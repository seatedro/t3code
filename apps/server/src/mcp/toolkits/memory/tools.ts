import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as Memory from "../../../memory/Memory.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const MemoryTool = Tool.make("memory", {
  description: [
    "Your permanent memory in this environment. It outlives sessions, compaction, and model changes.",
    "- `wake` before any other tool call in a new session, then do what it prints, to the end.",
    "- `note` one line (max 280 bytes) whenever you learn something worth keeping: a task worth real effort, a fact or decision, anything about the user. No duplicates. If it asks for a compression, `nap` before your next action.",
    "- `recall <regex>` searches every memory word for word; `zoom <a-b>` opens a summary into its halves; `forget <a-b>` drops a bad summary.",
    'Printed commands like `memory nap 0-1 "..."` are calls to this tool: command `nap`, args `["0-1", "..."]`.',
  ].join("\n"),
  parameters: Schema.Struct({
    command: Memory.MemoryCommand,
    args: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  success: Schema.Struct({ output: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Memory.Memory,
  ],
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)
  // Off in settings, or a subagent, which cannot judge what is already known.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.memoryToolVisible);

export const MemoryToolkit = Toolkit.make(MemoryTool);
