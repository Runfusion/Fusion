import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FusionPlugin } from "@fusion/plugin-sdk";
import plugin from "../index.js";
import type { AgentRuntime } from "../types.js";

const {
  mockResolveModelConfig,
  mockCreateStreamSession,
  mockStreamPrompt,
  mockDescribeStreamModel,
} = vi.hoisted(() => ({
  mockResolveModelConfig: vi.fn().mockReturnValue({
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    apiKey: undefined,
    thinkingLevel: undefined,
  }),
  mockCreateStreamSession: vi.fn().mockReturnValue({ messages: [], dispose: vi.fn() }),
  mockStreamPrompt: vi.fn().mockResolvedValue(undefined),
  mockDescribeStreamModel: vi.fn().mockReturnValue("anthropic/claude-sonnet-4-5"),
}));

vi.mock("../pi-module.js", () => ({
  resolveModelConfig: mockResolveModelConfig,
  createStreamSession: mockCreateStreamSession,
  streamPrompt: mockStreamPrompt,
  describeStreamModel: mockDescribeStreamModel,
}));

function isAgentRuntime(value: unknown): value is AgentRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "name" in value &&
    typeof (value as AgentRuntime).createSession === "function" &&
    typeof (value as AgentRuntime).promptWithFallback === "function" &&
    typeof (value as AgentRuntime).describeModel === "function"
  );
}

function createMockContext() {
  return {
    pluginId: "fusion-plugin-hermes-runtime",
    settings: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    emitEvent: vi.fn(),
    taskStore: { getTask: vi.fn() },
  };
}

describe("Hermes runtime plugin integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports a valid Fusion plugin manifest", () => {
    const fusionPlugin = plugin as FusionPlugin;

    expect(fusionPlugin).toBeDefined();
    expect(fusionPlugin.manifest.id).toBe("fusion-plugin-hermes-runtime");
  });

  it("runtime factory returns an AgentRuntime-compatible Hermes adapter", async () => {
    const runtime = (await plugin.runtime!.factory(createMockContext() as any)) as AgentRuntime;

    expect(runtime.id).toBe("hermes");
    expect(runtime.name).toBe("Hermes Runtime");
    expect(isAgentRuntime(runtime)).toBe(true);

    const created = await runtime.createSession({ cwd: "/tmp", systemPrompt: "helpful" });
    expect(created.sessionFile).toBeUndefined();

    await runtime.promptWithFallback(created.session, "Hello integration");
    expect(mockStreamPrompt).toHaveBeenCalled();

    expect(runtime.describeModel(created.session)).toBe("anthropic/claude-sonnet-4-5");
  });

  it("onLoad emits hermes-runtime:loaded with runtime metadata", async () => {
    const ctx = createMockContext();

    await plugin.hooks.onLoad?.(ctx as any);

    expect(mockResolveModelConfig).toHaveBeenCalledWith(ctx.settings);
    expect(ctx.emitEvent).toHaveBeenCalledWith("hermes-runtime:loaded", {
      runtimeId: "hermes",
      version: "0.1.0",
    });
  });
});
