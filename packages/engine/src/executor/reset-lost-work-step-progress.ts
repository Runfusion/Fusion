/**
 * FNXC:CodeOrganization 2026-08-03-13:25:
 * resetLostWorkStepProgress peeled from TaskExecutor (U4).
 *
 * FNXC:StuckRequeue 2026-06-27-23:55:
 * After worktree removal loses uncommitted work, reset done/in-progress steps to pending and re-anchor currentStep.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";

export type ResetLostWorkStepProgressDeps = {
  store: TaskStore;
};

export async function resetLostWorkStepProgress(
  deps: ResetLostWorkStepProgressDeps,
  task: Task,
  completedStepCount: number,
  reason: string,
): Promise<void> {
  executorLog.warn(
    `${task.id} ${reason} — resetting ${completedStepCount} step(s) to pending`,
  );

  for (let i = 0; i < task.steps.length; i++) {
    if (task.steps[i].status === "done" || task.steps[i].status === "in-progress") {
      await deps.store.updateStep(task.id, i, "pending");
    }
  }

  const refreshedTask = await deps.store.getTask(task.id);
  const prevCurrentStep = refreshedTask.currentStep;
  if (refreshedTask.steps.length > 0) {
    const firstPendingStep = refreshedTask.steps.findIndex((s) => s.status === "pending");
    const newCurrentStep = firstPendingStep >= 0 ? firstPendingStep : 0;
    if (newCurrentStep !== prevCurrentStep) {
      await deps.store.updateTask(task.id, { currentStep: newCurrentStep });
      executorLog.log(
        `${task.id}: reset currentStep to ${newCurrentStep} after lost-work reset (was ${prevCurrentStep})`,
      );
      await deps.store.logEntry(
        task.id,
        `Reset currentStep to ${newCurrentStep} after lost-work step reset (was ${prevCurrentStep})`,
      );
    }
  }

  await deps.store.logEntry(
    task.id,
    `Reset ${completedStepCount} step(s) to pending — ${reason} (uncommitted work lost with worktree)`,
  );
}
