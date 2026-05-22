import { describe, expect, it } from "vitest";
import {
  applyTestModeOverrides,
  resolveExecutionSettingsModel,
  resolvePlanningSettingsModel,
  resolveProjectDefaultModel,
  resolveTaskExecutionModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
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
