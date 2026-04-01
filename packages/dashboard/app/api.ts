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

export function fetchTasks(limit?: number, offset?: number): Promise<Task[]> {
  const search = new URLSearchParams();
  if (limit !== undefined) search.set("limit", String(limit));
  if (offset !== undefined) search.set("offset", String(offset));
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return api<Task[]>(`/tasks${suffix}`);
}

export async function fetchTaskDetail(id: string): Promise<TaskDetail> {
  const maxAttempts = 2; // 1 initial + 1 retry
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`/api/tasks/${id}`, {
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

export function createTask(input: TaskCreateInput): Promise<Task> {
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

  return api<Task>("/tasks", {
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

export function updateTask(id: string, updates: { title?: string; description?: string; prompt?: string; dependencies?: string[]; modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null }): Promise<Task> {
  return api<Task>(`/tasks/${id}`, {
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
): Promise<{ updated: Task[]; count: number }> {
  return api<{ updated: Task[]; count: number }>("/tasks/batch-update-models", {
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

export function moveTask(id: string, column: Column): Promise<Task> {
  return api<Task>(`/tasks/${id}/move`, {
    method: "POST",
    body: JSON.stringify({ column }),
  });
}

export function deleteTask(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}`, { method: "DELETE" });
}

export function mergeTask(id: string): Promise<MergeResult> {
  return api<MergeResult>(`/tasks/${id}/merge`, { method: "POST" });
}

export function retryTask(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/retry`, { method: "POST" });
}

export function duplicateTask(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/duplicate`, { method: "POST" });
}

export function pauseTask(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/pause`, { method: "POST" });
}

export function unpauseTask(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/unpause`, { method: "POST" });
}

export function archiveTask(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/archive`, { method: "POST" });
}

export function unarchiveTask(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/unarchive`, { method: "POST" });
}

export function archiveAllDone(): Promise<Task[]> {
  return api<{ archived: Task[] }>("/tasks/archive-all-done", { method: "POST" }).then(
    (response) => response.archived
  );
}

export function approvePlan(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/approve-plan`, { method: "POST" });
}

export function rejectPlan(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/reject-plan`, { method: "POST" });
}

export function fetchConfig(): Promise<{ maxConcurrent: number; rootDir: string }> {
  return api<{ maxConcurrent: number; rootDir: string }>("/config");
}

export function fetchSettings(): Promise<Settings> {
  return api<Settings>("/settings");
}

export function updateSettings(settings: Partial<Settings>): Promise<Settings> {
  return api<Settings>("/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

/** Fetch global (user-level) settings from ~/.pi/kb/settings.json */
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
export function fetchSettingsByScope(): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
  return api<{ global: GlobalSettings; project: Partial<ProjectSettings> }>("/settings/scopes");
}

export function testNtfyNotification(config?: { ntfyEnabled?: boolean; ntfyTopic?: string }): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/settings/test-ntfy", {
    method: "POST",
    body: config ? JSON.stringify(config) : undefined,
  });
}

export async function uploadAttachment(id: string, file: File): Promise<TaskAttachment> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`/api/tasks/${id}/attachments`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || "Upload failed");
  return data as TaskAttachment;
}

export async function deleteAttachment(id: string, filename: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/attachments/${filename}`, { method: "DELETE" });
}

export function fetchAgentLogs(taskId: string): Promise<AgentLogEntry[]> {
  return api<AgentLogEntry[]>(`/tasks/${taskId}/logs`);
}

export function fetchSessionFiles(taskId: string): Promise<string[]> {
  return api<string[]>(`/tasks/${taskId}/session-files`);
}

export function fetchTaskComments(id: string): Promise<TaskComment[]> {
  return api<TaskComment[]>(`/tasks/${id}/comments`);
}

export function addTaskComment(id: string, text: string, author?: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({ text, author }),
  });
}

export function updateTaskComment(id: string, commentId: string, text: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/comments/${commentId}`, {
    method: "PATCH",
    body: JSON.stringify({ text }),
  });
}

export function deleteTaskComment(id: string, commentId: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/comments/${commentId}`, {
    method: "DELETE",
  });
}

export function addSteeringComment(id: string, text: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/steer`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function requestSpecRevision(id: string, feedback: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/spec/revise`, {
    method: "POST",
    body: JSON.stringify({ feedback }),
  });
}

export function refineTask(id: string, feedback: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/refine`, {
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

/** Fetch available AI models from the model registry */
export function fetchModels(): Promise<ModelInfo[]> {
  return api<ModelInfo[]>("/models");
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
  params: { title: string; body?: string; base?: string }
): Promise<PrInfo> {
  return api<PrInfo>(`/tasks/${id}/pr/create`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/** Fetch cached PR status for a task */
export function fetchPrStatus(id: string): Promise<PrStatusResponse> {
  return api<PrStatusResponse>(`/tasks/${id}/pr/status`);
}

/** Force refresh PR status from GitHub */
export function refreshPrStatus(id: string): Promise<PrRefreshResponse> {
  return api<PrRefreshResponse>(`/tasks/${id}/pr/refresh`, {
    method: "POST",
  });
}

// --- Issue Management API ---

/** Re-export GitHub badge-related types for convenience */
export type { IssueInfo, BatchStatusResult, BatchStatusEntry } from "@fusion/core";

/** Fetch cached issue status for a task */
export function fetchIssueStatus(id: string): Promise<{ issueInfo: import("@fusion/core").IssueInfo; stale: boolean }> {
  return api<{ issueInfo: import("@fusion/core").IssueInfo; stale: boolean }>(`/tasks/${id}/issue/status`);
}

/** Force refresh issue status from GitHub */
export function refreshIssueStatus(id: string): Promise<import("@fusion/core").IssueInfo> {
  return api<import("@fusion/core").IssueInfo>(`/tasks/${id}/issue/refresh`, {
    method: "POST",
  });
}

/** Batch-refresh cached GitHub badge status for multiple tasks. */
export async function fetchBatchStatus(taskIds: string[]): Promise<BatchStatusResult> {
  const response = await api<BatchStatusResponse>("/github/batch/status", {
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
export function startPlanning(initialPlan: string): Promise<PlanningSession> {
  return api<PlanningSession>("/planning/start", {
    method: "POST",
    body: JSON.stringify({ initialPlan }),
  });
}

/** Start a new planning session with AI streaming support */
export function startPlanningStreaming(initialPlan: string): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>("/planning/start-streaming", {
    method: "POST",
    body: JSON.stringify({ initialPlan }),
  });
}

/** Submit a response to the current planning question */
export function respondToPlanning(
  sessionId: string,
  responses: Record<string, unknown>
): Promise<PlanningSession> {
  return api<PlanningSession>("/planning/respond", {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

/** Cancel an active planning session */
export function cancelPlanning(sessionId: string): Promise<void> {
  return api<void>("/planning/cancel", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

/** Create a task from a completed planning session */
export function createTaskFromPlanning(sessionId: string): Promise<Task> {
  return api<Task>("/planning/create-task", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

/** Get the SSE stream URL for a planning session */
export function getPlanningStreamUrl(sessionId: string): string {
  return `/api/planning/${encodeURIComponent(sessionId)}/stream`;
}

/** Connect to planning session SSE stream and handle events
 * 
 * Returns an object with:
 * - close: function to close the connection
 * - reconnect: function to reconnect after error
 */
export function connectPlanningStream(
  sessionId: string,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: PlanningSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
  }
): { close: () => void; isConnected: () => boolean } {
  const url = getPlanningStreamUrl(sessionId);
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
export function fetchWorkflowSteps(): Promise<WorkflowStep[]> {
  return api<WorkflowStep[]>("/workflow-steps");
}

/** Create a new workflow step */
export function createWorkflowStep(input: WorkflowStepInput): Promise<WorkflowStep> {
  return api<WorkflowStep>("/workflow-steps", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update a workflow step */
export function updateWorkflowStep(id: string, updates: Partial<WorkflowStepInput>): Promise<WorkflowStep> {
  return api<WorkflowStep>(`/workflow-steps/${id}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a workflow step */
export function deleteWorkflowStep(id: string): Promise<void> {
  return api<void>(`/workflow-steps/${id}`, { method: "DELETE" });
}

/** Refine a workflow step's prompt using AI */
export function refineWorkflowStepPrompt(id: string): Promise<{ prompt: string; workflowStep: WorkflowStep }> {
  return api<{ prompt: string; workflowStep: WorkflowStep }>(`/workflow-steps/${id}/refine`, {
    method: "POST",
  });
}

/** Fetch workflow step results for a task */
export function fetchWorkflowResults(taskId: string): Promise<WorkflowStepResult[]> {
  return api<WorkflowStepResult[]>(`/tasks/${encodeURIComponent(taskId)}/workflow-results`);
}

// ── Workflow Step Templates ──────────────────────────────────────────────

/** Re-export WorkflowStepTemplate type from core */
export type { WorkflowStepTemplate } from "@fusion/core";

/** Fetch all built-in workflow step templates */
export function fetchWorkflowStepTemplates(): Promise<{ templates: import("@fusion/core").WorkflowStepTemplate[] }> {
  return api<{ templates: import("@fusion/core").WorkflowStepTemplate[] }>("/workflow-step-templates");
}

/** Create a workflow step from a built-in template */
export function createWorkflowStepFromTemplate(templateId: string): Promise<WorkflowStep> {
  return api<WorkflowStep>(`/workflow-step-templates/${encodeURIComponent(templateId)}/create`, {
    method: "POST",
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


export function startSubtaskBreakdown(description: string): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>("/subtasks/start-streaming", {
    method: "POST",
    body: JSON.stringify({ description }),
  });
}

export function getSubtaskStreamUrl(sessionId: string): string {
  return `/api/subtasks/${encodeURIComponent(sessionId)}/stream`;
}

export function connectSubtaskStream(
  sessionId: string,
  handlers: {
    onThinking?: (data: string) => void;
    onSubtasks?: (data: SubtaskItem[]) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
  }
): { close: () => void; isConnected: () => boolean } {
  const eventSource = new EventSource(getSubtaskStreamUrl(sessionId));
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
      handlers.onError?.(JSON.parse(messageEvent.data) as string);
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
): Promise<{ tasks: Task[]; parentTaskClosed?: boolean }> {
  return api<{ tasks: Task[]; parentTaskClosed?: boolean }>("/subtasks/create-tasks", {
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

export function cancelSubtaskBreakdown(sessionId: string): Promise<void> {
  return api<void>("/subtasks/cancel", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

// ── Agent API ────────────────────────────────────────────────────────────

import type { Agent, AgentDetail, AgentCapability, AgentState, AgentHeartbeatEvent, AgentCreateInput, AgentUpdateInput } from "@fusion/core";
export type { Agent, AgentDetail, AgentCapability, AgentState, AgentHeartbeatEvent, AgentCreateInput, AgentUpdateInput };

/** Fetch all agents, optionally filtered by state or role */
export function fetchAgents(filter?: { state?: AgentState; role?: AgentCapability }): Promise<Agent[]> {
  const params = new URLSearchParams();
  if (filter?.state) params.set("state", filter.state);
  if (filter?.role) params.set("role", filter.role);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<Agent[]>(`/agents${query}`);
}

/** Fetch a single agent with heartbeat history */
export function fetchAgent(agentId: string): Promise<AgentDetail> {
  return api<AgentDetail>(`/agents/${encodeURIComponent(agentId)}`);
}

/** Create a new agent */
export function createAgent(input: AgentCreateInput): Promise<Agent> {
  return api<Agent>("/agents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update an agent */
export function updateAgent(agentId: string, updates: AgentUpdateInput): Promise<Agent> {
  return api<Agent>(`/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Update an agent's state */
export function updateAgentState(agentId: string, state: AgentState): Promise<Agent> {
  return api<Agent>(`/agents/${encodeURIComponent(agentId)}/state`, {
    method: "POST",
    body: JSON.stringify({ state }),
  });
}

/** Delete an agent */
export function deleteAgent(agentId: string): Promise<void> {
  return api<void>(`/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
}

/** Record a heartbeat for an agent */
export function recordAgentHeartbeat(agentId: string, status: "ok" | "missed" | "recovered" = "ok"): Promise<AgentHeartbeatEvent> {
  return api<AgentHeartbeatEvent>(`/agents/${encodeURIComponent(agentId)}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

/** Fetch heartbeat history for an agent */
export function fetchAgentHeartbeats(agentId: string, limit?: number): Promise<AgentHeartbeatEvent[]> {
  const query = limit !== undefined ? `?limit=${limit}` : "";
  return api<AgentHeartbeatEvent[]>(`/agents/${encodeURIComponent(agentId)}/heartbeats${query}`);
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
export function fetchBackups(): Promise<BackupListResponse> {
  return api<BackupListResponse>("/backups");
}

/** Create a new database backup immediately */
export function createBackup(): Promise<BackupCreateResponse> {
  return api<BackupCreateResponse>("/backups", { method: "POST" });
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
export function exportSettings(scope?: 'global' | 'project' | 'both'): Promise<SettingsExportData> {
  const query = scope ? `?scope=${scope}` : "";
  return api<SettingsExportData>(`/settings/export${query}`);
}

/** Import settings from JSON data */
export function importSettings(
  data: SettingsExportData,
  options?: { scope?: 'global' | 'project' | 'both'; merge?: boolean }
): Promise<SettingsImportResponse> {
  return api<SettingsImportResponse>("/settings/import", {
    method: "POST",
    body: JSON.stringify({
      data,
      scope: options?.scope ?? "both",
      merge: options?.merge ?? true,
    }),
  });
}
