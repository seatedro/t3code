import { CommandId, type RunId, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { isAutoSettlementCandidate } from "../orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const ENDED_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

interface PendingRun {
  readonly runId: RunId;
  confirmed: boolean;
  heldByBackgroundWork: boolean;
  backgroundWorkCancelled: boolean;
}

/**
 * Settles a thread once a run started by a task with `autoSettle` completes. Failed or
 * interrupted runs stay visible. Pending threads live in memory, so a server restart
 * leaves them to the normal settlement rules.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const random = yield* SecureRandom.SecureRandom;
  // Set when the event arrives so later events for the thread retry until it can settle.
  const pending = new Map<ThreadId, PendingRun>();
  // Awaited work that finishes wakes the agent; settling first would detach the session
  // that is about to start the wake run, so the wake run's completion settles instead.
  const awaitingWake = new Set<ThreadId>();

  const settle = Effect.fn("ScheduledRunSettlement.settle")(
    function* (threadId: ThreadId) {
      const entry = pending.get(threadId);
      if (entry === undefined) return;
      if (!entry.confirmed) {
        const message = yield* projections.getRunMessage(threadId, entry.runId);
        const wakesScheduledRun =
          awaitingWake.delete(threadId) && message?.notification !== undefined;
        const taskId = message?.scheduledTaskId;
        const { tasks } = taskId === undefined ? { tasks: [] } : yield* scheduledTasks.list();
        if (pending.get(threadId) !== entry) return;
        if (
          !wakesScheduledRun &&
          !tasks.some((task) => task.id === taskId && task.autoSettle === true)
        ) {
          pending.delete(threadId);
          return;
        }
        entry.confirmed = true;
      }
      const [thread] = yield* projections.getSettlementCandidates(threadId);
      // Missing means settled, pinned, archived, or running again.
      if (thread === undefined || thread.latestRunId !== entry.runId) {
        if (pending.get(threadId) === entry) pending.delete(threadId);
        return;
      }
      if (!isAutoSettlementCandidate(thread, DateTime.toEpochMillis(yield* DateTime.now))) {
        if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) {
          entry.heldByBackgroundWork = true;
        }
        return;
      }
      if (entry.heldByBackgroundWork && !entry.backgroundWorkCancelled) {
        pending.delete(threadId);
        awaitingWake.add(threadId);
        return;
      }
      yield* orchestrator.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make(
          `server:scheduled-auto-settle:${threadId}:${yield* random.uuidV4()}`,
        ),
        threadId,
        snapshotAt: thread.updatedAt,
      });
      if (pending.get(threadId) === entry) pending.delete(threadId);
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("scheduled run settlement skipped", {
              threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  const worker = yield* makeDrainableWorker(settle);

  const start = Effect.fn("ScheduledRunSettlement.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (event.type === "run.updated" && ENDED_RUN_STATUSES.has(event.payload.status)) {
          if (event.payload.status === "completed") {
            pending.set(event.threadId, {
              runId: event.payload.id,
              confirmed: false,
              heldByBackgroundWork: false,
              backgroundWorkCancelled: false,
            });
          } else {
            pending.delete(event.threadId);
            awaitingWake.delete(event.threadId);
          }
        }
        if (event.type === "run.background-work-cancelled") {
          const entry = pending.get(event.threadId);
          if (entry !== undefined) entry.backgroundWorkCancelled = true;
        }
        return pending.has(event.threadId) ? worker.enqueue(event.threadId) : Effect.void;
      }),
    );
  });

  return { start, drain: worker.drain };
});
