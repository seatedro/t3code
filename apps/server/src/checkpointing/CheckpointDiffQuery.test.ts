import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { CheckpointRef, CheckpointScopeId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Diffy from "../diffy/Diffy.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { CheckpointRefUnavailableError, CheckpointTurnRangeUnavailableError } from "./Errors.ts";

const threadId = ThreadId.make("thread:checkpoint-diff-v2");
const firstRunId = RunId.make("run:checkpoint-diff-v2:1");
const secondRunId = RunId.make("run:checkpoint-diff-v2:2");
const firstScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:1");
const secondScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:2");
const secondRef = CheckpointRef.make("refs/t3/test/second");

function makeProjection(): ProjectionCheckpointContext {
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: firstRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "root_run", cwd: "/repo" },
    ],
    checkpoints: [
      {
        scopeId: secondScopeId,
        runId: secondRunId,
        ordinalWithinScope: 1,
        appRunOrdinal: 2,
        status: "ready",
        ref: secondRef,
      },
    ],
  };
}

function layerFor(input: {
  readonly projection: Effect.Effect<ProjectionCheckpointContext, OrchestratorProjectionError>;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
  readonly authoredPaths?: ReadonlySet<string>;
}) {
  return CheckpointDiffQuery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Diffy.layer,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () => input.projection,
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          diffCheckpoints: input.diffCheckpoints ?? (() => Effect.succeed("diff")),
          listAuthoredPaths: () => Effect.succeed(input.authoredPaths ?? null),
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );
}

it.effect("excludes ready checkpoints from rolled-back runs", () => {
  const projection = makeProjection();
  const layer = layerFor({
    projection: Effect.succeed({
      ...projection,
      runs: projection.runs.map((run) =>
        run.id === secondRunId ? { ...run, status: "rolled_back" as const } : run,
      ),
      checkpoints: [
        {
          ...projection.checkpoints[0]!,
          scopeId: firstScopeId,
          runId: firstRunId,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/t3/test/first"),
        },
        ...projection.checkpoints,
      ],
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 2, availableTurnCount: 1 },
    );
  }).pipe(Effect.provide(layer));
});

function makeProjectionAfterStoppedRun(stoppedRunCheckpoint: boolean) {
  const thirdRunId = RunId.make("run:checkpoint-diff-v2:3");
  const checkpoint = (
    ordinalWithinScope: number,
    runId: RunId | null,
  ): ProjectionCheckpointContext["checkpoints"][number] => ({
    scopeId: firstScopeId,
    runId,
    ordinalWithinScope,
    appRunOrdinal: runId === null ? null : ordinalWithinScope,
    status: "ready",
    ref: CheckpointRef.make(`refs/t3/test/ordinal/${ordinalWithinScope}`),
  });
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "interrupted" },
      { id: thirdRunId, ordinal: 3, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: thirdRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "tool", cwd: "/repo" },
    ],
    checkpoints: [
      {
        ...checkpoint(2, null),
        scopeId: secondScopeId,
        ref: CheckpointRef.make("refs/t3/test/tool/2"),
      },
      checkpoint(0, null),
      checkpoint(1, firstRunId),
      checkpoint(2, stoppedRunCheckpoint ? secondRunId : null),
      checkpoint(3, thirdRunId),
    ],
  } satisfies ProjectionCheckpointContext;
}

it.effect.each([false, true])(
  "diffs the turn after a stopped run from its parent checkpoint (stopped run captured: %s)",
  (stoppedRunCheckpoint) => {
    const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
      Effect.succeed("diff --git a/file b/file"),
    );
    const layer = layerFor({
      projection: Effect.succeed(makeProjectionAfterStoppedRun(stoppedRunCheckpoint)),
      diffCheckpoints,
    });

    return Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const result = yield* query.getTurnDiff({ threadId, fromTurnCount: 2, toTurnCount: 3 });

      assert.strictEqual(result.diff, "diff --git a/file b/file");
      yield* query.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 3 });
      yield* query.getFullThreadDiff({ threadId, toTurnCount: 3 });
      assert.deepEqual(
        diffCheckpoints.mock.calls.map(([input]) => ({
          from: input.fromCheckpointRef,
          to: input.toCheckpointRef,
        })),
        [
          { from: "refs/t3/test/ordinal/2", to: "refs/t3/test/ordinal/3" },
          { from: "refs/t3/test/ordinal/1", to: "refs/t3/test/ordinal/3" },
          {
            from: yield* checkpointRefForScopeOrdinal({
              scopeId: firstScopeId,
              ordinalWithinScope: 0,
            }),
            to: "refs/t3/test/ordinal/3",
          },
        ],
      );
      const stoppedTurnError = yield* query
        .getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 })
        .pipe(Effect.flip);
      assert.instanceOf(stoppedTurnError, CheckpointRefUnavailableError);
      assert.deepEqual(
        { checkpoint: stoppedTurnError.checkpoint, turnCount: stoppedTurnError.turnCount },
        { checkpoint: "to", turnCount: 2 },
      );
    }).pipe(Effect.provide(layer));
  },
);

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerStore = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  Layer.provide(NodeServices.layer),
);
const layerTest = Layer.merge(layerStore, layerVcsProcess).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Diffy.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.effect("shares the turn and full-thread diff budget across real Git batches", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const process = yield* VcsProcess.VcsProcess;
    const store = yield* CheckpointStore.CheckpointStore;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-diff-aggregate-" });
    const git = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
      process.run({
        operation: "CheckpointDiffQuery.test.git",
        command: "git",
        cwd,
        args,
        ...(env === undefined ? {} : { env }),
      });
    yield* git(["init"]);
    yield* git(["config", "user.email", "test@test.com"]);
    yield* git(["config", "user.name", "Test"]);
    yield* fs.writeFileString(path.join(cwd, "README.md"), "initial\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);

    const threadId = ThreadId.make("thread:aggregate-runtime");
    const runId = RunId.make("run:aggregate-runtime");
    const scopeId = CheckpointScopeId.make("scope:aggregate-runtime");
    const fromCheckpointRef = yield* checkpointRefForScopeOrdinal({
      scopeId,
      ordinalWithinScope: 0,
    });
    const toCheckpointRef = CheckpointRef.make("refs/t3/test/aggregate-after");
    yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
    // The old commit models files imported by a pull after the baseline was captured.
    yield* fs.writeFileString(path.join(cwd, "upstream.ts"), "imported\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "imported"], {
      ...globalThis.process.env,
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });
    const ownPaths = Array.from({ length: 1_600 }, (_, index) => `src/module-${index}/file.ts`);
    yield* Effect.forEach(
      ownPaths,
      (file) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true });
          yield* fs.writeFileString(path.join(cwd, file), `${"x".repeat(12_000)}\n`);
        }),
      { concurrency: 16, discard: true },
    );
    yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });

    const patchSizes: number[] = [];
    const query = yield* CheckpointDiffQuery.make.pipe(
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [{ id: runId, ordinal: 1, status: "completed" }],
              checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd }],
              checkpoints: [
                {
                  scopeId,
                  runId,
                  ordinalWithinScope: 1,
                  appRunOrdinal: 1,
                  status: "ready",
                  ref: toCheckpointRef,
                },
              ],
            }),
        }),
      ),
      Effect.provideService(CheckpointStore.CheckpointStore, {
        ...store,
        diffCheckpoints: (input) =>
          store.diffCheckpoints(input).pipe(
            Effect.tap((patch) =>
              Effect.sync(() => {
                if (input.format !== "numstat") {
                  patchSizes.push(Buffer.byteLength(patch));
                }
              }),
            ),
          ),
      }),
    );
    const turn = yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
    const turnPatchSizes = patchSizes.splice(0);
    const fullThread = yield* query.getFullThreadDiff({ threadId, toTurnCount: 1 });
    assert.isTrue(fullThread.diff === turn.diff);
    assert.isAtMost(Buffer.byteLength(turn.diff), 10_000_000);
    assert.isTrue(turn.diff.endsWith("\n\n[truncated]"));
    assert.include(turn.diff, "src/module-0/file.ts");
    assert.notInclude(turn.diff, "upstream.ts");
    assert.lengthOf(turnPatchSizes, 2);
    assert.deepEqual(patchSizes, turnPatchSizes);
    assert.isBelow(turnPatchSizes[0]!, 10_000_000);
    assert.strictEqual(
      turnPatchSizes.reduce((sum, size) => sum + size, 0),
      10_000_001,
    );
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("truncates a storage-cut UTF-8 character without replacement text", () => {
  const prefix = "x".repeat(9_999_985);
  const layer = layerFor({
    projection: Effect.succeed(makeProjection()),
    diffCheckpoints: (input) =>
      Effect.succeed(
        Buffer.from(`${prefix}😀${"x".repeat(9)}😀tail`)
          .subarray(0, input.maxOutputBytes)
          .toString("utf8"),
      ),
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 });
    assert.isAtMost(Buffer.byteLength(result.diff), 10_000_000);
    assert.isTrue(result.diff === `${prefix}\n\n[truncated]`);
  }).pipe(Effect.provide(layer));
});

it.effect("preserves an exact-fit filtered patch across batches without a marker", () => {
  const ownPaths = Array.from({ length: 1_000 }, (_, index) => `src/module-${index}/file.ts`);
  const patches = ["é".repeat(3_000_000), "x".repeat(4_000_000)];
  let patchReads = 0;
  const layer = layerFor({
    projection: Effect.succeed(makeProjection()),
    authoredPaths: new Set(ownPaths),
    diffCheckpoints: (input) =>
      Effect.sync(() =>
        input.format === "numstat"
          ? [...ownPaths, "upstream.ts"].map((path) => `1\t0\t${path}\0`).join("")
          : patches[patchReads++]!,
      ),
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.isTrue(result.diff === patches.join(""));
    assert.strictEqual(patchReads, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("diffs a turn semantically from real checkpoint contents", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const process = yield* VcsProcess.VcsProcess;
    const store = yield* CheckpointStore.CheckpointStore;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-semantic-diff-" });
    const git = (args: ReadonlyArray<string>) =>
      process.run({ operation: "CheckpointDiffQuery.test.git", command: "git", cwd, args });
    const write = (file: string, contents: string) =>
      fs.writeFileString(path.join(cwd, file), contents);
    const rust = (body: string) => `fn total() -> u32 {\n    ${body}\n}\n\nfn other() {}\n`;
    const renamed = Array.from({ length: 40 }, (_, line) => `line ${line} ✓\n`).join("");
    yield* git(["init"]);
    yield* git(["config", "user.email", "test@test.com"]);
    yield* git(["config", "user.name", "Test"]);
    yield* write("lib.rs", rust("1 + 1"));
    yield* write("gone.txt", "bye\n");
    yield* write("old-name.txt", renamed);
    yield* write("big.txt", "small\n");
    yield* write(
      "pipe.ts",
      "function f(hash: string) {\n  return parse(\n    Result.getOrThrow(decode(hash.slice(1))),\n  );\n}\n",
    );
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);

    const scopeId = CheckpointScopeId.make("scope:semantic-runtime");
    const runId = RunId.make("run:semantic-runtime");
    const fromCheckpointRef = yield* checkpointRefForScopeOrdinal({
      scopeId,
      ordinalWithinScope: 0,
    });
    const toCheckpointRef = CheckpointRef.make("refs/t3/test/semantic-after");
    yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
    yield* write("lib.rs", rust("2 + 2"));
    yield* fs.remove(path.join(cwd, "gone.txt"));
    yield* fs.rename(path.join(cwd, "old-name.txt"), path.join(cwd, "new-name.txt"));
    yield* write("added.txt", "héllo\n");
    yield* write("big.txt", "x".repeat(1_100_000));
    // Diffy aligns this refactor differently from git: it counts +6 -3 where git counts +5 -2.
    yield* write(
      "pipe.ts",
      "function f(hash: string) {\n  return pipe(\n    hash.slice(1),\n    decode,\n    Result.getOrThrow,\n    parse,\n  );\n}\n",
    );
    yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });

    const query = yield* CheckpointDiffQuery.make.pipe(
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [{ id: runId, ordinal: 1, status: "completed" }],
              checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd }],
              checkpoints: [
                {
                  scopeId,
                  runId,
                  ordinalWithinScope: 1,
                  appRunOrdinal: 1,
                  status: "ready",
                  ref: toCheckpointRef,
                },
              ],
            }),
        }),
      ),
    );
    const range = { threadId, fromTurnCount: 0, toTurnCount: 1 };
    const result = yield* query.getTurnSemanticDiff(range);

    assert.deepEqual(
      result.files?.map((file) => [file.status, file.old_path, file.new_path]),
      [
        ["added", undefined, "added.txt"],
        ["deleted", "gone.txt", undefined],
        ["modified", "lib.rs", "lib.rs"],
        ["renamed", "old-name.txt", "new-name.txt"],
        ["modified", "pipe.ts", "pipe.ts"],
      ],
    );
    // Counts match git's, as the turn summary does.
    const pipe = result.files?.find((file) => file.new_path === "pipe.ts");
    assert.deepEqual([pipe?.additions, pipe?.deletions], [5, 2]);
    assert.deepEqual(result.files?.find((file) => file.status === "added")?.hunks?.[0]?.rows, [
      { kind: "added", new: { line: 1, text: "héllo" } },
    ]);
    const lib = result.files?.find((file) => file.new_path === "lib.rs");
    assert.strictEqual(lib?.fallback, undefined);
    assert.strictEqual(lib?.hunks?.[0]?.header, "total");
    assert.deepEqual(result.omitted, [
      {
        status: "modified",
        old_path: "big.txt",
        new_path: "big.txt",
        additions: 1,
        deletions: 1,
        reason: "too_large",
      },
    ]);

    const onlyLib = yield* query.getTurnSemanticDiff({ ...range, paths: ["lib.rs"], syntax: true });
    assert.deepEqual(
      onlyLib.files?.map((file) => file.new_path),
      ["lib.rs"],
    );
    const libRows = onlyLib.files?.[0]?.hunks?.flatMap((hunk) => hunk.rows) ?? [];
    assert.isTrue(libRows.some((row) => (row.kind === "context" ? row.syntax : undefined)?.length));

    const rename = result.files?.find((file) => file.status === "renamed");
    const gap = rename?.gap_after ?? rename?.hunks?.[0]?.gap_before;
    assert.isDefined(gap);
    const expanded = yield* query.expandTurnDiffGap({
      ...range,
      status: "renamed",
      old_path: "old-name.txt",
      new_path: "new-name.txt",
      gap: gap!,
    });
    assert.strictEqual(expanded.rows.length, gap!.len);
    assert.deepEqual(expanded.rows[0], {
      kind: "context",
      old_line: gap!.old_start,
      new_line: gap!.new_start,
      text: `line ${gap!.old_start - 1} ✓`,
    });
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
