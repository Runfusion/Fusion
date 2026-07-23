import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { reviewStep as mockedReviewStepFn } from "../execution/reviewer.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  mockedExistsSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

describe("executor tool step numbering is 0-based", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  async function captureTools(stepStates = [
    { name: "Preflight", status: "pending" },
    { name: "First", status: "pending" },
    { name: "Second", status: "pending" },
  ]) {
    const store = createMockStore();
    store.getTask.mockImplementation(async () => ({
      id: "FN-6607-T",
      title: "Zero based steps",
      description: "",
      column: "in-progress",
      dependencies: [],
      steps: stepStates.map((step) => ({ ...step })),
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n### Step 1: First\n### Step 2: Second",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    store.updateStep.mockImplementation(async (_taskId: string, stepIndex: number, status: string) => {
      stepStates[stepIndex].status = status;
      return { steps: stepStates.map((step) => ({ ...step })) };
    });

    let customTools: any[] = [];
    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      customTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          navigateTree: vi.fn(),
          sessionManager: {
            getLeafId: vi.fn().mockReturnValue("leaf-step"),
            branchWithSummary: vi.fn(),
          },
          state: {},
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-6607-T",
      title: "Zero based steps",
      description: "",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    const tools: Record<string, any> = {};
    for (const tool of customTools) tools[tool.name] = tool.execute;
    return { tools, store, stepStates };
  }

  it("resume recovery reads the same 0-based review log written by fn_review_step", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-6607-R",
      title: "Resume",
      description: "",
      column: "in-progress",
      dependencies: [],
      steps: [
        { name: "Preflight", status: "done" },
        { name: "First", status: "in-progress" },
        { name: "Second", status: "pending" },
      ],
      currentStep: 1,
      log: [
        { timestamp: "2026-06-17T00:00:00.000Z", action: "Step 1 (First) → in-progress" },
        { timestamp: "2026-06-17T00:00:01.000Z", action: "code review Step 1: APPROVE" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await (executor as any).recoverApprovedStepsOnResume("FN-6607-R");

    expect(store.updateStep).toHaveBeenCalledWith("FN-6607-R", 1, "done");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-6607-R",
      expect.stringContaining("Step 1 (First) recovered as done on resume"),
    );
  });

  it("does not reconcile reopened steps from older complete-step commits", async () => {
    const store = createMockStore();
    const detail = {
      id: "FN-7273",
      title: "Reopened suffix",
      description: "",
      column: "in-progress",
      dependencies: [],
      baseCommitSha: "base",
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implementation", status: "done" },
        { name: "Testing", status: "pending" },
      ],
      currentStep: 2,
      log: [
        { timestamp: "2026-06-30T14:59:30.110Z", action: "Step 2 (Testing) → pending" },
      ],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n### Step 1: Implementation\n### Step 2: Testing",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    store.getTask.mockResolvedValue(detail);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git log")) {
        return "1782831500\tfeat(FN-7273): complete Step 2 — old verification\n";
      }
      return "";
    });

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await (executor as any).reconcileStepsFromGitHistory("FN-7273", detail, "/tmp/wt");

    expect(store.updateStep).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-7273",
      expect.stringContaining("Reconciled Step 2 as done from git history"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not log git-history reconciliation when TaskStore rejects the done write", async () => {
    const store = createMockStore();
    const detail = {
      id: "FN-7273",
      title: "Out of order reconciliation",
      description: "",
      column: "in-progress",
      dependencies: [],
      baseCommitSha: "base",
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Fix", status: "in-progress" },
        { name: "Delivery", status: "pending" },
      ],
      currentStep: 1,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n### Step 1: Fix\n### Step 2: Delivery",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    store.getTask.mockResolvedValue(detail);
    store.updateStep.mockResolvedValue({
      ...detail,
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Fix", status: "in-progress" },
        { name: "Delivery", status: "pending" },
      ],
    } as any);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git log")) {
        return "1782832000\tfeat(FN-7273): complete Step 2 — old delivery\n";
      }
      return "";
    });

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await (executor as any).reconcileStepsFromGitHistory("FN-7273", detail, "/tmp/wt");

    expect(store.updateStep).toHaveBeenCalledWith("FN-7273", 2, "done");
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-7273",
      expect.stringContaining("Reconciled Step 2 as done from git history"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("pending-review loop detection matches 0-based writer strings", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-6607-P",
      title: "Pending review",
      description: "",
      column: "in-progress",
      dependencies: [],
      taskDoneRetryCount: 2,
      /*
      FNXC:EngineTests 2026-07-19-16:50 (U10b):
      The invariant under test lives in the IMPLEMENTATION session's no-fn_task_done retry loop:
      a step blocked on a pending review must skip the retry and park in review. Declaring no
      pre-merge gates keeps the graph's optional review nodes out of the fixture so the pending
      review being detected is the one this test seeded in `log`.
      */
      enabledWorkflowSteps: [],
      /*
      FNXC:EngineTests 2026-07-19-17:05 (U10b):
      The pending review is seeded against the step the graph is actually executing — its first
      step — because the graph re-parses PROMPT.md into the step list on entry and starts at the
      first non-terminal step. "Step 0" remains the discriminator this test exists for: only a
      0-based writer ever emits it, so a 1-based regression breaks the match.
      */
      steps: [
        { name: "Preflight", status: "in-progress" },
        { name: "First", status: "pending" },
      ],
      currentStep: 0,
      log: [{ timestamp: new Date().toISOString(), action: "code review requested for Step 0 (Preflight)" }],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n### Step 1: First",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    store.getTask.mockResolvedValue(task);
    /*
    FNXC:EngineTests 2026-07-19-16:55 (U10b):
    PROMPT.md is the step source of record: the graph parses it into the task's step list before
    the implementation session, so the artifact must describe the SAME two steps the fixture
    seeded. With the harness's default single-step artifact the parse collapses the list to one
    step and the pending-review step this test is about ceases to exist.
    */
    store.getTaskDocument.mockImplementation(async (_taskId: string, key: string) =>
      key === "PROMPT.md" ? { content: task.prompt } : undefined,
    );
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    } as any);

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(task);

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-6607-P",
      expect.stringContaining("Step 0 is blocked on pending review"),
      undefined,
      expect.objectContaining({ agentId: "executor" }),
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-6607-P", "in-review");
  });
});
