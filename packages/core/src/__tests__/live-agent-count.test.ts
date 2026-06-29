import { describe, expect, it } from "vitest";
import { countRunningAgentTasks, deriveRunningAgentCounts, isRunningAgentTask } from "../live-agent-count.js";
import type { Task } from "../types.js";

function task(overrides: Pick<Task, "column"> & Partial<Pick<Task, "status" | "paused">>): Pick<Task, "column" | "status" | "paused"> {
  return {
    column: overrides.column,
    status: overrides.status,
    paused: overrides.paused,
  };
}

describe("live agent count predicates", () => {
  it("identifies tasks that hold top-level running-agent slots", () => {
    expect(isRunningAgentTask(task({ column: "in-progress" }))).toBe(true);
    expect(isRunningAgentTask(task({ column: "triage", status: "planning", paused: false }))).toBe(true);
    expect(isRunningAgentTask(task({ column: "triage", status: "planning", paused: true }))).toBe(false);

    for (const status of ["merging", "merging-pr", "merging-fix", "reviewing", "fixing"]) {
      expect(isRunningAgentTask(task({ column: "in-review", status, paused: false }))).toBe(true);
    }

    expect(isRunningAgentTask(task({ column: "in-review", paused: false }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "in-review", status: "pending", paused: false }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "in-review", status: "reviewing", paused: true }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "done" }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "todo" }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "archived" }))).toBe(false);
  });

  it("counts only tasks that satisfy the shared running-agent predicate", () => {
    expect(countRunningAgentTasks([
      task({ column: "in-progress" }),
      task({ column: "triage", status: "planning", paused: false }),
      task({ column: "triage", status: "planning", paused: true }),
      task({ column: "in-review", status: "merging", paused: false }),
      task({ column: "in-review", status: "merging-pr", paused: false }),
      task({ column: "in-review", status: "merging-fix", paused: false }),
      task({ column: "in-review", status: "reviewing", paused: false }),
      task({ column: "in-review", status: "fixing", paused: false }),
      task({ column: "in-review", status: "fixing", paused: true }),
      task({ column: "todo" }),
      task({ column: "done" }),
      task({ column: "archived" }),
    ])).toBe(7);
  });

  it("normalizes display counts for zero, one, multi-project, unopened, and oversubscribed states", () => {
    expect(deriveRunningAgentCounts({})).toEqual({ currentlyActive: 0, projectsActive: {} });
    expect(deriveRunningAgentCounts({ proj_zero: 0, proj_one: 1 })).toEqual({
      currentlyActive: 1,
      projectsActive: { proj_one: 1 },
    });
    expect(deriveRunningAgentCounts({ proj_a: 2, proj_b: 4, proj_unopened: 0 })).toEqual({
      currentlyActive: 6,
      projectsActive: { proj_a: 2, proj_b: 4 },
    });
    expect(deriveRunningAgentCounts({ proj_over_limit: 12, proj_negative: -3, proj_nan: Number.NaN })).toEqual({
      currentlyActive: 12,
      projectsActive: { proj_over_limit: 12 },
    });
  });
});
