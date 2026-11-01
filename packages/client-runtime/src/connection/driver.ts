import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import type {
  ConnectionAttemptError,
  ConnectionAttemptStage,
  PreparedConnection,
} from "./model.ts";
import { ConnectionTransientError } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import {
  connectionRoutes,
  routeEntry,
  routeHttpBaseUrl,
  sendsTokenInClear,
  usableRoutes,
} from "./routes.ts";
import * as RpcSession from "../rpc/session.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ConnectionTimings from "./timings.ts"; // temp: connection timings

export type ConnectionDriverProgress =
  | {
      readonly stage: "preparing";
    }
  | {
      readonly stage: Exclude<ConnectionAttemptStage, "preparing">;
      readonly prepared: PreparedConnection;
    };

export interface EnvironmentConnectionLease {
  readonly prepared: PreparedConnection;
  readonly session: RpcSession.RpcSession;
}

export type RouteCheck = "answered" | "silent" | "unchecked";

const ROUTE_CHECK_TIMEOUT_MS = 2_500;
// Preferred direct routes share one head start, so a relay or SSH connection
// does not wait the full probe timeout for a LAN the device has already left.
// A route that answers later still takes over while that fallback connects.
const ROUTE_CHECK_HEAD_START_MS = 500;

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      entry: ConnectionCatalogEntry,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
    ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope>;
    readonly preflight: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<boolean>;
    /** Asks the host behind a live session to answer a fresh request on the session's own origin. */
    readonly checkHost: (prepared: PreparedConnection) => Effect.Effect<RouteCheck>;
  }
>()("@t3tools/client-runtime/connection/driver/ConnectionDriver") {}

export const connectOverRoutes = Effect.fn("ConnectionDriver.connectOverRoutes")(function* <R>(
  entry: ConnectionCatalogEntry,
  checkRoute: (route: ConnectionRoute) => Effect.Effect<RouteCheck>,
  connectRoute: (
    route: ConnectionRoute,
  ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, R | Scope.Scope>,
) {
  const routes = usableRoutes(entry);
  const checks =
    routes.length === 1
      ? []
      : yield* Effect.forEach(routes, (route) => Effect.forkChild(checkRoute(route)));
  const headStart = yield* Effect.forkChild(Effect.sleep(ROUTE_CHECK_HEAD_START_MS));
  const attemptScope = yield* Scope.Scope;
  let transient: ConnectionAttemptError | undefined;
  let blocked: ConnectionAttemptError | undefined;
  // Each route gets its own scope so a half-open session closes before the next try.
  const attempt = Effect.fnUntraced(function* (route: ConnectionRoute) {
    const routeScope = yield* Scope.fork(attemptScope);
    const result = yield* connectRoute(route).pipe(
      Scope.provide(routeScope),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(routeScope, exit))),
      Effect.result,
    );
    if (result._tag === "Failure") {
      if (result.failure._tag === "ConnectionTransientError") transient ??= result.failure;
      else blocked ??= result.failure;
    }
    return result;
  });
  interface SilentRoute {
    readonly route: ConnectionRoute;
    readonly index: number;
  }
  const silent: Array<SilentRoute> = [];
  // Succeeds with the first silent route whose check answers, and fails once none can.
  const firstAnswer = (candidates: ReadonlyArray<SilentRoute>) =>
    candidates.length === 0
      ? Effect.fail(undefined)
      : Effect.raceAll(
          candidates.map((candidate) =>
            Fiber.join(checks[candidate.index]!).pipe(
              Effect.flatMap((check) =>
                check === "answered" ? Effect.succeed(candidate) : Effect.fail(undefined),
              ),
            ),
          ),
        );
  const deferred: Array<ConnectionRoute> = [];
  for (const [index, route] of routes.entries()) {
    const check =
      checks.length === 0
        ? "unchecked"
        : yield* Effect.raceFirst(
            Fiber.join(checks[index]!),
            Fiber.join(headStart).pipe(Effect.as<RouteCheck>("silent")),
          );
    if (check === "silent") {
      silent.push({ route, index });
      continue;
    }
    // An unchecked route (relay, SSH) starts once the head start is spent, but a
    // preferred route that answers before it connects takes over, so a check a
    // few milliseconds late on a slow link does not cost the slower route.
    const outcome =
      check === "unchecked" && silent.length > 0
        ? yield* Effect.raceFirst(
            attempt(route),
            firstAnswer(silent).pipe(
              Effect.catch(() => Effect.never),
              Effect.as("preempted" as const),
            ),
          )
        : yield* attempt(route);
    if (outcome === "preempted") {
      deferred.push(...routes.slice(index));
      break;
    }
    if (outcome._tag === "Success") return outcome.success;
    // An incompatible server is the same server on every route.
    if (outcome.failure.reason === "unsupported") return yield* outcome.failure;
  }
  // Silent routes go in the order their checks answer, without waiting for a
  // route that is still dead, which can hold an attempt open far longer than its probe.
  let unanswered = silent;
  while (true) {
    const answered = yield* firstAnswer(unanswered).pipe(Effect.option);
    if (answered._tag === "None") break;
    unanswered = unanswered.filter((candidate) => candidate !== answered.value);
    const result = yield* attempt(answered.value.route);
    if (result._tag === "Success") return result.success;
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  for (const route of [...deferred, ...unanswered.map((candidate) => candidate.route)]) {
    const result = yield* attempt(route);
    if (result._tag === "Success") return result.success;
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  return yield* (
    transient ??
      blocked ??
      new ConnectionTransientError({
        reason: "endpoint-unavailable",
        detail: `${entry.target.label} did not answer on any saved route.`,
      })
  );
});

/** @public */
export const make = Effect.gen(function* () {
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;
  const httpClient = yield* HttpClient.HttpClient;

  // The descriptor is public, so this sends no credential to whatever
  // answers at a saved LAN address on a different network.
  const checkDescriptor = (
    httpBaseUrl: string,
    environmentId: string,
    onAnswer: (descriptor: ExecutionEnvironmentDescriptor) => void = () => {},
  ) =>
    fetchRemoteEnvironmentDescriptor({
      httpBaseUrl,
      timeoutMs: ROUTE_CHECK_TIMEOUT_MS,
    }).pipe(
      Effect.map((descriptor): RouteCheck => {
        if (descriptor.environmentId !== environmentId) return "silent";
        onAnswer(descriptor);
        return "answered";
      }),
      Effect.orElseSucceed((): RouteCheck => "silent"),
      // A cached descriptor would answer for a host that cannot be reached.
      Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store" }),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const checkRoute = (
    entry: ConnectionCatalogEntry,
    route: ConnectionRoute,
    onAnswer?: (descriptor: ExecutionEnvironmentDescriptor) => void,
  ) => {
    const httpBaseUrl = routeHttpBaseUrl(route);
    if (httpBaseUrl === null) return Effect.succeed<RouteCheck>("unchecked");
    return checkDescriptor(httpBaseUrl, entry.target.environmentId, onAnswer).pipe(
      Effect.withSpan("ConnectionDriver.checkRoute", {
        attributes: { "connection.target.kind": route.target._tag },
      }),
    );
  };

  const checkHost = (prepared: PreparedConnection) =>
    checkDescriptor(prepared.httpBaseUrl, prepared.environmentId).pipe(
      Effect.withSpan("ConnectionDriver.checkHost", {
        attributes: { "connection.target.kind": prepared.target._tag },
      }),
    );

  const connect = Effect.fn("ConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const target = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
      "connection.route.count": connectionRoutes(entry).length,
    });
    yield* reportProgress({ stage: "preparing" });
    // A route's check already fetched its descriptor, so its attempt skips fetching it again.
    const checked = new Map<ConnectionRoute, ExecutionEnvironmentDescriptor>();
    return yield* connectOverRoutes(
      entry,
      (route) => checkRoute(entry, route, (descriptor) => checked.set(route, descriptor)),
      Effect.fnUntraced(
        function* (route) {
          const prepared = yield* resolver.prepare(routeEntry(entry, route), checked.get(route));
          yield* ConnectionTimings.markPrepared; // temp: connection timings
          yield* reportProgress({ stage: "opening", prepared });
          const session = yield* sessions.connect(prepared);
          yield* reportProgress({ stage: "synchronizing", prepared });
          yield* session.ready;
          return { prepared, session } satisfies EnvironmentConnectionLease;
        },
        ConnectionTimings.measureAttempt, // temp: connection timings
      ),
    );
  }, ConnectionTimings.measureConnect); // temp: connection timings

  const preflight = (entry: ConnectionCatalogEntry, route: ConnectionRoute) =>
    (sendsTokenInClear(connectionRoutes(entry), route)
      ? Effect.succeed("silent" as const)
      : checkRoute(entry, route)
    ).pipe(
      Effect.flatMap((check) =>
        check === "answered"
          ? resolver.prepare(routeEntry(entry, route)).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false),
      ),
      Effect.withSpan("ConnectionDriver.preflight"),
    );

  return ConnectionDriver.of({ connect, preflight, checkHost });
});

export const layer = Layer.effect(ConnectionDriver, make);
