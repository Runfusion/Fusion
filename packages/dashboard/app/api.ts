import type { Task, TaskDetail, TaskAttachment, TaskCreateInput, AgentLogEntry, Column, MergeResult, Settings } from "@kb/core";

async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || "Request failed");
  return data as T;
}

export function fetchTasks(): Promise<Task[]> {
  return api<Task[]>("/tasks");
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
  return api<Task>("/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateTask(id: string, updates: { title?: string; description?: string; prompt?: string; dependencies?: string[]; modelProvider?: string; modelId?: string; validatorModelProvider?: string; validatorModelId?: string }): Promise<Task> {
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
export function fetchPrStatus(id: string): Promise<{ prInfo: PrInfo; stale: boolean }> {
  return api<{ prInfo: PrInfo; stale: boolean }>(`/tasks/${id}/pr/status`);
}

/** Force refresh PR status from GitHub */
export function refreshPrStatus(id: string): Promise<PrInfo> {
  return api<PrInfo>(`/tasks/${id}/pr/refresh`, {
    method: "POST",
  });
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
