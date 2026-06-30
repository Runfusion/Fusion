import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskDetail, WorkflowIr, WorkflowWorkItem, WorkflowWorkItemState } from "@fusion/core";

import { WorkflowTaskRuntime, type WorkflowTaskRuntimeDeps } from "../workflow-task-runtime.js";
import type { WorkflowNodeResult } from "../workflow-graph-executor.js";
import type { PreparedWorktree, WorkflowRuntimePrimitives } from "../runtime-primitives.js";

const task = { id: "FN-9002" } as TaskDetail;
const flagOff = { experimentalFeatures: {} } as unknown as Pick<Settings, "experimentalFeatures">;
const promptWithOneStep = "# Task: FN-9002 - Runtime default\n\n## Steps\n\n### Step 1: Implement runtime default\n- Exercise the default workflow.\n";

const parseStepsDeps = {
  readArtifact: async (_task: TaskDetail, key: string) => key === "PROMPT.md" ? promptWithOneStep : undefined,
  writeSteps: async (target: TaskDetail, steps: TaskDetail["steps"]) => {
    target.steps = steps;
  },
};

function selectedIr(): WorkflowIr {
  return {
    version: "v1",
    name: "selected",
    nodes: [
      { id: "start", kind: "start" },
      { id: "prepare", kind: "prompt", config: { prompt: "prepare" } },
      { id: "execute", kind: "prompt", config: { seam: "execute" } },
      { id: "zend", kind: "end" },
    ],
    edges: [
      { from: "start", to: "prepare", condition: "success" },
      { from: "prepare", to: "execute", condition: "success" },
      { from: "execute", to: "zend", condition: "success" },
      { from: "execute", to: "zend", condition: "failure" },
    ],
  };
}

function recordingPrimitives(
  calls: string[],
  overrides: Partial<Record<"prepare" | "execute" | "workflowStep", WorkflowNodeResult>> & {
    prepareData?: PreparedWorktree | null;
  } = {},
  observed: {
    prepared?: PreparedWorktree;
    executedTasks?: TaskDetail[];
    stepTasks?: TaskDetail[];
    mergeAttempt?: number;
    mergeRunId?: string;
    mergeWorkflowId?: string;
  } = {},
): WorkflowRuntimePrimitives {
  const prepared: PreparedWorktree = { worktreePath: "/tmp/fusion-worktree" };
  return {
    prepareWorktree: async () => {
      calls.push("prepare-worktree");
      return {
        outcome: overrides.prepare?.outcome ?? "success",
        value: overrides.prepare?.value,
        contextPatch: overrides.prepare?.contextPatch,
        data: overrides.prepare?.outcome === "failure"
          ? undefined
          : overrides.prepareData === null
            ? undefined
            : overrides.prepareData ?? prepared,
      };
    },
    readArtifact: async (_ctx, _task, key) => key === "PROMPT.md" ? promptWithOneStep : undefined,
    writeArtifact: async (_ctx, _task, key) => ({ outcome: "success", data: { key } }),
    runPlanningSession: async () => {
      calls.push("planning");
      return { outcome: "success", data: { approved: true, artifactKeys: [] } };
    },
    runCodingSession: async (_ctx, _task, preparedWorktree) => {
      calls.push("execute");
      observed.prepared = preparedWorktree;
      observed.executedTasks?.push(_task);
      const override = overrides.execute;
      return {
        outcome: override?.outcome ?? "success",
        value: override?.value ?? "implemented",
        contextPatch: override?.contextPatch,
        data: { taskDone: override?.outcome !== "failure", modifiedFiles: [] },
      };
    },
    runTaskStep: async (_ctx, _task, stepIndex) => {
      calls.push(`step:${stepIndex}`);
      observed.stepTasks?.push(_task);
      observed.executedTasks?.push(_task);
      return { outcome: "success" };
    },
    resetTaskStep: async () => ({ ok: true }),
    runReview: async (_ctx, _task, input) => {
      calls.push(input.stepIndex === undefined ? "review" : "step-review");
      return {
        outcome: "success",
        value: input.stepIndex === undefined ? "in-review" : "approve",
        data: { verdict: "APPROVE" },
      };
    },
    runVerification: async () => ({ outcome: "success", data: { verdict: "skipped" } }),
    runWorkflowStep: async () => {
      calls.push("workflow-step");
      const override = overrides.workflowStep;
      return {
        outcome: override?.outcome ?? "success",
        value: override?.value ?? "workflow-steps-passed",
        contextPatch: override?.contextPatch,
        data: { allPassed: override?.value !== "remediation-scheduled" },
      };
    },
    updateSteps: async (_ctx, _task, steps) => {
      _task.steps = steps;
      return { outcome: "success", data: { count: steps.length } };
    },
    transitionTask: async () => {
      calls.push("schedule");
      return { outcome: "success" };
    },
    requestMerge: async (ctx) => {
      calls.push("merge");
      observed.mergeAttempt = ctx.node.attempt;
      observed.mergeRunId = ctx.run.runId;
      observed.mergeWorkflowId = ctx.run.workflowId;
      return { outcome: "success", value: "merged", data: { status: "merged" } };
    },
    abortRun: async () => ({ outcome: "success" }),
    audit: () => undefined,
  };
}

describe("WorkflowTaskRuntime", () => {
  it("requires execution wiring at the type boundary", () => {
    // @ts-expect-error WorkflowTaskRuntime is an execution entry point, so primitives are required.
    const missingPrimitives: WorkflowTaskRuntimeDeps = {
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        getTaskDocument: async (_taskId, key) => key === "PROMPT.md" ? { key } : null,
      },
      runCustomNode: async () => ({ outcome: "success" }),
    };
    expect(missingPrimitives).toBeDefined();
  });

  it("runs a selected workflow through the graph engine", async () => {
    const calls: string[] = [];
    const observed: { prepared?: PreparedWorktree } = {};
    let workflowSelectionReads = 0;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => {
          workflowSelectionReads += 1;
          return { workflowId: "WF-001", stepIds: [] };
        },
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives(
        calls,
        {
          prepare: { outcome: "success", contextPatch: { preparedKey: "from-prepare" } },
          execute: { outcome: "success", contextPatch: { executeKey: "from-execute" } },
        },
        observed,
      ),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      parseStepsDeps,
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["custom:prepare", "prepare-worktree", "execute"]);
    expect(result.visitedNodeIds).toEqual(["start", "prepare", "execute"]);
    expect(observed.prepared).toEqual({ worktreePath: "/tmp/fusion-worktree" });
    expect(result.context.preparedKey).toBe("from-prepare");
    expect(result.context.executeKey).toBe("from-execute");
    expect(workflowSelectionReads).toBe(1);
  });

  it("records a completion summary when a workflow run completes without fn_task_done", async () => {
    const updates: Array<{ taskId: string; summary: string }> = [];
    const logs: Array<{ taskId: string; action: string; detail?: string }> = [];
    const completedTask = {
      ...task,
      title: "Ship workflow summaries",
      steps: [
        { title: "Implement summary persistence", status: "done" },
        { title: "Verify workflow completion", status: "done" },
      ],
      modifiedFiles: ["packages/engine/src/workflow-task-runtime.ts"],
    } as TaskDetail;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => completedTask,
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        updateTask: async (taskId, update) => {
          updates.push({ taskId, summary: update.summary });
        },
        logEntry: async (taskId, action, detail) => {
          logs.push({ taskId, action, detail });
        },
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      parseStepsDeps,
    });

    const result = await runtime.run(completedTask, flagOff);

    expect(result.disposition).toBe("completed");
    expect(updates).toEqual([
      {
        taskId: task.id,
        summary: expect.stringContaining("Workflow completed: Ship workflow summaries."),
      },
    ]);
    expect(updates[0]?.summary).toContain("Completed 2/2 task steps.");
    expect(updates[0]?.summary).toContain("Changed files: packages/engine/src/workflow-task-runtime.ts.");
    expect(logs).toEqual([
      expect.objectContaining({ taskId: task.id, action: "Workflow completion summary recorded" }),
    ]);
  });

  it("preserves an existing workflow completion summary", async () => {
    const updateTask = vi.fn();
    const summarizedTask = { ...task, summary: "Agent-authored completion summary." } as TaskDetail;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => summarizedTask,
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        updateTask,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      parseStepsDeps,
    });

    const result = await runtime.run(summarizedTask, flagOff);

    expect(result.disposition).toBe("completed");
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("preserves attachments through selected workflow execution", async () => {
    const calls: string[] = [];
    const attachments = [
      {
        filename: "abc-shot.png",
        originalName: "shot.png",
        mimeType: "image/png",
        size: 1024,
        createdAt: new Date().toISOString(),
      },
      {
        filename: "def-context.txt",
        originalName: "context.txt",
        mimeType: "text/plain",
        size: 256,
        createdAt: new Date().toISOString(),
      },
    ];
    const attachmentTask = { ...task, attachments } as TaskDetail;
    const observed: { executedTasks: TaskDetail[] } = { executedTasks: [] };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives(calls, undefined, observed),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      parseStepsDeps,
    });

    const result = await runtime.run(attachmentTask, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["custom:prepare", "prepare-worktree", "execute"]);
    expect(observed.executedTasks).toHaveLength(1);
    expect(observed.executedTasks[0]?.attachments).toEqual(attachments);
  });

  it("preserves attachments through built-in workflow execution", async () => {
    const calls: string[] = [];
    const attachments = [
      {
        filename: "abc-shot.png",
        originalName: "shot.png",
        mimeType: "image/png",
        size: 1024,
        createdAt: new Date().toISOString(),
      },
    ];
    const attachmentTask = { ...task, attachments } as TaskDetail;
    const observed: { executedTasks: TaskDetail[] } = { executedTasks: [] };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        getTaskDocument: async (_taskId, key) => key === "PROMPT.md" ? { key } : null,
      },
      primitives: recordingPrimitives(calls, undefined, observed),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      parseStepsDeps,
    });

    const result = await runtime.run(attachmentTask, flagOff);

    expect(result.disposition).toBe("completed");
    // Default Coding is stepwise: planning writes PROMPT.md, parse projects steps,
    // then foreach runs `runTaskStep` before merge. No legacy execute/review seam.
    expect(calls).toEqual(["planning", "custom:plan-review-step", "step:0", "custom:code-review-step", "custom:completion-summary", "merge"]);
    expect(observed.executedTasks).toHaveLength(1);
    expect(observed.executedTasks[0]?.attachments).toEqual(attachments);
  });

  it("passes undefined attachments through built-in workflow execution when absent", async () => {
    const observed: { executedTasks: TaskDetail[] } = { executedTasks: [] };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        getTaskDocument: async (_taskId, key) => key === "PROMPT.md" ? { key } : null,
      },
      primitives: recordingPrimitives([], undefined, observed),
      runCustomNode: async () => ({ outcome: "success" }),
      parseStepsDeps,
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("completed");
    expect(observed.executedTasks).toHaveLength(1);
    expect(observed.executedTasks[0]?.attachments).toBeUndefined();
  });

  it("fails execute instead of skipping coding when prepare succeeds without worktree data", async () => {
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives(calls, {
        prepare: { outcome: "success", value: "prepared-without-data" },
        prepareData: null,
      }),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(calls).toEqual(["custom:prepare", "prepare-worktree"]);
    expect(result.visitedNodeIds).toEqual(["start", "prepare", "execute"]);
  });

  it("resolves an unselected task to the built-in coding workflow instead of falling back", async () => {
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        getTaskDocument: async (_taskId, key) => key === "PROMPT.md" ? { key } : null,
      },
      primitives: recordingPrimitives(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      parseStepsDeps,
    });

    const defaultTask = { ...task, enabledWorkflowSteps: ["plan-review", "code-review"] } as TaskDetail;
    const result = await runtime.run(defaultTask, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["planning", "custom:plan-review-step", "step:0", "custom:code-review-step", "custom:completion-summary", "merge"]);
    expect(result.visitedNodeIds).toContain("plan");
    expect(result.visitedNodeIds).toContain("plan-review");
    expect(result.visitedNodeIds).toContain("parse");
    expect(result.visitedNodeIds).toContain("steps");
    expect(result.visitedNodeIds).toContain("code-review");
    expect(result.visitedNodeIds).not.toContain("execute");
    expect(result.visitedNodeIds).not.toContain("review");
  });

  it("runs the pre-merge browser-verification optional-group once when enabled, before review", async () => {
    // U6: replaces the prior workflow-step-remediation test. With the group ENABLED
    // (task.enabledWorkflowSteps includes "browser-verification"), the inner
    // browser-verification-step prompt node runs once pre-merge, recorded as a
    // custom-node call; the group then routes success → review → merge.
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        getTaskDocument: async (_taskId, key) => key === "PROMPT.md" ? { key } : null,
      },
      primitives: recordingPrimitives(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      parseStepsDeps,
    });

    const enabledTask = { ...task, enabledWorkflowSteps: ["plan-review", "browser-verification", "code-review"] } as TaskDetail;
    const result = await runtime.run(enabledTask, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual([
      "planning",
      "custom:plan-review-step",
      "step:0",
      "custom:browser-verification-step",
      "custom:code-review-step",
      "custom:completion-summary",
      "merge",
    ]);
    expect(result.visitedNodeIds).toContain("plan-review::plan-review-step");
    expect(result.visitedNodeIds).toContain("browser-verification::browser-verification-step");
    expect(result.visitedNodeIds).toContain("code-review::code-review-step");
    expect(result.visitedNodeIds).not.toContain("execute");
    expect(result.visitedNodeIds).not.toContain("review");
  });

  it("fails selected workflow lookup misses instead of running the built-in workflow", async () => {
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-MISSING", stepIds: [] }),
        getWorkflowDefinition: async () => undefined,
      },
      primitives: recordingPrimitives(calls),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toContain("workflow-resolution-error: workflow-missing: WF-MISSING");
    expect(calls).toEqual([]);
  });

  it("fails corrupt selected workflow definitions instead of running the built-in workflow", async () => {
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-CORRUPT", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: "not a workflow ir" }),
      },
      primitives: recordingPrimitives(calls),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toContain("workflow-resolution-error:");
    expect(calls).toEqual([]);
  });

  it("forces only the graph executor flag while preserving other settings", async () => {
    let observedSettings: Pick<Settings, "experimentalFeatures"> | undefined;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      handlers: {
        prompt: async (_node, context) => {
          observedSettings = context.settings;
          return { outcome: "success" };
        },
      },
    });
    const settings = {
      experimentalFeatures: { workflowColumns: true },
      testMode: true,
    } as unknown as Settings;

    const result = await runtime.run(task, settings);

    expect(result.disposition).toBe("completed");
    expect(observedSettings?.experimentalFeatures?.workflowGraphExecutor).toBeUndefined();
    expect(observedSettings?.experimentalFeatures?.workflowColumns).toBe(true);
    expect((observedSettings as Settings | undefined)?.testMode).toBe(true);
  });

  it("uses a workflow-specific default run id", async () => {
    const observedRunIds: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      parseStepsDeps,
      branchPersistence: {
        loadBranchStates: (_taskId, runId) => {
          observedRunIds.push(runId);
          return [];
        },
      },
    });

    await runtime.run(task, flagOff);

    expect(observedRunIds).toContain("FN-9002:WF-001");
  });

  it("runs a leased workflow work item at its addressed node and persists success", async () => {
    const calls: string[] = [];
    const transitions: Array<{ id: string; state: WorkflowWorkItemState; patch?: Record<string, unknown> }> = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => task,
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        transitionWorkflowWorkItem: (id, state, patch) => {
          transitions.push({ id, state, patch });
          return { ...workItem, state };
        },
      },
      primitives: recordingPrimitives(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });
    const workItem = {
      id: "work-1",
      runId: "run-1",
      taskId: task.id,
      nodeId: "execute",
      kind: "task",
      state: "running",
      attempt: 0,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;

    const result = await runtime.runWorkItem(workItem, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["prepare-worktree", "execute"]);
    expect(result.visitedNodeIds).toEqual(["execute"]);
    expect(transitions).toEqual([
      {
        id: "work-1",
        state: "succeeded",
        patch: { leaseOwner: null, leaseExpiresAt: null, lastError: null },
      },
    ]);
  });

  it("fails and releases a workflow work item when the addressed node fails", async () => {
    const transitions: Array<{ id: string; state: WorkflowWorkItemState; patch?: Record<string, unknown> }> = [];
    const workItem = {
      id: "work-2",
      runId: "run-1",
      taskId: task.id,
      nodeId: "execute",
      kind: "task",
      state: "running",
      attempt: 0,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => task,
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        transitionWorkflowWorkItem: (id, state, patch) => {
          transitions.push({ id, state, patch });
          return { ...workItem, state };
        },
      },
      primitives: recordingPrimitives([], { execute: { outcome: "failure", value: "implementation-incomplete" } }),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.runWorkItem(workItem, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toBe("implementation-incomplete");
    expect(transitions).toEqual([
      {
        id: "work-2",
        state: "failed",
        patch: { leaseOwner: null, leaseExpiresAt: null, lastError: "implementation-incomplete" },
      },
    ]);
  });

  it("routes merge-gate work items off when task auto-merge is disabled", async () => {
    const transitions: Array<{ id: string; state: WorkflowWorkItemState; patch?: Record<string, unknown> }> = [];
    const workItem = {
      id: "work-merge-gate",
      runId: "run-merge-gate",
      taskId: task.id,
      nodeId: "merge-gate",
      kind: "merge",
      state: "running",
      attempt: 0,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => ({ ...task, autoMerge: false } as TaskDetail),
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        transitionWorkflowWorkItem: (id, state, patch) => {
          transitions.push({ id, state, patch });
          return { ...workItem, state };
        },
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.runWorkItem(workItem, { ...flagOff, autoMerge: true } as Settings);

    expect(result.disposition).toBe("completed");
    expect(result.context["node:merge-gate:value"]).toBe("auto-off");
    expect(transitions).toEqual([
      {
        id: "work-merge-gate",
        state: "succeeded",
        patch: { leaseOwner: null, leaseExpiresAt: null, lastError: null },
      },
    ]);
  });

  it("persists manual merge holds as manual-required work items", async () => {
    const transitions: Array<{ id: string; state: WorkflowWorkItemState; patch?: Record<string, unknown> }> = [];
    const workItem = {
      id: "work-manual-hold",
      runId: "run-manual-hold",
      taskId: task.id,
      nodeId: "merge-manual-hold",
      kind: "manual-hold",
      state: "running",
      attempt: 0,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => task,
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        transitionWorkflowWorkItem: (id, state, patch) => {
          transitions.push({ id, state, patch });
          return { ...workItem, state };
        },
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.runWorkItem(workItem, flagOff);

    expect(result.disposition).toBe("manual-required");
    expect(result.reason).toBe("manual-required");
    expect(transitions).toEqual([
      {
        id: "work-manual-hold",
        state: "manual-required",
        patch: { leaseOwner: null, leaseExpiresAt: null, lastError: "manual-required" },
      },
    ]);
  });

  it("returns failed without persisting when work item store transitions are unwired", async () => {
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const workItem = {
      id: "work-unwired",
      runId: "run-unwired",
      taskId: task.id,
      nodeId: "merge-gate",
      kind: "merge",
      state: "running",
      attempt: 0,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;

    await expect(runtime.runWorkItem(workItem, flagOff)).resolves.toEqual(expect.objectContaining({
      disposition: "failed",
      reason: "workflow-work-item-store-unwired",
    }));
  });

  it("threads work item attempt into merge primitive context", async () => {
    const observed: { mergeAttempt?: number; mergeRunId?: string; mergeWorkflowId?: string } = {};
    const transitions: Array<{ id: string; state: WorkflowWorkItemState; patch?: Record<string, unknown> }> = [];
    const workItem = {
      id: "work-merge-attempt",
      runId: "run-merge-attempt",
      taskId: task.id,
      nodeId: "merge-attempt",
      kind: "merge",
      state: "running",
      attempt: 3,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => task,
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        transitionWorkflowWorkItem: (id, state, patch) => {
          transitions.push({ id, state, patch });
          return { ...workItem, state };
        },
      },
      primitives: recordingPrimitives([], {}, observed),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.runWorkItem(workItem, flagOff);

    expect(result.disposition).toBe("completed");
    expect(result.context["workflow:work-item-attempt"]).toBe(3);
    expect(observed.mergeAttempt).toBe(3);
    expect(observed.mergeRunId).toBe("run-merge-attempt");
    expect(observed.mergeWorkflowId).toBe("builtin:coding");
    expect(transitions).toEqual([
      expect.objectContaining({ id: "work-merge-attempt", state: "succeeded" }),
    ]);
  });

  it("backfills a workflow completion summary before resumed merge work items run", async () => {
    const observed: { mergeAttempt?: number; mergeRunId?: string; mergeWorkflowId?: string } = {};
    const updates: Array<{ taskId: string; summary: string }> = [];
    const transitions: Array<{ id: string; state: WorkflowWorkItemState; patch?: Record<string, unknown> }> = [];
    const workItem = {
      id: "work-merge-summary",
      runId: "run-merge-summary",
      taskId: task.id,
      nodeId: "merge-attempt",
      kind: "merge",
      state: "running",
      attempt: 0,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => ({
          ...task,
          title: "Resume merge with summary",
          steps: [{ title: "Finish work", status: "done" }],
        } as TaskDetail),
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        updateTask: async (taskId, update) => {
          updates.push({ taskId, summary: update.summary });
        },
        transitionWorkflowWorkItem: (id, state, patch) => {
          transitions.push({ id, state, patch });
          return { ...workItem, state };
        },
      },
      primitives: recordingPrimitives([], {}, observed),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.runWorkItem(workItem, flagOff);

    expect(result.disposition).toBe("completed");
    expect(updates).toEqual([
      {
        taskId: task.id,
        summary: expect.stringContaining("Workflow completed: Resume merge with summary."),
      },
    ]);
    expect(updates[0]?.summary).toContain("Completion source: workflow-work-item:merge (builtin:coding).");
    expect(observed.mergeRunId).toBe("run-merge-summary");
    expect(transitions).toEqual([
      expect.objectContaining({ id: "work-merge-summary", state: "succeeded" }),
    ]);
  });

  it("uses the built-in workflow id in the default run id for unselected tasks", async () => {
    const observedRunIds: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      branchPersistence: {
        loadBranchStates: (_taskId, runId) => {
          observedRunIds.push(runId);
          return [];
        },
      },
    });

    await runtime.run(task, flagOff);

    expect(observedRunIds).toContain("FN-9002:builtin:coding");
  });

  it("surfaces graph failures as workflow-engine failures, not fallback", async () => {
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives(calls, { execute: { outcome: "failure", value: "implementation-incomplete" } }),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.outcome).toBe("failure");
    expect(calls).toEqual(["custom:prepare", "prepare-worktree", "execute"]);
  });

  it("converts interpreter throws into workflow-engine failures", async () => {
    const badIr: WorkflowIr = {
      version: "v1",
      name: "bad",
      nodes: [
        { id: "start", kind: "start" },
        { id: "zend", kind: "end" },
      ],
      edges: [{ from: "start", to: "ghost" }],
    };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: badIr }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toMatch(/workflow-execution-error/);
  });

  it("preserves graph node ids when the graph throws after seam and custom side effects", async () => {
    const cyclicIr: WorkflowIr = {
      version: "v1",
      name: "cyclic",
      nodes: [
        { id: "start", kind: "start" },
        { id: "do-execute", kind: "prompt", config: { seam: "execute" } },
        { id: "loop", kind: "prompt", config: { prompt: "loop" } },
      ],
      edges: [
        { from: "start", to: "do-execute", condition: "success" },
        { from: "do-execute", to: "loop", condition: "success" },
        { from: "loop", to: "do-execute", condition: "success" },
      ],
    };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: cyclicIr }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toMatch(/workflow-execution-error/);
    expect(result.visitedNodeIds).toEqual(["do-execute", "loop"]);
  });

  it("diagnostic event failures do not affect execution", async () => {
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      onEvent: () => {
        throw new Error("diagnostics failed");
      },
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("completed");
  });
});
