/**
 * Tests for ChatManager - specifically text accumulation behavior
 * These tests verify the fix for FN-1857: Chat assistant messages not persisted after navigating away
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatManager, __setCreateKbAgent, __resetChatState } from "../chat.js";

// ── Mock Setup ──────────────────────────────────────────────────────────────

// Mock summarizeTitle using vi.hoisted so it's available at module hoisting time
const { mockSummarizeTitle } = vi.hoisted(() => ({
  mockSummarizeTitle: vi.fn(),
}));

vi.mock("@fusion/core", () => ({
  summarizeTitle: mockSummarizeTitle,
}));

// ── Mock Store ──────────────────────────────────────────────────────────────

const mockChatStore = {
  getSession: vi.fn(),
  createSession: vi.fn(),
  addMessage: vi.fn(),
  getMessages: vi.fn(),
  updateSession: vi.fn(),
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ChatManager.sendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetChatState();

    // Default mock setup
    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: "agent-001",
      status: "active",
    });
    mockChatStore.addMessage.mockReturnValue({
      id: "msg-001",
      sessionId: "chat-001",
      role: "assistant",
      content: "",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accumulates streamed text and uses it for message persistence", async () => {
    // Track the callbacks to simulate streaming
    let onThinkingCb: ((delta: string) => void) | undefined;
    let onTextCb: ((delta: string) => void) | undefined;

    __setCreateKbAgent(async (options: any) => {
      onThinkingCb = options.onThinking;
      onTextCb = options.onText;

      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate streaming via callbacks
            onTextCb?.("Hello ");
            onTextCb?.("world!");
            onThinkingCb?.("Let me think...");
          }),
          dispose: vi.fn(),
          state: {
            messages: [], // Empty - relying on accumulated text
          },
        },
      };
    });

    // Arrange
    const chatManager = new ChatManager(
      mockChatStore as any,
      "/tmp/test",
    );

    // Act
    await chatManager.sendMessage("chat-001", "Hello");

    // Assert - verify that addMessage was called with accumulated text
    const assistantCall = mockChatStore.addMessage.mock.calls.find(
      (call) => call[1].role === "assistant"
    );
    expect(assistantCall).toBeDefined();
    expect(assistantCall?.[1].content).toBe("Hello world!");
  });

  it("accumulates thinking output separately from text", async () => {
    let onThinkingCb: ((delta: string) => void) | undefined;
    let onTextCb: ((delta: string) => void) | undefined;

    __setCreateKbAgent(async (options: any) => {
      onThinkingCb = options.onThinking;
      onTextCb = options.onText;

      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            onTextCb?.("Response");
            onThinkingCb?.("Thinking...");
          }),
          dispose: vi.fn(),
          state: { messages: [] },
        },
      };
    });

    const chatManager = new ChatManager(
      mockChatStore as any,
      "/tmp/test",
    );

    await chatManager.sendMessage("chat-001", "Hello");

    // Assert - thinking output is accumulated
    const assistantCall = mockChatStore.addMessage.mock.calls.find(
      (call) => call[1].role === "assistant"
    );
    expect(assistantCall?.[1].thinkingOutput).toBe("Thinking...");
  });

  it("uses accumulated text as primary source over state.messages extraction", async () => {
    __setCreateKbAgent(async (options: any) => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Fire onText callbacks
            if (options.onText) {
              options.onText("Accumulated text");
            }
          }),
          dispose: vi.fn(),
          state: {
            messages: [
              { role: "assistant", content: "State messages text" },
            ],
          },
        },
      };
    });

    const chatManager = new ChatManager(
      mockChatStore as any,
      "/tmp/test",
    );

    await chatManager.sendMessage("chat-001", "Hello");

    // Assert - accumulated text takes precedence
    const assistantCall = mockChatStore.addMessage.mock.calls.find(
      (call) => call[1].role === "assistant"
    );
    expect(assistantCall?.[1].content).toBe("Accumulated text");
  });

  it("falls back to state.messages when accumulated text is empty", async () => {
    __setCreateKbAgent(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Don't fire onText callbacks - rely on state.messages
          }),
          dispose: vi.fn(),
          state: {
            messages: [
              { role: "assistant", content: "Fallback text" },
            ],
          },
        },
      };
    });

    const chatManager = new ChatManager(
      mockChatStore as any,
      "/tmp/test",
    );

    await chatManager.sendMessage("chat-001", "Hello");

    // Assert - falls back to state.messages
    const assistantCall = mockChatStore.addMessage.mock.calls.find(
      (call) => call[1].role === "assistant"
    );
    expect(assistantCall?.[1].content).toBe("Fallback text");
  });

  it("handles array content format in state.messages extraction", async () => {
    __setCreateKbAgent(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // No onText callbacks
          }),
          dispose: vi.fn(),
          state: {
            messages: [
              {
                role: "assistant",
                content: [
                  { type: "text", text: "Part1 " },
                  { type: "text", text: "Part2" },
                ],
              },
            ],
          },
        },
      };
    });

    const chatManager = new ChatManager(
      mockChatStore as any,
      "/tmp/test",
    );

    await chatManager.sendMessage("chat-001", "Hello");

    // Assert - array content is joined
    const assistantCall = mockChatStore.addMessage.mock.calls.find(
      (call) => call[1].role === "assistant"
    );
    expect(assistantCall?.[1].content).toBe("Part1 Part2");
  });

  it("persists user message before AI response", async () => {
    __setCreateKbAgent(async (options: any) => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (options.onText) options.onText("Response");
          }),
          dispose: vi.fn(),
          state: { messages: [] },
        },
      };
    });

    const chatManager = new ChatManager(
      mockChatStore as any,
      "/tmp/test",
    );

    await chatManager.sendMessage("chat-001", "User message");

    // Assert - user message is persisted first
    const calls = mockChatStore.addMessage.mock.calls;
    expect(calls[0]).toEqual([
      "chat-001",
      expect.objectContaining({
        role: "user",
        content: "User message",
      }),
    ]);
    // Assistant message is persisted second
    expect(calls[1][0]).toBe("chat-001");
    expect(calls[1][1].role).toBe("assistant");
  });

  it("generates title when session has no title", async () => {
    mockSummarizeTitle.mockResolvedValue("Short Title");

    __setCreateKbAgent(async (options: any) => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (options.onText) options.onText("Response");
          }),
          dispose: vi.fn(),
          state: { messages: [] },
        },
      };
    });

    const chatManager = new ChatManager(
      mockChatStore as any,
      "/tmp/test",
    );

    await chatManager.sendMessage("chat-001", "This is a long message that needs to be summarized");

    // Wait for the async title generation
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Assert - summarizeTitle was called with the message content and model params
    expect(mockSummarizeTitle).toHaveBeenCalledWith(
      "This is a long message that needs to be summarized",
      "/tmp/test",
      undefined,
      undefined,
    );

    // Assert - session was updated with the generated title
    expect(mockChatStore.updateSession).toHaveBeenCalledWith("chat-001", { title: "Short Title" });
  });

  it("uses truncated content when summarizeTitle returns null", async () => {
    mockSummarizeTitle.mockResolvedValue(null);

    __setCreateKbAgent(async (options: any) => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (options.onText) options.onText("Response");
          }),
          dispose: vi.fn(),
          state: { messages: [] },
        },
      };
    });

    const chatManager = new ChatManager(
      mockChatStore as any,
      "/tmp/test",
    );

    const longMessage = "A".repeat(300);
    await chatManager.sendMessage("chat-001", longMessage);

    // Wait for the async title generation
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Assert - summarizeTitle was called
    expect(mockSummarizeTitle).toHaveBeenCalled();

    // Assert - session was updated with truncated content (first 60 chars)
    expect(mockChatStore.updateSession).toHaveBeenCalledWith("chat-001", { title: "A".repeat(60) });
  });

  it("does not generate title when session already has a title", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: "agent-001",
      status: "active",
      title: "Existing Title",
    });

    __setCreateKbAgent(async (options: any) => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (options.onText) options.onText("Response");
          }),
          dispose: vi.fn(),
          state: { messages: [] },
        },
      };
    });

    const chatManager = new ChatManager(
      mockChatStore as any,
      "/tmp/test",
    );

    await chatManager.sendMessage("chat-001", "This is a long message");

    // Wait for potential async operations
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Assert - summarizeTitle was NOT called
    expect(mockSummarizeTitle).not.toHaveBeenCalled();
    // Assert - updateSession was NOT called
    expect(mockChatStore.updateSession).not.toHaveBeenCalled();
  });
});
