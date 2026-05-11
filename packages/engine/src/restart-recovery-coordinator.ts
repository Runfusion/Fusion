import type { Task, TaskStore } from "@fusion/core";
import type { TaskExecutor } from "./executor.js";
import { createLogger } from "./logger.js";

const log = createLogger("restart-recovery");

export function hasStepProgress(task: Task): boolean {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  return steps.some((step) => step.status === "done" || step.status === "in-progress" || step.status === "skipped");
}

function isNoTaskDoneFailure(task: Task): boolean {
  return task.status === "failed"
    && typeof task.error === "string"
    && task.error.toLowerCase().includes("without calling fn_task_done");
}

export function isMissingWorktreeSessionStartFailure(error: unknown): boolean {
  if (typeof error !== "string") {
    return false;
  }
  return error.includes("Refusing to start coding agent in missing worktree:");
}

export function isRecoverableMissingWorktreeReviewFailure(task: Task): boolean {
  return task.column === "in-review"
    && !task.paused
    && task.status === "failed"
    && isMissingWorktreeSessionStartFailure(task.error)
    && hasStepProgress(task);
}

export class RestartRecoveryCoordinator {
  constructor(
    private readonly store: TaskStore,
    private readonly executor: TaskExecutor,
  ) {}

  async recoverInterruptedRuns(): Promise<void> {
    const allInProgress = await this.store.listTasks({ slim: true, column: "in-progress" });
    const candidates = allInProgress.filter((task) => task.column === "in-progress" && !task.paused);

    if (candidates.length === 0) return;

    let requeued = 0;
    for (const task of candidates) {
      if (!this.mustSafeRetry(task)) continue;
      await this.safeRequeue(task);
      requeued++;
    }

    if (requeued > 0) {
      log.log(`Restart recovery requeued ${requeued} interrupted task(s) for safe retry`);
    }

    await this.executor.resumeOrphaned();
  }

  private mustSafeRetry(task: Task): boolean {
    return isNoTaskDoneFailure(task) && !hasStepProgress(task);
  }

  private async safeRequeue(task: Task): Promise<void> {
    await this.store.updateTask(task.id, {
      status: "stuck-killed",
      worktree: null,
      branch: null,
      sessionFile: null,
      error: null,
    });
    await this.store.logEntry(
      task.id,
      "Restart recovery: interrupted run had no step progress and no fn_task_done — requeued to todo for safe retry",
    );
    await this.store.moveTask(task.id, "todo");
  }
}
