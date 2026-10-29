import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as TailnetHttp from "./http.ts";
import { TailnetDiscovery } from "./TailnetDiscovery.ts";
import { TailnetTrust, TailnetTrustRefusedError } from "./TailnetTrust.ts";

class TailnetTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.tailnet) {}

const DISCOVERED = { available: true, peers: [] };

const session = (scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
  Effect.succeed({
    sessionId: AuthSessionId.make("tailnet-test"),
    subject: "tailnet-test",
    method: "bearer-access-token" as const,
    scopes,
  });

const layerRoutes = (trusted: boolean) =>
  HttpApiBuilder.layer(TailnetTestApi).pipe(
    Layer.provide(TailnetHttp.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: (request) => {
            switch (request.headers.authorization) {
              case undefined:
                return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
              case "Bearer reader":
                return session([AuthAccessReadScope]);
              case "Bearer other":
                return session([AuthOrchestrationReadScope]);
              default:
                return Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({}));
            }
          },
        }),
        Layer.mock(TailnetTrust)({
          identify: () =>
            trusted
              ? Effect.succeed({
                  stableId: "nPhone",
                  name: "phone",
                  loginName: "owner@github",
                  os: "iOS",
                  address: "100.64.0.9",
                })
              : Effect.fail(
                  new TailnetTrustRefusedError({
                    reason: "tailnet_device_not_trusted",
                    detail: "test",
                  }),
                ),
        }),
        Layer.mock(TailnetDiscovery)({ peers: Effect.succeed(DISCOVERED) }),
      ),
    ),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
  );

const requestPeers = (trusted: boolean, authorization?: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layerRoutes(trusted), { disableLogger: true })),
    ({ handler }) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request("http://100.64.0.1/api/tailnet/peers", {
            headers: authorization === undefined ? {} : { authorization },
          }),
          Context.empty(),
        );
        return { status: response.status, body: await response.json() };
      }),
    ({ dispose }) => Effect.promise(dispose),
  );

it.effect.each([
  { name: "a session with access:read", trusted: false, authorization: "Bearer reader" },
  { name: "a trusted device without a credential", trusted: true, authorization: undefined },
])("lists peers for $name", ({ trusted, authorization }) =>
  Effect.gen(function* () {
    const response = yield* requestPeers(trusted, authorization);
    expect(response).toEqual({ status: 200, body: DISCOVERED });
  }),
);

it.effect.each([
  {
    name: "a session without access:read",
    trusted: true,
    authorization: "Bearer other",
    status: 403,
    body: { code: "insufficient_scope" },
  },
  {
    name: "an untrusted device without a credential",
    trusted: false,
    authorization: undefined,
    status: 401,
    body: { reason: "missing_credential" },
  },
  {
    name: "an invalid credential from a trusted device",
    trusted: true,
    authorization: "Bearer stale",
    status: 401,
    body: { reason: "invalid_credential" },
  },
])("refuses $name", ({ trusted, authorization, status, body }) =>
  Effect.gen(function* () {
    const response = yield* requestPeers(trusted, authorization);
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject(body);
  }),
);
