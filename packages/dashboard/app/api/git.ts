/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Git remotes, PR management, terminal sessions, and git management client API peeled from legacy.ts.
 */

import type { PrConflictDiagnostics, PrInfo, TaskDetail, BatchStatusResult, BatchStatusResponse } from "@fusion/core";
import { api } from "./client.js";
import { withProjectId } from "./health.js";

/** Append repoPath query param for workspace-mode sub-repo targeting */
function withRepoPath(path: string, repoPath?: string): string {
  if (!repoPath) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}repoPath=${encodeURIComponent(repoPath)}`;
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
export function fetchGitRemotes(projectId?: string, repoPath?: string): Promise<GitRemote[]> {
  return api<GitRemote[]>(withRepoPath(withProjectId("/git/remotes", projectId), repoPath));
}

/** Detailed git remote info with fetch and push URLs */
export interface GitRemoteDetailed {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/** Fetch all git remotes with their fetch and push URLs */
export function fetchGitRemotesDetailed(projectId?: string, repoPath?: string): Promise<GitRemoteDetailed[]> {
  return api<GitRemoteDetailed[]>(withRepoPath(withProjectId("/git/remotes/detailed", projectId), repoPath));
}

/** Add a new git remote */
export function addGitRemote(name: string, url: string, projectId?: string, repoPath?: string): Promise<void> {
  return api<void>(withRepoPath(withProjectId("/git/remotes", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ name, url }),
  });
}

/** Remove a git remote */
export function removeGitRemote(name: string, projectId?: string, repoPath?: string): Promise<void> {
  return api<void>(withRepoPath(withProjectId(`/git/remotes/${encodeURIComponent(name)}`, projectId), repoPath), {
    method: "DELETE",
  });
}

/** Rename a git remote */
export function renameGitRemote(name: string, newName: string, projectId?: string, repoPath?: string): Promise<void> {
  return api<void>(withRepoPath(withProjectId(`/git/remotes/${encodeURIComponent(name)}`, projectId), repoPath), {
    method: "PATCH",
    body: JSON.stringify({ newName }),
  });
}

/** Update the URL for a git remote */
export function updateGitRemoteUrl(name: string, url: string, projectId?: string, repoPath?: string): Promise<void> {
  return api<void>(withRepoPath(withProjectId(`/git/remotes/${encodeURIComponent(name)}/url`, projectId), repoPath), {
    method: "PUT",
    body: JSON.stringify({ url }),
  });
}

// --- PR Management API ---

export interface PrCheckStatus {
  name: string;
  required: boolean;
  state: string;
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PrStatusResponse {
  prInfo: PrInfo;
  prInfos?: PrInfo[];
  stale: boolean;
  automationStatus?: string | null;
}

export interface PrRefreshEntry {
  prInfo: PrInfo;
  conflictDiagnostics?: PrConflictDiagnostics;
  mergeReady: boolean;
  mergeable?: PrInfo["mergeable"];
  blockingReasons: string[];
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: PrCheckStatus[];
  automationStatus?: string | null;
  conflictReclaimQueued?: boolean;
}

export interface PrRefreshResponse extends PrRefreshEntry {
  primary: PrRefreshEntry;
  all: PrRefreshEntry[];
}

export interface PrMergeResponse {
  prInfo: PrInfo;
  alreadyMerged?: boolean;
}

export interface PrChecksResponse {
  prInfos?: PrInfo[];
  checks: PrCheckStatus[];
  rollup: "success" | "pending" | "failure" | "unknown";
  lastCheckedAt: string;
}

export interface PrReviewThreadItem {
  id: string;
  author: string;
  text: string;
  source?: "github-review" | "github-review-comment";
  externalId?: string;
  reviewState?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  createdAt: string;
}

export interface PrReviewsResponse {
  prInfos?: PrInfo[];
  snapshot: {
    decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
    items: Array<{
      id: string;
      author: { login: string };
      body: string;
      state?: string;
      htmlUrl?: string;
      createdAt: string;
    }>;
  };
  comments: PrReviewThreadItem[];
}

export interface PrMetadataResponse {
  title: string;
  body: string;
  templateUsed: boolean;
}

export interface PrPreflightCommit {
  sha: string;
  subject: string;
  author: string;
}

export interface PrPreflightChangedFile {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface PrPreflightResponse {
  branchOnRemote: boolean;
  commitsPresent: boolean;
  conflictsWithBase: boolean;
  ghAuthOk: boolean;
  defaultBaseBranch: string;
  head: string;
  commits: PrPreflightCommit[];
  changedFiles: PrPreflightChangedFile[];
}

export interface ResolvePrConflictsResult {
  resolved: boolean;
  pushed: boolean;
  conflictedFiles: string[];
  message: string;
}

export interface ResolvePrConflictsResponse {
  result: ResolvePrConflictsResult;
  preflight: PrPreflightResponse;
}

export interface PushPrBranchResult {
  pushed: boolean;
  head: string;
  message: string;
}

export interface PushPrBranchResponse {
  result: PushPrBranchResult;
  preflight: PrPreflightResponse;
}

export interface PrOptionsUser {
  login: string;
  name?: string;
}

export interface PrOptionsLabel {
  name: string;
  color: string;
}

export interface PrOptionsResponse {
  baseBranches: string[];
  reviewers: PrOptionsUser[];
  assignees: PrOptionsUser[];
  labels: PrOptionsLabel[];
}

export interface CreatePrParams {
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
  reviewers?: string[];
  assignees?: string[];
  labels?: string[];
}

/** Generate AI metadata for creating a GitHub PR for a task */
export function generatePrMetadata(id: string, projectId?: string): Promise<PrMetadataResponse> {
  return api<PrMetadataResponse>(withProjectId(`/tasks/${id}/pr/generate-metadata`, projectId), {
    method: "POST",
  });
}

/** Fetch PR preflight diagnostics for a task */
export function fetchPrPreflight(id: string, projectId?: string, base?: string): Promise<PrPreflightResponse> {
  const baseParam = base ? `?base=${encodeURIComponent(base)}` : "";
  return api<PrPreflightResponse>(withProjectId(`/tasks/${id}/pr/preflight${baseParam}`, projectId));
}

/** Ask Fusion to resolve Create-PR merge conflicts for a task branch */
export function resolvePrConflicts(id: string, base?: string, projectId?: string): Promise<ResolvePrConflictsResponse> {
  return api<ResolvePrConflictsResponse>(withProjectId(`/tasks/${id}/pr/resolve-conflicts`, projectId), {
    method: "POST",
    ...(base ? { body: JSON.stringify({ base }) } : {}),
  });
}

/** Push the Create-PR task branch to origin and refresh preflight state */
export function pushPrBranch(id: string, base?: string, projectId?: string): Promise<PushPrBranchResponse> {
  return api<PushPrBranchResponse>(withProjectId(`/tasks/${id}/pr/push-branch`, projectId), {
    method: "POST",
    ...(base ? { body: JSON.stringify({ base }) } : {}),
  });
}

/** Fetch PR creation options (branches/reviewers/assignees/labels) for a task */
export function fetchPrOptions(id: string, projectId?: string): Promise<PrOptionsResponse> {
  return api<PrOptionsResponse>(withProjectId(`/tasks/${id}/pr/options`, projectId));
}

/** Create a GitHub PR for a task */
export function createPr(
  id: string,
  params: CreatePrParams,
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

export function unlinkPr(taskId: string, number: number, projectId?: string): Promise<{ task: TaskDetail; prInfos: PrInfo[] }> {
  return api<{ task: TaskDetail; prInfos: PrInfo[] }>(withProjectId(`/tasks/${taskId}/pr/${number}/unlink`, projectId), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function reclaimPrConflict(id: string, projectId?: string): Promise<{ queued: boolean; reason?: string }> {
  return api<{ queued: boolean; reason?: string }>(withProjectId(`/tasks/${id}/pr/reclaim-conflict`, projectId), {
    method: "POST",
  });
}

export function mergePr(id: string, method?: "merge" | "squash" | "rebase", projectId?: string, prNumber?: number): Promise<PrMergeResponse> {
  const search = prNumber ? `?pr=${encodeURIComponent(String(prNumber))}` : "";
  return api<PrMergeResponse>(withProjectId(`/tasks/${id}/pr/merge${search}`, projectId), {
    method: "POST",
    body: JSON.stringify(method ? { method } : {}),
  });
}

export function setAutoMergeOnGreen(
  id: string,
  enabled: boolean,
  strategy?: "merge" | "squash" | "rebase",
  projectId?: string,
  prNumber?: number,
): Promise<{ prInfo: PrInfo }> {
  const search = prNumber ? `?pr=${encodeURIComponent(String(prNumber))}` : "";
  return api<{ prInfo: PrInfo }>(withProjectId(`/tasks/${id}/pr/auto-merge${search}`, projectId), {
    method: "POST",
    body: JSON.stringify({ enabled, strategy }),
  });
}

/** Fetch all PR checks for a task */
export function fetchPrChecks(id: string, projectId?: string, prNumber?: number): Promise<PrChecksResponse> {
  const search = prNumber ? `?pr=${encodeURIComponent(String(prNumber))}` : "";
  return api<PrChecksResponse>(withProjectId(`/tasks/${id}/pr/checks${search}`, projectId));
}

export function fetchPrReviews(id: string, projectId?: string, prNumber?: number): Promise<PrReviewsResponse> {
  const search = prNumber ? `?pr=${encodeURIComponent(String(prNumber))}` : "";
  return api<PrReviewsResponse>(withProjectId(`/tasks/${id}/pr/reviews${search}`, projectId));
}

// --- Issue Management API ---

/** Re-export GitHub badge-related types for convenience */
export type { IssueInfo, BatchStatusResult, BatchStatusEntry, PrInfo } from "@fusion/core";

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
  // Returned only when `?extended=1` is passed to GET /api/git/status.
  headSha?: string;
  integrationBranch?: string;
  integrationBranchSource?: "settings" | "origin-head" | "fallback";
  isOnIntegrationBranch?: boolean;
  /** True when `git branch --show-current` failed (transient git error,
   *  permission, etc.). Distinct from detached HEAD (command succeeds with
   *  empty stdout). UI surfaces "branch detection unavailable" rather than
   *  silently hiding the wrong-branch warning. */
  currentBranchDetectionFailed?: boolean;
  integrationTipSha?: string | null;
  /** "local" = `refs/heads/<branch>` exists; "remote-only" = only
   *  `refs/remotes/origin/<branch>` exists and was used as fallback;
   *  "missing" = neither ref exists. */
  integrationTipSource?: "local" | "remote-only" | "missing";
  originIntegrationTipSha?: string | null;
  /** HEAD vs the **local** integration tip. Undefined when the branch
   *  exists only as a remote-tracking ref. */
  aheadOfIntegration?: number;
  behindIntegration?: number;
  /** HEAD vs `origin/<integrationBranch>`. Defined whenever the remote
   *  tracking ref exists, regardless of whether the local ref does. */
  aheadOfIntegrationRemote?: number;
  behindIntegrationRemote?: number;
  /** Local integration tip vs `origin/<integrationBranch>`. Defined only
   *  when both refs exist. */
  aheadOfOriginIntegration?: number;
  behindOriginIntegration?: number;
  dirtyDetails?: {
    staged: number;
    modified: number;
    untracked: number;
    conflicted: number;
    sample: string[];
  };
  indexStaleVsHead?: boolean;
  stashCount?: number;
  recentMergeAdvances?: Array<{
    taskId: string;
    fromSha: string | null;
    toSha: string;
    advancedAt: string;
    autoSyncOutcome?: string;
    needsAction: boolean;
    resolution: "reachable" | "orphaned" | "subsumed" | "superseded" | "pending";
  }>;
}

/** Git commit info */
export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  body?: string;
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
  autostashed?: boolean;
  stashReapplied?: boolean;
  stashConflict?: boolean;
}

/** Result of a push operation */
export interface GitPushResult {
  success: boolean;
  message: string;
}

/** Fetch current git status. Pass `extended` to also get integration-branch
 *  resolution, ahead/behind vs both local and origin integration tip, dirty
 *  breakdown, stash count, index-stale detection, and recent merge-advance
 *  audit events for the project-root worktree. */
export function fetchGitStatus(projectId?: string, opts?: { extended?: boolean }, repoPath?: string): Promise<GitStatus> {
  const base = withRepoPath(withProjectId("/git/status", projectId), repoPath);
  if (!opts?.extended) return api<GitStatus>(base);
  const sep = base.includes("?") ? "&" : "?";
  return api<GitStatus>(`${base}${sep}extended=1`);
}

/** Append the read-only commit worktree target query param used only by commit list/diff endpoints. */
function withCommitWorktreePath(path: string, worktreePath?: string): string {
  if (!worktreePath) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}worktreePath=${encodeURIComponent(worktreePath)}`;
}

/** Fetch recent commits */
export function fetchGitCommits(limit?: number, projectId?: string, repoPath?: string, worktreePath?: string): Promise<GitCommit[]> {
  const query = limit ? `?limit=${limit}` : "";
  return api<GitCommit[]>(withCommitWorktreePath(withRepoPath(withProjectId(`/git/commits${query}`, projectId), repoPath), worktreePath));
}

/** Fetch diff for a specific commit */
export function fetchCommitDiff(hash: string, projectId?: string, repoPath?: string, worktreePath?: string): Promise<{ stat: string; patch: string }> {
  return api<{ stat: string; patch: string }>(withCommitWorktreePath(withRepoPath(withProjectId(`/git/commits/${hash}/diff`, projectId), repoPath), worktreePath));
}

/** Fetch local commits ahead of the upstream tracking branch (commits to push) */
export function fetchAheadCommits(projectId?: string, repoPath?: string): Promise<GitCommit[]> {
  return api<GitCommit[]>(withRepoPath(withProjectId("/git/commits/ahead", projectId), repoPath));
}

/** Fetch recent commits for a specific remote */
export function fetchRemoteCommits(remote: string, ref?: string, limit?: number, projectId?: string, repoPath?: string): Promise<GitCommit[]> {
  const params = new URLSearchParams();
  if (ref) params.set("ref", ref);
  if (limit) params.set("limit", String(limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<GitCommit[]>(withRepoPath(withProjectId(`/git/remotes/${encodeURIComponent(remote)}/commits${query}`, projectId), repoPath));
}

/** Fetch branch names known on a specific remote (from local remote-tracking refs). */
export function fetchGitRemoteBranches(remote: string, projectId?: string, repoPath?: string): Promise<string[]> {
  return api<string[]>(withRepoPath(withProjectId(`/git/remotes/${encodeURIComponent(remote)}/branches`, projectId), repoPath));
}

/** Fetch all local branches */
export function fetchGitBranches(projectId?: string, repoPath?: string): Promise<GitBranch[]> {
  return api<GitBranch[]>(withRepoPath(withProjectId("/git/branches", projectId), repoPath));
}

/** Fetch recent commits for a specific branch */
export function fetchBranchCommits(branchName: string, limit?: number, projectId?: string, repoPath?: string): Promise<GitCommit[]> {
  const query = limit ? `?limit=${limit}` : "";
  return api<GitCommit[]>(withRepoPath(withProjectId(`/git/branches/${encodeURIComponent(branchName)}/commits${query}`, projectId), repoPath));
}

/** Fetch all worktrees */
export function fetchGitWorktrees(projectId?: string, repoPath?: string): Promise<GitWorktree[]> {
  return api<GitWorktree[]>(withRepoPath(withProjectId("/git/worktrees", projectId), repoPath));
}

/** Create a new branch */
export function createBranch(name: string, base?: string, projectId?: string, repoPath?: string): Promise<void> {
  return api<void>(withRepoPath(withProjectId("/git/branches", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ name, base }),
  });
}

/** Checkout an existing branch */
export function checkoutBranch(name: string, projectId?: string, repoPath?: string): Promise<void> {
  return api<void>(withRepoPath(withProjectId(`/git/branches/${encodeURIComponent(name)}/checkout`, projectId), repoPath), {
    method: "POST",
  });
}

/** Delete a branch */
export function deleteBranch(name: string, force?: boolean, projectId?: string, repoPath?: string): Promise<void> {
  const query = force ? "?force=true" : "";
  return api<void>(withRepoPath(withProjectId(`/git/branches/${encodeURIComponent(name)}${query}`, projectId), repoPath), {
    method: "DELETE",
  });
}

/** Fetch from remote */
export function fetchRemote(remote?: string, projectId?: string, repoPath?: string): Promise<GitFetchResult> {
  return api<GitFetchResult>(withRepoPath(withProjectId("/git/fetch", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ remote }),
  });
}

/** Pull current branch */
export function pullBranch(options?: { rebase?: boolean }, projectId?: string, repoPath?: string): Promise<GitPullResult>;
export function pullBranch(projectId?: string, repoPath?: string): Promise<GitPullResult>;
export function pullBranch(
  optionsOrProjectId?: { rebase?: boolean } | string,
  projectId?: string,
  repoPath?: string,
): Promise<GitPullResult> {
  // FNXC:DashboardGitApi 2026-06-24-00:00:
  // pullBranch has two overloads. In the string-arg style pullBranch(projectId, repoPath),
  // the second positional carries repoPath (not the 3rd parameter), so resolve it from `projectId`
  // to avoid dropping repoPath; otherwise multi-repo workspace pulls hit the wrong repo.
  const isStringForm = typeof optionsOrProjectId === "string";
  const options = isStringForm ? undefined : optionsOrProjectId;
  const resolvedProjectId = isStringForm ? optionsOrProjectId : projectId;
  const resolvedRepoPath = isStringForm ? projectId : repoPath;

  return api<GitPullResult>(withRepoPath(withProjectId("/git/pull", resolvedProjectId), resolvedRepoPath), {
    method: "POST",
    body: JSON.stringify({ rebase: options?.rebase ?? false }),
  });
}

/** Push current branch */
export function pushBranch(projectId?: string, repoPath?: string): Promise<GitPushResult> {
  return api<GitPushResult>(withRepoPath(withProjectId("/git/push", projectId), repoPath), {
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
export function fetchGitStashList(projectId?: string, repoPath?: string): Promise<GitStash[]> {
  return api<GitStash[]>(withRepoPath(withProjectId("/git/stashes", projectId), repoPath));
}

/** Create a new stash */
export function createStash(message?: string, projectId?: string, repoPath?: string): Promise<{ message: string }> {
  return api<{ message: string }>(withRepoPath(withProjectId("/git/stashes", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

/** Apply a stash entry */
export function applyStash(index: number, drop?: boolean, projectId?: string, repoPath?: string): Promise<{ message: string }> {
  return api<{ message: string }>(withRepoPath(withProjectId(`/git/stashes/${index}/apply`, projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ drop }),
  });
}

/** Drop a stash entry */
export function dropStash(index: number, projectId?: string, repoPath?: string): Promise<{ message: string }> {
  return api<{ message: string }>(withRepoPath(withProjectId(`/git/stashes/${index}`, projectId), repoPath), {
    method: "DELETE",
  });
}

/** Fetch stash diff (stat + patch) */
export function fetchStashDiff(index: number, projectId?: string, repoPath?: string): Promise<{ stat: string; patch: string }> {
  return api<{ stat: string; patch: string }>(withRepoPath(withProjectId(`/git/stashes/${index}/diff`, projectId), repoPath));
}

/** Fetch unstaged diff (working directory changes) */
export function fetchUnstagedDiff(projectId?: string, repoPath?: string): Promise<{ stat: string; patch: string }> {
  return api<{ stat: string; patch: string }>(withRepoPath(withProjectId("/git/diff", projectId), repoPath));
}

/** Fetch diff for a specific file in staged or unstaged mode */
export function fetchGitFileDiff(path: string, staged: boolean, projectId?: string, repoPath?: string): Promise<{ stat: string; patch: string }> {
  const params = new URLSearchParams();
  params.set("path", path);
  params.set("staged", String(staged));
  return api<{ stat: string; patch: string }>(withRepoPath(withProjectId(`/git/diff/file?${params.toString()}`, projectId), repoPath));
}

/** Fetch file changes (staged and unstaged) */
export function fetchFileChanges(projectId?: string, repoPath?: string): Promise<GitFileChange[]> {
  return api<GitFileChange[]>(withRepoPath(withProjectId("/git/changes", projectId), repoPath));
}

/** Stage specific files */
export function stageFiles(files: string[], projectId?: string, repoPath?: string): Promise<{ staged: string[] }> {
  return api<{ staged: string[] }>(withRepoPath(withProjectId("/git/stage", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

/** Unstage specific files */
export function unstageFiles(files: string[], projectId?: string, repoPath?: string): Promise<{ unstaged: string[] }> {
  return api<{ unstaged: string[] }>(withRepoPath(withProjectId("/git/unstage", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

/** Create a commit */
export function createCommit(message: string, projectId?: string, repoPath?: string): Promise<{ hash: string; message: string }> {
  return api<{ hash: string; message: string }>(withRepoPath(withProjectId("/git/commit", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

/** Discard changes in working directory for specific files */
export function discardChanges(files: string[], projectId?: string, repoPath?: string): Promise<{ discarded: string[] }> {
  return api<{ discarded: string[] }>(withRepoPath(withProjectId("/git/discard", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

