/**
 * FNXC:CodeOrganization 2026-07-15-00:00:
 * Workflow step failure filter helpers peeled from executor.ts.
 */
import type { WorkflowStepResult as CoreWorkflowStepResult } from "@fusion/core";

/*
FNXC:ReviewLeniency 2026-07-02-01:00:
Retrying a task must clear PRIOR FAILURE states so the retry starts clean — including on optional gate nodes like code-review / browser-verification. Results are upserted by node id, so a re-running node overwrites its own stale entry, but a send-back-for-fix leaves the failed entry in place until (and unless) that node re-runs; meanwhile self-healing's failed-pre-merge scan and the dashboard both see a stale failure, and a node that is skipped/relaxed on the retry never clears it. Drop every terminal failure result (`failed`/`advisory_failure`) on retry while keeping `passed`/`skipped`/`pending` evidence (so a previously-passed Plan Review is not re-run). Returns the same array reference when nothing changed so callers can skip a no-op write.

FNXC:WorkflowStepResults 2026-07-09-00:30:
FN-7727 explicit decision: an explicit user/agent RETRY remains a clean-slate —
it MAY drop the current `failed`/`advisory_failure` entry entirely (along with
any `priorAttempts` history it carried), since retry is deliberately
discarding prior failure state, not preserving it. This is DIFFERENT from the
self-healing recovery re-run path (`recoverFailedPreMergeWorkflowStep` /
`recoverReviewTasksWithFailedPreMergeSteps`), which does NOT call this
function — that path re-runs the SAME node in place and its result goes
through `upsertWorkflowStepResult`, which is where prior-attempt history is
preserved. This filter must not throw on entries carrying `priorAttempts`
(it only reads `status`, so `priorAttempts` is inert here regardless).
*/
export function clearTerminalWorkflowStepFailures(
  results: CoreWorkflowStepResult[] | undefined,
): CoreWorkflowStepResult[] {
  const current = results ?? [];
  const kept = current.filter((result) => result.status !== "failed" && result.status !== "advisory_failure");
  return kept.length === current.length ? current : kept;
}
