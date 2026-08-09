/**
 * FNXC:CodeOrganization 2026-08-03-13:50:
 * routeUnusableWorktreeGraphFailureToRecovery peeled from TaskExecutor (U4).
 *
 * FNXC:MissingWorktreeRecovery 2026-07-16-19:40:
 * FN-5147: auto-merge off keeps in-review terminal; unusable-worktree graph failures recover via requeue-todo.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40:
 * Review-lane auto-merge-off gate uses resolved resume lanes.
 */
import type { Task, TaskDetail, TaskStore } from "@fusion/core";
import { allowsAutoMergeProcessing } from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import { createRunAuditor, generateSyntheticRunId, type EngineRunContext, type RunAuditor } from "../util/run-audit.js";
import { resolveTerminalColumnsFor } from "./lifecycle-columns.js";
import { extractUnusableWorktreeGraphFailure } from "./graph-failure-pure.js";
import { extractMissingWorktreePathFromSessionStartFailure } from "../healing/restart-recovery-coordinator.js";
import type { ResumeLanes } from "./resolve-resume-lanes.js";

export type RouteUnusableWorktreeGraphFailureToRecoveryDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  pausedAborted: Set<string>;
  resolveResumeLanes: (taskId: string, memo?: { lanes?: ResumeLanes }) => Promise<ResumeLanes>;
  recoverMissingWorktreeSessionStartFailure: (
    live: TaskDetail,
    stalePath: string,
    error: Error,
    audit: RunAuditor,
  ) => Promise<"requeue-todo" | "escalate-exhausted" | false>;
};

export async function routeUnusableWorktreeGraphFailureToRecovery(
  deps: RouteUnusableWorktreeGraphFailureToRecoveryDeps,
  task: Task,
  live: TaskDetail,
  result: WorkflowGraphTaskRunResult,
  resumeLanesMemo?: { lanes?: ResumeLanes },
): Promise<boolean> {
    if (live.deletedAt) return false;
    if (live.paused || live.userPaused === true) return false;
    if ((await resolveTerminalColumnsFor(deps.store, live.id)).includes(live.column)) return false;
    // Pause/abort provenance owns aborted runs; a genuine abort never carries the
    // session-start refusal as its terminal node error in the same walk.
    if (deps.pausedAborted.has(task.id)) return false;
    const errorText = extractUnusableWorktreeGraphFailure(result);
    if (!errorText) return false;
    /*
    FNXC:MissingWorktreeRecovery 2026-07-16-19:40:
    FN-5147: with auto-merge off, `in-review` is terminal-until-human-merged — recovery must
    not move those tasks backward or re-enqueue them. Mirrors the gating the in-review
    self-healing sweep (recoverMissingWorktreeReviewFailures) applies before the same recovery.
    */
    /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): FN-5147 — with the literal, a renamed board
       skipped this auto-merge-off gate entirely, so an automatic recovery moved a human-review-terminal
       card backward. #2689 converted the terminal guard at the top of this method; this is the other half
       of the same decision. */
    if (live.column === (await deps.resolveResumeLanes(live.id, resumeLanesMemo)).review) {
      const settings = await deps.store.getSettings();
      if (!allowsAutoMergeProcessing(live, settings)) return false;
    }
    const stalePath = extractMissingWorktreePathFromSessionStartFailure(errorText) ?? live.worktree ?? "";
    const audit = createRunAuditor(deps.store, {
      runId: deps.getRunContextFor(task.id)?.runId ?? generateSyntheticRunId("graph-worktree-recovery", task.id),
      agentId: deps.getRunContextFor(task.id)?.agentId ?? (task.assignedAgentId ?? "executor"),
      taskId: task.id,
      phase: "execute",
    });
    const outcome = await deps.recoverMissingWorktreeSessionStartFailure(live, stalePath, new Error(errorText), audit);
    // escalate-exhausted intentionally returns false: the failure falls through to the
    // visible terminal park so a human inspects the task instead of it looping silently.
    return outcome === "requeue-todo";
}
