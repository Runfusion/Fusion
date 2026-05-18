import { describe, expect, expectTypeOf, it } from "vitest";
import type { PrInfo as CorePrInfo } from "@fusion/core";
import type { PrInfo as DashboardPrInfo } from "../legacy";

describe("legacy PrInfo re-export", () => {
  it("matches the canonical @fusion/core PrInfo type", () => {
    expectTypeOf<DashboardPrInfo>().toEqualTypeOf<CorePrInfo>();
    expectTypeOf<CorePrInfo>().toEqualTypeOf<DashboardPrInfo>();
    expect(true).toBe(true);
  });

  it("preserves PrInfo fields through JSON round-trip", () => {
    const info: DashboardPrInfo = {
      url: "https://github.com/org/repo/pull/42",
      number: 42,
      status: "open",
      title: "Use canonical PrInfo",
      headBranch: "feature/prinfo",
      baseBranch: "main",
      commentCount: 3,
      isDraft: false,
      draft: false,
      autoMergeOnGreen: true,
      autoMergeStrategy: "squash",
      checkRollup: "pending",
      mergeable: "behind",
      lastMergeError: "waiting for checks",
      lastMergeErrorAt: "2026-05-17T12:00:00.000Z",
      lastCommentAt: "2026-05-17T12:10:00.000Z",
      lastCheckedAt: "2026-05-17T12:11:00.000Z",
      lastReviewDecision: "REVIEW_REQUIRED",
    };

    const roundTrip = JSON.parse(JSON.stringify(info)) as DashboardPrInfo;
    expect(roundTrip).toEqual(info);
  });
});
