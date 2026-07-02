// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createFnAgentMock, resolveMcpServersForStoreMock } = vi.hoisted(() => ({
  createFnAgentMock: vi.fn(async () => ({
    session: {
      state: { messages: [] as Array<{ role: string; content: string }> },
      prompt: vi.fn(async function (this: { state: { messages: Array<{ role: string; content: string }> } }, _message: string) {
        this.state.messages.push({
          role: "assistant",
          content: JSON.stringify({
            type: "question",
            data: {
              id: "q1",
              text: "What should be built?",
              type: "text",
              required: true,
            },
          }),
        });
      }),
      dispose: vi.fn(),
    },
  })),
  resolveMcpServersForStoreMock: vi.fn(async () => ({
    servers: [{ name: "docs", transport: "stdio", command: "node", env: { TOKEN: "materialized-secret" } }],
    errors: [],
  })),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    DEFAULT_TASK_PRIORITY: "normal",
    TASK_PRIORITIES: ["low", "normal", "high", "urgent"],
    resolvePrompt: vi.fn(() => undefined),
    summarizeTitle: vi.fn((value: string) => value.slice(0, 80)),
  };
});

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    buildSessionSkillContextSync: vi.fn(() => ({ skillSelectionContext: undefined })),
    createChatTaskDocumentTools: vi.fn(() => []),
    createWorkflowAuthoringTools: vi.fn(() => []),
    createFnAgent: createFnAgentMock,
    resolveMcpServersForStore: resolveMcpServersForStoreMock,
  };
});

vi.mock("../planning-board-tools.js", () => ({
  createPlanningBoardTools: vi.fn(() => []),
}));

import { __resetPlanningState, createSession, createSessionWithAgent, planningStreamManager } from "../planning.js";
import { resolveManualAiPromptMcpServers } from "../routes.js";
import { createMissionInterviewAgent } from "../mission-interview.js";
import { createTargetInterviewAgent } from "../milestone-slice-interview.js";

describe("dashboard MCP lane forwarding", () => {
  beforeEach(() => {
    __resetPlanningState();
    createFnAgentMock.mockClear();
    resolveMcpServersForStoreMock.mockClear();
  });

  it("forwards the materialized MCP set to chat/planning createFnAgent sessions", async () => {
    const store = {} as never;

    await createSession("127.0.0.1", "Build a feature", store, "/tmp/fusion-dashboard-test");

    expect(resolveMcpServersForStoreMock).toHaveBeenCalledWith(store);
    expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/fusion-dashboard-test",
      tools: "readonly",
      allowMcpToolsInReadonly: true,
      mcpServers: [expect.objectContaining({ name: "docs", env: { TOKEN: "materialized-secret" } })],
    }));
  });

  it("defaults an undefined MCP resolver result to empty servers for non-streaming planning", async () => {
    resolveMcpServersForStoreMock.mockResolvedValueOnce(undefined as never);

    await createSession("127.0.0.1", "Build without MCP", {} as never, "/tmp/fusion-dashboard-test");

    expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      tools: "readonly",
      allowMcpToolsInReadonly: true,
      mcpServers: [],
    }));
  });

  it("defaults an undefined MCP resolver result to empty servers for streaming planning", async () => {
    resolveMcpServersForStoreMock.mockResolvedValueOnce(undefined as never);

    const sessionId = await createSessionWithAgent(
      "127.0.0.1",
      "Stream without MCP",
      "/tmp/fusion-dashboard-test",
      {} as never,
    );

    const startInitialTurn = planningStreamManager.consumeInitialTurn(sessionId);
    expect(startInitialTurn).toBeTypeOf("function");
    startInitialTurn?.();

    await vi.waitFor(() => expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      tools: "readonly",
      allowMcpToolsInReadonly: true,
      mcpServers: [],
    })));
  });

  it("resolves materialized MCP servers for manual AI-prompt workflow steps", async () => {
    const store = {} as never;

    await expect(resolveManualAiPromptMcpServers(store)).resolves.toEqual([
      expect.objectContaining({ name: "docs", env: { TOKEN: "materialized-secret" } }),
    ]);
    expect(resolveMcpServersForStoreMock).toHaveBeenCalledWith(store);
  });

  it("preserves empty MCP results for manual AI-prompt workflow steps", async () => {
    resolveMcpServersForStoreMock.mockResolvedValueOnce({ servers: [], errors: [] });

    await expect(resolveManualAiPromptMcpServers({} as never)).resolves.toEqual([]);
  });

  it("forwards materialized MCP servers to mission interview agents", async () => {
    const store = {} as never;
    const session = { id: "mission-session", thinkingOutput: "" } as never;

    await createMissionInterviewAgent(session, "/tmp/fusion-dashboard-test", store);

    expect(resolveMcpServersForStoreMock).toHaveBeenCalledWith(store);
    expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/fusion-dashboard-test",
      tools: "readonly",
      allowMcpToolsInReadonly: true,
      mcpServers: [expect.objectContaining({ name: "docs", env: { TOKEN: "materialized-secret" } })],
    }));
  });

  it("forwards empty MCP results to mission interview agents", async () => {
    resolveMcpServersForStoreMock.mockResolvedValueOnce({ servers: [], errors: [] });

    await createMissionInterviewAgent({ id: "mission-empty", thinkingOutput: "" } as never, "/tmp/fusion-dashboard-test", {} as never);

    expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: [] }));
  });

  it("forwards materialized MCP servers to milestone and slice interview agents", async () => {
    const store = {} as never;
    const session = { id: "target-session", targetType: "milestone", thinkingOutput: "" } as never;

    await createTargetInterviewAgent(session, "/tmp/fusion-dashboard-test", store);

    expect(resolveMcpServersForStoreMock).toHaveBeenCalledWith(store);
    expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/fusion-dashboard-test",
      tools: "readonly",
      allowMcpToolsInReadonly: true,
      mcpServers: [expect.objectContaining({ name: "docs", env: { TOKEN: "materialized-secret" } })],
    }));
  });

  it("forwards empty MCP results to milestone and slice interview agents", async () => {
    resolveMcpServersForStoreMock.mockResolvedValueOnce({ servers: [], errors: [] });

    await createTargetInterviewAgent({ id: "target-empty", targetType: "slice", thinkingOutput: "" } as never, "/tmp/fusion-dashboard-test", {} as never);

    expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: [] }));
  });
});
