import {
  SemanticDiffError,
  type OrchestrationExpandTurnDiffGapResult,
  type PullRequestDiffImageInput,
  type PullRequestExpandDiffGapInput,
  type PullRequestRef,
  type PullRequestSemanticDiffInput,
  type PullRequestSemanticDiffResult,
  type SemanticDiffImageResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "./PullRequestService.ts";

/** A PR's diff in Diffy's rows, read from the project's own clone rather than the host. */
export class PullRequestSemanticDiff extends Context.Service<
  PullRequestSemanticDiff,
  {
    readonly diff: (
      input: PullRequestSemanticDiffInput,
    ) => Effect.Effect<
      PullRequestSemanticDiffResult,
      SemanticDiffError | PullRequestService.PullRequestError
    >;
    readonly expandGap: (
      input: PullRequestExpandDiffGapInput,
    ) => Effect.Effect<
      OrchestrationExpandTurnDiffGapResult,
      SemanticDiffError | PullRequestService.PullRequestError
    >;
    readonly image: (
      input: PullRequestDiffImageInput,
    ) => Effect.Effect<
      SemanticDiffImageResult,
      SemanticDiffError | PullRequestService.PullRequestError
    >;
  }
>()("t3/pullRequest/PullRequestSemanticDiff") {}

const reference = (input: PullRequestRef): PullRequestRef => ({
  projectId: input.projectId,
  repository: input.repository,
  number: input.number,
  ...(input.host === undefined ? {} : { host: input.host }),
  ...(input.expectedAccountId === undefined ? {} : { expectedAccountId: input.expectedAccountId }),
  ...(input.allowStale === undefined ? {} : { allowStale: input.allowStale }),
});

/** @public */
export const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const diffy = yield* Diffy.Diffy;
  const projects = yield* ProjectService.ProjectService;

  const failure = (message: string) => (cause: unknown) =>
    new SemanticDiffError({ message, cause });

  // The PR's two commits and its files, from the PR's own project checkout or the one its read
  // was routed through. Null when no candidate base gives the host's own files and totals: a
  // stale clone must fall back to the host's patch, not differ from it.
  const openRange = Effect.fn("PullRequestSemanticDiff.openRange")(function* (
    input: PullRequestRef,
  ) {
    const detail = yield* pullRequests.detail(reference(input));
    if (detail.headSha === undefined) return null;
    const own = yield* projects
      .getShell(input.projectId)
      .pipe(Effect.mapError(failure("Could not read the project.")));
    const roots = new Set(
      [Option.getOrUndefined(own)?.workspaceRoot, detail.workspaceRoot].filter(
        (root): root is string => root !== undefined,
      ),
    );
    for (const cwd of roots) {
      const handle = yield* vcsRegistry
        .detect({ cwd, requestedKind: "git" })
        .pipe(Effect.orElseSucceed(() => null));
      if (handle === null) continue;
      const candidates = yield* git
        .listPullRequestBases({ cwd, headSha: detail.headSha, baseBranch: detail.baseBranch })
        .pipe(Effect.orElseSucceed(() => null));
      if (candidates === null) continue;
      for (const mergeBase of candidates.bases) {
        const changed = yield* git
          .listCommitRangeFiles(cwd, mergeBase, candidates.headSha)
          .pipe(Effect.mapError(failure("Could not list the PR's files.")));
        const additions = changed.reduce((sum, file) => sum + file.additions, 0);
        const deletions = changed.reduce((sum, file) => sum + file.deletions, 0);
        if (
          changed.length === detail.changedFiles &&
          additions === detail.additions &&
          deletions === detail.deletions
        ) {
          return {
            cwd,
            mergeBase,
            headSha: candidates.headSha,
            changed,
            readObjects: handle.driver.checkpoints.readObjects,
          };
        }
      }
    }
    return null;
  });

  const diff: PullRequestSemanticDiff["Service"]["diff"] = Effect.fn(
    "PullRequestSemanticDiff.diff",
  )(function* (input) {
    if (!(yield* diffy.available)) return { files: null, omitted: [] };
    const range = yield* openRange(input);
    if (range === null) return { files: null, omitted: [] };
    const files = filterPaths(
      range.changed.map((file) => ({
        path: file.path,
        previousPath: file.previousPath ?? undefined,
        additions: file.additions,
        deletions: file.deletions,
      })),
      input.paths,
    );
    const reads = yield* range
      .readObjects({
        cwd: range.cwd,
        revisions: files.flatMap((file) => [
          `${range.mergeBase}:${file.previousPath ?? file.path}`,
          `${range.headSha}:${file.path}`,
        ]),
        maxObjectBytes: SEMANTIC_DIFF_MAX_FILE_BYTES,
        maxTotalBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      })
      .pipe(Effect.mapError(failure("Could not read the PR's files.")));
    const { inputs, counted, omitted } = planSemanticDiff(
      files,
      files.map((_, index) => [reads[index * 2]!, reads[index * 2 + 1]!] as const),
    );
    const diffed = yield* diffy
      .diff(inputs, { syntax: input.syntax ?? false })
      .pipe(Effect.mapError(failure("Could not diff the PR.")));
    return {
      files: Option.getOrNull(Option.map(diffed, (result) => withGitCounts(result, counted))),
      omitted,
    };
  });

  const expandGap: PullRequestSemanticDiff["Service"]["expandGap"] = Effect.fn(
    "PullRequestSemanticDiff.expandGap",
  )(function* (input) {
    const range = yield* openRange(input);
    if (range === null) return { rows: [] };
    const sides = [
      input.old_path === undefined ? undefined : `${range.mergeBase}:${input.old_path}`,
      input.new_path === undefined ? undefined : `${range.headSha}:${input.new_path}`,
    ];
    const reads = yield* range
      .readObjects({
        cwd: range.cwd,
        revisions: sides.filter((revision) => revision !== undefined),
        maxObjectBytes: SEMANTIC_DIFF_MAX_FILE_BYTES,
        maxTotalBytes: 2 * SEMANTIC_DIFF_MAX_FILE_BYTES,
      })
      .pipe(Effect.mapError(failure("Could not read the file.")));
    const [before, after] = sides[0] === undefined ? [undefined, reads[0]] : [reads[0], reads[1]];
    const rows = yield* diffy
      .expand(gapFileInput(input, before, after), input.gap, { syntax: input.syntax ?? false })
      .pipe(Effect.mapError(failure("Could not show the unchanged lines.")));
    return { rows: Option.getOrElse(rows, () => []) };
  });

  const image: PullRequestSemanticDiff["Service"]["image"] = Effect.fn(
    "PullRequestSemanticDiff.image",
  )(function* (input) {
    if (imageMimeType(input.path) === null) return { image: null };
    const range = yield* openRange(input);
    if (range === null) return { image: null };
    const [read] = yield* range
      .readObjects({
        cwd: range.cwd,
        revisions: [`${input.side === "old" ? range.mergeBase : range.headSha}:${input.path}`],
        maxObjectBytes: SEMANTIC_DIFF_MAX_IMAGE_BYTES,
        maxTotalBytes: SEMANTIC_DIFF_MAX_IMAGE_BYTES,
      })
      .pipe(Effect.mapError(failure("Could not read the image.")));
    return imageResult(input.path, read);
  });

  return PullRequestSemanticDiff.of({ diff, expandGap, image });
});

export const layer = Layer.effect(PullRequestSemanticDiff, make);
