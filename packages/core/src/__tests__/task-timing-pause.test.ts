// @vitest-environment node
/*
FN-457 — parity guard between the twin active-time calculations.

`packages/core/src/tasks/task-timing.ts` and `packages/dashboard/app/utils/taskTiming.ts` each carry
a copy of the active-time formula. They have drifted once already (the `columnFlags` conversion
reached core and never reached the dashboard, so the card chip under-reported every in-flight run on
a renamed board) and the drift was only found by a visible production defect.

These fixtures are deliberately IDENTICAL to the FN-457 pause cases in
`packages/dashboard/app/utils/__tests__/taskTiming.test.ts`, with the same expected values written
out literally. A one-sided change to either copy turns one of the two suites red.
*/
import { describe, it, expect } from "vitest";
import { getTotalAgentActiveMs } from "../tasks/task-timing.js";
import type { Task } from "../types.js";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const CREATED = "2026-09-16T00:00:00.000Z";

function timingTask(overrides: Partial<Task> = {}): Task {
  return {
    column: "done",
    cumulativeActiveMs: 600_000,
    executionStartedAt: undefined,
    cumulativePlanningMs: undefined,
    planningStartedAt: undefined,
    createdAt: CREATED,
    firstExecutionAt: CREATED,
    ...overrides,
  } as unknown as Task;
}

describe("core getTotalAgentActiveMs — durable pause deduction parity", () => {
  it("subtracts banked pause from a closed execution total", () => {
    expect(getTotalAgentActiveMs(timingTask({ cumulativePausedMs: 200_000 }), NOW)).toBe(400_000);
  });

  it("subtracts the open pause segment while the card is actually paused", () => {
    expect(getTotalAgentActiveMs(
      timingTask({
        column: "in-progress",
        executionStartedAt: "2026-09-16T11:50:00.000Z",
        paused: true,
        pausedStartedAt: "2026-09-16T11:55:00.000Z",
      }),
      NOW,
    )).toBe(600_000 + 600_000 - 300_000);
  });

  it("honors userPaused as well as paused for the open segment", () => {
    expect(getTotalAgentActiveMs(
      timingTask({ userPaused: true, pausedStartedAt: "2026-09-16T11:55:00.000Z" }),
      NOW,
    )).toBe(300_000);
  });

  it("IGNORES an orphaned pausedStartedAt on a card that is no longer paused", () => {
    expect(getTotalAgentActiveMs(timingTask({ pausedStartedAt: CREATED }), NOW)).toBe(600_000);
  });

  it("never returns a negative total when pause exceeds recorded execution", () => {
    expect(getTotalAgentActiveMs(timingTask({ cumulativeActiveMs: 60_000, cumulativePausedMs: 900_000 }), NOW)).toBe(0);
  });

  it("deducts pause from execution only, leaving planning intact", () => {
    expect(getTotalAgentActiveMs(
      timingTask({ cumulativePlanningMs: 300_000, cumulativePausedMs: 200_000 }),
      NOW,
    )).toBe(700_000);
  });

  it("still returns null when the card carries no timing signal at all", () => {
    expect(getTotalAgentActiveMs(
      timingTask({ cumulativeActiveMs: undefined, cumulativePausedMs: 200_000 }),
      NOW,
    )).toBeNull();
  });
});
