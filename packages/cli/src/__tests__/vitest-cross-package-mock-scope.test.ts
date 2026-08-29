import { afterEach, expect, it, vi } from "vitest";
import { ChatManager, __resetChatState, __setCreateResolvedAgentSession } from "../../../dashboard/src/chat.js";
import { createFnAgent } from "../../../engine/src/pi.js";

const { createAgentSessionMock, findModelMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  findModelMock: vi.fn((provider: string, id: string) => ({ provider, id })),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createAgentSession: createAgentSessionMock,
  createBashTool: vi.fn(() => ({ name: "bash" })),
  createCodingTools: vi.fn(() => []),
  createEditTool: () => ({ name: "edit" }),
  createExtensionRuntime: vi.fn(),
  createFindTool: () => ({ name: "find" }),
  createGrepTool: () => ({ name: "grep" }),
  createLsTool: () => ({ name: "ls" }),
  createReadOnlyTools: vi.fn(() => []),
  createReadTool: () => ({ name: "read" }),
  createWriteTool: () => ({ name: "write" }),
  DefaultResourceLoader: class { async reload() {} },
  DefaultPackageManager: class { async resolve() { return { extensions: [] }; } },
  discoverAndLoadExtensions: vi.fn(async () => ({ runtime: { pendingProviderRegistrations: [] }, errors: [] })),
  getAgentDir: () => "/mock-agent-dir",
  LegacyCredentialStorage: { create: () => ({ setFallbackResolver: vi.fn(), getApiKey: vi.fn(), get: vi.fn(), set: vi.fn(), has: vi.fn(), hasAuth: vi.fn(), getAll: vi.fn(() => ({})), list: vi.fn(), logout: vi.fn(), remove: vi.fn(), reload: vi.fn() }) },
  ModelRuntime: { create: async () => ({ getAuth: async () => ({ auth: { headers: {} } }), refresh: async () => {} }) },
  ModelRegistry: class { static create() { return new this(); } find(provider: string, id: string) { return findModelMock(provider, id); } getAll() { return []; } registerProvider() {} async refresh() {} async getApiKeyAndHeaders() { return { ok: true }; } },
  SettingsManager: { create: () => ({}), inMemory: () => ({}) },
}));

afterEach(() => {
  createAgentSessionMock.mockReset();
  findModelMock.mockClear();
  __resetChatState();
});

it("routes a CLI pi mock through dashboard chat and engine source", async () => {
  /*
  FNXC:CliTests 2026-08-11-04:52:
  This must turn red if the exact pi-coding-agent alias is removed. That regression silently
  disabled a security permission gate because dashboard and engine resolved peer-hashed runtime
  copies that did not receive the CLI test's vi.mock.
  */
  createAgentSessionMock.mockResolvedValue({
    session: {
      state: { messages: [] },
      subscribe: vi.fn(),
      dispose: vi.fn(),
      prompt: vi.fn(async () => undefined),
      setThinkingLevel: vi.fn(),
    },
  });
  __setCreateResolvedAgentSession(async (options) => createFnAgent({ ...options, tools: "coding" }) as any);

  const chatStore = {
    /*
    FNXC:CliTests 2026-08-23-16:12:
    TITLED SESSION ON PURPOSE. An untitled chat session makes `ChatManager.sendMessage` fire a
    non-blocking title summarizer, which creates a SECOND pi session through the same factory — a
    race whose timing decides the call count. Seeding a title suppresses that side-channel so this
    guard keeps measuring the one thing it exists for: the CLI `vi.mock` reaching the dashboard and
    engine copies of the runtime.
    */
    getSession: vi.fn(() => ({ id: "mock-scope", agentId: "agent-mock-scope", status: "active", title: "Mock scope session" })),
    addMessage: vi.fn((message) => ({ id: `message-${message.role}`, ...message })),
    getMessages: vi.fn(() => []),
    setCliSessionFile: vi.fn(async () => undefined),
    setInFlightGeneration: vi.fn(async () => undefined),
    updateSession: vi.fn(async () => undefined),
    recordTokenUsage: vi.fn(async () => undefined),
  };
  const agentStore = {
    init: vi.fn(async () => undefined),
    getAgent: vi.fn(async () => ({ id: "agent-mock-scope", name: "Mock Scope Agent", role: "executor", runtimeConfig: {} })),
  };

  const manager = new ChatManager(chatStore as any, process.cwd(), agentStore as any);
  await manager.sendMessage("mock-scope", "exercise the engine session factory");

  expect(createAgentSessionMock).toHaveBeenCalledOnce();
});
