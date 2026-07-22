import { describe, it, expect } from "vitest";
import { resolveAgentPrompt } from "@fusion/core";
import { buildPromptLayers, collapsePromptLayers, type SystemPromptLayers } from "../execution/prompt-layers.js";

const DEFAULT_REVIEWER_PROMPT = resolveAgentPrompt("reviewer");

describe("cross-session prompt cache integration", () => {
  const MEMORY_INSTRUCTIONS = "\n## Memory\n\nUse fn_memory_search to look up relevant context.";

  function simulateReviewerSession(sessionIndex: number): SystemPromptLayers {
    return buildPromptLayers({
      basePrompt: DEFAULT_REVIEWER_PROMPT,
      agentInstructions: `Session ${sessionIndex}: custom instructions that vary per agent.`,
      memorySection: MEMORY_INSTRUCTIONS,
      pluginContributions: sessionIndex % 2 === 0
        ? "## Plugin: lint\n\nCheck lint rules."
        : "",
    });
  }

  it("produces byte-identical stable prefixes across 10 reviewer sessions", () => {
    const sessions = Array.from({ length: 10 }, (_, i) => simulateReviewerSession(i));

    const stablePrefix = sessions[0].stable;
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i].stable).toBe(stablePrefix);
    }
  });

  it("dynamic layers vary across sessions as expected", () => {
    const sessions = Array.from({ length: 5 }, (_, i) => simulateReviewerSession(i));

    const uniqueDynamics = new Set(sessions.map((s) => s.dynamic));
    expect(uniqueDynamics.size).toBeGreaterThan(1);
  });

  it("collapsed layers produce valid non-empty strings", () => {
    const sessions = Array.from({ length: 5 }, (_, i) => simulateReviewerSession(i));

    for (const session of sessions) {
      const collapsed = collapsePromptLayers(session);
      expect(collapsed.length).toBeGreaterThan(0);
      expect(collapsed).toContain("independent code and plan reviewer");
    }
  });

  it("stable prefix starts with the canonical default reviewer prompt", () => {
    const layers = simulateReviewerSession(0);
    expect(layers.stable.startsWith(DEFAULT_REVIEWER_PROMPT)).toBe(true);
  });
});
