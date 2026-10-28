import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  hasT3Memory,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

const memoryLine = "call it with `wake` before any other tool";

describe("memory instructions", () => {
  it("follow the credential's memory capability", () => {
    NodeAssert.equal(hasT3Memory({ capabilities: new Set(["orchestration", "memory"]) }), true);
    NodeAssert.equal(hasT3Memory({ capabilities: new Set(["orchestration"]) }), false);
    NodeAssert.equal(hasT3Memory(undefined), false);
  });

  it("join the system prompt and first-run prompt only when memory is on", () => {
    NodeAssert.ok(t3OrchestrationSystemPrompt(true, true)?.includes(memoryLine));
    NodeAssert.ok(!t3OrchestrationSystemPrompt(true, false)?.includes(memoryLine));
    NodeAssert.equal(t3OrchestrationSystemPrompt(false, true), undefined);
    const firstRun = (memory: boolean) =>
      t3OrchestrationPromptForFirstRun({ prompt: "hi", runOrdinal: 1, hasT3Mcp: true, memory });
    NodeAssert.ok(firstRun(true).includes(memoryLine));
    NodeAssert.ok(!firstRun(false).includes(memoryLine));
  });

  it("are sent again to an ACP agent when memory is switched on", () => {
    const off = { interactionMode: "default" as const, hasT3Mcp: true, memory: false };
    const on = { ...off, memory: true };

    NodeAssert.equal(
      t3AcpPromptWithInstructions({ prompt: "hi", state: off, previousState: off }),
      "hi",
    );
    NodeAssert.ok(
      t3AcpPromptWithInstructions({ prompt: "hi", state: on, previousState: off }).includes(
        memoryLine,
      ),
    );
  });
});
