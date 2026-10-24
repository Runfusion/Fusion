/**
 * FNXC:CodeOrganization 2026-08-03-09:50:
 * resumeTaskForAgent peeled from TaskExecutor (U4).
 * After heartbeat completion, re-dispatch WIP tasks assigned to (or effectively bound to) the agent.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import { isTaskWorkComplete } from "./task-predicates.js";

export type ResumeTaskForAgentDeps = {
  store: TaskStore;
  executing: Set<string>;
  recoveringCompleted: Set<string>;
  processWideGraphRouting: Set<string>;
  activeSessions: { has(taskId: string): boolean };
  activeStepExecutors: { has(taskId: string): boolean };
  activeWorkflowStepSessions: { has(taskId: string): boolean };
  listWipLaneTasks: () => Promise<Task[]>;
  taskEffectiveAgentMatches: (task: Task, agentId: string) => Promise<boolean>;
  recoverCompletedTask: (task: Task) => Promise<boolean>;
  execute: (task: Task) => Promise<void>;
};

export async function resumeTaskForAgent(
  deps: ResumeTaskForAgentDeps,
  agentId: string,
): Promise<void> {
  const settings = await deps.store.getSettings();
  if (settings.globalPause || settings.enginePaused) return;
  const tasks = await deps.listWipLaneTasks();
  const dispatched = new Set<string>();
  const isDispatchable = (task: Task): boolean =>
    !task.deletedAt
    && !task.paused
    && !deps.executing.has(task.id)
    && !deps.activeSessions.has(task.id)
    && !deps.activeStepExecutors.has(task.id)
    && !deps.activeWorkflowStepSessions.has(task.id);
  const dispatch = (task: Task, reason: string): void => {
    if (dispatched.has(task.id)) return;
    dispatched.add(task.id);
    /*
    FNXC:CompletedTaskDispatch 2026-10-03:
    Both passes admit through THIS function, so the completed-work fast-path
    lives here once. A heartbeat completion must not re-run finished work: the
    same predicate + repair the startup (resume-orphaned) and unpause sweeps
    already use. The claim is held only for the call and released in every
    outcome — holding it wedges the completed-task watchdog and the next sweep.
    */
    if (isTaskWorkComplete(task) && !task.mergeDetails) {
      if (deps.recoveringCompleted.has(task.id)) return;
      if (deps.processWideGraphRouting.has(task.id)) return;
      deps.recoveringCompleted.add(task.id);
      executorLog.log(`${task.id}: completed work after heartbeat completion for agent ${agentId} (${reason}) — recovering instead of re-executing`);
      void deps.recoverCompletedTask(task)
        .catch((err) => executorLog.error(`Failed to recover completed ${task.id} after heartbeat completion:`, err))
        .finally(() => deps.recoveringCompleted.delete(task.id));
      return;
    }
    executorLog.log(`${task.id}: re-dispatching execute() after heartbeat completion for agent ${agentId} (${reason})`);
    deps.execute(task).catch((err) =>
      executorLog.error(`Failed to resume ${task.id} after heartbeat completion:`, err),
    );
  };

  // Pass 1: directly-assigned tasks (legacy behavior, byte-identical).
  for (const task of tasks) {
    if (task.assignedAgentId === agentId && isDispatchable(task)) {
      dispatch(task, "assigned");
    }
  }

  // Pass 2: tasks whose EFFECTIVE column agent resolves to `agentId`. The graph
  // engine is the default runtime; the IR resolve is best-effort and skipped
  // for tasks already dispatched/executing.
  for (const task of tasks) {
    if (dispatched.has(task.id) || !isDispatchable(task)) continue;
    // Skip tasks the assigned-agent filter already covers — a redundant column
    // binding to the same agent would only re-confirm pass 1.
    if (task.assignedAgentId === agentId) continue;
    let matches = false;
    try {
      matches = await deps.taskEffectiveAgentMatches(task, agentId);
    } catch {
      matches = false;
    }
    if (matches) dispatch(task, "effective-column-agent");
  }
}
