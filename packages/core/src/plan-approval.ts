import { createHash } from "node:crypto";
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
 */
export function computePlanApprovalFingerprint(promptText: string): string {
  const normalized = promptText
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\s+$/, "");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
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
