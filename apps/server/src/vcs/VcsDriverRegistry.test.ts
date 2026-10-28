import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessSpawnError } from "@t3tools/contracts";
import * as JjFixture from "./testing/JjFixture.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const normalizeGitArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args[0] === "-C" && args.length >= 2 ? args.slice(2) : args;

describe("VcsDriverRegistry", () => {
  const makeDiskBackedLayer = (rootDir: string, calls: string[]) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const command = normalizeGitArgs(input.args).join(" ");
              calls.push(command);
              let repoDir: string | null = input.cwd;
              while (repoDir !== null && !(yield* fs.exists(path.join(repoDir, ".git")))) {
                repoDir = repoDir === rootDir ? null : path.dirname(repoDir);
              }
              if (repoDir === null) {
                return {
                  ...processOutput(""),
                  exitCode: ChildProcessSpawner.ExitCode(128),
                  stderr: "fatal: not a git repository",
                };
              }
              if (command === "rev-parse --is-inside-work-tree") return processOutput("true\n");
              if (command === "rev-parse --show-toplevel") return processOutput(`${repoDir}\n`);
              if (command === "rev-parse --git-common-dir") {
                return processOutput(`${path.relative(input.cwd, path.join(repoDir, ".git"))}\n`);
              }
              return processOutput("");
            }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
        }),
      ),
    );

  it.effect("detects again when a cached repository is removed from disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      yield* fs.makeDirectory(path.join(repoDir, ".git"));
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);

        yield* fs.remove(path.join(repoDir, ".git"), { recursive: true });

        assert.equal(yield* registry.detect({ cwd: repoDir }), null);
        assert.equal(calls.filter((call) => call === "rev-parse --is-inside-work-tree").length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("detects again when git init creates a repository inside a cached one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const projectDir = path.join(parentDir, "project");
      yield* fs.makeDirectory(path.join(parentDir, ".git"));
      yield* fs.makeDirectory(projectDir);
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: projectDir }))?.repository.rootPath, parentDir);

        yield* fs.makeDirectory(path.join(projectDir, ".git"));

        assert.equal(
          (yield* registry.detect({ cwd: projectDir }))?.repository.rootPath,
          projectDir,
        );
      }).pipe(Effect.provide(makeDiskBackedLayer(parentDir, calls)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("detects a repository created after a negative lookup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal(yield* registry.detect({ cwd: repoDir }), null);

        yield* fs.makeDirectory(path.join(repoDir, ".git"));

        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);
        assert.equal(calls.filter((call) => call === "rev-parse --is-inside-work-tree").length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a jj workspace as unsupported, never Git, when jj is not installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const main = path.join(parent, "main");
      const ws = path.join(parent, "ws1");
      yield* fs.makeDirectory(path.join(main, ".jj", "repo"), { recursive: true });
      yield* fs.makeDirectory(path.join(main, ".git"));
      yield* fs.makeDirectory(path.join(ws, ".jj"), { recursive: true });
      yield* fs.writeFileString(path.join(ws, ".jj", "repo"), "../../main/.jj/repo");
      yield* fs.writeFileString(path.join(ws, ".git"), "gitdir: ../main/.git/worktrees/ws1");

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const handle = yield* registry.resolve({ cwd: ws });

        assert.equal(handle.kind, "jj");
        assert.equal(handle.repository.rootPath, ws);
        assert.equal(handle.repository.metadataPath, path.join(main, ".jj", "repo"));
        assert.equal(handle.problem?.code, "unsupported");
      }).pipe(
        Effect.provide(
          Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
            Layer.provide(NodeServices.layer),
            Layer.provide(
              Layer.mock(VcsProjectConfig.VcsProjectConfig)({
                resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
              }),
            ),
            Layer.provide(
              Layer.mock(VcsProcess.VcsProcess)({
                run: (input) =>
                  Effect.fail(
                    new VcsProcessSpawnError({
                      operation: input.operation,
                      command: input.command,
                      cwd: input.cwd,
                      cause: PlatformError.systemError({
                        _tag: "NotFound",
                        module: "ChildProcess",
                        method: "spawn",
                      }),
                    }),
                  ),
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const layerRealRegistry = Layer.effect(
  VcsDriverRegistry.VcsDriverRegistry,
  VcsDriverRegistry.make,
).pipe(
  Layer.provide(
    Layer.mock(VcsProjectConfig.VcsProjectConfig)({
      resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
    }),
  ),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(JjFixture.layerIsolatedEnv),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-jj-" });
});

describe.skipIf(!JjFixture.jjAvailable)("VcsDriverRegistry with jj", () => {
  it.live(
    "detects a colocated repo and its secondary workspace as jj, from nested directories too",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const parent = yield* makeTempDir;
        const main = path.join(parent, "main");
        const ws = path.join(parent, "ws1");
        yield* fs.makeDirectory(path.join(main, "src"), { recursive: true });
        yield* JjFixture.createColocatedRepo(main);
        yield* JjFixture.addWorkspace(main, "ws1", ws);

        const root = yield* registry.resolve({ cwd: path.join(main, "src") });
        assert.equal(root.kind, "jj");
        assert.equal(root.repository.rootPath, main);
        assert.isUndefined(root.problem);

        const secondary = yield* registry.resolve({ cwd: ws });
        assert.equal(secondary.kind, "jj");
        assert.equal(secondary.repository.rootPath, ws);
        assert.isUndefined(secondary.problem);

        const asGit = yield* registry.resolve({ cwd: main, requestedKind: "git" });
        assert.equal(asGit.kind, "git");
      }).pipe(Effect.provide(layerRealRegistry)),
  );

  it.live("reports a non-colocated repo as unsupported jj, even inside a Git repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const outer = yield* makeTempDir;
      const inner = path.join(outer, "inner");
      yield* JjFixture.runGit(outer, ["init", "-q"]);
      yield* fs.makeDirectory(inner);
      yield* JjFixture.createNonColocatedRepo(inner);

      const handle = yield* registry.resolve({ cwd: inner });

      assert.equal(handle.kind, "jj");
      assert.equal(handle.repository.rootPath, inner);
      assert.equal(handle.problem?.code, "unsupported");
    }).pipe(Effect.provide(layerRealRegistry)),
  );

  it.live("detects an independent Git repository nested in a jj repo as Git", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const main = yield* makeTempDir;
      const nested = path.join(main, "vendor", "lib");
      yield* JjFixture.createColocatedRepo(main);
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* JjFixture.runGit(nested, ["init", "-q"]);

      const handle = yield* registry.resolve({ cwd: nested });

      assert.equal(handle.kind, "git");
      assert.equal(handle.repository.rootPath, nested);
    }).pipe(Effect.provide(layerRealRegistry)),
  );

  it.live("keeps a Git-only repo as Git, then detects jj once it is colocated", () =>
    Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const cwd = yield* makeTempDir;
      yield* JjFixture.runGit(cwd, ["init", "-q"]);

      const before = yield* registry.resolve({ cwd });
      assert.equal(before.kind, "git");

      yield* JjFixture.createColocatedRepo(cwd);

      const after = yield* registry.resolve({ cwd });
      assert.equal(after.kind, "jj");
      assert.isUndefined(after.problem);
    }).pipe(Effect.provide(layerRealRegistry)),
  );
});
