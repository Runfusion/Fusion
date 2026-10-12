/**
 * FNXC:CodeOrganization 2026-08-03-19:20:
 * blockOuterDispatchWhenDependenciesUnmet peeled from TaskExecutor (U4).
 *
 * FNXC:DependencyGating 2026-06-20-07:30:
 * Workflow-graph and workflow-authoritative executor dispatches can be invoked outside the classic scheduler loop, so they must re-apply the shared scheduling dependency gate before graph routing, column-agent seams, or review handoff can run.
 * Requeue with blockedBy instead of executing so missing or soft-deleted dependency residue keeps the scheduler helper's non-blocking semantics while live todo/queued/in-progress/triage dependencies block every dispatch surface.
 */
import type { Task, TaskStore } from "@fusion/core";
import { getUnmetSchedulingDependencies, resolveDependencySatisfactionColumns } from "../scheduler.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { clearDispatchBlockedLogState, logDispatchBlockedOnce } from "./dispatch-block-log.js";

export type DependencyDispatchGateDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function blockOuterDispatchWhenDependenciesUnmet(
  deps: DependencyDispatchGateDeps,
  task: Task,
): Promise<boolean> {
  if (!task.dependencies || task.dependencies.length === 0) {
    clearDispatchBlockedLogState(task.id);
    return false;
  }

  const settings = await deps.store.getSettings();
  /*
  FNXC:ListTasksExcludeLog 2026-10-12-15:35 (RUFU-615 tranche 3):
  `slim: true` does NOT drop the `log` column while deriving (see `ListTasksOptions.excludeLog`), so this
  dispatch-gate read was hydrating every card's full log array — up to ~1000 entries / 3.9 MB per card — on
  every dependency check, for a gate that reads dependencies, column and status only. A live 180 s sampling
  heap profile on production attributed 925 MiB of still-live allocations to `listTasksImpl -> rowToTask`
  (62% of the window's live bytes), which is the same path RUFU-627 measured at +33 MiB/min of forced-GC
  floor. Only callers that scan log MARKERS may hydrate log; this one passes `excludeLog` explicitly.
  */
  const tasks = await deps.store.listTasks({ includeArchived: false, slim: true, excludeLog: true });
  const liveTask = tasks.find((candidate) => candidate.id === task.id) ?? task;
  const dependencyIds = new Set(liveTask.dependencies);
  /*
  FNXC:DependencyGating 2026-10-04-03:04:
  Resume admission resolves custom review lanes before it dispatches a dependent. The outer
  execution gate must use that same dependency vocabulary; otherwise it immediately re-queues a
  just-released dependent because a valid review lane is not literally named `in-review`.
  */
  const satisfactionColumnsByTaskId = await resolveDependencySatisfactionColumns(
    deps.store,
    tasks.filter((candidate) => dependencyIds.has(candidate.id)),
  );
  const markerAcceptedByTaskId = new Map<string, boolean>();
  if (settings.mergeRequestContractShadowEnabled === true) {
    for (const depId of liveTask.dependencies) {
      markerAcceptedByTaskId.set(depId, (await deps.store.getCompletionHandoffAcceptedMarker(depId)) !== null);
    }
  }
  const unmetDeps = getUnmetSchedulingDependencies(liveTask, tasks, {
    satisfactionColumnsByTaskId,
    ...(settings.mergeRequestContractShadowEnabled === true ? { markerAcceptedByTaskId } : {}),
  });
  if (unmetDeps.length === 0) {
    clearDispatchBlockedLogState(liveTask.id);
    return false;
  }

  // Dependency admission is an in-place hold. It may suppress dispatch but cannot move lifecycle state backward.
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
  logDispatchBlockedOnce(
    executorLog,
    liveTask.id,
    `dependencies:${normalizedUnmetDeps.join(",")}`,
    `${liveTask.id}: executor dispatch blocked by unmet dependencies: ${unmetDeps.join(", ")}`,
  );
  return true;
}
