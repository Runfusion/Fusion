import { describe, expect, it, vi } from "vitest";
import { PermissionDeniedError } from "@fusion/core";
import type { TaskDetail, WorkflowIr } from "@fusion/core";

import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import {
  WorkflowGraphExecutor,
  workflowNodeErrorCodeContextKey,
} from "../workflows/workflow-graph-executor.js";

/*
FNXC:Authorization 2026-08-09-03:04:
`handleGraphFailure` overwrites a terminal node failure with a generic
"Workflow graph terminated with failure at node '<n>'" string. For a permission denial that
erases the entire answer: the operator is told WHERE the run stopped but never that it stopped
because an actor lacked a grant, and no amount of retrying or worktree repair will fix it.

Two halves are covered here because the denial does not reach the executor as an Error at all —
the graph executor flattens every node exception to `error.message` — so preserving the message
requires the CODE to be carried across that flattening as well:
  1. the graph executor stamps `node:<id>:errorCode` when (and only when) the thrown error is a
     typed permission denial;
  2. the executor's terminal park keys on that code to keep the denial's own sentence, while every
     other failure keeps the generic message byte-for-byte.
*/

const now = "2026-08-09T03:04:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-PERMISSION-DENIED",
    title: "Permission denial preserved through graph failure",
    description: "U1 coverage",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-permission-denied",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-permission-denied",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

function singleNodeGraph(nodeId: string): WorkflowIr {
  return {
    version: "v1",
    name: "permission-denied-probe",
    nodes: [
      { id: "start", kind: "start" },
      { id: nodeId, kind: "prompt" },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: nodeId },
      { from: nodeId, to: "end", condition: "success" },
    ],
  };
}

function settingsOn() {
  return { experimentalFeatures: { workflowGraphExecutor: true } };
}

describe("graph executor carries the permission-denied discriminant across error flattening", () => {
  it("stamps node:<id>:errorCode when a node throws a PermissionDeniedError", async () => {
    const prompt = vi.fn(async () => {
      throw new PermissionDeniedError("actor-7", "tasks:delete", "FN-1234");
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt }, maxRetriesPerNode: 1 });

    const result = await executor.run(task() as TaskDetail, settingsOn(), singleNodeGraph("gate"));

    expect(result.outcome).toBe("failure");
    expect(result.context[workflowNodeErrorCodeContextKey("gate")]).toBe("PERMISSION_DENIED");
    expect(result.context["node:gate:error"]).toBe(
      "actor-7 is not permitted to tasks:delete on FN-1234",
    );
  });

  it("stamps no error code for an ordinary node exception", async () => {
    const prompt = vi.fn(async () => {
      throw new Error("worktree missing");
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt }, maxRetriesPerNode: 1 });

    const result = await executor.run(task() as TaskDetail, settingsOn(), singleNodeGraph("gate"));

    expect(result.outcome).toBe("failure");
    expect(result.context[workflowNodeErrorCodeContextKey("gate")]).toBeUndefined();
    expect(result.context["node:gate:error"]).toBe("worktree missing");
  });
});

describe("handleGraphFailure preserves a permission denial's message", () => {
  async function parkGraphFailure(context: Record<string, unknown>, failedNodeId = "gate") {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task();
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue({
      autoMerge: true,
      maxAutoMergeRetries: 3,
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
    });
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as unknown as {
      handleGraphFailure: (t: TaskDetail, r: unknown) => Promise<void>;
    }).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: [failedNodeId],
      context,
    });

    return { store, live };
  }

  it("parks the task with the denial's own message instead of the generic node text", async () => {
    const { store, live } = await parkGraphFailure({
      "node:gate:value": "exception",
      "node:gate:error": "actor-7 is not permitted to tasks:delete on FN-1234",
      "node:gate:errorCode": "PERMISSION_DENIED",
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      {
        error: "actor-7 is not permitted to tasks:delete on FN-1234",
        status: "failed",
      },
      undefined,
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({
        error: expect.stringContaining("Workflow graph terminated with failure"),
      }),
      expect.anything(),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      "actor-7 is not permitted to tasks:delete on FN-1234",
      undefined,
      undefined,
    );
  });

  it("recovers the denial from a materialized instance key when the visited node id does not match", async () => {
    // A foreach/template instance patches context under its own instance id, so the exact
    // `node:<visitedNodeId>:errorCode` lookup legitimately misses; the denial must not be dropped.
    const { store, live } = await parkGraphFailure({
      "node:gate#1:value": "exception",
      "node:gate#1:error": "actor-7 is not permitted to tasks:merge",
      "node:gate#1:errorCode": "PERMISSION_DENIED",
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      { error: "actor-7 is not permitted to tasks:merge", status: "failed" },
      undefined,
    );
  });

  it("keeps the generic message for a non-permission node failure", async () => {
    const { store, live } = await parkGraphFailure({
      "node:gate:value": "exception",
      "node:gate:error": "worktree missing",
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      {
        error: "Workflow graph terminated with failure at node 'gate'",
        status: "failed",
      },
      undefined,
    );
  });

  it("keeps the generic message when a node error carries a different typed code", async () => {
    const { store, live } = await parkGraphFailure({
      "node:gate:value": "exception",
      "node:gate:error": "task FN-1 not found",
      "node:gate:errorCode": "TASK_NOT_FOUND",
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      {
        error: "Workflow graph terminated with failure at node 'gate'",
        status: "failed",
      },
      undefined,
    );
  });

  it("falls back to the generic message when the denial code has no message beside it", async () => {
    const { store, live } = await parkGraphFailure({
      "node:gate:value": "exception",
      "node:gate:errorCode": "PERMISSION_DENIED",
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      {
        error: "Workflow graph terminated with failure at node 'gate'",
        status: "failed",
      },
      undefined,
    );
  });
});
