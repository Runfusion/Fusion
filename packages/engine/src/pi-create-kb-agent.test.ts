import { beforeEach, describe, expect, it, vi } from "vitest";

const createAgentSessionMock = vi.fn();
const createCodingToolsMock = vi.fn(() => []);
const createReadOnlyToolsMock = vi.fn(() => []);
const createExtensionRuntimeMock = vi.fn();
const discoverAndLoadExtensionsMock = vi.fn().mockResolvedValue({
  runtime: { pendingProviderRegistrations: [] },
  errors: [],
});
const packageManagerResolveMock = vi.fn().mockResolvedValue({ extensions: [] });
const findMock = vi.fn();
const registerProviderMock = vi.fn();
const refreshMock = vi.fn();
const settingsManagerCreateMock = vi.fn(() => ({ kind: "settings-manager-create" }));
const setFallbackResolverMock = vi.fn();
const reloadMock = vi.fn(async () => {});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
    create: () => ({
      setFallbackResolver: setFallbackResolverMock,
    }),
  },
  createAgentSession: createAgentSessionMock,
  createCodingTools: createCodingToolsMock,
  createExtensionRuntime: createExtensionRuntimeMock,
  createReadOnlyTools: createReadOnlyToolsMock,
  DefaultResourceLoader: class {
    async reload() {
      await reloadMock();
    }
  },
  DefaultPackageManager: class {
    async resolve() {
      return packageManagerResolveMock();
    }
  },
  discoverAndLoadExtensions: discoverAndLoadExtensionsMock,
  getAgentDir: () => "/mock-agent-dir",
  ModelRegistry: class {
    find(provider: string, modelId: string) {
      return findMock(provider, modelId);
    }
    registerProvider(name: string, config: unknown) {
      return registerProviderMock(name, config);
    }
    refresh() {
      return refreshMock();
    }
  },
  SessionManager: {
    inMemory: () => ({ kind: "session-manager" }),
  },
  SettingsManager: {
    create: settingsManagerCreateMock,
    inMemory: () => ({ kind: "settings-manager" }),
  },
}));

describe("createKbAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMock.mockImplementation((provider: string, modelId: string) => ({ provider, id: modelId }));
    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        subscribe: vi.fn(),
        dispose: vi.fn(),
        setThinkingLevel: vi.fn(),
      },
    });
  });

  it("registers extension providers before resolving configured models", async () => {
    packageManagerResolveMock.mockResolvedValueOnce({
      extensions: [{ enabled: true, path: "/extensions/zai-provider" }],
    });
    discoverAndLoadExtensionsMock.mockResolvedValueOnce({
      runtime: {
        pendingProviderRegistrations: [
          {
            name: "zai",
            config: { models: [{ id: "glm-5.1" }] },
            extensionPath: "/extensions/zai-provider",
          },
        ],
      },
      errors: [],
    });

    const { createKbAgent } = await import("./pi.js");

    await createKbAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "zai",
      defaultModelId: "glm-5.1",
    });

    expect(discoverAndLoadExtensionsMock).toHaveBeenCalledWith(["/extensions/zai-provider"], "/tmp", undefined);
    expect(registerProviderMock).toHaveBeenCalledWith("zai", expect.objectContaining({
      models: [{ id: "glm-5.1" }],
    }));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("avoids lock-based SettingsManager.create when loading extension providers", async () => {
    const { createKbAgent } = await import("./pi.js");

    await createKbAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    });

    expect(packageManagerResolveMock).toHaveBeenCalled();
    expect(discoverAndLoadExtensionsMock).toHaveBeenCalled();
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(settingsManagerCreateMock).not.toHaveBeenCalled();
  });

  it("throws when the configured primary model cannot be resolved", async () => {
    findMock.mockImplementation((provider: string, modelId: string) => (
      provider === "zai" && modelId === "glm-5.1" ? undefined : { provider, id: modelId }
    ));

    const { createKbAgent } = await import("./pi.js");

    await expect(createKbAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "zai",
      defaultModelId: "glm-5.1",
    })).rejects.toThrow("Configured primary model zai/glm-5.1 was not found");

    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  it("throws when the configured fallback model cannot be resolved", async () => {
    findMock.mockImplementation((provider: string, modelId: string) => (
      provider === "openai-codex" && modelId === "missing-model" ? undefined : { provider, id: modelId }
    ));

    const { createKbAgent } = await import("./pi.js");

    await expect(createKbAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "coding",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackProvider: "openai-codex",
      fallbackModelId: "missing-model",
    })).rejects.toThrow("Configured fallback model openai-codex/missing-model was not found");

    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  it("creates a session when configured models resolve successfully", async () => {
    const { createKbAgent } = await import("./pi.js");

    await createKbAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.3-codex",
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock.mock.calls[0][0]).toMatchObject({
      model: { provider: "openai-codex", id: "gpt-5.4" },
    });
  });
});
