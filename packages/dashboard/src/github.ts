import type { IssueInfo, PrInfo } from "@kb/core";
import {
  isGhAvailable,
  isGhAuthenticated,
  runGhAsync,
  runGhJsonAsync,
  getGhErrorMessage,
  getCurrentRepo,
  runGh,
} from "@kb/core";

/**
 * Sleep for a specified number of milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Result of a throttled fetch operation.
 */
export interface ThrottledFetchResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  retryAfter?: number;
}

/**
 * Options for throttled fetch operations.
 */
export interface ThrottledFetchOptions {
  /** Delay between requests in milliseconds (default: 1000ms) */
  delayMs?: number;
  /** Maximum number of retries on 429 responses (default: 3) */
  maxRetries?: number;
}

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

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
export type PrCheckState =
  | "success"
  | "pending"
  | "failure"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure";

export interface PrCheckStatus {
  name: string;
  required: boolean;
  state: PrCheckState;
}

export interface PrMergeStatus {
  prInfo: PrInfo;
  reviewDecision: ReviewDecision;
  checks: PrCheckStatus[];
  mergeReady: boolean;
  blockingReasons: string[];
}

export interface FindPrParams {
  owner?: string;
  repo?: string;
  head: string;
  state?: "open" | "closed" | "all";
}

export interface MergePrParams {
  owner?: string;
  repo?: string;
  number: number;
  method?: "merge" | "squash" | "rebase";
}

export interface BadgeBatchRequest {
  alias: string;
  type: "pr" | "issue";
  number: number;
}

export type BadgeBatchResponse = Record<
  string,
  | { type: "pr"; prInfo: Omit<PrInfo, "lastCheckedAt"> }
  | { type: "issue"; issueInfo: Omit<IssueInfo, "lastCheckedAt"> }
  | null
>;

// gh CLI JSON output types
interface GhPrViewJson {
  id?: string;
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  reviewDecision?: ReviewDecision;
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

interface GhPrListJson {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  baseRefName: string;
  headRefName: string;
  isCrossRepository?: boolean;
  mergedAt?: string | null;
}

interface GhPrCheckJson {
  name: string;
  state: string;
}

interface GhIssueViewJson {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED";
  stateReason?: "completed" | "not_planned" | "reopened";
}

interface GraphQlBatchPullRequest {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  baseRefName: string;
  headRefName: string;
  comments: {
    totalCount: number;
    nodes: Array<{ updatedAt: string } | null>;
  };
}

interface GraphQlBatchIssue {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED";
  stateReason?: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | null;
}

interface GraphQlBatchPayload {
  data?: {
    repository?: Record<string, GraphQlBatchPullRequest | GraphQlBatchIssue | null>;
  };
  errors?: Array<{ message: string }>;
}

function normalizeCheckState(state: string | null | undefined): PrCheckState {
  switch ((state ?? "").toLowerCase()) {
    case "success":
      return "success";
    case "pending":
    case "queued":
    case "in_progress":
    case "expected":
      return "pending";
    case "failure":
    case "failed":
    case "error":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    case "action_required":
      return "action_required";
    case "neutral":
      return "neutral";
    case "skipped":
      return "skipped";
    case "stale":
      return "stale";
    case "startup_failure":
      return "startup_failure";
    default:
      return "failure";
  }
}

function toPrInfo(input: {
  url: string;
  number: number;
  title: string;
  status: PrInfo["status"];
  headBranch: string;
  baseBranch: string;
  commentCount?: number;
  lastCommentAt?: string;
  lastCheckedAt?: string;
}): PrInfo {
  return {
    url: input.url,
    number: input.number,
    status: input.status,
    title: input.title,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    commentCount: input.commentCount ?? 0,
    lastCommentAt: input.lastCommentAt,
    lastCheckedAt: input.lastCheckedAt,
  };
}

export function isPrMergeReady(input: {
  status: PrInfo["status"];
  reviewDecision: ReviewDecision;
  checks: PrCheckStatus[];
}): { ready: boolean; blockingReasons: string[] } {
  const blockingReasons: string[] = [];

  if (input.status !== "open") {
    blockingReasons.push(`PR is ${input.status}`);
  }

  if (input.reviewDecision === "CHANGES_REQUESTED") {
    blockingReasons.push("changes requested review is active");
  }

  const blockingChecks = input.checks.filter(
    (check) => check.required && check.state !== "success",
  );
  if (blockingChecks.length > 0) {
    blockingReasons.push(
      `required checks not successful: ${blockingChecks
        .map((check) => `${check.name} (${check.state})`)
        .join(", ")}`,
    );
  }

  return {
    ready: blockingReasons.length === 0,
    blockingReasons,
  };
}

export class GitHubClient {
  private token: string | undefined;
  private baseUrl = "https://api.github.com";
  private lastRequestTime = 0;

  /**
   * Create a GitHub client.
   * @param token Optional GitHub token for REST API fallback when gh CLI is unavailable
   */
  constructor(token?: string) {
    this.token = token;
  }

  private hasGhAuth(): boolean {
    return isGhAvailable() && isGhAuthenticated();
  }

  private resolveRepo(owner?: string, repo?: string): { owner: string; repo: string } {
    if (owner && repo) {
      return { owner, repo };
    }

    const currentRepo = getCurrentRepo();
    if (!currentRepo) {
      throw new Error(
        "Could not determine repository. Specify owner/repo in params or run from a git repository with a GitHub remote.",
      );
    }

    return currentRepo;
  }

  /**
   * Try to create a PR using the `gh` CLI if available, otherwise fall back
   * to the REST API. Returns the created PR info.
   */
  async createPr(params: CreatePrParams): Promise<PrInfo> {
    // Try gh CLI first (preferred for auth handling)
    if (this.hasGhAuth()) {
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
    const { owner, repo } = this.resolveRepo(paramOwner, paramRepo);

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

    return toPrInfo({
      url: prUrl,
      number,
      status: "open",
      title,
      headBranch: head,
      baseBranch: base || "main",
      commentCount: 0,
    });
  }

  private async createPrWithApi(params: CreatePrParams): Promise<PrInfo> {
    const { owner: paramOwner, repo: paramRepo, title, body, head, base = "main" } = params;
    const { owner, repo } = this.resolveRepo(paramOwner, paramRepo);

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

    return toPrInfo({
      url: data.html_url,
      number: data.number,
      status: this.mapPrState(data.state),
      title: data.title,
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
      commentCount: data.comments,
    });
  }

  async findPrForBranch(params: FindPrParams): Promise<PrInfo | null> {
    if (this.hasGhAuth()) {
      try {
        return await this.findPrForBranchWithGh(params);
      } catch (err) {
        if (this.token) {
          return this.findPrForBranchWithApi(params);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }

    if (this.token) {
      return this.findPrForBranchWithApi(params);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private async findPrForBranchWithGh(params: FindPrParams): Promise<PrInfo | null> {
    const { owner, repo } = this.resolveRepo(params.owner, params.repo);
    const prs = await runGhJsonAsync<GhPrListJson[]>([
      "pr", "list",
      "--repo", `${owner}/${repo}`,
      "--head", params.head,
      "--state", params.state ?? "all",
      "--json", "number,url,title,state,baseRefName,headRefName,mergedAt",
    ]);

    const pr = prs[0];
    if (!pr) return null;

    return toPrInfo({
      url: pr.url,
      number: pr.number,
      status: pr.mergedAt ? "merged" : this.mapGhPrState(pr.state),
      title: pr.title,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      commentCount: 0,
    });
  }

  private async findPrForBranchWithApi(params: FindPrParams): Promise<PrInfo | null> {
    const { owner, repo } = this.resolveRepo(params.owner, params.repo);
    const searchParams = new URLSearchParams();
    searchParams.set("head", `${owner}:${params.head}`);
    searchParams.set("state", params.state ?? "all");
    searchParams.set("per_page", "1");

    const response = await fetch(
      `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${searchParams}`,
      { headers: this.buildHeaders() },
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }

    const pulls = (await response.json()) as Array<{
      number: number;
      html_url: string;
      title: string;
      state: string;
      merged_at: string | null;
      head: { ref: string };
      base: { ref: string };
      comments: number;
    }>;

    const pr = pulls[0];
    if (!pr) return null;

    return toPrInfo({
      url: pr.html_url,
      number: pr.number,
      status: pr.merged_at ? "merged" : this.mapPrState(pr.state),
      title: pr.title,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      commentCount: pr.comments,
    });
  }

  async getPrMergeStatus(owner: string | undefined, repo: string | undefined, number: number): Promise<PrMergeStatus> {
    if (this.hasGhAuth()) {
      try {
        return await this.getPrMergeStatusWithGh(owner, repo, number);
      } catch (err) {
        if (this.token) {
          return this.getPrMergeStatusWithApi(owner, repo, number);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }

    if (this.token) {
      return this.getPrMergeStatusWithApi(owner, repo, number);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private async getPrMergeStatusWithGh(owner: string | undefined, repo: string | undefined, number: number): Promise<PrMergeStatus> {
    const resolved = this.resolveRepo(owner, repo);
    const pr = await runGhJsonAsync<GhPrViewJson>([
      "pr", "view", String(number),
      "--repo", `${resolved.owner}/${resolved.repo}`,
      "--json", "number,url,title,state,baseRefName,headRefName,reviewDecision",
    ]);
    const checks = await runGhJsonAsync<GhPrCheckJson[]>([
      "pr", "checks", String(number),
      "--repo", `${resolved.owner}/${resolved.repo}`,
      "--required",
      "--json", "name,state",
    ]).catch(() => []);

    const prInfo = toPrInfo({
      url: pr.url,
      number: pr.number,
      status: this.mapGhPrState(pr.state),
      title: pr.title,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      commentCount: 0,
    });
    const normalizedChecks = checks.map((check) => ({
      name: check.name,
      required: true,
      state: normalizeCheckState(check.state),
    } satisfies PrCheckStatus));
    const readiness = isPrMergeReady({
      status: prInfo.status,
      reviewDecision: pr.reviewDecision ?? null,
      checks: normalizedChecks,
    });

    return {
      prInfo,
      reviewDecision: pr.reviewDecision ?? null,
      checks: normalizedChecks,
      mergeReady: readiness.ready,
      blockingReasons: readiness.blockingReasons,
    };
  }

  private async getPrMergeStatusWithApi(owner: string | undefined, repo: string | undefined, number: number): Promise<PrMergeStatus> {
    const resolved = this.resolveRepo(owner, repo);
    const response = await fetch(`${this.baseUrl}/graphql`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        query: `query PullRequestMergeStatus($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              number
              url
              title
              state
              reviewDecision
              baseRefName
              headRefName
              comments { totalCount }
              commits(last: 1) {
                nodes {
                  commit {
                    statusCheckRollup {
                      contexts(first: 100) {
                        nodes {
                          __typename
                          ... on CheckRun {
                            name
                            status
                            conclusion
                            isRequired(pullRequestNumber: $number)
                          }
                          ... on StatusContext {
                            context
                            state
                            isRequired(pullRequestNumber: $number)
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        variables: { owner: resolved.owner, repo: resolved.repo, number },
      }),
    });

    const payload = await response.json() as {
      data?: {
        repository?: {
          pullRequest?: {
            number: number;
            url: string;
            title: string;
            state: "OPEN" | "CLOSED" | "MERGED";
            reviewDecision: ReviewDecision;
            baseRefName: string;
            headRefName: string;
            comments: { totalCount: number };
            commits: {
              nodes: Array<{
                commit: {
                  statusCheckRollup?: {
                    contexts?: {
                      nodes?: Array<
                        | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null; isRequired?: boolean }
                        | { __typename: "StatusContext"; context: string; state: string; isRequired?: boolean }
                        | null
                      >;
                    };
                  } | null;
                };
              }>;
            };
          };
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (!response.ok || payload.errors?.length) {
      const message = payload.errors?.[0]?.message || response.statusText;
      throw new Error(`GitHub API error: ${response.status} ${message}`);
    }

    const pr = payload.data?.repository?.pullRequest;
    if (!pr) {
      throw new Error(`PR #${number} not found in ${resolved.owner}/${resolved.repo}`);
    }

    const nodes = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts?.nodes ?? [];
    const checks = nodes.flatMap((node) => {
      if (!node || !node.isRequired) return [];
      if (node.__typename === "CheckRun") {
        return [{
          name: node.name,
          required: true,
          state: normalizeCheckState(node.conclusion ?? node.status),
        } satisfies PrCheckStatus];
      }
      return [{
        name: node.context,
        required: true,
        state: normalizeCheckState(node.state),
      } satisfies PrCheckStatus];
    });

    const prInfo = toPrInfo({
      url: pr.url,
      number: pr.number,
      status: this.mapGhPrState(pr.state),
      title: pr.title,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      commentCount: pr.comments.totalCount,
    });
    const readiness = isPrMergeReady({
      status: prInfo.status,
      reviewDecision: pr.reviewDecision,
      checks,
    });

    return {
      prInfo,
      reviewDecision: pr.reviewDecision,
      checks,
      mergeReady: readiness.ready,
      blockingReasons: readiness.blockingReasons,
    };
  }

  async mergePr(params: MergePrParams): Promise<PrInfo> {
    if (this.hasGhAuth()) {
      try {
        return await this.mergePrWithGh(params);
      } catch (err) {
        if (this.token) {
          return this.mergePrWithApi(params);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }

    if (this.token) {
      return this.mergePrWithApi(params);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private async mergePrWithGh(params: MergePrParams): Promise<PrInfo> {
    const resolved = this.resolveRepo(params.owner, params.repo);
    runGh([
      "pr", "merge", String(params.number),
      "--repo", `${resolved.owner}/${resolved.repo}`,
      `--${params.method ?? "squash"}`,
      "--delete-branch",
    ]);
    return this.getPrStatus(resolved.owner, resolved.repo, params.number);
  }

  private async mergePrWithApi(params: MergePrParams): Promise<PrInfo> {
    const resolved = this.resolveRepo(params.owner, params.repo);
    const response = await fetch(
      `${this.baseUrl}/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.repo)}/pulls/${params.number}/merge`,
      {
        method: "PUT",
        headers: this.buildHeaders(),
        body: JSON.stringify({ merge_method: params.method ?? "squash" }),
      },
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }

    return this.getPrStatus(resolved.owner, resolved.repo, params.number);
  }

  /**
   * Fetch current PR status using gh CLI if available, otherwise REST API.
   */
  async getPrStatus(owner: string, repo: string, number: number): Promise<PrInfo> {
    if (this.hasGhAuth()) {
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
    if (this.hasGhAuth()) {
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
    if (this.hasGhAuth()) {
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

  async getBadgeStatusesBatch(
    owner: string,
    repo: string,
    requests: BadgeBatchRequest[],
  ): Promise<BadgeBatchResponse> {
    if (requests.length === 0) {
      return {};
    }

    if (this.hasGhAuth()) {
      try {
        return await this.getBadgeStatusesBatchWithGh(owner, repo, requests);
      } catch (err) {
        if (this.token) {
          return this.getBadgeStatusesBatchWithApi(owner, repo, requests);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }

    if (this.token) {
      return this.getBadgeStatusesBatchWithApi(owner, repo, requests);
    }

    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private async getBadgeStatusesBatchWithGh(
    owner: string,
    repo: string,
    requests: BadgeBatchRequest[],
  ): Promise<BadgeBatchResponse> {
    const query = buildBadgeBatchQuery(requests);
    const output = await runGhAsync([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
    ]);

    const payload = JSON.parse(output) as GraphQlBatchPayload;
    if (payload.errors?.length) {
      throw new Error(payload.errors[0].message);
    }

    return normalizeBadgeBatchPayload(payload.data?.repository, requests);
  }

  private async getBadgeStatusesBatchWithApi(
    owner: string,
    repo: string,
    requests: BadgeBatchRequest[],
  ): Promise<BadgeBatchResponse> {
    const response = await fetch(`${this.baseUrl}/graphql`, {
      method: "POST",
      headers: {
        ...this.buildHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: buildBadgeBatchQuery(requests),
        variables: { owner, repo },
      }),
    });

    const payload = (await response.json()) as GraphQlBatchPayload;
    if (!response.ok || payload.errors?.length) {
      const message = payload.errors?.[0]?.message || response.statusText;
      throw new Error(`GitHub API error: ${response.status} ${message}`);
    }

    return normalizeBadgeBatchPayload(payload.data?.repository, requests);
  }

  /**
   * Fetch a URL with throttling and automatic retry on rate limit (429) responses.
   * Implements exponential backoff and respects Retry-After header when present.
   * Ensures minimum delay between sequential requests.
   */
  async fetchThrottled<T>(
    url: string,
    options: RequestInit = {},
    throttleOptions: ThrottledFetchOptions = {},
  ): Promise<ThrottledFetchResult<T>> {
    const { delayMs = 1000, maxRetries = 3 } = throttleOptions;

    // Enforce delay between sequential requests
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (this.lastRequestTime > 0 && timeSinceLastRequest < delayMs) {
      await delay(delayMs - timeSinceLastRequest);
    }

    let didBackoffDelay = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // On retry attempts (after first failure), apply delay
        // Skip if we already applied backoff delay in previous iteration
        if (attempt > 0 && !didBackoffDelay) {
          await delay(delayMs);
        }
        didBackoffDelay = false; // Reset for this iteration

        this.lastRequestTime = Date.now();

        const response = await fetch(url, {
          ...options,
          headers: {
            ...this.buildHeaders(),
            ...(options.headers || {}),
          },
        });

        // Handle rate limit (429) with retry logic
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;

          // If this is the last retry, return the error
          if (attempt >= maxRetries) {
            return {
              success: false,
              error: `GitHub API rate limit exceeded. Retry after ${retryAfterSeconds ?? "unknown"} seconds.`,
              retryAfter: retryAfterSeconds,
            };
          }

          // Calculate exponential backoff delay
          // Use Retry-After header if present, otherwise use exponential backoff
          const backoffDelay = retryAfterSeconds
            ? retryAfterSeconds * 1000
            : delayMs * Math.pow(2, attempt);

          await delay(backoffDelay);
          didBackoffDelay = true;
          // Continue to next iteration - the backoff delay was already applied
          // so we skip the standard inter-request delay logic
          continue;
        }

        // Handle other non-OK responses (don't retry)
        if (!response.ok) {
          const error = await response.json().catch(() => ({ message: response.statusText }));
          return {
            success: false,
            error: `GitHub API error: ${response.status} ${error.message || response.statusText}`,
          };
        }

        // Success - parse and return data
        const data = await response.json() as T;
        return { success: true, data };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        // On last attempt, return the error
        if (attempt >= maxRetries) {
          return { success: false, error: errorMessage };
        }

        // For network errors, wait and retry with exponential backoff
        // Skip standard inter-request delay since we're applying backoff
        const backoffDelay = delayMs * Math.pow(2, attempt);
        await delay(backoffDelay);
        didBackoffDelay = true;
      }
    }

    // Should never reach here, but TypeScript needs it
    return { success: false, error: "Max retries exceeded" };
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
    if (this.hasGhAuth()) {
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
    if (this.hasGhAuth()) {
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

function buildBadgeBatchQuery(requests: BadgeBatchRequest[]): string {
  const selections = requests
    .map((request) => {
      if (request.type === "pr") {
        return `${request.alias}: pullRequest(number: ${request.number}) {
          number
          url
          title
          state
          baseRefName
          headRefName
          comments(last: 1) {
            totalCount
            nodes {
              updatedAt
            }
          }
        }`;
      }

      return `${request.alias}: issue(number: ${request.number}) {
        number
        url
        title
        state
        stateReason
      }`;
    })
    .join("\n");

  return `query RepoBadgeStatuses($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      ${selections}
    }
  }`;
}

function normalizeBadgeBatchPayload(
  repository: Record<string, GraphQlBatchPullRequest | GraphQlBatchIssue | null> | undefined,
  requests: BadgeBatchRequest[],
): BadgeBatchResponse {
  const response: BadgeBatchResponse = {};

  for (const request of requests) {
    const resource = repository?.[request.alias];
    if (!resource) {
      response[request.alias] = null;
      continue;
    }

    if (request.type === "pr") {
      if (!isGraphQlBatchPullRequest(resource)) {
        response[request.alias] = null;
        continue;
      }

      response[request.alias] = {
        type: "pr",
        prInfo: {
          url: resource.url,
          number: resource.number,
          status: mapGraphQlBatchPrState(resource.state),
          title: resource.title,
          headBranch: resource.headRefName,
          baseBranch: resource.baseRefName,
          commentCount: resource.comments.totalCount,
          lastCommentAt: resource.comments.nodes.find(Boolean)?.updatedAt,
        },
      };
      continue;
    }

    if (isGraphQlBatchPullRequest(resource)) {
      response[request.alias] = null;
      continue;
    }

    response[request.alias] = {
      type: "issue",
      issueInfo: {
        url: resource.url,
        number: resource.number,
        state: resource.state === "OPEN" ? "open" : "closed",
        title: resource.title,
        stateReason: mapGraphQlBatchIssueStateReason(resource.stateReason),
      },
    };
  }

  return response;
}

function isGraphQlBatchPullRequest(
  resource: GraphQlBatchPullRequest | GraphQlBatchIssue,
): resource is GraphQlBatchPullRequest {
  return "headRefName" in resource;
}

function mapGraphQlBatchPrState(state: GraphQlBatchPullRequest["state"]): PrInfo["status"] {
  switch (state) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
    default:
      return "closed";
  }
}

function mapGraphQlBatchIssueStateReason(
  stateReason: GraphQlBatchIssue["stateReason"],
): IssueInfo["stateReason"] {
  switch (stateReason) {
    case "COMPLETED":
      return "completed";
    case "NOT_PLANNED":
      return "not_planned";
    case "REOPENED":
      return "reopened";
    default:
      return undefined;
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
