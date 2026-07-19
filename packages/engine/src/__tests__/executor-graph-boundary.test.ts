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
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore } from "./executor-test-helpers.js";
import type { WorkflowIr } from "@fusion/core";

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

function makeExecutor(opts: { selection?: { workflowId: string; stepIds: string[] }; ir?: WorkflowIr; taskColumn?: string }) {
  const store = createMockStore() as unknown as Record<string, unknown>;
  const liveTask = {
    id: "FN-B1",
    title: "t",
    description: "",
    column: opts.taskColumn ?? "in-review",
    dependencies: [],
    steps: [],
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
    expect(moveTask).toHaveBeenCalledWith("FN-B1", "merging", expect.anything());
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
});
