/**
 * FNXC:CodeOrganization 2026-08-03-19:30:
 * finalizeMergeConfirmedWorkflowGraphTask peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowMerge 2026-06-29-08:32:
 * A workflow graph merge node can await a successful ProjectEngine merge request and return before the row reaches `done`. Merge confirmation is durable proof of landing; the executor must finalize that row from any non-terminal column instead of re-running parse or clearing mergeDetails.
 *
 * FNXC:WorkflowMerge 2026-06-29-23:12:
 * FN-7261 exposed stale no-op proof as a re-execution blocker: a reopened task with incomplete implementation steps and only no-op merge proof must fall through to merge-state cleanup/reverification, not consume execute() by repeatedly trying blocked finalization.
 */
import type { MergeResult, TaskStore } from "@fusion/core";
import { hasNonTerminalSteps } from "@fusion/core";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";
import { executorLog } from "../logger.js";
import { createRunAuditor, generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";
import { resolveCompleteColumnFor } from "./lifecycle-columns.js";

export type MergeConfirmedFinalizeDeps = {
  rootDir: string;
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function finalizeMergeConfirmedWorkflowGraphTask(
  deps: MergeConfirmedFinalizeDeps,
  taskId: string,
  reason: string,
): Promise<boolean> {
  const live = await deps.store.getTask(taskId).catch(() => null);
  if (!live || live.mergeDetails?.mergeConfirmed !== true || live.column === await resolveCompleteColumnFor(deps.store, live.id)) return false;

  await deps.store.logEntry(
    taskId,
    `Workflow graph observed confirmed merge while task was '${live.column}' — finalizing to done (${reason})`,
    undefined,
    deps.getRunContextFor(taskId),
  );
  const finalization = await finalizeProvenAutoMergeTask({
    store: deps.store,
    taskId,
    result: {
      task: live,
      ok: true,
      merged: true,
      commitSha: live.mergeDetails?.commitSha,
      noOp: live.mergeDetails?.noOpMerge === true,
      reason: live.mergeDetails?.noOpReason,
      mergeConfirmed: true,
    } as MergeResult,
    rootDir: deps.rootDir,
    audit: createRunAuditor(deps.store, {
      runId: generateSyntheticRunId("workflow-graph-merge-finalize", taskId),
      agentId: "executor",
      taskId,
      taskLineageId: live.lineageId,
      phase: "workflow-graph-merge-finalize",
    }),
    auditAgentId: "executor",
    auditPhase: "workflow-graph-merge-finalize",
    source: "workflow-graph-merge-finalize",
    log: (message) => executorLog.warn(message),
  });
  if (finalization.outcome === "blocked") {
    executorLog.warn(`${taskId}: workflow graph merge-confirmed finalization blocked — ${finalization.reason ?? "unknown"}`);
    await deps.store.logEntry(
      taskId,
      `Workflow graph merge-confirmed finalization blocked — ${finalization.reason ?? "unknown"}`,
      undefined,
      deps.getRunContextFor(taskId),
    );
    /*
    FNXC:MergeBlockerReasons 2026-08-26-11:40:
    Ask the CONDITION, not the sentence.

    This carve-out exists because a no-op merge confirmation with no landed commit is not proof that
    the work was done: when the steps are still unfinished the run must fall through to stale-merge
    cleanup and reverification instead of being consumed here. It selected that case by comparing the
    blocker reason with `===` against the exact string "task has incomplete steps".

    The merge-authority work then made refusals more informative, so a card in an error state now
    reports `task is marked 'failed': … task has incomplete steps`. Same meaning, different sentence —
    and this stopped matching, silently, so the fall-through never happened again. A blocker message is
    written for an operator and will be reworded again; `hasNonTerminalSteps` is the rule underneath it
    and cannot drift from `getTaskMergeBlocker`, which is defined from the same set.
    */
    if (hasNonTerminalSteps(live) && live.mergeDetails?.noOpMerge === true && !live.mergeDetails?.commitSha) {
      return false;
    }
    return true;
  }
  executorLog.log(`${taskId}: workflow graph merge-confirmed task finalized (${finalization.outcome})`);
  return true;
}
