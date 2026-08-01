import { describe, expect, it } from "vitest";
import {
  countRunningAgentTasks,
  deriveRunningAgentCounts,
  enrichRunningAgentTaskShapeFromFlags,
  isRunningAgentTask,
  isWaitingAgentTask,
} from "../agents/live-agent-count.js";
import type { RunningAgentTaskShape } from "../agents/live-agent-count.js";

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

  it("counts a live pending workflow-step gate lease as running in any non-terminal lane", () => {
    const pendingCodeReview = [{ workflowStepId: "code-review", workflowStepName: "Code Review", status: "pending" as const, startedAt: "2026-07-22T05:00:00.000Z" }];
    // In Review: MERGING task + live CODE REVIEW gate must both count (was 1/2).
    expect(isRunningAgentTask(task({ column: "in-review", columnIsReviewOrMerge: true, workflowStepResults: pendingCodeReview }))).toBe(true);
    // Planning-lane gate (plan-review) with status cleared to null also counts.
    const pendingPlanReview = [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "pending" as const, startedAt: "2026-07-22T05:00:00.000Z" }];
    expect(isRunningAgentTask(task({ column: "todo", columnIsIntakeOrHold: true, workflowStepResults: pendingPlanReview }))).toBe(true);
    // A running gate is never Waiting.
    expect(isWaitingAgentTask(task({ column: "todo", columnIsIntakeOrHold: true, workflowStepResults: pendingPlanReview }))).toBe(false);
    // Pause and terminal columns still dominate.
    expect(isRunningAgentTask(task({ column: "in-review", columnIsReviewOrMerge: true, workflowStepResults: pendingCodeReview, paused: true }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "in-review", columnIsReviewOrMerge: true, workflowStepResults: pendingCodeReview, userPaused: true }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "done", columnTerminalKind: "complete", workflowStepResults: pendingCodeReview }))).toBe(false);
    // Terminal step records are not live leases.
    const passed = [{ workflowStepId: "code-review", workflowStepName: "Code Review", status: "passed" as const, completedAt: "2026-07-22T05:10:00.000Z" }];
    expect(isRunningAgentTask(task({ column: "in-review", columnIsReviewOrMerge: true, workflowStepResults: passed }))).toBe(false);
    const failed = [{ workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed" as const, completedAt: "2026-07-22T05:10:00.000Z" }];
    expect(isRunningAgentTask(task({ column: "in-review", columnIsReviewOrMerge: true, workflowStepResults: failed }))).toBe(false);
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

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-10:30 (Phase C convergence — live-agent-count.ts):

The no-flags fallback is DELIBERATELY the legacy pair, and these cases exist so a future
"finish the conversion" pass cannot quietly change the answer. Running and Waiting are
complements over the same rows, so if the two former literal sites ever disagree a card
lands in both counts or in neither, and the footer's queued total misreports it.

What is pinned:
  - with NO flags, the legacy planner ids are Waiting (unchanged behavior);
  - with NO flags, a renamed planner column is NOT Waiting — the known gap, whose fix is at
    the caller (supply flags, or use the IR-based `enrichRunningAgentTaskShape`), not a guess
    about what an absent flag set means;
  - flags always WIN over the fallback, in both directions, which is what makes the caller
    fix effective.
*/
describe("the no-flags fallback keeps the legacy planner vocabulary", () => {
  const bare = (column: string) => ({ id: "FN-1", column } as Parameters<typeof isWaitingAgentTask>[0]);

  it("treats the legacy planner ids as waiting when no flags are supplied", () => {
    expect(isWaitingAgentTask(enrichRunningAgentTaskShapeFromFlags(bare("triage")))).toBe(true);
    expect(isWaitingAgentTask(enrichRunningAgentTaskShapeFromFlags(bare("todo")))).toBe(true);
    expect(isWaitingAgentTask(enrichRunningAgentTaskShapeFromFlags(bare("in-review")))).toBe(false);
  });

  it("answers identically whether the shape was enriched or read raw", () => {
    // The two former literal sites: `enrich...FromFlags` and `isWaitingAgentTask`'s own
    // `??` fallback. One rule, so one answer.
    for (const column of ["triage", "todo", "in-progress", "backlog"]) {
      expect(isWaitingAgentTask(enrichRunningAgentTaskShapeFromFlags(bare(column))))
        .toBe(isWaitingAgentTask(bare(column)));
    }
  });

  it("does NOT invent a planner lane for a renamed column with no flags", () => {
    expect(isWaitingAgentTask(enrichRunningAgentTaskShapeFromFlags(bare("backlog")))).toBe(false);
  });

  it("lets supplied flags override the legacy answer in both directions", () => {
    // A board that declares `todo` as a WIP column: flags win, so it is Running, not Waiting.
    const wipTodo = enrichRunningAgentTaskShapeFromFlags(bare("todo"), { countsTowardWip: true });
    expect(isWaitingAgentTask(wipTodo)).toBe(false);
    expect(isRunningAgentTask(wipTodo)).toBe(true);
    // And the renamed planner lane becomes Waiting as soon as its flags arrive.
    expect(isWaitingAgentTask(enrichRunningAgentTaskShapeFromFlags(bare("backlog"), { intake: true }))).toBe(true);
  });
});
