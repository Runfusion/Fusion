import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { toWorkspaceRepoReviewResult } from "../executor/run-graph-custom-node.js";
import { workflowNodeRequiresWorktree } from "../workflows/workflow-node-execution-needs.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

function reviewTask() {
  const now = new Date().toISOString();
  return {
    id: "FN-288-REVIEW",
    title: "Judge without repairing",
    description: "Keep reviewers read-only unless the workflow opts into inline fixes.",
    column: "in-progress" as const,
    worktree: "/tmp/fn-288-review",
    branch: "fusion/fn-288-review",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" as const }],
    currentStep: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
  };
}

function codeReviewStep() {
  const now = new Date().toISOString();
  return {
    id: "graph:code-review-step",
    name: "Code Review",
    description: "",
    mode: "prompt" as const,
    phase: "pre-merge" as const,
    gateMode: "gate" as const,
    prompt: "Review the implementation.",
    toolMode: "readonly" as const,
    optionalGroupId: "code-review",
    reviewKind: "code" as const,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

async function dispatchReview(options: {
  baseSettings?: Record<string, unknown>;
  workflowValues?: Record<string, unknown>;
}) {
  const task = reviewTask();
  const store = createMockStore();
  store.getTask.mockResolvedValue(task);
  store.getTaskWorkflowSelection.mockReturnValue({ workflowId: "builtin:coding", stepIds: ["code-review"] });
  store.getWorkflowDefinition = vi.fn(async () => undefined);
  store.getWorkflowSettingValues = vi.fn(() => options.workflowValues ?? {});
  store.getWorkflowSettingsProjectId = vi.fn(() => "project-fn-288");

  const captured: Array<{ tools?: string; systemPrompt?: string }> = [];
  mockedCreateFnAgent.mockImplementation(async (sessionOptions: { tools?: string; systemPrompt?: string }) => {
    captured.push({ tools: sessionOptions.tools, systemPrompt: sessionOptions.systemPrompt });
    const listeners: Array<(event: unknown) => void> = [];
    return {
      session: {
        state: {},
        subscribe: (listener: (event: unknown) => void) => {
          listeners.push(listener);
          return () => {};
        },
        prompt: vi.fn(async () => {
          for (const listener of listeners) {
            listener({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: '{"verdict":"APPROVE","notes":"The scoped implementation satisfies the approved task contract."}',
              },
            });
          }
        }),
        dispose: vi.fn(),
      },
    } as any;
  });

  const executor = new TaskExecutor(store as any, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as any);
  await (executor as any).executeWorkflowStep(
    task,
    codeReviewStep(),
    task.worktree,
    { workflowStepTimeoutMs: 60_000, ...(options.baseSettings ?? {}) },
    undefined,
  );
  return captured.at(-1);
}

describe("reviewers judge without repairing", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockImplementation(() => Buffer.from(""));
  });

  it("uses the workflow declaration default to keep review sessions read-only", async () => {
    const session = await dispatchReview({});

    expect(session?.tools).toBe("readonly");
    expect(session?.systemPrompt).not.toContain("## Same-Session Fix Policy");
  });

  it("preserves an explicit base setting that enables same-session fixes", async () => {
    const session = await dispatchReview({ baseSettings: { reviewerInlineFixes: true } });

    expect(session?.tools).toBe("coding");
    expect(session?.systemPrompt).toContain("## Same-Session Fix Policy");
  });

  it("honors a stored workflow value that enables same-session fixes", async () => {
    const session = await dispatchReview({ workflowValues: { reviewerInlineFixes: true } });

    expect(session?.tools).toBe("coding");
    expect(session?.systemPrompt).toContain("## Same-Session Fix Policy");
  });

  it("keeps authored coding gates worktree-capable under the review seal classifier", () => {
    for (const id of ["browser-verification-step", "documentation-delivery-step"]) {
      expect(workflowNodeRequiresWorktree({
        id,
        kind: "prompt",
        config: { toolMode: "coding" },
      })).toBe(true);
    }
  });

  it("never synthesizes workspace approval from verdict-required transport success", () => {
    expect(toWorkspaceRepoReviewResult({
      success: true,
      verdictRequired: true,
      output: "The reviewer returned without an authored verdict.",
    })).toMatchObject({
      verdict: "UNAVAILABLE",
      review: "The reviewer returned without an authored verdict.",
    });
  });
});
