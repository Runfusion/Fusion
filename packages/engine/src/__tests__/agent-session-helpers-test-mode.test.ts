import { describe, expect, it } from "vitest";
import {
  resolveExecutorSessionModel,
  resolveHeartbeatSessionModels,
  resolveMergerSessionModel,
  resolvePlanningSessionModel,
} from "../agent-session-helpers.js";

const assignedAgentRuntimeConfig = {
  modelProvider: "anthropic",
  modelId: "claude-sonnet-4-5",
};

describe("agent-session-helpers test mode overrides", () => {
  it("forces every resolver lane to mock when settings.testMode is true", () => {
    const settings = {
      testMode: true,
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
      executionProvider: "openai",
      executionModelId: "gpt-4.1",
      planningProvider: "openai",
      planningModelId: "gpt-4.1",
      defaultProviderOverride: "openai",
      defaultModelIdOverride: "gpt-4.1",
    };

    expect(resolveExecutorSessionModel("openai", "gpt-4.1", settings, assignedAgentRuntimeConfig)).toEqual({
      provider: "mock",
      modelId: "scripted",
    });
    expect(resolvePlanningSessionModel("openai", "gpt-4.1", settings, assignedAgentRuntimeConfig)).toEqual({
      provider: "mock",
      modelId: "scripted",
    });
    expect(resolveMergerSessionModel(settings, assignedAgentRuntimeConfig)).toEqual({
      provider: "mock",
      modelId: "scripted",
    });
    expect(resolveHeartbeatSessionModels(settings, assignedAgentRuntimeConfig)).toEqual({
      defaultProvider: "mock",
      defaultModelId: "scripted",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
  });

  it("forces every resolver lane to mock when defaultProvider is mock", () => {
    const settings = {
      defaultProvider: "mock",
      defaultModelId: "custom",
      executionProvider: "openai",
      executionModelId: "gpt-4.1",
      planningProvider: "openai",
      planningModelId: "gpt-4.1",
      defaultProviderOverride: "openai",
      defaultModelIdOverride: "gpt-4.1",
    };

    expect(resolveExecutorSessionModel("openai", "gpt-4.1", settings, assignedAgentRuntimeConfig)).toEqual({
      provider: "mock",
      modelId: "scripted",
    });
    expect(resolvePlanningSessionModel("openai", "gpt-4.1", settings, assignedAgentRuntimeConfig)).toEqual({
      provider: "mock",
      modelId: "scripted",
    });
    expect(resolveMergerSessionModel(settings, assignedAgentRuntimeConfig)).toEqual({
      provider: "mock",
      modelId: "scripted",
    });
    expect(resolveHeartbeatSessionModels(settings, assignedAgentRuntimeConfig)).toEqual({
      defaultProvider: "mock",
      defaultModelId: "scripted",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
  });

  it("keeps existing behavior when test mode is inactive", () => {
    const settings = {
      executionProvider: "openai",
      executionModelId: "gpt-4.1",
      planningProvider: "openai",
      planningModelId: "gpt-4.1",
      defaultProviderOverride: "openai",
      defaultModelIdOverride: "gpt-4.1",
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
    };

    expect(resolveExecutorSessionModel("task-provider", "task-model", settings, assignedAgentRuntimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(resolvePlanningSessionModel("task-provider", "task-model", settings, assignedAgentRuntimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(resolveMergerSessionModel(settings, assignedAgentRuntimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(resolveHeartbeatSessionModels(settings, assignedAgentRuntimeConfig)).toEqual({
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      fallbackProvider: "openai",
      fallbackModelId: "gpt-4.1",
    });
  });
});
