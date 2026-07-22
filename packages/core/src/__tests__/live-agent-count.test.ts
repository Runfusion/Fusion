import { describe, expect, it } from "vitest";
import {
  countRunningAgentTasks,
  deriveRunningAgentCounts,
  enrichRunningAgentTaskShapeFromFlags,
  isRunningAgentTask,
  isWaitingAgentTask,
} from "../live-agent-count.js";
import type { RunningAgentTaskShape } from "../live-agent-count.js";

function task(overrides: Partial<RunningAgentTaskShape> & Pick<RunningAgentTaskShape, "column">): RunningAgentTaskShape {
  return { columnTerminalKind: "none", ...overrides };
}

describe("live agent count predicates", () => {
  it("counts live planners in every non-terminal workflow lane", () => {
    expect(isRunningAgentTask(task({ column: "todo", status: "planning" }))).toBe(true);
    expect(isRunningAgentTask(task({ column: "ideas", status: "planning" }))).toBe(true);
    expect(isRunningAgentTask(task({ column: "ideas", status: "planning", paused: true }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "ideas", status: "planning", userPaused: true }))).toBe(false);
  });

  it("counts unpaused WIP cards as running without requiring sessionFile", () => {
    // sessionFile is not a DB/board field; WIP membership + not paused is the production signal.
    expect(isRunningAgentTask(task({ column: "in-progress", columnCountsTowardWip: true }))).toBe(true);
    expect(isRunningAgentTask(task({ column: "working", columnCountsTowardWip: true }))).toBe(true);
    expect(isRunningAgentTask(task({ column: "in-progress", columnCountsTowardWip: true, sessionFile: "/tmp/run" }))).toBe(true);
    expect(isRunningAgentTask(task({ column: "in-progress", columnCountsTowardWip: true, checkedOutBy: "agent-a" }))).toBe(true);
    expect(isRunningAgentTask(task({ column: "in-progress", columnCountsTowardWip: true, paused: true }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "in-progress", columnCountsTowardWip: true, userPaused: true }))).toBe(false);
  });

  it("counts only active review/merge statuses and excludes terminal columns", () => {
    for (const status of ["merging", "merging-pr", "merging-fix", "reviewing", "landing", "fixing"]) {
      expect(isRunningAgentTask(task({ column: "review", status, columnIsReviewOrMerge: true }))).toBe(true);
    }
    expect(isRunningAgentTask(task({ column: "review", status: "pending", columnIsReviewOrMerge: true }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "ideas", status: "merging", columnIsReviewOrMerge: false }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "shipped", sessionFile: "/tmp/stale", columnCountsTowardWip: true, columnTerminalKind: "complete" }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "working", columnCountsTowardWip: true, columnTerminalKind: "none" }))).toBe(true);
  });

  it("enriches terminal, waiting, and WIP traits from board flags", () => {
    const complete = enrichRunningAgentTaskShapeFromFlags(task({ column: "shipped", sessionFile: "/tmp/stale" }), { complete: true, countsTowardWip: true });
    expect(complete.columnTerminalKind).toBe("complete");
    expect(isRunningAgentTask(complete)).toBe(false);

    const intake = enrichRunningAgentTaskShapeFromFlags(task({ column: "ideas" }), { intake: true });
    expect(isWaitingAgentTask(intake)).toBe(true);
    expect(isWaitingAgentTask({ ...intake, status: "planning" })).toBe(false);
    expect(isWaitingAgentTask(enrichRunningAgentTaskShapeFromFlags(task({ column: "hold" }), { hold: true }))).toBe(true);
  });

  it("counts only the shared predicate", () => {
    expect(countRunningAgentTasks([
      task({ column: "in-progress", sessionFile: "/tmp/run" }),
      task({ column: "in-progress" }),
      task({ column: "triage", status: "planning" }),
      task({ column: "in-review", status: "merging", columnIsReviewOrMerge: true }),
      task({ column: "done", sessionFile: "/tmp/stale" }),
    ])).toBe(4);
  });

  it("normalizes aggregate display counts", () => {
    expect(deriveRunningAgentCounts({ proj_zero: 0, proj_one: 1, proj_nan: Number.NaN })).toEqual({
      currentlyActive: 1,
      projectsActive: { proj_one: 1 },
    });
  });
});
