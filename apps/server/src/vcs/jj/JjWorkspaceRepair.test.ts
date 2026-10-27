// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { VcsProcessExitError, VcsWorkspaceStaleError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitVcsDriver from "../GitVcsDriver.ts";
import * as VcsDriverRegistry from "../VcsDriverRegistry.ts";
import * as VcsProcess from "../VcsProcess.ts";
import { JjCli } from "./JjCli.ts";
import * as JjWorkspaceRepair from "./JjWorkspaceRepair.ts";

// CI runners do not install jj; these tests drive the real binary.
const jjAvailable = NodeChildProcess.spawnSync("jj", ["--version"]).status === 0;

const JJ_FLAGS = [
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
const STALE = /The working copy is stale|Could not read working copy's operation/;

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerTest = Layer.mergeAll(layerVcsProcess, NodeServices.layer);

// Stand-in for the foundation lane's JjCli, with the same flags and stale classification.
const layerJjCliTest = (env: NodeJS.ProcessEnv) =>
  Layer.effect(
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
                ...JJ_FLAGS,
                ...(input.workingCopy === "observe" ? ["--ignore-working-copy"] : []),
                ...input.args,
              ],
              env,
              allowNonZeroExit: true,
            })
            .pipe(
              Effect.flatMap((output) => {
                if (output.exitCode === 0 || input.allowNonZeroExit) return Effect.succeed(output);
                const context = { operation: input.operation, cwd: input.cwd };
                const detail = output.stderr.trim();
                return Effect.fail(
                  STALE.test(output.stderr)
                    ? new VcsWorkspaceStaleError({ ...context, detail })
                    : new VcsProcessExitError({
                        ...context,
                        command: "jj",
                        exitCode: output.exitCode,
                        detail,
                      }),
                );
              }),
            ),
        version: Effect.die("unused"),
      });
    }),
  );

const layerRegistryTest = Layer.unwrap(
  Effect.map(GitVcsDriver.makeVcsDriver, (git) =>
    Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      get: () => Effect.succeed(git),
      detect: ({ cwd }) =>
        Effect.succeed({
          kind: "jj",
          repository: {
            kind: "jj",
            rootPath: cwd,
            metadataPath: null,
            freshness: {
              source: "live-local",
              observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
              expiresAt: Option.none(),
            },
          },
          driver: git,
        }),
    }),
  ),
);

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "jj-repair-test-" });
  yield* fs.writeFileString(NodePath.join(dir, "jj-config.toml"), "");
  yield* fs.writeFileString(NodePath.join(dir, "gitconfig"), "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JJ_CONFIG: NodePath.join(dir, "jj-config.toml"),
    JJ_USER: "T3 Test",
    JJ_EMAIL: "t3@example.test",
    JJ_EDITOR: "false",
    GIT_CONFIG_GLOBAL: NodePath.join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const exec = (command: "jj" | "git", cwd: string, args: ReadonlyArray<string>) =>
    vcsProcess.run({
      operation: "JjWorkspaceRepair.test",
      command,
      cwd,
      args: command === "jj" ? [...JJ_FLAGS, ...args] : args,
      env,
      allowNonZeroExit: true,
    });
  const run = (command: "jj" | "git", cwd: string, args: ReadonlyArray<string>) =>
    exec(command, cwd, args).pipe(
      Effect.tap((output) =>
        output.exitCode === 0 ? Effect.void : Effect.die(`${command} failed: ${output.stderr}`),
      ),
      Effect.map((output) => output.stdout.trim()),
    );
  const main = NodePath.join(dir, "main");
  const ws = NodePath.join(dir, "ws1");
  yield* run("jj", dir, ["git", "init", "--colocate", main]);
  yield* fs.writeFileString(NodePath.join(main, "a.txt"), "a\n");
  yield* run("jj", main, ["commit", "-m", "base"]);
  yield* run("jj", main, ["workspace", "add", "--colocate", "--name", "ws1", "-r", "@-", ws]);

  const repair = (cwd: string) =>
    JjWorkspaceRepair.JjWorkspaceRepair.pipe(
      Effect.flatMap((service) => service.repair({ cwd })),
      Effect.provide(
        JjWorkspaceRepair.layer.pipe(
          Layer.provide(Layer.mergeAll(layerJjCliTest(env), layerRegistryTest)),
        ),
      ),
    );
  return { fs, main, ws, exec, run, repair };
});

describe.skipIf(!jjAvailable)("JjWorkspaceRepair", () => {
  it.live("preserves disk files under a ref, then un-stales the workspace", () =>
    Effect.gen(function* () {
      const { fs, main, ws, exec, run, repair } = yield* makeFixture;
      yield* fs.writeFileString(NodePath.join(ws, "a.txt"), "snapshotted\n");
      yield* run("jj", ws, ["util", "snapshot"]);
      yield* fs.writeFileString(NodePath.join(ws, "a.txt"), "edited\n");
      yield* fs.writeFileString(NodePath.join(ws, "untracked_new.txt"), "new\n");
      const changeId = yield* run("jj", main, [
        "log",
        "--no-graph",
        "-r",
        "ws1@",
        "-T",
        "change_id",
      ]);
      yield* fs.writeFileString(NodePath.join(main, "other.txt"), "other\n");
      yield* run("jj", main, ["commit", "-m", "other"]);
      const other = yield* run("jj", main, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"]);
      yield* run("jj", main, ["rebase", "-s", "ws1@", "-d", other]);
      const staleSnapshot = yield* exec("jj", ws, ["util", "snapshot"]);
      expect(staleSnapshot.stderr).toContain("The working copy is stale");

      const result = yield* repair(ws);

      if (!result.repaired) return expect.fail("expected a repair");
      expect(result.preservedRef).toMatch(/^refs\/t3\/repair\/ws1\/[\w-]+$/);
      expect(result.divergentChangeIds).toEqual([changeId]);
      expect(yield* run("git", ws, ["show", `${result.preservedRef}:a.txt`])).toBe("edited");
      expect(yield* run("git", ws, ["show", `${result.preservedRef}:untracked_new.txt`])).toBe(
        "new",
      );
      yield* run("jj", ws, ["util", "snapshot"]);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("leaves a workspace that is not stale untouched", () =>
    Effect.gen(function* () {
      const { fs, ws, run, repair } = yield* makeFixture;
      yield* fs.writeFileString(NodePath.join(ws, "a.txt"), "edited\n");

      expect(yield* repair(ws)).toEqual({ repaired: false });
      expect(yield* run("git", ws, ["for-each-ref", "refs/t3/repair"])).toBe("");
      expect(
        yield* run("jj", ws, ["log", "--no-graph", "-r", "divergent()", "-T", "change_id"]),
      ).toBe("");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
