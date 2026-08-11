import { describe, expect, it } from "vitest";
import {
  getPrimaryWorkflowRole,
  resolvePermanentAgentEffectiveModel,
  resolvePermanentAgentEffectiveThinkingLevel,
} from "../ai/agent-effective-model.js";

const builtIn = (role: "triage" | "executor" | "reviewer" | "merger", runtimeConfig?: Record<string, unknown>) => ({
  role,
  roles: [role],
  metadata: { builtInWorkflowRole: true, workflowRole: role },
  runtimeConfig,
});

describe("permanent agent effective model inheritance", () => {
  it("uses the project override for every built-in workflow role when lanes are empty", () => {
    const settings = {
      defaultProviderOverride: "anthropic",
      defaultModelIdOverride: "claude-project",
      defaultProvider: "openai",
      defaultModelId: "gpt-global",
    };

    for (const role of ["triage", "executor", "reviewer", "merger"] as const) {
      expect(resolvePermanentAgentEffectiveModel(builtIn(role, { enabled: false }), settings)).toEqual({
        provider: "anthropic",
        modelId: "claude-project",
      });
    }
  });

  it("selects role lanes before project defaults and retains legacy role discovery", () => {
    const settings = {
      planningProvider: "planning-provider",
      planningModelId: "planning-model",
      executionProvider: "execution-provider",
      executionModelId: "execution-model",
      validatorProvider: "validator-provider",
      validatorModelId: "validator-model",
      mergerProvider: "merger-provider",
      mergerModelId: "merger-model",
      defaultProviderOverride: "project-provider",
      defaultModelIdOverride: "project-model",
    };
    const expected = {
      triage: ["planning-provider", "planning-model"],
      executor: ["execution-provider", "execution-model"],
      reviewer: ["validator-provider", "validator-model"],
      merger: ["merger-provider", "merger-model"],
    } as const;

    for (const role of ["triage", "executor", "reviewer", "merger"] as const) {
      expect(resolvePermanentAgentEffectiveModel({ role, runtimeConfig: {} }, settings)).toEqual({
        provider: expected[role][0],
        modelId: expected[role][1],
      });
    }
    expect(getPrimaryWorkflowRole({ roles: ["executor", "merger"] })).toBe("executor");
  });

  it("keeps complete agent model overrides but ignores incomplete pairs", () => {
    const settings = { defaultProviderOverride: "project-provider", defaultModelIdOverride: "project-model" };
    expect(resolvePermanentAgentEffectiveModel(builtIn("merger", {
      modelProvider: "agent-provider",
      modelId: "agent-model",
    }), settings)).toEqual({ provider: "agent-provider", modelId: "agent-model" });
    expect(resolvePermanentAgentEffectiveModel(builtIn("merger", { modelProvider: "partial-provider" }), settings)).toEqual({
      provider: "project-provider",
      modelId: "project-model",
    });
  });

  it("preserves the mock test-mode resolver result", () => {
    expect(resolvePermanentAgentEffectiveModel(builtIn("merger", { enabled: false }), {
      testMode: true,
      mergerProvider: "real-provider",
      mergerModelId: "real-model",
    })).toEqual({ provider: "mock", modelId: "scripted" });
  });

  it("resolves thinking from explicit session, agent, role lane, project, then global defaults", () => {
    const settings = {
      planningThinkingLevel: "low",
      executionThinkingLevel: "medium",
      validatorThinkingLevel: "high",
      mergerThinkingLevel: "xhigh",
      defaultThinkingLevelOverride: "minimal",
      defaultThinkingLevel: "off",
    };
    expect(resolvePermanentAgentEffectiveThinkingLevel(builtIn("triage", {}), settings)).toBe("low");
    expect(resolvePermanentAgentEffectiveThinkingLevel(builtIn("executor", {}), settings)).toBe("medium");
    expect(resolvePermanentAgentEffectiveThinkingLevel(builtIn("reviewer", {}), settings)).toBe("high");
    expect(resolvePermanentAgentEffectiveThinkingLevel(builtIn("merger", {}), settings)).toBe("xhigh");
    expect(resolvePermanentAgentEffectiveThinkingLevel(builtIn("merger", { thinkingLevel: "minimal" }), settings)).toBe("minimal");
    expect(resolvePermanentAgentEffectiveThinkingLevel(builtIn("merger", { thinkingLevel: "minimal" }), settings, "off")).toBe("off");
  });
});
