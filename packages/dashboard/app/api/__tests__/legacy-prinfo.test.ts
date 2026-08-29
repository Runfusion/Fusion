import { describe, expect, it } from "vitest";
import type { PrInfo } from "../legacy";

describe("legacy PrInfo surface", () => {
  it("supports optional PR automation and draft fields", () => {
    const info: PrInfo = {
      url: "https://github.com/org/repo/pull/1",
      number: 1,
      status: "open",
      title: "Add feature",
      headBranch: "feature-branch",
      baseBranch: "main",
      commentCount: 2,
      isDraft: true,
      draft: true,
      autoMergeOnGreen: true,
      autoMergeStrategy: "squash",
      lastMergeError: "merge blocked",
      lastMergeErrorAt: "2026-05-17T12:00:00.000Z",
      checkRollup: "pending",
      mergeable: "blocked",
      lastCommentAt: "2026-05-17T12:01:00.000Z",
      lastCheckedAt: "2026-05-17T12:02:00.000Z",
      lastReviewDecision: "REVIEW_REQUIRED",
    };

    expect(info.draft).toBe(true);
    expect(info.isDraft).toBe(true);
    expect(info.autoMergeOnGreen).toBe(true);
    expect(info.autoMergeStrategy).toBe("squash");
    expect(info.lastMergeError).toBe("merge blocked");
    expect(info.lastMergeErrorAt).toBe("2026-05-17T12:00:00.000Z");
    expect(info.checkRollup).toBe("pending");
  });
});
