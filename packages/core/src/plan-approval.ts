import { createHash } from "node:crypto";
import {
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_HEADING,
  ORIGINAL_DESCRIPTION_START_MARKER,
} from "./original-description-policy.js";
import { FRONTEND_UX_CRITERIA_SECTION } from "./frontend-ux-policy.js";
import type { ProjectSettings } from "./types.js";

export type PlanApprovalMode = NonNullable<ProjectSettings["planApprovalMode"]>;

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
 * FNXC:PlanApproval 2026-06-26-00:00:
 * Per-project planApprovalMode controls the planning approval gate for every task in the project: require-all always parks approved specs for manual approval, auto-approve-all always bypasses the gate, and workflow/undefined preserves the workflow-resolved requirePlanApproval value.
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
