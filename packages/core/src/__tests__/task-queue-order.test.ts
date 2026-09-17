import { describe, expect, it } from "vitest";
import {
  compareQueueBoostSequence,
  compareTasksByCompleteArrival,
  compareTasksByIntakeDisplayOrder,
  compareTasksByQueueOrder,
  isTaskQueueBoost,
  normalizeTaskQueueBoost,
  resolveEffectiveQueueBoost,
  resolveQueuePresence,
  resolveTaskColumnEntryAt,
  sortTasksByQueueOrder,
  sortTasksForDisplayColumn,
  type TaskQueueBoost,
  type TaskQueueSortable,
} from "../tasks/task-queue-order.js";

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509's behavioural contract for the shared queue order. These cases exist because the old
priority comparator is deleted: a fixture still carrying `priority: "urgent"` must have NO effect
on the result, and a boost must be scoped to one stay rather than becoming a permanent rank.
*/

const iso = (minutes: number): string => new Date(Date.UTC(2026, 8, 17, 10, minutes, 0)).toISOString();

function task(
  id: string,
  createdAt: string,
  extra: Partial<TaskQueueSortable> & { priority?: string } = {},
): TaskQueueSortable {
  return { id, createdAt, column: "todo", ...extra } as TaskQueueSortable;
}

function boost(sequence: string, overrides: Partial<TaskQueueBoost> = {}): TaskQueueBoost {
  return {
    sequence,
    workflowId: "builtin:coding",
    column: "todo",
    columnEntryAt: iso(0),
    requestId: `req-${sequence}`,
    ...overrides,
  };
}

describe("queue order — arrival is creation, never anything else", () => {
  it("orders oldest-first and ignores array order", () => {
    const tasks = [task("FN-10", iso(30)), task("FN-2", iso(10)), task("FN-7", iso(20))];
    expect(sortTasksByQueueOrder(tasks).map((t) => t.id)).toEqual(["FN-2", "FN-7", "FN-10"]);
  });

  it("never mutates its input", () => {
    const tasks = [task("FN-3", iso(30)), task("FN-1", iso(10))];
    const snapshot = tasks.map((t) => t.id);
    sortTasksByQueueOrder(tasks);
    expect(tasks.map((t) => t.id)).toEqual(snapshot);
  });

  it("breaks an exact createdAt tie by numeric id suffix, so FN-2 precedes FN-10", () => {
    const tasks = [task("FN-10", iso(5)), task("FN-2", iso(5))];
    expect(sortTasksByQueueOrder(tasks).map((t) => t.id)).toEqual(["FN-2", "FN-10"]);
  });

  it("ignores a legacy priority value entirely", () => {
    const tasks = [
      task("FN-9", iso(40), { priority: "urgent" }),
      task("FN-1", iso(10), { priority: "low" }),
    ];
    expect(sortTasksByQueueOrder(tasks).map((t) => t.id)).toEqual(["FN-1", "FN-9"]);
  });

  it("sorts missing/invalid timestamps after valid ones, stably by id", () => {
    const tasks = [
      task("FN-5", "not-a-date"),
      task("FN-4", iso(50)),
      task("FN-3", ""),
    ];
    expect(sortTasksByQueueOrder(tasks).map((t) => t.id)).toEqual(["FN-4", "FN-3", "FN-5"]);
  });

  it("does not let updatedAt or a column re-entry rejuvenate a task", () => {
    const old = task("FN-1", iso(0), { updatedAt: iso(59), columnMovedAt: iso(59) });
    const recent = task("FN-2", iso(30));
    expect(compareTasksByQueueOrder(old, recent)).toBeLessThan(0);
  });
});

describe("boost sequence ordering", () => {
  it("compares decimal strings numerically beyond MAX_SAFE_INTEGER", () => {
    expect(compareQueueBoostSequence("9007199254740993", "9007199254740992")).toBeGreaterThan(0);
    expect(compareQueueBoostSequence("10", "9")).toBeGreaterThan(0);
    expect(compareQueueBoostSequence("0007", "7")).toBe(0);
  });

  it("puts boosted cards ahead of unboosted ones, latest boost at the head", () => {
    const a = task("FN-1", iso(0));
    const b = task("FN-2", iso(10), { columnMovedAt: iso(0), queueBoost: boost("5") });
    const c = task("FN-3", iso(20), { columnMovedAt: iso(0), queueBoost: boost("9") });
    expect(sortTasksByQueueOrder([a, b, c]).map((t) => t.id)).toEqual(["FN-3", "FN-2", "FN-1"]);
  });

  it("lets a second click on A reclaim the head from B", () => {
    const a = task("FN-1", iso(0), { columnMovedAt: iso(0), queueBoost: boost("3") });
    const b = task("FN-2", iso(10), { columnMovedAt: iso(0), queueBoost: boost("4") });
    expect(sortTasksByQueueOrder([a, b]).map((t) => t.id)).toEqual(["FN-2", "FN-1"]);
    const aAgain = { ...a, queueBoost: boost("5") };
    expect(sortTasksByQueueOrder([aAgain, b]).map((t) => t.id)).toEqual(["FN-1", "FN-2"]);
  });
});

describe("boost scope — one stay in one column of one workflow", () => {
  it("stays effective across phases of the same stay", () => {
    const planning = task("FN-1", iso(0), { columnMovedAt: iso(0), status: "planning", queueBoost: boost("2") });
    expect(resolveEffectiveQueueBoost(planning)).not.toBeNull();
    const waiting = { ...planning, status: "queued" };
    expect(resolveEffectiveQueueBoost(waiting)).not.toBeNull();
  });

  it("is inert after a column move", () => {
    const moved = task("FN-1", iso(0), { column: "in-progress", columnMovedAt: iso(0), queueBoost: boost("2") });
    expect(resolveEffectiveQueueBoost(moved)).toBeNull();
  });

  it("does not resurrect after A -> B -> A, because the stay marker changed", () => {
    const backInA = task("FN-1", iso(0), {
      column: "todo",
      columnMovedAt: iso(45),
      queueBoost: boost("2", { columnEntryAt: iso(0) }),
    });
    expect(resolveEffectiveQueueBoost(backInA)).toBeNull();
  });

  it("is inert after a workflow change", () => {
    const t = task("FN-1", iso(0), { columnMovedAt: iso(0), queueBoost: boost("2") });
    expect(resolveEffectiveQueueBoost(t, { workflowId: "builtin:coding" })).not.toBeNull();
    expect(resolveEffectiveQueueBoost(t, { workflowId: "WF-003" })).toBeNull();
  });

  it("treats structurally invalid legacy data as no boost, never as a valid boost", () => {
    expect(normalizeTaskQueueBoost({ sequence: 5 })).toBeNull();
    expect(normalizeTaskQueueBoost("urgent")).toBeNull();
    expect(normalizeTaskQueueBoost(null)).toBeNull();
    expect(isTaskQueueBoost({ ...boost("1"), sequence: "" })).toBe(false);
    expect(isTaskQueueBoost({ ...boost("1"), requestId: "" })).toBe(false);
  });

  it("resolves the stay marker from columnMovedAt, falling back to createdAt", () => {
    expect(resolveTaskColumnEntryAt({ createdAt: iso(1), columnMovedAt: iso(9) })).toBe(iso(9));
    expect(resolveTaskColumnEntryAt({ createdAt: iso(1) })).toBe(iso(1));
  });
});

describe("display order per column role", () => {
  const manualIntake = { intake: true, manualIntake: true } as const;
  const complete = { complete: true } as const;
  const wip = { countsTowardWip: true } as const;

  it("shows manual intake newest-first with a descending id tiebreak", () => {
    const tasks = [task("FN-1", iso(0)), task("FN-3", iso(20)), task("FN-2", iso(20))];
    expect(
      sortTasksForDisplayColumn(tasks, "ideas", { columnFlags: manualIntake }).map((t) => t.id),
    ).toEqual(["FN-3", "FN-2", "FN-1"]);
  });

  it("keeps Complete on arrival order, not creation order", () => {
    const tasks = [
      task("FN-1", iso(0), { columnMovedAt: iso(50) }),
      task("FN-2", iso(30), { columnMovedAt: iso(10) }),
    ];
    expect(
      sortTasksForDisplayColumn(tasks, "done", { columnFlags: complete }).map((t) => t.id),
    ).toEqual(["FN-1", "FN-2"]);
    expect(compareTasksByCompleteArrival(tasks[0]!, tasks[1]!)).toBeLessThan(0);
  });

  it("puts active cards first, then the whole queue in Boost/FIFO order", () => {
    const active = task("FN-9", iso(55));
    const oldest = task("FN-1", iso(0));
    const boosted = task("FN-8", iso(50), { column: "in-progress", columnMovedAt: iso(0), queueBoost: boost("7", { column: "in-progress" }) });
    const sorted = sortTasksForDisplayColumn([oldest, boosted, active], "in-progress", {
      columnFlags: wip,
      isActive: (t) => t.id === "FN-9",
    });
    expect(sorted.map((t) => t.id)).toEqual(["FN-9", "FN-8", "FN-1"]);
  });

  it("does not let a boost reorder active cards among themselves", () => {
    const a = task("FN-1", iso(0), { columnMovedAt: iso(0), queueBoost: boost("1") });
    const b = task("FN-2", iso(10), { columnMovedAt: iso(0), queueBoost: boost("99") });
    const sorted = sortTasksForDisplayColumn([b, a], "in-progress", {
      columnFlags: wip,
      isActive: () => true,
    });
    expect(sorted.map((t) => t.id)).toEqual(["FN-1", "FN-2"]);
  });

  it("orders manual intake deterministically for zero and one card", () => {
    expect(sortTasksForDisplayColumn([], "ideas", { columnFlags: manualIntake })).toEqual([]);
    const single = [task("FN-1", iso(0))];
    expect(sortTasksForDisplayColumn(single, "ideas", { columnFlags: manualIntake }).map((t) => t.id)).toEqual(["FN-1"]);
  });

  it("matches compareTasksByIntakeDisplayOrder for equal timestamps", () => {
    expect(compareTasksByIntakeDisplayOrder(task("FN-2", iso(5)), task("FN-10", iso(5)))).toBeGreaterThan(0);
  });
});

describe("queue presence and Boost availability", () => {
  const live = { isActive: false } as const;

  it("offers Boost on a waiting planning card", () => {
    const verdict = resolveQueuePresence({ ...live, column: "todo", columnFlags: { hold: true } });
    expect(verdict).toEqual({ hasQueue: true, boostAvailable: true, reason: null });
  });

  it("offers Boost on a waiting WIP card even when it is blocked", () => {
    expect(
      resolveQueuePresence({ ...live, column: "in-progress", columnFlags: { countsTowardWip: true } }).boostAvailable,
    ).toBe(true);
  });

  it("withholds Boost on an actively worked card but still reports a queue", () => {
    const verdict = resolveQueuePresence({
      column: "in-progress",
      columnFlags: { countsTowardWip: true },
      isActive: true,
    });
    expect(verdict).toEqual({ hasQueue: true, boostAvailable: false, reason: "active" });
  });

  it("withholds Boost on manual intake, Complete, historical and deleted cards", () => {
    expect(resolveQueuePresence({ ...live, column: "ideas", columnFlags: { intake: true, manualIntake: true } }).reason).toBe("manual-intake");
    expect(resolveQueuePresence({ ...live, column: "done", columnFlags: { complete: true } }).reason).toBe("complete");
    expect(resolveQueuePresence({ ...live, column: "todo", columnFlags: { hold: true }, isHistorical: true }).reason).toBe("historical");
    expect(resolveQueuePresence({ ...live, column: "todo", columnFlags: { hold: true }, isDeleted: true }).reason).toBe("deleted");
  });

  it("withholds Boost when column metadata is unresolved rather than assuming permission", () => {
    const verdict = resolveQueuePresence({ ...live, column: "mystery", columnFlags: undefined });
    expect(verdict).toEqual({ hasQueue: false, boostAvailable: false, reason: "unresolved" });
  });

  it("withholds Boost in a review lane that is a purely human wait after auto-merge is off", () => {
    expect(
      resolveQueuePresence({
        ...live,
        column: "in-review",
        columnFlags: { mergeBlocker: true },
        autoMergeEnabled: false,
      }).reason,
    ).toBe("human-only-wait");
  });

  it("keeps Boost in a review lane with auto-merge off while an automatic review still has to run", () => {
    expect(
      resolveQueuePresence({
        ...live,
        column: "in-review",
        columnFlags: { mergeBlocker: true },
        autoMergeEnabled: false,
        hasRemainingAutomaticReview: true,
      }).boostAvailable,
    ).toBe(true);
  });

  it("withholds Boost in a column with no automatic processing at all", () => {
    expect(
      resolveQueuePresence({ ...live, column: "parking", columnFlags: { humanReview: false } }).reason,
    ).toBe("no-automatic-processing");
  });
});
