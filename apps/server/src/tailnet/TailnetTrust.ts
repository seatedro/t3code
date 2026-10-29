// @effect-diagnostics nodeBuiltinImport:off - isIP classifies socket addresses; Effect has no equivalent.
import * as NodeNet from "node:net";

import {
  AuthAccessTokenType,
  AuthStandardClientScopes,
  type AuthAccessTokenResult,
  type AuthClientPresentationMetadata,
} from "@t3tools/contracts";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import {
  isTailscaleIpv4Address,
  type TailscaleTailnet,
  type TailscaleWhois,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { ServerAuthAuthenticatedAccessTokenIssueError } from "../auth/EnvironmentAuth.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as TailscaleLocal from "./TailscaleLocal.ts";

/** Sessions admitted by Tailscale identity carry the node's stable id, so they can be found again. */
export const TAILNET_DEVICE_SUBJECT_PREFIX = "tailnet-device:";

export interface TailnetDevice {
  readonly stableId: string;
  readonly name: string;
  readonly loginName: string;
  readonly os: string | null;
  readonly address: string;
}

export class TailnetTrustRefusedError extends Schema.TaggedError<TailnetTrustRefusedError>()(
  "TailnetTrustRefusedError",
  {
    reason: Schema.Literals(["tailnet_trust_disabled", "tailnet_device_not_trusted"]),
    /** Why, for the server log only; a client learns just the reason. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.reason === "tailnet_trust_disabled"
      ? "This environment does not trust tailnet devices."
      : "The connection does not come from a trusted tailnet device.";
  }
}

const notTrusted = (detail: string) =>
  new TailnetTrustRefusedError({ reason: "tailnet_device_not_trusted", detail });

const unmapIpv4 = (address: string): string =>
  address.toLowerCase().startsWith("::ffff:") ? address.slice("::ffff:".length) : address;

const isTailnetAddress = (address: string): boolean =>
  NodeNet.isIP(address) !== 0 && (isTailscaleIpv4Address(address) || isTailnetHost(address));

const firstHeader = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

type TailnetSource =
  | { readonly via: "direct"; readonly address: string }
  /** Tailscale Serve's proxy: loopback, with the identity headers it adds. */
  | {
      readonly via: "serve";
      readonly address: string;
      readonly login: string;
      readonly host: string;
    };

/**
 * Where a request claims to come from on the tailnet, from the socket and, only for a
 * loopback socket when this server configured Tailscale Serve, the headers Serve sets.
 * Anything else, including LAN, relay and loopback clients, has no tailnet source.
 */
function resolveTailnetSource(input: {
  readonly remoteAddress: string | undefined;
  readonly localAddress: string | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly serveConfigured: boolean;
}): TailnetSource | null {
  const remote = input.remoteAddress === undefined ? undefined : unmapIpv4(input.remoteAddress);
  const local = input.localAddress === undefined ? undefined : unmapIpv4(input.localAddress);
  if (remote === undefined || local === undefined) return null;
  // Both ends: the connection arrived on this machine's tailnet interface.
  if (isTailnetAddress(remote) && isTailnetAddress(local)) {
    return { via: "direct", address: remote };
  }
  if (!input.serveConfigured || NodeNet.isIP(remote) === 0 || !isLocalLoopbackHost(remote)) {
    return null;
  }
  const login = firstHeader(input.headers["tailscale-user-login"]);
  const host = firstHeader(input.headers.host)?.toLowerCase();
  const forwardedFor = firstHeader(input.headers["x-forwarded-for"]);
  // Serve sets X-Forwarded-For to the one tailnet client; a list was not built by Serve alone.
  if (
    login === undefined ||
    host === undefined ||
    forwardedFor === undefined ||
    forwardedFor.includes(",") ||
    input.headers["tailscale-funnel-request"] !== undefined
  ) {
    return null;
  }
  const address = unmapIpv4(forwardedFor);
  return isTailnetAddress(address) ? { via: "serve", address, login, host } : null;
}

/** Host values Serve forwards for this machine: its MagicDNS name, with or without the port. */
const serveHostsFor = (magicDnsName: string, servePort: number): ReadonlySet<string> =>
  new Set([magicDnsName.toLowerCase(), `${magicDnsName.toLowerCase()}:${servePort}`]);

/**
 * Whether the node tailscaled names is the owner's: a user device of this tailnet (not
 * tagged, not shared in, not a sharee's) signed in as this machine's own user, or, when
 * this machine is tagged and has no user, as the login the owner configured.
 */
function evaluateTailnetDevice(input: {
  readonly tailnet: TailscaleTailnet;
  readonly whois: TailscaleWhois;
  readonly configuredLogin: string;
}): { readonly loginName: string; readonly stableId: string } | string {
  const { whois } = input;
  const self = input.tailnet.self;
  if (self === null) return "server_identity_unknown";
  if (whois.tagged) return "tagged_device";
  if (whois.shared) return "shared_device";
  if (whois.stableId === null || whois.loginName === null || whois.userId === null) {
    return "device_identity_unknown";
  }
  const stableId = whois.stableId;
  const member =
    stableId === self.stableId ||
    input.tailnet.peers.some((peer) => peer.stableId === stableId && !peer.sharee);
  if (!member) return "not_a_tailnet_member";
  if (self.tagged) {
    const configured = input.configuredLogin.trim().toLowerCase();
    if (configured === "") return "tagged_server_without_login";
    return whois.loginName.toLowerCase() === configured
      ? { loginName: whois.loginName, stableId }
      : "other_account";
  }
  if (self.loginName === null || self.userId === null) return "server_identity_unknown";
  // The same login in another tailnet is another user with its own id.
  return whois.loginName === self.loginName && whois.userId === self.userId
    ? { loginName: whois.loginName, stableId }
    : "other_account";
}

export class TailnetTrust extends Context.Service<
  TailnetTrust,
  {
    /** The trusted device a request comes from. Fails unless the setting is on and Tailscale vouches. */
    readonly identify: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<TailnetDevice, TailnetTrustRefusedError>;
    readonly issueSession: (
      request: HttpServerRequest.HttpServerRequest,
      presented: AuthClientPresentationMetadata,
    ) => Effect.Effect<
      AuthAccessTokenResult,
      TailnetTrustRefusedError | ServerAuthAuthenticatedAccessTokenIssueError
    >;
  }
>()("t3/tailnet/TailnetTrust") {}

const socketOf = (request: HttpServerRequest.HttpServerRequest) => {
  const source = request.source as
    | { readonly socket?: { readonly remoteAddress?: string; readonly localAddress?: string } }
    | undefined;
  return {
    remoteAddress: source?.socket?.remoteAddress,
    localAddress: source?.socket?.localAddress,
  };
};

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettingsService;
  const sessions = yield* SessionStore.SessionStore;
  const tailscale = yield* TailscaleLocal.TailscaleLocal;

  const identify: TailnetTrust["Service"]["identify"] = Effect.fn("TailnetTrust.identify")(
    function* (request) {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(() => notTrusted("settings_unreadable")),
      );
      if (!current.tailnetTrustEnabled) {
        return yield* new TailnetTrustRefusedError({
          reason: "tailnet_trust_disabled",
          detail: "setting_off",
        });
      }
      // Checked before running tailscale, so other networks cannot make the server spawn it.
      const source = resolveTailnetSource({
        ...socketOf(request),
        headers: request.headers,
        serveConfigured: config.tailscaleServeEnabled,
      });
      if (source === null) return yield* notTrusted("not_over_tailnet");
      const tailnet = yield* tailscale.tailnet;
      if (tailnet === null) return yield* notTrusted("tailscale_unavailable");
      if (source.via === "serve") {
        const magicDnsName = tailnet.self?.magicDnsName ?? null;
        if (
          magicDnsName === null ||
          !serveHostsFor(magicDnsName, config.tailscaleServePort).has(source.host)
        ) {
          return yield* notTrusted("serve_host_mismatch");
        }
      }
      const whois = yield* tailscale.whois(source.address);
      if (whois === null) return yield* notTrusted("unknown_peer");
      const verdict = evaluateTailnetDevice({
        tailnet,
        whois,
        configuredLogin: current.tailnetTrustLogin,
      });
      if (typeof verdict === "string") return yield* notTrusted(verdict);
      if (source.via === "serve" && source.login !== verdict.loginName) {
        return yield* notTrusted("serve_login_mismatch");
      }
      return {
        stableId: verdict.stableId,
        name: whois.name ?? whois.magicDnsName ?? source.address,
        loginName: verdict.loginName,
        os: whois.os,
        address: source.address,
      } satisfies TailnetDevice;
    },
    // Off-tailnet callers are refused before Tailscale is asked; only a tailnet refusal says much.
    Effect.tapError((error) =>
      (error.detail === "setting_off" || error.detail === "not_over_tailnet"
        ? Effect.logDebug
        : Effect.logInfo)("Refused a tailnet device without a pairing code.", {
        reason: error.reason,
        detail: error.detail,
      }),
    ),
  );

  const issueSession: TailnetTrust["Service"]["issueSession"] = Effect.fn(
    "TailnetTrust.issueSession",
  )(function* (request, presented) {
    const device = yield* identify(request);
    const derived = deriveAuthClientMetadata({ request, presented });
    const session = yield* sessions
      .issue({
        method: "bearer-access-token",
        subject: `${TAILNET_DEVICE_SUBJECT_PREFIX}${device.stableId}`,
        scopes: AuthStandardClientScopes,
        client: {
          ...derived,
          label: `Tailscale: ${device.name} (${device.loginName})`,
          ipAddress: device.address,
          ...(presented.os === undefined && device.os !== null ? { os: device.os } : {}),
        },
      })
      .pipe(
        Effect.mapError((cause) => new ServerAuthAuthenticatedAccessTokenIssueError({ cause })),
      );
    yield* Effect.logInfo("Admitted a tailnet device without a pairing code.", {
      sessionId: session.sessionId,
      device: device.name,
      login: device.loginName,
    });
    const now = yield* DateTime.now;
    return {
      access_token: session.token,
      issued_token_type: AuthAccessTokenType,
      token_type: "Bearer",
      expires_in: Math.max(
        0,
        Math.floor((session.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1000),
      ),
      scope: encodeOAuthScope(session.scopes),
    } satisfies AuthAccessTokenResult;
  });

  const revokeTailnetSessions = Effect.fn("TailnetTrust.revokeTailnetSessions")(function* () {
    const active = yield* sessions.listActive();
    const admitted = active.filter((session) =>
      session.subject.startsWith(TAILNET_DEVICE_SUBJECT_PREFIX),
    );
    yield* Effect.forEach(admitted, (session) => sessions.revoke(session.sessionId), {
      discard: true,
    });
    if (admitted.length > 0) {
      yield* Effect.logInfo("Revoked sessions admitted by Tailscale identity.", {
        count: admitted.length,
      });
    }
  });

  // Off is a way out, not just a closed door: devices let in earlier lose their sessions,
  // including when settings.json was edited while the server was stopped.
  const revokeWhenOff = (enabled: boolean) =>
    enabled
      ? Effect.void
      : revokeTailnetSessions().pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Failed to revoke sessions admitted by Tailscale identity.", {
              cause,
            }),
          ),
        );
  const changes = yield* settings.subscribeChanges;
  yield* Effect.gen(function* () {
    yield* settings.ready;
    yield* revokeWhenOff((yield* settings.getSettings).tailnetTrustEnabled);
    yield* changes.pipe(
      Stream.map((next) => next.tailnetTrustEnabled),
      Stream.changes,
      Stream.runForEach(revokeWhenOff),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Tailnet trust reconciliation stopped.", { cause }),
    ),
    Effect.forkScoped,
  );

  return TailnetTrust.of({ identify, issueSession });
});

export const layer = Layer.effect(TailnetTrust, make);
