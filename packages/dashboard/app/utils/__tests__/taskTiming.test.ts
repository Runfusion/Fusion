import { describe, it, expect } from "vitest";
import { getActiveRuntimeMs, getTotalAgentActiveMs, getWallClockSinceFirstExecutionMs } from "../taskTiming";

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
