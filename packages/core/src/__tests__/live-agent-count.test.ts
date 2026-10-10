import { describe, expect, it } from "vitest";
import {
  countRunningAgentTasks,
  deriveRunningAgentCounts,
  enrichRunningAgentTaskShapeFromFlags,
  isFailedWipPark,
  isRunningAgentTask,
  isWaitingAgentTask,
} from "../agents/live-agent-count.js";
import { isFailedWipPark as isFailedWipParkGate, isRunningAgentTask as isRunningAgentTaskGate } from "../index.gate.js";
import { isFailedWipPark as isFailedWipParkFull } from "../index.js";
import type { RunningAgentTaskShape } from "../agents/live-agent-count.js";

function task(overrides: Partial<RunningAgentTaskShape> & Pick<RunningAgentTaskShape, "column">): RunningAgentTaskShape {
  return { columnTerminalKind: "none", ...overrides };
}

describe("live agent count predicates", () => {
  /*
  FNXC:CapacitySlotLeak 2026-09-19-04:07:
  A planning claim is a live agent only while a planner session is live. The lane is NOT the
  discriminator: planning is dispatched from the intake lane and from the hold lane alike, so lane
  membership cannot separate a running planner from the durable remains of a dead one. The flag-less
  case is the documented legacy fallback for callers that cannot observe planner sessions (dashboard
  footer, CLI, the synchronous semaphore leak valve). The incident this pins: orphaned
  `status:"planning"` rows held every project slot, so the planner throttled itself (677
  "Plan throttled by running-agent cap" lines; 258 with `claimed=2, processing=0`).
  */
  it("counts a planner in every non-terminal lane only while a planner session is live", () => {
    expect(isRunningAgentTask(task({ column: "todo", status: "planning", planningIsLive: true }))).toBe(true);
    expect(isRunningAgentTask(task({ column: "ideas", status: "planning", planningIsLive: true }))).toBe(true);
    // No planner session behind the status: the card must not hold a capacity slot in ANY lane.
    expect(isRunningAgentTask(task({ column: "todo", status: "planning", planningIsLive: false }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "ideas", status: "planning", planningIsLive: false }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "in-progress", columnCountsTowardWip: true, status: "planning", planningIsLive: false }))).toBe(false);
    expect(countRunningAgentTasks([
      task({ column: "todo", status: "planning", planningIsLive: false }),
      task({ column: "todo", status: "planning", planningIsLive: true }),
    ])).toBe(1);
    // Flag-less legacy callers keep the historical count; pause still excludes the card.
    expect(isRunningAgentTask(task({ column: "todo", status: "planning" }))).toBe(true);
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

  it("keeps an externally blocked non-terminal card as a holder but never as waiting work", () => {
    const externalBlock = {
      origin: "host-environment" as const,
      code: "ENOSPC",
      message: "no space left on device, write",
      source: "agent-declaration" as const,
      blockedAt: "2026-08-28T04:01:00.000Z",
      resume: { column: "in-progress", currentStep: 6, worktree: "/worktrees/fn-209", branch: "fusion/fn-209" },
    };
    const blockedWip = task({ column: "in-progress", columnCountsTowardWip: true, status: "blocked", paused: true, externalBlock });
    const blockedHold = task({ column: "todo", columnIsIntakeOrHold: true, status: "blocked", paused: true, externalBlock });

    expect(isRunningAgentTask(blockedWip)).toBe(true);
    expect(isRunningAgentTask(blockedHold)).toBe(true);
    expect(countRunningAgentTasks([blockedWip, blockedHold])).toBe(2);
    expect(isWaitingAgentTask(blockedWip)).toBe(false);
    expect(isWaitingAgentTask(blockedHold)).toBe(false);
  });

  it("does not count failed WIP (or any failed row) as a live capacity holder", () => {
    // Failed parks remain in WIP until rebound/operator action but must free maxWorktrees/maxConcurrent.
    expect(isRunningAgentTask(task({ column: "in-progress", columnCountsTowardWip: true, status: "failed" }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "working", columnCountsTowardWip: true, status: "failed" }))).toBe(false);
    expect(isRunningAgentTask(task({
      column: "in-progress",
      columnCountsTowardWip: true,
      status: "failed",
      workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code Review", status: "pending" as const, startedAt: "2026-08-01T00:00:00.000Z" }],
    }))).toBe(false);
    expect(isRunningAgentTask(task({ column: "in-review", columnIsReviewOrMerge: true, status: "failed" }))).toBe(false);
    // Still Waiting only for intake/hold — failed WIP is neither running nor waiting.
    expect(isWaitingAgentTask(task({ column: "in-progress", columnCountsTowardWip: true, status: "failed" }))).toBe(false);
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

/*
FNXC:ColumnCapacity 2026-10-10-19:34 (RUFU-362):
The failed-park atom moved out of `isRunningAgentTask`'s body because it turned out to answer a
SECOND question: does this row occupy a COLUMN WIP slot? Production project saneca proved the two
answers had drifted — `in-progress` held three rows and every one of them was status:"failed", so
the in-transaction capacity check reported the lane full, refused every todo→in-progress move with
`capacity-exhausted`, and the board froze (294 graph suspends on waitReason:"capacity" inside 30
minutes, zero board-wide moves). A dead row must never hold a slot in any dimension; a live row
must keep holding one in every dimension.

The truth table is pinned in BOTH directions. The `null` / `"merging"` / `"planning"` rows are the
control that stops the exclusion from widening into "ignore the lane": a counter that dropped
EVERY row would also clear the frozen-board symptom test while quietly deleting capacity.
*/
describe("isFailedWipPark — the single spelling of the failed-park rule", () => {
  const row = (status: string | null | undefined) =>
    isFailedWipPark({ status } as Parameters<typeof isFailedWipPark>[0]);

  it("is true only for a failed park, so live and non-failed rows keep their slot", () => {
    expect(row("failed")).toBe(true);
    // Controls: live, absent, and non-failed terminal statuses all still occupy a slot.
    expect(row(null)).toBe(false);
    expect(row(undefined)).toBe(false);
    expect(row("merging")).toBe(false);
    expect(row("planning")).toBe(false);
    expect(row("done")).toBe(false);
  });

  /*
  This is a PARITY PIN, honest about what it can catch. Production holds exactly one call site, so
  a re-literalized status check could only return as a SECOND rule beside this one — which is
  precisely how the column dimension drifted away from the agent dimension. Asserting that the atom
  implies not-running across every lane is what makes that drift fail loudly.
  */
  it("keeps isRunningAgentTask agreeing with the atom across every lane", () => {
    const lanes: Array<Partial<RunningAgentTaskShape> & Pick<RunningAgentTaskShape, "column">> = [
      { column: "in-progress", columnCountsTowardWip: true },
      { column: "working", columnCountsTowardWip: true },
      { column: "in-review", columnTerminalKind: "none", columnIsReviewOrMerge: true },
      { column: "todo", columnIsIntakeOrHold: true },
    ];
    for (const lane of lanes) {
      for (const status of ["failed", null, "planning", "merging", "done"] as const) {
        const shape = task({ ...lane, status });
        if (isFailedWipPark(shape)) expect(isRunningAgentTask(shape), `${lane.column}/${status}`).toBe(false);
      }
      // Non-vacuous control per lane: a live row's answer is not the atom's doing.
      expect(isFailedWipPark(task({ ...lane, status: null }))).toBe(false);
    }
    // And the live WIP row really does still hold its slot.
    expect(isRunningAgentTask(task({ column: "in-progress", columnCountsTowardWip: true, status: null }))).toBe(true);
  });
});

/*
FNXC:MergeGatePolicy 2026-10-10-19:34 (RUFU-362):
Same both-barrels pin as `file-scope-lease.test.ts` and `agent-log-read-guard.test.ts` establish,
and load-bearing for the same reason: the `engine-core` merge-gate vitest project aliases
`@fusion/core` to the gate bundle built from `index.gate.ts`, and `hold-release.ts` imports this
predicate through that specifier. A gate-barrel omission is not a type-only annoyance there — the
sweep would call `undefined` at runtime. RUFU-204's Code Review died mid-reasoning while checking
exactly this, which is why the pin is written the same way.
*/
describe("isFailedWipPark is exposed from BOTH core barrels (index + index.gate stay in sync)", () => {
  it("resolves the identical function through the full and gate barrels", () => {
    expect(typeof isFailedWipParkGate).toBe("function");
    // Re-export of the same module instance → the same function, so the barrels cannot drift.
    expect(isFailedWipParkGate).toBe(isFailedWipPark);
    expect(isFailedWipParkFull).toBe(isFailedWipPark);
    expect(isFailedWipParkGate({ status: "failed" })).toBe(true);
    expect(isFailedWipParkGate({ status: null })).toBe(false);
    // The neighbour the atom was extracted from is still published from both barrels too.
    expect(isRunningAgentTaskGate).toBe(isRunningAgentTask);
  });
});
