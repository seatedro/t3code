// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import * as VcsDriverRegistry from "../VcsDriverRegistry.ts";
import * as VcsProcess from "../VcsProcess.ts";
import * as JjCli from "./JjCli.ts";
import * as JjWorkspaces from "./JjWorkspaces.ts";

const fixtureEnv = {
  JJ_CONFIG: NodeOS.devNull,
  JJ_USER: "T3 Test",
  JJ_EMAIL: "t3@example.com",
  GIT_CONFIG_GLOBAL: NodeOS.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "T3 Test",
  GIT_AUTHOR_EMAIL: "t3@example.com",
  GIT_COMMITTER_NAME: "T3 Test",
  GIT_COMMITTER_EMAIL: "t3@example.com",
};

// The real JjCli, with its processes pointed at the fixture's isolated config.
const layerTestJjCli = JjCli.layer.pipe(
  Layer.provide(
    Layer.effect(
      VcsProcess.VcsProcess,
      Effect.map(VcsProcess.make, (vcsProcess) =>
        VcsProcess.VcsProcess.of({
          run: (input) => vcsProcess.run({ ...input, env: { ...fixtureEnv, ...input.env } }),
        }),
      ),
    ).pipe(Layer.provide(ProcessRunner.layer)),
  ),
);

const layerJjRegistry = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
  detect: ({ cwd }) =>
    Effect.succeed({
      kind: "jj",
      repository: { rootPath: cwd },
    } as VcsDriverRegistry.VcsDriverHandle),
  resolve: ({ cwd }) =>
    Effect.succeed({
      kind: "jj",
      repository: { rootPath: cwd },
    } as VcsDriverRegistry.VcsDriverHandle),
});

const layerWorkspaces = JjWorkspaces.layer.pipe(
  Layer.provideMerge(layerTestJjCli),
  Layer.provideMerge(layerJjRegistry),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-jj-workspaces-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const layerWorkflow = GitWorkflowService.layer.pipe(
  Layer.provide(Layer.mock(GitManager.GitManager)({})),
  Layer.provideMerge(layerWorkspaces),
);

const run = (command: "git" | "jj", cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    return (yield* process.run({
      operation: "JjWorkspaces.test",
      command,
      cwd,
      args: command === "jj" ? ["--color=never", "--no-pager", ...args] : args,
      env: fixtureEnv,
    })).stdout.trim();
  });

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-ws-" }));
  const root = `${base}/repo`;
  const workspaces = `${base}/workspaces`;
  yield* fs.makeDirectory(root);
  yield* run("git", root, ["init", "-q", "-b", "main"]);
  yield* fs.writeFileString(`${root}/a.txt`, "first\n");
  yield* run("git", root, ["add", "."]);
  yield* run("git", root, ["commit", "-qm", "first"]);
  const first = yield* run("git", root, ["rev-parse", "HEAD"]);
  yield* fs.writeFileString(`${root}/a.txt`, "second\n");
  yield* run("git", root, ["commit", "-qam", "second"]);
  yield* run("jj", root, ["git", "init", "--colocate"]);
  const service = yield* JjWorkspaces.JjWorkspaces;
  const create = (name: string, baseRef = "main") =>
    service.create({
      repoRoot: root,
      path: `${workspaces}/t3-${name}`,
      baseRef,
      branch: `t3/${name}`,
      createBranch: true,
    });
  return { fs, root, workspaces, first, service, create };
});

const isColocated = (cwd: string) =>
  run("jj", cwd, ["git", "colocation", "status"]).pipe(
    Effect.map((output) => output.includes("is currently colocated")),
  );

describe("parseWorkspaceList", () => {
  it("skips lines that are not workspace entries", () => {
    assert.deepEqual(
      JjWorkspaces.parseWorkspaceList(
        [
          '{"name":"default","root":"/repo"}',
          "Warning: something",
          '{"name":"t3-a"}',
          '{"name":"t3-b","root":"/w/t3-b"}',
          "",
        ].join("\n"),
      ),
      [
        { name: "default", root: "/repo" },
        { name: "t3-b", root: "/w/t3-b" },
      ],
    );
  });
});

// CI has no jj binary yet; these run wherever jj >= 0.46 is on PATH.
describe.skipIf(NodeChildProcess.spawnSync("jj", ["--version"]).status !== 0)(
  "JjWorkspaces with jj",
  () => {
    it.live("creates a workspace at the exact base while the root has uncommitted work", () =>
      Effect.gen(function* () {
        const { fs, root, workspaces, first, service, create } = yield* fixture;
        yield* fs.writeFileString(`${root}/wip.txt`, "root work\n");

        const created = yield* create("abcd", first);

        const path = `${workspaces}/t3-abcd`;
        assert.deepEqual(created, { path, branch: "t3/abcd" });
        expect(yield* fs.readFileString(`${path}/a.txt`)).toBe("first\n");
        expect(yield* fs.exists(`${path}/wip.txt`)).toBe(false);
        expect(yield* fs.readFileString(`${root}/wip.txt`)).toBe("root work\n");
        expect(yield* run("git", path, ["symbolic-ref", "HEAD"])).toBe("refs/heads/t3/abcd");
        expect(yield* run("git", path, ["rev-parse", "HEAD"])).toBe(first);
        expect(
          yield* run("jj", path, ["bookmark", "list", "-T", 'self.name() ++ "\\n"']),
        ).toContain("t3/abcd");
        expect(yield* service.list(root)).toContainEqual({ name: "t3-abcd", root: path });
        // KnownWorkspaces and t3_worktree_list read git's worktree list.
        const git = yield* GitVcsDriver.GitVcsDriver;
        expect(yield* git.listWorktreePaths(root)).toContain(path);
      }).pipe(Effect.provide(layerWorkspaces), Effect.scoped),
    );

    it.live("rejects repositories with submodules before creating anything", () =>
      Effect.gen(function* () {
        const { fs, root, workspaces, service, create } = yield* fixture;
        yield* fs.writeFileString(`${root}/.gitmodules`, "");
        yield* run("git", root, ["add", ".gitmodules"]);
        yield* run("git", root, ["commit", "-qm", "submodules"]);

        const exit = yield* Effect.exit(create("sub", "HEAD"));

        expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(
          "VcsUnsupportedOperationError",
        );
        expect(yield* fs.exists(`${workspaces}/t3-sub`)).toBe(false);
        expect((yield* service.list(root)).map((entry) => entry.name)).toEqual(["default"]);
      }).pipe(Effect.provide(layerWorkspaces), Effect.scoped),
    );

    it.live("reattaches the branch after a jj command detaches HEAD", () =>
      Effect.gen(function* () {
        const { fs, service, create } = yield* fixture;
        const { path } = yield* create("work");
        yield* fs.writeFileString(`${path}/x.txt`, "agent work\n");
        yield* run("jj", path, ["commit", "-m", "agent work"]);
        expect(
          yield* run("git", path, ["symbolic-ref", "-q", "HEAD"]).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" });

        yield* service.ensureBranchAttached({ cwd: path });

        expect(yield* run("git", path, ["symbolic-ref", "HEAD"])).toBe("refs/heads/t3/work");
        expect(yield* run("git", path, ["show", "--format=%s", "-s", "HEAD"])).toBe("agent work");
      }).pipe(Effect.provide(layerWorkspaces), Effect.scoped),
    );

    it.live("fails with bookmark moved when the branch left HEAD's history", () =>
      Effect.gen(function* () {
        const { fs, root, first, service, create } = yield* fixture;
        const { path } = yield* create("moved", first);
        yield* fs.writeFileString(`${path}/x.txt`, "agent work\n");
        yield* run("jj", path, ["commit", "-m", "agent work"]);
        yield* run("jj", root, ["bookmark", "set", "t3/moved", "-r", "main", "--allow-backwards"]);

        const exit = yield* Effect.exit(service.ensureBranchAttached({ cwd: path }));

        expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("bookmark-moved");
        expect(
          yield* run("git", path, ["symbolic-ref", "-q", "HEAD"]).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" });
      }).pipe(Effect.provide(layerWorkspaces), Effect.scoped),
    );

    it.live("refuses to forget while a sibling is prunable and keeps siblings colocated", () =>
      Effect.gen(function* () {
        const { fs, root, workspaces, service, create } = yield* fixture;
        const one = (yield* create("one")).path;
        const two = (yield* create("two")).path;
        const three = (yield* create("three")).path;
        yield* fs.rename(three, `${workspaces}/moved-away`);

        const refused = yield* Effect.exit(
          service.forget({ repoRoot: root, path: one, force: false }),
        );
        expect(Exit.isFailure(refused) && JSON.stringify(refused.cause)).toContain(three);
        expect(yield* fs.exists(one)).toBe(true);

        yield* fs.rename(`${workspaces}/moved-away`, three);
        yield* service.forget({ repoRoot: root, path: one, force: false });

        expect(yield* fs.exists(one)).toBe(false);
        expect((yield* service.list(root)).map((entry) => entry.name)).toEqual([
          "default",
          "t3-three",
          "t3-two",
        ]);
        expect(yield* isColocated(two)).toBe(true);
        expect(yield* isColocated(three)).toBe(true);
        expect(yield* run("git", root, ["worktree", "list", "--porcelain"])).not.toContain(one);
      }).pipe(Effect.provide(layerWorkspaces), Effect.scoped),
    );

    it.live("refuses to forget a dirty workspace unless forced", () =>
      Effect.gen(function* () {
        const { fs, root, service, create } = yield* fixture;
        const { path } = yield* create("dirty");
        yield* fs.writeFileString(`${path}/notes.txt`, "unsaved\n");

        const refused = yield* Effect.exit(service.forget({ repoRoot: root, path, force: false }));
        expect(Exit.isFailure(refused) && JSON.stringify(refused.cause)).toContain('"dirty"');

        yield* service.forget({ repoRoot: root, path, force: true });
        expect(yield* fs.exists(path)).toBe(false);
      }).pipe(Effect.provide(layerWorkspaces), Effect.scoped),
    );

    it.live("recreates a missing workspace through the git workflow without pruning", () =>
      Effect.gen(function* () {
        const { fs, root, workspaces, service, create } = yield* fixture;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const sibling = (yield* create("sibling")).path;
        const created = yield* workflow.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "t3/rec",
          baseRefName: "refs/heads/main",
          path: `${workspaces}/t3-rec`,
        });
        const path = created.worktree.path;
        yield* fs.writeFileString(`${path}/a.txt`, "agent work\n");
        yield* run("git", path, ["commit", "-qam", "agent work"]);
        yield* fs.remove(path, { recursive: true });

        yield* workflow.pruneWorktrees({ cwd: root });
        yield* workflow.createWorktree({ cwd: root, refName: "t3/rec", path });

        expect(yield* fs.readFileString(`${path}/a.txt`)).toBe("agent work\n");
        expect(yield* run("git", path, ["symbolic-ref", "HEAD"])).toBe("refs/heads/t3/rec");
        expect((yield* service.list(root)).map((entry) => entry.name)).toEqual([
          "default",
          "t3-rec",
          "t3-sibling",
        ]);
        expect(yield* run("git", root, ["worktree", "list", "--porcelain"])).not.toContain(
          "prunable",
        );
        expect(yield* isColocated(sibling)).toBe(true);
      }).pipe(Effect.provide(layerWorkflow), Effect.scoped),
    );

    it.live("renames the workspace branch with git and imports it into jj", () =>
      Effect.gen(function* () {
        const { fs, create } = yield* fixture;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const { path } = yield* create("tmp");
        yield* fs.writeFileString(`${path}/x.txt`, "agent work\n");
        yield* run("jj", path, ["commit", "-m", "agent work"]);

        const renamed = yield* workflow.renameBranch({
          cwd: path,
          oldBranch: "t3/tmp",
          newBranch: "feature/named",
          exactName: true,
        });

        expect(renamed.branch).toBe("feature/named");
        expect(yield* run("git", path, ["symbolic-ref", "HEAD"])).toBe("refs/heads/feature/named");
        const bookmarks = yield* run("jj", path, [
          "--ignore-working-copy",
          "bookmark",
          "list",
          "-T",
          'self.name() ++ "\\n"',
        ]);
        expect(bookmarks).toContain("feature/named");
        expect(bookmarks).not.toContain("t3/tmp");
      }).pipe(Effect.provide(layerWorkflow), Effect.scoped),
    );
  },
);
