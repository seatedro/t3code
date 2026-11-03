import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationExpandTurnDiffGapInput,
  type OrchestrationExpandTurnDiffGapResult,
  type OrchestrationGetTurnSemanticDiffInput,
  type OrchestrationGetTurnSemanticDiffResult,
  type SemanticDiffFileStatus,
  type SemanticDiffOmittedFile,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Diffy from "../diffy/Diffy.ts";
import type { DiffyError, DiffyFileInput } from "../diffy/Diffy.ts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
  type CheckpointDiffOperation,
  type CheckpointServiceError,
} from "./Errors.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { isGitImport, parseTurnDiffFilesFromNumstat, type TurnDiffFileSummary } from "./Diffs.ts";

// Windows limits a command line to 32,767 characters. Leave room for the rest of git's arguments.
const MAX_PATHSPEC_CHARS = 24_000;
const DIFF_TRUNCATED_MARKER = "\n\n[truncated]";
// Diffy's semantic diff gives up past 1 MiB a side, and so does its highlighter.
const SEMANTIC_DIFF_MAX_FILE_BYTES = 1_048_576;
const OMITTED_REASON = {
  too_large: "too_large",
  over_budget: "request_too_large",
  unreadable: "unreadable",
} as const satisfies Record<string, SemanticDiffOmittedFile["reason"]>;

function batchFilePaths(files: ReadonlyArray<TurnDiffFileSummary>) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of files) {
    const paths = file.previousPath === undefined ? [file.path] : [file.previousPath, file.path];
    const size = paths.reduce((total, path) => total + path.length + 16, 0);
    if (batch.length > 0 && length + size > MAX_PATHSPEC_CHARS) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(...paths);
    length += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;

    readonly getTurnSemanticDiff: (
      input: OrchestrationGetTurnSemanticDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnSemanticDiffResult, CheckpointServiceError | DiffyError>;

    readonly expandTurnDiffGap: (
      input: OrchestrationExpandTurnDiffGapInput,
    ) => Effect.Effect<OrchestrationExpandTurnDiffGapResult, CheckpointServiceError | DiffyError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const digest = yield* Digest.Digest;
  const diffy = yield* Diffy.Diffy;

  const resolveComparison = Effect.fn("CheckpointDiffQuery.resolveComparison")(function* (
    input: {
      readonly threadId: ThreadId;
      readonly fromTurnCount: number;
      readonly toTurnCount: number;
    },
    operation: CheckpointDiffOperation,
    ignoreWhitespace: boolean,
  ) {
    const projection = yield* threads.getCheckpointContext(input.threadId).pipe(
      Effect.mapError(
        () =>
          new CheckpointThreadNotFoundError({
            operation,
            threadId: input.threadId,
          }),
      ),
      Effect.withSpan("checkpoint.turnDiff.lookupContext"),
    );
    const completedRunIds = new Set(
      projection.runs.filter((run) => run.status === "completed").map((run) => run.id),
    );
    const readyCheckpoints = projection.checkpoints.filter(
      (checkpoint) =>
        checkpoint.status === "ready" &&
        checkpoint.appRunOrdinal !== null &&
        checkpoint.runId !== null &&
        completedRunIds.has(checkpoint.runId),
    );
    const maxTurnCount = readyCheckpoints.reduce(
      (max, checkpoint) => Math.max(max, checkpoint.appRunOrdinal ?? 0),
      0,
    );
    if (input.toTurnCount > maxTurnCount) {
      return yield* new CheckpointTurnRangeUnavailableError({
        operation,
        threadId: input.threadId,
        requestedTurnCount: input.toTurnCount,
        availableTurnCount: maxTurnCount,
      });
    }

    const toCheckpoint = readyCheckpoints.find(
      (checkpoint) => checkpoint.appRunOrdinal === input.toTurnCount,
    );
    if (toCheckpoint === undefined) {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        checkpoint: "to",
      });
    }

    const toScope = projection.checkpointScopes.find((scope) => scope.id === toCheckpoint.scopeId);
    if (toScope === undefined) {
      return yield* new CheckpointWorkspacePathMissingError({
        operation,
        threadId: input.threadId,
      });
    }

    // Capture compares against the preceding scope ordinal, even when that
    // checkpoint belongs to a stopped run or has no run.
    const parentCheckpoint =
      input.fromTurnCount === input.toTurnCount - 1
        ? projection.checkpoints.find(
            (checkpoint) =>
              checkpoint.status === "ready" &&
              checkpoint.scopeId === toCheckpoint.scopeId &&
              checkpoint.ordinalWithinScope === toCheckpoint.ordinalWithinScope - 1,
          )
        : undefined;

    const firstScope =
      input.fromTurnCount === 0
        ? projection.checkpointScopes.find((scope) => scope.kind === "root_run")
        : undefined;
    const fromCheckpointRef =
      input.fromTurnCount === 0
        ? firstScope === undefined
          ? undefined
          : yield* checkpointRefForScopeOrdinal({
              scopeId: firstScope.id,
              ordinalWithinScope: 0,
            }).pipe(Effect.provideService(Digest.Digest, digest))
        : (
            parentCheckpoint ??
            readyCheckpoints.find((checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount)
          )?.ref;
    if (fromCheckpointRef === undefined) {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.fromTurnCount,
        checkpoint: "from",
      });
    }

    const comparison = {
      cwd: toScope.cwd,
      fromCheckpointRef,
      toCheckpointRef: toCheckpoint.ref,
      fallbackFromToHead: false,
      ignoreWhitespace,
    };
    return comparison;
  });

  /** With `listAll` false, files are listed only when some may be Git imports. */
  const listTurnFiles = Effect.fn("CheckpointDiffQuery.listTurnFiles")(function* (
    comparison: Effect.Success<ReturnType<typeof resolveComparison>>,
    listAll: boolean,
  ) {
    const authoredPaths = yield* checkpointStore
      .listAuthoredPaths(comparison)
      .pipe(Effect.orElseSucceed(() => null));
    const files =
      authoredPaths === null && !listAll
        ? []
        : yield* checkpointStore.diffCheckpoints({ ...comparison, format: "numstat" }).pipe(
            Effect.map(parseTurnDiffFilesFromNumstat),
            Effect.orElseSucceed(() => []),
          );
    const retainedFiles = files.filter((file) => !isGitImport(file, authoredPaths));
    return { files, retainedFiles };
  });

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff = buildTurnDiffResult(input, "");
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const comparison = yield* resolveComparison(input, operation, ignoreWhitespace);
      const { files, retainedFiles } = yield* listTurnFiles(comparison, false);
      // Select retained paths before generating a patch, so imported bulk cannot exhaust its output limit.
      const pathBatches =
        retainedFiles.length === files.length ? [undefined] : batchFilePaths(retainedFiles);
      let diff = "";
      let remainingBytes = CHECKPOINT_DIFF_MAX_OUTPUT_BYTES;
      for (const filePaths of pathBatches) {
        const patch = yield* checkpointStore
          .diffCheckpoints({
            ...comparison,
            ...(filePaths === undefined ? {} : { filePaths }),
            // One extra byte distinguishes an exact fit from a truncated patch.
            maxOutputBytes: remainingBytes + 1,
          })
          .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));
        const patchBytes = Buffer.byteLength(patch);
        diff += patch;
        if (patchBytes > remainingBytes) {
          // Reserve marker space only on overflow, which may trim an earlier batch.
          // Streaming decode drops an incomplete final UTF-8 character at the byte boundary.
          diff =
            new TextDecoder().decode(
              Buffer.from(diff).subarray(
                0,
                CHECKPOINT_DIFF_MAX_OUTPUT_BYTES - Buffer.byteLength(DIFF_TRUNCATED_MARKER),
              ),
              { stream: true },
            ) + DIFF_TRUNCATED_MARKER;
          break;
        }
        remainingBytes -= patchBytes;
      }

      const turnDiff = buildTurnDiffResult(input, diff);
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const turnDiff = yield* getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace,
    });
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  const getTurnSemanticDiff: CheckpointDiffQuery["Service"]["getTurnSemanticDiff"] = Effect.fn(
    "CheckpointDiffQuery.getTurnSemanticDiff",
  )(function* (input) {
    const range = {
      threadId: input.threadId,
      fromTurnCount: input.fromTurnCount,
      toTurnCount: input.toTurnCount,
    };
    if (input.fromTurnCount === input.toTurnCount) return { ...range, files: [], omitted: [] };
    if (!(yield* diffy.available)) return { ...range, files: null, omitted: [] };

    // Diffy shows whitespace changes itself, so list files without ignoring whitespace.
    const comparison = yield* resolveComparison(
      input,
      "CheckpointDiffQuery.getTurnSemanticDiff",
      false,
    );
    const { retainedFiles: turnFiles } = yield* listTurnFiles(comparison, true);
    const paths = input.paths === undefined ? undefined : new Set(input.paths);
    const retainedFiles =
      paths === undefined
        ? turnFiles
        : turnFiles.filter(
            (file) =>
              paths.has(file.path) ||
              (file.previousPath !== undefined && paths.has(file.previousPath)),
          );
    const reads = yield* checkpointStore.readObjects({
      cwd: comparison.cwd,
      revisions: retainedFiles.flatMap((file) => [
        `${comparison.fromCheckpointRef}:${file.previousPath ?? file.path}`,
        `${comparison.toCheckpointRef}:${file.path}`,
      ]),
      maxObjectBytes: SEMANTIC_DIFF_MAX_FILE_BYTES,
      maxTotalBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
    });

    const inputs: DiffyFileInput[] = [];
    const counted: TurnDiffFileSummary[] = [];
    const omitted: SemanticDiffOmittedFile[] = [];
    retainedFiles.forEach((file, index) => {
      const before = reads[index * 2]!;
      const after = reads[index * 2 + 1]!;
      const status: SemanticDiffFileStatus =
        file.previousPath !== undefined
          ? "renamed"
          : before._tag === "missing"
            ? "added"
            : after._tag === "missing"
              ? "deleted"
              : "modified";
      const paths = {
        ...(status === "added" ? {} : { old_path: file.previousPath ?? file.path }),
        ...(status === "deleted" ? {} : { new_path: file.path }),
      };
      const unread = [before, after].find(
        (read) => read._tag !== "read" && read._tag !== "missing",
      );
      if (unread !== undefined || (before._tag === "missing" && after._tag === "missing")) {
        omitted.push({
          status,
          ...paths,
          additions: file.additions,
          deletions: file.deletions,
          reason: OMITTED_REASON[unread?._tag ?? "unreadable"],
        });
        return;
      }
      counted.push(file);
      inputs.push({
        status,
        ...paths,
        ...(before._tag === "read" ? { old: before.bytes } : {}),
        ...(after._tag === "read" ? { new: after.bytes } : {}),
      });
    });

    const files = yield* diffy.diff(inputs, { syntax: input.syntax ?? false });
    return {
      ...range,
      // Git's counts, so a file reads the same here as in the turn's summary.
      files: Option.getOrNull(
        Option.map(files, (diffed) =>
          diffed.map((file, index) => ({
            ...file,
            additions: counted[index]!.additions,
            deletions: counted[index]!.deletions,
          })),
        ),
      ),
      omitted,
    };
  });

  const expandTurnDiffGap: CheckpointDiffQuery["Service"]["expandTurnDiffGap"] = Effect.fn(
    "CheckpointDiffQuery.expandTurnDiffGap",
  )(function* (input) {
    const comparison = yield* resolveComparison(
      input,
      "CheckpointDiffQuery.expandTurnDiffGap",
      false,
    );
    const sides = [
      input.old_path === undefined
        ? undefined
        : `${comparison.fromCheckpointRef}:${input.old_path}`,
      input.new_path === undefined ? undefined : `${comparison.toCheckpointRef}:${input.new_path}`,
    ];
    const reads = yield* checkpointStore.readObjects({
      cwd: comparison.cwd,
      revisions: sides.filter((revision) => revision !== undefined),
      maxObjectBytes: SEMANTIC_DIFF_MAX_FILE_BYTES,
      maxTotalBytes: 2 * SEMANTIC_DIFF_MAX_FILE_BYTES,
    });
    const [before, after] = sides[0] === undefined ? [undefined, reads[0]] : [reads[0], reads[1]];
    const rows = yield* diffy.expand(
      {
        status: input.status,
        ...(input.old_path === undefined ? {} : { old_path: input.old_path }),
        ...(input.new_path === undefined ? {} : { new_path: input.new_path }),
        ...(before?._tag === "read" ? { old: before.bytes } : {}),
        ...(after?._tag === "read" ? { new: after.bytes } : {}),
      },
      input.gap,
      { syntax: input.syntax ?? false },
    );
    return { rows: Option.getOrElse(rows, () => []) };
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
    getTurnSemanticDiff,
    expandTurnDiffGap,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
