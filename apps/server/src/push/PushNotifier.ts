import type { PushNotificationData, ThreadId } from "@t3tools/contracts";
import {
  projectThreadAwarenessV2,
  type AgentAwarenessPhase,
  type AgentAwarenessState,
} from "@t3tools/shared/agentAwareness";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  makeAgentAwarenessPublishWorker,
  shouldPublishAgentAwarenessEvent,
} from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import * as PushDevices from "./PushDevices.ts";

export type PushAlertKind = "needs-you" | "finished";

export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_PUSH_BATCH = 100;
// Matches the relay: a finish noticed later than this is old news.
const TERMINAL_FRESHNESS_MS = 2 * 60 * 1_000;
// Matches the relay's publisher: a run can end moments before its continuation starts.
const COMPLETION_CONFIRM_DELAY = "5 seconds";
const ONLINE_PUSH_TTL_SECONDS = 60 * 60;

const STATUS_TEXT: Partial<Record<AgentAwarenessPhase, string>> = {
  waiting_for_approval: "Needs your approval",
  waiting_for_input: "Has a question",
  completed: "Finished",
  failed: "Failed",
};

const isAttention = (phase: AgentAwarenessPhase) =>
  phase === "waiting_for_approval" || phase === "waiting_for_input";
const isTerminal = (phase: AgentAwarenessPhase) => phase === "completed" || phase === "failed";

/**
 * T3 Connect's alert rules (`infra/relay` agentActivityAlerts) for one thread's move: entering
 * needs-you alerts; finishing or failing alerts only from a seen, unfinished phase, while fresh.
 * `previous` is undefined when the thread had no awareness row.
 */
export function pushAlertForTransition(input: {
  readonly previous: AgentAwarenessPhase | undefined;
  readonly next: AgentAwarenessState | null;
  readonly nowMs: number;
}): PushAlertKind | null {
  const { previous, next } = input;
  if (next === null) return null;
  if (isAttention(next.phase)) {
    return previous !== undefined && isAttention(previous) ? null : "needs-you";
  }
  if (!isTerminal(next.phase) || previous === undefined || isTerminal(previous)) return null;
  return input.nowMs - Date.parse(next.updatedAt) <= TERMINAL_FRESHNESS_MS ? "finished" : null;
}

interface ExpoPushMessage {
  readonly to: string;
  readonly data: PushNotificationData;
  readonly priority: "high" | "normal";
  readonly title?: string;
  readonly body?: string;
  readonly sound?: "default";
  readonly threadId?: string;
  readonly contentAvailable?: true;
  readonly ttl?: number;
}

const ExpoPushTicket = Schema.Struct({
  status: Schema.String,
  id: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  details: Schema.optional(Schema.Struct({ error: Schema.optional(Schema.String) })),
});
const ExpoPushSendResponse = Schema.Struct({ data: Schema.Array(ExpoPushTicket) });

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface CompletionHold {
  due: boolean;
}

export const make = Effect.gen(function* () {
  const devices = yield* PushDevices.PushDevices;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const sessions = yield* SessionStore.SessionStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const http = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  const environmentId = yield* serverEnvironment.getEnvironmentId;

  // Null until a device is registered, so servers nobody pushes from skip the reads.
  let phases: Map<ThreadId, AgentAwarenessPhase> | null = null;
  const holds = new Map<ThreadId, CompletionHold>();

  const send = Effect.fn("PushNotifier.send")(function* (
    tokens: ReadonlyArray<string>,
    message: Omit<ExpoPushMessage, "to">,
  ) {
    for (let start = 0; start < tokens.length; start += EXPO_PUSH_BATCH) {
      const batch = tokens.slice(start, start + EXPO_PUSH_BATCH).map((to) => ({ to, ...message }));
      const response = yield* http
        .execute(
          HttpClientRequest.post(EXPO_PUSH_SEND_URL).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe(batch),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ExpoPushSendResponse)),
          Effect.timeout("10 seconds"),
          Effect.retry({ times: 2, schedule: Schedule.exponential("1 second") }),
        );
      const gone = batch
        .filter((_, index) => response.data[index]?.details?.error === "DeviceNotRegistered")
        .map((pushed) => pushed.to);
      yield* devices.forget(gone);
      yield* Effect.logInfo("sent push notifications", {
        kind: message.data.kind,
        devices: batch.length,
        tickets: response.data.flatMap((ticket) => (ticket.id === undefined ? [] : [ticket.id])),
        errors: response.data.flatMap((ticket) =>
          ticket.status === "ok" ? [] : [ticket.details?.error ?? ticket.message ?? "unknown"],
        ),
        forgotten: gone.length,
      });
    }
  });

  const pushAlert = Effect.fn("PushNotifier.pushAlert")(function* (
    kind: PushAlertKind,
    state: AgentAwarenessState,
  ) {
    const tokens = yield* devices.tokensWanting(kind === "needs-you" ? "needsYou" : "finished");
    if (tokens.length === 0) return;
    yield* send(tokens, {
      title: truncate(state.threadTitle, 120),
      body: truncate(`${STATUS_TEXT[state.phase] ?? state.headline} · ${state.projectTitle}`, 160),
      sound: "default",
      priority: "high",
      threadId: `${state.environmentId}/${state.threadId}`,
      data: {
        kind,
        environmentId: state.environmentId,
        threadId: state.threadId,
        deepLink: state.deepLink,
      },
    });
  });

  const readAwareness = Effect.fn("PushNotifier.readAwareness")(function* (threadId: ThreadId) {
    const thread = yield* threads.getThreadShell(threadId);
    if (thread === null || thread.archivedAt !== null) return { state: null, settled: null };
    const project = yield* projects.getById(thread.projectId);
    if (Option.isNone(project)) return { state: null, settled: null };
    const input = { environmentId, project: project.value, thread };
    const state = projectThreadAwarenessV2(input);
    // A completion the user settled during its confirmation window still happened.
    const settled =
      state === null && thread.settledOverride === "settled"
        ? projectThreadAwarenessV2({ ...input, thread: { ...thread, settledOverride: null } })
        : null;
    return { state, settled: settled?.phase === "completed" ? settled : null };
  });

  const baseline = Effect.fn("PushNotifier.baseline")(function* () {
    const [projectSnapshot, shellSnapshot] = yield* Effect.all([
      projects.snapshot,
      threads.getShellSnapshot(),
    ]);
    const projectById = new Map(projectSnapshot.projects.map((project) => [project.id, project]));
    const next = new Map<ThreadId, AgentAwarenessPhase>();
    for (const thread of shellSnapshot.threads) {
      const project = projectById.get(thread.projectId);
      if (project === undefined) continue;
      const state = projectThreadAwarenessV2({ environmentId, project, thread });
      if (state !== null) next.set(thread.id, state.phase);
    }
    return next;
  });

  // Annotated: the confirmation re-enters the worker, which would make inference circular.
  const holdCompletion = (threadId: ThreadId): Effect.Effect<void> => {
    const hold: CompletionHold = { due: false };
    holds.set(threadId, hold);
    return Effect.sleep(COMPLETION_CONFIRM_DELAY).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          hold.due = true;
          return publishWorker.enqueue(threadId);
        }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  };

  const evaluate = Effect.fn("PushNotifier.evaluate")(function* (threadId: ThreadId) {
    if (phases === null) {
      if (!(yield* devices.hasAny)) return;
      // The first registration starts from what is true now, like the relay's first snapshot.
      phases = yield* baseline();
      return;
    }
    const { state, settled } = yield* readAwareness(threadId);
    const previous = phases.get(threadId);
    const hold = holds.get(threadId);
    if (hold !== undefined && !hold.due && (state === null || state.phase === "completed")) return;
    if (hold === undefined && state?.phase === "completed" && previous !== "completed") {
      yield* holdCompletion(threadId);
      return;
    }
    holds.delete(threadId);
    const alertState = hold?.due === true && state === null ? settled : state;
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    const kind = pushAlertForTransition({ previous, next: alertState, nowMs });
    if (state === null) phases.delete(threadId);
    else phases.set(threadId, state.phase);
    if (kind !== null && alertState !== null) yield* pushAlert(kind, alertState);
  });

  const publishWorker = yield* makeAgentAwarenessPublishWorker((threadId: ThreadId) =>
    evaluate(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("push notification check failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const announceOnline = Effect.fn("PushNotifier.announceOnline")(function* () {
    const tokens = yield* devices.tokensWanting("online");
    if (tokens.length === 0) return;
    // Silent: the app decides whether anyone asked to hear about this machine.
    yield* send(tokens, {
      contentAvailable: true,
      priority: "normal",
      ttl: ONLINE_PUSH_TTL_SECONDS,
      data: { kind: "environment-online", environmentId },
    });
  });

  const start = Effect.fn("PushNotifier.start")(function* () {
    yield* forkParked(
      announceOnline().pipe(
        // The network can lag a boot; keep trying for about a minute.
        Effect.retry({ times: 4, schedule: Schedule.exponential("4 seconds") }),
        Effect.catchCause((cause) =>
          Effect.logWarning("could not announce this machine to push devices", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );
    yield* forkParked(
      Stream.runForEach(sessions.streamChanges, (change) =>
        change.type === "clientRemoved"
          ? devices.forgetSession(change.sessionId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("could not forget a revoked session's push devices", {
                  cause: Cause.pretty(cause),
                }),
              ),
            )
          : Effect.void,
      ),
    );
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        shouldPublishAgentAwarenessEvent(event)
          ? publishWorker.enqueue(event.threadId)
          : Effect.void,
      ),
    );
  });

  return { drain: publishWorker.drain, start };
});

export const layer = Layer.effectDiscard(make.pipe(Effect.flatMap((notifier) => notifier.start())));
