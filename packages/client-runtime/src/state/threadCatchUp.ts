import type {
  EnvironmentId,
  OrchestrationV2ShellThreadStatus,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import { connectionProjectionPhase } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { EnvironmentShellState } from "./shell.ts";
import type { ThreadCatchUpInput, ThreadCatchUpOutcome } from "./threads.ts";

export const THREAD_CATCH_UP_POLICY = {
  concurrency: 2,
  /** Saved copies opened per pass. A thread without one costs a key lookup and doesn't count. */
  maxCopiesPerPass: 6,
  /**
   * A median turn writes ~70 events and the server replays at most 128, so a copy days behind
   * would come back as a full snapshot for a thread nobody has opened here since.
   */
  maxBehindMs: 3 * 24 * 60 * 60_000,
  /** Shell changes inside this window fold into one pass. */
  passDelayMs: 2_000,
  /** Between catch-ups of one thread, and before a pass resumes threads left over by the cap. */
  cooldownMs: 30_000,
  timeoutMs: 20_000,
} as const;

type CatchUpShellThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "updatedAt" | "status" | "pendingRuntimeRequest" | "archivedAt" | "deletedAt"
>;

export interface ThreadCatchUpTarget {
  readonly threadId: ThreadId;
  /** The shell's `updatedAt` in epoch ms when the target was taken. */
  readonly updatedAt: number;
  /** Asked for by name, as for a push: skips the cooldown and the staleness checks. */
  readonly explicit: boolean;
}

const RUNNING_STATUSES: ReadonlySet<OrchestrationV2ShellThreadStatus> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
]);

/**
 * Threads whose `updatedAt` moved since the last look, recording this look in `seen`. A thread
 * new to the shell counts as moved: it may be an old thread back in view. The first look,
 * normally the cached shell, only records.
 */
export function observeShellThreads(
  seen: Map<ThreadId, number> | undefined,
  threads: ReadonlyArray<CatchUpShellThread>,
): { readonly seen: Map<ThreadId, number>; readonly changed: ReadonlyArray<ThreadId> } {
  if (seen === undefined) {
    return {
      seen: new Map(threads.map((thread) => [thread.id, DateTime.toEpochMillis(thread.updatedAt)])),
      changed: [],
    };
  }
  const changed: ThreadId[] = [];
  for (const thread of threads) {
    const updatedAt = DateTime.toEpochMillis(thread.updatedAt);
    const previous = seen.get(thread.id);
    if (previous !== undefined && updatedAt <= previous) continue;
    seen.set(thread.id, updatedAt);
    changed.push(thread.id);
  }
  return { seen, changed };
}

function catchUpRank(target: ThreadCatchUpTarget, thread: CatchUpShellThread | undefined) {
  if (target.explicit) return 0;
  if (thread?.pendingRuntimeRequest != null) return 1;
  if (thread !== undefined && RUNNING_STATUSES.has(thread.status)) return 2;
  return 3;
}

/** Asked-for threads, then threads that need the user, then running ones, then newest first. */
export function orderThreadCatchUps(
  targets: ReadonlyArray<ThreadCatchUpTarget>,
  threads: ReadonlyMap<ThreadId, CatchUpShellThread>,
): ReadonlyArray<ThreadCatchUpTarget> {
  const ranked = targets.map((target) => ({
    target,
    rank: catchUpRank(target, threads.get(target.threadId)),
  }));
  ranked.sort((a, b) => a.rank - b.rank || b.target.updatedAt - a.target.updatedAt);
  return ranked.map((entry) => entry.target);
}

interface CatchUpGate {
  readonly connected: boolean;
  readonly foreground: boolean;
  readonly live: boolean;
}

const isGateOpen = (gate: CatchUpGate) => gate.connected && gate.foreground && gate.live;

export interface ThreadCatchUpScheduler {
  readonly observeShell: (state: EnvironmentShellState) => void;
  /** Whether the environment's connection is ready. */
  readonly setConnected: (connected: boolean) => void;
  readonly setForeground: (foreground: boolean) => void;
  readonly request: (threadId: ThreadId) => void;
}

/**
 * Keeps one environment's saved thread copies current while it is connected, its shell is live
 * and the app is in the foreground. Threads whose shell `updatedAt` moves are caught up in
 * passes; a pass waits out `passDelayMs` so a burst of changes folds into it. Inputs are plain
 * calls so registry listeners can feed them without a fiber per input.
 */
export const makeThreadCatchUpScheduler = Effect.fn("ThreadCatchUp.makeScheduler")(function* (
  catchUp: (target: ThreadCatchUpTarget) => Effect.Effect<ThreadCatchUpOutcome>,
) {
  const policy = THREAD_CATCH_UP_POLICY;
  let seen: Map<ThreadId, number> | undefined;
  let lastSnapshot: unknown;
  let lastThreads: ReadonlyArray<CatchUpShellThread> = [];
  const dirty = new Map<ThreadId, ThreadCatchUpTarget>();
  const cooldownUntil = new Map<ThreadId, number>();
  let gate: CatchUpGate = { connected: false, foreground: true, live: false };
  let urgent = false;
  let pass: Fiber.Fiber<number | undefined> | undefined;
  const wake = yield* Queue.sliding<void>(1);
  const signal = () => {
    Queue.offerUnsafe(wake, undefined);
  };
  const updateGate = (patch: Partial<CatchUpGate>) => {
    const wasOpen = isGateOpen(gate);
    gate = { ...gate, ...patch };
    if (wasOpen === isGateOpen(gate)) return;
    if (wasOpen) pass?.interruptUnsafe();
    else signal();
  };

  const runPass = Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const threads = new Map(lastThreads.map((thread) => [thread.id, thread]));
    const eligible: ThreadCatchUpTarget[] = [];
    for (const [threadId, target] of dirty) {
      const thread = threads.get(threadId);
      if (
        !target.explicit &&
        (thread === undefined || thread.archivedAt !== null || thread.deletedAt !== null)
      ) {
        dirty.delete(threadId);
        continue;
      }
      if (!target.explicit && (cooldownUntil.get(threadId) ?? 0) > startedAt) continue;
      eligible.push(target);
    }
    let opened = 0;
    const outcomes: ThreadCatchUpOutcome[] = [];
    yield* Effect.forEach(
      orderThreadCatchUps(eligible, threads),
      (target) =>
        Effect.gen(function* () {
          if (opened >= policy.maxCopiesPerPass) return;
          opened += 1;
          const outcome = yield* catchUp(target).pipe(
            Effect.catchCause(() => Effect.succeed("timed-out" as const)),
          );
          outcomes.push(outcome);
          if (outcome === "absent" || outcome === "open") opened -= 1;
          else {
            cooldownUntil.set(
              target.threadId,
              (yield* Clock.currentTimeMillis) + policy.cooldownMs,
            );
          }
          const latest = dirty.get(target.threadId);
          if (
            latest !== undefined &&
            latest.updatedAt <= target.updatedAt &&
            (target.explicit || !latest.explicit)
          ) {
            dirty.delete(target.threadId);
          }
        }),
      { concurrency: policy.concurrency, discard: true },
    );
    const endedAt = yield* Clock.currentTimeMillis;
    for (const [threadId, until] of cooldownUntil) {
      if (until <= endedAt) cooldownUntil.delete(threadId);
    }
    if (outcomes.length > 0) {
      yield* Effect.logDebug("Thread catch-up pass.").pipe(
        Effect.annotateLogs({
          durationMs: endedAt - startedAt,
          caughtUp: outcomes.filter((outcome) => outcome === "caught-up").length,
          checked: outcomes.length,
          waiting: dirty.size,
        }),
      );
    }
    // Leftovers past the cap and threads still cooling down get a pass of their own.
    let dueAt: number | undefined;
    for (const threadId of dirty.keys()) {
      const due = cooldownUntil.get(threadId) ?? endedAt + policy.cooldownMs;
      dueAt = dueAt === undefined ? due : Math.min(dueAt, due);
    }
    return dueAt;
  });

  yield* Effect.gen(function* () {
    let dueAt: number | undefined;
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      const signaled =
        dueAt === undefined
          ? yield* Queue.take(wake).pipe(Effect.as(true))
          : Option.isSome(
              yield* Effect.timeoutOption(
                Queue.take(wake),
                Duration.millis(Math.max(0, dueAt - now)),
              ),
            );
      dueAt = undefined;
      // A due pass is already coalesced; only fresh signals wait for more changes.
      if (signaled && !urgent) yield* Effect.sleep(Duration.millis(policy.passDelayMs));
      urgent = false;
      if (!isGateOpen(gate)) continue;
      pass = yield* Effect.forkChild(runPass, { startImmediately: true });
      const exit = yield* Fiber.await(pass);
      pass = undefined;
      dueAt = Exit.isSuccess(exit) ? exit.value : undefined;
    }
  }).pipe(Effect.forkScoped);

  return {
    observeShell: (state) => {
      if (Option.isSome(state.snapshot) && state.snapshot.value !== lastSnapshot) {
        lastSnapshot = state.snapshot.value;
        lastThreads = state.snapshot.value.threads;
        const observed = observeShellThreads(seen, lastThreads);
        seen = observed.seen;
        let added = false;
        for (const threadId of observed.changed) {
          const previous = dirty.get(threadId);
          added ||= previous === undefined;
          dirty.set(threadId, {
            threadId,
            updatedAt: seen.get(threadId) ?? 0,
            explicit: previous?.explicit ?? false,
          });
        }
        if (added) signal();
      }
      updateGate({ live: state.status === "live" });
    },
    setConnected: (connected) => updateGate({ connected }),
    setForeground: (foreground) => updateGate({ foreground }),
    request: (threadId) => {
      dirty.set(threadId, { threadId, updatedAt: seen?.get(threadId) ?? 0, explicit: true });
      urgent = true;
      signal();
    },
  } satisfies ThreadCatchUpScheduler;
});

export function createThreadCatchUpAtoms<R, E>(input: {
  readonly runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E
  >;
  readonly environmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
  readonly shellStateAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
  readonly catchUp: (
    input: ThreadCatchUpInput,
  ) => Effect.Effect<ThreadCatchUpOutcome, never, Persistence.EnvironmentCacheStore>;
  /** Always foreground when omitted. */
  readonly foregroundAtom?: Atom.Atom<boolean>;
}) {
  const requestListeners = new Set<(environmentId: EnvironmentId, threadId: ThreadId) => void>();

  const environmentAtom = Atom.family((environmentId: EnvironmentId) =>
    input.runtime
      .atom(
        Effect.gen(function* () {
          const registry = yield* AtomRegistry.AtomRegistry;
          const cache = yield* Persistence.EnvironmentCacheStore;
          const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
          const scheduler = yield* makeThreadCatchUpScheduler((target) =>
            input
              .catchUp({
                registry,
                environmentId,
                threadId: target.threadId,
                ...(target.explicit ? {} : { shellUpdatedAt: target.updatedAt }),
                maxBehindMs: THREAD_CATCH_UP_POLICY.maxBehindMs,
                timeout: Duration.millis(THREAD_CATCH_UP_POLICY.timeoutMs),
              })
              .pipe(Effect.provideService(Persistence.EnvironmentCacheStore, cache)),
          );
          const listen = <A>(atom: Atom.Atom<A>, listener: (value: A) => void) =>
            Effect.acquireRelease(
              Effect.sync(() => registry.subscribe(atom, listener, { immediate: true })),
              (cancel) => Effect.sync(cancel),
            );
          yield* listen(input.shellStateAtom(environmentId), scheduler.observeShell);
          if (input.foregroundAtom !== undefined) {
            yield* listen(input.foregroundAtom, scheduler.setForeground);
          }
          const request = (requested: EnvironmentId, threadId: ThreadId) => {
            if (requested === environmentId) scheduler.request(threadId);
          };
          yield* Effect.acquireRelease(
            Effect.sync(() => requestListeners.add(request)),
            () => Effect.sync(() => requestListeners.delete(request)),
          );
          yield* environments
            .followStream(
              environmentId,
              Stream.unwrap(
                EnvironmentSupervisor.EnvironmentSupervisor.pipe(
                  Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
                ),
              ),
            )
            .pipe(
              Stream.runForEach((state) =>
                Effect.sync(() =>
                  scheduler.setConnected(connectionProjectionPhase(state) === "ready"),
                ),
              ),
              Effect.forkScoped,
            );
        }),
      )
      .pipe(Atom.withLabel(`thread-catch-up:${environmentId}`)),
  );

  return {
    /** Mount once at the app root. */
    atom: Atom.make((get) => {
      for (const environmentId of get(input.environmentIdsAtom)) {
        get.mount(environmentAtom(environmentId));
      }
    }).pipe(Atom.withLabel("thread-catch-up")),
    /** Catches a thread up ahead of anything waiting, if this client has a copy of it. */
    request(environmentId: EnvironmentId, threadId: ThreadId) {
      for (const listener of requestListeners) listener(environmentId, threadId);
    },
  };
}
