import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskStore, AgentStore, ChatStore, MessageStore, Settings } from "@fusion/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createChatFusionToolset } from "../chat.js";

function makeTool(name: string): ToolDefinition {
  return { name, label: name, description: "", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) };
}

const baseTaskStore = () => ({
  getSettings: vi.fn(async () => ({})),
} as unknown as TaskStore);

const baseAgentStore = {} as unknown as AgentStore;

const baseChatStore = () => ({
  getSession: vi.fn(),
  getMessages: vi.fn(),
} as unknown as ChatStore);

const baseMessageStore = {} as unknown as MessageStore;

describe("createChatFusionToolset — permission-parity regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Task-lifecycle mutation tools that require an enforceable action-gate context.
  // These are only exposed when actionGateContext is present, because
  // wrapToolsWithActionGate is a pass-through without a gate (pi.ts) — advertising
  // them ungated would let delete/retry/etc. run with no policy enforcement.
  const gatedMutationTools = [
    "fn_task_delete",
    "fn_task_retry",
    "fn_task_pause",
    "fn_task_unpause",
    "fn_task_duplicate",
    "fn_task_merge",
  ];

  // Tools that target the factory's ambient current-task id. Project-scoped chat has
  // no ambient task, so binding "" would make them operate on no task — they are
  // intentionally NOT part of the chat surface (executor/heartbeat bind them with a
  // concrete task id instead).
  const ambientTaskTools = ["fn_task_update", "fn_task_add_dep", "fn_task_promote"];

  it("exposes gated task-mutation surface when an action-gate context is present", async () => {
    const taskStore = baseTaskStore();
    const tools = await createChatFusionToolset({
      taskStore,
      agentStore: baseAgentStore,
      rootDir: "/project",
      agentId: "agent-abc",
      missionMutationGated: true,
      actionGateContext: {} as any,
    });
    const names = new Set(tools.map((t) => t.name));
    for (const name of gatedMutationTools) {
      expect(names.has(name), `missing gated mutation tool: ${name}`).toBe(true);
    }
  });

  it("does not expose the removed task archive tools", async () => {
    const tools = await createChatFusionToolset({
      taskStore: baseTaskStore(),
      agentStore: baseAgentStore,
      rootDir: "/project",
      agentId: "agent-abc",
      missionMutationGated: true,
      actionGateContext: {} as any,
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("fn_task_archive")).toBe(false);
    expect(names.has("fn_task_unarchive")).toBe(false);
  });

  it("withholds task-mutation tools when there is no enforceable action-gate context", async () => {
    const taskStore = baseTaskStore();
    const tools = await createChatFusionToolset({
      taskStore,
      agentStore: baseAgentStore,
      rootDir: "/project",
      agentId: "agent-abc",
      missionMutationGated: false,
      // no actionGateContext
    });
    const names = new Set(tools.map((t) => t.name));
    for (const name of gatedMutationTools) {
      expect(names.has(name), `mutation tool leaked without gate: ${name}`).toBe(false);
    }
  });

  it("keeps mission status mutations behind missionMutationGated", async () => {
    const taskStore = baseTaskStore();
    const ungated = await createChatFusionToolset({
      taskStore,
      agentStore: baseAgentStore,
      rootDir: "/project",
      agentId: "agent-abc",
      missionMutationGated: false,
    });
    const gated = await createChatFusionToolset({
      taskStore,
      agentStore: baseAgentStore,
      rootDir: "/project",
      agentId: "agent-abc",
      missionMutationGated: true,
    });
    const ungatedNames = new Set(ungated.map((tool) => tool.name));
    const gatedNames = new Set(gated.map((tool) => tool.name));
    for (const name of ["fn_feature_set_status", "fn_mission_set_status"]) {
      expect(ungatedNames.has(name), `mission mutation leaked without gate: ${name}`).toBe(false);
      expect(gatedNames.has(name), `missing gated mission mutation: ${name}`).toBe(true);
    }
  });

  it("never binds ambient-task tools in project-scoped chat (no ambient task id)", async () => {
    const taskStore = baseTaskStore();
    for (const gate of [undefined, {} as any]) {
      const tools = await createChatFusionToolset({
        taskStore,
        agentStore: baseAgentStore,
        rootDir: "/project",
        agentId: "agent-abc",
        missionMutationGated: gate ? true : false,
        ...(gate ? { actionGateContext: gate } : {}),
      });
      const names = new Set(tools.map((t) => t.name));
      for (const name of ambientTaskTools) {
        expect(names.has(name), `ambient-task tool must not be bound: ${name}`).toBe(false);
      }
    }
  });

  it("does not bind fn_reflect_on_performance in chat (no reflection service available)", async () => {
    const taskStore = baseTaskStore();
    const tools = await createChatFusionToolset({
      taskStore,
      agentStore: baseAgentStore,
      rootDir: "/project",
      agentId: "agent-abc",
      actionGateContext: {} as any,
    });
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("fn_reflect_on_performance")).toBe(false);
    // read-only evaluations tool still present (degrades to ratings-only without a store)
    expect(names.has("fn_read_evaluations")).toBe(true);
  });

  it("registers conversation read tools only with a store and current Direct session", async () => {
    const tools = await createChatFusionToolset({
      rootDir: "/project",
      chatStore: baseChatStore(),
      currentChatSessionId: "chat-00000000",
      currentProjectId: "project-a",
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("fn_chat_conversation_read")).toBe(true);
    expect(names.has("fn_chat_conversation_search")).toBe(true);
  });

  it("withholds conversation tools when the chat store is absent", async () => {
    const tools = await createChatFusionToolset({
      rootDir: "/project",
      currentChatSessionId: "chat-00000000",
      currentProjectId: "project-a",
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("fn_chat_conversation_read")).toBe(false);
    expect(names.has("fn_chat_conversation_search")).toBe(false);
  });

  it("withholds conversation tools when the current session identity is absent", async () => {
    const tools = await createChatFusionToolset({
      rootDir: "/project",
      chatStore: baseChatStore(),
      currentProjectId: "project-a",
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("fn_chat_conversation_read")).toBe(false);
    expect(names.has("fn_chat_conversation_search")).toBe(false);
  });

  it("keeps room and mentioned-responder caller shapes free of conversation tools", async () => {
    for (const callerOptions of [
      { taskStore: baseTaskStore(), agentStore: baseAgentStore, agentId: "room-responder" },
      { taskStore: baseTaskStore(), agentStore: baseAgentStore, agentId: "mentioned-responder" },
    ]) {
      const tools = await createChatFusionToolset({ rootDir: "/project", ...callerOptions });
      const names = new Set(tools.map((tool) => tool.name));
      expect(names.has("fn_chat_conversation_read")).toBe(false);
      expect(names.has("fn_chat_conversation_search")).toBe(false);
    }
  });

  it("does not regress existing read-only tools", async () => {
    const taskStore = baseTaskStore();
    const tools = await createChatFusionToolset({
      taskStore,
      agentStore: baseAgentStore,
      rootDir: "/project",
      agentId: "agent-abc",
    });
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("fn_task_list")).toBe(true);
    expect(names.has("fn_task_show")).toBe(true);
    expect(names.has("fn_task_search")).toBe(true);
    expect(names.has("fn_task_create")).toBe(true);
    expect(names.has("fn_task_assign")).toBe(true);
    expect(names.has("fn_list_agents")).toBe(true);
    expect(names.has("fn_web_fetch")).toBe(true);
    expect(names.has("fn_trait_list")).toBe(true);
    expect(names.has("fn_ask_question")).toBe(true);
  });
});
