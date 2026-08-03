/**
 * FNXC:CodeOrganization 2026-08-03-07:20:
 * fn_task_done refusal evaluation peeled from executor.ts (wave18 / U4 Slice A).
 * Public symbols remain re-exported from executor.ts for import / vi.mock stability.
 */
import type { Task } from "@fusion/core";
import { evaluateSkipBypassTaint } from "@fusion/core";
import type { ReviewVerdict } from "../execution/reviewer.js";

const TASK_DONE_REFUSAL_SUFFIX = "Either finish the work and resubmit, or do not call fn_task_done — exit the session and the engine will requeue.";

type TaskDoneRefusalClass =
  | "bulk-step-completion-without-review"
  | "pending-code-review-revise";

type TaskDoneRefusalResult =
  | { ok: true }
  | {
    ok: false;
    refusalClass: TaskDoneRefusalClass;
    message: string;
    reason: string;
  };

export function formatTaskDoneRefusal(refusalClass: TaskDoneRefusalClass, reason: string): string {
  /*
  FNXC:Lifecycle 2026-07-16-10:20:
  FN-8141 — when the bulk-completion gate refuses (steps lack APPROVE verdicts), the agent must NOT reach for
  skip-every-step-then-complete as the escape hatch (that is exactly how FN-8141 laundered a failure into `done`).
  Name the honest blocked exit in the refusal so the sanctioned path is the advertised one.
  */
  const blockedHint = refusalClass === "bulk-step-completion-without-review"
    ? " If the work genuinely cannot proceed, do NOT skip the remaining steps to force completion — call fn_task_done(outcome=\"blocked\", reason=\"...\") instead."
    : "";
  return `fn_task_done refused (${refusalClass}): ${reason}. ${TASK_DONE_REFUSAL_SUFFIX}${blockedHint}`;
}

export function evaluateTaskDoneRefusal(
  task: Task,
  _params: { summary?: string },
  codeReviewVerdicts: Map<number, ReviewVerdict>,
): TaskDoneRefusalResult {
  const pendingSteps: number[] = [];
  for (let stepIndex = 0; stepIndex < task.steps.length; stepIndex++) {
    const step = task.steps[stepIndex];
    if (!step || step.status === "done" || step.status === "skipped") {
      continue;
    }
    pendingSteps.push(stepIndex);
    if (codeReviewVerdicts.get(stepIndex) === "REVISE") {
      const reason = `Step ${stepIndex} (${step.name}) has a pending code review verdict of REVISE`;
      return {
        ok: false,
        refusalClass: "pending-code-review-revise",
        reason,
        message: formatTaskDoneRefusal("pending-code-review-revise", reason),
      };
    }
  }

  if (pendingSteps.length >= 2) {
    const allPendingApproved = pendingSteps.every((stepIndex) => codeReviewVerdicts.get(stepIndex) === "APPROVE");
    if (!allPendingApproved) {
      const reason = `attempted to auto-complete ${pendingSteps.length} pending steps without APPROVE verdicts on all of them`;
      return {
        ok: false,
        refusalClass: "bulk-step-completion-without-review",
        reason,
        message: formatTaskDoneRefusal("bulk-step-completion-without-review", reason),
      };
    }
  }

  return { ok: true };
}

/*
FNXC:Lifecycle 2026-07-16-21:40:
FN-8141 — synthesize a refusal for an IMPLICIT (agent-exited, no explicit
fn_task_done) completion whose skipped steps are skip-bypass tainted. Only the
implicit/auto paths consult this; an explicit accepted fn_task_done stays the
honest exit that clears the taint. Reuses the bulk-step-completion class so the
existing refusal budget/park machinery applies unchanged.
*/
export function buildSkipBypassTaintRefusal(
  evaluation: ReturnType<typeof evaluateSkipBypassTaint>,
): Extract<TaskDoneRefusalResult, { ok: false }> {
  const reason = evaluation.reason
    ?? "skipped steps after a bulk-step-completion refusal cannot auto-complete the task";
  return {
    ok: false,
    refusalClass: "bulk-step-completion-without-review",
    reason,
    message: formatTaskDoneRefusal("bulk-step-completion-without-review", reason),
  };
}

/**
 * Determines the step index from which revision should restart given a set of
 * completed steps and user feedback. Exported for unit tests; no longer called
 * from the executor (revision is now handled via `reopenLastStepForRevision`).
 */
export function determineRevisionResetStart(
  steps: ReadonlyArray<{ name: string }>,
  feedback: string,
): number {
  const total = steps.length;
  if (total === 0) return 0;
  const skipPreflight = /preflight/i.test(steps[0].name);
  const firstCandidate = skipPreflight ? 1 : 0;
  if (firstCandidate >= total) return total;
  const fb = feedback.toLowerCase();
  for (let i = firstCandidate; i < total; i++) {
    const tokens = steps[i].name.toLowerCase().match(/[a-z][a-z]{4,}/g) ?? [];
    if (tokens.some((t) => fb.includes(t))) return i;
  }
  return firstCandidate;
}
