/*
FNXC:DashboardTests 2026-06-14-09:58:
FN-6444 confirmed this ChatManager API-path suite is deterministic under dashboard-api, so it must run in backfill instead of remaining a curated skip-list orphan.
*/
/**
 * Tests for ChatManager - specifically text accumulation behavior
 * These tests verify the fix for FN-1857: Chat assistant messages not persisted after navigating away
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ChatManager,
  __setBuildAgentChatPrompt,
  __setCreateFnAgent,
  __setCreateResolvedAgentSession,
  __resetChatState,
  chatStreamManager,
  __getChatDiagnostics,
  __setChatDiagnostics,
  CHAT_ASK_QUESTION_GUIDANCE,
} from "../chat.js";

// ── Mock Setup ──────────────────────────────────────────────────────────────

// Mock summarizeTitle using vi.hoisted so it's available at module hoisting time
const { mockSummarizeTitle } = vi.hoisted(() => ({
  mockSummarizeTitle: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  summarizeTitle: mockSummarizeTitle,
  DASHBOARD_USER_ID: "dashboard",
  normalizeMessageParticipant: (id: string, type: "user" | "agent" | "system") => {
    const normalized = id.trim();
    if (type === "user" && ["dashboard", "user:dashboard", "User: user:dashboard"].includes(normalized)) {
      return { id: "dashboard", type: "user" as const };
    }
    return { id: normalized, type };
  },
}));

// SessionManager is constructed per-chat for CLI session continuity. We don't
// want tests touching the real ~/.pi sessions directory, so stub the static
// methods. The test `cliSessionFile-threading` asserts call shapes.
const { mockSessionManagerCreate, mockSessionManagerOpen } = vi.hoisted(() => {
  const fakeManager = {
    getSessionFile: () => "/tmp/test/.pi-fake/session-abc.jsonl",
  };
  return {
    mockSessionManagerCreate: vi.fn(() => fakeManager),
    mockSessionManagerOpen: vi.fn(() => fakeManager),
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    create: mockSessionManagerCreate,
    open: mockSessionManagerOpen,
  },
}));

// ── Mock Store ──────────────────────────────────────────────────────────────

const mockChatStore = {
  getSession: vi.fn(),
  createSession: vi.fn(),
  addMessage: vi.fn(),
  getMessages: vi.fn(),
  updateSession: vi.fn(),
  setCliSessionFile: vi.fn(),
  setInFlightGeneration: vi.fn(),
  getRoomMessages: vi.fn(),
};

const mockAgentStore = {
  init: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(),
};

function createChatManager(pluginRunner?: Record<string, unknown>, messageStore?: Record<string, unknown>): ChatManager {
  return new ChatManager(mockChatStore as any, "/tmp/test", mockAgentStore as any, pluginRunner as any, undefined, messageStore as any);
}

function createChatManagerForRoot(rootDir: string): ChatManager {
  return new ChatManager(mockChatStore as any, rootDir, mockAgentStore as any);
}

function createChatManagerWithSettings(settings: {
  fallbackProvider?: string;
  fallbackModelId?: string;
  defaultProvider?: string;
  defaultModelId?: string;
}): ChatManager {
  return new ChatManager(
    mockChatStore as any,
    "/tmp/test",
    mockAgentStore as any,
    undefined,
    async () => settings,
  );
}

function createChatManagerWithoutAgentStore(): ChatManager {
  return new ChatManager(mockChatStore as any, "/tmp/test");
}

// Minimal stand-in TaskStore. The workflow tool factories only capture the
// store reference at build time, so name-membership assertions never touch it.
const mockTaskStore = {} as any;

function createChatManagerWithTaskStore(): ChatManager {
  return new ChatManager(
    mockChatStore as any,
    "/tmp/test",
    mockAgentStore as any,
    undefined,
    undefined,
    undefined,
    mockTaskStore,
  );
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
    mockChatStore.getRoomMessages.mockReturnValue([]);

    mockAgentStore.init.mockResolvedValue(undefined);
    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      soul: "Be calm and precise.",
      memory: "Remember to keep test coverage high.",
      instructionsText: "Keep replies focused.",
      runtimeConfig: {},
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
      __setCreateFnAgent(async (options: any) => {
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

      __setCreateFnAgent(async () => {
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

    __setCreateFnAgent(async (options: any) => {
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

  // U11 / R12 drift guard: the chat lane must expose workflow discovery,
  // mutation, settings, selection, and trait vocabulary to the agent when a
  // scoped task store is available.
  it("exposes the full workflow authoring surface to the chat agent when a task store is present", async () => {
    let capturedTools: Array<{ name: string }> = [];
    __setCreateFnAgent(async (options: any) => {
      capturedTools = options.customTools ?? [];
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "ok" }] },
        },
      };
    });

    const chatManager = createChatManagerWithTaskStore();
    await chatManager.sendMessage("chat-001", "Author me a workflow");

    const names = capturedTools.map((t) => t.name);
    for (const required of [
      "fn_workflow_create",
      "fn_workflow_update",
      "fn_workflow_delete",
      "fn_workflow_settings",
      "fn_workflow_list",
      "fn_workflow_get",
      "fn_workflow_select",
      "fn_trait_list",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("exposes fn_task_document_* tools to the chat agent when a task store is present", async () => {
    let capturedTools: Array<{ name: string; execute?: (...args: any[]) => Promise<any> }> = [];
    __setCreateFnAgent(async (options: any) => {
      capturedTools = options.customTools ?? [];
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "ok" }] },
        },
      };
    });

    const taskStore = {
      upsertTaskDocument: vi.fn().mockResolvedValue({
        id: "doc-1",
        taskId: "FN-6635",
        key: "docs",
        content: "Saved from chat",
        revision: 1,
        author: "chat-agent",
        createdAt: "2026-06-18T06:51:00.000Z",
        updatedAt: "2026-06-18T06:51:00.000Z",
      }),
    } as any;
    const chatManager = new ChatManager(
      mockChatStore as any,
      "/tmp/test",
      mockAgentStore as any,
      undefined,
      undefined,
      undefined,
      taskStore,
    );

    await chatManager.sendMessage("chat-001", "Save this as task docs");

    const names = capturedTools.map((tool) => tool.name);
    expect(names).toContain("fn_task_document_write");
    expect(names).toContain("fn_task_document_read");

    const writeTool = capturedTools.find((tool) => tool.name === "fn_task_document_write");
    const writeResult = await writeTool?.execute?.("call-doc-write", {
      task_id: "FN-6635",
      key: "docs",
      content: "Saved from chat",
      author: "chat-agent",
    });

    expect(taskStore.upsertTaskDocument).toHaveBeenCalledWith("FN-6635", {
      key: "docs",
      content: "Saved from chat",
      author: "chat-agent",
    });
    expect(writeResult?.content?.[0]?.text).toContain("Saved document \"docs\"");
  });

  it("does not expose fn_task_document_* tools when no task store is present", async () => {
    let capturedTools: Array<{ name: string }> = [];
    __setCreateFnAgent(async (options: any) => {
      capturedTools = options.customTools ?? [];
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "ok" }] },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Try saving docs");

    const names = capturedTools.map((tool) => tool.name);
    expect(names).not.toContain("fn_task_document_write");
    expect(names).not.toContain("fn_task_document_read");
  });

  it("persists and clears durable in-flight generation snapshots during streaming", async () => {
    let onTextCb: ((delta: string) => void) | undefined;

    __setCreateFnAgent(async (options: any) => {
      onTextCb = options.onText;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            onTextCb?.("chunk");
          }),
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "chunk" }] },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Hello");

    expect(mockChatStore.setInFlightGeneration).toHaveBeenCalledWith(
      "chat-001",
      expect.objectContaining({ status: "generating" }),
    );
    expect(mockChatStore.setInFlightGeneration).toHaveBeenLastCalledWith("chat-001", null);
  });

  it("broadcasts done with persisted assistant message snapshot", async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = chatStreamManager.subscribe("chat-001", (event) => {
      events.push(event);
    });

    __setCreateFnAgent(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        state: {
          messages: [{ role: "assistant", content: "Final content" }],
        },
      },
    }));

    mockChatStore.addMessage.mockReturnValueOnce({ id: "msg-user", role: "user" });
    mockChatStore.addMessage.mockReturnValueOnce({
      id: "msg-final",
      sessionId: "chat-001",
      role: "assistant",
      content: "Final content",
      thinkingOutput: null,
      metadata: null,
      attachments: undefined,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Hello");
    unsubscribe();

    expect(events).toContainEqual({
      type: "done",
      data: {
        messageId: "msg-final",
        message: {
          id: "msg-final",
          sessionId: "chat-001",
          role: "assistant",
          content: "Final content",
          thinkingOutput: null,
          metadata: null,
          attachments: undefined,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        attachments: undefined,
      },
    });
  });


  it("broadcasts tool_start and tool_end SSE events when agent calls tools", async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = chatStreamManager.subscribe("chat-001", (event) => {
      events.push(event);
    });

    let onToolStartCb: ((name: string, args?: Record<string, unknown>) => void) | undefined;
    let onToolEndCb: ((name: string, isError: boolean, result?: unknown) => void) | undefined;

    __setCreateFnAgent(async (options: any) => {
      onToolStartCb = options.onToolStart;
      onToolEndCb = options.onToolEnd;

      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            onToolStartCb?.("read", { path: "/foo.ts" });
            onToolEndCb?.("read", false, "file contents");
            options.onText?.("Done");
          }),
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Done" }],
          },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Use read tool");
    unsubscribe();

    expect(events).toContainEqual({
      type: "tool_start",
      data: { toolName: "read", args: { path: "/foo.ts" } },
    });
    expect(events).toContainEqual({
      type: "tool_end",
      data: { toolName: "read", isError: false, result: "file contents" },
    });
  });

  it("persists tool calls in assistant message metadata", async () => {
    let onToolStartCb: ((name: string, args?: Record<string, unknown>) => void) | undefined;
    let onToolEndCb: ((name: string, isError: boolean, result?: unknown) => void) | undefined;

    __setCreateFnAgent(async (options: any) => {
      onToolStartCb = options.onToolStart;
      onToolEndCb = options.onToolEnd;

      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            onToolStartCb?.("read", { path: "foo.ts" });
            onToolEndCb?.("read", false, "contents");
            options.onText?.("Here you go");
          }),
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Here you go" }],
          },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Read foo.ts");

    const assistantCall = mockChatStore.addMessage.mock.calls.find(
      (call) => call[1].role === "assistant",
    );

    expect(assistantCall).toBeDefined();
    expect(assistantCall?.[1]).toEqual(
      expect.objectContaining({
        metadata: {
          toolCalls: [
            {
              toolName: "read",
              args: { path: "foo.ts" },
              isError: false,
              result: "contents",
            },
          ],
        },
      }),
    );
  });

  it("creates chat agents with the full coding toolset", async () => {
    let createOptions: any;
    __setCreateFnAgent(async (options: any) => {
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

  it("requests bound agent and enabled plugin skills for regular chat", async () => {
    let createOptions: any;
    __setCreateResolvedAgentSession(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Skills ready" }] },
        },
      };
    });
    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      runtimeConfig: {},
      metadata: { skills: ["agent-debug", "ce-debug"] },
    });
    const pluginRunner = {
      getPluginSkills: vi.fn(() => [
        { pluginId: "fusion-plugin-compound-engineering", skill: { name: "ce-debug", enabled: true } },
        { pluginId: "disabled-plugin", skill: { name: "disabled-debug", enabled: false } },
      ]),
    };

    const chatManager = createChatManager(pluginRunner);
    await chatManager.sendMessage("chat-001", "Hello");

    expect(pluginRunner.getPluginSkills).toHaveBeenCalledTimes(1);
    expect(createOptions.skillSelection).toMatchObject({
      projectRootDir: "/tmp/test",
      sessionPurpose: "executor",
    });
    expect(createOptions.skillSelection.requestedSkillNames).toEqual(["agent-debug", "ce-debug"]);
    expect(createOptions.skillSelection.requestedSkillNames).not.toContain("disabled-debug");
  });

  it("requests enabled plugin skills for model-only QuickChat sessions", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: null,
      status: "active",
    });
    let createOptions: any;
    __setCreateResolvedAgentSession(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Plugin skill ready" }] },
        },
      };
    });
    const pluginRunner = {
      getPluginSkills: vi.fn(() => [
        { pluginId: "fusion-plugin-compound-engineering", skill: { name: "ce-debug" } },
      ]),
    };

    const chatManager = createChatManager(pluginRunner);
    await chatManager.sendMessage("chat-001", "Hello");

    expect(createOptions.skillSelection.requestedSkillNames).toEqual(["fusion", "ce-debug"]);
    expect(createOptions.skillSelection.sessionPurpose).toBe("executor");
  });

  it("merges plugin skills when a bound chat agent has no metadata skills", async () => {
    let createOptions: any;
    __setCreateResolvedAgentSession(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Fallback skills ready" }] },
        },
      };
    });
    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      runtimeConfig: {},
      metadata: {},
    });
    const pluginRunner = {
      getPluginSkills: vi.fn(() => [
        { pluginId: "fusion-plugin-compound-engineering", skill: { name: "ce-debug", enabled: true } },
      ]),
    };

    const chatManager = createChatManager(pluginRunner);
    await chatManager.sendMessage("chat-001", "Hello");

    expect(createOptions.skillSelection.requestedSkillNames).toEqual(["fusion", "ce-debug"]);
  });

  it("loads a single-segment /skill command and strips it from the chat prompt", async () => {
    const promptSpy = vi.fn().mockResolvedValue(undefined);
    let createOptions: any;
    __setCreateResolvedAgentSession(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: promptSpy,
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Skill command ready" }] },
        },
      };
    });
    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      runtimeConfig: {},
      metadata: { skills: ["agent-debug"] },
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "/skill:ce-debug please debug this");

    expect(createOptions.skillSelection.requestedSkillNames).toEqual(["agent-debug", "ce-debug"]);
    expect(promptSpy).toHaveBeenCalledTimes(1);
    const promptContent = promptSpy.mock.calls[0]?.[0] as string;
    expect(promptContent).toBe("please debug this");
    expect(promptContent).not.toContain("/skill:");
    expect(mockChatStore.addMessage).toHaveBeenCalledWith("chat-001", expect.objectContaining({
      role: "user",
      content: "/skill:ce-debug please debug this",
    }));
  });

  it("loads two-segment and multiple /skill commands in typed order", async () => {
    const promptSpy = vi.fn().mockResolvedValue(undefined);
    let createOptions: any;
    __setCreateResolvedAgentSession(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: promptSpy,
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Multiple skills ready" }] },
        },
      };
    });
    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      runtimeConfig: {},
      metadata: { skills: [] },
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "start /skill:review/pr please /skill:gamma now");

    expect(createOptions.skillSelection.requestedSkillNames).toEqual(["fusion", "review/pr", "gamma"]);
    const promptContent = promptSpy.mock.calls[0]?.[0] as string;
    expect(promptContent).toBe("start please now");
    expect(promptContent).not.toContain("/skill:");
  });

  it("dedupes typed /skill commands against agent and plugin skills case-insensitively", async () => {
    const promptSpy = vi.fn().mockResolvedValue(undefined);
    let createOptions: any;
    __setCreateResolvedAgentSession(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: promptSpy,
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Deduped" }] },
        },
      };
    });
    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      runtimeConfig: {},
      metadata: { skills: ["ce-debug"] },
    });
    const pluginRunner = {
      getPluginSkills: vi.fn(() => [
        { pluginId: "fusion-plugin-compound-engineering", skill: { name: "review/pr", enabled: true } },
      ]),
    };

    const chatManager = createChatManager(pluginRunner);
    await chatManager.sendMessage("chat-001", "/skill:CE-DEBUG /skill:review/pr/SKILL.md use both");

    expect(createOptions.skillSelection.requestedSkillNames).toEqual(["ce-debug", "review/pr"]);
    const names = createOptions.skillSelection.requestedSkillNames.filter((name: string) => name.toLowerCase() === "ce-debug");
    expect(names).toHaveLength(1);
    expect(promptSpy.mock.calls[0]?.[0]).toBe("use both");
  });

  it("creates skill selection for model-only QuickChat when /skill is typed without plugin skills", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: null,
      status: "active",
    });
    const promptSpy = vi.fn().mockResolvedValue(undefined);
    let createOptions: any;
    __setCreateResolvedAgentSession(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: promptSpy,
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Model-only skill ready" }] },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "/skill:foo answer directly");

    expect(createOptions.skillSelection).toMatchObject({
      projectRootDir: "/tmp/test",
      sessionPurpose: "executor",
    });
    expect(createOptions.skillSelection.requestedSkillNames).toContain("foo");
    expect(promptSpy.mock.calls[0]?.[0]).toBe("answer directly");
  });

  it("leaves skill selection and prompt content unchanged when no /skill command is present", async () => {
    const promptSpy = vi.fn().mockResolvedValue(undefined);
    let createOptions: any;
    __setCreateResolvedAgentSession(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: promptSpy,
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Plain reply" }] },
        },
      };
    });
    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      runtimeConfig: {},
      metadata: { skills: ["agent-debug"] },
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "plain hello");

    expect(createOptions.skillSelection.requestedSkillNames).toEqual(["agent-debug"]);
    expect(promptSpy.mock.calls[0]?.[0]).toBe("plain hello");
  });

  it("keeps agent skills when the chat plugin runner lacks skill discovery", async () => {
    let createOptions: any;
    __setCreateResolvedAgentSession(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Agent skill ready" }] },
        },
      };
    });
    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      runtimeConfig: {},
      metadata: { skills: ["agent-debug"] },
    });

    const chatManager = createChatManager({ getRuntimeById: vi.fn() });
    await chatManager.sendMessage("chat-001", "Hello");

    expect(createOptions.skillSelection.requestedSkillNames).toEqual(["agent-debug"]);
  });

  it("accumulates thinking output separately from text", async () => {
    let onThinkingCb: ((delta: string) => void) | undefined;
    let onTextCb: ((delta: string) => void) | undefined;

    __setCreateFnAgent(async (options: any) => {
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

    __setCreateFnAgent(async (options: any) => {
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
    expect(assistantCalls).toHaveLength(2);
    expect(assistantCalls[0]).toEqual([
      "chat-001",
      expect.objectContaining({
        role: "assistant",
        content: "Partial answer",
        thinkingOutput: "Thinking...",
        metadata: { interrupted: true },
      }),
    ]);
    expect(assistantCalls[1]).toEqual([
      "chat-001",
      expect.objectContaining({
        role: "assistant",
        content: "Tool execution failed",
        metadata: expect.objectContaining({
          failureInfo: expect.objectContaining({ summary: "Tool execution failed" }),
        }),
      }),
    ]);
    expect(events).toContainEqual({ type: "error", data: expect.objectContaining({ summary: "Tool execution failed" }) });
  });

  it("persists a structured assistant failure message on immediate failure", async () => {
    __setCreateFnAgent(async () => {
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
    expect(assistantCalls).toHaveLength(1);
    expect(assistantCalls[0]).toEqual([
      "chat-001",
      expect.objectContaining({
        role: "assistant",
        content: "Immediate failure",
        metadata: expect.objectContaining({
          failureInfo: expect.objectContaining({ summary: "Immediate failure" }),
        }),
      }),
    ]);
  });

  it("surfaces provider errors stored on session.state.errorMessage and persists a failure bubble", async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = chatStreamManager.subscribe("chat-001", (event) => {
      events.push(event);
    });

    __setCreateFnAgent(async () => {
      const session = {
        prompt: vi.fn().mockImplementation(async function (this: any) {
          this.state.errorMessage = "Codex error: provider request failed";
        }),
        dispose: vi.fn(),
        state: { messages: [] as unknown[], errorMessage: undefined as string | undefined },
      };
      return { session };
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
        content: "Codex error: provider request failed",
        metadata: expect.objectContaining({
          failureInfo: expect.objectContaining({ summary: "Codex error: provider request failed" }),
        }),
      }),
    ]);
    expect(events).toContainEqual({ type: "error", data: expect.objectContaining({ summary: "Codex error: provider request failed" }) });
  });

  it("uses the agent runtime path when the agent has a runtimeHint configured", async () => {
    const createResolvedSession = vi.fn(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        state: {
          messages: [{ role: "assistant", content: "Runtime response" }],
        },
      },
    }));
    __setCreateResolvedAgentSession(createResolvedSession as any);

    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      soul: "Be calm and precise.",
      memory: "Remember to keep test coverage high.",
      instructionsText: "Keep replies focused.",
      runtimeConfig: {
        runtimeHint: "openclaw",
      },
    });

    const pluginRunner = {
      getRuntimeById: vi.fn(),
      createRuntimeContext: vi.fn(),
    };
    const messageStore = {
      sendMessage: vi.fn(),
      getInbox: vi.fn(),
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
    };
    const chatManager = createChatManager(pluginRunner, messageStore);

    await chatManager.sendMessage("chat-001", "Hello");

    expect(createResolvedSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionPurpose: "executor",
      runtimeHint: "openclaw",
      pluginRunner,
    }));
    expect(createResolvedSession).toHaveBeenCalledWith(expect.objectContaining({
      customTools: expect.arrayContaining([
        expect.objectContaining({ name: "fn_ask_question" }),
        expect.objectContaining({ name: "fn_send_message" }),
        expect.objectContaining({ name: "fn_read_messages" }),
      ]),
    }));
  });

  it("routes Hermes mailbox sends from agent to canonical dashboard user", async () => {
    const createResolvedSession = vi.fn(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        state: {
          messages: [{ role: "assistant", content: "Runtime response" }],
        },
      },
    }));
    __setCreateResolvedAgentSession(createResolvedSession as any);

    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      soul: "Be calm and precise.",
      memory: "Remember to keep test coverage high.",
      instructionsText: "Keep replies focused.",
      runtimeConfig: {
        runtimeHint: "hermes-runtime",
      },
    });

    const messageStore = {
      sendMessage: vi.fn().mockReturnValue({ id: "msg-123" }),
      getInbox: vi.fn().mockReturnValue([]),
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
    };
    const chatManager = createChatManager(undefined, messageStore);

    await chatManager.sendMessage("chat-001", "Hello");

    const customTools = createResolvedSession.mock.calls[0]?.[0]?.customTools ?? [];
    const sendTool = customTools.find((tool: { name: string }) => tool.name === "fn_send_message");
    expect(sendTool).toBeDefined();

    const sendResult = await sendTool.execute("call-1", {
      to_id: "User: user:dashboard",
      content: "status",
      type: "agent-to-user",
    }, undefined, undefined, undefined);

    expect(sendResult.content[0]?.type === "text" ? sendResult.content[0].text : "").toContain("Message sent to dashboard");
    expect(messageStore.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      fromId: "agent-001",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      type: "agent-to-user",
    }));
  });

  it("injects ask-question but not mailbox tools for non-agent chat sessions", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: null,
      status: "active",
    });

    const createResolvedSession = vi.fn(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        state: {
          messages: [{ role: "assistant", content: "Runtime response" }],
        },
      },
    }));
    __setCreateResolvedAgentSession(createResolvedSession as any);

    const messageStore = {
      sendMessage: vi.fn(),
      getInbox: vi.fn(),
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
    };
    const chatManager = createChatManager(undefined, messageStore);

    await chatManager.sendMessage("chat-001", "Hello");

    const createOptions = createResolvedSession.mock.calls[0]?.[0];
    const customTools = createOptions?.customTools ?? [];
    expect(customTools.map((tool: { name: string }) => tool.name)).toContain("fn_ask_question");
    expect(customTools.map((tool: { name: string }) => tool.name)).not.toContain("fn_send_message");
    expect(customTools.map((tool: { name: string }) => tool.name)).not.toContain("fn_read_messages");
    expect(createOptions?.systemPrompt).toContain(CHAT_ASK_QUESTION_GUIDANCE);
  });

  it("adds rich task context and steering tools for synthetic task planner chat sessions", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: "task-planner:FN-7310",
      status: "active",
      modelProvider: "anthropic",
      modelId: "claude-plan",
    });

    const createResolvedSession = vi.fn(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        state: {
          messages: [{ role: "assistant", content: "Planning response" }],
        },
      },
    }));
    __setCreateResolvedAgentSession(createResolvedSession as any);

    const taskStore = {
      getTask: vi.fn().mockResolvedValue({
        id: "FN-7310",
        title: "Add planner chat",
        description: "Short list description should not replace the task prompt",
        prompt: "# PROMPT.md\n\nImplement the planner-model Chat tab from the detailed task plan.",
        column: "todo",
        status: "planning",
        currentStep: 0,
        dependencies: ["FN-7309"],
        steps: [{ title: "Polish", status: "in-progress" }],
        comments: [{ text: "User wants planner chat", author: "user" }],
        steeringComments: [{ text: "Keep Activity intact", author: "user" }],
        log: [{ level: "info", message: "Activity transcript loaded" }],
      }),
      getSettings: vi.fn().mockResolvedValue({}),
    };
    const chatManager = new ChatManager(
      mockChatStore as any,
      "/tmp/test",
      mockAgentStore as any,
      undefined,
      undefined,
      undefined,
      taskStore as any,
    );

    await chatManager.sendMessage("chat-001", "How should I plan this?");

    const createOptions = createResolvedSession.mock.calls[0]?.[0];
    expect(createOptions.defaultProvider).toBe("anthropic");
    expect(createOptions.defaultModelId).toBe("claude-plan");
    expect(createOptions.systemPrompt).toContain("## Task Planner Chat Context");
    expect(createOptions.systemPrompt).toContain("Task ID: FN-7310");
    expect(createOptions.systemPrompt).toContain("Title: Add planner chat");
    expect(createOptions.systemPrompt).toContain("Prompt:\n# PROMPT.md");
    expect(createOptions.systemPrompt).toContain("Implement the planner-model Chat tab from the detailed task plan.");
    expect(createOptions.systemPrompt).toContain("Dependencies:\n- FN-7309:");
    expect(createOptions.systemPrompt).toContain("Progress: step 1 of 1");
    expect(createOptions.systemPrompt).toContain("Current step: Polish: in-progress");
    expect(createOptions.systemPrompt).toContain("Polish: in-progress");
    expect(createOptions.systemPrompt).toContain("Activity transcript loaded");
    expect(createOptions.systemPrompt).toContain("fn_ask_question");
    expect(createOptions.systemPrompt).toContain("Do not create steering for ordinary questions");
    expect(createOptions.systemPrompt).toContain("Ask a clarifying question");
    expect(createOptions.systemPrompt).toContain("credential/secrets");
    expect(createOptions.systemPrompt).toContain("destructive removals");
    expect(createOptions.customTools.map((tool: { name: string }) => tool.name)).toContain("fn_task_planner_add_steering");
    expect(mockChatStore.addMessage).toHaveBeenCalledWith("chat-001", expect.objectContaining({
      role: "user",
      content: "How should I plan this?",
    }));
    expect(mockChatStore.addMessage).not.toHaveBeenCalledWith("chat-001", expect.objectContaining({
      role: "user",
      content: expect.stringContaining("Task Planner Chat Context"),
    }));
    expect(taskStore.getTask).toHaveBeenNthCalledWith(1, "FN-7310", { activityLogLimit: 20 });
    expect(taskStore.getTask).toHaveBeenCalledWith("FN-7309");
  });

  it("adds steering through the task-scoped planner tool without accepting a caller task id", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: "task-planner:FN-7310",
      status: "active",
      modelProvider: "anthropic",
      modelId: "claude-plan",
    });

    const createResolvedSession = vi.fn(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        state: { messages: [{ role: "assistant", content: "Done" }] },
      },
    }));
    __setCreateResolvedAgentSession(createResolvedSession as any);

    const persistedComment = {
      id: "steer-7310",
      text: "Keep the new Chat tab separate from Activity.",
      author: "user",
      createdAt: "2026-06-30T23:59:00.000Z",
    };
    const taskStore = {
      getTask: vi.fn().mockResolvedValue({ id: "FN-7310", title: "Add planner chat", column: "todo" }),
      addSteeringComment: vi.fn().mockResolvedValue({
        id: "FN-7310",
        updatedAt: "2026-06-30T23:59:01.000Z",
        steeringComments: [persistedComment],
      }),
      getSettings: vi.fn().mockResolvedValue({}),
    };
    const chatManager = new ChatManager(
      mockChatStore as any,
      "/tmp/test",
      mockAgentStore as any,
      undefined,
      undefined,
      undefined,
      taskStore as any,
    );

    await chatManager.sendMessage("chat-001", "Tell the executor to keep Chat separate from Activity");

    const createOptions = createResolvedSession.mock.calls[0]?.[0];
    const steeringTool = createOptions.customTools.find((tool: { name: string }) => tool.name === "fn_task_planner_add_steering");
    const result = await steeringTool.execute("call-1", {
      taskId: "FN-OTHER",
      text: "  Keep the new Chat tab separate from Activity.  ",
    });

    expect(taskStore.addSteeringComment).toHaveBeenCalledWith(
      "FN-7310",
      "Keep the new Chat tab separate from Activity.",
      "user",
    );
    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({
      taskId: "FN-7310",
      text: "Keep the new Chat tab separate from Activity.",
      taskUpdatedAt: "2026-06-30T23:59:01.000Z",
      steeringComment: persistedComment,
    });
  });

  it("persists duplicate clear planner steering requests only when the tool is called again", async () => {
    mockChatStore.getSession.mockReturnValue({ id: "chat-001", agentId: "task-planner:FN-7310", status: "active" });
    const createResolvedSession = vi.fn(async () => ({
      session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), state: { messages: [] } },
    }));
    __setCreateResolvedAgentSession(createResolvedSession as any);
    const taskStore = {
      getTask: vi.fn().mockResolvedValue({ id: "FN-7310", column: "todo" }),
      addSteeringComment: vi.fn()
        .mockResolvedValueOnce({ id: "FN-7310", steeringComments: [{ id: "steer-1", text: "Keep the narrow approach", author: "user" }] })
        .mockResolvedValueOnce({ id: "FN-7310", steeringComments: [{ id: "steer-2", text: "Keep the narrow approach", author: "user" }] }),
      getSettings: vi.fn().mockResolvedValue({}),
    };
    const chatManager = new ChatManager(mockChatStore as any, "/tmp/test", mockAgentStore as any, undefined, undefined, undefined, taskStore as any);

    await chatManager.sendMessage("chat-001", "Tell the executor to keep the narrow approach");

    const createOptions = createResolvedSession.mock.calls[0]?.[0];
    const steeringTool = createOptions.customTools.find((tool: { name: string }) => tool.name === "fn_task_planner_add_steering");
    await steeringTool.execute("call-1", { text: "Keep the narrow approach" });
    await steeringTool.execute("call-2", { text: "Keep the narrow approach" });

    expect(taskStore.addSteeringComment).toHaveBeenCalledTimes(2);
    expect(taskStore.addSteeringComment).toHaveBeenNthCalledWith(1, "FN-7310", "Keep the narrow approach", "user");
    expect(taskStore.addSteeringComment).toHaveBeenNthCalledWith(2, "FN-7310", "Keep the narrow approach", "user");
  });

  it("rejects empty planner steering tool text without mutating the task", async () => {
    mockChatStore.getSession.mockReturnValue({ id: "chat-001", agentId: "task-planner:FN-7310", status: "active" });
    const createResolvedSession = vi.fn(async () => ({
      session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), state: { messages: [] } },
    }));
    __setCreateResolvedAgentSession(createResolvedSession as any);
    const taskStore = {
      getTask: vi.fn().mockResolvedValue({ id: "FN-7310", column: "todo" }),
      addSteeringComment: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({}),
    };
    const chatManager = new ChatManager(mockChatStore as any, "/tmp/test", mockAgentStore as any, undefined, undefined, undefined, taskStore as any);

    await chatManager.sendMessage("chat-001", "Tell the executor something");

    const createOptions = createResolvedSession.mock.calls[0]?.[0];
    const steeringTool = createOptions.customTools.find((tool: { name: string }) => tool.name === "fn_task_planner_add_steering");
    const result = await steeringTool.execute("call-1", { text: "   " });

    expect(result.isError).toBe(true);
    expect(taskStore.addSteeringComment).not.toHaveBeenCalled();
  });

  it("guides chat agents to use ask-question cards for option sets", () => {
    expect(CHAT_ASK_QUESTION_GUIDANCE).toContain("## Asking the User");
    expect(CHAT_ASK_QUESTION_GUIDANCE).toContain("fn_ask_question");
    expect(CHAT_ASK_QUESTION_GUIDANCE).toMatch(/options|choices|alternatives/);
    expect(CHAT_ASK_QUESTION_GUIDANCE).toContain("instead of listing options only in prose");
    expect(CHAT_ASK_QUESTION_GUIDANCE).toContain("single_select");
    expect(CHAT_ASK_QUESTION_GUIDANCE).toContain("multi_select");
  });

  it("uses the assigned built-in pi agent model when the chat session has no explicit model override", async () => {
    let createOptions: any;

    __setCreateFnAgent(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Model response" }],
          },
        },
      };
    });

    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      soul: "Be calm and precise.",
      memory: "Remember to keep test coverage high.",
      instructionsText: "Keep replies focused.",
      runtimeConfig: {
        model: "minimax/MiniMax-M2.7-highspeed",
      },
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Hello");

    expect(createOptions.defaultProvider).toBe("minimax");
    expect(createOptions.defaultModelId).toBe("MiniMax-M2.7-highspeed");
  });

  it("allows fallback for default-model chat and persists the fallback metadata", async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = chatStreamManager.subscribe("chat-001", (event) => {
      events.push(event);
    });

    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: "agent-001",
      status: "active",
      title: "Default Codex Chat",
      modelProvider: "openai-codex",
      modelId: "gpt-5.3-codex",
    });

    let createOptions: any;
    __setCreateFnAgent(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async function (this: any) {
            await options.onFallbackModelUsed?.({
              primaryModel: "openai-codex/gpt-5.3-codex",
              fallbackModel: "zai/glm-5.1",
              triggerPoint: "prompt-time",
            });
            this.state.messages = [{ role: "assistant", content: "Fallback reply" }];
          }),
          dispose: vi.fn(),
          state: { messages: [] as Array<{ role: string; content: string }> },
        },
      };
    });

    const chatManager = createChatManagerWithSettings({
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.3-codex",
      fallbackProvider: "zai",
      fallbackModelId: "glm-5.1",
    });

    await chatManager.sendMessage("chat-001", "Hello");
    unsubscribe();

    expect(createOptions.fallbackProvider).toBe("zai");
    expect(createOptions.fallbackModelId).toBe("glm-5.1");
    expect(mockChatStore.updateSession).toHaveBeenCalledWith("chat-001", {
      modelProvider: "zai",
      modelId: "glm-5.1",
    });
    expect(events).toContainEqual({
      type: "fallback",
      data: {
        primaryModel: "openai-codex/gpt-5.3-codex",
        fallbackModel: "zai/glm-5.1",
        triggerPoint: "prompt-time",
      },
    });

    const assistantCall = mockChatStore.addMessage.mock.calls.find((call) => call[1].role === "assistant");
    expect(assistantCall?.[1]).toEqual(expect.objectContaining({
      metadata: {
        fallback: {
          primaryModel: "openai-codex/gpt-5.3-codex",
          fallbackModel: "zai/glm-5.1",
          triggerPoint: "prompt-time",
        },
      },
    }));
  });

  it("does not allow fallback when the chat session has a specific non-default model selected", async () => {
    let createOptions: any;
    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: "agent-001",
      status: "active",
      title: "Explicit Model Chat",
      modelProvider: "openai-codex",
      modelId: "gpt-5.3-codex",
    });

    __setCreateFnAgent(async (options: any) => {
      createOptions = options;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async function (this: any) {
            this.state.messages = [{ role: "assistant", content: "Primary reply" }];
          }),
          dispose: vi.fn(),
          state: { messages: [] as Array<{ role: string; content: string }> },
        },
      };
    });

    const chatManager = createChatManagerWithSettings({
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      fallbackProvider: "zai",
      fallbackModelId: "glm-5.1",
    });

    await chatManager.sendMessage("chat-001", "Hello");

    expect(createOptions.fallbackProvider).toBeUndefined();
    expect(createOptions.fallbackModelId).toBeUndefined();
  });

  it("persists thinking output even when no text was generated", async () => {
    __setCreateFnAgent(async (options: any) => {
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
    expect(assistantCalls).toHaveLength(2);
    expect(assistantCalls[0]).toEqual([
      "chat-001",
      expect.objectContaining({
        role: "assistant",
        content: "(response interrupted before text generation)",
        thinkingOutput: "Working through tools",
        metadata: { interrupted: true },
      }),
    ]);
    expect(assistantCalls[1]).toEqual([
      "chat-001",
      expect.objectContaining({
        role: "assistant",
        content: "Interrupted during tool call",
        metadata: expect.objectContaining({
          failureInfo: expect.objectContaining({ summary: "Interrupted during tool call" }),
        }),
      }),
    ]);
  });

  it("uses accumulated text as primary source over state.messages extraction", async () => {
    __setCreateFnAgent(async (options: any) => {
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
    __setCreateFnAgent(async () => {
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
    __setCreateFnAgent(async () => {
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
    __setCreateFnAgent(async (options: any) => {
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
    __setCreateFnAgent(async (options: any) => {
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
    expect(createOptions.systemPrompt).toContain("Your chat reply is the primary response to the user.");
    expect(createOptions.systemPrompt).toContain("Use `fn_send_message` only when either (a) the user explicitly asks");
  });

  it("includes guidance to avoid double-sending mailbox copies by default", async () => {
    let createOptions: any;
    __setCreateFnAgent(async (options: any) => {
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

    expect(createOptions.systemPrompt).toContain("Do not also call `fn_send_message` with the same content");
    expect(createOptions.systemPrompt).toContain("Use `fn_send_message` only when either (a) the user explicitly asks for mailbox/inbox/notification delivery");
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
    __setCreateFnAgent(async (options: any) => {
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
    __setCreateFnAgent(async (options: any) => {
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

  it("inlines text attachments and forwards image attachments to the chat agent", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fn-chat-agent-attachments-"));
    const promptSpy = vi.fn().mockResolvedValue(undefined);
    try {
      await mkdir(join(rootDir, ".fusion", "chat-attachments", "chat-001"), { recursive: true });
      await writeFile(join(rootDir, ".fusion", "chat-attachments", "chat-001", "note.txt"), "session attachment bytes");
      await writeFile(join(rootDir, ".fusion", "chat-attachments", "chat-001", "image.png"), Buffer.from([9, 8, 7]));

      __setCreateFnAgent(async () => ({
        session: {
          prompt: promptSpy,
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Done" }] },
        },
      }));

      const chatManager = createChatManagerForRoot(rootDir);
      await chatManager.sendMessage("chat-001", "What is attached?", undefined, undefined, [
        {
          id: "att-text",
          filename: "note.txt",
          originalName: "note.txt",
          mimeType: "text/plain",
          size: 24,
          createdAt: "2026-06-16T00:00:00.000Z",
        },
        {
          id: "att-image",
          filename: "image.png",
          originalName: "image.png",
          mimeType: "image/png",
          size: 3,
          createdAt: "2026-06-16T00:00:00.000Z",
        },
      ]);

      expect(promptSpy).toHaveBeenCalledTimes(1);
      const [promptArgument, promptOptions] = promptSpy.mock.calls[0] ?? [];
      expect(promptArgument).toContain("[User attached: note.txt (text/plain, 24B), image.png (image/png, 3B)]");
      expect(promptArgument).toContain("## Attachments");
      expect(promptArgument).toContain("session attachment bytes");
      expect(promptOptions).toEqual({
        images: [{ type: "image", data: Buffer.from([9, 8, 7]).toString("base64"), mimeType: "image/png" }],
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("sends only the new user message — prior turns come from the resumed CLI session, not the prompt", async () => {
    const promptSpy = vi.fn().mockResolvedValue(undefined);

    // Even with a backlog in the store, the prompt must be the new message
    // alone. Stuffing prior turns into the prompt is what bloated the on-disk
    // CLI session every iteration before per-chat resume was wired up.
    mockChatStore.getMessages.mockReturnValue([
      { role: "user", content: "Earlier user question" },
      { role: "assistant", content: "Earlier assistant answer" },
      { role: "user", content: "Current question" },
    ]);

    __setCreateFnAgent(async () => {
      return {
        session: {
          prompt: promptSpy,
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Done" }] },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Current question");

    expect(promptSpy).toHaveBeenCalledTimes(1);
    const promptArgument = promptSpy.mock.calls[0]?.[0];
    expect(promptArgument).toBe("Current question");
    expect(promptArgument).not.toContain("Previous Conversation");
    expect(promptArgument).not.toContain("Earlier user question");
  });

  it("creates a fresh CLI session on the first turn and persists its file path", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: "agent-001",
      status: "active",
      cliSessionFile: null,
    });

    const createSpy = vi.fn();
    __setCreateFnAgent(async (options: any) => {
      createSpy(options);
      return {
        session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), state: { messages: [] } },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "First message");

    expect(mockSessionManagerCreate).toHaveBeenCalledWith("/tmp/test");
    expect(mockSessionManagerOpen).not.toHaveBeenCalled();
    expect(mockChatStore.setCliSessionFile).toHaveBeenCalledWith(
      "chat-001",
      "/tmp/test/.pi-fake/session-abc.jsonl",
    );
    expect(createSpy.mock.calls[0]?.[0]?.sessionManager).toBeDefined();
  });

  it("reopens the same CLI session on second turn and persists both assistant replies", async () => {
    const promptSpy = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    mockChatStore.getSession
      .mockReturnValueOnce({
        id: "chat-001",
        agentId: "agent-001",
        status: "active",
        cliSessionFile: null,
      })
      .mockReturnValueOnce({
        id: "chat-001",
        agentId: "agent-001",
        status: "active",
        cliSessionFile: __dirname + "/chat-manager.test.ts",
      });

    __setCreateFnAgent(async () => ({
      session: { prompt: promptSpy, dispose: vi.fn(), state: { messages: [{ role: "assistant", content: "Done" }] } },
    }));

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Turn one");
    await chatManager.sendMessage("chat-001", "Turn two");

    expect(mockSessionManagerCreate).toHaveBeenCalledTimes(1);
    expect(mockSessionManagerOpen).toHaveBeenCalledTimes(1);
    expect(promptSpy).toHaveBeenCalledTimes(2);

    const assistantCalls = mockChatStore.addMessage.mock.calls.filter((call) => call[1].role === "assistant");
    expect(assistantCalls).toHaveLength(2);
  });

  it("reopens the same CLI session on subsequent turns instead of creating a new one", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: "agent-001",
      status: "active",
      cliSessionFile: __dirname + "/chat-manager.test.ts", // any existing file
    });

    __setCreateFnAgent(async () => ({
      session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), state: { messages: [] } },
    }));

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Follow-up");

    expect(mockSessionManagerOpen).toHaveBeenCalledTimes(1);
    expect(mockSessionManagerCreate).not.toHaveBeenCalled();
    expect(mockChatStore.setCliSessionFile).not.toHaveBeenCalled();
  });

  it("generates title when session has no title", async () => {
    mockSummarizeTitle.mockResolvedValue("Short Title");

    __setCreateFnAgent(async (options: any) => {
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

    vi.useFakeTimers();
    try {
      await chatManager.sendMessage("chat-001", "This is a long message that needs to be summarized");
      await vi.advanceTimersByTimeAsync(100);

      // Assert - summarizeTitle was called with the message content and model params
      expect(mockSummarizeTitle).toHaveBeenCalledWith(
        "This is a long message that needs to be summarized",
        "/tmp/test",
        undefined,
        undefined,
      );

      // Assert - session was updated with the generated title
      expect(mockChatStore.updateSession).toHaveBeenCalledWith("chat-001", { title: "Short Title" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses truncated content when summarizeTitle returns null", async () => {
    mockSummarizeTitle.mockResolvedValue(null);

    __setCreateFnAgent(async (options: any) => {
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
    vi.useFakeTimers();
    try {
      await chatManager.sendMessage("chat-001", longMessage);
      await vi.advanceTimersByTimeAsync(100);

      // Assert - summarizeTitle was called
      expect(mockSummarizeTitle).toHaveBeenCalled();

      // Assert - session was updated with truncated content (first 60 chars)
      expect(mockChatStore.updateSession).toHaveBeenCalledWith("chat-001", { title: "A".repeat(60) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not generate title when session already has a title", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: "agent-001",
      status: "active",
      title: "Existing Title",
    });

    __setCreateFnAgent(async (options: any) => {
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

    vi.useFakeTimers();
    try {
      await chatManager.sendMessage("chat-001", "This is a long message");
      await vi.advanceTimersByTimeAsync(100);

      // Assert - summarizeTitle was NOT called
      expect(mockSummarizeTitle).not.toHaveBeenCalled();
      // Assert - updateSession was NOT called
      expect(mockChatStore.updateSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

    __setCreateFnAgent(async () => {
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

    __setCreateFnAgent(async () => {
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

    __setCreateFnAgent(async () => {
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

describe("ChatManager diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetChatState();

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
    mockChatStore.getRoomMessages.mockReturnValue([]);
    mockAgentStore.init.mockResolvedValue(undefined);
    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      soul: "Be calm and precise.",
    });
    mockAgentStore.listAgents.mockResolvedValue([]);
    __setBuildAgentChatPrompt(async ({ basePrompt }: any) => basePrompt);
  });

  it("logs error diagnostic when broadcast callback throws", () => {
    const loggedErrors: Array<{ message: string; args: unknown[] }> = [];
    __setChatDiagnostics({
      log: vi.fn(),
      warn: vi.fn(),
      error: (message: string, ...args: unknown[]) => {
        loggedErrors.push({ message, args });
      },
    });

    const throwingCallback = vi.fn(() => {
      throw new Error("Broadcast callback failed");
    });
    const unsubscribe = chatStreamManager.subscribe("chat-001", throwingCallback);

    try {
      expect(() =>
        chatStreamManager.broadcast("chat-001", { type: "thinking", data: "test" })
      ).not.toThrow();

      expect(throwingCallback).toHaveBeenCalledTimes(1);
      expect(loggedErrors).toContainEqual({
        message: "Error broadcasting to client for session chat-001:",
        args: [expect.any(Error)],
      });
    } finally {
      unsubscribe();
    }
  });

  it("logs error diagnostic when sendMessage encounters AI processing failure", async () => {
    const loggedErrors: Array<{ message: string; args: unknown[] }> = [];
    __setChatDiagnostics({
      log: vi.fn(),
      warn: vi.fn(),
      error: (message: string, ...args: unknown[]) => {
        loggedErrors.push({ message, args });
      },
    });

    __setCreateFnAgent(async () => {
      return {
        session: {
          prompt: vi.fn().mockRejectedValue(new Error("AI processing failed")),
          dispose: vi.fn(),
          state: { messages: [] },
        },
      };
    });

    const chatManager = createChatManager();
    await chatManager.sendMessage("chat-001", "Hello");

    expect(loggedErrors).toContainEqual({
      message: "Error in sendMessage for session chat-001:",
      args: [expect.any(Error)],
    });
  });

  it("logs error diagnostic when dispose fails during cancellation", () => {
    const loggedErrors: Array<{ message: string; args: unknown[] }> = [];
    __setChatDiagnostics({
      log: vi.fn(),
      warn: vi.fn(),
      error: (message: string, ...args: unknown[]) => {
        loggedErrors.push({ message, args });
      },
    });

    const disposeSpy = vi.fn().mockImplementation(() => {
      throw new Error("Dispose failed");
    });

    __setCreateFnAgent(async () => {
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
    // Set up an active generation manually
    const abortController = new AbortController();
    (chatManager as any).activeGenerations.set("chat-001", {
      abortController,
      agentResult: { session: { dispose: disposeSpy } },
    });

    chatManager.cancelGeneration("chat-001");

    expect(loggedErrors).toContainEqual({
      message: "Error disposing agent session during cancellation:",
      args: [expect.any(Error)],
    });
  });

  it("logs error diagnostic when dispose fails after successful sendMessage", async () => {
    const loggedErrors: Array<{ message: string; args: unknown[] }> = [];
    __setChatDiagnostics({
      log: vi.fn(),
      warn: vi.fn(),
      error: (message: string, ...args: unknown[]) => {
        loggedErrors.push({ message, args });
      },
    });

    const disposeSpy = vi.fn().mockImplementation(() => {
      throw new Error("Dispose failed");
    });

    __setCreateFnAgent(async () => {
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

    expect(loggedErrors).toContainEqual({
      message: "Error disposing agent session:",
      args: [expect.any(Error)],
    });
  });
});

describe("ChatManager.isGenerating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetChatState();
    mockChatStore.getSession.mockReturnValue({
      id: "chat-001",
      agentId: "agent-1",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    mockChatStore.addMessage.mockReturnValue({
      id: "msg-1",
      sessionId: "chat-001",
      role: "user",
      content: "Hello",
      createdAt: new Date().toISOString(),
    });
    mockSummarizeTitle.mockResolvedValue("Test Title");
  });

  it("returns false when no generation is active", () => {
    const chatManager = createChatManager();
    expect(chatManager.isGenerating("chat-001")).toBe(false);
  });

  it("returns true during an active generation", async () => {
    let resolvePrompt: () => void;
    const promptPromise = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });

    __setCreateFnAgent(async () => {
      await promptPromise;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Done" }] },
        },
      };
    });

    const chatManager = createChatManager();

    // Start the generation (don't await it — it blocks until resolvePrompt is called)
    const sendPromise = chatManager.sendMessage("chat-001", "Hello");

    // The generation should be active now
    expect(chatManager.isGenerating("chat-001")).toBe(true);
    expect(chatManager.isGenerating("chat-999")).toBe(false); // different session

    // Complete the generation
    resolvePrompt!();
    await sendPromise;

    // Generation should be cleared
    expect(chatManager.isGenerating("chat-001")).toBe(false);
  });
});

describe("ChatManager.getGeneratingSessionIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetChatState();
    mockSummarizeTitle.mockResolvedValue("Test Title");
  });

  it("returns empty array when no generations are active", () => {
    const chatManager = createChatManager();
    expect(chatManager.getGeneratingSessionIds()).toEqual([]);
  });

  it("returns all session IDs with active generations", async () => {
    let resolvePrompt1: () => void;
    let resolvePrompt2: () => void;
    const promptPromise1 = new Promise<void>((resolve) => { resolvePrompt1 = resolve; });
    const promptPromise2 = new Promise<void>((resolve) => { resolvePrompt2 = resolve; });

    let callCount = 0;
    __setCreateFnAgent(async () => {
      callCount++;
      const promise = callCount === 1 ? promptPromise1 : promptPromise2;
      await promise;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Done" }] },
        },
      };
    });

    mockChatStore.getSession.mockImplementation((id: string) => ({
      id,
      agentId: "agent-1",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    mockChatStore.addMessage.mockReturnValue({
      id: "msg-1",
      sessionId: "chat-001",
      role: "user",
      content: "Hello",
      createdAt: new Date().toISOString(),
    });

    const chatManager = createChatManager();

    // Start two generations
    const send1 = chatManager.sendMessage("chat-001", "Hello");
    const send2 = chatManager.sendMessage("chat-002", "World");

    // Both should show as generating
    const ids = chatManager.getGeneratingSessionIds();
    expect(ids).toContain("chat-001");
    expect(ids).toContain("chat-002");
    expect(ids).toHaveLength(2);

    // Complete both
    resolvePrompt1!();
    resolvePrompt2!();
    await Promise.all([send1, send2]);

    expect(chatManager.getGeneratingSessionIds()).toEqual([]);
  });
});

describe("ChatManager generation isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetChatState();
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
    mockChatStore.getRoomMessages.mockReturnValue([]);
  });

  // Regression: a "Generation cancelled" broadcast from a previous generation
  // must not leak into a new SSE subscriber that connected after the cancel
  // request landed. Before per-generation tagging this race silently flipped
  // the new chat into "no streaming" state with no Stop button or indicator.
  it("cancelGeneration broadcast does not reach a new generation's subscriber", async () => {
    const chatManager = createChatManager();

    // Start gen #1 manually so we can hold a reference to its generationId
    // without driving a real agent loop.
    const firstGen = chatManager.beginGeneration("chat-001");
    expect(firstGen.generationId).toBe(1);

    // Simulate the new request subscribing for gen #2 BEFORE the cancel of
    // gen #1 has been processed by the backend.
    const secondGen = chatManager.beginGeneration("chat-001");
    expect(secondGen.generationId).toBe(2);
    // beginGeneration aborts the prior controller so the old loop unwinds.
    expect(firstGen.abortController.signal.aborted).toBe(true);

    const eventsForNewSubscriber: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = chatStreamManager.subscribe(
      "chat-001",
      (event) => { eventsForNewSubscriber.push(event); },
      { generationId: secondGen.generationId },
    );

    // Cancel gen #1 (which is what the in-flight HTTP cancel request would do).
    // Today this is a no-op for activeGenerations because beginGeneration #2
    // overwrote the entry, but in production the cancel can race with the
    // beginGeneration. Simulate the broadcast directly as well to exercise the
    // tagged-broadcast filtering.
    chatStreamManager.broadcast(
      "chat-001",
      { type: "error", data: "Generation cancelled" },
      { generationId: firstGen.generationId },
    );

    expect(eventsForNewSubscriber).toEqual([]);

    // A broadcast tagged for gen #2 still reaches the subscriber.
    chatStreamManager.broadcast(
      "chat-001",
      { type: "text", data: "hello" },
      { generationId: secondGen.generationId },
    );
    expect(eventsForNewSubscriber).toEqual([{ type: "text", data: "hello" }]);

    unsubscribe();
  });

  // Regression: an old generation completing its `finally` block must not
  // delete a newer generation's activeGenerations entry, otherwise
  // `isGenerating(sessionId)` returns false while the new request is still
  // streaming and recovery polling cannot find it.
  it("old generation finally does not delete a newer generation's slot", async () => {
    const chatManager = createChatManager();

    let resolvePrompt: (() => void) | undefined;
    let promptCreatedResolve!: () => void;
    let promptCreated: Promise<void>;
    let promptCallCount = 0;
    promptCreated = new Promise<void>((resolve) => {
      promptCreatedResolve = resolve;
    });
    __setCreateFnAgent(async () => {
      promptCallCount += 1;
      const callIndex = promptCallCount;
      return {
        session: {
          prompt: vi.fn().mockImplementation(() => {
            // First call hangs until we resolve it; second resolves immediately.
            if (callIndex === 1) {
              return new Promise<void>((resolve) => {
                resolvePrompt = resolve;
                promptCreatedResolve();
              });
            }
            return Promise.resolve();
          }),
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "ok" }] },
        },
      };
    });

    // Kick off generation #1 — it will hang inside prompt().
    const sendOne = chatManager.sendMessage("chat-001", "first");
    // Wait until generation #1 has actually reached its hanging prompt.
    await promptCreated;
    expect(chatManager.isGenerating("chat-001")).toBe(true);

    // Cancel #1 (so its prompt() will eventually unwind via the abort path).
    chatManager.cancelGeneration("chat-001");

    // Start generation #2 and let it run. Its sendMessage promise resolves
    // synchronously (mock prompt returns immediately on the second call), but
    // the activeGenerations slot for #2 is set during its execution.
    const sendTwo = chatManager.sendMessage("chat-001", "second");
    await sendTwo;

    // Now release #1's prompt so its finally block runs.
    resolvePrompt?.();
    await sendOne;

    // The slot was correctly cleaned up by sendTwo (the most recent owner)
    // and not re-deleted/corrupted by sendOne's late finally.
    expect(chatManager.isGenerating("chat-001")).toBe(false);
  });

  it("sendRoomMessage inlines room text attachments and forwards room image attachments", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fn-chat-room-agent-attachments-"));
    const promptSpy = vi.fn().mockResolvedValue(undefined);
    try {
      await mkdir(join(rootDir, ".fusion", "chat-room-attachments", "room-1"), { recursive: true });
      await writeFile(join(rootDir, ".fusion", "chat-room-attachments", "room-1", "room-note.txt"), "room attachment bytes");
      await writeFile(join(rootDir, ".fusion", "chat-room-attachments", "room-1", "room-image.webp"), Buffer.from([5, 4, 3]));

      (mockChatStore as any).getRoom = vi.fn().mockReturnValue({ id: "room-1", name: "team" });
      (mockChatStore as any).listRoomMembers = vi.fn().mockReturnValue([
        { roomId: "room-1", agentId: "agent-001", role: "member", addedAt: "2026-01-01" },
      ]);
      (mockChatStore as any).addRoomMessage = vi.fn().mockImplementation((_roomId: string, input: any) => ({
        id: input.role === "user" ? "user-room-msg" : "assistant-room-msg",
        roomId: "room-1",
        ...input,
      }));

      mockAgentStore.listAgents.mockResolvedValue([
        { id: "agent-001", name: "Avery", role: "executor", state: "idle" },
      ]);
      mockAgentStore.getAgent.mockResolvedValue({ id: "agent-001", name: "Avery", role: "executor", state: "idle" });

      __setCreateResolvedAgentSession(async () => ({
        session: {
          prompt: promptSpy,
          dispose: vi.fn(),
          state: { messages: [{ role: "assistant", content: "Room answer" }] },
        },
        provider: "test",
        model: "test",
        fallbackInfo: undefined,
      } as any));

      const chatManager = createChatManagerForRoot(rootDir);
      await chatManager.sendRoomMessage("room-1", "hello @Avery", [
        {
          id: "att-room-text",
          filename: "room-note.txt",
          originalName: "room-note.txt",
          mimeType: "text/plain",
          size: 21,
          createdAt: "2026-06-16T00:00:00.000Z",
        },
        {
          id: "att-room-image",
          filename: "room-image.webp",
          originalName: "room-image.webp",
          mimeType: "image/webp",
          size: 3,
          createdAt: "2026-06-16T00:00:00.000Z",
        },
      ]);

      expect(promptSpy).toHaveBeenCalledTimes(1);
      const [promptArgument, promptOptions] = promptSpy.mock.calls[0] ?? [];
      expect(promptArgument).toContain("Latest user message to answer:\n\nhello @Avery");
      expect(promptArgument).toContain("## Attachments");
      expect(promptArgument).toContain("room attachment bytes");
      expect(promptOptions).toEqual({
        images: [{ type: "image", data: Buffer.from([5, 4, 3]).toString("base64"), mimeType: "image/webp" }],
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("sendRoomMessage persists assistant room replies", async () => {
    (mockChatStore as any).getRoom = vi.fn().mockReturnValue({ id: "room-1", name: "team" });
    (mockChatStore as any).listRoomMembers = vi.fn().mockReturnValue([
      { roomId: "room-1", agentId: "agent-001", role: "member", addedAt: "2026-01-01" },
    ]);
    (mockChatStore as any).addRoomMessage = vi.fn().mockImplementation((_roomId: string, input: any) => ({
      id: "room-msg",
      roomId: "room-1",
      ...input,
    }));

    mockAgentStore.listAgents.mockResolvedValue([
      { id: "agent-001", name: "Avery", role: "executor", state: "idle" },
    ]);
    mockAgentStore.getAgent.mockResolvedValue({ id: "agent-001", name: "Avery", role: "executor", state: "idle" });

    __setCreateResolvedAgentSession(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        state: { messages: [{ role: "assistant", content: "Room answer" }] },
      },
      provider: "test",
      model: "test",
      fallbackInfo: undefined,
    } as any));

    const chatManager = createChatManager();
    await chatManager.sendRoomMessage("room-1", "hello @Avery");

    const assistant = (mockChatStore as any).addRoomMessage.mock.calls
      .map((call: any[]) => call[1])
      .find((entry: any) => entry.role === "assistant");

    expect(assistant).toMatchObject({
      role: "assistant",
      senderAgentId: "agent-001",
      content: "Room answer",
    });
  });

  it("sendRoomMessage still resolves room member responders when listAgents is unavailable", async () => {
    (mockChatStore as any).getRoom = vi.fn().mockReturnValue({ id: "room-1", name: "team" });
    (mockChatStore as any).listRoomMembers = vi.fn().mockReturnValue([
      { roomId: "room-1", agentId: "agent-001", role: "member", addedAt: "2026-01-01" },
    ]);
    (mockChatStore as any).addRoomMessage = vi.fn().mockImplementation((_roomId: string, input: any) => ({
      id: "room-msg",
      roomId: "room-1",
      ...input,
    }));

    mockAgentStore.listAgents.mockRejectedValue(new Error("agent listing offline"));
    mockAgentStore.getAgent.mockResolvedValue({ id: "agent-001", name: "Avery", role: "executor", state: "idle" });

    __setCreateResolvedAgentSession(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        state: { messages: [{ role: "assistant", content: "Recovered room answer" }] },
      },
      provider: "test",
      model: "test",
      fallbackInfo: undefined,
    } as any));

    const chatManager = createChatManager();
    await chatManager.sendRoomMessage("room-1", "hello @Avery");

    const assistant = (mockChatStore as any).addRoomMessage.mock.calls
      .map((call: any[]) => call[1])
      .find((entry: any) => entry.role === "assistant");

    expect(assistant).toMatchObject({
      role: "assistant",
      senderAgentId: "agent-001",
      content: "Recovered room answer",
    });
  });

});
