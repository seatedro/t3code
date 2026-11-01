import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";

import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "./shell.ts";
import {
  observeShellThreads,
  orderThreadCatchUps,
  makeThreadCatchUpScheduler,
  THREAD_CATCH_UP_POLICY,
  type ThreadCatchUpTarget,
} from "./threadCatchUp.ts";
import type { ThreadCatchUpOutcome } from "./threads.ts";

const { passDelayMs, cooldownMs, maxCopiesPerPass } = THREAD_CATCH_UP_POLICY;
const BASE_MS = DateTime.toEpochMillis(v2ThreadShell.updatedAt);

function shellThread(
  id: string,
  updatedAtOffsetMs: number,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    updatedAt: DateTime.makeUnsafe(BASE_MS + updatedAtOffsetMs),
    ...overrides,
  };
}

function shellState(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  status: EnvironmentShellState["status"] = "live",
): EnvironmentShellState {
  return { ...EMPTY_SHELL_STATE, status, snapshot: Option.some({ ...v2ShellSnapshot, threads }) };
}

interface CatchUpCall {
  readonly target: ThreadCatchUpTarget;
  readonly at: number;
  readonly done: Deferred.Deferred<ThreadCatchUpOutcome>;
}

const makeScheduler = Effect.fn("TestThreadCatchUp.makeScheduler")(function* (options: {
  readonly connected: boolean;
  readonly shell: EnvironmentShellState;
}) {
  const calls = yield* Queue.unbounded<CatchUpCall>();
  let active = 0;
  let maxActive = 0;
  const scheduler = yield* makeThreadCatchUpScheduler((target) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<ThreadCatchUpOutcome>();
      active += 1;
      maxActive = Math.max(maxActive, active);
      yield* Queue.offer(calls, { target, at: yield* Clock.currentTimeMillis, done });
      return yield* Deferred.await(done).pipe(Effect.ensuring(Effect.sync(() => (active -= 1))));
    }),
  );
  scheduler.setConnected(options.connected);
  scheduler.observeShell(options.shell);
  return {
    scheduler,
    calls,
    maxActive: () => maxActive,
    /** Takes the next catch-up and finishes it with `outcome`. */
    finishNext: (outcome: ThreadCatchUpOutcome = "caught-up") =>
      Queue.take(calls).pipe(Effect.tap((call) => Deferred.succeed(call.done, outcome))),
  };
});

const threadIds = (...ids: ReadonlyArray<string>) => ids.map((id) => ThreadId.make(id));

describe("observeShellThreads", () => {
  it("records the first look, then reports threads that moved or came back into view", () => {
    const first = observeShellThreads(undefined, [shellThread("a", 0), shellThread("b", 0)]);
    expect(first.changed).toEqual([]);

    const next = observeShellThreads(first.seen, [
      shellThread("a", 0),
      shellThread("b", 1_000),
      shellThread("c", -60_000),
    ]);
    expect(next.changed).toEqual([ThreadId.make("b"), ThreadId.make("c")]);
    expect(observeShellThreads(next.seen, [shellThread("b", 1_000)]).changed).toEqual([]);
  });
});

describe("orderThreadCatchUps", () => {
  it("puts asked-for threads first, then threads that need the user, then running, then newest", () => {
    const threads = new Map(
      [
        shellThread("idle-new", 3_000),
        shellThread("idle-old", 1_000),
        shellThread("running", 0, { status: "running" }),
        shellThread("needs-user", -5_000, {
          pendingRuntimeRequest: {
            id: "request-1" as never,
            kind: "approval" as never,
            createdAt: v2ThreadShell.updatedAt,
          },
        }),
        shellThread("asked", -9_000),
      ].map((thread) => [thread.id, thread]),
    );
    const target = (id: string, explicit = false): ThreadCatchUpTarget => ({
      threadId: ThreadId.make(id),
      updatedAt: DateTime.toEpochMillis(threads.get(ThreadId.make(id))!.updatedAt),
      explicit,
    });
    const ordered = orderThreadCatchUps(
      [
        target("idle-old"),
        target("running"),
        target("idle-new"),
        target("asked", true),
        target("needs-user"),
      ],
      threads,
    );
    expect(ordered.map((entry) => entry.threadId)).toEqual([
      "asked",
      "needs-user",
      "running",
      "idle-new",
      "idle-old",
    ]);
  });
});

describe("makeThreadCatchUpScheduler", () => {
  it.effect("catches up two at a time, six saved copies per pass, then the rest", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 10 }, (_, index) => `thread-${index}`);
      const h = yield* makeScheduler({
        connected: true,
        shell: shellState(ids.map((id) => shellThread(id, 0))),
      });
      h.scheduler.observeShell(shellState(ids.map((id, index) => shellThread(id, 1_000 + index))));
      yield* TestClock.adjust(passDelayMs);

      const firstPass: CatchUpCall[] = [];
      // One finish frees one slot, so the queue sees each copy only once a slot opens.
      const absent = yield* h.finishNext("absent");
      for (let index = 0; index < maxCopiesPerPass; index += 1) {
        firstPass.push(yield* h.finishNext());
      }
      expect(h.maxActive()).toBe(2);
      expect([absent, ...firstPass].map((call) => call.target.threadId)).toEqual(
        threadIds(
          "thread-9",
          "thread-8",
          "thread-7",
          "thread-6",
          "thread-5",
          "thread-4",
          "thread-3",
        ),
      );

      yield* TestClock.adjust(cooldownMs);
      const rest = [yield* h.finishNext(), yield* h.finishNext(), yield* h.finishNext()];
      expect(rest.map((call) => call.target.threadId)).toEqual(
        threadIds("thread-2", "thread-1", "thread-0"),
      );
      expect(rest[0]!.at).toBeGreaterThanOrEqual(firstPass[0]!.at + cooldownMs);
    }),
  );

  it.effect("folds a thread's changes into one catch-up per cooldown, unless it is asked for", () =>
    Effect.gen(function* () {
      const h = yield* makeScheduler({
        connected: true,
        shell: shellState([shellThread("busy", 0)]),
      });
      for (const offset of [1_000, 1_500, 2_000]) {
        h.scheduler.observeShell(shellState([shellThread("busy", offset)]));
      }
      yield* TestClock.adjust(passDelayMs);
      const first = yield* h.finishNext();
      expect(first.target.updatedAt).toBe(BASE_MS + 2_000);

      h.scheduler.observeShell(shellState([shellThread("busy", 3_000)]));
      yield* TestClock.adjust(passDelayMs);
      h.scheduler.request(ThreadId.make("busy"));
      const asked = yield* h.finishNext();
      expect(asked.target.explicit).toBe(true);
      expect(asked.at).toBe(first.at + passDelayMs);

      h.scheduler.observeShell(shellState([shellThread("busy", 4_000)]));
      yield* TestClock.adjust(cooldownMs);
      const cooled = yield* h.finishNext();
      expect(cooled.target).toMatchObject({ explicit: false, updatedAt: BASE_MS + 4_000 });
      expect(cooled.at).toBeGreaterThanOrEqual(asked.at + cooldownMs);
    }),
  );

  it.effect("waits for a ready connection and a live shell", () =>
    Effect.gen(function* () {
      const h = yield* makeScheduler({
        connected: false,
        shell: shellState([shellThread("a", 0)], "cached"),
      });
      h.scheduler.observeShell(shellState([shellThread("a", 1_000)], "synchronizing"));
      yield* TestClock.adjust(cooldownMs);
      h.scheduler.setConnected(true);
      yield* TestClock.adjust(cooldownMs);
      const liveAt = yield* Clock.currentTimeMillis;
      h.scheduler.observeShell(shellState([shellThread("a", 1_000)], "live"));
      yield* TestClock.adjust(passDelayMs);
      const call = yield* h.finishNext();
      expect(call.target.threadId).toBe(ThreadId.make("a"));
      expect(call.at).toBe(liveAt + passDelayMs);
    }),
  );
});
