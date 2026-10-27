// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef, VcsProcessExitError, VcsWorkspaceStaleError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { describe } from "vite-plus/test";

import * as ProcessRunner from "../../processRunner.ts";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import * as VcsProcess from "../VcsProcess.ts";
import { JjCli } from "./JjCli.ts";
import * as JjCheckpoints from "./JjCheckpoints.ts";

// CI images do not ship jj yet; these suites need the real binary.
const jjAvailable = NodeChildProcess.spawnSync("jj", ["--version"]).status === 0;

const JJ_GLOBAL_ARGS = [
  "--color=never",
  "--no-pager",
  "--config",
  "ui.paginate=never",
  "--config",
  "ui.log-word-wrap=false",
  "--config",
  "snapshot.auto-update-stale=false",
  "--config",
  "git.abandon-unreachable-commits=false",
];

// Isolates every jj and git process from the developer's config.
const layerFixtureVcsProcess = Layer.effect(
  VcsProcess.VcsProcess,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const configHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-config-" });
    const vcsProcess = yield* VcsProcess.make;
    const env = {
      JJ_CONFIG: "",
      JJ_USER: "T3 Test",
      JJ_EMAIL: "t3@example.com",
      XDG_CONFIG_HOME: configHome,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    return VcsProcess.VcsProcess.of({
      run: (input) => vcsProcess.run({ ...input, env: { ...env, ...input.env } }),
    });
  }),
).pipe(Layer.provide(ProcessRunner.layer));

const STALE_PATTERN = /The working copy is stale|Could not read working copy's operation/;

// Stands in for the real JjCli runner with the same flags and stale classification.
const layerJjCliTest = Layer.effect(
  JjCli,
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    return JjCli.of({
      run: (input) =>
        vcsProcess
          .run({
            operation: input.operation,
            command: "jj",
            cwd: input.cwd,
            args: [
              ...JJ_GLOBAL_ARGS,
              ...(input.workingCopy === "observe" ? ["--ignore-working-copy"] : []),
              ...input.args,
            ],
            env: { JJ_EDITOR: "false", JJ_PAGER: "cat", JJ_OP_USERNAME: "t3code" },
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.flatMap((result) => {
              if (result.exitCode === 0 || input.allowNonZeroExit === true) {
                return Effect.succeed(result);
              }
              const context = { operation: input.operation, cwd: input.cwd };
              return Effect.fail(
                STALE_PATTERN.test(result.stderr)
                  ? new VcsWorkspaceStaleError({ ...context, detail: result.stderr.trim() })
                  : new VcsProcessExitError({
                      ...context,
                      command: `jj ${input.args[0] ?? ""}`,
                      exitCode: result.exitCode,
                      detail: result.stderr.trim(),
                    }),
              );
            }),
          ),
      version: Effect.succeed({ major: 0, minor: 46, patch: 0, raw: "0.46.0" }),
    });
  }),
);

const layerTest = layerJjCliTest.pipe(
  Layer.provideMerge(layerFixtureVcsProcess),
  Layer.provideMerge(NodeServices.layer),
);

const jj = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(JjCli, (cli) =>
    cli.run({ operation: "JjCheckpoints.test.jj", cwd, args, workingCopy: "snapshot" }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(VcsProcess.VcsProcess, (vcsProcess) =>
    vcsProcess.run({
      operation: "JjCheckpoints.test.git",
      command: "git",
      cwd,
      args: ["-C", cwd, ...args],
    }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

const workingCopyCommit = (cwd: string) =>
  jj(cwd, ["log", "--no-graph", "-r", "@", "-T", "self.commit_id()"]);

const makeCheckpoints = Effect.gen(function* () {
  const gitDriver = yield* GitVcsDriver.makeVcsDriverShape();
  return yield* JjCheckpoints.make({
    execute: gitDriver.execute,
    checkpoints: gitDriver.checkpoints,
  });
});

const checkpointRef = (ordinal: number) =>
  CheckpointRef.make(`refs/t3/orchestration-v2/checkpoints/jj-test/ordinal/${ordinal}`);

const BIG_FILE_BYTES = 1_500_000;

// A colocated repo `main` with a secondary colocated workspace `ws` on the base commit.
const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-checkpoints-" });
  const main = NodePath.join(root, "main");
  const ws = NodePath.join(root, "ws");
  yield* jj(root, ["git", "init", "--colocate", "main"]);
  yield* fileSystem.writeFileString(NodePath.join(main, "a.txt"), "base\n");
  yield* fileSystem.writeFile(NodePath.join(main, "big.bin"), new Uint8Array(BIG_FILE_BYTES));
  yield* fileSystem.writeFileString(NodePath.join(main, "exec.sh"), "#!/bin/sh\n");
  yield* fileSystem.chmod(NodePath.join(main, "exec.sh"), 0o755);
  yield* fileSystem.symlink("a.txt", NodePath.join(main, "link"));
  yield* jj(main, ["--config", "snapshot.max-new-file-size=10MiB", "commit", "-m", "base"]);
  const base = yield* jj(main, ["log", "--no-graph", "-r", "@-", "-T", "self.commit_id()"]);
  yield* jj(main, ["workspace", "add", "--colocate", "--name", "ws", "-r", base, ws]);
  return { main, ws, base };
});

describe.skipIf(!jjAvailable)("JjCheckpoints", () => {
  it.live("round-trips deletions, mode bits, symlinks, and large files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { ws } = yield* makeFixture;
      const checkpoints = yield* makeCheckpoints;
      const file = (name: string) => NodePath.join(ws, name);

      yield* fileSystem.writeFileString(file("a.txt"), "turn 1\n");
      yield* fileSystem.writeFileString(file("notes.txt"), "notes\n");
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) });

      yield* fileSystem.remove(file("big.bin"));
      yield* fileSystem.remove(file("notes.txt"));
      yield* fileSystem.chmod(file("exec.sh"), 0o644);
      yield* fileSystem.remove(file("link"));
      yield* fileSystem.writeFileString(file("link"), "regular\n");
      yield* fileSystem.writeFileString(file("t2.txt"), "turn 2\n");
      yield* fileSystem.writeFileString(file("a.txt"), "turn 2\n");
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(2) });

      const numstat = yield* checkpoints.diffCheckpoints({
        cwd: ws,
        fromCheckpointRef: checkpointRef(1),
        toCheckpointRef: checkpointRef(2),
        ignoreWhitespace: false,
        format: "numstat",
      });
      assert.deepEqual(
        numstat
          .split("\0")
          .map((entry) => entry.split("\t")[2])
          .filter((path) => path !== undefined && path.length > 0)
          .toSorted(),
        ["a.txt", "big.bin", "exec.sh", "link", "notes.txt", "t2.txt"],
      );

      assert.isTrue(
        yield* checkpoints.restoreCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) }),
      );
      assert.strictEqual(yield* fileSystem.readFileString(file("a.txt")), "turn 1\n");
      assert.strictEqual(yield* fileSystem.readFileString(file("notes.txt")), "notes\n");
      assert.isFalse(yield* fileSystem.exists(file("t2.txt")));
      assert.strictEqual((yield* fileSystem.stat(file("big.bin"))).size, BigInt(BIG_FILE_BYTES));
      assert.strictEqual((yield* fileSystem.stat(file("exec.sh"))).mode & 0o111, 0o111);
      assert.strictEqual(yield* fileSystem.readLink(file("link")), "a.txt");

      // The next snapshot keeps the restored large file tracked.
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(3) });
      assert.strictEqual(
        yield* checkpoints.diffCheckpoints({
          cwd: ws,
          fromCheckpointRef: checkpointRef(1),
          toCheckpointRef: checkpointRef(3),
          ignoreWhitespace: false,
        }),
        "",
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("restores a tracked file that info/exclude now ignores", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { main, ws } = yield* makeFixture;
      const checkpoints = yield* makeCheckpoints;

      yield* fileSystem.writeFileString(NodePath.join(ws, "notes.txt"), "notes\n");
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) });
      yield* fileSystem.remove(NodePath.join(ws, "notes.txt"));
      yield* fileSystem.writeFileString(
        NodePath.join(main, ".git", "info", "exclude"),
        "notes.txt\n",
        { flag: "a" },
      );
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(2) });

      assert.isTrue(
        yield* checkpoints.restoreCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) }),
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(NodePath.join(ws, "notes.txt")),
        "notes\n",
      );
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(3) });
      assert.strictEqual(
        yield* checkpoints.diffCheckpoints({
          cwd: ws,
          fromCheckpointRef: checkpointRef(1),
          toCheckpointRef: checkpointRef(3),
          ignoreWhitespace: false,
        }),
        "",
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("restores a conflicted checkpoint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { ws, base } = yield* makeFixture;
      const checkpoints = yield* makeCheckpoints;
      const aTxt = NodePath.join(ws, "a.txt");

      yield* fileSystem.writeFileString(aTxt, "left\n");
      const left = yield* workingCopyCommit(ws);
      yield* jj(ws, ["new", base]);
      yield* fileSystem.writeFileString(aTxt, "right\n");
      const right = yield* workingCopyCommit(ws);
      yield* jj(ws, ["new", left, right]);
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) });
      yield* fileSystem.writeFileString(aTxt, "resolved\n");
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(2) });

      assert.isTrue(
        yield* checkpoints.restoreCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) }),
      );
      assert.strictEqual(
        yield* jj(ws, ["log", "--no-graph", "-r", "@", "-T", "self.conflict()"]),
        "true",
      );
      assert.include(yield* fileSystem.readFileString(aTxt), "<<<<<<<");
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("refuses to restore when another workspace builds on this one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { main, ws } = yield* makeFixture;
      const checkpoints = yield* makeCheckpoints;
      const aTxt = NodePath.join(ws, "a.txt");
      const ws2 = NodePath.join(NodePath.dirname(ws), "ws2");

      yield* fileSystem.writeFileString(aTxt, "turn 1\n");
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) });
      yield* jj(main, ["workspace", "add", "--colocate", "--name", "ws2", "-r", "ws@", ws2]);
      yield* fileSystem.writeFileString(aTxt, "turn 2\n");

      const error = yield* Effect.flip(
        checkpoints.restoreCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) }),
      );
      assert.strictEqual(error._tag, "VcsUnsupportedOperationError");
      assert.include(error.message, "ws2");
      assert.strictEqual(yield* fileSystem.readFileString(aTxt), "turn 2\n");
      // Refusing before the snapshot leaves the dependent workspace usable.
      yield* jj(ws2, ["status"]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("fails a stale workspace restore without touching files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { main, ws } = yield* makeFixture;
      const checkpoints = yield* makeCheckpoints;
      const aTxt = NodePath.join(ws, "a.txt");

      yield* fileSystem.writeFileString(aTxt, "turn 1\n");
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) });
      yield* fileSystem.writeFileString(aTxt, "turn 2\n");
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(2) });
      yield* fileSystem.writeFileString(NodePath.join(main, "m.txt"), "main\n");
      yield* jj(main, ["commit", "-m", "other"]);
      yield* jj(main, ["rebase", "-s", "ws@", "-d", "@-"]);
      yield* fileSystem.writeFileString(aTxt, "unsnapshotted\n");

      const error = yield* Effect.flip(
        checkpoints.restoreCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) }),
      );
      assert.strictEqual(error._tag, "VcsWorkspaceStaleError");
      assert.strictEqual(yield* fileSystem.readFileString(aTxt), "unsnapshotted\n");
      assert.isFalse(yield* fileSystem.exists(NodePath.join(ws, "m.txt")));
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("restores a checkpoint jj garbage-collected by re-importing it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { ws } = yield* makeFixture;
      const checkpoints = yield* makeCheckpoints;
      const aTxt = NodePath.join(ws, "a.txt");

      yield* fileSystem.writeFileString(aTxt, "turn 1\n");
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) });
      const captured = yield* git(ws, ["rev-parse", checkpointRef(1)]);
      for (const content of ["one\n", "two\n", "three\n"]) {
        yield* fileSystem.writeFileString(aTxt, content);
        yield* jj(ws, ["util", "snapshot"]);
      }
      yield* jj(ws, ["op", "abandon", "..@-"]);
      yield* jj(ws, ["util", "gc", "--expire=now"]);
      assert.strictEqual(
        yield* jj(ws, ["log", "--no-graph", "-r", `present(${captured})`, "-T", "commit_id"]),
        "",
      );

      assert.isTrue(
        yield* checkpoints.restoreCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) }),
      );
      assert.strictEqual(yield* fileSystem.readFileString(aTxt), "turn 1\n");
      assert.strictEqual(yield* git(ws, ["diff", captured, yield* workingCopyCommit(ws)]), "");
      assert.strictEqual(
        yield* jj(ws, ["log", "--no-graph", "-r", "divergent()", "-T", "commit_id"]),
        "",
      );
      assert.strictEqual(yield* git(ws, ["for-each-ref", "refs/heads/t3-cp-*"]), "");
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("lists authored paths only while the parent is unchanged", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { ws } = yield* makeFixture;
      const checkpoints = yield* makeCheckpoints;

      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(1) });
      yield* fileSystem.writeFileString(NodePath.join(ws, "a.txt"), "turn 1\n");
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(2) });
      yield* jj(ws, ["new"]);
      yield* fileSystem.writeFileString(NodePath.join(ws, "b.txt"), "turn 2\n");
      yield* checkpoints.captureCheckpoint({ cwd: ws, checkpointRef: checkpointRef(3) });

      const authored = (from: number, to: number) =>
        checkpoints.listAuthoredPaths({
          cwd: ws,
          fromCheckpointRef: checkpointRef(from),
          toCheckpointRef: checkpointRef(to),
        });
      assert.deepEqual(yield* authored(1, 2), new Set(["a.txt"]));
      assert.isNull(yield* authored(2, 3));
    }).pipe(Effect.provide(layerTest)),
  );
});
