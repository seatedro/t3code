import {
  CheckpointRef,
  type VcsError,
  type VcsRepairWorkspaceInput,
  type VcsRepairWorkspaceResult,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import * as VcsDriverRegistry from "../VcsDriverRegistry.ts";
import { JjCli } from "./JjCli.ts";

const OPERATION = "JjWorkspaceRepair.repair";

export class JjWorkspaceRepair extends Context.Service<
  JjWorkspaceRepair,
  {
    readonly repair: (
      input: VcsRepairWorkspaceInput,
    ) => Effect.Effect<VcsRepairWorkspaceResult, VcsError>;
  }
>()("t3/vcs/jj/JjWorkspaceRepair") {}

// Workspace names are user-chosen; keep each ref path component valid.
const refComponent = (name: string) => name.replace(/[^\w-]/g, "-") || "workspace";

const make = Effect.gen(function* () {
  const jj = yield* JjCli;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;

  const unsupported = (detail: string) =>
    new VcsUnsupportedOperationError({ operation: OPERATION, kind: "jj", detail });

  const repairLeased = Effect.fn("JjWorkspaceRepair.repairLeased")(function* (root: string) {
    const stale = yield* jj
      .run({ operation: OPERATION, cwd: root, args: ["util", "snapshot"], workingCopy: "snapshot" })
      .pipe(
        Effect.as(false),
        Effect.catchTags({ VcsWorkspaceStaleError: () => Effect.succeed(true) }),
      );
    if (!stale) return { repaired: false } as const;

    const git = yield* registry.get("git");
    if (git.checkpoints === undefined) {
      return yield* unsupported("Git checkpoints are unavailable, so files cannot be preserved.");
    }
    const workspace = yield* jj.run({
      operation: OPERATION,
      cwd: root,
      args: [
        "workspace",
        "list",
        "-T",
        'if(self.target().current_working_copy(), self.name() ++ "\\n")',
      ],
      workingCopy: "observe",
    });
    const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const preservedRef = CheckpointRef.make(
      `refs/t3/repair/${refComponent(workspace.stdout.trim())}/${id}`,
    );
    // update-stale resets disk and buries unsnapshotted edits in a divergent sibling.
    yield* git.checkpoints.captureCheckpoint({ cwd: root, checkpointRef: preservedRef });
    yield* jj.run({
      operation: OPERATION,
      cwd: root,
      args: ["workspace", "update-stale"],
      workingCopy: "snapshot",
    });

    const divergent = yield* jj.run({
      operation: OPERATION,
      cwd: root,
      args: ["log", "--no-graph", "-r", "divergent()", "-T", 'self.change_id() ++ "\\n"'],
      workingCopy: "observe",
    });
    const divergentChangeIds = [
      ...new Set(divergent.stdout.split("\n").filter((line) => line.length > 0)),
    ];
    return { repaired: true, preservedRef, divergentChangeIds } as const;
  });

  const repair: JjWorkspaceRepair["Service"]["repair"] = Effect.fn("JjWorkspaceRepair.repair")(
    function* (input) {
      const handle = yield* registry.detect({ cwd: input.cwd });
      if (handle?.kind !== "jj") {
        return yield* unsupported(`No jj workspace was detected at ${input.cwd}.`);
      }
      const rootPath = handle.repository.rootPath;
      const root = yield* fileSystem.realPath(rootPath).pipe(Effect.orElseSucceed(() => rootPath));
      return yield* withWorkspaceLease(root, repairLeased(root));
    },
  );

  return JjWorkspaceRepair.of({ repair });
});

export const layer = Layer.effect(JjWorkspaceRepair, make);
