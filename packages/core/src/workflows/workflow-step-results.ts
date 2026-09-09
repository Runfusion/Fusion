import type { WorkflowReviewFinding, WorkflowReviewFindingResolution, WorkflowReviewFindingSeverity, WorkflowStepResult } from "../types.js";

export const WORKFLOW_STEP_NOT_RUN_REASONS = ["not-configured", "tooling-unavailable", "execution-mode-skip", "repository-context-unresolved"] as const;
export type WorkflowStepNotRunReason = (typeof WORKFLOW_STEP_NOT_RUN_REASONS)[number];

/** A not-run result is terminal and honest only when its fixed reason accompanies `skipped`. */
export function isWorkflowStepNotRun(result: WorkflowStepResult): boolean {
  return result.status === "skipped"
    && typeof result.notRunReason === "string"
    && (WORKFLOW_STEP_NOT_RUN_REASONS as readonly string[]).includes(result.notRunReason);
}

export const WORKFLOW_REVIEW_FINDING_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const WORKFLOW_REVIEW_FINDING_RESOLUTIONS = ["open", "resolved-in-review", "superseded", "dispute-upheld"] as const;
/** Values an untrusted reviewer response may assign; automatic dispute closure is Fusion-owned. */
export const MODEL_ASSIGNABLE_WORKFLOW_REVIEW_FINDING_RESOLUTIONS = ["resolved-in-review", "superseded"] as const;
export const MAX_WORKFLOW_REVIEW_FINDINGS = 20;
const MAX_FINDING_ID_LENGTH = 128;
const MAX_FINDING_TITLE_LENGTH = 240;
const MAX_FINDING_BODY_LENGTH = 4_000;
const MAX_FINDING_PATH_LENGTH = 1_000;

/**
 * FNXC:WorkflowReviewFindings 2026-08-05-06:29:
 * Model findings are untrusted JSON. Normalize them once at the core persistence boundary so every
 * writer stores collision-free IDs and bounded operator-facing text; malformed entries are dropped
 * rather than becoming selectable feedback.
 */
export function normalizeWorkflowReviewFindings(raw: unknown): WorkflowReviewFinding[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const normalized: WorkflowReviewFinding[] = [];
  const usedIds = new Set<string>();
  for (const candidate of raw) {
    if (normalized.length >= MAX_WORKFLOW_REVIEW_FINDINGS || !candidate || typeof candidate !== "object") continue;
    const value = candidate as Record<string, unknown>;
    const title = boundedTrimmedString(value.title, MAX_FINDING_TITLE_LENGTH);
    const body = boundedTrimmedString(value.body, MAX_FINDING_BODY_LENGTH);
    if (!title || !body) continue;
    const baseId = boundedTrimmedString(value.id, MAX_FINDING_ID_LENGTH) || `finding-${normalized.length + 1}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId.slice(0, Math.max(1, MAX_FINDING_ID_LENGTH - String(suffix).length - 1))}-${suffix++}`;
    usedIds.add(id);
    const filePath = boundedTrimmedString(value.filePath, MAX_FINDING_PATH_LENGTH);
    const line = typeof value.line === "number" && Number.isFinite(value.line) && value.line > 0
      ? Math.floor(value.line)
      : undefined;
    const severity = isWorkflowReviewFindingSeverity(value.severity) ? value.severity : undefined;
    const resolution = isModelAssignableWorkflowReviewFindingResolution(value.resolution)
      ? value.resolution
      : undefined;
    const rebutsDisputedFindingId = boundedTrimmedString(value.rebutsDisputedFindingId, MAX_FINDING_ID_LENGTH);
    normalized.push({ id, title, body, ...(filePath ? { filePath } : {}), ...(line ? { line } : {}), ...(severity ? { severity } : {}), ...(resolution ? { resolution } : {}), ...(rebutsDisputedFindingId ? { rebutsDisputedFindingId } : {}) });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function boundedTrimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

export function isWorkflowReviewFindingSeverity(value: unknown): value is WorkflowReviewFindingSeverity {
  return typeof value === "string" && (WORKFLOW_REVIEW_FINDING_SEVERITIES as readonly string[]).includes(value);
}

export function isWorkflowReviewFindingResolution(value: unknown): value is WorkflowReviewFindingResolution {
  return typeof value === "string" && (WORKFLOW_REVIEW_FINDING_RESOLUTIONS as readonly string[]).includes(value);
}

export function isModelAssignableWorkflowReviewFindingResolution(value: unknown): value is Exclude<WorkflowReviewFindingResolution, "open" | "dispute-upheld"> {
  return typeof value === "string" && (MODEL_ASSIGNABLE_WORKFLOW_REVIEW_FINDING_RESOLUTIONS as readonly string[]).includes(value);
}

/** Historical findings and explicit `open` findings remain actionable. */
export function isOpenWorkflowReviewFinding(finding: WorkflowReviewFinding): boolean {
  return finding.resolution === undefined || finding.resolution === "open";
}

/** Normalize untrusted reviewer claims before they can target persisted prior-lane findings. */
export function normalizeSupersededFindingIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = [...new Set(raw
    .map((value) => boundedTrimmedString(value, MAX_FINDING_ID_LENGTH))
    .filter((value): value is string => value !== undefined))]
    .slice(0, MAX_WORKFLOW_REVIEW_FINDINGS);
  return ids.length > 0 ? ids : undefined;
}

/**
 * Apply a later review step's explicit supersession claim only to its named prior result,
 * preserving other lanes that may use the same finding IDs.
 */
export function applySupersededFindingIds(
  results: WorkflowStepResult[] | undefined,
  ids: string[],
  options: { excludeWorkflowStepId: string; sourceWorkflowStepId: string },
): WorkflowStepResult[] | undefined {
  if (!results || ids.length === 0 || !options.sourceWorkflowStepId) return results;
  const claimed = new Set(ids);
  let changed = false;
  const next = results.map((result) => {
    if (result.workflowStepId !== options.sourceWorkflowStepId || result.workflowStepId === options.excludeWorkflowStepId || !result.findings?.length) return result;
    let findingsChanged = false;
    const findings = result.findings.map((finding) => {
      if (!claimed.has(finding.id) || !isOpenWorkflowReviewFinding(finding)) return finding;
      findingsChanged = true;
      return { ...finding, resolution: "superseded" as const };
    });
    if (!findingsChanged) return result;
    changed = true;
    return { ...result, findings };
  });
  return changed ? next : results;
}

/** Resolve same-gate findings stored in archived attempts without changing their step state. */
export function applySupersededPriorAttemptFindingIds(
  results: WorkflowStepResult[] | undefined,
  options: { workflowStepId: string; findingIds: string[] },
): WorkflowStepResult[] | undefined {
  if (!results || options.findingIds.length === 0) return results;
  const claimed = new Set(options.findingIds);
  let changed = false;
  const next = results.map((result) => {
    if (result.workflowStepId !== options.workflowStepId || !result.priorAttempts?.length) return result;
    let resultChanged = false;
    const priorAttempts = result.priorAttempts.map((attempt) => {
      if (!attempt.findings?.length) return attempt;
      let findingsChanged = false;
      const findings = attempt.findings.map((finding) => {
        if (!claimed.has(finding.id) || !isOpenWorkflowReviewFinding(finding)) return finding;
        findingsChanged = true;
        return { ...finding, resolution: "superseded" as const };
      });
      if (!findingsChanged) return attempt;
      changed = true;
      resultChanged = true;
      return { ...attempt, findings };
    });
    return resultChanged ? { ...result, priorAttempts } : result;
  });
  return changed ? next : results;
}

export function collectDisputedFindings(
  results: WorkflowStepResult[] | undefined,
  options: { revisionKey: string },
): WorkflowReviewFinding[] {
  const result = results?.find((entry) => entry.workflowStepId === options.revisionKey);
  return (result?.priorAttempts ?? []).flatMap((attempt) => attempt.findings ?? [])
    .filter((finding) => finding.disputedAt != null && isOpenWorkflowReviewFinding(finding));
}

/*
FNXC:ReviewConvergence 2026-08-22-05:20:
FN-149 permits automatic dispute closure only after a terminal verdict for the same gate. Pending
lease writes share this persistence sink, so closing there would uphold the implementer before a
reviewer can rebut it.
*/
export function closeUnrebuttedDisputedFindings(
  existing: WorkflowStepResult[] | undefined,
  incoming: WorkflowStepResult,
  options: { revisionKey: string; workflowStepId: string },
  now: string = new Date().toISOString(),
): WorkflowStepResult[] | undefined {
  if (incoming.workflowStepId !== options.workflowStepId || incoming.workflowStepId !== options.revisionKey
    || !isTerminalStepResult(incoming) || !incoming.verdict || !existing) return existing;
  const superseded = new Set(incoming.supersededFindingIds ?? []);
  const rebutted = new Set((incoming.findings ?? []).map((finding) => finding.rebutsDisputedFindingId).filter((id): id is string => Boolean(id)));
  let changed = false;
  const next = existing.map((result) => {
    if (result.workflowStepId !== options.workflowStepId || !result.priorAttempts?.length) return result;
    let resultChanged = false;
    const priorAttempts = result.priorAttempts.map((attempt) => {
      if (!attempt.findings?.length) return attempt;
      let attemptChanged = false;
      const findings = attempt.findings.map((finding) => {
        if (!finding.disputedAt || !isOpenWorkflowReviewFinding(finding)) return finding;
        if (rebutted.has(finding.id)) {
          attemptChanged = resultChanged = changed = true;
          return { ...finding, disputeRebuttedAt: now };
        }
        if (superseded.has(finding.id)) return finding;
        attemptChanged = resultChanged = changed = true;
        return { ...finding, resolution: "dispute-upheld" as const };
      });
      return attemptChanged ? { ...attempt, findings } : attempt;
    });
    return resultChanged ? { ...result, priorAttempts } : result;
  });
  return changed ? next : existing;
}

/*
FNXC:WorkflowStepResults 2026-07-09-00:20:
FN-7727: both engine `WorkflowStepResult` recorders (the executor graph adapter's
`recordWorkflowStepResult` and triage's `recordPlanReviewWorkflowResult`) used to
upsert by `workflowStepId` with a bare `existing[idx] = result` replace-in-place.
When self-healing (`recoverFailedPreMergeWorkflowStep` /
`recoverReviewTasksWithFailedPreMergeSteps`) sends a failed pre-merge review step
back for fix and the graph re-runs that same node, the new attempt silently
overwrote the prior `status:"failed"` record — losing its `output`/`notes`/
`verdict`/timestamps forever. This shared, PURE helper is the single upsert path
for every recorder: it snapshots a replaced `failed`/`advisory_failure` entry into
the new entry's `priorAttempts` (bounded, oldest-dropped, single-level — snapshots
never carry their own nested `priorAttempts`), and carries forward already-
accumulated history across successive re-runs. `priorAttempts` is read-only
history: callers that select "the current failed step" (self-healing selection,
`getTaskMergeBlocker`, progress/timing) must keep reading the top-level array
entries only and never flatten/inspect `priorAttempts` for that purpose.
*/

/** Default cap on the number of prior terminal-failure attempts retained per step. */
export const MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS = 5;

const TERMINAL_FAILURE_STATUSES: ReadonlySet<WorkflowStepResult["status"]> = new Set([
  "failed",
  "advisory_failure",
]);

function isTerminalFailure(result: WorkflowStepResult): boolean {
  return TERMINAL_FAILURE_STATUSES.has(result.status);
}

function isSupersededPlanningEvidence(result: WorkflowStepResult): boolean {
  return result.supersededAt != null;
}

/**
 * Strip a result down to a single-level history snapshot: its own
 * `priorAttempts` are dropped so nesting never grows beyond one level deep.
 */
export function toSnapshot(result: WorkflowStepResult): WorkflowStepResult {
  if (!result.priorAttempts || result.priorAttempts.length === 0) return result;
  const { priorAttempts: _drop, ...rest } = result;
  return rest as WorkflowStepResult;
}

/**
 * FNXC:ReviewConvergence 2026-08-22-05:00:
 * Automatic remediation must retain the failed review ledger while explicit operator retry keeps
 * its clean-slate contract. A skipped carrier is non-blocking but hands a single-level snapshot to
 * the next upsert; this blanket helper is intentionally incapable of writing arbitration metadata.
 */
/*
FNXC:ReviewRemediation 2026-09-05-22:31:
FN-295: `workflowStepIds` scopes the archive to the gate whose remediation is actually running. The
blanket form contradicted its own call sites — "archive ITS failed review result" — and archived every
terminal failure on the card, including a stale row from an unrelated gate. An archived carrier is an
unconditional merge veto (`evaluatePreMergeApprovals`) that no reseed, reroute, or operator bypass can
select, so one gate's remediation could permanently wedge a card on another gate's row. Omitting the
scope preserves the historical blanket behaviour for callers that genuinely mean "all".
*/
export function archiveTerminalWorkflowStepFailures(
  results: WorkflowStepResult[] | undefined,
  archivedAt: string = new Date().toISOString(),
  options: { workflowStepIds?: ReadonlySet<string> } = {},
): WorkflowStepResult[] | undefined {
  const inScope = (result: WorkflowStepResult): boolean =>
    isTerminalFailure(result) && (!options.workflowStepIds || options.workflowStepIds.has(result.workflowStepId));
  if (!results?.some(inScope)) return results;
  return results.map((result) => {
    if (!inScope(result)) return result;
    const snapshot = toSnapshot(result);
    const priorAttempts = [snapshot, ...(result.priorAttempts ?? [])].slice(0, MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS);
    const {
      output: _output, notes: _notes, verdict: _verdict, findings: _findings,
      leaseOwner: _leaseOwner, leaseNodeId: _leaseNodeId, priorAttempts: _priorAttempts,
      bypassedBy: _bypassedBy, bypassedAt: _bypassedAt, bypassReason: _bypassReason,
      bypassedFromStatus: _bypassedFromStatus, bypassedFromVerdict: _bypassedFromVerdict,
      arbitrationDecision: _arbitrationDecision, arbitrationBindingFindingCount: _arbitrationBindingFindingCount,
      arbitratedAttemptAt: _arbitratedAttemptAt, arbitratedAt: _arbitratedAt, arbitrationNotes: _arbitrationNotes,
      ...carrier
    } = result;
    return {
      ...carrier,
      status: "skipped" as const,
      remediationArchivedAt: archivedAt,
      remediationArchivedFromStatus: result.status,
      priorAttempts,
    };
  });
}

export function isArchivedRemediationCarrier(result: WorkflowStepResult): boolean {
  return result.remediationArchivedAt != null;
}

export type ArbitrationFailureFence = {
  workflowStepId: string;
  expectedStartedAt?: string;
  expectedCompletedAt?: string;
  expectedVerdict?: WorkflowStepResult["verdict"];
  expectedReviewInputFingerprint?: string;
  decision: "UPHOLD_REVIEW" | "UPHOLD_IMPLEMENTER" | "SPLIT";
  bindingFindingCount: number;
  arbitratedAt: string;
  arbitrationNotes: string;
};

/** Fenced arbitration can release only the exact failed gate the arbiter read. */
export function archiveArbitratedWorkflowStepFailure(
  results: WorkflowStepResult[] | undefined,
  fence: ArbitrationFailureFence,
): { results: WorkflowStepResult[] | undefined; applied: true } | { results: WorkflowStepResult[] | undefined; applied: false; reason: "gate-missing" | "not-failed" | "attempt-changed" | "superseded" | "binding-findings-survive" } {
  const index = results?.findIndex((result) => result.workflowStepId === fence.workflowStepId) ?? -1;
  if (index < 0 || !results) return { results, applied: false, reason: "gate-missing" };
  const current = results[index];
  if (current.status !== "failed") return { results, applied: false, reason: "not-failed" };
  if (current.supersededAt != null) return { results, applied: false, reason: "superseded" };
  if (current.startedAt !== fence.expectedStartedAt || current.completedAt !== fence.expectedCompletedAt
    || current.verdict !== fence.expectedVerdict
    || (fence.expectedReviewInputFingerprint !== undefined && current.reviewInputFingerprint !== fence.expectedReviewInputFingerprint)) {
    return { results, applied: false, reason: "attempt-changed" };
  }
  if (fence.bindingFindingCount > 0) return { results, applied: false, reason: "binding-findings-survive" };
  /*
  FNXC:ReviewConvergence 2026-08-22-05:33:
  FN-149 permits automatic release only when arbitration upholds the implementer, or when a SPLIT
  leaves no binding finding. An UPHOLD_REVIEW verdict is never gate-opening, even if a malformed
  arbiter payload reports zero bindings.
  */
  if (fence.decision !== "UPHOLD_IMPLEMENTER" && fence.decision !== "SPLIT") {
    return { results, applied: false, reason: "binding-findings-survive" };
  }
  const archivedResults = archiveTerminalWorkflowStepFailures([current], fence.arbitratedAt);
  // `current` is failed, so the archival helper must produce exactly one carrier; retain a
  // defensive refusal if that invariant changes rather than releasing a malformed gate.
  const archived = archivedResults?.[0];
  if (!archived) return { results, applied: false, reason: "not-failed" };
  const next = [...results];
  next[index] = {
    ...archived,
    arbitrationDecision: fence.decision,
    arbitrationBindingFindingCount: fence.bindingFindingCount,
    arbitratedAttemptAt: current.completedAt ?? current.startedAt,
    arbitratedAt: fence.arbitratedAt,
    arbitrationNotes: fence.arbitrationNotes,
  };
  return { results: next, applied: true };
}

/**
 * Pure upsert of a `WorkflowStepResult` by `workflowStepId`, preserving a
 * bounded history of prior terminal-failure attempts on the surviving entry.
 *
 * - Absent → the incoming result is appended.
 * - Present → the existing entry is replaced IN PLACE (array position
 *   preserved). The existing entry's already-accumulated `priorAttempts` are
 *   carried forward onto the incoming result. If the existing entry represents
 *   a DIFFERENT attempt (deduped by `startedAt` — a same-run `pending`→`failed`
 *   transition of the same attempt is not a new attempt) and its status is a
 *   terminal failure (`failed` | `advisory_failure`) or superseded planning
 *   projection, a single-level snapshot of it is pushed onto the incoming
 *   result's `priorAttempts`.
 * - `priorAttempts` is bounded to `opts.maxPriorAttempts` (default
 *   `MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS`), newest-first, oldest dropped.
 *
 * Never mutates `existing` or `incoming`; always returns a new array.
 */
export function upsertWorkflowStepResult(
  existing: WorkflowStepResult[] | undefined,
  incoming: WorkflowStepResult,
  opts?: { maxPriorAttempts?: number },
): WorkflowStepResult[] {
  const maxPriorAttempts = opts?.maxPriorAttempts ?? MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS;
  const source = existing ?? [];
  const idx = source.findIndex((r) => r.workflowStepId === incoming.workflowStepId);

  if (idx < 0) {
    const next = [...source];
    next.push({ ...incoming });
    return next;
  }

  const previous = source[idx];
  const isSameAttempt = previous.startedAt !== undefined
    && incoming.startedAt !== undefined
    && previous.startedAt === incoming.startedAt;

  let priorAttempts = previous.priorAttempts ? [...previous.priorAttempts] : [];
  if (!isSameAttempt && (isTerminalFailure(previous) || isSupersededPlanningEvidence(previous))) {
    priorAttempts = [toSnapshot(previous), ...priorAttempts];
  }
  if (priorAttempts.length > maxPriorAttempts) {
    priorAttempts = priorAttempts.slice(0, maxPriorAttempts);
  }

  const replacement: WorkflowStepResult = { ...incoming };
  if (priorAttempts.length > 0) {
    replacement.priorAttempts = priorAttempts;
  } else {
    delete replacement.priorAttempts;
  }

  const next = [...source];
  next[idx] = replacement;
  return next;
}

/*
FNXC:PlanReviewLease 2026-07-18-23:25:
U3 / KTD-4 — pending review-gate results are LEASES. A `pending` result whose
`leaseOwner` is set and whose `startedAt` is within the staleness floor is a LIVE
lease: a re-entering graph run must adopt it (skip re-dispatch), never launch a
second reviewer. Only past the staleness floor may another run RECLAIM the gate
by compare-and-set (write its own owner). This is the FN-6736 stale-lease pattern
applied to the plan-review dedup site, and it is what makes the FN-1315 duplicate
"Starting workflow step: Plan Review" interleaving impossible by construction.

These helpers are PURE (no store, no clock beyond the injected `now`) so the
graph executor and unit tests share one lease implementation.
*/

/** Default staleness floor for a review-gate lease (ms). A lease older than this
 *  with no terminal result is presumed crashed and may be reclaimed. Mirrors the
 *  FN-6736 staleness-floor standard for durable single-owner leases. */
export const PLAN_REVIEW_LEASE_STALENESS_MS = 15 * 60 * 1000;

/** FN-267 uses the same conservative floor for an in-flight automatic remediation attempt. */
export const REMEDIATION_ATTEMPT_CLAIM_STALENESS_MS = 15 * 60 * 1000;

export type RemediationAttemptClaimDisposition =
  | { kind: "absent" }
  | { kind: "signature-moved" }
  | { kind: "refused"; reason: NonNullable<WorkflowStepResult["remediationRefusedReason"]> }
  | { kind: "owned"; result: WorkflowStepResult }
  | { kind: "held"; owner: string }
  | { kind: "reclaimable" }
  | { kind: "claimable"; result: WorkflowStepResult };

/**
 * FNXC:LifecycleContainment 2026-08-30-12:57:
 * This is deliberately pure and clock-injected like classifyReviewLease. Admission, resolution,
 * and the self-healing advisory filter use one step-id-addressed vocabulary; the engine supplies
 * `liveSignature` because review-input normalization belongs to its review protocol, not core.
 */
export function classifyRemediationAttemptClaim(
  results: readonly WorkflowStepResult[] | undefined,
  input: { workflowStepId: string; signature: string; liveSignature: string | undefined; owner?: string; now: number; stalenessMs?: number },
): RemediationAttemptClaimDisposition {
  const result = results?.find((entry) => entry.workflowStepId === input.workflowStepId);
  if (!result) return { kind: "absent" };
  if (input.liveSignature !== input.signature) return { kind: "signature-moved" };
  if (result.remediationAttemptSignature !== undefined && result.remediationAttemptSignature !== input.signature) {
    return { kind: "signature-moved" };
  }
  if (result.remediationRefusedReason) return { kind: "refused", reason: result.remediationRefusedReason };
  const owner = result.remediationAttemptOwner;
  if (owner && input.owner === owner) return { kind: "owned", result };
  if (!owner) return { kind: "claimable", result };
  const claimedAt = result.remediationAttemptClaimedAt ? Date.parse(result.remediationAttemptClaimedAt) : Number.NaN;
  if (!Number.isFinite(claimedAt) || input.now - claimedAt >= (input.stalenessMs ?? REMEDIATION_ATTEMPT_CLAIM_STALENESS_MS)) {
    return { kind: "reclaimable" };
  }
  return { kind: "held", owner };
}

/**
 * Identity a caller supplies so {@link classifyReviewLease} can recognize leases left behind by a
 * PREVIOUS process on the SAME node. `nodeId` must be the cluster node id stamped into
 * `WorkflowStepResult.leaseNodeId`; `processBootAt` is this process's start time (epoch ms).
 * Omit it entirely to keep pure staleness-floor semantics.
 */
export interface LocalNodeLeaseIdentity {
  nodeId: string;
  processBootAt: number;
}

/** Classification of a review-gate's current lease state for a re-entering run. */
export type ReviewLeaseDisposition =
  /** No prior result — this run should claim the lease and dispatch the reviewer. */
  | { kind: "claim" }
  /** A terminal result already exists (passed/failed/…): satisfied, do not dispatch. */
  | { kind: "settled"; result: WorkflowStepResult }
  /** A LIVE lease owned by another run within the staleness floor: adopt, do NOT dispatch. */
  | { kind: "adopt"; owner: string }
  /** A stale lease (past the floor, or ownerless): this run may reclaim by CAS and dispatch. */
  | { kind: "reclaim"; priorOwner?: string };

/** Terminal statuses a leased pending result can settle into. */
const TERMINAL_STEP_STATUSES: ReadonlySet<WorkflowStepResult["status"]> = new Set([
  "passed",
  "failed",
  "advisory_failure",
  "skipped",
]);

/** Is a stored result a terminal (settled) record rather than a live/stale lease? */
export function isTerminalStepResult(result: WorkflowStepResult): boolean {
  return TERMINAL_STEP_STATUSES.has(result.status);
}

/**
 * Decide what a re-entering run should do about a review gate, given the current
 * results for the gate's step id. Pure and clock-injected. The staleness floor
 * (not owner identity) governs honor-vs-reclaim, so a crash/restart that re-enters
 * with the SAME deterministic run id still honors a live lease within the floor
 * (never double-dispatches) and only reclaims once the lease is presumed dead.
 *
 * - No existing result → `claim` (dispatch the reviewer, writing a lease).
 * - Existing terminal result → `settled` (dedup: do not re-dispatch).
 * - Existing `pending` lease within the staleness floor → `adopt` (do NOT dispatch).
 * - Existing `pending` lease past the floor (or ownerless/undated) → `reclaim`.
 */
export function classifyReviewLease(
  results: readonly WorkflowStepResult[] | undefined,
  stepId: string,
  now: number,
  stalenessMs: number = PLAN_REVIEW_LEASE_STALENESS_MS,
  localNode?: LocalNodeLeaseIdentity,
): ReviewLeaseDisposition {
  const existing = results?.find((r) => r.workflowStepId === stepId);
  if (!existing) return { kind: "claim" };
  if (isTerminalStepResult(existing)) return { kind: "settled", result: existing };
  // existing.status === "pending": it is a lease.
  const startedMs = existing.startedAt ? Date.parse(existing.startedAt) : Number.NaN;
  const ageMs = Number.isFinite(startedMs) ? now - startedMs : Number.POSITIVE_INFINITY;
  /*
  FNXC:PlanReviewLease 2026-07-26-20:12:
  Pre-boot reclaim. A lease stamped with THIS node's id whose `startedAt` predates this process's
  boot is provably dead: the process that could have owned it no longer exists. Reclaim it
  immediately instead of waiting out the staleness floor — the floor exists to protect leases we
  cannot attribute, and this one we can.

  Deliberately narrow, because every widening is a double-dispatch risk:
  - `leaseNodeId` must be PRESENT and EQUAL to ours. Absent (legacy rows) or a peer's id both keep
    the floor — under multi-node, a fresh peer lease is very likely genuinely running.
  - `startedAt` must parse and be STRICTLY before boot. A lease taken by this process after boot is
    a live in-process claim and must still be adopted.
  Motivating incident FN-8603: an engine restart killed a Code Review session 34s in; the lease then
  read "fresh" for the remaining ~14 minutes of the floor, so nothing re-ran the gate until it aged
  out and was marked failed.
  */
  const ownedByDeadLocalProcess =
    localNode !== undefined &&
    existing.leaseNodeId !== undefined &&
    existing.leaseNodeId === localNode.nodeId &&
    Number.isFinite(startedMs) &&
    startedMs < localNode.processBootAt;
  if (ownedByDeadLocalProcess) return { kind: "reclaim", priorOwner: existing.leaseOwner };
  const stale = !existing.leaseOwner || !Number.isFinite(startedMs) || ageMs >= stalenessMs;
  if (stale) return { kind: "reclaim", priorOwner: existing.leaseOwner };
  // Not stale ⇒ `leaseOwner` is guaranteed set (the stale check requires it).
  return { kind: "adopt", owner: existing.leaseOwner as string };
}

/**
 * Build the `pending` lease record a run writes when it claims/reclaims a review
 * gate. `startedAt` is the lease clock; `leaseOwner` is this run's identity.
 */
export function makeReviewLeaseRecord(args: {
  stepId: string;
  stepName: string;
  owner: string;
  startedAt: string;
  phase?: WorkflowStepResult["phase"];
  source?: WorkflowStepResult["source"];
}): WorkflowStepResult {
  return {
    workflowStepId: args.stepId,
    workflowStepName: args.stepName,
    ...(args.phase ? { phase: args.phase } : {}),
    ...(args.source ? { source: args.source } : {}),
    status: "pending",
    startedAt: args.startedAt,
    leaseOwner: args.owner,
  };
}
