import { describe, it, expect } from "vitest";
import { buildSystemPromptWithInstructions } from "../agents/agent-instructions.js";
import { buildPromptLayers, collapsePromptLayers, withRequestVolatileContext, SESSION_CONTEXT_HEADING } from "../execution/prompt-layers.js";

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
    /*
    FNXC:PromptByteStability 2026-09-24-02:10 (RUFU-267):
    This case used to assert that the reviewer's retrieved MEMORY.md BODY sat in the dynamic layer,
    ahead of the agent instructions. That contract is retired: a retrieved memory body changes whenever
    any agent writes memory, so two consecutive reviews of one task diverged at that block and the
    provider prefix cache covered only the role head. `memorySection` is no longer a `buildPromptLayers`
    input at all (the blocking guard refuses it). The rewritten case pins what replaced it: the static
    memory-USE guidance keeps its memory → instructions → plugins order inside the serialized prompt,
    while the retrieved body rides the request tail and never enters the layers.
    */
    it("keeps memory guidance ordered ahead of instructions and the retrieved memory body outside the prompt layers", () => {
      const basePrompt = "You are an independent code and plan reviewer.";
      const memoryInstructions = "## Memory\n\nUse fn_memory_search.";
      const memoryBody = "## Memory\n\n- Reviewed FN-1201 on 2026-09-20.";
      const agentInstructions = "Focus on security.";
      const plugins = "## Plugin: lint\n\nCheck eslint.";

      const layers = buildPromptLayers({
        basePrompt,
        agentInstructions,
        memoryInstructions,
        pluginContributions: plugins,
      });
      const result = collapsePromptLayers(layers);

      // Base prompt is the stable layer (no memory of any kind)
      expect(layers.stable).toBe(basePrompt);

      // Serialized prompt preserves: memory guidance → instructions → plugins ordering
      const memoryIdx = result.indexOf("## Memory");
      const instructionsIdx = result.indexOf("## Custom Instructions");
      const pluginsIdx = result.indexOf("## Plugin:");
      expect(memoryIdx).toBeGreaterThan(0);
      expect(instructionsIdx).toBeGreaterThan(memoryIdx);
      expect(pluginsIdx).toBeGreaterThan(instructionsIdx);

      // The volatile memory body is never part of the serialized system prompt.
      expect(result).not.toContain("FN-1201");

      // It rides the request tail instead, so it still reaches the model per request.
      const tail = withRequestVolatileContext("Review task FN-1202.", { memorySection: memoryBody });
      expect(tail.startsWith(result)).toBe(false);
      expect(tail).toContain("FN-1201");
      expect(tail).toContain(SESSION_CONTEXT_HEADING);

      // And the serialized head is byte-stable across memory-body changes.
      const otherBody = "## Memory\n\n- Reviewed FN-1203 on 2026-09-21.";
      expect(collapsePromptLayers(layers)).toBe(result);
      expect(withRequestVolatileContext("Review task FN-1202.", { memorySection: otherBody }))
        .not.toBe(tail);
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
