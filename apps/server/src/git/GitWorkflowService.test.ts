import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { VcsStatusLocalResult } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as JjFixture from "../vcs/testing/JjFixture.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as JjCli from "../vcs/jj/JjCli.ts";
import * as JjWorkspaces from "../vcs/jj/JjWorkspaces.ts";

it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(
            Layer.mock(JjWorkspaces.JjWorkspaces)({ repoRoot: () => Effect.succeed(null) }),
          ),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

const gitLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: "t3/feature",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const layerWorkflow = (registry: Layer.Layer<VcsDriverRegistry.VcsDriverRegistry>) =>
  GitWorkflowService.layer.pipe(
    Layer.provide(registry),
    Layer.provide(
      Layer.mock(GitManager.GitManager)({
        localStatus: () => Effect.succeed(gitLocalStatus),
      }),
    ),
    Layer.provide(JjWorkspaces.layer.pipe(Layer.provide(registry), Layer.provide(JjCli.layer))),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-workflow-vcs-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(JjFixture.layerIsolatedEnv),
    Layer.provideMerge(NodeServices.layer),
  );

const layerHandle = (handle: Omit<VcsDriverRegistry.VcsDriverHandle, "driver">) =>
  Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    detect: () => Effect.succeed(handle as VcsDriverRegistry.VcsDriverHandle),
    resolve: () => Effect.succeed(handle as VcsDriverRegistry.VcsDriverHandle),
  });

const repository = (kind: "git" | "jj", rootPath: string) =>
  ({
    kind,
    rootPath,
    metadataPath: null,
    freshness: { source: "live-local" },
  }) as unknown as VcsDriverRegistry.VcsDriverHandle["repository"];

describe("GitWorkflowService vcs status", () => {
  it.effect("tags Git status with its kind", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/repo" });
      assert.deepStrictEqual(status, { ...gitLocalStatus, vcs: { kind: "git" } });
    }).pipe(
      Effect.provide(
        layerWorkflow(layerHandle({ kind: "git", repository: repository("git", "/repo") })),
      ),
    ),
  );

  it.effect("reports an unsupported jj repo as a problem, not a clean or missing repo", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const problem = { code: "unsupported" as const, message: "not colocated" };

      const local = yield* workflow.localStatus({ cwd: "/repo" });
      assert.isTrue(local.isRepo);
      assert.deepStrictEqual(local.vcs, { kind: "jj", problem });
      assert.deepStrictEqual((yield* workflow.status({ cwd: "/repo" })).vcs, {
        kind: "jj",
        problem,
      });
      assert.isNull(yield* workflow.remoteStatus({ cwd: "/repo" }));
      assert.isFalse(yield* workflow.isRepository("/repo"));

      const error = yield* workflow.hasCommit({ cwd: "/repo", refName: "HEAD" }).pipe(Effect.flip);
      assert.include(error.message, "not colocated");
    }).pipe(
      Effect.provide(
        layerWorkflow(
          layerHandle({
            kind: "jj",
            repository: repository("jj", "/repo"),
            problem: { code: "unsupported", message: "not colocated" },
          }),
        ),
      ),
    ),
  );
});

const layerRealRegistry = VcsDriverRegistry.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProjectConfig.VcsProjectConfig)({
      resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
    }),
  ),
  Layer.provide(VcsProcess.layer),
  Layer.provide(NodeServices.layer),
);

describe.skipIf(!JjFixture.jjAvailable)("GitWorkflowService in a colocated jj repo", () => {
  it.live("names the jj workspace and keeps Git workflows working", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-jj-" });
      const main = path.join(parent, "main");
      const ws = path.join(parent, "ws1");
      yield* fileSystem.makeDirectory(main);
      yield* JjFixture.createColocatedRepo(main);
      yield* JjFixture.writeFile(main, "README.md", "hello\n");
      yield* JjFixture.runJj(main, ["commit", "-m", "init"]);
      yield* JjFixture.addWorkspace(main, "ws1", ws);

      assert.deepStrictEqual((yield* workflow.localStatus({ cwd: ws })).vcs, {
        kind: "jj",
        workspaceName: "ws1",
      });
      assert.deepStrictEqual((yield* workflow.localStatus({ cwd: main })).vcs, {
        kind: "jj",
        workspaceName: "default",
      });
      assert.isTrue(yield* workflow.isRepository(ws));
      assert.isTrue(yield* workflow.hasCommit({ cwd: ws, refName: "HEAD" }));
    }).pipe(Effect.provide(layerWorkflow(layerRealRegistry))),
  );

  it.live("never prunes Git worktrees, which would un-colocate absent jj workspaces", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-jj-" });
      const main = path.join(parent, "main");
      const ws = path.join(parent, "ws1");
      yield* fileSystem.makeDirectory(main);
      yield* JjFixture.createColocatedRepo(main);
      yield* JjFixture.addWorkspace(main, "ws1", ws);
      yield* fileSystem.remove(ws, { recursive: true });

      yield* workflow.pruneWorktrees({ cwd: main });

      assert.include(yield* JjFixture.runGit(main, ["worktree", "list", "--porcelain"]), ws);
    }).pipe(Effect.provide(layerWorkflow(layerRealRegistry))),
  );

  it.live("reports a failed jj workspace lookup as a problem instead of a clean status", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-jj-" });

      const status = yield* Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        return yield* workflow.localStatus({ cwd });
      }).pipe(
        Effect.provide(
          layerWorkflow(layerHandle({ kind: "jj", repository: repository("jj", cwd) })),
        ),
      );

      assert.equal(status.vcs?.kind, "jj");
      assert.equal(status.vcs?.problem?.code, "error");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
