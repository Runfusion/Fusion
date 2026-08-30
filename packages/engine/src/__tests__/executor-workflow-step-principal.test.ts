import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

type CapturedSession = {
  defaultProvider?: string;
  defaultModelId?: string;
  runtimeHint?: string;
};

function captureSession(): { last?: CapturedSession } {
  const holder: { last?: CapturedSession } = {};
  mockedCreateFnAgent.mockImplementation(async (options: any) => {
    holder.last = {
      defaultProvider: options.defaultProvider,
      defaultModelId: options.defaultModelId,
      runtimeHint: options.runtimeHint,
    };
    const listeners: Array<(event: any) => void> = [];
    return {
      session: {
        state: {},
        subscribe: (listener: (event: any) => void) => {
          listeners.push(listener);
          return () => {};
        },
        prompt: vi.fn(async () => {
          for (const listener of listeners) {
            listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: '{"verdict":"APPROVE","notes":"Reviewed the scoped work and found it correct."}' } });
          }
        }),
        dispose: vi.fn(),
      },
    };
  });
  return holder;
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-PRINCIPAL-1",
    title: "Principal session",
    description: "verify routed identity",
    column: "in-progress" as const,
    worktree: "/tmp/wt",
    branch: "fusion/fn-principal-1",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "s", status: "in-progress" as const }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function step(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: "step:principal",
    name: "Code Review",
    description: "",
    mode: "prompt" as const,
    phase: "pre-merge" as const,
    gateMode: "advisory" as const,
    prompt: "Review this.",
    toolMode: "readonly" as const,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeExecutor() {
  const store = createMockStore();
  store.getSettings.mockResolvedValue({});
  const agents = new Map([
    ["agent-principal", { id: "agent-principal", runtimeConfig: { model: "anthropic/claude-principal", modelProvider: "anthropic", modelId: "claude-principal", runtimeHint: "principal-hint" } }],
    ["agent-assigned", { id: "agent-assigned", runtimeConfig: { model: "openai/gpt-assigned", modelProvider: "openai", modelId: "gpt-assigned", runtimeHint: "assigned-hint" } }],
  ]);
  const agentStore = { getAgent: vi.fn(async (id: string) => agents.get(id) ?? null), createAgent: vi.fn() };
  return { store, executor: new TaskExecutor(store as any, "/tmp/test", { agentStore } as any) };
}

describe("executor workflow-step routed principal", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockImplementation(() => Buffer.from(""));
  });

  it.each([
    ["review", step()],
    ["ordinary prompt", step({ name: "Implementation Prompt" })],
  ])("uses the routed principal runtime identity for a %s step", async (_lane, workflowStep) => {
    const { executor } = makeExecutor();
    const captured = captureSession();
    const assignedConfig = vi.spyOn(executor as any, "getAssignedAgentRuntimeConfig");

    await (executor as any).executeWorkflowStep(
      task({ assignedAgentId: "agent-assigned" }), workflowStep, "/tmp/wt", {}, undefined,
      { principalAgentId: "agent-principal" },
    );

    expect(captured.last).toMatchObject({
      defaultProvider: "anthropic",
      defaultModelId: "claude-principal",
      runtimeHint: "principal-hint",
    });
    expect(assignedConfig).not.toHaveBeenCalled();
  });

  it("threads only string graph principal context to prompt steps", async () => {
    const { store, executor } = makeExecutor();
    store.getTask.mockImplementation(async (id: string) => task({ id }));
    const execute = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });
    const executeScript = vi.spyOn(executor as any, "executeScriptWorkflowStep").mockResolvedValue({ success: true, output: "ok" });
    const promptNode = { id: "principal-prompt", kind: "prompt", config: { prompt: "Review" } };
    const scriptNode = { id: "principal-script", kind: "script", config: { command: "true" } };

    await (executor as any).runGraphCustomNode(promptNode, task(), {}, undefined, { "workflow:principal-agent-id": "agent-principal" });
    await (executor as any).runGraphCustomNode(promptNode, task(), {}, undefined, { "workflow:principal-agent-id": 42 });
    await (executor as any).runGraphCustomNode(scriptNode, task(), {}, undefined, { "workflow:principal-agent-id": "agent-principal" });

    expect(execute.mock.calls[0][5]).toMatchObject({ principalAgentId: "agent-principal" });
    expect(execute.mock.calls[1][5]).toMatchObject({ principalAgentId: undefined });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(executeScript.mock.calls[0]).toHaveLength(5);
  });

  it("fails closed instead of falling back when the routed principal is unavailable", async () => {
    const { executor } = makeExecutor();
    await expect((executor as any).executeWorkflowStep(
      task({ assignedAgentId: "agent-assigned" }), step(), "/tmp/wt", {}, undefined,
      { principalAgentId: "agent-missing" },
    )).rejects.toThrow(/^workflow-principal-unavailable:agent-missing$/);
  });

  it("keeps unrouted steps on their assigned agent", async () => {
    const { executor } = makeExecutor();
    const captured = captureSession();
    await (executor as any).executeWorkflowStep(
      task({ assignedAgentId: "agent-assigned" }), step({ name: "Implementation Prompt" }), "/tmp/wt", {}, undefined,
    );
    expect(captured.last).toMatchObject({ defaultProvider: "openai", defaultModelId: "gpt-assigned", runtimeHint: "assigned-hint" });
  });
});
