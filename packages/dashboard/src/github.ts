import type { PrInfo } from "@kb/core";
import {
  isGhAvailable,
  isGhAuthenticated,
  runGhJson,
  runGhJsonAsync,
  getGhErrorMessage,
  getCurrentRepo,
  runGh,
} from "@kb/core";

export interface CreatePrParams {
  owner?: string;
  repo?: string;
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

// gh CLI JSON output types
interface GhPrViewJson {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  baseRefName: string;
  headRefName: string;
  comments: Array<{
    id: string;
    body: string;
    author: { login: string };
    createdAt: string;
    updatedAt: string;
    url: string;
  }>;
}

interface GhIssueViewJson {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED";
  stateReason?: "completed" | "not_planned" | "reopened";
}

export class GitHubClient {
  private token: string | undefined;
  private baseUrl = "https://api.github.com";

  /**
   * Create a GitHub client.
   * @param token Optional GitHub token for REST API fallback when gh CLI is unavailable
   */
  constructor(token?: string) {
    this.token = token;
  }

  /**
   * Try to create a PR using the `gh` CLI if available, otherwise fall back
   * to the REST API. Returns the created PR info.
   */
  async createPr(params: CreatePrParams): Promise<PrInfo> {
    // Try gh CLI first (preferred for auth handling)
    if (isGhAvailable() && isGhAuthenticated()) {
      try {
        return this.createPrWithGh(params);
      } catch (err) {
        // If gh CLI fails and we have a token, fall back to REST API
        if (this.token) {
          return this.createPrWithApi(params);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }
    
    // Fall back to REST API
    if (this.token) {
      return this.createPrWithApi(params);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided. Run 'gh auth login' or set GITHUB_TOKEN.");
  }

  private createPrWithGh(params: CreatePrParams): PrInfo {
    const { owner: paramOwner, repo: paramRepo, title, body, head, base } = params;

    // Get owner/repo from params or current repo context
    let owner = paramOwner;
    let repo = paramRepo;
    
    if (!owner || !repo) {
      const currentRepo = getCurrentRepo();
      if (!currentRepo) {
        throw new Error("Could not determine repository. Specify owner/repo in params or run from a git repository with a GitHub remote.");
      }
      owner = currentRepo.owner;
      repo = currentRepo.repo;
    }

    // Type guard: owner and repo are now guaranteed to be strings
    if (!owner || !repo) {
      throw new Error("Could not determine repository.");
    }

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

    // Use gh-cli module to execute
    const result = runGh(args);

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
    const { owner: paramOwner, repo: paramRepo, title, body, head, base = "main" } = params;
    
    // Get owner/repo from params or current repo context
    let owner = paramOwner;
    let repo = paramRepo;
    
    if (!owner || !repo) {
      const currentRepo = getCurrentRepo();
      if (!currentRepo) {
        throw new Error("Could not determine repository. Specify owner/repo in params or run from a git repository with a GitHub remote.");
      }
      owner = currentRepo.owner;
      repo = currentRepo.repo;
    }

    // Type guard: owner and repo are now guaranteed to be strings
    if (!owner || !repo) {
      throw new Error("Could not determine repository.");
    }

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
   * Fetch current PR status using gh CLI if available, otherwise REST API.
   */
  async getPrStatus(owner: string, repo: string, number: number): Promise<PrInfo> {
    if (isGhAvailable() && isGhAuthenticated()) {
      try {
        return await this.getPrStatusWithGh(owner, repo, number);
      } catch (err) {
        if (this.token) {
          return this.getPrStatusWithApi(owner, repo, number);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }
    
    if (this.token) {
      return this.getPrStatusWithApi(owner, repo, number);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private async getPrStatusWithGh(owner: string, repo: string, number: number): Promise<PrInfo> {
    const pr = await runGhJsonAsync<GhPrViewJson>([
      "pr", "view", String(number),
      "--repo", `${owner}/${repo}`,
      "--json", "number,url,title,state,baseRefName,headRefName",
    ]);

    return {
      url: pr.url,
      number: pr.number,
      status: this.mapGhPrState(pr.state),
      title: pr.title,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      commentCount: 0, // Would need separate API call for comment count
    };
  }

  private async getPrStatusWithApi(owner: string, repo: string, number: number): Promise<PrInfo> {
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
   * List PR comments using gh CLI if available, otherwise REST API.
   */
  async listPrComments(
    owner: string,
    repo: string,
    number: number,
    since?: string,
  ): Promise<PrComment[]> {
    if (isGhAvailable() && isGhAuthenticated()) {
      try {
        return await this.listPrCommentsWithGh(owner, repo, number, since);
      } catch (err) {
        if (this.token) {
          return this.listPrCommentsWithApi(owner, repo, number, since);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }
    
    if (this.token) {
      return this.listPrCommentsWithApi(owner, repo, number, since);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private async listPrCommentsWithGh(
    owner: string,
    repo: string,
    number: number,
    since?: string,
  ): Promise<PrComment[]> {
    const pr = await runGhJsonAsync<GhPrViewJson>([
      "pr", "view", String(number),
      "--repo", `${owner}/${repo}`,
      "--json", "comments",
    ]);

    let comments = pr.comments.map((c: GhPrViewJson["comments"][number]) => ({
      id: parseInt(c.id, 10),
      body: c.body,
      user: { login: c.author.login },
      created_at: c.createdAt,
      updated_at: c.updatedAt,
      html_url: c.url,
    }));

    // Filter by timestamp if since is provided
    if (since) {
      const sinceDate = new Date(since);
      comments = comments.filter((c: PrComment) => new Date(c.created_at) > sinceDate);
    }

    return comments;
  }

  private async listPrCommentsWithApi(
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

  /**
   * Fetch current issue status using gh CLI if available, otherwise REST API.
   * Returns null if the issue is not found or is a pull request.
   */
  async getIssueStatus(
    owner: string,
    repo: string,
    number: number,
  ): Promise<Omit<import("@kb/core").IssueInfo, "lastCheckedAt"> | null> {
    if (isGhAvailable() && isGhAuthenticated()) {
      try {
        return await this.getIssueStatusWithGh(owner, repo, number);
      } catch (err) {
        if (this.token) {
          return this.getIssueStatusWithApi(owner, repo, number);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }
    
    if (this.token) {
      return this.getIssueStatusWithApi(owner, repo, number);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private async getIssueStatusWithGh(
    owner: string,
    repo: string,
    number: number,
  ): Promise<Omit<import("@kb/core").IssueInfo, "lastCheckedAt"> | null> {
    try {
      const issue = await runGhJsonAsync<GhIssueViewJson>([
        "issue", "view", String(number),
        "--repo", `${owner}/${repo}`,
        "--json", "number,url,title,state,stateReason",
      ]);

      return {
        url: issue.url,
        number: issue.number,
        state: this.mapGhIssueState(issue.state),
        title: issue.title,
        stateReason: issue.stateReason,
      };
    } catch (err) {
      // gh issue view returns error if the issue is actually a PR
      // or if the issue doesn't exist
      if (err instanceof Error && err.message.includes("Could not resolve to an issue")) {
        return null;
      }
      throw err;
    }
  }

  private async getIssueStatusWithApi(
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

  private mapGhPrState(state: "OPEN" | "CLOSED" | "MERGED"): "open" | "closed" | "merged" {
    switch (state) {
      case "OPEN":
        return "open";
      case "CLOSED":
        return "closed";
      case "MERGED":
        return "merged";
      default:
        return "closed";
    }
  }

  private mapIssueState(state: string): "open" | "closed" {
    return state === "open" ? "open" : "closed";
  }

  private mapGhIssueState(state: "OPEN" | "CLOSED"): "open" | "closed" {
    return state === "OPEN" ? "open" : "closed";
  }

  /**
   * List open issues from a repository.
   * Uses gh CLI if available, otherwise falls back to REST API.
   */
  async listIssues(
    owner: string,
    repo: string,
    options?: { limit?: number; labels?: string[] }
  ): Promise<Array<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
  }>> {
    if (isGhAvailable() && isGhAuthenticated()) {
      try {
        return await this.listIssuesWithGh(owner, repo, options);
      } catch (err) {
        if (this.token) {
          return this.listIssuesWithApi(owner, repo, options);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }
    
    if (this.token) {
      return this.listIssuesWithApi(owner, repo, options);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided. Run 'gh auth login' to authenticate.");
  }

  private async listIssuesWithGh(
    owner: string,
    repo: string,
    options?: { limit?: number; labels?: string[] }
  ): Promise<Array<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
  }>> {
    const limit = options?.limit ?? 30;
    
    // gh issue list doesn't support label filtering directly, so we fetch and filter client-side
    const issues = await runGhJsonAsync<Array<{
      number: number;
      title: string;
      body: string;
      url: string;
      labels: Array<{ name: string }>;
    }>>([
      "issue", "list",
      "--repo", `${owner}/${repo}`,
      "--state", "open",
      "--limit", String(Math.min(limit, 100)),
      "--json", "number,title,body,url,labels",
    ]);

    let result = issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      html_url: issue.url,
      labels: issue.labels,
    }));

    // Filter by labels if specified (client-side filtering)
    if (options?.labels && options.labels.length > 0) {
      result = result.filter((issue) =>
        options.labels!.some((label) =>
          issue.labels.some((l) => l.name === label)
        )
      );
    }

    return result.slice(0, limit);
  }

  private async listIssuesWithApi(
    owner: string,
    repo: string,
    options?: { limit?: number; labels?: string[] }
  ): Promise<Array<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
  }>> {
    const limit = options?.limit ?? 30;
    
    const params = new URLSearchParams();
    params.append("state", "open");
    params.append("per_page", String(Math.min(limit, 100)));
    if (options?.labels && options.labels.length > 0) {
      params.append("labels", options.labels.join(","));
    }

    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params}`;
    const headers = this.buildHeaders();

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Repository not found: ${owner}/${repo}`);
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as Array<{
      number: number;
      title: string;
      body: string | null;
      html_url: string;
      labels: Array<{ name: string }>;
      pull_request?: unknown;
    }>;

    // Filter out pull requests (they have a pull_request property)
    return data.filter((issue) => !issue.pull_request).slice(0, limit);
  }

  /**
   * Fetch a single issue by number.
   * Uses gh CLI if available, otherwise falls back to REST API.
   * Returns null if the issue is not found or is a pull request.
   */
  async getIssue(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: "open" | "closed";
    stateReason?: "completed" | "not_planned" | "reopened";
  } | null> {
    if (isGhAvailable() && isGhAuthenticated()) {
      try {
        return await this.getIssueWithGh(owner, repo, number);
      } catch (err) {
        if (this.token) {
          return this.getIssueWithApi(owner, repo, number);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }
    
    if (this.token) {
      return this.getIssueWithApi(owner, repo, number);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided. Run 'gh auth login' to authenticate.");
  }

  private async getIssueWithGh(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: "open" | "closed";
    stateReason?: "completed" | "not_planned" | "reopened";
  } | null> {
    try {
      const issue = await runGhJsonAsync<{
        number: number;
        title: string;
        body: string;
        url: string;
        state: "OPEN" | "CLOSED";
        stateReason?: "completed" | "not_planned" | "reopened";
      }>([
        "issue", "view", String(number),
        "--repo", `${owner}/${repo}`,
        "--json", "number,title,body,url,state,stateReason",
      ]);

      return {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        html_url: issue.url,
        state: this.mapGhIssueState(issue.state),
        stateReason: issue.stateReason,
      };
    } catch (err) {
      // gh issue view returns error if the issue is actually a PR
      // or if the issue doesn't exist
      if (err instanceof Error && 
          (err.message.includes("Could not resolve to an issue") || 
           err.message.includes("not found"))) {
        return null;
      }
      throw err;
    }
  }

  private async getIssueWithApi(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: "open" | "closed";
    stateReason?: "completed" | "not_planned" | "reopened";
  } | null> {
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
    const headers = this.buildHeaders();

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      number: number;
      title: string;
      body: string | null;
      html_url: string;
      state: string;
      state_reason?: "completed" | "not_planned" | "reopened";
      pull_request?: unknown;
    };

    // Filter out pull requests - this endpoint returns both issues and PRs
    if (data.pull_request) {
      return null;
    }

    return {
      html_url: data.html_url,
      number: data.number,
      title: data.title,
      body: data.body,
      state: this.mapIssueState(data.state),
      stateReason: data.state_reason,
    };
  }
}

/**
 * Extract owner/repo from a GitHub remote URL or return null if not a GitHub remote.
 * @deprecated Use parseRepoFromRemote from gh-cli.ts instead
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
 * @deprecated Use getCurrentRepo from gh-cli.ts instead
 */
export function getCurrentGitHubRepo(cwd: string): { owner: string; repo: string } | null {
  const { execFileSync } = require("node:child_process");
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
