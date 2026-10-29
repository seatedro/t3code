import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, type ServerSettings } from "@t3tools/contracts";
import type { TailscaleNode, TailscaleTailnet, TailscaleWhois } from "@t3tools/tailscale";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import { TAILNET_DEVICE_SUBJECT_PREFIX } from "../auth/TailnetSessionGate.ts";
import * as TailnetTrust from "./TailnetTrust.ts";
import * as TailscaleLocal from "./TailscaleLocal.ts";

const OWNER_ID = 7478531525256488;
const OWNER_LOGIN = "seatedro@github";
const SERVER_IP = "100.84.4.32";
const SERVER_IPV6 = "fd7a:115c:a1e0::5a29:421";
const MACBOOK_IP = "100.117.108.54";
const MACBOOK_IPV6 = "fd7a:115c:a1e0::2533:6c36";
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
  tailnetAddresses: [MACBOOK_IP, MACBOOK_IPV6],
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
  tailnetAddresses: [SERVER_IP, SERVER_IPV6],
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
  routesOtherHosts: false,
  ...overrides,
});

const ownerWhois: Readonly<Record<string, TailscaleWhois>> = {
  [MACBOOK_IP]: whoisOf({}),
  [MACBOOK_IPV6]: whoisOf({}),
  [SERVER_IP]: whoisOf({ stableId: "nPulsar", name: "pulsar" }),
};

interface Scenario {
  readonly enabled?: boolean;
  readonly login?: string;
  readonly tailnet?: TailscaleTailnet | null;
  readonly whois?: Readonly<Record<string, TailscaleWhois>>;
  /** Holds every whois until released, to interleave a settings change. */
  readonly whoisGate?: {
    readonly asked: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
}

const request = (input: {
  readonly remote: string;
  readonly local: string;
  readonly headers?: Readonly<Record<string, string>>;
}) =>
  ({
    headers: { host: "pulsar:3773", "user-agent": "Flock/1 CFNetwork Darwin", ...input.headers },
    cookies: {},
    source: { socket: { remoteAddress: input.remote, localAddress: input.local } },
  }) as unknown as HttpServerRequest.HttpServerRequest;

const direct = (headers: Readonly<Record<string, string>> = {}) =>
  request({ remote: MACBOOK_IP, local: SERVER_IP, headers });

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

const fakeTailscale = (scenario: Scenario, whoisCalls: Ref.Ref<ReadonlyArray<string>>) =>
  TailscaleLocal.TailscaleLocal.of({
    tailnet: Effect.succeed(scenario.tailnet === undefined ? ownerTailnet : scenario.tailnet),
    whois: (address) =>
      Effect.gen(function* () {
        yield* Ref.update(whoisCalls, (calls) => [...calls, address]);
        if (scenario.whoisGate !== undefined) {
          yield* Deferred.succeed(scenario.whoisGate.asked, undefined);
          yield* Deferred.await(scenario.whoisGate.release);
        }
        return (scenario.whois ?? ownerWhois)[address] ?? null;
      }),
  });

const layerSessions = SessionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailnet-trust-" })),
);

const layerFor = (scenario: Scenario, whoisCalls: Ref.Ref<ReadonlyArray<string>>) =>
  TailnetTrust.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(TailscaleLocal.TailscaleLocal, fakeTailscale(scenario, whoisCalls)),
    ),
    Layer.provideMerge(
      layerSettings({
        tailnetTrustEnabled: scenario.enabled ?? true,
        tailnetTrustLogin: scenario.login ?? "",
      }),
    ),
    Layer.provideMerge(layerSessions),
    Layer.provide(NodeServices.layer),
  );

type TailnetDeps =
  | TailnetTrust.TailnetTrust
  | SessionStore.SessionStore
  | ServerSettingsService
  | TailscaleLocal.TailscaleLocal;

const runScenario = <A, E>(
  scenario: Scenario,
  body: (whoisCalls: Ref.Ref<ReadonlyArray<string>>) => Effect.Effect<A, E, TailnetDeps>,
) =>
  Effect.gen(function* () {
    const whoisCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    return yield* body(whoisCalls).pipe(Effect.provide(layerFor(scenario, whoisCalls)));
  });

const identify = (incoming: HttpServerRequest.HttpServerRequest) =>
  TailnetTrust.TailnetTrust.pipe(Effect.flatMap((trust) => trust.identify(incoming)));

const tailnetSessionIds = Effect.flatMap(SessionStore.SessionStore, (sessions) =>
  sessions.listActive(),
).pipe(
  Effect.map((active) =>
    active
      .filter((session) => session.subject.startsWith(TAILNET_DEVICE_SUBJECT_PREFIX))
      .map((session) => session.sessionId),
  ),
);

it.effect("admits another device of the owner over a direct tailnet connection", () =>
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

it.effect("accepts the names and addresses that reach this node, and IPv6 or mapped sockets", () =>
  runScenario({}, (whoisCalls) =>
    Effect.gen(function* () {
      for (const host of [
        "pulsar",
        "pulsar:16113",
        `${MAGIC_DNS}:16113`,
        "PULSAR.tail87c919.ts.net.",
        `${SERVER_IP}:3773`,
        `[${SERVER_IPV6}]:3773`,
      ]) {
        expect((yield* identify(direct({ host }))).stableId).toBe("nMacbook");
      }
      expect(
        (yield* identify(request({ remote: `::ffff:${MACBOOK_IP}`, local: `::ffff:${SERVER_IP}` })))
          .address,
      ).toBe(MACBOOK_IP);
      expect((yield* identify(request({ remote: MACBOOK_IPV6, local: SERVER_IPV6 }))).address).toBe(
        MACBOOK_IPV6,
      );
      // A user typing the address is a navigation, not a page making the request.
      expect((yield* identify(direct({ "sec-fetch-site": "none" }))).stableId).toBe("nMacbook");
      expect((yield* Ref.get(whoisCalls)).length).toBe(9);
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
    name: "a web page's request",
    scenario: {},
    request: direct({ origin: "https://evil.example" }),
    detail: "browser_origin",
    asksTailscale: false,
  },
  {
    name: "a sandboxed page's request",
    scenario: {},
    request: direct({ origin: "null" }),
    detail: "browser_origin",
    asksTailscale: false,
  },
  {
    name: "a same-origin fetch after DNS rebinding",
    scenario: {},
    request: direct({ "sec-fetch-site": "same-origin" }),
    detail: "browser_fetch_site",
    asksTailscale: false,
  },
  {
    name: "a cross-site fetch",
    scenario: {},
    request: direct({ "sec-fetch-site": "cross-site" }),
    detail: "browser_fetch_site",
    asksTailscale: false,
  },
  {
    name: "a rebound Host",
    scenario: {},
    request: direct({ host: "evil.example:3773" }),
    detail: "foreign_host",
    asksTailscale: false,
  },
  {
    name: "a name that only starts like this node's",
    scenario: {},
    request: direct({ host: "pulsar.evil.example" }),
    detail: "foreign_host",
    asksTailscale: false,
  },
  {
    name: "another node's name",
    scenario: {},
    request: direct({ host: "macbook:3773" }),
    detail: "foreign_host",
    asksTailscale: false,
  },
  {
    name: "a loopback Host",
    scenario: {},
    request: direct({ host: "localhost:3773" }),
    detail: "foreign_host",
    asksTailscale: false,
  },
  {
    name: "a missing Host",
    scenario: {},
    request: direct({ host: "" }),
    detail: "foreign_host",
    asksTailscale: false,
  },
  {
    name: "a LAN client",
    scenario: {},
    request: request({ remote: "192.168.1.40", local: "192.168.1.20" }),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "a tailnet source address that arrived on the LAN interface",
    scenario: {},
    request: request({ remote: MACBOOK_IP, local: "192.168.1.20" }),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "a public client",
    scenario: {},
    request: request({ remote: "203.0.113.9", local: SERVER_IP }),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "a loopback request carrying Tailscale Serve's identity headers",
    scenario: {},
    request: request({
      remote: "127.0.0.1",
      local: "127.0.0.1",
      headers: {
        host: MAGIC_DNS,
        "tailscale-user-login": OWNER_LOGIN,
        "x-forwarded-for": MACBOOK_IP,
      },
    }),
    detail: "not_over_tailnet",
    asksTailscale: false,
  },
  {
    name: "a CGNAT interface that is not this node's Tailscale address",
    scenario: {},
    request: request({ remote: MACBOOK_IP, local: "100.96.0.5" }),
    detail: "not_this_node_address",
    asksTailscale: false,
  },
  {
    name: "this machine connecting to itself",
    scenario: {},
    request: request({ remote: SERVER_IP, local: SERVER_IP }),
    detail: "this_machine",
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
    scenario: { whois: { [MACBOOK_IP]: whoisOf({ userId: 42, loginName: "mallory@github" }) } },
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
    name: "a subnet router or exit node",
    scenario: { whois: { [MACBOOK_IP]: whoisOf({ routesOtherHosts: true }) } },
    request: direct(),
    detail: "routes_other_hosts",
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
  runScenario(refusal.scenario, (whoisCalls) =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(identify(refusal.request))).toMatchObject({
        _tag: "TailnetTrustRefusedError",
        reason: refusal.reason ?? "tailnet_device_not_trusted",
        detail: refusal.detail,
      });
      if (refusal.asksTailscale === false) {
        expect(yield* Ref.get(whoisCalls)).toEqual([]);
      }
    }),
  ),
);

it.effect("refuses to issue a session when the device is not trusted", () =>
  runScenario({ enabled: false }, () =>
    Effect.gen(function* () {
      const trust = yield* TailnetTrust.TailnetTrust;
      yield* Effect.flip(trust.issueSession(direct(), {}));
      expect(yield* tailnetSessionIds).toEqual([]);
    }),
  ),
);

it.effect("keeps one session per device, replacing the one it had", () =>
  runScenario({}, () =>
    Effect.gen(function* () {
      const trust = yield* TailnetTrust.TailnetTrust;
      const sessions = yield* SessionStore.SessionStore;
      const first = yield* sessions.verify((yield* trust.issueSession(direct(), {})).access_token);
      const second = yield* sessions.verify((yield* trust.issueSession(direct(), {})).access_token);
      expect(yield* tailnetSessionIds).toEqual([second.sessionId]);
      expect(yield* Effect.flip(sessions.verify(first.token))).toMatchObject({
        _tag: "SessionTokenRevokedError",
      });
    }),
  ),
);

it.effect("trust turned off while Tailscale answers leaves no session behind", () =>
  Effect.gen(function* () {
    const asked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* runScenario({ whoisGate: { asked, release } }, () =>
      Effect.gen(function* () {
        const trust = yield* TailnetTrust.TailnetTrust;
        const settings = yield* ServerSettingsService;
        const admitting = yield* Effect.forkChild(trust.issueSession(direct(), {}));
        yield* Deferred.await(asked);
        yield* settings.updateSettings({ tailnetTrustEnabled: false });
        yield* Deferred.succeed(release, undefined);
        expect(yield* Effect.flip(Fiber.join(admitting))).toMatchObject({
          reason: "tailnet_trust_disabled",
          detail: "turned_off_while_admitting",
        });
        expect(yield* tailnetSessionIds).toEqual([]);
      }),
    );
  }),
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

it.effect("reconcile, which startup awaits, revokes sessions left from before trust was off", () =>
  runScenario({ enabled: false }, () =>
    Effect.gen(function* () {
      const trust = yield* TailnetTrust.TailnetTrust;
      const sessions = yield* SessionStore.SessionStore;
      const left = yield* sessions.issue({
        subject: `${TAILNET_DEVICE_SUBJECT_PREFIX}nMacbook`,
        method: "bearer-access-token",
      });
      const paired = yield* sessions.issue({ subject: "one-time-token" });
      yield* trust.reconcile;
      expect((yield* sessions.listActive()).map((session) => session.sessionId)).toEqual([
        paired.sessionId,
      ]);
      expect(yield* Effect.flip(sessions.verify(left.token))).toMatchObject({
        _tag: "SessionTokenRevokedError",
      });
    }),
  ),
);
