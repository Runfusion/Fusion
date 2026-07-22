import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { reviewStep as mockedReviewStepFn } from "../execution/reviewer.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExistsSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

async function captureTools(comments: any[] = [], steeringComments: any[] = []) {
  const store = createMockStore();
  const stepStates = [
    { name: "Preflight", status: "done" },
    { name: "Implement", status: "pending" },
    { name: "Test", status: "pending" },
  ];

  let checkpointLeafId = "leaf-1";
  const navigateTree = vi.fn().mockResolvedValue({ cancelled: false });

  store.getTask.mockImplementation(async () => ({
    id: "FN-TEST",
    title: "Test",
    description: "Test",
    column: "in-progress",
    dependencies: [],
    steps: stepStates.map((s) => ({ ...s })),
    currentStep: 1,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    comments,
    steeringComments,
  }));
  store.updateStep.mockImplementation(async (_taskId: string, stepIndex: number, status: string) => {
    stepStates[stepIndex].status = status;
    return { steps: stepStates.map((s) => ({ ...s })) };
  });

  let customTools: any[] = [];
  mockedCreateFnAgent.mockImplementation(async (opts: any) => {
    customTools = opts.customTools || [];
    return {
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        navigateTree,
        sessionManager: {
          getLeafId: vi.fn(() => checkpointLeafId),
          branchWithSummary: vi.fn(),
        },
      },
    } as any;
  });

  mockedExistsSync.mockReturnValue(true);
  const executor = new TaskExecutor(store, "/tmp/test");
  await executor.execute({
    id: "FN-TEST",
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

  const tools: Record<string, any> = {};
  for (const tool of customTools) tools[tool.name] = tool.execute;
  return { tools, store, stepStates, navigateTree, setLeaf: (leaf: string) => { checkpointLeafId = leaf; } };
}

function workflowPromptTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-WF-PROMPT",
    title: "Workflow prompt",
    description: "Run reviewer workflow prompt",
    column: "in-progress" as const,
    worktree: "/tmp/wt",
    branch: "fusion/fn-wf-prompt",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "Done", status: "done" as const }],
    currentStep: 0,
    log: [],
    prompt: "# prompt",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function workflowPromptStep(overrides: Record<string, unknown> = {}) {
  return {
    id: "graph:browser-verification-step",
    name: "Browser Verification",
    description: "",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: "gate",
    prompt: "Verify the operator requirements.",
    toolMode: "readonly",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function captureWorkflowStepSystemPrompt(taskDetail: Record<string, unknown>) {
  const store = createMockStore();
  store.getTask.mockResolvedValue(taskDetail as any);
  const captured: { systemPrompt?: string } = {};
  mockedCreateFnAgent.mockImplementation(async (opts: any) => {
    captured.systemPrompt = opts.systemPrompt;
    const listeners: Array<(event: any) => void> = [];
    return {
      session: {
        state: {},
        subscribe: (fn: (event: any) => void) => {
          listeners.push(fn);
          return () => {};
        },
        prompt: vi.fn(async () => {
          for (const fn of listeners) {
            fn({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                partial: '{"verdict":"APPROVE","notes":""}',
                contentIndex: 0,
                delta: '{"verdict":"APPROVE","notes":""}',
              },
            });
          }
        }),
        dispose: vi.fn(),
      },
    } as any;
  });
  const executor = new TaskExecutor(store, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as any);

  await (executor as any).executeWorkflowStep(
    workflowPromptTask({ id: taskDetail.id }),
    workflowPromptStep(),
    "/tmp/wt",
    {},
    undefined,
    undefined,
  );

  return captured.systemPrompt ?? "";
}

describe("workflow prompt reviewer comment context", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("adds canonical user comments and legacy steering to workflow-step reviewer system prompts", async () => {
    const systemPrompt = await captureWorkflowStepSystemPrompt(workflowPromptTask({
      comments: [
        { id: "c-user", text: "Unified workflow prompt requirement", author: "user", createdAt: "2026-06-21T10:00:00.000Z" },
        { id: "c-agent", text: "agent-only workflow note", author: "agent", createdAt: "2026-06-21T10:01:00.000Z" },
      ],
      steeringComments: [
        { id: "s-user", text: "Legacy workflow prompt steering", author: "user", createdAt: "2026-06-21T10:02:00.000Z" },
        { id: "s-agent", text: "agent-only legacy steering", author: "agent", createdAt: "2026-06-21T10:03:00.000Z" },
      ],
    }));

    expect(systemPrompt).toContain("## User Comments");
    expect(systemPrompt).toContain("Unified workflow prompt requirement");
    expect(systemPrompt).toContain("Legacy workflow prompt steering");
    expect(systemPrompt).not.toContain("agent-only workflow note");
    expect(systemPrompt).not.toContain("agent-only legacy steering");
  });

  it("omits empty user comment sections for workflow-step reviewer system prompts", async () => {
    const systemPrompt = await captureWorkflowStepSystemPrompt(workflowPromptTask({
      comments: [{ id: "c-agent", text: "agent-only workflow note", author: "agent", createdAt: "2026-06-21T10:01:00.000Z" }],
      steeringComments: [{ id: "s-agent", text: "agent-only legacy steering", author: "agent", createdAt: "2026-06-21T10:03:00.000Z" }],
    }));

    expect(systemPrompt).not.toContain("## User Comments");
    expect(systemPrompt).not.toContain("agent-only workflow note");
    expect(systemPrompt).not.toContain("agent-only legacy steering");
  });
});
