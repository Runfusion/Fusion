import { createHash } from "node:crypto";
import {
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_HEADING,
  ORIGINAL_DESCRIPTION_START_MARKER,
} from "../tasks/original-description-policy.js";
import { FRONTEND_UX_CRITERIA_SECTION } from "../tasks/frontend-ux-policy.js";
import type { ProjectSettings, Task } from "../types.js";
import type { WorkflowStepResult } from "../types/workflow/workflow-steps.js";
import { PLAN_REVIEW_GROUP_ID } from "../workflows/builtin-plan-review-group.js";

export type PlanApprovalMode = NonNullable<ProjectSettings["planApprovalMode"]>;

/*
FNXC:PlanReviewApproval 2026-08-04-00:26:
Plan Review is terminal when the reviewer passed it or an operator durably accepted the final
failed REVISE after the revision cap. Require the full audited source state so a malformed skip
cannot silently open the execution gate.
*/
export function isPlanReviewSatisfied(result: WorkflowStepResult): boolean {
  if (result.workflowStepId !== PLAN_REVIEW_GROUP_ID) return false;
  if (result.supersededAt != null) return false;
  if (result.status === "passed") return true;
  if (result.status !== "skipped") return false;
  const operatorBypass = (result.bypassedFromStatus === "failed" || result.bypassedFromStatus === "advisory_failure")
    && result.bypassedFromVerdict === "REVISE"
    && typeof result.bypassedBy === "string" && result.bypassedBy.trim().length > 0
    && typeof result.bypassedAt === "string" && result.bypassedAt.trim().length > 0
    && typeof result.bypassReason === "string" && result.bypassReason.trim().length > 0;
  /*
  FNXC:ReviewConvergence 2026-08-22-17:29:
  FN-149 arbitration may satisfy Plan Review only after every binding obligation was removed.
  The archive helper already refuses a nonzero count, but this gate is the final fail-closed
  boundary for persisted carriers and must not trust a malformed UPHOLD_IMPLEMENTER record.
  */
  const arbitratedRelease = (result.remediationArchivedFromStatus === "failed" || result.remediationArchivedFromStatus === "advisory_failure")
    && result.arbitrationBindingFindingCount === 0
    && (result.arbitrationDecision === "UPHOLD_IMPLEMENTER"
      || result.arbitrationDecision === "SPLIT")
    && typeof result.arbitratedAttemptAt === "string" && result.arbitratedAttemptAt.trim().length > 0
    && typeof result.arbitratedAt === "string" && result.arbitratedAt.trim().length > 0
    && typeof result.arbitrationNotes === "string" && result.arbitrationNotes.trim().length > 0;
  return operatorBypass || arbitratedRelease;
}

/*
 * FNXC:PlanReviewSupersession 2026-08-04-06:35:
 * A dependency change preserves Plan Review history for audit while retiring
 * every current gate projection, including an in-flight lease. Superseded
 * evidence belongs to the old planning episode and cannot satisfy the new gate.
 *
 * FNXC:PlanReviewSupersession 2026-08-28-06:24:
 * Respecify preserves the old plan only as revision source. Its current Plan Review evidence must
 * be retired under an explicit reason so the preserved text can never count as already reviewed.
 */
export function supersedePlanReviewResults(
  results: WorkflowStepResult[] | undefined,
  supersededAt: string,
  reason: NonNullable<WorkflowStepResult["supersededReason"]> = "dependency-change",
): WorkflowStepResult[] | undefined {
  if (!results?.some((result) => result.workflowStepId === PLAN_REVIEW_GROUP_ID && result.supersededAt == null)) {
    return results;
  }
  return results.map((result) => result.workflowStepId === PLAN_REVIEW_GROUP_ID && result.supersededAt == null
    ? { ...result, supersededAt, supersededReason: reason }
    : result);
}

export function buildPreservedPlanRespecifyPatch(
  task: Pick<Task, "workflowStepResults">,
  supersededAt: string,
): {
  status: "needs-replan";
  approvedPlanFingerprint: null;
  awaitingApprovalReason: null;
  workflowStepResults: WorkflowStepResult[] | undefined;
} {
  return {
    status: "needs-replan",
    approvedPlanFingerprint: null,
    awaitingApprovalReason: null,
    workflowStepResults: supersedePlanReviewResults(task.workflowStepResults, supersededAt, "respecify"),
  };
}

/**
 * FNXC:PlanApproval 2026-07-04-22:41:
 * FN-7569 — manual plan approval was not idempotent against unchanged plan content: an
 * operator approving a plan (auto-approve-all off) had no persisted record of *what* they
 * approved, so any re-specification of the same task (replan, plan-review reviewer-outage
 * retry, self-healing rebound to triage) that re-ran finalizeApprovedTask re-triggered the
 * manual gate and re-parked an already-approved, byte-identical plan at "awaiting-approval".
 * computePlanApprovalFingerprint gives approve-plan a stable hash of the approved PROMPT.md
 * (Task.approvedPlanFingerprint) so the manual gate can skip re-parking when the freshly
 * written PROMPT.md is unchanged, while still re-asking when the plan genuinely changed or
 * was rejected. Normalizes only trailing whitespace/newlines so cosmetic write differences
 * (trailing newline, trailing spaces) never cause spurious re-approval.
 *
 * FNXC:PlanApproval 2026-07-15-20:45:
 * FN-8008 — `finalizeApprovedTask` deterministically injects Original Description and
 * Frontend UX hygiene after a planner produces a spec. Approval fingerprints must ignore
 * precisely those generated sections: approve-plan reads the on-disk prompt while recovery
 * may compare its pre-injection text. Keeping normalization here makes every producer and
 * consumer agree without treating an operator-authored Mission, Steps, or File Scope change
 * as unchanged.
 */
export function computePlanApprovalFingerprint(promptText: string): string {
  const normalized = normalizePlanApprovalPrompt(promptText)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\s+$/, "");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** Remove only the exact deterministic sections injected during specification hygiene. */
function normalizePlanApprovalPrompt(promptText: string): string {
  return stripInjectedFrontendUxCriteria(stripInjectedOriginalDescription(promptText));
}

function stripInjectedOriginalDescription(promptText: string): string {
  const start = promptText.indexOf(ORIGINAL_DESCRIPTION_START_MARKER);
  const end = findGeneratedOriginalDescriptionEnd(promptText, start);
  if (start === -1 || end === -1) return promptText;

  const heading = promptText.lastIndexOf(ORIGINAL_DESCRIPTION_HEADING, start);
  if (heading === -1) return promptText;

  const sectionEnd = end + ORIGINAL_DESCRIPTION_END_MARKER.length;
  const before = promptText.slice(0, heading).trimEnd();
  const after = promptText.slice(sectionEnd).replace(/^\n+/, "");
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

/**
 * FNXC:PlanApproval 2026-07-15-21:30:
 * FN-8008 — Original Description bodies are verbatim, so marker-like text can occur both
 * inside the generated body and later in operator-authored prompt content. The generated
 * closing marker is bounded by the next known PROMPT section (or end of file), preventing a
 * later literal marker from swallowing a real Mission/Steps/File Scope revision.
 */
function findGeneratedOriginalDescriptionEnd(promptText: string, start: number): number {
  if (start === -1) return -1;

  let searchFrom = start + ORIGINAL_DESCRIPTION_START_MARKER.length;
  while (searchFrom < promptText.length) {
    const end = promptText.indexOf(ORIGINAL_DESCRIPTION_END_MARKER, searchFrom);
    if (end === -1) return -1;

    const after = promptText.slice(end + ORIGINAL_DESCRIPTION_END_MARKER.length);
    if (
      !after.trim()
      || /^\n{1,2}##\s+(?:Before\s*→\s*After Transformation|Review Level(?:\s*:.*)?|Mission|Surface Enumeration|Symptom Verification|Dependencies|Context to Read First|File Scope|Steps|Documentation Requirements|Completion Criteria|Git Commit Convention|Do NOT|Changeset Requirements|Frontend UX Criteria|Acceptance Criteria|Notifications|External Integration Evidence)\s*(?:\n|$)/.test(after)
    ) {
      return end;
    }
    searchFrom = end + ORIGINAL_DESCRIPTION_END_MARKER.length;
  }
  return -1;
}

function stripInjectedFrontendUxCriteria(promptText: string): string {
  const sectionStart = promptText.indexOf(FRONTEND_UX_CRITERIA_SECTION);
  if (sectionStart === -1) return promptText;

  const before = promptText.slice(0, sectionStart).trimEnd();
  const after = promptText
    .slice(sectionStart + FRONTEND_UX_CRITERIA_SECTION.length)
    .replace(/^\n+/, "");
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

/**
 * FNXC:PlanApproval 2026-08-28-17:16:
 * FN-234 removes per-task approval escalation. Manual approval now derives only from the project
 * planApprovalMode and the workflow-resolved requirePlanApproval setting: require-all always parks,
 * auto-approve-all always bypasses, and workflow/undefined preserves the workflow value.
 */
export function resolvePlanApprovalRequired(
  settings: Pick<ProjectSettings, "planApprovalMode" | "requirePlanApproval">,
): boolean {
  switch (settings.planApprovalMode) {
    case "require-all":
      return true;
    case "auto-approve-all":
      return false;
    case "workflow":
    default:
      return Boolean(settings.requirePlanApproval);
  }
}
