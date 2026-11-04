import {
  columnsWithFlag,
  isRecoverableOverlapWaitFailure,
  allowsAutoMergeProcessing,
  resolveEffectiveAutoMerge,
  resolveTaskLifecycleColumns,
  resolveWorkflowIrForTask,
  type LifecycleColumns,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowSelectionCache,
} from "@fusion/core";
import { createLogger } from "../logger.js";

const log = createLogger("self-healing");

/*
FNXC:OverlapWaitRelease 2026-11-04-02:15 (RUFU-373):
Which lanes this sweep may resume a wait from, derived from COLUMN TRAITS rather than from any id.

A bounded acquisition park lands in the workflow's rebound/Hold dwell lane, not in WIP. The old gate
(`current.column === lanes?.wip`) therefore refused the resume exactly where the park lives, and it did so
while the resumed predecessor had ALREADY landed — the "stays failed forever" half of SANE-436 / ROZV-197.

The dwell lane's column id is `todo` on every builtin coding board (its NAME is "Planning", which is why an
id read is not a lane read) and an arbitrary string on a custom board, so membership is computed from the
workflow IR's traits: the WIP lane plus every Hold and intake column. `Hold` is deliberately NOT unique —
`resolveLifecycleColumns` resolves it FIRST-MATCH, so `lanes.hold` names one column on a board that may
declare several, and a single-id comparison would silently under-cover. `columnsWithFlag` is the only
read that returns the whole class.

Review and complete lanes gain no authority here: a wait is released where it waits, and a move out of a
review lane is a different authority (see the lifecycle-containment rule in AGENTS.md). An unresolvable
workflow vocabulary resumes nothing — it fails closed rather than guessing a lane.
*/
export function overlapWaitResumeLaneIds(
  lanes: LifecycleColumns | undefined,
  ir: WorkflowIr | undefined,
): Set<string> {
  const accepted = new Set<string>();
  if (lanes?.wip) accepted.add(lanes.wip);
  // Non-unique flags are enumerated, never first-matched: Hold and intake can each name several columns.
  for (const flag of ["hold", "intake"] as const) {
    for (const columnId of ir ? columnsWithFlag(ir, flag) : []) accepted.add(columnId);
  }
  return accepted;
}

/*
FNXC:OverlapWaitRelease 2026-09-17-06:29:
Run on startup and maintenance, including failed WIP whose visible blocker was already cleared.
Only idle missing-delivery or superseded-owner failures resume; completed steps and the current lane remain intact.
Repairing an indicator is metadata cleanup, not authorization to resume a paused or human-owned card.
*/
export async function reconcileReleasedOverlapWaits(
  store: TaskStore,
  isTaskLive: (task: Task) => boolean,
  onReleased?: (releases: readonly { taskId: string; blockerId: string }[]) => void | Promise<void>,
): Promise<number> {
  if (typeof store.reconcileTaskOverlapWaits !== "function") return 0;
  const settings = await store.getSettings();
  if (settings.globalPause || settings.enginePaused) return 0;
  let count = 0;
  /*
   * FNXC:OverlapWaitRelease 2026-11-04-02:15 (RUFU-373): the lane set needs the task's workflow IR, and this
   * loop runs over the whole board on startup and on every maintenance batch. The caches are per-sweep, so a
   * revision published mid-sweep is re-read by the next one rather than pinned process-wide.
   */
  const irCache = new Map<string, WorkflowIr>();
  const selectionCache: WorkflowSelectionCache = new Map();
  // FNXC:ListTasksExcludeLog 2026-10-12-16:20 (RUFU-615 tranche 4): this scan never reads task log or markers (no non-logger `.log` token in the file), so `slim` must not pay for hydrating the whole board's log. See list-tasks-slim-excludes-log.test.ts.
  for (const task of await store.listTasks({ includeArchived: false, slim: true, excludeLog: true })) {
    if (task.deletedAt || (!task.overlapBlockedBy && !task.blockedBy && !isRecoverableOverlapWaitFailure(task.error))) continue;
    try {
      const lanes = await resolveTaskLifecycleColumns(store, task.id, irCache);
      const ir = await resolveWorkflowIrForTask(store, task.id, irCache, selectionCache).catch(() => undefined);
      const resumeLaneIds = overlapWaitResumeLaneIds(lanes, ir);
      const result = await store.reconcileTaskOverlapWaits(task.id, {
        resumeIf: (current) => resumeLaneIds.has(current.column) && !isTaskLive(current)
          && !current.checkedOutBy && !current.paused && !current.userPaused
          && resolveEffectiveAutoMerge(current, settings) !== false && allowsAutoMergeProcessing(current, settings),
      });
      if (result.cancelledCount || result.resumed || result.clearedBlockerIds.length) count++;
      if (result.clearedBlockerIds.length) await onReleased?.(result.clearedBlockerIds.map((blockerId) => ({ taskId: task.id, blockerId })));
    } catch (error) {
      log.warn(`Overlap recovery deferred for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return count;
}
