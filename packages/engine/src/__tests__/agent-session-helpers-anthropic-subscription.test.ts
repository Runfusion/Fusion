import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveRuntimeMock } = vi.hoisted(() => ({ resolveRuntimeMock: vi.fn() }));

vi.mock("../execution/runtime-resolution.js", async () => {
  const actual = await vi.importActual<typeof import("../execution/runtime-resolution.js")>("../execution/runtime-resolution.js");
  return { ...actual, resolveRuntime: resolveRuntimeMock };
});

import { createResolvedAgentSession } from "../agents/agent-session-helpers.js";

describe("createResolvedAgentSession Anthropic auth-id normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes direct Anthropic ids to credential resolution and runtime creation", async () => {
    const createSession = vi.fn().mockResolvedValue({ session: { prompt: vi.fn() } });
    resolveRuntimeMock.mockResolvedValue({
      runtime: { id: "pi", createSession, promptWithFallback: vi.fn(), describeModel: vi.fn() },
      runtimeId: "pi",
      wasConfigured: false,
    });
    const getDefaultInstance = vi.fn().mockReturnValue({ providerId: "anthropic", instanceId: "subscription" });
    const authStorage = {
      getInstance: vi.fn(),
      getDefaultInstance,
      listInstances: vi.fn().mockReturnValue([]),
    } as any;

    await createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/project",
      systemPrompt: "system",
      defaultProvider: "anthropic-subscription",
      defaultModelId: "claude-opus-4-8",
      fallbackProvider: "anthropic-api-key",
      fallbackModelId: "claude-sonnet-4-5",
      credentialInstanceId: "missing",
      authStorage,
    });

    expect(getDefaultInstance).toHaveBeenCalledWith("anthropic");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      defaultProvider: "anthropic",
      fallbackProvider: "anthropic",
    }));
  });
});
