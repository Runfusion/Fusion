/**
 * FNXC:CodeOrganization 2026-08-03-20:05:
 * recoverApprovedStepsOnResume peeled from TaskExecutor (U4).
 *
 * When the engine restarts mid-step, an `in-progress` step may have already passed its code
 * review (log: `code review Step N: APPROVE`) but not yet been flipped to `done` by the agent's
 * next `fn_task_update` call. Without intervention, the next executor pass re-enters the step
 * and replays plan + code review (5–20 min waste per restart). Scans the task log for any
 * in-progress step whose most recent approved code review is newer than its most recent
 * `→ pending` transition, and marks those steps `done`.
 */
import type { TaskDetail, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";

export async function recoverApprovedStepsOnResume(
  store: TaskStore,
  taskId: string,
): Promise<void> {
  let detail: TaskDetail;
  try {
    detail = await store.getTask(taskId);
  } catch (err) {
    executorLog.warn(`${taskId}: recoverApprovedStepsOnResume getTask failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const log = detail.log ?? [];
  if (log.length === 0) return;

  let recovered = 0;
  for (let i = 0; i < detail.steps.length; i++) {
    if (detail.steps[i].status !== "in-progress") continue;

    let lastPendingAt = -1;
    let lastApproveAt = -1;
    const stepName = detail.steps[i].name;
    // Matches "Step 3 (My Step) → pending"; name is user-controlled, so match
    // on prefix rather than a regex built from the name.
    const transitionPrefix = `Step ${i} (${stepName}) → `;
    const approvePrefix = `code review Step ${i}:`;
    for (let j = 0; j < log.length; j++) {
      const action = log[j].action || "";
      if (action.startsWith(transitionPrefix)) {
        const status = action.slice(transitionPrefix.length).trim();
        if (status === "pending") lastPendingAt = j;
      } else if (action.startsWith(approvePrefix) && action.includes("APPROVE")) {
        lastApproveAt = j;
      }
    }

    if (lastApproveAt > lastPendingAt) {
      executorLog.log(
        `${taskId}: step ${i} ("${stepName}") already has an approved code review — marking done on resume (skipping review replay)`,
      );
      try {
        await store.logEntry(
          taskId,
          `Step ${i} (${stepName}) recovered as done on resume — code review had already approved before the engine stopped`,
        );
        await store.updateStep(taskId, i, "done");
        recovered++;
      } catch (err) {
        executorLog.warn(
          `${taskId}: failed to recover step ${i} on resume: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (recovered > 0) {
    executorLog.log(`${taskId}: recovered ${recovered} approved step(s) on resume`);
  }
}
