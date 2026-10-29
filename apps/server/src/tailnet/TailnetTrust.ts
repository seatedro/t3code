// @effect-diagnostics nodeBuiltinImport:off - isIP classifies socket addresses; Effect has no equivalent.
import * as NodeNet from "node:net";

import {
  AuthAccessTokenType,
  AuthStandardClientScopes,
  type AuthAccessTokenResult,
  type AuthClientPresentationMetadata,
} from "@t3tools/contracts";
import { isTailnetHost } from "@t3tools/shared/hostClassification";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import {
  isTailscaleIpv4Address,
  type TailscaleNode,
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

import { ServerSettingsService } from "../serverSettings.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { ServerAuthAuthenticatedAccessTokenIssueError } from "../auth/EnvironmentAuth.ts";
import {
  isTailnetDeviceSubject,
  TAILNET_DEVICE_SUBJECT_PREFIX,
} from "../auth/TailnetSessionGate.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as TailscaleLocal from "./TailscaleLocal.ts";

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

const disabled = (detail: string) =>
  new TailnetTrustRefusedError({ reason: "tailnet_trust_disabled", detail });

const unmapIpv4 = (address: string): string => {
  const lower = address.toLowerCase();
  return lower.startsWith("::ffff:") ? lower.slice("::ffff:".length) : lower;
};

const isTailnetAddress = (address: string): boolean =>
  NodeNet.isIP(address) !== 0 && (isTailscaleIpv4Address(address) || isTailnetHost(address));

/**
 * A web page on a trusted device must not borrow the device's identity: the session would
 * give it a shell. Browsers mark their requests; native clients such as Flock send neither.
 */
const browserRequestDetail = (headers: HttpServerRequest.HttpServerRequest["headers"]) =>
  headers.origin !== undefined
    ? "browser_origin"
    : headers["sec-fetch-site"] !== undefined && headers["sec-fetch-site"] !== "none"
      ? "browser_fetch_site"
      : null;

/** The name or address in a Host header, without brackets, port, or a trailing dot. */
const hostNameOf = (host: string | undefined): string | null => {
  const match = /^(\[[^\]]+\]|[^:[\]]+)(?::\d+)?$/u.exec(host?.trim().toLowerCase() ?? "");
  return match?.[1]?.replace(/^\[|\]$/gu, "").replace(/\.$/u, "") ?? null;
};

/** What a client may have typed to reach this node over Tailscale; any other Host is rebinding. */
const ownHostNames = (self: TailscaleNode): ReadonlySet<string> => {
  const magicDnsName = self.magicDnsName?.toLowerCase();
  return new Set([
    ...(magicDnsName === undefined ? [] : [magicDnsName, magicDnsName.split(".")[0] ?? ""]),
    ...self.tailnetAddresses,
  ]);
};

/**
 * Whether the node tailscaled names is the owner's: another user device of this tailnet (not
 * this machine, not tagged, not shared in or a sharee's, not routing for other hosts) signed in
 * as this machine's own user or, when this machine is tagged, as the login the owner configured.
 */
function evaluateTailnetDevice(input: {
  readonly tailnet: TailscaleTailnet;
  readonly whois: TailscaleWhois;
  readonly configuredLogin: string;
}): { readonly loginName: string; readonly stableId: string } | string {
  const { whois } = input;
  const self = input.tailnet.self;
  if (self === null) return "server_identity_unknown";
  if (whois.stableId === null || whois.loginName === null || whois.userId === null) {
    return whois.tagged ? "tagged_device" : "device_identity_unknown";
  }
  // Any program on this machine could connect to its own address.
  if (whois.stableId === self.stableId) return "this_machine";
  if (whois.tagged) return "tagged_device";
  if (whois.shared) return "shared_device";
  if (whois.routesOtherHosts) return "routes_other_hosts";
  const stableId = whois.stableId;
  if (!input.tailnet.peers.some((peer) => peer.stableId === stableId && !peer.sharee)) {
    return "not_a_tailnet_member";
  }
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
    /** One session per device: a device asking again replaces the session it had. */
    readonly issueSession: (
      request: HttpServerRequest.HttpServerRequest,
      presented: AuthClientPresentationMetadata,
    ) => Effect.Effect<
      AuthAccessTokenResult,
      TailnetTrustRefusedError | ServerAuthAuthenticatedAccessTokenIssueError
    >;
    /** Revokes the sessions trust admitted when the setting is off. Startup awaits it. */
    readonly reconcile: Effect.Effect<void>;
  }
>()("t3/tailnet/TailnetTrust") {}

const socketOf = (request: HttpServerRequest.HttpServerRequest) => {
  const source = request.source as
    | { readonly socket?: { readonly remoteAddress?: string; readonly localAddress?: string } }
    | undefined;
  const remote = source?.socket?.remoteAddress;
  const local = source?.socket?.localAddress;
  return {
    remote: remote === undefined ? undefined : unmapIpv4(remote),
    local: local === undefined ? undefined : unmapIpv4(local),
  };
};

/** @public */
export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const sessions = yield* SessionStore.SessionStore;
  const tailscale = yield* TailscaleLocal.TailscaleLocal;

  const trustEnabled = settings.getSettings.pipe(
    Effect.map((current) => current.tailnetTrustEnabled),
    Effect.orElseSucceed(() => false),
  );

  const identify: TailnetTrust["Service"]["identify"] = Effect.fn("TailnetTrust.identify")(
    function* (request) {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(() => notTrusted("settings_unreadable")),
      );
      if (!current.tailnetTrustEnabled) return yield* disabled("setting_off");
      const browser = browserRequestDetail(request.headers);
      if (browser !== null) return yield* notTrusted(browser);
      // Checked before running tailscale, so other networks cannot make the server spawn it.
      const { remote, local } = socketOf(request);
      if (
        remote === undefined ||
        local === undefined ||
        !isTailnetAddress(remote) ||
        !isTailnetAddress(local)
      ) {
        return yield* notTrusted("not_over_tailnet");
      }
      const tailnet = yield* tailscale.tailnet;
      if (tailnet === null) return yield* notTrusted("tailscale_unavailable");
      const self = tailnet.self;
      if (self === null) return yield* notTrusted("server_identity_unknown");
      // Another CGNAT or overlay interface (WARP, NetBird, a VPC) shares the address range.
      if (!self.tailnetAddresses.includes(local)) return yield* notTrusted("not_this_node_address");
      const hostName = hostNameOf(request.headers.host);
      if (hostName === null || !ownHostNames(self).has(hostName)) {
        return yield* notTrusted("foreign_host");
      }
      const whois = yield* tailscale.whois(remote);
      if (whois === null) return yield* notTrusted("unknown_peer");
      const verdict = evaluateTailnetDevice({
        tailnet,
        whois,
        configuredLogin: current.tailnetTrustLogin,
      });
      if (typeof verdict === "string") return yield* notTrusted(verdict);
      return {
        stableId: verdict.stableId,
        name: whois.name ?? whois.magicDnsName ?? remote,
        loginName: verdict.loginName,
        os: whois.os,
        address: remote,
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
    const issueError = (cause: unknown) =>
      new ServerAuthAuthenticatedAccessTokenIssueError({ cause });
    const session = yield* sessions
      .issue({
        method: "bearer-access-token",
        subject: `${TAILNET_DEVICE_SUBJECT_PREFIX}${device.stableId}`,
        scopes: AuthStandardClientScopes,
        replaceActiveForSubjectAndMethod: true,
        client: {
          ...derived,
          label: `Tailscale: ${device.name} (${device.loginName})`,
          ipAddress: device.address,
          ...(presented.os === undefined && device.os !== null ? { os: device.os } : {}),
        },
      })
      .pipe(Effect.mapError(issueError));
    // Asking Tailscale takes a while; trust turned off meanwhile must not leave this session behind.
    if (!(yield* trustEnabled)) {
      yield* sessions.revoke(session.sessionId).pipe(Effect.mapError(issueError));
      return yield* disabled("turned_off_while_admitting");
    }
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

  const reconcile: TailnetTrust["Service"]["reconcile"] = Effect.gen(function* () {
    if (yield* trustEnabled) return;
    const active = yield* sessions.listActive();
    const admitted = active.filter((session) => isTailnetDeviceSubject(session.subject));
    yield* Effect.forEach(admitted, (session) => sessions.revoke(session.sessionId), {
      discard: true,
    });
    if (admitted.length > 0) {
      yield* Effect.logInfo("Revoked sessions admitted by Tailscale identity.", {
        count: admitted.length,
      });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Failed to revoke sessions admitted by Tailscale identity.", { cause }),
    ),
    Effect.withSpan("TailnetTrust.reconcile"),
  );

  // Live changes, including settings.json edits by `t3 auth tailnet-trust off`. Revoking here
  // tidies the session list; the gate in EnvironmentAuth is what refuses them while off.
  const changes = yield* settings.subscribeChanges;
  yield* Effect.gen(function* () {
    yield* settings.ready;
    yield* changes.pipe(
      Stream.map((next) => next.tailnetTrustEnabled),
      Stream.changes,
      Stream.runForEach(() => reconcile),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Tailnet trust stopped following settings.", { cause }),
    ),
    Effect.forkScoped,
  );

  return TailnetTrust.of({ identify, issueSession, reconcile });
});

export const layer = Layer.effect(TailnetTrust, make);
