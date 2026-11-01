// temp: connection timings
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";

import { BearerConnectionProfile } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import { BearerConnectionTarget, type PreparedConnection } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as ConnectionTimings from "./timings.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";

const BODY = JSON.stringify({ threads: ["a", "b", "c"] });

const jsonHttpClient = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(BODY, { headers: { "content-length": String(BODY.length) } }),
    ),
  ),
);

const getJson = (url: string) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(HttpClientRequest.get(url)).pipe(Effect.flatMap((response) => response.json)),
  );

function readTimings(environmentId: EnvironmentId) {
  return AtomRegistry.make().get(ConnectionTimings.environmentTimingsAtom(environmentId));
}

describe("ConnectionTimings", () => {
  it.effect("records a connect's route, steps, socket open and shell snapshot", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("timings-connect");
      const httpBaseUrl = "http://100.100.1.2:3773";
      const prepared: PreparedConnection = {
        environmentId,
        label: "pulsar",
        httpBaseUrl,
        socketUrl: "ws://100.100.1.2:3773/ws",
        httpAuthorization: null,
        target: new BearerConnectionTarget({ environmentId, label: "pulsar", connectionId: "c1" }),
      };
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ConnectionResolver.ConnectionResolver, {
              prepare: () =>
                Effect.void.pipe(
                  ConnectionTimings.step("descriptor"),
                  Effect.andThen(Effect.void.pipe(ConnectionTimings.step("ticket"))),
                  Effect.as(prepared),
                ),
              prepareForUpdate: () => Effect.die("unused"),
            }),
            Layer.succeed(RpcSession.RpcSessionFactory, {
              // Like the real session: a forked fiber marks the open, and ready waits for it.
              connect: () =>
                Effect.gen(function* () {
                  const opened = yield* Deferred.make<void>();
                  yield* ConnectionTimings.markSocketOpen.pipe(
                    Effect.andThen(Deferred.succeed(opened, undefined)),
                    Effect.forkScoped,
                  );
                  return { ready: Deferred.await(opened) } as unknown as RpcSession.RpcSession;
                }),
            }),
            Layer.succeed(HttpClient.HttpClient, jsonHttpClient),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({}),
          ),
        ),
      );
      const lease = yield* driver.connect(
        {
          target: prepared.target,
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "c1",
              environmentId,
              label: "pulsar",
              httpBaseUrl,
              wsBaseUrl: "ws://100.100.1.2:3773",
              network: "tailscale",
            }),
          ),
          enabled: true,
        },
        () => Effect.void,
      );
      yield* getJson(`${httpBaseUrl}/api/shell`).pipe(
        ConnectionTimings.measureShellSnapshot(lease.prepared, jsonHttpClient),
      );
      ConnectionTimings.markShellSnapshotApplied(environmentId);

      const [connect] = readTimings(environmentId)?.connects ?? [];
      expect(connect).toMatchObject({
        outcome: "connected",
        route: { kind: "tailnet", address: httpBaseUrl },
        routeMs: expect.any(Number),
        authMs: expect.any(Number),
        descriptorMs: expect.any(Number),
        ticketMs: expect.any(Number),
        tokenMs: null,
        socketOpenMs: expect.any(Number),
        configMs: expect.any(Number),
        readyMs: expect.any(Number),
        shell: {
          source: "http",
          responseMs: expect.any(Number),
          bodyMs: expect.any(Number),
          decodeMs: expect.any(Number),
          appliedAtMs: expect.any(Number),
          bytes: BODY.length,
          wireBytes: BODY.length,
        },
      });
      expect(connect?.attempts).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("records a thread open's cache, HTTP snapshot and catch-up", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("timings-thread");
      const threadId = ThreadId.make("thread-1");
      const open = ConnectionTimings.startThreadOpen(environmentId, threadId);
      open.cached("disk");
      yield* getJson("http://host.test/api/thread").pipe(
        ConnectionTimings.measureThreadSnapshot(
          { environmentId } as PreparedConnection,
          threadId,
          jsonHttpClient,
        ),
      );
      open.item("event");
      open.item("synchronized");

      const [threadOpen] = readTimings(environmentId)?.threadOpens ?? [];
      expect(threadOpen).toMatchObject({
        threadId,
        cache: "disk",
        cacheMs: expect.any(Number),
        liveMs: expect.any(Number),
        snapshot: { source: "http", bytes: BODY.length, decodeMs: expect.any(Number) },
      });
    }),
  );
});
