import { describe, expect, it } from "vitest";
import type { TaskDetail, WorkflowIr, WorkflowStepResult } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";

const settings = { experimentalFeatures: { workflowGraphExecutor: true } };
const task = (enabledWorkflowSteps: string[] = []): TaskDetail => ({
  id: "FN-224",
  enabledWorkflowSteps,
}) as TaskDetail;

function recorder() {
  const results: WorkflowStepResult[] = [];
  return {
    results,
    record: async (_taskId: string, result: WorkflowStepResult) => {
      const index = results.findIndex((candidate) => candidate.workflowStepId === result.workflowStepId);
      if (index >= 0) results[index] = result;
      else results.push(result);
    },
  };
}

function linearIr(node: WorkflowIr["nodes"][number]): WorkflowIr {
  return {
    version: "v2",
    name: "reviewed-commit-plumbing",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [{ id: "start", kind: "start" }, node, { id: "end", kind: "end" }],
    edges: [{ from: "start", to: node.id }, { from: node.id, to: "end" }],
  };
}

const reviewedCommitSha = "0123456789abcdef0123456789abcdef01234567";

describe("reviewed commit result plumbing", () => {
  it("persists an optional-group review anchor from its exit context", async () => {
    const sink = recorder();
    const reviewGroup: WorkflowIr["nodes"][number] = {
      id: "code-review",
      kind: "optional-group",
      config: {
        name: "Code Review",
        reviewKind: "code",
        defaultOn: false,
        template: {
          nodes: [{ id: "review", kind: "prompt", config: { prompt: "Review" } }],
          edges: [],
        },
      },
    };
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async (node) => node.id === "review"
          ? { outcome: "success", value: "APPROVE", contextPatch: { reviewedCommitSha } }
          : { outcome: "success" },
      },
      recordWorkflowStepResult: sink.record,
    });

    await executor.run(task(["code-review"]), settings, linearIr(reviewGroup));

    expect(sink.results).toEqual([
      expect.objectContaining({ workflowStepId: "code-review", reviewedCommitSha }),
    ]);
  });

  it("persists an ordinary review node anchor", async () => {
    const sink = recorder();
    const node: WorkflowIr["nodes"][number] = {
      id: "review",
      kind: "prompt",
      config: { name: "Code Review", prompt: "Review", reviewKind: "code" },
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", contextPatch: { reviewedCommitSha } }) },
      recordWorkflowStepResult: sink.record,
    });

    await executor.run(task(), settings, linearIr(node));

    expect(sink.results).toEqual([
      expect.objectContaining({ workflowStepId: "review", reviewedCommitSha }),
    ]);
  });

  it("does not persist an anchor from a non-review node", async () => {
    const sink = recorder();
    const node: WorkflowIr["nodes"][number] = {
      id: "execute",
      kind: "prompt",
      config: { prompt: "Execute" },
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", contextPatch: { reviewedCommitSha } }) },
      recordWorkflowStepResult: sink.record,
    });

    await executor.run(task(), settings, linearIr(node));

    expect(sink.results).toEqual([]);
  });

  it("omits an undefined review anchor instead of persisting an undefined key", async () => {
    const sink = recorder();
    const node: WorkflowIr["nodes"][number] = {
      id: "review",
      kind: "prompt",
      config: { prompt: "Review", reviewKind: "code" },
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", contextPatch: { reviewedCommitSha: undefined } }) },
      recordWorkflowStepResult: sink.record,
    });

    await executor.run(task(), settings, linearIr(node));

    expect(sink.results).toHaveLength(1);
    expect(sink.results[0]).not.toHaveProperty("reviewedCommitSha");
  });
});
