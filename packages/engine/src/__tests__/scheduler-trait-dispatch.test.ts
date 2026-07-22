/*
FNXC:WorkflowScheduling 2026-07-19-03:00:
U4 — the scheduler is the sole hold→wip mover, dispatch derives from traits, and
WIP accounting is trait-configured with a shared budget (KTD-2/KTD-9). These tests
exercise the hold/release sweep directly (the sole live dispatcher — the legacy
pull-from-todo path is dead behind the workflow-column runtime) and the pure
budget-set resolution.
*/
import { describe, expect, it, vi } from "vitest";
import { resolveWipBudgetColumns, evaluateCapacityRejection, type Task, type TaskStore, type WorkflowIr } from "@fusion/core";

import { runHoldReleaseSweep } from "../hold-release.js";

const WF = "custom:wf";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...over,
  } as Task;
}

/** Single-wip benchmark-shaped IR: todo(hold capacity) → in-progress(wip) → done. */
function singleWipIr(): WorkflowIr {
  return {
    version: "v2",
    name: "single-wip",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "exec", kind: "prompt", column: "in-progress" },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "exec" },
      { from: "exec", to: "end", condition: "success" },
    ],
  } as WorkflowIr;
}

/** Two wip columns sharing one maxConcurrent budget: todo → wip-a → wip-b → done. */
function twoWipIr(): WorkflowIr {
  return {
    version: "v2",
    name: "two-wip",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "wip-a", name: "WIP A", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "wip-b", name: "WIP B", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "a", kind: "prompt", column: "wip-a" },
      { id: "b", kind: "prompt", column: "wip-b" },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "a" },
      { from: "a", to: "b", condition: "success" },
      { from: "b", to: "end", condition: "success" },
    ],
  } as WorkflowIr;
}

function storeWith(tasks: Task[], ir: WorkflowIr, settings: Record<string, unknown> = {}): TaskStore {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const selection = { workflowId: WF, stepIds: [] as string[] };
  return {
    listTasks: vi.fn(async () => [...byId.values()]),
    getTask: vi.fn(async (id: string) => byId.get(id) ?? null),
    getSettings: vi.fn(async () => ({ maxConcurrent: 1, maxWorktrees: 4, ...settings })),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const cur = byId.get(id); if (cur) Object.assign(cur, patch); return cur as Task;
    }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const cur = byId.get(id); if (cur) cur.column = column; return cur as Task;
    }),
    moveTaskIf: vi.fn(async (id: string, column: Task["column"], predicate: (live: Task) => boolean | Promise<boolean>) => {
      const cur = byId.get(id)!;
      if (!await predicate(cur) || cur.column === column) return { task: cur, moved: false };
      cur.column = column;
      return { task: cur, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
    // No getTasksDir → isUnplannedForExecution returns false (cards are "planned").
  } as unknown as TaskStore;
}

// ── Pure budget-set resolution (KTD-9) ────────────────────────────────────────

describe("resolveWipBudgetColumns (KTD-9)", () => {
  it("pools every wip column sharing a limitSetting into one budget", () => {
    expect(new Set(resolveWipBudgetColumns(twoWipIr(), "wip-a"))).toEqual(new Set(["wip-a", "wip-b"]));
    expect(new Set(resolveWipBudgetColumns(twoWipIr(), "wip-b"))).toEqual(new Set(["wip-a", "wip-b"]));
  });

  it("keeps an explicit per-column limit independent (its own budget)", () => {
    const ir = twoWipIr();
    (ir as any).columns[1].traits[0].config = { limit: 3 }; // wip-a: explicit override
    expect(resolveWipBudgetColumns(ir, "wip-a")).toEqual(["wip-a"]);
    // wip-b still pools via the shared setting (only itself now).
    expect(resolveWipBudgetColumns(ir, "wip-b")).toEqual(["wip-b"]);
  });

  it("returns the single wip column for a single-wip workflow, and [] for a non-capacity column", () => {
    expect(resolveWipBudgetColumns(singleWipIr(), "in-progress")).toEqual(["in-progress"]);
    expect(resolveWipBudgetColumns(singleWipIr(), "todo")).toEqual([]);
  });
});

// ── Hold/release sweep: single mover + trait-derived capacity (KTD-2) ──────────

describe("hold/release sweep — capacity (U4)", () => {
  it("holds a Todo card while the wip column is saturated, then releases exactly once when a slot frees (scenario 1)", async () => {
    const held = task({ id: "H", column: "todo" });
    const occupant = task({ id: "O", column: "in-progress" });
    const store = storeWith([held, occupant], singleWipIr(), { maxConcurrent: 1 });

    const first = await runHoldReleaseSweep(store, { now: () => Date.now() });
    expect(first.released).toEqual([]); // saturated (1/1)
    expect(first.held.some((h) => h.taskId === "H" && h.reason === "downstream-full")).toBe(true);
    expect(store.moveTaskIf).not.toHaveBeenCalled();

    // Free the slot (occupant leaves in-progress) and sweep again.
    occupant.column = "done";
    const second = await runHoldReleaseSweep(store, { now: () => Date.now() });
    expect(second.released).toEqual(["H"]);
    expect(store.moveTaskIf).toHaveBeenCalledTimes(1);
    expect(store.moveTaskIf).toHaveBeenCalledWith("H", "in-progress", expect.any(Function), expect.anything());
  });

  it("counts a mid-transition (transitionPending) card toward the cap (scenario 2, countPending)", async () => {
    const held = task({ id: "H", column: "todo" });
    // A card still in todo but committed to move into in-progress holds the slot.
    const pending = task({ id: "P", column: "todo" });
    (pending as any).transitionPending = { toColumn: "in-progress" };
    const store = storeWith([held, pending], singleWipIr(), { maxConcurrent: 1 });

    const result = await runHoldReleaseSweep(store, { now: () => Date.now() });
    expect(result.released).not.toContain("H");
    expect(result.held.some((h) => h.taskId === "H" && h.reason === "downstream-full")).toBe(true);
  });

  it("shares one budget across two wip columns (scenario 3)", async () => {
    const held = task({ id: "H", column: "todo" });
    const inA = task({ id: "A", column: "wip-a" });
    const inB = task({ id: "B", column: "wip-b" });
    // maxConcurrent=2: wip-a(1) + wip-b(1) = 2 → pool full even though each column has 1.
    const store = storeWith([held, inA, inB], twoWipIr(), { maxConcurrent: 2 });

    const result = await runHoldReleaseSweep(store, { now: () => Date.now() });
    expect(result.released).not.toContain("H");
    expect(result.held.some((h) => h.taskId === "H" && h.reason === "downstream-full")).toBe(true);
    // Free a slot in the pool (B leaves wip-b → only one occupant) and sweep the
    // same store again: the card releases into the first wip column.
    inB.column = "done";
    const result2 = await runHoldReleaseSweep(store, { now: () => Date.now() });
    expect(result2.released).toEqual(["H"]);
    expect(store.moveTaskIf).toHaveBeenCalledTimes(1);
    expect(store.moveTaskIf).toHaveBeenCalledWith("H", "wip-a", expect.any(Function), expect.anything());
  });

  it("never releases a paused or user-paused card (scenario 5)", async () => {
    const paused = task({ id: "P", column: "todo", paused: true });
    const userPaused = task({ id: "U", column: "todo", userPaused: true });
    const store = storeWith([paused, userPaused], singleWipIr(), { maxConcurrent: 5 });

    const result = await runHoldReleaseSweep(store, { now: () => Date.now() });
    expect(result.released).toEqual([]);
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });
});

// ── No-hold workflow: in-txn validator capacity check is the only gate (scenario 4) ──

describe("no-hold workflow saturation (scenario 4)", () => {
  it("the sweep does not manage a wip column that has no upstream hold column", async () => {
    // A workflow whose wip column is entered directly (no hold): the sweep never
    // holds/releases it — the graph moves straight across and the in-txn capacity
    // check (moves.ts) is the sole gate. Assert the sweep is inert for such a card.
    const noHoldIr: WorkflowIr = {
      version: "v2",
      name: "no-hold",
      columns: [
        { id: "intake", name: "Intake", traits: [{ trait: "intake" }] },
        { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "intake" },
        { id: "exec", kind: "prompt", column: "in-progress" },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [{ from: "start", to: "exec" }, { from: "exec", to: "end", condition: "success" }],
    } as WorkflowIr;
    const card = task({ id: "N", column: "intake" });
    const store = storeWith([card], noHoldIr, { maxConcurrent: 1 });

    const result = await runHoldReleaseSweep(store, { now: () => Date.now() });
    // intake is not a hold column → not managed by the sweep at all.
    expect(result.released).toEqual([]);
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  it("the in-txn capacity policy rejects a move into a saturated shared pool (the gate for no-hold moves)", () => {
    // The mechanism the in-txn check uses: sum occupants across the budget set and
    // reject when the pooled limit is reached. Two wip columns, maxConcurrent=2,
    // both occupied → a third move is rejected (capacity-exhausted, retryable).
    const budget = resolveWipBudgetColumns(twoWipIr(), "wip-a");
    expect(new Set(budget)).toEqual(new Set(["wip-a", "wip-b"]));
    const rejection = evaluateCapacityRejection("wip-a", { limit: 2, occupants: 2 });
    expect(rejection?.code).toBe("capacity-exhausted");
    expect(rejection?.retryable).toBe(true);
  });
});
