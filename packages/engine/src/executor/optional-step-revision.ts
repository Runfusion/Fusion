/**
 * FNXC:CodeOrganization 2026-08-03-07:45:
 * Optional step revision attempt accounting peeled from executor.ts.
 */
import type { Task } from "@fusion/core";
import {
  collectPlanReviewFeedbackHistory,
  countPlanReviewRevisionAttempts,
} from "../plan-review-feedback-history.js";

export const OPTIONAL_STEP_REVISION_KEY_MARKER = "Workflow revision key:";

export function normalizeOptionalStepRevisionKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function optionalStepRevisionKey(nodeId: string | undefined, stepName: string | undefined): string {
  return normalizeOptionalStepRevisionKey(nodeId) || normalizeOptionalStepRevisionKey(stepName) || "pre-merge-optional-step";
}

export function countOptionalStepRevisionAttempts(task: Pick<Task, "log">, key: string, stepName: string | undefined): number {
  const normalizedKey = normalizeOptionalStepRevisionKey(key);
  const normalizedStepName = normalizeOptionalStepRevisionKey(stepName);
  return (task.log ?? []).filter((entry) => {
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

export function optionalStepRevisionLogOutcome(details: string, key: string): string {
  return `${details}\n${OPTIONAL_STEP_REVISION_KEY_MARKER} ${key}`;
}

/*
FNXC:PlanReviewConvergence 2026-08-04-06:35 (FN-8768; restored 2026-08-15-22:15 after the wave-18
executor.ts shell-ification dropped it): Retry numbering uses the uncapped durable attempt ledger,
while prompt prose uses the separately bounded, deduplicated same-episode decision history.
*/
export function buildGraphPlanReviewConvergenceContext(
  task: Pick<Task, "workflowStepResults">,
  revisionKey: string,
): string {
  const priorAttemptCount = countPlanReviewRevisionAttempts(task.workflowStepResults, { revisionKey });
  const attempt = priorAttemptCount + 1;
  if (attempt <= 1) return "";

  const history = collectPlanReviewFeedbackHistory(task.workflowStepResults, { revisionKey });
  const lines = [
    `## Convergence — Plan Review attempt ${attempt}`,
    "Treat the cumulative prior feedback below as a decision primer. Verify each prior blocker against the current PROMPT.md before looking for new findings.",
    "- Do not re-raise a resolved or semantically duplicate blocker.",
    "- A newly blocking finding must identify the revision that introduced it, the prior blocker that genuinely masked it, or why it is independently delivery-blocking for correctness, security, data safety, or executability. Record an earlier reviewer miss explicitly; never demote a critical defect merely because it was missed before.",
  ];
  if (attempt >= 3) {
    lines.push(
      "- Severity ratchet (attempt 3+): only delivery-blocking critical defects may return REVISE; important/minor wording or implementation-detail findings are advisory.",
    );
  }
  if (history.length > 0) {
    lines.push("", "### Cumulative prior Plan Review ledger");
    history.forEach((feedback, index) => {
      lines.push(`#### PR${index + 1}`, feedback);
    });
  }
  return lines.join("\n");
}
