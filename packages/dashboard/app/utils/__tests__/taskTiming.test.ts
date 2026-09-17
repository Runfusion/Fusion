import { describe, it, expect } from "vitest";
import type { Task, WorkflowStepResult } from "@fusion/core";
import {
  buildStepDurations,
  formatDurationMs,
  getActiveRuntimeMs,
  getTaskRuntimeBreakdown,
  getTotalAgentActiveMs,
  getVerificationRuntimeMs,
  getWallClockSinceFirstExecutionMs,
  getWorkflowRuntimeMs,
} from "../taskTiming";

describe("taskTiming helpers", () => {
  it("returns persisted plus live segment for in-progress tasks", () => {
    const nowMs = Date.parse("2026-05-15T13:16:00.000Z");
    const runtime = getActiveRuntimeMs(
      {
        column: "in-progress",
        cumulativeActiveMs: 240_000,
        executionStartedAt: "2026-05-15T13:15:00.000Z",
        columnMovedAt: "2026-05-15T13:15:00.000Z",
      },
      nowMs,
    );

    expect(runtime).toBe(300_000);
  });

  it("sums planning and execution segments without using idle dwell", () => {
    expect(getTotalAgentActiveMs({
      column: "done", cumulativeActiveMs: 120_000, executionStartedAt: undefined,
      cumulativePlanningMs: 180_000, planningStartedAt: undefined,
    }, Date.parse("2026-05-15T13:16:00.000Z"))).toBe(300_000);
  });

  it("returns null when there is no active-runtime signal", () => {
    const runtime = getActiveRuntimeMs(
      {
        column: "todo",
        cumulativeActiveMs: undefined,
        executionStartedAt: undefined,
        columnMovedAt: undefined,
      },
      Date.now(),
    );

    expect(runtime).toBeNull();
  });

  it("uses shifted executionStartedAt so the active badge excludes engine-down time", () => {
    const t0 = Date.parse("2026-06-25T00:00:00.000Z");
    const runtime = getActiveRuntimeMs(
      {
        column: "in-progress",
        cumulativeActiveMs: undefined,
        executionStartedAt: new Date(t0 + 60 * 60_000).toISOString(),
        columnMovedAt: new Date(t0).toISOString(),
      },
      t0 + 65 * 60_000,
    );

    expect(runtime).toBe(5 * 60_000);
    expect(getActiveRuntimeMs({ column: "in-progress", cumulativeActiveMs: undefined, executionStartedAt: undefined, columnMovedAt: undefined }, t0)).toBeNull();
  });

  it("caps a poisoned cumulative total at the task wall-clock age", () => {
    const createdAt = "2026-05-15T08:00:00.000Z";
    const nowMs = Date.parse("2026-05-15T15:00:00.000Z");
    const task = {
      column: "in-review",
      cumulativeActiveMs: 4 * 24 * 60 * 60_000,
      executionStartedAt: undefined,
      createdAt,
    };

    expect(getActiveRuntimeMs(task, nowMs)).toBe(7 * 60 * 60_000);
    expect(getTotalAgentActiveMs({ ...task, cumulativePlanningMs: 0, planningStartedAt: undefined }, nowMs))
      .toBe(7 * 60 * 60_000);
  });

  it("retains planning accrued before first execution when applying the wall-clock ceiling", () => {
    const nowMs = Date.parse("2026-05-15T10:00:00.000Z");
    expect(getTotalAgentActiveMs({
      column: "in-progress",
      createdAt: "2026-05-15T09:00:00.000Z",
      firstExecutionAt: "2026-05-15T10:00:00.000Z",
      cumulativeActiveMs: 0,
      executionStartedAt: "2026-05-15T10:00:00.000Z",
      cumulativePlanningMs: 30 * 60_000,
      planningStartedAt: undefined,
    }, nowMs)).toBe(30 * 60_000);
  });

  it("counts only the banked and current segments after a WIP round trip", () => {
    const nowMs = Date.parse("2026-05-15T08:20:00.000Z");
    expect(getTotalAgentActiveMs({
      column: "in-progress",
      cumulativeActiveMs: 5 * 60_000,
      executionStartedAt: "2026-05-15T08:15:00.000Z",
      cumulativePlanningMs: undefined,
      planningStartedAt: undefined,
      firstExecutionAt: "2026-05-15T08:00:00.000Z",
    }, nowMs)).toBe(10 * 60_000);
  });

  it("returns wall-clock runtime since first execution", () => {
    const wallClock = getWallClockSinceFirstExecutionMs(
      "2026-05-15T08:42:00.000Z",
      "2026-05-15T13:17:00.000Z",
      Date.parse("2026-05-15T13:20:00.000Z"),
    );

    expect(wallClock).toBe(16_500_000);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-10:10:

THE INVARIANT: the card's active-time chip counts the live run from the card's OWN wip lane.

THE FINDING THAT MATTERS MORE THAN THE FIX: `@fusion/core` exports its own `getTotalAgentActiveMs`,
and it was already converted onto `isWipColumnRole`. The card chip imports THIS module instead — a
second implementation of the same calculation in a different package — so that conversion never
reached the surface an operator looks at. The census counted core's site as done while the rendered
number stayed wrong. Two implementations of one rule, one converted and one not, is exactly the drift
`column-roles.ts` exists to end.

Keyed on the literal, the live execution segment was dropped on a renamed board: the chip
under-reported the run in flight by exactly its elapsed time, then healed itself the moment the card
moved on and the segment was persisted into `cumulativeActiveMs`. A number that is wrong only while
you are watching it.

REVERT PROOF, measured: restore `task.column === "in-progress"` in `getActiveRuntimeMs` and the
renamed-lane cases below fail.
*/
describe("step-report duration helpers", () => {
  const entry = (timestamp: string, action: string) => ({ timestamp, action });

  it("formats shared duration strings at the milliseconds, seconds, and minutes boundaries", () => {
    expect(formatDurationMs(999)).toBe("999 ms");
    expect(formatDurationMs(1_000)).toBe("1.0 s");
    expect(formatDurationMs(59_000)).toBe("59.0 s");
    expect(formatDurationMs(60_000)).toBe("1m 0s");
  });

  it("returns elapsed time for a normal implementation-step transition", () => {
    const durations = buildStepDurations([
      entry("2026-08-29T10:00:00.000Z", "Step 0 (Preflight) → in-progress"),
      entry("2026-08-29T10:00:15.000Z", "Step 0 (Preflight) → done"),
    ]);

    expect(durations.get(0, "Preflight")).toBe(15_000);
  });

  it("retains the first opening transition when progress is logged twice", () => {
    const durations = buildStepDurations([
      entry("2026-08-29T10:00:00.000Z", "Step 0 (Preflight) → in-progress"),
      entry("2026-08-29T10:00:05.000Z", "Step 0 (Preflight) → in-progress"),
      entry("2026-08-29T10:00:15.000Z", "Step 0 (Preflight) → done"),
    ]);

    expect(durations.get(0, "Preflight")).toBe(15_000);
  });

  it("does not synthesize duration when a trimmed log lacks the opening transition", () => {
    const durations = buildStepDurations([
      entry("2026-08-29T10:00:15.000Z", "Step 0 (Preflight) → done"),
    ]);

    expect(durations.get(0, "Preflight")).toBeUndefined();
  });

  it("does not render duration for a still-running step", () => {
    const durations = buildStepDurations([
      entry("2026-08-29T10:00:00.000Z", "Step 0 (Preflight) → in-progress"),
    ]);

    expect(durations.get(0, "Preflight")).toBeUndefined();
  });

  it("sums closed segments for a retried step", () => {
    const durations = buildStepDurations([
      entry("2026-08-29T10:00:00.000Z", "Step 0 (Preflight) → in-progress"),
      entry("2026-08-29T10:00:10.000Z", "Step 0 (Preflight) → done"),
      entry("2026-08-29T10:00:20.000Z", "Step 0 (Preflight) → in-progress"),
      entry("2026-08-29T10:00:25.000Z", "Step 0 (Preflight) → skipped"),
    ]);

    expect(durations.get(0, "Preflight")).toBe(15_000);
  });

  it("ignores non-transition activity text that happens to mention a step", () => {
    const durations = buildStepDurations([
      entry("2026-08-29T10:00:00.000Z", "Reset stuck-kill streak (forward progress: step 0 (Preflight) → done)"),
      entry("2026-08-29T10:00:01.000Z", "[integrity-warning] graph-source updateStep suppressed: step 0 (Preflight) → done blocked by unmet dependency step 0 (pending)"),
      entry("2026-08-29T10:00:02.000Z", "Ignored out-of-order done for step 0 (Preflight) — earlier step 0 (Preflight) is still pending"),
      entry("2026-08-29T10:00:03.000Z", "Step 0 (Preflight) recovered as done on resume — code review had already approved before the engine stopped"),
    ]);

    expect(durations.get(0, "Preflight")).toBeUndefined();
  });

  it("falls back to step index when a renamed report differs from the recorded transition", () => {
    const durations = buildStepDurations([
      entry("2026-08-29T10:00:00.000Z", "Step 0 (Preflight) → in-progress"),
      entry("2026-08-29T10:00:15.000Z", "Step 0 (Preflight) → done"),
    ]);

    expect(durations.get(0, "Renamed preflight")).toBe(15_000);
  });
});

describe("active-time resolves the card's own wip lane", () => {
  const WIP_FLAGS = { countsTowardWip: true } as never;
  const NOW = Date.parse("2026-07-31T12:00:00Z");
  const STARTED = "2026-07-31T11:00:00Z";
  const HOUR = 60 * 60 * 1000;

  it("counts the in-flight run for a RENAMED wip lane", () => {
    expect(getActiveRuntimeMs(
      { column: "building", cumulativeActiveMs: 0, executionStartedAt: STARTED } as never, NOW, WIP_FLAGS,
    )).toBe(HOUR);
  });

  it("includes it in the rendered total", () => {
    expect(getTotalAgentActiveMs(
      { column: "building", cumulativeActiveMs: 0, executionStartedAt: STARTED } as never, NOW, WIP_FLAGS,
    )).toBe(HOUR);
  });

  it("does NOT count a live segment outside the wip lane", () => {
    // A stale executionStartedAt on a review card is not active time.
    expect(getActiveRuntimeMs(
      { column: "signoff", cumulativeActiveMs: 0, executionStartedAt: STARTED } as never, NOW, { mergeBlocker: true } as never,
    )).toBe(0);
  });

  it("keeps the legacy id when no flags are supplied", () => {
    expect(getActiveRuntimeMs(
      { column: "in-progress", cumulativeActiveMs: 0, executionStartedAt: STARTED } as never, NOW,
    )).toBe(HOUR);
  });
});

/*
FN-457 — the card's clock chip must show worked time, and its hover detail must break that time into
Planning / Execution / Verification with no bucket counting the same millisecond twice.
*/
const FN457_NOW = Date.parse("2026-09-16T12:00:00.000Z");
const FN457_CREATED = "2026-09-16T00:00:00.000Z";

function breakdownTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-457",
    title: "chip",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: FN457_CREATED,
    updatedAt: FN457_CREATED,
    firstExecutionAt: FN457_CREATED,
    ...overrides,
  } as unknown as Task;
}

function gate(overrides: Partial<WorkflowStepResult>): WorkflowStepResult {
  return {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    status: "passed",
    ...overrides,
  } as WorkflowStepResult;
}

describe("getActiveRuntimeMs — durable pause deduction (FN-457)", () => {
  it("subtracts banked pause from a closed execution total", () => {
    expect(getActiveRuntimeMs(
      { column: "done", cumulativeActiveMs: 600_000, executionStartedAt: undefined, columnMovedAt: FN457_CREATED, createdAt: FN457_CREATED, cumulativePausedMs: 200_000 },
      FN457_NOW,
    )).toBe(400_000);
  });

  it("subtracts the open pause segment while the card is actually paused", () => {
    expect(getActiveRuntimeMs(
      {
        column: "in-progress",
        cumulativeActiveMs: 600_000,
        executionStartedAt: "2026-09-16T11:50:00.000Z",
        columnMovedAt: FN457_CREATED,
        createdAt: FN457_CREATED,
        paused: true,
        pausedStartedAt: "2026-09-16T11:55:00.000Z",
      },
      FN457_NOW,
    )).toBe(600_000 + 600_000 - 300_000);
  });

  it("honors userPaused as well as paused for the open segment", () => {
    expect(getActiveRuntimeMs(
      { column: "done", cumulativeActiveMs: 600_000, executionStartedAt: undefined, columnMovedAt: FN457_CREATED, createdAt: FN457_CREATED, userPaused: true, pausedStartedAt: "2026-09-16T11:55:00.000Z" },
      FN457_NOW,
    )).toBe(300_000);
  });

  it("IGNORES an orphaned pausedStartedAt on a card that is no longer paused", () => {
    // Deducting a segment that ended long ago would grow without bound and drive the chip to zero.
    expect(getActiveRuntimeMs(
      { column: "done", cumulativeActiveMs: 600_000, executionStartedAt: undefined, columnMovedAt: FN457_CREATED, createdAt: FN457_CREATED, pausedStartedAt: FN457_CREATED },
      FN457_NOW,
    )).toBe(600_000);
  });

  it("never returns a negative total when pause exceeds recorded execution", () => {
    expect(getActiveRuntimeMs(
      { column: "done", cumulativeActiveMs: 60_000, executionStartedAt: undefined, columnMovedAt: FN457_CREATED, createdAt: FN457_CREATED, cumulativePausedMs: 900_000 },
      FN457_NOW,
    )).toBe(0);
  });

  it("carries the same deduction through getTotalAgentActiveMs for TaskTokenStatsPanel", () => {
    expect(getTotalAgentActiveMs(
      { column: "done", cumulativeActiveMs: 600_000, executionStartedAt: undefined, cumulativePlanningMs: 300_000, planningStartedAt: undefined, createdAt: FN457_CREATED, cumulativePausedMs: 200_000 },
      FN457_NOW,
    )).toBe(700_000);
  });
});

describe("getVerificationRuntimeMs — allow-list, not a naive sum (FN-457)", () => {
  it("excludes the Plan Review gate, whose time is already in cumulativePlanningMs", () => {
    expect(getVerificationRuntimeMs([
      gate({ workflowStepId: "plan-review", workflowStepName: "Plan Review", reviewKind: "plan", source: "optional-group", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:05:00.000Z" }),
    ], FN457_NOW)).toBe(0);
  });

  it("excludes a skill node result, whose time is already in cumulativeActiveMs", () => {
    expect(getVerificationRuntimeMs([
      gate({ workflowStepId: "implement", workflowStepName: "Implement", source: "node", reviewKind: undefined, startedAt: "2026-09-16T10:00:00.000Z", completedAt: "2026-09-16T10:30:00.000Z" }),
    ], FN457_NOW)).toBe(0);
  });

  it("includes a code-review gate", () => {
    expect(getVerificationRuntimeMs([
      gate({ reviewKind: "code", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:08:00.000Z" }),
    ], FN457_NOW)).toBe(480_000);
  });

  it("includes an optional-group gate such as browser verification", () => {
    expect(getVerificationRuntimeMs([
      gate({ workflowStepId: "browser-verification", workflowStepName: "Browser Verification", source: "optional-group", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:03:00.000Z" }),
    ], FN457_NOW)).toBe(180_000);
  });

  it("includes an ordinary custom pre-merge gate that carries no source", () => {
    /* `executor/run-graph-custom-node.ts` writes the prompt/script gates of docs/workflow-steps.md
       with a phase and no `source`; their wall clock runs in the review lane, outside both counters. */
    expect(getVerificationRuntimeMs([
      gate({ workflowStepId: "lint-gate", workflowStepName: "Lint gate", phase: "pre-merge", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:08:00.000Z" }),
    ], FN457_NOW)).toBe(480_000);
  });

  it("excludes a legacy Plan Review row that carries neither reviewKind nor source", () => {
    /* Reconstructed by `executor/workflow-step-satisfaction.ts`; only the step id identifies it. */
    expect(getVerificationRuntimeMs([
      gate({ workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:05:00.000Z" }),
    ], FN457_NOW)).toBe(0);
  });

  it("includes a post-merge result", () => {
    expect(getVerificationRuntimeMs([
      gate({ workflowStepId: "post-merge-check", workflowStepName: "Post merge", phase: "post-merge", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:02:00.000Z" }),
    ], FN457_NOW)).toBe(120_000);
  });

  it("unions overlapping windows instead of summing them", () => {
    // Two foreach instances of the same gate running concurrently must not count twice.
    expect(getVerificationRuntimeMs([
      gate({ reviewKind: "code", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:10:00.000Z" }),
      gate({ reviewKind: "code", startedAt: "2026-09-16T11:05:00.000Z", completedAt: "2026-09-16T11:12:00.000Z" }),
    ], FN457_NOW)).toBe(12 * 60_000);
  });

  it("still sums two disjoint windows", () => {
    expect(getVerificationRuntimeMs([
      gate({ reviewKind: "code", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:05:00.000Z" }),
      gate({ reviewKind: "code", startedAt: "2026-09-16T11:20:00.000Z", completedAt: "2026-09-16T11:23:00.000Z" }),
    ], FN457_NOW)).toBe(8 * 60_000);
  });

  it("counts an open gate up to now when no live wip segment covers it", () => {
    expect(getVerificationRuntimeMs(
      [gate({ reviewKind: "code", startedAt: "2026-09-16T11:50:00.000Z" })],
      FN457_NOW,
      { liveWipSegmentCovers: false },
    )).toBe(600_000);
  });

  it("ignores an open gate while a live wip execution segment already covers it", () => {
    // The remediation case: a bounce returned the card to implementation with the gate row open.
    expect(getVerificationRuntimeMs(
      [gate({ reviewKind: "code", startedAt: "2026-09-16T11:50:00.000Z" })],
      FN457_NOW,
      { liveWipSegmentCovers: true },
    )).toBe(0);
  });

  it("still counts an open gate in the wip lane when NO live execution segment is running", () => {
    // Skipping on lane alone would erase the only timing such a card has.
    const b = getTaskRuntimeBreakdown(breakdownTask({
      column: "in-progress",
      workflowStepResults: [gate({ reviewKind: "code", status: "pending", startedAt: "2026-09-16T11:50:00.000Z" })],
    }), FN457_NOW)!;
    expect(b.verificationMs).toBe(600_000);
  });

  it("returns 0 for absent or empty results", () => {
    expect(getVerificationRuntimeMs(undefined, FN457_NOW)).toBe(0);
    expect(getVerificationRuntimeMs([], FN457_NOW)).toBe(0);
  });

  it("leaves getWorkflowRuntimeMs's naive per-step sum untouched", () => {
    // TaskTokenStatsPanel depends on this shape for its per-step breakdown.
    const results = [
      gate({ workflowStepId: "plan-review", reviewKind: "plan", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:05:00.000Z" }),
      gate({ workflowStepId: "implement", source: "node", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:30:00.000Z" }),
    ];
    // Naive per-step sum: 5m + 30m, overlap included, exclusions ignored.
    expect(getWorkflowRuntimeMs(results, FN457_NOW)).toBe(35 * 60_000);
    expect(getVerificationRuntimeMs(results, FN457_NOW)).toBe(0);
  });
});

describe("getTaskRuntimeBreakdown — one disjoint decomposition (FN-457)", () => {
  it("reports planning alone", () => {
    expect(getTaskRuntimeBreakdown(breakdownTask({ column: "todo", cumulativePlanningMs: 180_000 }), FN457_NOW))
      .toEqual({ planningMs: 180_000, executionMs: 0, verificationMs: 0, totalMs: 180_000 });
  });

  it("reports execution alone", () => {
    expect(getTaskRuntimeBreakdown(breakdownTask({ column: "done", cumulativeActiveMs: 600_000 }), FN457_NOW))
      .toEqual({ planningMs: 0, executionMs: 600_000, verificationMs: 0, totalMs: 600_000 });
  });

  it("reports verification alone", () => {
    expect(getTaskRuntimeBreakdown(breakdownTask({
      column: "in-review",
      cumulativeActiveMs: 0,
      workflowStepResults: [gate({ reviewKind: "code", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:08:00.000Z" })],
    }), FN457_NOW)).toEqual({ planningMs: 0, executionMs: 0, verificationMs: 480_000, totalMs: 480_000 });
  });

  it("keeps the three buckets summing exactly to the total", () => {
    const b = getTaskRuntimeBreakdown(breakdownTask({
      column: "in-review",
      cumulativePlanningMs: 300_000,
      cumulativeActiveMs: 600_000,
      workflowStepResults: [gate({ reviewKind: "code", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:08:00.000Z" })],
    }), FN457_NOW)!;
    expect(b.planningMs + b.executionMs + b.verificationMs).toBe(b.totalMs);
    expect(b.totalMs).toBe(300_000 + 600_000 + 480_000);
  });

  it("deducts pause from the execution bucket only", () => {
    expect(getTaskRuntimeBreakdown(breakdownTask({
      column: "in-review",
      cumulativePlanningMs: 300_000,
      cumulativeActiveMs: 600_000,
      cumulativePausedMs: 200_000,
    }), FN457_NOW)).toEqual({ planningMs: 300_000, executionMs: 400_000, verificationMs: 0, totalMs: 700_000 });
  });

  it("applies no deduction when a pause outside the wip lane banked nothing", () => {
    expect(getTaskRuntimeBreakdown(breakdownTask({ column: "in-review", cumulativeActiveMs: 600_000, paused: true }), FN457_NOW)!.executionMs)
      .toBe(600_000);
  });

  it("keeps lines summing to the label under wall-clock clamping", () => {
    // A historically poisoned row whose accumulators exceed the card's real age.
    const young = "2026-09-16T11:55:00.000Z";
    const b = getTaskRuntimeBreakdown(breakdownTask({
      column: "done",
      createdAt: young,
      firstExecutionAt: young,
      cumulativePlanningMs: 60_000,
      cumulativeActiveMs: 99_000_000,
    }), FN457_NOW)!;
    expect(b.totalMs).toBe(300_000);
    expect(b.planningMs + b.executionMs + b.verificationMs).toBe(b.totalMs);
  });

  it("falls back to timedExecutionMs and zeroes verification to avoid double counting", () => {
    expect(getTaskRuntimeBreakdown(breakdownTask({
      column: "done",
      timedExecutionMs: 420_000,
      workflowStepResults: [gate({ reviewKind: "code", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:08:00.000Z" })],
    }), FN457_NOW)).toEqual({ planningMs: 0, executionMs: 420_000, verificationMs: 0, totalMs: 420_000 });
  });

  it("falls back to [timing] log entries when nothing else is instrumented", () => {
    const b = getTaskRuntimeBreakdown(breakdownTask({
      column: "done",
      log: [{ timestamp: FN457_CREATED, action: "[timing] Active segment: 90000ms" }],
    }), FN457_NOW)!;
    expect(b.executionMs).toBe(90_000);
    expect(b.totalMs).toBe(90_000);
  });

  it("falls back to column wall clock for a legacy wip card with no instrumentation", () => {
    const b = getTaskRuntimeBreakdown(breakdownTask({ column: "in-progress", columnMovedAt: "2026-09-16T11:30:00.000Z" }), FN457_NOW)!;
    expect(b.executionMs).toBe(1_800_000);
    expect(b.totalMs).toBe(1_800_000);
  });

  it("returns null when no timing source exists outside the wip lane", () => {
    expect(getTaskRuntimeBreakdown(breakdownTask({ column: "in-review", columnMovedAt: undefined, updatedAt: undefined as never }), FN457_NOW)).toBeNull();
  });

  it("keeps a genuine instrumented zero rather than inventing wall clock", () => {
    expect(getTaskRuntimeBreakdown(breakdownTask({ column: "in-progress", cumulativeActiveMs: 0, columnMovedAt: "2026-09-16T11:30:00.000Z" }), FN457_NOW))
      .toEqual({ planningMs: 0, executionMs: 0, verificationMs: 0, totalMs: 0 });
  });

  it("adds live merge elapsed time to the verification bucket", () => {
    const b = getTaskRuntimeBreakdown(breakdownTask({ column: "in-review", cumulativeActiveMs: 600_000 }), FN457_NOW, undefined, 120_000)!;
    expect(b.verificationMs).toBe(120_000);
    expect(b.totalMs).toBe(720_000);
  });

  it("counts the live wip execution segment on a renamed board when flags are supplied", () => {
    const renamed = breakdownTask({ column: "building", cumulativeActiveMs: 600_000, executionStartedAt: "2026-09-16T11:50:00.000Z" });
    expect(getTaskRuntimeBreakdown(renamed, FN457_NOW)!.executionMs).toBe(600_000);
    expect(getTaskRuntimeBreakdown(renamed, FN457_NOW, { countsTowardWip: true } as never)!.executionMs).toBe(1_200_000);
  });
});
