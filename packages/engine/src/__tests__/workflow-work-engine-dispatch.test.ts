// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
