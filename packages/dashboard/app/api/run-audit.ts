/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Run-audit, timeline, org tree, and task review client API peeled from legacy.ts.
 */

import type {
  Agent,
  AgentStats,
  OrgTreeNode,
  AgentLogEntry,
  Task,
  TaskReviewData,
} from "@fusion/core";
import { api } from "./client.js";
import type { FetchOptions } from "./client.js";
import { withProjectId } from "./health.js";
import { dedupe } from "./dedupe.js";
import type {
  TaskReviewResponse,
  RefreshTaskReviewResponse,
  SelectedReviewItem,
  ReviseTaskReviewResponse,
  AddressPrFeedbackResponse,
} from "./tasks.js";

// ── Run-Audit & Timeline API ────────────────────────────────────────────────

/** Valid domain filters for run-audit queries. */
export type RunAuditDomainFilter = "database" | "git" | "filesystem" | "sandbox";

/** Filter options for run-audit queries. */
export interface RunAuditFilters {
  /** Filter by task ID */
  taskId?: string;
  /** Filter by domain category */
  domain?: RunAuditDomainFilter;
  /** Start of time range (inclusive, ISO-8601) */
  startTime?: string;
  /** End of time range (inclusive, ISO-8601) */
  endTime?: string;
  /** Maximum number of events to return */
  limit?: number;
}

/** Normalized run-audit event for UI consumption. */
export interface NormalizedRunAuditEvent {
  id: string;
  timestamp: string;
  taskId?: string;
  domain: "database" | "git" | "filesystem" | "sandbox";
  mutationType: string;
  target: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

/** Response shape for run-audit endpoint. */
export interface RunAuditResponse {
  runId: string;
  events: NormalizedRunAuditEvent[];
  filters: {
    taskId?: string;
    domain?: RunAuditDomainFilter;
    startTime?: string;
    endTime?: string;
  };
  totalCount: number;
  hasMore: boolean;
}

/** Unified timeline entry that can represent either an audit event or an agent log entry. */
export interface TimelineEntry {
  timestamp: string;
  type: "audit" | "log";
  sortKey: string;
  audit?: NormalizedRunAuditEvent;
  log?: AgentLogEntry;
}

/** Response shape for run-timeline endpoint. */
export interface RunTimelineResponse {
  run: {
    id: string;
    agentId: string;
    startedAt: string;
    endedAt?: string;
    status: string;
    taskId?: string;
  };
  auditByDomain: {
    database: NormalizedRunAuditEvent[];
    git: NormalizedRunAuditEvent[];
    filesystem: NormalizedRunAuditEvent[];
    sandbox: NormalizedRunAuditEvent[];
  };
  counts: {
    auditEvents: number;
    logEntries: number;
  };
  timeline: TimelineEntry[];
}

/**
 * Fetch normalized run-audit events for a specific agent run.
 *
 * @param agentId - The agent ID
 * @param runId - The run ID
 * @param filters - Optional filter parameters
 * @param projectId - Optional project ID for multi-project workspaces
 * @returns Promise resolving to RunAuditResponse with normalized events
 * @throws Error if runId is blank or whitespace-only
 */
export function fetchAgentRunAudit(
  agentId: string,
  runId: string,
  filters?: RunAuditFilters,
  projectId?: string,
): Promise<RunAuditResponse> {
  // Validate runId before making API call
  if (!runId || runId.trim().length === 0) {
    throw new Error("runId is required");
  }

  const params = new URLSearchParams();
  if (filters?.taskId) params.set("taskId", filters.taskId);
  if (filters?.domain) params.set("domain", filters.domain);
  if (filters?.startTime) params.set("startTime", filters.startTime);
  if (filters?.endTime) params.set("endTime", filters.endTime);
  if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<RunAuditResponse>(
    withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/audit${query}`, projectId),
  );
}

/**
 * Fetch a correlated timeline combining run-audit events and agent logs for a specific run.
 *
 * @param agentId - The agent ID
 * @param runId - The run ID
 * @param options - Optional parameters
 * @param options.taskId - Override task ID for audit filtering (defaults to run's contextSnapshot.taskId)
 * @param options.domain - Filter audit events by domain
 * @param options.startTime - Start of time range (ISO-8601)
 * @param options.endTime - End of time range (ISO-8601)
 * @param options.includeLogs - Whether to include agent logs (default true)
 * @param options.limit - Maximum audit events to return
 * @param projectId - Optional project ID for multi-project workspaces
 * @returns Promise resolving to RunTimelineResponse with merged timeline
 * @throws Error if runId is blank or whitespace-only
 */
export function fetchAgentRunTimeline(
  agentId: string,
  runId: string,
  options?: {
    taskId?: string;
    domain?: RunAuditDomainFilter;
    startTime?: string;
    endTime?: string;
    includeLogs?: boolean;
    limit?: number;
  },
  projectId?: string,
): Promise<RunTimelineResponse> {
  // Validate runId before making API call
  if (!runId || runId.trim().length === 0) {
    throw new Error("runId is required");
  }

  const params = new URLSearchParams();
  if (options?.taskId) params.set("taskId", options.taskId);
  if (options?.domain) params.set("domain", options.domain);
  if (options?.startTime) params.set("startTime", options.startTime);
  if (options?.endTime) params.set("endTime", options.endTime);
  if (options?.includeLogs !== undefined) params.set("includeLogs", String(options.includeLogs));
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<RunTimelineResponse>(
    withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/timeline${query}`, projectId),
  );
}

/** Fetch aggregate agent stats */
export function fetchAgentStats(projectId?: string, options?: FetchOptions): Promise<AgentStats> {
  const path = withProjectId("/agents/stats", projectId);
  return dedupe(path, () => api<AgentStats>(path), options);
}

/** Fetch the chain of command for an agent (self → manager → grand-manager → ...) */
export function fetchChainOfCommand(agentId: string, projectId?: string): Promise<Agent[]> {
  return api<Agent[]>(withProjectId(`/agents/${encodeURIComponent(agentId)}/chain-of-command`, projectId));
}

/** Fetch the full org tree as nested nodes */
export function fetchOrgTree(projectId?: string, options?: { includeEphemeral?: boolean }): Promise<OrgTreeNode[]> {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (options?.includeEphemeral) params.set("includeEphemeral", "true");
  const query = params.toString();
  return api<OrgTreeNode[]>(`/agents/org-tree${query ? `?${query}` : ""}`);
}

/** Resolve an agent by shortname or ID */
export function resolveAgent(shortname: string, projectId?: string): Promise<{ agent: Agent }> {
  return api<{ agent: Agent }>(withProjectId(`/agents/resolve/${encodeURIComponent(shortname)}`, projectId));
}

/** Fetch employees (agents that report to a given parent agent) */
export function fetchAgentChildren(agentId: string, projectId?: string): Promise<Agent[]> {
  return api<Agent[]>(withProjectId(`/agents/${encodeURIComponent(agentId)}/children`, projectId)).catch((err: Error) => {
    // Return empty array for 404 (agent may have been deleted)
    if (err.message.includes("not found")) return [];
    throw err;
  });
}

/** Alias for fetchAgentChildren with employee-focused naming */
export const fetchAgentEmployees = fetchAgentChildren;

/** Assign or unassign a task to an explicit agent */
export function assignTask(taskId: string, agentId: string | null, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/assign`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ agentId }),
  });
}

/** Assign or unassign a task to a user (for review handoff) */
export function assignTaskToUser(taskId: string, userId: string | null, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/assign-user`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ userId }),
  });
}

/** Accept review - clear assignee and awaiting-user-review status, keep in in-review */
export function acceptTaskReview(taskId: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/accept-review`, projectId), {
    method: "POST",
  });
}

function mapTaskReviewDataToLegacy(data: TaskReviewData): TaskReviewResponse {
  const fetchedAt = data.fetchedAt ?? undefined;
  const canonicalItems = data.items.map((item) => ({
    id: item.itemId,
    body: item.body,
    author: { login: item.author },
    createdAt: item.createdAt ?? new Date(0).toISOString(),
    updatedAt: item.updatedAt ?? undefined,
    path: item.filePath,
    threadId: item.threadId,
    htmlUrl: item.url,
    state: item.reviewState ?? undefined,
    summary: item.title ?? undefined,
    isResolved: item.isResolved,
    ...(typeof item.line === "number" ? { line: item.line } : {}),
  }));

  return {
    reviewState: {
      source: data.mode,
      summary: data.summary ?? undefined,
      items: canonicalItems,
      addressing: data.items
        .filter((item) => item.progressStatus != null)
        .map((item) => ({
          itemId: item.itemId,
          status: item.progressStatus ?? "queued",
          selectedAt: item.createdAt ?? fetchedAt ?? new Date(0).toISOString(),
          snapshot: {
            itemId: item.itemId,
            sourceMode: item.sourceMode,
            source: item.sourceMode === "pull-request" ? "pr-review" : "reviewer-agent",
            summary: item.title || item.body.slice(0, 120),
            body: item.body,
            authorLogin: item.author,
            filePath: item.filePath,
            lineNumber: item.line,
            threadId: item.threadId,
            url: item.url,
          },
        })),
      lastRefreshedAt: fetchedAt,
      refreshStatus: "ready",
      refreshSource: "initial-load",
    },
    automationStatus: null,
  };
}

/** Fetch normalized task review data (PR mode or direct mode) */
export async function fetchTaskReview(taskId: string, projectId?: string): Promise<TaskReviewResponse> {
  const data = await api<TaskReviewData>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/review`, projectId));
  return mapTaskReviewDataToLegacy(data);
}

/** Fetch canonical review payload for future review-tab rendering. */
export function fetchTaskReviewData(taskId: string, projectId?: string): Promise<TaskReviewData> {
  return api<TaskReviewData>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/review`, projectId));
}

/** Refresh normalized task review data (PR mode or direct mode) */
export async function refreshTaskReview(taskId: string, projectId?: string): Promise<RefreshTaskReviewResponse> {
  const data = await api<TaskReviewData>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/review/refresh`, projectId), {
    method: "POST",
  });
  return mapTaskReviewDataToLegacy(data);
}

/** Refresh canonical review payload for future review-tab rendering. */
export function refreshTaskReviewData(taskId: string, projectId?: string): Promise<TaskReviewData> {
  return api<TaskReviewData>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/review/refresh`, projectId), {
    method: "POST",
  });
}

/** Request an in-place revision pass for selected review items */
export function reviseTaskReviewItems(taskId: string, selectedItems: SelectedReviewItem[], projectId?: string): Promise<ReviseTaskReviewResponse> {
  return api<ReviseTaskReviewResponse>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/review/address`, projectId), {
    method: "POST",
    body: JSON.stringify({ selectedItems, tab: "review" }),
  });
}

/** Request an AI pass that addresses open pull-request feedback for the task's primary PR. */
export function addressPrFeedback(taskId: string, projectId?: string): Promise<AddressPrFeedbackResponse> {
  return api<AddressPrFeedbackResponse>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/pr/address-feedback`, projectId), {
    method: "POST",
  });
}

/** Return task to agent - clear assignee and status, move to todo */
export function returnTaskToAgent(taskId: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/return-to-agent`, projectId), {
    method: "POST",
  });
}

/** Fetch tasks explicitly assigned to an agent */
export function fetchAgentTasks(agentId: string, projectId?: string): Promise<Task[]> {
  return api<Task[]>(withProjectId(`/agents/${encodeURIComponent(agentId)}/tasks`, projectId));
}

