// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TaskStore,
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  __resetWorkflowExtensionRegistryForTests,
  getWorkflowExtensionRegistry,
  workflowExtensionRegistryId,
  type Task,
  type TaskDetail,
  type WorkflowWorkItem,
  type WorkflowIr,
} from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { claimDueWorkflowWorkItem } from "../workflow-work-scheduler.js";
import { processDueWorkflowWorkItem, workflowMergeWorkKinds } from "../workflow-work-processor.js";
import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";
import type { WorkflowRuntimePrimitives } from "../runtime-primitives.js";

describe("workflow work-engine dispatch", () => {
  afterEach(() => {
    __resetWorkflowExtensionRegistryForTests();
  });

  it("lets a plugin work engine claim a task from column extension metadata", async () => {
    const extensionKey = workflowExtensionRegistryId("engine-plugin", "custom-dispatch");
    const task = {
      id: "FN-WORK",
      column: "in-progress",
      title: "plugin work",
      description: "plugin work",
    } as TaskDetail;
    const workflow: WorkflowIr = {
      version: "v2",
      name: "custom",
      columns: [
        { id: "todo", name: "Todo", traits: [] },
        {
          id: "in-progress",
          name: "Running",
          traits: [],
          extensions: { [extensionKey]: { lane: "custom" } },
        },
      ],
      nodes: [],
      edges: [],
    };
    const dispatch = vi.fn().mockResolvedValue({
      kind: "claimed",
      runId: "plugin-run-1",
      message: "claimed by plugin",
    });
    getWorkflowExtensionRegistry().register("engine-plugin", {
      extensionId: "custom-dispatch",
      name: "Custom dispatch",
      kind: "work-engine",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      dispatch,
    });

    const store = {
      on: vi.fn(),
      getTask: vi.fn().mockResolvedValue(task),
      getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "custom-workflow", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({ ir: workflow }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
      updateTask: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new TaskExecutor(store as any, "/tmp/fusion-work-engine-test");

    const claimed = await (executor as any).maybeDispatchWorkflowWorkEngine(task as Task);

    expect(claimed).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      task,
      workflow,
      columnId: "in-progress",
      metadata: { lane: "custom" },
    }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-WORK", "claimed by plugin");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "workflow:work-engine:claimed",
      metadata: expect.objectContaining({ extensionId: extensionKey, pluginId: "engine-plugin" }),
    }));
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});

describe("workflow work scheduler claims", () => {
  function workItem(input: Partial<WorkflowWorkItem> & Pick<WorkflowWorkItem, "id" | "taskId" | "nodeId">): WorkflowWorkItem {
    return {
      runId: "run-1",
      kind: "task",
      state: "runnable",
      attempt: 0,
      retryAfter: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      ...input,
    };
  }

  it("claims the first due workflow work item without reading task columns", () => {
    const item = workItem({ id: "work-1", taskId: "FN-1", nodeId: "node-a" });
    const store = {
      listDueWorkflowWorkItems: vi.fn(() => [item]),
      acquireWorkflowWorkItemLease: vi.fn(() => ({ ...item, state: "running", leaseOwner: "scheduler-a" })),
    };

    const dispatch = claimDueWorkflowWorkItem(store, {
      now: "2026-06-09T00:00:00.000Z",
      leaseOwner: "scheduler-a",
      leaseDurationMs: 60_000,
      kinds: ["task"],
    });

    expect(store.listDueWorkflowWorkItems).toHaveBeenCalledWith({
      now: "2026-06-09T00:00:00.000Z",
      limit: 25,
      kinds: ["task"],
    });
    expect(store.acquireWorkflowWorkItemLease).toHaveBeenCalledWith("work-1", "scheduler-a", {
      now: "2026-06-09T00:00:00.000Z",
      leaseDurationMs: 60_000,
    });
    expect(dispatch).toMatchObject({
      runId: "run-1",
      taskId: "FN-1",
      nodeId: "node-a",
      workItem: { state: "running", leaseOwner: "scheduler-a" },
    });
  });

  it("skips contenders whose lease was already acquired", () => {
    const first = workItem({ id: "work-1", taskId: "FN-1", nodeId: "node-a" });
    const second = workItem({ id: "work-2", taskId: "FN-2", nodeId: "node-b" });
    const store = {
      listDueWorkflowWorkItems: vi.fn(() => [first, second]),
      acquireWorkflowWorkItemLease: vi.fn((id: string) => (id === "work-2" ? { ...second, state: "running" } : null)),
    };

    const dispatch = claimDueWorkflowWorkItem(store, {
      now: "2026-06-09T00:00:00.000Z",
      leaseOwner: "scheduler-a",
      leaseDurationMs: 60_000,
    });

    expect(dispatch?.workItem.id).toBe("work-2");
    expect(store.acquireWorkflowWorkItemLease).toHaveBeenCalledTimes(2);
  });
});

describe("workflow work processor", () => {
  let rootDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "kb-workflow-work-processor-"));
    store = new TaskStore(rootDir, join(rootDir, ".fusion-global"));
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function primitives(): WorkflowRuntimePrimitives {
    const success = async () => ({ outcome: "success" as const });
    return {
      prepareWorktree: async () => ({ outcome: "success", data: { worktreePath: rootDir } }),
      readArtifact: async () => undefined,
      writeArtifact: async (_ctx, _task, key) => ({ outcome: "success", data: { key } }),
      runPlanningSession: success,
      runCodingSession: async () => ({ outcome: "success", data: { taskDone: true, modifiedFiles: [] } }),
      runTaskStep: success,
      resetTaskStep: async () => ({ ok: true }),
      runReview: async () => ({ outcome: "success", data: { verdict: "APPROVE" } }),
      runVerification: async () => ({ outcome: "success", data: { verdict: "skipped" } }),
      runWorkflowStep: success,
      updateSteps: async (_ctx, _task, steps) => ({ outcome: "success", data: { count: steps.length } }),
      transitionTask: success,
      requestMerge: async () => ({ outcome: "success", data: { status: "merged" } }),
      abortRun: success,
      audit: vi.fn(),
    };
  }

  it("claims due merge work and runs it through workflow runtime", async () => {
    const task = await store.createTask({ description: "processor task" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.handoffToReview(task.id, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-processor", agentId: "agent-test" },
      now: "2026-06-09T00:00:00.000Z",
    });
    const runtime = new WorkflowTaskRuntime({
      store,
      primitives: primitives(),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await processDueWorkflowWorkItem(store, runtime, { experimentalFeatures: {} } as any, {
      now: "2026-06-09T00:00:00.000Z",
      leaseOwner: "processor-a",
      leaseDurationMs: 60_000,
      kinds: workflowMergeWorkKinds(),
    });

    expect(result).toMatchObject({
      claimed: true,
      taskId: task.id,
      runtime: { disposition: "completed" },
    });
    expect(store.listWorkflowWorkItemsForTask(task.id, { kinds: ["merge"] })).toEqual([
      expect.objectContaining({ state: "succeeded", leaseOwner: null, leaseExpiresAt: null }),
    ]);
  });

  it("marks claimed work failed when runtime dispatch throws", async () => {
    const task = await store.createTask({ description: "processor failure task" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.handoffToReview(task.id, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-processor-failure", agentId: "agent-test" },
      now: "2026-06-09T00:00:00.000Z",
    });
    const runtime = new WorkflowTaskRuntime({
      store,
      primitives: primitives(),
      runCustomNode: async () => ({ outcome: "success" }),
    });
    vi.spyOn(runtime, "runWorkItem").mockRejectedValue(new Error("sqlite busy"));

    const result = await processDueWorkflowWorkItem(store, runtime, { experimentalFeatures: {} } as any, {
      now: "2026-06-09T00:00:00.000Z",
      leaseOwner: "processor-a",
      leaseDurationMs: 60_000,
      kinds: workflowMergeWorkKinds(),
    });

    expect(result).toMatchObject({
      claimed: true,
      taskId: task.id,
      runtime: {
        disposition: "failed",
        outcome: "failure",
        reason: "workflow-work-item-runtime-error:sqlite busy",
      },
    });
    expect(store.listWorkflowWorkItemsForTask(task.id, { kinds: ["merge"] })).toEqual([
      expect.objectContaining({
        state: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: "workflow-work-item-runtime-error:sqlite busy",
      }),
    ]);
  });

  it("returns claimed identity when runtime and cleanup transition both fail", async () => {
    const task = await store.createTask({ description: "processor double failure task" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.handoffToReview(task.id, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-processor-double-failure", agentId: "agent-test" },
      now: "2026-06-09T00:00:00.000Z",
    });
    const runtime = new WorkflowTaskRuntime({
      store,
      primitives: primitives(),
      runCustomNode: async () => ({ outcome: "success" }),
    });
    vi.spyOn(runtime, "runWorkItem").mockRejectedValue(new Error("sqlite busy"));
    vi.spyOn(store, "transitionWorkflowWorkItem").mockImplementation(() => {
      throw new Error("cleanup busy");
    });

    const result = await processDueWorkflowWorkItem(store, runtime, { experimentalFeatures: {} } as any, {
      now: "2026-06-09T00:00:00.000Z",
      leaseOwner: "processor-a",
      leaseDurationMs: 60_000,
      kinds: workflowMergeWorkKinds(),
    });

    expect(result).toMatchObject({
      claimed: true,
      taskId: task.id,
      runtime: {
        disposition: "failed",
        outcome: "failure",
        reason: "workflow-work-item-runtime-error:sqlite busy",
      },
    });
    expect(result.workItemId).toBeDefined();
  });
});
