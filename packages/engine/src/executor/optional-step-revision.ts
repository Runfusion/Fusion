/**
 * FNXC:CodeOrganization 2026-08-03-07:45:
 * Optional step revision attempt accounting peeled from executor.ts.
 */
import type { Task, WorkflowReviewKind, WorkflowStepResult } from "@fusion/core";
import { isOpenWorkflowReviewFinding } from "@fusion/core";
import { createHash } from "node:crypto";
import {
  collectPlanReviewFeedbackHistory,
  countPlanReviewRevisionAttempts,
} from "../plan-review-feedback-history.js";

export const OPTIONAL_STEP_REVISION_KEY_MARKER = "Workflow revision key:";
export const REVIEW_REMEDIATION_EPISODE_MARKER = "Review remediation episode:";

/*
FNXC:ReviewRemediationBudget 2026-09-08-01:46:
Every failed gate occurrence needs a deterministic identity, including script and Browser Verification
results that have no content-review fingerprint. Exclude only remediation-claim bookkeeping, which is
expected to change while an owner holds the same failed occurrence; all execution/result evidence stays
in the digest so a replacement round cannot publish or resume stale work.
*/
export function reviewRemediationEpisodeIdentity(result: WorkflowStepResult): string {
  const identity = {
    workflowStepId: result.workflowStepId,
    workflowStepName: result.workflowStepName,
    phase: result.phase,
    source: result.source,
    status: result.status,
    verdictRequired: result.verdictRequired,
    reviewKind: result.reviewKind,
    output: result.output,
    findings: result.findings,
    repositoryReviewOutcomes: result.repositoryReviewOutcomes,
    repositoryScopeRevision: result.repositoryScopeRevision,
    notRunReason: result.notRunReason,
    reviewInputFingerprint: result.reviewInputFingerprint,
    reviewedCommitSha: result.reviewedCommitSha,
    verdict: result.verdict,
    notes: result.notes,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function hasReviewRemediationAttemptForEpisode(
  task: Pick<Task, "log">,
  episodeIdentity: string,
): boolean {
  return (task.log ?? []).some((entry) =>
    (entry.outcome ?? "").split(/\r?\n/).some((line) => line.trim() === `${REVIEW_REMEDIATION_EPISODE_MARKER} ${episodeIdentity}`),
  );
}

export function normalizeOptionalStepRevisionKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function optionalStepRevisionKey(nodeId: string | undefined, stepName: string | undefined): string {
  return normalizeOptionalStepRevisionKey(nodeId) || normalizeOptionalStepRevisionKey(stepName) || "pre-merge-optional-step";
}

/*
FNXC:WorkflowRevisionBudget 2026-09-05-23:30:
FN-1711: the revision budget is derived from the task log, so a dashboard review restart — which
discards the step result and re-runs the gate — left the counter untouched and the fresh review was
refused for a budget the PREVIOUS episode had spent. Measured: a card whose Code Review was restarted
twice still reported `Attempts: 6 / Maximum revisions: 3` and never merged. The log is append-only, so
the restart appends this marker instead of rewriting history, and attempts recorded before the newest
marker for the same revision key belong to the closed episode.
*/
export const OPTIONAL_STEP_REVISION_RESET_MARKER = "Workflow revision ledger reset:";

export function optionalStepRevisionResetOutcome(key: string): string {
  return `${OPTIONAL_STEP_REVISION_RESET_MARKER} ${key}`;
}

function resetIndexFor(log: NonNullable<Task["log"]>, normalizedKey: string): number {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const outcome = log[index]?.outcome ?? "";
    const markerIndex = outcome.indexOf(OPTIONAL_STEP_REVISION_RESET_MARKER);
    if (markerIndex < 0) continue;
    const markerValue = outcome.slice(markerIndex + OPTIONAL_STEP_REVISION_RESET_MARKER.length).split(/\r?\n/, 1)[0]?.trim();
    if (normalizeOptionalStepRevisionKey(markerValue) === normalizedKey) return index;
  }
  return -1;
}

export function countOptionalStepRevisionAttempts(task: Pick<Task, "log">, key: string, stepName: string | undefined): number {
  const normalizedKey = normalizeOptionalStepRevisionKey(key);
  const normalizedStepName = normalizeOptionalStepRevisionKey(stepName);
  const log = task.log ?? [];
  const since = resetIndexFor(log, normalizedKey);
  return (since >= 0 ? log.slice(since + 1) : log).filter((entry) => {
    const action = entry.action ?? "";
    const outcome = entry.outcome ?? "";
    if (!/attempt \d+\//.test(action)) return false;
    const markerIndex = outcome.indexOf(OPTIONAL_STEP_REVISION_KEY_MARKER);
    if (markerIndex >= 0) {
      const markerValue = outcome.slice(markerIndex + OPTIONAL_STEP_REVISION_KEY_MARKER.length).split(/\r?\n/, 1)[0]?.trim();
      return normalizeOptionalStepRevisionKey(markerValue) === normalizedKey;
    }
    if (!normalizedStepName) return false;
    return normalizeOptionalStepRevisionKey(outcome).includes(`step: ${normalizedStepName}`);
  }).length;
}

export function optionalStepRevisionLogOutcome(details: string, key: string, episodeIdentity?: string): string {
  return `${details}\n${OPTIONAL_STEP_REVISION_KEY_MARKER} ${key}${episodeIdentity ? `\n${REVIEW_REMEDIATION_EPISODE_MARKER} ${episodeIdentity}` : ""}`;
}

/*
FNXC:PlanReviewConvergence 2026-08-04-06:35 (FN-8768; restored 2026-08-15-22:15 after the wave-18
executor.ts shell-ification dropped it): Retry numbering uses the uncapped durable attempt ledger,
while prompt prose uses the separately bounded, deduplicated same-episode decision history.
*/
export function buildReviewConvergenceContext(
  task: Pick<Task, "workflowStepResults">,
  options: { revisionKey: string; reviewKind: WorkflowReviewKind; changeSummaryBlock?: string },
): string {
  const revisionKey = options.revisionKey;
  const priorAttemptCount = countPlanReviewRevisionAttempts(task.workflowStepResults, { revisionKey });
  const attempt = priorAttemptCount + 1;
  if (attempt <= 1) return "";

  const history = collectPlanReviewFeedbackHistory(task.workflowStepResults, { revisionKey });
  const lines = [
    `## Convergence — ${options.reviewKind === "plan" ? "Plan Review" : "Code Review"} attempt ${attempt}`,
  ];
  if (options.changeSummaryBlock?.trim()) lines.push("", options.changeSummaryBlock.trim());
  lines.push(
    "Treat the cumulative prior feedback below as a decision primer. Verify each prior blocker against the current PROMPT.md before looking for new findings.",
    "- Do not re-raise a resolved or semantically duplicate blocker.",
    "- A newly blocking finding must identify the revision that introduced it, the prior blocker that genuinely masked it, or why it is independently delivery-blocking for correctness, security, data safety, or executability. Record an earlier reviewer miss explicitly; never demote a critical defect merely because it was missed before.",
  );
  if (attempt >= 3) {
    lines.push(
      "- Severity ratchet (attempt 3+): only delivery-blocking critical defects may return REVISE; important/minor wording or implementation-detail findings are advisory.",
    );
  }
  if (history.length > 0) {
    lines.push("", "### Cumulative prior Plan Review ledger");
    history.forEach((feedback, index) => lines.push(`#### PR${index + 1}`, feedback));
  }
  const own = task.workflowStepResults?.find((result) => result.workflowStepId === revisionKey);
  const findings = (own?.priorAttempts ?? []).flatMap((attempt) => attempt.findings ?? [])
    .filter(isOpenWorkflowReviewFinding);
  if (findings.length > 0) {
    lines.push("", "### Your prior findings on this gate");
    findings.forEach((finding) => lines.push(`- ${finding.id} — [${finding.severity ?? "unclassified"}] ${finding.title}: ${finding.body}${finding.filePath ? ` (${finding.filePath}${finding.line ? `:${finding.line}` : ""})` : ""}`));
    lines.push("Match prior defects by file path, line region, and described behavior; IDs and titles may change between rounds.");
  }
  const disputed = findings.filter((finding) => finding.disputedAt);
  if (disputed.length > 0) {
    lines.push("", "### Disputed by the implementer");
    disputed.forEach((finding) => lines.push(`- ${finding.id}: ${finding.disputeRationale ?? "No rationale recorded."}`));
    lines.push("You MUST rule on each dispute: accept it by listing its ID in supersededFindingIds, or maintain it with a finding whose rebutsDisputedFindingId names it and whose body answers the rationale. A maintained objection needs that reference even if it has a new finding ID.");
  }
  return lines.join("\n");
}

/** Backward-compatible plan wrapper retains the established Plan Review call site. */
export function buildGraphPlanReviewConvergenceContext(task: Pick<Task, "workflowStepResults">, revisionKey: string): string {
  return buildReviewConvergenceContext(task, { revisionKey, reviewKind: "plan" });
}
