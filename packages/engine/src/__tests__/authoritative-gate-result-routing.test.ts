import { describe, expect, it } from "vitest";
import { PLAN_REVIEW_GROUP_ID, type TaskDetail, type WorkflowIr, type WorkflowStepResult } from "@fusion/core";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";

const settings = { experimentalFeatures: { workflowGraphExecutor: true } };
const graph: WorkflowIr = {
  version: "v2", name: "authoritative-gate-routing",
  columns: [{ id: "in-review", name: "Review", traits: [] }],
  nodes: [
    { id: "start", kind: "start" },
    { id: "review", kind: "optional-group", config: { name: "Review", defaultOn: true, phase: "pre-merge", template: { nodes: [{ id: "reviewer", kind: "prompt", config: { prompt: "review" } }], edges: [] } } },
  ],
  edges: [{ from: "start", to: "review" }],
};
function task(): TaskDetail {
  return { id: "FN-9289", steps: [], enabledWorkflowSteps: ["review"], workflowStepResults: [] } as TaskDetail;
}

describe("authoritative gate-result routing", () => {
  it("fails a required gate and logs failure when its durable row rejects the optimistic approval", async () => {
    const logs: string[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", value: "APPROVE", contextPatch: { verdictRequired: true } }) },
      recordWorkflowStepResult: async (_id, result) => result.status === "pending"
        ? { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: result }
        : { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: { ...result, status: "failed", verdict: undefined } },
      logTaskEntry: (message) => logs.push(message),
    });
    const result = await executor.run(task(), settings, graph);
    expect(result.visitedNodeIds).toContain("review");
    expect(result.context).toMatchObject({ "node:review:outcome": "failure", "node:review:value": "gate-result-not-approved" });
    expect(result.outcome).toBe("failure");
    expect(result.context["node:review:outcome"]).toBe("failure");
    expect(result.context["node:review:value"]).toBe("gate-result-not-approved");
    expect(logs).toContain("[pre-merge] Workflow step failed: Review");
  });

  it("requires an approving durable verdict for optional required reviews", async () => {
    const logs: string[] = [];
    const terminalRows: WorkflowStepResult[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", value: "APPROVE", contextPatch: { verdictRequired: true } }) },
      recordWorkflowStepResult: async (_id, result) => {
        if (result.status === "pending") {
          return { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: result };
        }
        terminalRows.push(result);
        return { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: { ...result, verdict: undefined } };
      },
      logTaskEntry: (message) => logs.push(message),
    });
    const result = await executor.run(task(), settings, {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === "review" ? {
        ...node,
        config: { ...node.config, reviewKind: "code" },
      } : node),
    });
    expect(terminalRows).toMatchObject([{ status: "passed", verdict: "APPROVE", verdictRequired: true, reviewKind: "code" }]);
    expect(result).toMatchObject({
      outcome: "failure",
      context: { "node:review:outcome": "failure", "node:review:value": "gate-result-not-approved" },
    });
    expect(logs).toContain("[pre-merge] Workflow step failed: Review");
    expect(logs).not.toContain("[pre-merge] Workflow step completed: Review");
  });

  it("fails a required gate when a failed durable row retains a stale APPROVE verdict", async () => {
    const logs: string[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", value: "APPROVE", contextPatch: { verdictRequired: true } }) },
      recordWorkflowStepResult: async (_id, result) => result.status === "pending"
        ? { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: result }
        : { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: { ...result, status: "failed", verdict: "APPROVE" } },
      logTaskEntry: (message) => logs.push(message),
    });
    const result = await executor.run(task(), settings, graph);
    expect(result).toMatchObject({
      outcome: "failure",
      context: { "node:review:outcome": "failure", "node:review:value": "gate-result-not-approved" },
    });
    expect(logs).toContain("[pre-merge] Workflow step failed: Review");
    expect(logs).not.toContain("[pre-merge] Workflow step completed: Review");
  });

  it("holds required gates on a wired persistence refusal without inventing REVISE", async () => {
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", value: "APPROVE", contextPatch: { verdictRequired: true } }) },
      recordWorkflowStepResult: async (_id, result) => result.status === "pending"
        ? { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: result }
        : { scopeCurrent: true, persisted: false, disposition: "fence-refused" },
    });
    const result = await executor.run(task(), settings, graph);
    expect(result.outcome).toBe("failure");
    expect(result.context["node:review:value"]).toBe("gate-persistence-unavailable");
    expect(result.context["node:review:value"]).not.toBe("REVISE");
  });

  it("preserves repository scope supersession routing", async () => {
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", value: "APPROVE", contextPatch: { verdictRequired: true } }) },
      recordWorkflowStepResult: async (_id, result) => result.status === "pending"
        ? { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: result }
        : { scopeCurrent: false, persisted: false, disposition: "scope-superseded" },
    });
    const result = await executor.run(task(), settings, graph);
    expect(result.outcome).toBe("failure");
    expect(result.context["node:review:value"]).toBe("workspace-review-superseded");
  });

  it("holds reconstructed Plan Review when its repaired terminal row is not applied", async () => {
    const logs: string[] = [];
    const reconstructedTask = {
      ...task(),
      workflowStepResults: undefined,
      enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID],
      log: [{ action: "[pre-merge] Workflow step completed: Plan Review", timestamp: new Date().toISOString() }],
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success" }) },
      recordWorkflowStepResult: async () => ({ scopeCurrent: true, persisted: false, disposition: "fence-refused" }),
      logTaskEntry: (message) => logs.push(message),
    });
    const result = await executor.run(reconstructedTask, settings, {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === "review" ? { ...node, id: PLAN_REVIEW_GROUP_ID } : node),
      edges: [{ from: "start", to: PLAN_REVIEW_GROUP_ID }],
    });
    expect(result).toMatchObject({ outcome: "failure", context: { [`node:${PLAN_REVIEW_GROUP_ID}:value`]: "gate-persistence-unavailable" } });
    expect(logs).not.toContain("[pre-merge] Workflow step already passed: Plan Review");
  });

  it("preserves reconstructed Plan Review cancellation while its terminal persistence is pending", async () => {
    const controller = new AbortController();
    const reconstructedTask = {
      ...task(),
      workflowStepResults: undefined,
      enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID],
      log: [{ action: "[pre-merge] Workflow step completed: Plan Review", timestamp: new Date().toISOString() }],
    };
    const executor = new WorkflowGraphExecutor({
      signal: controller.signal,
      handlers: { prompt: async () => ({ outcome: "success" }) },
      recordWorkflowStepResult: async () => {
        controller.abort();
        return { scopeCurrent: true, persisted: false, disposition: "aborted" };
      },
    });
    const result = await executor.run(reconstructedTask, settings, {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === "review" ? { ...node, id: PLAN_REVIEW_GROUP_ID } : node),
      edges: [{ from: "start", to: PLAN_REVIEW_GROUP_ID }],
    });
    expect(result).toMatchObject({
      outcome: "failure",
      context: { [`node:${PLAN_REVIEW_GROUP_ID}:abortKind`]: "engine-pause" },
    });
    expect(result.context[`node:${PLAN_REVIEW_GROUP_ID}:value`]).not.toBe("gate-persistence-unavailable");
  });

  it("fails standalone required review nodes from their durable terminal row", async () => {
    const standaloneGraph: WorkflowIr = {
      version: "v2", name: "standalone-authoritative-review",
      columns: [{ id: "in-review", name: "Review", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "standalone-review", kind: "prompt", config: { prompt: "review", reviewKind: "code" } },
      ],
      edges: [{ from: "start", to: "standalone-review" }],
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", value: "APPROVE", contextPatch: { verdictRequired: true } }) },
      recordWorkflowStepResult: async (_id, result) => result.status === "pending"
        ? { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: result }
        : { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: { ...result, status: "failed" } },
    });
    const result = await executor.run({ ...task(), enabledWorkflowSteps: ["standalone-review"] }, settings, standaloneGraph);
    expect(result).toMatchObject({ outcome: "failure", context: {
      "node:standalone-review:outcome": "failure",
      "node:standalone-review:value": "gate-result-not-approved",
    } });
  });

  it("requires an approving durable verdict for standalone required review nodes", async () => {
    const standaloneGraph: WorkflowIr = {
      version: "v2", name: "standalone-verdict-authority",
      columns: [{ id: "in-review", name: "Review", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "standalone-review", kind: "prompt", config: { prompt: "review", reviewKind: "code" } },
      ],
      edges: [{ from: "start", to: "standalone-review" }],
    };
    const terminalRows: WorkflowStepResult[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", value: "APPROVE", contextPatch: { verdictRequired: true } }) },
      recordWorkflowStepResult: async (_id, result) => {
        if (result.status === "pending") {
          return { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: result };
        }
        terminalRows.push(result);
        return { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: { ...result, verdict: undefined } };
      },
    });
    const result = await executor.run({ ...task(), enabledWorkflowSteps: ["standalone-review"] }, settings, standaloneGraph);
    expect(terminalRows).toMatchObject([{ status: "passed", verdict: "APPROVE", verdictRequired: true }]);
    expect(result).toMatchObject({ outcome: "failure", context: { "node:standalone-review:value": "gate-result-not-approved" } });
  });

  it("holds standalone required review nodes when their terminal write is refused", async () => {
    const standaloneGraph: WorkflowIr = {
      version: "v2", name: "standalone-refused-review",
      columns: [{ id: "in-review", name: "Review", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "standalone-review", kind: "prompt", config: { prompt: "review", reviewKind: "code" } },
      ],
      edges: [{ from: "start", to: "standalone-review" }],
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", value: "APPROVE", contextPatch: { verdictRequired: true } }) },
      recordWorkflowStepResult: async (_id, result) => result.status === "pending"
        ? { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: result }
        : { scopeCurrent: true, persisted: false, disposition: "fence-refused" },
    });
    await expect(executor.run({ ...task(), enabledWorkflowSteps: ["standalone-review"] }, settings, standaloneGraph))
      .resolves.toMatchObject({ outcome: "failure", context: { "node:standalone-review:value": "gate-persistence-unavailable" } });
  });

  it("routes a durable optional-group REVISE to its authored remediation edge", async () => {
    const requested: unknown[] = [];
    const remediationGraph: WorkflowIr = {
      ...graph,
      nodes: [
        ...graph.nodes.map((node) => node.id === "review" ? {
          ...node,
          config: { ...node.config, reviewKind: "code" },
        } : node),
        { id: "remediate", kind: "code", config: { workflowAction: "pre-merge-remediation", forWorkflowStepId: "review" } },
      ],
      edges: [...graph.edges, { from: "review", to: "remediate", condition: "outcome:failure" }],
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "failure", value: "REVISE", contextPatch: { verdictRequired: true, output: "Fix the review finding." } }) },
      recordWorkflowStepResult: async (_id, result) => ({ scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: result }),
      requestPreMergeOptionalStepFix: async (_taskId, context) => { requested.push(context); return true; },
    });
    await expect(executor.run(task(), settings, remediationGraph)).resolves.toMatchObject({ outcome: "success", context: { "node:review:fixScheduled": true } });
    expect(requested).toMatchObject([{ nodeId: "review", verdict: "REVISE" }]);
  });

  it("preserves a durable standalone REVISE for the task runner's authored remediation edge", async () => {
    const requested: unknown[] = [];
    const standaloneGraph: WorkflowIr = {
      version: "v2", name: "standalone-revise-remediation",
      columns: [{ id: "in-review", name: "Review", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "standalone-review", kind: "prompt", config: { prompt: "review", reviewKind: "code" } },
        { id: "remediate", kind: "code", config: { workflowAction: "pre-merge-remediation", forWorkflowStepId: "standalone-review" } },
      ],
      edges: [
        { from: "start", to: "standalone-review" },
        { from: "standalone-review", to: "remediate", condition: "outcome:failure" },
      ],
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "failure", value: "REVISE", contextPatch: { verdictRequired: true, output: "Fix the review finding." } }) },
      recordWorkflowStepResult: async (_id, result) => ({ scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: result }),
      requestPreMergeOptionalStepFix: async (_taskId, context) => { requested.push(context); return true; },
    });
    await expect(executor.run({ ...task(), enabledWorkflowSteps: ["standalone-review"] }, settings, standaloneGraph))
      .resolves.toMatchObject({ outcome: "failure", context: { "node:standalone-review:outcome": "failure", "node:standalone-review:value": "REVISE" } });
    /* FNXC:AuthoritativeGateResult 2026-09-12-23:45: The task runner, rather than this single-node executor, traverses the authored failure edge. */
    expect(standaloneGraph.edges).toContainEqual({ from: "standalone-review", to: "remediate", condition: "outcome:failure" });
    expect(requested).toEqual([]);
  });

  it("contains an abort raised while optional-group terminal persistence is pending", async () => {
    const controller = new AbortController();
    const records: WorkflowStepResult[] = [];
    const discarded: string[] = [];
    const executor = new WorkflowGraphExecutor({
      signal: controller.signal,
      handlers: { prompt: async () => ({ outcome: "success", value: "APPROVE", contextPatch: { verdictRequired: true } }) },
      recordWorkflowStepResult: async (_id, result) => {
        records.push(result);
        if (result.status !== "pending") controller.abort();
        return result.status === "pending"
          ? { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: result }
          : { scopeCurrent: true, persisted: false, disposition: "aborted" };
      },
      discardWorkflowStepLease: async (_taskId, workflowStepId) => { discarded.push(workflowStepId); },
    });
    const result = await executor.run(task(), settings, graph);
    expect(result).toMatchObject({ outcome: "failure", context: { "node:review:abortKind": "engine-pause" } });
    expect(records.at(-1)).toMatchObject({ status: "passed" });
    expect(discarded).toEqual(["review"]);
  });

  it("keeps a legacy boolean sink compatible", async () => {
    const records: WorkflowStepResult[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", value: "APPROVE", contextPatch: { verdictRequired: true } }) },
      recordWorkflowStepResult: async (_id, result) => { records.push(result); return true; },
    });
    await expect(executor.run(task(), settings, graph)).resolves.toMatchObject({ outcome: "success" });
    expect(records.at(-1)).toMatchObject({ status: "passed" });
  });
});
