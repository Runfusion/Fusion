import { describe, expect, it, vi } from "vitest";
import { getTaskMergeBlocker } from "@fusion/core";
import type { TaskDetail, WorkflowIr, WorkflowStepResult } from "@fusion/core";
import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";
import { persistWorkflowStepResultWithOutcome } from "../executor/execute-workflow-graph.js";

const settings = { experimentalFeatures: { workflowGraphExecutor: true } };

function task(enabledWorkflowSteps: string[] | undefined = undefined): TaskDetail {
  return {
    id: "FN-249",
    column: "in-review",
    steps: [],
    enabledWorkflowSteps,
    workflowStepResults: [],
  } as TaskDetail;
}

function optionalGroupGraph(): WorkflowIr {
  return {
    version: "v2",
    name: "aborted-optional-step",
    columns: [{ id: "in-review", name: "Review", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "documentation-delivery",
        kind: "optional-group",
        config: {
          name: "Documentation",
          defaultOn: true,
          phase: "pre-merge",
          template: {
            nodes: [{ id: "documentation-step", kind: "prompt", config: { prompt: "document" } }],
            edges: [],
          },
        },
      },
      { id: "merge-attempt", kind: "merge-attempt", config: { capability: "task-merge" } },
    ],
    edges: [
      { from: "start", to: "documentation-delivery" },
      { from: "documentation-delivery", to: "merge-attempt", condition: "failure" },
    ],
  };
}

function nodeProgressGraph(): WorkflowIr {
  return {
    version: "v2",
    name: "aborted-node-progress",
    columns: [{ id: "in-review", name: "Review", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "security-gate", kind: "gate", config: { skillName: "security", prompt: "verify" } },
    ],
    edges: [{ from: "start", to: "security-gate" }],
  };
}

function recorder(records: WorkflowStepResult[]) {
  return {
    record: async (_taskId: string, result: WorkflowStepResult) => {
      const existing = records.findIndex((entry) => entry.workflowStepId === result.workflowStepId);
      if (existing >= 0) records[existing] = result;
      else records.push(result);
      return true;
    },
    discard: async (_taskId: string, workflowStepId: string, startedAt: string) => {
      const index = records.findIndex((entry) =>
        entry.workflowStepId === workflowStepId
        && entry.status === "pending"
        && entry.startedAt === startedAt,
      );
      if (index >= 0) records.splice(index, 1);
      return index >= 0;
    },
  };
}

/** Production-shaped sink where only the pending lease write has a transient failure. */
function sinkWithTransientPendingFailure(subject: TaskDetail) {
  let failPendingWrite = true;
  const updateTask = vi.fn(async (_id: string, patch: Partial<TaskDetail>) => {
    const pending = patch.workflowStepResults?.some((entry) => entry.status === "pending") === true;
    if (failPendingWrite && pending) {
      failPendingWrite = false;
      throw new Error("temporary pending lease persistence failure");
    }
    Object.assign(subject, patch);
    return subject;
  });
  const store = {
    getTask: vi.fn(async () => subject),
    updateTask,
    isBackendMode: vi.fn(() => false),
    recordAgentActivity: vi.fn(async () => undefined),
  };
  const record = vi.fn((
    taskId: string,
    result: WorkflowStepResult,
    fence?: {
      signal?: AbortSignal;
      requireAttemptStartedAt?: string;
      requireAttemptStartedAtOrAbsent?: string;
    },
  ) => persistWorkflowStepResultWithOutcome(
    { store, getRunContextFor: () => undefined, readTaskArtifact: async () => undefined } as never,
    taskId,
    result,
    fence,
  ));
  return { record, store, updateTask };
}

/*
FNXC:WorkflowLifecycle 2026-08-29-02:24:
FN-249 distinguishes an operator-aborted run from a real failed verdict. The graph may have already
written a pending lease, but it must discard that exact attempt, never terminalize the gate as failed,
and never enter the advisory failure edge that would request merge work.
*/
describe("workflow graph aborted step result handling", () => {
  it("reproduces the advisory Documentation failure chain without terminalizing or entering merge", async () => {
    const controller = new AbortController();
    const records: WorkflowStepResult[] = [];
    const logs: string[] = [];
    const sink = recorder(records);
    const handler: WorkflowNodeHandler = async (node) => {
      if (node.id === "documentation-step") {
        controller.abort();
        return { outcome: "success", value: "failed" };
      }
      return { outcome: "success" };
    };
    const executor = new WorkflowGraphExecutor({
      signal: controller.signal,
      handlers: { prompt: handler },
      recordWorkflowStepResult: sink.record,
      discardWorkflowStepLease: sink.discard,
      logTaskEntry: (action) => logs.push(action),
    });

    const result = await executor.run(task(), settings, optionalGroupGraph());

    expect(result.outcome).toBe("failure");
    expect(result.visitedNodeIds).not.toContain("merge");
    expect(records).toEqual([]);
    expect(logs).toContain("[pre-merge] Workflow step interrupted: Documentation");
    expect(logs.join("\n")).not.toContain("Workflow step failed:");
    const blocker = getTaskMergeBlocker({
      column: "in-review",
      steps: [],
      workflowStepResults: records,
    });
    expect(blocker).not.toBe("task has failed pre-merge workflow steps");
    expect(blocker).not.toBe("task has incomplete or failed pre-merge workflow steps");
  });

  it("discards a node-progress lease when a source:node gate is interrupted", async () => {
    const controller = new AbortController();
    const records: WorkflowStepResult[] = [];
    const sink = recorder(records);
    const executor = new WorkflowGraphExecutor({
      signal: controller.signal,
      handlers: {
        gate: async () => {
          controller.abort();
          return { outcome: "failure", value: "cancelled-handler" };
        },
      },
      recordWorkflowStepResult: sink.record,
      discardWorkflowStepLease: sink.discard,
    });

    const result = await executor.run(task(), settings, nodeProgressGraph());

    expect(result.outcome).toBe("failure");
    expect(records).toEqual([]);
  });

  it("preserves ordinary failed terminalization when no abort signal is set", async () => {
    const records: WorkflowStepResult[] = [];
    const sink = recorder(records);
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({ outcome: "failure", value: "provider-failure" }),
      },
      recordWorkflowStepResult: sink.record,
      discardWorkflowStepLease: sink.discard,
    });

    await executor.run(task(), settings, optionalGroupGraph());

    expect(records).toEqual([
      expect.objectContaining({ workflowStepId: "documentation-delivery", status: "failed" }),
    ]);
  });

  it("persists an optional-group terminal result after its fail-soft pending lease write fails", async () => {
    const subject = task();
    const sink = sinkWithTransientPendingFailure(subject);
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({ outcome: "failure", value: "provider-failure" }),
      },
      recordWorkflowStepResult: sink.record,
    });

    await executor.run(subject, settings, optionalGroupGraph());

    expect(sink.updateTask).toHaveBeenCalledTimes(2);
    expect(sink.record.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      workflowStepId: "documentation-delivery",
      status: "pending",
    }));
    const pendingResult = sink.record.mock.calls[0]?.[1] as WorkflowStepResult;
    const terminalFence = sink.record.mock.calls[1]?.[2] as {
      requireAttemptStartedAt?: string;
      requireAttemptStartedAtOrAbsent?: string;
    } | undefined;
    expect(terminalFence?.requireAttemptStartedAt).toBeUndefined();
    expect(terminalFence).toEqual(expect.objectContaining({
      requireAttemptStartedAtOrAbsent: pendingResult.startedAt,
    }));
    expect(subject.workflowStepResults).toEqual([
      expect.objectContaining({ workflowStepId: "documentation-delivery", status: "failed" }),
    ]);
  });

  it("refuses a stale optional-group terminal result after a later attempt claims the gate", async () => {
    const subject = task();
    const sink = sinkWithTransientPendingFailure(subject);
    let laterLease: Awaited<ReturnType<typeof persistWorkflowStepResultWithOutcome>> | undefined;
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => {
          laterLease = await persistWorkflowStepResultWithOutcome(
            { store: sink.store, getRunContextFor: () => undefined, readTaskArtifact: async () => undefined } as never,
            subject.id,
            {
              workflowStepId: "documentation-delivery",
              workflowStepName: "Documentation",
              phase: "pre-merge",
              source: "optional-group",
              status: "pending",
              startedAt: "later-attempt",
            },
          );
          return { outcome: "failure", value: "provider-failure" };
        },
      },
      recordWorkflowStepResult: sink.record,
    });

    await executor.run(subject, settings, optionalGroupGraph());

    expect(laterLease).toEqual({ scopeCurrent: true, persisted: true });
    const pendingResult = sink.record.mock.calls[0]?.[1] as WorkflowStepResult;
    const terminalFence = sink.record.mock.calls[1]?.[2] as {
      requireAttemptStartedAt?: string;
      requireAttemptStartedAtOrAbsent?: string;
    } | undefined;
    expect(terminalFence).toEqual(expect.objectContaining({
      requireAttemptStartedAtOrAbsent: pendingResult.startedAt,
    }));
    expect(subject.workflowStepResults).toEqual([
      expect.objectContaining({
        workflowStepId: "documentation-delivery",
        status: "pending",
        startedAt: "later-attempt",
      }),
    ]);
  });

  it("persists a source:node terminal result after its fail-soft pending lease write fails", async () => {
    const subject = task();
    const sink = sinkWithTransientPendingFailure(subject);
    const executor = new WorkflowGraphExecutor({
      handlers: {
        gate: async () => ({ outcome: "failure", value: "provider-failure" }),
      },
      recordWorkflowStepResult: sink.record,
    });

    await executor.run(subject, settings, nodeProgressGraph());

    expect(sink.updateTask).toHaveBeenCalledTimes(2);
    expect(sink.record.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      workflowStepId: "security-gate",
      status: "pending",
    }));
    const pendingResult = sink.record.mock.calls[0]?.[1] as WorkflowStepResult;
    const terminalFence = sink.record.mock.calls[1]?.[2] as {
      requireAttemptStartedAt?: string;
      requireAttemptStartedAtOrAbsent?: string;
    } | undefined;
    expect(terminalFence?.requireAttemptStartedAt).toBeUndefined();
    expect(terminalFence).toEqual(expect.objectContaining({
      requireAttemptStartedAtOrAbsent: pendingResult.startedAt,
    }));
    expect(subject.workflowStepResults).toEqual([
      expect.objectContaining({ workflowStepId: "security-gate", status: "failed" }),
    ]);
  });
});
