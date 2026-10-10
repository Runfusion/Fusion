/*
FNXC:ColumnCapacity 2026-10-10-19:55 (RUFU-362):
The hold/release sweep keeps its OWN mirror of the store's in-txn capacity count, and its header
comment has always claimed "same counting rule as the in-txn check". Until RUFU-362 that claim was
false in one direction: `countCapacitySlot` counted every non-deleted row in the budget columns,
while FN-8704 had already ruled that a `status:"failed"` park is operator-visible debris rather than
a live capacity holder. The two counters therefore agreed with each other and disagreed with the
ruling, which is exactly how production project saneca froze: three failed rows in a WIP limit of 3,
live WIP 0, and every ready card held `downstream-full` forever (294 graph suspends on
waitReason:"capacity" in 30 minutes, zero board-wide moves).

These tests pin the mirror against the predicate rather than against a comment: a failed occupant
must NOT produce `downstream-full`, a live occupant MUST still produce it (over-admission is the
other failure mode and costs worktree contention), and a mixed lane at the limit MUST still hold.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { runHoldReleaseSweep, resetHoldReleaseInstrumentation } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:wf";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    // A planned prompt stating no premises is vacuously satisfied, so the plan-premise gate
    // never substitutes itself for the capacity question under test.
    prompt: "# Planned\n\n## Mission\nImplement the approved work.\n",
    ...over,
  } as Task;
}

/** The Coding (Ideas) shape: a capacity hold on todo releasing into one WIP-limited column. */
function singleWipIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      {
        id: "in-progress",
        label: "In Progress",
        traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }],
      },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function storeWith(tasks: Task[], ir: WorkflowIr, settings: Record<string, unknown>): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  return {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => tasks),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const cur = tasks.find((t) => t.id === id)!;
      cur.column = column;
      return { task: cur, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
  } as unknown as TaskStore;
}

function clock(startMs = 1_000_000) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** True when the sweep held the card specifically because it believed the lane was full. */
function heldDownstreamFull(result: { held: Array<{ taskId: string; reason: string }> }, taskId: string): boolean {
  return result.held.some((h) => h.taskId === taskId && h.reason === "downstream-full");
}

describe("hold/release sweep: a failed park does not occupy a column WIP slot", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
  });

  it("releases a ready card into a lane whose only occupant is a failed park", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const contender = task({ id: "READY", column: "todo" });
    const deadPark = task({ id: "DEAD", column: "in-progress", status: "failed" });
    const store = storeWith([contender, deadPark], singleWipIr(), { maxConcurrent: 1 });

    const result = await runHoldReleaseSweep(store, { now: clock().now });

    expect(heldDownstreamFull(result, "READY")).toBe(false);
    expect(result.released).toContain("READY");
    expect(contender.column).toBe("in-progress");
    // The debris rule from FN-8704: the dead row stays in the lane for the operator.
    expect(deadPark.column).toBe("in-progress");
  });

  it("still holds the same card when the occupant is live (negative proof against over-admission)", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const contender = task({ id: "READY", column: "todo" });
    const liveOccupant = task({ id: "LIVE", column: "in-progress", status: null });
    const store = storeWith([contender, liveOccupant], singleWipIr(), { maxConcurrent: 1 });

    const result = await runHoldReleaseSweep(store, { now: clock().now });

    expect(heldDownstreamFull(result, "READY")).toBe(true);
    expect(result.released).toEqual([]);
    expect(contender.column).toBe("todo");
  });

  it("holds at the limit when a live occupant fills the lane alongside failed parks", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const contender = task({ id: "READY", column: "todo" });
    const liveOccupant = task({ id: "LIVE", column: "in-progress", status: null });
    const deadParks = [
      task({ id: "DEAD-1", column: "in-progress", status: "failed" }),
      task({ id: "DEAD-2", column: "in-progress", status: "failed" }),
    ];
    const store = storeWith([contender, liveOccupant, ...deadParks], singleWipIr(), { maxConcurrent: 1 });

    const result = await runHoldReleaseSweep(store, { now: clock().now });

    // One live row is the whole budget: the parks neither add nor subtract.
    expect(heldDownstreamFull(result, "READY")).toBe(true);
    expect(result.released).toEqual([]);
  });

  it("admits when live occupancy drops below the limit even though failed parks outnumber it", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const contender = task({ id: "READY", column: "todo" });
    const liveOccupant = task({ id: "LIVE", column: "in-progress", status: null });
    const deadParks = [
      task({ id: "DEAD-1", column: "in-progress", status: "failed" }),
      task({ id: "DEAD-2", column: "in-progress", status: "failed" }),
    ];
    const store = storeWith([contender, liveOccupant, ...deadParks], singleWipIr(), { maxConcurrent: 2 });

    const result = await runHoldReleaseSweep(store, { now: clock().now });

    expect(heldDownstreamFull(result, "READY")).toBe(false);
    expect(result.released).toContain("READY");
    expect(contender.column).toBe("in-progress");
  });

  it("does not let a failed park reserve a slot through a transitionPending marker", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const contender = task({ id: "READY", column: "todo" });
    // A dead row mid-transition INTO the budget column: it holds neither kind of slot.
    const deadMidTransition = task({
      id: "DEAD-TP",
      column: "done",
      status: "failed",
      transitionPending: { toColumn: "in-progress" },
    } as Partial<Task>);
    const store = storeWith([contender, deadMidTransition], singleWipIr(), { maxConcurrent: 1 });

    const result = await runHoldReleaseSweep(store, { now: clock().now });

    expect(heldDownstreamFull(result, "READY")).toBe(false);
    expect(result.released).toContain("READY");
  });
});
