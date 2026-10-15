import { describe, it, expect } from "vitest";
import {
  buildPromptLayers,
  collapsePromptLayers,
  withRequestVolatileContext,
  SESSION_CONTEXT_HEADING,
} from "../execution/prompt-layers.js";

/*
FNXC:PromptByteStability 2026-09-24-02:10 (RUFU-267):
The reviewer used to pass its retrieved memory section into the serialized system prompt, so two
consecutive review requests of one task diverged at that block — the provider prefix cache stopped
after the role head. `memorySection` is no longer a prompt-layer input; the reviewer's serialized
prompt is config-time only and its per-request memory rides the end of the review prompt. These
cases pin both halves of that contract.
*/
describe("reviewer prompt layering", () => {
  const REVIEWER_BASE = "You are an independent code and plan reviewer.";
  const MEMORY_INSTRUCTIONS = "\n## Memory\n\nUse fn_memory_search to look up context.";

  it("puts base prompt in stable layer and memory guidance in dynamic layer", () => {
    const layers = buildPromptLayers({
      basePrompt: REVIEWER_BASE,
      agentInstructions: "Custom reviewer guidance.",
      memoryInstructions: MEMORY_INSTRUCTIONS,
      pluginContributions: "## Plugin: lint\n\nCheck lint.",
    });

    expect(layers.stable).toBe(REVIEWER_BASE);
    expect(layers.stable).not.toContain("Memory");
    expect(layers.dynamic).toContain("Memory");
    expect(layers.dynamic).toContain("Custom reviewer guidance");
  });

  it("cannot be coaxed into serializing a memory body: the removed volatile field has no effect", () => {
    const withoutVolatileKey = collapsePromptLayers(buildPromptLayers({
      basePrompt: REVIEWER_BASE,
      agentInstructions: "Custom reviewer guidance.",
    }));
    const layers = buildPromptLayers({
      basePrompt: REVIEWER_BASE,
      agentInstructions: "Custom reviewer guidance.",
      // Cast: `memorySection` is gone from the input type, so a caller can only reintroduce it by
      // force — which is what `scripts/check-prompt-volatility.mjs` refuses at build time.
      memorySection: "## Agent Memory\n\nRetrieved MEMORY.md body.",
    } as Parameters<typeof buildPromptLayers>[0]);

    // The field is unread, so the volatile body cannot reach the cached prefix even when a caller
    // forces it past the type: the collapsed prompt is byte-identical to the honest composition.
    expect(collapsePromptLayers(layers)).toBe(withoutVolatileKey);
    expect(collapsePromptLayers(layers)).not.toContain("MEMORY.md body");
  });

  it("produces an identical serialized prompt across sessions whose retrieved memory differs", () => {
    const first = collapsePromptLayers(buildPromptLayers({
      basePrompt: REVIEWER_BASE,
      agentInstructions: "Check for bugs.",
    }));
    const second = collapsePromptLayers(buildPromptLayers({
      basePrompt: REVIEWER_BASE,
      agentInstructions: "Check for bugs.",
    }));

    expect(second).toBe(first);

    // Volatility still reaches each review, as a request tail that differs per request.
    const firstRequest = withRequestVolatileContext("Review FN-1.", {
      memorySection: "## Agent Memory\n\n- Reviewed FN-0.",
    });
    const secondRequest = withRequestVolatileContext("Review FN-1.", {
      memorySection: "## Agent Memory\n\n- Reviewed FN-0.\n- Reviewed FN-1.",
    });

    expect(firstRequest).not.toBe(secondRequest);
    expect(secondRequest).toContain(SESSION_CONTEXT_HEADING);
    expect(secondRequest).toContain("Reviewed FN-1");
  });

  it("collapsed layers match legacy concatenation", () => {
    const layers = buildPromptLayers({
      basePrompt: REVIEWER_BASE,
      agentInstructions: "Check for bugs.",
      pluginContributions: "## Plugin: sec\n\nScan.",
    });
    const collapsed = collapsePromptLayers(layers);

    expect(collapsed).toBe(
      `${REVIEWER_BASE}\n\n## Custom Instructions\n\nCheck for bugs.\n\n## Plugin: sec\n\nScan.`
    );
  });
});
