/**
 * FNXC:CodeOrganization 2026-08-03-12:15:
 * routeRetryableRemediationGraphFailureToPreMergeFix peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowRemediation 2026-07-03-20:10:
 * A failed `pre-merge-remediation` node is retryable when the durable blocking Code Review/optional-step result is still present and its revision budget remains. Route that parked graph failure through the same pre-merge fix handoff as live review REVISE handling.
 *
 * FNXC:AutoMergeHold 2026-07-09-17:04:
 * FN-7750 requires retryable pre-merge remediation to treat stale shared-group members as standalone manual-hold rows when global auto-merge is off; only live/open groups retain the shared-member exemption.
 */
import type { Task, TaskDetail, TaskStore, WorkflowStepResult } from "@fusion/core";
import { allowsAutoMergeProcessing } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import { resolveTerminalColumnsFor } from "./lifecycle-columns.js";
import { latestFailedPreMergeWorkflowStep } from "./graph-failure-pure.js";
import { optionalStepRevisionLogOutcome } from "./optional-step-revision.js";

export type RouteRetryableRemediationDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  isPreMergeRemediationGraphNode: (taskId: string, failedNode: string | undefined) => Promise<boolean>;
  isLiveSharedBranchGroupMember: (live: Pick<TaskDetail, "branchContext">) => Promise<boolean>;
  resolveFailedPreMergeWorkflowStepBudget: (
    task: Task,
    target: WorkflowStepResult,
  ) => Promise<{ unbounded: boolean; max: number; label: string; key: string; stepName?: string; attempts: number }>;
  recoverFailedPreMergeWorkflowStep: (task: Task) => Promise<boolean>;
  persistTokenUsage: (taskId: string) => Promise<void>;
};

export async function routeRetryableRemediationGraphFailureToPreMergeFix(
  deps: RouteRetryableRemediationDeps,
  live: TaskDetail,
  failedNode: string | undefined,
  failureValue: string | undefined,
): Promise<boolean> {
  if (!await deps.isPreMergeRemediationGraphNode(live.id, failedNode)) return false;
  if (live.deletedAt || live.paused || live.userPaused === true) return false;
  if ((await resolveTerminalColumnsFor(deps.store, live.id)).includes(live.column)) return false;
  if (!live.worktree) return false;
  const settings = await deps.store.getSettings().catch(() => undefined);
  if (!settings || settings.globalPause === true || settings.enginePaused === true) return false;
  if (!allowsAutoMergeProcessing(live, settings) && !(await deps.isLiveSharedBranchGroupMember(live))) return false;
  const target = latestFailedPreMergeWorkflowStep(live);
  if (!target) return false;
  const budget = await deps.resolveFailedPreMergeWorkflowStepBudget(live, target);
  if (!budget.unbounded && (!Number.isFinite(budget.max) || budget.max <= 0)) return false;
  if (!budget.unbounded && budget.attempts >= budget.max) return false;

  const nextCount = budget.attempts + 1;
  const totalFixCount = (live.postReviewFixCount ?? 0) + 1;
  await deps.store.updateTask(live.id, { postReviewFixCount: totalFixCount }, deps.getRunContextFor(live.id));
  await deps.store.logEntry(
    live.id,
    `Auto-recovered retryable remediation node '${failedNode ?? "unknown"}' for failed pre-merge workflow step (attempt ${nextCount}/${budget.label})`,
    optionalStepRevisionLogOutcome(`Step: ${budget.stepName ?? budget.key}${failureValue ? `\nGraph value: ${failureValue}` : ""}`, budget.key),
    deps.getRunContextFor(live.id),
  );
  const sentBack = await deps.recoverFailedPreMergeWorkflowStep(live);
  if (!sentBack) return false;
  await deps.persistTokenUsage(live.id);
  return true;
}
