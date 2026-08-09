/**
 * FNXC:CodeOrganization 2026-08-03-19:20:
 * blockOuterDispatchWhenDependenciesUnmet peeled from TaskExecutor (U4).
 *
 * FNXC:DependencyGating 2026-06-20-07:30:
 * Workflow-graph and workflow-authoritative executor dispatches can be invoked outside the classic scheduler loop, so they must re-apply the shared scheduling dependency gate before graph routing, column-agent seams, or review handoff can run.
 * Requeue with blockedBy instead of executing so missing or soft-deleted dependency residue keeps the scheduler helper's non-blocking semantics while live todo/queued/in-progress/triage dependencies block every dispatch surface.
 */
import type { Task, TaskStore } from "@fusion/core";
import { getUnmetSchedulingDependencies } from "../scheduler.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { resolveReboundColumnFor } from "./lifecycle-columns.js";

export type DependencyDispatchGateDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function blockOuterDispatchWhenDependenciesUnmet(
  deps: DependencyDispatchGateDeps,
  task: Task,
): Promise<boolean> {
  if (!task.dependencies || task.dependencies.length === 0) return false;

  const settings = await deps.store.getSettings();
  const tasks = await deps.store.listTasks({ includeArchived: false, slim: true });
  const liveTask = tasks.find((candidate) => candidate.id === task.id) ?? task;
  const markerAcceptedByTaskId = new Map<string, boolean>();
  if (settings.mergeRequestContractShadowEnabled === true) {
    for (const depId of liveTask.dependencies) {
      markerAcceptedByTaskId.set(depId, (await deps.store.getCompletionHandoffAcceptedMarker(depId)) !== null);
    }
  }
  const unmetDeps = getUnmetSchedulingDependencies(
    liveTask,
    tasks,
    settings.mergeRequestContractShadowEnabled === true ? { markerAcceptedByTaskId } : undefined,
  );
  if (unmetDeps.length === 0) return false;

  const reboundColumn = await resolveReboundColumnFor(deps.store, liveTask.id);
  if (liveTask.column !== reboundColumn) {
    await deps.store.moveTask(liveTask.id, reboundColumn, {
      preserveProgress: true,
      preserveWorktree: true,
      preserveResumeState: true,
      moveSource: "engine",
      recoveryRehome: true,
    });
  }
  /*
  FNXC:DependencyGating 2026-08-07-12:10:
  Prefer the store's transitionQueuedEpisode so queued signature/blockedBy/audit are one atomic
  write (FN-8806 / main). Falls back to updateTask+logEntry only when the store lacks the helper.
  */
  const normalizedUnmetDeps = [...new Set(unmetDeps)].sort();
  if (typeof deps.store.transitionQueuedEpisode === "function") {
    await deps.store.transitionQueuedEpisode(liveTask.id, {
      signature: `dependency:${normalizedUnmetDeps.join(",")}`,
      blockedBy: unmetDeps[0] ?? null,
      overlapBlockedBy: liveTask.overlapBlockedBy ?? null,
      action: `queued — unmet dependencies: ${unmetDeps.join(", ")}`,
      outcome: "Executor pre-dispatch dependency gate blocked workflow/authoritative execution.",
      runContext: deps.getRunContextFor(liveTask.id),
    });
  } else {
    await deps.store.updateTask(liveTask.id, { status: "queued", blockedBy: unmetDeps[0] }, deps.getRunContextFor(liveTask.id));
    await deps.store.logEntry(
      liveTask.id,
      `queued — unmet dependencies: ${unmetDeps.join(", ")}`,
      "Executor pre-dispatch dependency gate blocked workflow/authoritative execution.",
      deps.getRunContextFor(liveTask.id),
    );
  }
  executorLog.log(`${liveTask.id}: executor dispatch blocked by unmet dependencies: ${unmetDeps.join(", ")}`);
  return true;
}
