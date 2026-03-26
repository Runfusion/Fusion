import { describe, it, expect } from "vitest";
import { groupByWorktree, getWorktreeLabel } from "./worktreeGrouping";
import type { Task } from "@hai/core";

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
    expect(getWorktreeLabel(".worktrees/HAI-001")).toBe("HAI-001");
    expect(getWorktreeLabel("/path/to/hai/hai-001")).toBe("hai-001");
  });

  it("extracts humanized worktree names", () => {
    expect(getWorktreeLabel(".worktrees/swirly-monkey")).toBe("swirly-monkey");
    expect(getWorktreeLabel("/tmp/project/.worktrees/quiet-falcon")).toBe("quiet-falcon");
    expect(getWorktreeLabel(".worktrees/bright-orchid-2")).toBe("bright-orchid-2");
  });
});

describe("groupByWorktree", () => {
  it("groups active in-progress tasks by worktree", () => {
    const t1 = makeTask({ id: "HAI-001", worktree: ".worktrees/swift-falcon" });
    const t2 = makeTask({ id: "HAI-002", worktree: ".worktrees/quiet-robin" });

    const groups = groupByWorktree([t1, t2], [t1, t2], 2);

    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("swift-falcon");
    expect(groups[0].activeTasks).toEqual([t1]);
    expect(groups[1].label).toBe("quiet-robin");
    expect(groups[1].activeTasks).toEqual([t2]);
  });

  it("places queued tasks only in the Up Next group, never in worktree groups", () => {
    const active = makeTask({ id: "HAI-001", worktree: ".worktrees/swift-falcon" });
    const queued = makeTask({
      id: "HAI-002",
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
    const active = makeTask({ id: "HAI-001", worktree: ".worktrees/swift-falcon" });

    const groups = groupByWorktree([active], [active], 2);

    expect(groups.find((g) => g.label === "Up Next")).toBeUndefined();
  });

  it("does not create Up Next when queued tasks have unsatisfied dependencies", () => {
    const active = makeTask({ id: "HAI-001", worktree: ".worktrees/swift-falcon" });
    const blocked = makeTask({
      id: "HAI-002",
      column: "todo",
      dependencies: ["HAI-003"], // HAI-003 doesn't exist or isn't done
    });

    const groups = groupByWorktree([active], [active, blocked], 2);

    expect(groups.find((g) => g.label === "Up Next")).toBeUndefined();
  });

  it("respects maxConcurrent limit on queued tasks shown", () => {
    const active = makeTask({ id: "HAI-001", worktree: ".worktrees/swift-falcon" });
    const q1 = makeTask({ id: "HAI-010", column: "todo" });
    const q2 = makeTask({ id: "HAI-011", column: "todo" });
    const q3 = makeTask({ id: "HAI-012", column: "todo" });

    const groups = groupByWorktree([active], [active, q1, q2, q3], 2);

    const upNext = groups.find((g) => g.label === "Up Next");
    expect(upNext).toBeDefined();
    expect(upNext!.queuedTasks).toHaveLength(2);
  });

  it("places unassigned in-progress tasks in Unassigned group", () => {
    const unassigned = makeTask({ id: "HAI-001" }); // no worktree

    const groups = groupByWorktree([unassigned], [unassigned], 2);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Unassigned");
    expect(groups[0].activeTasks).toEqual([unassigned]);
  });

  it("queued tasks with satisfied deps appear in Up Next", () => {
    const done = makeTask({ id: "HAI-001", column: "done" });
    const queued = makeTask({
      id: "HAI-002",
      column: "todo",
      dependencies: ["HAI-001"],
    });

    const groups = groupByWorktree([], [done, queued], 2);

    const upNext = groups.find((g) => g.label === "Up Next");
    expect(upNext).toBeDefined();
    expect(upNext!.queuedTasks).toEqual([queued]);
  });
});
