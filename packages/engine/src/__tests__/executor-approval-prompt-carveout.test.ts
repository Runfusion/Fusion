import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveAgentPrompt } from "@fusion/core";

/*
FNXC:ExecutorPrompt 2026-07-05-00:40:
FN-7608 regression coverage: both canonical executor prompts (EXECUTOR_SYSTEM_PROMPT
in engine/executor.ts and EXECUTOR_PROMPT_TEXT in core/agent-prompts.ts, exposed via
resolveAgentPrompt("executor")) must carry the pending-approval turn-ending carve-out,
and the shared clause text must stay byte-identical between the two copies so they
never drift. EXECUTOR_SYSTEM_PROMPT is a private module constant (not exported), so
the engine copy is asserted by reading the source file directly.
*/
const CARVEOUT_MARKER = "Exception — pending approval.";

function readExecutorSourcePrompt(): string {
  const executorTsPath = fileURLToPath(new URL("../executor.ts", import.meta.url));
  return readFileSync(executorTsPath, "utf8");
}

function readAgentPromptsSource(): string {
  const agentPromptsTsPath = fileURLToPath(new URL("../../../core/src/agent-prompts.ts", import.meta.url));
  return readFileSync(agentPromptsTsPath, "utf8");
}

describe("executor prompt pending-approval carve-out (FN-7608)", () => {
  it("EXECUTOR_SYSTEM_PROMPT (engine) contains the carve-out marker", () => {
    const source = readExecutorSourcePrompt();
    expect(source).toContain(CARVEOUT_MARKER);
    expect(source).toContain("Waiting on a pending approval IS a legitimate turn end");
  });

  it("EXECUTOR_PROMPT_TEXT (core, via resolveAgentPrompt) contains the carve-out marker", () => {
    const prompt = resolveAgentPrompt("executor");
    expect(prompt).toContain(CARVEOUT_MARKER);
    expect(prompt).toContain("Waiting on a pending approval IS a legitimate turn end");
  });

  it("keeps the shared carve-out clause byte-identical between both prompt copies", () => {
    // Compare raw .ts SOURCE text on both sides (not the runtime-resolved
    // core prompt), since the core copy's runtime string has already been
    // through template-literal escape resolution (e.g. `\\\`` -> `\``) while
    // reading executor.ts's source keeps its literal escape sequences —
    // comparing source-to-source avoids a false mismatch from that.
    const engineSource = readExecutorSourcePrompt();
    const coreSource = readAgentPromptsSource();

    function extractClause(text: string): string {
      const start = text.indexOf(`**${CARVEOUT_MARKER}**`);
      expect(start).toBeGreaterThan(-1);
      const end = text.indexOf("\n\nIf you have just finished", start);
      expect(end).toBeGreaterThan(start);
      return text.slice(start, end);
    }

    const engineClause = extractClause(engineSource);
    const coreClause = extractClause(coreSource);
    expect(engineClause).toBe(coreClause);
  });
});
