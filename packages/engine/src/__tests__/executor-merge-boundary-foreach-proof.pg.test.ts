import { afterEach, expect, it, vi } from "vitest";
import { instanceNodeId, type TaskStep, type TaskStore, type WorkflowIr } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { TaskExecutor } from "../executor.js";

const runId = "foreach-proof-run";
const columns = [{ id: "todo", name: "Todo", traits: [] }, { id: "in-review", name: "Review", traits: [{ trait: "merge" }] }];
const foreachIr: WorkflowIr = {
  version: "v2", name: "foreach proof", columns,
  nodes: [
    { id: "parse", kind: "parse-steps", column: "todo" },
    { id: "steps", kind: "foreach", column: "todo", config: { source: "task-steps", template: { nodes: [{ id: "step-execute", kind: "prompt", config: { seam: "step-execute" } }], edges: [] } } },
    { id: "merge", kind: "merge-gate", column: "in-review" }, { id: "end", kind: "end" },
  ], edges: [],
};
const foreachWithoutSeamIr: WorkflowIr = {
  ...foreachIr,
  nodes: foreachIr.nodes.map((node) => node.id === "steps"
    ? { ...node, config: { source: "task-steps", template: { nodes: [{ id: "review", kind: "prompt" }], edges: [] } } }
    : node),
};
const executeIr: WorkflowIr = {
  version: "v2", name: "execute proof", columns,
  nodes: [{ id: "execute", kind: "prompt", column: "todo", config: { seam: "execute" } }, { id: "merge", kind: "merge-gate", column: "in-review" }], edges: [],
};
const nodeResult = (id: string, status: "passed" | "failed" = "passed") => ({ workflowStepId: id, source: "node" as const, phase: "pre-merge" as const, status, completedAt: new Date().toISOString() });
const pendingSteps = (): TaskStep[] => ["one", "two", "three"].map((title, index) => ({ id: `${index}`, title, status: "pending" }));

let harness: PgTestHarness | undefined;
afterEach(async () => { await harness?.teardown(); harness = undefined; vi.restoreAllMocks(); });

async function setup({ ir = foreachIr, results = [], steps = pendingSteps() }: { ir?: WorkflowIr; results?: ReturnType<typeof nodeResult>[]; steps?: TaskStep[] } = {}) {
  harness = await createTaskStoreForTest();
  const store = harness.store;
  const task = await store.createTask({ description: "foreach merge proof" });
  await store.moveTask(task.id, "todo");
  await store.moveTask(task.id, "in-progress");
  await store.updateTask(task.id, { steps, workflowStepResults: results });
  vi.spyOn(store as unknown as { getTaskWorkflowSelectionAsync: () => Promise<unknown> }, "getTaskWorkflowSelectionAsync").mockResolvedValue({ workflowId: "wf-proof", stepIds: [] });
  vi.spyOn(store as unknown as { getTaskWorkflowSelection: () => unknown }, "getTaskWorkflowSelection").mockReturnValue({ workflowId: "wf-proof", stepIds: [] });
  vi.spyOn(store as unknown as { getWorkflowDefinition: () => Promise<unknown> }, "getWorkflowDefinition").mockResolvedValue({ id: "wf-proof", ir });
  return { store, task, executor: new TaskExecutor(store as TaskStore, process.cwd()) };
}

async function merge(executor: TaskExecutor, task: unknown) {
  return (executor as unknown as { ensureWorkflowMergeBoundaryTask: (t: unknown, m: unknown) => Promise<unknown> })
    .ensureWorkflowMergeBoundaryTask(task, { reason: "test", nodeId: "merge", workflowId: "wf-proof", runId });
}

async function proofFailure(executor: TaskExecutor, task: unknown) {
  return (executor as unknown as { getWorkflowMergeImplementationProofFailure: (t: unknown) => Promise<string | undefined> })
    .getWorkflowMergeImplementationProofFailure(task);
}

pgDescribe("FN-8601 — PostgreSQL foreach merge proof", () => {
  it("blocks partial results even with completed persisted rows, then advances complete coverage", async () => {
    const ids = [0, 1, 2].map((index) => instanceNodeId("steps", index, "step-execute"));
    const { store, task, executor } = await setup({ results: [nodeResult(ids[0])] });
    for (let index = 0; index < 3; index += 1) await store.saveWorkflowRunStepInstanceAsync({ taskId: task.id, runId, foreachNodeId: "steps", stepIndex: index, pinnedStepCount: 3, currentNodeId: "step-execute", status: "completed", reworkCount: 0 });
    await merge(executor, task);
    let live = await store.getTask(task.id);
    expect(live?.column).not.toBe("in-review");
    expect(live?.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
    expect(await proofFailure(executor, live!)).toContain("foreach step instances are incomplete");
    const evaluation = await (executor as unknown as { evaluateWorkflowMergeBoundary: (t: unknown, run?: string) => Promise<{ missingInstanceIds: string[] }> }).evaluateWorkflowMergeBoundary(live!, runId);
    expect(evaluation.missingInstanceIds).toEqual([ids[1], ids[2]]);
    await store.updateTask(task.id, { workflowStepResults: ids.map((id) => nodeResult(id)) });
    live = await store.getTask(task.id);
    await merge(executor, live!);
    live = await store.getTask(task.id);
    expect(live?.column).toBe("in-review");
    expect(live?.steps.every((step) => step.status === "done")).toBe(true);
  });

  it("blocks complete coverage when an unrelated pre-merge node result failed", async () => {
    const ids = [0, 1, 2].map((index) => instanceNodeId("steps", index, "step-execute"));
    const { store, task, executor } = await setup({ results: [...ids.map((id) => nodeResult(id)), nodeResult("unrelated", "failed")] });
    await merge(executor, task);
    const live = await store.getTask(task.id);
    expect(live?.column).not.toBe("in-review");
    expect(live?.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
  });

  it("keeps empty results as missing implementation proof for execute and foreach-without-seam workflows", async () => {
    for (const ir of [executeIr, foreachWithoutSeamIr]) {
      const { store, task, executor } = await setup({ ir, results: [] });
      const live = await store.getTask(task.id);
      expect(await proofFailure(executor, live!)).toContain("implementation did not run");
      await merge(executor, live!);
      const afterMerge = await store.getTask(task.id);
      expect(afterMerge?.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
    }
  });

  it("preserves non-foreach and resumed foreach merge behavior", async () => {
    const { store: executeStore, task: executeTask, executor: executeExecutor } = await setup({ ir: executeIr, results: [nodeResult("execute")] });
    await merge(executeExecutor, executeTask);
    let live = await executeStore.getTask(executeTask.id);
    expect(live?.column).toBe("in-review");
    expect(live?.steps.every((step) => step.status === "done")).toBe(true);
    await harness?.teardown(); harness = undefined;

    const id = instanceNodeId("steps", 2, "step-execute");
    const resumed = pendingSteps(); resumed[0] = { ...resumed[0], status: "done" }; resumed[1] = { ...resumed[1], status: "skipped" };
    const { store, task, executor } = await setup({ results: [nodeResult(id)], steps: resumed });
    await merge(executor, task);
    live = await store.getTask(task.id);
    expect(live?.column).toBe("in-review");
    expect(live?.steps.every((step) => step.status === "done" || step.status === "skipped")).toBe(true);
  });
});
