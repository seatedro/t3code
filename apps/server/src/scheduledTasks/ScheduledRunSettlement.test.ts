import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ScheduledRunSettlement from "./ScheduledRunSettlement.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const NOW = DateTime.makeUnsafe("2026-10-27T03:00:00.000Z");
const PROJECT_ID = ProjectId.make("project:test");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

function task(id: string, autoSettle: boolean): ScheduledTask {
  return {
    id: ScheduledTaskId.make(id),
    title: id,
    prompt: "Rebase onto upstream",
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "14:00" },
    projectId: PROJECT_ID,
    threadId: null,
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    ...(autoSettle ? { autoSettle: true } : {}),
    createdBy: "agent",
    creationSource: "mcp",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "succeeded",
    lastRunError: null,
    runCount: 1,
  };
}

function candidate(
  threadId: ThreadId,
  runId: RunId,
  pendingBackgroundTasks: ProjectionStore.ProjectionSettlementCandidate["pendingBackgroundTasks"] = [],
): ProjectionStore.ProjectionSettlementCandidate {
  return {
    id: threadId,
    projectId: PROJECT_ID,
    branch: "t3/rebase",
    worktreePath: "/worktrees/rebase",
    pullRequests: [],
    linkedPullRequest: null,
    branchPullRequest: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    pinnedAt: null,
    autoSettleDisabledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    latestRunId: runId,
    latestRunRequestedAt: NOW,
    latestRunStartedAt: NOW,
    latestRunCompletedAt: NOW,
    latestUserMessageAt: NOW,
    status: "completed",
    activityRunStartedAt: null,
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks,
    pendingGuestMessageCount: 0,
    lastSnoozeWakeAt: null,
    latestUserAuthoredMessageAt: null,
  };
}

function runEnded(
  threadId: ThreadId,
  runId: RunId,
  status: OrchestrationV2Run["status"],
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event:${runId}:${status}`),
    type: "run.updated",
    threadId,
    runId,
    occurredAt: NOW,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: MODEL.instanceId,
      modelSelection: MODEL,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

interface ThreadFixture {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
}

function thread(name: string, scheduledTaskId?: string): ThreadFixture {
  return {
    threadId: ThreadId.make(`thread:${name}`),
    runId: RunId.make(`run:${name}`),
    scheduledTaskId:
      scheduledTaskId === undefined ? undefined : ScheduledTaskId.make(scheduledTaskId),
  };
}

const makeHarness = Effect.fn("makeScheduledRunSettlementHarness")(function* (
  threads: ReadonlyArray<ThreadFixture>,
  initialCandidates: ReadonlyArray<ProjectionStore.ProjectionSettlementCandidate>,
) {
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const settled = yield* Queue.unbounded<ThreadId>();
  const candidateReads = yield* Queue.unbounded<ThreadId>();
  const candidates = yield* Ref.make(initialCandidates);
  const layer = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromQueue(events),
      dispatch: (command) =>
        command.type === "thread.auto-settle"
          ? Queue.offer(settled, command.threadId).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            )
          : Effect.die(new Error(`Unexpected command: ${command.type}`)),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getRunMessage: (threadId, runId) => {
        const fixture = threads.find((entry) => entry.threadId === threadId);
        return Effect.succeed(
          fixture === undefined
            ? undefined
            : {
                ...(fixture.scheduledTaskId === undefined
                  ? {}
                  : { scheduledTaskId: fixture.scheduledTaskId }),
                id: MessageId.make(`message:${runId}`),
                threadId,
                runId,
                nodeId: null,
                role: "user" as const,
                text: "Rebase onto upstream",
                attachments: [],
                streaming: false,
                createdBy: "agent" as const,
                creationSource: "mcp" as const,
                createdAt: NOW,
                updatedAt: NOW,
              },
        );
      },
      getSettlementCandidates: (threadId) =>
        Ref.get(candidates).pipe(
          Effect.map((all) => all.filter((entry) => entry.id === threadId)),
          Effect.tap(() =>
            threadId === undefined ? Effect.void : Queue.offer(candidateReads, threadId),
          ),
        ),
    }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () => Effect.succeed({ tasks: [task("task:auto", true), task("task:manual", false)] }),
    }),
    NodeCrypto.layer,
  );
  return { events, settled, candidateReads, candidates, layer };
});

it.effect("settles only completed runs started by an auto-settle task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settles = thread("settles", "task:auto");
      const optedOut = thread("opted-out", "task:manual");
      const failed = thread("failed", "task:auto");
      const typed = thread("typed");
      const all = [settles, optedOut, failed, typed];
      const fixture = yield* makeHarness(
        all,
        all.map((entry) => candidate(entry.threadId, entry.runId)),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledRunSettlement.make;
        yield* service.start();
        yield* Queue.offerAll(fixture.events, [
          runEnded(optedOut.threadId, optedOut.runId, "completed"),
          runEnded(failed.threadId, failed.runId, "failed"),
          runEnded(typed.threadId, typed.runId, "completed"),
          runEnded(settles.threadId, settles.runId, "completed"),
        ]);
        // Events are handled in order, so the earlier threads were already passed over.
        assert.strictEqual(yield* Queue.take(fixture.settled), settles.threadId);
        assert.strictEqual(yield* Queue.size(fixture.settled), 0);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.effect("waits for awaited background work to end before settling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const busy = thread("busy", "task:auto");
      const awaitedCommand = [
        { kind: "command" as const, taskId: "build", awaited: true as const },
      ];
      const fixture = yield* makeHarness(
        [busy],
        [candidate(busy.threadId, busy.runId, awaitedCommand)],
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledRunSettlement.make;
        yield* service.start();
        yield* Queue.offer(fixture.events, runEnded(busy.threadId, busy.runId, "completed"));
        yield* Queue.take(fixture.candidateReads);
        yield* service.drain;
        assert.strictEqual(yield* Queue.size(fixture.settled), 0);

        yield* Ref.set(fixture.candidates, [candidate(busy.threadId, busy.runId)]);
        yield* Queue.offer(fixture.events, {
          id: EventId.make("event:busy:background-ended"),
          type: "run.background-work-cancelled",
          threadId: busy.threadId,
          runId: busy.runId,
          occurredAt: NOW,
          payload: { runId: busy.runId, restartCancelledBackgroundWork: [] },
        });
        assert.strictEqual(yield* Queue.take(fixture.settled), busy.threadId);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);
