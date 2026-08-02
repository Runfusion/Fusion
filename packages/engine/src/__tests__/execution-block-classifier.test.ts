import { describe, expect, it } from "vitest";
import {
  BLOCKED_THRASH_LIMIT,
  classifyBlockedExit,
  countBlockedThrashHits,
  isDurableBlockedError,
  isDurableBlockedTask,
  isFileClaimBlockedReason,
  partitionBlockedByRefs,
} from "../execution-block-classifier.js";

describe("partitionBlockedByRefs", () => {
  it("splits task ids from pr refs", () => {
    expect(partitionBlockedByRefs(["FN-8145", "pr:2398", "#2400", "PR-12", "  "])).toEqual({
      taskIds: ["FN-8145"],
      prNumbers: [2398, 2400, 12],
    });
  });
});

describe("classifyBlockedExit", () => {
  it("allows auto-replan only for plan defects with empty blockers", () => {
    const c = classifyBlockedExit("requirements contradict each other", []);
    expect(c.allowAutoReplan).toBe(true);
    expect(c.class).toBe("plan-defect");
  });

  it("rejects auto-replan for file-claim / PR language (FN-8700)", () => {
    const reason =
      "Required SQL finding packages/core/src/task-store/reads.ts:619 is actively claimed by PR #2398. " +
      "check-file-claimed reports collision policy.";
    const c = classifyBlockedExit(reason, []);
    expect(c.allowAutoReplan).toBe(false);
    expect(c.class).toBe("file-claim");
    expect(c.prNumbers).toContain(2398);
    expect(c.externalBlockers.some((b) => b.kind === "github-pr" && b.number === 2398)).toBe(true);
  });

  it("rejects auto-replan when blockedBy carries task deps", () => {
    const c = classifyBlockedExit("waiting on upstream", ["FN-8145"]);
    expect(c.allowAutoReplan).toBe(false);
    expect(c.class).toBe("external");
  });

  it("accepts pr: refs in blockedBy without treating as plan defect", () => {
    const c = classifyBlockedExit("files claimed", ["pr:2398"]);
    expect(c.allowAutoReplan).toBe(false);
    expect(c.prNumbers).toContain(2398);
  });
});

describe("isFileClaimBlockedReason", () => {
  it("matches claim policy language", () => {
    expect(isFileClaimBlockedReason("actively claimed by PR #2398")).toBe(true);
    expect(isFileClaimBlockedReason("check-file-claimed.mjs reports open PR")).toBe(true);
    expect(isFileClaimBlockedReason("requirements contradict")).toBe(false);
  });
});

describe("isDurableBlockedError / task", () => {
  it("treats claim BLOCKED errors as durable", () => {
    expect(isDurableBlockedError("BLOCKED: path actively claimed by PR #1")).toBe(true);
    expect(isDurableBlockedError("BLOCKED: requirements contradict each other")).toBe(false);
    expect(
      isDurableBlockedTask({
        status: "failed",
        error: "BLOCKED: actively claimed by PR #2398",
      }),
    ).toBe(true);
  });
});

describe("countBlockedThrashHits", () => {
  it("counts recent claim BLOCKED log rows toward the thrash limit", () => {
    const now = Date.parse("2026-08-02T01:30:00.000Z");
    const log = [
      { action: "BLOCKED: actively claimed by PR #2398", timestamp: "2026-08-02T01:00:00.000Z" },
      { action: "BLOCKED: check-file-claimed collision on reads.ts PR #2398", timestamp: "2026-08-02T01:10:00.000Z" },
      { action: "BLOCKED: actively claimed by PR #2398", timestamp: "2026-08-02T01:20:00.000Z" },
      { action: "unrelated progress", timestamp: "2026-08-02T01:25:00.000Z" },
    ];
    const sig = classifyBlockedExit("actively claimed by PR #2398", []).thrashSignature;
    expect(countBlockedThrashHits(log, sig, now)).toBeGreaterThanOrEqual(BLOCKED_THRASH_LIMIT);
  });
});
