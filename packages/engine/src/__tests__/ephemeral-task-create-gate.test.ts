import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TaskStore } from "@fusion/core";
import "./executor-test-helpers.js";
import { createMockStore, mockedCreateFnAgent, resetExecutorMocks } from "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createTaskCreateTool,
  createDelegateTaskTool,
  isAgentDelegateTaskToolAvailable,
  isAgentTaskCreateToolAvailable,
} from "../agent-tools.js";

/*
FNXC:EphemeralAgentTaskCreation 2026-07-26-06:20:
Operator report: with project policy "Ephemeral agent follow-up tasks = Deny", an executing agent
still filed ten follow-up tasks (five parallel fn_task_create calls it reported as timed out, then
five sequential retries). Deny must be structural — the tool is not registered for an ephemeral
session at all — not merely an execute-time refusal the model can keep retrying.

These tests assert the invariant on every surface that can hand fn_task_create to an ephemeral
worker: the shared registration predicate, the execute-time gate inside the factory (defense in
depth), and the two engine lanes that register the tool (outer execution session, per-step session).
*/

function settings(policy?: "allow" | "upon_validation" | "deny", legacy?: boolean) {
  return {
    ...(policy ? { ephemeralAgentTaskCreationPolicy: policy } : {}),
    ...(legacy === undefined ? {} : { ephemeralAgentsCanCreateTasks: legacy }),
  } as Parameters<typeof isAgentTaskCreateToolAvailable>[0];
}

/*
FNXC:EphemeralAgentTaskCreation 2026-07-26-07:40:
Behavioral capture of the session tool list. This replaced a pair of source-text ratchets that
asserted the call expression appeared in executor.ts/step-session-executor.ts: code review noted
they assert spelling, not behavior — an inverted condition or an unconditional include would
still pass them. Asserting on the tools the executor actually hands the model is the invariant.
*/
async function captureExecutorSession(
  policy?: "allow" | "upon_validation" | "deny",
): Promise<{ toolNames: string[]; systemPrompt: string }> {
  const store = createMockStore();
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15_000,
    groupOverlappingFiles: false,
    autoMerge: false,
    ...(policy ? { ephemeralAgentTaskCreationPolicy: policy } : {}),
  });

  let toolNames: string[] = [];
  let systemPrompt = "";
  mockedCreateFnAgent.mockImplementation((async (opts: { customTools?: Array<{ name: string }>; systemPrompt?: string }) => {
    toolNames = (opts.customTools ?? []).map((tool) => tool.name);
    systemPrompt = opts.systemPrompt ?? "";
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } };
  }) as never);

  const executor = new TaskExecutor(store, "/tmp/test");
  await executor.execute({
    id: "FN-001",
    title: "Test",
    description: "Test",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { toolNames, systemPrompt };
}

describe("isAgentTaskCreateToolAvailable", () => {
  it("withholds the tool from an ephemeral caller when the policy denies creation", () => {
    expect(isAgentTaskCreateToolAvailable(settings("deny"), true)).toBe(false);
  });

  it("honors the legacy boolean when no explicit policy is persisted", () => {
    expect(isAgentTaskCreateToolAvailable(settings(undefined, false), true)).toBe(false);
    expect(isAgentTaskCreateToolAvailable(settings(undefined, true), true)).toBe(true);
  });

  it("keeps the tool for allow and upon_validation (a proposal is a supported action)", () => {
    expect(isAgentTaskCreateToolAvailable(settings("allow"), true)).toBe(true);
    expect(isAgentTaskCreateToolAvailable(settings("upon_validation"), true)).toBe(true);
  });

  it("never gates a non-ephemeral caller, even under deny", () => {
    expect(isAgentTaskCreateToolAvailable(settings("deny"), false)).toBe(true);
    expect(isAgentTaskCreateToolAvailable(settings("deny"), undefined)).toBe(true);
  });

  it("defaults to available when settings are unreadable", () => {
    expect(isAgentTaskCreateToolAvailable(undefined, true)).toBe(true);
    expect(isAgentTaskCreateToolAvailable(settings(), true)).toBe(true);
  });
});

describe("fn_task_create execute-time gate (defense in depth)", () => {
  it("refuses an ephemeral caller under deny without touching the store", async () => {
    let createCalls = 0;
    const store = {
      getSettings: async () => settings("deny"),
      createTask: async () => { createCalls += 1; throw new Error("createTask must not run under deny"); },
    } as unknown as TaskStore;

    const tool = createTaskCreateTool(store, { sourceType: "api" }, { callerIsEphemeral: true });
    const result = await (tool.execute as unknown as (
      id: string,
      params: unknown,
    ) => Promise<{ isError?: boolean; details?: unknown }>)(
      "call-1",
      { description: "Follow-up work discovered mid-task" },
    );

    expect(result.isError).toBe(true);
    expect((result.details as { rule?: string }).rule).toBe("ephemeral-agents-cannot-create-tasks");
    expect(createCalls).toBe(0);
  });
});

describe("isAgentDelegateTaskToolAvailable", () => {
  /*
  FNXC:EphemeralAgentTaskCreation 2026-07-26-07:40:
  fn_delegate_task reaches the same createAgentTask primitive, so Deny must cover it. It is
  stricter than fn_task_create: upon_validation also withholds it, because delegation has no
  proposal channel and would otherwise launder a create past the operator review.
  */
  it("withholds delegation from an ephemeral caller under deny", () => {
    expect(isAgentDelegateTaskToolAvailable(settings("deny"), true)).toBe(false);
  });

  it("withholds delegation under upon_validation (no proposal channel to validate through)", () => {
    expect(isAgentDelegateTaskToolAvailable(settings("upon_validation"), true)).toBe(false);
  });

  it("allows delegation under allow, and always for non-ephemeral callers", () => {
    expect(isAgentDelegateTaskToolAvailable(settings("allow"), true)).toBe(true);
    expect(isAgentDelegateTaskToolAvailable(settings("deny"), false)).toBe(true);
  });

  it("refuses at execute time without creating a task", async () => {
    let createCalls = 0;
    const taskStore = {
      getSettings: async () => settings("deny"),
      createTask: async () => { createCalls += 1; throw new Error("createTask must not run under deny"); },
    } as unknown as TaskStore;
    const agentStore = {
      getAgent: async () => { throw new Error("target lookup must not run before the caller gate"); },
    } as never;

    const tool = createDelegateTaskTool(agentStore, taskStore, { callerIsEphemeral: true });
    const result = await (tool.execute as unknown as (
      id: string,
      params: unknown,
    ) => Promise<{ isError?: boolean; details?: unknown }>)(
      "call-1",
      { agent_id: "agent-permanent", description: "Delegated follow-up" },
    );

    expect(result.isError).toBe(true);
    expect((result.details as { rule?: string }).rule).toBe("ephemeral-agents-cannot-create-tasks");
    expect(createCalls).toBe(0);
  });
});

describe("executor session tool list (behavioral)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("hands the model no task-creating tool under deny", async () => {
    const { toolNames } = await captureExecutorSession("deny");
    expect(toolNames).not.toContain("fn_task_create");
    expect(toolNames).not.toContain("fn_delegate_task");
    // Sanity: the session still has its other tools, so this is suppression, not an empty list.
    expect(toolNames).toContain("fn_task_done");
  });

  it("keeps fn_task_create under upon_validation but still withholds delegation", async () => {
    const { toolNames } = await captureExecutorSession("upon_validation");
    expect(toolNames).toContain("fn_task_create");
    expect(toolNames).not.toContain("fn_delegate_task");
  });

  it("keeps both tools when the policy allows creation", async () => {
    const { toolNames } = await captureExecutorSession("allow");
    expect(toolNames).toContain("fn_task_create");
  });

  it("defaults to allow when no policy is persisted", async () => {
    const { toolNames } = await captureExecutorSession();
    expect(toolNames).toContain("fn_task_create");
  });

  /*
  FNXC:EphemeralAgentTaskCreation 2026-07-26-07:40:
  The base prompt teaches fn_task_create in several places. Withholding the tool without
  correcting the prompt recreates the instruction/capability mismatch behind the incident, so
  the session prompt must state the absence and name the fallback.
  */
  it("tells the agent the tool is withheld by policy and what to do instead", async () => {
    const { systemPrompt } = await captureExecutorSession("deny");
    expect(systemPrompt).toContain("Follow-up task creation is disabled for this session");
    expect(systemPrompt).toContain("fn_task_log");
  });

  it("adds no withheld-tool guidance when creation is allowed", async () => {
    const { systemPrompt } = await captureExecutorSession("allow");
    expect(systemPrompt).not.toContain("Follow-up task creation is disabled for this session");
  });
});
