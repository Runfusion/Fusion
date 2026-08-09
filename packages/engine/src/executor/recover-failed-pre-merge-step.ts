/**
 * FNXC:CodeOrganization 2026-08-03-09:20:
 * recoverFailedPreMergeWorkflowStep peeled from TaskExecutor (U4).
 *
 * Auto-revive an `in-review` task whose pre-merge workflow step(s) failed, by replaying
 * the same send-back-for-fix flow the executor uses during a live run. Invoked by
 * SelfHealingManager's `recoverReviewTasksWithFailedPreMergeSteps` scan when a task is
 * parked in review with a failed pre-merge step and no active session. Picks the latest
 * failed pre-merge workflow step result, injects feedback into PROMPT.md, resets steps,
 * and schedules todo → in-progress. Independently enforces the effective finite-or-unlimited
 * revision budget before it can reopen work.
 *
 * FNXC:WorkflowPostMerge 2026-06-26-14:00:
 * U7c: gate-ness is now sourced from the recorded `WorkflowStepResult.status`, NOT a
 * `workflow_steps` table read. The graph executor (workflow-graph-executor.ts) maps a
 * group outcome to status by gate semantics: a GATE REVISE / hard failure records
 * `status: "failed"` (blocking), while an ADVISORY REVISE records `status:
 * "advisory_failure"` (non-blocking). So a pre-merge result with `status === "failed"`
 * IS by construction a blocking gate failure — the prior `getWorkflowStep(id).gateMode`
 * lookup was redundant (and after the table drop it returned undefined for graph node
 * ids anyway). Recovery revives the task from the latest blocking pre-merge failure.
 *
 * FNXC:WorkflowRevisionBudget 2026-07-22-18:30:
 * Failed-step recovery is also a remediation entry point, not merely a
 * retry-label formatter. Enforce the same finite Code Review budget here
 * as live and restart-local graph remediation: an unset policy remains
 * unlimited, while zero or an exhausted explicit cap cannot silently send
 * work back for another fix. Progress-loop termination stays owned by the
 * graph executor's signature guard rather than this budget check.
 */
import type { Task, TaskStore, WorkflowStepResult as CoreWorkflowStepResult } from "@fusion/core";
import { hasSharedBranchMemberAutoMergeHold } from "@fusion/core";
import { executorLog } from "../logger.js";

export type RecoverFailedPreMergeStepDeps = {
  store: TaskStore;
  resolveFailedPreMergeWorkflowStepBudget: (
    task: Task,
    target: CoreWorkflowStepResult,
  ) => Promise<{ unbounded: boolean; max: number; label: string; key: string; stepName?: string; attempts: number }>;
  sendTaskBackForFix: (
    task: Task,
    worktreePath: string,
    failureFeedback: string,
    stepName: string,
    reason: string,
    preserveResumeState?: boolean,
    mergeVerificationFailure?: boolean,
    retryPresentation?: { attempt: number; max?: number },
  ) => Promise<void>;
};

export async function recoverFailedPreMergeWorkflowStep(
  deps: RecoverFailedPreMergeStepDeps,
  task: Task,
): Promise<boolean> {
  try {
    /*
     * FNXC:SharedBranchMemberHold 2026-08-08-01:58:
     * Startup/self-healing recovery is another pre-merge remediation requester.
     * Project Off holds non-opted-in members; only an operator release may advance.
     */
    if (hasSharedBranchMemberAutoMergeHold(task, await deps.store.getSettings())) return false;
    const failed = (task.workflowStepResults ?? [])
      .filter((r) => (r.phase || "pre-merge") === "pre-merge" && r.status === "failed")
      .sort((a, b) => {
        const aTs = Date.parse(a.completedAt || a.startedAt || "");
        const bTs = Date.parse(b.completedAt || b.startedAt || "");
        return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
      });

    const target = failed[0];
    if (!target) {
      executorLog.warn(`${task.id}: no failed pre-merge workflow step to recover from`);
      return false;
    }

    const feedback = target.output?.trim() || "(no feedback captured)";
    const stepName = target.workflowStepName || target.workflowStepId || "Unknown";
    const budget = await deps.resolveFailedPreMergeWorkflowStepBudget(task, target);
    if (!budget.unbounded && (!Number.isFinite(budget.max) || budget.max <= 0)) return false;
    if (!budget.unbounded && budget.attempts >= budget.max) return false;

    await deps.sendTaskBackForFix(
      task,
      task.worktree ?? "",
      feedback,
      stepName,
      `Auto-revived from in-review: pre-merge workflow step "${stepName}" had failed`,
      true,
      false,
      { attempt: budget.attempts + 1, max: budget.unbounded ? undefined : budget.max },
    );
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.error(`Failed to recover failed pre-merge workflow step for ${task.id}: ${errorMessage}`);
    return false;
  }
}
