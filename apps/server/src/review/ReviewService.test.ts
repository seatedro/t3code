import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as Diffy from "../diffy/Diffy.ts";
import * as ReviewService from "./ReviewService.ts";

function layer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreesDirectory?: string;
  readonly previousWorktreesDirectories?: ReadonlyArray<string>;
  readonly projectRoots?: ReadonlyArray<string> | "unavailable";
  readonly threadWorktrees?: ReadonlyArray<{ worktreePath: string; deleted?: boolean }>;
  readonly gitWorktrees?: ReadonlyArray<string>;
}) {
  const projectRoots = input.projectRoots ?? [];
  return ReviewService.layer.pipe(
    Layer.provide(Diffy.layer),
    Layer.provide(KnownWorkspaces.layer),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [index, thread] of (input.threadWorktrees ?? []).entries()) {
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
                created_at, updated_at, deleted_at, payload_json
              ) VALUES (
                ${`thread-${index}`}, 'project-0', 'Thread', 'codex', 'full-access', 'default',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                ${thread.deleted ? "2026-01-02T00:00:00.000Z" : null},
                ${JSON.stringify({ worktreePath: thread.worktreePath })}
              )
            `;
          }
        }),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          projectRoots === "unavailable"
            ? Effect.fail(
                new ProjectStore.ProjectStoreV2Error({ operation: "list", cause: "offline" }),
              )
            : Effect.succeed(
                projectRoots.map((workspaceRoot, index) => ({
                  id: ProjectId.make(`project-${index}`),
                  title: `Project ${index}`,
                  workspaceRoot,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                })),
              ),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        listWorktreePaths: () => Effect.succeed([...(input.gitWorktrees ?? [])]),
      }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        worktreesDirectory: input.worktreesDirectory ?? "",
        previousWorktreesDirectories: [...(input.previousWorktreesDirectories ?? [])],
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService", () => {
  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows previous custom worktree locations but never a filesystem root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const previous = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-old-worktrees-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: previous });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: "/",
            previousWorktreesDirectories: [previous],
          }),
        ),
      );
      assert.strictEqual(result.cwd, previous);

      const rootLink = `${baseDir}/root-link`;
      yield* fs.symlink("/", rootLink);
      for (const worktreesDirectory of ["/", rootLink]) {
        const error = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, worktreesDirectory })));
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows registered project roots outside the server cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const projectChild = `${projectRoot}/packages/app`;
      yield* fs.makeDirectory(projectChild, { recursive: true });
      const sibling = `${projectRoot}-sibling`;
      yield* fs.makeDirectory(sibling);
      yield* Effect.addFinalizer(() => fs.remove(sibling, { recursive: true }).pipe(Effect.ignore));

      const review = (cwd: string, projectRoots: ReadonlyArray<string> | "unavailable") =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, projectRoots })));

      assert.strictEqual((yield* review(projectRoot, [projectRoot])).cwd, projectRoot);
      assert.strictEqual((yield* review(projectChild, [projectRoot])).cwd, projectChild);
      const dottedChild = `${projectRoot}/..feature`;
      yield* fs.makeDirectory(dottedChild);
      assert.strictEqual((yield* review(dottedChild, [projectRoot])).cwd, dottedChild);
      for (const [cwd, projectRoots] of [
        [sibling, [projectRoot]],
        [projectRoot, []],
        [projectRoot, "unavailable"],
      ] as const) {
        const error = yield* review(cwd, projectRoots).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows the worktree a thread is bound to, and nothing else outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const bound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-bound-" });
      const deleted = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-deleted-" });
      const unbound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-unbound-" });
      const claimed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-claimed-" });
      yield* fs.makeDirectory(`${bound}/sub`);

      const review = (cwd: string) =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(
          Effect.provide(
            layer({
              workspaceRoot,
              baseDir,
              projectRoots: [project],
              gitWorktrees: [project, bound, deleted],
              threadWorktrees: [
                { worktreePath: bound },
                { worktreePath: claimed },
                { worktreePath: deleted, deleted: true },
                { worktreePath: "t3-review-relative" },
                { worktreePath: "/" },
              ],
            }),
          ),
        );

      for (const cwd of [bound, `${bound}/sub`]) {
        assert.strictEqual((yield* review(cwd)).cwd, cwd);
      }
      for (const cwd of [deleted, unbound, claimed, `${process.cwd()}/t3-review-relative`]) {
        const error = yield* review(cwd).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a thread's worktree linked from a managed folder to a checkout elsewhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const managed = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-worktrees-" }),
      );
      const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-checkout-" });
      yield* fs.symlink(checkout, `${managed}/feature`);

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: checkout });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: managed,
            threadWorktrees: [{ worktreePath: `${managed}/feature` }],
          }),
        ),
      );
      assert.strictEqual(result.cwd, checkout);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const layerRealGit = (workspaceRoot: string, baseDir: string) =>
  ReviewService.layer.pipe(
    Layer.provide(Diffy.layer),
    Layer.provide(
      Layer.mock(KnownWorkspaces.KnownWorkspaces)({ contains: () => Effect.succeed(false) }),
    ),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsDriverRegistry.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

it.effect("diffs a branch semantically against its base, untracked files included", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-semantic-" }),
    );
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
    const cwd = `${workspaceRoot}/repo`;
    yield* fs.makeDirectory(cwd);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]);

    yield* Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const git = (args: ReadonlyArray<string>) =>
        process.run({ operation: "ReviewService.test.git", command: "git", cwd, args });
      const write = (file: string, contents: string) =>
        fs.writeFileString(`${cwd}/${file}`, contents);
      const lines = Array.from({ length: 30 }, (_, line) => `const v${line} = ${line};\n`).join("");
      yield* git(["init", "-b", "main"]);
      yield* git(["config", "user.email", "test@test.com"]);
      yield* git(["config", "user.name", "Test"]);
      yield* write("a.ts", lines);
      yield* write("old.txt", "kept\n".repeat(20));
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "base"]);
      yield* git(["checkout", "-b", "feature"]);
      yield* git(["mv", "old.txt", "new.txt"]);
      yield* git(["commit", "-m", "rename"]);
      // Uncommitted edits and untracked files belong to the branch, as review compares it.
      yield* write("a.ts", lines.replace("const v20 = 20;", "const v20 = 21;"));
      yield* write("u.ts", "export const fresh = true;\n");
      yield* fs.writeFile(`${cwd}/shot.png`, png);
      yield* fs.writeFileString(`${outside}/secret.txt`, "outside\n");
      yield* fs.symlink(`${outside}/secret.txt`, `${cwd}/escape.txt`);

      const review = yield* ReviewService.ReviewService;
      const result = yield* review.getSemanticDiff({ cwd, baseRef: "main" });
      assert.strictEqual(result.baseRef, "main");
      const byPath = new Map(
        (result.files ?? []).map((file) => [file.new_path ?? file.old_path, file]),
      );
      assert.deepStrictEqual([...byPath.keys()].toSorted(), [
        "a.ts",
        "new.txt",
        "shot.png",
        "u.ts",
      ]);
      const edited = byPath.get("a.ts")!;
      assert.strictEqual(edited.status, "modified");
      assert.deepStrictEqual([edited.additions, edited.deletions], [1, 1]);
      assert.strictEqual(byPath.get("new.txt")?.status, "renamed");
      assert.strictEqual(byPath.get("new.txt")?.old_path, "old.txt");
      assert.strictEqual(byPath.get("u.ts")?.status, "added");
      // A symlink pointing out of the checkout is never read.
      assert.deepStrictEqual(
        result.omitted.map((file) => [file.new_path, file.reason]),
        [["escape.txt", "unreadable"]],
      );

      const gap = edited.hunks?.[0]?.gap_before;
      assert.isDefined(gap);
      const expanded = yield* review.expandDiffGap({
        cwd,
        baseRef: "main",
        status: "modified",
        old_path: "a.ts",
        new_path: "a.ts",
        gap: gap!,
      });
      assert.strictEqual(expanded.rows.length, gap!.len);

      const image = yield* review.getDiffImage({
        cwd,
        baseRef: "main",
        side: "new",
        path: "shot.png",
      });
      assert.deepStrictEqual(image.image, {
        mime: "image/png",
        base64: Buffer.from(png).toString("base64"),
        bytes: png.byteLength,
      });
      const text = yield* review.getDiffImage({ cwd, baseRef: "main", side: "new", path: "u.ts" });
      assert.isNull(text.image);
    }).pipe(Effect.provide(layerRealGit(workspaceRoot, baseDir)));
  }).pipe(Effect.provide(NodeServices.layer)),
);
