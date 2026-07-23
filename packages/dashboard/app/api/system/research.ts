/**
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Research + evals client API peeled from legacy.ts.
 */
import type {
  EvalRun,
  EvalTaskResult,
  ResearchRunStatus,
  Task,
} from "@fusion/core";
import type {
  ResearchAvailability,
  ResearchRunDetail,
  ResearchRunsResponse,
  ResearchRunResponse,
  ResearchProviderOption,
} from "../../research-types";
import { api, ApiRequestError } from "../client/client.js";
import { withProjectId } from "../client/health.js";

// ── Research API ────────────────────────────────────────────────────────────

export interface EvalsListOptions {
  q?: string;
  runId?: string;
  scoreMin?: number;
  scoreMax?: number;
  limit?: number;
  offset?: number;
}

export function listEvals(options: EvalsListOptions = {}, projectId?: string): Promise<{ results: EvalTaskResult[]; count: number }> {
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q);
  if (options.runId) params.set("runId", options.runId);
  if (options.scoreMin !== undefined) params.set("scoreMin", String(options.scoreMin));
  if (options.scoreMax !== undefined) params.set("scoreMax", String(options.scoreMax));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<{ results: EvalTaskResult[]; count: number }>(withProjectId(`/evals${suffix}`, projectId));
}

export function getEval(id: string, projectId?: string): Promise<{ result: EvalTaskResult }> {
  return api<{ result: EvalTaskResult }>(withProjectId(`/evals/${encodeURIComponent(id)}`, projectId));
}

export function listEvalRuns(projectId?: string): Promise<{ runs: EvalRun[] }> {
  return api<{ runs: EvalRun[] }>(withProjectId("/evals/runs", projectId));
}

export interface CreateResearchRunInput {
  query: string;
  providers: ResearchProviderOption[];
  githubRepo?: string;
  githubIssueNumber?: number;
  includeLocalDocs?: boolean;
  enableSynthesis?: boolean;
  maxResults?: number;
  depth?: "shallow" | "normal" | "deep";
}

export function listResearchRuns(
  options: { q?: string; status?: ResearchRunStatus; limit?: number } = {},
  projectId?: string,
): Promise<ResearchRunsResponse> {
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q);
  if (options.status) params.set("status", options.status);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<ResearchRunsResponse>(withProjectId(`/research/runs${suffix}`, projectId));
}

export function createResearchRun(input: CreateResearchRunInput, projectId?: string): Promise<ResearchRunResponse> {
  return api<ResearchRunResponse>(withProjectId("/research/runs", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getResearchRun(id: string, projectId?: string): Promise<ResearchRunResponse> {
  return api<ResearchRunResponse>(withProjectId(`/research/runs/${encodeURIComponent(id)}`, projectId));
}

export type ResearchActionErrorCode =
  | "FEATURE_DISABLED"
  | "MISSING_CREDENTIALS"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "RUN_CANCELLED"
  | "RETRY_EXHAUSTED"
  | "INVALID_TRANSITION"
  | "NON_RETRYABLE_PROVIDER_ERROR"
  | "INTERNAL_ERROR";

export interface ResearchActionError extends ApiRequestError {
  researchCode: ResearchActionErrorCode;
  setupHint?: string;
  retryable?: boolean;
}

function asResearchActionError(error: unknown): never {
  if (error instanceof ApiRequestError) {
    const codeCandidate = error.details?.code;
    const code = typeof codeCandidate === "string" ? codeCandidate : "INTERNAL_ERROR";
    const setupHint = typeof error.details?.setupHint === "string" ? error.details.setupHint : undefined;
    const retryable = typeof error.details?.retryable === "boolean" ? error.details.retryable : undefined;
    const enriched = error as ResearchActionError;
    enriched.researchCode = code as ResearchActionErrorCode;
    enriched.setupHint = setupHint;
    enriched.retryable = retryable;
    throw enriched;
  }
  throw error;
}

export async function cancelResearchRun(id: string, projectId?: string): Promise<{ run: ResearchRunDetail }> {
  try {
    return await api<{ run: ResearchRunDetail }>(withProjectId(`/research/runs/${encodeURIComponent(id)}/cancel`, projectId), {
      method: "POST",
    });
  } catch (error) {
    asResearchActionError(error);
  }
}

export async function retryResearchRun(id: string, projectId?: string): Promise<{ run: ResearchRunDetail }> {
  try {
    return await api<{ run: ResearchRunDetail }>(withProjectId(`/research/runs/${encodeURIComponent(id)}/retry`, projectId), {
      method: "POST",
    });
  } catch (error) {
    asResearchActionError(error);
  }
}

export function exportResearchRun(
  id: string,
  format: "markdown" | "json" | "html",
  projectId?: string,
): Promise<{ format: string; content: string; filename: string }> {
  return api<{ format: string; content: string; filename: string }>(
    withProjectId(`/research/runs/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`, projectId),
  );
}

export function createTaskFromResearchRun(
  id: string,
  input: { findingId?: string; title?: string; description?: string; priority?: "low" | "normal" | "high" | "urgent"; attachExport?: boolean },
  projectId?: string,
): Promise<{ task: Task; documentKey: string; attachmentFilename?: string }> {
  const findingId = input.findingId ?? "finding-1";
  return api<{ task: Task; documentKey: string; attachmentFilename?: string }>(
    withProjectId(`/research/runs/${encodeURIComponent(id)}/findings/${encodeURIComponent(findingId)}/task`, projectId),
    {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        priority: input.priority,
        attachExport: input.attachExport,
      }),
    },
  );
}

export function attachResearchRunToTask(
  id: string,
  input: { findingId?: string; taskId: string; attachExport?: boolean },
  projectId?: string,
): Promise<{ taskId: string; documentKey: string; revision: number; attachmentFilename?: string }> {
  const findingId = input.findingId ?? "finding-1";
  return api<{ taskId: string; documentKey: string; revision: number; attachmentFilename?: string }>(
    withProjectId(
      `/research/runs/${encodeURIComponent(id)}/findings/${encodeURIComponent(findingId)}/tasks/${encodeURIComponent(input.taskId)}/enrich`,
      projectId,
    ),
    {
      method: "POST",
      body: JSON.stringify({
        attachExport: input.attachExport,
      }),
    },
  );
}

export function getResearchAvailability(projectId?: string): Promise<ResearchAvailability> {
  return listResearchRuns({}, projectId).then((response) => response.availability);
}

export interface ResearchStatsResponse {
  total: number;
  byStatus: Record<ResearchRunStatus, number>;
}

export function getResearchStats(projectId?: string): Promise<ResearchStatsResponse> {
  return api<ResearchStatsResponse>(withProjectId("/research/stats", projectId));
}

/*
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Preserve legacy `system-panel` imports while implementations live in system-panel.ts.
 */
export {
  fetchCurrentSystemRebuild,
  fetchSystemInfo,
  fetchSystemLogs,
  promoteResearchFinding,
  reloadAllSystemPlugins,
  requestSystemRestart,
  restartAllSystemAgents,
  restartSystemEngines,
  startFnBinaryLinkLocal,
  startFnBinaryUseGlobal,
  startSystemRebuild,
} from "./system-panel.js";
export type {
  ResearchFindingPromotionInput,
  SystemInfoResponse,
  SystemLogEntryDto,
  SystemRebuildJobLine,
  SystemRebuildJobSnapshot,
} from "./system-panel.js";

