import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { type VcsError, VcsProcessSpawnError } from "@t3tools/contracts";
import * as JjFixture from "../testing/JjFixture.ts";
import * as VcsProcess from "../VcsProcess.ts";
import * as JjCli from "./JjCli.ts";

const output = (stdout: string, stderr = "", exitCode = 0): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const STALE_STDERR =
  "Error: The working copy is stale (not updated since operation 1fe7db7acb5f).\nHint: Run `jj workspace update-stale` to update it.\n";
const LOST_OPERATION_STDERR =
  "Error: Could not read working copy's operation.\nHint: Run `jj workspace update-stale` to recover.\n";
const INDEX_LOCK_STDERR =
  "Error: Failed to reset Git HEAD state\nCaused by:\n1: Could not acquire lock for index file\n";

const missingBinary = (input: VcsProcess.VcsProcessInput) =>
  new VcsProcessSpawnError({
    operation: input.operation,
    command: input.command,
    cwd: input.cwd,
    cause: PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
    }),
  });

const makeCli = (
  respond: (
    input: VcsProcess.VcsProcessInput,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>,
  version = "jj 0.46.0-7d382314f9420b4b8d932245b49c99492c812b9f\n",
) =>
  Effect.gen(function* () {
    const commands: Array<VcsProcess.VcsProcessInput> = [];
    let versionProbes = 0;
    const cli = yield* JjCli.make.pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.args[0] === "--version") {
            versionProbes += 1;
            return Effect.succeed(output(version));
          }
          commands.push(input);
          return respond(input);
        },
      }),
    );
    return { cli, commands, versionProbes: () => versionProbes };
  });

const baseInput = {
  operation: "test.jj",
  cwd: "/workspace",
  args: ["log", "--no-graph"],
  workingCopy: "observe",
} satisfies JjCli.JjRunInput;

describe("JjCli", () => {
  it.effect("applies the fixed flags, config overrides, and environment to every command", () =>
    Effect.gen(function* () {
      const { cli, commands } = yield* makeCli(() => Effect.succeed(output("ok")));

      yield* cli.run(baseInput);
      yield* cli.run({ ...baseInput, args: ["util", "snapshot"], workingCopy: "snapshot" });

      const overrides = [
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
      assert.deepStrictEqual(commands[0]?.args, [
        ...overrides,
        "--ignore-working-copy",
        "log",
        "--no-graph",
      ]);
      assert.deepStrictEqual(commands[1]?.args, [...overrides, "util", "snapshot"]);
      assert.equal(commands[0]?.command, "jj");
      assert.deepStrictEqual(commands[0]?.env, {
        JJ_EDITOR: "false",
        JJ_PAGER: "cat",
        JJ_OP_USERNAME: "t3code",
      });
    }),
  );

  it.effect("reports both stale working-copy messages as stale without retrying", () =>
    Effect.gen(function* () {
      for (const stderr of [STALE_STDERR, LOST_OPERATION_STDERR]) {
        const { cli, commands } = yield* makeCli(() => Effect.succeed(output("", stderr, 1)));

        const error = yield* cli.run({ ...baseInput, allowNonZeroExit: true }).pipe(Effect.flip);

        assert.equal(error._tag, "VcsWorkspaceStaleError");
        assert.notInclude(error.message, "Hint");
        assert.equal(commands.length, 1);
      }
    }),
  );

  it.effect("retries a held index lock with the bounded Git policy, then reports it", () =>
    Effect.gen(function* () {
      const { cli, commands } = yield* makeCli(() =>
        Effect.succeed(output("", INDEX_LOCK_STDERR, 1)),
      );

      const fiber = yield* cli.run(baseInput).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);

      assert.equal(error._tag, "VcsProcessExitError");
      if (error._tag === "VcsProcessExitError") {
        assert.equal(error.retryable, true);
        assert.equal(error.detail, VcsProcess.GIT_INDEX_LOCKED_DETAIL);
      }
      assert.equal(commands.length, 3);
    }),
  );

  it.effect("succeeds once a held index lock is released", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const { cli } = yield* makeCli(() => {
        attempts += 1;
        return Effect.succeed(attempts === 1 ? output("", INDEX_LOCK_STDERR, 1) : output("done"));
      });

      const fiber = yield* cli.run(baseInput).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");

      assert.equal((yield* Fiber.join(fiber)).stdout, "done");
      assert.equal(attempts, 2);
    }),
  );

  it.effect("returns non-zero exits only when allowed, with jj's error line as detail", () =>
    Effect.gen(function* () {
      const { cli } = yield* makeCli(() =>
        Effect.succeed(output("", "Error: Revision `nope` doesn't exist\n", 1)),
      );

      assert.equal((yield* cli.run({ ...baseInput, allowNonZeroExit: true })).exitCode, 1);
      const error = yield* cli.run(baseInput).pipe(Effect.flip);
      assert.equal(error._tag, "VcsProcessExitError");
      if (error._tag === "VcsProcessExitError") {
        assert.equal(error.detail, "Revision `nope` doesn't exist");
        assert.isUndefined(error.retryable);
      }
    }),
  );

  it.effect("reports a missing binary as unsupported and probes again on the next call", () =>
    Effect.gen(function* () {
      let installed = false;
      const commands: Array<VcsProcess.VcsProcessInput> = [];
      const cli = yield* JjCli.make.pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) => {
            if (!installed) return Effect.fail(missingBinary(input));
            if (input.args[0] === "--version") return Effect.succeed(output("jj 0.46.0\n"));
            commands.push(input);
            return Effect.succeed(output("ok"));
          },
        }),
      );

      const error = yield* cli.run(baseInput).pipe(Effect.flip);
      assert.equal(error._tag, "VcsUnsupportedOperationError");
      if (error._tag === "VcsUnsupportedOperationError") assert.equal(error.kind, "jj");

      installed = true;
      assert.equal((yield* cli.run(baseInput)).stdout, "ok");
      assert.equal(commands.length, 1);
    }),
  );

  it.effect("refuses to run jj older than the supported minimum", () =>
    Effect.gen(function* () {
      const { cli, commands } = yield* makeCli(
        () => Effect.succeed(output("ok")),
        "jj 0.45.2-abcdef\n",
      );

      const error = yield* cli.run(baseInput).pipe(Effect.flip);

      assert.equal(error._tag, "VcsUnsupportedOperationError");
      assert.include(error.message, JjCli.JJ_MIN_VERSION);
      assert.equal(commands.length, 0);
      assert.deepStrictEqual(yield* cli.version, {
        major: 0,
        minor: 45,
        patch: 2,
        raw: "jj 0.45.2-abcdef",
      });
    }),
  );

  it.effect("caches the version between commands", () =>
    Effect.gen(function* () {
      const { cli, versionProbes } = yield* makeCli(() => Effect.succeed(output("ok")));

      yield* cli.run(baseInput);
      yield* cli.run(baseInput);

      assert.equal(versionProbes(), 1);
    }),
  );

  it("compares versions against the floor", () => {
    const supported = (raw: string) => {
      const version = JjCli.parseJjVersion(raw);
      return version === null ? null : JjCli.isSupportedJjVersion(version);
    };
    assert.equal(supported("jj 0.46.0-7d382314f9420b4b8d932245b49c99492c812b9f"), true);
    assert.equal(supported("jj 0.47.1"), true);
    assert.equal(supported("jj 1.0.0"), true);
    assert.equal(supported("jj 0.45.9"), false);
    assert.equal(supported("not jj"), null);
  });
});

const layerLive = JjCli.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(JjFixture.layerIsolatedEnv),
  Layer.provideMerge(NodeServices.layer),
);

describe.skipIf(!JjFixture.jjAvailable)("JjCli with the real binary", () => {
  it.live("reports a stale secondary workspace on snapshot and still allows observing reads", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cli = yield* JjCli.JjCli;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-cli-" });
      const main = path.join(parent, "main");
      const ws = path.join(parent, "ws1");
      yield* fileSystem.makeDirectory(main);
      yield* JjFixture.createColocatedRepo(main);
      yield* JjFixture.addWorkspace(main, "ws1", ws);
      yield* JjFixture.makeWorkspaceStale(main, "ws1");

      const error = yield* cli
        .run({ operation: "test.status", cwd: ws, args: ["status"], workingCopy: "snapshot" })
        .pipe(Effect.flip);
      assert.equal(error._tag, "VcsWorkspaceStaleError");

      const observed = yield* cli.run({
        operation: "test.log",
        cwd: ws,
        args: ["log", "--no-graph", "-r", "@", "-T", "self.commit_id()"],
        workingCopy: "observe",
      });
      assert.match(observed.stdout, /^[0-9a-f]{40}$/);
    }).pipe(Effect.provide(layerLive)),
  );

  it.live("classifies a held Git index lock as retryable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cli = yield* JjCli.JjCli;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-cli-" });
      yield* JjFixture.createColocatedRepo(cwd);
      yield* fileSystem.writeFileString(path.join(cwd, ".git", "index.lock"), "");
      yield* JjFixture.writeFile(cwd, "a.txt", "changed\n");

      const error = yield* cli
        .run({ operation: "test.status", cwd, args: ["status"], workingCopy: "snapshot" })
        .pipe(Effect.flip);

      assert.equal(error._tag, "VcsProcessExitError");
      if (error._tag === "VcsProcessExitError") assert.equal(error.retryable, true);
    }).pipe(Effect.provide(layerLive)),
  );

  it.live("parses the installed version", () =>
    Effect.gen(function* () {
      const version = yield* (yield* JjCli.JjCli).version;
      assert.isTrue(JjCli.isSupportedJjVersion(version));
      assert.match(version.raw, /^jj \d+\.\d+\.\d+/);
    }).pipe(Effect.provide(layerLive)),
  );
});
