import { execFileSync } from "node:child_process";
import type { PrInfo } from "@kb/core";

export interface CreatePrParams {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  head: string;
  base?: string;
}

export interface PrComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
}

export class GitHubClient {
  private token: string | undefined;
  private baseUrl = "https://api.github.com";

  constructor(token?: string) {
    this.token = token;
  }

  /**
   * Try to create a PR using the `gh` CLI if available, otherwise fall back
   * to the REST API. Returns the created PR info.
   */
  async createPr(params: CreatePrParams): Promise<PrInfo> {
    // Try gh CLI first (preferred for auth handling)
    try {
      return this.createPrWithGh(params);
    } catch {
      // Fall back to REST API
      return this.createPrWithApi(params);
    }
  }

  private createPrWithGh(params: CreatePrParams): PrInfo {
    const { owner, repo, title, body, head, base } = params;

    // Build gh pr create command arguments (as array for safety)
    const args = [
      "pr", "create",
      "--repo", `${owner}/${repo}`,
      "--title", title,
      "--head", head,
    ];

    if (body) {
      args.push("--body", body);
    }
    if (base) {
      args.push("--base", base);
    }

    // Execute gh command using execFileSync for proper argument handling
    const result = execFileSync("gh", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });

    // Extract PR URL from output (gh outputs the PR URL on success)
    const prUrl = result.trim();
    const match = prUrl.match(/\/pull\/(\d+)$/);
    if (!match) {
      throw new Error(`Failed to parse PR URL from gh output: ${prUrl}`);
    }

    const number = parseInt(match[1], 10);

    return {
      url: prUrl,
      number,
      status: "open",
      title,
      headBranch: head,
      baseBranch: base || "main",
      commentCount: 0,
    };
  }

  private async createPrWithApi(params: CreatePrParams): Promise<PrInfo> {
    const { owner, repo, title, body, head, base = "main" } = params;

    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;

    const headers = this.buildHeaders();

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title,
        body: body || "",
        head,
        base,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }

    const data = await response.json() as {
      number: number;
      html_url: string;
      title: string;
      state: string;
      head: { ref: string };
      base: { ref: string };
      comments: number;
    };

    return {
      url: data.html_url,
      number: data.number,
      status: this.mapPrState(data.state),
      title: data.title,
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
      commentCount: data.comments,
    };
  }

  /**
   * Fetch current PR status from GitHub API.
   */
  async getPrStatus(owner: string, repo: string, number: number): Promise<PrInfo> {
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;

    const headers = this.buildHeaders();

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`PR #${number} not found in ${owner}/${repo}`);
      }
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }

    const data = await response.json() as {
      number: number;
      html_url: string;
      title: string;
      state: string;
      merged: boolean;
      head: { ref: string };
      base: { ref: string };
      comments: number;
      updated_at: string;
    };

    return {
      url: data.html_url,
      number: data.number,
      status: data.merged ? "merged" : this.mapPrState(data.state),
      title: data.title,
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
      commentCount: data.comments,
      lastCommentAt: data.updated_at,
    };
  }

  /**
   * List PR comments since a specific timestamp.
   */
  async listPrComments(
    owner: string,
    repo: string,
    number: number,
    since?: string,
  ): Promise<PrComment[]> {
    const params = new URLSearchParams();
    params.append("per_page", "100");
    if (since) {
      params.append("since", since);
    }

    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments?${params}`;

    const headers = this.buildHeaders();

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        return []; // PR might not exist or have no comments
      }
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }

    return response.json() as Promise<PrComment[]>;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "kb-dashboard/1.0",
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    return headers;
  }

  private mapPrState(state: string): "open" | "closed" {
    return state === "open" ? "open" : "closed";
  }

  /**
   * Fetch current issue status from GitHub API.
   * Returns null if the issue is not found or is a pull request.
   */
  async getIssueStatus(
    owner: string,
    repo: string,
    number: number,
  ): Promise<Omit<import("@kb/core").IssueInfo, "lastCheckedAt"> | null> {
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;

    const headers = this.buildHeaders();

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }

    const data = (await response.json()) as {
      number: number;
      html_url: string;
      title: string;
      state: string;
      state_reason?: "completed" | "not_planned" | "reopened";
      pull_request?: unknown;
    };

    // Filter out pull requests - this endpoint returns both issues and PRs
    if (data.pull_request) {
      return null;
    }

    return {
      url: data.html_url,
      number: data.number,
      state: this.mapIssueState(data.state),
      title: data.title,
      stateReason: data.state_reason,
    };
  }

  private mapIssueState(state: string): "open" | "closed" {
    return state === "open" ? "open" : "closed";
  }
}

/**
 * Extract owner/repo from a GitHub remote URL or return null if not a GitHub remote.
 */
export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  // Handle HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = remoteUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // Handle SSH: git@github.com:owner/repo.git or git@github.com:owner/repo
  const sshMatch = remoteUrl.match(/github\.com:([^\/]+)\/([^\/\.]+)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/**
 * Get the current GitHub remote owner/repo from the git config.
 */
export function getCurrentGitHubRepo(cwd: string): { owner: string; repo: string } | null {
  try {
    const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    return parseGitHubRemote(remoteUrl);
  } catch {
    return null;
  }
}
