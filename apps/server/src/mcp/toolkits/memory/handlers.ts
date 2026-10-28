import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Memory from "../../../memory/Memory.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MemoryToolkit } from "./tools.ts";

const READS: ReadonlySet<Memory.MemoryCommand> = new Set(["wake", "recall", "zoom"]);

const run = Effect.fn("MemoryToolkit.run")(function* (params: {
  readonly command: Memory.MemoryCommand;
  readonly args?: ReadonlyArray<string>;
}) {
  const memory = yield* Memory.Memory;
  const output = yield* memory.run(params.command, params.args ?? []).pipe(
    Effect.catchTags({
      MemoryRefusal: (refusal) =>
        Effect.fail(
          new OrchestratorMcpFailure({ code: "invalid_request", message: refusal.reason }),
        ),
      MemoryStorageError: (error) =>
        Effect.fail(
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
    }),
  );
  return { output };
});

export const layer = McpToolAccess.toLayer(MemoryToolkit, {
  memory: McpToolAccess.either(
    (params) => READS.has(params.command),
    McpToolAccess.readsAsCaller(run),
    McpToolAccess.actsAsCaller(run),
  ),
});
