import { VcsProcessExitError, VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as VcsDriver from "../VcsDriver.ts";
import { JjCli } from "./JjCli.ts";

export interface JjCheckpointsGit {
  readonly execute: VcsDriver.VcsDriver["Service"]["execute"];
  readonly checkpoints: VcsDriver.VcsCheckpointOps;
}

// A checkpoint is the snapshotted @ commit pinned by a git ref, so diffs and ref bookkeeping stay on git.
export const make = Effect.fn("JjCheckpoints.make")(function* (git: JjCheckpointsGit) {
  const jj = yield* JjCli;
  const fileSystem = yield* FileSystem.FileSystem;

  const readWorkingCopyCommit = (
    operation: string,
    cwd: string,
    workingCopy: "observe" | "snapshot",
  ) =>
    jj
      .run({
        operation,
        cwd,
        workingCopy,
        args: ["log", "--no-graph", "-r", "@", "-T", "self.commit_id()"],
      })
      .pipe(
        Effect.flatMap((result) => {
          const commit = result.stdout.trim();
          return commit.length > 0
            ? Effect.succeed(commit)
            : Effect.fail(
                new VcsProcessExitError({
                  operation,
                  command: "jj log",
                  cwd,
                  exitCode: 0,
                  detail: "jj log returned no working-copy commit.",
                }),
              );
        }),
      );

  const resolveCommit = (operation: string, cwd: string, revision: string) =>
    git
      .execute({
        operation,
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          const commit = result.stdout.trim();
          return result.exitCode === 0 && commit.length > 0 ? commit : null;
        }),
      );

  const restoreFrom = (operation: string, cwd: string, commit: string) =>
    jj.run({ operation, cwd, workingCopy: "snapshot", args: ["restore", "--from", commit, "."] });

  // After `jj op abandon` + `jj util gc`, jj forgets C while the git ref still pins it.
  // A temporary branch re-imports C; abandoning it afterwards clears the divergence with @.
  const restoreFromReimported = Effect.fn("JjCheckpoints.restoreFromReimported")(function* (
    operation: string,
    cwd: string,
    commit: string,
  ) {
    const bookmark = `t3-cp-${commit.slice(0, 12)}`;
    yield* git.execute({ operation, cwd, args: ["update-ref", `refs/heads/${bookmark}`, commit] });
    const cleanup = Effect.all([
      jj.run({
        operation,
        cwd,
        workingCopy: "snapshot",
        args: ["bookmark", "delete", `exact:${bookmark}`],
      }),
      jj.run({ operation, cwd, workingCopy: "snapshot", args: ["abandon", commit] }),
    ]);
    yield* restoreFrom(operation, cwd, commit).pipe(
      Effect.onError(() => cleanup.pipe(Effect.ignore)),
    );
    yield* cleanup;
  });

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("JjCheckpoints.captureCheckpoint")(function* (input) {
      const operation = "JjCheckpoints.captureCheckpoint";
      const commit = yield* readWorkingCopyCommit(operation, input.cwd, "snapshot");
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["update-ref", input.checkpointRef, commit],
      });
    }),

    hasCheckpointRef: git.checkpoints.hasCheckpointRef,

    restoreCheckpoint: Effect.fn("JjCheckpoints.restoreCheckpoint")(function* (input) {
      const operation = "JjCheckpoints.restoreCheckpoint";
      const commit =
        (yield* resolveCommit(operation, input.cwd, input.checkpointRef)) ??
        (input.fallbackToHead === true ? yield* resolveCommit(operation, input.cwd, "HEAD") : null);
      if (commit === null) return false;

      // Rewriting @, even by snapshotting it, rebases and stales other workspaces' working copies built on it.
      const dependents = yield* jj.run({
        operation,
        cwd: input.cwd,
        workingCopy: "observe",
        args: [
          "log",
          "--no-graph",
          "-r",
          "(descendants(@) ~ @) & working_copies()",
          "-T",
          'self.working_copies().map(|w| w.name()).join("\\n") ++ "\\n"',
        ],
      });
      const dependentWorkspaces = dependents.stdout.split("\n").filter((name) => name.length > 0);
      if (dependentWorkspaces.length > 0) {
        return yield* new VcsUnsupportedOperationError({
          operation,
          kind: "jj",
          detail: `Restoring this checkpoint would make workspaces that build on it stale: ${dependentWorkspaces.join(", ")}.`,
        });
      }

      // Fails with VcsWorkspaceStaleError before anything on disk changes.
      yield* jj.run({
        operation,
        cwd: input.cwd,
        workingCopy: "snapshot",
        args: ["util", "snapshot"],
      });

      const known = yield* jj.run({
        operation,
        cwd: input.cwd,
        workingCopy: "observe",
        args: ["log", "--no-graph", "-r", `present(${commit})`, "-T", "self.commit_id()"],
      });
      if (known.stdout.trim().length > 0) {
        yield* restoreFrom(operation, input.cwd, commit);
      } else {
        yield* restoreFromReimported(operation, input.cwd, commit);
      }
      // Restoring away the last tracked file can remove a nested workspace directory.
      yield* fileSystem.makeDirectory(input.cwd, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessExitError({
              operation,
              command: "jj restore",
              cwd: input.cwd,
              exitCode: 0,
              detail: `Could not recreate the checkpoint workspace: ${cause.message}`,
            }),
        ),
      );

      const restored = yield* readWorkingCopyCommit(operation, input.cwd, "observe");
      const mismatched = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["diff", "--name-only", "-z", "--no-renames", commit, restored, "--", "."],
        maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: "error",
      });
      const mismatchedPaths = mismatched.stdout.split("\0").filter((path) => path.length > 0);
      if (mismatchedPaths.length > 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "jj restore",
          cwd: input.cwd,
          exitCode: 0,
          detail: `Restore left paths different from the checkpoint: ${mismatchedPaths.join(", ")}`,
        });
      }
      return true;
    }),

    diffCheckpoints: git.checkpoints.diffCheckpoints,

    // jj rewrites @ and its parents freely, so only an unchanged parent makes the tree diff the turn's own.
    listAuthoredPaths: Effect.fn("JjCheckpoints.listAuthoredPaths")(function* (input) {
      const operation = "JjCheckpoints.listAuthoredPaths";
      const from = `${input.fromCheckpointRef}^{commit}`;
      const to = `${input.toCheckpointRef}^{commit}`;
      const parents = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["log", "--no-walk=unsorted", "--format=%P", from, to],
      });
      const [fromParents = "", toParents = ""] = parents.stdout.trimEnd().split("\n");
      if (fromParents === "" || fromParents !== toParents) return null;

      const changed = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", from, to],
        maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: "error",
      });
      return new Set(changed.stdout.split("\0").filter((path) => path.length > 0));
    }),

    deleteCheckpointRefs: git.checkpoints.deleteCheckpointRefs,
  };

  return checkpoints;
});
