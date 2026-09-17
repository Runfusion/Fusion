import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sortTasksForDisplayColumn,
  compareTasksByQueueOrder,
  type TaskQueueSortable,
} from "@fusion/core";
import { ProjectAdmissionCoordinator, type AdmissionCandidate } from "../concurrency/concurrency.js";

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509's integrated operator acceptance: several cards wait behind an occupied slot, the operator
boosts the NEWEST one, every view shows active-then-C/A/B, nothing starts until the slot frees, C is
then the first card actually selected, and a restart preserves that outcome.

This is deliberately ONE scenario across the display sorter and the real admission coordinator,
because the defect class it guards against is the two disagreeing: a board that shows one order while
the engine starts a different card is exactly the confusion the chronological queue removes.
*/

const PROJECT = "/repo";
const iso = (minutes: number): string => new Date(Date.UTC(2026, 8, 17, 10, minutes, 0)).toISOString();

const STAY = iso(0);
const boostOf = (sequence: string, column: string) => ({
  sequence,
  workflowId: "builtin:coding",
  column,
  columnEntryAt: STAY,
  requestId: `req-${sequence}`,
});

/** A (B) older, (A) middle, (C) newest trio waiting behind one active card. */
function board(boostedC = false): TaskQueueSortable[] {
  return [
    { id: "FN-ACTIVE", createdAt: iso(5), column: "in-progress", columnMovedAt: STAY },
    { id: "FN-B", createdAt: iso(10), column: "in-progress", columnMovedAt: STAY },
    { id: "FN-A", createdAt: iso(20), column: "in-progress", columnMovedAt: STAY },
    {
      id: "FN-C",
      createdAt: iso(30),
      column: "in-progress",
      columnMovedAt: STAY,
      ...(boostedC ? { queueBoost: boostOf("11", "in-progress") } : {}),
    },
  ];
}

const WIP_FLAGS = { countsTowardWip: true } as const;
const visibleOrder = (tasks: TaskQueueSortable[]): string[] =>
  sortTasksForDisplayColumn(tasks, "in-progress", {
    columnFlags: WIP_FLAGS,
    isActive: (candidate) => candidate.id === "FN-ACTIVE",
  }).map((task) => task.id);

function candidateFor(task: TaskQueueSortable, start: () => Promise<boolean | void>): AdmissionCandidate {
  return {
    taskId: task.id,
    projectId: PROJECT,
    lane: "execute",
    consumesWorktree: false,
    createdAt: task.createdAt,
    column: task.column!,
    columnMovedAt: task.columnMovedAt!,
    ...(task.queueBoost ? { queueBoost: task.queueBoost } : {}),
    start,
  };
}

describe("FN-509 operator acceptance: boost the newest card behind an occupied slot", () => {
  let coordinator: ProjectAdmissionCoordinator;
  beforeEach(() => {
    coordinator = new ProjectAdmissionCoordinator();
  });

  it("shows active-then-oldest-first before the boost", () => {
    expect(visibleOrder(board())).toEqual(["FN-ACTIVE", "FN-B", "FN-A", "FN-C"]);
  });

  it("shows active, then C ahead of A and B, after the boost", () => {
    expect(visibleOrder(board(true))).toEqual(["FN-ACTIVE", "FN-C", "FN-B", "FN-A"]);
  });

  it("starts nothing while the slot is still occupied, boosted or not", async () => {
    const started: string[] = [];
    const waiting = board(true).filter((task) => task.id !== "FN-ACTIVE");
    const admitted = await coordinator.admitNext({
      projectId: PROJECT,
      maxConcurrent: 1,
      claimed: () => 1,
      refresh: async () => waiting.map((task) => candidateFor(task, async () => { started.push(task.id); })),
    });
    expect(admitted).toBeUndefined();
    expect(started).toEqual([]);
  });

  it("selects the boosted card first once the slot frees, matching the visible order", async () => {
    const started: string[] = [];
    const waiting = board(true).filter((task) => task.id !== "FN-ACTIVE");
    const admitted = await coordinator.admitNext({
      projectId: PROJECT,
      maxConcurrent: 1,
      claimed: () => 0,
      refresh: async () => waiting.map((task) => candidateFor(task, async () => { started.push(task.id); })),
    });
    expect(admitted).toBe("FN-C");
    expect(started).toEqual(["FN-C"]);
    // The engine's choice is the head of what the board displayed behind the active card.
    expect(visibleOrder(board(true))[1]).toBe("FN-C");
  });

  it("survives a restart, because the rank lives on the task rather than in memory", async () => {
    // A fresh coordinator models the process restarting with no in-memory state at all.
    const restarted = new ProjectAdmissionCoordinator();
    const waiting = board(true).filter((task) => task.id !== "FN-ACTIVE");
    const admitted = await restarted.admitNext({
      projectId: PROJECT,
      maxConcurrent: 1,
      claimed: () => 0,
      refresh: async () => waiting.map((task) => candidateFor(task, async () => true)),
    });
    expect(admitted).toBe("FN-C");
  });

  it("falls back to B, the oldest, once C's boost scope ends with a column move", async () => {
    const moved = board(true).map((task) => task.id === "FN-C" ? { ...task, columnMovedAt: iso(45) } : task);
    expect(visibleOrder(moved)).toEqual(["FN-ACTIVE", "FN-B", "FN-A", "FN-C"]);

    const waiting = moved.filter((task) => task.id !== "FN-ACTIVE");
    const admitted = await coordinator.admitNext({
      projectId: PROJECT,
      maxConcurrent: 1,
      claimed: () => 0,
      refresh: async () => waiting.map((task) => candidateFor(task, async () => true)),
    });
    expect(admitted).toBe("FN-B");
  });

  it("renders Ideas newest-first and Complete by most recent arrival in the same board", () => {
    const ideas = [
      { id: "FN-1", createdAt: iso(0), column: "ideas" },
      { id: "FN-9", createdAt: iso(40), column: "ideas" },
    ];
    expect(
      sortTasksForDisplayColumn(ideas, "ideas", { columnFlags: { intake: true, manualIntake: true } }).map((t) => t.id),
    ).toEqual(["FN-9", "FN-1"]);

    const done = [
      { id: "FN-OLD-ARRIVAL", createdAt: iso(50), column: "done", columnMovedAt: iso(10) },
      { id: "FN-NEW-ARRIVAL", createdAt: iso(0), column: "done", columnMovedAt: iso(55) },
    ];
    expect(
      sortTasksForDisplayColumn(done, "done", { columnFlags: { complete: true } }).map((t) => t.id),
    ).toEqual(["FN-NEW-ARRIVAL", "FN-OLD-ARRIVAL"]);
  });

  it("keeps the comparator and the coordinator agreeing on the same pair", () => {
    const [, b, , c] = board(true);
    // Boosted C leads older B in the comparator …
    expect(compareTasksByQueueOrder(c!, b!)).toBeLessThan(0);
    // … which is exactly what the admission pass above selected.
    expect(visibleOrder(board(true)).indexOf("FN-C")).toBeLessThan(visibleOrder(board(true)).indexOf("FN-B"));
  });

  it("does not let a boost reorder the active card itself", () => {
    const bothActive = board(true);
    const sorted = sortTasksForDisplayColumn(bothActive, "in-progress", {
      columnFlags: WIP_FLAGS,
      isActive: (candidate) => candidate.id === "FN-ACTIVE" || candidate.id === "FN-C",
    }).map((task) => task.id);
    // Two active cards order by arrival between themselves; the boost does not promote C over ACTIVE.
    expect(sorted.slice(0, 2)).toEqual(["FN-ACTIVE", "FN-C"]);
  });
});

/* A refusal must not silently consume the slot; the next admissible card still starts. */
describe("FN-509 acceptance: a blocked boosted card yields to the next admissible candidate", () => {
  it("walks past the boosted card whose lane declines, then starts the oldest", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    const started: string[] = [];
    const waiting = board(true).filter((task) => task.id !== "FN-ACTIVE");
    const declining = vi.fn(async () => false);

    const admitted = await coordinator.admitNext({
      projectId: PROJECT,
      maxConcurrent: 5,
      claimed: () => 0,
      refresh: async () => waiting.map((task) =>
        candidateFor(task, task.id === "FN-C" ? declining : async () => { started.push(task.id); })),
    });

    expect(declining).toHaveBeenCalledOnce();
    expect(admitted).toBe("FN-B");
    expect(started).toEqual(["FN-B"]);
  });
});
