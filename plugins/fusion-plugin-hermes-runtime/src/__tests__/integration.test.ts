import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FusionPlugin } from "@fusion/plugin-sdk";
import plugin from "../index.js";
import type { AgentRuntime } from "../types.js";

const { mockCreateFnAgent, mockPromptWithFallback, mockDescribeModel } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn().mockResolvedValue({
    session: { id: "hermes-session" },
    sessionFile: "/tmp/hermes.session.json",
  }),
  mockPromptWithFallback: vi.fn().mockResolvedValue(undefined),
  mockDescribeModel: vi.fn().mockReturnValue("anthropic/claude-sonnet-4-5"),
}));

vi.mock("../pi-module.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPromptWithFallback,
  describeModel: mockDescribeModel,
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
    settings: {},
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports a valid Fusion plugin manifest", () => {
    const fusionPlugin = plugin as FusionPlugin;

    expect(fusionPlugin).toBeDefined();
    expect(fusionPlugin.manifest.id).toBe("fusion-plugin-hermes-runtime");
  });

  it("registers Hermes runtime metadata", () => {
    expect(plugin.runtime).toBeDefined();
    expect(plugin.runtime?.metadata.runtimeId).toBe("hermes");
  });

  it("runtime factory returns an AgentRuntime-compatible Hermes adapter", async () => {
    const runtime = (await plugin.runtime!.factory(createMockContext() as any)) as AgentRuntime;

    expect(runtime.id).toBe("hermes");
    expect(runtime.name).toBe("Hermes Runtime");
    expect(isAgentRuntime(runtime)).toBe(true);
  });

  it("onLoad emits hermes-runtime:loaded with runtime metadata", async () => {
    const ctx = createMockContext();

    await plugin.hooks.onLoad?.(ctx as any);

    expect(ctx.emitEvent).toHaveBeenCalledWith("hermes-runtime:loaded", {
      runtimeId: "hermes",
      version: "0.1.0",
    });
  });
});
