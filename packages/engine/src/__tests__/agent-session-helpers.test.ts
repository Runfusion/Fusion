import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractRuntimeHint,
  extractRuntimeModel,
  resolveExecutorSessionModel,
  resolveExecutorThinkingLevel,
  resolveExecutorFallbackThinkingLevel,
  resolveHeartbeatSessionModels,
  resolveImplicitPlanningFallbackModel,
  resolveMergerSessionModel,
  resolveMergerThinkingLevel,
  resolveMergerFallbackThinkingLevel,
  resolvePlanningSessionModel,
  resolvePlanningThinkingLevel,
  resolvePlanningFallbackThinkingLevel,
  resolveTitleSummarizerThinkingLevel,
  resolveTitleSummarizerFallbackThinkingLevel,
  resolveValidatorSessionModel,
  resolveValidatorThinkingLevel,
  resolveValidatorFallbackThinkingLevel,
  wrapCustomToolsForPluginRuntime,
} from "../agent-session-helpers.js";

const { resolveRuntimeMock } = vi.hoisted(() => ({
  resolveRuntimeMock: vi.fn(),
}));

vi.mock("../runtime-resolution.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-resolution.js")>("../runtime-resolution.js");
  return {
    ...actual,
    resolveRuntime: resolveRuntimeMock,
  };
});


describe("non-pi custom tool wrapping", () => {
  it("preserves chat fusion tool names without an action-gate context", () => {
    const tools = [
      { name: "fn_task_list", description: "List tasks", parameters: {}, execute: async () => ({}) },
      { name: "fn_delegate_task", description: "Delegate a task", parameters: {}, execute: async () => ({}) },
      { name: "fn_list_agents", description: "List agents", parameters: {}, execute: async () => ({}) },
      { name: "fn_web_fetch", description: "Fetch a URL", parameters: {}, execute: async () => ({}) },
    ] as any;

    expect(wrapCustomToolsForPluginRuntime(tools, {}, { runtimeId: "grok", sessionPurpose: "heartbeat" })?.map((tool) => tool.name))
      .toEqual(tools.map((tool: { name: string }) => tool.name));
  });
});

describe("resolve model-lane thinking levels", () => {
  it("applies node/task > workflow execution lane > global lane > project default lane > global default precedence", () => {
    const settings = {
      defaultThinkingLevel: "low",
      defaultThinkingLevelOverride: "medium",
      executionGlobalThinkingLevel: "high",
      executionThinkingLevel: "minimal",
    } as const;

    expect(resolveExecutorThinkingLevel("xhigh", settings)).toBe("xhigh");
    expect(resolveExecutorThinkingLevel(undefined, settings)).toBe("minimal");
    expect(resolveExecutorThinkingLevel(undefined, { executionGlobalThinkingLevel: "high", defaultThinkingLevel: "low" })).toBe("high");
    expect(resolveExecutorThinkingLevel(undefined, { defaultThinkingLevelOverride: "medium", defaultThinkingLevel: "low" })).toBe("medium");
    expect(resolveExecutorThinkingLevel(undefined, { defaultThinkingLevel: "low" })).toBe("low");
  });

  it("resolves planning, reviewer, and summarization lane overrides before the global default", () => {
    expect(resolvePlanningThinkingLevel({ planningThinkingLevel: "low", planningGlobalThinkingLevel: "minimal", defaultThinkingLevel: "high" })).toBe("low");
    expect(resolvePlanningThinkingLevel({ planningThinkingLevel: "low", defaultThinkingLevel: "high" }, "xhigh")).toBe("xhigh");
    expect(resolveValidatorThinkingLevel(undefined, { validatorThinkingLevel: "minimal", validatorGlobalThinkingLevel: "medium", defaultThinkingLevel: "low" })).toBe("minimal");
    expect(resolveValidatorThinkingLevel("xhigh", { validatorThinkingLevel: "minimal", validatorGlobalThinkingLevel: "medium", defaultThinkingLevel: "low" })).toBe("xhigh");
    expect(resolveTitleSummarizerThinkingLevel({
      titleSummarizerThinkingLevel: "high",
      titleSummarizerGlobalThinkingLevel: "medium",
      defaultThinkingLevel: "low",
    })).toBe("high");
    expect(resolveTitleSummarizerThinkingLevel({
      titleSummarizerGlobalThinkingLevel: "medium",
      defaultThinkingLevelOverride: "minimal",
      defaultThinkingLevel: "low",
    })).toBe("medium");
  });

  it("documents caller precedence for per-task planning and validator thinking overrides", () => {
    const settings = { planningThinkingLevel: "minimal", validatorThinkingLevel: "low", defaultThinkingLevel: "off" } as const;
    const task = { thinkingLevel: "medium", planningThinkingLevel: "high", validatorThinkingLevel: "xhigh" } as const;

    expect(resolvePlanningThinkingLevel(settings, task.planningThinkingLevel ?? task.thinkingLevel)).toBe("high");
    expect(resolveValidatorThinkingLevel(task.validatorThinkingLevel ?? task.thinkingLevel, settings)).toBe("xhigh");

    const legacyTask = { thinkingLevel: "medium", planningThinkingLevel: undefined, validatorThinkingLevel: undefined } as const;
    expect(resolvePlanningThinkingLevel(settings, legacyTask.planningThinkingLevel ?? legacyTask.thinkingLevel)).toBe("medium");
    expect(resolveValidatorThinkingLevel(legacyTask.validatorThinkingLevel ?? legacyTask.thinkingLevel, settings)).toBe("medium");

    const nodeThinkingLevel = "minimal" as const;
    expect(resolveValidatorThinkingLevel(nodeThinkingLevel ?? task.validatorThinkingLevel ?? task.thinkingLevel, settings)).toBe("minimal");
  });

  it("resolves fallback thinking through fallback key then executor lane then defaults", () => {
    expect(resolveExecutorFallbackThinkingLevel("task", { fallbackThinkingLevel: "high", executionThinkingLevel: "low" })).toBe("high");
    expect(resolveExecutorFallbackThinkingLevel(undefined, { executionThinkingLevel: "minimal", defaultThinkingLevel: "low" })).toBe("minimal");
    expect(resolveExecutorFallbackThinkingLevel(undefined, { defaultThinkingLevelOverride: "medium", defaultThinkingLevel: "low" })).toBe("medium");
    expect(resolveExecutorFallbackThinkingLevel(undefined, { defaultThinkingLevel: "low" })).toBe("low");
  });

  it("resolves workflow fallback thinking before global fallback then lane defaults", () => {
    expect(resolvePlanningFallbackThinkingLevel({ planningFallbackThinkingLevel: "xhigh", fallbackThinkingLevel: "high", planningThinkingLevel: "low" })).toBe("xhigh");
    expect(resolvePlanningFallbackThinkingLevel({ fallbackThinkingLevel: "high", planningThinkingLevel: "low" })).toBe("high");
    expect(resolvePlanningFallbackThinkingLevel({ planningThinkingLevel: "low", defaultThinkingLevel: "minimal" })).toBe("low");
    expect(resolvePlanningFallbackThinkingLevel({ defaultThinkingLevelOverride: "medium", defaultThinkingLevel: "minimal" })).toBe("medium");
    expect(resolvePlanningFallbackThinkingLevel({ defaultThinkingLevel: "minimal" })).toBe("minimal");

    expect(resolveValidatorFallbackThinkingLevel(undefined, { validatorFallbackThinkingLevel: "xhigh", fallbackThinkingLevel: "high", validatorThinkingLevel: "low" })).toBe("xhigh");
    expect(resolveValidatorFallbackThinkingLevel(undefined, { fallbackThinkingLevel: "high", validatorThinkingLevel: "low" })).toBe("high");
    expect(resolveValidatorFallbackThinkingLevel(undefined, { validatorThinkingLevel: "low", defaultThinkingLevel: "minimal" })).toBe("low");
    expect(resolveValidatorFallbackThinkingLevel(undefined, { defaultThinkingLevelOverride: "medium", defaultThinkingLevel: "minimal" })).toBe("medium");
    expect(resolveValidatorFallbackThinkingLevel(undefined, { defaultThinkingLevel: "minimal" })).toBe("minimal");
  });

  it("resolves title summarizer and merger fallback thinking through fallback and default chains", () => {
    expect(resolveTitleSummarizerFallbackThinkingLevel({ titleSummarizerFallbackThinkingLevel: "xhigh", fallbackThinkingLevel: "high", titleSummarizerThinkingLevel: "low" })).toBe("xhigh");
    expect(resolveTitleSummarizerFallbackThinkingLevel({ fallbackThinkingLevel: "high", titleSummarizerThinkingLevel: "low" })).toBe("high");
    expect(resolveTitleSummarizerFallbackThinkingLevel({ titleSummarizerThinkingLevel: "low", defaultThinkingLevel: "minimal" })).toBe("low");
    expect(resolveTitleSummarizerFallbackThinkingLevel({ defaultThinkingLevelOverride: "medium", defaultThinkingLevel: "minimal" })).toBe("medium");
    expect(resolveTitleSummarizerFallbackThinkingLevel({ defaultThinkingLevel: "minimal" })).toBe("minimal");

    expect(resolveMergerFallbackThinkingLevel({ mergerFallbackThinkingLevel: "xhigh", fallbackThinkingLevel: "high", mergerThinkingLevel: "medium" })).toBe("xhigh");
    expect(resolveMergerFallbackThinkingLevel({ fallbackThinkingLevel: "high", defaultThinkingLevel: "low" })).toBe("high");
    expect(resolveMergerFallbackThinkingLevel({ defaultThinkingLevelOverride: "medium", defaultThinkingLevel: "low" })).toBe("medium");
    expect(resolveMergerFallbackThinkingLevel({ defaultThinkingLevel: "low" })).toBe("low");
  });

  it("applies project merger thinking > global merger thinking > default thinking for merger sessions", () => {
    expect(resolveMergerThinkingLevel({
      mergerThinkingLevel: "xhigh",
      mergerGlobalThinkingLevel: "high",
      defaultThinkingLevelOverride: "medium",
      defaultThinkingLevel: "low",
    })).toBe("xhigh");
    expect(resolveMergerThinkingLevel({
      mergerGlobalThinkingLevel: "high",
      defaultThinkingLevelOverride: "medium",
      defaultThinkingLevel: "low",
    })).toBe("high");
    expect(resolveMergerThinkingLevel({
      defaultThinkingLevelOverride: "medium",
      defaultThinkingLevel: "low",
    })).toBe("medium");
    expect(resolveMergerThinkingLevel({ defaultThinkingLevel: "low" })).toBe("low");
  });
});

describe("extractRuntimeHint", () => {
  it("returns undefined for undefined config", () => {
    expect(extractRuntimeHint(undefined)).toBeUndefined();
  });

  it("returns undefined when runtimeHint key is missing", () => {
    expect(extractRuntimeHint({})).toBeUndefined();
  });

  it("returns normalized runtime hint when configured", () => {
    expect(extractRuntimeHint({ runtimeHint: " openclaw " })).toBe("openclaw");
  });

  it("returns undefined for whitespace-only runtimeHint", () => {
    expect(extractRuntimeHint({ runtimeHint: "   " })).toBeUndefined();
  });

  it("returns undefined for non-string runtimeHint", () => {
    expect(extractRuntimeHint({ runtimeHint: 42 })).toBeUndefined();
  });
});

describe("extractRuntimeModel", () => {
  it("parses combined and separate runtime model pairs", () => {
    expect(extractRuntimeModel({ model: " anthropic/claude-sonnet-4-5 " })).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(extractRuntimeModel({ modelProvider: " openai ", modelId: " gpt-4.1 " })).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
  });

  it("does not turn malformed combined strings into complete model pairs", () => {
    expect(extractRuntimeModel({ model: "gpt 5.3" })).toEqual({
      provider: undefined,
      modelId: undefined,
    });
  });
});

describe("resolve session model parity", () => {
  const settings = {
    executionProvider: "openai",
    executionModelId: "gpt-4.1",
    planningProvider: "anthropic",
    planningModelId: "claude-sonnet-4-5",
    defaultProviderOverride: "google",
    defaultModelIdOverride: "gemini-2.5-pro",
    defaultProvider: "zai",
    defaultModelId: "glm-5.1",
  };

  it("uses the same fresh settings model for executor and heartbeat when runtimeConfig is absent", () => {
    const executor = resolveExecutorSessionModel(undefined, undefined, settings);
    const heartbeat = resolveHeartbeatSessionModels(settings);

    expect(executor).toEqual({ provider: "openai", modelId: "gpt-4.1" });
    expect(heartbeat).toEqual({
      defaultProvider: executor.provider,
      defaultModelId: executor.modelId,
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
  });

  it("ignores partial runtimeConfig pairs without mixing runtime and settings fields", () => {
    expect(resolveHeartbeatSessionModels(
      {
        executionProvider: "openai",
        executionModelId: "gpt-4.1",
      },
      { modelProvider: "stale-provider" },
    )).toEqual({
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });

    expect(resolveHeartbeatSessionModels(
      {
        executionProvider: "openai",
        executionModelId: "gpt-4.1",
      },
      { modelId: "gpt 5.3" },
    )).toEqual({
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
  });

  it("does not let a stale complete runtime model mask newer task or settings models outside heartbeat", () => {
    const staleRuntimeConfig = { model: "openai-codex/gpt-5.3-codex" };

    expect(resolveExecutorSessionModel("task-provider", "task-model", settings, staleRuntimeConfig)).toEqual({
      provider: "task-provider",
      modelId: "task-model",
    });
    expect(resolveExecutorSessionModel(undefined, undefined, settings, staleRuntimeConfig)).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
    expect(resolvePlanningSessionModel("planning-task-provider", "planning-task-model", settings, staleRuntimeConfig)).toEqual({
      provider: "planning-task-provider",
      modelId: "planning-task-model",
    });
    expect(resolvePlanningSessionModel(undefined, undefined, settings, staleRuntimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(resolveValidatorSessionModel("validator-task-provider", "validator-task-model", settings, staleRuntimeConfig)).toEqual({
      provider: "validator-task-provider",
      modelId: "validator-task-model",
    });
    expect(resolveValidatorSessionModel(undefined, undefined, {
      ...settings,
      validatorProvider: "google",
      validatorModelId: "gemini-2.5-pro",
    }, staleRuntimeConfig)).toEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
    expect(resolveMergerSessionModel(settings, staleRuntimeConfig)).toEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
  });

  it("uses the durable agent's complete assigned model for heartbeat instead of shared execution settings", () => {
    expect(resolveHeartbeatSessionModels(
      {
        defaultProviderOverride: "anthropic",
        defaultModelIdOverride: "claude-sonnet-5",
        defaultProvider: "openai-codex",
        defaultModelId: "gpt-5.5",
      },
      { modelProvider: "grok-cli", modelId: "grok-4.5", model: "grok-cli/grok-4.5" },
    )).toEqual({
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
  });

  it("does not leak malformed gpt 5.3-style runtimeConfig into any automatic lane", () => {
    const malformedRuntimeConfig = { modelId: "gpt 5.3" };

    expect(resolveExecutorSessionModel(undefined, undefined, settings, malformedRuntimeConfig)).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
    expect(resolvePlanningSessionModel(undefined, undefined, settings, malformedRuntimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(resolveHeartbeatSessionModels(settings, malformedRuntimeConfig)).toEqual({
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
    expect(resolveValidatorSessionModel(undefined, undefined, settings, malformedRuntimeConfig)).toEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
    expect(resolveMergerSessionModel(settings, malformedRuntimeConfig)).toEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
  });

  it("falls back through project override and global defaults before runtimeConfig", () => {
    const staleRuntimeConfig = { model: "stale-provider/stale-model" };

    expect(resolveMergerSessionModel({
      defaultProviderOverride: "google",
      defaultModelIdOverride: "gemini-2.5-pro",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    }, staleRuntimeConfig)).toEqual({ provider: "google", modelId: "gemini-2.5-pro" });
    expect(resolveMergerSessionModel({
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    }, staleRuntimeConfig)).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });

  it("prefers the dedicated merger lane over default and other AI role lanes", () => {
    const staleRuntimeConfig = { model: "stale-provider/stale-model" };

    expect(resolveMergerSessionModel({
      mergerProvider: "merger-project-provider",
      mergerModelId: "merger-project-model",
      mergerGlobalProvider: "merger-global-provider",
      mergerGlobalModelId: "merger-global-model",
      executionProvider: "openai",
      executionModelId: "gpt-4.1",
      defaultProviderOverride: "google",
      defaultModelIdOverride: "gemini-2.5-pro",
    }, staleRuntimeConfig)).toEqual({
      provider: "merger-project-provider",
      modelId: "merger-project-model",
    });

    expect(resolveMergerSessionModel({
      mergerGlobalProvider: "merger-global-provider",
      mergerGlobalModelId: "merger-global-model",
      planningProvider: "anthropic",
      planningModelId: "claude-sonnet-4-5",
      defaultProviderOverride: "google",
      defaultModelIdOverride: "gemini-2.5-pro",
    }, staleRuntimeConfig)).toEqual({
      provider: "merger-global-provider",
      modelId: "merger-global-model",
    });
  });

  it("uses a complete runtime model only when no lane/task/default model is configured", () => {
    const runtimeConfig = { modelProvider: "anthropic", modelId: "claude-opus-4" };

    expect(resolveExecutorSessionModel(undefined, undefined, undefined, runtimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4",
    });
    expect(resolvePlanningSessionModel(undefined, undefined, undefined, runtimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4",
    });
    expect(resolveHeartbeatSessionModels(undefined, runtimeConfig)).toEqual({
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus-4",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
    expect(resolveValidatorSessionModel(undefined, undefined, undefined, runtimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4",
    });
    expect(resolveMergerSessionModel(undefined, runtimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4",
    });
  });

  it("covers backend-only surfaces; desktop and mobile breakpoints are not applicable", () => {
    expect(resolveExecutorSessionModel(undefined, undefined, settings, { model: "stale/old" })).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
    expect(resolvePlanningSessionModel(undefined, undefined, settings, { model: "stale/old" })).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(resolveValidatorSessionModel(undefined, undefined, settings, { model: "stale/old" })).toEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
    expect(resolveMergerSessionModel(settings, { model: "stale/old" })).toEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
  });
});

describe("non-heartbeat project model override precedence invariant", () => {
  const staleRuntimeConfig = { model: "stale-provider/stale-model" };
  const partialRuntimeConfigs: Array<Record<string, unknown>> = [
    { modelProvider: "stale-provider" },
    { modelId: "stale-model" },
    { model: "stale-provider" },
  ];

  const sessionCases = [
    {
      label: "executor",
      settings: { executionProvider: "project-exec-provider", executionModelId: "project-exec-model" },
      resolve: (runtimeConfig?: Record<string, unknown>) =>
        resolveExecutorSessionModel(undefined, undefined, {
          executionProvider: "project-exec-provider",
          executionModelId: "project-exec-model",
        }, runtimeConfig),
      expected: { provider: "project-exec-provider", modelId: "project-exec-model" },
    },
    {
      label: "planning",
      settings: { planningProvider: "project-plan-provider", planningModelId: "project-plan-model" },
      resolve: (runtimeConfig?: Record<string, unknown>) =>
        resolvePlanningSessionModel(undefined, undefined, {
          planningProvider: "project-plan-provider",
          planningModelId: "project-plan-model",
        }, runtimeConfig),
      expected: { provider: "project-plan-provider", modelId: "project-plan-model" },
    },
    {
      label: "validator",
      settings: { validatorProvider: "project-validator-provider", validatorModelId: "project-validator-model" },
      resolve: (runtimeConfig?: Record<string, unknown>) =>
        resolveValidatorSessionModel(undefined, undefined, {
          validatorProvider: "project-validator-provider",
          validatorModelId: "project-validator-model",
        }, runtimeConfig),
      expected: { provider: "project-validator-provider", modelId: "project-validator-model" },
    },
    {
      label: "merger default lane",
      settings: { defaultProviderOverride: "project-default-provider", defaultModelIdOverride: "project-default-model" },
      resolve: (runtimeConfig?: Record<string, unknown>) =>
        resolveMergerSessionModel({
          defaultProviderOverride: "project-default-provider",
          defaultModelIdOverride: "project-default-model",
        }, runtimeConfig),
      expected: { provider: "project-default-provider", modelId: "project-default-model" },
    },
  ];

  it.each(sessionCases)("$label project override wins when runtimeConfig is absent, complete, or partial", ({ resolve, expected }) => {
    expect(resolve()).toEqual(expected);
    expect(resolve(staleRuntimeConfig)).toEqual(expected);
    for (const partialRuntimeConfig of partialRuntimeConfigs) {
      expect(resolve(partialRuntimeConfig)).toEqual(expected);
    }
  });

  it("per-task overrides still outrank saved project lane overrides", () => {
    const runtimeConfig = { model: "stale-provider/stale-model" };

    expect(resolveExecutorSessionModel("task-provider", "task-model", {
      executionProvider: "project-provider",
      executionModelId: "project-model",
    }, runtimeConfig)).toEqual({ provider: "task-provider", modelId: "task-model" });
    expect(resolvePlanningSessionModel("task-planning-provider", "task-planning-model", {
      planningProvider: "project-planning-provider",
      planningModelId: "project-planning-model",
    }, runtimeConfig)).toEqual({ provider: "task-planning-provider", modelId: "task-planning-model" });
    expect(resolveValidatorSessionModel("task-validator-provider", "task-validator-model", {
      validatorProvider: "project-validator-provider",
      validatorModelId: "project-validator-model",
    }, runtimeConfig)).toEqual({ provider: "task-validator-provider", modelId: "task-validator-model" });
  });

  it("falls back to global lanes and global defaults only when project lanes are unset", () => {
    const runtimeConfig = { model: "stale-provider/stale-model" };

    expect(resolveExecutorSessionModel(undefined, undefined, {
      executionGlobalProvider: "global-exec-provider",
      executionGlobalModelId: "global-exec-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    }, runtimeConfig)).toEqual({ provider: "global-exec-provider", modelId: "global-exec-model" });
    expect(resolvePlanningSessionModel(undefined, undefined, {
      planningGlobalProvider: "global-plan-provider",
      planningGlobalModelId: "global-plan-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    }, runtimeConfig)).toEqual({ provider: "global-plan-provider", modelId: "global-plan-model" });
    expect(resolveValidatorSessionModel(undefined, undefined, {
      validatorGlobalProvider: "global-validator-provider",
      validatorGlobalModelId: "global-validator-model",
      defaultProvider: "global-default-provider",
      defaultModelId: "global-default-model",
    }, runtimeConfig)).toEqual({ provider: "global-validator-provider", modelId: "global-validator-model" });
    expect(resolveMergerSessionModel({
      defaultProvider: "global-default-provider",
      defaultModelId: "global-default-model",
    }, runtimeConfig)).toEqual({ provider: "global-default-provider", modelId: "global-default-model" });
  });

  it("uses complete runtimeConfig only after project defaults and globals are absent", () => {
    const runtimeConfig = { model: "runtime-provider/runtime-model" };

    expect(resolveExecutorSessionModel(undefined, undefined, {
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    }, runtimeConfig)).toEqual({ provider: "project-default-provider", modelId: "project-default-model" });
    expect(resolvePlanningSessionModel(undefined, undefined, {
      defaultProvider: "global-default-provider",
      defaultModelId: "global-default-model",
    }, runtimeConfig)).toEqual({ provider: "global-default-provider", modelId: "global-default-model" });
    expect(resolveValidatorSessionModel(undefined, undefined, undefined, runtimeConfig)).toEqual({
      provider: "runtime-provider",
      modelId: "runtime-model",
    });
    expect(resolveHeartbeatSessionModels(undefined, runtimeConfig)).toEqual({
      defaultProvider: "runtime-provider",
      defaultModelId: "runtime-model",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
  });

  it("forces mock/scripted across session surfaces when testMode or mock default is active", () => {
    const runtimeConfig = { model: "runtime-provider/runtime-model" };
    const testModeSettings = {
      testMode: true,
      executionProvider: "project-exec-provider",
      executionModelId: "project-exec-model",
      planningProvider: "project-plan-provider",
      planningModelId: "project-plan-model",
      validatorProvider: "project-validator-provider",
      validatorModelId: "project-validator-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    };

    expect(resolveExecutorSessionModel("task-provider", "task-model", testModeSettings, runtimeConfig)).toEqual({ provider: "mock", modelId: "scripted" });
    expect(resolvePlanningSessionModel("task-plan-provider", "task-plan-model", testModeSettings, runtimeConfig)).toEqual({ provider: "mock", modelId: "scripted" });
    expect(resolveValidatorSessionModel("task-validator-provider", "task-validator-model", testModeSettings, runtimeConfig)).toEqual({ provider: "mock", modelId: "scripted" });
    expect(resolveMergerSessionModel(testModeSettings, runtimeConfig)).toEqual({ provider: "mock", modelId: "scripted" });
    expect(resolveHeartbeatSessionModels({ defaultProvider: "mock", defaultModelId: "global-default-model" }, runtimeConfig)).toEqual({
      defaultProvider: "mock",
      defaultModelId: "scripted",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
  });
});

describe("createResolvedAgentSession", () => {
  beforeEach(() => {
    resolveRuntimeMock.mockReset();
  });

  it("forwards taskEnv unchanged to runtime session factory", async () => {
    const mockSession = { prompt: vi.fn() } as any;
    const createSessionMock = vi.fn().mockResolvedValue({
      session: mockSession,
      sessionFile: "session.json",
    });
    resolveRuntimeMock.mockResolvedValue({
      runtime: {
        id: "pi",
        name: "Default PI Runtime",
        createSession: createSessionMock,
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "mock/model"),
      },
      runtimeId: "pi",
      wasConfigured: false,
    });

    const { createResolvedAgentSession } = await import("../agent-session-helpers.js");

    const taskEnv = { PATH: "/tmp/bin", FUSION_TEST_VAR: "value" };
    await createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner: undefined,
      cwd: "/tmp/project",
      systemPrompt: "system",
      taskEnv,
    });

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskEnv,
      }),
    );
  });

  it("forwards sessionPurpose into runtime.createSession for host-extension policy", async () => {
    /*
    FNXC:MergeQueue 2026-07-15-11:20:
    FN-7956 fix requires sessionPurpose "merger" to reach createFnAgent so host extensions are skipped.
    */
    const mockSession = { prompt: vi.fn() } as any;
    const createSessionMock = vi.fn().mockResolvedValue({
      session: mockSession,
      sessionFile: "session.json",
    });
    resolveRuntimeMock.mockResolvedValue({
      runtime: {
        id: "pi",
        name: "Default PI Runtime",
        createSession: createSessionMock,
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "mock/model"),
      },
      runtimeId: "pi",
      wasConfigured: false,
    });

    const { createResolvedAgentSession } = await import("../agent-session-helpers.js");

    await createResolvedAgentSession({
      sessionPurpose: "merger",
      pluginRunner: undefined,
      cwd: "/tmp/project",
      systemPrompt: "merge",
    });

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionPurpose: "merger",
      }),
    );
  });

  it("emits session:runtime-resolved when runAuditor is provided", async () => {
    const mockSession = { prompt: vi.fn() } as any;
    const createSessionMock = vi.fn().mockResolvedValue({ session: mockSession });
    const auditDatabaseMock = vi.fn().mockResolvedValue(undefined);

    const { createResolvedAgentSession } = await import("../agent-session-helpers.js");

    await createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/project",
      systemPrompt: "system",
      defaultProvider: "mock",
      defaultModelId: "mock-default",
      runAuditor: { database: auditDatabaseMock } as any,
      settings: { testMode: true } as any,
    });

    expect(createSessionMock).not.toHaveBeenCalled();
    expect(auditDatabaseMock).toHaveBeenCalledTimes(1);
    expect(auditDatabaseMock).toHaveBeenCalledWith({
      type: "session:runtime-resolved",
      target: "mock",
      metadata: {
        sessionPurpose: "executor",
        runtimeId: "mock",
        wasConfigured: true,
        provider: "mock",
        modelId: "mock-default",
        mockProviderActive: true,
        testModeActive: true,
      },
    });
  });

  it("succeeds when runAuditor is omitted", async () => {
    const mockSession = { prompt: vi.fn() } as any;
    const createSessionMock = vi.fn().mockResolvedValue({
      session: mockSession,
      sessionFile: "session.json",
    });
    resolveRuntimeMock.mockResolvedValue({
      runtime: {
        id: "pi",
        name: "Default PI Runtime",
        createSession: createSessionMock,
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "mock/model"),
      },
      runtimeId: "pi",
      wasConfigured: false,
    });

    const { createResolvedAgentSession } = await import("../agent-session-helpers.js");

    await expect(createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/project",
      systemPrompt: "system",
    })).resolves.toMatchObject({ runtimeId: "pi", wasConfigured: false });
  });

  it("warns and continues when runAuditor throws", async () => {
    const mockSession = { prompt: vi.fn() } as any;
    const createSessionMock = vi.fn().mockResolvedValue({ session: mockSession });
    resolveRuntimeMock.mockResolvedValue({
      runtime: {
        id: "pi",
        name: "Default PI Runtime",
        createSession: createSessionMock,
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "mock/model"),
      },
      runtimeId: "pi",
      wasConfigured: false,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createResolvedAgentSession } = await import("../agent-session-helpers.js");

    await expect(createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/project",
      systemPrompt: "system",
      runAuditor: {
        database: vi.fn().mockRejectedValue(new Error("audit down")),
      } as any,
    })).resolves.toMatchObject({ session: mockSession, runtimeId: "pi", wasConfigured: false });

    warnSpy.mockRestore();
  });

  /*
  FNXC:GrokAcp 2026-07-12-06:30:
  PR #2011 Greptile P1: non-pi runtimes must receive action-gated customTools so
  Grok ACP loopback execute cannot bypass AgentPermissionPolicy.
  */
  it("wraps customTools with action gate for non-pi runtimes before createSession", async () => {
    const mockSession = { prompt: vi.fn() } as any;
    const createSessionMock = vi.fn().mockResolvedValue({ session: mockSession });
    resolveRuntimeMock.mockResolvedValue({
      runtime: {
        id: "grok",
        name: "Grok Runtime",
        createSession: createSessionMock,
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "grok/default"),
      },
      runtimeId: "grok",
      wasConfigured: true,
    });

    const execute = vi.fn().mockResolvedValue({ ok: true });
    const rawTool = {
      name: "fn_workflow_delete",
      label: "Delete Workflow",
      description: "",
      parameters: {},
      execute,
    };
    const lockedDownPolicy = {
      presetId: "locked-down",
      rules: {
        git_write: "block",
        file_write_delete: "block",
        command_execution: "block",
        network_api: "block",
        task_agent_mutation: "block",
        review_gate_bypass: "block",
        file_scope: "block",
      },
    };

    const { createResolvedAgentSession } = await import("../agent-session-helpers.js");
    await createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/project",
      systemPrompt: "system",
      customTools: [rawTool as any],
      actionGateContext: {
        agentId: "agent-1",
        agentName: "Agent",
        isEphemeral: false,
        taskId: "FN-1",
        permissionPolicy: lockedDownPolicy as any,
        createApprovalRequest: vi.fn(),
        findApprovalByDedupeKey: vi.fn().mockResolvedValue(null),
      } as any,
    });

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const passedTools = createSessionMock.mock.calls[0][0].customTools as Array<{
      name: string;
      execute: (...args: unknown[]) => Promise<unknown>;
    }>;
    expect(passedTools).toHaveLength(1);
    expect(passedTools[0].name).toBe("fn_workflow_delete");
    expect(passedTools[0].execute).not.toBe(execute);
    // Gated execute must not call the raw tool when policy blocks.
    const blocked = await passedTools[0].execute("call-1", { workflow_id: "WF-1" });
    expect(blocked).toEqual(
      expect.objectContaining({
        isError: true,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not pre-wrap customTools for the pi runtime (createFnAgent owns the chain)", async () => {
    const mockSession = { prompt: vi.fn() } as any;
    const createSessionMock = vi.fn().mockResolvedValue({ session: mockSession });
    resolveRuntimeMock.mockResolvedValue({
      runtime: {
        id: "pi",
        name: "Default PI Runtime",
        createSession: createSessionMock,
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "mock/model"),
      },
      runtimeId: "pi",
      wasConfigured: false,
    });

    const execute = vi.fn().mockResolvedValue({ ok: true });
    const rawTool = {
      name: "fn_workflow_delete",
      label: "Delete",
      description: "",
      parameters: {},
      execute,
    };

    const { createResolvedAgentSession } = await import("../agent-session-helpers.js");
    await createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/project",
      systemPrompt: "system",
      customTools: [rawTool as any],
      actionGateContext: {
        agentId: "agent-1",
        agentName: "Agent",
        isEphemeral: false,
        taskId: "FN-1",
        permissionPolicy: { defaultDisposition: "block", rules: {} } as any,
        createApprovalRequest: vi.fn(),
        findApprovalByDedupeKey: vi.fn(),
      } as any,
    });

    const passedTools = createSessionMock.mock.calls[0][0].customTools;
    expect(passedTools[0]).toBe(rawTool);
  });
});

describe("resolveMergerSessionModel", () => {
  it("uses assigned agent runtime model only when no default model pair is configured", () => {
    expect(
      resolveMergerSessionModel(
        {},
        { model: "  anthropic/claude-3-5-sonnet-20241022  " },
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet-20241022",
    });
  });

  it("falls back to default override pair when runtime model is not fully specified", () => {
    expect(
      resolveMergerSessionModel(
        {
          defaultProviderOverride: "openai",
          defaultModelIdOverride: "gpt-4.1",
          defaultProvider: "anthropic",
          defaultModelId: "claude-3-5-sonnet",
        },
        { modelProvider: "anthropic" },
      ),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
  });

  it("falls back to global defaults when no override pair is configured", () => {
    expect(
      resolveMergerSessionModel(
        {
          defaultProvider: "anthropic",
          defaultModelId: "claude-3-5-sonnet",
        },
        { modelId: "claude-3-opus" },
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
    });
  });

  it("ignores partial override pairs and falls back to global defaults", () => {
    expect(
      resolveMergerSessionModel({
        defaultProviderOverride: "openai",
        defaultProvider: "anthropic",
        defaultModelId: "claude-3-5-sonnet",
      }),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
    });

    expect(
      resolveMergerSessionModel({
        defaultModelIdOverride: "gpt-4.1",
        defaultProvider: "anthropic",
        defaultModelId: "claude-3-5-sonnet",
      }),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
    });
  });

  it("works when assignedAgentRuntimeConfig is undefined", () => {
    expect(
      resolveMergerSessionModel({
        defaultProviderOverride: "openai",
        defaultModelIdOverride: "gpt-4.1",
        defaultProvider: "anthropic",
        defaultModelId: "claude-3-5-sonnet",
      }),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
  });
});

describe("resolveImplicitPlanningFallbackModel (FN-7719)", () => {
  it("derives a distinct implicit fallback from the project/global default model", () => {
    expect(
      resolveImplicitPlanningFallbackModel(
        {
          defaultProvider: "openai",
          defaultModelId: "gpt-4o",
        },
        "9router",
        "nvidia/moonshotai/kimi-k2.6",
      ),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
  });

  it("returns undefined/undefined when the implicit fallback would equal the primary (self-swap guard)", () => {
    expect(
      resolveImplicitPlanningFallbackModel(
        {
          defaultProvider: "openai",
          defaultModelId: "gpt-4o",
        },
        "openai",
        "gpt-4o",
      ),
    ).toEqual({
      provider: undefined,
      modelId: undefined,
    });
  });

  it("uses the inherited global default when a project override equals the planning primary", () => {
    expect(
      resolveImplicitPlanningFallbackModel(
        {
          defaultProviderOverride: "anthropic",
          defaultModelIdOverride: "claude-sonnet-5",
          defaultProvider: "openai-codex",
          defaultModelId: "gpt-5.5",
        },
        "anthropic",
        "claude-sonnet-5",
      ),
    ).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.5",
    });
  });

  it("returns undefined/undefined when no project/global default model is configured", () => {
    expect(
      resolveImplicitPlanningFallbackModel({}, "9router", "nvidia/moonshotai/kimi-k2.6"),
    ).toEqual({
      provider: undefined,
      modelId: undefined,
    });
  });

  it("does not inject an implicit fallback in test mode", () => {
    expect(
      resolveImplicitPlanningFallbackModel(
        {
          testMode: true,
          defaultProvider: "openai",
          defaultModelId: "gpt-4o",
        },
        "9router",
        "nvidia/moonshotai/kimi-k2.6",
      ),
    ).toEqual({
      provider: undefined,
      modelId: undefined,
    });
  });

  it("prefers the assigned agent runtime model when no default model pair is configured", () => {
    expect(
      resolveImplicitPlanningFallbackModel(
        {},
        "9router",
        "nvidia/moonshotai/kimi-k2.6",
        { model: "anthropic/claude-3-5-sonnet-20241022" },
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet-20241022",
    });
  });
});
