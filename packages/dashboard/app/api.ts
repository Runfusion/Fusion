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
  BatchStatusEntry,
  ActivityLogEntry,
  ActivityEventType,
  WorkflowStep,
  WorkflowStepInput,
  WorkflowStepResult,
} from "@fusion/core";
import type { PlanningQuestion, PlanningSummary, PlanningResponse } from "@fusion/core";
import type { ScheduledTask, ScheduledTaskCreateInput, ScheduledTaskUpdateInput, AutomationRunResult, AutomationStep } from "@fusion/core";

function looksLikeHtml(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<HTML");
}

function buildApiUrl(path: string): string {
  return `/api${path}`;
}

async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
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

export function fetchTasks(limit?: number, offset?: number, projectId?: string): Promise<Task[]> {
  const search = new URLSearchParams();
  if (limit !== undefined) search.set("limit", String(limit));
  if (offset !== undefined) search.set("offset", String(offset));
  if (projectId) search.set("projectId", projectId);
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
    modelPresetId,
    modelProvider,
    modelId,
    validatorModelProvider,
    validatorModelId,
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
      modelPresetId,
      modelProvider,
      modelId,
      validatorModelProvider,
      validatorModelId,
    }),
  });
}

export function updateTask(id: string, updates: { title?: string; description?: string; prompt?: string; dependencies?: string[]; enabledWorkflowSteps?: string[]; modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null }, projectId?: string): Promise<Task> {
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

/** Fetch global (user-level) settings from ~/.pi/fusion/settings.json */
export function fetchGlobalSettings(): Promise<GlobalSettings> {
  return api<GlobalSettings>("/settings/global");
}

/** Update global (user-level) settings. These persist across all kb projects. */
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

export function fetchAgentLogs(taskId: string, projectId?: string): Promise<AgentLogEntry[]> {
  return api<AgentLogEntry[]>(withProjectId(`/tasks/${taskId}/logs`, projectId));
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

/** Import a specific GitHub issue as a kb task */
export function apiImportGitHubIssue(owner: string, repo: string, issueNumber: number): Promise<Task> {
  return api<Task>("/github/issues/import", {
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

/** Batch import multiple GitHub issues as kb tasks with throttling */
export function apiBatchImportGitHubIssues(
  owner: string,
  repo: string,
  issueNumbers: number[],
  delayMs?: number
): Promise<{ results: BatchImportResult[] }> {
  return api<{ results: BatchImportResult[] }>("/github/issues/batch-import", {
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

/** Import a specific GitHub pull request as a kb review task */
export function apiImportGitHubPull(owner: string, repo: string, prNumber: number): Promise<Task> {
  return api<Task>("/github/pulls/import", {
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
export function fetchGitRemotes(): Promise<GitRemote[]> {
  return api<GitRemote[]>("/git/remotes");
}

/** Detailed git remote info with fetch and push URLs */
export interface GitRemoteDetailed {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/** Fetch all git remotes with their fetch and push URLs */
export function fetchGitRemotesDetailed(): Promise<GitRemoteDetailed[]> {
  return api<GitRemoteDetailed[]>("/git/remotes/detailed");
}

/** Add a new git remote */
export function addGitRemote(name: string, url: string): Promise<void> {
  return api<void>("/git/remotes", {
    method: "POST",
    body: JSON.stringify({ name, url }),
  });
}

/** Remove a git remote */
export function removeGitRemote(name: string): Promise<void> {
  return api<void>(`/git/remotes/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

/** Rename a git remote */
export function renameGitRemote(name: string, newName: string): Promise<void> {
  return api<void>(`/git/remotes/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify({ newName }),
  });
}

/** Update the URL for a git remote */
export function updateGitRemoteUrl(name: string, url: string): Promise<void> {
  return api<void>(`/git/remotes/${encodeURIComponent(name)}/url`, {
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
export function execTerminalCommand(command: string): Promise<TerminalExecResponse> {
  return api<TerminalExecResponse>("/terminal/exec", {
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
  rows?: number
): Promise<PtyTerminalSession> {
  return api<PtyTerminalSession>("/terminal/sessions", {
    method: "POST",
    body: JSON.stringify({ cwd, cols, rows }),
  });
}

/** Kill a PTY terminal session */
export function killPtyTerminalSession(sessionId: string): Promise<{ killed: boolean }> {
  return api<{ killed: boolean }>(`/terminal/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

/** List active PTY terminal sessions */
export function listTerminalSessions(): Promise<PtyTerminalSessionInfo[]> {
  return api<PtyTerminalSessionInfo[]>("/terminal/sessions");
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
export function fetchGitStatus(): Promise<GitStatus> {
  return api<GitStatus>("/git/status");
}

/** Fetch recent commits */
export function fetchGitCommits(limit?: number): Promise<GitCommit[]> {
  const query = limit ? `?limit=${limit}` : "";
  return api<GitCommit[]>(`/git/commits${query}`);
}

/** Fetch diff for a specific commit */
export function fetchCommitDiff(hash: string): Promise<{ stat: string; patch: string }> {
  return api<{ stat: string; patch: string }>(`/git/commits/${hash}/diff`);
}

/** Fetch local commits ahead of the upstream tracking branch (commits to push) */
export function fetchAheadCommits(): Promise<GitCommit[]> {
  return api<GitCommit[]>("/git/commits/ahead");
}

/** Fetch recent commits for a specific remote */
export function fetchRemoteCommits(remote: string, ref?: string, limit?: number): Promise<GitCommit[]> {
  const params = new URLSearchParams();
  if (ref) params.set("ref", ref);
  if (limit) params.set("limit", String(limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<GitCommit[]>(`/git/remotes/${encodeURIComponent(remote)}/commits${query}`);
}

/** Fetch all local branches */
export function fetchGitBranches(): Promise<GitBranch[]> {
  return api<GitBranch[]>("/git/branches");
}

/** Fetch all worktrees */
export function fetchGitWorktrees(): Promise<GitWorktree[]> {
  return api<GitWorktree[]>("/git/worktrees");
}

/** Create a new branch */
export function createBranch(name: string, base?: string): Promise<void> {
  return api<void>("/git/branches", {
    method: "POST",
    body: JSON.stringify({ name, base }),
  });
}

/** Checkout an existing branch */
export function checkoutBranch(name: string): Promise<void> {
  return api<void>(`/git/branches/${encodeURIComponent(name)}/checkout`, {
    method: "POST",
  });
}

/** Delete a branch */
export function deleteBranch(name: string, force?: boolean): Promise<void> {
  const query = force ? "?force=true" : "";
  return api<void>(`/git/branches/${encodeURIComponent(name)}${query}`, {
    method: "DELETE",
  });
}

/** Fetch from remote */
export function fetchRemote(remote?: string): Promise<GitFetchResult> {
  return api<GitFetchResult>("/git/fetch", {
    method: "POST",
    body: JSON.stringify({ remote }),
  });
}

/** Pull current branch */
export function pullBranch(): Promise<GitPullResult> {
  return api<GitPullResult>("/git/pull", {
    method: "POST",
  });
}

/** Push current branch */
export function pushBranch(): Promise<GitPushResult> {
  return api<GitPushResult>("/git/push", {
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
export function fetchGitStashList(): Promise<GitStash[]> {
  return api<GitStash[]>("/git/stashes");
}

/** Create a new stash */
export function createStash(message?: string): Promise<{ message: string }> {
  return api<{ message: string }>("/git/stashes", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

/** Apply a stash entry */
export function applyStash(index: number, drop?: boolean): Promise<{ message: string }> {
  return api<{ message: string }>(`/git/stashes/${index}/apply`, {
    method: "POST",
    body: JSON.stringify({ drop }),
  });
}

/** Drop a stash entry */
export function dropStash(index: number): Promise<{ message: string }> {
  return api<{ message: string }>(`/git/stashes/${index}`, {
    method: "DELETE",
  });
}

/** Fetch unstaged diff (working directory changes) */
export function fetchUnstagedDiff(): Promise<{ stat: string; patch: string }> {
  return api<{ stat: string; patch: string }>("/git/diff");
}

/** Fetch file changes (staged and unstaged) */
export function fetchFileChanges(): Promise<GitFileChange[]> {
  return api<GitFileChange[]>("/git/changes");
}

/** Stage specific files */
export function stageFiles(files: string[]): Promise<{ staged: string[] }> {
  return api<{ staged: string[] }>("/git/stage", {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

/** Unstage specific files */
export function unstageFiles(files: string[]): Promise<{ unstaged: string[] }> {
  return api<{ unstaged: string[] }>("/git/unstage", {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

/** Create a commit */
export function createCommit(message: string): Promise<{ hash: string; message: string }> {
  return api<{ hash: string; message: string }>("/git/commit", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

/** Discard changes in working directory for specific files */
export function discardChanges(files: string[]): Promise<{ discarded: string[] }> {
  return api<{ discarded: string[] }>("/git/discard", {
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
export function fetchFileList(taskId: string, path?: string): Promise<FileListResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return api<FileListResponse>(`/tasks/${taskId}/files${query}`);
}

/** Fetch file content */
export function fetchFileContent(taskId: string, filePath: string): Promise<FileContentResponse> {
  return api<FileContentResponse>(`/tasks/${taskId}/files/${encodeURIComponent(filePath)}`);
}

/** Save file content */
export function saveFileContent(taskId: string, filePath: string, content: string): Promise<SaveFileResponse> {
  return api<SaveFileResponse>(`/tasks/${taskId}/files/${encodeURIComponent(filePath)}`, {
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
export function fetchWorkspaces(): Promise<WorkspaceListResponse> {
  return api<WorkspaceListResponse>("/workspaces");
}

/** List files in a workspace (project root or task worktree). */
export function fetchWorkspaceFileList(workspace: string, path?: string): Promise<FileListResponse> {
  const query = new URLSearchParams({ workspace });
  if (path) {
    query.set("path", path);
  }
  return api<FileListResponse>(`/files?${query.toString()}`);
}

/** Fetch file content from a workspace. */
export function fetchWorkspaceFileContent(workspace: string, filePath: string): Promise<FileContentResponse> {
  const query = new URLSearchParams({ workspace });
  return api<FileContentResponse>(`/files/${encodeURIComponent(filePath)}?${query.toString()}`);
}

/** Save file content to a workspace. */
export function saveWorkspaceFileContent(workspace: string, filePath: string, content: string): Promise<SaveFileResponse> {
  const query = new URLSearchParams({ workspace });
  return api<SaveFileResponse>(`/files/${encodeURIComponent(filePath)}?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
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
export function startPlanningStreaming(initialPlan: string, projectId?: string): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/planning/start-streaming", projectId), {
    method: "POST",
    body: JSON.stringify({ initialPlan }),
  });
}

/** Submit a response to the current planning question */
export function respondToPlanning(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string
): Promise<PlanningSession> {
  return api<PlanningSession>(withProjectId("/planning/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

/** Cancel an active planning session */
export function cancelPlanning(sessionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId("/planning/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
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


/** Get the SSE stream URL for a planning session */
export function getPlanningStreamUrl(sessionId: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/planning/${encodeURIComponent(sessionId)}/stream`, projectId));
}

/** Connect to planning session SSE stream and handle events
 * 
 * Returns an object with:
 * - close: function to close the connection
 * - reconnect: function to reconnect after error
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
  }
): { close: () => void; isConnected: () => boolean } {
  const url = getPlanningStreamUrl(sessionId, projectId);
  const eventSource = new EventSource(url);
  let isClosed = false;

  eventSource.onopen = () => {
    isClosed = false;
  };

  eventSource.onmessage = (event) => {
    // Handle comment events (heartbeats)
    if (event.data.startsWith(":")) return;
  };

  // Handle specific event types
  eventSource.addEventListener("thinking", (event: Event) => {
    try {
      const messageEvent = event as MessageEvent;
      const data = JSON.parse(messageEvent.data);
      handlers.onThinking?.(data);
    } catch {
      const messageEvent = event as MessageEvent;
      handlers.onThinking?.(messageEvent.data);
    }
  });

  eventSource.addEventListener("question", (event: Event) => {
    try {
      const messageEvent = event as MessageEvent;
      const data = JSON.parse(messageEvent.data) as PlanningQuestion;
      handlers.onQuestion?.(data);
    } catch (err) {
      console.error("[planning] Failed to parse question event:", err);
    }
  });

  eventSource.addEventListener("summary", (event: Event) => {
    try {
      const messageEvent = event as MessageEvent;
      const data = JSON.parse(messageEvent.data) as PlanningSummary;
      handlers.onSummary?.(data);
    } catch (err) {
      console.error("[planning] Failed to parse summary event:", err);
    }
  });

  eventSource.addEventListener("error", (event: Event) => {
    try {
      const messageEvent = event as MessageEvent;
      const data = JSON.parse(messageEvent.data);
      handlers.onError?.(data.message || data);
    } catch {
      const messageEvent = event as MessageEvent;
      handlers.onError?.(messageEvent.data || "Stream error");
    }
    close();
  });

  eventSource.addEventListener("complete", () => {
    handlers.onComplete?.();
    close();
  });

  // Handle connection errors
  eventSource.onerror = () => {
    if (!isClosed) {
      handlers.onError?.("Connection lost");
      close();
    }
  };

  function close() {
    if (!isClosed) {
      isClosed = true;
      eventSource.close();
    }
  }

  return {
    close,
    isConnected: () => !isClosed && eventSource.readyState === EventSource.OPEN,
  };
}

// ── Automation / Scheduled Tasks ──────────────────────────────────

/** Response from the manual run trigger endpoint. */
export interface AutomationRunResponse {
  schedule: ScheduledTask;
  result: AutomationRunResult;
}

export function fetchAutomations(): Promise<ScheduledTask[]> {
  return api<ScheduledTask[]>("/automations");
}

export function fetchAutomation(id: string): Promise<ScheduledTask> {
  return api<ScheduledTask>(`/automations/${id}`);
}

export function createAutomation(input: ScheduledTaskCreateInput): Promise<ScheduledTask> {
  const { name, description, scheduleType, cronExpression, command, enabled, timeoutMs, steps } = input;
  return api<ScheduledTask>("/automations", {
    method: "POST",
    body: JSON.stringify({ name, description, scheduleType, cronExpression, command, enabled, timeoutMs, steps }),
  });
}

export function updateAutomation(id: string, updates: ScheduledTaskUpdateInput): Promise<ScheduledTask> {
  const { name, description, scheduleType, cronExpression, command, enabled, timeoutMs, steps } = updates;
  return api<ScheduledTask>(`/automations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name, description, scheduleType, cronExpression, command, enabled, timeoutMs, steps }),
  });
}

export async function deleteAutomation(id: string): Promise<void> {
  await api(`/automations/${id}`, {
    method: "DELETE",
  });
}

export function runAutomation(id: string): Promise<AutomationRunResponse> {
  return api<AutomationRunResponse>(`/automations/${id}/run`, {
    method: "POST",
  });
}

export function toggleAutomation(id: string): Promise<ScheduledTask> {
  return api<ScheduledTask>(`/automations/${id}/toggle`, {
    method: "POST",
  });
}

export function reorderAutomationSteps(id: string, stepIds: string[]): Promise<ScheduledTask> {
  return api<ScheduledTask>(`/automations/${id}/steps/reorder`, {
    method: "POST",
    body: JSON.stringify({ stepIds }),
  });
}

// ── Activity Log API ────────────────────────────────────────────

/** Re-export ActivityLogEntry type from core for convenience */
export type { ActivityLogEntry, ActivityEventType } from "@fusion/core";

/** Fetch activity log entries */
export function fetchActivityLog(options?: { limit?: number; since?: string; type?: ActivityEventType }): Promise<ActivityLogEntry[]> {
  const search = new URLSearchParams();
  if (options?.limit !== undefined) search.set("limit", String(options.limit));
  if (options?.since !== undefined) search.set("since", options.since);
  if (options?.type !== undefined) search.set("type", options.type);
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return api<ActivityLogEntry[]>(`/activity${suffix}`);
}

/** Clear all activity log entries */
export function clearActivityLog(): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/activity", { method: "DELETE" });
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
 * @returns The refined text
 * @throws Error with message for rate limit (429), invalid type (422), validation (400), or server errors
 */
export async function refineText(text: string, type: RefinementType): Promise<string> {
  const response = await api<RefineTextResponse>("/ai/refine-text", {
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
  }
): { close: () => void; isConnected: () => boolean } {
  const eventSource = new EventSource(getSubtaskStreamUrl(sessionId, projectId));
  let isClosed = false;

  eventSource.onopen = () => {
    isClosed = false;
  };

  eventSource.addEventListener("thinking", (event: Event) => {
    const messageEvent = event as MessageEvent;
    try {
      handlers.onThinking?.(JSON.parse(messageEvent.data));
    } catch {
      handlers.onThinking?.(messageEvent.data);
    }
  });

  eventSource.addEventListener("subtasks", (event: Event) => {
    try {
      const messageEvent = event as MessageEvent;
      handlers.onSubtasks?.(JSON.parse(messageEvent.data) as SubtaskItem[]);
    } catch (err) {
      console.error("[subtasks] Failed to parse subtasks event:", err);
    }
  });

  eventSource.addEventListener("error", (event: Event) => {
    try {
      const messageEvent = event as MessageEvent;
      const parsedData = JSON.parse(messageEvent.data);
      const errorMessage = typeof parsedData === "string" && parsedData.length > 0 ? parsedData : null;
      if (errorMessage) {
        handlers.onError?.(errorMessage);
      } else {
        handlers.onError?.("Stream error");
      }
    } catch {
      handlers.onError?.("Stream error");
    }
    isClosed = true;
    eventSource.close();
  });

  eventSource.addEventListener("complete", () => {
    handlers.onComplete?.();
    isClosed = true;
    eventSource.close();
  });

  eventSource.onerror = () => {
    if (!isClosed) {
      handlers.onError?.("Connection lost");
    }
    isClosed = true;
    eventSource.close();
  };

  return {
    close: () => {
      isClosed = true;
      eventSource.close();
    },
    isConnected: () => !isClosed,
  };
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

export function cancelSubtaskBreakdown(sessionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId("/subtasks/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

// ── Agent API ────────────────────────────────────────────────────────────

import type { Agent, AgentDetail, AgentCapability, AgentState, AgentHeartbeatEvent, AgentHeartbeatRun, AgentCreateInput, AgentUpdateInput, AgentTaskSession, AgentStats } from "@fusion/core";
export type { Agent, AgentDetail, AgentCapability, AgentState, AgentHeartbeatEvent, AgentHeartbeatRun, AgentCreateInput, AgentUpdateInput, AgentTaskSession, AgentStats };

function withProjectId(path: string, projectId?: string): string {
  if (!projectId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}projectId=${encodeURIComponent(projectId)}`;
}

/** Fetch all agents, optionally filtered by state or role */
export function fetchAgents(
  filter?: { state?: AgentState; role?: AgentCapability },
  projectId?: string,
): Promise<Agent[]> {
  const params = new URLSearchParams();
  if (filter?.state) params.set("state", filter.state);
  if (filter?.role) params.set("role", filter.role);
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

/** Fetch aggregate agent stats */
export function fetchAgentStats(projectId?: string): Promise<AgentStats> {
  return api<AgentStats>(withProjectId("/agents/stats", projectId));
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
 * @returns The generated title (guaranteed ≤60 characters)
 * @throws Error with descriptive message for 400/429/503 errors
 */
export async function summarizeTitle(
  description: string,
  provider?: string,
  modelId?: string
): Promise<string> {
  const res = await fetch("/api/ai/summarize-title", {
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

/** Browse directory entries for the directory picker */
export interface BrowseDirectoryResult {
  currentPath: string;
  parentPath: string | null;
  entries: Array<{ name: string; path: string; hasChildren: boolean }>;
}

export function browseDirectory(path?: string, showHidden?: boolean): Promise<BrowseDirectoryResult> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (showHidden) params.set("showHidden", "true");
  const qs = params.toString();
  return api<BrowseDirectoryResult>(`/browse-directory${qs ? `?${qs}` : ""}`);
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

/** Mission entity */
export interface Mission {
  id: string;
  title: string;
  description?: string;
  status: MissionStatus;
  interviewState: "not_started" | "in_progress" | "completed" | "needs_update";
  autoAdvance?: boolean;
  createdAt: string;
  updatedAt: string;
}

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

/** Fetch all missions */
export function fetchMissions(projectId?: string): Promise<Mission[]> {
  return api<Mission[]>(withProjectId("/missions", projectId));
}

/** Create a new mission */
export function createMission(input: { title: string; description?: string }, projectId?: string): Promise<Mission> {
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
export function startMissionInterview(missionTitle: string, projectId?: string): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/missions/interview/start", projectId), {
    method: "POST",
    body: JSON.stringify({ missionTitle }),
  });
}

/** Submit a response to the current interview question */
export function respondToMissionInterview(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string
): Promise<MissionInterviewResponse> {
  return api<MissionInterviewResponse>(withProjectId("/missions/interview/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

/** Cancel an active mission interview session */
export function cancelMissionInterview(sessionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId("/missions/interview/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
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
  }
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(withProjectId(`/missions/interview/${encodeURIComponent(sessionId)}/stream`, projectId));
  const eventSource = new EventSource(url);
  let isClosed = false;

  eventSource.onopen = () => {
    isClosed = false;
  };

  eventSource.onmessage = (event) => {
    if (event.data.startsWith(":")) return;
  };

  eventSource.addEventListener("thinking", (event: Event) => {
    try {
      const messageEvent = event as MessageEvent;
      const data = JSON.parse(messageEvent.data);
      handlers.onThinking?.(data);
    } catch {
      const messageEvent = event as MessageEvent;
      handlers.onThinking?.(messageEvent.data);
    }
  });

  eventSource.addEventListener("question", (event: Event) => {
    try {
      const messageEvent = event as MessageEvent;
      const data = JSON.parse(messageEvent.data) as PlanningQuestion;
      handlers.onQuestion?.(data);
    } catch (err) {
      console.error("[mission-interview] Failed to parse question event:", err);
    }
  });

  eventSource.addEventListener("summary", (event: Event) => {
    try {
      const messageEvent = event as MessageEvent;
      const data = JSON.parse(messageEvent.data) as MissionPlanSummary;
      handlers.onSummary?.(data);
    } catch (err) {
      console.error("[mission-interview] Failed to parse summary event:", err);
    }
  });

  eventSource.addEventListener("error", (event: Event) => {
    try {
      const messageEvent = event as MessageEvent;
      const data = JSON.parse(messageEvent.data);
      handlers.onError?.(data.message || data);
    } catch {
      const messageEvent = event as MessageEvent;
      handlers.onError?.(messageEvent.data || "Stream error");
    }
    close();
  });

  eventSource.addEventListener("complete", () => {
    handlers.onComplete?.();
    close();
  });

  eventSource.onerror = () => {
    if (!isClosed) {
      handlers.onError?.("Connection lost");
      close();
    }
  };

  function close() {
    if (!isClosed) {
      isClosed = true;
      eventSource.close();
    }
  }

  return {
    close,
    isConnected: () => !isClosed && eventSource.readyState === EventSource.OPEN,
  };
}

// ── AI Sessions (Background Tasks) ─────────────────────────────────────────

export interface AiSessionSummary {
  id: string;
  type: "planning" | "subtask" | "mission_interview";
  status: "generating" | "awaiting_input" | "complete" | "error";
  title: string;
  projectId: string | null;
  updatedAt: string;
}

export interface AiSessionDetail extends AiSessionSummary {
  inputPayload: string;
  conversationHistory: string;
  currentQuestion: string | null;
  result: string | null;
  thinkingOutput: string;
  error: string | null;
  createdAt: string;
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

export async function deleteAiSession(id: string): Promise<void> {
  await fetch(buildApiUrl(`/ai-sessions/${encodeURIComponent(id)}`), { method: "DELETE" });
}
