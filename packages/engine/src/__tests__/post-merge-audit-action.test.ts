import { describe, expect, it } from "vitest";
import {
  resolvePostMergeAuditAction,
  type PostMergeAuditAction,
} from "../merger.js";
import type {
  SquashAuditFindings,
  SquashAuditTouchedFileOverlapFinding,
  SquashAuditDuplicateSubjectFinding,
} from "../merge/merger-squash-audit.js";

/**
 * FN-4333 — unit tests for the post-merge audit decision helper.
 *
 * `resolvePostMergeAuditAction` decides whether a dirty audit should block
 * the merge or be passed through. The merger uses this to apply the
 * deterministic-verification short-circuit + the `postMergeAuditMode`
 * setting without spinning up real git/store state.
 */

function overlap(file: string): SquashAuditTouchedFileOverlapFinding {
  return {
    type: "touched-file-overlap",
    file,
    recentMainCommits: [{ sha: "abcdef12", subject: "chore: recent main edit" }],
  };
}

function duplicateSubject(subject: string): SquashAuditDuplicateSubjectFinding {
  return { type: "duplicate-subject", subject };
}

function findings(opts: {
  strategy: "squash" | "rebase";
  duplicates?: SquashAuditDuplicateSubjectFinding[];
  overlaps?: SquashAuditTouchedFileOverlapFinding[];
}): SquashAuditFindings {
  const duplicates = opts.duplicates ?? [];
  const overlaps = opts.overlaps ?? [];
  const list = [...duplicates, ...overlaps];
  const base = {
    parentSha: "0000000000000000000000000000000000000000",
    lookback: 30,
    branchSubjects: [],
    recentMainSubjects: [],
    duplicateSubjects: duplicates,
    touchedFiles: overlaps.map((o) => o.file),
    touchedFileOverlaps: overlaps,
    findings: list,
    issueCount: list.length,
    clean: list.length === 0,
  };
  if (opts.strategy === "rebase") {
    return {
      ...base,
      strategy: "rebase",
      rangeBaseSha: "1".repeat(40),
      rangeHeadSha: "2".repeat(40),
      auditTargetLabel: "11111111..22222222",
    };
  }
  return {
    ...base,
    strategy: "squash",
    squashSha: "3".repeat(40),
    squashSubject: "feat: squash",
    auditTargetLabel: "33333333",
  };
}

describe("resolvePostMergeAuditAction (FN-4333)", () => {
  it("passes through when audit is clean (defensive default)", () => {
    const result = resolvePostMergeAuditAction({
      mode: "block",
      strategy: "rebase",
      findings: findings({ strategy: "rebase" }),
      verificationPassed: false,
    });
    expect(result.action).toBe("pass");
  });

  it("blocks duplicate-subject findings in block mode regardless of verification", () => {
    const result = resolvePostMergeAuditAction({
      mode: "block",
      strategy: "rebase",
      findings: findings({
        strategy: "rebase",
        duplicates: [duplicateSubject("feat: collide")],
        overlaps: [overlap("docs/README.md")],
      }),
      verificationPassed: true,
    });
    expect(result).toEqual<PostMergeAuditAction>({ action: "block", reason: "mode-block" });
  });

  it("short-circuits rebase-strategy overlap-only findings when the tree is verified", () => {
    const result = resolvePostMergeAuditAction({
      mode: "block",
      strategy: "rebase",
      findings: findings({ strategy: "rebase", overlaps: [overlap("docs/README.md")] }),
      verificationPassed: true,
    });
    expect(result).toEqual<PostMergeAuditAction>({ action: "pass", reason: "verified-short-circuit" });
  });

  it("does NOT short-circuit overlap-only findings when the tree was not verified", () => {
    const result = resolvePostMergeAuditAction({
      mode: "block",
      strategy: "rebase",
      findings: findings({ strategy: "rebase", overlaps: [overlap("docs/README.md")] }),
      verificationPassed: false,
    });
    expect(result).toEqual<PostMergeAuditAction>({ action: "block", reason: "mode-block" });
  });

  it("does NOT short-circuit squash-strategy overlap-only findings even when verified (no deterministic guarantee)", () => {
    const result = resolvePostMergeAuditAction({
      mode: "block",
      strategy: "squash",
      findings: findings({ strategy: "squash", overlaps: [overlap("docs/README.md")] }),
      verificationPassed: true,
    });
    expect(result).toEqual<PostMergeAuditAction>({ action: "block", reason: "mode-block" });
  });

  it("passes any dirty audit in warn mode", () => {
    const result = resolvePostMergeAuditAction({
      mode: "warn",
      strategy: "squash",
      findings: findings({
        strategy: "squash",
        duplicates: [duplicateSubject("feat: collide")],
        overlaps: [overlap("packages/dashboard/app/x.tsx")],
      }),
      verificationPassed: false,
    });
    expect(result).toEqual<PostMergeAuditAction>({ action: "pass", reason: "mode-warn" });
  });

  it("prefers verified-short-circuit reason over mode-warn when both would pass", () => {
    const result = resolvePostMergeAuditAction({
      mode: "warn",
      strategy: "rebase",
      findings: findings({ strategy: "rebase", overlaps: [overlap("a.txt")] }),
      verificationPassed: true,
    });
    expect(result).toEqual<PostMergeAuditAction>({ action: "pass", reason: "verified-short-circuit" });
  });
});
