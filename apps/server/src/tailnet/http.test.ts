import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import type { TailscaleNode, TailscaleWhois } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as TailnetSessionGate from "../auth/TailnetSessionGate.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TailnetHttp from "./http.ts";
import { TailnetDiscovery } from "./TailnetDiscovery.ts";
import * as TailnetTrust from "./TailnetTrust.ts";
import { TailscaleLocal } from "./TailscaleLocal.ts";

class TailnetTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.tailnet) {}

const SERVER_IP = "100.84.4.32";
const PHONE_IP = "100.125.201.106";
const DISCOVERED = { available: true, peers: [] };

const tailscaleNode = (overrides: Partial<TailscaleNode>): TailscaleNode => ({
  stableId: "nPhone",
  name: "iphone",
  magicDnsName: "iphone.tail87c919.ts.net",
  os: "iOS",
  userId: 1,
  loginName: "owner@github",
  tagged: false,
  tailnetIpv4Addresses: [PHONE_IP],
  tailnetAddresses: [PHONE_IP],
  online: true,
  sharee: false,
  ...overrides,
});

const phoneWhois: TailscaleWhois = {
  stableId: "nPhone",
  name: "iphone",
  magicDnsName: "iphone.tail87c919.ts.net",
  os: "iOS",
  userId: 1,
  loginName: "owner@github",
  tagged: false,
  shared: false,
  routesOtherHosts: false,
};

/** Only tailscaled is faked; routing, CORS, auth, trust and sessions are the server's own. */
const makeLayerRoutes = (tailnetTrustEnabled: boolean) =>
  HttpApiBuilder.layer(TailnetTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(TailnetHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(ServerHttp.layerBrowserApiCors),
    Layer.provide(TailnetTrust.layer),
    Layer.provide(Layer.mock(TailnetDiscovery)({ peers: Effect.succeed(DISCOVERED) })),
    Layer.provide(
      Layer.succeed(
        TailscaleLocal,
        TailscaleLocal.of({
          tailnet: Effect.succeed({
            running: true,
            self: tailscaleNode({
              stableId: "nPulsar",
              name: "pulsar",
              magicDnsName: "pulsar.tail87c919.ts.net",
              os: "linux",
              tailnetIpv4Addresses: [SERVER_IP],
              tailnetAddresses: [SERVER_IP],
            }),
            peers: [tailscaleNode({})],
          }),
          whois: (address) => Effect.succeed(address === PHONE_IP ? phoneWhois : null),
        }),
      ),
    ),
    Layer.provideMerge(
      EnvironmentAuth.layer.pipe(
        Layer.provide(TailnetSessionGate.layerFromSettings),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
      ),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest({ tailnetTrustEnabled })),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailnet-http-" })),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
  );

/** A web Request carrying the socket a Node server would see, so trust reads real addresses. */
const fromPhone = (
  path: string,
  init: RequestInit & { readonly socket?: { remoteAddress: string; localAddress: string } } = {},
) =>
  Object.assign(
    new Request(`http://pulsar:3773${path}`, {
      ...init,
      headers: { host: "pulsar:3773", ...init.headers },
    }),
    { socket: init.socket ?? { remoteAddress: PHONE_IP, localAddress: SERVER_IP } },
  );

const askForSession = (headers: Record<string, string> = {}) =>
  fromPhone("/api/auth/tailnet-session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ client_label: "Flock" }),
  });

/** These routes never reach the secret store; a DPoP proof is checked only after its token. */
const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
  get: () => Effect.succeedNone,
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: () => Effect.die("Not used by these routes."),
  remove: () => Effect.void,
});

const withServer = <A>(
  use: (handle: (request: Request) => Promise<Response>) => Promise<A>,
  options: { readonly tailnetTrustEnabled?: boolean } = {},
) => {
  const layerRoutes = makeLayerRoutes(options.tailnetTrustEnabled ?? true);
  const context = Context.make(ServerSecretStore.ServerSecretStore, unusedSecretStore);
  return Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
    ({ handler }) => Effect.promise(() => use((request) => handler(request, context))),
    ({ dispose }) => Effect.promise(dispose),
  );
};

it.effect("a trusted device gets a working session without a code", () =>
  withServer(async (handle) => {
    const issued = await handle(askForSession());
    expect(issued.status).toBe(200);
    const { access_token } = (await issued.json()) as { access_token: string };
    const authorization = { authorization: `Bearer ${access_token}` };

    const state = await handle(fromPhone("/api/auth/session", { headers: authorization }));
    expect(await state.json()).toMatchObject({ authenticated: true });
    const peers = await handle(fromPhone("/api/tailnet/peers", { headers: authorization }));
    expect({ status: peers.status, body: await peers.json() }).toEqual({
      status: 200,
      body: DISCOVERED,
    });
    // The same device again gets one session, not another.
    expect((await handle(askForSession())).status).toBe(200);
    const stale = await handle(fromPhone("/api/auth/session", { headers: authorization }));
    expect(await stale.json()).toMatchObject({ authenticated: false });
  }),
);

it.effect.each([
  { name: "a page on another origin", headers: { origin: "https://evil.example" } },
  { name: "a sandboxed page", headers: { origin: "null" } },
  { name: "a rebound page fetching same-origin", headers: { "sec-fetch-site": "same-origin" } },
  { name: "a rebound Host", headers: { host: "evil.example:3773" } },
])("refuses $name on both routes", ({ headers }) =>
  withServer(async (handle) => {
    const issued = await handle(askForSession(headers));
    expect(issued.status).toBe(403);
    expect(await issued.json()).toMatchObject({ reason: "tailnet_device_not_trusted" });
    expect(issued.headers.get("access-control-allow-origin")).toBeNull();
    const peers = await handle(fromPhone("/api/tailnet/peers", { headers }));
    expect(peers.status).toBe(401);
    expect(await peers.json()).toMatchObject({ reason: "missing_credential" });
  }),
);

it.effect("tells a trusted device that this machine has trust off", () =>
  withServer(
    async (handle) => {
      const issued = await handle(askForSession());
      expect(issued.status).toBe(403);
      expect(await issued.json()).toMatchObject({
        code: "operation_forbidden",
        reason: "tailnet_trust_disabled",
      });
    },
    { tailnetTrustEnabled: false },
  ),
);

it.effect("refuses a connection that did not arrive over the tailnet", () =>
  withServer(async (handle) => {
    const lan = { remoteAddress: "192.168.1.40", localAddress: "192.168.1.20" };
    const issued = await handle(
      fromPhone("/api/auth/tailnet-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        socket: lan,
      }),
    );
    expect(issued.status).toBe(403);
    expect((await handle(fromPhone("/api/tailnet/peers", { socket: lan }))).status).toBe(401);
  }),
);

it.effect("answers no browser preflight on the two routes trust admits", () =>
  withServer(async (handle) => {
    const preflight = (path: string) =>
      handle(
        fromPhone(path, {
          method: "OPTIONS",
          headers: {
            origin: "https://evil.example",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        }),
      );
    for (const path of ["/api/auth/tailnet-session", "/api/tailnet/peers"]) {
      expect((await preflight(path)).headers.get("access-control-allow-origin")).toBeNull();
    }
    // Other browser API routes keep their CORS.
    expect((await preflight("/api/auth/session")).headers.get("access-control-allow-origin")).toBe(
      "*",
    );
  }),
);

it.effect.each([
  { name: "an invalid bearer", credential: () => ({ authorization: "Bearer stale" }) },
  {
    name: "an invalid DPoP token",
    credential: () => ({ authorization: "DPoP stale", dpop: "proof" }),
  },
  {
    name: "a stale session cookie",
    credential: (cookieName: string) => ({ cookie: `${cookieName}=stale` }),
  },
])("a trusted device with $name is not let in on its tailnet identity", ({ credential }) =>
  withServer(async (handle) => {
    const state = (await (await handle(fromPhone("/api/auth/session"))).json()) as {
      auth: { sessionCookieName: string };
    };
    const peers = await handle(
      fromPhone("/api/tailnet/peers", { headers: credential(state.auth.sessionCookieName) }),
    );
    expect(peers.status).toBe(401);
    expect(await peers.json()).toMatchObject({ reason: "invalid_credential" });
  }),
);

it.effect("a session without access:read cannot list peers, even from a trusted device", () =>
  withServer(async (handle) => {
    const owner = (await (await handle(askForSession())).json()) as { access_token: string };
    const pairing = await handle(
      fromPhone("/api/auth/pairing-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.access_token}`,
        },
        body: JSON.stringify({ scopes: [AuthOrchestrationReadScope] }),
      }),
    );
    const { credential } = (await pairing.json()) as { credential: string };
    const exchanged = await handle(
      fromPhone("/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      }),
    );
    const reader = (await exchanged.json()) as { access_token: string };
    const peers = await handle(
      fromPhone("/api/tailnet/peers", {
        headers: { authorization: `Bearer ${reader.access_token}` },
      }),
    );
    expect(peers.status).toBe(403);
    expect(await peers.json()).toMatchObject({ code: "insufficient_scope" });
  }),
);
