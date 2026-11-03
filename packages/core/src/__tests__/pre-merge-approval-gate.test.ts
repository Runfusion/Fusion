import { describe, expect, it } from "vitest";
import { getTaskMergeBlocker } from "../merge/task-merge.js";
import { evaluatePreMergeAdmissionDecision, evaluatePreMergeApprovals, hasValidStaleReviewCallbackWaiver, resolveUnprovenReviewApproval } from "../merge/pre-merge-approval.js";
import { evaluateZeroCommitEmptyInputContentProof } from "../merge/zero-commit-landing-proof.js";

const base = {
  column: "in-review", paused: false, steps: [], repositoryScope: undefined,
};
const required = new Set(["code-review"]);

describe("positive pre-merge approval gate", () => {
  it("accepts only an exact receipt-backed automatic stale callback waiver", () => {
    const result = {
      workflowStepId: "custom-code", workflowStepName: "Custom code", status: "skipped" as const,
      phase: "pre-merge" as const, reviewKind: "code" as const,
      priorAttempts: [{
        workflowStepId: "custom-code", workflowStepName: "Custom code", status: "pending" as const,
        phase: "pre-merge" as const, reviewKind: "code" as const, startedAt: "a",
      }],
      automatedStaleCallbackWaiver: {
        receiptId: "receipt-1", policyVersion: "fn-9429-v1" as const,
        actor: "system:stale-review-callback-waiver" as const,
        reason: "proven-stale-code-review-callback" as const,
        issuedAt: "2026-10-01T00:00:00.000Z", priorStatus: "pending" as const, attemptId: "pending:a:",
      },
    };
    const context = { projectId: "project-a", taskId: "FN-1", requiredPreMergeStepIds: new Set(["custom-code"]), singularScope: true, effectiveAutoMerge: true, hasOpenFindings: false,
      receipts: [{ id: "receipt-1", projectId: "project-a", taskId: "FN-1", workflowStepId: "custom-code", attemptId: "pending:a:", policyVersion: "fn-9429-v1" as const, actor: "system:stale-review-callback-waiver" as const, reason: "proven-stale-code-review-callback" as const, issuedAt: "2026-10-01T00:00:00.000Z", state: "issued" as const }], };
    expect(hasValidStaleReviewCallbackWaiver(result, context)).toBe(true);
    expect(hasValidStaleReviewCallbackWaiver(result, { ...context, taskId: "FN-2" })).toBe(false);
    expect(hasValidStaleReviewCallbackWaiver(result, { ...context, receipts: [] })).toBe(false);
    expect(hasValidStaleReviewCallbackWaiver(result, { ...context, singularScope: false })).toBe(false);
    const task = { ...base, id: "FN-1", workflowStepResults: [result] };
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: new Set(["custom-code"]), mergeContent: { kind: "singular", diff: { state: "empty" } } }))
      .toBe("task has enabled pre-merge workflow steps without a current approval (gate 'custom-code')");
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: new Set(["custom-code"]), mergeContent: { kind: "singular", diff: { state: "empty" } }, staleReviewCallbackWaiver: { projectId: context.projectId, effectiveAutoMerge: true, hasOpenFindings: false, receipts: context.receipts } }))
      .toBeUndefined();
  });

  it("rejects an old receipt copied onto a newer attempt of the same task and step", () => {
    const result = {
      workflowStepId: "custom-code", workflowStepName: "Custom code", status: "skipped" as const,
      phase: "pre-merge" as const, reviewKind: "code" as const,
      priorAttempts: [{
        workflowStepId: "custom-code", workflowStepName: "Custom code", status: "pending" as const,
        phase: "pre-merge" as const, reviewKind: "code" as const, startedAt: "newer-attempt",
      }],
      automatedStaleCallbackWaiver: {
        receiptId: "receipt-1", policyVersion: "fn-9429-v1" as const,
        actor: "system:stale-review-callback-waiver" as const,
        reason: "proven-stale-code-review-callback" as const,
        issuedAt: "2026-10-01T00:00:00.000Z", priorStatus: "pending" as const, attemptId: "pending:older-attempt:",
      },
    };
    const receipts = [{ id: "receipt-1", projectId: "project-a", taskId: "FN-1", workflowStepId: "custom-code", attemptId: "pending:older-attempt:", policyVersion: "fn-9429-v1" as const, actor: "system:stale-review-callback-waiver" as const, reason: "proven-stale-code-review-callback" as const, issuedAt: "2026-10-01T00:00:00.000Z", state: "issued" as const }];
    const context = { projectId: "project-a", taskId: "FN-1", requiredPreMergeStepIds: new Set(["custom-code"]), singularScope: true, effectiveAutoMerge: true, hasOpenFindings: false, receipts };

    expect(hasValidStaleReviewCallbackWaiver(result, context)).toBe(false);
    expect(getTaskMergeBlocker({ ...base, id: "FN-1", workflowStepResults: [result] }, {
      requiredPreMergeStepIds: new Set(["custom-code"]),
      mergeContent: { kind: "singular", diff: { state: "empty" } },
      staleReviewCallbackWaiver: { projectId: context.projectId, effectiveAutoMerge: true, hasOpenFindings: false, receipts },
    })).toBe("task has enabled pre-merge workflow steps without a current approval (gate 'custom-code')");
  });

  it("blocks the FN-175 result-wipe shape", () => {
    expect(getTaskMergeBlocker({ ...base, workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan", status: "passed" }] }, { requiredPreMergeStepIds: required }))
      .toBe("task has enabled pre-merge workflow steps that never ran");
  });

  it("reports the same durable retry carrier that merge admission uses", () => {
    const task = {
      ...base,
      workflowStepResults: [{
        workflowStepId: "code-review", workflowStepName: "Code", status: "passed" as const,
        verdict: "APPROVE" as const, reviewKind: "code" as const, reviewInputFingerprint: "current",
        completedAt: "2026-10-12T17:00:00.000Z",
        priorAttempts: [{ workflowStepId: "code-review", workflowStepName: "Code", status: "failed" as const, reviewKind: "code" as const }],
      }],
    };
    const decision = evaluatePreMergeAdmissionDecision(task, {
      requiredPreMergeStepIds: required,
      mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } },
    });

    expect(decision).toMatchObject({ allApproved: true, gates: [{ workflowStepId: "code-review", state: "approved", selectedResult: { status: "passed", verdict: "APPROVE", reviewInputFingerprint: "current" } }] });
    expect(evaluatePreMergeApprovals(task, {
      requiredPreMergeStepIds: required,
      mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } },
    })).toEqual([{ workflowStepId: "code-review", state: "approved" }]);
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: required, mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } } })).toBeUndefined();
  });

  it("reports a present invalid carrier instead of calling it absent", () => {
    const task = { ...base, workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code", status: "passed" as const, reviewKind: "code" as const, completedAt: "2026-10-12T17:00:00.000Z" }] };
    const decision = evaluatePreMergeAdmissionDecision(task, { requiredPreMergeStepIds: required, mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } } });

    expect(decision).toMatchObject({ allApproved: false, gates: [{ workflowStepId: "code-review", state: "not-approved", selectedResult: { status: "passed" } }] });
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: required, mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } } })).toContain("gate 'code-review'");
  });

  it("rejects a passed Code Review that has no reviewer verdict", () => {
    const task = { ...base, workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code", status: "passed" as const, reviewKind: "code" as const, reviewInputFingerprint: "a" }] };
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: required, mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "a" } } }))
      .toBe("task has enabled pre-merge workflow steps without a current approval (gate 'code-review')");
  });

  it("requires an approving current diff fingerprint", () => {
    const task = { ...base, workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code", status: "passed" as const, verdict: "APPROVE" as const, reviewKind: "code" as const, reviewInputFingerprint: "a" }] };
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: required, mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "a" } } })).toBeUndefined();
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: required, mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "b" } } }))
      .toBe("task has a pre-merge approval recorded against different content");
  });

  it("fails closed when source content cannot be proven", () => {
    const task = { ...base, workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code", status: "passed" as const, verdict: "APPROVE" as const, reviewKind: "code" as const }] };
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: required, mergeContent: { kind: "singular", diff: { state: "unavailable", reason: "git" } } }))
      .toBe("task has no provable approval for the content being merged");
  });

  it("binds an empty-input approval only to a still-empty singular diff", () => {
    const task = {
      ...base,
      workflowStepResults: [{
        workflowStepId: "code-review", workflowStepName: "Code", status: "passed" as const,
        verdict: "APPROVE" as const, reviewKind: "code" as const,
        reviewInputFingerprint: "empty-review-input:v1",
      }],
    };
    const empty = evaluatePreMergeApprovals(task, {
      requiredPreMergeStepIds: required,
      mergeContent: { kind: "singular", diff: { state: "empty" } },
    });
    const populated = evaluatePreMergeApprovals(task, {
      requiredPreMergeStepIds: required,
      mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "a".repeat(64) } },
    });
    /*
    FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-17:27 (RUFU-384):
    RUFU-337 pinned the `unavailable` case as a single unconditional refusal. It is now a PAIR, because the
    two cards that reach this question are different: a commit-expected card whose diff became unreadable
    after review still gets RUFU-337's exact answer, and only a card that holds its own zero-commit
    authorization gets the recognition. The flag is the ONLY difference between the two calls below — same
    row, same marker, same descriptor — so this test is itself the proof that the arm is flag-derived.
    */
    const unavailable = evaluatePreMergeApprovals(task, {
      requiredPreMergeStepIds: required,
      mergeContent: { kind: "singular", diff: { state: "unavailable", reason: "git" } },
    });
    const unavailableAuthorized = evaluatePreMergeApprovals({ ...task, noCommitsExpected: true }, {
      requiredPreMergeStepIds: required,
      mergeContent: { kind: "singular", diff: { state: "unavailable", reason: "missing-worktree-or-base" } },
    });

    expect(empty[0]?.state).toBe("approved");
    expect(populated[0]?.state).toBe("stale-content");
    expect(unavailable[0]?.state).toBe("unprovable-content");
    expect(unavailableAuthorized[0]?.state).toBe("approved");
  });

  /*
  FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-17:27 (RUFU-384):
  The rest of the content-proof matrix the new arm must classify, one case per row. RUFU-365 wedged
  because exactly ONE cell of this matrix had no honest answer: an approved empty-input row over a diff
  that cannot be computed because there is nothing to compute. Every other cell keeps RUFU-337's answer.
  */
  const emptyApprovalRow = {
    workflowStepId: "code-review", workflowStepName: "Code", status: "passed" as const,
    verdict: "APPROVE" as const, reviewKind: "code" as const,
    reviewInputFingerprint: "empty-review-input:v1",
  };
  const unavailableContent = { kind: "singular" as const, diff: { state: "unavailable" as const, reason: "missing-worktree-or-base" } };

  /*
  FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-18:50 (RUFU-384, code-review P0):
  `unavailable` is a STATE, not a finding. `probeReviewDiffFingerprint` reaches it for three reasons and two
  of them are evidence that content EXISTS: `git-diff-too-large` means more than 10 MiB of patch was streamed,
  and `git-diff-failed` means a present checkout could not be read. A waiver keyed on the state alone would
  squash-merge that content under an approval bound to an empty diff — the FN-9234 class this change is
  forbidden to weaken — so each content-bearing reason is pinned here at BOTH seams the operator sees: the
  gate state and the door sentence.
  */
  const contentBearingUnavailableReasons = ["git-diff-too-large", "git-diff-failed"] as const;

  it.each(contentBearingUnavailableReasons)(
    "refuses an authorized empty-marker row whose diff is unavailable because %s proves content exists",
    (reason) => {
      const approvals = evaluatePreMergeApprovals({ ...base, noCommitsExpected: true, workflowStepResults: [emptyApprovalRow] }, {
        requiredPreMergeStepIds: required,
        mergeContent: { kind: "singular", diff: { state: "unavailable", reason } },
      });
      expect(approvals[0]?.state).toBe("unprovable-content");
    },
  );

  it("keeps an empty-marker approval stale when content appears after review", () => {
    const approved = evaluatePreMergeApprovals({ ...base, noCommitsExpected: true, workflowStepResults: [emptyApprovalRow] }, {
      requiredPreMergeStepIds: required,
      mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "a".repeat(64) } },
    });
    expect(approved[0]?.state).toBe("stale-content");
  });

  it("reports a required gate with no row as missing even for an authorized zero-commit card", () => {
    const noRow = evaluatePreMergeApprovals({ ...base, noCommitsExpected: true, workflowStepResults: [] }, {
      requiredPreMergeStepIds: required,
      mergeContent: unavailableContent,
    });
    expect(noRow[0]?.state).toBe("missing");
  });

  it("answers the descriptorless question unchanged for the authorized empty-input row", () => {
    /*
    `evaluateNoCommitsNoOpFinalize` asks this gate DESCRIPTORLESS (no `mergeContent` argument), and the
    zero-commit finalize lanes route through it. The arm lives INSIDE the `unavailable` descriptor branch,
    so the descriptorless answer must not move — pinning it here is what stops a later widening of the
    arm from quietly becoming the only approval authority in the finalize lanes.
    */
    const descriptorless = evaluatePreMergeApprovals({ ...base, noCommitsExpected: true, workflowStepResults: [emptyApprovalRow] }, {
      requiredPreMergeStepIds: required,
    });
    expect(descriptorless[0]?.state).toBe("approved");
  });

  it("refuses a version-mismatched empty-input marker over unavailable content", () => {
    const future = { ...emptyApprovalRow, reviewInputFingerprint: "empty-review-input:v2" };
    const approvals = evaluatePreMergeApprovals({ ...base, noCommitsExpected: true, workflowStepResults: [future] }, {
      requiredPreMergeStepIds: required,
      mergeContent: unavailableContent,
    });
    expect(approvals[0]?.state).toBe("unprovable-content");
  });

  it("never speaks for a gate the workflow did not require", () => {
    /*
    Condition (d) is only observable at the predicate seam: `evaluatePreMergeAdmissionDecision` calls
    `evaluateStep` once per REQUIRED gate, so a non-required marker row is never even looked at. Asserted
    directly here so the guard has a real owner — the door half of the assertion shows that an unrequired
    marker row cannot stand in for the required gate that has no row.
    */
    const authorized = { noCommitsExpected: true as const };
    const missingCheckout = "missing-worktree-or-base";
    expect(evaluateZeroCommitEmptyInputContentProof(authorized, emptyApprovalRow, "code-review", required, missingCheckout)).toBe(true);
    expect(evaluateZeroCommitEmptyInputContentProof(authorized, emptyApprovalRow, "docs-delivery", required, missingCheckout)).toBe(false);
    expect(evaluateZeroCommitEmptyInputContentProof(authorized, emptyApprovalRow, "code-review", undefined, missingCheckout)).toBe(false);
    expect(evaluateZeroCommitEmptyInputContentProof({}, emptyApprovalRow, "code-review", required, missingCheckout)).toBe(false);
    expect(evaluateZeroCommitEmptyInputContentProof({ noCommitsExpected: false }, emptyApprovalRow, "code-review", required, missingCheckout)).toBe(false);
    expect(evaluateZeroCommitEmptyInputContentProof(authorized, undefined, "code-review", required, missingCheckout)).toBe(false);
    // Condition (e): the reason is a REQUIRED argument, so no caller can ask this question without saying
    // why the diff is unavailable, and every reason but the missing-checkout one answers false.
    for (const reason of contentBearingUnavailableReasons) {
      expect(evaluateZeroCommitEmptyInputContentProof(authorized, emptyApprovalRow, "code-review", required, reason)).toBe(false);
    }

    const optionalGate = { ...base, noCommitsExpected: true, workflowStepResults: [{ ...emptyApprovalRow, workflowStepId: "docs-delivery" }] };
    const approvals = evaluatePreMergeApprovals(optionalGate, {
      requiredPreMergeStepIds: required,
      mergeContent: unavailableContent,
    });
    expect(approvals[0]).toMatchObject({ workflowStepId: "code-review", state: "missing" });
  });

  it("refuses an empty-marker approval the reviewer did not authorize", () => {
    const revise = { ...emptyApprovalRow, verdict: "REVISE" as const };
    const pending = { ...emptyApprovalRow, status: "pending" as const, verdict: undefined };
    const archived = { ...emptyApprovalRow, remediationArchivedAt: "2026-10-01T00:00:00.000Z" };
    for (const row of [revise, pending, archived]) {
      const approvals = evaluatePreMergeApprovals({ ...base, noCommitsExpected: true, workflowStepResults: [row] }, {
        requiredPreMergeStepIds: required,
        mergeContent: unavailableContent,
      });
      expect(approvals[0]?.state).toBe("not-approved");
    }
  });

  it("shows the door refusal sentence only for the card without zero-commit authorization", () => {
    /*
    Door level (Symptom Verification assertion 2): RUFU-365's card reached the operator as this exact
    sentence from `getTaskMergeBlocker`, so the sentence is the assertion. It must appear for the
    flagless row and must NOT appear for the flagged one.
    */
    const row = { ...base, workflowStepResults: [emptyApprovalRow] };
    expect(getTaskMergeBlocker(row, { requiredPreMergeStepIds: required, mergeContent: unavailableContent }))
      .toBe("task has no provable approval for the content being merged");
    expect(getTaskMergeBlocker({ ...row, noCommitsExpected: true }, { requiredPreMergeStepIds: required, mergeContent: unavailableContent }))
      .toBeUndefined();
  });

  it.each(contentBearingUnavailableReasons)(
    "keeps the door refusal sentence for an authorized row whose diff is unavailable because %s", (reason) => {
      // The flagged card is the one the arm exists for, so this is the sharpest negative: the SAME row that
      // merges over a missing checkout still refuses when the unavailability proves a patch is there.
      expect(getTaskMergeBlocker(
        { ...base, noCommitsExpected: true, workflowStepResults: [emptyApprovalRow] },
        { requiredPreMergeStepIds: required, mergeContent: { kind: "singular", diff: { state: "unavailable", reason } } },
      )).toBe("task has no provable approval for the content being merged");
    },
  );

  it.each([
    ["kind and identity", { reviewKind: "code" as const }],
    ["identity only", { reviewKind: undefined }],
  ])("moves the %s proofless wedge onto recoverable and bypassable blockers", (_name, reviewMetadata) => {
    const approval = {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge" as const,
      status: "passed" as const,
      verdict: "APPROVE" as const,
      ...reviewMetadata,
    };
    const mergeContent = { kind: "singular" as const, diff: { state: "fingerprint" as const, fingerprint: "current" } };
    const wedged = { ...base, workflowStepResults: [approval] };
    for (const manual of [false, true]) {
      expect(getTaskMergeBlocker(wedged, { manual, requiredPreMergeStepIds: required, mergeContent }))
        .toBe("task has no provable approval for the content being merged");
    }

    const downgraded = resolveUnprovenReviewApproval(approval, { workspace: false })!.downgraded;
    const recoverable = { ...base, workflowStepResults: [downgraded] };
    for (const manual of [false, true]) {
      expect(getTaskMergeBlocker(recoverable, { manual, requiredPreMergeStepIds: required, mergeContent }))
        .toBe("task has enabled pre-merge workflow steps without a current approval (gate 'code-review')");
    }
    expect(getTaskMergeBlocker(recoverable)).toBe("task has failed pre-merge workflow steps");

    const bypassed = {
      ...downgraded,
      status: "skipped" as const,
      bypassedBy: "operator-1",
      bypassedAt: "2026-09-01T00:00:00.000Z",
      bypassReason: "Reviewer transport failed",
      bypassedFromStatus: "failed" as const,
    };
    for (const manual of [false, true]) {
      expect(getTaskMergeBlocker({ ...base, workflowStepResults: [bypassed] }, {
        manual,
        requiredPreMergeStepIds: required,
        mergeContent,
      })).toBeUndefined();
    }
  });
});
