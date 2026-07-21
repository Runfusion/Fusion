// @ts-nocheck
// FN-6226 surface enumeration: engine-only behavior, so desktop/mobile
// breakpoints are N/A. These tests cover legacy seams, graph runtime
// primitives, custom graph prompt/script/gate nodes under a custom workflow
// selection, builtin/default selection behavior via the legacy seam, fast /
// standard / undefined executionMode data states, and the executor tool
// injection surface (fn_review_step is deleted in both modes) vs mandatory fn_task_done.
import { describe, it, expect, vi, beforeEach } from "vitest";
import "./executor-test-helpers.js";
import { getBuiltinWorkflow } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { WorkflowGraphTaskRunner } from "../workflow-graph-task-runner.js";
import { FOREACH_ACTIVE_CONTEXT_KEY } from "../workflow-node-handlers.js";
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

/*
FNXC:EngineTests 2026-07-19-15:05 (U10b):
Review gates are graph nodes, so one `execute()` opens several agent sessions and the FIRST one is a review
node (Plan Review), not the implementation session. The tool-injection requirement spans the whole run:
`fn_task_done` must be present SOMEWHERE (the implementation session must retain the only completion path),
and `fn_review_step` must appear on NO session in either execution mode. Union the tools across every
session instead of indexing call 0, which now inspects a review node's readonly toolset.
*/
function allSessionToolNames(): string[] {
  return mockedCreateFnAgent.mock.calls.flatMap(([opts]: any[]) =>
    ((opts?.customTools ?? []) as any[]).map((tool) => tool?.name),
  );
}

function workflowResult() {
  return { allPassed: true, results: [] };
}

describe("fast mode workflow/runtime invariants", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  /*
  FNXC:WorkflowSelection 2026-07-14-17:06:
  The executor must pass its asynchronously resolved PostgreSQL workflow selection into the graph runner. Re-reading through the synchronous compatibility method would replace a custom graph with builtin:coding.
  */
  /*
  FNXC:EngineTests 2026-07-19-18:20 (U10b):
  Graph ownership is unconditional: the entry point is `executeWorkflowGraph` and it returns void
  because it can no longer decline a task. The requirement under test is unchanged — the async
  selection the executor resolved is what the runner sees — so only the seam name/return moved.
  */
  it("reuses the asynchronous PostgreSQL workflow selection inside the graph runner", async () => {
    const selected = { workflowId: "WF-async-custom", stepIds: ["review"] };
    const { store, executor } = makeExecutorForTask(task());
    store.getTaskWorkflowSelection = vi.fn(() => undefined);
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => selected);
    store.getWorkflowDefinition = vi.fn(async () => ({
      id: selected.workflowId,
      name: "Async custom",
      ir: {
        version: "v1",
        name: "Async custom",
        nodes: [{ id: "start", kind: "start" }, { id: "end", kind: "end" }],
        edges: [{ from: "start", to: "end" }],
      },
    }));
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockImplementation(async function () {
      expect((this as any).deps.store.getTaskWorkflowSelection()).toEqual(selected);
      await expect((this as any).deps.store.getTaskWorkflowSelectionAsync()).resolves.toEqual(selected);
      return { disposition: "completed", outcome: "success", visitedNodeIds: ["start"] };
    });

    try {
      await expect((executor as any).executeWorkflowGraph(task())).resolves.toBeUndefined();

      expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledWith("FN-6226");
      expect(store.getTaskWorkflowSelection).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      // Prototype spy: restore even on failure so it cannot leak into sibling runner tests.
      run.mockRestore();
    }
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

  it("does not project a fresh graph step or capture its baseline before the executor creates its worktree", async () => {
    let liveTask = task({
      steps: [{ name: "Preflight", status: "pending" }],
      worktree: undefined,
      branch: undefined,
      baseCommitSha: undefined,
    });
    const store = createMockStore();
    store.getTask.mockImplementation(async () => liveTask);
    const executor = new TaskExecutor(store, "/tmp/project-root");
    const runGraphTaskStep = vi.spyOn(executor as any, "runGraphTaskStep").mockImplementation(async () => {
      expect(store.updateStep).not.toHaveBeenCalled();
      liveTask = {
        ...liveTask,
        worktree: "/tmp/project-root/.worktrees/fresh-step",
        branch: "fusion/fn-6226",
        baseCommitSha: "fresh-worktree-base",
        steps: [{ name: "Preflight", status: "done" }],
      };
      return { success: true };
    });

    const result = await (executor as any)
      .createAuthoritativeWorkflowPrimitives({ experimentalFeatures: { workflowGraphExecutor: true } })
      .runTaskStep(
        {
          run: { taskId: liveTask.id },
          node: {
            node: { id: "steps#0:step-execute" },
            context: {
              [FOREACH_ACTIVE_CONTEXT_KEY]: {
                foreachNodeId: "steps",
                stepIndex: 0,
                instanceId: "steps#0",
              },
            },
          },
        },
        liveTask,
        0,
      );

    expect(runGraphTaskStep).toHaveBeenCalledTimes(1);
    expect(store.updateStep).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: "success",
      baselineSha: "fresh-worktree-base",
      checkpointId: undefined,
    });
  });

  it("applies fresh-worktree step ordering through the legacy graph seam", async () => {
    let liveTask = task({
      steps: [{ name: "Preflight", status: "pending" }],
      worktree: undefined,
      baseCommitSha: undefined,
    });
    const store = createMockStore();
    store.getTask.mockImplementation(async () => liveTask);
    const executor = new TaskExecutor(store, "/tmp/project-root");
    vi.spyOn(executor as any, "runGraphTaskStep").mockImplementation(async () => {
      expect(store.updateStep).not.toHaveBeenCalled();
      liveTask = {
        ...liveTask,
        worktree: "/tmp/project-root/.worktrees/fresh-step",
        baseCommitSha: "fresh-worktree-base",
        steps: [{ name: "Preflight", status: "done" }],
      };
      return { success: true };
    });
    const active = {
      foreachNodeId: "steps",
      stepIndex: 0,
      instanceId: "steps#0",
    };

    const result = await executor.createAuthoritativeWorkflowSeams({} as any).stepExecute?.(
      liveTask,
      { [FOREACH_ACTIVE_CONTEXT_KEY]: active },
    );

    expect(store.updateStep).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "success",
      contextPatch: {
        [FOREACH_ACTIVE_CONTEXT_KEY]: {
          baselineSha: "fresh-worktree-base",
          checkpointId: undefined,
        },
      },
    });
  });

  it("fast builtin:coding still parses and executes steps while disabled optional groups stay inert", async () => {
    const calls: string[] = [];
    const prompt = "# Task\n\n## Steps\n\n### Step 1: Do the work\n- [ ] edit files";
    const taskSteps = [{ name: "Do the work", status: "pending" }];
    const seams = {
      planning: vi.fn(async () => {
        calls.push("plan");
        return { outcome: "success", value: "planned" };
      }),
      execute: vi.fn(async () => {
        calls.push("legacy-execute");
        return { outcome: "success", value: "implemented" };
      }),
      review: vi.fn(async () => {
        calls.push("review");
        return { outcome: "success", value: "approved" };
      }),
      merge: vi.fn(async () => {
        calls.push("merge");
        return { outcome: "success", value: "merged" };
      }),
      schedule: vi.fn(async () => ({ outcome: "success", value: "scheduled" })),
      stepExecute: vi.fn(async (_task, context) => {
        calls.push(`step-execute:${context["foreach:active"]?.stepIndex}`);
        return { outcome: "success", value: "step-done" };
      }),
    };
    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async (id: string) => getBuiltinWorkflow(id)),
      },
      seams,
      parseStepsDeps: {
        readArtifact: async (_target, key) => key === "PROMPT.md" ? prompt : undefined,
        writeSteps: async (target) => {
          calls.push("parse");
          target.steps = taskSteps;
        },
      },
      runCustomNode: vi.fn(async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success", value: "custom-ok" };
      }),
    });

    const result = await runner.run(task({
      id: "FN-6226",
      executionMode: "fast",
      enabledWorkflowSteps: [],
      prompt,
    }), { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toContain("parse");
    expect(result.visitedNodeIds).toContain("steps#0:step-execute");
    expect(result.visitedNodeIds).toContain("browser-verification");
    expect(result.visitedNodeIds).not.toContain("browser-verification::browser-verification-step");
    expect(result.visitedNodeIds).toContain("code-review");
    expect(result.visitedNodeIds).not.toContain("code-review::code-review-step");
    expect(result.visitedNodeIds).not.toContain("workflow-step");
    expect(calls).toContain("parse");
    expect(calls).toContain("step-execute:0");
    expect(calls).not.toContain("legacy-execute");
    /*
    FNXC:WorkflowFastMode 2026-07-01-00:00:
    The default built-in now resolves to the stepwise final-review workflow. In raw fast-mode compatibility runs, default-on review groups are skipped as custom nodes and the legacy review seam is not invoked; the merge seam remains the lifecycle suffix assertion.
    */
    expect(seams.review).not.toHaveBeenCalled();
    expect(seams.merge).toHaveBeenCalledTimes(1);
  });

  it("raw fast mode skips skill executor nodes when primitives are unavailable", async () => {
    const runCustomNode = vi.fn(async () => ({ outcome: "success", value: "ran-skill" }));
    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-fast-skill", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async () => ({
          id: "WF-fast-skill",
          name: "Fast skill",
          description: "custom skill workflow",
          kind: "workflow",
          layout: {},
          createdAt: now,
          updatedAt: now,
          ir: {
            version: "v1",
            name: "Fast skill",
            nodes: [
              { id: "start", kind: "start" },
              { id: "skill-review", kind: "prompt", config: { executor: "skill", skillName: "compound-engineering:ce-code-review" } },
              { id: "end", kind: "end" },
            ],
            edges: [
              { from: "start", to: "skill-review" },
              { from: "skill-review", to: "end", condition: "success" },
            ],
          },
        })),
      },
      seams: {
        planning: vi.fn(async () => ({ outcome: "success", value: "planned" })),
        execute: vi.fn(async () => ({ outcome: "success", value: "implemented" })),
        review: vi.fn(async () => ({ outcome: "success", value: "approved" })),
        merge: vi.fn(async () => ({ outcome: "success", value: "merged" })),
        schedule: vi.fn(async () => ({ outcome: "success", value: "scheduled" })),
      },
      runCustomNode,
    });

    const result = await runner.run(task({ executionMode: "fast" }), { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toEqual(["start", "skill-review"]);
    expect(runCustomNode).not.toHaveBeenCalled();
  });

  it("raw fast mode still invokes non-executable review seam nodes", async () => {
    const review = vi.fn(async () => ({ outcome: "success" as const, value: "approved" }));
    const runCustomNode = vi.fn(async () => ({ outcome: "failure" as const, value: "unexpected-custom-node" }));
    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-fast-review-seam", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async () => ({
          id: "WF-fast-review-seam",
          name: "Fast review seam",
          description: "custom review seam workflow",
          kind: "workflow",
          layout: {},
          createdAt: now,
          updatedAt: now,
          ir: {
            version: "v1",
            name: "Fast review seam",
            nodes: [
              { id: "start", kind: "start" },
              { id: "review", kind: "prompt", config: { seam: "review" } },
              { id: "end", kind: "end" },
            ],
            edges: [
              { from: "start", to: "review" },
              { from: "review", to: "end", condition: "success" },
            ],
          },
        })),
      },
      seams: {
        planning: vi.fn(async () => ({ outcome: "success", value: "planned" })),
        execute: vi.fn(async () => ({ outcome: "success", value: "implemented" })),
        review,
        merge: vi.fn(async () => ({ outcome: "success", value: "merged" })),
        schedule: vi.fn(async () => ({ outcome: "success", value: "scheduled" })),
      },
      runCustomNode,
    });

    const result = await runner.run(task({ executionMode: "fast" }), { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toEqual(["start", "review"]);
    expect(review).toHaveBeenCalledTimes(1);
    expect(runCustomNode).not.toHaveBeenCalled();
  });

  it("fast builtin:coding executes explicitly selected optional-group template nodes", async () => {
    const calls: string[] = [];
    const prompt = "# Task\n\n## Steps\n\n### Step 1: Do the work\n- [ ] edit files";
    const taskSteps = [{ name: "Do the work", status: "pending" }];
    const seams = {
      planning: vi.fn(async () => ({ outcome: "success", value: "planned" })),
      execute: vi.fn(async () => ({ outcome: "success", value: "implemented" })),
      review: vi.fn(async () => ({ outcome: "success", value: "approved" })),
      merge: vi.fn(async () => ({ outcome: "success", value: "merged" })),
      schedule: vi.fn(async () => ({ outcome: "success", value: "scheduled" })),
      stepExecute: vi.fn(async () => ({ outcome: "success", value: "step-done" })),
    };
    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async (id: string) => getBuiltinWorkflow(id)),
      },
      seams,
      parseStepsDeps: {
        readArtifact: async (_target, key) => key === "PROMPT.md" ? prompt : undefined,
        writeSteps: async (target) => {
          target.steps = taskSteps;
        },
      },
      runCustomNode: vi.fn(async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success", value: "APPROVE" };
      }),
    });

    const result = await runner.run(task({
      id: "FN-7283",
      executionMode: "fast",
      enabledWorkflowSteps: ["browser-verification"],
      prompt,
    }), { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toContain("browser-verification::browser-verification-step");
    expect(calls).toContain("custom:browser-verification-step");
    expect(result.visitedNodeIds).toContain("code-review");
    expect(result.visitedNodeIds).not.toContain("code-review::code-review-step");
  });

  it("blocks fast builtin:coding merge when parsed implementation proof is missing", async () => {
    const liveTask = task({
      id: "FN-7271",
      executionMode: "fast",
      enabledWorkflowSteps: [],
      column: "in-progress",
      steps: [],
      prompt: "# Task\n\n## Steps\n\n### Step 1: Do the work\n- [ ] edit files",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(liveTask);
    store.getTaskWorkflowSelection = vi.fn(() => ({ workflowId: "builtin:coding", stepIds: [] }));
    store.getWorkflowDefinition = vi.fn(async (id: string) => getBuiltinWorkflow(id));
    store.moveTask.mockResolvedValue({ ...liveTask, column: "in-review" });
    const executor = new TaskExecutor(store, "/tmp/test") as any;
    const mergeRequester = vi.fn(async () => ({ merged: true }));
    executor.setMergeRequester(mergeRequester);

    const result = await executor.createAuthoritativeWorkflowPrimitives({ autoMerge: true }).requestMerge(
      {
        run: { runId: "FN-7271:builtin:coding", taskId: "FN-7271", workflowId: "builtin-stepwise-final-review-coding" },
        node: { node: { id: "merge" } },
      },
      liveTask,
    );

    expect(result).toMatchObject({
      outcome: "failure",
      value: "implementation-incomplete",
      data: { reason: "implementation-incomplete" },
    });
    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7271",
      expect.stringContaining("Workflow merge blocked before requester: implementation did not run"),
      undefined,
      undefined,
    );
  });


  it("allows noCommitsExpected builtin:coding merge even when parsed implementation steps are empty", async () => {
    const liveTask = task({
      id: "FN-1165-NOOP",
      executionMode: "fast",
      enabledWorkflowSteps: [],
      column: "in-progress",
      steps: [],
      noCommitsExpected: true,
      branch: null,
      worktree: null,
      prompt: "# Task\n\n## Steps\n\n### Step 1: Decide\n- [ ] Record no-code decision",
    });
    const inReviewTask = { ...liveTask, column: "in-review" } as typeof liveTask;
    const doneTask = {
      ...liveTask,
      column: "done",
      mergeDetails: {
        mergeConfirmed: true,
        noOpMerge: true,
        noOpReason: "no-commits-expected",
      },
    } as typeof liveTask;
    const store = createMockStore();
    store.getTask.mockResolvedValue(liveTask);
    store.getTaskWorkflowSelection = vi.fn(() => ({ workflowId: "builtin:coding", stepIds: [] }));
    store.getWorkflowDefinition = vi.fn(async (id: string) => getBuiltinWorkflow(id));
    store.moveTask
      .mockResolvedValueOnce(inReviewTask)
      .mockResolvedValueOnce(doneTask);
    const executor = new TaskExecutor(store, "/tmp/test") as any;
    const mergeRequester = vi.fn(async () => ({
      task: inReviewTask,
      merged: true,
      noOp: true,
      mergeConfirmed: true,
      reason: "no-commits-expected",
    }));
    executor.setMergeRequester(mergeRequester);

    const result = await executor.createAuthoritativeWorkflowPrimitives({ autoMerge: true }).requestMerge(
      {
        run: { runId: "FN-1165-NOOP:builtin:coding", taskId: "FN-1165-NOOP", workflowId: "builtin-stepwise-final-review-coding" },
        node: { node: { id: "merge" } },
      },
      liveTask,
    );

    expect(result).toMatchObject({ outcome: "success", value: "merge-noop" });
    expect(mergeRequester).toHaveBeenCalledWith("FN-1165-NOOP", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-1165-NOOP",
      expect.stringContaining("implementation did not run"),
      undefined,
      undefined,
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-1165-NOOP", "done", expect.objectContaining({ preserveProgress: true }));
  });

  it("fast builtin:coding executes plain Steps-section headings from fast triage specs", async () => {
    const calls: string[] = [];
    const prompt = `# Task

## Steps

### Preflight
- [ ] inspect

### Implementation
- [ ] edit

### Testing & Verification
- [ ] test
`;
    const seams = {
      planning: vi.fn(async () => ({ outcome: "success", value: "planned" })),
      execute: vi.fn(async () => ({ outcome: "success", value: "implemented" })),
      review: vi.fn(async () => ({ outcome: "success", value: "approved" })),
      merge: vi.fn(async () => ({ outcome: "success", value: "merged" })),
      schedule: vi.fn(async () => ({ outcome: "success", value: "scheduled" })),
      stepExecute: vi.fn(async (_task, context) => {
        calls.push(`step-execute:${context["foreach:active"]?.stepIndex}`);
        return { outcome: "success", value: "step-done" };
      }),
    };
    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async (id: string) => getBuiltinWorkflow(id)),
      },
      seams,
      parseStepsDeps: {
        readArtifact: async (_target, key) => key === "PROMPT.md" ? prompt : undefined,
        writeSteps: async (target, steps) => {
          target.steps = steps;
        },
      },
      runCustomNode: vi.fn(async () => ({ outcome: "success" })),
    });

    const result = await runner.run(task({
      id: "FN-7260",
      executionMode: "fast",
      enabledWorkflowSteps: [],
      prompt,
    }), { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toContain("steps#0:step-execute");
    expect(result.visitedNodeIds).toContain("steps#1:step-execute");
    expect(result.visitedNodeIds).toContain("steps#2:step-execute");
    expect(calls).toEqual(["step-execute:0", "step-execute:1", "step-execute:2"]);
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

  it.each([
    ["completion-summary id", { id: "completion-summary", kind: "prompt", config: { prompt: "summarize" } }],
    ["summaryTarget task", { id: "custom-summary", kind: "prompt", config: { prompt: "summarize", summaryTarget: "task" } }],
  ])("does not skip completion summary nodes in fast mode by %s", async (_label, node) => {
    const { executor } = makeExecutorForTask(task({ executionMode: "fast", worktree: "/tmp/wt" }));
    const executeStep = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "Done." });

    const result = await (executor as any).runGraphCustomNode(
      node,
      task({ executionMode: "fast" }),
      {},
      undefined,
    );

    expect(result).toMatchObject({ outcome: "success", value: "passed" });
    expect(executeStep).toHaveBeenCalledTimes(1);
  });

  it.each(["prompt", "script", "gate"])("executes optional-group template %s nodes in fast mode", async (kind) => {
    const { executor } = makeExecutorForTask(task({ executionMode: "fast", worktree: "/tmp/wt" }));
    const executeStep = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true });
    const executeScript = vi.spyOn(executor as any, "executeScriptWorkflowStep").mockResolvedValue({ success: true });
    const config = kind === "script" ? { scriptName: "lint" } : { prompt: "check" };

    const result = await (executor as any).runGraphCustomNode(
      { id: `custom-${kind}`, kind, config },
      task({ executionMode: "fast" }),
      {},
      undefined,
      { "workflow:optionalGroupActive": "browser-verification" },
    );

    expect(result).toMatchObject({ outcome: "success" });
    if (kind === "script") {
      expect(executeScript).toHaveBeenCalledTimes(1);
      expect(executeStep).not.toHaveBeenCalled();
    } else {
      expect(executeStep).toHaveBeenCalledTimes(1);
      expect(executeScript).not.toHaveBeenCalled();
    }
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

  // U4 (KTD-2): the legacy `workflow-step` seam and `runWorkflowStep` primitive
  // were removed, so the two it.each blocks that drove them directly (fast-mode
  // skip + standard-mode run) are gone. Fast-mode skip of workflow gates is now
  // covered above by the custom-node tests ("skips custom %s nodes in fast mode")
  // and by builtin-coding-workflow-step-results.test.ts (graph recording path).

  it("re-enters graph recovery for fast completed tasks with unsatisfied explicit optional steps", async () => {
    const liveTask = task({
      id: "FN-7283-RECOVERY",
      executionMode: "fast",
      enabledWorkflowSteps: ["browser-verification"],
      worktree: "/tmp/wt",
      baseCommitSha: "base",
      steps: [{ name: "Do it", status: "done" }],
      workflowStepResults: [],
    });
    const { executor } = makeExecutorForTask(liveTask);
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue([]);
    const graph = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    const recovered = await executor.recoverCompletedTask(liveTask as any);

    expect(recovered).toBe(true);
    expect(graph).toHaveBeenCalledWith(liveTask);
  });

  /*
  FNXC:EngineTests 2026-07-19-18:20 (U10b):
  The requirement under test is a store that CANNOT resolve a workflow selection (minimal/older embedded
  adapters). The shared harness supplies both selection readers, so the reader-less shape is reconstructed
  explicitly here — otherwise the graph resolves builtin:coding and this branch is never reached.
  The park is now UNCONDITIONAL: with the legacy execute fallback deleted, the graph is the only executor,
  so a store that cannot resolve a workflow must park loudly whether or not the task has explicit
  `enabledWorkflowSteps` — the old "no enabled steps means nothing to gate" carve-out would now silently run
  nothing. Both step shapes are asserted so the carve-out cannot be reintroduced.
  */
  it.each([
    ["explicit optional steps", ["browser-verification"]],
    ["no enabled steps", []],
  ])("fails closed when the store cannot resolve workflow selection (%s)", async (_label, enabledWorkflowSteps) => {
    const liveTask = task({
      id: "FN-7283-MINIMAL-STORE",
      executionMode: "fast",
      enabledWorkflowSteps,
      worktree: "/tmp/wt",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(liveTask);
    delete (store as any).getTaskWorkflowSelection;
    delete (store as any).getTaskWorkflowSelectionAsync;
    const executor = new TaskExecutor(store, "/tmp/test") as any;
    const graphFailure = vi.spyOn(executor, "handleGraphFailure").mockResolvedValue(undefined);

    await executor.executeWorkflowGraph(liveTask);

    expect(graphFailure).toHaveBeenCalledWith(liveTask, expect.objectContaining({
      disposition: "failed",
      outcome: "failure",
      reason: expect.stringContaining("workflow-selection-api-unavailable"),
    }));
  });

  it("skips graph recovery for fast completed tasks with no explicit optional steps", async () => {
    const liveTask = task({
      id: "FN-7283-RECOVERY-EMPTY",
      executionMode: "fast",
      enabledWorkflowSteps: [],
      worktree: "/tmp/wt",
      baseCommitSha: "base",
      steps: [{ name: "Do it", status: "done" }],
      workflowStepResults: [],
    });
    const { store, executor } = makeExecutorForTask(liveTask);
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue([]);
    const graph = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    const recovered = await executor.recoverCompletedTask(liveTask as any);

    expect(recovered).toBe(true);
    expect(graph).not.toHaveBeenCalled();
    expect(store.handoffToReview).toHaveBeenCalledWith(
      "FN-7283-RECOVERY-EMPTY",
      expect.objectContaining({ evidence: expect.objectContaining({ reason: "completed-task-recovered" }) }),
    );
  });

  /*
  FNXC:WorkflowReviewGates 2026-07-19-02:40:
  U10 (R9) tombstone: `fn_review_step` is deleted outright. Neither fast nor standard mode may
  inject it — review gates are graph nodes, and a second in-session review authority is exactly
  the duplicate-Plan-Review defect the cutover removes. `fn_task_done` stays mandatory in both.
  */
  it("keeps fn_task_done mandatory while never injecting fn_review_step in fast mode", async () => {
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

    expect(allSessionToolNames()).toContain("fn_task_done");
    expect(allSessionToolNames()).not.toContain("fn_review_step");
  });

  it("never injects fn_review_step in standard mode either", async () => {
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

    expect(allSessionToolNames()).toContain("fn_task_done");
    expect(allSessionToolNames()).not.toContain("fn_review_step");
  });

});
