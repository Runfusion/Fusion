import { describe, it, expect } from "vitest";
import { groupByWorktree, getWorktreeLabel } from "../worktreeGrouping";
import type { Task } from "@fusion/core";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("getWorktreeLabel", () => {
  it("extracts last path segment", () => {
    expect(getWorktreeLabel(".worktrees/FN-001")).toBe("FN-001");
    expect(getWorktreeLabel("/path/to/kb/kb-001")).toBe("kb-001");
  });

  it("extracts humanized worktree names", () => {
    expect(getWorktreeLabel(".worktrees/swirly-monkey")).toBe("swirly-monkey");
    expect(getWorktreeLabel("/tmp/project/.worktrees/quiet-falcon")).toBe("quiet-falcon");
    expect(getWorktreeLabel("C:\\repo\\.worktrees\\quiet-falcon")).toBe("quiet-falcon");
    expect(getWorktreeLabel(".worktrees/bright-orchid-2")).toBe("bright-orchid-2");
  });
});

describe("groupByWorktree", () => {
  it("groups active in-progress tasks by worktree", () => {
    const t1 = makeTask({ id: "FN-001", worktree: ".worktrees/swift-falcon" });
    const t2 = makeTask({ id: "FN-002", worktree: ".worktrees/quiet-robin" });

    const groups = groupByWorktree([t1, t2], [t1, t2], 2);

    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("swift-falcon");
    expect(groups[0].activeTasks).toEqual([t1]);
    expect(groups[1].label).toBe("quiet-robin");
    expect(groups[1].activeTasks).toEqual([t2]);
  });

  it("places queued tasks only in the Up Next group, never in worktree groups", () => {
    const active = makeTask({ id: "FN-001", worktree: ".worktrees/swift-falcon" });
    const queued = makeTask({
      id: "FN-002",
      column: "todo",
      dependencies: [],
    });

    const groups = groupByWorktree([active], [active, queued], 2);

    // Worktree group should have no queued tasks
    const worktreeGroup = groups.find((g) => g.label === "swift-falcon");
    expect(worktreeGroup).toBeDefined();
    expect(worktreeGroup!.queuedTasks).toEqual([]);

    // Up Next should contain the queued task
    const upNext = groups.find((g) => g.label === "Up Next");
    expect(upNext).toBeDefined();
    expect(upNext!.queuedTasks).toEqual([queued]);
    expect(upNext!.activeTasks).toEqual([]);
  });

  it("does not create Up Next group when there are no eligible queued tasks", () => {
    const active = makeTask({ id: "FN-001", worktree: ".worktrees/swift-falcon" });

    const groups = groupByWorktree([active], [active], 2);

    expect(groups.find((g) => g.label === "Up Next")).toBeUndefined();
  });

  it("does not create Up Next when queued tasks have unsatisfied dependencies", () => {
    const active = makeTask({ id: "FN-001", worktree: ".worktrees/swift-falcon" });
    const blocked = makeTask({
      id: "FN-002",
      column: "todo",
      dependencies: ["FN-003"], // KB-003 doesn't exist or isn't done
    });

    const groups = groupByWorktree([active], [active, blocked], 2);

    expect(groups.find((g) => g.label === "Up Next")).toBeUndefined();
  });

  it("respects maxConcurrent limit on queued tasks shown", () => {
    const active = makeTask({ id: "FN-001", worktree: ".worktrees/swift-falcon" });
    const q1 = makeTask({ id: "FN-010", column: "todo" });
    const q2 = makeTask({ id: "FN-011", column: "todo" });
    const q3 = makeTask({ id: "FN-012", column: "todo" });

    const groups = groupByWorktree([active], [active, q1, q2, q3], 2);

    const upNext = groups.find((g) => g.label === "Up Next");
    expect(upNext).toBeDefined();
    expect(upNext!.queuedTasks).toHaveLength(2);
  });

  it("places unassigned in-progress tasks in Unassigned group", () => {
    const unassigned = makeTask({ id: "FN-001" }); // no worktree

    const groups = groupByWorktree([unassigned], [unassigned], 2);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Unassigned");
    expect(groups[0].activeTasks).toEqual([unassigned]);
  });

  it("excludes paused todo tasks from Up Next", () => {
    const active = makeTask({ id: "FN-001", worktree: ".worktrees/swift-falcon" });
    const paused = makeTask({
      id: "FN-002",
      column: "todo",
      dependencies: [],
      paused: true,
    });
    const normal = makeTask({
      id: "FN-003",
      column: "todo",
      dependencies: [],
    });

    const groups = groupByWorktree([active], [active, paused, normal], 2);

    const upNext = groups.find((g) => g.label === "Up Next");
    expect(upNext).toBeDefined();
    expect(upNext!.queuedTasks.map((t) => t.id)).toEqual(["FN-003"]);
    expect(upNext!.queuedTasks.map((t) => t.id)).not.toContain("FN-002");
  });

  it("queued tasks with satisfied deps appear in Up Next", () => {
    const done = makeTask({ id: "FN-001", column: "done" });
    const queued = makeTask({
      id: "FN-002",
      column: "todo",
      dependencies: ["FN-001"],
    });

    const groups = groupByWorktree([], [done, queued], 2);

    const upNext = groups.find((g) => g.label === "Up Next");
    expect(upNext).toBeDefined();
    expect(upNext!.queuedTasks).toEqual([queued]);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
The upcoming-work list must find the HOLD lane by trait, not by the id `todo`.

WHY THIS ONE HID. On the default board the id and the role coincide — U11 gave `todo` the
hold trait — so every existing case here passed and the site looked healthy. Rename the
hold column and the filter matched nothing: the worktree view showed no upcoming work at
all and read as idle. A whole panel silently empty, nothing thrown.

Board resolves the hold ids across ALL workflows on the board (a card in another
workflow's hold lane is still upcoming work); Lane passes nothing and keeps the legacy
fallback, which is why the default case below omits the argument entirely.

REVERT CHECK, measured: dropping the parameter back to `t.column === "todo"` fails the
renamed case with an empty queue.
*/
describe("upcoming-work queue resolves the hold lane by trait", () => {
  const mkTask = (id: string, column: string, extra: Record<string, unknown> = {}) =>
    ({
      id, title: id, description: "", column, dependencies: [], steps: [], currentStep: 0,
      log: [], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
      ...extra,
    } as never);

  it("finds waiting cards in a RENAMED hold column when the ids are supplied", () => {
    const waiting = mkTask("FN-50", "backlog");
    const groups = groupByWorktree([], [waiting], 3, new Set(["FN-50"]));
    const queued = groups.flatMap((group) => group.queuedTasks ?? []);
    expect(queued.map((task: { id: string }) => task.id)).toContain("FN-50");
  });

  it("finds nothing in a renamed hold column when the ids are NOT supplied", () => {
    /*
    Pins the fallback's real limit rather than pretending it covers custom boards: with no
    resolved ids the legacy guess is all there is, and it cannot know about `backlog`. This
    is the case that used to be the ONLY behaviour, on every board.
    */
    const groups = groupByWorktree([], [mkTask("FN-51", "backlog")], 3);
    const queued = groups.flatMap((group) => group.queuedTasks ?? []);
    expect(queued.map((task: { id: string }) => task.id)).not.toContain("FN-51");
  });

  it("still finds legacy `todo` cards with no ids supplied, so Lane is unaffected", () => {
    const groups = groupByWorktree([], [mkTask("FN-52", "todo")], 3);
    const queued = groups.flatMap((group) => group.queuedTasks ?? []);
    expect(queued.map((task: { id: string }) => task.id)).toContain("FN-52");
  });

  it("does not treat a task outside the resolved set as waiting", () => {
    /*
    The narrowing guard: a lookup that ignored its set would pass the first case. It is keyed
    on TASK id, so this also pins the per-workflow scoping — a card whose own workflow does
    not mark its column `hold` is absent from the set even if another workflow reuses the id
    (PR #2625 review).
    */
    const groups = groupByWorktree([], [mkTask("FN-53", "building")], 3, new Set(["FN-99"]));
    const queued = groups.flatMap((group) => group.queuedTasks ?? []);
    expect(queued.map((task: { id: string }) => task.id)).not.toContain("FN-53");
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (PR #2625 review — greptile):
TWO WORKFLOWS, ONE COLUMN NAME, DIFFERENT TRAITS — the case that killed the first design.

My first version passed a board-wide set of hold COLUMN ids. Column ids are namespaced per
workflow, so workflow A can declare `staging` as its hold lane while workflow B declares
`staging` as executing. A unioned id set answers "is `staging` a hold column?" — a question
with no single answer — and every executing card in workflow B would have been listed under
Up Next as waiting work. Confidently wrong, which is worse than the renamed-board emptiness
the change set out to fix.

Keying on TASK id moves the decision to the only place that can make it: the caller, which
knows each task's own workflow. This case is the regression test for that, expressed the way
the helper now sees it — one card in the set, one not, both in a column called `staging`.
*/
describe("hold resolution is scoped per workflow, not per column name", () => {
  const mkTask = (id: string, column: string) =>
    ({
      id, title: id, description: "", column, dependencies: [], steps: [], currentStep: 0,
      log: [], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    } as never);

  it("lists only the card whose OWN workflow marks `staging` as hold", () => {
    const waitingInA = mkTask("FN-60", "staging");
    const executingInB = mkTask("FN-61", "staging");

    // What Board computes: FN-60's workflow declares `staging` hold; FN-61's does not.
    const groups = groupByWorktree([], [waitingInA, executingInB], 3, new Set(["FN-60"]));
    const queued = groups.flatMap((group) => group.queuedTasks ?? []).map((task: { id: string }) => task.id);

    expect(queued).toContain("FN-60");
    // The assertion the column-id design could not satisfy: same column name, opposite answer.
    expect(queued).not.toContain("FN-61");
  });
});
