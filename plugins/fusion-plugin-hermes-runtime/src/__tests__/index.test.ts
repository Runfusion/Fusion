import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveModelConfig } = vi.hoisted(() => ({
  mockResolveModelConfig: vi.fn().mockReturnValue({
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    apiKey: undefined,
    thinkingLevel: undefined,
  }),
}));

vi.mock("../pi-module.js", () => ({
  resolveModelConfig: mockResolveModelConfig,
}));

import plugin, { hermesRuntimeMetadata, hermesRuntimeFactory, HERMES_RUNTIME_ID } from "../index.js";
import { HermesRuntimeAdapter } from "../runtime-adapter.js";

function createMockContext(settings: Record<string, unknown> = {}) {
  return {
    pluginId: "fusion-plugin-hermes-runtime",
    settings,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    emitEvent: vi.fn(),
    taskStore: {
      getTask: vi.fn(),
    },
  };
}

describe("hermes-runtime plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has expected manifest identity", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-hermes-runtime");
    expect(plugin.manifest.name).toBe("Hermes Runtime Plugin");
    expect(plugin.manifest.version).toBe("0.1.0");
    expect(plugin.state).toBe("installed");
  });

  it("registers runtime metadata and exports matching constants", () => {
    expect(HERMES_RUNTIME_ID).toBe("hermes");
    expect(plugin.runtime?.metadata.runtimeId).toBe("hermes");
    expect(plugin.runtime?.metadata.name).toBe("Hermes Runtime");
    expect(plugin.runtime?.metadata.description).toContain("pi-ai direct streaming");
    expect(plugin.manifest.runtime).toEqual(hermesRuntimeMetadata);
  });

  it("onLoad resolves model config and logs selected provider/model without api key", async () => {
    const ctx = createMockContext({ provider: "openai", modelId: "gpt-5", apiKey: "secret" });
    mockResolveModelConfig.mockReturnValue({
      provider: "openai",
      modelId: "gpt-5",
      apiKey: "secret",
      thinkingLevel: "medium",
    });

    await plugin.hooks.onLoad?.(ctx as any);

    expect(mockResolveModelConfig).toHaveBeenCalledWith(ctx.settings);
    expect(ctx.logger.info).toHaveBeenCalledWith("Hermes Runtime Plugin loaded — using openai/gpt-5");
    expect(ctx.logger.info.mock.calls[0][0]).not.toContain("secret");
    expect(ctx.emitEvent).toHaveBeenCalledWith("hermes-runtime:loaded", {
      runtimeId: "hermes",
      version: "0.1.0",
    });
  });

  it("runtime factory resolves settings and returns HermesRuntimeAdapter", async () => {
    const ctx = createMockContext({ provider: "openai", modelId: "gpt-5" });
    mockResolveModelConfig.mockReturnValue({
      provider: "openai",
      modelId: "gpt-5",
      apiKey: "api-key",
      thinkingLevel: "high",
    });

    const runtime = (await hermesRuntimeFactory(ctx as any)) as HermesRuntimeAdapter;

    expect(mockResolveModelConfig).toHaveBeenCalledWith(ctx.settings);
    expect(runtime).toBeInstanceOf(HermesRuntimeAdapter);
    expect(runtime.id).toBe("hermes");
    expect(runtime.name).toBe("Hermes Runtime");
    expect((runtime as any).config).toEqual({
      provider: "openai",
      modelId: "gpt-5",
      apiKey: "api-key",
      thinkingLevel: "high",
    });
  });
});
