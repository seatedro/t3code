import {
  EnvironmentId,
  EventId,
  ORCHESTRATION_V2_WS_METHODS,
  TurnItemId,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import { createEnvironmentThreadStateAtoms, type EnvironmentThreadState } from "./threads.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = v2ThreadId;
const THREAD: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, title: "Cached thread" },
};
const SNAPSHOT: OrchestrationV2ThreadDetailSnapshot = { snapshotSequence: 7, projection: THREAD };

const makeHarness = Effect.fn("TestThreadAtoms.makeHarness")(function* (options?: {
  readonly snapshot?: OrchestrationV2ThreadDetailSnapshot;
  readonly socketSnapshot?: false;
  /** The thread's saved copy on disk. */
  readonly saved?: OrchestrationV2ThreadDetailSnapshot;
}) {
  const subscriptions = yield* Queue.unbounded<{
    readonly afterSequence: number | undefined;
    readonly events: Queue.Queue<OrchestrationV2ThreadStreamItem>;
    readonly closed: Deferred.Deferred<void>;
  }>();
  const olderLoads = yield* Queue.unbounded<{
    readonly cursor: string | null;
    readonly response: Deferred.Deferred<OrchestrationV2ThreadHistoryPage>;
    readonly closed: Deferred.Deferred<void>;
  }>();
  const snapshot = options?.snapshot ?? SNAPSHOT;
  const saves = yield* Queue.unbounded<OrchestrationV2ThreadDetailSnapshot>();
  let httpLoads = 0;
  let diskLoads = 0;
  let opened = 0;
  let active = 0;
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: { readonly afterSequence?: number }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
          const closed = yield* Deferred.make<void>();
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              opened += 1;
              active += 1;
            }),
            () =>
              Effect.sync(() => {
                active -= 1;
              }).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
          );
          yield* Queue.offer(subscriptions, { afterSequence: input.afterSequence, events, closed });
          // Like a paging server, a fresh subscribe opens with the bounded snapshot.
          if (input.afterSequence === undefined && options?.socketSnapshot !== false) {
            yield* Queue.offer(events, { kind: "snapshot", ...snapshot });
          }
          return Stream.fromQueue(events);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({
      threadResumeCompletionMarker: true,
      threadSnapshotPagination: true,
    } as never),
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        socketUrl: TARGET.wsBaseUrl,
        httpAuthorization: null,
        target: TARGET,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: () => Effect.die("Unexpected environment registration"),
    assertKnownAddress: () => Effect.die("Unexpected address check"),
    reconcilePlatform: () => Effect.die("Unexpected environment reconciliation"),
    remove: () => Effect.die("Unexpected environment removal"),
    removeRoute: () => Effect.die("Unexpected route removal"),
    reorderRoutes: () => Effect.die("Unexpected route reorder"),
    removeRelayEnvironments: () => Effect.die("Unexpected environment removal"),
    retryNow: () => Effect.void,
    setEnabled: () => Effect.die("Unexpected environment toggle"),
    setCompatibility: () => Effect.die("Unexpected compatibility update"),
    state: () => SubscriptionRef.get(supervisor.state),
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  });
  const historyController = yield* Effect.service(
    ThreadHistoryController.ThreadHistoryController,
  ).pipe(Effect.provide(ThreadHistoryController.layer));
  const historyHttpClient = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const response = yield* Deferred.make<OrchestrationV2ThreadHistoryPage>();
      const closed = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
      yield* Queue.offer(olderLoads, { cursor: url.searchParams.get("cursor"), response, closed });
      const page = yield* Deferred.await(response);
      return HttpClientResponse.fromWeb(request, Response.json(page));
    }).pipe(Effect.scoped),
  );
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () =>
      Effect.sync(() => {
        diskLoads += 1;
        return Option.fromUndefinedOr(options?.saved);
      }),
    saveThread: (_environmentId, saved) => Queue.offer(saves, saved),
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(ThreadHistoryController.ThreadHistoryController, historyController),
      Layer.succeed(HttpClient.HttpClient, historyHttpClient),
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(Persistence.EnvironmentCacheStore, cache),
      Layer.succeed(
        ThreadSnapshotLoader.ThreadSnapshotLoader,
        ThreadSnapshotLoader.ThreadSnapshotLoader.of({
          load: () =>
            Effect.sync(() => {
              httpLoads += 1;
              return {
                _tag: "present" as const,
                snapshot,
                ...(snapshot.historyCursor === undefined
                  ? {}
                  : {
                      history: {
                        historyCursor: snapshot.historyCursor,
                        hasMoreHistory: snapshot.hasMoreHistory ?? false,
                        latestLocalTurnOrdinal: snapshot.latestLocalTurnOrdinal ?? null,
                      },
                    }),
              };
            }),
        }),
      ),
    ),
  );
  const raw = createEnvironmentThreadStateAtoms(runtime);
  const details = createEnvironmentThreadDetailAtoms(raw.stateAtom);
  const ref = { environmentId: TARGET.environmentId, threadId: THREAD_ID };
  const stateAtom = details.stateAtom(ref);
  const makeRegistry = Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make({ defaultIdleTTL: 60_000, timeoutResolution: 1 })),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  const registry = yield* makeRegistry;

  return {
    registry,
    makeRegistry,
    rawAtoms: raw,
    stateAtom,
    details,
    ref,
    subscriptions,
    olderLoads,
    saves,
    cache,
    loadEarlier: () => historyController.loadEarlier(TARGET.environmentId, THREAD_ID),
    counts: () => ({ httpLoads, diskLoads, opened, active }),
  };
});

function observeState(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

function currentThread(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<EnvironmentThreadState>,
) {
  return Option.getOrThrow(registry.get(atom).data);
}

describe("createEnvironmentThreadStateAtoms", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.effect("keeps warm data and resumes a completed cursor without loading another snapshot", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      yield* Queue.offer(first.events, {
        kind: "event",
        sequence: 8,
        event: {
          id: EventId.make("metadata-1"),
          type: "thread.metadata-updated",
          threadId: THREAD_ID,
          occurredAt: THREAD.thread.updatedAt,
          payload: { ...THREAD.thread, title: "Retained title" },
        },
      });
      yield* Queue.offer(first.events, { kind: "synchronized" });
      yield* observeState(h.registry, h.stateAtom, (state) => state.status === "live");
      const before = currentThread(h.registry, h.stateAtom);
      unmount();
      yield* Deferred.await(first.closed);
      const remount = h.registry.mount(h.stateAtom);
      expect(currentThread(h.registry, h.stateAtom)).toBe(before);
      const next = yield* Queue.take(h.subscriptions);
      expect(next.afterSequence).toBe(8);
      expect(h.counts()).toEqual({ httpLoads: 0, diskLoads: 1, opened: 2, active: 1 });
      remount();
      yield* Deferred.await(next.closed);
    }),
  );

  it.effect("cancels older-page work on unmount and permits it again on a warm return", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        snapshot: {
          ...SNAPSHOT,
          historyCursor: "older-1",
          hasMoreHistory: true,
        },
      });
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      const loading = yield* h.loadEarlier().pipe(Effect.forkScoped);
      const older = yield* Queue.take(h.olderLoads);
      expect(h.registry.get(h.stateAtom).history.loading).toBe(true);
      unmount();
      yield* Deferred.await(first.closed);
      yield* Deferred.await(older.closed);
      yield* Fiber.await(loading);
      const remount = h.registry.mount(h.stateAtom);
      const next = yield* Queue.take(h.subscriptions);
      expect(h.registry.get(h.stateAtom).history.loading).toBe(false);
      const retrying = yield* h.loadEarlier().pipe(Effect.forkScoped);
      const retried = yield* Queue.take(h.olderLoads);
      expect(retried.cursor).toBe("older-1");
      expect(h.counts().httpLoads).toBe(0);
      remount();
      yield* Deferred.await(next.closed);
      yield* Deferred.await(retried.closed);
      yield* Fiber.await(retrying);
    }),
  );

  it.effect("opens from the bounded socket snapshot without HTTP and merges older history", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ socketSnapshot: false });
      const unmount = h.registry.mount(h.stateAtom);
      const subscription = yield* Queue.take(h.subscriptions);
      expect(subscription.afterSequence).toBeUndefined();

      yield* Queue.offer(subscription.events, {
        kind: "snapshot",
        snapshotSequence: 12,
        projection: THREAD,
        historyCursor: "socket-older-1",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 4,
      });
      yield* Queue.offer(subscription.events, { kind: "synchronized" });
      yield* observeState(
        h.registry,
        h.stateAtom,
        (state) => state.status === "live" && state.history.historyCursor === "socket-older-1",
      );

      const loading = yield* h.loadEarlier().pipe(Effect.forkScoped);
      const request = yield* Queue.take(h.olderLoads);
      expect(request.cursor).toBe("socket-older-1");
      const olderItem = {
        id: TurnItemId.make("socket-fallback-older-item"),
        type: "command_execution" as const,
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed" as const,
        title: "Earlier command",
        input: "pwd",
        output: "/workspace",
        exitCode: 0,
        startedAt: THREAD.thread.createdAt,
        completedAt: THREAD.thread.createdAt,
        updatedAt: THREAD.thread.createdAt,
      };
      yield* Deferred.succeed(request.response, {
        snapshotSequence: 12,
        items: [
          {
            position: 0,
            visibility: "local",
            sourceThreadId: THREAD_ID,
            sourceItemId: olderItem.id,
            item: olderItem,
          },
        ],
        nextCursor: null,
        hasMoreHistory: false,
      });
      expect(yield* Fiber.join(loading)).toEqual({ _tag: "loaded" });

      const state = h.registry.get(h.stateAtom);
      expect(Option.getOrThrow(state.data).visibleTurnItems.map((row) => row.sourceItemId)).toEqual(
        [olderItem.id],
      );
      expect(state.history).toMatchObject({
        historyCursor: null,
        hasMoreHistory: false,
        loading: false,
        error: null,
        expanded: true,
        latestLocalTurnOrdinal: 4,
      });
      expect(h.counts().httpLoads).toBe(0);

      unmount();
      yield* Deferred.await(subscription.closed);
    }),
  );
});

it.effect("keeps snapshot boundaries and completion markers ordered inside a replay batch", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const unmount = h.registry.mount(h.stateAtom);
    const first = yield* Queue.take(h.subscriptions);
    const title = (sequence: number, value: string): OrchestrationV2ThreadStreamItem => ({
      kind: "event",
      sequence,
      event: {
        id: EventId.make(`batch-title-${sequence}`),
        type: "thread.metadata-updated",
        threadId: THREAD_ID,
        occurredAt: THREAD.thread.updatedAt,
        payload: { ...THREAD.thread, title: value },
      },
    });
    yield* Queue.offerAll(first.events, [
      title(8, "Before snapshot"),
      {
        kind: "snapshot",
        snapshotSequence: 20,
        projection: THREAD,
        historyCursor: "older-batch",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 10,
      },
      title(21, "After snapshot"),
      title(19, "Stale replay"),
      { kind: "synchronized" },
    ]);
    const state = yield* observeState(h.registry, h.stateAtom, (value) => value.status === "live");
    expect(Option.getOrThrow(state.data).thread.title).toBe("After snapshot");
    expect(state.history.historyCursor).toBe("older-batch");
    expect(state.history.latestLocalTurnOrdinal).toBe(10);
    unmount();
    yield* Deferred.await(first.closed);
    const remount = h.registry.mount(h.stateAtom);
    const next = yield* Queue.take(h.subscriptions);
    expect(next.afterSequence).toBe(21);
    remount();
    yield* Deferred.await(next.closed);
  }),
);

describe("catchUp", () => {
  const minutes = (count: number) => DateTime.add(THREAD.thread.updatedAt, { minutes: count });
  const titleEvent = (
    sequence: number,
    title: string,
    occurredAt: DateTime.Utc,
  ): OrchestrationV2ThreadStreamItem => ({
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`catch-up-title-${sequence}`),
      type: "thread.metadata-updated",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...THREAD.thread, title },
    },
  });
  const catchUp = (
    h: Effect.Success<ReturnType<typeof makeHarness>>,
    shellUpdatedAt: DateTime.Utc,
    maxBehindMs = 60 * 60_000,
  ) =>
    h.rawAtoms
      .catchUp({
        registry: h.registry,
        environmentId: TARGET.environmentId,
        threadId: THREAD_ID,
        shellUpdatedAt: DateTime.toEpochMillis(shellUpdatedAt),
        maxBehindMs,
        timeout: "20 seconds",
      })
      .pipe(Effect.provideService(Persistence.EnvironmentCacheStore, h.cache));

  it.effect("resumes a saved copy from its sequence, saves the result, and lets go", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ saved: SNAPSHOT });
      const running = yield* catchUp(h, minutes(5)).pipe(Effect.forkScoped);
      const subscription = yield* Queue.take(h.subscriptions);
      expect(subscription.afterSequence).toBe(SNAPSHOT.snapshotSequence);
      yield* Queue.offerAll(subscription.events, [
        titleEvent(9, "Caught up", minutes(5)),
        { kind: "synchronized" },
      ]);
      expect(yield* Fiber.join(running)).toBe("caught-up");
      const saved = yield* Queue.take(h.saves);
      expect(saved.snapshotSequence).toBe(9);
      expect(saved.projection.thread.title).toBe("Caught up");
      yield* Deferred.await(subscription.closed);
      // The disk copy is decoded once: the thread starts from the copy catch-up loaded.
      expect(h.counts()).toEqual({ httpLoads: 0, diskLoads: 1, opened: 1, active: 0 });
    }),
  );

  it.effect("leaves no copy, a copy as new as the shell, and a copy too far behind alone", () =>
    Effect.gen(function* () {
      const none = yield* makeHarness();
      expect(yield* catchUp(none, minutes(5))).toBe("absent");
      expect(none.counts()).toMatchObject({ httpLoads: 0, opened: 0 });

      // Events after the last thread-record event move only the projection's clock.
      const saved = yield* makeHarness({
        saved: { ...SNAPSHOT, projection: { ...THREAD, updatedAt: minutes(2) } },
      });
      expect(yield* catchUp(saved, minutes(2))).toBe("current");
      expect(yield* catchUp(saved, minutes(63))).toBe("too-old");
      expect(saved.counts()).toMatchObject({ httpLoads: 0, opened: 0 });
    }),
  );

  it.effect("leaves an open thread to its own subscription", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ saved: SNAPSHOT });
      const unmount = h.registry.mount(h.stateAtom);
      const open = yield* Queue.take(h.subscriptions);
      expect(yield* catchUp(h, minutes(5))).toBe("open");
      expect(h.counts().opened).toBe(1);
      unmount();
      yield* Deferred.await(open.closed);
    }),
  );

  it.effect("resumes a copy kept from a live view and waits for the server to confirm", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ saved: SNAPSHOT });
      const unmount = h.registry.mount(h.stateAtom);
      const viewed = yield* Queue.take(h.subscriptions);
      yield* Queue.offerAll(viewed.events, [
        titleEvent(8, "Viewed", minutes(1)),
        { kind: "synchronized" },
      ]);
      yield* observeState(h.registry, h.stateAtom, (state) => state.status === "live");
      unmount();
      yield* Deferred.await(viewed.closed);

      const running = yield* catchUp(h, minutes(5)).pipe(Effect.forkScoped);
      const resumed = yield* Queue.take(h.subscriptions);
      expect(resumed.afterSequence).toBe(8);
      // A kept live status would let go before the replay; it must wait for the marker.
      yield* observeState(h.registry, h.stateAtom, (state) => state.status === "synchronizing");
      yield* Queue.offerAll(resumed.events, [
        titleEvent(9, "Caught up", minutes(5)),
        { kind: "synchronized" },
      ]);
      expect(yield* Fiber.join(running)).toBe("caught-up");
      expect((yield* Queue.take(h.saves)).projection.thread.title).toBe("Viewed");
      expect((yield* Queue.take(h.saves)).projection.thread.title).toBe("Caught up");
      expect(h.counts()).toMatchObject({ diskLoads: 1, opened: 2 });
    }),
  );
});
