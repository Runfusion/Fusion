/**
 * FNXC:CodeOrganization 2026-08-03-10:35:
 * resumeOrphaned peeled from TaskExecutor (U4).
 * Startup recovery for orphaned WIP tasks after crash/restart.
 *
 * FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (a MISSED PAIR, the class #2879 ratcheted):
 * `listWipLaneTasks()` already resolves the wip lane by role. This filter must not re-assert
 * the literal `in-progress` on the rows that read returned, or on a renamed board the read
 * finds orphans and the filter drops every one — recovery silently does nothing after restart.
 */
import type { Task, TaskStore } from "@fusion/core";
import { resolveProjectColumnsForRoles } from "@fusion/core";
import { setImmediate as setImmediateCb } from "node:timers";
import { executorLog } from "../logger.js";
import { getResumeOrphanDelayMs } from "./resume-orphan-delay.js";
import { isNoProgressNoTaskDoneFailure, isTaskWorkComplete } from "./task-predicates.js";

const yieldEventLoop = (): Promise<void> => new Promise((resolve) => setImmediateCb(resolve));

export type ResumeOrphanedDeps = {
  store: TaskStore;
  executing: Set<string>;
  recoveringCompleted: Set<string>;
  processWideGraphRouting: Set<string>;
  listWipLaneTasks: () => Promise<Task[]>;
  clearResumeFailureState: (task: Task) => Promise<void>;
  recoverApprovedStepsOnResume: (taskId: string) => Promise<void>;
  recoverCompletedTask: (task: Task) => Promise<boolean>;
  execute: (task: Task) => Promise<void>;
};

export async function resumeOrphaned(deps: ResumeOrphanedDeps): Promise<void> {
  const settings = await deps.store.getSettings();
  if (settings.globalPause || settings.enginePaused) {
    executorLog.log(
      `resumeOrphaned skipped — ${
        settings.globalPause ? "global pause" : "engine pause"
      } is active`,
    );
    return;
  }

  const wipColumns = await resolveProjectColumnsForRoles(deps.store, ["countsTowardWip"]);
  const tasks = await deps.listWipLaneTasks();
  const inProgress = tasks.filter(
    (t) => wipColumns.has(t.column) && !t.deletedAt && !deps.executing.has(t.id) && !t.paused,
  );

  if (inProgress.length === 0) return;

  executorLog.log(`Found ${inProgress.length} orphaned in-progress task(s)`);
  const resumeDelayMs = getResumeOrphanDelayMs();
  if (resumeDelayMs > 0) {
    executorLog.log(
      `Deferring orphan task resumption for ${resumeDelayMs}ms to keep dashboard responsive during cold start`,
    );
  }
  // When the delay is zero (default in tests and when explicitly disabled),
  // skip the setTimeout indirection so the spawn happens on the current
  // microtask — matching the legacy behavior callers may rely on.
  const scheduleResume = resumeDelayMs > 0
    ? (fn: () => void) => { setTimeout(fn, resumeDelayMs); }
    : (fn: () => void) => { fn(); };
  let yieldNext = false;
  for (const task of inProgress) {
    if (yieldNext) await yieldEventLoop();
    yieldNext = true;
    // Fast-path: if the task already completed its work (all steps done),
    // move it directly to in-review instead of re-executing from scratch.
    if (isTaskWorkComplete(task) && !task.mergeDetails) {
      if (deps.recoveringCompleted.has(task.id)) {
        executorLog.debug(`${task.id} completed-task recovery already running - skipping duplicate startup recovery`);
        continue;
      }
      if (deps.processWideGraphRouting.has(task.id)) {
        executorLog.debug(`${task.id} owned by the workflow graph interpreter — skipping completed-task fast-path`);
        continue;
      }
      executorLog.log(`${task.id} is already complete — fast-pathing to in-review`);
      deps.recoveringCompleted.add(task.id);
      scheduleResume(() => {
        void deps.recoverCompletedTask(task)
          .catch((err) =>
            executorLog.error(`Failed to recover completed orphan ${task.id}:`, err),
          )
          .finally(() => {
            deps.recoveringCompleted.delete(task.id);
          });
      });
      continue;
    }

    if (isNoProgressNoTaskDoneFailure(task)) {
      executorLog.log(`${task.id} failed without fn_task_done and has no step progress — leaving for self-healing requeue`);
      continue;
    }

    executorLog.log(`Resuming ${task.id}: ${task.title || task.description.slice(0, 60)}`);
    try {
      await deps.clearResumeFailureState(task);
      await deps.store.logEntry(task.id, "Resumed after engine restart");
      await deps.recoverApprovedStepsOnResume(task.id);
    } catch (err) {
      executorLog.error(`Failed to write resume log for ${task.id}:`, err);
    }
    scheduleResume(() => {
      deps.execute(task).catch((err) =>
        executorLog.error(`Failed to resume ${task.id}:`, err),
      );
    });
  }
}
