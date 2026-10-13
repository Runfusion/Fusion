import type { Task, WorkflowStepResult } from "../types.js";
import { PLAN_REVIEW_GROUP_ID } from "../workflows/builtin-plan-review-group.js";
import { FAST_MODE_BYPASS_ACTOR } from "../workflows/workflow-fast-lane.js";
import { deriveStaleReviewCallbackAttemptId, isWorkflowStepNotRun } from "../workflows/workflow-step-results.js";
import type { MergeContentDescriptor } from "./merge-content-descriptor.js";

export type PreMergeApprovalState = "approved" | "missing" | "not-approved" | "stale-content" | "unprovable-content";
/*
FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217):
The approval evaluator collapses two different facts into one `not-approved` state: "a reviewer looked
and rejected" and "the gate never produced a verdict". Both answers are correct for the merge door
(FN-180 positive-approval contract, byte-stable) and fatal for recovery, because every re-run route
keyed off `missing` only. `verdictLessFailed` names the row SHAPE on the approval so recovery lanes
(reseed, stall router, parked-card recovery) can admit a fresh gate run while the merge door keeps
refusing; it is a recovery routing signal, never an approval and never a fabricated verdict.
The field is only ever PRESENT-TRUE: absent keeps every existing approval shape byte-stable.
*/
/** Compact compatibility projection consumed by merge and recovery callers. */
export type PreMergeApproval = {
  workflowStepId: string;
  state: PreMergeApprovalState;
  repositories?: string[];
  verdictLessFailed?: true;
};


/** Detailed gate diagnostic reserved for the canonical admission decision. */
export type PreMergeAdmissionGate = PreMergeApproval & {
  selectedResult?: Pick<WorkflowStepResult, "workflowStepId" | "status" | "verdict" | "reviewInputFingerprint" | "startedAt" | "completedAt" | "supersededAt" | "remediationArchivedAt">;
};

/** Shared, renderable merge-admission projection for every required pre-merge gate. */
export type PreMergeAdmissionDecision = {
  gates: PreMergeAdmissionGate[];
  allApproved: boolean;
};

/** Store-issued, project-scoped authority for one automatic stale-callback waiver. */
export type StaleReviewCallbackWaiverReceipt = {
  id: string;
  projectId: string;
  taskId: string;
  workflowStepId: string;
  attemptId: string;
  policyVersion: "fn-9429-v1";
  actor: "system:stale-review-callback-waiver";
  reason: "proven-stale-code-review-callback";
  issuedAt: string;
  state: "issued" | "revoked";
};

export const STALE_REVIEW_CALLBACK_WAIVER_POLICY_VERSION = "fn-9429-v1" as const;
export const STALE_REVIEW_CALLBACK_WAIVER_ACTOR = "system:stale-review-callback-waiver" as const;
export const STALE_REVIEW_CALLBACK_WAIVER_REASON = "proven-stale-code-review-callback" as const;

/*
FNXC:StaleReviewCallbackWaiver 2026-10-01-04:05:
Merge authority is the exact receipt supplied by a TaskStore-scoped reader, never task JSON alone.
The comparison also derives receipt identity from the immediately preserved prior attempt, so an
otherwise complete carrier copied onto a newer same-step attempt remains a blocking failed review.
*/
export function hasValidStaleReviewCallbackWaiver(
  result: WorkflowStepResult,
  context: {
    projectId?: string;
    taskId?: string;
    requiredPreMergeStepIds?: ReadonlySet<string>;
    singularScope: boolean;
    effectiveAutoMerge: boolean;
    hasOpenFindings: boolean;
    receipts?: readonly StaleReviewCallbackWaiverReceipt[];
  },
): boolean {
  const carrier = result.automatedStaleCallbackWaiver;
  const priorAttempt = result.priorAttempts?.[0];
  const priorAttemptId = priorAttempt && deriveStaleReviewCallbackAttemptId(priorAttempt);
  if (!carrier || result.status !== "skipped" || result.verdict !== undefined
    || (result.phase ?? "pre-merge") !== "pre-merge" || result.reviewKind !== "code"
    || !priorAttempt || priorAttempt.workflowStepId !== result.workflowStepId
    || priorAttempt.status !== carrier.priorStatus || priorAttemptId !== carrier.attemptId
    || !context.singularScope || !context.effectiveAutoMerge || context.hasOpenFindings
    || !context.requiredPreMergeStepIds?.has(result.workflowStepId)
    || !context.projectId || !context.taskId || !Array.isArray(context.receipts)) return false;
  const matches = context.receipts.filter((receipt) => receipt.id === carrier.receiptId
    && receipt.projectId === context.projectId
    && receipt.taskId === context.taskId
    && receipt.workflowStepId === result.workflowStepId
    && receipt.attemptId === carrier.attemptId
    && receipt.policyVersion === carrier.policyVersion
    && receipt.actor === carrier.actor
    && receipt.reason === carrier.reason
    && receipt.issuedAt === carrier.issuedAt
    && receipt.state === "issued");
  return matches.length === 1;
}

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
FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217):
The verdict-less failed pre-merge gate row is ONE structural class with four producers: a crashed or
orphaned review session (and the harness's no-verdict dispatch defect), an FN-8492 pending→failed
orphan rewrite, an FN-279 invalidated approval whose verdict was stripped, and an FN-295 collateral
restore (the restored row never carried a verdict; pre-restore archived rows stay excluded because the
FN-295 restore lane owns them — hence `remediationArchivedAt == null`). None of them recorded an
opinion, so the gate may run again — that is a fresh evaluation, not a reversal of reviewer
authority: an authored non-approving verdict (`REVISE`/`RETHINK`/`UNAVAILABLE`) keeps the row out of
this class and stays in the remediation-only lane (AC2). `status === "failed"` excludes `pending`
rows (in-flight sessions own them; FN-8492 rewrites orphaned pending to `failed`, at which point the
row joins this class), `advisory_failure` rows (a distinct terminal status with its own advisory-lane
semantics, not the failed-gate shape), and `skipped`+bypassed waiver rows;
`arbitrationDecision === undefined` excludes adjudicated rows.
`requiresAuthoredReviewVerdict` is the owed-verdict discriminator: a script-mode non-review gate
failing on an exit code never owed a verdict, belongs to the ordinary failed-step remediation lane,
and would otherwise be reseeded in a loop it cannot satisfy.
*/
export function isVerdictLessFailedGateRow(
  result: Pick<
    WorkflowStepResult,
    | "workflowStepId"
    | "phase"
    | "status"
    | "verdict"
    | "reviewKind"
    | "verdictRequired"
    | "bypassedBy"
    | "remediationArchivedAt"
    | "arbitrationDecision"
  >,
): boolean {
  return (result.phase ?? "pre-merge") === "pre-merge"
    && result.status === "failed"
    // `verdict == null` deliberately covers both the absent field and a literal JSON `null`
    // (RUFU-204's stored row carries `verdict: null` although the type says `undefined`).
    && result.verdict == null
    && result.bypassedBy === undefined
    && result.remediationArchivedAt == null
    && result.arbitrationDecision === undefined
    && requiresAuthoredReviewVerdict(result.workflowStepId, result);
}

/**
 * Required pre-merge gates whose latest row is verdict-less-failed (RUFU-217).
 * Derived through `evaluatePreMergeApprovals` so recovery lanes and the merge door read the same
 * latest-row-per-gate resolution; the merge door keeps refusing these gates — this finder only names
 * which gates a bounded fresh run may be seeded for. A task with no required gate ids resolves none
 * (there is no gate the engine could re-run).
 */
export function findVerdictLessFailedRequiredGates(
  task: Pick<Task, "workflowStepResults" | "repositoryScope">,
  options: { requiredPreMergeStepIds?: ReadonlySet<string> } = {},
): string[] {
  if (!options.requiredPreMergeStepIds?.size) return [];
  return evaluatePreMergeApprovals(task, options)
    .filter((approval) => approval.verdictLessFailed === true)
    .map((approval) => approval.workflowStepId);
}

/*
FNXC:PreMergeApproval 2026-09-22-21:42 (RUFU-276):
The other half of the RUFU-276 admission test: which required gates have NEVER reported. Only
`state: "missing"` qualifies — a `pending` row is a present gate (FN-8492 rewrites it, never
deletes it), a verdict-less failed row is RUFU-217's lane, an authored REVISE is the remediation
lane, and a stale-content row is the stale lane. Recovery lanes use this to prove the wedge
sentence they are repairing still matches the row they are repairing, so a card that gained a
result row between the sweep read and the repair write is left to its new owner.
*/

/** Required pre-merge gates with no result row at all, in the same latest-row resolution the merge door uses. */
export function findUnrunRequiredPreMergeStepIds(
  task: Pick<Task, "workflowStepResults" | "repositoryScope">,
  options: { requiredPreMergeStepIds?: ReadonlySet<string> } = {},
): string[] {
  if (!options.requiredPreMergeStepIds?.size) return [];
  return evaluatePreMergeApprovals(task, options)
    .filter((approval) => approval.state === "missing")
    .map((approval) => approval.workflowStepId);
}

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

/*
FNXC:PreMergeApproval 2026-09-02-21:57 (SUPERSEDED — see FNXC:PreMergeApproval 2026-09-06 below):
RUFU-172/178 classified a verdict-less remediation carrier as `missing` so FN-9243's re-seed would run
the gate again, replacing the unsatisfiable `not-approved` refusal that stranded FN-9243 cards.

FNXC:PreMergeApproval 2026-09-06 (merge origin/main dd808ed2c6, FN-295):
Upstream FN-295 shipped a different recovery for the same wedge and the classifier now defers to it.
An archived carrier stays `not-approved`; recovery is (a) `auditedOperatorWaiver` — an audited FN-7720
bypass satisfies the gate in place, and (b) `resolveCollateralArchivedReviewGate` — self-healing
restores a carrier that was archived as COLLATERAL of another gate's remediation back to its
recoverable `failed` state. `getLatestFailedPreMergeReviewStep` selects the carrier for the operator
bypass directly. RUFU-178's `isReRunnableRemediationCarrier` → `missing` branch is therefore DELETED:
keeping it would pre-empt the `not-approved` answer upstream's tests and diagnostics reason about.
*/

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

/*
FNXC:PreMergeAdmission 2026-10-12-19:48:
Merge admission and Workflow Results must select the same durable top-level result for each required
pre-merge gate. The compact approval projection remains the compatibility contract for merge and
recovery callers; only the canonical decision carries the selected-row diagnostic. Prior attempts are
audit history only: allowing them to reopen approval after a retry, reset, or workflow revision would
let stale review evidence authorize current content.
*/
export function evaluatePreMergeApprovals(
  task: Pick<Task, "workflowStepResults" | "repositoryScope"> & Partial<Pick<Task, "id">>,
  options: {
    requiredPreMergeStepIds?: ReadonlySet<string>;
    mergeContent?: MergeContentDescriptor;
    /** Authoritative records loaded by TaskStore for the current project/task only. */
    staleReviewCallbackWaiver?: {
      projectId: string;
      effectiveAutoMerge: boolean;
      hasOpenFindings: boolean;
      receipts: readonly StaleReviewCallbackWaiverReceipt[];
    };
  } = {},
): PreMergeApproval[] {
  const required = options.requiredPreMergeStepIds;
  if (!required?.size) return [];
  return evaluatePreMergeAdmissionDecision(task, options).gates.map(({ selectedResult: _selectedResult, ...gate }) => gate);
}

export function evaluatePreMergeAdmissionDecision(
  task: Pick<Task, "workflowStepResults" | "repositoryScope"> & Partial<Pick<Task, "id">>,
  options: {
    requiredPreMergeStepIds?: ReadonlySet<string>;
    mergeContent?: MergeContentDescriptor;
    staleReviewCallbackWaiver?: {
      projectId: string;
      effectiveAutoMerge: boolean;
      hasOpenFindings: boolean;
      receipts: readonly StaleReviewCallbackWaiverReceipt[];
    };
  } = {},
): PreMergeAdmissionDecision {
  const required = options.requiredPreMergeStepIds;
  if (!required?.size) return { gates: [], allApproved: true };
  const results = task.workflowStepResults ?? [];
  const gates = [...required].map((workflowStepId) => {
    const gate = evaluateStep(workflowStepId, results, task, options.mergeContent, options);
    const result = results.filter((candidate) => candidate.workflowStepId === workflowStepId).at(-1);
    return result ? {
      ...gate,
      selectedResult: {
        workflowStepId: result.workflowStepId,
        status: result.status,
        verdict: result.verdict,
        reviewInputFingerprint: result.reviewInputFingerprint,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        supersededAt: result.supersededAt,
        remediationArchivedAt: result.remediationArchivedAt,
      },
    } : gate;
  });
  return { gates, allApproved: gates.every((gate) => gate.state === "approved") };
}

function evaluateStep(
  workflowStepId: string,
  results: readonly WorkflowStepResult[],
  task: Pick<Task, "repositoryScope"> & Partial<Pick<Task, "id">>,
  descriptor: MergeContentDescriptor | undefined,
  options: {
    requiredPreMergeStepIds?: ReadonlySet<string>;
    mergeContent?: MergeContentDescriptor;
    staleReviewCallbackWaiver?: {
      projectId: string;
      effectiveAutoMerge: boolean;
      hasOpenFindings: boolean;
      receipts: readonly StaleReviewCallbackWaiverReceipt[];
    };
  },
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
    fingerprint they cannot produce and rendered builtin:coding-ideas unmergeable.
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
    const receiptWaiver = hasValidStaleReviewCallbackWaiver(result, {
      projectId: options.staleReviewCallbackWaiver?.projectId,
      taskId: task.id,
      requiredPreMergeStepIds: options.requiredPreMergeStepIds,
      singularScope: descriptor?.kind === "singular",
      effectiveAutoMerge: options.staleReviewCallbackWaiver?.effectiveAutoMerge === true,
      hasOpenFindings: options.staleReviewCallbackWaiver?.hasOpenFindings === true,
      receipts: options.staleReviewCallbackWaiver?.receipts,
    });
    const approved = (result.status === "passed" && (requiresAuthoredVerdict ? approvedVerdict : (result.verdict === undefined || approvedVerdict)))
      || (result.status === "skipped" && (!!result.bypassedBy || receiptWaiver))
      || notRunApproves;
    /*
    FNXC:PreMergeApproval 2026-09-06-00:47:
    Remediation archives suppress automatic re-approval, but cannot disarm the audited FN-7720
    operator waiver. Without this narrow exception, a crash-archived gate is permanently unmergeable.
    */
    const auditedOperatorWaiver = isAuditedOperatorBypass(result) && descriptor?.kind !== "workspace";
    if (!approved || (result.remediationArchivedAt != null && !auditedOperatorWaiver)) {
      /*
      FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217):
      The refusal stays `not-approved` byte-for-byte; the conditional spread adds the recovery
      routing signal only for the verdict-less row shape, so every other not-approved carrier
      (authored REVISE, workspace revision churn, archived carriers) keeps its exact approval shape.
      */
      return {
        workflowStepId,
        state: "not-approved",
        ...(isVerdictLessFailedGateRow(result) ? { verdictLessFailed: true as const } : {}),
      };
    }
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
    builtin:coding-ideas via pipeline-smoke S01; builtin:review-gated-coding carries the same
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
