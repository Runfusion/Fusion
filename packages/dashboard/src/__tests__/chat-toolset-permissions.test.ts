import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskStore, AgentStore, MessageStore, Settings } from "@fusion/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createChatFusionToolset } from "../chat.js";

function makeTool(name: string): ToolDefinition {
  return { name, label: name, description: "", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) };
}

const baseTaskStore = () => ({
  getSettings: vi.fn(async () => ({})),
} as unknown as TaskStore);

const baseAgentStore = {} as unknown as AgentStore;

const baseMessageStore = {} as unknown as MessageStore;

describe("createChatFusionToolset — permission-parity regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Task-lifecycle mutation tools that require an enforceable action-gate context.
  // These are only exposed when actionGateContext is present, because
  // wrapToolsWithActionGate is a pass-through without a gate (pi.ts) — advertising
  // them ungated would let archive/delete/retry/etc. run with no policy enforcement.
  const gatedMutationTools = [
    "fn_task_archive",
    "fn_task_unarchive",
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
