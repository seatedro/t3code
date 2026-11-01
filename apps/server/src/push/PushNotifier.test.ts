import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import type { AgentAwarenessPhase, AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PushDevices from "./PushDevices.ts";
import * as PushNotifier from "./PushNotifier.ts";

const ENVIRONMENT_ID = EnvironmentId.make("push-environment");
const THREAD_ID = ThreadId.make("push-thread");
const PROJECT_ID = ProjectId.make("push-project");
const SESSION_ID = AuthSessionId.make("push-session");
const PHONE = "ExponentPushToken[phone]";
const NOW = "2026-09-04T12:00:00.000Z";
const NOW_MS = DateTime.toEpochMillis(DateTime.makeUnsafe(NOW));

describe("pushAlertForTransition", () => {
  const state = (phase: AgentAwarenessPhase, updatedAt = NOW): AgentAwarenessState => ({
    environmentId: ENVIRONMENT_ID,
    threadId: THREAD_ID,
    projectTitle: "flock",
    threadTitle: "Thread",
    phase,
    headline: phase,
    modelTitle: "test-model",
    updatedAt,
    deepLink: "/threads/push-environment/push-thread",
  });
  const stale = DateTime.formatIso(DateTime.makeUnsafe(NOW_MS - 3 * 60 * 1_000));

  it.each([
    { previous: "running", next: state("waiting_for_approval"), alert: "needs-you" },
    { previous: undefined, next: state("waiting_for_input"), alert: "needs-you" },
    { previous: "waiting_for_approval", next: state("waiting_for_input"), alert: null },
    { previous: "running", next: state("completed"), alert: "finished" },
    { previous: "waiting_for_input", next: state("failed"), alert: "finished" },
    // An unobserved or already finished thread is a replay, not news.
    { previous: undefined, next: state("completed"), alert: null },
    { previous: "failed", next: state("completed"), alert: null },
    { previous: "running", next: state("completed", stale), alert: null },
    { previous: "running", next: state("running"), alert: null },
    { previous: "running", next: null, alert: null },
  ] as const)("$previous → $next.phase alerts $alert", ({ previous, next, alert }) => {
    assert.strictEqual(
      PushNotifier.pushAlertForTransition({ previous, next, nowMs: NOW_MS }),
      alert,
    );
  });
});

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix the flaky test",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const PROJECT = {
  id: PROJECT_ID,
  title: "flock",
  workspaceRoot: "/workspace",
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

interface PushedMessage {
  readonly to: string;
  readonly title?: string;
  readonly body?: string;
  readonly contentAvailable?: boolean;
  readonly data: { readonly kind: string; readonly threadId?: string };
}

const makeHarness = Effect.fnUntraced(function* (
  options: { readonly ticketError?: (to: string) => string | undefined } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const devices = yield* PushDevices.PushDevices;
  const forgottenSessions = yield* Queue.unbounded<AuthSessionId>();
  yield* sql`
    INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
    VALUES (${SESSION_ID}, 'test', '[]', 'browser-session-cookie',
      '1970-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')
  `;
  yield* devices.register(SESSION_ID, {
    token: PHONE,
    preferences: { needsYou: true, finished: true, online: true },
  });

  let current = shell();
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const pulls = yield* Queue.unbounded<void>();
  const sessionChanges = yield* PubSub.unbounded<SessionStore.SessionCredentialChange>();
  const pushed = yield* Queue.unbounded<ReadonlyArray<PushedMessage>>();
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      assert.strictEqual(request.url, PushNotifier.EXPO_PUSH_SEND_URL);
      assert.strictEqual(request.body._tag, "Uint8Array");
      const messages: ReadonlyArray<PushedMessage> =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : [];
      yield* Queue.offer(pushed, messages);
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          data: messages.map((message, index) => {
            const error = options.ticketError?.(message.to);
            return error === undefined
              ? { status: "ok", id: `ticket-${index}` }
              : { status: "error", message: error, details: { error } };
          }),
        }),
      );
    }),
  );

  const notifier = yield* PushNotifier.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.sync(() => current),
          getShellSnapshot: () =>
            Effect.sync(() => ({
              schemaVersion: 2,
              snapshotSequence: 1,
              threads: [current],
              archivedThreads: [],
            })),
          streamDomainEvents: Stream.fromEffectRepeat(
            Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
          ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome(PROJECT),
          snapshot: Effect.succeed({ projects: [PROJECT], updatedAt: NOW }),
        }),
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "t3_session",
          legacyCookieName: undefined,
          streamChanges: Stream.fromPubSub(sessionChanges),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
        }),
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.succeed(PushDevices.PushDevices, {
          ...devices,
          forgetSession: (sessionId) =>
            devices
              .forgetSession(sessionId)
              .pipe(Effect.andThen(Queue.offer(forgottenSessions, sessionId))),
        }),
      ),
    ),
  );
  yield* notifier.start();
  yield* Queue.take(pulls);

  /** Moves the thread and tells the notifier, as a domain event would. */
  const move = Effect.fnUntraced(function* (overrides: Partial<OrchestrationV2ThreadShell>) {
    current = shell({ ...overrides, updatedAt: yield* DateTime.now });
    yield* Queue.offer(events, {
      id: EventId.make(`event:${current.status}`),
      type: "thread.settled",
      threadId: THREAD_ID,
      occurredAt: current.updatedAt,
      payload: {
        ...current,
        settledOverride: "settled" as const,
        settledAt: current.updatedAt,
        lastVisitedAt: null,
      },
    });
    yield* Queue.take(pulls);
    yield* notifier.drain;
  });

  // The online announcement at startup goes first.
  assert.deepStrictEqual(
    (yield* Queue.take(pushed)).map((message) => [message.contentAvailable, message.data.kind]),
    [[true, "environment-online"]],
  );
  // The first event after a registration only records where every thread stands.
  yield* move({ status: "running" });
  return { devices, move, pushed, sessionChanges, forgottenSessions, notifier };
});

const notifierLayer = PushDevices.layer.pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
);

describe("PushNotifier", () => {
  it.effect("pushes needs-you at once and a finish after its confirmation window", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const { move, pushed } = yield* makeHarness();

      yield* move({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-approval"),
          kind: "command",
          createdAt: yield* DateTime.now,
        },
      });
      assert.deepStrictEqual(
        (yield* Queue.take(pushed)).map((message) => [
          message.to,
          message.title,
          message.body,
          message.data.kind,
          message.data.threadId,
        ]),
        [[PHONE, "Fix the flaky test", "Needs your approval · flock", "needs-you", THREAD_ID]],
      );

      yield* move({ status: "completed" });
      assert.strictEqual(yield* Queue.size(pushed), 0);
      yield* TestClock.adjust("5 seconds");
      yield* move({ status: "completed" });
      assert.deepStrictEqual(
        (yield* Queue.take(pushed)).map((message) => [message.body, message.data.kind]),
        [["Finished · flock", "finished"]],
      );
    }).pipe(Effect.provide(notifierLayer)),
  );

  it.effect("stays quiet when a continuation starts inside the confirmation window", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const { move, pushed, notifier } = yield* makeHarness();

      yield* move({ status: "completed" });
      yield* move({ status: "running" });
      yield* TestClock.adjust("5 seconds");
      yield* notifier.drain;
      // A subagent never alerts, however it ends.
      yield* move({
        status: "failed",
        lineage: {
          rootThreadId: THREAD_ID,
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
        },
      });
      assert.strictEqual(yield* Queue.size(pushed), 0);
    }).pipe(Effect.provide(notifierLayer)),
  );

  it.effect("forgets tokens Expo no longer delivers to and tokens of revoked sessions", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const { devices, move, pushed, sessionChanges, forgottenSessions } = yield* makeHarness({
        ticketError: (to) => (to === "ExpoPushToken[gone]" ? "DeviceNotRegistered" : undefined),
      });
      yield* devices.register(SESSION_ID, {
        token: "ExpoPushToken[gone]",
        preferences: { needsYou: true, finished: true, online: true },
      });

      yield* move({ status: "failed" });
      assert.strictEqual((yield* Queue.take(pushed)).length, 2);
      assert.deepStrictEqual(yield* devices.tokensWanting("finished"), [PHONE]);

      yield* PubSub.publish(sessionChanges, { type: "clientRemoved", sessionId: SESSION_ID });
      assert.strictEqual(yield* Queue.take(forgottenSessions), SESSION_ID);
      assert.isFalse(yield* devices.hasAny);
    }).pipe(Effect.provide(notifierLayer)),
  );
});
