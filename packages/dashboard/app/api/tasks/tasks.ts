/**
 * FNXC:CodeOrganization 2026-07-16-01:00:
 * Task CRUD client API (list/detail/create/update/move) peeled from legacy.ts.
 */
import type {
  Task,
  TaskDetail,
  TaskCreateInput,
  ColumnId,
  TaskPriority,
  TaskSourceIssue,
  TaskGitLabTracking,
  TaskGitLabTrackedItem,
  GithubIssueAction,
} from "@fusion/core";
import { withTokenHeader } from "../../auth";
import { api, ApiRequestError, buildApiUrl, proxyApi } from "../client/client.js";
import { withProjectId } from "../client/health.js";

/** Options that shape the soft-delete request payload/query, not hard-delete behavior. */
export interface DeleteTaskOptions {
  removeDependencyReferences?: boolean;
  removeLineageReferences?: boolean;
  githubIssueAction?: GithubIssueAction;
  allowResurrection?: boolean;
}

export interface ArchiveTaskOptions {
  removeLineageReferences?: boolean;
}

export function fetchTasks(
  limit?: number,
  offset?: number,
  projectId?: string,
  q?: string,
  includeArchived?: boolean,
): Promise<Task[]> {
  const search = new URLSearchParams();
  if (limit !== undefined) search.set("limit", String(limit));
  if (offset !== undefined) search.set("offset", String(offset));
  if (projectId) search.set("projectId", projectId);
  if (q) search.set("q", q);
  if (includeArchived) search.set("includeArchived", "1");
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return api<Task[]>(`/tasks${suffix}`);
}

/**
 * FNXC:ArchivePagination 2026-07-08-00:00:
 * Dedicated paged read for the Archived board column (FN-7659). Returns
 * one bounded page (default 100) ordered `archivedAt DESC` plus `total`/
 * `hasMore` so the caller can drive a "Show more" affordance without ever
 * fetching the whole archive in one request.
 */
export function fetchArchivedTasks(
  projectId?: string,
  limit?: number,
  offset?: number,
): Promise<{ tasks: Task[]; total: number; hasMore: boolean }> {
  const search = new URLSearchParams();
  if (limit !== undefined) search.set("limit", String(limit));
  if (offset !== undefined) search.set("offset", String(offset));
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return api<{ tasks: Task[]; total: number; hasMore: boolean }>(withProjectId(`/tasks/archived${suffix}`, projectId));
}

export async function fetchTaskDetail(id: string, projectId?: string): Promise<TaskDetail> {
  const maxAttempts = 2; // 1 initial + 1 retry
  const url = buildApiUrl(withProjectId(`/tasks/${id}`, projectId));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: withTokenHeader({ "Content-Type": "application/json" }),
    });
    const data = await res.json();
    if (res.ok) return data as TaskDetail;
    if (attempt === maxAttempts) {
      throw new Error((data as { error?: string }).error || "Request failed");
    }
  }
  // unreachable
  throw new Error("Request failed");
}

export interface TaskRuntimeFallbackResponse {
  taskId: string;
  hasEvent: boolean;
  wasConfigured: boolean | null;
  runtimeHint: string | null;
  reason: string | null;
  eventId: string | null;
  timestamp: string | null;
  showFallbackBadge: boolean;
}

/**
 * Fetch the most recent session:runtime-resolved audit event for a task,
 * normalized for the runtime-fallback badge/toast affordance. Used by
 * useRuntimeFallbackStatus.
 */
export async function fetchTaskRuntimeFallback(
  taskId: string,
  projectId?: string,
): Promise<TaskRuntimeFallbackResponse> {
  return api<TaskRuntimeFallbackResponse>(withProjectId(`/tasks/${taskId}/runtime-fallback`, projectId));
}

export interface UpdateTaskReviewRequest {
  reviewState: TaskDetail["reviewState"] | null;
}

export interface TaskReviewResponse {
  reviewState: NonNullable<TaskDetail["reviewState"]>;
  automationStatus: string | null;
  emptyMessage?: string | null;
  prInfo?: TaskDetail["prInfo"];
}

export interface RefreshTaskReviewResponse {
  reviewState: NonNullable<TaskDetail["reviewState"]>;
  automationStatus: string | null;
  prInfo?: TaskDetail["prInfo"];
}

export interface SelectedReviewItem {
  id: string;
  source: "pr-review" | "reviewer-agent";
  threadId?: string;
  filePath?: string;
  lineNumber?: number;
  author?: string;
  summary: string;
  body: string;
  url?: string;
}

export interface ReviseTaskReviewResponse {
  task: Task;
  reviewState: NonNullable<TaskDetail["reviewState"]>;
}

export interface AddressPrFeedbackResponse {
  task: Task;
}

export interface DuplicateMatch {
  id: string;
  title: string;
  description: string;
  column: string;
  score: number;
}

export class DuplicateCandidatesError extends Error {
  readonly matches: DuplicateMatch[];

  constructor(matches: DuplicateMatch[]) {
    super("duplicate_candidates");
    this.name = "DuplicateCandidatesError";
    this.matches = matches;
  }
}

export interface CreateTaskRequestOptions {
  transportNodeId?: string;
  localNodeId?: string;
}

export type BranchSelectionInput = {
  mode: "project-default" | "auto-new" | "existing" | "custom-new";
  branchName?: string;
  baseBranch?: string;
};

export type CreateTaskInput = TaskCreateInput & {
  branchSelection?: BranchSelectionInput;
  acknowledgedDuplicates?: string[];
  bypassDuplicateCheck?: boolean;
};

export async function checkDuplicateTasks(
  input: { title?: string; description: string },
  projectId?: string,
): Promise<DuplicateMatch[]> {
  const response = await api<{ matches?: DuplicateMatch[] }>(withProjectId("/tasks/duplicate-check", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
  return response.matches ?? [];
}

export async function createTask(
  input: CreateTaskInput,
  projectId?: string,
  options?: CreateTaskRequestOptions,
): Promise<Task> {
  const {
    title,
    description,
    column,
    dependencies,
    breakIntoSubtasks,
    enabledWorkflowSteps,
    workflowId,
    assignedAgentId,
    modelPresetId,
    modelProvider,
    modelId,
    validatorModelProvider,
    validatorModelId,
    planningModelProvider,
    planningModelId,
    mergerModelProvider,
    mergerModelId,
    thinkingLevel,
    validatorThinkingLevel,
    planningThinkingLevel,
    mergerThinkingLevel,
    plannerOversightLevel,
    summarize,
    reviewLevel,
    executionMode,
    autoMerge,
    priority,
    source,
    nodeId,
    branch,
    baseBranch,
    branchSelection,
    githubTracking,
    sessionAdvisorEnabled,
    acknowledgedDuplicates,
    bypassDuplicateCheck,
  } = input;

  try {
    return await proxyApi<Task>(withProjectId("/tasks", projectId), {
    method: "POST",
    nodeId: options?.transportNodeId,
    localNodeId: options?.localNodeId,
    body: JSON.stringify({
      title,
      description,
      column,
      dependencies,
      breakIntoSubtasks,
      enabledWorkflowSteps,
      workflowId,
      assignedAgentId,
      modelPresetId,
      modelProvider,
      modelId,
      validatorModelProvider,
      validatorModelId,
      planningModelProvider,
      planningModelId,
      mergerModelProvider,
      mergerModelId,
      thinkingLevel,
      validatorThinkingLevel,
      planningThinkingLevel,
      mergerThinkingLevel,
      plannerOversightLevel,
      summarize,
      reviewLevel,
      executionMode,
      autoMerge,
      priority,
      source,
      nodeId,
      branch,
      baseBranch,
      branchSelection,
      githubTracking,
      sessionAdvisorEnabled,
      acknowledgedDuplicates,
      bypassDuplicateCheck,
    }),
  });
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 409 && error.message === "duplicate_candidates") {
      const matches = Array.isArray(error.details?.matches)
        ? (error.details?.matches as DuplicateMatch[])
        : [];
      throw new DuplicateCandidatesError(matches);
    }
    throw error;
  }
}

export interface RepairOverlapBlockerResult {
  taskId: string;
  dryRun: boolean;
  repaired: boolean;
  statusCleared: boolean;
  previousOverlapBlockedBy?: string;
  currentOverlapBlockedBy?: string;
  reason: string;
  message: string;
  task?: Task;
}

export function repairOverlapBlocker(
  id: string,
  options: { dryRun?: boolean; reason?: string } = {},
  projectId?: string,
): Promise<RepairOverlapBlockerResult> {
  return api<RepairOverlapBlockerResult>(withProjectId(`/tasks/${id}/repair-overlap-blocker`, projectId), {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export function updateTask(
  id: string,
  updates: {
    title?: string;
    description?: string;
    prompt?: string;
    dependencies?: string[];
    enabledWorkflowSteps?: string[];
    overlapBlockedBy?: string | null;
    status?: null;
    modelProvider?: string | null;
    modelId?: string | null;
    validatorModelProvider?: string | null;
    validatorModelId?: string | null;
    planningModelProvider?: string | null;
    planningModelId?: string | null;
    mergerModelProvider?: string | null;
    mergerModelId?: string | null;
    thinkingLevel?: string | null;
    validatorThinkingLevel?: string | null;
    planningThinkingLevel?: string | null;
    mergerThinkingLevel?: string | null;
    plannerOversightLevel?: "off" | "observe" | "steer" | "autonomous" | null;
    /** FNXC:PlannerOversight 2026-07-14-18:11: boolean override or null to inherit project default. */
    sessionAdvisorEnabled?: boolean | null;
    reviewLevel?: number | null;
    executionMode?: "standard" | "fast" | null;
    noCommitsExpected?: boolean;
    autoMerge?: boolean | null;
    priority?: TaskPriority | null;
    sourceIssue?: TaskSourceIssue | null;
    nodeId?: string | null;
    branch?: string | null;
    baseBranch?: string | null;
    githubTracking?: {
      enabled?: boolean;
      repoOverride?: string | null;
      issue?: null;
    } | null;
    gitlabTracking?: (Omit<TaskGitLabTracking, "item"> & { item?: TaskGitLabTrackedItem | null }) | null;
    dismissNearDuplicate?: boolean;
  },
  projectId?: string,
): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/**
 * Batch update AI model configuration for multiple tasks.
 * @param taskIds - Array of task IDs to update
 * @param modelProvider - Executor model provider (optional, null to clear)
 * @param modelId - Executor model ID (optional, null to clear)
 * @param validatorModelProvider - Validator model provider (optional, null to clear)
 * @param validatorModelId - Validator model ID (optional, null to clear)
 * @param thinkingLevel - Executor thinking level (optional, null to clear)
 * @returns Promise with updated tasks and count
 */
export function batchUpdateTaskModels(
  taskIds: string[],
  modelProvider?: string | null,
  modelId?: string | null,
  validatorModelProvider?: string | null,
  validatorModelId?: string | null,
  planningModelProvider?: string | null,
  planningModelId?: string | null,
  nodeId?: string | null,
  thinkingLevel?: string | null,
  projectId?: string,
): Promise<{ updated: Task[]; count: number }> {
  return api<{ updated: Task[]; count: number }>(withProjectId("/tasks/batch-update-models", projectId), {
    method: "POST",
    body: JSON.stringify({
      taskIds,
      modelProvider,
      modelId,
      validatorModelProvider,
      validatorModelId,
      planningModelProvider,
      planningModelId,
      nodeId,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    }),
  });
}

export function moveTask(
  id: string,
  column: ColumnId,
  projectId?: string,
  optionsOrPosition?: { preserveProgress?: boolean } | number,
): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/move`, projectId), {
    method: "POST",
    body: JSON.stringify({
      column,
      ...(
        typeof optionsOrPosition === "object" && optionsOrPosition?.preserveProgress
          ? { preserveProgress: true }
          : {}
      ),
    }),
  });
}
