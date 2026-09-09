/**
 * FNXC:CodeOrganization 2026-07-16-12:00:
 * Task lifecycle client API (promote/delete/merge/pause/plan) peeled from legacy.ts.
 */
import type {
  Task,
  MergeResult,
  BranchGroup,
  BranchGroupPrState,
  PlannerOverseerRuntimeSnapshot,
  PlannerInterventionEntry,
} from "@fusion/core";
import { api } from "../client/client.js";
import { withProjectId } from "../client/health.js";
import type { DeleteTaskOptions } from "./tasks.js";

/**
 * Manually promote a held card out of its hold column (U9).
 *
 * FNXC:WorkflowScheduling 2026-08-29-00:24:
 * FN-245 removes the browser client's force option. Every promote request is a
 * normal release attempt, so an unplanned or approval-held card remains held
 * until its planning gates genuinely complete.
 */
export function promoteTask(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/promote`, projectId), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/**
 * Soft-deletes a task by setting `deletedAt` server-side while preserving the row/artifacts,
 * and keeping the task ID reserved.
 *
 * `removeDependencyReferences` allows forced delete by first removing incoming dependency links.
 * `githubIssueAction` controls linked issue behavior (`close`, `delete`, or `leave`) during deletion.
 *
 * This endpoint never hard-removes the persisted row or task artifacts.
 */
export function deleteTask(id: string, projectId?: string, options?: DeleteTaskOptions): Promise<Task> {
  const search = new URLSearchParams();
  if (options?.removeDependencyReferences) {
    search.set("removeDependencyReferences", "true");
  }
  if (options?.removeLineageReferences) {
    search.set("removeLineageReferences", "true");
  }
  if (options?.githubIssueAction) {
    search.set("githubIssueAction", options.githubIssueAction);
  }
  // FNXC:TaskLifecycle 2026-07-16-12:00:
  // FN-5233 route reads delete modifiers from query params, including allowResurrection.
  if (options?.allowResurrection) {
    search.set("allowResurrection", "true");
  }

  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return api<Task>(withProjectId(`/tasks/${id}${suffix}`, projectId), { method: "DELETE" });
}

export function mergeTask(id: string, projectId?: string): Promise<MergeResult> {
  return api<MergeResult>(withProjectId(`/tasks/${id}/merge`, projectId), { method: "POST" });
}

export interface BranchGroupMemberSummary {
  taskId: string;
  title: string;
  column: Task["column"];
  landed: boolean;
}

export interface BranchGroupReviewAdvisory {
  taskId: string;
  workflowStepId: string;
  workflowStepName: string;
  status: "passed" | "failed" | "advisory_failure" | "skipped" | "pending";
  verdict?: "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE";
  notes?: string;
  findings: Array<{ id: string; title: string; body: string; filePath?: string; line?: number; severity?: "low" | "medium" | "high" | "critical" }>;
}

export interface BranchGroupSummary extends BranchGroup {
  members: BranchGroupMemberSummary[];
  advisories: BranchGroupReviewAdvisory[];
  completion: {
    landed: number;
    total: number;
    complete: boolean;
  };
}

export interface PromoteBranchGroupResult {
  groupId: string;
  status?: BranchGroup["status"];
  prState?: BranchGroupPrState;
  prNumber?: number;
  prUrl?: string;
}

export function apiListBranchGroups(projectId?: string, status?: BranchGroup["status"]): Promise<{ groups: BranchGroupSummary[] }> {
  const search = new URLSearchParams();
  if (status) search.set("status", status);
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return api<{ groups: BranchGroupSummary[] }>(withProjectId(`/branch-groups${suffix}`, projectId));
}

export function apiGetBranchGroup(id: string, projectId?: string): Promise<{ group: BranchGroupSummary }> {
  return api<{ group: BranchGroupSummary }>(withProjectId(`/branch-groups/${id}`, projectId));
}

export function apiAssignTaskBranchGroup(
  payload: { taskId: string; groupId?: string | null; branchName?: string },
  projectId?: string,
): Promise<{ taskId: string; groupId: string | null }> {
  return api<{ taskId: string; groupId: string | null }>(withProjectId("/branch-groups/assign", projectId), {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function apiPromoteBranchGroup(id: string, projectId?: string): Promise<PromoteBranchGroupResult> {
  return api<PromoteBranchGroupResult>(withProjectId(`/branch-groups/${id}/promote`, projectId), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function apiAbandonBranchGroup(id: string, projectId?: string): Promise<{ groupId: string; group: BranchGroupSummary }> {
  return api<{ groupId: string; group: BranchGroupSummary }>(withProjectId(`/branch-groups/${id}/abandon`, projectId), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export type RecoverBranchBindingOutcome =
  | { taskId: string; result: "applied"; branch: string; aheadCount: number; integrationBase: string; previousBranch: string | null }
  | { taskId: string; result: "skipped"; reason: "binding-intact" | "no-live-branch" | "ambiguous-candidates" | "no-unique-work"; candidates?: Array<{ branch: string; aheadCount: number }> };

export function retryTask(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/retry`, projectId), { method: "POST" });
}

/*
FNXC:ReviewLaneBypass 2026-07-09-00:00:
Operator/privileged review-lane bypass primitive (FN-7720). Bypasses the latest
failed pre-merge review step of an in-review task so it can advance past the
gate; a non-empty `reason` is mandatory and audited server-side. Mirrors
`retryTask`'s client shape.
*/
export function bypassReview(id: string, reason: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/bypass-review`, projectId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}

export function relaunchCliSession(sessionId: string, projectId?: string): Promise<{ ok: boolean; taskId?: string }> {
  return api<{ ok: boolean; taskId?: string }>(
    withProjectId(`/cli-sessions/${encodeURIComponent(sessionId)}/relaunch`, projectId),
    { method: "POST" },
  );
}

export function recoverBranchBinding(id: string, projectId?: string): Promise<RecoverBranchBindingOutcome> {
  return api<RecoverBranchBindingOutcome>(withProjectId(`/tasks/${id}/recover-branch-binding`, projectId), { method: "POST" });
}

export interface TaskResetOptions {
  description?: string;
}

/*
FNXC:TaskReset 2026-08-28-16:31:
Reset deliberately uses the same options-second, projectId-last contract as duplicateTask and every host prop. The hook alone owns projectId; placing an options object in that slot would let withProjectId silently encode it as `[object Object]` while dropping the description from the request body.
*/
export function resetTask(
  id: string,
  options?: TaskResetOptions,
  projectId?: string,
): Promise<Task> {
  const description = options?.description;
  return api<Task>(withProjectId(`/tasks/${id}/reset`, projectId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(description === undefined ? { confirm: true } : { confirm: true, description }),
  });
}

export function duplicateTask(
  id: string,
  options?: { workflowId?: string },
  projectId?: string,
): Promise<Task> {
  const workflowId = options?.workflowId;
  return api<Task>(withProjectId(`/tasks/${id}/duplicate`, projectId), {
    method: "POST",
    ...(workflowId
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowId }) }
      : {}),
  });
}

export function pauseTask(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/pause`, projectId), { method: "POST" });
}

export function unpauseTask(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/unpause`, projectId), { method: "POST" });
}

/*
FNXC:PlannerOversight 2026-07-04-17:00:
FN-7517 task-detail planner-overseer controls. `nudgeOverseer` asks the
engine to inject one steering-guidance comment into the task's currently
watched stage right now (guidance-only — never a merge/PR/destructive side
effect); `stopOverseer` disables active oversight for the task (writes the
per-task `plannerOversightLevel: "off"` override); `explainOverseer` is a
read of the current overseer runtime state (watched stage, reason, last
action, attempt count/limit) for the "explain current action" panel. Each
returns an `applied: false`/`snapshot: null` style result rather than
throwing when oversight is off/inactive or the engine runtime is
unavailable — callers should treat that as a normal disabled state, not an
error toast.
*/
export interface OverseerControlResult {
  applied: boolean;
  reason: string;
  task?: Task;
}

export function nudgeOverseer(id: string, projectId?: string): Promise<OverseerControlResult> {
  return api<OverseerControlResult>(withProjectId(`/tasks/${id}/overseer/nudge`, projectId), { method: "POST" });
}

export function stopOverseer(id: string, projectId?: string): Promise<OverseerControlResult> {
  return api<OverseerControlResult>(withProjectId(`/tasks/${id}/overseer/stop`, projectId), { method: "POST" });
}

export function explainOverseer(id: string, projectId?: string): Promise<{ snapshot: PlannerOverseerRuntimeSnapshot | null }> {
  return api<{ snapshot: PlannerOverseerRuntimeSnapshot | null }>(withProjectId(`/tasks/${id}/overseer/explain`, projectId), { method: "GET" });
}

/*
FNXC:PlannerOversight 2026-07-04-18:00:
FN-7519 read-only client fetch for the planner-intervention timeline. Mirrors
`explainOverseer`'s pattern; never mutates state and resolves to an empty
array when the task has no recorded interventions.
*/
export function fetchPlannerInterventionTimeline(id: string, projectId?: string): Promise<{ entries: PlannerInterventionEntry[] }> {
  return api<{ entries: PlannerInterventionEntry[] }>(withProjectId(`/tasks/${id}/overseer/interventions`, projectId), { method: "GET" });
}

/*
FNXC:TaskRevert 2026-07-05-00:00 (FN-7525):
Client-side contract for `POST /tasks/:id/revert` (route owned by FN-7523/
FN-7524/FN-7547/FN-7548 — see the `FNXC:TaskRevert` block in
`register-task-workflow-routes.ts`). This is a discriminated union, NOT a
`Task` — the source task's column/status is never mutated by this call; the
caller (useTasks' `revertTask` op) refreshes the task list afterward so any
newly-created revert commit / AI-undo task becomes visible, without patching
the source task's column directly.
*/
export interface RevertTaskWorkspaceRepoResult {
  repo: string;
  classification?: string;
  revertCommitSha?: string;
  conflicts?: unknown;
  alreadyReverted?: boolean;
}

export interface RevertTaskGitResult {
  mode: "git";
  clean: boolean;
  revertCommitSha?: string;
  revertCommitShas?: string[];
  conflicts?: unknown;
  alreadyReverted?: boolean;
  unsupported?: boolean;
  needsHuman?: boolean;
  reason?: string;
  workspace?: { repos: RevertTaskWorkspaceRepoResult[] };
}

export interface RevertTaskAiResult {
  mode: "ai";
  createdTaskId: string;
  alreadyOpen?: boolean;
}

export type RevertTaskResult = RevertTaskGitResult | RevertTaskAiResult;

export interface RevertTaskOptions {
  mode?: "git" | "ai" | "auto";
  granularity?: "squash" | "per-sha";
}

export function revertTask(id: string, projectId?: string, body?: RevertTaskOptions): Promise<RevertTaskResult> {
  return api<RevertTaskResult>(withProjectId(`/tasks/${id}/revert`, projectId), {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

export function approvePlan(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/approve-plan`, projectId), { method: "POST" });
}

export function rejectPlan(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/reject-plan`, projectId), { method: "POST" });
}


/** Dismiss one durable AI merge finding; this is intentionally separate from workflow-step bypass. */
export function dismissAiMergeReviewFinding(taskId: string, findingId: string, reason: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${taskId}/ai-merge-review-findings/${findingId}/dismiss`, projectId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}
