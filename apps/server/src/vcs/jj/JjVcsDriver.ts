import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  type VcsError,
  type VcsWorkspaceProblem,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import * as VcsDriver from "../VcsDriver.ts";
import * as JjCli from "./JjCli.ts";

// Methods and literals only: user template-aliases can shadow functions such as json().
const WORKSPACE_LIST_TEMPLATE = 'self.name().escape_json() ++ "\\t" ++ self.root() ++ "\\0"';

const NOT_COLOCATED_DETAIL =
  "This jj workspace is not colocated with Git. T3 Code supports colocated jj repositories only.";

const nowFreshness = Effect.fn("JjVcsDriver.nowFreshness")(function* () {
  return {
    source: "live-local" as const,
    observedAt: yield* DateTime.now,
    expiresAt: Option.none(),
  };
});

const exists = (fileSystem: FileSystem.FileSystem, target: string) =>
  fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

/** The nearest `.jj/repo` wins over `.git` at the same level; a nearer `.git` is an independent Git repository. */
const findWorkspace = Effect.fn("JjVcsDriver.findWorkspace")(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => null));
  if (resolved === null) return null;

  let directory = resolved;
  while (true) {
    const repoEntry = path.join(directory, ".jj", "repo");
    const info = yield* fileSystem.stat(repoEntry).pipe(Effect.orElseSucceed(() => null));
    if (info !== null) {
      if (info.type === "Directory") return { rootPath: directory, repoPath: repoEntry };
      const pointer = yield* fileSystem.readFileString(repoEntry).pipe(
        Effect.mapError(
          (cause) =>
            new VcsRepositoryDetectionError({
              operation: "JjVcsDriver.findWorkspace",
              cwd,
              detail: "Failed to read the jj workspace's repository pointer.",
              cause,
            }),
        ),
      );
      return {
        rootPath: directory,
        repoPath: path.resolve(path.join(directory, ".jj"), pointer.trim()),
      };
    }
    if (yield* exists(fileSystem, path.join(directory, ".git"))) return null;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
});

export const problemFromError = (error: VcsError): VcsWorkspaceProblem =>
  error._tag === "VcsUnsupportedOperationError"
    ? { code: "unsupported", message: error.detail }
    : error._tag === "VcsWorkspaceStaleError"
      ? { code: "stale", message: error.detail }
      : { code: "error", message: error.message };

/** Null when the workspace is a supported colocated jj workspace. */
export const inspectSupport = Effect.fn("JjVcsDriver.inspectSupport")(function* (rootPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const jj = yield* JjCli.JjCli;
  if (!(yield* exists(fileSystem, path.join(rootPath, ".git")))) {
    return { code: "unsupported", message: NOT_COLOCATED_DETAIL } satisfies VcsWorkspaceProblem;
  }
  return yield* jj
    .run({
      operation: "JjVcsDriver.inspectSupport",
      cwd: rootPath,
      args: ["git", "colocation", "status"],
      workingCopy: "observe",
      timeoutMs: 5_000,
    })
    .pipe(
      Effect.map((result): VcsWorkspaceProblem | null =>
        /is currently colocated with Git/.test(result.stdout)
          ? null
          : { code: "unsupported", message: NOT_COLOCATED_DETAIL },
      ),
      Effect.catch((error) => Effect.succeed(problemFromError(error))),
    );
});

const parseJsonString = (text: string) => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

const parseWorkspaceList = (stdout: string) =>
  stdout.split("\0").flatMap((record) => {
    const separator = record.indexOf("\t");
    const name = separator === -1 ? null : parseJsonString(record.slice(0, separator).trim());
    return name === null ? [] : [{ name, root: record.slice(separator + 1) }];
  });

/** The name jj gives the workspace rooted at `rootPath`, or null when jj does not list it. */
export const readCurrentWorkspaceName = Effect.fn("JjVcsDriver.readCurrentWorkspaceName")(
  function* (rootPath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const jj = yield* JjCli.JjCli;
    const canonical = (target: string) =>
      fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));
    const root = yield* canonical(rootPath);
    const result = yield* jj.run({
      operation: "JjVcsDriver.readCurrentWorkspaceName",
      cwd: rootPath,
      args: ["workspace", "list", "-T", WORKSPACE_LIST_TEMPLATE],
      workingCopy: "observe",
      timeoutMs: 5_000,
    });
    for (const workspace of parseWorkspaceList(result.stdout)) {
      if ((yield* canonical(workspace.root)) === root) return workspace.name;
    }
    return null;
  },
);

/** Pass the Git driver to share it; checkpoint wiring builds on the same Git `execute` and `checkpoints`. */
export const makeVcsDriverShape = Effect.fn("makeJjVcsDriverShape")(function* (
  gitDriver?: VcsDriver.VcsDriver["Service"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const jj = yield* JjCli.JjCli;
  const git = gitDriver ?? (yield* GitVcsDriver.makeVcsDriverShape());
  const provideFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const capabilities = {
    kind: "jj" as const,
    supportsWorktrees: true,
    supportsBookmarks: true,
    supportsAtomicSnapshot: true,
    supportsPushDefaultRemote: true,
    ignoreClassifier: "git-compatible-fallback" as const,
  };

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "JjVcsDriver.detectRepository",
  )(function* (cwd) {
    const workspace = yield* provideFs(findWorkspace(cwd));
    if (workspace === null) return null;
    return {
      kind: "jj" as const,
      rootPath: workspace.rootPath,
      metadataPath: workspace.repoPath,
      freshness: yield* nowFreshness(),
    };
  });

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    detectRepository(cwd).pipe(Effect.map((repository) => repository !== null));

  // Ignore rules come from the colocated Git checkout; without one, Git would answer for an enclosing repository.
  const requireColocated = Effect.fn("JjVcsDriver.requireColocated")(function* (
    operation: string,
    cwd: string,
  ) {
    const workspace = yield* provideFs(findWorkspace(cwd));
    if (workspace === null || !(yield* exists(fileSystem, path.join(workspace.rootPath, ".git")))) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: "jj",
        detail: NOT_COLOCATED_DETAIL,
      });
    }
  });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = (cwd) =>
    requireColocated("JjVcsDriver.listWorkspaceFiles", cwd).pipe(
      Effect.andThen(git.listWorkspaceFiles(cwd)),
    );

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = (
    cwd,
    relativePaths,
  ) =>
    relativePaths.length === 0
      ? Effect.succeed(relativePaths)
      : requireColocated("JjVcsDriver.filterIgnoredPaths", cwd).pipe(
          Effect.andThen(git.filterIgnoredPaths(cwd, relativePaths)),
        );

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = (cwd) =>
    requireColocated("JjVcsDriver.listRemotes", cwd).pipe(Effect.andThen(git.listRemotes(cwd)));

  // Generic callers never snapshot; foreground snapshots go through JjCli with workingCopy: "snapshot".
  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    jj.run({
      operation: input.operation,
      cwd: input.cwd,
      args: input.args,
      workingCopy: "observe",
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
    });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = () =>
    Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.initRepository",
        kind: "jj",
        detail: "T3 Code does not create jj repositories. Run `jj git init --colocate` yourself.",
      }),
    );

  return {
    capabilities,
    execute,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  } satisfies VcsDriver.VcsDriver["Service"];
});

export const layerVcs = Layer.effect(
  VcsDriver.VcsDriver,
  Effect.gen(function* () {
    return VcsDriver.VcsDriver.of(yield* makeVcsDriverShape());
  }),
);
