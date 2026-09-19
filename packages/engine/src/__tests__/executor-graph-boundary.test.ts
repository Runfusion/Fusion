/*
FNXC:WorkflowMerge 2026-07-19-05:20:
U5a scenario 1 — the workflow merge boundary lands the card in the merge NODE's
OWN IR column, not a hardcoded "in-review":
  - builtin:coding places its merge-class nodes in `in-review` → the default
    pipeline lands in `in-review` (KTD-7 parity), byte-identical to before.
  - a user-authored workflow (the benchmark) places the merge node in `Merging`
    → the card lands in `Merging` because the IR says so.
These call the executor's merge-boundary resolution directly (via `as any`) so the
assertion does not depend on the full agent-session execute() path.
*/
import { describe, expect, it, vi } from "vitest";
/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2):
These call-arg assertions now include the mutation context the converted sweep passes.
Adding it is what keeps them load-bearing: left at the old arity every
`toHaveBeenCalledWith` here would fail, and every `.not.toHaveBeenCalledWith` would pass
vacuously — an assertion that can no longer fail is worse than one that is red.
*/
/* FNXC:Identity 2026-08-09-03:04 (U18/KTD2 Stage C): the merge boundary derives the executor lane instead of marking, so the assertion pins the DERIVED actor — re-marking this site now fails. */
import { mutationContextFor } from "./mutation-context-matchers.js";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore } from "./executor-test-helpers.js";
import type { WorkflowIr } from "@fusion/core";
/* FNXC:Identity 2026-08-09-03:04 (U18/KTD2 Stage C): the executor threads a real mutation context to every store call, so these assertions pin it rather than accepting `undefined`. */
import { ANY_MUTATION_CONTEXT } from "./mutation-context-matchers.js";

function benchmarkIr(): WorkflowIr {
  return {
    version: "v2",
    name: "benchmark",
    columns: [
      { id: "in-review", name: "In review", traits: [{ trait: "human-review" }] },
      { id: "merging", name: "Merging", traits: [{ trait: "merge" }, { trait: "merge-blocker" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "in-review" },
      { id: "merge-gate", kind: "merge-gate", column: "merging", config: { gate: "auto-merge" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "merge-gate" },
      { from: "merge-gate", to: "end", condition: "success" },
    ],
  } as WorkflowIr;
}

function foreachIr(): WorkflowIr {
  return {
    version: "v2",
    columns: [{ id: "in-review", name: "In review", traits: [{ trait: "merge" }] }],
    nodes: [{
      id: "steps",
      kind: "foreach",
      config: {
        source: "task-steps",
        template: { nodes: [{ id: "step-execute", kind: "prompt", config: { seam: "step-execute" } }], edges: [] },
      },
    }],
    edges: [],
  } as WorkflowIr;
}

function executeIr(): WorkflowIr {
  return {
    version: "v2",
    name: "execute then merge",
    columns: [
      { id: "in-progress", name: "In progress", traits: [] },
      { id: "in-review", name: "In review", traits: [{ trait: "merge" }, { trait: "merge-blocker" }] },
    ],
    nodes: [
      { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
      { id: "merge", kind: "merge-gate", column: "in-review" },
    ],
    edges: [{ from: "execute", to: "merge", condition: "success" }],
  } as WorkflowIr;
}

function makeExecutor(opts: {
  selection?: { workflowId: string; stepIds: string[] };
  ir?: WorkflowIr;
  taskColumn?: string;
  steps?: Array<{ id: string; title: string; status: "pending" | "done" | "skipped" }>;
  workflowStepResults?: Array<{
    workflowStepId: string;
    workflowStepName: string;
    source: "node";
    phase: "pre-merge";
    status: "passed" | "pending";
    completedAt: string;
  }>;
}) {
  const store = createMockStore() as unknown as Record<string, unknown>;
  const liveTask = {
    id: "FN-B1",
    title: "t",
    description: "",
    column: opts.taskColumn ?? "in-review",
    dependencies: [],
    steps: opts.steps ?? [],
    workflowStepResults: opts.workflowStepResults,
    currentStep: 0,
    log: [],
    prompt: "# t",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.getTask = vi.fn().mockResolvedValue(liveTask);
  store.getTaskWorkflowSelection = vi.fn(() => opts.selection);
  store.getTaskWorkflowSelectionAsync = vi.fn(async () => opts.selection);
  store.getWorkflowDefinition = vi.fn(async () => (opts.ir ? { ir: opts.ir } : undefined));
  const executor = new TaskExecutor(store as never, "/tmp/exec-boundary");
  return { executor: executor as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>, store, liveTask };
}

describe("U5a — IR-driven merge boundary (scenario 1)", () => {
  it("resolves the merge column to the benchmark merge node's own column (Merging)", async () => {
    const { executor } = makeExecutor({ selection: { workflowId: "custom:benchmark", stepIds: [] }, ir: benchmarkIr() });
    const column = await executor.resolveMergeBoundaryColumn("FN-B1", "merge-gate");
    expect(column).toBe("merging");
  });

  it("resolves the merge column to `in-review` for builtin:coding (KTD-7 parity)", async () => {
    // No selection → resolveWorkflowIrForTask falls back to builtin:coding, whose
    // merge-class nodes live in `in-review`.
    const { executor } = makeExecutor({ selection: undefined });
    const column = await executor.resolveMergeBoundaryColumn("FN-B1", "merge-gate");
    expect(column).toBe("in-review");
  });

  it("falls back to the first merge-class node's column when the named node id is synthetic/unknown", async () => {
    const { executor } = makeExecutor({ selection: { workflowId: "custom:benchmark", stepIds: [] }, ir: benchmarkIr() });
    // The legacy merge seam passes a synthetic id ("legacy-merge-seam") that is not
    // in the IR — resolution keys on merge-class kinds, landing in `merging`.
    const column = await executor.resolveMergeBoundaryColumn("FN-B1", "legacy-merge-seam");
    expect(column).toBe("merging");
  });

  it("moves the card to the benchmark merge column (Merging), not in-review", async () => {
    const { executor, store } = makeExecutor({
      selection: { workflowId: "custom:benchmark", stepIds: [] },
      ir: benchmarkIr(),
      taskColumn: "in-review", // arrived from review; must advance to Merging
    });
    await executor.ensureWorkflowMergeBoundaryTask(
      { id: "FN-B1", column: "in-review", steps: [] },
      { reason: "workflow-merge-boundary", nodeId: "merge-gate", workflowId: "custom:benchmark", runId: "r1" },
    );
    const moveTask = store.moveTask as ReturnType<typeof vi.fn>;
    expect(moveTask).toHaveBeenCalledWith("FN-B1", "merging", expect.anything(), mutationContextFor("executor"));
  });

  it("is a no-op when the card is already in the resolved merge column", async () => {
    const { executor, store } = makeExecutor({
      selection: { workflowId: "custom:benchmark", stepIds: [] },
      ir: benchmarkIr(),
      taskColumn: "merging",
    });
    await executor.ensureWorkflowMergeBoundaryTask(
      { id: "FN-B1", column: "merging", steps: [] },
      { reason: "workflow-merge-boundary", nodeId: "merge-gate", workflowId: "custom:benchmark", runId: "r1" },
    );
    const moveTask = store.moveTask as ReturnType<typeof vi.fn>;
    expect(moveTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:WorkflowLifecycle 2026-07-26-22:59:
  Successful pre-merge proof must still project graph-native results onto legacy steps after review handoff has already moved the card into the merge column; the projection must not trigger a redundant move.
  */
  it("projects graph-native completion after review handoff already moved the card to the merge column", async () => {
    const pendingSteps = [
      { id: "0", title: "Preflight", status: "pending" as const },
      { id: "1", title: "Implement", status: "pending" as const },
    ];
    const { executor, store, liveTask } = makeExecutor({
      selection: { workflowId: "custom:execute", stepIds: [] },
      ir: executeIr(),
      taskColumn: "in-review",
      steps: pendingSteps,
      workflowStepResults: [{
        workflowStepId: "execute",
        workflowStepName: "Execute",
        source: "node",
        phase: "pre-merge",
        status: "passed",
        completedAt: new Date().toISOString(),
      }],
    });

    await executor.ensureWorkflowMergeBoundaryTask(
      liveTask,
      { reason: "workflow-merge-boundary", nodeId: "merge", workflowId: "custom:execute", runId: "r1" },
    );

    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-B1",
      {
        steps: pendingSteps.map((step) => ({ ...step, status: "done" })),
        currentStep: 1,
      },
      ANY_MUTATION_CONTEXT,
    );
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:WorkflowMerge 2026-08-20-00:50:
  FN-9157 regression: Review Level 0 deliberately supplies no optional node
  results, so terminal step-execute coverage must admit the same merge handoff.
  */
  it.each([[], undefined] as const)("admits fully terminal foreach coverage without node results (%j)", async (workflowStepResults) => {
    const doneSteps = [
      { id: "0", title: "Preflight", status: "done" as const },
      { id: "1", title: "Implement", status: "done" as const },
    ];
    const { executor, store, liveTask } = makeExecutor({
      selection: { workflowId: "custom:foreach", stepIds: [] },
      ir: foreachIr(),
      taskColumn: "in-progress",
      steps: doneSteps,
      workflowStepResults: workflowStepResults as never,
    });
    const result = await executor.ensureWorkflowMergeBoundaryTask(
      liveTask,
      { reason: "workflow-merge-boundary", nodeId: "merge", workflowId: "custom:foreach", runId: "r1" },
    ) as { task: { column: string }; blocked?: { reason: string } };
    expect(result.blocked).toBeUndefined();
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-B1", expect.stringContaining("Workflow merge boundary blocked:"), expect.anything(), expect.anything());
    expect(store.moveTask).toHaveBeenCalledWith("FN-B1", "in-review", expect.anything());
  });

  it("maps each incomplete merge-boundary proof to a redacted audit code", async () => {
    const cases = [
      {
        steps: [{ id: "0", title: "Implement", status: "pending" as const }],
        workflowStepResults: [],
        code: "no-node-result",
        missingInstanceCount: 1,
      },
      {
        steps: [{ id: "0", title: "Implement", status: "pending" as const }],
        workflowStepResults: [{ workflowStepId: "review", workflowStepName: "Review", source: "node" as const, phase: "pre-merge" as const, status: "pending" as const, completedAt: "2026-01-01" }],
        code: "non-terminal-node-result",
        missingInstanceCount: 1,
      },
      {
        steps: [{ id: "0", title: "Implement", status: "pending" as const }],
        workflowStepResults: [{ workflowStepId: "review", workflowStepName: "Review", source: "node" as const, phase: "pre-merge" as const, status: "passed" as const, completedAt: "2026-01-01" }],
        code: "missing-foreach-instances",
        missingInstanceCount: 1,
      },
    ];
    for (const { steps, workflowStepResults, code, missingInstanceCount } of cases) {
      const { executor, liveTask } = makeExecutor({
        selection: { workflowId: "custom:foreach", stepIds: [] }, ir: foreachIr(), steps, workflowStepResults,
      });
      const result = await executor.ensureWorkflowMergeBoundaryTask(
        liveTask,
        { reason: "workflow-merge-boundary", nodeId: "merge", workflowId: "custom:foreach", runId: "r1" },
      ) as { blocked?: { code: string; missingInstanceCount: number } };
      expect(result.blocked).toMatchObject({ code, missingInstanceCount });
    }
  });
});
