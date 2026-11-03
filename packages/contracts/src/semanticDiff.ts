import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TurnCountRange } from "./checkpointDiff.ts";

// Diffy's display format, version 1: https://github.com/seatedro/diffy/blob/master/crates/diffy-compare/FORMAT.md
// Field names follow the format so the server forwards Diffy's output untouched.
// Lines are 1-based, ranges half-open, span offsets UTF-16 code units within `text`.

export const SemanticDiffFileStatus = Schema.Literals([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
]);
export type SemanticDiffFileStatus = typeof SemanticDiffFileStatus.Type;

export const SemanticDiffChangeSpan = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  intensity: Schema.Literals(["novel", "novel_word", "unchanged_context", "renamed"]),
});
export type SemanticDiffChangeSpan = typeof SemanticDiffChangeSpan.Type;

export const SemanticDiffSyntaxSpan = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  // Diffy may add classes without a version bump; render unknown ones as plain text.
  class: Schema.String,
});
export type SemanticDiffSyntaxSpan = typeof SemanticDiffSyntaxSpan.Type;

export const SemanticDiffLine = Schema.Struct({
  line: Schema.Number,
  text: Schema.String,
  changes: Schema.optionalKey(Schema.Array(SemanticDiffChangeSpan)),
  syntax: Schema.optionalKey(Schema.Array(SemanticDiffSyntaxSpan)),
});
export type SemanticDiffLine = typeof SemanticDiffLine.Type;

export const SemanticDiffRow = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("context"),
    old_line: Schema.Number,
    new_line: Schema.Number,
    text: Schema.String,
    syntax: Schema.optionalKey(Schema.Array(SemanticDiffSyntaxSpan)),
  }),
  Schema.Struct({ kind: Schema.Literal("removed"), old: SemanticDiffLine }),
  Schema.Struct({ kind: Schema.Literal("added"), new: SemanticDiffLine }),
  Schema.Struct({ kind: Schema.Literal("modified"), old: SemanticDiffLine, new: SemanticDiffLine }),
]);
export type SemanticDiffRow = typeof SemanticDiffRow.Type;

export const SemanticDiffGap = Schema.Struct({
  old_start: Schema.Number,
  new_start: Schema.Number,
  len: Schema.Number,
});
export type SemanticDiffGap = typeof SemanticDiffGap.Type;

export const SemanticDiffHunk = Schema.Struct({
  old_start: Schema.Number,
  old_len: Schema.Number,
  new_start: Schema.Number,
  new_len: Schema.Number,
  header: Schema.optionalKey(Schema.String),
  gap_before: Schema.optionalKey(SemanticDiffGap),
  rows: Schema.Array(SemanticDiffRow),
});
export type SemanticDiffHunk = typeof SemanticDiffHunk.Type;

export const SemanticDiffFallback = Schema.Struct({
  kind: Schema.Literals(["no_grammar", "grammar_unavailable", "semantic", "request_budget"]),
  reason: Schema.optionalKey(
    Schema.Literals([
      "too_large",
      "parse_errors",
      "error_coverage",
      "unparsed",
      "budget",
      "timeout",
    ]),
  ),
  message: Schema.String,
});
export type SemanticDiffFallback = typeof SemanticDiffFallback.Type;

export const SemanticDiffOutlineItem = Schema.Struct({
  side: Schema.Literals(["old", "new"]),
  line: Schema.Number,
  end_line: Schema.optionalKey(Schema.Number),
  kind: Schema.String,
  name: Schema.String,
  change: Schema.Literals(["added", "removed", "renamed", "moved", "edited"]),
  edits: Schema.optionalKey(Schema.Number),
});
export type SemanticDiffOutlineItem = typeof SemanticDiffOutlineItem.Type;

export const SemanticDiffMove = Schema.Struct({
  old_start: Schema.Number,
  old_len: Schema.Number,
  new_start: Schema.Number,
  new_len: Schema.Number,
  from: Schema.optionalKey(Schema.String),
  into: Schema.optionalKey(Schema.String),
  item: Schema.optionalKey(Schema.String),
});
export type SemanticDiffMove = typeof SemanticDiffMove.Type;

export const SemanticDiffRename = Schema.Struct({
  old: Schema.String,
  new: Schema.String,
  uses: Schema.Number,
});
export type SemanticDiffRename = typeof SemanticDiffRename.Type;

export const SemanticDiffFile = Schema.Struct({
  status: SemanticDiffFileStatus,
  old_path: Schema.optionalKey(Schema.String),
  new_path: Schema.optionalKey(Schema.String),
  language: Schema.optionalKey(Schema.String),
  binary: Schema.optionalKey(Schema.Boolean),
  /** Git's line counts, as in the turn's summary; the rows are Diffy's. */
  additions: Schema.Number,
  deletions: Schema.Number,
  old_missing_newline: Schema.optionalKey(Schema.Boolean),
  new_missing_newline: Schema.optionalKey(Schema.Boolean),
  fallback: Schema.optionalKey(SemanticDiffFallback),
  hunks: Schema.optionalKey(Schema.Array(SemanticDiffHunk)),
  gap_after: Schema.optionalKey(SemanticDiffGap),
  outline: Schema.optionalKey(Schema.Array(SemanticDiffOutlineItem)),
  moves: Schema.optionalKey(Schema.Array(SemanticDiffMove)),
  renames: Schema.optionalKey(Schema.Array(SemanticDiffRename)),
});
export type SemanticDiffFile = typeof SemanticDiffFile.Type;

/** A changed file the server left out of the diff. Counts come from git. */
export const SemanticDiffOmittedFile = Schema.Struct({
  status: SemanticDiffFileStatus,
  old_path: Schema.optionalKey(Schema.String),
  new_path: Schema.optionalKey(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
  reason: Schema.Literals(["too_large", "request_too_large", "unreadable"]),
});
export type SemanticDiffOmittedFile = typeof SemanticDiffOmittedFile.Type;

export const OrchestrationGetTurnSemanticDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    /** Add syntax spans, so the client needs no highlighter. */
    syntax: Schema.optionalKey(Schema.Boolean),
    /** Only these files, by new or old path. Rows run several times a patch's size. */
    paths: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnSemanticDiffInput =
  typeof OrchestrationGetTurnSemanticDiffInput.Type;

export const OrchestrationGetTurnSemanticDiffResult = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    /** Null when this server has no Diffy build for its platform; use `getTurnDiff`. */
    files: Schema.NullOr(Schema.Array(SemanticDiffFile)),
    omitted: Schema.Array(SemanticDiffOmittedFile),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnSemanticDiffResult =
  typeof OrchestrationGetTurnSemanticDiffResult.Type;

export const OrchestrationExpandTurnDiffGapInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    status: SemanticDiffFileStatus,
    old_path: Schema.optionalKey(Schema.String),
    new_path: Schema.optionalKey(Schema.String),
    gap: SemanticDiffGap,
    syntax: Schema.optionalKey(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationExpandTurnDiffGapInput = typeof OrchestrationExpandTurnDiffGapInput.Type;

export const OrchestrationExpandTurnDiffGapResult = Schema.Struct({
  rows: Schema.Array(SemanticDiffRow),
});
export type OrchestrationExpandTurnDiffGapResult = typeof OrchestrationExpandTurnDiffGapResult.Type;

export class OrchestrationGetTurnSemanticDiffError extends Schema.TaggedError<OrchestrationGetTurnSemanticDiffError>()(
  "OrchestrationGetTurnSemanticDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationExpandTurnDiffGapError extends Schema.TaggedError<OrchestrationExpandTurnDiffGapError>()(
  "OrchestrationExpandTurnDiffGapError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
