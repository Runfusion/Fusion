/**
 * FNXC:CodeOrganization 2026-08-03-13:45:
 * Pure completion/refusal predicates peeled from TaskExecutor (U4).
 */
import type { Task } from "@fusion/core";
import { evaluateSkipBypassTaint } from "@fusion/core";
import type { ReviewVerdict } from "../execution/reviewer.js";
import {
  buildSkipBypassTaintRefusal,
  evaluateTaskDoneRefusal,
} from "./task-done-refusal.js";
import { isTaskWorkComplete } from "./task-predicates.js";

/*
FNXC:Lifecycle 2026-07-16-21:40: FN-8141 — the step-status "already complete" branch
must not treat skip-bypass-tainted skips as completion; an accepted done / in-review
column are honest completion signals and stay unaffected.

The review lane arrives from the caller because the synchronous resolver returns the
default workflow in PostgreSQL mode, so resolving it here would change the census and not the behaviour.
*/
export function isTaskAlreadyCompleteForNonContinuableSession(
  task: Task,
  taskDone: boolean,
  reviewLane: string,
): boolean {
  return taskDone
    || task.column === reviewLane
    || (isTaskWorkComplete(task) && !evaluateSkipBypassTaint(task).blocked);
}

/*
FNXC:Lifecycle 2026-07-16-21:40:
FN-8141 — the implicit completion path (agent exit without fn_task_done while steps look complete)
must enforce the same skip-bypass taint refusal as explicit task_done. A synthesized taint refusal
here re-parks the run through the existing refusal budget rather than laundering skipped-after-refusal
steps into review. The explicit fn_task_done tool path is NOT routed here — that call remains the honest exit.
*/
export function evaluateImplicitCompletionRefusal(
  task: Task,
  codeReviewVerdicts: Map<number, ReviewVerdict>,
): ReturnType<typeof evaluateTaskDoneRefusal> {
  const refusal = evaluateTaskDoneRefusal(task, {}, codeReviewVerdicts);
  if (!refusal.ok) return refusal;
  const taint = evaluateSkipBypassTaint(task);
  if (taint.blocked) return buildSkipBypassTaintRefusal(taint);
  return { ok: true };
}

/*
FNXC:Lifecycle 2026-07-16-21:40:
FN-8141 — a `bulk-step-completion-without-review` refusal stamps the durable taint
marker so that later skips (in this or a requeued lifecycle) cannot auto-promote. The
marker is cleared only on an honest exit (accepted fn_task_done / operator retry).
*/
export function skipBypassTaintUpdateForRefusal(
  refusal: Extract<ReturnType<typeof evaluateTaskDoneRefusal>, { ok: false }>,
): { bulkCompletionRefusalAt: string } | Record<string, never> {
  if (refusal.refusalClass !== "bulk-step-completion-without-review") return {};
  return { bulkCompletionRefusalAt: new Date().toISOString() };
}
