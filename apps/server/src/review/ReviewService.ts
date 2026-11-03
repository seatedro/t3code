import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  SemanticDiffError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewBranchCommitsInput,
  type ReviewBranchCommitsResult,
  type ReviewDiffImageInput,
  type ReviewExpandDiffGapInput,
  type ReviewSemanticDiffInput,
  type ReviewSemanticDiffResult,
  type OrchestrationExpandTurnDiffGapResult,
  type SemanticDiffImageResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as Diffy from "../diffy/Diffy.ts";
import {
  filterPaths,
  gapFileInput,
  imageMimeType,
  imageResult,
  planSemanticDiff,
  SEMANTIC_DIFF_MAX_FILE_BYTES,
  SEMANTIC_DIFF_MAX_IMAGE_BYTES,
  withGitCounts,
} from "../diffy/semanticDiffFiles.ts";
import type { GitObjectRead } from "../vcs/GitObjectBatch.ts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";

const WORKSPACE_BOUND_SUBJECTS = {
  "ReviewService.getBranchCommits": "commit list",
  "ReviewService.getDiffPreview": "diff preview",
  "ReviewService.getDiffFileContents": "diff file contents",
} as const;

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getBranchCommits: (
      input: ReviewBranchCommitsInput,
    ) => Effect.Effect<ReviewBranchCommitsResult, ReviewDiffPreviewError>;
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
    /** The checkout's branch against its base, in Diffy's rows. */
    readonly getSemanticDiff: (
      input: ReviewSemanticDiffInput,
    ) => Effect.Effect<ReviewSemanticDiffResult, SemanticDiffError>;
    readonly expandDiffGap: (
      input: ReviewExpandDiffGapInput,
    ) => Effect.Effect<OrchestrationExpandTurnDiffGapResult, SemanticDiffError>;
    readonly getDiffImage: (
      input: ReviewDiffImageInput,
    ) => Effect.Effect<SemanticDiffImageResult, SemanticDiffError>;
  }
>()("t3/review/ReviewService") {}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const diffy = yield* Diffy.Diffy;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation: keyof typeof WORKSPACE_BOUND_SUBJECTS,
    cwd: string,
  ) {
    const [candidate, workspaceRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
    ]);
    if (
      KnownWorkspaces.isWithinRoot(path, candidate, workspaceRoot) ||
      (yield* knownWorkspaces.contains(candidate))
    ) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail: `Review ${WORKSPACE_BOUND_SUBJECTS[operation]} cwd must stay within the configured workspace root.`,
    });
  });

  const getBranchCommits: ReviewService["Service"]["getBranchCommits"] = Effect.fn(
    "ReviewService.getBranchCommits",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getBranchCommits", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) return { commits: [], truncated: false };
    if (handle.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getBranchCommits",
        kind: handle.kind,
        detail: "Review commit lists require a Git repository.",
      });
    }
    return yield* git.getReviewBranchCommits(input);
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    return yield* git.getReviewDiffPreview(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  // Reads working-tree files as the new side, as `git diff` against the working tree sees them.
  // Paths come from git; a file that resolves outside the checkout is unreadable, not followed.
  const readWorkingTree = Effect.fn("ReviewService.readWorkingTree")(function* (
    root: string,
    paths: ReadonlyArray<string>,
    limits: { readonly maxObjectBytes: number; readonly maxTotalBytes: number },
  ) {
    const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
    let total = 0;
    const reads: GitObjectRead[] = [];
    for (const relative of paths) {
      reads.push(
        yield* Effect.gen(function* () {
          const target = yield* fileSystem.realPath(path.resolve(root, relative));
          if (!KnownWorkspaces.isWithinRoot(path, target, realRoot)) {
            return { _tag: "unreadable" } as const;
          }
          const info = yield* fileSystem.stat(target);
          if (info.type !== "File") return { _tag: "unreadable" } as const;
          const size = Number(info.size);
          if (size > limits.maxObjectBytes) return { _tag: "too_large", size } as const;
          if (total + size > limits.maxTotalBytes) return { _tag: "over_budget", size } as const;
          total += size;
          return { _tag: "read", bytes: yield* fileSystem.readFile(target) } as const;
        }).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              Effect.succeed(
                error.reason._tag === "NotFound"
                  ? ({ _tag: "missing" } as const)
                  : ({ _tag: "unreadable" } as const),
              ),
          }),
        ),
      );
    }
    return reads;
  });

  const semanticFailure = (message: string) => (cause: unknown) =>
    new SemanticDiffError({ message, cause });

  // The branch's files and a reader for its old side, or null outside a git checkout.
  const openBranch = Effect.fn("ReviewService.openBranch")(function* (input: {
    readonly cwd: string;
    readonly baseRef?: string | undefined;
  }) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);
    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") return null;
    const branch = yield* git.listBranchReviewFiles(input);
    if (branch === null) return null;
    return { ...branch, readObjects: handle.driver.checkpoints.readObjects };
  });

  const getSemanticDiff: ReviewService["Service"]["getSemanticDiff"] = Effect.fn(
    "ReviewService.getSemanticDiff",
  )(
    function* (input) {
      const branch = yield* openBranch(input);
      if (branch === null) return { cwd: input.cwd, baseRef: null, files: [], omitted: [] };
      if (!(yield* diffy.available)) {
        return { cwd: input.cwd, baseRef: branch.baseRef, files: null, omitted: [] };
      }
      const files = filterPaths(
        branch.files.map((file) => ({
          path: file.path,
          previousPath: file.previousPath ?? undefined,
          additions: file.additions,
          deletions: file.deletions,
        })),
        input.paths,
      );
      // Old and new sides share one budget, as a turn's do.
      const before = yield* branch.readObjects({
        cwd: branch.root,
        revisions: files.map((file) => `${branch.oldRevision}:${file.previousPath ?? file.path}`),
        maxObjectBytes: SEMANTIC_DIFF_MAX_FILE_BYTES,
        maxTotalBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES / 2,
      });
      const after = yield* readWorkingTree(
        branch.root,
        files.map((file) => file.path),
        {
          maxObjectBytes: SEMANTIC_DIFF_MAX_FILE_BYTES,
          maxTotalBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES / 2,
        },
      );
      const { inputs, counted, omitted } = planSemanticDiff(
        files,
        files.map((_, index) => [before[index]!, after[index]!] as const),
      );
      const diffed = yield* diffy.diff(inputs, { syntax: input.syntax ?? false });
      return {
        cwd: input.cwd,
        baseRef: branch.baseRef,
        files: Option.getOrNull(Option.map(diffed, (result) => withGitCounts(result, counted))),
        omitted,
      };
    },
    Effect.mapError(semanticFailure("Could not diff the branch.")),
  );

  const expandDiffGap: ReviewService["Service"]["expandDiffGap"] = Effect.fn(
    "ReviewService.expandDiffGap",
  )(
    function* (input) {
      const branch = yield* openBranch(input);
      if (branch === null) return { rows: [] };
      const limits = {
        maxObjectBytes: SEMANTIC_DIFF_MAX_FILE_BYTES,
        maxTotalBytes: SEMANTIC_DIFF_MAX_FILE_BYTES,
      };
      const before =
        input.old_path === undefined
          ? undefined
          : (yield* branch.readObjects({
              cwd: branch.root,
              revisions: [`${branch.oldRevision}:${input.old_path}`],
              ...limits,
            }))[0];
      const after =
        input.new_path === undefined
          ? undefined
          : (yield* readWorkingTree(branch.root, [input.new_path], limits))[0];
      const rows = yield* diffy.expand(gapFileInput(input, before, after), input.gap, {
        syntax: input.syntax ?? false,
      });
      return { rows: Option.getOrElse(rows, () => []) };
    },
    Effect.mapError(semanticFailure("Could not show the unchanged lines.")),
  );

  const getDiffImage: ReviewService["Service"]["getDiffImage"] = Effect.fn(
    "ReviewService.getDiffImage",
  )(
    function* (input) {
      if (imageMimeType(input.path) === null) return { image: null };
      const branch = yield* openBranch(input);
      if (branch === null) return { image: null };
      const limits = {
        maxObjectBytes: SEMANTIC_DIFF_MAX_IMAGE_BYTES,
        maxTotalBytes: SEMANTIC_DIFF_MAX_IMAGE_BYTES,
      };
      const [read] =
        input.side === "old"
          ? yield* branch.readObjects({
              cwd: branch.root,
              revisions: [`${branch.oldRevision}:${input.path}`],
              ...limits,
            })
          : yield* readWorkingTree(branch.root, [input.path], limits);
      return imageResult(input.path, read);
    },
    Effect.mapError(semanticFailure("Could not read the image.")),
  );

  return ReviewService.of({
    getBranchCommits,
    getDiffPreview,
    getDiffFileContents,
    getSemanticDiff,
    expandDiffGap,
    getDiffImage,
  });
});

export const layer = Layer.effect(ReviewService, make);
