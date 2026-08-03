import { describe, expect, it } from "vitest";
import {
  BLOCKED_THRASH_LIMIT,
  classifyBlockedExit,
  countBlockedThrashHits,
  isDurableBlockedTask,
  partitionBlockedByRefs,
} from "../execution-block-classifier.js";

/*
FNXC:HonestBlockedExit 2026-08-02-23:59 (operator decision — FN-8728 vs PR #2398):
Blocked exits classify on Fusion task dependencies ONLY. PR refs and file-claim
reason language must never produce a durable park — open PRs are not blockers.
*/

describe("partitionBlockedByRefs", () => {
  it("keeps task ids and discards legacy pr refs and junk", () => {
    expect(partitionBlockedByRefs(["FN-8145", "pr:2398", "#2400", "PR-12", "  ", "fn-8145"])).toEqual({
      taskIds: ["FN-8145"],
    });
  });
});

describe("classifyBlockedExit", () => {
  it("allows auto-replan for empty blockers regardless of reason prose", () => {
    const c = classifyBlockedExit("requirements contradict each other", []);
    expect(c.allowAutoReplan).toBe(true);
    expect(c.class).toBe("plan-defect");
  });

  it("ignores file-claim / PR language — reason prose never makes a block durable", () => {
    const reason =
      "Required SQL finding packages/core/src/task-store/reads.ts:619 is actively claimed by PR #2398. " +
      "check-file-claimed reports collision policy.";
    const c = classifyBlockedExit(reason, []);
    expect(c.allowAutoReplan).toBe(true);
    expect(c.class).toBe("plan-defect");
  });

  it("rejects auto-replan when blockedBy carries task deps", () => {
    const c = classifyBlockedExit("waiting on upstream", ["FN-8145"]);
    expect(c.allowAutoReplan).toBe(false);
    expect(c.class).toBe("external");
    expect(c.thrashSignature).toBe("tasks:FN-8145");
  });

  it("discards pr: refs in blockedBy — a PR-only block is a plan defect", () => {
    const c = classifyBlockedExit("files claimed", ["pr:2398"]);
    expect(c.allowAutoReplan).toBe(true);
    expect(c.class).toBe("plan-defect");
  });
});

describe("isDurableBlockedTask", () => {
  it("honors only metadata-classed external (task-dependency) parks", () => {
    expect(
      isDurableBlockedTask({
        status: "failed",
        error: "BLOCKED: waiting on FN-8145",
        sourceMetadata: { blockedClass: "external" },
      }),
    ).toBe(true);
    // Legacy FN-8700 file-claim parks are deliberately NOT durable anymore.
    expect(
      isDurableBlockedTask({
        status: "failed",
        error: "BLOCKED: actively claimed by PR #2398",
        sourceMetadata: {
          blockedClass: "file-claim",
          externalBlockers: [{ kind: "github-pr", number: 2398 }],
        },
      }),
    ).toBe(false);
    expect(
      isDurableBlockedTask({ status: "failed", error: "BLOCKED: actively claimed by PR #2398" }),
    ).toBe(false);
  });
});

describe("countBlockedThrashHits", () => {
  it("counts recent BLOCKED log rows matching the task-dependency signature", () => {
    const now = Date.parse("2026-08-02T01:30:00.000Z");
    const log = [
      { action: "BLOCKED: waiting on FN-8145", timestamp: "2026-08-02T01:00:00.000Z" },
      { action: "BLOCKED: still waiting on FN-8145", timestamp: "2026-08-02T01:10:00.000Z" },
      { action: "BLOCKED: waiting on FN-8145", timestamp: "2026-08-02T01:20:00.000Z" },
      { action: "unrelated progress", timestamp: "2026-08-02T01:25:00.000Z" },
    ];
    const sig = classifyBlockedExit("waiting on upstream", ["FN-8145"]).thrashSignature;
    expect(countBlockedThrashHits(log, sig, now)).toBeGreaterThanOrEqual(BLOCKED_THRASH_LIMIT);
  });

  it("never counts hits for the plan-defect signature", () => {
    const now = Date.parse("2026-08-02T01:30:00.000Z");
    const log = [{ action: "BLOCKED: anything", timestamp: "2026-08-02T01:20:00.000Z" }];
    expect(countBlockedThrashHits(log, "plan-defect", now)).toBe(0);
  });
});
