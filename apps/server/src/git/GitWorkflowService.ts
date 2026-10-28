import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import {
  GitManagerError,
  GitCommandError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
  type VcsStatusVcs,
  type VcsWorkspaceProblem,
} from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as JjCli from "../vcs/jj/JjCli.ts";
import * as JjVcsDriver from "../vcs/jj/JjVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as JjWorkspaces from "../vcs/jj/JjWorkspaces.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
    readonly hasCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly hasRefNamed: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
      options?: { readonly snapshotWorkingCopy?: boolean },
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName?: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"];
    readonly fetchWorktreeBaseCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string } | null,
      GitCommandError
    >;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitVcsDriver.GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly renameBranch: (input: {
      readonly exactName?: boolean;
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("t3/git/GitWorkflowService") {}

function nonRepositoryLocalStatus(): VcsStatusLocalResult {
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

// The repository exists but Git cannot read it; clients show the problem instead of a clean tree.
function problemLocalStatus(vcs: VcsStatusVcs): VcsStatusLocalResult {
  return { ...nonRepositoryLocalStatus(), isRepo: true, vcs };
}

function nonRepositoryStatus(): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

const WORKSPACE_NAME_CACHE_TTL = Duration.seconds(30);

// A colocated jj workspace is a real Git worktree, so Git workflows run unchanged there.
const isGitBacked = (handle: VcsDriverRegistry.VcsDriverHandle) =>
  handle.kind === "git" || (handle.kind === "jj" && handle.problem === undefined);

const unsupportedDetail = (
  subject: "workflow" | "command",
  operation: string,
  handle: VcsDriverRegistry.VcsDriverHandle,
) =>
  handle.problem
    ? `The ${operation} ${subject} is unavailable in this ${handle.kind} repository: ${handle.problem.message}`
    : `The ${operation} ${subject} currently supports Git repositories only; detected ${handle.kind}.`;

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const jjCli = yield* JjCli.make;

  const workspaceNames = yield* Cache.makeWith(
    (rootPath: string) =>
      JjVcsDriver.readCurrentWorkspaceName(rootPath).pipe(
        Effect.provideService(JjCli.JjCli, jjCli),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
    {
      capacity: 256,
      timeToLive: Exit.match({
        onSuccess: () => WORKSPACE_NAME_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  // Observe-mode reads cannot detect a stale workspace, so the last foreground snapshot's verdict
  // sticks until a later snapshot succeeds.
  const staleWorkspaces = new Map<string, VcsWorkspaceProblem>();

  const snapshotJjWorkingCopy = Effect.fn("GitWorkflowService.snapshotJjWorkingCopy")(function* (
    rootPath: string,
  ) {
    const problem = yield* jjCli
      .run({
        operation: "GitWorkflowService.snapshotJjWorkingCopy",
        cwd: rootPath,
        args: ["util", "snapshot"],
        workingCopy: "snapshot",
      })
      .pipe(
        Effect.as(null),
        Effect.catch((error) => Effect.succeed(JjVcsDriver.problemFromError(error))),
      );
    if (problem?.code === "stale") staleWorkspaces.set(rootPath, problem);
    else staleWorkspaces.delete(rootPath);
    return problem;
  });

  const statusVcs = Effect.fn("GitWorkflowService.statusVcs")(function* (
    handle: VcsDriverRegistry.VcsDriverHandle,
    snapshotWorkingCopy: boolean,
  ) {
    if (handle.kind !== "jj") return { kind: handle.kind } satisfies VcsStatusVcs;
    if (handle.problem) return { kind: "jj", problem: handle.problem } satisfies VcsStatusVcs;
    const rootPath = handle.repository.rootPath;
    const snapshotProblem = snapshotWorkingCopy ? yield* snapshotJjWorkingCopy(rootPath) : null;
    const problem = snapshotProblem ?? staleWorkspaces.get(rootPath);
    return yield* Cache.get(workspaceNames, rootPath).pipe(
      Effect.map((name): VcsStatusVcs => ({
        kind: "jj",
        ...(name !== null && name.length > 0 && name === name.trim()
          ? { workspaceName: name }
          : {}),
        ...(problem ? { problem } : {}),
      })),
      Effect.catch((error) =>
        Effect.succeed<VcsStatusVcs>({
          kind: "jj",
          problem: JjVcsDriver.problemFromError(error),
        }),
      ),
    );
  });

  const jjWorkspaces = yield* JjWorkspaces.JjWorkspaces;

  const asGitCommandError = (operation: string, cwd: string) => (cause: { message: string }) =>
    new GitCommandError({ operation, command: "jj", cwd, detail: cause.message, cause });

  // jj repos import every T3 ref mutation with abandon-unreachable off, before a user's jj command does.
  const importJjRefs = (operation: string, cwd: string) =>
    jjWorkspaces
      .repoRoot(cwd)
      .pipe(
        Effect.flatMap((root) =>
          root === null
            ? Effect.void
            : jjWorkspaces
                .importGitRefs(cwd)
                .pipe(Effect.mapError(asGitCommandError(operation, cwd))),
        ),
      );

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(rootPath: string, effect: Effect.Effect<A, E, R>) =>
    fileSystem.realPath(rootPath).pipe(
      Effect.orElseSucceed(() => rootPath),
      Effect.flatMap((cwd) => withWorkspaceLease(cwd, effect)),
    );

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
    if (!isGitBacked(handle)) {
      return yield* new GitManagerError({
        operation,
        cwd,
        detail: `${unsupportedDetail("workflow", operation, handle)} (${cwd})`,
      });
    }
    return handle;
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    if (!isGitBacked(handle)) {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: unsupportedDetail("command", operation, handle),
      });
    }
    return handle;
  });

  const detectGitRepositoryForStatus = Effect.fn("GitWorkflowService.detectGitRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const handle = yield* registry.detect({ cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
      if (!handle) {
        return null;
      }
      if (handle.kind !== "git" && handle.kind !== "jj") {
        return yield* new GitManagerError({
          operation,
          cwd,
          detail: `${unsupportedDetail("workflow", operation, handle)} (${cwd})`,
        });
      }
      return handle;
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    if (!handle) {
      return false;
    }
    if (!isGitBacked(handle)) {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: unsupportedDetail("command", operation, handle),
      });
    }
    return true;
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  return GitWorkflowService.of({
    isRepository: Effect.fn("GitWorkflowService.isRepository")(function (cwd) {
      return registry.detect({ cwd }).pipe(
        Effect.map((handle) => handle !== null && isGitBacked(handle)),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.isRepository",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
    }),
    hasCommit: Effect.fn("GitWorkflowService.hasCommit")(function (input) {
      return ensureGitCommand("GitWorkflowService.hasCommit", input.cwd).pipe(
        Effect.andThen(
          git.execute({
            operation: "GitWorkflowService.hasCommit",
            cwd: input.cwd,
            args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
            allowNonZeroExit: true,
          }),
        ),
        Effect.map((result) => result.exitCode === 0),
      );
    }),
    hasRefNamed: Effect.fn("GitWorkflowService.hasRefNamed")(function (input) {
      // Pattern characters would widen the ref match.
      return /[*?[\\]/.test(input.refName)
        ? Effect.succeed(false)
        : ensureGitCommand("GitWorkflowService.hasRefNamed", input.cwd).pipe(
            Effect.andThen(
              git.execute({
                operation: "GitWorkflowService.hasRefNamed",
                cwd: input.cwd,
                args: [
                  "for-each-ref",
                  "--count=1",
                  "--format=%(refname)",
                  `refs/**/${input.refName}`,
                ],
              }),
            ),
            Effect.map((result) => result.stdout.trim().length > 0),
          );
    }),
    status: Effect.fn("GitWorkflowService.status")(function* (input) {
      const handle = yield* detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd);
      if (!handle) return nonRepositoryStatus();
      if (handle.problem) {
        return {
          ...nonRepositoryStatus(),
          ...problemLocalStatus({ kind: handle.kind, problem: handle.problem }),
        };
      }
      const [status, vcs] = yield* Effect.all(
        [gitManager.status(input), statusVcs(handle, false)],
        {
          concurrency: "unbounded",
        },
      );
      return { ...status, vcs };
    }),
    localStatus: Effect.fn("GitWorkflowService.localStatus")(function* (input, options) {
      const handle = yield* detectGitRepositoryForStatus(
        "GitWorkflowService.localStatus",
        input.cwd,
      );
      if (!handle) return nonRepositoryLocalStatus();
      if (handle.problem) {
        return problemLocalStatus({ kind: handle.kind, problem: handle.problem });
      }
      // A jj snapshot rewrites the Git index, so Git status must read after it.
      const snapshotVcs = options?.snapshotWorkingCopy ? yield* statusVcs(handle, true) : null;
      const [status, vcs] = yield* Effect.all(
        [
          gitManager.localStatus(input),
          snapshotVcs ? Effect.succeed(snapshotVcs) : statusVcs(handle, false),
        ],
        { concurrency: "unbounded" },
      );
      return { ...status, vcs };
    }),
    remoteStatus: Effect.fn("GitWorkflowService.remoteStatus")(function* (input, options) {
      const handle = yield* detectGitRepositoryForStatus(
        "GitWorkflowService.remoteStatus",
        input.cwd,
      );
      if (!handle || handle.problem) return null;
      return yield* gitManager.remoteStatus(input, options);
    }),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: Effect.fn("GitWorkflowService.pullCurrentBranch")(function (cwd) {
      return ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(cwd)),
      );
    }),
    runStackedAction: Effect.fn("GitWorkflowService.runStackedAction")(function* (input, options) {
      const operation = "GitWorkflowService.runStackedAction";
      const jjRoot = yield* jjWorkspaces.repoRoot(input.cwd);
      if (jjRoot !== null) {
        yield* jjWorkspaces
          .ensureBranchAttached({ cwd: input.cwd })
          .pipe(Effect.mapError(asGitCommandError(operation, input.cwd)));
      }
      const actionOptions: GitManager.GitRunStackedActionOptions | undefined =
        jjRoot === null
          ? options
          : {
              ...options,
              commit: (commit) =>
                jjWorkspaces
                  .commit(commit)
                  .pipe(Effect.mapError(asGitCommandError(operation, commit.cwd))),
            };
      const result = yield* ensureGit(operation, input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.featureBranch
            ? withCheckoutLease(
                handle.repository.rootPath,
                gitManager.runStackedAction(input, actionOptions),
              )
            : gitManager.runStackedAction(input, actionOptions),
        ),
      );
      if (jjRoot !== null) yield* importJjRefs(operation, input.cwd);
      return result;
    }),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: Effect.fn("GitWorkflowService.preparePullRequestThread")(
      function* (input) {
        if (input.mode === "worktree" && (yield* jjWorkspaces.repoRoot(input.cwd)) !== null) {
          return yield* new GitManagerError({
            operation: "GitWorkflowService.preparePullRequestThread",
            cwd: input.cwd,
            detail:
              "Pull request worktrees are not supported in jj repositories yet. Check the pull request out locally instead.",
          });
        }
        return yield* ensureGit("GitWorkflowService.preparePullRequestThread", input.cwd).pipe(
          Effect.flatMap((handle) =>
            input.mode === "local"
              ? withCheckoutLease(
                  handle.repository.rootPath,
                  gitManager.preparePullRequestThread(input),
                )
              : gitManager.preparePullRequestThread(input),
          ),
        );
      },
    ),
    listRefs: Effect.fn("GitWorkflowService.listRefs")(function (input) {
      return detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      );
    }),
    createWorktree: Effect.fn("GitWorkflowService.createWorktree")(function* (input, options) {
      const operation = "GitWorkflowService.createWorktree";
      const jjRoot = yield* jjWorkspaces.repoRoot(input.cwd);
      if (jjRoot === null) {
        return yield* ensureGitCommand(operation, input.cwd).pipe(
          Effect.andThen(gitManager.createWorktree(input, options)),
        );
      }
      const created = yield* jjWorkspaces
        .create({
          repoRoot: jjRoot,
          path: input.path,
          baseRef: input.refName,
          branch: input.newRefName ?? input.refName,
          createBranch: input.newRefName !== undefined,
        })
        .pipe(Effect.mapError(asGitCommandError(operation, input.cwd)));
      if (options?.progress?.onWorktreeClaimed) {
        yield* options.progress.onWorktreeClaimed(created.path);
      }
      return { worktree: { path: created.path, refName: created.branch } };
    }),
    listLocalBranchNames: Effect.fn("GitWorkflowService.listLocalBranchNames")(function (cwd) {
      return ensureGitCommand("GitWorkflowService.listLocalBranchNames", cwd).pipe(
        Effect.andThen(git.listLocalBranchNames(cwd)),
      );
    }),
    fetchRemote: Effect.fn("GitWorkflowService.fetchRemote")(function (input) {
      return ensureGitCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
        Effect.andThen(git.fetchRemote(input)),
      );
    }),
    remoteExists: Effect.fn("GitWorkflowService.remoteExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
      );
    }),
    remoteBranchExists: Effect.fn("GitWorkflowService.remoteBranchExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteBranchExists", input.cwd).pipe(
        Effect.andThen(git.remoteBranchExists(input)),
      );
    }),
    resolveRemoteTrackingCommit: Effect.fn("GitWorkflowService.resolveRemoteTrackingCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
          Effect.andThen(git.resolveRemoteTrackingCommit(input)),
        );
      },
    ),
    resolveWorktreeBaseRemote: Effect.fn("GitWorkflowService.resolveWorktreeBaseRemote")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.resolveWorktreeBaseRemote", input.cwd).pipe(
          Effect.andThen(git.resolveWorktreeBaseRemote(input)),
        );
      },
    ),
    fetchWorktreeBaseCommit: Effect.fn("GitWorkflowService.fetchWorktreeBaseCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.fetchWorktreeBaseCommit", input.cwd).pipe(
          Effect.andThen(git.fetchWorktreeBaseCommit(input)),
        );
      },
    ),
    removeWorktree: Effect.fn("GitWorkflowService.removeWorktree")(function* (input) {
      const operation = "GitWorkflowService.removeWorktree";
      const jjRoot = yield* jjWorkspaces.repoRoot(input.cwd);
      if (jjRoot === null) {
        return yield* ensureGitCommand(operation, input.cwd).pipe(
          Effect.andThen(git.removeWorktree(input)),
        );
      }
      yield* jjWorkspaces
        .forget({ repoRoot: jjRoot, path: input.path, force: input.force === true })
        .pipe(Effect.mapError(asGitCommandError(operation, input.cwd)));
    }),
    pruneWorktrees: Effect.fn("GitWorkflowService.pruneWorktrees")(function* (input) {
      // `git worktree prune` un-colocates missing jj workspaces.
      if ((yield* jjWorkspaces.repoRoot(input.cwd)) !== null) return;
      return yield* ensureGitCommand("GitWorkflowService.pruneWorktrees", input.cwd).pipe(
        Effect.andThen(git.pruneWorktrees(input)),
      );
    }),
    deleteLocalBranch: Effect.fn("GitWorkflowService.deleteLocalBranch")(function (input) {
      return ensureGitCommand("GitWorkflowService.deleteLocalBranch", input.cwd).pipe(
        Effect.andThen(git.deleteLocalBranch(input)),
        Effect.tap(() => importJjRefs("GitWorkflowService.deleteLocalBranch", input.cwd)),
      );
    }),
    createRef: Effect.fn("GitWorkflowService.createRef")(function (input) {
      return ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.switchRef
            ? withCheckoutLease(handle.repository.rootPath, git.createRef(input))
            : git.createRef(input),
        ),
        Effect.tap(() => importJjRefs("GitWorkflowService.createRef", input.cwd)),
      );
    }),
    switchRef: Effect.fn("GitWorkflowService.switchRef")(function (input) {
      return ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(handle.repository.rootPath, Effect.scoped(git.switchRef(input))),
        ),
        Effect.tap(() => importJjRefs("GitWorkflowService.switchRef", input.cwd)),
      );
    }),
    renameBranch: Effect.fn("GitWorkflowService.renameBranch")(function* (input) {
      const operation = "GitWorkflowService.renameBranch";
      const jjRoot = yield* jjWorkspaces.repoRoot(input.cwd);
      if (jjRoot !== null) {
        yield* jjWorkspaces
          .ensureBranchAttached({ cwd: input.cwd, branch: input.oldBranch })
          .pipe(Effect.mapError(asGitCommandError(operation, input.cwd)));
      }
      const result = yield* ensureGit(operation, input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      );
      if (jjRoot !== null) yield* importJjRefs(operation, input.cwd);
      return result;
    }),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
