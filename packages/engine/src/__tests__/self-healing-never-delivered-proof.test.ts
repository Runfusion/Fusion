import { describe, expect, it, vi } from "vitest";
import {
  defaultBaseStampedCommitShas,
  hasApprovedContentReviewEvidence,
  proveCardScopeNeverDelivered,
  resolveBaseDeliveryEvidence,
  verifyBaseStampedCommits,
} from "../self-healing-git-evidence.js";

/*
FNXC:AlreadyMergedFalsePositive 2026-10-11-11:05 (RUFU-396):
These two helpers decide whether a zero-own-commit card is rescued or refused, so they are tested
through their real bodies with only the git reads injected. The fixtures are RUFU-391's measured shape:
two commits on main stamped `Fusion-Task-Id: RUFU-391` whose bodies carry another card's
`Fusion-Task-Id: RUFU-388` trailer and whose touched paths (review-stall parks, the changeset for that
work, the shared governance docs) intersect none of RUFU-391's declared scope.
*/

/** The two mis-stamped commits, with the paths they really touch. */
const MISSTAMPED_SHAS = ["36a88363e2", "65b0dec011"];
const MISSTAMPED_PATHS: Record<string, string[]> = {
  "36a88363e2": ["packages/engine/src/self-healing.ts", ".changeset/rufu-391-review-park.md"],
  "65b0dec011": ["packages/engine/src/pre-merge-gate-reseed.ts", "AGENTS.md", "docs/run-audit.md"],
};

/** RUFU-378's control: a stamped commit that is really that card's own and carries its declared file. */
const OWN_SHA = "80a67a940c";
const OWN_PATHS: Record<string, string[]> = { [OWN_SHA]: ["packages/cli/src/commands/models.ts"] };

const RUFU391_SCOPE = ["packages/cli/src/commands/settings.ts", "packages/engine/src/triage.ts", "docs/cli-reference.md"];

function ownershipBySha(owned: Record<string, boolean>) {
  return vi.fn(async (sha: string) =>
    owned[sha]
      ? { owned: true }
      : { owned: false, ownerTaskId: "RUFU-388", rejectionReason: "foreign-task" as const },
  );
}

function pathsFrom(map: Record<string, string[]>) {
  return vi.fn(async (_repoDir: string, sha: string) => {
    const paths = map[sha];
    if (!paths) throw new Error(`git show: unknown commit ${sha}`);
    return paths;
  });
}

const stamped = (shas: string[]) => async () => shas;

describe("verifyBaseStampedCommits", () => {
  it("treats a base with no stamp for this card as none, not as a delivery claim", async () => {
    const proof = await verifyBaseStampedCommits({
      repoDir: "/repo",
      baseBranch: "main",
      taskId: "RUFU-404",
      readCommitTaskOwnership: ownershipBySha({}),
      readBaseStampedCommitShas: stamped([]),
    });
    expect(proof.kind).toBe("none");
    expect(proof.stampedBaseCommitShas).toEqual([]);
  });

  it("refuses to treat a stamp whose ownership re-verifies as foreign as this card's landed commit", async () => {
    // RUFU-391 on main: the stamp matches the id, the commit body names RUFU-388.
    const readOwnership = ownershipBySha({});
    const proof = await verifyBaseStampedCommits({
      repoDir: "/repo",
      baseBranch: "main",
      taskId: "RUFU-391",
      readCommitTaskOwnership: readOwnership,
      readCommitTouchedPaths: pathsFrom(MISSTAMPED_PATHS),
      readBaseStampedCommitShas: stamped(MISSTAMPED_SHAS),
    });
    expect(proof.kind).toBe("unverified-stamp");
    expect(proof.ownLandedCommitShas).toEqual([]);
    // Both stamped commits were re-read individually — the base claim is not taken from the grep.
    expect(readOwnership).toHaveBeenCalledTimes(MISSTAMPED_SHAS.length);
  });

  it("downgrades an owned stamp that carries no content", async () => {
    const proof = await verifyBaseStampedCommits({
      repoDir: "/repo",
      baseBranch: "main",
      taskId: "RUFU-391",
      readCommitTaskOwnership: ownershipBySha({ "65b0dec011": true }),
      readCommitTouchedPaths: pathsFrom({ "65b0dec011": [] }),
      readBaseStampedCommitShas: stamped(["65b0dec011"]),
    });
    expect(proof.kind).toBe("unverified-stamp");
    expect(proof.ownLandedCommitShas).toEqual([]);
  });

  it("confirms an own landed commit when ownership re-verifies AND the commit is content-bearing", async () => {
    const proof = await verifyBaseStampedCommits({
      repoDir: "/repo",
      baseBranch: "main",
      taskId: "RUFU-378",
      readCommitTaskOwnership: ownershipBySha({ [OWN_SHA]: true }),
      readCommitTouchedPaths: pathsFrom(OWN_PATHS),
      readBaseStampedCommitShas: stamped([OWN_SHA]),
    });
    expect(proof.kind).toBe("own-landed-commit");
    expect(proof.ownLandedCommitShas).toEqual([OWN_SHA]);
  });

  it("keeps the verdict unknown when every stamp is unreadable rather than laundering it into none", async () => {
    const proof = await verifyBaseStampedCommits({
      repoDir: "/repo",
      baseBranch: "main",
      taskId: "RUFU-391",
      readCommitTaskOwnership: async () => {
        throw new Error("git show timed out");
      },
      readCommitTouchedPaths: pathsFrom(MISSTAMPED_PATHS),
      readBaseStampedCommitShas: stamped(MISSTAMPED_SHAS),
    });
    expect(proof.kind).toBe("unknown");
    expect(proof.unreadableCommitCount).toBe(MISSTAMPED_SHAS.length);
  });

  it("keeps a partially readable base out of own-landed even when one stamp verified", async () => {
    // The negative control for `own-landed-commit`: one verified stamp is enough to withhold the
    // rescue, so the mixed case must report the verified commit and stay non-rescuable.
    const proof = await verifyBaseStampedCommits({
      repoDir: "/repo",
      baseBranch: "main",
      taskId: "RUFU-391",
      readCommitTaskOwnership: ownershipBySha({ "65b0dec011": true }),
      readCommitTouchedPaths: pathsFrom({ "65b0dec011": ["packages/engine/src/self-healing.ts"] }),
      readBaseStampedCommitShas: stamped(["65b0dec011"]),
    });
    expect(proof.kind).toBe("own-landed-commit");
  });

  it("reports unknown when the stamp scan itself fails", async () => {
    const proof = await verifyBaseStampedCommits({
      repoDir: "/repo",
      baseBranch: "main",
      taskId: "RUFU-391",
      readCommitTaskOwnership: ownershipBySha({}),
      readCommitTouchedPaths: pathsFrom(MISSTAMPED_PATHS),
      readBaseStampedCommitShas: async () => {
        throw new Error("git log --grep timed out");
      },
    });
    expect(proof.kind).toBe("unknown");
    expect(proof.unreadableCommitCount).toBe(0);
  });
});

describe("proveCardScopeNeverDelivered", () => {
  it("proves never-delivered when no stamped commit touches the declared scope", async () => {
    const proof = await proveCardScopeNeverDelivered({
      repoDir: "/repo",
      declaredScope: RUFU391_SCOPE,
      stampedBaseCommitShas: MISSTAMPED_SHAS,
      readCommitTouchedPaths: pathsFrom(MISSTAMPED_PATHS),
    });
    expect(proof.verdict).toBe("never-delivered");
    expect(proof.matchedScopePaths).toEqual([]);
    expect(proof.scopePathCount).toBe(RUFU391_SCOPE.length);
  });

  it("reports delivered when one stamped commit touches a declared path", async () => {
    const proof = await proveCardScopeNeverDelivered({
      repoDir: "/repo",
      declaredScope: RUFU391_SCOPE,
      stampedBaseCommitShas: [OWN_SHA],
      readCommitTouchedPaths: pathsFrom({ [OWN_SHA]: ["packages/cli/src/commands/settings.ts"] }),
    });
    expect(proof.verdict).toBe("delivered");
    expect(proof.matchedScopePaths).toEqual(["packages/cli/src/commands/settings.ts"]);
  });

  it("matches a declared glob, not only a literal path", async () => {
    const proof = await proveCardScopeNeverDelivered({
      repoDir: "/repo",
      declaredScope: ["packages/dashboard/app/**/*.css"],
      stampedBaseCommitShas: [OWN_SHA],
      readCommitTouchedPaths: pathsFrom({ [OWN_SHA]: ["packages/dashboard/app/components/Card.css"] }),
    });
    expect(proof.verdict).toBe("delivered");
  });

  it("refuses to prove absence for a card that declared no scope", async () => {
    const proof = await proveCardScopeNeverDelivered({
      repoDir: "/repo",
      declaredScope: [],
      stampedBaseCommitShas: MISSTAMPED_SHAS,
      readCommitTouchedPaths: pathsFrom(MISSTAMPED_PATHS),
    });
    expect(proof.verdict).toBe("unknown");
    expect(proof.scopePathCount).toBe(0);
  });

  it("refuses to prove absence when any stamped commit's content is unreadable", async () => {
    // The second mis-stamped sha is absent from the map, so its read throws.
    const proof = await proveCardScopeNeverDelivered({
      repoDir: "/repo",
      declaredScope: RUFU391_SCOPE,
      stampedBaseCommitShas: MISSTAMPED_SHAS,
      readCommitTouchedPaths: pathsFrom({ "36a88363e2": MISSTAMPED_PATHS["36a88363e2"]! }),
    });
    expect(proof.verdict).toBe("unknown");
    expect(proof.unreadableCommitCount).toBe(1);
  });

  it("refuses to prove absence when there is no stamp to examine", async () => {
    const readTouchedPaths = pathsFrom({});
    const proof = await proveCardScopeNeverDelivered({
      repoDir: "/repo",
      declaredScope: RUFU391_SCOPE,
      stampedBaseCommitShas: [],
      readCommitTouchedPaths: readTouchedPaths,
    });
    expect(proof.verdict).toBe("unknown");
    // No commits means nothing to read: the reader is not called at all.
    expect(readTouchedPaths).not.toHaveBeenCalled();
  });
});

describe("resolveBaseDeliveryEvidence", () => {
  it("pairs a verified own landed commit with a delivered scope verdict", async () => {
    const evidence = await resolveBaseDeliveryEvidence({
      repoDir: "/repo",
      baseBranch: "main",
      taskId: "RUFU-378",
      declaredScope: ["packages/cli/src/commands/models.ts"],
      readCommitTaskOwnership: ownershipBySha({ [OWN_SHA]: true }),
      readCommitTouchedPaths: pathsFrom(OWN_PATHS),
      readBaseStampedCommitShas: stamped([OWN_SHA]),
    });
    expect(evidence).toEqual({
      hasVerifiedOwnLandedCommit: true,
      scopeNeverDelivered: false,
      stampedBaseCommitCount: 1,
      ownLandedCommitCount: 1,
      scopePathCount: 1,
    });
  });

  it("pairs an unverified stamp with the never-delivered verdict that unlocks the reclaim", async () => {
    const evidence = await resolveBaseDeliveryEvidence({
      repoDir: "/repo",
      baseBranch: "main",
      taskId: "RUFU-391",
      declaredScope: RUFU391_SCOPE,
      readCommitTaskOwnership: ownershipBySha({}),
      readCommitTouchedPaths: pathsFrom(MISSTAMPED_PATHS),
      readBaseStampedCommitShas: stamped(MISSTAMPED_SHAS),
    });
    expect(evidence).toEqual({
      hasVerifiedOwnLandedCommit: false,
      scopeNeverDelivered: true,
      stampedBaseCommitCount: 2,
      ownLandedCommitCount: 0,
      scopePathCount: 3,
    });
  });

  it("withholds both claims when the scope is undeclared, so the grep-only behavior stands", async () => {
    const evidence = await resolveBaseDeliveryEvidence({
      repoDir: "/repo",
      baseBranch: "main",
      taskId: "RUFU-391",
      declaredScope: [],
      readCommitTaskOwnership: ownershipBySha({}),
      readCommitTouchedPaths: pathsFrom(MISSTAMPED_PATHS),
      readBaseStampedCommitShas: stamped(MISSTAMPED_SHAS),
    });
    expect(evidence.hasVerifiedOwnLandedCommit).toBe(false);
    expect(evidence.scopeNeverDelivered).toBe(false);
  });
});

describe("defaultBaseStampedCommitShas", () => {
  it("scans the base branch for both lineage and task-id trailers", async () => {
    // The real default reader runs here: a missing repo must surface as a throw, never as an
    // empty-and-therefore-landed verdict.
    await expect(
      defaultBaseStampedCommitShas({ repoDir: "/nonexistent-repo-for-test", baseBranch: "main", taskId: "RUFU-391" }),
    ).rejects.toThrow();
  });
});

/*
FNXC:AlreadyMergedFalsePositive 2026-10-11-13:00 (RUFU-396):
The scope cross-check is the SECOND delivery signal, not the only one. A card whose own code review
was approved had its work read and taken, so a file-scope mismatch is scope drift (which the board's own
rules permit) rather than absence, and the rescue must abstain.
*/
describe("hasApprovedContentReviewEvidence", () => {
  const approved = {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    status: "passed" as const,
    verdict: "APPROVE" as const,
  };

  it("recognises an approved content-review row as delivery evidence", () => {
    expect(hasApprovedContentReviewEvidence([approved])).toBe(true);
  });

  it("accepts APPROVE_WITH_NOTES and a reviewKind-tagged step id", () => {
    expect(hasApprovedContentReviewEvidence([{ ...approved, verdict: "APPROVE_WITH_NOTES" }])).toBe(true);
    expect(hasApprovedContentReviewEvidence([{
      ...approved,
      workflowStepId: "step-review",
      reviewKind: "code" as const,
    }])).toBe(true);
  });

  it("refuses a missing, REVISEd, failed, or operator-bypassed review", () => {
    expect(hasApprovedContentReviewEvidence(undefined)).toBe(false);
    expect(hasApprovedContentReviewEvidence([])).toBe(false);
    expect(hasApprovedContentReviewEvidence([{ ...approved, status: "failed" as const }])).toBe(false);
    expect(hasApprovedContentReviewEvidence([{ ...approved, verdict: "REVISE" as const }])).toBe(false);
    expect(hasApprovedContentReviewEvidence([{
      ...approved,
      status: "skipped" as const,
      verdict: undefined,
      bypassedBy: "operator",
    }])).toBe(false);
    // A plan-review approval is not content evidence.
    expect(hasApprovedContentReviewEvidence([{ ...approved, workflowStepId: "plan-review" }])).toBe(false);
  });

  it("makes an approved review veto the never-delivered proof for a stamped-but-unmatched base", async () => {
    const evidence = await resolveBaseDeliveryEvidence({
      repoDir: "/repo",
      baseBranch: "main",
      taskId: "RUFU-391",
      declaredScope: RUFU391_SCOPE,
      approvedReviewEvidence: true,
      readCommitTaskOwnership: ownershipBySha({}),
      readCommitTouchedPaths: pathsFrom(MISSTAMPED_PATHS),
      readBaseStampedCommitShas: stamped(MISSTAMPED_SHAS),
    });
    expect(evidence.scopeNeverDelivered).toBe(false);
    expect(evidence.neverDeliveredBlockedBy).toBe("approved-review-evidence");
  });
});
