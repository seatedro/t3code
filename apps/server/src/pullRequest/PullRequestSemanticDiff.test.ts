import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type PullRequestDetail } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as Diffy from "../diffy/Diffy.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as PullRequestSemanticDiff from "./PullRequestSemanticDiff.ts";
import * as PullRequestService from "./PullRequestService.ts";

const reference = { projectId: ProjectId.make("project"), repository: "o/r", number: 7 };

it.effect("diffs a PR from the clone only when its files match the host's", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-diff-" }));
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-diff-base-" });
    let detail: Partial<PullRequestDetail> = {};

    const layer = PullRequestSemanticDiff.layer.pipe(
      Layer.provide(
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () => Effect.succeed({ workspaceRoot: cwd, ...detail } as PullRequestDetail),
        }),
      ),
      Layer.provide(Diffy.layer),
      Layer.provideMerge(GitVcsDriver.layer),
      Layer.provideMerge(VcsDriverRegistry.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfig.layerTest(cwd, baseDir)),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );

    yield* Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const git = (args: ReadonlyArray<string>) =>
        process
          .run({ operation: "PullRequestSemanticDiff.test.git", command: "git", cwd, args })
          .pipe(Effect.map((result) => result.stdout.trim()));
      const lines = Array.from({ length: 30 }, (_, line) => `let v${line} = ${line};\n`).join("");
      yield* git(["init", "-b", "main"]);
      yield* git(["config", "user.email", "test@test.com"]);
      yield* git(["config", "user.name", "Test"]);
      yield* fs.writeFileString(`${cwd}/a.js`, lines);
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "base"]);
      yield* git(["checkout", "-b", "feature"]);
      yield* fs.writeFileString(`${cwd}/a.js`, lines.replace("let v4 = 4;", "let v4 = 40;"));
      yield* fs.writeFileString(`${cwd}/b.js`, "export {};\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "feature"]);
      const headSha = yield* git(["rev-parse", "HEAD"]);
      // main moves on after the PR branched; the PR's diff still starts at their merge base.
      yield* git(["checkout", "main"]);
      yield* fs.writeFileString(`${cwd}/c.js`, "later\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "later"]);

      const prs = yield* PullRequestSemanticDiff.PullRequestSemanticDiff;
      detail = { headSha, baseBranch: "main", changedFiles: 2, additions: 2, deletions: 1 };
      const result = yield* prs.diff(reference);
      assert.deepStrictEqual(
        (result.files ?? []).map((file) => [file.new_path, file.status, file.additions]),
        [
          ["a.js", "modified", 1],
          ["b.js", "added", 1],
        ],
      );
      const image = yield* prs.image({ ...reference, side: "new", path: "b.js" });
      assert.isNull(image.image);

      // The host counts other files, say for a base branch this clone hasn't fetched.
      detail = { ...detail, changedFiles: 3 };
      assert.isNull((yield* prs.diff(reference)).files);
      // The head commit isn't in this clone.
      detail = { ...detail, changedFiles: 2, headSha: "0".repeat(40) };
      assert.isNull((yield* prs.diff(reference)).files);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
