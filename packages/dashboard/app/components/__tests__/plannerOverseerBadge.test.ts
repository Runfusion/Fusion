import { describe, it, expect } from "vitest";
import { plannerOverseerBadgeTooltip, plannerOverseerStateLabel } from "../plannerOverseerBadge";
import type { PlannerOverseerRuntimeSnapshot, PlannerOverseerState } from "@fusion/core";

const NON_IDLE_STATES: PlannerOverseerState[] = [
  "watching",
  "steering",
  "recovering",
  "awaiting-confirmation",
];

function makeSnapshot(
  overrides: Partial<PlannerOverseerRuntimeSnapshot> = {},
): Pick<PlannerOverseerRuntimeSnapshot, "state" | "reason" | "watchedStage" | "signal" | "pendingConfirmation"> {
  return {
    state: "watching",
    reason: undefined,
    watchedStage: undefined,
    signal: undefined,
    pendingConfirmation: undefined,
    ...overrides,
  };
}

describe("plannerOverseerStateLabel", () => {
  for (const state of NON_IDLE_STATES) {
    it(`renders a human-readable label for "${state}" (no raw kebab-case)`, () => {
      const label = plannerOverseerStateLabel(state);
      expect(label).not.toBe(state);
      expect(label).not.toMatch(/-/);
    });
  }

  it("renders a distinct readable label for awaiting-confirmation", () => {
    expect(plannerOverseerStateLabel("awaiting-confirmation")).toBe("Awaiting confirmation");
  });
});

describe("plannerOverseerBadgeTooltip", () => {
  it("uses the verbatim reason when present", () => {
    const tooltip = plannerOverseerBadgeTooltip(
      makeSnapshot({ state: "steering", reason: "Executor is stalled on step 3" }),
    );
    expect(tooltip).toContain("Executor is stalled on step 3");
  });

  it("falls back gracefully (no literal undefined) when reason is absent", () => {
    const tooltip = plannerOverseerBadgeTooltip(makeSnapshot({ state: "watching", reason: undefined }));
    expect(tooltip).not.toMatch(/undefined/);
    expect(tooltip.length).toBeGreaterThan(0);
  });

  it("appends watched stage and signal when both present", () => {
    const tooltip = plannerOverseerBadgeTooltip(
      makeSnapshot({ state: "recovering", watchedStage: "executor", signal: "progressing" }),
    );
    expect(tooltip).toContain("executor");
    expect(tooltip).toContain("progressing");
    expect(tooltip).not.toMatch(/undefined/);
  });

  it("appends watched stage without a signal clause when signal is absent", () => {
    const tooltip = plannerOverseerBadgeTooltip(makeSnapshot({ state: "steering", watchedStage: "executor" }));
    expect(tooltip).toContain("executor");
    expect(tooltip).not.toMatch(/undefined/);
  });

  it("omits stage/signal wording entirely when both are absent", () => {
    const tooltip = plannerOverseerBadgeTooltip(makeSnapshot({ state: "steering", reason: "Applying a targeted fix" }));
    expect(tooltip).not.toMatch(/undefined/);
  });

  it("explains a pending human decision for awaiting-confirmation regardless of the pendingConfirmation flag value", () => {
    const tooltip = plannerOverseerBadgeTooltip(
      makeSnapshot({ state: "awaiting-confirmation", reason: "Retry limit reached", pendingConfirmation: true }),
    );
    expect(tooltip).toMatch(/human decision/i);
  });

  it("explains a pending human decision when pendingConfirmation is true even outside the awaiting-confirmation state", () => {
    const tooltip = plannerOverseerBadgeTooltip(
      makeSnapshot({ state: "watching", reason: "Observing", pendingConfirmation: true }),
    );
    expect(tooltip).toMatch(/human decision/i);
  });

  it("does not mention a pending decision when pendingConfirmation is false and state is not awaiting-confirmation", () => {
    const tooltip = plannerOverseerBadgeTooltip(
      makeSnapshot({ state: "watching", reason: "Observing", pendingConfirmation: false }),
    );
    expect(tooltip).not.toMatch(/human decision/i);
  });

  it("never emits the raw kebab-case state string when reason is absent (uses the readable label instead)", () => {
    // Only "awaiting-confirmation" is kebab-case; the others contain no hyphen
    // so a substring check would be trivially true. Assert the hyphenated raw
    // form specifically never leaks into the tooltip.
    const tooltip = plannerOverseerBadgeTooltip(
      makeSnapshot({ state: "awaiting-confirmation", reason: undefined }),
    );
    expect(tooltip).not.toContain("awaiting-confirmation");
  });
});
