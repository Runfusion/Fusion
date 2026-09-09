import type { Task, WorkflowStepResult } from "../types.js";
import { PLAN_REVIEW_GROUP_ID } from "../workflows/builtin-plan-review-group.js";
import { FAST_MODE_BYPASS_ACTOR } from "../workflows/workflow-fast-lane.js";
import { isWorkflowStepNotRun } from "../workflows/workflow-step-results.js";
import type { MergeContentDescriptor } from "./merge-content-descriptor.js";

export type PreMergeApprovalState = "approved" | "missing" | "not-approved" | "stale-content" | "unprovable-content";
export type PreMergeApproval = { workflowStepId: string; state: PreMergeApprovalState; repositories?: string[] };

/** The merge gate's sole definition of a review whose approval binds source content. */
export function requiresContentReviewProof(
  workflowStepId: string,
  result: Pick<WorkflowStepResult, "reviewKind">,
): boolean {
  return workflowStepId === "code-review" || result.reviewKind === "code";
}

/** Whether merge admission must see a positive machine-authored review verdict. */
export function requiresAuthoredReviewVerdict(
  workflowStepId: string,
  result: Pick<WorkflowStepResult, "reviewKind" | "verdictRequired">,
): boolean {
  return requiresContentReviewProof(workflowStepId, result)
    || result.reviewKind !== undefined
    || result.verdictRequired === true;
}

export const AUTOMATED_BYPASS_ACTORS: ReadonlySet<string> = new Set([FAST_MODE_BYPASS_ACTOR]);

/*
FNXC:PreMergeApproval 2026-09-01-11:28:
Content binding prevents an automated approval from being reused against different source, while an
audited human waiver is not a source approval at all: FN-7720 promises to clear the failed gate, but
falling through to diff comparison made that operator escape inert. The actor is the discriminator
because fast mode writes the same timestamp, reason, and absent-gate fields as an operator bypass;
a passed proofless row remains refused regardless of any stray bypass metadata.
*/
export function isAuditedOperatorBypass(
  result: Pick<WorkflowStepResult, "status" | "bypassedBy" | "bypassedAt" | "bypassReason">,
): boolean {
  if (result.status !== "skipped") return false;
  const actor = result.bypassedBy?.trim();
  return Boolean(
    actor
    && !AUTOMATED_BYPASS_ACTORS.has(actor)
    && result.bypassedAt?.trim()
    && result.bypassReason?.trim(),
  );
}

const UNPROVEN_REVIEW_APPROVAL_DIAGNOSTIC = "Content-binding review approval recorded without reviewInputFingerprint; approval invalidated so the gate can run again.";

/*
FNXC:ReviewInputProof 2026-09-01-11:28:
A proofless content approval is already terminal `passed`, so neither the failed-step bypass nor the
pending-step resume surface can select it. Rewrite only that invalid singular approval to `failed`,
never delete it, so recovery can re-run the gate and the operator retains a selectable audit carrier.
*/
/*
FNXC:PreMergeApproval 2026-09-05-22:11:
FN-295: `archiveTerminalWorkflowStepFailures` archives EVERY terminal failure on the card, not only the
gate whose remediation is running. A Plan Review row that a restart had left `pending` — rewritten to
`failed` by the FN-8492 orphaned-step sweep, never by a reviewer — was therefore archived as collateral
of a Code Review remediation. The archived carrier is then a permanent merge veto (`remediationArchivedAt`
is unconditional below) that NO recovery owns: the reseed handles only `missing`, the stale-content
reroute only `stale-content`, and the FN-7720 operator bypass selects only `status:"failed"`. Measured on
FN-295: three review restarts each re-ran Code Review and Documentation successfully and still merged
nothing, because the poisoned row is in neither of those lanes.

This resolver restores such a collateral carrier to the terminal failure it actually was, so the card is
recoverable again through the ordinary audited bypass. It deliberately does NOT approve anything: no
verdict is written, and a row carrying a real operator waiver (`bypassedBy`) or belonging to the gate that
owns the remediation wave is never touched.
*/
export const COLLATERAL_ARCHIVED_REVIEW_GATE_DIAGNOSTIC =
  "Gate archived as collateral of another gate's remediation and restored to its recoverable failed state by self-healing. No reviewer verdict was fabricated; re-run or bypass this gate to clear the merge door.";

export function resolveCollateralArchivedReviewGate(
  result: WorkflowStepResult,
  options: { remediationGateIds: ReadonlySet<string> },
): { restored: WorkflowStepResult; reason: string } | undefined {
  const archivedFrom = result.remediationArchivedFromStatus;
  if ((result.phase ?? "pre-merge") !== "pre-merge"
    || result.status !== "skipped"
    || result.remediationArchivedAt == null
    || result.bypassedBy !== undefined
    || (archivedFrom !== "failed" && archivedFrom !== "advisory_failure")
    || options.remediationGateIds.has(result.workflowStepId)) {
    return undefined;
  }
  const {
    remediationArchivedAt: _archivedAt,
    remediationArchivedFromStatus: _archivedFrom,
    ...rest
  } = result;
  return {
    restored: {
      ...rest,
      status: archivedFrom,
      output: COLLATERAL_ARCHIVED_REVIEW_GATE_DIAGNOSTIC,
      notes: COLLATERAL_ARCHIVED_REVIEW_GATE_DIAGNOSTIC,
    },
    reason: COLLATERAL_ARCHIVED_REVIEW_GATE_DIAGNOSTIC,
  };
}

export function resolveUnprovenReviewApproval(
  result: WorkflowStepResult,
  options: { workspace: boolean },
): { downgraded: WorkflowStepResult; reason: string } | undefined {
  if ((result.phase ?? "pre-merge") !== "pre-merge"
    || !requiresContentReviewProof(result.workflowStepId, result)
    || options.workspace
    || result.status !== "passed"
    || (result.verdict !== "APPROVE" && result.verdict !== "APPROVE_WITH_NOTES")
    || result.reviewInputFingerprint !== undefined
    || result.bypassedBy !== undefined
    || result.remediationArchivedAt != null) {
    return undefined;
  }
  const { verdict: _verdict, ...withoutVerdict } = result;
  return {
    downgraded: {
      ...withoutVerdict,
      status: "failed",
      output: UNPROVEN_REVIEW_APPROVAL_DIAGNOSTIC,
      notes: UNPROVEN_REVIEW_APPROVAL_DIAGNOSTIC,
    },
    reason: UNPROVEN_REVIEW_APPROVAL_DIAGNOSTIC,
  };
}

export function evaluatePreMergeApprovals(
  task: Pick<Task, "workflowStepResults" | "repositoryScope">,
  options: { requiredPreMergeStepIds?: ReadonlySet<string>; mergeContent?: MergeContentDescriptor } = {},
): PreMergeApproval[] {
  const required = options.requiredPreMergeStepIds;
  if (!required?.size) return [];
  const results = task.workflowStepResults ?? [];
  return [...required].map((workflowStepId) => evaluateStep(workflowStepId, results, task, options.mergeContent));
}

function evaluateStep(
  workflowStepId: string,
  results: readonly WorkflowStepResult[],
  task: Pick<Task, "repositoryScope">,
  descriptor: MergeContentDescriptor | undefined,
): PreMergeApproval {
  const result = results.filter((candidate) => candidate.workflowStepId === workflowStepId).at(-1);
  // Workspace Code Review persists its positive proof in repositoryScope so it survives
  // the intentional workflow-result remediation wipe; singular tasks have no such carrier.
  if (!result && descriptor?.kind !== "workspace") return { workflowStepId, state: "missing" };
  if (result) {
    /*
    FNXC:ReviewVerdictAuthority 2026-09-02-19:25:
    Authored-verdict authority and source-content binding are separate invariants. Review-kind and
    verdictRequired rows need APPROVE/APPROVE_WITH_NOTES, but only the narrow content-review predicate
    may feed `bindsContent`; widening that predicate made plan and deterministic gates require a diff
    fingerprint they cannot produce and rendered builtin:coding-ideas-v2 unmergeable.
    */
    const requiresExplicitVerdict = requiresContentReviewProof(workflowStepId, result);
    const requiresAuthoredVerdict = requiresAuthoredReviewVerdict(workflowStepId, result);
    const approvedVerdict = result.verdict === "APPROVE" || result.verdict === "APPROVE_WITH_NOTES";
    /*
    FNXC:WorkflowStepNotRun 2026-08-28-14:13:
    A check that could not run must not block a task, but its honest skipped carrier can open only a
    non-content, non-plan gate. Code-domain checks still require a positive current verdict, and the
    plan-domain exclusion is load-bearing because the status-only return below would otherwise let an
    unexecuted Plan Review open the merge door despite `isPlanReviewSatisfied` refusing it.
    */
    const isPlanDomain = workflowStepId === PLAN_REVIEW_GROUP_ID || result.reviewKind === "plan";
    const notRunApproves = isWorkflowStepNotRun(result) && !requiresAuthoredVerdict && !isPlanDomain;
    const approved = (result.status === "passed" && (requiresAuthoredVerdict ? approvedVerdict : (result.verdict === undefined || approvedVerdict)))
      || (result.status === "skipped" && !!result.bypassedBy)
      || notRunApproves;
    /*
    FNXC:PreMergeApproval 2026-09-06-00:47:
    Remediation archives suppress automatic re-approval, but cannot disarm the audited FN-7720
    operator waiver. Without this narrow exception, a crash-archived gate is permanently unmergeable.
    */
    const auditedOperatorWaiver = isAuditedOperatorBypass(result) && descriptor?.kind !== "workspace";
    if (!approved || (result.remediationArchivedAt != null && !auditedOperatorWaiver)) return { workflowStepId, state: "not-approved" };
    // Plan fingerprints bind plan text rather than source diff and must never be cross-compared.
    if (result.reviewKind === "plan") return { workflowStepId, state: "approved" };
    if (auditedOperatorWaiver) {
      return { workflowStepId, state: "approved" };
    }
    /*
    FNXC:PreMergeApproval 2026-08-24-07:10:
    A required pre-merge step is not necessarily a CONTENT REVIEW. Review-column workflows also
    require deterministic verification and documentation/delivery gates, which pass on an exit code
    or a completed action and never record a `reviewInputFingerprint` — there is no diff for them to
    bind. Falling through to the diff comparison classified every one of them as
    `unprovable-content`, so `canMergeTask` answered "task has no provable approval for the content
    being merged" and NOTHING could ever merge on such a workflow. Measured on
    builtin:coding-ideas-v2 via pipeline-smoke S01; builtin:review-gated-coding carries the same
    latent defect and simply never reached its merge.
    The carve-out is deliberately narrow: it applies only when the step is neither `code-review` nor
    a `reviewKind: "code"` result AND recorded no fingerprint of its own. A content review that DID
    record one still gets compared, and a code review missing its fingerprint is still refused — the
    FN-180 guarantee it exists to protect is untouched.
    */
    const bindsContent = requiresExplicitVerdict || result.reviewInputFingerprint !== undefined;
    if (!bindsContent) return { workflowStepId, state: "approved" };
  }
  if (!descriptor) return { workflowStepId, state: "approved" };
  if (descriptor.kind === "singular") {
    if (descriptor.diff.state === "empty") return { workflowStepId, state: "approved" };
    if (descriptor.diff.state === "unavailable") return { workflowStepId, state: "unprovable-content" };
    return result?.reviewInputFingerprint === descriptor.diff.fingerprint
      ? { workflowStepId, state: "approved" }
      : { workflowStepId, state: result?.reviewInputFingerprint ? "stale-content" : "unprovable-content" };
  }
  if (task.repositoryScope?.state !== "confirmed" || descriptor.repositories.state === "unavailable") {
    return { workflowStepId, state: "unprovable-content" };
  }
  if (task.repositoryScope.reviewRemediation?.scopeRevision === task.repositoryScope.revision) {
    return { workflowStepId, state: "not-approved" };
  }
  if (result?.repositoryScopeRevision !== undefined && result.repositoryScopeRevision !== task.repositoryScope.revision) {
    return { workflowStepId, state: "stale-content" };
  }
  const missing: string[] = [];
  const stale: string[] = [];
  for (const repository of descriptor.repositories.inScopeModified) {
    const expected = descriptor.repositories.fingerprints[repository];
    const evidence = task.repositoryScope.reviewEvidence?.[repository];
    if (!evidence) missing.push(repository);
    else if (expected && evidence.fingerprint !== expected) stale.push(repository);
  }
  if (missing.length) return { workflowStepId, state: "missing", repositories: missing };
  if (stale.length) return { workflowStepId, state: "stale-content", repositories: stale };
  return { workflowStepId, state: "approved" };
}
