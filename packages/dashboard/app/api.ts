import type { Task, TaskDetail, TaskAttachment, TaskCreateInput, AgentLogEntry, Column, MergeResult, Settings } from "@kb/core";
import type { PlanningQuestion, PlanningSummary, PlanningResponse } from "@kb/core";

async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || "Request failed");
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

export function approvePlan(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/approve-plan`, { method: "POST" });
}

export function rejectPlan(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/reject-plan`, { method: "POST" });
}

export function fetchConfig(): Promise<{ maxConcurrent: number }> {
  return api<{ maxConcurrent: number }>("/config");
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

/** Usage window for a provider (e.g., "Session (5h)", "Weekly") */
export interface UsageWindow {
  label: string;
  percentUsed: number; // 0-100
  percentLeft: number; // 0-100
  resetText: string | null; // e.g., "resets in 2h"
  resetMs?: number; // ms until reset
  windowDurationMs?: number; // total window length
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

/** Re-export IssueInfo type for convenience */
export type { IssueInfo } from "@kb/core";

/** Fetch cached issue status for a task */
export function fetchIssueStatus(id: string): Promise<{ issueInfo: import("@kb/core").IssueInfo; stale: boolean }> {
  return api<{ issueInfo: import("@kb/core").IssueInfo; stale: boolean }>(`/tasks/${id}/issue/status`);
}

/** Force refresh issue status from GitHub */
export function refreshIssueStatus(id: string): Promise<import("@kb/core").IssueInfo> {
  return api<import("@kb/core").IssueInfo>(`/tasks/${id}/issue/refresh`, {
    method: "POST",
  });
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

// --- Planning Mode API ---

/** Planning session state returned from API */
export interface PlanningSession {
  sessionId: string;
  currentQuestion: PlanningQuestion | null;
  summary: PlanningSummary | null;
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
