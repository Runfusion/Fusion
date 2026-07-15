import { describe, expect, it } from "vitest";
import { ACTIVE_MERGE_PIPELINE_STATUSES, isActiveMergeStatus } from "../active-merge-status.js";

describe("isActiveMergeStatus", () => {
  it("treats the full AI/PR merge pipeline as active merge", () => {
    for (const status of ["merging", "merging-pr", "merging-fix", "reviewing", "landing"]) {
      expect(isActiveMergeStatus(status)).toBe(true);
      expect(ACTIVE_MERGE_PIPELINE_STATUSES.has(status)).toBe(true);
    }
  });

  it("rejects idle and non-merge statuses", () => {
    for (const status of [null, undefined, "", "queued", "planning", "failed", "awaiting-approval"]) {
      expect(isActiveMergeStatus(status)).toBe(false);
    }
  });
});
