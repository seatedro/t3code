import type { VcsDriverKind, VcsStatusResult, VcsWorkspaceProblem } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

export interface VcsTerminology {
  /** An isolated checkout: a git worktree or a jj workspace. */
  readonly workspace: string;
  readonly workspaces: string;
  /** A named ref: a git branch or a jj bookmark. */
  readonly ref: string;
  readonly refs: string;
}

const GIT_TERMINOLOGY: VcsTerminology = Object.freeze({
  workspace: "Worktree",
  workspaces: "Worktrees",
  ref: "Branch",
  refs: "Branches",
});

const JJ_TERMINOLOGY: VcsTerminology = Object.freeze({
  workspace: "Workspace",
  workspaces: "Workspaces",
  ref: "Bookmark",
  refs: "Bookmarks",
});

/** Returns a shared constant per kind, so consumers can compare by identity. */
export function vcsTerminologyFor(kind: VcsDriverKind | null | undefined): VcsTerminology {
  return kind === "jj" ? JJ_TERMINOLOGY : GIT_TERMINOLOGY;
}

type VcsStatusQueryResult = AsyncResult.AsyncResult<VcsStatusResult | null, unknown>;

function selectStatusVcs(result: VcsStatusQueryResult) {
  return Option.getOrNull(AsyncResult.value(result))?.vcs;
}

// Selectors return primitives so a subscriber re-renders only when that field
// changes, not on every status event.
export function selectVcsKind(result: VcsStatusQueryResult): VcsDriverKind | null {
  return selectStatusVcs(result)?.kind ?? null;
}

export function selectVcsProblemCode(
  result: VcsStatusQueryResult,
): VcsWorkspaceProblem["code"] | null {
  return selectStatusVcs(result)?.problem?.code ?? null;
}

export function selectVcsProblemMessage(result: VcsStatusQueryResult): string | null {
  return selectStatusVcs(result)?.problem?.message ?? null;
}

/**
 * Commit, push, pull, and change requests run against the repository, so an
 * unsupported or broken one blocks them. A stale workspace is repairable and
 * leaves the colocated git checkout usable.
 */
export function vcsProblemBlockingReason(
  status: Pick<VcsStatusResult, "vcs"> | null | undefined,
): string | null {
  const problem = status?.vcs?.problem;
  return problem && problem.code !== "stale" ? problem.message : null;
}

export function vcsProblemLabel(
  problem: Pick<VcsWorkspaceProblem, "code">,
  terminology: VcsTerminology,
): string {
  switch (problem.code) {
    case "stale":
      return `Stale ${terminology.workspace.toLowerCase()}`;
    case "unsupported":
      return "Unsupported repository";
    case "error":
      return "Repository error";
  }
}

export function vcsProblemDescription(problem: VcsWorkspaceProblem): string {
  return problem.code === "stale" ? `${problem.message} Repair available.` : problem.message;
}
