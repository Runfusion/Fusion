import { describe, it, expect } from "vitest";
import { buildSystemPromptWithInstructions } from "../agent-instructions.js";
import { buildPromptLayers, collapsePromptLayers } from "../prompt-layers.js";

/**
 * Backward compatibility tests: verify that the new layered prompt approach
 * produces byte-identical output to the legacy buildSystemPromptWithInstructions
 * + manual concatenation pattern used by each subsystem.
 */
describe("prompt layers backward compatibility", () => {
  describe("collapsed layers match buildSystemPromptWithInstructions", () => {
    it("matches when only base prompt is provided", () => {
      const basePrompt = "You are a reviewer.";

      const oldResult = buildSystemPromptWithInstructions(basePrompt, "");
      const layers = buildPromptLayers({ basePrompt });
      const newResult = collapsePromptLayers(layers);

      expect(newResult).toBe(oldResult);
    });

    it("matches with base prompt and instructions", () => {
      const basePrompt = "You are a reviewer.";
      const instructions = "Check for SQL injection.";

      const oldResult = buildSystemPromptWithInstructions(basePrompt, instructions);
      const layers = buildPromptLayers({
        basePrompt,
        agentInstructions: instructions,
      });
      const newResult = collapsePromptLayers(layers);

      expect(newResult).toBe(oldResult);
    });

    it("matches with base prompt, instructions, and plugin contributions", () => {
      const basePrompt = "You are an executor.";
      const instructions = "Follow TDD.";
      const plugins = "## Plugin: security\n\nScan for vulnerabilities.";

      // Old approach: buildSystemPromptWithInstructions + manual concatenation
      const oldSystemPrompt = buildSystemPromptWithInstructions(basePrompt, instructions);
      const oldResult = `${oldSystemPrompt}\n\n${plugins}`;

      // New approach: buildPromptLayers + collapsePromptLayers
      const layers = buildPromptLayers({
        basePrompt,
        agentInstructions: instructions,
        pluginContributions: plugins,
      });
      const newResult = collapsePromptLayers(layers);

      expect(newResult).toBe(oldResult);
    });

    it("matches with empty instructions and plugin contributions", () => {
      const basePrompt = "You are a triage agent.";
      const plugins = "## Plugin: research\n\nUse web search.";

      // Old approach: buildSystemPromptWithInstructions returns base (empty instructions)
      // then plugins appended
      const oldSystemPrompt = buildSystemPromptWithInstructions(basePrompt, "");
      const oldResult = `${oldSystemPrompt}\n\n${plugins}`;

      const layers = buildPromptLayers({
        basePrompt,
        pluginContributions: plugins,
      });
      const newResult = collapsePromptLayers(layers);

      expect(newResult).toBe(oldResult);
    });

    it("matches with empty instructions and no plugins", () => {
      const basePrompt = "You are a heartbeat agent.";

      const oldResult = buildSystemPromptWithInstructions(basePrompt, "");
      const layers = buildPromptLayers({ basePrompt });
      const newResult = collapsePromptLayers(layers);

      expect(newResult).toBe(oldResult);
    });
  });

  describe("reviewer assembly pattern", () => {
    it("produces the expected reviewer prompt with memory in dynamic layer", () => {
      const basePrompt = "You are an independent code and plan reviewer.";
      const memoryInstructions = "\n## Memory\n\nUse fn_memory_search.";
      const agentInstructions = "Focus on security.";
      const plugins = "## Plugin: lint\n\nCheck eslint.";

      // New reviewer pattern: memory goes in dynamic layer (not stable) so
      // the stable prefix is byte-identical across sessions even when memory
      // changes mid-task.
      const layers = buildPromptLayers({
        basePrompt,
        agentInstructions,
        memorySection: memoryInstructions,
        pluginContributions: plugins,
      });
      const result = collapsePromptLayers(layers);

      // Base prompt is the stable layer
      expect(layers.stable).toBe(basePrompt);
      // Dynamic layer contains instructions, memory, and plugins
      expect(result).toContain(agentInstructions);
      expect(result).toContain("Memory");
      expect(result).toContain(plugins);
    });
  });

  describe("executor assembly pattern", () => {
    it("reproduces the executor prompt assembly", () => {
      const basePrompt = "You are a task execution agent.";
      const agentInstructions = "Follow the spec precisely.";
      const plugins = "## Plugin: deploy\n\nCheck CI status.";

      // Old executor pattern:
      // 1. buildSystemPromptWithInstructions(base, instructions)
      // 2. if plugins: concatenate
      const oldSystemPrompt = buildSystemPromptWithInstructions(
        basePrompt,
        agentInstructions,
      );
      const oldResult = `${oldSystemPrompt}\n\n${plugins}`;

      const layers = buildPromptLayers({
        basePrompt,
        agentInstructions,
        pluginContributions: plugins,
      });
      const newResult = collapsePromptLayers(layers);

      expect(newResult).toBe(oldResult);
    });
  });

  describe("heartbeat assembly pattern", () => {
    it("reproduces the heartbeat prompt assembly with multi-part instructions", () => {
      const basePrompt = "You are a heartbeat agent.";
      const identitySection = "## Identity\n\nYou are Agent-1.";
      const memoryInstructions = "## Memory\n\nUse memory tools.";
      const selfImprovePrompt = "## Self-Improvement\n\nReview your performance.";

      // Old heartbeat pattern:
      // 1. Join identity + memory + selfImprove with \n\n
      // 2. buildSystemPromptWithInstructions(base, joined)
      // 3. if plugins: concatenate
      const joinedInstructions = [identitySection, memoryInstructions, selfImprovePrompt]
        .filter((part) => part.trim())
        .join("\n\n");
      const oldResult = buildSystemPromptWithInstructions(basePrompt, joinedInstructions);

      const layers = buildPromptLayers({
        basePrompt,
        agentInstructions: joinedInstructions,
      });
      const newResult = collapsePromptLayers(layers);

      expect(newResult).toBe(oldResult);
    });
  });

  describe("triage assembly pattern", () => {
    it("reproduces the triage prompt assembly with multi-part instructions", () => {
      const basePrompt = "You are a task specification agent.";
      const identitySection = "## Identity\n\nYou are TriageBot.";
      const triageInstructions = "Be thorough.";
      const researchGuidance = "## Research\n\nUse web search when needed.";

      // Old triage pattern:
      // 1. Join identity + instructions + research with \n\n
      // 2. buildSystemPromptWithInstructions(base, joined)
      const joinedInstructions = [identitySection, triageInstructions, researchGuidance]
        .filter((section) => section.trim())
        .join("\n\n");
      const oldResult = buildSystemPromptWithInstructions(basePrompt, joinedInstructions);

      const layers = buildPromptLayers({
        basePrompt,
        agentInstructions: joinedInstructions,
      });
      const newResult = collapsePromptLayers(layers);

      expect(newResult).toBe(oldResult);
    });
  });
});
