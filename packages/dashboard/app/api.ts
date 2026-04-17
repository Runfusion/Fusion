import type {
  Task,
  TaskDetail,
  TaskAttachment,
  TaskComment,
  TaskCreateInput,
  AgentLogEntry,
  Column,
  MergeResult,
  Settings,
  GlobalSettings,
  ProjectSettings,
  BatchStatusResult,
  BatchStatusResponse,
  ActivityLogEntry,
  ActivityEventType,
  WorkflowStep,
  WorkflowStepInput,
  WorkflowStepResult,
  PluginInstallation,
  PluginUiSlotDefinition,
  TaskDocument,
  TaskDocumentRevision,
  TaskDocumentWithTask,

  Message,
  MessageType,
  ParticipantType,
  NodeConfig,
  NodeStatus,
  NodeMeshState,
  SystemMetrics,
  DiscoveryConfig,
  MissionEvent,
  MissionHealth,
  MissionEventType,
  AgentRating,
  AgentRatingSummary,
  AgentRatingInput,
  ChatSession,
  ChatMessage,
  Roadmap,
  RoadmapMilestone,
  RoadmapFeature,
  RoadmapCreateInput,
  RoadmapUpdateInput,
  RoadmapMilestoneCreateInput,
  RoadmapMilestoneUpdateInput,
  RoadmapFeatureCreateInput,
  RoadmapFeatureUpdateInput,
  RoadmapWithHierarchy,
  RoadmapExportBundle,
  RoadmapMissionPlanningHandoff,
  RoadmapFeatureTaskPlanningHandoff,
  Insight,
  InsightCategory,
  InsightStatus,
  InsightListOptions,
  InsightRun,
  InsightRunTrigger,
  InsightRunCreateInput,
} from "@fusion/core";
import type { PlanningQuestion, PlanningSummary } from "@fusion/core";
import type { ScheduledTask, ScheduledTaskCreateInput, ScheduledTaskUpdateInput, AutomationRunResult, Routine, RoutineCreateInput, RoutineUpdateInput, RoutineExecutionResult } from "@fusion/core";
import type { DiscoveredSkill, CatalogEntry, CatalogFetchResult, ToggleSkillResult } from "@fusion/dashboard";
import type { MilestoneValidationTelemetry } from "./components/mission-types";

// Re-export skills types for use by hooks and components
export type { DiscoveredSkill, CatalogEntry, CatalogFetchResult, ToggleSkillResult };

function looksLikeHtml(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<HTML");
}

function buildApiUrl(path: string): string {
  return `/api${path}`;
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const url = buildApiUrl(path);
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });

  // Handle successful 204 No Content responses (e.g., DELETE, reorder)
  // These return no body and no JSON content-type — return undefined for void endpoints
  if (res.status === 204) {
    if (!res.ok) {
      // 204 is always ok by definition, but guard anyway
      throw new Error(`Request failed for ${url}: ${res.status} ${res.statusText}`);
    }
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  const bodyText = await res.text();
  const isJson = contentType.includes("application/json");
  const isHtml = contentType.includes("text/html") || looksLikeHtml(bodyText);

  if (isHtml) {
    throw new Error(
      `API returned HTML instead of JSON for ${url}. ` +
      `The endpoint may not be properly configured. (${res.status} ${res.statusText})`
    );
  }

  if (!isJson) {
    const preview = bodyText.length > 160 ? `${bodyText.slice(0, 160)}...` : bodyText;
    throw new Error(
      `API returned ${contentType || "an unknown content type"} instead of JSON for ${url}. ` +
      `(${res.status} ${res.statusText})${preview ? ` Response: ${preview}` : ""}`
    );
  }

  let data: unknown;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    throw new Error(
      `API returned invalid JSON for ${url}. (${res.status} ${res.statusText})`
    );
  }

  if (!res.ok) {
    throw new Error((data as { error?: string } | null)?.error || `Request failed for ${url}: ${res.status} ${res.statusText}`);
  }

  return data as T;
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

export async function fetchTaskDetail(id: string, projectId?: string): Promise<TaskDetail> {
  const maxAttempts = 2; // 1 initial + 1 retry
  const url = buildApiUrl(withProjectId(`/tasks/${id}`, projectId));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
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

export function createTask(input: TaskCreateInput, projectId?: string): Promise<Task> {
  const {
    title,
    description,
    column,
    dependencies,
    breakIntoSubtasks,
    enabledWorkflowSteps,
    assignedAgentId,
    modelPresetId,
    modelProvider,
    modelId,
    validatorModelProvider,
    validatorModelId,
    planningModelProvider,
    planningModelId,
    thinkingLevel,
    summarize,
  } = input;

  return api<Task>(withProjectId("/tasks", projectId), {
    method: "POST",
    body: JSON.stringify({
      title,
      description,
      column,
      dependencies,
      breakIntoSubtasks,
      enabledWorkflowSteps,
      assignedAgentId,
      modelPresetId,
      modelProvider,
      modelId,
      validatorModelProvider,
      validatorModelId,
      planningModelProvider,
      planningModelId,
      thinkingLevel,
      summarize,
    }),
  });
}

export function updateTask(id: string, updates: { title?: string; description?: string; prompt?: string; dependencies?: string[]; enabledWorkflowSteps?: string[]; modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null; planningModelProvider?: string | null; planningModelId?: string | null; thinkingLevel?: string | null }, projectId?: string): Promise<Task> {
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
    }),
  });
}

export function moveTask(id: string, column: Column, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/move`, projectId), {
    method: "POST",
    body: JSON.stringify({ column }),
  });
}

export function deleteTask(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}`, projectId), { method: "DELETE" });
}

export function mergeTask(id: string, projectId?: string): Promise<MergeResult> {
  return api<MergeResult>(withProjectId(`/tasks/${id}/merge`, projectId), { method: "POST" });
}

export function retryTask(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/retry`, projectId), { method: "POST" });
}

export function duplicateTask(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/duplicate`, projectId), { method: "POST" });
}

export function pauseTask(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/pause`, projectId), { method: "POST" });
}

export function unpauseTask(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/unpause`, projectId), { method: "POST" });
}

export function archiveTask(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/archive`, projectId), { method: "POST" });
}

export function unarchiveTask(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/unarchive`, projectId), { method: "POST" });
}

export function archiveAllDone(projectId?: string): Promise<Task[]> {
  return api<{ archived: Task[] }>(withProjectId("/tasks/archive-all-done", projectId), { method: "POST" }).then(
    (response) => response.archived
  );
}

export function approvePlan(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/approve-plan`, projectId), { method: "POST" });
}

export function rejectPlan(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/reject-plan`, projectId), { method: "POST" });
}

export function fetchConfig(projectId?: string): Promise<{ maxConcurrent: number; rootDir: string }> {
  return api<{ maxConcurrent: number; rootDir: string }>(withProjectId("/config", projectId));
}

export function fetchSettings(projectId?: string): Promise<Settings> {
  return api<Settings>(withProjectId("/settings", projectId));
}

export function updateSettings(settings: Partial<Settings>, projectId?: string): Promise<Settings> {
  return api<Settings>(withProjectId("/settings", projectId), {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function fetchMemory(projectId?: string): Promise<{ content: string }> {
  return api<{ content: string }>(withProjectId("/memory", projectId));
}

export function saveMemory(content: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId("/memory", projectId), {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

export interface MemoryFileInfo {
  path: string;
  label: string;
  layer: "long-term" | "daily" | "dreams" | "legacy";
  size: number;
  updatedAt: string;
}

export function fetchMemoryFiles(projectId?: string): Promise<{ files: MemoryFileInfo[] }> {
  return api<{ files: MemoryFileInfo[] }>(withProjectId("/memory/files", projectId));
}

export function fetchMemoryFile(path: string, projectId?: string): Promise<{ path: string; content: string }> {
  const query = `path=${encodeURIComponent(path)}`;
  return api<{ path: string; content: string }>(withProjectId(`/memory/file?${query}`, projectId));
}

export function saveMemoryFile(path: string, content: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId("/memory/file", projectId), {
    method: "PUT",
    body: JSON.stringify({ path, content }),
  });
}

/**
 * Compact memory content using AI to distill it down to the most important insights.
 * Reads current memory, compacts it via AI, and writes the result back.
 * @param projectId - Optional project ID for multi-project support
 * @returns Promise resolving to the compacted memory content
 */
export function compactMemory(projectId?: string): Promise<{ content: string }> {
  return api<{ content: string }>(withProjectId("/memory/compact", projectId), {
    method: "POST",
  });
}

/**
 * Memory backend capabilities returned by the backend status API.
 */
export interface MemoryBackendCapabilities {
  readable: boolean;
  writable: boolean;
  supportsAtomicWrite: boolean;
  hasConflictResolution: boolean;
  persistent: boolean;
}

/**
 * Memory backend status response from GET /api/memory/backend
 */
export interface MemoryBackendStatus {
  /** The effective backend type after runtime resolution */
  currentBackend: string;
  /** Capabilities of the effective backend */
  capabilities: MemoryBackendCapabilities;
  /** List of registered backend types available */
  availableBackends: string[];
}

/**
 * Fetch the current memory backend status and capabilities.
 * Use this to determine which backend is active and what operations it supports.
 */
export function fetchMemoryBackendStatus(projectId?: string): Promise<MemoryBackendStatus> {
  return api<MemoryBackendStatus>(withProjectId("/memory/backend", projectId));
}

/** Fetch global (user-level) settings from ~/.fusion/settings.json */
export function fetchGlobalSettings(): Promise<GlobalSettings> {
  return api<GlobalSettings>("/settings/global");
}

/** Update global (user-level) settings. These persist across all fn projects. */
export function updateGlobalSettings(settings: Partial<GlobalSettings>): Promise<Settings> {
  return api<Settings>("/settings/global", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

/** Fetch settings separated by scope: { global, project } */
export function fetchSettingsByScope(projectId?: string): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
  return api<{ global: GlobalSettings; project: Partial<ProjectSettings> }>(withProjectId("/settings/scopes", projectId));
}

export interface PiExtensionEntry {
  id: string;
  name: string;
  path: string;
  source: "fusion-global" | "pi-global" | "fusion-project" | "pi-project";
  enabled: boolean;
}

export interface PiExtensionSettings {
  extensions: PiExtensionEntry[];
  disabledIds: string[];
  settingsPath: string;
}

export function fetchPiExtensions(projectId?: string): Promise<PiExtensionSettings> {
  return api<PiExtensionSettings>(withProjectId("/settings/pi-extensions", projectId));
}

export function updatePiExtensions(disabledIds: string[], projectId?: string): Promise<PiExtensionSettings> {
  return api<PiExtensionSettings>(withProjectId("/settings/pi-extensions", projectId), {
    method: "PUT",
    body: JSON.stringify({ disabledIds }),
  });
}

export function testNtfyNotification(config?: { ntfyEnabled?: boolean; ntfyTopic?: string }, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId("/settings/test-ntfy", projectId), {
    method: "POST",
    body: config ? JSON.stringify(config) : undefined,
  });
}

export async function uploadAttachment(id: string, file: File, projectId?: string): Promise<TaskAttachment> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(buildApiUrl(withProjectId(`/tasks/${id}/attachments`, projectId)), {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || "Upload failed");
  return data as TaskAttachment;
}

export async function deleteAttachment(id: string, filename: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/attachments/${filename}`, projectId), { method: "DELETE" });
}

export function fetchAgentLogs(
  taskId: string,
  projectId?: string,
  options?: { limit?: number; offset?: number },
): Promise<AgentLogEntry[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options?.offset !== undefined) {
    params.set("offset", String(options.offset));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return api<AgentLogEntry[]>(withProjectId(`/tasks/${taskId}/logs${suffix}`, projectId));
}

/**
 * Fetch agent logs with pagination metadata.
 * Returns entries along with total count and hasMore flag from response headers.
 */
export async function fetchAgentLogsWithMeta(
  taskId: string,
  projectId?: string,
  options?: { limit?: number; offset?: number },
): Promise<{ entries: AgentLogEntry[]; total: number; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options?.offset !== undefined) {
    params.set("offset", String(options.offset));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const url = withProjectId(`/tasks/${taskId}/logs${suffix}`, projectId);

  const response = await fetch(buildApiUrl(url));

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Failed to fetch agent logs" }));
    throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
  }

  const entries = await response.json() as AgentLogEntry[];

  // Read pagination headers
  const total = response.headers.has("X-Total-Count")
    ? parseInt(response.headers.get("X-Total-Count")!, 10)
    : entries.length;
  const hasMore = response.headers.has("X-Has-More")
    ? response.headers.get("X-Has-More") === "true"
    : false;

  return { entries, total, hasMore };
}

export function fetchSessionFiles(taskId: string, projectId?: string): Promise<string[]> {
  return api<string[]>(withProjectId(`/tasks/${taskId}/session-files`, projectId));
}

export function fetchTaskComments(id: string, projectId?: string): Promise<TaskComment[]> {
  return api<TaskComment[]>(withProjectId(`/tasks/${id}/comments`, projectId));
}

export function addTaskComment(id: string, text: string, author?: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/comments`, projectId), {
    method: "POST",
    body: JSON.stringify({ text, author }),
  });
}

export function updateTaskComment(id: string, commentId: string, text: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/comments/${commentId}`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ text }),
  });
}

export function deleteTaskComment(id: string, commentId: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/comments/${commentId}`, projectId), {
    method: "DELETE",
  });
}

// ── Task Document API Functions ──────────────────────────────────────────────

export function fetchTaskDocuments(taskId: string, projectId?: string): Promise<TaskDocument[]> {
  return api<TaskDocument[]>(withProjectId(`/tasks/${taskId}/documents`, projectId));
}

export function fetchTaskDocument(taskId: string, key: string, projectId?: string): Promise<TaskDocument> {
  return api<TaskDocument>(withProjectId(`/tasks/${taskId}/documents/${key}`, projectId));
}

export function fetchTaskDocumentRevisions(taskId: string, key: string, projectId?: string): Promise<TaskDocumentRevision[]> {
  return api<TaskDocumentRevision[]>(withProjectId(`/tasks/${taskId}/documents/${key}/revisions`, projectId));
}

export interface FetchAllDocumentsOptions {
  q?: string;
  limit?: number;
  offset?: number;
}

export async function fetchAllDocuments(
  options?: FetchAllDocumentsOptions,
  projectId?: string,
): Promise<TaskDocumentWithTask[]> {
  const params = new URLSearchParams();
  if (options?.q) params.set("q", options.q);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  const queryString = params.toString();
  const path = `/documents${queryString ? `?${queryString}` : ""}`;
  return api<TaskDocumentWithTask[]>(withProjectId(path, projectId));
}

export function putTaskDocument(
  taskId: string,
  key: string,
  content: string,
  opts?: { author?: string; metadata?: Record<string, unknown> },
  projectId?: string,
): Promise<TaskDocument> {
  return api<TaskDocument>(withProjectId(`/tasks/${taskId}/documents/${key}`, projectId), {
    method: "PUT",
    body: JSON.stringify({
      content,
      author: opts?.author,
      metadata: opts?.metadata,
    }),
  });
}

export function deleteTaskDocument(taskId: string, key: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/tasks/${taskId}/documents/${key}`, projectId), {
    method: "DELETE",
  });
}

export function addSteeringComment(id: string, text: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/steer`, projectId), {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function requestSpecRevision(id: string, feedback: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/spec/revise`, projectId), {
    method: "POST",
    body: JSON.stringify({ feedback }),
  });
}

export function rebuildTaskSpec(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/spec/rebuild`, projectId), {
    method: "POST",
  });
}

export function refineTask(id: string, feedback: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/refine`, projectId), {
    method: "POST",
    body: JSON.stringify({ feedback }),
  });
}

// --- Models API ---

/** Available AI model info returned by the models endpoint */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
}

/** Response from the models endpoint */
export interface ModelsResponse {
  models: ModelInfo[];
  favoriteProviders: string[];
  favoriteModels: string[];
}

/** Fetch available AI models from the model registry along with favoriteProviders */
export function fetchModels(): Promise<ModelsResponse> {
  return api<ModelsResponse>("/models");
}

// --- Usage API ---

/** Pace information for weekly usage windows */
export interface UsagePace {
  status: "ahead" | "on-track" | "behind";
  percentElapsed: number; // 0-100, how much of the window time has passed
  message: string; // e.g., "Using 15% over your limit pace"
}

/** Usage window for a provider (e.g., "Session (5h)", "Weekly") */
export interface UsageWindow {
  label: string;
  percentUsed: number; // 0-100
  percentLeft: number; // 0-100
  resetText: string | null; // e.g., "resets in 2h"
  resetMs?: number; // ms until reset
  resetAt?: string; // ISO 8601 timestamp of when the window resets (machine-readable)
  windowDurationMs?: number; // total window length
  pace?: UsagePace; // pace indicator for weekly windows
}

/** Provider usage data */
export interface ProviderUsage {
  name: string;
  icon: string; // emoji
  status: "ok" | "error" | "no-auth";
  error?: string;
  plan?: string | null;
  email?: string | null;
  windows: UsageWindow[];
}

/** Fetch usage data from all configured AI providers */
export function fetchUsageData(): Promise<{ providers: ProviderUsage[] }> {
  return api<{ providers: ProviderUsage[] }>("/usage");
}

// --- Auth API ---

/** OAuth provider with current authentication status */
export interface AuthProvider {
  id: string;
  name: string;
  authenticated: boolean;
  /** Whether this provider uses OAuth or API key authentication */
  type?: "oauth" | "api_key";
}

/** Fetch authentication status for all OAuth providers */
export function fetchAuthStatus(): Promise<{ providers: AuthProvider[] }> {
  return api<{ providers: AuthProvider[] }>("/auth/status");
}

/** Initiate OAuth login for a provider. Returns the auth URL to open in a new tab. */
export function loginProvider(provider: string): Promise<{ url: string; instructions?: string }> {
  return api<{ url: string; instructions?: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

/** Logout from a provider, removing stored credentials. */
export function logoutProvider(provider: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/auth/logout", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

/** Save an API key for an API-key-backed provider. */
export function saveApiKey(provider: string, apiKey: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/auth/api-key", {
    method: "POST",
    body: JSON.stringify({ provider, apiKey }),
  });
}

/** Remove an API key for an API-key-backed provider. */
export function clearApiKey(provider: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/auth/api-key", {
    method: "DELETE",
    body: JSON.stringify({ provider }),
  });
}

// --- GitHub Import API ---

/** GitHub issue returned by the fetch endpoint */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
}

/** Fetch open GitHub issues from a repository */
export function apiFetchGitHubIssues(
  owner: string,
  repo: string,
  limit?: number,
  labels?: string[]
): Promise<GitHubIssue[]> {
  return api<GitHubIssue[]>("/github/issues/fetch", {
    method: "POST",
    body: JSON.stringify({ owner, repo, limit, labels }),
  });
}

/** Import a specific GitHub issue as a fn task */
export function apiImportGitHubIssue(owner: string, repo: string, issueNumber: number, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId("/github/issues/import", projectId), {
    method: "POST",
    body: JSON.stringify({ owner, repo, issueNumber }),
  });
}

/** Result of a batch import operation for a single issue */
export interface BatchImportResult {
  issueNumber: number;
  success: boolean;
  taskId?: string;
  error?: string;
  skipped?: boolean;
  retryAfter?: number;
}

/** Batch import multiple GitHub issues as fn tasks with throttling */
export function apiBatchImportGitHubIssues(
  owner: string,
  repo: string,
  issueNumbers: number[],
  delayMs?: number,
  projectId?: string
): Promise<{ results: BatchImportResult[] }> {
  return api<{ results: BatchImportResult[] }>(withProjectId("/github/issues/batch-import", projectId), {
    method: "POST",
    body: JSON.stringify({ owner, repo, issueNumbers, delayMs }),
  });
}

// --- GitHub Pull Request Import API ---

/** GitHub pull request returned by the fetch endpoint */
export interface GitHubPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  headBranch: string;
  baseBranch: string;
}

/** Fetch open GitHub pull requests from a repository */
export function apiFetchGitHubPulls(
  owner: string,
  repo: string,
  limit?: number
): Promise<GitHubPull[]> {
  return api<GitHubPull[]>("/github/pulls/fetch", {
    method: "POST",
    body: JSON.stringify({ owner, repo, limit }),
  });
}

/** Import a specific GitHub pull request as a fn review task */
export function apiImportGitHubPull(owner: string, repo: string, prNumber: number, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId("/github/pulls/import", projectId), {
    method: "POST",
    body: JSON.stringify({ owner, repo, prNumber }),
  });
}

// --- Git Remote Detection API ---

/** Git remote info returned by the remotes endpoint */
export interface GitRemote {
  name: string;
  owner: string;
  repo: string;
  url: string;
}

/** Fetch GitHub remotes from the current git repository */
export function fetchGitRemotes(projectId?: string): Promise<GitRemote[]> {
  return api<GitRemote[]>(withProjectId("/git/remotes", projectId));
}

/** Detailed git remote info with fetch and push URLs */
export interface GitRemoteDetailed {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/** Fetch all git remotes with their fetch and push URLs */
export function fetchGitRemotesDetailed(projectId?: string): Promise<GitRemoteDetailed[]> {
  return api<GitRemoteDetailed[]>(withProjectId("/git/remotes/detailed", projectId));
}

/** Add a new git remote */
export function addGitRemote(name: string, url: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId("/git/remotes", projectId), {
    method: "POST",
    body: JSON.stringify({ name, url }),
  });
}

/** Remove a git remote */
export function removeGitRemote(name: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/git/remotes/${encodeURIComponent(name)}`, projectId), {
    method: "DELETE",
  });
}

/** Rename a git remote */
export function renameGitRemote(name: string, newName: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/git/remotes/${encodeURIComponent(name)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ newName }),
  });
}

/** Update the URL for a git remote */
export function updateGitRemoteUrl(name: string, url: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/git/remotes/${encodeURIComponent(name)}/url`, projectId), {
    method: "PUT",
    body: JSON.stringify({ url }),
  });
}

// --- PR Management API ---

/** PR info returned by PR endpoints */
export interface PrInfo {
  url: string;
  number: number;
  status: "open" | "closed" | "merged";
  title: string;
  headBranch: string;
  baseBranch: string;
  commentCount: number;
  lastCommentAt?: string;
  lastCheckedAt?: string;
}

export interface PrCheckStatus {
  name: string;
  required: boolean;
  state: string;
}

export interface PrStatusResponse {
  prInfo: PrInfo;
  stale: boolean;
  automationStatus?: string | null;
}

export interface PrRefreshResponse {
  prInfo: PrInfo;
  mergeReady: boolean;
  blockingReasons: string[];
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: PrCheckStatus[];
  automationStatus?: string | null;
}

/** Create a GitHub PR for a task */
export function createPr(
  id: string,
  params: { title: string; body?: string; base?: string },
  projectId?: string,
): Promise<PrInfo> {
  return api<PrInfo>(withProjectId(`/tasks/${id}/pr/create`, projectId), {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/** Fetch cached PR status for a task */
export function fetchPrStatus(id: string, projectId?: string): Promise<PrStatusResponse> {
  return api<PrStatusResponse>(withProjectId(`/tasks/${id}/pr/status`, projectId));
}

/** Force refresh PR status from GitHub */
export function refreshPrStatus(id: string, projectId?: string): Promise<PrRefreshResponse> {
  return api<PrRefreshResponse>(withProjectId(`/tasks/${id}/pr/refresh`, projectId), {
    method: "POST",
  });
}

// --- Issue Management API ---

/** Re-export GitHub badge-related types for convenience */
export type { IssueInfo, BatchStatusResult, BatchStatusEntry } from "@fusion/core";

/** Fetch cached issue status for a task */
export function fetchIssueStatus(id: string, projectId?: string): Promise<{ issueInfo: import("@fusion/core").IssueInfo; stale: boolean }> {
  return api<{ issueInfo: import("@fusion/core").IssueInfo; stale: boolean }>(withProjectId(`/tasks/${id}/issue/status`, projectId));
}

/** Force refresh issue status from GitHub */
export function refreshIssueStatus(id: string, projectId?: string): Promise<import("@fusion/core").IssueInfo> {
  return api<import("@fusion/core").IssueInfo>(withProjectId(`/tasks/${id}/issue/refresh`, projectId), {
    method: "POST",
  });
}

/** Batch-refresh cached GitHub badge status for multiple tasks. */
export async function fetchBatchStatus(taskIds: string[], projectId?: string): Promise<BatchStatusResult> {
  const response = await api<BatchStatusResponse>(withProjectId("/github/batch/status", projectId), {
    method: "POST",
    body: JSON.stringify({ taskIds }),
  });

  return response.results;
}

// --- Terminal API ---

/** Terminal exec response - returns sessionId for streaming output via SSE */
export interface TerminalExecResponse {
  sessionId: string;
}

/** Terminal session status and output */
export interface TerminalSession {
  id: string;
  command: string;
  running: boolean;
  exitCode: number | null;
  output: string;
  startTime: string;
}

/** Terminal SSE event types */
export interface TerminalOutputEvent {
  type: "stdout" | "stderr";
  data: string;
}

/** Terminal exit event from SSE */
export interface TerminalExitEvent {
  type: "exit";
  exitCode: number;
}

/** Execute a shell command and get a session ID for streaming output */
export function execTerminalCommand(command: string, projectId?: string): Promise<TerminalExecResponse> {
  return api<TerminalExecResponse>(withProjectId("/terminal/exec", projectId), {
    method: "POST",
    body: JSON.stringify({ command }),
  });
}

/** Get terminal session status and accumulated output */
export function getTerminalSession(sessionId: string): Promise<TerminalSession> {
  return api<TerminalSession>(`/terminal/sessions/${encodeURIComponent(sessionId)}`);
}

/** Kill a running terminal session */
export function killTerminalSession(sessionId: string, signal?: "SIGTERM" | "SIGKILL" | "SIGINT"): Promise<{ killed: boolean; sessionId: string }> {
  return api<{ killed: boolean; sessionId: string }>(`/terminal/sessions/${encodeURIComponent(sessionId)}/kill`, {
    method: "POST",
    body: JSON.stringify({ signal: signal ?? "SIGTERM" }),
  });
}

/** Get the SSE stream URL for a terminal session */
export function getTerminalStreamUrl(sessionId: string): string {
  return `/api/terminal/sessions/${encodeURIComponent(sessionId)}/stream`;
}

// --- PTY Terminal API (WebSocket-based) ---

/** PTY Terminal session response */
export interface PtyTerminalSession {
  sessionId: string;
  shell: string;
  cwd: string;
}

/** PTY Terminal session info for listing */
export interface PtyTerminalSessionInfo {
  id: string;
  cwd: string;
  shell: string;
  createdAt: string;
}

/** Create a new PTY terminal session */
export function createTerminalSession(
  cwd?: string,
  cols?: number,
  rows?: number,
  projectId?: string
): Promise<PtyTerminalSession> {
  return api<PtyTerminalSession>(withProjectId("/terminal/sessions", projectId), {
    method: "POST",
    body: JSON.stringify({ cwd, cols, rows }),
  });
}

/** Kill a PTY terminal session */
export function killPtyTerminalSession(sessionId: string, projectId?: string): Promise<{ killed: boolean }> {
  return api<{ killed: boolean }>(withProjectId(`/terminal/sessions/${encodeURIComponent(sessionId)}`, projectId), {
    method: "DELETE",
  });
}

/** List active PTY terminal sessions */
export function listTerminalSessions(projectId?: string): Promise<PtyTerminalSessionInfo[]> {
  return api<PtyTerminalSessionInfo[]>(withProjectId("/terminal/sessions", projectId));
}

// --- Git Management API ---

/** Current git status */
export interface GitStatus {
  branch: string;
  commit: string;
  isDirty: boolean;
  ahead: number;
  behind: number;
}

/** Git commit info */
export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  parents: string[];
}

/** Git branch info */
export interface GitBranch {
  name: string;
  isCurrent: boolean;
  remote?: string;
  lastCommitDate?: string;
}

/** Git worktree info */
export interface GitWorktree {
  path: string;
  branch?: string;
  isMain: boolean;
  isBare: boolean;
  taskId?: string;
}

/** Result of a fetch operation */
export interface GitFetchResult {
  fetched: boolean;
  message: string;
}

/** Result of a pull operation */
export interface GitPullResult {
  success: boolean;
  message: string;
  conflict?: boolean;
}

/** Result of a push operation */
export interface GitPushResult {
  success: boolean;
  message: string;
}

/** Fetch current git status */
export function fetchGitStatus(projectId?: string): Promise<GitStatus> {
  return api<GitStatus>(withProjectId("/git/status", projectId));
}

/** Fetch recent commits */
export function fetchGitCommits(limit?: number, projectId?: string): Promise<GitCommit[]> {
  const query = limit ? `?limit=${limit}` : "";
  return api<GitCommit[]>(withProjectId(`/git/commits${query}`, projectId));
}

/** Fetch diff for a specific commit */
export function fetchCommitDiff(hash: string, projectId?: string): Promise<{ stat: string; patch: string }> {
  return api<{ stat: string; patch: string }>(withProjectId(`/git/commits/${hash}/diff`, projectId));
}

/** Fetch local commits ahead of the upstream tracking branch (commits to push) */
export function fetchAheadCommits(projectId?: string): Promise<GitCommit[]> {
  return api<GitCommit[]>(withProjectId("/git/commits/ahead", projectId));
}

/** Fetch recent commits for a specific remote */
export function fetchRemoteCommits(remote: string, ref?: string, limit?: number, projectId?: string): Promise<GitCommit[]> {
  const params = new URLSearchParams();
  if (ref) params.set("ref", ref);
  if (limit) params.set("limit", String(limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<GitCommit[]>(withProjectId(`/git/remotes/${encodeURIComponent(remote)}/commits${query}`, projectId));
}

/** Fetch all local branches */
export function fetchGitBranches(projectId?: string): Promise<GitBranch[]> {
  return api<GitBranch[]>(withProjectId("/git/branches", projectId));
}

/** Fetch recent commits for a specific branch */
export function fetchBranchCommits(branchName: string, limit?: number, projectId?: string): Promise<GitCommit[]> {
  const query = limit ? `?limit=${limit}` : "";
  return api<GitCommit[]>(withProjectId(`/git/branches/${encodeURIComponent(branchName)}/commits${query}`, projectId));
}

/** Fetch all worktrees */
export function fetchGitWorktrees(projectId?: string): Promise<GitWorktree[]> {
  return api<GitWorktree[]>(withProjectId("/git/worktrees", projectId));
}

/** Create a new branch */
export function createBranch(name: string, base?: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId("/git/branches", projectId), {
    method: "POST",
    body: JSON.stringify({ name, base }),
  });
}

/** Checkout an existing branch */
export function checkoutBranch(name: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/git/branches/${encodeURIComponent(name)}/checkout`, projectId), {
    method: "POST",
  });
}

/** Delete a branch */
export function deleteBranch(name: string, force?: boolean, projectId?: string): Promise<void> {
  const query = force ? "?force=true" : "";
  return api<void>(withProjectId(`/git/branches/${encodeURIComponent(name)}${query}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch from remote */
export function fetchRemote(remote?: string, projectId?: string): Promise<GitFetchResult> {
  return api<GitFetchResult>(withProjectId("/git/fetch", projectId), {
    method: "POST",
    body: JSON.stringify({ remote }),
  });
}

/** Pull current branch */
export function pullBranch(projectId?: string): Promise<GitPullResult> {
  return api<GitPullResult>(withProjectId("/git/pull", projectId), {
    method: "POST",
  });
}

/** Push current branch */
export function pushBranch(projectId?: string): Promise<GitPushResult> {
  return api<GitPushResult>(withProjectId("/git/push", projectId), {
    method: "POST",
  });
}

/** Git stash entry */
export interface GitStash {
  index: number;
  message: string;
  date: string;
  branch: string;
}

/** Individual file change with staging status */
export interface GitFileChange {
  file: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked";
  staged: boolean;
  oldFile?: string;
}

/** Fetch stash list */
export function fetchGitStashList(projectId?: string): Promise<GitStash[]> {
  return api<GitStash[]>(withProjectId("/git/stashes", projectId));
}

/** Create a new stash */
export function createStash(message?: string, projectId?: string): Promise<{ message: string }> {
  return api<{ message: string }>(withProjectId("/git/stashes", projectId), {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

/** Apply a stash entry */
export function applyStash(index: number, drop?: boolean, projectId?: string): Promise<{ message: string }> {
  return api<{ message: string }>(withProjectId(`/git/stashes/${index}/apply`, projectId), {
    method: "POST",
    body: JSON.stringify({ drop }),
  });
}

/** Drop a stash entry */
export function dropStash(index: number, projectId?: string): Promise<{ message: string }> {
  return api<{ message: string }>(withProjectId(`/git/stashes/${index}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch unstaged diff (working directory changes) */
export function fetchUnstagedDiff(projectId?: string): Promise<{ stat: string; patch: string }> {
  return api<{ stat: string; patch: string }>(withProjectId("/git/diff", projectId));
}

/** Fetch file changes (staged and unstaged) */
export function fetchFileChanges(projectId?: string): Promise<GitFileChange[]> {
  return api<GitFileChange[]>(withProjectId("/git/changes", projectId));
}

/** Stage specific files */
export function stageFiles(files: string[], projectId?: string): Promise<{ staged: string[] }> {
  return api<{ staged: string[] }>(withProjectId("/git/stage", projectId), {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

/** Unstage specific files */
export function unstageFiles(files: string[], projectId?: string): Promise<{ unstaged: string[] }> {
  return api<{ unstaged: string[] }>(withProjectId("/git/unstage", projectId), {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

/** Create a commit */
export function createCommit(message: string, projectId?: string): Promise<{ hash: string; message: string }> {
  return api<{ hash: string; message: string }>(withProjectId("/git/commit", projectId), {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

/** Discard changes in working directory for specific files */
export function discardChanges(files: string[], projectId?: string): Promise<{ discarded: string[] }> {
  return api<{ discarded: string[] }>(withProjectId("/git/discard", projectId), {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

// --- File Browser API ---

/** File node in directory listing */
export interface FileNode {
  name: string;
  type: "file" | "directory";
  size?: number;
  mtime?: string;
}

/** File listing response */
export interface FileListResponse {
  path: string;
  entries: FileNode[];
}

/** File content response */
export interface FileContentResponse {
  content: string;
  mtime: string;
  size: number;
}

/** Save file response */
export interface SaveFileResponse {
  success: true;
  mtime: string;
  size: number;
}

/** List files in task directory */
export function fetchFileList(taskId: string, path?: string, projectId?: string): Promise<FileListResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return api<FileListResponse>(withProjectId(`/tasks/${taskId}/files${query}`, projectId));
}

/** Fetch file content */
export function fetchFileContent(taskId: string, filePath: string, projectId?: string): Promise<FileContentResponse> {
  return api<FileContentResponse>(withProjectId(`/tasks/${taskId}/files/${encodeURIComponent(filePath)}`, projectId));
}

/** Save file content */
export function saveFileContent(taskId: string, filePath: string, content: string, projectId?: string): Promise<SaveFileResponse> {
  return api<SaveFileResponse>(withProjectId(`/tasks/${taskId}/files/${encodeURIComponent(filePath)}`, projectId), {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

// --- Workspace File Browser API ---

export interface WorkspaceTaskInfo {
  id: string;
  title?: string;
  worktree: string;
}

export interface WorkspaceListResponse {
  project: string;
  tasks: WorkspaceTaskInfo[];
}

/** Fetch available file browser workspaces. */
export function fetchWorkspaces(projectId?: string): Promise<WorkspaceListResponse> {
  return api<WorkspaceListResponse>(withProjectId("/workspaces", projectId));
}

/** List files in a workspace (project root or task worktree). */
export function fetchWorkspaceFileList(workspace: string, path?: string, projectId?: string): Promise<FileListResponse> {
  const query = new URLSearchParams({ workspace });
  if (path) {
    query.set("path", path);
  }
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileListResponse>(`/files?${query.toString()}`);
}

/** Fetch file content from a workspace. */
export function fetchWorkspaceFileContent(workspace: string, filePath: string, projectId?: string): Promise<FileContentResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileContentResponse>(`/files/${encodeURIComponent(filePath)}?${query.toString()}`);
}

/** Save file content to a workspace. */
export function saveWorkspaceFileContent(workspace: string, filePath: string, content: string, projectId?: string): Promise<SaveFileResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<SaveFileResponse>(`/files/${encodeURIComponent(filePath)}?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

// --- Workspace File Operations API (Copy, Move, Delete, Rename, Download) ---

/** File operation response for copy/move/delete/rename operations */
export interface FileOperationResponse {
  success: true;
  message?: string;
}

/** Copy a file or directory to a new location within a workspace. */
export function copyFile(workspace: string, filePath: string, destination: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}/copy?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ destination }),
  });
}

/** Move a file or directory to a new location within a workspace. */
export function moveFile(workspace: string, filePath: string, destination: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}/move?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ destination }),
  });
}

/** Delete a file or directory within a workspace. */
export function deleteFile(workspace: string, filePath: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}/delete?${query.toString()}`, {
    method: "POST",
  });
}

/** Rename a file or directory within a workspace. */
export function renameFile(workspace: string, filePath: string, newName: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}/rename?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ newName }),
  });
}

/** Get the download URL for a single file in a workspace. */
export function downloadFileUrl(workspace: string, filePath: string, projectId?: string): string {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return `/api/files/${encodeURIComponent(filePath)}/download?${query.toString()}`;
}

/** Get the download URL for a folder as ZIP in a workspace. */
export function downloadZipUrl(workspace: string, filePath: string, projectId?: string): string {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return `/api/files/${encodeURIComponent(filePath)}/download-zip?${query.toString()}`;
}

// --- Planning Mode API ---

/** Planning session state returned from API */
export interface PlanningSession {
  sessionId: string;
  currentQuestion: PlanningQuestion | null;
  summary: PlanningSummary | null;
}

export interface SubtaskItem {
  id: string;
  title: string;
  description: string;
  suggestedSize: "S" | "M" | "L";
  dependsOn: string[];
}

/** SSE event types for planning session streaming */
export type PlanningStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "question"; data: PlanningQuestion }
  | { type: "summary"; data: PlanningSummary }
  | { type: "error"; data: string }
  | { type: "complete"; data: Record<string, never> };

/** Start a new planning session with an initial plan */
export function startPlanning(initialPlan: string, projectId?: string): Promise<PlanningSession> {
  return api<PlanningSession>(withProjectId("/planning/start", projectId), {
    method: "POST",
    body: JSON.stringify({ initialPlan }),
  });
}

/** Start a new planning session with AI streaming support */
export function startPlanningStreaming(
  initialPlan: string,
  projectId?: string,
  modelOverride?: { planningModelProvider?: string; planningModelId?: string }
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/planning/start-streaming", projectId), {
    method: "POST",
    body: JSON.stringify({
      initialPlan,
      planningModelProvider: modelOverride?.planningModelProvider,
      planningModelId: modelOverride?.planningModelId,
    }),
  });
}

/** Submit a response to the current planning question */
export function respondToPlanning(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
  tabId?: string,
): Promise<PlanningSession> {
  return api<PlanningSession>(withProjectId("/planning/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses, tabId }),
  });
}

/** Retry a failed planning session turn */
export function retryPlanningSession(
  sessionId: string,
  projectId?: string,
  tabId?: string,
): Promise<{ success: boolean; sessionId: string }> {
  return api<{ success: boolean; sessionId: string }>(
    withProjectId(`/planning/${encodeURIComponent(sessionId)}/retry`, projectId),
    {
      method: "POST",
      ...(tabId ? { body: JSON.stringify({ tabId }) } : {}),
    },
  );
}

/** Cancel an active planning session */
export function cancelPlanning(sessionId: string, projectId?: string, tabId?: string): Promise<void> {
  return api<void>(withProjectId("/planning/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, tabId }),
  });
}

/** Create a task from a completed planning session */
export function createTaskFromPlanning(sessionId: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId("/planning/create-task", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

/** Start subtask breakdown from a completed planning session */
export function startPlanningBreakdown(
  sessionId: string,
  projectId?: string,
): Promise<{ sessionId: string; subtasks: SubtaskItem[] }> {
  return api<{ sessionId: string; subtasks: SubtaskItem[] }>(
    withProjectId("/planning/start-breakdown", projectId),
    {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    },
  );
}

/** Create multiple tasks from a completed planning session */
export function createTasksFromPlanning(
  planningSessionId: string,
  subtasks: Array<{
    id: string;
    title: string;
    description: string;
    suggestedSize: "S" | "M" | "L";
    dependsOn: string[];
  }>,
  projectId?: string,
): Promise<{ tasks: Task[] }> {
  return api<{ tasks: Task[] }>(withProjectId("/planning/create-tasks", projectId), {
    method: "POST",
    body: JSON.stringify({ planningSessionId, subtasks }),
  });
}


type StreamConnectionState = "connected" | "reconnecting";

interface ResilientEventSourceOptions {
  maxReconnectAttempts?: number;
  onConnectionStateChange?: (state: StreamConnectionState) => void;
  onFatalError?: (message: string) => void;
}

interface ResilientEventHandlers {
  onOpen?: () => void;
  onMessage?: (event: MessageEvent) => void;
  events?: Record<string, (event: MessageEvent) => void>;
}

function appendLastEventId(url: string, lastEventId: number | null): string {
  if (lastEventId === null || lastEventId <= 0) {
    return url;
  }

  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}lastEventId=${encodeURIComponent(String(lastEventId))}`;
}

function createResilientEventSource(
  url: string,
  handlers: ResilientEventHandlers,
  options: ResilientEventSourceOptions = {},
): { close: () => void; isConnected: () => boolean } {
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
  let eventSource: EventSource | null = null;
  let closedByUser = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSeenEventId: number | null = null;
  let reconnectingNotified = false;

  const shouldDispatch = (event: MessageEvent): boolean => {
    const rawId = event.lastEventId;
    if (!rawId) {
      return true;
    }

    const parsedId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(parsedId)) {
      return true;
    }

    if (lastSeenEventId !== null && parsedId <= lastSeenEventId) {
      return false;
    }

    lastSeenEventId = parsedId;
    return true;
  };

  const connect = (): void => {
    if (closedByUser) return;

    const nextUrl = appendLastEventId(url, lastSeenEventId);
    const source = new EventSource(nextUrl);
    eventSource = source;

    source.onopen = () => {
      reconnectAttempts = 0;
      reconnectingNotified = false;
      options.onConnectionStateChange?.("connected");
      handlers.onOpen?.();
    };

    source.onmessage = (event) => {
      const messageEvent = event as MessageEvent;
      if (!shouldDispatch(messageEvent)) return;
      handlers.onMessage?.(messageEvent);
    };

    for (const [eventName, handler] of Object.entries(handlers.events ?? {})) {
      source.addEventListener(eventName, (event: Event) => {
        const messageEvent = event as MessageEvent;
        if (!shouldDispatch(messageEvent)) return;
        handler(messageEvent);
      });
    }

    source.onerror = () => {
      if (closedByUser || eventSource !== source) return;

      const readyState = source.readyState;
      if (readyState === EventSource.CONNECTING) {
        if (!reconnectingNotified) {
          reconnectingNotified = true;
          options.onConnectionStateChange?.("reconnecting");
        }
        return;
      }

      source.close();

      if (reconnectAttempts >= maxReconnectAttempts) {
        options.onFatalError?.("Connection lost");
        return;
      }

      reconnectingNotified = true;
      options.onConnectionStateChange?.("reconnecting");
      reconnectAttempts += 1;

      const delayMs = Math.min(1000 * 2 ** (reconnectAttempts - 1), 30000);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };
  };

  connect();

  return {
    close: () => {
      closedByUser = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      eventSource?.close();
    },
    isConnected: () => !closedByUser && eventSource?.readyState === EventSource.OPEN,
  };
}

function startKeepAlive(
  sessionId: string,
  projectId?: string,
  intervalMs = 25_000,
): { stop: () => void } {
  const timer = setInterval(() => {
    void pingSession(sessionId, projectId).catch(() => {
      // Best-effort keepalive: ignore failures so streams remain active.
    });
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

/** Get the SSE stream URL for a planning session */
export function getPlanningStreamUrl(sessionId: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/planning/${encodeURIComponent(sessionId)}/stream`, projectId));
}

/** Connect to planning session SSE stream and handle events
 * 
 * Returns an object with:
 * - close: function to close the connection
 */
export function connectPlanningStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: PlanningSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = getPlanningStreamUrl(sessionId, projectId);
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const resilient = createResilientEventSource(
    url,
    {
      onOpen: () => {
        stopKeepAlive();
        keepAlive = startKeepAlive(sessionId, projectId);
      },
      onMessage: (event) => {
        if (event.data.startsWith(":")) return;
      },
      events: {
        thinking: (event) => {
          try {
            handlers.onThinking?.(JSON.parse(event.data));
          } catch {
            handlers.onThinking?.(event.data);
          }
        },
        question: (event) => {
          try {
            handlers.onQuestion?.(JSON.parse(event.data) as PlanningQuestion);
          } catch (err) {
            console.error("[planning] Failed to parse question event:", err);
          }
        },
        summary: (event) => {
          try {
            handlers.onSummary?.(JSON.parse(event.data) as PlanningSummary);
          } catch (err) {
            console.error("[planning] Failed to parse summary event:", err);
          }
        },
        error: (event) => {
          try {
            const parsed = JSON.parse(event.data);
            handlers.onError?.(parsed.message || parsed);
          } catch {
            handlers.onError?.(event.data || "Stream error");
          }
          connection?.close();
        },
        complete: () => {
          handlers.onComplete?.();
          connection?.close();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => {
        stopKeepAlive();
        handlers.onError?.(message);
      },
    },
  );

  connection = {
    close: () => {
      stopKeepAlive();
      resilient.close();
    },
    isConnected: resilient.isConnected,
  };

  return connection;
}

// ── Automation / Scheduled Tasks ──────────────────────────────────

/**
 * Options for scheduling scope (global vs project-scoped automations/routines).
 * When scope is "project", projectId must be provided.
 */
export type SchedulingScopeOptions = {
  /** Scope for scheduling operations: "global" or "project". Defaults to "project" on the server. */
  scope?: "global" | "project";
  /** Project ID required when scope is "project". */
  projectId?: string;
};

/**
 * Build URL suffix with scope and projectId query params.
 * Mirrors the backend's parseScopeParam logic: scope goes in query param.
 */
function withSchedulingScope(path: string, options?: SchedulingScopeOptions): string {
  const params = new URLSearchParams();
  if (options?.scope) {
    params.set("scope", options.scope);
  }
  if (options?.projectId) {
    params.set("projectId", options.projectId);
  }
  const suffix = params.toString();
  if (!suffix) return path;
  return `${path}?${suffix}`;
}

/** Response from the manual run trigger endpoint. */
export interface AutomationRunResponse {
  schedule: ScheduledTask;
  result: AutomationRunResult;
}

export function fetchAutomations(options?: SchedulingScopeOptions): Promise<ScheduledTask[]> {
  return api<ScheduledTask[]>(withSchedulingScope("/automations", options));
}

export function fetchAutomation(id: string, options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  return api<ScheduledTask>(withSchedulingScope(`/automations/${id}`, options));
}

export function createAutomation(input: ScheduledTaskCreateInput, options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  // Forward all input fields including scope metadata (scope may be set on input or in options)
  return api<ScheduledTask>(withSchedulingScope("/automations", options), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAutomation(id: string, updates: ScheduledTaskUpdateInput, options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  // Forward all update fields including scope metadata
  return api<ScheduledTask>(withSchedulingScope(`/automations/${id}`, options), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteAutomation(id: string, options?: SchedulingScopeOptions): Promise<void> {
  await api(withSchedulingScope(`/automations/${id}`, options), {
    method: "DELETE",
  });
}

export function runAutomation(id: string, options?: SchedulingScopeOptions): Promise<AutomationRunResponse> {
  return api<AutomationRunResponse>(withSchedulingScope(`/automations/${id}/run`, options), {
    method: "POST",
  });
}

export function toggleAutomation(id: string, options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  return api<ScheduledTask>(withSchedulingScope(`/automations/${id}/toggle`, options), {
    method: "POST",
  });
}

export function reorderAutomationSteps(id: string, stepIds: string[], options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  return api<ScheduledTask>(withSchedulingScope(`/automations/${id}/steps/reorder`, options), {
    method: "POST",
    body: JSON.stringify({ stepIds }),
  });
}

// ── Routines API ────────────────────────────────────────────────

export interface RoutineRunResponse {
  routine: Routine;
  result: RoutineExecutionResult;
}

export function fetchRoutines(options?: SchedulingScopeOptions): Promise<Routine[]> {
  return api<Routine[]>(withSchedulingScope("/routines", options));
}

export function fetchRoutine(id: string, options?: SchedulingScopeOptions): Promise<Routine> {
  return api<Routine>(withSchedulingScope(`/routines/${id}`, options));
}

export function createRoutine(input: RoutineCreateInput, options?: SchedulingScopeOptions): Promise<Routine> {
  // Forward all input fields including scope metadata
  return api<Routine>(withSchedulingScope("/routines", options), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateRoutine(id: string, updates: RoutineUpdateInput, options?: SchedulingScopeOptions): Promise<Routine> {
  // Forward all update fields including scope metadata
  return api<Routine>(withSchedulingScope(`/routines/${id}`, options), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteRoutine(id: string, options?: SchedulingScopeOptions): Promise<void> {
  await api(withSchedulingScope(`/routines/${id}`, options), {
    method: "DELETE",
  });
}

export function runRoutine(id: string, options?: SchedulingScopeOptions): Promise<RoutineRunResponse> {
  return api<RoutineRunResponse>(withSchedulingScope(`/routines/${id}/trigger`, options), {
    method: "POST",
  });
}

export function fetchRoutineRuns(id: string, options?: SchedulingScopeOptions): Promise<RoutineExecutionResult[]> {
  return api<RoutineExecutionResult[]>(withSchedulingScope(`/routines/${id}/runs`, options));
}

export function triggerRoutineWebhook(id: string, payload?: Record<string, unknown>, options?: SchedulingScopeOptions): Promise<RoutineRunResponse> {
  return api<RoutineRunResponse>(withSchedulingScope(`/routines/${id}/webhook`, options), {
    method: "POST",
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

// ── Activity Log API ────────────────────────────────────────────

/** Re-export ActivityLogEntry type from core for convenience */
export type { ActivityLogEntry, ActivityEventType } from "@fusion/core";

/** Fetch activity log entries */
export function fetchActivityLog(options?: { limit?: number; since?: string; type?: ActivityEventType; projectId?: string }): Promise<ActivityLogEntry[]> {
  const search = new URLSearchParams();
  if (options?.limit !== undefined) search.set("limit", String(options.limit));
  if (options?.since !== undefined) search.set("since", options.since);
  if (options?.type !== undefined) search.set("type", options.type);
  if (options?.projectId) search.set("projectId", options.projectId);
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return api<ActivityLogEntry[]>(`/activity${suffix}`);
}

/** Clear all activity log entries */
export function clearActivityLog(projectId?: string): Promise<{ success: boolean }> {
  const path = withProjectId("/activity", projectId);
  return api<{ success: boolean }>(path, { method: "DELETE" });
}

// ── Workflow Steps ─────────────────────────────────────────────────────

/** Fetch all workflow step definitions */
export function fetchWorkflowSteps(projectId?: string): Promise<WorkflowStep[]> {
  return api<WorkflowStep[]>(withProjectId("/workflow-steps", projectId));
}

/** Create a new workflow step */
export function createWorkflowStep(input: WorkflowStepInput, projectId?: string): Promise<WorkflowStep> {
  return api<WorkflowStep>(withProjectId("/workflow-steps", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update a workflow step */
export function updateWorkflowStep(id: string, updates: Partial<WorkflowStepInput>, projectId?: string): Promise<WorkflowStep> {
  return api<WorkflowStep>(withProjectId(`/workflow-steps/${id}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a workflow step */
export function deleteWorkflowStep(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/workflow-steps/${id}`, projectId), { method: "DELETE" });
}

/** Refine a workflow step's prompt using AI */
export function refineWorkflowStepPrompt(id: string, projectId?: string): Promise<{ prompt: string; workflowStep: WorkflowStep }> {
  return api<{ prompt: string; workflowStep: WorkflowStep }>(withProjectId(`/workflow-steps/${id}/refine`, projectId), {
    method: "POST",
  });
}

/** Fetch workflow step results for a task */
export function fetchWorkflowResults(taskId: string, projectId?: string): Promise<WorkflowStepResult[]> {
  return api<WorkflowStepResult[]>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/workflow-results`, projectId));
}

// ── Workflow Step Templates ──────────────────────────────────────────────

/** Re-export WorkflowStepTemplate type from core */
export type { WorkflowStepTemplate } from "@fusion/core";

/** Fetch all built-in workflow step templates */
export function fetchWorkflowStepTemplates(): Promise<{ templates: import("@fusion/core").WorkflowStepTemplate[] }> {
  return api<{ templates: import("@fusion/core").WorkflowStepTemplate[] }>("/workflow-step-templates");
}

/** Create a workflow step from a built-in template */
export function createWorkflowStepFromTemplate(templateId: string, projectId?: string): Promise<WorkflowStep> {
  return api<WorkflowStep>(withProjectId(`/workflow-step-templates/${encodeURIComponent(templateId)}/create`, projectId), {
    method: "POST",
  });
}

// ── Scripts API ────────────────────────────────────────────────────────

/** Script entry returned from the API */
export interface ScriptEntry {
  name: string;
  command: string;
}

/** Result of running a script via POST /api/scripts/:name/run */
export interface ScriptRunResult {
  sessionId: string;
  command: string;
}

/** Fetch all saved scripts from project settings */
export function fetchScripts(projectId?: string): Promise<Record<string, string>> {
  return api<Record<string, string>>(withProjectId("/scripts", projectId));
}

/** Add or update a script */
export function addScript(name: string, command: string, projectId?: string): Promise<ScriptEntry> {
  return api<ScriptEntry>(withProjectId("/scripts", projectId), {
    method: "POST",
    body: JSON.stringify({ name, command }),
  });
}

/** Remove a script by name */
export function removeScript(name: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/scripts/${encodeURIComponent(name)}`, projectId), { method: "DELETE" });
}

/** Run a saved script by name */
export function runScript(name: string, args?: string[], projectId?: string): Promise<ScriptRunResult> {
  return api<ScriptRunResult>(withProjectId(`/scripts/${encodeURIComponent(name)}/run`, projectId), {
    method: "POST",
    body: JSON.stringify({ args }),
  });
}

// ── AI Text Refinement API ────────────────────────────────────────────

/** Refinement types for AI text refinement */
export type RefinementType = "clarify" | "add-details" | "expand" | "simplify";

/** Response from text refinement endpoint */
export interface RefineTextResponse {
  refined: string;
}

/**
 * Refine task description text using AI.
 * @param text - The text to refine (1-2000 characters)
 * @param type - The refinement type: clarify, add-details, expand, or simplify
 * @param projectId - Optional project ID for scoped settings resolution
 * @returns The refined text
 * @throws Error with message for rate limit (429), invalid type (422), validation (400), or server errors
 */
export async function refineText(text: string, type: RefinementType, projectId?: string): Promise<string> {
  const response = await api<RefineTextResponse>(withProjectId("/ai/refine-text", projectId), {
    method: "POST",
    body: JSON.stringify({ text, type }),
  });
  return response.refined;
}

/**
 * Error messages for refineText failures (to use with toast notifications).
 */
export const REFINE_ERROR_MESSAGES = {
  /** Rate limit exceeded (429) */
  RATE_LIMIT: "Too many refinement requests. Please wait an hour.",
  /** Invalid refinement type (422) */
  INVALID_TYPE: "Invalid refinement option selected.",
  /** Network or server errors */
  NETWORK: "Failed to refine text. Please try again.",
} as const;

/**
 * Get user-friendly error message for a refineText error.
 * @param error - The error thrown by refineText
 * @returns A user-friendly error message suitable for toast display
 */
export function getRefineErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return REFINE_ERROR_MESSAGES.NETWORK;
  }

  const message = error.message.toLowerCase();

  // Rate limit errors (429)
  if (message.includes("rate limit") || message.includes("429")) {
    return REFINE_ERROR_MESSAGES.RATE_LIMIT;
  }

  // Invalid type errors (422)
  if (message.includes("invalid") && message.includes("type")) {
    return REFINE_ERROR_MESSAGES.INVALID_TYPE;
  }

  // Text validation errors (400) - pass through from backend
  if (
    message.startsWith("text must") ||
    message.includes("text is required") ||
    message.includes("type is required")
  ) {
    return error.message;
  }

  // Default network/server error
  return REFINE_ERROR_MESSAGES.NETWORK;
}


export function startSubtaskBreakdown(description: string, projectId?: string): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/subtasks/start-streaming", projectId), {
    method: "POST",
    body: JSON.stringify({ description }),
  });
}

export function retrySubtaskSession(
  sessionId: string,
  projectId?: string,
  tabId?: string,
): Promise<{ success: boolean; sessionId: string }> {
  return api<{ success: boolean; sessionId: string }>(
    withProjectId(`/subtasks/${encodeURIComponent(sessionId)}/retry`, projectId),
    {
      method: "POST",
      ...(tabId ? { body: JSON.stringify({ tabId }) } : {}),
    },
  );
}

export function getSubtaskStreamUrl(sessionId: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/subtasks/${encodeURIComponent(sessionId)}/stream`, projectId));
}

export function connectSubtaskStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onSubtasks?: (data: SubtaskItem[]) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const resilient = createResilientEventSource(
    getSubtaskStreamUrl(sessionId, projectId),
    {
      onOpen: () => {
        stopKeepAlive();
        keepAlive = startKeepAlive(sessionId, projectId);
      },
      events: {
        thinking: (event) => {
          try {
            handlers.onThinking?.(JSON.parse(event.data));
          } catch {
            handlers.onThinking?.(event.data);
          }
        },
        subtasks: (event) => {
          try {
            handlers.onSubtasks?.(JSON.parse(event.data) as SubtaskItem[]);
          } catch (err) {
            console.error("[subtasks] Failed to parse subtasks event:", err);
          }
        },
        error: (event) => {
          try {
            const parsedData = JSON.parse(event.data);
            const errorMessage = typeof parsedData === "string" && parsedData.length > 0 ? parsedData : null;
            handlers.onError?.(errorMessage || "Stream error");
          } catch {
            handlers.onError?.("Stream error");
          }
          connection?.close();
        },
        complete: () => {
          handlers.onComplete?.();
          connection?.close();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => {
        stopKeepAlive();
        handlers.onError?.(message);
      },
    },
  );

  connection = {
    close: () => {
      stopKeepAlive();
      resilient.close();
    },
    isConnected: resilient.isConnected,
  };

  return connection;
}

export function createTasksFromBreakdown(
  sessionId: string,
  subtasks: SubtaskItem[],
  parentTaskId?: string,
  projectId?: string,
): Promise<{ tasks: Task[]; parentTaskClosed?: boolean }> {
  return api<{ tasks: Task[]; parentTaskClosed?: boolean }>(withProjectId("/subtasks/create-tasks", projectId), {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      parentTaskId,
      subtasks: subtasks.map((subtask) => ({
        tempId: subtask.id,
        title: subtask.title,
        description: subtask.description,
        size: subtask.suggestedSize,
        dependsOn: subtask.dependsOn,
      })),
    }),
  });
}

export function cancelSubtaskBreakdown(sessionId: string, projectId?: string, tabId?: string): Promise<void> {
  return api<void>(withProjectId("/subtasks/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, tabId }),
  });
}

// ── Agent API ────────────────────────────────────────────────────────────

import type {
  Agent,
  AgentDetail,
  AgentCapability,
  AgentState,
  AgentHeartbeatEvent,
  AgentHeartbeatRun,
  AgentCreateInput,
  AgentUpdateInput,
  AgentTaskSession,
  AgentStats,
  HeartbeatInvocationSource,
  OrgTreeNode,
  AgentReflection,
  AgentPerformanceSummary,
  ReflectionTrigger,
  AgentBudgetStatus,
} from "@fusion/core";
export type { Agent, AgentDetail, AgentCapability, AgentState, AgentHeartbeatEvent, AgentHeartbeatRun, AgentCreateInput, AgentUpdateInput, AgentTaskSession, AgentStats, HeartbeatInvocationSource, OrgTreeNode, AgentReflection, AgentPerformanceSummary, ReflectionTrigger, AgentBudgetStatus };

function withProjectId(path: string, projectId?: string): string {
  if (!projectId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}projectId=${encodeURIComponent(projectId)}`;
}

/**
 * Rewrite a path to route through the node proxy when viewing a remote node.
 * When nodeId is provided and differs from localNodeId (i.e., it's a remote node),
 * rewrites the path from `/tasks` to `/proxy/${encodeURIComponent(nodeId)}/tasks`.
 * When nodeId is undefined or matches localNodeId, returns the path unchanged.
 */
export function withNodeId(path: string, nodeId?: string, localNodeId?: string): string {
  if (!nodeId || nodeId === localNodeId) return path;
  // Rewrite path to proxy endpoint: /tasks -> /proxy/:nodeId/tasks
  // Strip leading /api prefix if present since proxyApi adds it
  const apiPrefix = "/api";
  const pathWithoutPrefix = path.startsWith(apiPrefix) ? path.slice(apiPrefix.length) : path;
  return `/proxy/${encodeURIComponent(nodeId)}${pathWithoutPrefix}`;
}

/**
 * Make an API request, optionally routing through the node proxy for remote nodes.
 * When nodeId is provided and differs from localNodeId, the request is routed
 * through /api/proxy/:nodeId/... instead of directly.
 */
export function proxyApi<T>(path: string, opts?: RequestInit & { nodeId?: string; localNodeId?: string }): Promise<T> {
  // Extract nodeId/localNodeId from opts before passing to api()
  const { nodeId, localNodeId, ...fetchOpts } = opts ?? {};
  const resolvedPath = withNodeId(path, nodeId, localNodeId);
  return api<T>(resolvedPath, fetchOpts);
}

/** Fetch all agents, optionally filtered by state or role */
export function fetchAgents(
  filter?: { state?: AgentState; role?: AgentCapability; includeEphemeral?: boolean },
  projectId?: string,
): Promise<Agent[]> {
  const params = new URLSearchParams();
  if (filter?.state) params.set("state", filter.state);
  if (filter?.role) params.set("role", filter.role);
  if (filter?.includeEphemeral === true) params.set("includeEphemeral", "true");
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<Agent[]>(`/agents${query}`);
}

/** Fetch a single agent with heartbeat history */
export function fetchAgent(agentId: string, projectId?: string): Promise<AgentDetail> {
  return api<AgentDetail>(withProjectId(`/agents/${encodeURIComponent(agentId)}`, projectId));
}

/** Create a new agent */
export function createAgent(input: AgentCreateInput, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId("/agents", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update an agent */
export function updateAgent(agentId: string, updates: AgentUpdateInput, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Update agent custom instructions */
export function updateAgentInstructions(
  agentId: string,
  instructions: { instructionsPath?: string; instructionsText?: string },
  projectId?: string,
): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/instructions`, projectId), {
    method: "PATCH",
    body: JSON.stringify(instructions),
  });
}

/** Fetch agent soul/personality text */
export function fetchAgentSoul(agentId: string, projectId?: string): Promise<{ soul: string | null }> {
  return api<{ soul: string | null }>(withProjectId(`/agents/${encodeURIComponent(agentId)}/soul`, projectId));
}

/** Update agent soul/personality text */
export function updateAgentSoul(agentId: string, soul: string, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/soul`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ soul }),
  });
}

/** Fetch per-agent memory text */
export function fetchAgentMemory(agentId: string, projectId?: string): Promise<{ memory: string | null }> {
  return api<{ memory: string | null }>(withProjectId(`/agents/${encodeURIComponent(agentId)}/memory`, projectId));
}

/** Update per-agent memory text */
export function updateAgentMemory(agentId: string, memory: string, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/memory`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ memory }),
  });
}

/** Update an agent's state */
export function updateAgentState(agentId: string, state: AgentState, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/state`, projectId), {
    method: "POST",
    body: JSON.stringify({ state }),
  });
}

/** Delete an agent */
export function deleteAgent(agentId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/agents/${encodeURIComponent(agentId)}`, projectId), {
    method: "DELETE",
  });
}

/** Record a heartbeat for an agent */
export function recordAgentHeartbeat(
  agentId: string,
  status: "ok" | "missed" | "recovered" = "ok",
  projectId?: string,
): Promise<AgentHeartbeatEvent> {
  return api<AgentHeartbeatEvent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/heartbeat`, projectId), {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

/** Fetch heartbeat history for an agent */
export function fetchAgentHeartbeats(agentId: string, limit?: number, projectId?: string): Promise<AgentHeartbeatEvent[]> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentHeartbeatEvent[]>(`/agents/${encodeURIComponent(agentId)}/heartbeats${query}`);
}

/** Fetch heartbeat runs for an agent */
export function fetchAgentRuns(agentId: string, limit?: number, projectId?: string): Promise<AgentHeartbeatRun[]> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentHeartbeatRun[]>(`/agents/${encodeURIComponent(agentId)}/runs${query}`);
}

/** Fetch a single heartbeat run detail */
export function fetchAgentRunDetail(agentId: string, runId: string, projectId?: string): Promise<AgentHeartbeatRun> {
  return api<AgentHeartbeatRun>(withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, projectId));
}

/** Fetch agent logs for a specific run's time window */
export function fetchAgentRunLogs(agentId: string, runId: string, projectId?: string): Promise<AgentLogEntry[]> {
  return api<AgentLogEntry[]>(withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/logs`, projectId));
}

/** Manually start a heartbeat run for an agent */
export function startAgentRun(
  agentId: string,
  projectId?: string,
  options?: { source?: HeartbeatInvocationSource; triggerDetail?: string },
): Promise<AgentHeartbeatRun> {
  const source = options?.source ?? "manual";
  const triggerDetail = options?.triggerDetail ?? "Agent activated via dashboard";
  return api<AgentHeartbeatRun>(withProjectId(`/agents/${encodeURIComponent(agentId)}/runs`, projectId), {
    method: "POST",
    body: JSON.stringify({ source, triggerDetail }),
  });
}

/** Stop an active heartbeat run for an agent */
export function stopAgentRun(
  agentId: string,
  projectId?: string,
): Promise<{ ok: boolean; runId?: string; message?: string }> {
  return api<{ ok: boolean; runId?: string; message?: string }>(
    withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/stop`, projectId),
    {
      method: "POST",
    },
  );
}

// ── Run-Audit & Timeline API ────────────────────────────────────────────────

/** Valid domain filters for run-audit queries. */
export type RunAuditDomainFilter = "database" | "git" | "filesystem";

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
  domain: "database" | "git" | "filesystem";
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
export function fetchAgentStats(projectId?: string): Promise<AgentStats> {
  return api<AgentStats>(withProjectId("/agents/stats", projectId));
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

// ── Agent Import API ────────────────────────────────────────────────────────

/** Company entry from companies.sh catalog */
export interface CompanyEntry {
  slug: string;
  name: string;
  tagline?: string;
  repo?: string;
  website?: string;
  installs?: number;
}

/** Response from companies.sh catalog API */
export interface CompaniesCatalogResponse {
  companies: CompanyEntry[];
  error?: string;
}

/** Result of importing agents from an Agent Companies source */
export interface AgentImportResult {
  companyName?: string;
  companySlug?: string;
  agents?: Array<{ name: string; role: string; title?: string; skills?: string[] }>;
  /** In dry-run mode: agent name strings. In live mode: agent objects with id and name. */
  created: string[] | Array<{ id: string; name: string }>;
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
  dryRun?: boolean;
}

/**
 * Fetch companies from companies.sh catalog.
 * Returns both companies and optional error message for proper error surfacing.
 */
export function fetchCompanies(): Promise<CompaniesCatalogResponse> {
  return api<CompaniesCatalogResponse>("/agents/companies");
}

/**
 * Import agents from an Agent Companies source via the API.
 * Uses dryRun for preview, then actual import.
 *
 * Supports four input modes:
 * - { manifest: string } - raw AGENTS.md content
 * - { source: string } - server directory path
 * - { agents: unknown[] } - parsed agent manifests
 * - { importSource: "companies.sh", companySlug: string } - companies.sh catalog entry
 */
export function importAgents(
  input:
    | { manifest: string }
    | { source: string }
    | { agents: unknown[] }
    | { importSource: "companies.sh"; companySlug: string },
  options?: { dryRun?: boolean; skipExisting?: boolean },
  projectId?: string,
): Promise<AgentImportResult> {
  return api<AgentImportResult>(withProjectId("/agents/import", projectId), {
    method: "POST",
    body: JSON.stringify({
      ...input,
      dryRun: options?.dryRun ?? false,
      skipExisting: options?.skipExisting ?? true,
    }),
  });
}

// ── Agent Generation API ────────────────────────────────────────────────────

/** Generated agent specification returned by the AI */
export interface AgentGenerationSpec {
  /** Display name for the agent */
  title: string;
  /** Single emoji icon */
  icon: string;
  /** Agent capability/role */
  role: string;
  /** Brief description of the agent's purpose */
  description: string;
  /** Detailed system prompt in markdown */
  systemPrompt: string;
  /** Suggested thinking level */
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
  /** Suggested max turns (1-500) */
  maxTurns: number;
}

/** State of an agent generation session */
export interface AgentGenerationSession {
  id: string;
  roleDescription: string;
  spec?: AgentGenerationSpec;
  createdAt: string;
  updatedAt: string;
}

/** Start an agent generation session with a role description */
export function startAgentGeneration(role: string, projectId?: string): Promise<{ sessionId: string; roleDescription: string }> {
  return api<{ sessionId: string; roleDescription: string }>(withProjectId("/agents/generate/start", projectId), {
    method: "POST",
    body: JSON.stringify({ role }),
  });
}

/** Generate the agent specification for an existing session */
export function generateAgentSpec(sessionId: string, projectId?: string): Promise<{ spec: AgentGenerationSpec }> {
  return api<{ spec: AgentGenerationSpec }>(withProjectId("/agents/generate/spec", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

/** Get the current state of an agent generation session */
export function getAgentGenerationSession(sessionId: string, projectId?: string): Promise<{ session: AgentGenerationSession }> {
  return api<{ session: AgentGenerationSession }>(withProjectId(`/agents/generate/${encodeURIComponent(sessionId)}`, projectId));
}

/** Cancel and clean up an agent generation session */
export function cancelAgentGeneration(sessionId: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/agents/generate/${encodeURIComponent(sessionId)}`, projectId), {
    method: "DELETE",
  });
}

// --- Backup API ---

/** Backup metadata from the API */
export interface BackupInfo {
  filename: string;
  createdAt: string;
  size: number;
  path: string;
}

/** Result of listing backups */
export interface BackupListResponse {
  backups: BackupInfo[];
  count: number;
  totalSize: number;
}

/** Result of creating a backup */
export interface BackupCreateResponse {
  success: boolean;
  backupPath?: string;
  output?: string;
  deletedCount?: number;
  error?: string;
}

/** Fetch all database backups */
export function fetchBackups(projectId?: string): Promise<BackupListResponse> {
  return api<BackupListResponse>(withProjectId("/backups", projectId));
}

/** Create a new database backup immediately */
export function createBackup(projectId?: string): Promise<BackupCreateResponse> {
  return api<BackupCreateResponse>(withProjectId("/backups", projectId), { method: "POST" });
}

// --- Settings Export/Import API ---

/** Exported settings data structure */
export interface SettingsExportData {
  version: 1;
  exportedAt: string;
  source?: string;
  global?: GlobalSettings;
  project?: Partial<ProjectSettings>;
}

/** Result of importing settings */
export interface SettingsImportResponse {
  success: boolean;
  globalCount: number;
  projectCount: number;
  error?: string;
}

/** Export settings as JSON */
export function exportSettings(scope?: 'global' | 'project' | 'both', projectId?: string): Promise<SettingsExportData> {
  const path = withProjectId("/settings/export", projectId);
  const scopedPath = scope ? `${path}${path.includes("?") ? "&" : "?"}scope=${encodeURIComponent(scope)}` : path;
  return api<SettingsExportData>(scopedPath);
}

/** Import settings from JSON data */
export function importSettings(
  data: SettingsExportData,
  options?: { scope?: 'global' | 'project' | 'both'; merge?: boolean },
  projectId?: string
): Promise<SettingsImportResponse> {
  return api<SettingsImportResponse>(withProjectId("/settings/import", projectId), {
    method: "POST",
    body: JSON.stringify({
      data,
      scope: options?.scope ?? "both",
      merge: options?.merge ?? true,
    }),
  });
}

// --- AI Summarization API ---

/** Response from title summarization endpoint */
export interface SummarizeTitleResponse {
  title: string;
}

/** Summarize a task description into a concise title using AI.
 * @param description - The task description to summarize (must be 201-2000 chars)
 * @param provider - Optional AI model provider (e.g., "anthropic")
 * @param modelId - Optional AI model ID (e.g., "claude-sonnet-4-5")
 * @param projectId - Optional project ID for scoped settings resolution
 * @returns The generated title (guaranteed ≤60 characters)
 * @throws Error with descriptive message for 400/429/503 errors
 */
export async function summarizeTitle(
  description: string,
  provider?: string,
  modelId?: string,
  projectId?: string
): Promise<string> {
  const url = projectId
    ? `/api/ai/summarize-title?projectId=${encodeURIComponent(projectId)}`
    : "/api/ai/summarize-title";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description, provider, modelId }),
  });

  const contentType = res.headers.get("content-type") ?? "";
  const bodyText = await res.text();
  const isJson = contentType.includes("application/json");

  if (!isJson) {
    throw new Error(`API returned non-JSON response: ${bodyText.slice(0, 100)}`);
  }

  const data = JSON.parse(bodyText) as { title?: string; error?: string };

  if (!res.ok) {
    const errorMessage = data.error || "Request failed";
    if (res.status === 400) {
      throw new Error(`Invalid request: ${errorMessage}`);
    } else if (res.status === 429) {
      throw new Error(`Rate limit exceeded: ${errorMessage}`);
    } else if (res.status === 503) {
      throw new Error(`AI service temporarily unavailable: ${errorMessage}`);
    } else {
      throw new Error(errorMessage);
    }
  }

  if (!data.title) {
    throw new Error("API returned empty title");
  }

  return data.title;
}

// ── Project Management API (Multi-Project Support) ───────────────────────

/** Project information returned by project endpoints */
export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  status: "active" | "paused" | "errored" | "initializing";
  isolationMode: "in-process" | "child-process";
  nodeId?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
}

/** Project health metrics */
export interface ProjectHealth {
  projectId: string;
  status: "active" | "paused" | "errored" | "initializing";
  activeTaskCount: number;
  inFlightAgentCount: number;
  lastActivityAt?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  totalTasksCompleted: number;
  totalTasksFailed: number;
  averageTaskDurationMs?: number;
  updatedAt: string;
}

/** Executor state values */
export type ExecutorState = "idle" | "running" | "paused";

/** Aggregated executor statistics for the status bar.
 * 
 * Counts (runningTaskCount, blockedTaskCount, queuedTaskCount, inReviewCount, stuckTaskCount)
 * are derived client-side from the same tasks array shared with the board, ensuring
 * the footer counts always match the column counts displayed on screen.
 * The API returns settings-based values (globalPause, enginePaused, maxConcurrent) and
 * lastActivityAt from the activity log.
 * 
 * The executorState is derived from:
 * - "idle": globalPause is true OR (enginePaused is true AND runningTaskCount is 0)
 * - "paused": enginePaused is true AND runningTaskCount > 0
 * - "running": globalPause is false AND enginePaused is false AND runningTaskCount > 0
 */
export interface ExecutorStats {
  /** Number of tasks currently in "in-progress" column */
  runningTaskCount: number;
  /** Number of tasks with blockedBy field set (waiting on file overlap) */
  blockedTaskCount: number;
  /** Number of "in-progress" tasks with no activity for > 10 minutes */
  stuckTaskCount: number;
  /** Number of tasks in "todo" column */
  queuedTaskCount: number;
  /** Number of tasks in "in-review" column */
  inReviewCount: number;
  /** Derived executor state: "idle", "running", or "paused" */
  executorState: ExecutorState;
  /** Maximum concurrent tasks allowed from settings */
  maxConcurrent: number;
  /** ISO timestamp of most recent task event from activity log */
  lastActivityAt?: string;
}

/** Unified activity feed entry */
export interface ActivityFeedEntry {
  id: string;
  timestamp: string;
  type: "task:created" | "task:moved" | "task:updated" | "task:deleted" | "task:merged" | "task:failed" | "settings:updated";
  projectId: string;
  projectName: string;
  taskId?: string;
  taskTitle?: string;
  details: string;
  metadata?: Record<string, unknown>;
}

/** Input for creating a new project */
export interface ProjectCreateInput {
  name: string;
  path: string;
  isolationMode?: "in-process" | "child-process";
  nodeId?: string;
}

/** Node information returned by node endpoints */
export interface NodeInfo {
  id: NodeConfig["id"];
  name: NodeConfig["name"];
  type: NodeConfig["type"];
  url?: NodeConfig["url"];
  apiKey?: NodeConfig["apiKey"];
  status: NodeStatus;
  capabilities?: NodeConfig["capabilities"];
  maxConcurrent: NodeConfig["maxConcurrent"];
  createdAt: NodeConfig["createdAt"];
  updatedAt: NodeConfig["updatedAt"];
}

/** Node discovered over local network mDNS/DNS-SD */
export interface DiscoveredNodeInfo {
  name: string;
  host: string;
  port: number;
  nodeType: "local" | "remote";
  nodeId?: string;
  discoveredAt: string;
  lastSeenAt: string;
}

/** Input for creating a new node */
export interface NodeCreateInput {
  name: string;
  type: "local" | "remote";
  url?: string;
  apiKey?: string;
  maxConcurrent?: number;
}

/** Input for updating an existing node */
export type NodeUpdateInput = Partial<Pick<NodeCreateInput, "name" | "type" | "url" | "apiKey" | "maxConcurrent">> & {
  status?: NodeStatus;
  capabilities?: string[];
};

/** Result from a node health check */
export interface NodeHealthCheckResult {
  nodeId: string;
  status: NodeStatus;
  responseTimeMs?: number;
  error?: string;
  checkedAt: string;
}

/** Runtime metrics for a node */
export interface NodeMetrics {
  nodeId: string;
  activeTaskCount: number;
  inFlightAgentCount: number;
  uptimeMs: number;
  lastActivityAt?: string;
}

/** Options for fetching activity feed */
export interface FeedOptions {
  limit?: number;
  since?: string;
  projectId?: string;
  type?: ActivityFeedEntry["type"];
}

/** Global concurrency state across all projects */
export interface GlobalConcurrencyState {
  globalMaxConcurrent: number;
  currentlyActive: number;
  queuedCount: number;
  projectsActive: Record<string, number>;
}

/** First run status response */
export interface FirstRunStatus {
  hasProjects: boolean;
  singleProjectPath: string | null;
}

/** Setup state for first-run wizard */
export interface SetupState {
  /** The first-run state: fresh-install, needs-migration, setup-wizard, normal-operation */
  state: "fresh-install" | "needs-migration" | "setup-wizard" | "normal-operation";
  /** Projects detected on the filesystem (not yet registered) */
  detectedProjects: Array<{
    path: string;
    name: string;
    hasDb: boolean;
  }>;
  /** Whether the central database exists */
  hasCentralDb: boolean;
  /** Projects already registered in the central database */
  registeredProjects: Array<{
    id: string;
    name: string;
    path: string;
  }>;
}

/** Input for completing setup */
export interface CompleteSetupInput {
  projects: Array<{
    path: string;
    name: string;
    isolationMode?: "in-process" | "child-process";
  }>;
}

/** Result of completing setup */
export interface CompleteSetupResult {
  success: boolean;
  projectsRegistered: string[];
  errors: string[];
}

/** Fetch all registered projects */
export function fetchProjects(): Promise<ProjectInfo[]> {
  return api<ProjectInfo[]>("/projects");
}

/** Fetch all registered nodes */
export function fetchNodes(): Promise<NodeInfo[]> {
  return api<NodeInfo[]>("/nodes");
}

/** Fetch discovery runtime status and active config. */
export function fetchDiscoveryStatus(): Promise<{ active: boolean; config: DiscoveryConfig | null }> {
  return api<{ active: boolean; config: DiscoveryConfig | null }>("/discovery/status");
}

/** Start local-network discovery service. */
export function startDiscovery(input?: {
  broadcast?: boolean;
  listen?: boolean;
  port?: number;
}): Promise<{ success: boolean; config: DiscoveryConfig }> {
  return api<{ success: boolean; config: DiscoveryConfig }>("/discovery/start", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

/** Stop local-network discovery service. */
export function stopDiscovery(): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/discovery/stop", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** Fetch currently discovered nodes from mDNS/DNS-SD. */
export function fetchDiscoveredNodes(): Promise<DiscoveredNodeInfo[]> {
  return api<DiscoveredNodeInfo[]>("/discovery/nodes");
}

/** Register a discovered node into the central node registry. */
export function connectDiscoveredNode(input: {
  name: string;
  host: string;
  port: number;
  apiKey?: string;
}): Promise<NodeInfo> {
  return api<NodeInfo>("/discovery/connect", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Register a new node */
export function registerNode(input: NodeCreateInput): Promise<NodeInfo> {
  return api<NodeInfo>("/nodes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch a single node by ID */
export function fetchNode(id: string): Promise<NodeInfo> {
  return api<NodeInfo>(`/nodes/${encodeURIComponent(id)}`);
}

/** Update an existing node */
export function updateNode(id: string, updates: NodeUpdateInput): Promise<NodeInfo> {
  return api<NodeInfo>(`/nodes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Unregister a node */
export function unregisterNode(id: string): Promise<void> {
  return api<void>(`/nodes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Trigger a node health check */
export async function checkNodeHealth(id: string): Promise<NodeHealthCheckResult> {
  const result = await api<Partial<NodeHealthCheckResult> & { status: NodeStatus }>(`/nodes/${encodeURIComponent(id)}/health-check`, {
    method: "POST",
  });

  return {
    nodeId: result.nodeId ?? id,
    status: result.status,
    responseTimeMs: result.responseTimeMs,
    error: result.error,
    checkedAt: result.checkedAt ?? new Date().toISOString(),
  };
}

/** Fetch runtime metrics for a node */
export async function fetchNodeMetrics(id: string): Promise<SystemMetrics | null> {
  return api<SystemMetrics | null>(`/nodes/${encodeURIComponent(id)}/metrics`);
}

/** Fetch full mesh topology state (all nodes with their metrics and known peers) */
export async function fetchMeshState(): Promise<NodeMeshState[]> {
  return api<NodeMeshState[]>("/mesh/state");
}

/** Browse directory entries for the directory picker */
export interface BrowseDirectoryResult {
  currentPath: string;
  parentPath: string | null;
  entries: Array<{ name: string; path: string; hasChildren: boolean }>;
}

export function browseDirectory(
  path?: string,
  showHidden?: boolean,
  nodeId?: string,
  localNodeId?: string,
): Promise<BrowseDirectoryResult> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (showHidden) params.set("showHidden", "true");
  if (nodeId) params.set("nodeId", nodeId);
  const qs = params.toString();
  const fullPath = `/browse-directory${qs ? `?${qs}` : ""}`;
  // If nodeId is for a remote node, route through proxy
  if (nodeId && nodeId !== localNodeId) {
    return proxyApi<BrowseDirectoryResult>(fullPath, { nodeId, localNodeId });
  }
  return api<BrowseDirectoryResult>(fullPath);
}

/** Register a new project */
export function registerProject(input: ProjectCreateInput): Promise<ProjectInfo> {
  return api<ProjectInfo>("/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Unregister a project */
export function unregisterProject(id: string): Promise<void> {
  return api<void>(`/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Fetch health metrics for a specific project */
export function fetchProjectHealth(id: string): Promise<ProjectHealth> {
  return api<ProjectHealth>(`/projects/${encodeURIComponent(id)}/health`);
}

/** Fetch executor statistics for the status bar.
 * 
 * Returns settings-based values and lastActivityAt.
 * Counts are derived client-side from the tasks array.
 */
export function fetchExecutorStats(projectId?: string): Promise<{
  globalPause: boolean;
  enginePaused: boolean;
  maxConcurrent: number;
  lastActivityAt?: string;
}> {
  return api<{
    globalPause: boolean;
    enginePaused: boolean;
    maxConcurrent: number;
    lastActivityAt?: string;
  }>(withProjectId("/executor/stats", projectId));
}

/** Fetch unified activity feed */
export function fetchActivityFeed(options?: FeedOptions): Promise<ActivityFeedEntry[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.since) params.set("since", options.since);
  if (options?.projectId) params.set("projectId", options.projectId);
  if (options?.type) params.set("type", options.type);
  
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<ActivityFeedEntry[]>(`/activity-feed${query}`);
}

/** Pause a project */
export function pauseProject(id: string): Promise<ProjectInfo> {
  return api<ProjectInfo>(`/projects/${encodeURIComponent(id)}/pause`, {
    method: "POST",
  });
}

/** Resume a paused project */
export function resumeProject(id: string): Promise<ProjectInfo> {
  return api<ProjectInfo>(`/projects/${encodeURIComponent(id)}/resume`, {
    method: "POST",
  });
}

/** Fetch first run status to detect if user needs setup wizard */
export function fetchFirstRunStatus(): Promise<FirstRunStatus> {
  return api<FirstRunStatus>("/first-run-status");
}

/** Fetch detailed setup state including detected projects */
export function fetchSetupState(): Promise<SetupState> {
  return api<SetupState>("/setup-state");
}

/** Complete first-run setup by registering projects */
export function completeSetup(input: CompleteSetupInput): Promise<CompleteSetupResult> {
  return api<CompleteSetupResult>("/complete-setup", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch global concurrency state */
export function fetchGlobalConcurrency(): Promise<GlobalConcurrencyState> {
  return api<GlobalConcurrencyState>("/global-concurrency");
}

/** Update the system-wide concurrency limit shared across all projects. */
export function updateGlobalConcurrency(input: {
  globalMaxConcurrent: number;
}): Promise<GlobalConcurrencyState> {
  return api<GlobalConcurrencyState>("/global-concurrency", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** Fetch tasks for a specific project */
export function fetchProjectTasks(projectId: string, limit?: number, offset?: number): Promise<Task[]> {
  const params = new URLSearchParams();
  params.set("projectId", projectId);
  if (limit !== undefined) params.set("limit", String(limit));
  if (offset !== undefined) params.set("offset", String(offset));
  return api<Task[]>(`/tasks?${params.toString()}`);
}

/** Fetch project-specific config */
export function fetchProjectConfig(projectId: string): Promise<{ maxConcurrent: number; rootDir: string }> {
  return api<{ maxConcurrent: number; rootDir: string }>(`/projects/${encodeURIComponent(projectId)}/config`);
}

/** Detected project information */
export interface DetectedProject {
  path: string;
  suggestedName: string;
  existing: boolean;
}

/** Detect projects in a base path */
export function detectProjects(basePath?: string): Promise<{ projects: DetectedProject[] }> {
  return api<{ projects: DetectedProject[] }>("/projects/detect", {
    method: "POST",
    body: JSON.stringify({ basePath }),
  });
}

/** Fetch a single project by ID */
export function fetchProject(id: string): Promise<ProjectInfo> {
  return api<ProjectInfo>(`/projects/${encodeURIComponent(id)}`);
}

/** Update an existing project */
export function updateProject(id: string, updates: Partial<ProjectInfo>): Promise<ProjectInfo> {
  return api<ProjectInfo>(`/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

// ── Task Diff API ──────────────────────────────────────────────────────────

/** Task diff information */
export interface TaskDiff {
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted";
    additions: number;
    deletions: number;
    patch: string;
  }>;
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}

/** Fetch diff for a task's changes */
export function fetchTaskDiff(taskId: string, worktree?: string, projectId?: string): Promise<TaskDiff> {
  const params = new URLSearchParams();
  if (worktree) params.set("worktree", worktree);
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<TaskDiff>(`/tasks/${encodeURIComponent(taskId)}/diff${query}`);
}

/** Individual file diff */
export interface TaskFileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  diff: string;
  oldPath?: string;
}

/** Fetch file diffs for a task */
export function fetchTaskFileDiffs(taskId: string, projectId?: string): Promise<TaskFileDiff[]> {
  return api<TaskFileDiff[]>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/file-diffs`, projectId));
}

// ── Mission API ───────────────────────────────────────────────────────────

/** Mission status values */
export type MissionStatus = "planning" | "active" | "blocked" | "complete" | "archived";

/** Milestone status values */
export type MilestoneStatus = "planning" | "active" | "blocked" | "complete";

/** Slice status values */
export type SliceStatus = "pending" | "active" | "complete";

/** Feature status values */
export type FeatureStatus = "defined" | "triaged" | "in-progress" | "done";

/** Autopilot state values for mission autonomous progression */
export type AutopilotState = "inactive" | "watching" | "activating" | "completing";

/** Autopilot status for a mission */
export interface AutopilotStatus {
  enabled: boolean;
  state: AutopilotState;
  watched: boolean;
  lastActivityAt?: string;
  nextScheduledCheck?: string;
}

/** Mission entity */
export interface Mission {
  id: string;
  title: string;
  description?: string;
  status: MissionStatus;
  interviewState: "not_started" | "in_progress" | "completed" | "needs_update";
  autoAdvance?: boolean;
  /** When true, enable autopilot monitoring system for this mission */
  autopilotEnabled?: boolean;
  /** Current autopilot runtime state */
  autopilotState?: AutopilotState;
  /** ISO-8601 timestamp of last autopilot activity */
  lastAutopilotActivityAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Status summary for a mission card, computed from hierarchy */
export interface MissionSummary {
  totalMilestones: number;
  completedMilestones: number;
  totalFeatures: number;
  completedFeatures: number;
  progressPercent: number;
}

/** Mission with optional status summary (returned by list endpoint) */
export type MissionWithSummary = Mission & { summary?: MissionSummary };

/** Milestone entity */
export interface Milestone {
  id: string;
  missionId: string;
  title: string;
  description?: string;
  status: MilestoneStatus;
  orderIndex: number;
  interviewState: "not_started" | "in_progress" | "completed" | "needs_update";
  dependencies: string[];
  createdAt: string;
  updatedAt: string;
}

/** Slice entity */
export interface Slice {
  id: string;
  milestoneId: string;
  title: string;
  description?: string;
  status: SliceStatus;
  orderIndex: number;
  activatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Feature entity */
export interface MissionFeature {
  id: string;
  sliceId: string;
  taskId?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  status: FeatureStatus;
  createdAt: string;
  updatedAt: string;
}

/** Milestone with slices (each slice has features) */
export interface MilestoneWithSlices extends Milestone {
  slices: SliceWithFeatures[];
}

/** Slice with features */
export interface SliceWithFeatures extends Slice {
  features: MissionFeature[];
}

/** Full mission hierarchy */
export interface MissionWithHierarchy extends Mission {
  milestones: MilestoneWithSlices[];
}

/** Fetch all missions with status summary */
export function fetchMissions(projectId?: string): Promise<MissionWithSummary[]> {
  return api<MissionWithSummary[]>(withProjectId("/missions", projectId));
}

/** Create a new mission */
export function createMission(input: { title: string; description?: string; autoAdvance?: boolean; autopilotEnabled?: boolean }, projectId?: string): Promise<Mission> {
  return api<Mission>(withProjectId("/missions", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Get mission with full hierarchy */
export function fetchMission(missionId: string, projectId?: string): Promise<MissionWithHierarchy> {
  return api<MissionWithHierarchy>(withProjectId(`/missions/${encodeURIComponent(missionId)}`, projectId));
}

/** Update mission */
export function updateMission(missionId: string, updates: Partial<Mission>, projectId?: string): Promise<Mission> {
  return api<Mission>(withProjectId(`/missions/${encodeURIComponent(missionId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete mission */
export function deleteMission(missionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/${encodeURIComponent(missionId)}`, projectId), {
    method: "DELETE",
  });
}

/** Get mission computed status */
export function fetchMissionStatus(missionId: string, projectId?: string): Promise<{ status: string }> {
  return api<{ status: string }>(withProjectId(`/missions/${encodeURIComponent(missionId)}/status`, projectId));
}

/** Query options for paginated mission event logs. */
export interface MissionEventQueryOptions {
  limit?: number;
  offset?: number;
  eventType?: MissionEventType;
}

/** Paginated mission event log response. */
export interface MissionEventsResponse {
  events: MissionEvent[];
  total: number;
  limit: number;
  offset: number;
}

/** Fetch paginated mission observability events. */
export function fetchMissionEvents(
  missionId: string,
  options?: MissionEventQueryOptions,
  projectId?: string,
): Promise<MissionEventsResponse> {
  const query = new URLSearchParams();
  if (options?.limit !== undefined) query.set("limit", String(options.limit));
  if (options?.offset !== undefined) query.set("offset", String(options.offset));
  if (options?.eventType !== undefined) query.set("eventType", options.eventType);

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return api<MissionEventsResponse>(
    withProjectId(`/missions/${encodeURIComponent(missionId)}/events${suffix}`, projectId),
  );
}

/** Fetch computed mission health metrics. */
export function fetchMissionHealth(missionId: string, projectId?: string): Promise<MissionHealth> {
  return api<MissionHealth>(withProjectId(`/missions/${encodeURIComponent(missionId)}/health`, projectId));
}

/** Fetch health metrics for all missions in a single batched request. */
export function fetchMissionsHealth(projectId?: string): Promise<Record<string, MissionHealth>> {
  return api<Record<string, MissionHealth>>(withProjectId("/missions/health", projectId));
}

/** Add milestone to mission */
export function createMilestone(
  missionId: string,
  input: { title: string; description?: string; dependencies?: string[] },
  projectId?: string
): Promise<Milestone> {
  return api<Milestone>(withProjectId(`/missions/${encodeURIComponent(missionId)}/milestones`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update milestone */
export function updateMilestone(milestoneId: string, updates: Partial<Milestone>, projectId?: string): Promise<Milestone> {
  return api<Milestone>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete milestone */
export function deleteMilestone(milestoneId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}`, projectId), {
    method: "DELETE",
  });
}

/** Reorder milestones */
export function reorderMilestones(missionId: string, orderedIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/${encodeURIComponent(missionId)}/milestones/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ orderedIds }),
  });
}

/** Add slice to milestone */
export function createSlice(
  milestoneId: string,
  input: { title: string; description?: string },
  projectId?: string
): Promise<Slice> {
  return api<Slice>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/slices`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update slice */
export function updateSlice(sliceId: string, updates: Partial<Slice>, projectId?: string): Promise<Slice> {
  return api<Slice>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete slice */
export function deleteSlice(sliceId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}`, projectId), {
    method: "DELETE",
  });
}

/** Activate slice */
export function activateSlice(sliceId: string, projectId?: string): Promise<Slice> {
  return api<Slice>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}/activate`, projectId), {
    method: "POST",
  });
}

/** Reorder slices */
export function reorderSlices(milestoneId: string, orderedIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/slices/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ orderedIds }),
  });
}

/** Add feature to slice */
export function createFeature(
  sliceId: string,
  input: { title: string; description?: string; acceptanceCriteria?: string },
  projectId?: string
): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}/features`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update feature */
export function updateFeature(featureId: string, updates: Partial<MissionFeature>, projectId?: string): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete feature */
export function deleteFeature(featureId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}`, projectId), {
    method: "DELETE",
  });
}

/** Link feature to task */
export function linkFeatureToTask(featureId: string, taskId: string, projectId?: string): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/link-task`, projectId), {
    method: "POST",
    body: JSON.stringify({ taskId }),
  });
}

/** Unlink feature from task */
export function unlinkFeatureFromTask(featureId: string, projectId?: string): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/unlink-task`, projectId), {
    method: "POST",
  });
}

/** Triage a feature — create a task from the feature and link it */
export function triageFeature(featureId: string, taskTitle?: string, taskDescription?: string, projectId?: string): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/triage`, projectId), {
    method: "POST",
    body: JSON.stringify({ taskTitle, taskDescription }),
  });
}

/** Triage all "defined" features in a slice */
export function triageAllSliceFeatures(sliceId: string, projectId?: string): Promise<{ triaged: MissionFeature[]; count: number }> {
  return api<{ triaged: MissionFeature[]; count: number }>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}/triage-all`, projectId), {
    method: "POST",
  });
}

// ── Contract Assertion API ─────────────────────────────────────────────────────

/** Contract assertion status */
export type MissionAssertionStatus = "pending" | "passed" | "failed" | "blocked";

/** A contract assertion represents an explicit behavioral test or requirement associated with a milestone */
export interface MissionContractAssertion {
  id: string;
  milestoneId: string;
  title: string;
  assertion: string;
  status: MissionAssertionStatus;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a contract assertion */
export interface ContractAssertionCreateInput {
  title: string;
  assertion: string;
  status?: MissionAssertionStatus;
}

/** Input for updating a contract assertion */
export interface ContractAssertionUpdateInput {
  title?: string;
  assertion?: string;
  status?: MissionAssertionStatus;
}

/** List assertions for a milestone, ordered by orderIndex */
export function fetchAssertions(milestoneId: string, projectId?: string): Promise<MissionContractAssertion[]> {
  return api<MissionContractAssertion[]>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/assertions`, projectId));
}

/** Create a new assertion for a milestone */
export function createAssertion(milestoneId: string, input: ContractAssertionCreateInput, projectId?: string): Promise<MissionContractAssertion> {
  return api<MissionContractAssertion>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/assertions`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Reorder assertions within a milestone */
export function reorderAssertions(milestoneId: string, orderedIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/assertions/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ orderedIds }),
  });
}

/** Get a single assertion by ID */
export function fetchAssertion(assertionId: string, projectId?: string): Promise<MissionContractAssertion> {
  return api<MissionContractAssertion>(withProjectId(`/missions/assertions/${encodeURIComponent(assertionId)}`, projectId));
}

/** Update an assertion */
export function updateAssertion(assertionId: string, updates: ContractAssertionUpdateInput, projectId?: string): Promise<MissionContractAssertion> {
  return api<MissionContractAssertion>(withProjectId(`/missions/assertions/${encodeURIComponent(assertionId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete an assertion */
export function deleteAssertion(assertionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/assertions/${encodeURIComponent(assertionId)}`, projectId), {
    method: "DELETE",
  });
}

/** Link a feature to an assertion */
export function linkFeatureToAssertion(featureId: string, assertionId: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/assertions/${encodeURIComponent(assertionId)}/link`, projectId), {
    method: "POST",
  });
}

/** Unlink a feature from an assertion */
export function unlinkFeatureFromAssertion(featureId: string, assertionId: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/assertions/${encodeURIComponent(assertionId)}/unlink`, projectId), {
    method: "POST",
  });
}

/** List assertions linked to a feature */
export function fetchAssertionsForFeature(featureId: string, projectId?: string): Promise<MissionContractAssertion[]> {
  return api<MissionContractAssertion[]>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/assertions`, projectId));
}

/** List features linked to an assertion */
export function fetchFeaturesForAssertion(assertionId: string, projectId?: string): Promise<MissionFeature[]> {
  return api<MissionFeature[]>(withProjectId(`/missions/assertions/${encodeURIComponent(assertionId)}/features`, projectId));
}

/** Validation rollup for a milestone */
export interface MilestoneValidationRollup {
  milestoneId: string;
  totalAssertions: number;
  passedAssertions: number;
  failedAssertions: number;
  blockedAssertions: number;
  pendingAssertions: number;
  unlinkedAssertions: number;
  state: "not_started" | "needs_coverage" | "ready" | "passed" | "failed" | "blocked";
}

/** Get milestone validation rollup */
export function fetchMilestoneValidation(milestoneId: string, projectId?: string): Promise<MilestoneValidationRollup> {
  return api<MilestoneValidationRollup>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/validation`, projectId));
}

/** Fetch grouped validation telemetry for a milestone */
export function fetchMilestoneValidationTelemetry(milestoneId: string, projectId?: string): Promise<MilestoneValidationTelemetry> {
  return api<MilestoneValidationTelemetry>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/validation-telemetry`, projectId));
}

// ── Validation Loop API ───────────────────────────────────────────────────────

/** Loop state snapshot for a feature */
export interface MissionFeatureLoopSnapshot {
  featureId: string;
  feature: MissionFeature;
  loopState: "idle" | "implementing" | "validating" | "needs_fix" | "passed" | "blocked";
  implementationAttemptCount: number;
  validatorAttemptCount: number;
  lastValidatorRunId?: string;
  lastValidatorStatus?: "running" | "passed" | "failed" | "blocked" | "error";
  generatedFromFeatureId?: string;
  generatedFromRunId?: string;
  retryBudgetRemaining: number;
}

/** Validator run */
export interface MissionValidatorRun {
  id: string;
  featureId: string;
  milestoneId: string;
  sliceId: string;
  status: "running" | "passed" | "failed" | "blocked" | "error";
  triggerType: string;
  implementationAttempt: number;
  validatorAttempt: number;
  summary?: string;
  blockedReason?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Trigger validation for a feature */
export function triggerValidation(featureId: string, projectId?: string): Promise<{ runId: string; featureId: string; status: string; triggerType: string; implementationAttempt: number; validatorAttempt: number; startedAt: string }> {
  return api(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/validate`, projectId), {
    method: "POST",
  });
}

/** Get validation loop state for a feature */
export function fetchValidationLoopState(featureId: string, projectId?: string): Promise<MissionFeatureLoopSnapshot> {
  return api<MissionFeatureLoopSnapshot>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/validation-loop`, projectId));
}

/** Paginated response wrapper for validation runs */
export interface ValidationRunsResponse {
  runs: MissionValidatorRun[];
  total: number;
  limit: number;
  offset: number;
}

/** List validation runs for a feature */
export function fetchValidationRuns(featureId: string, options?: { limit?: number; offset?: number }, projectId?: string): Promise<MissionValidatorRun[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<ValidationRunsResponse>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/validation-runs${suffix}`, projectId))
    .then((response) => response.runs);
}

/** Get a single validator run */
export function fetchValidationRun(runId: string, projectId?: string): Promise<MissionValidatorRun & { failures?: Array<{ id: string; assertionId: string; message?: string; expected?: string; actual?: string }> }> {
  return api(withProjectId(`/missions/validation-runs/${encodeURIComponent(runId)}`, projectId));
}

/** Pause a mission (sets status to "blocked", in-flight tasks continue) */
export function pauseMission(missionId: string, projectId?: string): Promise<Mission> {
  return api<Mission>(withProjectId(`/missions/${encodeURIComponent(missionId)}/pause`, projectId), {
    method: "POST",
  });
}

/** Resume a paused mission (sets status back to "active") */
export function resumeMission(missionId: string, projectId?: string): Promise<Mission> {
  return api<Mission>(withProjectId(`/missions/${encodeURIComponent(missionId)}/resume`, projectId), {
    method: "POST",
  });
}

/** Stop a mission (sets status to "blocked" and pauses all linked tasks) */
export function stopMission(missionId: string, projectId?: string): Promise<Mission & { pausedTaskIds: string[] }> {
  return api<Mission & { pausedTaskIds: string[] }>(withProjectId(`/missions/${encodeURIComponent(missionId)}/stop`, projectId), {
    method: "POST",
  });
}

/** Start a planning mission: sets status to "active" and activates the first pending slice */
export function startMission(missionId: string, projectId?: string): Promise<MissionWithHierarchy> {
  return api<MissionWithHierarchy>(withProjectId(`/missions/${encodeURIComponent(missionId)}/start`, projectId), {
    method: "POST",
  });
}

// ── Mission Autopilot API ────────────────────────────────────────────────

/** Fetch autopilot status for a mission */
export function fetchMissionAutopilotStatus(missionId: string, projectId?: string): Promise<AutopilotStatus> {
  return api<AutopilotStatus>(withProjectId(`/missions/${encodeURIComponent(missionId)}/autopilot`, projectId));
}

/** Update autopilot settings for a mission (enable/disable) */
export function updateMissionAutopilot(missionId: string, updates: { enabled?: boolean }, projectId?: string): Promise<AutopilotStatus> {
  return api<AutopilotStatus>(withProjectId(`/missions/${encodeURIComponent(missionId)}/autopilot`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Manually start autopilot watching for a mission */
export function startMissionAutopilot(missionId: string, projectId?: string): Promise<AutopilotStatus> {
  return api<AutopilotStatus>(withProjectId(`/missions/${encodeURIComponent(missionId)}/autopilot/start`, projectId), {
    method: "POST",
  });
}

/** Manually stop autopilot watching for a mission */
export function stopMissionAutopilot(missionId: string, projectId?: string): Promise<AutopilotStatus> {
  return api<AutopilotStatus>(withProjectId(`/missions/${encodeURIComponent(missionId)}/autopilot/stop`, projectId), {
    method: "POST",
  });
}

// ── Mission Interview API ─────────────────────────────────────────────────

/** Mission plan types returned by the interview AI */
export interface MissionPlanFeature {
  title: string;
  description?: string;
  acceptanceCriteria?: string;
}

export interface MissionPlanSlice {
  title: string;
  description?: string;
  verification?: string;
  features: MissionPlanFeature[];
}

export interface MissionPlanMilestone {
  title: string;
  description?: string;
  verification?: string;
  slices: MissionPlanSlice[];
}

export interface MissionPlanSummary {
  missionTitle?: string;
  missionDescription?: string;
  milestones: MissionPlanMilestone[];
}

export type MissionInterviewResponse =
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: MissionPlanSummary };

/** Start a mission interview session with AI streaming */
export function startMissionInterview(
  missionTitle: string,
  projectId?: string,
  modelOverride?: { modelProvider?: string; modelId?: string },
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/missions/interview/start", projectId), {
    method: "POST",
    body: JSON.stringify({
      missionTitle,
      modelProvider: modelOverride?.modelProvider,
      modelId: modelOverride?.modelId,
    }),
  });
}

/** Submit a response to the current interview question */
export function respondToMissionInterview(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
  tabId?: string,
): Promise<MissionInterviewResponse> {
  return api<MissionInterviewResponse>(withProjectId("/missions/interview/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses, tabId }),
  });
}

/** Retry a failed mission interview turn */
export function retryMissionInterviewSession(
  sessionId: string,
  projectId?: string,
  tabId?: string,
): Promise<{ success: boolean; sessionId: string }> {
  return api<{ success: boolean; sessionId: string }>(
    withProjectId(`/missions/interview/${encodeURIComponent(sessionId)}/retry`, projectId),
    {
      method: "POST",
      ...(tabId ? { body: JSON.stringify({ tabId }) } : {}),
    },
  );
}

/** Cancel an active mission interview session */
export function cancelMissionInterview(sessionId: string, projectId?: string, tabId?: string): Promise<void> {
  return api<void>(withProjectId("/missions/interview/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, tabId }),
  });
}

/** Create mission from completed interview */
export function createMissionFromInterview(
  sessionId: string,
  summary?: MissionPlanSummary,
  projectId?: string
): Promise<MissionWithHierarchy> {
  return api<MissionWithHierarchy>(withProjectId("/missions/interview/create-mission", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, summary }),
  });
}

/** Connect to mission interview SSE stream and handle events */
export function connectMissionInterviewStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: MissionPlanSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(withProjectId(`/missions/interview/${encodeURIComponent(sessionId)}/stream`, projectId));
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const resilient = createResilientEventSource(
    url,
    {
      onOpen: () => {
        stopKeepAlive();
        keepAlive = startKeepAlive(sessionId, projectId);
      },
      onMessage: (event) => {
        if (event.data.startsWith(":")) return;
      },
      events: {
        thinking: (event) => {
          try {
            handlers.onThinking?.(JSON.parse(event.data));
          } catch {
            handlers.onThinking?.(event.data);
          }
        },
        question: (event) => {
          try {
            handlers.onQuestion?.(JSON.parse(event.data) as PlanningQuestion);
          } catch (err) {
            console.error("[mission-interview] Failed to parse question event:", err);
          }
        },
        summary: (event) => {
          try {
            handlers.onSummary?.(JSON.parse(event.data) as MissionPlanSummary);
          } catch (err) {
            console.error("[mission-interview] Failed to parse summary event:", err);
          }
        },
        error: (event) => {
          try {
            const parsed = JSON.parse(event.data);
            handlers.onError?.(parsed.message || parsed);
          } catch {
            handlers.onError?.(event.data || "Stream error");
          }
          connection?.close();
        },
        complete: () => {
          handlers.onComplete?.();
          connection?.close();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => {
        stopKeepAlive();
        handlers.onError?.(message);
      },
    },
  );

  connection = {
    close: () => {
      stopKeepAlive();
      resilient.close();
    },
    isConnected: resilient.isConnected,
  };

  return connection;
}

// ── Milestone/Slice Interview API ─────────────────────────────────────────

/** Summary type for milestone/slice interview responses */
export interface TargetInterviewSummary {
  title?: string;
  description?: string;
  planningNotes?: string;
  verification?: string;
}

/** Response from milestone/slice interview: either a question or a completed plan */
export type TargetInterviewResponse =
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: TargetInterviewSummary };

// Helper functions for URL construction
function buildMilestoneInterviewUrl(milestoneId: string, path: string, projectId?: string): string {
  return withProjectId(
    `/missions/milestones/${encodeURIComponent(milestoneId)}/interview${path}`,
    projectId
  );
}

function buildSliceInterviewUrl(sliceId: string, path: string, projectId?: string): string {
  return withProjectId(
    `/missions/slices/${encodeURIComponent(sliceId)}/interview${path}`,
    projectId
  );
}

/** Start a milestone interview session */
export function startMilestoneInterview(
  milestoneId: string,
  projectId?: string,
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(buildMilestoneInterviewUrl(milestoneId, "/start", projectId), {
    method: "POST",
  });
}

/** Submit a response to a milestone interview question */
export function respondToMilestoneInterview(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
  tabId?: string,
): Promise<TargetInterviewResponse> {
  return api<TargetInterviewResponse>(buildMilestoneInterviewUrl(sessionId, "/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses, tabId }),
  });
}

/** Connect to milestone interview SSE stream and handle events */
export function connectMilestoneInterviewStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: TargetInterviewSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(buildMilestoneInterviewUrl(sessionId, `/${encodeURIComponent(sessionId)}/stream`, projectId));
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const resilient = createResilientEventSource(
    url,
    {
      onOpen: () => {
        stopKeepAlive();
        keepAlive = startKeepAlive(sessionId, projectId);
      },
      onMessage: (event) => {
        if (event.data.startsWith(":")) return;
      },
      events: {
        thinking: (event) => {
          try {
            handlers.onThinking?.(JSON.parse(event.data));
          } catch {
            handlers.onThinking?.(event.data);
          }
        },
        question: (event) => {
          try {
            handlers.onQuestion?.(JSON.parse(event.data) as PlanningQuestion);
          } catch (err) {
            console.error("[milestone-interview] Failed to parse question event:", err);
          }
        },
        summary: (event) => {
          try {
            handlers.onSummary?.(JSON.parse(event.data) as TargetInterviewSummary);
          } catch (err) {
            console.error("[milestone-interview] Failed to parse summary event:", err);
          }
        },
        error: (event) => {
          try {
            const parsed = JSON.parse(event.data);
            handlers.onError?.(parsed.message || parsed);
          } catch {
            handlers.onError?.(event.data || "Stream error");
          }
          connection?.close();
        },
        complete: () => {
          handlers.onComplete?.();
          connection?.close();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => {
        stopKeepAlive();
        handlers.onError?.(message);
      },
    },
  );

  connection = {
    close: () => {
      stopKeepAlive();
      resilient.close();
    },
    isConnected: resilient.isConnected,
  };

  return connection;
}

/** Apply milestone interview results to the milestone */
export function applyMilestoneInterview(
  sessionId: string,
  summary?: TargetInterviewSummary,
  projectId?: string,
): Promise<Milestone> {
  return api<Milestone>(buildMilestoneInterviewUrl(sessionId, "/apply", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, summary }),
  });
}

/** Skip milestone interview and use mission context */
export function skipMilestoneInterview(
  milestoneId: string,
  projectId?: string,
): Promise<Milestone> {
  return api<Milestone>(buildMilestoneInterviewUrl(milestoneId, "/skip", projectId), {
    method: "POST",
  });
}

/** Start a slice interview session */
export function startSliceInterview(
  sliceId: string,
  projectId?: string,
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(buildSliceInterviewUrl(sliceId, "/start", projectId), {
    method: "POST",
  });
}

/** Submit a response to a slice interview question */
export function respondToSliceInterview(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
  tabId?: string,
): Promise<TargetInterviewResponse> {
  return api<TargetInterviewResponse>(buildSliceInterviewUrl(sessionId, "/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses, tabId }),
  });
}

/** Connect to slice interview SSE stream and handle events */
export function connectSliceInterviewStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: TargetInterviewSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(buildSliceInterviewUrl(sessionId, `/${encodeURIComponent(sessionId)}/stream`, projectId));
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const resilient = createResilientEventSource(
    url,
    {
      onOpen: () => {
        stopKeepAlive();
        keepAlive = startKeepAlive(sessionId, projectId);
      },
      onMessage: (event) => {
        if (event.data.startsWith(":")) return;
      },
      events: {
        thinking: (event) => {
          try {
            handlers.onThinking?.(JSON.parse(event.data));
          } catch {
            handlers.onThinking?.(event.data);
          }
        },
        question: (event) => {
          try {
            handlers.onQuestion?.(JSON.parse(event.data) as PlanningQuestion);
          } catch (err) {
            console.error("[slice-interview] Failed to parse question event:", err);
          }
        },
        summary: (event) => {
          try {
            handlers.onSummary?.(JSON.parse(event.data) as TargetInterviewSummary);
          } catch (err) {
            console.error("[slice-interview] Failed to parse summary event:", err);
          }
        },
        error: (event) => {
          try {
            const parsed = JSON.parse(event.data);
            handlers.onError?.(parsed.message || parsed);
          } catch {
            handlers.onError?.(event.data || "Stream error");
          }
          connection?.close();
        },
        complete: () => {
          handlers.onComplete?.();
          connection?.close();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => {
        stopKeepAlive();
        handlers.onError?.(message);
      },
    },
  );

  connection = {
    close: () => {
      stopKeepAlive();
      resilient.close();
    },
    isConnected: resilient.isConnected,
  };

  return connection;
}

/** Apply slice interview results to the slice */
export function applySliceInterview(
  sessionId: string,
  summary?: TargetInterviewSummary,
  projectId?: string,
): Promise<Slice> {
  return api<Slice>(buildSliceInterviewUrl(sessionId, "/apply", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, summary }),
  });
}

/** Skip slice interview and use mission context */
export function skipSliceInterview(
  sliceId: string,
  projectId?: string,
): Promise<Slice> {
  return api<Slice>(buildSliceInterviewUrl(sliceId, "/skip", projectId), {
    method: "POST",
  });
}

/** Preview enriched description for a feature before triage */
export async function previewEnrichedDescription(
  featureId: string,
  projectId?: string,
): Promise<{ description: string }> {
  try {
    return await api<{ description: string }>(
      withProjectId(`/missions/features/${encodeURIComponent(featureId)}/preview-description`, projectId),
      {
        method: "POST",
      }
    );
  } catch {
    // If endpoint doesn't exist, throw to trigger fallback
    throw new Error("Preview endpoint not available");
  }
}

// ── Roadmap API ─────────────────────────────────────────────────────────────────

/** Fetch all roadmaps */
export function fetchRoadmaps(projectId?: string): Promise<Roadmap[]> {
  return api<Roadmap[]>(withProjectId("/roadmaps", projectId));
}

/** Create a new roadmap */
export function createRoadmap(input: RoadmapCreateInput, projectId?: string): Promise<Roadmap> {
  return api<Roadmap>(withProjectId("/roadmaps", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch a single roadmap with full hierarchy (milestones and features) */
export function fetchRoadmap(roadmapId: string, projectId?: string): Promise<RoadmapWithHierarchy> {
  return api<RoadmapWithHierarchy>(withProjectId(`/roadmaps/${encodeURIComponent(roadmapId)}`, projectId));
}

/** Update roadmap metadata */
export function updateRoadmap(roadmapId: string, updates: RoadmapUpdateInput, projectId?: string): Promise<Roadmap> {
  return api<Roadmap>(withProjectId(`/roadmaps/${encodeURIComponent(roadmapId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a roadmap */
export function deleteRoadmap(roadmapId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/roadmaps/${encodeURIComponent(roadmapId)}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch milestones for a roadmap */
export function fetchRoadmapMilestones(roadmapId: string, projectId?: string): Promise<RoadmapMilestone[]> {
  return api<RoadmapMilestone[]>(withProjectId(`/roadmaps/${encodeURIComponent(roadmapId)}/milestones`, projectId));
}

/** Create a milestone in a roadmap */
export function createRoadmapMilestone(roadmapId: string, input: RoadmapMilestoneCreateInput, projectId?: string): Promise<RoadmapMilestone> {
  return api<RoadmapMilestone>(withProjectId(`/roadmaps/${encodeURIComponent(roadmapId)}/milestones`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update milestone metadata */
export function updateRoadmapMilestone(milestoneId: string, updates: RoadmapMilestoneUpdateInput, projectId?: string): Promise<RoadmapMilestone> {
  return api<RoadmapMilestone>(withProjectId(`/roadmaps/milestones/${encodeURIComponent(milestoneId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a milestone */
export function deleteRoadmapMilestone(milestoneId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/roadmaps/milestones/${encodeURIComponent(milestoneId)}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch features for a milestone */
export function fetchRoadmapFeatures(milestoneId: string, projectId?: string): Promise<RoadmapFeature[]> {
  return api<RoadmapFeature[]>(withProjectId(`/roadmaps/milestones/${encodeURIComponent(milestoneId)}/features`, projectId));
}

/** Create a feature in a milestone */
export function createRoadmapFeature(milestoneId: string, input: RoadmapFeatureCreateInput, projectId?: string): Promise<RoadmapFeature> {
  return api<RoadmapFeature>(withProjectId(`/roadmaps/milestones/${encodeURIComponent(milestoneId)}/features`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update feature metadata */
export function updateRoadmapFeature(featureId: string, updates: RoadmapFeatureUpdateInput, projectId?: string): Promise<RoadmapFeature> {
  return api<RoadmapFeature>(withProjectId(`/roadmaps/features/${encodeURIComponent(featureId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a feature */
export function deleteRoadmapFeature(featureId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/roadmaps/features/${encodeURIComponent(featureId)}`, projectId), {
    method: "DELETE",
  });
}

/** Reorder milestones within a roadmap */
export function reorderRoadmapMilestones(roadmapId: string, orderedMilestoneIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/roadmaps/${encodeURIComponent(roadmapId)}/milestones/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ orderedMilestoneIds }),
  });
}

/** Reorder features within a milestone */
export function reorderRoadmapFeatures(milestoneId: string, orderedFeatureIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/roadmaps/milestones/${encodeURIComponent(milestoneId)}/features/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ orderedFeatureIds }),
  });
}

/** Move a feature to a different milestone or position */
export function moveRoadmapFeature(
  featureId: string,
  targetMilestoneId: string,
  targetIndex: number,
  projectId?: string
): Promise<void> {
  return api<void>(withProjectId(`/roadmaps/features/${encodeURIComponent(featureId)}/move`, projectId), {
    method: "POST",
    body: JSON.stringify({ targetMilestoneId, targetIndex }),
  });
}

/** Export a roadmap as a flat bundle for persistence/import/export */
export function exportRoadmap(roadmapId: string, projectId?: string): Promise<RoadmapExportBundle> {
  return api<RoadmapExportBundle>(withProjectId(`/roadmaps/${encodeURIComponent(roadmapId)}/export`, projectId));
}

/** Get mission planning handoff payload for a roadmap */
export function getRoadmapMissionHandoff(roadmapId: string, projectId?: string): Promise<RoadmapMissionPlanningHandoff> {
  return api<RoadmapMissionPlanningHandoff>(withProjectId(`/roadmaps/${encodeURIComponent(roadmapId)}/handoff/mission`, projectId));
}

/** Get task planning handoff payload for a single roadmap feature */
export function getRoadmapFeatureHandoff(
  roadmapId: string,
  milestoneId: string,
  featureId: string,
  projectId?: string
): Promise<RoadmapFeatureTaskPlanningHandoff> {
  return api<RoadmapFeatureTaskPlanningHandoff>(
    withProjectId(
      `/roadmaps/${encodeURIComponent(roadmapId)}/milestones/${encodeURIComponent(milestoneId)}/features/${encodeURIComponent(featureId)}/handoff/task`,
      projectId
    )
  );
}

/** Combined handoff response type for roadmap handoff endpoint */
export interface RoadmapHandoffResponse {
  mission: RoadmapMissionPlanningHandoff;
  features: RoadmapFeatureTaskPlanningHandoff[];
}

/** Get both mission and feature handoff payloads for a roadmap */
export function fetchRoadmapHandoff(roadmapId: string, projectId?: string): Promise<RoadmapHandoffResponse> {
  return api<RoadmapHandoffResponse>(withProjectId(`/roadmaps/${encodeURIComponent(roadmapId)}/handoff`, projectId));
}

/** Response from milestone suggestion generation */
export interface MilestoneSuggestionsResponse {
  suggestions: Array<{
    title: string;
    description?: string;
  }>;
}

/** Generate milestone suggestions from a goal prompt */
export function generateMilestoneSuggestions(
  roadmapId: string,
  goalPrompt: string,
  count?: number,
  projectId?: string
): Promise<MilestoneSuggestionsResponse> {
  return api<MilestoneSuggestionsResponse>(
    withProjectId(`/roadmaps/${encodeURIComponent(roadmapId)}/suggestions/milestones`, projectId),
    {
      method: "POST",
      body: JSON.stringify({
        goalPrompt: goalPrompt.trim(),
        ...(count !== undefined ? { count } : {}),
      }),
    }
  );
}

/** Response type for feature suggestions */
export interface FeatureSuggestionsResponse {
  suggestions: Array<{
    title: string;
    description?: string;
  }>;
}

/** Input for generating feature suggestions */
export interface GenerateFeatureSuggestionsInput {
  /** Optional prompt to guide feature generation */
  prompt?: string;
  /** Number of features to generate (default 5, max 10) */
  count?: number;
}

/** Generate feature suggestions for a milestone */
export function generateFeatureSuggestions(
  milestoneId: string,
  input?: GenerateFeatureSuggestionsInput,
  projectId?: string
): Promise<FeatureSuggestionsResponse> {
  return api<FeatureSuggestionsResponse>(
    withProjectId(`/roadmaps/milestones/${encodeURIComponent(milestoneId)}/suggestions/features`, projectId),
    {
      method: "POST",
      body: JSON.stringify({
        ...(input?.prompt !== undefined ? { prompt: input.prompt.trim() } : {}),
        ...(input?.count !== undefined ? { count: input.count } : {}),
      }),
    }
  );
}

// ── AI Sessions (Background Tasks) ─────────────────────────────────────────

export interface AiSessionSummary {
  id: string;
  type: "planning" | "subtask" | "mission_interview" | "milestone_interview" | "slice_interview";
  status: "generating" | "awaiting_input" | "complete" | "error";
  title: string;
  projectId: string | null;
  lockedByTab: string | null;
  updatedAt: string;
}

export interface ConversationHistoryEntry {
  question?: PlanningQuestion;
  response?: Record<string, unknown>;
  thinkingOutput?: string;
}

export interface AiSessionDetail extends AiSessionSummary {
  inputPayload: string;
  conversationHistory: string;
  currentQuestion: string | null;
  result: string | null;
  thinkingOutput: string;
  error: string | null;
  createdAt: string;
  lockedAt: string | null;
}

export function parseConversationHistory(raw: string): ConversationHistoryEntry[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function fetchAiSessions(projectId?: string): Promise<AiSessionSummary[]> {
  const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const res = await fetch(buildApiUrl(`/ai-sessions${params}`));
  if (!res.ok) return [];
  const data = await res.json();
  return data.sessions ?? [];
}

export async function fetchAiSession(id: string): Promise<AiSessionDetail | null> {
  const res = await fetch(buildApiUrl(`/ai-sessions/${encodeURIComponent(id)}`));
  if (!res.ok) return null;
  return res.json();
}

export async function acquireSessionLock(
  sessionId: string,
  tabId: string,
): Promise<{ acquired: boolean; currentHolder: string | null }> {
  const result = await api<{ acquired: boolean; currentHolder?: string | null }>(
    `/ai-sessions/${encodeURIComponent(sessionId)}/lock`,
    {
      method: "POST",
      body: JSON.stringify({ tabId }),
    },
  );

  return {
    acquired: result.acquired,
    currentHolder: result.currentHolder ?? null,
  };
}

export function releaseSessionLock(sessionId: string, tabId: string): Promise<void> {
  return api<void>(`/ai-sessions/${encodeURIComponent(sessionId)}/lock`, {
    method: "DELETE",
    body: JSON.stringify({ tabId }),
  });
}

export function forceAcquireSessionLock(sessionId: string, tabId: string): Promise<void> {
  return api<void>(`/ai-sessions/${encodeURIComponent(sessionId)}/lock/force`, {
    method: "POST",
    body: JSON.stringify({ tabId }),
  });
}

export async function deleteAiSession(id: string): Promise<void> {
  await fetch(buildApiUrl(`/ai-sessions/${encodeURIComponent(id)}`), { method: "DELETE" });
}

export function pingSession(sessionId: string, projectId?: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(withProjectId(`/ai-sessions/${encodeURIComponent(sessionId)}/ping`, projectId), {
    method: "POST",
  });
}

// ── Messages API ──────────────────────────────────────────────────────────

/** Response shape for GET /messages/inbox */
export interface InboxResponse {
  messages: Message[];
  total: number;
  unreadCount: number;
}

/** Response shape for GET /messages/outbox */
export interface OutboxResponse {
  messages: Message[];
  total: number;
}

/** Response shape for GET /messages/unread-count */
export interface UnreadCountResponse {
  unreadCount: number;
}

/** Response shape for POST /messages/read-all */
export interface MarkAllReadResponse {
  markedAsRead: number;
}

/** Response shape for GET /agents/:id/mailbox */
export interface AgentMailboxResponse {
  ownerId: string;
  ownerType: ParticipantType;
  unreadCount: number;
  lastMessage?: Message;
  messages: Message[];
}

/** Input for sending a message via the dashboard */
export interface SendMessageInput {
  toId: string;
  toType: ParticipantType;
  content: string;
  type: MessageType;
  metadata?: Record<string, unknown>;
}

/** Fetch inbox messages for the current user. */
export function fetchInbox(
  options?: { limit?: number; offset?: number; unreadOnly?: boolean; type?: MessageType },
  projectId?: string,
): Promise<InboxResponse> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  if (options?.unreadOnly) params.set("unreadOnly", "true");
  if (options?.type) params.set("type", options.type);
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<InboxResponse>(`/messages/inbox${query}`);
}

/** Fetch sent messages for the current user. */
export function fetchOutbox(
  options?: { limit?: number; offset?: number; type?: MessageType },
  projectId?: string,
): Promise<OutboxResponse> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  if (options?.type) params.set("type", options.type);
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<OutboxResponse>(`/messages/outbox${query}`);
}

/** Fetch unread message count (lightweight, for header badge). */
export function fetchUnreadCount(projectId?: string): Promise<UnreadCountResponse> {
  return api<UnreadCountResponse>(withProjectId("/messages/unread-count", projectId));
}

/** Fetch a single message by ID. */
export function fetchMessage(id: string, projectId?: string): Promise<Message> {
  return api<Message>(withProjectId(`/messages/${encodeURIComponent(id)}`, projectId));
}

/** Send a new message. */
export function sendMessage(input: SendMessageInput, projectId?: string): Promise<Message> {
  return api<Message>(withProjectId("/messages", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Mark a specific message as read. */
export function markMessageRead(id: string, projectId?: string): Promise<Message> {
  return api<Message>(withProjectId(`/messages/${encodeURIComponent(id)}/read`, projectId), {
    method: "POST",
  });
}

/** Mark all inbox messages as read. */
export function markAllMessagesRead(projectId?: string): Promise<MarkAllReadResponse> {
  return api<MarkAllReadResponse>(withProjectId("/messages/read-all", projectId), {
    method: "POST",
  });
}

/** Delete a message. */
export function deleteMessage(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/messages/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch conversation between current user and a specific participant. */
export function fetchConversation(
  participantId: string,
  participantType: ParticipantType,
  projectId?: string,
): Promise<Message[]> {
  const path = `/messages/conversation/${encodeURIComponent(participantType)}/${encodeURIComponent(participantId)}`;
  return api<Message[]>(withProjectId(path, projectId));
}

/** Fetch an agent's mailbox (admin read-only view). */
export function fetchAgentMailbox(agentId: string, projectId?: string): Promise<AgentMailboxResponse> {
  return api<AgentMailboxResponse>(withProjectId(`/agents/${encodeURIComponent(agentId)}/mailbox`, projectId));
}

/** Fetch reflection history for an agent. */
export function fetchAgentReflections(agentId: string, limit?: number, projectId?: string): Promise<AgentReflection[]> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentReflection[]>(`/agents/${encodeURIComponent(agentId)}/reflections${query}`);
}

/** Fetch the most recent reflection for an agent. */
export function fetchAgentReflection(agentId: string, projectId?: string): Promise<AgentReflection> {
  return api<AgentReflection>(withProjectId(`/agents/${encodeURIComponent(agentId)}/reflections/latest`, projectId));
}

/** Trigger a manual reflection for an agent. */
export function triggerAgentReflection(agentId: string, projectId?: string): Promise<AgentReflection> {
  return api<AgentReflection>(withProjectId(`/agents/${encodeURIComponent(agentId)}/reflections`, projectId), {
    method: "POST",
  });
}

/** Fetch aggregated performance summary for an agent. */
export function fetchAgentPerformance(agentId: string, windowMs?: number, projectId?: string): Promise<AgentPerformanceSummary> {
  const params = new URLSearchParams();
  if (windowMs !== undefined) params.set("windowMs", String(windowMs));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentPerformanceSummary>(`/agents/${encodeURIComponent(agentId)}/performance${query}`);
}

/** Fetch ratings for an agent */
export function fetchAgentRatings(
  agentId: string,
  options?: { limit?: number; category?: string },
  projectId?: string,
): Promise<AgentRating[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.category) params.set("category", options.category);
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentRating[]>(`/agents/${encodeURIComponent(agentId)}/ratings${query}`);
}

/** Add a rating for an agent */
export function addAgentRating(
  agentId: string,
  input: AgentRatingInput,
  projectId?: string,
): Promise<AgentRating> {
  return api<AgentRating>(withProjectId(`/agents/${encodeURIComponent(agentId)}/ratings`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch rating summary for an agent */
export function fetchAgentRatingSummary(agentId: string, projectId?: string): Promise<AgentRatingSummary> {
  return api<AgentRatingSummary>(withProjectId(`/agents/${encodeURIComponent(agentId)}/ratings/summary`, projectId));
}

/** Delete a specific rating */
export function deleteAgentRating(agentId: string, ratingId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/agents/${encodeURIComponent(agentId)}/ratings/${encodeURIComponent(ratingId)}`, projectId), {
    method: "DELETE",
  });
}

// ── Agent Budget API ──────────────────────────────────────────────────────

/** Fetch budget status for an agent */
export function fetchAgentBudgetStatus(agentId: string, projectId?: string): Promise<AgentBudgetStatus> {
  return api<AgentBudgetStatus>(withProjectId(`/agents/${encodeURIComponent(agentId)}/budget`, projectId));
}

/** Reset budget usage for an agent */
export function resetAgentBudget(agentId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/agents/${encodeURIComponent(agentId)}/budget/reset`, projectId), {
    method: "POST",
  });
}

// ── Plugin Management ────────────────────────────────────────────────────────

/** Fetch all installed plugins */
export async function fetchPlugins(projectId?: string): Promise<PluginInstallation[]> {
  return api<PluginInstallation[]>(withProjectId("/plugins", projectId));
}

/** Fetch a single plugin by ID */
export async function fetchPluginDetail(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}`, projectId));
}

/** Install a plugin from local path or npm package */
export async function installPlugin(
  source: { path: string } | { package: string },
  projectId?: string,
): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId("/plugins", projectId), {
    method: "POST",
    body: JSON.stringify({ mode: "install", ...source }),
  });
}

/** Enable a plugin */
export async function enablePlugin(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}/enable`, projectId), {
    method: "POST",
  });
}

/** Disable a plugin */
export async function disablePlugin(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}/disable`, projectId), {
    method: "POST",
  });
}

/** Uninstall a plugin */
export async function uninstallPlugin(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/plugins/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch plugin settings */
export async function fetchPluginSettings(id: string, projectId?: string): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>(withProjectId(`/plugins/${encodeURIComponent(id)}/settings`, projectId));
}

/** Update plugin settings */
export async function updatePluginSettings(
  id: string,
  settings: Record<string, unknown>,
  projectId?: string,
): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>(withProjectId(`/plugins/${encodeURIComponent(id)}/settings`, projectId), {
    method: "PUT",
    body: JSON.stringify({ settings }),
  });
}

/** Reload a running plugin with updated code */
export async function reloadPlugin(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}/reload`, projectId), {
    method: "POST",
  });
}

/** A UI slot entry returned by GET /api/plugins/ui-slots */
export interface PluginUiSlotEntry {
  pluginId: string;
  slot: PluginUiSlotDefinition;
}

/** Fetch all UI slot definitions from active plugins */
export async function fetchPluginUiSlots(projectId?: string): Promise<PluginUiSlotEntry[]> {
  return api<PluginUiSlotEntry[]>(withProjectId("/plugins/ui-slots", projectId));
}

// ── Skills Management ─────────────────────────────────────────────────────────

/** Fetch all discovered skills with their enabled state */
export async function fetchDiscoveredSkills(projectId?: string): Promise<DiscoveredSkill[]> {
  const response = await api<{ skills: DiscoveredSkill[] }>(withProjectId("/skills/discovered", projectId));
  return response.skills;
}

/** Toggle a skill's enabled/disabled state */
export async function toggleExecutionSkill(
  skillId: string,
  enabled: boolean,
  projectId?: string,
): Promise<ToggleSkillResult> {
  return api<ToggleSkillResult>(withProjectId("/skills/execution", projectId), {
    method: "PATCH",
    body: JSON.stringify({ skillId, enabled }),
  });
}

/** Fetch the skills.sh catalog */
export async function fetchSkillsCatalog(
  query?: string,
  limit?: number,
  projectId?: string,
): Promise<CatalogFetchResult> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (limit !== undefined) params.set("limit", String(limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<CatalogFetchResult>(withProjectId(`/skills/catalog${suffix}`, projectId));
}

// ── Chat API ─────────────────────────────────────────────────────────────────

export interface ChatSessionListResponse {
  sessions: ChatSession[];
}

export interface ChatSessionResponse {
  session: ChatSession;
}

export interface ChatMessageListResponse {
  messages: ChatMessage[];
}

/** Fetch all chat sessions for a project */
export function fetchChatSessions(projectId?: string, status?: string): Promise<ChatSessionListResponse> {
  const search = new URLSearchParams();
  if (projectId) search.set("projectId", projectId);
  if (status) search.set("status", status);
  const qs = search.toString();
  return api<ChatSessionListResponse>(`/chat/sessions${qs ? `?${qs}` : ""}`);
}

/** Create a new chat session */
export function createChatSession(
  input: { agentId: string; title?: string; modelProvider?: string; modelId?: string },
  projectId?: string,
): Promise<ChatSessionResponse> {
  return api<ChatSessionResponse>(withProjectId("/chat/sessions", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch a single chat session */
export function fetchChatSession(id: string, projectId?: string): Promise<ChatSessionResponse> {
  return api<ChatSessionResponse>(withProjectId(`/chat/sessions/${encodeURIComponent(id)}`, projectId));
}

/** Update a chat session (title, status) */
export function updateChatSession(
  id: string,
  updates: { title?: string; status?: string },
  projectId?: string,
): Promise<ChatSessionResponse> {
  return api<ChatSessionResponse>(withProjectId(`/chat/sessions/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a chat session */
export function deleteChatSession(id: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/chat/sessions/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch messages for a chat session */
export function fetchChatMessages(
  sessionId: string,
  opts?: { limit?: number; offset?: number; before?: string },
  projectId?: string,
): Promise<ChatMessageListResponse> {
  const search = new URLSearchParams();
  if (opts?.limit !== undefined) search.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) search.set("offset", String(opts.offset));
  if (opts?.before) search.set("before", opts.before);
  const qs = search.toString();
  return api<ChatMessageListResponse>(
    withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ""}`, projectId),
  );
}

/** Delete a specific message from a chat session */
export function deleteChatMessage(
  sessionId: string,
  messageId: string,
  projectId?: string,
): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(
    withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`, projectId),
    {
      method: "DELETE",
    },
  );
}

/** Send a chat message and receive the AI response via SSE streaming.
 *
 *  The backend exposes `POST /api/chat/sessions/:id/messages` which returns an SSE
 *  stream (not JSON). Events: `thinking`, `text`, `done`, `error`.
 *
 *  Since `EventSource` only supports GET requests, this function uses `fetch()`
 *  with a ReadableStream to parse SSE events from the POST response body.
 */
export function streamChatResponse(
  sessionId: string,
  content: string,
  handlers: {
    onThinking?: (data: string) => void;
    onText?: (data: string) => void;
    onDone?: (data: { messageId: string }) => void;
    onError?: (data: string) => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  projectId?: string,
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/messages`, projectId));

  void options;

  const abortController = new AbortController();
  let closedByUser = false;

  const dispatchEvent = (eventName: string, rawData: string): void => {
    if (!eventName || !rawData) {
      return;
    }

    switch (eventName) {
      case "thinking":
        try {
          handlers.onThinking?.(JSON.parse(rawData));
        } catch {
          handlers.onThinking?.(rawData);
        }
        break;
      case "text":
        try {
          handlers.onText?.(JSON.parse(rawData));
        } catch {
          handlers.onText?.(rawData);
        }
        break;
      case "done":
        try {
          handlers.onDone?.(JSON.parse(rawData));
        } catch {
          handlers.onDone?.({ messageId: "" });
        }
        break;
      case "error":
        try {
          const parsed = JSON.parse(rawData);
          handlers.onError?.(parsed.message || parsed);
        } catch {
          handlers.onError?.(rawData || "Stream error");
        }
        break;
    }
  };

  // Start streaming via POST
  (async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text();
        let errorMsg = `Request failed: ${res.status}`;
        try {
          const parsed = JSON.parse(errorBody);
          errorMsg = parsed.error || errorMsg;
        } catch { /* use default */ }
        handlers.onError?.(errorMsg);
        return;
      }

      if (!res.body) {
        handlers.onError?.("No response body");
        return;
      }

      handlers.onConnectionStateChange?.("connected");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentDataLines: string[] = [];

      // POST-based chat responses still speak SSE, so parser state must persist
      // across ReadableStream chunks. Networks can split `event:` and `data:`
      // lines arbitrarily, and resetting state per-read drops assistant output.
      const processLines = (chunk: string, flushPendingEvent = false): void => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        // Only push complete SSE lines (ending with \n) to lines for processing.
        // Incomplete lines (no trailing \n) are intentionally left in the buffer
        // to be continued by the next chunk or properly handled at stream end.
        if (flushPendingEvent && buffer.length > 0 && buffer.endsWith("\n")) {
          lines.push(buffer);
          buffer = "";
        }

        for (const rawLine of lines) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const value = line.slice(5);
            currentDataLines.push(value.startsWith(" ") ? value.slice(1) : value);
          } else if (line === "") {
            const currentData = currentDataLines.join("\n");
            dispatchEvent(currentEvent, currentData);
            currentEvent = "";
            currentDataLines = [];
          }
        }

        // Flush any pending event/data at stream end.
        // Only dispatch if we have both a valid event type and accumulated data.
        if (flushPendingEvent && currentEvent && currentDataLines.length > 0) {
          const trailingData = currentDataLines.join("\n");
          dispatchEvent(currentEvent, trailingData);
          currentEvent = "";
          currentDataLines = [];
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          processLines(decoder.decode(), true);
          break;
        }

        processLines(decoder.decode(value, { stream: true }));
      }
    } catch (err: unknown) {
      if (closedByUser) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      handlers.onError?.(err instanceof Error ? err.message : "Connection error");
    }
  })();

  return {
    close: () => {
      closedByUser = true;
      abortController.abort();
    },
    isConnected: () => !closedByUser,
  };
}


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
 * Trigger a manual insight generation run.
 */
export function triggerInsightRun(
  trigger: InsightRunTrigger = "manual",
  inputMetadata?: InsightRun["inputMetadata"],
  projectId?: string,
): Promise<InsightRun> {
  return api<InsightRun>(withProjectId("/insights/run", projectId), {
    method: "POST",
    body: JSON.stringify({ trigger, inputMetadata }),
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
