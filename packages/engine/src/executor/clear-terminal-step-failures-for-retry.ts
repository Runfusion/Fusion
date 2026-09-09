/**
 * FNXC:CodeOrganization 2026-08-03-19:00:
 * clearTerminalStepFailuresForRetry peeled from TaskExecutor (U4).
 *
 * FNXC:ReviewLeniency 2026-07-02-02:10:
 * Clear prior terminal failure results (failed/advisory_failure — incl. optional gate nodes like
 * code-review) so a retry starts clean. Call this ONLY once the task has left the mergeable
 * in-review column (i.e. it is in `todo`): clearing while still in-review drops the merge blocker
 * during the rerun-bounce window and could let a concurrent auto-merge sweep merge an empty-`steps`
 * graph-native task with its gate failure unaddressed. `moveTask(in-review→todo)` already clears
 * ALL results (applyReopenFieldClears), so this is chiefly for the in-progress→todo bounce path
 * where the move does not. Passed/skipped/pending evidence is kept.
 */
import type { TaskStore, WorkflowStepResult } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import { archiveTerminalWorkflowStepFailures } from "@fusion/core";
import { clearTerminalWorkflowStepFailures } from "./workflow-step-failures.js";

/*
FNXC:ReviewRemediation 2026-09-05-22:31:
FN-295: the remediation archive is scoped to the ONE gate this bounce is remediating — the latest
terminal pre-merge failure — because that is what both call sites describe ("archive ITS failed review
result"). The blanket archive also stamped unrelated terminal rows, and an archived carrier is a merge
veto that no reseed, reroute, or operator bypass can select. Measured on FN-295: a Plan Review row that
a restart had left `pending`, rewritten to `failed` by the orphaned-step sweep at 10:30, was archived by
a Code Review remediation at 19:28 and made the card permanently unmergeable with no recovery owner.
An older failure of a DIFFERENT gate stays `failed`: still blocking (it was never remediated) but
visible, re-runnable, and selectable by the audited operator bypass.
*/
function latestTerminalPreMergeFailureId(results: readonly WorkflowStepResult[] | undefined): string | undefined {
  return (results ?? [])
    .filter((result) => (result.phase || "pre-merge") === "pre-merge"
      && (result.status === "failed" || result.status === "advisory_failure"))
    .sort((left, right) => {
      const leftTime = Date.parse(left.completedAt || left.startedAt || "");
      const rightTime = Date.parse(right.completedAt || right.startedAt || "");
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    })[0]?.workflowStepId;
}

export type TerminalFailureRetryMode = "archive" | "clear";

export type ClearTerminalStepFailuresForRetryDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function clearTerminalStepFailuresForRetry(
  deps: ClearTerminalStepFailuresForRetryDeps,
  taskId: string,
  mode: TerminalFailureRetryMode,
): Promise<void> {
  const live = await deps.store.getTask(taskId).catch(() => null);
  if (!live) return;
  const remediatedStepId = mode === "archive" ? latestTerminalPreMergeFailureId(live.workflowStepResults) : undefined;
  const cleared = mode === "archive"
    ? archiveTerminalWorkflowStepFailures(
      live.workflowStepResults,
      undefined,
      remediatedStepId ? { workflowStepIds: new Set([remediatedStepId]) } : {},
    )
    : clearTerminalWorkflowStepFailures(live.workflowStepResults);
  if (cleared !== live.workflowStepResults) {
    await deps.store.updateTask(taskId, { workflowStepResults: cleared }, deps.getRunContextFor(taskId));
  }
}
