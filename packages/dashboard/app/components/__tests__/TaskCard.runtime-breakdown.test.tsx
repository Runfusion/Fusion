/*
FN-457 — the card's clock chip must show worked time, not wall clock, and explain itself on hover.

ORIGINAL SYMPTOM: in the wip lane the chip measured wall clock since column entry, so a card parked
overnight showed "14h" for twenty real minutes of work. In review/complete it summed planning +
execution and counted verification-gate time nowhere. Its tooltip offered no detail. And any naive
sum of `workflowStepResults` would have double-counted twice over: the Plan Review gate already
lives in `cumulativePlanningMs`, and a `source: "node"` skill result already lives in
`cumulativeActiveMs`.

THREE MUTATIONS MUST TURN THIS FILE RED: neutralizing the pause deduction, replacing the verification
allow-list with a naive `getWorkflowRuntimeMs` sum, and dropping the detail lines from `title`.
*/
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import type { Task, WorkflowStepResult } from "@fusion/core";
import { TaskCard } from "../TaskCard";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");

vi.mock("../../hooks/useLiveTimeTicker", () => ({
  useLiveTimeTicker: () => Date.parse("2026-09-16T12:00:00.000Z"),
}));

const noop = () => {};

function gate(overrides: Partial<WorkflowStepResult>): WorkflowStepResult {
  return {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    status: "passed",
    ...overrides,
  } as WorkflowStepResult;
}

function card(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-457",
    title: "a measured card",
    description: "t",
    column: "in-progress",
    steps: [],
    dependencies: [],
    log: [],
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    firstExecutionAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  } as unknown as Task;
}

function chipOf(task: Task, flags?: Record<string, boolean>): HTMLElement {
  const { container } = render(
    <TaskCard task={task} taskColumnFlags={flags as never} onOpenDetail={noop} addToast={noop} />,
  );
  const chip = container.querySelector(".card-time-indicator");
  expect(chip, "the clock chip must render").not.toBeNull();
  return chip as HTMLElement;
}

/** Parse the three detail lines back out of the tooltip so the sum can be checked. */
function detailMinutes(title: string): { planning: number; execution: number; verification: number } {
  const read = (label: string): number => {
    const match = new RegExp(`${label} (\\d+)([mhd])`).exec(title);
    if (!match) return 0;
    const value = Number(match[1]);
    return match[2] === "m" ? value : match[2] === "h" ? value * 60 : value * 60 * 24;
  };
  return { planning: read("Planning"), execution: read("Execution(?! time)"), verification: read("Verification") };
}

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true, writable: true });
});

/*
The exact Symptom Verification fixture: 10 minutes actually worked inside a 4-hour window that is
almost entirely a 3h50 pause, plus three workflow results of which only one is verification.
*/
function symptomTask(): Task {
  return card({
    column: "in-progress",
    /* The live wip segment opened four hours ago and has been paused for all but its first ten
       minutes, so the honest execution figure is 10m and the wall clock is 4h. */
    cumulativeActiveMs: 0,
    executionStartedAt: "2026-09-16T08:00:00.000Z",
    paused: true,
    cumulativePausedMs: 0,
    pausedStartedAt: "2026-09-16T08:10:00.000Z",
    workflowStepResults: [
      gate({ workflowStepId: "plan-review", workflowStepName: "Plan Review", reviewKind: "plan", source: "optional-group", startedAt: "2026-09-16T07:50:00.000Z", completedAt: "2026-09-16T07:55:00.000Z" }),
      gate({ workflowStepId: "implement", workflowStepName: "Implement", source: "node", startedAt: "2026-09-16T08:00:00.000Z", completedAt: "2026-09-16T08:30:00.000Z" }),
      gate({ reviewKind: "code", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:08:00.000Z" }),
    ],
  });
}

describe("FN-457 symptom: the chip reports worked time, not wall clock", () => {
  it("does not show the four-hour wall clock for ten minutes of work", () => {
    const chip = chipOf(symptomTask());
    expect(chip.textContent).not.toMatch(/\b4h\b/);
    // 10 min execution + 8 min verification, pause fully deducted.
    expect(chip.textContent).toContain("18m");
  });

  it("puts the three detail lines in the tooltip, summing exactly to the label", () => {
    const chip = chipOf(symptomTask());
    const title = chip.getAttribute("title") ?? "";
    expect(title).toContain("Planning");
    expect(title).toContain("Execution");
    expect(title).toContain("Verification");

    const parts = detailMinutes(title);
    expect(parts.planning + parts.execution + parts.verification).toBe(18);
  });

  it("counts ONLY the code-review gate as verification", () => {
    // 5 min of Plan Review is already in cumulativePlanningMs; 30 min of skill node work is already
    // in cumulativeActiveMs. A naive sum would add 35 minutes that are counted elsewhere.
    const parts = detailMinutes(chipOf(symptomTask()).getAttribute("title") ?? "");
    expect(parts.verification).toBe(8);
    expect(parts.execution).toBe(10);
  });

  it("renders the same tooltip at a narrow and a wide viewport", () => {
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true, writable: true });
    const narrow = chipOf(symptomTask()).getAttribute("title");
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
    const wide = chipOf(symptomTask()).getAttribute("title");
    expect(narrow).toBe(wide);
  });

  it("mirrors the tooltip content into aria-label on one line", () => {
    const chip = chipOf(symptomTask());
    const title = chip.getAttribute("title") ?? "";
    const aria = chip.getAttribute("aria-label") ?? "";
    expect(aria).not.toContain("\n");
    for (const line of title.split("\n")) expect(aria).toContain(line);
  });
});

describe("FN-457 lanes and roles", () => {
  const withGates = {
    cumulativePlanningMs: 300_000,
    cumulativeActiveMs: 600_000,
    workflowStepResults: [gate({ reviewKind: "code", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:08:00.000Z" })],
  };

  it("wip lane, legacy id: label plus three detail lines", () => {
    const chip = chipOf(card({ column: "in-progress", ...withGates }));
    expect(chip.getAttribute("title")).toContain("In progress");
    expect(detailMinutes(chip.getAttribute("title") ?? "")).toEqual({ planning: 5, execution: 10, verification: 8 });
  });

  it("review lane, legacy id", () => {
    const chip = chipOf(card({ column: "in-review", ...withGates }));
    expect(chip.getAttribute("title")).toContain("Execution time");
    expect(detailMinutes(chip.getAttribute("title") ?? "")).toEqual({ planning: 5, execution: 10, verification: 8 });
  });

  it("complete lane keeps the tested Completed suffix", () => {
    /* `getDoneCompletionMs` reads the real wall clock, so the completion stamp must be in the past. */
    const chip = chipOf(card({ column: "done", columnMovedAt: "2026-09-16T00:30:00.000Z", ...withGates }));
    expect(chip.getAttribute("title")).toContain("Completed");
    expect(detailMinutes(chip.getAttribute("title") ?? "")).toEqual({ planning: 5, execution: 10, verification: 8 });
  });

  it("renamed wip lane with resolved flags counts the live execution segment", () => {
    const chip = chipOf(
      card({ column: "building", cumulativeActiveMs: 600_000, executionStartedAt: "2026-09-16T11:50:00.000Z" }),
      { countsTowardWip: true },
    );
    // 10 min persisted + 10 min live.
    expect(chip.textContent).toContain("20m");
  });

  it("renamed review lane with resolved flags renders the chip", () => {
    const chip = chipOf(card({ column: "verifying", ...withGates }), { mergeBlocker: true });
    expect(detailMinutes(chip.getAttribute("title") ?? "")).toEqual({ planning: 5, execution: 10, verification: 8 });
  });

  it("an active merge keeps its Merge phase header and counts live merge time as verification", () => {
    const chip = chipOf(card({
      column: "in-review",
      status: "merging",
      updatedAt: "2026-09-16T11:58:00.000Z",
      cumulativeActiveMs: 600_000,
    }));
    const title = chip.getAttribute("title") ?? "";
    expect(title).toContain("Merge phase");
    const parts = detailMinutes(title);
    expect(parts.verification).toBe(2);
    expect(parts.planning + parts.execution + parts.verification).toBe(12);
  });
});

describe("FN-457 data states", () => {
  it("a legacy card with only columnMovedAt still renders a chip", () => {
    const chip = chipOf(card({ column: "in-progress", columnMovedAt: "2026-09-16T11:30:00.000Z" }));
    expect(chip.textContent).toContain("30m");
  });

  it("a card with only timedExecutionMs zeroes verification to avoid double counting", () => {
    const chip = chipOf(card({
      column: "in-review",
      timedExecutionMs: 420_000,
      workflowStepResults: [gate({ reviewKind: "code", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:08:00.000Z" })],
    }));
    expect(detailMinutes(chip.getAttribute("title") ?? "")).toEqual({ planning: 0, execution: 7, verification: 0 });
  });

  it("a card with only workflow verification gates reports verification alone", () => {
    const chip = chipOf(card({
      column: "in-review",
      cumulativeActiveMs: 0,
      workflowStepResults: [gate({ reviewKind: "code", startedAt: "2026-09-16T11:00:00.000Z", completedAt: "2026-09-16T11:08:00.000Z" })],
    }));
    expect(detailMinutes(chip.getAttribute("title") ?? "")).toEqual({ planning: 0, execution: 0, verification: 8 });
  });

  it("a closed pause is deducted even when the card is no longer paused", () => {
    const chip = chipOf(card({ column: "in-review", cumulativeActiveMs: 600_000, cumulativePausedMs: 300_000 }));
    expect(detailMinutes(chip.getAttribute("title") ?? "").execution).toBe(5);
  });

  it("an ORPHANED pausedStartedAt on an unpaused card deducts nothing", () => {
    // Deducting a segment that ended hours ago would grow without bound and empty the chip.
    const chip = chipOf(card({
      column: "in-review",
      cumulativeActiveMs: 600_000,
      pausedStartedAt: "2026-09-16T00:00:00.000Z",
    }));
    expect(detailMinutes(chip.getAttribute("title") ?? "").execution).toBe(10);
  });

  it("a pause taken outside the wip lane never banked, so nothing is deducted", () => {
    const chip = chipOf(card({ column: "in-review", cumulativeActiveMs: 600_000, paused: true }));
    expect(detailMinutes(chip.getAttribute("title") ?? "").execution).toBe(10);
  });

  it("keeps the lines summing to the label under wall-clock clamping", () => {
    const young = "2026-09-16T11:55:00.000Z";
    const chip = chipOf(card({
      column: "in-review",
      createdAt: young,
      firstExecutionAt: young,
      cumulativePlanningMs: 60_000,
      cumulativeActiveMs: 99_000_000,
    }));
    const title = chip.getAttribute("title") ?? "";
    const parts = detailMinutes(title);
    expect(parts.planning + parts.execution + parts.verification).toBe(5);
    expect(chip.textContent).toContain("5m");
  });

  it("uses `now` consistently with the frozen ticker", () => {
    expect(NOW).toBe(Date.parse("2026-09-16T12:00:00.000Z"));
  });
});
