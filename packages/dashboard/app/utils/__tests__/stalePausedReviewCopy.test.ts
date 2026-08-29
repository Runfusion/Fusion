import { describe, expect, it } from "vitest";

import { getStalePausedReviewCopy, shouldShowStalePausedReviewBadge } from "../stalePausedReviewCopy";

describe("stalePausedReviewCopy", () => {
  it("returns populated copy", () => {
    const copy = getStalePausedReviewCopy({
      code: "stale-paused-review",
      reason: "reason",
      observedAt: "2026-05-14T00:00:00.000Z",
      ageMs: 86_400_000,
      thresholdMs: 86_400_000,
    });

    expect(copy.badgeLabel).toBe("Paused stall");
    expect(copy.headline.length).toBeGreaterThan(0);
    expect(copy.description.length).toBeGreaterThan(0);
    expect(copy.suggestedAction).toContain("unpause");
  });

  it.each([
    { column: "in-review", paused: false, stalePausedReview: { code: "stale-paused-review" } },
    { column: "todo", paused: true, stalePausedReview: { code: "stale-paused-review" } },
    { column: "in-review", paused: true, stalePausedReview: undefined },
  ] as const)("hides badge for non-canonical visibility cases", (task) => {
    expect(shouldShowStalePausedReviewBadge(task as any)).toBe(false);
  });

  it("shows badge only for paused in-review task with signal", () => {
    expect(
      shouldShowStalePausedReviewBadge({
        column: "in-review",
        paused: true,
        stalePausedReview: {
          code: "stale-paused-review",
          reason: "r",
          observedAt: "2026-05-14T00:00:00.000Z",
          ageMs: 86_400_000,
          thresholdMs: 86_400_000,
        },
      }),
    ).toBe(true);
  });
});
