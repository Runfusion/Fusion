/**
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Insights client API peeled from legacy.ts.
 */
import type {
  Insight,
  InsightCategory,
  InsightStatus,
  InsightRun,
  InsightRunTrigger,
} from "@fusion/core";
import { api } from "./client.js";
import { withProjectId } from "./health.js";

// ── Insights API ─────────────────────────────────────────────────────────────

export interface InsightsListResponse {
  insights: Insight[];
  count: number;
}

export interface RunsListResponse {
  runs: InsightRun[];
}

/**
 * List insights for a project with optional filtering.
 */
export function fetchInsights(
  options: {
    category?: InsightCategory;
    status?: InsightStatus;
    runId?: string;
    limit?: number;
    offset?: number;
  } = {},
  projectId?: string,
): Promise<InsightsListResponse> {
  const params = new URLSearchParams();
  if (options.category) params.set("category", options.category);
  if (options.status) params.set("status", options.status);
  if (options.runId) params.set("runId", options.runId);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<InsightsListResponse>(withProjectId(`/insights${suffix}`, projectId));
}

/**
 * Get a single insight by ID.
 */
export function fetchInsight(id: string, projectId?: string): Promise<Insight> {
  return api<Insight>(withProjectId(`/insights/${encodeURIComponent(id)}`, projectId));
}

/**
 * Update an insight.
 */
export function updateInsight(
  id: string,
  updates: {
    title?: string;
    content?: string | null;
    category?: InsightCategory;
    status?: InsightStatus;
  },
  projectId?: string,
): Promise<Insight> {
  return api<Insight>(withProjectId(`/insights/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/**
 * Delete an insight.
 */
export function deleteInsight(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/insights/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/**
 * Dismiss an insight (set status to dismissed).
 */
export function dismissInsight(id: string, projectId?: string): Promise<Insight> {
  return api<Insight>(withProjectId(`/insights/${encodeURIComponent(id)}/dismiss`, projectId), {
    method: "POST",
  });
}

/**
 * Archive an insight (set status to archived).
 */
export function archiveInsight(id: string, projectId?: string): Promise<Insight> {
  return api<Insight>(withProjectId(`/insights/${encodeURIComponent(id)}/archive`, projectId), {
    method: "POST",
  });
}

/**
 * Unarchive an insight (set status back to confirmed).
 */
export function unarchiveInsight(id: string, projectId?: string): Promise<Insight> {
  return api<Insight>(withProjectId(`/insights/${encodeURIComponent(id)}/unarchive`, projectId), {
    method: "POST",
  });
}

/**
 * Trigger a manual insight generation run.
 */
export function triggerInsightRun(
  trigger: InsightRunTrigger = "manual",
  inputMetadata?: InsightRun["inputMetadata"],
  projectId?: string,
  modelProvider?: string,
  modelId?: string,
  thinkingLevel?: string,
): Promise<InsightRun> {
  const body: Record<string, unknown> = { trigger, inputMetadata };
  if (modelProvider) body.modelProvider = modelProvider;
  if (modelId) body.modelId = modelId;
  if (thinkingLevel) body.thinkingLevel = thinkingLevel;
  return api<InsightRun>(withProjectId("/insights/run", projectId), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * List insight generation runs.
 */
export function fetchInsightRuns(projectId?: string): Promise<RunsListResponse> {
  return api<RunsListResponse>(withProjectId("/insights/runs", projectId));
}

/**
 * Get a single insight run by ID.
 */
export function fetchInsightRun(id: string, projectId?: string): Promise<InsightRun> {
  return api<InsightRun>(withProjectId(`/insights/runs/${encodeURIComponent(id)}`, projectId));
}

/**
 * Get data needed to create a task from an insight.
 */
export function getInsightCreateTaskData(
  id: string,
  projectId?: string,
): Promise<{
  success: boolean;
  insight: Insight;
  suggestedTitle: string;
  suggestedDescription: string;
}> {
  return api(withProjectId(`/insights/${encodeURIComponent(id)}/create-task`, projectId), {
    method: "POST",
  });
}

