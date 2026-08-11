// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { persistWorkflowStepResult } from "../executor/execute-workflow-graph.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedExistsSync, resetExecutorMocks } from "./executor-test-helpers.js";

const RAW_REVIEW = JSON.stringify({
  verdict: "REVISE",
  notes: "later review",
  findings: [
    { id: "r1", title: "Receipt", body: "Fixed: explicit catch", resolution: "resolved-in-review" },
    { id: "r2", title: "Receipt", body: "Fixed: timeout budget", resolution: "resolved-in-review" },
    { id: "o1", title: "Open", body: "The only actionable finding" },
  ],
  supersededFindingSourceWorkflowStepId: "cleanup-review",
  supersededFindingIds: ["c1", "c2", "c3"],
});

function task(workflowStepResults = []) {
  return {
    id: "FN-8956", title: "Review findings", description: "test", column: "in-progress",
    dependencies: [], steps: [], currentStep: 0, log: [], prompt: "# Task", worktree: "/tmp/test-worktree", branch: "fusion/FN-8956",
    createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", workflowStepResults,
  };
}

const earlierResult = () => ({
  workflowStepId: "cleanup-review", workflowStepName: "Cleanup review", phase: "pre-merge", source: "node", status: "passed", reviewKind: "code",
  findings: [
    { id: "c1", title: "Cleanup one", body: "still present" },
    { id: "c2", title: "Cleanup two", body: "still present" },
    { id: "c3", title: "Cleanup three", body: "still present" },
  ], startedAt: "2026-08-12T00:00:00.000Z", completedAt: "2026-08-12T00:01:00.000Z",
});

function reviewGraph(node) {
  return {
    version: "v2", name: "review carrier", columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [{ id: "start", kind: "start" }, node, { id: "end", kind: "end" }],
    edges: [{ from: "start", to: node.id }, { from: node.id, to: "end" }],
  };
}

function sink(row, options = {}) {
  const store = {
    getTask: vi.fn(async () => row),
    updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
    isBackendMode: vi.fn(() => options.backend ?? false),
    withPlanningLifecycleLock: vi.fn(async (_id, fn) => fn()),
    lockCurrentPlanWhilePlanningLocked: vi.fn(async () => {}),
    reconcileSpecDriftWhilePlanningLocked: vi.fn(async () => {}),
  };
  return {
    row,
    store,
    record: (id, result) => persistWorkflowStepResult({
      store,
      getRunContextFor: () => undefined,
      readTaskArtifact: async () => "# Task",
    } as any, id, result),
  };
}

async function declaredScriptOutcome() {
  const store = createMockStore();
  store.getTask.mockResolvedValue(task());
  store.getSettings.mockResolvedValue({ autoMerge: false, experimentalFeatures: { workflowGraphExecutor: true } });
  const executor = new TaskExecutor(store, "/tmp/test");
  vi.spyOn(executor as any, "executeScriptWorkflowStep").mockResolvedValue({ success: true, output: RAW_REVIEW });
  return (executor as any).runGraphCustomNode(
    { id: "code-script", kind: "script", config: { scriptName: "review", reviewKind: "code" } }, task(), {}, undefined,
  );
}

/*
FNXC:WorkflowReviewFindings 2026-08-11-20:10:
Supersession is only safe when the production carrier is covered end to end: custom-review parsing feeds a graph
writer, and the shared persistence sink marks earlier durable findings in that same update. The unmarked control
proves arbitrary script stdout cannot become a cross-lane write capability.
*/
describe("review finding supersession production carrier", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("carries declared scripts through the ordinary graph writer and stamps only earlier findings at the sink", async () => {
    const outcome = await declaredScriptOutcome();
    const persisted = sink(task([earlierResult()]));
    const graph = new WorkflowGraphExecutor({
      runCustomNode: async () => outcome,
      recordWorkflowStepResult: persisted.record,
    });

    await graph.run(task([earlierResult()]), { experimentalFeatures: { workflowGraphExecutor: true } }, reviewGraph({
      id: "code-script", kind: "script", config: { name: "Code script", reviewKind: "code" },
    }));

    const results = persisted.row.workflowStepResults;
    expect(results.find((result) => result.workflowStepId === "code-script")).toMatchObject({
      supersededFindingSourceWorkflowStepId: "cleanup-review",
  supersededFindingIds: ["c1", "c2", "c3"],
    });
    expect(results[0].findings.map((finding) => finding.resolution)).toEqual(["superseded", "superseded", "superseded"]);
    expect(results.find((result) => result.workflowStepId === "code-script").findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "r1", resolution: "resolved-in-review" }),
      expect.objectContaining({ id: "o1" }),
    ]));
  });

  it("does not let identical unmarked script output reach either graph writer field or persistence mutation", async () => {
    const outcome = await declaredScriptOutcome();
    const persisted = sink(task([earlierResult()]));
    const graph = new WorkflowGraphExecutor({
      runCustomNode: async () => outcome,
      recordWorkflowStepResult: persisted.record,
    });
    await graph.run(task([earlierResult()]), { experimentalFeatures: { workflowGraphExecutor: true } }, reviewGraph({
      id: "plain-script", kind: "script", config: { name: "Plain script" },
    }));

    // Unmarked scripts do not qualify for graph review-progress recording at all.
    expect(persisted.row.workflowStepResults).toHaveLength(1);
    expect(persisted.row.workflowStepResults[0].findings).not.toContainEqual(expect.objectContaining({ resolution: "superseded" }));
  });

  it("carries prompt and optional-group exits through their distinct graph writers into the same sink", async () => {
    const patch = { findings: JSON.parse(RAW_REVIEW).findings, supersededFindingSourceWorkflowStepId: "cleanup-review", supersededFindingIds: ["c1", "c2", "c3"] };
    for (const node of [
      { id: "prompt-review", kind: "prompt", config: { name: "Prompt review", reviewKind: "code" } },
      {
        id: "group-review", kind: "optional-group", config: {
          name: "Group review", reviewKind: "code", defaultOn: true,
          template: { nodes: [{ id: "inside", kind: "prompt", config: { reviewKind: "code" } }], edges: [] },
        },
      },
    ]) {
      const persisted = sink(task([earlierResult()]));
      const graph = new WorkflowGraphExecutor({
        handlers: { prompt: async () => ({ outcome: "success", value: "APPROVE", contextPatch: patch }) },
        recordWorkflowStepResult: persisted.record,
      });
      await graph.run(task([earlierResult()]), { experimentalFeatures: { workflowGraphExecutor: true } }, reviewGraph(node));
      expect(persisted.row.workflowStepResults[0].findings.map((finding) => finding.resolution)).toEqual(["superseded", "superseded", "superseded"]);
      expect(persisted.row.workflowStepResults.find((result) => result.workflowStepId === node.id)).toMatchObject({
        supersededFindingSourceWorkflowStepId: "cleanup-review",
  supersededFindingIds: ["c1", "c2", "c3"],
      });
    }
  });

  it("applies a Plan Review claim within the planning lifecycle lock rather than a second update", async () => {
    const persisted = sink(task([earlierResult()]), { backend: true });
    await persisted.record("FN-8956", {
      workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", source: "optional-group", status: "passed",
      reviewKind: "plan", verdict: "APPROVE", supersededFindingSourceWorkflowStepId: "cleanup-review", supersededFindingIds: ["c1"], startedAt: "2026-08-12T00:00:00.000Z", completedAt: "2026-08-12T00:01:00.000Z",
    });
    expect(persisted.store.withPlanningLifecycleLock).toHaveBeenCalledOnce();
    expect(persisted.store.updateTask).toHaveBeenCalledOnce();
    expect(persisted.row.workflowStepResults[0].findings[0]).toMatchObject({ id: "c1", resolution: "superseded" });
  });
});
