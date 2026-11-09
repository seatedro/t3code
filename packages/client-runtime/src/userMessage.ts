import {
  type ChatAttachment,
  type ChatFileAttachment,
  type GuestMessageAttribution,
  type OrchestrationMessageContext,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2IdleCompaction,
  type OrchestrationV2Run,
  type OrchestrationV2UserMessageInputIntent,
  ScheduledTaskId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";

/** The working row while T3 Code's own compaction runs. */
export const IDLE_COMPACTING_LABELS = {
  beforeCacheExpires: "Compacting before the cache expires…",
  onReturn: "Compacting…",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLES = {
  beforeCacheExpires: "Context automatically compacted before cache expiry",
  onReturn: "Context compacted before sending",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

export function resolveUserMessageFileCards(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}): ReadonlyArray<ChatFileAttachment> | null {
  const files = message.attachments.filter(
    (attachment): attachment is ChatFileAttachment =>
      attachment.type === "file" &&
      imageMimeType(attachment) === null &&
      videoMimeType(attachment) === null &&
      filePreviewKind(attachment) !== "audio",
  );
  if (files.length === 0 || files.length !== message.attachments.length) return null;
  const fileIds = new Set(files.map((file) => file.id));
  const remaining = replaceComposerContextReferences(message.text, (reference) => {
    const record = message.context?.records.find((item) => item.contextId === reference.contextId);
    return reference.kind === "file" &&
      record?.kind === "file" &&
      "attachmentId" in record &&
      fileIds.has(record.attachmentId)
      ? ""
      : reference.label || reference.kind;
  });
  return remaining.trim() === "" ? files : null;
}

export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  readonly context?: { readonly guest?: GuestMessageAttribution | undefined } | undefined;
}): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "t3code" | "guest" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  /** Set when `attribution` is "guest". */
  readonly guestName?: string;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  // The stored text names the guest for the agent; people see the guest's own words.
  const guest = message.context?.guest;
  if (guest !== undefined) {
    return {
      text: guest.text,
      attribution: "guest",
      scheduledTaskId: undefined,
      guestName: guest.name,
    };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: message.text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    };
  }
  return {
    // The agent needs words to start a turn; people sent only the attachments.
    text: isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text,
    attribution:
      message.createdBy !== "agent"
        ? null
        : message.creationSource === "server"
          ? "t3code"
          : "agent",
    scheduledTaskId: undefined,
  };
}

type GroupableUserMessage = Parameters<typeof resolveUserMessagePresentation>[0] & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
};

export function resolveUserMessageGrouping(
  message: GroupableUserMessage | undefined,
  previous: GroupableUserMessage | undefined,
  next: GroupableUserMessage | undefined,
) {
  const isOwnMessage = (value: GroupableUserMessage | undefined) =>
    value?.role === "user" && resolveUserMessagePresentation(value).attribution === null;
  const isSteer = (value: GroupableUserMessage | undefined) =>
    value?.inputIntent === "steer" || value?.inputIntent === "promoted_queued_to_steer";
  const groupedWithPrevious = isOwnMessage(message) && isOwnMessage(previous);
  return {
    groupedWithPrevious,
    groupedWithNext: isOwnMessage(message) && isOwnMessage(next),
    continuesSteer: groupedWithPrevious && isSteer(message) && isSteer(previous),
  };
}

/** One earlier run of an automation in this thread, as a bar on its card. */
export interface AutomationRunMark {
  /** The bar's height from 0 to 1: the run's working time on a log scale against the longest shown. */
  readonly level: number;
  readonly failed: boolean;
  /** Still working, or never started; it has no length yet. */
  readonly open: boolean;
  /** The run this card's message started. */
  readonly current: boolean;
}

const AUTOMATION_RUN_MARKS = 12;

/**
 * The runs an automation started in this thread, up to and including the one `messageId` started,
 * and whether that message is the automation's latest here.
 */
export function automationRunHistory(
  thread: {
    readonly messages: ReadonlyArray<{
      readonly id: string;
      readonly scheduledTaskId?: ScheduledTaskId | undefined;
    }>;
    readonly runs: ReadonlyArray<
      Pick<OrchestrationV2Run, "userMessageId" | "ordinal" | "status" | "startedAt" | "completedAt">
    >;
  },
  messageId: string,
): { readonly marks: ReadonlyArray<AutomationRunMark>; readonly latest: boolean } {
  const index = thread.messages.findIndex((message) => message.id === messageId);
  const taskId = thread.messages[index]?.scheduledTaskId;
  if (taskId === undefined) return { marks: [], latest: false };
  const triggers = thread.messages.filter((message) => message.scheduledTaskId === taskId);
  const position = triggers.findIndex((message) => message.id === messageId);
  const runsByMessage = new Map<string, Array<(typeof thread.runs)[number]>>();
  for (const run of thread.runs) {
    const runs = runsByMessage.get(run.userMessageId) ?? [];
    runs.push(run);
    runsByMessage.set(run.userMessageId, runs);
  }
  const spans = triggers
    .slice(Math.max(0, position + 1 - AUTOMATION_RUN_MARKS), position + 1)
    .map((message) => {
      // A restarted or continued run carries the same message; together they are one run.
      const runs = [...(runsByMessage.get(message.id) ?? [])].sort((a, b) => a.ordinal - b.ordinal);
      const starts = runs.flatMap((run) => (run.startedAt === null ? [] : [run.startedAt]));
      const ends = runs.flatMap((run) => (run.completedAt === null ? [] : [run.completedAt]));
      const ms =
        starts.length === 0 || ends.length < runs.length
          ? null
          : Math.max(
              0,
              Math.max(...ends.map(DateTime.toEpochMillis)) -
                Math.min(...starts.map(DateTime.toEpochMillis)),
            );
      return { ms, failed: runs.at(-1)?.status === "failed", current: message.id === messageId };
    });
  const longest = Math.log1p(Math.max(1, ...spans.map((span) => span.ms ?? 0)));
  return {
    marks: spans.map((span) => ({
      level: span.ms === null ? 0 : Math.log1p(span.ms) / longest,
      failed: span.failed,
      open: span.ms === null,
      current: span.current,
    })),
    latest: position === triggers.length - 1,
  };
}
