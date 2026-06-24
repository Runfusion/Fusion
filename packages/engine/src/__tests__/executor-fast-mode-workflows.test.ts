// @ts-nocheck
// FN-6226 surface enumeration: engine-only behavior, so desktop/mobile
// breakpoints are N/A. These tests cover legacy seams, graph runtime
// primitives, custom graph prompt/script/gate nodes under a custom workflow
// selection, builtin/default selection behavior via the legacy seam, fast /
// standard / undefined executionMode data states, and the executor tool
// injection surface for fn_review_step vs mandatory fn_task_done.
import { describe, it, expect, vi, beforeEach } from "vitest";
import "./executor-test-helpers.js";
import { getBuiltinWorkflow } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { WorkflowGraphTaskRunner } from "../workflow-graph-task-runner.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExistsSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const now = "2026-06-10T00:00:00.000Z";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-6226",
    title: "Fast mode workflow task",
    description: "exercise fast mode",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "# Task\n## Steps\n### Step 1\n- [ ] do it",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeExecutorForTask(liveTask = task()) {
  const store = createMockStore();
  store.getTask.mockImplementation(async (id: string) => ({ ...liveTask, id }));
  store.getSettings.mockResolvedValue({
    autoMerge: false,
    experimentalFeatures: { workflowGraphExecutor: true },
  });
  return { store, executor: new TaskExecutor(store, "/tmp/test") };
}

function workflowResult() {
  return { allPassed: true, results: [] };
}

describe("fast mode workflow/runtime invariants", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("graph executor with a custom workflow skips custom pre-merge prompt/gate nodes in fast mode", async () => {
    const { store, executor } = makeExecutorForTask(task({ executionMode: "fast", worktree: "/tmp/wt" }));
    const executeStep = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true });
    const executeScript = vi.spyOn(executor as any, "executeScriptWorkflowStep").mockResolvedValue({ success: true });

    const definition = {
      id: "WF-fast-custom",
      name: "Fast custom",
      description: "custom workflow",
      kind: "workflow",
      layout: {},
      createdAt: now,
      updatedAt: now,
      ir: {
        version: "v1",
        name: "Fast custom",
        nodes: [
          { id: "start", kind: "start" },
          { id: "custom-review", kind: "prompt", config: { prompt: "Review this" } },
          { id: "custom-gate", kind: "gate", config: { prompt: "Gate this", gateMode: "gate" } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "custom-review" },
          { from: "custom-review", to: "custom-gate" },
          { from: "custom-gate", to: "end" },
        ],
      },
    };

    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-fast-custom", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async () => definition),
      },
      seams: (executor as any).createAuthoritativeWorkflowSeams({}),
      primitives: (executor as any).createAuthoritativeWorkflowPrimitives({ experimentalFeatures: { workflowGraphExecutor: true } }),
      runCustomNode: (node, nodeTask, context) => (executor as any).runGraphCustomNode(node, nodeTask, {}, undefined),
    });

    const result = await runner.run(task({ id: "FN-6226", executionMode: "fast" }), { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toEqual(["start", "custom-review", "custom-gate"]);
    expect(executeStep).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-6226",
      "Fast mode — custom graph node 'custom-review' skipped",
      undefined,
      undefined,
    );
  });

  it("falls back to the runner task when prepareWorktree cannot trust the live row", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({ ...task({ id: "FN-OTHER", worktree: "/tmp/wrong" }) });
    const executor = new TaskExecutor(store, "/tmp/test");

    const result = await (executor as any)
      .createAuthoritativeWorkflowPrimitives({ experimentalFeatures: { workflowGraphExecutor: true } })
      .prepareWorktree(
        { run: { taskId: "FN-6226" }, node: { node: { id: "execute" }, context: {} } },
        task({ id: "FN-6226", worktree: "/tmp/right", branch: "fusion/fn-6226" }),
      );

    expect(result).toMatchObject({
      outcome: "success",
      data: {
        worktreePath: "/tmp/right",
        branchName: "fusion/fn-6226",
      },
    });
  });

  // U6: the coding built-in's pre-merge browser-verification optional-group is
  // default-OFF (the task sets no enabledWorkflowSteps), so it is bypassed — its
  // group node is visited but its body never runs and runWorkflowSteps is not
  // called. Fast mode is irrelevant to a bypassed group; the seam is simply gone.
  it("graph executor with builtin:coding selection bypasses the disabled browser-verification group", async () => {
    const { executor } = makeExecutorForTask(task({ executionMode: "fast", worktree: "/tmp/wt" }));
    const runWorkflowSteps = vi.spyOn(executor as any, "runWorkflowSteps").mockResolvedValue(workflowResult());
    const seams = {
      planning: vi.fn(async () => ({ outcome: "success", value: "planned" })),
      execute: vi.fn(async () => ({ outcome: "success", value: "implemented" })),
      workflowStep: (executor as any).createAuthoritativeWorkflowSeams({}).workflowStep,
      review: vi.fn(async () => ({ outcome: "success", value: "approved" })),
      merge: vi.fn(async () => ({ outcome: "success", value: "merged" })),
      schedule: vi.fn(async () => ({ outcome: "success", value: "scheduled" })),
    };
    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async (id: string) => getBuiltinWorkflow(id)),
      },
      seams,
      runCustomNode: vi.fn(async () => ({ outcome: "failure", value: "unexpected-custom-node" })),
    });

    const result = await runner.run(task({ id: "FN-6226", executionMode: "fast" }), { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toContain("browser-verification");
    expect(result.visitedNodeIds).not.toContain("browser-verification::browser-verification-step");
    expect(result.visitedNodeIds).not.toContain("workflow-step");
    expect(runWorkflowSteps).not.toHaveBeenCalled();
    expect(seams.review).toHaveBeenCalledTimes(1);
    expect(seams.merge).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["standard", "standard"],
    ["undefined", undefined],
    ["null", null],
  ])("runs custom pre-merge prompt nodes in %s execution mode", async (_label, executionMode) => {
    const { executor } = makeExecutorForTask(task({ executionMode, worktree: "/tmp/wt" }));
    const executeStep = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true });

    const result = await (executor as any).runGraphCustomNode(
      { id: "custom-review", kind: "prompt", config: { prompt: "Review this" } },
      task({ executionMode }),
      {},
      undefined,
    );

    expect(result.outcome).toBe("success");
    expect(result.value).toBe("passed");
    expect(executeStep).toHaveBeenCalledTimes(1);
  });

  it.each(["prompt", "script", "gate"])("skips custom %s nodes in fast mode before workflow-step execution", async (kind) => {
    const { executor } = makeExecutorForTask(task({ executionMode: "fast", worktree: "/tmp/wt" }));
    const executeStep = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true });
    const executeScript = vi.spyOn(executor as any, "executeScriptWorkflowStep").mockResolvedValue({ success: true });
    const config = kind === "script" ? { scriptName: "lint" } : { prompt: "check" };

    const result = await (executor as any).runGraphCustomNode(
      { id: `custom-${kind}`, kind, config },
      task({ executionMode: "fast" }),
      {},
      undefined,
    );

    expect(result).toMatchObject({ outcome: "success", value: "workflow-step-skipped" });
    expect(executeStep).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("does not bypass await-input custom graph nodes in fast mode", async () => {
    const { executor } = makeExecutorForTask(task({ executionMode: "fast" }));
    const awaitInput = vi.spyOn(executor as any, "runAwaitInputNode").mockResolvedValue({ outcome: "success", value: "awaiting-input" });

    const result = await (executor as any).runGraphCustomNode(
      { id: "human", kind: "prompt", config: { awaitInput: true } },
      task({ executionMode: "fast" }),
      {},
      undefined,
    );

    expect(result.value).toBe("awaiting-input");
    expect(awaitInput).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["legacy seam", (executor: TaskExecutor, settings: any) => (executor as any).createAuthoritativeWorkflowSeams(settings).workflowStep(task({ id: "FN-6226" }), {})],
    ["graph primitive", (executor: TaskExecutor, settings: any) => (executor as any).createAuthoritativeWorkflowPrimitives(settings).runWorkflowStep(
      { run: { taskId: "FN-6226" }, node: { node: { id: "workflow-step" }, context: {} } },
      task({ id: "FN-6226" }),
      { phase: "pre-merge", worktreePath: "/tmp/wt" },
    )],
  ])("%s skips pre-merge workflow steps in fast mode", async (_label, invoke) => {
    const { executor } = makeExecutorForTask(task({ executionMode: "fast", worktree: "/tmp/wt" }));
    const runWorkflowSteps = vi.spyOn(executor as any, "runWorkflowSteps").mockResolvedValue(workflowResult());

    const result = await invoke(executor, { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.outcome).toBe("success");
    expect(result.value).toBe("workflow-step-skipped");
    expect(runWorkflowSteps).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy seam", (executor: TaskExecutor, settings: any) => (executor as any).createAuthoritativeWorkflowSeams(settings).workflowStep(task({ id: "FN-6226" }), {})],
    ["graph primitive", (executor: TaskExecutor, settings: any) => (executor as any).createAuthoritativeWorkflowPrimitives(settings).runWorkflowStep(
      { run: { taskId: "FN-6226" }, node: { node: { id: "workflow-step" }, context: {} } },
      task({ id: "FN-6226" }),
      { phase: "pre-merge", worktreePath: "/tmp/wt" },
    )],
  ])("%s runs pre-merge workflow steps for standard and default execution modes", async (_label, invoke) => {
    for (const executionMode of ["standard", undefined]) {
      const { executor } = makeExecutorForTask(task({ executionMode, worktree: "/tmp/wt" }));
      const runWorkflowSteps = vi.spyOn(executor as any, "runWorkflowSteps").mockResolvedValue(workflowResult());

      const result = await invoke(executor, { experimentalFeatures: { workflowGraphExecutor: true } });

      expect(result.outcome).toBe("success");
      expect(runWorkflowSteps).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps fn_task_done mandatory while excluding fn_review_step in fast mode", async () => {
    mockedCreateFnAgent.mockImplementation(async (opts: any) => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        sessionManager: {
          getLeafId: vi.fn().mockReturnValue("leaf"),
          branchWithSummary: vi.fn(),
          navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
        },
        navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      },
      capturedTools: opts.customTools,
    }));
    const store = createMockStore();
    store.getTask.mockResolvedValue(task({ id: "FN-TOOLS", executionMode: "fast" }));
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(task({ id: "FN-TOOLS", executionMode: "fast" }));

    const tools = mockedCreateFnAgent.mock.calls[0][0].customTools.map((tool: any) => tool.name);
    expect(tools).toContain("fn_task_done");
    expect(tools).not.toContain("fn_review_step");
  });

  it("includes fn_review_step in standard mode", async () => {
    mockedCreateFnAgent.mockImplementation(async (opts: any) => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        sessionManager: {
          getLeafId: vi.fn().mockReturnValue("leaf"),
          branchWithSummary: vi.fn(),
          navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
        },
        navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      },
      capturedTools: opts.customTools,
    }));
    const store = createMockStore();
    store.getTask.mockResolvedValue(task({ id: "FN-TOOLS", executionMode: "standard" }));
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(task({ id: "FN-TOOLS", executionMode: "standard" }));

    const tools = mockedCreateFnAgent.mock.calls[0][0].customTools.map((tool: any) => tool.name);
    expect(tools).toContain("fn_review_step");
  });
});
