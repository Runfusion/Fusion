import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractRuntimeHint,
  resolveHeartbeatSessionModels,
  resolveMergerSessionModel,
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

describe("resolveHeartbeatSessionModels", () => {
  it("uses agent runtime model as primary and execution settings as fallback", () => {
    expect(resolveHeartbeatSessionModels(
      {
        executionProvider: "openai",
        executionModelId: "gpt-4.1",
      },
      { model: "anthropic/claude-sonnet-4-5" },
    )).toEqual({
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      fallbackProvider: "openai",
      fallbackModelId: "gpt-4.1",
    });
  });

  it("uses execution settings model when runtime override is missing", () => {
    expect(resolveHeartbeatSessionModels(
      {
        executionProvider: "openai",
        executionModelId: "gpt-4.1",
      },
      {},
    )).toEqual({
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
  });

  it("does not duplicate fallback when runtime and execution model are the same", () => {
    expect(resolveHeartbeatSessionModels(
      {
        executionProvider: "openai",
        executionModelId: "gpt-4.1",
      },
      { modelProvider: "openai", modelId: "gpt-4.1" },
    )).toEqual({
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
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
});

describe("resolveMergerSessionModel", () => {
  it("uses assigned agent runtime model when both provider and modelId are present", () => {
    expect(
      resolveMergerSessionModel(
        {
          defaultProviderOverride: "openai",
          defaultModelIdOverride: "gpt-4.1",
          defaultProvider: "anthropic",
          defaultModelId: "claude-3-5-sonnet",
        },
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
