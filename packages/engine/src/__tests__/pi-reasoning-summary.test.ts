import { beforeEach, describe, expect, it, vi } from "vitest";

const createAgentSessionMock = vi.fn();
const modelRegistry = {
  modelRuntime: { getAuth: vi.fn(), refresh: vi.fn() },
  find: vi.fn((provider: string, id: string) => ({ provider, id })),
  getAll: vi.fn(() => []),
  registerProvider: vi.fn(),
};

vi.mock("@earendil-works/pi-coding-agent", () => ({
  LegacyCredentialStorage: { create: vi.fn(() => ({})) },
  createAgentSession: createAgentSessionMock,
  createBashTool: vi.fn((cwd: string) => ({ name: "bash", cwd })),
  createCodingTools: vi.fn(() => []),
  createEditTool: vi.fn(() => ({ name: "edit" })),
  createExtensionRuntime: vi.fn(),
  createFindTool: vi.fn(() => ({ name: "find" })),
  createGrepTool: vi.fn(() => ({ name: "grep" })),
  createLsTool: vi.fn(() => ({ name: "ls" })),
  createReadOnlyTools: vi.fn(() => []),
  createReadTool: vi.fn(() => ({ name: "read" })),
  createWriteTool: vi.fn(() => ({ name: "write" })),
  DefaultResourceLoader: class { async reload() {} },
  DefaultPackageManager: class { async resolve() { return { extensions: [] }; } },
  discoverAndLoadExtensions: vi.fn(async () => ({ runtime: { pendingProviderRegistrations: [] }, errors: [] })),
  getAgentDir: () => "/mock-agent-dir",
  ModelRegistry: class {},
  ModelRuntime: { create: vi.fn(async () => modelRegistry.modelRuntime) },
  SessionManager: { inMemory: () => ({ getSessionId: () => undefined }) },
  SettingsManager: { inMemory: () => ({}) },
}));

vi.mock("../auth/auth-storage.js", () => ({
  createFusionAuthStorage: vi.fn(() => ({})),
  createFusionModelRegistry: vi.fn(async () => modelRegistry),
}));
vi.mock("../auth/model-registry-refresh.js", () => ({
  refreshFusionModelRegistry: vi.fn(async () => "completed"),
}));
vi.mock("../auth/custom-providers.js", () => ({ readCustomProviders: vi.fn(() => []) }));

function makeSession(agent: { onPayload?: (payload: unknown, model: { api?: unknown }) => unknown | Promise<unknown> } = {}) {
  return {
    agent,
    prompt: vi.fn(async () => undefined),
    subscribe: vi.fn(),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
  };
}

async function createSession(session = makeSession(), options: Record<string, unknown> = {}) {
  createAgentSessionMock.mockResolvedValueOnce({ session });
  const { createPiAgentSessionRaw } = await import("../pi.js");
  const result = await createPiAgentSessionRaw({
    cwd: "/tmp",
    systemPrompt: "test",
    tools: "readonly",
    defaultProvider: "openai",
    defaultModelId: "gpt-5",
    ...options,
  });
  return { result, session };
}

/*
FNXC:ThinkingTrace 2026-08-27-10:45:
Fusion can prove only the request payload it sends; a provider's generated reasoning bodies are outside this process. These tests therefore exercise the live createFnAgent session hook rather than asserting provider response content.
*/
describe("createFnAgent reasoning-summary payload hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelRegistry.find.mockImplementation((provider: string, id: string) => ({ provider, id }));
    modelRegistry.getAll.mockReturnValue([]);
  });

  it("installs onPayload on every created pi session", async () => {
    const session = makeSession();
    await createSession(session);

    expect(session.agent.onPayload).toEqual(expect.any(Function));
  });

  it("upgrades a Responses request while preserving its effort", async () => {
    const { session } = await createSession();
    const result = await session.agent.onPayload?.(
      { reasoning: { effort: "medium", summary: "auto" } },
      { api: "openai-responses" },
    );

    expect(result).toEqual({ reasoning: { effort: "medium", summary: "detailed" } });
  });

  it("leaves Anthropic and disabled-thinking requests unchanged", async () => {
    const { session } = await createSession();
    const anthropicPayload = { reasoning: { effort: "medium", summary: "auto" } };
    const disabledPayload = { reasoning: { effort: "none" } };

    expect(await session.agent.onPayload?.(anthropicPayload, { api: "anthropic-messages" })).toBeUndefined();
    expect(await session.agent.onPayload?.(disabledPayload, { api: "openai-responses" })).toBeUndefined();
  });

  it("chains an upstream replacement and preserves it when Fusion makes no change", async () => {
    const replacement = { reasoning: { effort: "high", summary: "auto" }, source: "upstream" };
    const upstream = vi.fn(() => replacement);
    const { session } = await createSession(makeSession({ onPayload: upstream }));

    expect(await session.agent.onPayload?.({ ignored: true }, { api: "openai-responses" })).toEqual({
      reasoning: { effort: "high", summary: "detailed" },
      source: "upstream",
    });
    expect(await session.agent.onPayload?.({ ignored: true }, { api: "anthropic-messages" })).toBe(replacement);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does not upgrade requests when summary detail is off", async () => {
    const { session } = await createSession(makeSession(), { reasoningSummaryDetail: "off" });

    expect(await session.agent.onPayload?.(
      { reasoning: { effort: "medium", summary: "auto" } },
      { api: "openai-responses" },
    )).toBeUndefined();
  });

  it("retries once on the same session after an unsupported-summary rejection", async () => {
    const requests: unknown[] = [];
    const agent: { onPayload?: (payload: unknown, model: { api?: unknown }) => Promise<unknown> } = {};
    const session = makeSession(agent);
    const prompt = session.prompt;
    let attempts = 0;
    prompt.mockImplementation(async () => {
      requests.push(await agent.onPayload?.(
        { reasoning: { effort: "medium", summary: "auto" } },
        { api: "openai-responses" },
      ));
      attempts += 1;
      if (attempts === 1) throw new Error("Unsupported reasoning summary: detailed");
    });

    const { result } = await createSession(session);
    await (result.session as any).promptWithFallback("test summary fallback");

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([
      { reasoning: { effort: "medium", summary: "detailed" } },
      undefined,
    ]);
  });
});
