/**
 * Tests for ChatManager - specifically text accumulation behavior
 * These tests verify the fix for FN-1857: Chat assistant messages not persisted after navigating away
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ChatManager,
  __setBuildAgentChatPrompt,
  __setCreateKbAgent,
  __resetChatState,
  chatStreamManager,
} from "../chat.js";

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

const mockAgentStore = {
  init: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(),
};

function createChatManager(): ChatManager {
  return new ChatManager(mockChatStore as any, "/tmp/test", mockAgentStore as any);
}

function createChatManagerWithoutAgentStore(): ChatManager {
  return new ChatManager(mockChatStore as any, "/tmp/test");
}

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
    mockChatStore.getMessages.mockReturnValue([]);

    mockAgentStore.init.mockResolvedValue(undefined);
    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      soul: "Be calm and precise.",
      memory: "Remember to keep test coverage high.",
      instructionsText: "Keep replies focused.",
    });
    mockAgentStore.listAgents.mockResolvedValue([
      {
        id: "agent-001",
        name: "Avery",
        role: "executor",
        state: "idle",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
        metadata: {},
      },
    ]);

    __setBuildAgentChatPrompt(async ({ agent, basePrompt }: any) => {
      return [
        basePrompt,
        `## Soul\n\n${agent.soul ?? ""}`,
        `## Memory\n\n${agent.memory ?? ""}`,
        `## Instructions\n\n${agent.instructionsText ?? ""}`,
      ].join("\n\n");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("mention parsing and context", () => {
    it("parseMentions extracts known agent names from content", async () => {
      mockAgentStore.listAgents.mockResolvedValue([
        {
          id: "agent-001",
          name: "Alpha",
          role: "executor",
          state: "idle",
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
          metadata: {},
        },
      ]);

      const chatManager = createChatManager();
      const mentions = await (chatManager as any).parseMentions("hello @Alpha how are you");

      expect(mentions).toEqual([{ agentId: "agent-001", agentName: "Alpha" }]);
    });

    it("parseMentions handles underscores in mentions", async () => {
      mockAgentStore.listAgents.mockResolvedValue([
        {
          id: "agent-003",
          name: "My Agent",
          role: "reviewer",
          state: "idle",
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
          metadata: {},
        },
      ]);

      const chatManager = createChatManager();
      const mentions = await (chatManager as any).parseMentions("ping @My_Agent please");

      expect(mentions).toEqual([{ agentId: "agent-003", agentName: "My Agent" }]);
    });

    it("parseMentions returns empty array when no mentions are present", async () => {
      const chatManager = createChatManager();
      const mentions = await (chatManager as any).parseMentions("hello there");

      expect(mentions).toEqual([]);
      expect(mockAgentStore.listAgents).not.toHaveBeenCalled();
    });

    it("parseMentions returns empty array when agentStore is unavailable", async () => {
      const chatManager = createChatManagerWithoutAgentStore();
      const mentions = await (chatManager as any).parseMentions("hello @Alpha");

      expect(mentions).toEqual([]);
    });

    it("buildMentionContext includes agent details", async () => {
      mockAgentStore.listAgents.mockResolvedValue([
        {
          id: "agent-001",
          name: "Alpha",
          role: "executor",
          state: "running",
          taskId: "FN-2000",
          soul: "A".repeat(260),
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
          metadata: {},
        },
      ]);

      const chatManager = createChatManager();
      const context = await (chatManager as any).buildMentionContext([
        { agentId: "agent-001", agentName: "Alpha" },
      ]);

      expect(context).toContain("The user mentioned the following agents in their message:");
      expect(context).toContain("@Alpha");
      expect(context).toContain("role: executor");
      expect(context).toContain("currently working on: FN-2000");
      expect(context).toContain("…");
    });

    it("buildMentionContext returns empty string when mentions are empty", async () => {
      const chatManager = createChatManager();
      const context = await (chatManager as any).buildMentionContext([]);

      expect(context).toBe("");
    });

    it("sendMessage appends mention context to system prompt when mentions are present", async () => {
      mockAgentStore.listAgents.mockResolvedValue([
        {
          id: "agent-001",
          name: "Avery",
          role: "executor",
          state: "running",
          taskId: "FN-1948",
          soul: "Mention-aware executor",
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
          metadata: {},
        },
      ]);

      let createOptions: any;
      __setCreateKbAgent(async (options: any) => {
        createOptions = options;
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            state: {
              messages: [{ role: "assistant", content: "Done" }],
            },
          },
        };
      });

      const chatManager = createChatManager();
      await chatManager.sendMessage("chat-001", "hello @Avery");

      expect(createOptions.systemPrompt).toContain("The user mentioned the following agents in their message:");
      expect(createOptions.systemPrompt).toContain("@Avery");
      expect(createOptions.systemPrompt).toContain("currently working on: FN-1948");
    });

    it("sendMessage stores mention metadata on the user message", async () => {
      mockAgentStore.listAgents.mockResolvedValue([
        {
          id: "agent-001",
          name: "Avery",
          role: "executor",
          state: "idle",
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
          metadata: {},
        },
      ]);

      __setCreateKbAgent(async () => {
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            state: {
              messages: [{ role: "assistant", content: "Done" }],
            },
          },
        };
      });

      const chatManager = createChatManager();
      await chatManager.sendMessage("chat-001", "hello @Avery");

      expect(mockChatStore.addMessage).toHaveBeenNthCalledWith(
        1,
        "chat-001",
        expect.objectContaining({
          role: "user",
          content: "hello @Avery",
          metadata: {
            mentions: [{ agentId: "agent-001", agentName: "Avery" }],
          },
        }),
      );
    });
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
    const chatManager = createChatManager();

    // Act
    await chatManager.sendMessage("chat-001", "Hello");

    // Assert - verify that addMessage was called with accumulated text
    const assistantCall = mockChatStore.addMessage.mock.calls.find(
      (call) => call[1].role === "assistant"
    );
    expect(assistantCall).toBeDefined();
    expect(assistantCall?.[1].content).toBe("Hello world!");
  });

  it("creates chat agents with the full coding toolset", async () => {
    let createOptions: any;
    __setCreateKbAgent(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Done" }],
          },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Hello");

    expect(createOptions.tools).toBe("coding");
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

    const chatManager = createChatManager();

    await chatManager.sendMessage("chat-001", "Hello");

    // Assert - thinking output is accumulated
    const assistantCall = mockChatStore.addMessage.mock.calls.find(
      (call) => call[1].role === "assistant"
    );
    expect(assistantCall?.[1].thinkingOutput).toBe("Thinking...");
  });

  it("persists partial assistant response when AI processing fails after streaming text", async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = chatStreamManager.subscribe("chat-001", (event) => {
      events.push(event);
    });

    __setCreateKbAgent(async (options: any) => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            options.onThinking?.("Thinking...");
            options.onText?.("Partial answer");
            throw new Error("Tool execution failed");
          }),
          dispose: vi.fn(),
          state: { messages: [] },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Hello");
    unsubscribe();

    const assistantCalls = mockChatStore.addMessage.mock.calls.filter((call) => call[1].role === "assistant");
    expect(assistantCalls).toHaveLength(1);
    expect(assistantCalls[0]).toEqual([
      "chat-001",
      expect.objectContaining({
        role: "assistant",
        content: "Partial answer",
        thinkingOutput: "Thinking...",
        metadata: { interrupted: true },
      }),
    ]);
    expect(events).toContainEqual({ type: "error", data: "Tool execution failed" });
  });

  it("does not persist empty assistant response on immediate failure", async () => {
    __setCreateKbAgent(async () => {
      return {
        session: {
          prompt: vi.fn().mockRejectedValue(new Error("Immediate failure")),
          dispose: vi.fn(),
          state: { messages: [] },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Hello");

    const assistantCalls = mockChatStore.addMessage.mock.calls.filter((call) => call[1].role === "assistant");
    expect(assistantCalls).toHaveLength(0);
  });

  it("persists thinking output even when no text was generated", async () => {
    __setCreateKbAgent(async (options: any) => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            options.onThinking?.("Working through tools");
            throw new Error("Interrupted during tool call");
          }),
          dispose: vi.fn(),
          state: { messages: [] },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Hello");

    const assistantCalls = mockChatStore.addMessage.mock.calls.filter((call) => call[1].role === "assistant");
    expect(assistantCalls).toHaveLength(1);
    expect(assistantCalls[0]).toEqual([
      "chat-001",
      expect.objectContaining({
        role: "assistant",
        content: "(response interrupted before text generation)",
        thinkingOutput: "Working through tools",
        metadata: { interrupted: true },
      }),
    ]);
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

    const chatManager = createChatManager();

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

    const chatManager = createChatManager();

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

    const chatManager = createChatManager();

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

    const chatManager = createChatManager();

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

  it("passes enriched system prompt with agent soul when agent context is available", async () => {
    let createOptions: any;
    __setCreateKbAgent(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Done" }],
          },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Hello");

    expect(mockAgentStore.init).toHaveBeenCalledTimes(1);
    expect(mockAgentStore.getAgent).toHaveBeenCalledWith("agent-001");
    expect(createOptions.systemPrompt).toContain("Be calm and precise.");
  });

  it("passes enriched system prompt with agent memory when agent context is available", async () => {
    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      soul: "Be concise.",
      memory: "Remember repo conventions from prior tasks.",
      instructionsText: "Focus on correctness.",
    });

    let createOptions: any;
    __setCreateKbAgent(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Done" }],
          },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Hello");

    expect(createOptions.systemPrompt).toContain("Remember repo conventions from prior tasks.");
  });

  it("falls back to generic chat system prompt when agent lookup returns null", async () => {
    mockAgentStore.getAgent.mockResolvedValue(null);

    let createOptions: any;
    __setCreateKbAgent(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Done" }],
          },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Hello");

    expect(createOptions.systemPrompt).toContain("You are a helpful AI assistant integrated into the fn task board system.");
    expect(createOptions.systemPrompt).not.toContain("## Soul");
  });

  it("includes previous user and assistant messages in the prompt context", async () => {
    const promptSpy = vi.fn().mockResolvedValue(undefined);

    mockChatStore.getMessages.mockReturnValue([
      { role: "user", content: "Earlier user question" },
      { role: "assistant", content: "Earlier assistant answer" },
      { role: "system", content: "System note should be filtered" },
      { role: "user", content: "Current question" },
    ]);

    __setCreateKbAgent(async () => {
      return {
        session: {
          prompt: promptSpy,
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Done" }],
          },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Current question");

    expect(promptSpy).toHaveBeenCalledTimes(1);
    const promptArgument = promptSpy.mock.calls[0]?.[0];
    expect(promptArgument).toContain("## Previous Conversation");
    expect(promptArgument).toContain("[User]: Earlier user question");
    expect(promptArgument).toContain("[Assistant]: Earlier assistant answer");
    expect(promptArgument).not.toContain("System note should be filtered");
    expect(promptArgument).toContain("## Current Message");
    expect(promptArgument).toContain("Current question");
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

    const chatManager = createChatManager();

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

    const chatManager = createChatManager();

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

    const chatManager = createChatManager();

    await chatManager.sendMessage("chat-001", "This is a long message");

    // Wait for potential async operations
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Assert - summarizeTitle was NOT called
    expect(mockSummarizeTitle).not.toHaveBeenCalled();
    // Assert - updateSession was NOT called
    expect(mockChatStore.updateSession).not.toHaveBeenCalled();
  });

  it("cancelGeneration returns false when no active generation exists", () => {
    const chatManager = createChatManager();

    expect(chatManager.cancelGeneration("chat-001")).toBe(false);
  });

  it("cancelGeneration returns true and aborts an active generation", () => {
    const chatManager = createChatManager();
    const abortController = new AbortController();
    const dispose = vi.fn();

    (chatManager as any).activeGenerations.set("chat-001", {
      abortController,
      agentResult: { session: { dispose } },
    });

    const events: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = chatStreamManager.subscribe("chat-001", (event) => {
      events.push(event);
    });

    const result = chatManager.cancelGeneration("chat-001");
    unsubscribe();

    expect(result).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "error", data: "Generation cancelled" });
  });

  it("cancelled generation does not persist assistant message", async () => {
    let rejectPrompt: ((reason?: unknown) => void) | undefined;

    __setCreateKbAgent(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(() => {
            return new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
            });
          }),
          dispose: vi.fn().mockImplementation(() => {
            rejectPrompt?.(new Error("Disposed"));
          }),
          state: {
            messages: [{ role: "assistant", content: "Should not persist" }],
          },
        },
      };
    });

    const chatManager = createChatManager();
    const sendPromise = chatManager.sendMessage("chat-001", "Hello");

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chatManager.cancelGeneration("chat-001")).toBe(true);
    await sendPromise;

    const assistantCalls = mockChatStore.addMessage.mock.calls.filter((call) => call[1].role === "assistant");
    expect(assistantCalls).toHaveLength(0);
  });

  it("cancelled generation broadcasts error event with cancellation message", async () => {
    let rejectPrompt: ((reason?: unknown) => void) | undefined;

    __setCreateKbAgent(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(() => {
            return new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
            });
          }),
          dispose: vi.fn().mockImplementation(() => {
            rejectPrompt?.(new Error("Disposed"));
          }),
          state: { messages: [] },
        },
      };
    });

    const events: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = chatStreamManager.subscribe("chat-001", (event) => {
      events.push(event);
    });

    const chatManager = createChatManager();
    const sendPromise = chatManager.sendMessage("chat-001", "Hello");

    await new Promise((resolve) => setTimeout(resolve, 0));
    chatManager.cancelGeneration("chat-001");
    await sendPromise;
    unsubscribe();

    expect(events.some((event) => event.type === "error" && event.data === "Generation cancelled")).toBe(true);
  });

  it("cleans active generation state even when dispose fails", async () => {
    const disposeSpy = vi.fn().mockImplementation(() => {
      throw new Error("dispose failed");
    });

    __setCreateKbAgent(async () => {
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: disposeSpy,
          state: {
            messages: [{ role: "assistant", content: "Done" }],
          },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Hello");

    expect((chatManager as any).activeGenerations.has("chat-001")).toBe(false);
  });
});
