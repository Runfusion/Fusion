import { describe, expect, it } from "vitest";
import {
  applyTestModeOverrides,
  resolveExecutionSettingsModel,
  resolvePlanningSettingsModel,
  resolveProjectDefaultModel,
  resolveTaskExecutionModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
  resolveMergerFallbackModel,
  resolveMergerSettingsModel,
  resolveTitleSummarizerSettingsModel,
  resolveValidatorSettingsModel,
  TEST_MODE_RESOLVED,
} from "../model-resolution.js";

describe("model-resolution", () => {
  it("prefers the project default override over the global default", () => {
    expect(
      resolveProjectDefaultModel({
        defaultProviderOverride: "openai",
        defaultModelIdOverride: "gpt-4o",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      }),
    ).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it("uses the execution lane before the project default override", () => {
    expect(
      resolveExecutionSettingsModel({
        executionProvider: "google",
        executionModelId: "gemini-2.5-pro",
        defaultProviderOverride: "openai",
        defaultModelIdOverride: "gpt-4o",
      }),
    ).toEqual({ provider: "google", modelId: "gemini-2.5-pro" });
  });

  it("selects the project execution lane over the base default for workflow-step callers", () => {
    const resolved = resolveExecutionSettingsModel({
      executionProvider: "openai",
      executionModelId: "gpt-4o",
      defaultProvider: "anthropic",
      defaultModelId: "claude-3-5-sonnet",
    });

    expect(resolved).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(resolved).not.toEqual({ provider: "anthropic", modelId: "claude-3-5-sonnet" });
  });

  it("falls back from planning global to the project default override", () => {
    expect(
      resolvePlanningSettingsModel({
        defaultProviderOverride: "openai",
        defaultModelIdOverride: "gpt-4o-mini",
      }),
    ).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
  });

  it("falls back from validator global to the project default override", () => {
    expect(
      resolveValidatorSettingsModel({
        defaultProviderOverride: "anthropic",
        defaultModelIdOverride: "claude-opus-4",
      }),
    ).toEqual({ provider: "anthropic", modelId: "claude-opus-4" });
  });

  it("uses title summarizer global, then project planning, then project default override", () => {
    expect(
      resolveTitleSummarizerSettingsModel({
        titleSummarizerGlobalProvider: "openai",
        titleSummarizerGlobalModelId: "gpt-4.1",
        planningProvider: "google",
        planningModelId: "gemini-2.5-pro",
        defaultProviderOverride: "anthropic",
        defaultModelIdOverride: "claude-sonnet-4-5",
      }),
    ).toEqual({ provider: "openai", modelId: "gpt-4.1" });

    expect(
      resolveTitleSummarizerSettingsModel({
        planningProvider: "google",
        planningModelId: "gemini-2.5-pro",
        defaultProviderOverride: "anthropic",
        defaultModelIdOverride: "claude-sonnet-4-5",
      }),
    ).toEqual({ provider: "google", modelId: "gemini-2.5-pro" });

    expect(
      resolveTitleSummarizerSettingsModel({
        defaultProviderOverride: "anthropic",
        defaultModelIdOverride: "claude-sonnet-4-5",
      }),
    ).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });

  it("uses project lane overrides for every pure settings lane before global and default fallbacks", () => {
    expect(resolveExecutionSettingsModel({
      executionProvider: "project-exec-provider",
      executionModelId: "project-exec-model",
      executionGlobalProvider: "global-exec-provider",
      executionGlobalModelId: "global-exec-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    })).toEqual({ provider: "project-exec-provider", modelId: "project-exec-model" });

    expect(resolvePlanningSettingsModel({
      planningProvider: "project-plan-provider",
      planningModelId: "project-plan-model",
      planningGlobalProvider: "global-plan-provider",
      planningGlobalModelId: "global-plan-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    })).toEqual({ provider: "project-plan-provider", modelId: "project-plan-model" });

    expect(resolveValidatorSettingsModel({
      validatorProvider: "project-validator-provider",
      validatorModelId: "project-validator-model",
      validatorGlobalProvider: "global-validator-provider",
      validatorGlobalModelId: "global-validator-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    })).toEqual({ provider: "project-validator-provider", modelId: "project-validator-model" });

    expect(resolveTitleSummarizerSettingsModel({
      titleSummarizerProvider: "project-title-provider",
      titleSummarizerModelId: "project-title-model",
      titleSummarizerGlobalProvider: "global-title-provider",
      titleSummarizerGlobalModelId: "global-title-model",
      planningProvider: "project-plan-provider",
      planningModelId: "project-plan-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    })).toEqual({ provider: "project-title-provider", modelId: "project-title-model" });

    expect(resolveMergerSettingsModel({
      mergerProvider: "project-merger-provider",
      mergerModelId: "project-merger-model",
      mergerGlobalProvider: "global-merger-provider",
      mergerGlobalModelId: "global-merger-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    })).toEqual({ provider: "project-merger-provider", modelId: "project-merger-model" });
  });

  it("resolves merger fallback project pair, global fallback, partial pairs, and test mode", () => {
    expect(resolveMergerFallbackModel({
      mergerFallbackProvider: "project-merger-fallback-provider",
      mergerFallbackModelId: "project-merger-fallback-model",
      fallbackProvider: "global-fallback-provider",
      fallbackModelId: "global-fallback-model",
    })).toEqual({ provider: "project-merger-fallback-provider", modelId: "project-merger-fallback-model" });
    expect(resolveMergerFallbackModel({
      mergerFallbackProvider: "partial-provider",
      fallbackProvider: "global-fallback-provider",
      fallbackModelId: "global-fallback-model",
    })).toEqual({ provider: "global-fallback-provider", modelId: "global-fallback-model" });
    expect(resolveMergerFallbackModel({
      fallbackProvider: "global-fallback-provider",
      fallbackModelId: "global-fallback-model",
    })).toEqual({ provider: "global-fallback-provider", modelId: "global-fallback-model" });
    expect(resolveMergerFallbackModel({
      testMode: true,
      mergerFallbackProvider: "project-merger-fallback-provider",
      mergerFallbackModelId: "project-merger-fallback-model",
    })).toEqual(TEST_MODE_RESOLVED);
  });

  it("does not mix partial project lane pairs with lower precedence model fields", () => {
    expect(resolveExecutionSettingsModel({
      executionProvider: "project-exec-provider",
      executionGlobalProvider: "global-exec-provider",
      executionGlobalModelId: "global-exec-model",
    })).toEqual({ provider: "global-exec-provider", modelId: "global-exec-model" });

    expect(resolvePlanningSettingsModel({
      planningModelId: "project-plan-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    })).toEqual({ provider: "project-default-provider", modelId: "project-default-model" });

    expect(resolveValidatorSettingsModel({
      validatorProvider: "project-validator-provider",
      defaultProvider: "global-default-provider",
      defaultModelId: "global-default-model",
    })).toEqual({ provider: "global-default-provider", modelId: "global-default-model" });

    expect(resolveTitleSummarizerSettingsModel({
      titleSummarizerModelId: "project-title-model",
      titleSummarizerGlobalProvider: "global-title-provider",
      titleSummarizerGlobalModelId: "global-title-model",
      planningProvider: "project-plan-provider",
      planningModelId: "project-plan-model",
    })).toEqual({ provider: "global-title-provider", modelId: "global-title-model" });

    expect(resolveMergerSettingsModel({
      mergerProvider: "project-merger-provider",
      mergerGlobalProvider: "global-merger-provider",
      mergerGlobalModelId: "global-merger-model",
    })).toEqual({ provider: "global-merger-provider", modelId: "global-merger-model" });
  });

  it("keeps global lane and default fallback order intact when project lanes are unset", () => {
    expect(resolveExecutionSettingsModel({
      executionGlobalProvider: "global-exec-provider",
      executionGlobalModelId: "global-exec-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    })).toEqual({ provider: "global-exec-provider", modelId: "global-exec-model" });

    expect(resolvePlanningSettingsModel({
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
      defaultProvider: "global-default-provider",
      defaultModelId: "global-default-model",
    })).toEqual({ provider: "project-default-provider", modelId: "project-default-model" });

    expect(resolveValidatorSettingsModel({
      defaultProvider: "global-default-provider",
      defaultModelId: "global-default-model",
    })).toEqual({ provider: "global-default-provider", modelId: "global-default-model" });

    expect(resolveTitleSummarizerSettingsModel({
      titleSummarizerGlobalProvider: "global-title-provider",
      titleSummarizerGlobalModelId: "global-title-model",
      planningProvider: "project-plan-provider",
      planningModelId: "project-plan-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    })).toEqual({ provider: "global-title-provider", modelId: "global-title-model" });

    expect(resolveMergerSettingsModel({
      mergerGlobalProvider: "global-merger-provider",
      mergerGlobalModelId: "global-merger-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
    })).toEqual({ provider: "global-merger-provider", modelId: "global-merger-model" });

    expect(resolveMergerSettingsModel({
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
      defaultProvider: "global-default-provider",
      defaultModelId: "global-default-model",
    })).toEqual({ provider: "project-default-provider", modelId: "project-default-model" });
  });

  it("does not inherit execution/planning/validator lanes for the merger model", () => {
    expect(resolveMergerSettingsModel({
      executionProvider: "project-exec-provider",
      executionModelId: "project-exec-model",
      planningProvider: "project-plan-provider",
      planningModelId: "project-plan-model",
      validatorProvider: "project-validator-provider",
      validatorModelId: "project-validator-model",
      defaultProvider: "global-default-provider",
      defaultModelId: "global-default-model",
    })).toEqual({ provider: "global-default-provider", modelId: "global-default-model" });
  });

  it("uses task overrides before settings fallbacks", () => {
    expect(
      resolveTaskExecutionModel(
        {
          modelProvider: "openai",
          modelId: "gpt-4o",
        },
        {
          executionProvider: "anthropic",
          executionModelId: "claude-sonnet-4-5",
        },
      ),
    ).toEqual({ provider: "openai", modelId: "gpt-4o" });

    expect(
      resolveTaskValidatorModel(
        {},
        {
          defaultProviderOverride: "anthropic",
          defaultModelIdOverride: "claude-sonnet-4-5",
        },
      ),
    ).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });

    expect(
      resolveTaskPlanningModel(
        {},
        {
          planningGlobalProvider: "openai",
          planningGlobalModelId: "gpt-4.1",
          defaultProviderOverride: "anthropic",
          defaultModelIdOverride: "claude-sonnet-4-5",
        },
      ),
    ).toEqual({ provider: "openai", modelId: "gpt-4.1" });
  });

  it("ignores partial pairs at every precedence tier", () => {
    expect(
      resolveProjectDefaultModel({
        defaultProviderOverride: "openai",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      }),
    ).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });

    expect(
      resolveTaskExecutionModel(
        { modelProvider: "task-provider" },
        {
          executionProvider: "openai",
          executionModelId: "gpt-4.1",
        },
      ),
    ).toEqual({ provider: "openai", modelId: "gpt-4.1" });

    expect(
      resolveTaskPlanningModel(
        { planningModelId: "task-planning-model" },
        {
          planningGlobalProvider: "anthropic",
          planningGlobalModelId: "claude-sonnet-4-5",
        },
      ),
    ).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });

    expect(
      resolveTaskValidatorModel(
        { validatorModelProvider: "validator-task-provider" },
        {
          defaultProviderOverride: "google",
          defaultModelIdOverride: "gemini-2.5-pro",
        },
      ),
    ).toEqual({ provider: "google", modelId: "gemini-2.5-pro" });
  });

  it("resolves task validator models through the full reviewer hierarchy", () => {
    const task = {
      validatorModelProvider: "task-reviewer-provider",
      validatorModelId: "task-reviewer-model",
    };
    const settings = {
      validatorProvider: "project-reviewer-provider",
      validatorModelId: "project-reviewer-model",
      validatorGlobalProvider: "global-reviewer-provider",
      validatorGlobalModelId: "global-reviewer-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
      defaultProvider: "global-default-provider",
      defaultModelId: "global-default-model",
    };

    expect(resolveTaskValidatorModel(task, settings)).toEqual({
      provider: "task-reviewer-provider",
      modelId: "task-reviewer-model",
    });
    expect(resolveTaskValidatorModel({}, settings)).toEqual({
      provider: "project-reviewer-provider",
      modelId: "project-reviewer-model",
    });
    expect(resolveTaskValidatorModel({}, {
      ...settings,
      validatorProvider: undefined,
      validatorModelId: undefined,
    })).toEqual({
      provider: "global-reviewer-provider",
      modelId: "global-reviewer-model",
    });
    expect(resolveTaskValidatorModel({}, {
      ...settings,
      validatorProvider: undefined,
      validatorModelId: undefined,
      validatorGlobalProvider: undefined,
      validatorGlobalModelId: undefined,
    })).toEqual({
      provider: "project-default-provider",
      modelId: "project-default-model",
    });
    expect(resolveTaskValidatorModel({}, {
      defaultProvider: "global-default-provider",
      defaultModelId: "global-default-model",
    })).toEqual({
      provider: "global-default-provider",
      modelId: "global-default-model",
    });
  });

  it("does not mix partial reviewer pairs across task, lane, and default tiers", () => {
    expect(resolveTaskValidatorModel(
      { validatorModelProvider: "task-provider-only" },
      {
        validatorProvider: "project-reviewer-provider",
        validatorModelId: "project-reviewer-model",
      },
    )).toEqual({ provider: "project-reviewer-provider", modelId: "project-reviewer-model" });

    expect(resolveTaskValidatorModel(
      { validatorModelId: "task-model-only" },
      {
        validatorProvider: "project-provider-only",
        validatorGlobalProvider: "global-reviewer-provider",
        validatorGlobalModelId: "global-reviewer-model",
      },
    )).toEqual({ provider: "global-reviewer-provider", modelId: "global-reviewer-model" });

    expect(resolveTaskValidatorModel(
      {},
      {
        validatorProvider: "project-reviewer-provider",
        validatorGlobalModelId: "global-model-only",
        defaultProviderOverride: "project-default-provider",
        defaultModelIdOverride: "project-default-model",
        defaultProvider: "global-default-provider",
        defaultModelId: "global-default-model",
      },
    )).toEqual({ provider: "project-default-provider", modelId: "project-default-model" });

    expect(resolveTaskValidatorModel(
      {},
      {
        defaultProviderOverride: "project-default-provider",
        defaultProvider: "global-default-provider",
        defaultModelId: "global-default-model",
      },
    )).toEqual({ provider: "global-default-provider", modelId: "global-default-model" });
  });

  it("forces task reviewer overrides to mock/scripted in test mode and mock default mode", () => {
    const task = {
      validatorModelProvider: "task-reviewer-provider",
      validatorModelId: "task-reviewer-model",
    };
    const populatedSettings = {
      validatorProvider: "project-reviewer-provider",
      validatorModelId: "project-reviewer-model",
      validatorGlobalProvider: "global-reviewer-provider",
      validatorGlobalModelId: "global-reviewer-model",
      defaultProviderOverride: "project-default-provider",
      defaultModelIdOverride: "project-default-model",
      defaultProvider: "global-default-provider",
      defaultModelId: "global-default-model",
    };

    expect(resolveTaskValidatorModel(task, {
      ...populatedSettings,
      testMode: true,
    })).toEqual(TEST_MODE_RESOLVED);
    expect(resolveTaskValidatorModel(task, {
      ...populatedSettings,
      defaultProvider: "mock",
    })).toEqual(TEST_MODE_RESOLVED);
  });

  it("forces every lane to mock when testMode is true", () => {
    const settings = {
      testMode: true,
      executionProvider: "anthropic",
      executionModelId: "claude-sonnet-4-5",
      planningProvider: "anthropic",
      planningModelId: "claude-sonnet-4-5",
      validatorProvider: "anthropic",
      validatorModelId: "claude-sonnet-4-5",
      titleSummarizerProvider: "anthropic",
      titleSummarizerModelId: "claude-sonnet-4-5",
      mergerProvider: "anthropic",
      mergerModelId: "claude-sonnet-4-5",
      defaultProviderOverride: "anthropic",
      defaultModelIdOverride: "claude-sonnet-4-5",
    };
    const taskOverrides = {
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "anthropic",
      validatorModelId: "claude-sonnet-4-5",
      planningModelProvider: "anthropic",
      planningModelId: "claude-sonnet-4-5",
    };

    expect(resolveProjectDefaultModel(settings)).toEqual(TEST_MODE_RESOLVED);
    expect(resolveExecutionSettingsModel(settings)).toEqual(TEST_MODE_RESOLVED);
    expect(resolvePlanningSettingsModel(settings)).toEqual(TEST_MODE_RESOLVED);
    expect(resolveValidatorSettingsModel(settings)).toEqual(TEST_MODE_RESOLVED);
    expect(resolveTitleSummarizerSettingsModel(settings)).toEqual(TEST_MODE_RESOLVED);
    expect(resolveMergerSettingsModel(settings)).toEqual(TEST_MODE_RESOLVED);
    expect(resolveTaskExecutionModel(taskOverrides, settings)).toEqual(TEST_MODE_RESOLVED);
    expect(resolveTaskValidatorModel(taskOverrides, settings)).toEqual(TEST_MODE_RESOLVED);
    expect(resolveTaskPlanningModel(taskOverrides, settings)).toEqual(TEST_MODE_RESOLVED);
  });

  it("forces mock when defaultProvider is mock without testMode", () => {
    const settings = {
      defaultProvider: "mock",
      defaultModelId: "anything",
      executionProvider: "anthropic",
      executionModelId: "claude-sonnet-4-5",
    };

    expect(resolveExecutionSettingsModel(settings)).toEqual(TEST_MODE_RESOLVED);
    expect(resolvePlanningSettingsModel(settings)).toEqual(TEST_MODE_RESOLVED);
    expect(resolveValidatorSettingsModel(settings)).toEqual(TEST_MODE_RESOLVED);
  });

  it("passes through when test mode is inactive", () => {
    const resolved = resolveExecutionSettingsModel({
      executionProvider: "anthropic",
      executionModelId: "claude-sonnet-4-5",
    });

    expect(applyTestModeOverrides(resolved, { testMode: false })).toEqual(resolved);
    expect(applyTestModeOverrides(resolved, {})).toEqual(resolved);
  });
});
