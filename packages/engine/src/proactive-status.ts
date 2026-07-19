import { redactSecrets, type AgentRole, type TaskStore } from "@fusion/core";
import type { ReviewVerdict } from "./reviewer.js";

const GENERIC_FAILURE_REASON = "No failure reason was provided.";
const MAX_REASON_LENGTH = 300;

/**
 * FNXC:ProactiveChatStatus 2026-07-16-12:00:
 * Issue #2153 requires the task-detail chat to narrate step start, success, intentional skips, safe
 * failure reasons, and review/rollback outcomes as standalone status rows, making it a real-time progress report.
 * Both step-session callbacks and the default fn_task_update seam use this shared wording. Failure
 * and review-summary diagnostics are nullish-safe, redacted, path/stack stripped, single-line, and
 * capped at 300 characters; UNAVAILABLE is not a verdict but is narrated as a safe operational failure.
 */
export function sanitizeFailureReason(rawError: unknown): string {
  let candidate: string;
  try {
    if (rawError === null || rawError === undefined) return GENERIC_FAILURE_REASON;
    if (rawError instanceof Error) candidate = rawError.message || String(rawError);
    else if (typeof rawError === "string") candidate = rawError;
    else candidate = String(rawError);
  } catch {
    return GENERIC_FAILURE_REASON;
  }
  if (!candidate.trim()) return GENERIC_FAILURE_REASON;

  let sanitized = redactSecrets(candidate)
    // Remove conventional JavaScript stack frames before general whitespace collapse.
    .replace(/\s*at\s+[^\n]+\([^\n]*:\d+:\d+\)/g, " ")
    .replace(/\s*at\s+[^\n]+:\d+:\d+/g, " ")
    // Any absolute filesystem path is environment-sensitive, including system/service roots.
    .replace(/(?:[A-Za-z]:\\|\/)[^\s:),]+/g, "[path]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!sanitized) return GENERIC_FAILURE_REASON;
  if (sanitized.length > MAX_REASON_LENGTH) sanitized = `${sanitized.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…`;
  return sanitized;
}

function stepLabel(stepIndex: number, stepName?: string): string {
  const fallback = `Step ${stepIndex}`;
  return stepName?.trim() || fallback;
}

export function buildStepStartMessage(stepIndex: number, stepName?: string): string {
  return `Starting Step ${stepIndex}: ${stepLabel(stepIndex, stepName)}`;
}

export function buildStepSuccessMessage(stepIndex: number, stepName?: string): string {
  const name = stepName?.trim();
  return name && name !== `Step ${stepIndex}` ? `Step ${stepIndex} finished — ${name}.` : `Step ${stepIndex} finished.`;
}

/**
 * FNXC:ProactiveChatStatus 2026-07-16-12:45:
 * Store-accepted skipped transitions are terminal task outcomes too. Narrate them distinctly so
 * preflight and intentional no-op flows remain visible without fabricating a failure reason.
 */
export function buildStepSkippedMessage(stepIndex: number, stepName?: string): string {
  const name = stepName?.trim();
  return name && name !== `Step ${stepIndex}` ? `Step ${stepIndex} was skipped — ${name}.` : `Step ${stepIndex} was skipped.`;
}

export function buildStepFailureMessage(stepIndex: number, stepName: string | undefined, safeReason: string): string {
  const prefix = stepName?.trim() && stepName.trim() !== `Step ${stepIndex}` ? `Step ${stepIndex} (${stepName.trim()})` : `Step ${stepIndex}`;
  return `${prefix} did not complete: ${safeReason}`;
}

export function buildReviewVerdictMessage(verdict: ReviewVerdict, summary: unknown): string | null {
  const safeSummary = sanitizeFailureReason(summary);
  switch (verdict) {
    case "APPROVE": return `Review passed — ${safeSummary}`;
    case "REVISE": return `Review requested changes: ${safeSummary}`;
    case "RETHINK": return `Review rolled the step back to rethink the approach: ${safeSummary}`;
    case "UNAVAILABLE": return null;
  }
}

export function buildPlanVerifiedMessage(): string {
  return "The plan was written and verified.";
}

/**
 * FNXC:ProactiveChatStatus 2026-07-16-13:10:
 * A reviewer outage is progress-relevant even though UNAVAILABLE is not a verdict. Report it as
 * an operational status, with the same bounded diagnostic policy as failures, so the chat tells
 * the operator why review did not complete without misrepresenting it as APPROVE/REVISE/RETHINK.
 */
export function buildReviewUnavailableMessage(reason: unknown): string {
  return `Review could not complete: ${sanitizeFailureReason(reason)}`;
}

/**
 * FNXC:ProactiveChatStatus 2026-07-16-12:30:
 * A RETHINK narration may claim that work was rolled back only after the baseline reset succeeds.
 * Reset failures instead need a safe status row that tells the operator the rollback did not finish.
 */
export function buildReviewRollbackFailureMessage(safeReason: string): string {
  return `Review could not roll the step back: ${safeReason}`;
}

export async function emitProactiveStatus(
  store: Pick<TaskStore, "appendAgentLog" | "getSettingsFast">,
  taskId: string,
  message: string | null | undefined,
  role: AgentRole,
  detail?: string,
): Promise<void> {
  if (!message) return;
  try {
    if ((await store.getSettingsFast()).proactiveTaskChatEnabled !== true) return;
    await store.appendAgentLog(taskId, message, "status", detail, role);
  } catch {
    // Proactive narration is strictly observational and must not affect execution.
  }
}
