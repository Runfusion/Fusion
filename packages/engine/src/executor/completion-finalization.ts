/**
 * FNXC:CodeOrganization 2026-08-03-17:25:
 * parkCompletedBlockedTask + completion finalization decision peeled from TaskExecutor (U4).
 * FN-7926 completed-blocked park + FN-8141 finalize decision path.
 */
import type { Task, TaskStore } from "@fusion/core";
import { evaluateSkipBypassTaint } from "@fusion/core";
import { COMPLETED_BLOCKED_PAUSE_REASON } from "../self-healing.js";
import { executorLog } from "../logger.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";
import { isTaskWorkComplete } from "./task-predicates.js";
import {
  resolveReboundColumnFor,
  resolveTerminalColumnsFor,
} from "./lifecycle-columns.js";

export type CompletionFinalizationDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  getTaskCompletionBlocker: (task: Task) => Promise<string | undefined>;
};

export async function parkCompletedBlockedTask(
  deps: CompletionFinalizationDeps,
  task: Task,
  completionBlocker: string,
  source: string,
  workComplete = isTaskWorkComplete(task),
): Promise<boolean> {
  if (task.paused === true || task.userPaused === true) return false;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-29-13:10:
  Was a raw Done literal. On a renamed
  board neither matched, so this "already finished, nothing to park" guard was INERT
  and a completed card resting in the workflow's own terminal column fell through —
  and the `column !== "todo"` branch below would then have MOVED it back out of that
  terminal column. Resolved through core's shared `resolveTerminalColumns`, which owns
  the Complete-role fallback.
  */
  const terminalColumns = await resolveTerminalColumnsFor(deps.store, task.id);
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (PR #2568 review — greptile):
  RE-READ AFTER THE AWAIT. The pause and column guards above ran against the `task`
  snapshot the caller passed, and this conversion introduced the first `await`
  between those guards and the writes below. Another dispatch or an operator action
  can move or pause the card while the IR resolution is in flight, and the stale
  snapshot would then let this method move a now-terminal task out of its terminal
  column, or overwrite a pause an operator just applied.

  Re-reading is cheap next to the resolution that precedes it, and it is the pause
  check that matters most: a user pause landing during the await is precisely the
  case where proceeding is least forgivable. Falling back to the passed snapshot on
  a read failure keeps this no worse than before the await existed.
  */
  const liveTask = await deps.store.getTask(task.id).catch(() => undefined) ?? task;
  if (liveTask.paused === true || liveTask.userPaused === true) return false;
  if (terminalColumns.includes(liveTask.column)) return false;
  if (!workComplete) return false;

  const message = `Completed work held — ${completionBlocker}; will advance to review when blocker clears`;
  /*
  FNXC:WorkflowLifecycle 2026-07-12-23:13:
  FN-7926: completed work with a persistent `getTaskCompletionBlocker` result must not self-requeue through the execute node. Re-running implementation cannot clear dependency/blockedBy state, so it only feeds FN-7863's generic no-progress backstop and misclassifies good work as `EXECUTION_DISPATCH_LOOP_EXHAUSTED`. Park in a scheduler-skipped todo state, preserve worktree/branch/steps, and reset the FN-7863 signature so the backstop remains reserved for genuinely incomplete no-progress loops.
  */
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (rebase merge, both sides kept):
  main (#2644) resolved the literal `todo` into `reboundColumn`; this branch added the
  post-await `liveTask` re-read. Taking either side alone loses the other — the
  literal comes back, or the stale snapshot does.
  */
  const reboundColumn = await resolveReboundColumnFor(deps.store, task.id);
  if (liveTask.column !== reboundColumn) {
    await deps.store.moveTask(task.id, reboundColumn, {
      preserveProgress: true,
      preserveResumeState: true,
      preserveWorktree: true,
      moveSource: "engine",
      lifecycleReason: "self-healing-stranded-recovery",
      recoveryRehome: true,
    });
  }
  await deps.store.updateTask(task.id, {
    paused: true,
    pausedReason: COMPLETED_BLOCKED_PAUSE_REASON,
    status: "queued",
    error: null,
    executeRequeueLoopCount: null,
    executeRequeueLoopSignature: null,
  }, deps.getRunContextFor(task.id));
  executorLog.log(`${task.id}: ${message}`);
  await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
  await emitBoundedRunAudit(deps.store, {
    taskId: task.id,
    agentId: "executor",
    runId: generateSyntheticRunId("completed-blocked-park", task.id),
    domain: "database",
    mutationType: "task:completed-blocked-parked",
    target: task.id,
    metadata: {
      taskId: task.id,
      blocker: completionBlocker,
      source,
      priorColumn: task.column,
      priorStatus: task.status ?? null,
    },
  });
  return true;
}

export async function getCompletedTaskFinalizationDecision(
  deps: CompletionFinalizationDeps,
  taskId: string,
  taskDone: boolean,
): Promise<"finalize" | "blocked" | "incomplete"> {
  const task = await deps.store.getTask(taskId);
  const completionBlocker = await deps.getTaskCompletionBlocker(task);
  /*
  FNXC:Lifecycle 2026-07-16-21:40:
  FN-8141 — `taskDone` means an ACCEPTED fn_task_done (explicit or a non-tainted
  implicit completion), which is the honest exit and always finalizes. Only the
  step-status-derived `isTaskWorkComplete` path can be laundered by skip-bypass, so
  the taint guard gates that path alone; a genuine no-op/PREMISE-STALE accepted done
  is never blocked.
  */
  const workComplete = taskDone
    || (isTaskWorkComplete(task) && !evaluateSkipBypassTaint(task).blocked);
  if (completionBlocker) {
    executorLog.log(`${taskId} completion blocked — ${completionBlocker}`);
    if (workComplete && await parkCompletedBlockedTask(deps, task, completionBlocker, "finalization", workComplete)) {
      return "blocked";
    }
    return "incomplete";
  }
  if (workComplete) return "finalize";
  return "incomplete";
}

export async function shouldFinalizeCompletedTask(
  deps: CompletionFinalizationDeps,
  taskId: string,
  taskDone: boolean,
): Promise<boolean> {
  return await getCompletedTaskFinalizationDecision(deps, taskId, taskDone) === "finalize";
}
