/**
 * ChatManager.sendMessage cli-agent send-branch (CLI Agent Executor integration).
 *
 * When a chat session selects a cli-agent executor (`cliExecutorAdapterId`),
 * sendMessage must broker the composer text to the injected CliChatSessionRunner
 * (ensureSession + send) rather than running the model agent loop. Narrow fakes:
 * no real ChatStore, no pi-ai agent, no PTY, no network, no port 4040.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Title generation is a shared server seam; stub the summarizer so the CLI branch can be
// asserted without a model call.
const { mockSummarizeTitle } = vi.hoisted(() => ({ mockSummarizeTitle: vi.fn() }));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  summarizeTitle: mockSummarizeTitle,
}));

import { ChatManager } from "../chat.js";

const mockChatStore = {
  getSession: vi.fn(),
  createSession: vi.fn(),
  addMessage: vi.fn(),
  getMessages: vi.fn(),
  updateSession: vi.fn(),
  setCliSessionFile: vi.fn(),
  setInFlightGeneration: vi.fn(),
  getRoomMessages: vi.fn(),
  recordTokenUsage: vi.fn(),
};

function makeManager(): ChatManager {
  return new ChatManager(mockChatStore as never, "/tmp/test");
}

describe("ChatManager.sendMessage — cli-agent send branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSummarizeTitle.mockResolvedValue("Generated CLI Title");
    mockChatStore.updateSession.mockResolvedValue(undefined);
  });

  /*
   * (S2) Regression: a CLI-agent-backed session returns before the model loop, so before FN-455
   * it never reached the title-generation block and stayed "Untitled conversation" forever.
   */
  it("generates a title for an untitled cli-executor session", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-cli-title",
      cliExecutorAdapterId: "claude-code",
      projectId: "proj-1",
      title: null,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    const manager = makeManager();
    manager.setCliChatRunner({ ensureSession: vi.fn(async () => "s"), send: vi.fn(async () => "sent" as const) }, "proj-1");

    await manager.sendMessage("chat-cli-title", "Explain the merge gate");

    await vi.waitFor(() => expect(mockSummarizeTitle).toHaveBeenCalled());
    expect(mockSummarizeTitle).toHaveBeenCalledWith(
      "Explain the merge gate",
      "/tmp/test",
      "anthropic",
      "claude-sonnet-4-5",
      expect.anything(),
    );
    await vi.waitFor(() =>
      expect(mockChatStore.updateSession).toHaveBeenCalledWith("chat-cli-title", { title: "Generated CLI Title" }),
    );
  });

  // (S4) Negative control: an already-titled cli session must not be renamed.
  it("does not generate a title for a cli-executor session that already has one", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-cli-titled",
      cliExecutorAdapterId: "claude-code",
      projectId: "proj-1",
      title: "Existing Title",
    });
    const manager = makeManager();
    manager.setCliChatRunner({ ensureSession: vi.fn(async () => "s"), send: vi.fn(async () => "sent" as const) }, "proj-1");

    await manager.sendMessage("chat-cli-titled", "Another message");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockSummarizeTitle).not.toHaveBeenCalled();
    expect(mockChatStore.updateSession).not.toHaveBeenCalled();
  });

  it("routes a cli-executor chat session's composer send to runner.send", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-cli",
      cliExecutorAdapterId: "claude-code",
      projectId: "proj-1",
    });

    const ensureSession = vi.fn(async () => "cli-session-1");
    const send = vi.fn(async () => "sent" as const);
    const manager = makeManager();
    manager.setCliChatRunner({ ensureSession, send }, "proj-1");

    await manager.sendMessage("chat-cli", "hello agent");

    expect(ensureSession).toHaveBeenCalledWith("chat-cli", { projectId: "proj-1" });
    expect(send).toHaveBeenCalledWith("chat-cli", "hello agent");
    // The model-agent path persists in-flight generation state; the cli branch
    // must NOT touch it.
    expect(mockChatStore.setInFlightGeneration).not.toHaveBeenCalled();
  });

  it("uses the session's projectId when no explicit runner projectId is set", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-cli2",
      cliExecutorAdapterId: "codex",
      projectId: "proj-from-session",
    });
    const ensureSession = vi.fn(async () => "cli-session-2");
    const send = vi.fn(async () => "queued" as const);
    const manager = makeManager();
    // No projectId passed to setCliChatRunner → falls back to session.projectId.
    manager.setCliChatRunner({ ensureSession, send });

    await manager.sendMessage("chat-cli2", "queued please");

    expect(ensureSession).toHaveBeenCalledWith("chat-cli2", { projectId: "proj-from-session" });
    expect(send).toHaveBeenCalledWith("chat-cli2", "queued please");
  });

  it("persists cli-chat token usage from the runner telemetry snapshot", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-cli3",
      cliExecutorAdapterId: "claude-code",
      projectId: "proj-1",
      agentId: "agent-cli",
      modelId: "claude-sonnet-4-5",
    });
    const ensureSession = vi.fn(async () => "cli-session-3");
    const send = vi.fn(async () => "sent" as const);
    const getTokenUsageSnapshot = vi.fn(async () => ({
      tokens: { input: 17, output: 23, cacheRead: 5, cacheWrite: 7, total: 52 },
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      messageId: "msg-cli-assistant",
      createdAt: "2026-07-02T00:00:00.000Z",
    }));
    const manager = makeManager();
    manager.setCliChatRunner({ ensureSession, send, getTokenUsageSnapshot }, "proj-1");

    await manager.sendMessage("chat-cli3", "hello cli");

    expect(mockChatStore.recordTokenUsage).toHaveBeenCalledWith({
      sourceKind: "cli-chat",
      chatSessionId: "chat-cli3",
      messageId: "msg-cli-assistant",
      projectId: "proj-1",
      agentId: "agent-cli",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      createdAt: "2026-07-02T00:00:00.000Z",
      inputTokens: 17,
      outputTokens: 23,
      cachedTokens: 5,
      cacheWriteTokens: 7,
      totalTokens: 52,
    });
  });
});
