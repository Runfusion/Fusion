/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * GitHub issue/PR import client API peeled from legacy.ts.
 */

import type { Task } from "@fusion/core";
import { api } from "../client/client.js";
import { withProjectId } from "../client/health.js";

// --- GitHub Import API ---

/** GitHub issue returned by the fetch endpoint */
/*
FNXC:GitHubImport 2026-06-22-18:30:
The Import Tasks preview pane renders the FULL issue (full body + metadata), so the list response carries the complete body plus author/state.
The GitHub issue-list endpoint already returns the full (untruncated) `body`; no per-item detail fetch is needed. `author`/`state` are surfaced for the preview metadata row.
*/
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  state?: "open" | "closed";
  author?: string | null;
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
/*
FNXC:GitHubImportTranslate 2026-07-15-14:10:
`targetLocale` forwards the panel's ACTIVE locale so an imported task carries the same translation the operator previewed.
The server also falls back to the global `language` setting, so this argument is not load-bearing for the common case — it exists for the one case the server cannot know: a surface whose locale was browser-detected while global `language` is unset (PR #2141 review, P1).
*/
export function apiImportGitHubIssue(owner: string, repo: string, issueNumber: number, projectId?: string, targetLocale?: string): Promise<Task> {
  return api<Task>(withProjectId("/github/issues/import", projectId), {
    method: "POST",
    body: JSON.stringify({ owner, repo, issueNumber, ...(targetLocale ? { targetLocale } : {}) }),
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
  projectId?: string,
  /** See apiImportGitHubIssue: batch import must carry translations identically. */
  targetLocale?: string,
): Promise<{ results: BatchImportResult[] }> {
  return api<{ results: BatchImportResult[] }>(withProjectId("/github/issues/batch-import", projectId), {
    method: "POST",
    body: JSON.stringify({ owner, repo, issueNumbers, delayMs, ...(targetLocale ? { targetLocale } : {}) }),
  });
}

// --- GitHub Pull Request Import API ---

/*
FNXC:GitHubImport 2026-06-22-18:30:
The PR-list endpoint already returns the full (untruncated) `body`; the import preview renders it in full with no per-item detail fetch. `state`/`author` surface PR metadata in the preview.
*/
export interface GitHubPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  headBranch: string;
  baseBranch: string;
  state?: "open" | "closed" | "merged";
  author?: string | null;
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

/*
FNXC:GitHubImport 2026-06-23-01:00:
Per-PR detail for the Import Tasks PR preview pane. `gh pr list` (apiFetchGitHubPulls) returns only comment COUNT + no per-check status, so the preview fetches the FULL comment thread + per-check status ON SELECTION via this client fn (never for the whole list — too expensive).
`status` is the gh CheckRun status (queued/in_progress/completed) or StatusContext state; `conclusion` (success/failure/neutral/...) is present once a check completes.
*/
/*
FNXC:GitHubImport 2026-06-23-03:30:
Comment shape carries `authorAvatarUrl?` (optional, backward-compatible) and `authorIsBot` so the preview renders an avatar + human/bot badge per comment. `authorIsBot` is derived server-side (author type is a GitHub Bot OR login ends in `[bot]`); `authorAvatarUrl` is omitted for bots whose synthetic login does not resolve to a real avatar.
*/
export interface GitHubCommentDetail {
  author: string;
  body: string;
  createdAt: string;
  authorAvatarUrl?: string;
  authorIsBot: boolean;
}

export interface GitHubPullDetail {
  comments: GitHubCommentDetail[];
  checks: Array<{ name: string; status: string; conclusion?: string; detailsUrl?: string }>;
}

/** Fetch the full comment thread + per-check status for a single GitHub PR (called on selection in the import preview). */
export function apiFetchGitHubPullDetail(repo: string, number: number): Promise<GitHubPullDetail> {
  return api<GitHubPullDetail>("/github/pulls/detail", {
    method: "POST",
    body: JSON.stringify({ repo, number }),
  });
}

/*
FNXC:GitHubImport 2026-06-23-03:15:
Per-issue detail for the Import Tasks issue preview pane. Mirrors apiFetchGitHubPullDetail: `gh issue list` has no comment thread, so the preview fetches the FULL comment thread ON SELECTION (never for the whole list).
Issues have no checks rollup, so only `comments` is returned.
*/
export interface GitHubIssueDetail {
  comments: GitHubCommentDetail[];
}

/** Fetch the full comment thread for a single GitHub issue (called on selection in the import preview). */
export function apiFetchGitHubIssueDetail(repo: string, number: number): Promise<GitHubIssueDetail> {
  return api<GitHubIssueDetail>("/github/issues/detail", {
    method: "POST",
    body: JSON.stringify({ repo, number }),
  });
}

/** Close a GitHub issue (Close issue button in the import preview). */
export async function apiCloseGitHubIssue(repo: string, number: number): Promise<void> {
  await api<{ ok: boolean }>("/github/issues/close", {
    method: "POST",
    body: JSON.stringify({ repo, number }),
  });
}


/*
FNXC:GitHubImport 2026-07-17-12:00:
Posts a new comment to the upstream GitHub issue. This is deliberately separate from
apiImportGitHubComment, which creates a Fusion resolve-feedback task from an existing comment.
*/
export async function apiAddGitHubIssueComment(repo: string, number: number, body: string): Promise<void> {
  await api<{ ok: boolean }>("/github/issues/comment", {
    method: "POST",
    body: JSON.stringify({ repo, number, body }),
  });
}

/** Import a specific GitHub pull request as a fn review task */
export function apiImportGitHubPull(owner: string, repo: string, prNumber: number, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId("/github/pulls/import", projectId), {
    method: "POST",
    body: JSON.stringify({ owner, repo, prNumber }),
  });
}

/**
 * FNXC:GitHubImport 2026-07-16-18:05:
 * Comment imports preserve the comment payload and issue/PR source context so the server can create a separately auditable resolve-feedback task without closing the detail window.
 */
export function apiImportGitHubComment(
  params: {
    owner: string;
    repo: string;
    number: number;
    type: "issue" | "pull";
    comment: Pick<GitHubCommentDetail, "author" | "body" | "createdAt">;
  },
  projectId?: string,
): Promise<Task> {
  return api<Task>(withProjectId("/github/comments/import", projectId), {
    method: "POST",
    body: JSON.stringify(params),
  });
}

