import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, type ServerSettings } from "@t3tools/contracts";
import type { TailscaleNode, TailscaleTailnet, TailscaleWhois } from "@t3tools/tailscale";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as TailnetTrust from "./TailnetTrust.ts";
import * as TailscaleLocal from "./TailscaleLocal.ts";

const OWNER_ID = 7478531525256488;
const OWNER_LOGIN = "seatedro@github";
const SERVER_IP = "100.84.4.32";
const MACBOOK_IP = "100.117.108.54";
const MAGIC_DNS = "pulsar.tail87c919.ts.net";

const node = (overrides: Partial<TailscaleNode>): TailscaleNode => ({
  stableId: "nMacbook",
  name: "macbook",
  magicDnsName: "macbook.tail87c919.ts.net",
  os: "macOS",
  userId: OWNER_ID,
  loginName: OWNER_LOGIN,
  tagged: false,
  tailnetIpv4Addresses: [MACBOOK_IP],
  online: true,
  sharee: false,
  ...overrides,
});

const self = node({
  stableId: "nPulsar",
  name: "pulsar",
  magicDnsName: MAGIC_DNS,
  os: "linux",
  tailnetIpv4Addresses: [SERVER_IP],
});

const ownerTailnet: TailscaleTailnet = { running: true, self, peers: [node({})] };

const whoisOf = (overrides: Partial<TailscaleWhois>): TailscaleWhois => ({
  stableId: "nMacbook",
  name: "macbook",
  magicDnsName: "macbook.tail87c919.ts.net",
  os: "macOS",
  userId: OWNER_ID,
  loginName: OWNER_LOGIN,
  tagged: false,
  shared: false,
  ...overrides,
});

interface Scenario {
  readonly enabled?: boolean;
  readonly login?: string;
  readonly serve?: boolean;
  readonly tailnet?: TailscaleTailnet | null;
  readonly whois?: Readonly<Record<string, TailscaleWhois>>;
}

const request = (input: {
  readonly remote: string;
  readonly local: string;
  readonly headers?: Readonly<Record<string, string>>;
}) =>
  ({
    headers: { "user-agent": "Flock/1.0 (iPhone; iOS 26)", ...input.headers },
    cookies: {},
    source: { socket: { remoteAddress: input.remote, localAddress: input.local } },
  }) as unknown as HttpServerRequest.HttpServerRequest;

const direct = (remote = MACBOOK_IP, local = SERVER_IP) => request({ remote, local });

const serveHeaders = {
  host: MAGIC_DNS,
  "tailscale-user-login": OWNER_LOGIN,
  "tailscale-user-name": "rohit",
  "x-forwarded-for": MACBOOK_IP,
};
const viaServe = (headers: Readonly<Record<string, string>> = serveHeaders) =>
  request({ remote: "127.0.0.1", local: "127.0.0.1", headers });

/** The test settings layer does not stream changes; this one does, like the file watcher. */
const layerSettings = (initial: Partial<ServerSettings>) =>
  Layer.effect(
    ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettingsService;
      const changes = yield* PubSub.unbounded<ServerSettings>();
      return ServerSettingsService.of({
        ...base,
        updateSettings: (patch) =>
          base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      });
    }),
  ).pipe(Layer.provide(ServerSettingsService.layerTest(initial)));

const layerSessions = SessionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
);

const layerFor = (scenario: Scenario, whoisCalls: Ref.Ref<ReadonlyArray<string>>) => {
  const tailscale = TailscaleLocal.TailscaleLocal.of({
    tailnet: Effect.succeed(scenario.tailnet === undefined ? ownerTailnet : scenario.tailnet),
    whois: (address) =>
      Ref.update(whoisCalls, (calls) => [...calls, address]).pipe(
        Effect.as(
          (scenario.whois ?? { [MACBOOK_IP]: whoisOf({}), [SERVER_IP]: whoisOf(self) })[address] ??
            null,
        ),
      ),
  });
  const layerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (config) => ({
      ...config,
      tailscaleServeEnabled: scenario.serve ?? false,
      tailscaleServePort: 443,
    })),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailnet-trust-" })));
  return TailnetTrust.layer.pipe(
    Layer.provideMerge(Layer.succeed(TailscaleLocal.TailscaleLocal, tailscale)),
    Layer.provideMerge(
      layerSettings({
        tailnetTrustEnabled: scenario.enabled ?? true,
        tailnetTrustLogin: scenario.login ?? "",
      }),
    ),
    Layer.provideMerge(layerSessions),
    Layer.provideMerge(layerConfig),
    Layer.provide(NodeServices.layer),
  );
};

const runScenario = <A, E>(
  scenario: Scenario,
  body: (whoisCalls: Ref.Ref<ReadonlyArray<string>>) => Effect.Effect<A, E, TailnetDeps>,
) =>
  Effect.gen(function* () {
    const whoisCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    return yield* body(whoisCalls).pipe(Effect.provide(layerFor(scenario, whoisCalls)));
  });

type TailnetDeps =
  | TailnetTrust.TailnetTrust
  | SessionStore.SessionStore
  | ServerSettingsService
  | TailscaleLocal.TailscaleLocal;

const identify = (incoming: HttpServerRequest.HttpServerRequest) =>
  TailnetTrust.TailnetTrust.pipe(Effect.flatMap((trust) => trust.identify(incoming)));

const expectRefused = (
  scenario: Scenario,
  incoming: HttpServerRequest.HttpServerRequest,
  expected: { readonly reason: string; readonly detail: string; readonly asksTailscale?: boolean },
) =>
  runScenario(scenario, (whoisCalls) =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(identify(incoming))).toMatchObject({
        _tag: "TailnetTrustRefusedError",
        reason: expected.reason,
        detail: expected.detail,
      });
      if (expected.asksTailscale === false) {
        expect(yield* Ref.get(whoisCalls)).toEqual([]);
      }
    }),
  );

const NOT_TRUSTED = "tailnet_device_not_trusted";

it.effect("admits the owner's device over a direct tailnet connection", () =>
  runScenario({}, () =>
    Effect.gen(function* () {
      const trust = yield* TailnetTrust.TailnetTrust;
      const sessions = yield* SessionStore.SessionStore;
      expect(yield* trust.identify(direct())).toEqual({
        stableId: "nMacbook",
        name: "macbook",
        loginName: OWNER_LOGIN,
        os: "macOS",
        address: MACBOOK_IP,
      });
      const issued = yield* trust.issueSession(direct(), { deviceType: "mobile" });
      expect(issued.token_type).toBe("Bearer");
      const session = yield* sessions.verify(issued.access_token);
      expect(session.subject).toBe("tailnet-device:nMacbook");
      expect(session.method).toBe("bearer-access-token");
      expect(session.scopes).toEqual(AuthStandardClientScopes);
      expect(session.client).toMatchObject({
        label: `Tailscale: macbook (${OWNER_LOGIN})`,
        ipAddress: MACBOOK_IP,
        deviceType: "mobile",
        os: "macOS",
      });
    }),
  ),
);

it.effect("admits the server machine itself and mapped or IPv6 tailnet sockets", () =>
  runScenario(
    {
      whois: {
        [SERVER_IP]: whoisOf({ stableId: "nPulsar", name: "pulsar" }),
        [MACBOOK_IP]: whoisOf({}),
        "fd7a:115c:a1e0::2533:6c36": whoisOf({}),
      },
    },
    (whoisCalls) =>
      Effect.gen(function* () {
        expect((yield* identify(direct(SERVER_IP, SERVER_IP))).stableId).toBe("nPulsar");
        expect(
          (yield* identify(direct(`::ffff:${MACBOOK_IP}`, `::ffff:${SERVER_IP}`))).address,
        ).toBe(MACBOOK_IP);
        expect(
          (yield* identify(direct("fd7a:115c:a1e0::2533:6c36", "fd7a:115c:a1e0::5a29:421")))
            .stableId,
        ).toBe("nMacbook");
        expect(yield* Ref.get(whoisCalls)).toEqual([
          SERVER_IP,
          MACBOOK_IP,
          "fd7a:115c:a1e0::2533:6c36",
        ]);
      }),
  ),
);

it.effect("admits through Tailscale Serve by the forwarded device, checked with whois", () =>
  runScenario({ serve: true }, (whoisCalls) =>
    Effect.gen(function* () {
      expect((yield* identify(viaServe())).stableId).toBe("nMacbook");
      expect((yield* identify(viaServe({ ...serveHeaders, host: `${MAGIC_DNS}:443` }))).name).toBe(
        "macbook",
      );
      expect(yield* Ref.get(whoisCalls)).toEqual([MACBOOK_IP, MACBOOK_IP]);
    }),
  ),
);

it.effect("a tagged server trusts the login its owner configured", () =>
  runScenario(
    {
      login: "SeatedRo@GitHub",
      tailnet: { ...ownerTailnet, self: { ...self, tagged: true, loginName: null } },
    },
    () =>
      Effect.gen(function* () {
        expect((yield* identify(direct())).loginName).toBe(OWNER_LOGIN);
      }),
  ),
);

const refusals: ReadonlyArray<{
  readonly name: string;
  readonly scenario: Scenario;
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly reason?: string;
  readonly detail: string;
  readonly asksTailscale?: boolean;
}> = [
  {
    name: "the setting is off",
    scenario: { enabled: false },
    request: direct(),
    reason: "tailnet_trust_disabled",
    detail: "setting_off",
    asksTailscale: false,
  },
  {
    name: "a LAN client",
    scenario: {},
    request: direct("192.168.1.40", "192.168.1.20"),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "a tailnet source address that arrived on the LAN interface",
    scenario: {},
    request: direct(MACBOOK_IP, "192.168.1.20"),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "a public client",
    scenario: {},
    request: direct("203.0.113.9", SERVER_IP),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "Serve headers on loopback when this server did not configure Serve",
    scenario: { serve: false },
    request: viaServe(),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "Serve headers from a LAN client",
    scenario: { serve: true },
    request: request({ remote: "192.168.1.40", local: "192.168.1.20", headers: serveHeaders }),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "a relayed request that copies Serve headers",
    scenario: { serve: true },
    request: viaServe({ ...serveHeaders, host: "abc123.t3.codes" }),
    detail: "serve_host_mismatch",
    asksTailscale: false,
  },
  {
    name: "a loopback browser that copies Serve headers",
    scenario: { serve: true },
    request: viaServe({ ...serveHeaders, host: "localhost:3773" }),
    detail: "serve_host_mismatch",
    asksTailscale: false,
  },
  {
    name: "a Funnel request",
    scenario: { serve: true },
    request: viaServe({ ...serveHeaders, "tailscale-funnel-request": "?1" }),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "a forwarded-for chain",
    scenario: { serve: true },
    request: viaServe({ ...serveHeaders, "x-forwarded-for": `203.0.113.9, ${MACBOOK_IP}` }),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "a forwarded-for address off the tailnet",
    scenario: { serve: true },
    request: viaServe({ ...serveHeaders, "x-forwarded-for": "192.168.1.40" }),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "Serve without the login header",
    scenario: { serve: true },
    request: viaServe({ host: MAGIC_DNS, "x-forwarded-for": MACBOOK_IP }),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "a Serve login header that disagrees with whois",
    scenario: { serve: true },
    request: viaServe({ ...serveHeaders, "tailscale-user-login": "mallory@github" }),
    detail: "serve_login_mismatch",
  },
  {
    name: "Tailscale is not running",
    scenario: { tailnet: null },
    request: direct(),
    detail: "tailscale_unavailable",
  },
  {
    name: "an address tailscaled does not know",
    scenario: { whois: {} },
    request: direct(),
    detail: "unknown_peer",
  },
  {
    name: "another user's device",
    scenario: {
      whois: { [MACBOOK_IP]: whoisOf({ userId: 42, loginName: "mallory@github" }) },
    },
    request: direct(),
    detail: "other_account",
  },
  {
    name: "the same login as another tailnet's user",
    scenario: { whois: { [MACBOOK_IP]: whoisOf({ userId: 42 }) } },
    request: direct(),
    detail: "other_account",
  },
  {
    name: "a tagged device",
    scenario: { whois: { [MACBOOK_IP]: whoisOf({ tagged: true, loginName: null }) } },
    request: direct(),
    detail: "tagged_device",
  },
  {
    name: "a device shared in from another tailnet",
    scenario: { whois: { [MACBOOK_IP]: whoisOf({ shared: true }) } },
    request: direct(),
    detail: "shared_device",
  },
  {
    name: "a device of someone this machine is shared with",
    scenario: { tailnet: { ...ownerTailnet, peers: [node({ sharee: true })] } },
    request: direct(),
    detail: "not_a_tailnet_member",
  },
  {
    name: "a node missing from this tailnet's status",
    scenario: { tailnet: { ...ownerTailnet, peers: [] } },
    request: direct(),
    detail: "not_a_tailnet_member",
  },
  {
    name: "a tagged server with no configured login",
    scenario: { tailnet: { ...ownerTailnet, self: { ...self, tagged: true, loginName: null } } },
    request: direct(),
    detail: "tagged_server_without_login",
  },
  {
    name: "a tagged server configured for another login",
    scenario: {
      login: "mallory@github",
      tailnet: { ...ownerTailnet, self: { ...self, tagged: true, loginName: null } },
    },
    request: direct(),
    detail: "other_account",
  },
];

it.effect.each(refusals)("refuses $name", (refusal) =>
  expectRefused(refusal.scenario, refusal.request, {
    reason: refusal.reason ?? NOT_TRUSTED,
    detail: refusal.detail,
    ...(refusal.asksTailscale === undefined ? {} : { asksTailscale: refusal.asksTailscale }),
  }),
);

it.effect("refuses to issue a session when the device is not trusted", () =>
  runScenario({ enabled: false }, () =>
    Effect.gen(function* () {
      const trust = yield* TailnetTrust.TailnetTrust;
      const sessions = yield* SessionStore.SessionStore;
      const exit = yield* Effect.exit(trust.issueSession(direct(), {}));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* sessions.listActive()).toEqual([]);
    }),
  ),
);

it.effect("turning the setting off revokes only the sessions it admitted", () =>
  runScenario({}, () =>
    Effect.gen(function* () {
      const trust = yield* TailnetTrust.TailnetTrust;
      const sessions = yield* SessionStore.SessionStore;
      const settings = yield* ServerSettingsService;
      const admitted = yield* sessions.verify(
        (yield* trust.issueSession(direct(), {})).access_token,
      );
      const paired = yield* sessions.issue({ subject: "one-time-token" });

      yield* settings.updateSettings({ tailnetTrustEnabled: false });
      yield* sessions.awaitInvalidation(admitted.sessionId);
      const remaining = (yield* sessions.listActive()).map((session) => session.sessionId);
      expect(remaining).toEqual([paired.sessionId]);

      yield* settings.updateSettings({ tailnetTrustEnabled: true });
      const again = yield* sessions.verify((yield* trust.issueSession(direct(), {})).access_token);
      expect(again.subject).toBe("tailnet-device:nMacbook");
    }),
  ),
);

it.effect("revokes tailnet sessions at startup when the setting is already off", () =>
  Effect.gen(function* () {
    const whoisCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerFor({ enabled: false }, whoisCalls);
    yield* Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const left = yield* sessions.issue({
        subject: `${TailnetTrust.TAILNET_DEVICE_SUBJECT_PREFIX}nMacbook`,
        method: "bearer-access-token",
      });
      const paired = yield* sessions.issue({ subject: "one-time-token" });
      // Building the service again, as a restart does, reconciles against the stored sessions.
      yield* Effect.scoped(
        Layer.build(TailnetTrust.layer).pipe(
          Effect.andThen(sessions.awaitInvalidation(left.sessionId)),
        ),
      );
      expect((yield* sessions.listActive()).map((session) => session.sessionId)).toEqual([
        paired.sessionId,
      ]);
    }).pipe(Effect.provide(layer));
  }),
);
