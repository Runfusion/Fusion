import { describe, it, expect } from "vitest";
import {
  type SystemPromptLayers,
  buildPromptLayers,
  collapsePromptLayers,
} from "../execution/prompt-layers.js";

describe("buildPromptLayers", () => {
  it("separates base prompt into stable layer", () => {
    const layers = buildPromptLayers({
      basePrompt: "You are a reviewer.",
    });

    expect(layers.stable).toBe("You are a reviewer.");
    expect(layers.dynamic).toBe("");
  });

  it("puts agent instructions into dynamic layer", () => {
    const layers = buildPromptLayers({
      basePrompt: "You are a reviewer.",
      agentInstructions: "Always check for SQL injection.",
    });

    expect(layers.stable).toBe("You are a reviewer.");
    expect(layers.dynamic).toContain("Always check for SQL injection.");
  });

  it("puts memory section into dynamic layer", () => {
    const layers = buildPromptLayers({
      basePrompt: "You are a reviewer.",
      memorySection: "## Agent Memory\n\nRemember to check tests.",
    });

    expect(layers.stable).toBe("You are a reviewer.");
    expect(layers.dynamic).toContain("Agent Memory");
  });

  it("puts plugin contributions into dynamic layer", () => {
    const layers = buildPromptLayers({
      basePrompt: "You are a reviewer.",
      pluginContributions: "## Plugin: security\n\nScan for CVEs.",
    });

    expect(layers.stable).toBe("You are a reviewer.");
    expect(layers.dynamic).toContain("security");
  });

  it("puts performance feedback into dynamic layer", () => {
    const layers = buildPromptLayers({
      basePrompt: "You are a reviewer.",
      performanceFeedback: "## Performance Feedback\n\n- Average score: 8.5",
    });

    expect(layers.stable).toBe("You are a reviewer.");
    expect(layers.dynamic).toContain("Performance Feedback");
  });

  it("combines multiple dynamic sections with double newlines", () => {
    const layers = buildPromptLayers({
      basePrompt: "Base.",
      agentInstructions: "Instructions.",
      memorySection: "Memory.",
      pluginContributions: "Plugins.",
    });

    expect(layers.dynamic).toBe(
      "Memory.\n\n## Custom Instructions\n\nInstructions.\n\nPlugins."
    );
  });

  it("omits empty dynamic sections", () => {
    const layers = buildPromptLayers({
      basePrompt: "Base.",
      agentInstructions: "",
      memorySection: "",
      pluginContributions: "Plugins.",
    });

    expect(layers.dynamic).toBe("Plugins.");
    expect(layers.dynamic).not.toContain("Custom Instructions");
  });

  it("produces deterministic output for identical inputs", () => {
    const input = {
      basePrompt: "Base.",
      agentInstructions: "Inst.",
      memorySection: "Mem.",
      pluginContributions: "Plug.",
      performanceFeedback: "Perf.",
    };

    const layers1 = buildPromptLayers(input);
    const layers2 = buildPromptLayers(input);

    expect(layers1.stable).toBe(layers2.stable);
    expect(layers1.dynamic).toBe(layers2.dynamic);
  });
});

describe("collapsePromptLayers", () => {
  it("returns stable when dynamic is empty", () => {
    const result = collapsePromptLayers({ stable: "Base.", dynamic: "" });
    expect(result).toBe("Base.");
  });

  it("joins stable and dynamic with double newline", () => {
    const result = collapsePromptLayers({
      stable: "Base.",
      dynamic: "Dynamic.",
    });
    expect(result).toBe("Base.\n\nDynamic.");
  });

  it("matches legacy buildSystemPromptWithInstructions output", () => {
    const layers = buildPromptLayers({
      basePrompt: "You are a reviewer.",
      agentInstructions: "Check for bugs.",
    });
    const collapsed = collapsePromptLayers(layers);

    expect(collapsed).toBe(
      "You are a reviewer.\n\n## Custom Instructions\n\nCheck for bugs."
    );
  });
});
