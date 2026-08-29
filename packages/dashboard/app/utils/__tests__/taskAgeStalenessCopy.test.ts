import { describe, expect, it } from "vitest";
import { getTaskAgeStalenessCopy, shouldShowTaskAgeStalenessBadge } from "../taskAgeStalenessCopy";

describe("taskAgeStalenessCopy", () => {
  it("returns warning copy", () => {
    const copy = getTaskAgeStalenessCopy({
      level: "warning",
      reason: "",
      observedAt: "2026-05-14T00:00:00.000Z",
      ageMs: 26 * 60 * 60_000,
      warningThresholdMs: 24 * 60 * 60_000,
      criticalThresholdMs: 72 * 60 * 60_000,
      column: "in-review",
      paused: false,
    });
    expect(copy?.badgeTone).toBe("warning");
    expect(copy?.description).not.toContain("while paused");
  });

  it("returns critical + paused phrasing", () => {
    const copy = getTaskAgeStalenessCopy({
      level: "critical",
      reason: "",
      observedAt: "2026-05-14T00:00:00.000Z",
      ageMs: 80 * 60 * 60_000,
      warningThresholdMs: 24 * 60 * 60_000,
      criticalThresholdMs: 72 * 60 * 60_000,
      column: "in-review",
      paused: true,
    });
    expect(copy?.badgeTone).toBe("critical");
    expect(copy?.description).toContain("while paused");
  });

  it("returns null/false when absent", () => {
    expect(getTaskAgeStalenessCopy(undefined)).toBeNull();
    expect(shouldShowTaskAgeStalenessBadge({ ageStaleness: undefined })).toBe(false);
  });
});
