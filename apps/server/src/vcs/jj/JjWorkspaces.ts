import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  type GitCommandError,
  type VcsError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import { resolveWorktreesDirectory } from "../../worktreesDirectory.ts";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import * as VcsDriverRegistry from "../VcsDriverRegistry.ts";
import * as JjCli from "./JjCli.ts";

export interface JjWorkspaceEntry {
  readonly name: string;
  readonly root: string;
}

export class JjWorkspaceError extends Schema.TaggedError<JjWorkspaceError>()("JjWorkspaceError", {
  operation: Schema.String,
  cwd: Schema.String,
  reason: Schema.Literals([
    "bookmark-moved",
    "prunable-worktree",
    "dirty",
    "invalid-path",
    "filesystem",
  ]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `jj workspace ${this.operation} failed (${this.cwd}): ${this.detail}`;
  }
}

export type JjWorkspacesError = VcsError | GitCommandError | JjWorkspaceError;

export interface JjWorkspaceCreateInput {
  readonly repoRoot: string;
  /** Null derives the managed worktree path, as `git worktree add` does. */
  readonly path: string | null;
  readonly baseRef: string;
  readonly branch: string;
  /** False checks out an existing branch, for recreating a missing workspace. */
  readonly createBranch: boolean;
}

export class JjWorkspaces extends Context.Service<
  JjWorkspaces,
  {
    /** The repository root when `cwd` is in a jj repository, else null. */
    readonly repoRoot: (cwd: string) => Effect.Effect<string | null>;
    readonly create: (
      input: JjWorkspaceCreateInput,
    ) => Effect.Effect<{ readonly path: string; readonly branch: string }, JjWorkspacesError>;
    readonly list: (repoRoot: string) => Effect.Effect<ReadonlyArray<JjWorkspaceEntry>, VcsError>;
    readonly forget: (input: {
      readonly repoRoot: string;
      readonly path: string;
      readonly force: boolean;
    }) => Effect.Effect<void, JjWorkspacesError>;
    /** jj detaches HEAD on every export; reattach before git work that needs the branch. */
    readonly ensureBranchAttached: (input: {
      readonly cwd: string;
      readonly branch?: string;
    }) => Effect.Effect<void, JjWorkspacesError>;
    readonly importGitRefs: (cwd: string) => Effect.Effect<void, VcsError>;
  }
>()("t3/vcs/jj/JjWorkspaces") {}

const LIST_TEMPLATE = 'json({"name"=>self.name(),"root"=>self.root()}) ++ "\\n"';

export function parseWorkspaceList(stdout: string): ReadonlyArray<JjWorkspaceEntry> {
  const entries: JjWorkspaceEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (
        typeof value === "object" &&
        value !== null &&
        "name" in value &&
        "root" in value &&
        typeof value.name === "string" &&
        typeof value.root === "string" &&
        value.name !== "" &&
        value.root !== ""
      ) {
        entries.push({ name: value.name, root: value.root });
      }
    } catch {
      continue;
    }
  }
  return entries;
}

function parsePrunableWorktrees(porcelain: string): ReadonlyArray<string> {
  return porcelain.split("\n\n").flatMap((block) => {
    const lines = block.split("\n");
    const worktree = lines.find((line) => line.startsWith("worktree "));
    return worktree !== undefined && lines.some((line) => line.startsWith("prunable"))
      ? [worktree.slice("worktree ".length)]
      : [];
  });
}

/** The branch HEAD last attached to, from checkout and rename reflog entries. */
function parseLastAttachedBranch(reflogSubjects: string): string | null {
  for (const subject of reflogSubjects.split("\n")) {
    const checkout = /^checkout: moving from .+ to (\S+)$/.exec(subject);
    if (checkout) return checkout[1]!;
    const renamed = /^Branch: renamed refs\/heads\/\S+ to refs\/heads\/(\S+)$/.exec(subject);
    if (renamed) return renamed[1]!;
  }
  return null;
}

const make = Effect.gen(function* () {
  const jj = yield* JjCli.JjCli;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const { worktreesDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const fail = (
    operation: string,
    cwd: string,
    reason: JjWorkspaceError["reason"],
    detail: string,
    cause?: unknown,
  ) =>
    new JjWorkspaceError({
      operation,
      cwd,
      reason,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const runGit = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation, cwd, args, allowNonZeroExit: true });

  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

  // Missing directories still compare equal through their nearest real parent.
  const canonical = (target: string) =>
    fileSystem.realPath(target).pipe(
      Effect.catch(() =>
        fileSystem
          .realPath(path.dirname(target))
          .pipe(Effect.map((parent) => path.join(parent, path.basename(target)))),
      ),
      Effect.orElseSucceed(() => path.resolve(target)),
    );

  const withRepoLock = <A, E, R>(repoRoot: string, effect: Effect.Effect<A, E, R>) =>
    canonical(repoRoot).pipe(
      Effect.flatMap((root) => withWorkspaceLease(`jj-workspaces:${root}`, effect)),
    );

  const repoRoot: JjWorkspaces["Service"]["repoRoot"] = (cwd) =>
    registry.detect({ cwd }).pipe(
      Effect.map((handle) => (handle?.kind === "jj" ? handle.repository.rootPath : null)),
      Effect.orElseSucceed(() => null),
    );

  const list: JjWorkspaces["Service"]["list"] = Effect.fn("JjWorkspaces.list")(function* (root) {
    const result = yield* jj.run({
      operation: "JjWorkspaces.list",
      cwd: root,
      args: ["workspace", "list", "-T", LIST_TEMPLATE],
      workingCopy: "observe",
    });
    return parseWorkspaceList(result.stdout);
  });

  // Helpers run inside the traced service methods, which own the spans.
  const findWorkspace = Effect.fnUntraced(function* (root: string, target: string) {
    const wanted = yield* canonical(target);
    for (const entry of yield* list(root)) {
      if ((yield* canonical(entry.root)) === wanted) return entry;
    }
    return null;
  });

  const importGitRefs: JjWorkspaces["Service"]["importGitRefs"] = Effect.fn(
    "JjWorkspaces.importGitRefs",
  )(function* (cwd) {
    yield* jj.run({
      operation: "JjWorkspaces.importGitRefs",
      cwd,
      args: ["git", "import"],
      // With --ignore-working-copy, importing a moved HEAD rewrites git's index from jj's stale
      // view, staging new files of the imported commit for deletion.
      workingCopy: "snapshot",
    });
  });

  // `jj workspace forget` un-colocates every absent sibling, so any prunable entry blocks it.
  const assertNoPrunableWorktrees = Effect.fnUntraced(function* (
    operation: string,
    root: string,
    except: string | null,
  ) {
    const listing = yield* git.execute({
      operation,
      cwd: root,
      args: ["worktree", "list", "--porcelain"],
    });
    const exempt = except === null ? null : yield* canonical(except);
    const prunable: string[] = [];
    for (const worktree of parsePrunableWorktrees(listing.stdout)) {
      if ((yield* canonical(worktree)) !== exempt) prunable.push(worktree);
    }
    if (prunable.length > 0) {
      return yield* fail(
        operation,
        root,
        "prunable-worktree",
        `Git lists missing worktrees: ${prunable.join(", ")}. Restore or remove them with jj before removing workspaces.`,
      );
    }
  });

  // Drops the git admin entry of a worktree whose folder is gone, without a repo-wide prune.
  const dropMissingGitWorktree = Effect.fnUntraced(function* (
    operation: string,
    root: string,
    target: string,
  ) {
    const commonDir = path.resolve(
      root,
      (yield* git.execute({
        operation,
        cwd: root,
        args: ["rev-parse", "--git-common-dir"],
      })).stdout.trim(),
    );
    const adminRoot = path.join(commonDir, "worktrees");
    const wanted = path.join(yield* canonical(target), ".git");
    for (const name of yield* fileSystem
      .readDirectory(adminRoot)
      .pipe(Effect.orElseSucceed((): string[] => []))) {
      const adminDir = path.join(adminRoot, name);
      const gitdir = yield* fileSystem
        .readFileString(path.join(adminDir, "gitdir"))
        .pipe(Effect.orElseSucceed(() => ""));
      if (gitdir.trim() === "") continue;
      const pointsAt = path.resolve(adminDir, gitdir.trim());
      if (path.join(yield* canonical(path.dirname(pointsAt)), ".git") !== wanted) continue;
      yield* fileSystem
        .remove(adminDir, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            fail(operation, root, "filesystem", `Failed to remove ${adminDir}`, cause),
          ),
        );
    }
  });

  const forgetLocked = Effect.fnUntraced(function* (
    operation: string,
    root: string,
    entry: JjWorkspaceEntry,
    target: string,
    present: boolean,
  ) {
    yield* withRepoLock(
      root,
      Effect.gen(function* () {
        yield* assertNoPrunableWorktrees(operation, root, present ? null : target);
        yield* jj.run({
          operation,
          cwd: root,
          args: ["workspace", "forget", "--", entry.name],
          workingCopy: "observe",
        });
      }),
    );
    if (present) {
      yield* fileSystem
        .remove(target, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            fail(operation, root, "filesystem", `Failed to delete ${target}`, cause),
          ),
        );
    } else {
      yield* dropMissingGitWorktree(operation, root, target);
    }
  });

  const forget: JjWorkspaces["Service"]["forget"] = Effect.fn("JjWorkspaces.forget")(
    function* (input) {
      const operation = "JjWorkspaces.forget";
      const target = path.resolve(input.repoRoot, input.path);
      if ((yield* canonical(target)) === (yield* canonical(input.repoRoot))) {
        return yield* fail(
          operation,
          input.repoRoot,
          "invalid-path",
          "The repository root cannot be removed.",
        );
      }
      const present = yield* exists(target);
      const entry = yield* findWorkspace(input.repoRoot, target);
      if (entry === null) {
        if (!present) return;
        return yield* fail(
          operation,
          input.repoRoot,
          "invalid-path",
          `${target} is not a workspace of this jj repository.`,
        );
      }
      if (present && !input.force) {
        const status = yield* git.execute({
          operation,
          cwd: target,
          args: ["-c", "status.showUntrackedFiles=normal", "status", "--porcelain"],
        });
        if (status.stdout.trim() !== "") {
          return yield* fail(
            operation,
            input.repoRoot,
            "dirty",
            `${target} contains modified or untracked files.`,
          );
        }
      }
      yield* forgetLocked(operation, input.repoRoot, entry, target, present);
    },
  );

  const defaultPath = Effect.fnUntraced(function* (root: string, branch: string) {
    const setting = yield* settings.getSettings.pipe(
      Effect.map((value) => value.worktreesDirectory),
      Effect.orElseSucceed(() => ""),
    );
    const parent = resolveWorktreesDirectory(
      setting,
      worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
    if (parent === null) {
      return yield* fail(
        "JjWorkspaces.create",
        root,
        "invalid-path",
        `The worktree location "${setting}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Worktrees.`,
      );
    }
    return path.join(parent, path.basename(path.resolve(root)), branch.replace(/\//g, "-"));
  });

  const create: JjWorkspaces["Service"]["create"] = Effect.fn("JjWorkspaces.create")(
    function* (input) {
      const operation = "JjWorkspaces.create";
      const root = input.repoRoot;
      for (const name of [input.branch, input.baseRef]) {
        if (name.startsWith("-")) {
          return yield* fail(operation, root, "invalid-path", `Invalid ref name: ${name}`);
        }
      }
      const target = path.resolve(root, input.path ?? (yield* defaultPath(root, input.branch)));
      const relative = path.relative(yield* canonical(root), yield* canonical(target));
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return yield* fail(
          operation,
          root,
          "invalid-path",
          `${target} must be outside the repository root.`,
        );
      }
      const commit = (yield* git.execute({
        operation,
        cwd: root,
        args: ["rev-parse", "--verify", "--end-of-options", `${input.baseRef}^{commit}`],
      })).stdout.trim();
      const submodules = yield* runGit(operation, root, [
        "cat-file",
        "-e",
        `${commit}:.gitmodules`,
      ]);
      if (submodules.exitCode === 0) {
        return yield* new VcsUnsupportedOperationError({
          operation,
          kind: "jj",
          detail: "Workspaces for repositories with submodules are not supported with jj yet.",
        });
      }
      yield* fileSystem
        .makeDirectory(path.dirname(target), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            fail(operation, root, "filesystem", `Failed to create ${path.dirname(target)}`, cause),
          ),
        );

      yield* withRepoLock(
        root,
        Effect.gen(function* () {
          if (!(yield* exists(target))) {
            const missing = yield* findWorkspace(root, target);
            if (missing !== null) {
              yield* assertNoPrunableWorktrees(operation, root, target);
              yield* jj.run({
                operation,
                cwd: root,
                args: ["workspace", "forget", "--", missing.name],
                workingCopy: "observe",
              });
            }
            yield* dropMissingGitWorktree(operation, root, target);
          }
          yield* jj.run({
            operation,
            cwd: root,
            args: [
              "workspace",
              "add",
              "--colocate",
              "--name",
              path.basename(target),
              "-r",
              commit,
              "--sparse-patterns",
              "full",
              target,
            ],
            // Snapshots the root once; with --ignore-working-copy the new workspace stays empty.
            workingCopy: "snapshot",
          });
        }),
      );

      yield* Effect.gen(function* () {
        yield* git.execute({
          operation,
          cwd: target,
          args: input.createBranch ? ["switch", "-c", input.branch] : ["switch", input.branch],
        });
        yield* importGitRefs(target);
      }).pipe(
        Effect.tapError(() =>
          forget({ repoRoot: root, path: target, force: true }).pipe(
            Effect.ignoreCause({ log: true }),
          ),
        ),
      );
      return { path: target, branch: input.branch };
    },
  );

  const ensureBranchAttached: JjWorkspaces["Service"]["ensureBranchAttached"] = Effect.fn(
    "JjWorkspaces.ensureBranchAttached",
  )(function* (input) {
    const operation = "JjWorkspaces.ensureBranchAttached";
    const { cwd } = input;
    if ((yield* runGit(operation, cwd, ["symbolic-ref", "-q", "HEAD"])).exitCode === 0) return;
    const [gitDir, commonDir] = (yield* git.execute({
      operation,
      cwd,
      args: ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    })).stdout
      .trim()
      .split("\n");
    // The default workspace has no T3 branch; leave its HEAD to jj.
    if (gitDir === commonDir) return;
    const branch =
      input.branch ??
      parseLastAttachedBranch(
        (yield* runGit(operation, cwd, ["reflog", "show", "-n", "100", "--format=%gs", "HEAD"]))
          .stdout,
      );
    if (branch === null) return;
    const ref = `refs/heads/${branch}`;
    const known =
      (yield* runGit(operation, cwd, ["show-ref", "--verify", "--quiet", ref])).exitCode === 0;
    if (!known) {
      if (input.branch === undefined) return;
      return yield* fail(operation, cwd, "bookmark-moved", `Branch ${branch} no longer exists.`);
    }
    const ancestor = yield* runGit(operation, cwd, ["merge-base", "--is-ancestor", ref, "HEAD"]);
    if (ancestor.exitCode !== 0) {
      return yield* fail(
        operation,
        cwd,
        "bookmark-moved",
        `Bookmark ${branch} moved away from this workspace's commit; move it back with jj or check it out before running git actions.`,
      );
    }
    yield* git.execute({ operation, cwd, args: ["switch", "-C", branch] });
  });

  return JjWorkspaces.of({
    repoRoot,
    create,
    list,
    forget,
    ensureBranchAttached,
    importGitRefs,
  });
});

export const layer = Layer.effect(JjWorkspaces, make);
