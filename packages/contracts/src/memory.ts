import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

/** An aligned power-of-two range of memories [lo, lo + size); size 1 is one memory. */
export const MemoryBlock = Schema.Struct({ lo: NonNegativeInt, size: PositiveInt });
export type MemoryBlock = typeof MemoryBlock.Type;

export const MemoryEntry = Schema.Struct({
  id: NonNegativeInt,
  date: Schema.String,
  /** Null once the memory is pruned; its number stays. */
  text: Schema.NullOr(Schema.String),
});
export type MemoryEntry = typeof MemoryEntry.Type;

export const MemoryNode = Schema.Struct({
  lo: NonNegativeInt,
  size: PositiveInt,
  kind: Schema.Literals(["memory", "pruned", "summary", "pending"]),
  /** The memory or summary text; null for a pruned memory or a summary not written yet. */
  text: Schema.NullOr(Schema.String),
  date: Schema.optionalKey(Schema.String),
});
export type MemoryNode = typeof MemoryNode.Type;

export const MemoryOverview = Schema.Struct({
  memories: NonNegativeInt,
  pruned: NonNegativeInt,
  summaries: NonNegativeInt,
  pendingCompressions: NonNegativeInt,
  since: Schema.NullOr(Schema.String),
  /** The top of the summary tree: the largest whole blocks covering every memory. */
  roots: Schema.Array(MemoryNode),
  /** What `memory wake` returns to an agent right now. */
  wake: Schema.String,
});
export type MemoryOverview = typeof MemoryOverview.Type;

export const MemoryOverviewInput = Schema.Struct({});

export const MemoryListInput = Schema.Struct({
  /** Case-insensitive regular expression; pruned memories never match. */
  query: Schema.optionalKey(Schema.String),
  /** Only memories numbered below this, for the next page. */
  before: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
});
export type MemoryListInput = typeof MemoryListInput.Type;

export const MemoryListResult = Schema.Struct({
  entries: Schema.Array(MemoryEntry),
  /** Pass as `before` for older memories; null when there are none. */
  nextBefore: Schema.NullOr(NonNegativeInt),
});
export type MemoryListResult = typeof MemoryListResult.Type;

export const MemoryChildrenResult = Schema.Struct({ nodes: Schema.Array(MemoryNode) });
export type MemoryChildrenResult = typeof MemoryChildrenResult.Type;

export const MemoryPruneInput = Schema.Struct({
  ids: Schema.Array(NonNegativeInt).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type MemoryPruneInput = typeof MemoryPruneInput.Type;

export const MemoryEditResult = Schema.Struct({
  pruned: NonNegativeInt,
  summariesDropped: NonNegativeInt,
});
export type MemoryEditResult = typeof MemoryEditResult.Type;

export const MemoryPurgeResult = Schema.Struct({
  memories: NonNegativeInt,
  summaries: NonNegativeInt,
});
export type MemoryPurgeResult = typeof MemoryPurgeResult.Type;

export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
