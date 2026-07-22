import { describe, it, expect } from "vitest";
import type { AgentRuntimeOptions } from "../agents/agent-runtime.js";
import type { SystemPromptLayers } from "../execution/prompt-layers.js";

describe("AgentRuntimeOptions.systemPromptLayers", () => {
  it("accepts systemPromptLayers alongside systemPrompt", () => {
    const layers: SystemPromptLayers = {
      stable: "You are a reviewer.",
      dynamic: "Check for bugs.",
    };

    const options: AgentRuntimeOptions = {
      cwd: "/tmp/test",
      systemPrompt: "You are a reviewer.\n\nCheck for bugs.",
      systemPromptLayers: layers,
    };

    expect(options.systemPromptLayers).toBeDefined();
    expect(options.systemPromptLayers!.stable).toBe("You are a reviewer.");
    expect(options.systemPromptLayers!.dynamic).toBe("Check for bugs.");
  });

  it("works without systemPromptLayers (backward compatible)", () => {
    const options: AgentRuntimeOptions = {
      cwd: "/tmp/test",
      systemPrompt: "You are a reviewer.",
    };

    expect(options.systemPromptLayers).toBeUndefined();
  });
});
