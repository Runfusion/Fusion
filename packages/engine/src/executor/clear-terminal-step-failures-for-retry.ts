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
import type { TaskStore } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import { clearTerminalWorkflowStepFailures } from "./workflow-step-failures.js";

export type ClearTerminalStepFailuresForRetryDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function clearTerminalStepFailuresForRetry(
  deps: ClearTerminalStepFailuresForRetryDeps,
  taskId: string,
): Promise<void> {
  const live = await deps.store.getTask(taskId).catch(() => null);
  if (!live) return;
  const cleared = clearTerminalWorkflowStepFailures(live.workflowStepResults);
  if (cleared !== live.workflowStepResults) {
    await deps.store.updateTask(taskId, { workflowStepResults: cleared }, deps.getRunContextFor(taskId));
  }
}
