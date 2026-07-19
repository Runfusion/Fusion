import { exec } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BranchGroup, BranchGroupPrState, DirectMergeCommitStrategy, IssueInfo, PrConflictDiagnostics, PrConflictState, PrInfo, Task, TaskReviewData, TaskReviewItem, TaskReviewSummary, TaskSourceIssue } from "@fusion/core";
import {
  isGhAvailable,
  isGhAuthenticated,
  runGhAsync,
  runGhJsonAsync,
  getGhErrorMessage,
  getCurrentRepo,
  runGh,
} from "@fusion/core";

const execAsync = promisify(exec);

/*
FNXC:GitHubImport 2026-06-23-03:30:
Resolve a comment author's bot flag + avatar URL for the Import Tasks preview.
isBot: true when the author type is a GitHub Bot (gh GraphQL Actor `__typename === "Bot"` / `is_bot`, REST `user.type === "Bot"`) OR the login ends in `[bot]` (case-insensitive).
avatarUrl: prefer the API-provided avatar; otherwise fall back to `https://github.com/{login}.png?size=40` — but NOT for bots, whose `[bot]`-suffixed login does not resolve to a real avatar (the frontend renders a generic bot icon instead of a broken image).

FNXC:GitHubImport 2026-06-22-12:00:
The TYPE field is the real bot signal and must be read directly. `gh pr/issue view --json comments` does NOT expose `__typename`/`type`/`is_bot` and surfaces an app bot's bare display login (e.g. `coderabbitai`, `greptileai`) WITHOUT the `[bot]` suffix, so the suffix heuristic alone misclassified GitHub App reviewers (CodeRabbit, Greptile) as HUMAN. The comment fetch now reads Actor `__typename` via `gh api graphql` (and REST `user.type`/`[bot]` login on the token path) — never hardcode specific app names; the type field catches ANY app bot.
*/
function resolveCommentAuthor(input: {
  login: string;
  typename?: string | null;
  isBot?: boolean | null;
  type?: string | null;
  avatarUrl?: string | null;
}): { authorIsBot: boolean; authorAvatarUrl?: string } {
  const login = input.login || "unknown";
  const authorIsBot = Boolean(
    input.isBot === true ||
      input.typename === "Bot" ||
      input.type === "Bot" ||
      /\[bot\]$/i.test(login),
  );
  const providedAvatar = input.avatarUrl?.trim();
  let authorAvatarUrl: string | undefined;
  if (providedAvatar) {
    authorAvatarUrl = providedAvatar;
  } else if (!authorIsBot && login !== "unknown") {
    authorAvatarUrl = `https://github.com/${encodeURIComponent(login)}.png?size=40`;
  }
  return { authorIsBot, authorAvatarUrl };
}

/*
FNXC:GitHubImport 2026-06-22-12:00:
Shape of a single comment node from the `gh api graphql` conversation query. The Actor
`__typename` is the authoritative bot signal (`gh pr/issue view --json comments` omits it).
*/
interface GhGraphqlCommentNode {
  author?: { __typename?: string | null; login?: string | null; avatarUrl?: string | null } | null;
  body?: string | null;
  createdAt?: string | null;
}

function quoteGitArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildSuggestedCommands(
  headBranch: string,
  baseBranch: string,
  directMergeCommitStrategy?: DirectMergeCommitStrategy,
  hasFallbackFiles = false,
): string[] {
  const commands = [
    "git fetch origin",
    `git checkout ${headBranch}`,
  ];

  if (directMergeCommitStrategy === "always-squash") {
    commands.push(`git merge origin/${baseBranch}`);
    commands.push("# Resolve conflicts then: git add <files> && git commit");
  } else {
    commands.push(`git rebase origin/${baseBranch}`);
    commands.push("# Resolve conflicts then: git add <files> && git rebase --continue");
  }

  if (hasFallbackFiles) {
    commands.push("# Note: file list reflects PR changes; resolve conflicts as reported by git status during rebase.");
  }

  return commands;
}

/**
 * Sleep for a specified number of milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIssueUrl(stdout: string): { owner: string; repo: string; number: number; url: string } {
  const url = stdout.trim();
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
  if (!match) {
    throw new Error(`Failed to parse issue URL from gh output: ${JSON.stringify(stdout)}`);
  }

  return {
    owner: match[1],
    repo: match[2],
    number: Number.parseInt(match[3], 10),
    url,
  };
}

/*
FNXC:GithubImport 2026-07-15-00:00:
GitHub import deduplication must survive edited task descriptions and owner/repo casing changes. Both CLI import paths, both extension tools, and dashboard single/batch routes share this sourceIssue-first helper, mirroring GitLab provenance while retaining legacy description URL matching.
*/
export function buildGitHubIssueSource(owner: string, repo: string, issue: { number: number; html_url: string }): {
  sourceIssue: TaskSourceIssue;
  sourceMetadata: Record<string, unknown>;
} {
  return {
    sourceIssue: {
      provider: "github",
      repository: `${owner}/${repo}`,
      externalIssueId: String(issue.number),
      issueNumber: issue.number,
      url: issue.html_url,
    },
    sourceMetadata: { issueUrl: issue.html_url, issueNumber: issue.number },
  };
}

function equalsIgnoreCase(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.toLocaleLowerCase() === right.toLocaleLowerCase());
}

function repositoryFromGitHubIssueUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+\/?$/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function isGitHubIssueAlreadyImported(
  task: Pick<Task, "description" | "sourceIssue" | "source">,
  input: { owner: string; repo: string; issueNumber: number; sourceUrl: string },
): boolean {
  const { owner, repo, issueNumber, sourceUrl } = input;
  const repository = `${owner}/${repo}`;
  const normalizedSourceUrl = sourceUrl.toLocaleLowerCase();

  if (task.description?.toLocaleLowerCase().includes(normalizedSourceUrl)) return true;

  const sourceIssue = task.sourceIssue;
  if (sourceIssue?.provider === "github") {
    if (equalsIgnoreCase(sourceIssue.url, sourceUrl)) return true;
    if (equalsIgnoreCase(sourceIssue.repository, repository)
      && (sourceIssue.issueNumber === issueNumber || sourceIssue.externalIssueId === String(issueNumber))) {
      return true;
    }
  }

  const metadata = task.source?.sourceMetadata;
  if (task.source?.sourceType === "github_import" && metadata && typeof metadata === "object") {
    const sourceMetadata = metadata as Record<string, unknown>;
    if (equalsIgnoreCase(typeof sourceMetadata.issueUrl === "string" ? sourceMetadata.issueUrl : undefined, sourceUrl)) return true;
    return sourceMetadata.issueNumber === issueNumber
      && equalsIgnoreCase(repositoryFromGitHubIssueUrl(sourceMetadata.issueUrl), repository);
  }

  return false;
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
  /** Open the PR in draft state (gh `--draft`, REST `draft: true`). Default false. */
  draft?: boolean;
  /** GitHub login handles to request review from. Empty/undefined → no reviewers requested. */
  reviewers?: string[];
}

export interface CreateIssueParams {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

function requireNonEmptyPrBody(body: string | undefined): string {
  const trimmed = body?.trim() ?? "";
  if (!trimmed) {
    throw new Error("PR body is required when creating a pull request");
  }
  return trimmed;
}

export interface CreatedIssue {
  owner: string;
  repo: string;
  number: number;
  htmlUrl: string;
  createdAt: string;
}

export interface DiscussionCandidate {
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: "open" | "closed";
}

export interface CreatedDiscussion {
  id: string;
  number: number;
  htmlUrl: string;
}

export interface PrComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
}

const PR_REVIEW_PAGE_SIZE = 100;
const MAX_PR_REVIEW_PAGES = 10;

/*
FNXC:GitHubImport 2026-07-16-16:20:
Upper bound on issues returned by listIssues for the import picker. The picker pages this set client-side,
so this cap bounds one fetch: gh's `--limit` paginates internally to reach it, and the REST path loops
`page` at ISSUE_LIST_PAGE_SIZE (100, GitHub's per_page max) until the cap or exhaustion. Keeps a huge repo
from returning an unbounded body while still surfacing far more than the old single 30/100-issue page.
*/
const MAX_LIST_ISSUES = 300;
const ISSUE_LIST_PAGE_SIZE = 100;

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
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PrReviewItem {
  id: string;
  source: "github-pr";
  status: "queued" | "in-progress" | "addressed" | "failed";
  summary: string;
  body?: string;
  filePath?: string;
  line?: number;
  reviewer?: string;
  commentUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrReviewStateItem {
  id: string;
  threadId?: string;
  githubCommentId?: number;
  path?: string;
  diffSide?: string;
  body: string;
  author: { login: string };
  createdAt: string;
  updatedAt?: string;
  state?: string;
  htmlUrl?: string;
  isResolved?: boolean;
}

export interface PrReviewSummary {
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviewers: Array<{ login: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING"; submittedAt?: string }>;
  blockingReasons: string[];
  checks: PrCheckStatus[];
}

export interface PrReviewSnapshot {
  decision: ReviewDecision;
  checks: PrCheckStatus[];
  items: PrReviewStateItem[];
  summary?: PrReviewSummary;
  prInfo: PrInfo;
  commentCount: number;
}

export interface PrMergeStatus {
  prInfo: PrInfo;
  reviewDecision: ReviewDecision;
  checks: PrCheckStatus[];
  mergeable: PrConflictState;
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
  /**
   * When set, the merge only proceeds if the PR head still points at this SHA
   * (defeats the push/merge race — U2/U6). A mismatch surfaces as
   * PrStaleHeadError so the pr-merge node can re-evaluate against the new head.
   */
  expectedHeadOid?: string;
}

/** Thrown when a merge is rejected because the PR head moved (expectedHeadOid mismatch). */
export class PrStaleHeadError extends Error {
  readonly code = "stale-head" as const;
  constructor(message: string) {
    super(message);
    this.name = "PrStaleHeadError";
  }
}

export interface UpdatePrParams {
  owner?: string;
  repo?: string;
  number: number;
  title?: string;
  body?: string;
}

export interface ClosePrParams {
  owner?: string;
  repo?: string;
  number: number;
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
interface GhReviewJson {
  id: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | string;
  body?: string | null;
  submittedAt?: string | null;
  author?: { login?: string | null } | null;
  url?: string | null;
}

type GhPrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
type GhPrMergeStateStatus = "CLEAN" | "DIRTY" | "BLOCKED" | "BEHIND" | "UNSTABLE" | "UNKNOWN" | "HAS_HOOKS";

interface GhPrViewJson {
  id?: string;
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft?: boolean;
  reviewDecision?: ReviewDecision;
  mergeable?: GhPrMergeable;
  mergeStateStatus?: GhPrMergeStateStatus;
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
  reviews?: GhReviewJson[];
}

interface PrReviewDetails {
  reviewDecision: ReviewDecision;
  comments: GhPrViewJson["comments"];
  reviews: GhReviewJson[];
}

/** A review thread with the U5 review-response fields (see getPrReviewThreadsDetailed). */
export interface PrReviewThreadDetail {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean;
  comments: Array<{ author: string; body: string; viewerDidAuthor: boolean }>;
}

interface GraphQlReviewThreadsPayload {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<{
            id: string;
            isResolved?: boolean | null;
            isOutdated?: boolean | null;
            viewerCanResolve?: boolean | null;
            comments?: {
              nodes?: Array<{
                body?: string | null;
                author?: { login?: string | null } | null;
                viewerDidAuthor?: boolean | null;
              } | null> | null;
            } | null;
          } | null> | null;
        } | null;
      } | null;
    } | null;
  };
}

interface GraphQlPageInfo {
  hasNextPage?: boolean | null;
  endCursor?: string | null;
}

interface GraphQlPrCommentNode {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  author?: { login?: string | null } | null;
}

interface GraphQlPrReviewNode {
  id: string;
  state: string;
  body?: string | null;
  submittedAt?: string | null;
  url?: string | null;
  author?: { login?: string | null } | null;
}

interface RestPullRequestComment {
  id: number;
  body?: string | null;
  user?: { login?: string | null } | null;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
}

interface GraphQlPrReviewDetailsPayload {
  data?: {
    repository?: {
      pullRequest?: {
        reviewDecision?: ReviewDecision;
        comments?: {
          nodes?: Array<GraphQlPrCommentNode | null>;
          pageInfo?: GraphQlPageInfo | null;
        } | null;
        reviews?: {
          nodes?: Array<GraphQlPrReviewNode | null>;
          pageInfo?: GraphQlPageInfo | null;
        } | null;
      } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
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
  link?: string;
  startedAt?: string;
  completedAt?: string;
  bucket?: string;
}

interface GhIssueViewJson {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED";
  stateReason?: "completed" | "not_planned" | "reopened";
}

interface RestIssueListItem {
  number: number;
  html_url: string;
  title: string;
  state: string;
  state_reason?: "completed" | "not_planned" | "reopened";
  pull_request?: unknown;
}

interface RestPrListItem {
  number: number;
  html_url: string;
  title: string;
  state: string;
  merged_at?: string | null;
  head: { ref: string };
  base: { ref: string };
  comments: number;
  updated_at?: string;
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

const MAX_BADGE_BATCH_SIZE = 100;
const BATCH_RETRY_DELAY_MS = 5_000;
const MAX_BATCH_RETRIES = 3;

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

function mapPrConflictState(
  mergeable?: GhPrMergeable,
  mergeStateStatus?: GhPrMergeStateStatus,
): PrConflictState {
  if (mergeStateStatus === "DIRTY" || mergeable === "CONFLICTING") {
    return "conflicting";
  }
  if (mergeStateStatus === "BEHIND") {
    return "behind";
  }
  if (mergeStateStatus === "BLOCKED") {
    return "blocked";
  }
  if (mergeStateStatus === "CLEAN" || mergeable === "MERGEABLE") {
    return "clean";
  }
  return "unknown";
}

function toPrInfo(input: {
  url: string;
  number: number;
  title: string;
  status: PrInfo["status"];
  headBranch: string;
  baseBranch: string;
  isDraft?: boolean;
  commentCount?: number;
  mergeable?: PrConflictState;
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
    isDraft: input.isDraft,
    draft: input.isDraft,
    mergeable: input.mergeable,
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

export interface GitHubClientOptions {
  token?: string;
  /**
   * When set, every dual-path method on this client uses ONLY the named transport.
   * "token" requires a non-empty `token`; "gh-cli" ignores `token` entirely.
   * When undefined, the legacy opportunistic behavior is preserved.
   */
  forceMode?: "token" | "gh-cli";
}

export class GitHubClient {
  private token: string | undefined;
  private forceMode: "token" | "gh-cli" | undefined;
  private baseUrl = "https://api.github.com";
  private lastRequestTime = 0;

  /**
   * Create a GitHub client.
   * @param tokenOrOptions Optional token or options for transport behavior
   */
  constructor(tokenOrOptions?: string | GitHubClientOptions) {
    if (typeof tokenOrOptions === "string") {
      this.token = tokenOrOptions;
      this.forceMode = undefined;
      return;
    }

    this.token = tokenOrOptions?.token;
    this.forceMode = tokenOrOptions?.forceMode;
  }

  /**
   * FNXC:ReportPipeline 2026-07-18-16:30:
   * An explicitly reviewed report screenshot may be hosted only in the selected
   * GitHub repository through this client's existing authenticated transport.
   * A failed or unsupported upload returns undefined so filing remains scrubbed,
   * text-only; raw data URLs must never leave the report pipeline.
   */
  async uploadReportImage(owner: string, repo: string, screenshot: { dataUrl: string; capturedAt: string }): Promise<string | undefined> {
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(screenshot.dataUrl);
    if (!match) return undefined;

    const extension = match[1] === "jpeg" ? "jpg" : "png";
    const path = `.fusion/report-screenshots/${crypto.randomUUID()}.${extension}`;
    const endpoint = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`;
    const body = {
      message: "chore: add user-reviewed Fusion report screenshot",
      content: match[2],
    };

    try {
      if (this.forceMode === "gh-cli") {
        this.requireGh();
        return this.uploadReportImageWithGh(endpoint, body);
      }
      if (this.forceMode === "token") {
        this.requireToken();
        return this.uploadReportImageWithApi(endpoint, body);
      }
      if (this.hasGhAuth()) {
        try {
          return await this.uploadReportImageWithGh(endpoint, body);
        } catch {
          if (!this.token) return undefined;
        }
      }
      return this.token ? await this.uploadReportImageWithApi(endpoint, body) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * FNXC:ReportPipeline 2026-07-18-19:30: Screenshot attachment is a two-step
   * GitHub operation. Compensate if the post-upload report comment fails so a
   * sensitive, user-reviewed image is not orphaned outside the report thread.
   */
  async deleteReportImage(owner: string, repo: string, url: string): Promise<void> {
    const prefix = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/main/`;
    if (!url.startsWith(prefix)) return;
    const path = url.slice(prefix.length);
    if (!path.startsWith(".fusion/report-screenshots/") || path.includes("..")) return;
    const endpoint = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`;
    try {
      if (this.forceMode === "gh-cli") {
        this.requireGh();
        await this.deleteReportImageWithGh(endpoint);
      } else if (this.forceMode === "token") {
        this.requireToken();
        await this.deleteReportImageWithApi(endpoint);
      } else if (this.hasGhAuth()) {
        try {
          await this.deleteReportImageWithGh(endpoint);
        } catch {
          if (this.token) await this.deleteReportImageWithApi(endpoint);
        }
      } else if (this.token) {
        await this.deleteReportImageWithApi(endpoint);
      }
    } catch {
      // Best-effort compensation: never let cleanup mask successful text filing.
    }
  }

  private async uploadReportImageWithGh(endpoint: string, body: { message: string; content: string }): Promise<string | undefined> {
    const result = await runGhJsonAsync<{ content?: { download_url?: string | null } }>([
      "api", "--method", "PUT", endpoint,
      "-f", `message=${body.message}`,
      "-f", `content=${body.content}`,
    ]);
    return result.content?.download_url ?? undefined;
  }

  private async uploadReportImageWithApi(endpoint: string, body: { message: string; content: string }): Promise<string | undefined> {
    const result = await this.fetchThrottled<{ content?: { download_url?: string | null } }>(`${this.baseUrl}/${endpoint}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return result.success ? result.data?.content?.download_url ?? undefined : undefined;
  }

  private async deleteReportImageWithGh(endpoint: string): Promise<void> {
    const existing = await runGhJsonAsync<{ sha?: string }>(["api", endpoint]);
    if (!existing.sha) return;
    await runGhJsonAsync(["api", "--method", "DELETE", endpoint, "-f", "message=chore: remove unattached Fusion report screenshot", "-f", `sha=${existing.sha}`]);
  }

  private async deleteReportImageWithApi(endpoint: string): Promise<void> {
    const existing = await this.fetchThrottled<{ sha?: string }>(`${this.baseUrl}/${endpoint}`);
    if (!existing.success || !existing.data?.sha) return;
    await this.fetchThrottled(`${this.baseUrl}/${endpoint}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "chore: remove unattached Fusion report screenshot", sha: existing.data.sha }),
    });
  }

  private hasGhAuth(): boolean {
    return isGhAvailable() && isGhAuthenticated();
  }

  private requireToken(): string {
    const token = this.token?.trim();
    if (!token) {
      throw new Error("GitHub client is forced to token mode, but no token is configured.");
    }
    return token;
  }

  private requireGh(): void {
    if (!isGhAvailable()) {
      throw new Error(getGhErrorMessage(new Error("gh CLI is not available.")));
    }
    if (!isGhAuthenticated()) {
      throw new Error(getGhErrorMessage(new Error("gh CLI is not authenticated.")));
    }
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
    if (this.forceMode === "gh-cli") {
      this.requireGh();
      return this.createPrWithGh(params);
    }

    if (this.forceMode === "token") {
      this.requireToken();
      return this.createPrWithApi(params);
    }

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

  async createIssue(params: CreateIssueParams): Promise<CreatedIssue> {
    if (this.forceMode === "gh-cli") {
      this.requireGh();
      return this.createIssueWithGh(params);
    }

    if (this.forceMode === "token") {
      this.requireToken();
      try {
        return await this.createIssueWithApi(params);
      } catch (error) {
        throw new Error(`Failed to create GitHub issue in ${params.owner}/${params.repo}`, { cause: error });
      }
    }

    if (this.hasGhAuth()) {
      try {
        return await this.createIssueWithGh(params);
      } catch (error) {
        if (this.token) {
          try {
            return await this.createIssueWithApi(params);
          } catch (apiError) {
            throw new Error(`Failed to create GitHub issue in ${params.owner}/${params.repo}`, { cause: apiError });
          }
        }
        throw new Error(`Failed to create GitHub issue in ${params.owner}/${params.repo}`, { cause: error });
      }
    }

    if (this.token) {
      try {
        return await this.createIssueWithApi(params);
      } catch (error) {
        throw new Error(`Failed to create GitHub issue in ${params.owner}/${params.repo}`, { cause: error });
      }
    }

    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided. Run 'gh auth login' or set GITHUB_TOKEN.");
  }

  private async createIssueWithGh(params: CreateIssueParams): Promise<CreatedIssue> {
    const stdout = await runGhAsync([
      "issue",
      "create",
      "--repo",
      `${params.owner}/${params.repo}`,
      "--title",
      params.title,
      "--body",
      params.body,
      ...(params.labels && params.labels.length > 0 ? ["--label", params.labels.join(",")] : []),
    ]);
    const parsed = parseIssueUrl(stdout);
    const issue = await runGhJsonAsync<{ number: number; url: string; createdAt: string }>([
      "issue",
      "view",
      parsed.url,
      "--json",
      "number,url,createdAt",
    ]);

    return {
      owner: params.owner,
      repo: params.repo,
      number: issue.number,
      htmlUrl: issue.url,
      createdAt: issue.createdAt,
    };
  }

  private async createIssueWithApi(params: CreateIssueParams): Promise<CreatedIssue> {
    const url = `${this.baseUrl}/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues`;
    const result = await this.fetchThrottled<{
      number: number;
      html_url: string;
      created_at: string;
    }>(url, {
      method: "POST",
      body: JSON.stringify({
        title: params.title,
        body: params.body,
        labels: params.labels,
      }),
    });

    if (!result.success || !result.data) {
      throw new Error(result.error ?? "GitHub API error");
    }

    return {
      owner: params.owner,
      repo: params.repo,
      number: result.data.number,
      htmlUrl: result.data.html_url,
      createdAt: result.data.created_at,
    };
  }

  private createPrWithGh(params: CreatePrParams): PrInfo {
    const { owner: paramOwner, repo: paramRepo, title, body, head, base, draft, reviewers } = params;
    const { owner, repo } = this.resolveRepo(paramOwner, paramRepo);
    /*
    FNXC:GitHubPrCreate 2026-06-23-00:00:
    The Create PR flow runs `gh pr create` non-interactively, so a title without a body fails at the CLI boundary. Validate here as a final guard in addition to dashboard/API checks and always pass `--body` with non-empty content.
    */
    const prBody = requireNonEmptyPrBody(body);

    // Build gh pr create command arguments (as array for safety)
    const args = [
      "pr", "create",
      "--repo", `${owner}/${repo}`,
      "--title", title,
      "--head", head,
      "--body", prBody,
    ];

    if (base) {
      args.push("--base", base);
    }
    if (draft) {
      args.push("--draft");
    }
    if (reviewers && reviewers.length > 0) {
      // Prefer single create call: gh supports `pr create --reviewer <login[,login...]>`.
      args.push("--reviewer", reviewers.join(","));
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
    const { owner: paramOwner, repo: paramRepo, title, body, head, base = "main", draft, reviewers } = params;
    const { owner, repo } = this.resolveRepo(paramOwner, paramRepo);
    const prBody = requireNonEmptyPrBody(body);

    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;

    const headers = this.buildHeaders();

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title,
        body: prBody,
        head,
        base,
        draft: draft === true,
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
      draft?: boolean;
      head: { ref: string };
      base: { ref: string };
      comments: number;
    };

    if (reviewers && reviewers.length > 0) {
      const requestedReviewersUrl = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${data.number}/requested_reviewers`;
      try {
        const requestedReviewersResponse = await fetch(requestedReviewersUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ reviewers }),
        });
        if (!requestedReviewersResponse.ok) {
          const reviewerError = await requestedReviewersResponse.json().catch(() => ({ message: requestedReviewersResponse.statusText }));
          process.stderr.write(
            `[github] failed to request reviewers for PR #${data.number}: ${requestedReviewersResponse.status} ${reviewerError.message || requestedReviewersResponse.statusText}\n`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[github] failed to request reviewers for PR #${data.number}: ${message}\n`);
      }
    }

    return toPrInfo({
      url: data.html_url,
      number: data.number,
      status: this.mapPrState(data.state),
      title: data.title,
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
      commentCount: data.comments,
      isDraft: data.draft,
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

  async getPrReviewSnapshot(owner: string | undefined, repo: string | undefined, number: number): Promise<PrReviewSnapshot> {
    const { owner: resolvedOwner, repo: resolvedRepo } = this.resolveRepo(owner, repo);
    const details = await this.getRawPrReviewDetails(resolvedOwner, resolvedRepo, number);
    const mergeStatus = await this.getPrMergeStatus(resolvedOwner, resolvedRepo, number);
    const checks = mergeStatus.checks;
    const commentItems: PrReviewStateItem[] = (details.comments ?? []).map((comment) => ({
      id: `gh-comment-${comment.id}`,
      threadId: `thread-comment-${comment.id}`,
      githubCommentId: Number.parseInt(comment.id, 10),
      body: comment.body,
      author: { login: comment.author?.login ?? "reviewer" },
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      htmlUrl: comment.url,
      state: "COMMENTED",
    }));

    const reviewItems: PrReviewStateItem[] = (details.reviews ?? []).map((review) => {
      const createdAt = review.submittedAt ?? new Date().toISOString();
      return {
        id: `gh-review-${review.id}`,
        threadId: `thread-review-${review.id}`,
        body: review.body ?? `Review ${review.state}`,
        author: { login: review.author?.login ?? "reviewer" },
        createdAt,
        updatedAt: createdAt,
        htmlUrl: review.url ?? undefined,
        state: review.state,
      };
    });

    return {
      decision: details.reviewDecision ?? null,
      checks,
      items: [...reviewItems, ...commentItems],
      prInfo: mergeStatus.prInfo,
      commentCount: commentItems.length,
      summary: {
        reviewDecision: details.reviewDecision ?? null,
        reviewers: (details.reviews ?? []).map((review) => ({
          login: review.author?.login ?? "reviewer",
          state: review.state === "APPROVED" || review.state === "CHANGES_REQUESTED" || review.state === "COMMENTED" || review.state === "PENDING" ? review.state : "COMMENTED",
          submittedAt: review.submittedAt ?? undefined,
        })),
        blockingReasons: mergeStatus.blockingReasons,
        checks,
      },
    };
  }

  async getPrReviewDetails(owner: string | undefined, repo: string | undefined, number: number): Promise<TaskReviewData> {
    const { owner: resolvedOwner, repo: resolvedRepo } = this.resolveRepo(owner, repo);
    const details = await this.getRawPrReviewDetails(resolvedOwner, resolvedRepo, number);
    const mergeStatus = await this.getPrMergeStatus(resolvedOwner, resolvedRepo, number);
    const fetchedAt = new Date().toISOString();

    const reviewItems: TaskReviewItem[] = (details.reviews ?? []).map((review) => ({
      itemId: `gh-review-${review.id}`,
      sourceMode: "pull-request",
      title: `Review ${review.state}`,
      body: review.body ?? `Review ${review.state}`,
      author: review.author?.login ?? "reviewer",
      createdAt: review.submittedAt ?? null,
      updatedAt: review.submittedAt ?? null,
      url: review.url ?? undefined,
      threadId: `review-${review.id}`,
      reviewState: review.state ?? null,
      progressStatus: null,
    }));

    const commentItems: TaskReviewItem[] = (details.comments ?? []).map((comment) => ({
      itemId: `gh-comment-${comment.id}`,
      sourceMode: "pull-request",
      title: "PR comment",
      body: comment.body,
      author: comment.author?.login ?? "reviewer",
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
      url: comment.url,
      threadId: `comment-${comment.id}`,
      reviewState: "COMMENTED",
      progressStatus: null,
    }));

    const summary: TaskReviewSummary = {
      reviewDecision: details.reviewDecision ?? null,
      reviewers: (details.reviews ?? []).map((review) => ({
        login: review.author?.login ?? "reviewer",
        state: review.state === "APPROVED" || review.state === "CHANGES_REQUESTED" || review.state === "COMMENTED" || review.state === "PENDING" ? review.state : "COMMENTED",
        submittedAt: review.submittedAt ?? undefined,
      })),
      blockingReasons: mergeStatus.blockingReasons,
      checks: mergeStatus.checks,
    };

    return {
      mode: "pull-request",
      refreshable: true,
      fetchedAt,
      summary,
      items: [...reviewItems, ...commentItems],
    };
  }

  private async getRawPrReviewDetails(owner: string, repo: string, number: number): Promise<PrReviewDetails> {
    if (this.hasGhAuth()) {
      try {
        return await this.getPrReviewDetailsWithGh(owner, repo, number);
      } catch (err) {
        if (this.token) {
          return this.getPrReviewDetailsWithApi(owner, repo, number);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }

    if (this.token) {
      return this.getPrReviewDetailsWithApi(owner, repo, number);
    }

    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private async getPrReviewDetailsWithGh(owner: string, repo: string, number: number): Promise<PrReviewDetails> {
    const pr = await runGhJsonAsync<Pick<GhPrViewJson, "reviewDecision">>([
      "pr",
      "view",
      String(number),
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "reviewDecision",
    ]);

    const issueComments = await this.fetchGhApiPages<GhPrViewJson["comments"][number]>(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
      owner,
      repo,
      number,
      "issue-comments",
    );
    const pullComments = await this.fetchGhApiPages<RestPullRequestComment>(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/comments`,
      owner,
      repo,
      number,
      "pull-comments",
    );
    const reviews = await this.fetchGhApiPages<GhReviewJson>(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`,
      owner,
      repo,
      number,
      "reviews",
    );

    const comments = [
      ...(issueComments ?? []).map((comment) => ({
        id: comment.id,
        body: comment.body,
        author: { login: comment.author?.login ?? "reviewer" },
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        url: comment.url,
      })),
      ...(pullComments ?? []).map((comment) => ({
        id: String(comment.id),
        body: comment.body ?? "",
        author: { login: comment.user?.login ?? "reviewer" },
        createdAt: comment.created_at ?? new Date().toISOString(),
        updatedAt: comment.updated_at ?? comment.created_at ?? new Date().toISOString(),
        url: comment.html_url ?? "",
      })),
    ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return {
      reviewDecision: pr.reviewDecision ?? null,
      comments,
      reviews: (reviews ?? []).map((review) => ({
        id: review.id,
        state: review.state,
        body: review.body,
        submittedAt: review.submittedAt,
        url: review.url,
        author: { login: review.author?.login ?? "reviewer" },
      })),
    };
  }

  private async fetchGhApiPages<T>(
    path: string,
    owner: string,
    repo: string,
    number: number,
    label: string,
  ): Promise<T[]> {
    const items: T[] = [];

    for (let page = 1; page <= MAX_PR_REVIEW_PAGES; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const pagePath = `${path}${separator}per_page=${PR_REVIEW_PAGE_SIZE}&page=${page}`;
      const pageItems = await runGhJsonAsync<T[]>(["api", pagePath]);
      items.push(...pageItems);
      if (pageItems.length < PR_REVIEW_PAGE_SIZE) {
        return items;
      }
    }

    process.stderr.write(
      `[github] PR review pagination cap hit for ${owner}/${repo}#${number} (${label}) after ${MAX_PR_REVIEW_PAGES} pages\n`,
    );
    return items;
  }

  private async getPrReviewDetailsWithApi(owner: string, repo: string, number: number): Promise<PrReviewDetails> {
    const comments: PrReviewDetails["comments"] = [];
    const reviews: PrReviewDetails["reviews"] = [];
    let reviewDecision: ReviewDecision = null;
    let commentsAfter: string | null = null;
    let reviewsAfter: string | null = null;
    let fetchComments = true;
    let fetchReviews = true;

    for (let page = 1; page <= MAX_PR_REVIEW_PAGES; page += 1) {
      const response = await fetch(`${this.baseUrl}/graphql`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          query: `query PullRequestReviewDetails(
            $owner: String!
            $repo: String!
            $number: Int!
            $commentsAfter: String
            $reviewsAfter: String
            $fetchComments: Boolean!
            $fetchReviews: Boolean!
          ) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                reviewDecision
                comments(first: ${PR_REVIEW_PAGE_SIZE}, after: $commentsAfter) @include(if: $fetchComments) {
                  nodes {
                    id
                    body
                    createdAt
                    updatedAt
                    url
                    author { login }
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
                reviews(first: ${PR_REVIEW_PAGE_SIZE}, after: $reviewsAfter) @include(if: $fetchReviews) {
                  nodes {
                    id
                    state
                    body
                    submittedAt
                    url
                    author { login }
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          }`,
          variables: {
            owner,
            repo,
            number,
            commentsAfter,
            reviewsAfter,
            fetchComments,
            fetchReviews,
          },
        }),
      });

      const payload = await response.json() as GraphQlPrReviewDetailsPayload;

      if (!response.ok || payload.errors?.length) {
        const message = payload.errors?.[0]?.message || response.statusText;
        throw new Error(`GitHub API error: ${response.status} ${message}`);
      }

      const pr = payload.data?.repository?.pullRequest;
      if (!pr) {
        throw new Error(`PR #${number} not found in ${owner}/${repo}`);
      }

      reviewDecision = pr.reviewDecision ?? null;

      if (fetchComments) {
        comments.push(...(pr.comments?.nodes ?? []).flatMap((comment) => {
          if (!comment) return [];
          return [{
            id: comment.id,
            body: comment.body,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
            url: comment.url,
            author: { login: comment.author?.login ?? "reviewer" },
          }];
        }));
        fetchComments = Boolean(pr.comments?.pageInfo?.hasNextPage);
        commentsAfter = pr.comments?.pageInfo?.endCursor ?? null;
      }

      if (fetchReviews) {
        reviews.push(...(pr.reviews?.nodes ?? []).flatMap((review) => {
          if (!review) return [];
          return [{
            id: review.id,
            state: review.state,
            body: review.body,
            submittedAt: review.submittedAt,
            url: review.url,
            author: { login: review.author?.login ?? "reviewer" },
          }];
        }));
        fetchReviews = Boolean(pr.reviews?.pageInfo?.hasNextPage);
        reviewsAfter = pr.reviews?.pageInfo?.endCursor ?? null;
      }

      if (!fetchComments && !fetchReviews) {
        return {
          reviewDecision,
          comments,
          reviews,
        };
      }
    }

    process.stderr.write(
      `[github] PR review pagination cap hit for ${owner}/${repo}#${number} (graphql) after ${MAX_PR_REVIEW_PAGES} pages\n`,
    );

    return {
      reviewDecision,
      comments,
      reviews,
    };
  }

  async getPrConflictDiagnostics(
    owner: string | undefined,
    repo: string | undefined,
    number: number,
    opts: {
      baseBranch: string;
      headBranch: string;
      repoRoot?: string;
      directMergeCommitStrategy?: DirectMergeCommitStrategy;
    },
  ): Promise<PrConflictDiagnostics> {
    const capturedAt = new Date().toISOString();
    let conflictingFiles: string[] = [];
    let usedFallbackFiles = false;

    if (opts.repoRoot) {
      try {
        await execAsync(`git -C ${quoteGitArg(opts.repoRoot)} rev-parse --git-dir`, {
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
        });

        const baseRef = `origin/${opts.baseBranch}`;
        const headRef = `origin/${opts.headBranch}`;
        await execAsync(`git -C ${quoteGitArg(opts.repoRoot)} fetch --no-tags --quiet origin ${quoteGitArg(opts.baseBranch)} ${quoteGitArg(opts.headBranch)}`, {
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
        }).catch(() => undefined);

        const { stdout: mergeBaseStdout } = await execAsync(
          `git -C ${quoteGitArg(opts.repoRoot)} merge-base ${quoteGitArg(baseRef)} ${quoteGitArg(headRef)}`,
          { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
        );
        const mergeBase = mergeBaseStdout.trim();

        const indexDir = await mkdtemp(join(tmpdir(), "fn-pr-conflict-"));
        const indexPath = join(indexDir, "index");
        const gitEnv = { ...process.env, GIT_INDEX_FILE: indexPath };

        try {
          await execAsync(`git -C ${quoteGitArg(opts.repoRoot)} read-tree -m ${quoteGitArg(mergeBase)} ${quoteGitArg(baseRef)} ${quoteGitArg(headRef)}`, {
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
            env: gitEnv,
          }).catch(() => undefined);

          const { stdout } = await execAsync(`git -C ${quoteGitArg(opts.repoRoot)} ls-files --unmerged`, {
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
            env: gitEnv,
          });

          conflictingFiles = [
            ...new Set(
              stdout
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => line.split(/\s+/).slice(3).join(" ").trim())
                .filter(Boolean),
            ),
          ];
        } finally {
          await rm(indexDir, { recursive: true, force: true });
        }
      } catch {
        conflictingFiles = [];
      }
    }

    if (conflictingFiles.length === 0 && owner && repo) {
      try {
        const compare = await runGhJsonAsync<{ files?: Array<{ filename?: string | null } | null> }>([
          "api",
          `repos/${owner}/${repo}/compare/${opts.baseBranch}...${opts.headBranch}`,
        ]);
        conflictingFiles = [
          ...new Set((compare.files ?? []).map((file) => file?.filename?.trim()).filter((file): file is string => Boolean(file))),
        ];
        usedFallbackFiles = conflictingFiles.length > 0;
      } catch {
        conflictingFiles = [];
      }
    }

    return {
      conflictingFiles,
      suggestedCommands: buildSuggestedCommands(opts.headBranch, opts.baseBranch, opts.directMergeCommitStrategy, usedFallbackFiles),
      capturedAt,
    };
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
      "--json", "number,url,title,state,isDraft,baseRefName,headRefName,reviewDecision,mergeable,mergeStateStatus",
    ]);
    const mergeable = mapPrConflictState(pr.mergeable, pr.mergeStateStatus);
    const checks = await runGhJsonAsync<GhPrCheckJson[]>([
      "pr", "checks", String(number),
      "--repo", `${resolved.owner}/${resolved.repo}`,
      "--required",
      "--json", "name,state,link,startedAt,completedAt",
    ]).catch(() => []);

    const prInfo = toPrInfo({
      url: pr.url,
      number: pr.number,
      status: this.mapGhPrState(pr.state),
      title: pr.title,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      isDraft: pr.isDraft,
      commentCount: 0,
      mergeable,
    });
    const normalizedChecks = checks.map((check) => ({
      name: check.name,
      required: true,
      state: normalizeCheckState(check.state),
      detailsUrl: check.link,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
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
      mergeable,
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
              mergeable
              mergeStateStatus
              isDraft
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
                            detailsUrl
                            startedAt
                            completedAt
                            isRequired(pullRequestNumber: $number)
                          }
                          ... on StatusContext {
                            context
                            state
                            targetUrl
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
            mergeable?: GhPrMergeable;
            mergeStateStatus?: GhPrMergeStateStatus;
            isDraft?: boolean;
            baseRefName: string;
            headRefName: string;
            comments: { totalCount: number };
            commits: {
              nodes: Array<{
                commit: {
                  statusCheckRollup?: {
                    contexts?: {
                      nodes?: Array<
                        | {
                          __typename: "CheckRun";
                          name: string;
                          status: string;
                          conclusion: string | null;
                          detailsUrl?: string | null;
                          startedAt?: string | null;
                          completedAt?: string | null;
                          isRequired?: boolean;
                        }
                        | { __typename: "StatusContext"; context: string; state: string; targetUrl?: string | null; isRequired?: boolean }
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
          detailsUrl: node.detailsUrl ?? undefined,
          startedAt: node.startedAt ?? undefined,
          completedAt: node.completedAt ?? undefined,
        } satisfies PrCheckStatus];
      }
      return [{
        name: node.context,
        required: true,
        state: normalizeCheckState(node.state),
        detailsUrl: node.targetUrl ?? undefined,
      } satisfies PrCheckStatus];
    });

    const mergeable = mapPrConflictState(pr.mergeable, pr.mergeStateStatus);
    const prInfo = toPrInfo({
      url: pr.url,
      number: pr.number,
      status: this.mapGhPrState(pr.state),
      title: pr.title,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      isDraft: pr.isDraft,
      commentCount: pr.comments.totalCount,
      mergeable,
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
      mergeable,
      mergeReady: readiness.ready,
      blockingReasons: readiness.blockingReasons,
    };
  }

  async getAllPrChecks(
    owner: string | undefined,
    repo: string | undefined,
    number: number,
  ): Promise<{ checks: PrCheckStatus[]; rollupRequired: PrCheckState | "unknown" }> {
    if (this.hasGhAuth()) {
      try {
        return await this.getAllPrChecksWithGh(owner, repo, number);
      } catch (err) {
        if (this.token) {
          return this.getAllPrChecksWithApi(owner, repo, number);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }

    if (this.token) {
      return this.getAllPrChecksWithApi(owner, repo, number);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private computeRequiredChecksRollup(checks: PrCheckStatus[]): PrCheckState | "unknown" {
    const requiredChecks = checks.filter((check) => check.required);
    if (requiredChecks.some((check) => ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(check.state))) {
      return "failure";
    }
    if (requiredChecks.some((check) => check.state === "pending")) {
      return "pending";
    }
    if (requiredChecks.length > 0) {
      return "success";
    }
    return "unknown";
  }

  private async getAllPrChecksWithGh(
    owner: string | undefined,
    repo: string | undefined,
    number: number,
  ): Promise<{ checks: PrCheckStatus[]; rollupRequired: PrCheckState | "unknown" }> {
    const resolved = this.resolveRepo(owner, repo);

    let checks = await runGhJsonAsync<GhPrCheckJson[]>([
      "pr", "checks", String(number),
      "--repo", `${resolved.owner}/${resolved.repo}`,
      "--json", "name,state,link,startedAt,completedAt,bucket",
    ]).catch(async () => {
      const allChecks = await runGhJsonAsync<GhPrCheckJson[]>([
        "pr", "checks", String(number),
        "--repo", `${resolved.owner}/${resolved.repo}`,
        "--json", "name,state,link,startedAt,completedAt",
      ]);
      const requiredChecks = await runGhJsonAsync<GhPrCheckJson[]>([
        "pr", "checks", String(number),
        "--repo", `${resolved.owner}/${resolved.repo}`,
        "--required",
        "--json", "name,state",
      ]).catch(() => []);
      const requiredNames = new Set(requiredChecks.map((check) => check.name));
      return allChecks.map((check) => ({ ...check, bucket: requiredNames.has(check.name) ? "pass" : "none" }));
    });

    checks = checks ?? [];
    const normalized = checks.map((check) => ({
      name: check.name,
      required: check.bucket ? check.bucket !== "none" : false,
      state: normalizeCheckState(check.state),
      detailsUrl: check.link,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
    } satisfies PrCheckStatus));

    return {
      checks: normalized,
      rollupRequired: this.computeRequiredChecksRollup(normalized),
    };
  }

  private async getAllPrChecksWithApi(
    owner: string | undefined,
    repo: string | undefined,
    number: number,
  ): Promise<{ checks: PrCheckStatus[]; rollupRequired: PrCheckState | "unknown" }> {
    const resolved = this.resolveRepo(owner, repo);
    const response = await fetch(`${this.baseUrl}/graphql`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        query: `query PullRequestAllChecks($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
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
                            detailsUrl
                            startedAt
                            completedAt
                            isRequired(pullRequestNumber: $number)
                          }
                          ... on StatusContext {
                            context
                            state
                            targetUrl
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
            commits: {
              nodes: Array<{
                commit: {
                  statusCheckRollup?: {
                    contexts?: {
                      nodes?: Array<
                        | {
                          __typename: "CheckRun";
                          name: string;
                          status: string;
                          conclusion: string | null;
                          detailsUrl?: string | null;
                          startedAt?: string | null;
                          completedAt?: string | null;
                          isRequired?: boolean;
                        }
                        | { __typename: "StatusContext"; context: string; state: string; targetUrl?: string | null; isRequired?: boolean }
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

    const nodes = payload.data?.repository?.pullRequest?.commits.nodes[0]?.commit.statusCheckRollup?.contexts?.nodes ?? [];
    const checks = nodes.flatMap((node) => {
      if (!node) return [];
      if (node.__typename === "CheckRun") {
        return [{
          name: node.name,
          required: Boolean(node.isRequired),
          state: normalizeCheckState(node.conclusion ?? node.status),
          detailsUrl: node.detailsUrl ?? undefined,
          startedAt: node.startedAt ?? undefined,
          completedAt: node.completedAt ?? undefined,
        } satisfies PrCheckStatus];
      }

      return [{
        name: node.context,
        required: Boolean(node.isRequired),
        state: normalizeCheckState(node.state),
        detailsUrl: node.targetUrl ?? undefined,
      } satisfies PrCheckStatus];
    });

    return {
      checks,
      rollupRequired: this.computeRequiredChecksRollup(checks),
    };
  }

  async mergePr(params: MergePrParams): Promise<PrInfo> {
    if (this.hasGhAuth()) {
      try {
        return await this.mergePrWithGh(params);
      } catch (err) {
        // A stale-head rejection is a real outcome, not a gh-vs-API fallback
        // trigger — re-running on the API path would merge the wrong head.
        if (err instanceof PrStaleHeadError) throw err;
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
    const args = [
      "pr", "merge", String(params.number),
      "--repo", `${resolved.owner}/${resolved.repo}`,
      `--${params.method ?? "squash"}`,
      "--delete-branch",
    ];
    if (params.expectedHeadOid) {
      args.push("--match-head-commit", params.expectedHeadOid);
    }
    try {
      runGh(args);
    } catch (err) {
      const message = getGhErrorMessage(err);
      if (
        params.expectedHeadOid &&
        /head.*(changed|modified|match|stale)|not the most recent|base branch was modified/i.test(message)
      ) {
        throw new PrStaleHeadError(`PR #${params.number} head moved since ${params.expectedHeadOid}; merge aborted`);
      }
      throw err;
    }
    return this.getPrStatus(resolved.owner, resolved.repo, params.number);
  }

  private async mergePrWithApi(params: MergePrParams): Promise<PrInfo> {
    const resolved = this.resolveRepo(params.owner, params.repo);
    const body: Record<string, string> = { merge_method: params.method ?? "squash" };
    if (params.expectedHeadOid) body.sha = params.expectedHeadOid;
    const response = await fetch(
      `${this.baseUrl}/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.repo)}/pulls/${params.number}/merge`,
      {
        method: "PUT",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      // 409 Conflict with a `sha` set means the head moved (stale-head race).
      if (params.expectedHeadOid && response.status === 409) {
        throw new PrStaleHeadError(`PR #${params.number} head moved since ${params.expectedHeadOid}; merge aborted`);
      }
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }

    return this.getPrStatus(resolved.owner, resolved.repo, params.number);
  }

  /**
   * Reply to a specific review thread (U2). GraphQL only — REST has no
   * thread-level reply that also carries thread identity. Honors viewerCanReply
   * by surfacing GitHub's error rather than guessing.
   */
  async replyToReviewThread(threadId: string, body: string): Promise<void> {
    const query = `mutation($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
        comment { id }
      }
    }`;
    await this.runGraphqlMutation(query, { threadId, body });
  }

  /** Resolve a review thread (U2). GraphQL only; caller should check viewerCanResolve first. */
  async resolveReviewThread(threadId: string): Promise<void> {
    const query = `mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
    }`;
    await this.runGraphqlMutation(query, { threadId });
  }

  /**
   * The authenticated viewer's login (single-user gh auth). Used by the U5
   * review-response run for marker authentication (anti-spoof) — a fusion marker
   * only suppresses a thread when authored by this login.
   */
  async getViewerLogin(): Promise<string> {
    const payload = await this.runGraphqlQuery<{ viewer?: { login?: string | null } | null }>(
      `query { viewer { login } }`,
      {},
    );
    return payload?.viewer?.login ?? "";
  }

  /**
   * Deep-fetch the PR's review threads with the per-thread + per-comment fields
   * the U5 review-response run needs: isResolved, isOutdated, viewerCanResolve,
   * and each comment's author + body + viewerDidAuthor. GraphQL only.
   */
  async getPrReviewThreadsDetailed(
    owner: string | undefined,
    repo: string | undefined,
    number: number,
  ): Promise<PrReviewThreadDetail[]> {
    const resolved = this.resolveRepo(owner, repo);
    const query = `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              isOutdated
              viewerCanResolve
              comments(first: 100) {
                nodes { body author { login } viewerDidAuthor }
              }
            }
          }
        }
      }
    }`;
    const payload = await this.runGraphqlQuery<GraphQlReviewThreadsPayload["data"]>(query, {
      owner: resolved.owner,
      repo: resolved.repo,
      number,
    });
    const nodes = payload?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.filter((n): n is NonNullable<typeof n> => n != null).map((n) => ({
      id: n.id,
      isResolved: n.isResolved ?? false,
      isOutdated: n.isOutdated ?? false,
      viewerCanResolve: n.viewerCanResolve ?? false,
      comments: (n.comments?.nodes ?? [])
        .filter((c): c is NonNullable<typeof c> => c != null)
        .map((c) => ({
          author: c.author?.login ?? "",
          body: c.body ?? "",
          viewerDidAuthor: c.viewerDidAuthor ?? false,
        })),
    }));
  }

  /*
  FNXC:ReportPipeline 2026-07-16-23:45:
  Feedback and unresolved Help reports can belong in repository Discussions,
  not only Issues. Keep their search, creation, and data-point comments in the
  existing GitHub client so the established gh/token transport and auth fallback
  remain the only egress mechanism.
  */
  async searchDiscussions(owner: string, repo: string, query: string, options?: { limit?: number }): Promise<DiscussionCandidate[]> {
    const limit = Math.max(1, options?.limit ?? 1000);
    const words = query.toLocaleLowerCase().split(/\s+/).filter((word) => word.length > 3);
    const matches: DiscussionCandidate[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;
    type DiscussionConnection = {
      nodes?: Array<{ id: string; number: number; title: string; body: string | null; url: string; isClosed?: boolean | null }> | null;
      pageInfo?: { hasNextPage: boolean; endCursor: string | null } | null;
    };
    type DiscussionSearchPayload = { repository?: { discussions?: DiscussionConnection | null } | null };

    /*
    FNXC:ReportPipeline 2026-07-18-11:15:
    Discussion dedupe must not only inspect the most recently updated page.
    Page through open and older discussions until the caller's explicit bound,
    so reports cannot silently miss a duplicate merely because it is inactive.
    */
    while (hasNextPage && matches.length < limit) {
      const payload: DiscussionSearchPayload | undefined = await this.runGraphqlQuery<DiscussionSearchPayload>(`query($owner:String!, $repo:String!, $cursor:String) {
        repository(owner:$owner, name:$repo) { discussions(first:100, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}) { nodes { id number title body url isClosed } pageInfo { hasNextPage endCursor } } }
      }`, { owner, repo, cursor });
      const discussions: DiscussionConnection | undefined = payload?.repository?.discussions ?? undefined;
      for (const discussion of discussions?.nodes ?? []) {
        if (discussion.isClosed) continue;
        if (words.length > 0 && !words.some((word) => `${discussion.title} ${discussion.body ?? ""}`.toLocaleLowerCase().includes(word))) continue;
        matches.push({ ...discussion, state: "open" });
        if (matches.length >= limit) break;
      }
      hasNextPage = discussions?.pageInfo?.hasNextPage === true;
      cursor = discussions?.pageInfo?.endCursor ?? null;
      if (hasNextPage && !cursor) break;
    }
    return matches;
  }

  /** Adds the same visible +1 signal to a Discussion duplicate as to an Issue duplicate. */
  async addDiscussionReaction(discussionId: string): Promise<void> {
    const payload = await this.runGraphqlQuery<{
      addReaction?: { reaction?: { content?: string | null } | null } | null;
    }>(`mutation($subjectId:ID!) {
      addReaction(input:{subjectId:$subjectId, content:THUMBS_UP}) { reaction { content } }
    }`, { subjectId: discussionId });
    if (!payload?.addReaction?.reaction) throw new Error("GitHub did not return the discussion reaction.");
  }

  async createDiscussion(owner: string, repo: string, title: string, body: string): Promise<CreatedDiscussion> {
    const categoryPayload = await this.runGraphqlQuery<{
      repository?: { id?: string; discussionCategories?: { nodes?: Array<{ id: string }> | null } | null } | null;
    }>(`query($owner:String!, $repo:String!) {
      repository(owner:$owner, name:$repo) { id discussionCategories(first:1) { nodes { id } } }
    }`, { owner, repo });
    const repositoryId = categoryPayload?.repository?.id;
    const categoryId = categoryPayload?.repository?.discussionCategories?.nodes?.[0]?.id;
    if (!repositoryId || !categoryId) throw new Error(`Discussions are not enabled for ${owner}/${repo}.`);
    const payload = await this.runGraphqlQuery<{
      createDiscussion?: { discussion?: { id: string; number: number; url: string } | null } | null;
    }>(`mutation($repositoryId:ID!, $categoryId:ID!, $title:String!, $body:String!) {
      createDiscussion(input:{repositoryId:$repositoryId, categoryId:$categoryId, title:$title, body:$body}) { discussion { id number url } }
    }`, { repositoryId, categoryId, title, body });
    const discussion = payload?.createDiscussion?.discussion;
    if (!discussion) throw new Error("GitHub did not return the created discussion.");
    return { id: discussion.id, number: discussion.number, htmlUrl: discussion.url };
  }

  async commentOnDiscussion(discussionId: string, body: string): Promise<{ url: string }> {
    const payload = await this.runGraphqlQuery<{
      addDiscussionComment?: { comment?: { url: string } | null } | null;
    }>(`mutation($discussionId:ID!, $body:String!) {
      addDiscussionComment(input:{discussionId:$discussionId, body:$body}) { comment { url } }
    }`, { discussionId, body });
    const url = payload?.addDiscussionComment?.comment?.url;
    if (!url) throw new Error("GitHub did not return the discussion comment.");
    return { url };
  }

  /** Run a read-only GraphQL query (gh CLI when available, else token/REST). */
  private async runGraphqlQuery<T>(query: string, variables: Record<string, string | number | null>): Promise<T | undefined> {
    if (this.hasGhAuth()) {
      const args = ["api", "graphql", "-f", `query=${query}`];
      for (const [key, value] of Object.entries(variables)) {
        if (value === null) continue;
        const flag = typeof value === "number" ? "-F" : "-f";
        args.push(flag, `${key}=${value}`);
      }
      const output = await runGhAsync(args);
      const payload = JSON.parse(output) as { data?: T; errors?: Array<{ message: string }> };
      if (payload.errors?.length) throw new Error(payload.errors[0].message);
      return payload.data;
    }
    if (this.token) {
      const response = await fetch(`${this.baseUrl}/graphql`, {
        method: "POST",
        headers: { ...this.buildHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (!response.ok || payload.errors?.length) {
        throw new Error(`GitHub API error: ${response.status} ${payload.errors?.[0]?.message || response.statusText}`);
      }
      return payload.data;
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  /**
   * ETag-conditional change probe (U2/U17). Returns { changed, etag } so the
   * reconcile can skip the expensive GraphQL deep-fetch when GitHub reports 304
   * (which does not count against the primary rate limit). Only available on the
   * REST/token path — gh CLI does not expose conditional requests.
   */
  async probePrChanged(
    owner: string | undefined,
    repo: string | undefined,
    number: number,
    etag?: string,
  ): Promise<{ changed: boolean; etag?: string }> {
    if (!this.token) {
      // No conditional-request path without a token; treat as always-changed so
      // the caller falls back to a full fetch.
      return { changed: true };
    }
    const resolved = this.resolveRepo(owner, repo);
    const headers: Record<string, string> = { ...this.buildHeaders() };
    if (etag) headers["If-None-Match"] = etag;
    const response = await fetch(
      `${this.baseUrl}/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.repo)}/pulls/${number}`,
      { headers },
    );
    if (response.status === 304) return { changed: false, etag };
    return { changed: true, etag: response.headers.get("etag") ?? undefined };
  }

  private async runGraphqlMutation(query: string, variables: Record<string, string>): Promise<void> {
    if (this.hasGhAuth()) {
      const args = ["api", "graphql", "-f", `query=${query}`];
      for (const [key, value] of Object.entries(variables)) {
        args.push("-F", `${key}=${value}`);
      }
      const output = await runGhAsync(args);
      const payload = JSON.parse(output) as { errors?: Array<{ message: string }> };
      if (payload.errors?.length) throw new Error(payload.errors[0].message);
      return;
    }
    if (this.token) {
      const response = await fetch(`${this.baseUrl}/graphql`, {
        method: "POST",
        headers: { ...this.buildHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const payload = (await response.json()) as { errors?: Array<{ message: string }> };
      if (!response.ok || payload.errors?.length) {
        throw new Error(`GitHub API error: ${response.status} ${payload.errors?.[0]?.message || response.statusText}`);
      }
      return;
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
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
      "--json", "number,url,title,state,isDraft,baseRefName,headRefName",
    ]);

    return {
      url: pr.url,
      number: pr.number,
      status: this.mapGhPrState(pr.state),
      title: pr.title,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      isDraft: pr.isDraft,
      draft: pr.isDraft,
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
      draft?: boolean;
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
      isDraft: data.draft,
      draft: data.draft,
      commentCount: data.comments,
      lastCommentAt: data.updated_at,
    };
  }

  /**
   * Edit the title and/or body of an existing PR by number. Uses gh CLI if
   * available, otherwise the REST API. Returns the refreshed PR status.
   *
   * Used by the group-PR sync path to push an updated member checklist /
   * completion summary onto the single managed group PR (U6, R6).
   */
  async updatePr(params: UpdatePrParams): Promise<PrInfo> {
    if (this.hasGhAuth()) {
      try {
        return await this.updatePrWithGh(params);
      } catch (err) {
        if (this.token) {
          return this.updatePrWithApi(params);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }

    if (this.token) {
      return this.updatePrWithApi(params);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private async updatePrWithGh(params: UpdatePrParams): Promise<PrInfo> {
    const resolved = this.resolveRepo(params.owner, params.repo);
    const args = [
      "pr", "edit", String(params.number),
      "--repo", `${resolved.owner}/${resolved.repo}`,
    ];
    if (params.title !== undefined) {
      args.push("--title", params.title);
    }
    if (params.body !== undefined) {
      args.push("--body", params.body);
    }
    runGh(args);
    return this.getPrStatus(resolved.owner, resolved.repo, params.number);
  }

  private async updatePrWithApi(params: UpdatePrParams): Promise<PrInfo> {
    const resolved = this.resolveRepo(params.owner, params.repo);
    const payload: Record<string, string> = {};
    if (params.title !== undefined) payload.title = params.title;
    if (params.body !== undefined) payload.body = params.body;
    const response = await fetch(
      `${this.baseUrl}/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.repo)}/pulls/${params.number}`,
      {
        method: "PATCH",
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }

    return this.getPrStatus(resolved.owner, resolved.repo, params.number);
  }

  /**
   * Close an existing PR by number without merging. Uses gh CLI if available,
   * otherwise the REST API. Returns the refreshed PR status.
   *
   * Used by terminal reconciliation when a branch group is abandoned (U6, R7).
   */
  async closePr(params: ClosePrParams): Promise<PrInfo> {
    if (this.hasGhAuth()) {
      try {
        return await this.closePrWithGh(params);
      } catch (err) {
        if (this.token) {
          return this.closePrWithApi(params);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }

    if (this.token) {
      return this.closePrWithApi(params);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private async closePrWithGh(params: ClosePrParams): Promise<PrInfo> {
    const resolved = this.resolveRepo(params.owner, params.repo);
    runGh([
      "pr", "close", String(params.number),
      "--repo", `${resolved.owner}/${resolved.repo}`,
    ]);
    return this.getPrStatus(resolved.owner, resolved.repo, params.number);
  }

  private async closePrWithApi(params: ClosePrParams): Promise<PrInfo> {
    const resolved = this.resolveRepo(params.owner, params.repo);
    const response = await fetch(
      `${this.baseUrl}/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.repo)}/pulls/${params.number}`,
      {
        method: "PATCH",
        headers: this.buildHeaders(),
        body: JSON.stringify({ state: "closed" }),
      },
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }

    return this.getPrStatus(resolved.owner, resolved.repo, params.number);
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
   * Adds a GitHub reaction to an issue through the same authenticated client
   * transport used for issue comments.
   */
  async addIssueReaction(owner: string, repo: string, issueNumber: number, content: "+1" = "+1"): Promise<void> {
    const endpoint = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/reactions`;
    if (this.forceMode === "gh-cli") {
      this.requireGh();
      await runGhJsonAsync(["api", "--method", "POST", endpoint, "-f", `content=${content}`]);
      return;
    }

    if (this.forceMode === "token") {
      this.requireToken();
    } else if (this.hasGhAuth()) {
      try {
        await runGhJsonAsync(["api", "--method", "POST", endpoint, "-f", `content=${content}`]);
        return;
      } catch (err) {
        if (!this.token) throw new Error(getGhErrorMessage(err));
      }
    }

    if (!this.token) {
      throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
    }
    const result = await this.fetchThrottled(`${this.baseUrl}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ content }),
    });
    if (!result.success) throw new Error(result.error ?? "Failed to react to GitHub issue");
  }

  async commentOnIssue(owner: string, repo: string, issueNumber: number, body: string): Promise<{ url?: string }> {
    if (this.forceMode === "gh-cli") {
      this.requireGh();
      const output = runGh([
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        `${owner}/${repo}`,
        "--body",
        body,
      ]);
      return { url: output.match(/https:\/\/github\.com\/[^\s]+/i)?.[0] };
    }

    if (this.forceMode === "token") {
      this.requireToken();
    } else if (this.hasGhAuth()) {
      try {
        const output = runGh([
          "issue",
          "comment",
          String(issueNumber),
          "--repo",
          `${owner}/${repo}`,
          "--body",
          body,
        ]);
        return { url: output.match(/https:\/\/github\.com\/[^\s]+/i)?.[0] };
      } catch (err) {
        if (!this.token) {
          throw new Error(getGhErrorMessage(err));
        }
      }
    }

    if (!this.token) {
      throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
    }

    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`;
    const result = await this.fetchThrottled<{ id: number; html_url?: string }>(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      },
    );

    if (!result.success) {
      throw new Error(result.error ?? "Failed to comment on GitHub issue");
    }
    return { url: result.data?.html_url };
  }

  async setIssueState(
    owner: string,
    repo: string,
    issueNumber: number,
    state: "open" | "closed",
    stateReason?: "completed" | "not_planned" | "reopened",
  ): Promise<void> {
    if (this.forceMode === "gh-cli") {
      this.requireGh();
      const command = state === "closed" ? "close" : "reopen";
      const args = ["issue", command, String(issueNumber), "--repo", `${owner}/${repo}`];
      if (state === "closed" && (stateReason === "completed" || stateReason === "not_planned")) {
        args.push("--reason", stateReason);
      }
      runGh(args);
      return;
    }

    if (this.forceMode === "token") {
      this.requireToken();
    } else if (this.hasGhAuth()) {
      try {
        const command = state === "closed" ? "close" : "reopen";
        const args = ["issue", command, String(issueNumber), "--repo", `${owner}/${repo}`];
        if (state === "closed" && (stateReason === "completed" || stateReason === "not_planned")) {
          args.push("--reason", stateReason);
        }
        runGh(args);
        return;
      } catch (err) {
        if (!this.token) {
          throw new Error(getGhErrorMessage(err));
        }
      }
    }

    if (!this.token) {
      throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
    }

    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`;
    const payload: { state: "open" | "closed"; state_reason?: "completed" | "not_planned" | "reopened" } = { state };
    if (stateReason !== undefined) {
      payload.state_reason = stateReason;
    }

    const result = await this.fetchThrottled<{ id: number; state: string }>(
      url,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!result.success) {
      throw new Error(result.error ?? "Failed to update GitHub issue state");
    }
  }

  async deleteIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
    if (this.forceMode === "gh-cli") {
      this.requireGh();
      runGh(["issue", "delete", String(issueNumber), "--repo", `${owner}/${repo}`, "--yes"]);
      return;
    }

    if (this.forceMode === "token") {
      throw new Error("Deleting GitHub issues requires gh CLI authentication. Token-only mode does not support issue deletion.");
    }

    if (this.hasGhAuth()) {
      runGh(["issue", "delete", String(issueNumber), "--repo", `${owner}/${repo}`, "--yes"]);
      return;
    }

    throw new Error("Deleting GitHub issues requires gh CLI authentication. Configure gh auth and retry.");
  }

  /**
   * Fetch current issue status using gh CLI if available, otherwise REST API.
   * Returns null if the issue is not found or is a pull request.
   */
  async getIssueStatus(
    owner: string,
    repo: string,
    number: number,
  ): Promise<Omit<import("@fusion/core").IssueInfo, "lastCheckedAt"> | null> {
    if (this.forceMode === "gh-cli") {
      this.requireGh();
      return this.getIssueStatusWithGh(owner, repo, number);
    }

    if (this.forceMode === "token") {
      this.requireToken();
      return this.getIssueStatusWithApi(owner, repo, number);
    }

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
  ): Promise<Omit<import("@fusion/core").IssueInfo, "lastCheckedAt"> | null> {
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
  ): Promise<Omit<import("@fusion/core").IssueInfo, "lastCheckedAt"> | null> {
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
      stateReason: data.state_reason ?? undefined,
    };
  }

  async getBatchIssueStatus(
    owner: string,
    repo: string,
    issueNumbers: number[],
  ): Promise<Map<number, IssueInfo>> {
    const requestedNumbers = uniqueBatchNumbers(issueNumbers);
    if (requestedNumbers.length === 0) {
      return new Map();
    }

    const issues = await retryBatchRequest(() => this.getRecentIssueStatuses(owner, repo, requestedNumbers));
    const missingNumbers = requestedNumbers.filter((number) => !issues.has(number));

    if (missingNumbers.length === 0) {
      return issues;
    }

    // Fall back to the exact-number badge query only for resources that were not
    // present in the recent REST listing, keeping the common path REST-based while
    // still bounding request count for older sparse issue numbers.
    const fallbackRequests = missingNumbers.map((number) => ({
      alias: `issue_${number}`,
      type: "issue" as const,
      number,
    }));
    const fallbackResources = await this.getBadgeStatusesBatchWithRetry(owner, repo, fallbackRequests);

    for (const request of fallbackRequests) {
      const resource = fallbackResources[request.alias];
      if (!resource || resource.type !== "issue") continue;
      issues.set(request.number, resource.issueInfo);
    }

    return issues;
  }

  async getBatchPrStatus(
    owner: string,
    repo: string,
    prNumbers: number[],
  ): Promise<Map<number, PrInfo>> {
    const requestedNumbers = uniqueBatchNumbers(prNumbers);
    if (requestedNumbers.length === 0) {
      return new Map();
    }

    const prs = await retryBatchRequest(() => this.getRecentPrStatuses(owner, repo, requestedNumbers));
    const missingNumbers = requestedNumbers.filter((number) => !prs.has(number));

    if (missingNumbers.length === 0) {
      return prs;
    }

    // Use the exact-number fallback only for PRs omitted from the recent REST page
    // so older items do not force paginated list scans or N single-resource calls.
    const fallbackRequests = missingNumbers.map((number) => ({
      alias: `pr_${number}`,
      type: "pr" as const,
      number,
    }));
    const fallbackResources = await this.getBadgeStatusesBatchWithRetry(owner, repo, fallbackRequests);

    for (const request of fallbackRequests) {
      const resource = fallbackResources[request.alias];
      if (!resource || resource.type !== "pr") continue;
      prs.set(request.number, resource.prInfo);
    }

    return prs;
  }

  private async getRecentIssueStatuses(
    owner: string,
    repo: string,
    requestedNumbers: number[],
  ): Promise<Map<number, IssueInfo>> {
    const requestedSet = new Set(requestedNumbers);
    const issues = new Map<number, IssueInfo>();
    const items = await this.listRecentIssueStatusPage(owner, repo);

    for (const issue of items) {
      if (!requestedSet.has(issue.number) || issue.pull_request) continue;
      issues.set(issue.number, {
        url: issue.html_url,
        number: issue.number,
        state: this.mapIssueState(issue.state),
        title: issue.title,
        stateReason: issue.state_reason,
      });
    }

    return issues;
  }

  private async listRecentIssueStatusPage(
    owner: string,
    repo: string,
  ): Promise<RestIssueListItem[]> {
    const path = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=all&per_page=${MAX_BADGE_BATCH_SIZE}`;

    if (this.hasGhAuth()) {
      try {
        return await runGhJsonAsync<RestIssueListItem[]>(["api", path]);
      } catch (err) {
        if (this.token) {
          return this.listRecentIssueStatusPageWithApi(owner, repo);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }

    if (this.token) {
      return this.listRecentIssueStatusPageWithApi(owner, repo);
    }

    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private async listRecentIssueStatusPageWithApi(
    owner: string,
    repo: string,
  ): Promise<RestIssueListItem[]> {
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=all&per_page=${MAX_BADGE_BATCH_SIZE}`;
    const response = await fetch(url, { headers: this.buildHeaders() });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }

    return response.json() as Promise<RestIssueListItem[]>;
  }

  private async getRecentPrStatuses(
    owner: string,
    repo: string,
    requestedNumbers: number[],
  ): Promise<Map<number, PrInfo>> {
    const requestedSet = new Set(requestedNumbers);
    const prs = new Map<number, PrInfo>();
    const items = await this.listRecentPrStatusPage(owner, repo);

    for (const pr of items) {
      if (!requestedSet.has(pr.number)) continue;
      prs.set(pr.number, {
        url: pr.html_url,
        number: pr.number,
        status: pr.merged_at ? "merged" : this.mapPrState(pr.state),
        title: pr.title,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        commentCount: pr.comments,
        lastCommentAt: pr.updated_at,
      });
    }

    return prs;
  }

  private async listRecentPrStatusPage(
    owner: string,
    repo: string,
  ): Promise<RestPrListItem[]> {
    const path = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&per_page=${MAX_BADGE_BATCH_SIZE}`;

    if (this.hasGhAuth()) {
      try {
        return await runGhJsonAsync<RestPrListItem[]>(["api", path]);
      } catch (err) {
        if (this.token) {
          return this.listRecentPrStatusPageWithApi(owner, repo);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }

    if (this.token) {
      return this.listRecentPrStatusPageWithApi(owner, repo);
    }

    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.");
  }

  private async listRecentPrStatusPageWithApi(
    owner: string,
    repo: string,
  ): Promise<RestPrListItem[]> {
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&per_page=${MAX_BADGE_BATCH_SIZE}`;
    const response = await fetch(url, { headers: this.buildHeaders() });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }

    return response.json() as Promise<RestPrListItem[]>;
  }

  private async getBadgeStatusesBatchWithRetry(
    owner: string,
    repo: string,
    requests: BadgeBatchRequest[],
  ): Promise<BadgeBatchResponse> {
    const response: BadgeBatchResponse = {};

    for (const chunk of chunkBadgeRequests(requests, MAX_BADGE_BATCH_SIZE)) {
      const chunkResponse = await retryBatchRequest(() => this.getBadgeStatusesBatch(owner, repo, chunk));
      Object.assign(response, chunkResponse);
    }

    return response;
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
      "User-Agent": "fn/1.0",
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
   * List issues from a repository.
   * Uses gh CLI if available, otherwise falls back to REST API.
   */
  async listIssues(
    owner: string,
    repo: string,
    options?: { limit?: number; labels?: string[]; state?: "open" | "all" }
  ): Promise<Array<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
    state?: "open" | "closed";
    updatedAt?: string;
    author?: string | null;
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
    options?: { limit?: number; labels?: string[]; state?: "open" | "all" }
  ): Promise<Array<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
    state?: "open" | "closed";
    updatedAt?: string;
    author?: string | null;
  }>> {
    const limit = Math.min(options?.limit ?? 30, MAX_LIST_ISSUES);
    const state = options?.state ?? "open";

    /*
    FNXC:GitHubImport 2026-07-16-16:20:
    Label filtering is client-side (OR across labels, matching the historical `.some()` semantics that `gh --label`'s AND cannot express).
    Because filtering happens AFTER the fetch, the fetch must pull the full cap when labels are set — otherwise `gh` returns the first `limit` UNFILTERED issues and the post-filter `.slice(0, limit)` starves, hiding labeled issues that sort past the first `limit` rows.
    Without labels there is nothing to filter, so fetch exactly `limit`. `gh --limit` paginates internally past 100 to reach the requested count.
    */
    const hasLabelFilter = Boolean(options?.labels && options.labels.length > 0);
    const fetchCount = hasLabelFilter ? MAX_LIST_ISSUES : limit;

    // gh issue list doesn't support OR label filtering directly, so we fetch and filter client-side
    const issues = await runGhJsonAsync<Array<{
      number: number;
      title: string;
      body: string;
      url: string;
      labels: Array<{ name: string }>;
      state: "OPEN" | "CLOSED";
      updatedAt: string;
      author?: { login?: string } | null;
    }>>([
      "issue", "list",
      "--repo", `${owner}/${repo}`,
      "--state", state,
      "--limit", String(fetchCount),
      // FNXC:GitHubImport 2026-06-22-18:30: Request `author` so the import preview pane can show full issue metadata (author/state alongside the already-present full body) without a per-item detail fetch.
      "--json", "number,title,body,url,labels,state,updatedAt,author",
    ]);

    let result = issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      html_url: issue.url,
      labels: issue.labels,
      state: this.mapGhIssueState(issue.state),
      updatedAt: issue.updatedAt,
      author: issue.author?.login ?? null,
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
    options?: { limit?: number; labels?: string[]; state?: "open" | "all" }
  ): Promise<Array<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
    state?: "open" | "closed";
    updatedAt?: string;
    author?: string | null;
  }>> {
    const limit = Math.min(options?.limit ?? 30, MAX_LIST_ISSUES);
    const state = options?.state ?? "open";
    const headers = this.buildHeaders();

    /*
    FNXC:GitHubImport 2026-07-16-16:20:
    REST `/issues` caps per_page at 100, so loop `page` until we collect `limit` real issues or a short page
    signals exhaustion. Pull requests share the `/issues` feed and are dropped here, which can shrink a page
    below per_page — so keep paging on a full 100-item page even after PR filtering, and stop only on a genuinely
    short page. Bounded by MAX_LIST_ISSUES pages-worth so a huge repo can't loop unbounded.
    */
    const perPage = Math.min(limit, ISSUE_LIST_PAGE_SIZE);
    const collected: Array<{
      number: number;
      title: string;
      body: string | null;
      html_url: string;
      labels: Array<{ name: string }>;
      state?: "open" | "closed";
      updatedAt?: string;
      author?: string | null;
    }> = [];

    for (let page = 1; collected.length < limit; page += 1) {
      const params = new URLSearchParams();
      params.append("state", state);
      params.append("per_page", String(perPage));
      params.append("page", String(page));
      if (options?.labels && options.labels.length > 0) {
        params.append("labels", options.labels.join(","));
      }

      const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params}`;
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
        state: string;
        updated_at: string;
        user?: { login?: string } | null;
        pull_request?: unknown;
      }>;

      for (const issue of data) {
        if (issue.pull_request) continue; // PRs share the /issues feed; exclude them
        collected.push({
          number: issue.number,
          title: issue.title,
          body: issue.body,
          html_url: issue.html_url,
          labels: issue.labels,
          state: this.mapIssueState(issue.state),
          updatedAt: issue.updated_at,
          author: issue.user?.login ?? null,
        });
      }

      // A page shorter than per_page means GitHub has no further issues to return.
      if (data.length < perPage) break;
    }

    return collected.slice(0, limit);
  }

  async searchIssues(
    owner: string,
    repo: string,
    query: string,
    options?: { limit?: number; state?: "open" | "closed" | "all" },
  ): Promise<Array<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: "open" | "closed";
    updatedAt?: string;
  }>> {
    const requestedLimit = options?.limit ?? 10;
    const limit = Math.min(Math.max(1, requestedLimit), 50);
    const state = options?.state ?? "all";

    if (this.hasGhAuth()) {
      try {
        const args = [
          "search",
          "issues",
          "--repo",
          `${owner}/${repo}`,
          "--limit",
          String(limit),
          "--json",
          "number,title,body,url,state,updatedAt,isPullRequest",
        ];
        if (state !== "all") {
          args.push("--state", state);
        }
        args.push("--", query);

        const issues = await runGhJsonAsync<Array<{
          number: number;
          title: string;
          body: string | null;
          url: string;
          state: "OPEN" | "CLOSED";
          updatedAt: string;
          isPullRequest?: boolean;
        }>>(args);

        return issues
          .filter((issue) => !issue.isPullRequest)
          .map((issue) => ({
            number: issue.number,
            title: issue.title,
            body: issue.body,
            html_url: issue.url,
            state: this.mapGhIssueState(issue.state),
            updatedAt: issue.updatedAt,
          }));
      } catch (err) {
        if (!this.token) {
          throw new Error(getGhErrorMessage(err));
        }
      }
    }

    if (!this.token) {
      throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided. Run 'gh auth login' to authenticate.");
    }

    const stateQualifier = state === "all" ? "" : ` state:${state}`;
    const q = `${query} repo:${owner}/${repo}${stateQualifier} is:issue`;
    const params = new URLSearchParams();
    params.set("q", q);
    params.set("per_page", String(Math.min(limit, 100)));

    const url = `${this.baseUrl}/search/issues?${params.toString()}`;
    const response = await fetch(url, { headers: this.buildHeaders() });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      items?: Array<{
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        state: string;
        updated_at: string;
        pull_request?: unknown;
      }>;
    };

    return (data.items ?? [])
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        html_url: issue.html_url,
        state: this.mapIssueState(issue.state) ?? "open",
        updatedAt: issue.updated_at,
      }))
      .slice(0, limit);
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
    closedAt?: string;
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
    closedAt?: string;
  } | null> {
    try {
      const issue = await runGhJsonAsync<{
        number: number;
        title: string;
        body: string;
        url: string;
        state: "OPEN" | "CLOSED";
        stateReason?: "completed" | "not_planned" | "reopened";
        closedAt?: string | null;
      }>([
        "issue", "view", String(number),
        "--repo", `${owner}/${repo}`,
        "--json", "number,title,body,url,state,stateReason,closedAt",
      ]);

      return {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        html_url: issue.url,
        state: this.mapGhIssueState(issue.state),
        stateReason: issue.stateReason,
        closedAt: normalizeIssueClosedAt(issue.closedAt),
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
    closedAt?: string;
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
      closed_at?: string | null;
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
      stateReason: data.state_reason ?? undefined,
      closedAt: normalizeIssueClosedAt(data.closed_at),
    };
  }

  /**
   * List open pull requests from a repository.
   * Uses gh CLI if available, otherwise falls back to REST API.
   */
  async listPullRequests(
    owner: string,
    repo: string,
    options?: { limit?: number }
  ): Promise<Array<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    headBranch: string;
    baseBranch: string;
    state?: "open" | "closed" | "merged";
    author?: string | null;
  }>> {
    if (this.hasGhAuth()) {
      try {
        return await this.listPullRequestsWithGh(owner, repo, options);
      } catch (err) {
        if (this.token) {
          return this.listPullRequestsWithApi(owner, repo, options);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }

    if (this.token) {
      return this.listPullRequestsWithApi(owner, repo, options);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided. Run 'gh auth login' to authenticate.");
  }

  private async listPullRequestsWithGh(
    owner: string,
    repo: string,
    options?: { limit?: number }
  ): Promise<Array<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    headBranch: string;
    baseBranch: string;
    state?: "open" | "closed" | "merged";
    author?: string | null;
  }>> {
    const limit = options?.limit ?? 30;

    const pulls = await runGhJsonAsync<Array<{
      number: number;
      title: string;
      body: string;
      url: string;
      headRefName: string;
      baseRefName: string;
      state?: "OPEN" | "CLOSED" | "MERGED";
      author?: { login?: string } | null;
    }>>([
      "pr", "list",
      "--repo", `${owner}/${repo}`,
      "--state", "open",
      "--limit", String(Math.min(limit, 100)),
      // FNXC:GitHubImport 2026-06-22-18:30: Request `state,author` so the import preview pane shows full PR metadata (author/state with the already-present full body) without a per-item detail fetch.
      "--json", "number,title,body,url,headRefName,baseRefName,state,author",
    ]);

    return pulls.map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      html_url: pr.url,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      state: pr.state ? (pr.state.toLowerCase() as "open" | "closed" | "merged") : undefined,
      author: pr.author?.login ?? null,
    }));
  }

  private async listPullRequestsWithApi(
    owner: string,
    repo: string,
    options?: { limit?: number }
  ): Promise<Array<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    headBranch: string;
    baseBranch: string;
    state?: "open" | "closed" | "merged";
    author?: string | null;
  }>> {
    const limit = options?.limit ?? 30;

    const params = new URLSearchParams();
    params.append("state", "open");
    params.append("per_page", String(Math.min(limit, 100)));

    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params}`;
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
      head: { ref: string };
      base: { ref: string };
      state?: string;
      user?: { login?: string } | null;
    }>;

    return data.slice(0, limit).map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      html_url: pr.html_url,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      state: pr.state === "open" || pr.state === "closed" ? pr.state : undefined,
      author: pr.user?.login ?? null,
    }));
  }

  /*
  FNXC:GitHubImport 2026-06-23-01:00:
  The Import Tasks PR preview needs the FULL comment thread plus per-check status for the SELECTED PR only.
  `gh pr list` (listPullRequests) returns just comment COUNT + no per-check detail, so this per-PR detail fetch is intentionally separate and called on selection — never for the whole list (too expensive).
  Returns the issue-level comment thread (author/body/createdAt, chronological) and the status-check rollup mapped to { name, status, conclusion?, detailsUrl? }.
  Falls back to REST when gh CLI auth is unavailable; check failures degrade to an empty checks array rather than failing the whole detail.
  */
  /*
  FNXC:GitHubImport 2026-06-23-03:30:
  Comment shape extends to { authorAvatarUrl?, authorIsBot } so the Import Tasks preview can render an avatar and a reliable human/bot badge per comment.
  authorIsBot is true when the author type resolves to a GitHub Bot OR the login ends in `[bot]`. authorAvatarUrl is the API-provided avatar when present, else a `https://github.com/{login}.png?size=40` fallback (suppressed for bot logins, whose `[bot]`-suffixed handle does not resolve — the frontend renders a generic bot icon instead).
  */
  async getPullRequestDetail(
    owner: string,
    repo: string,
    number: number
  ): Promise<{
    comments: Array<{ author: string; body: string; createdAt: string; authorAvatarUrl?: string; authorIsBot: boolean }>;
    checks: Array<{ name: string; status: string; conclusion?: string; detailsUrl?: string }>;
  }> {
    if (this.hasGhAuth()) {
      try {
        return await this.getPullRequestDetailWithGh(owner, repo, number);
      } catch (err) {
        if (this.token) {
          return this.getPullRequestDetailWithApi(owner, repo, number);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }
    if (this.token) {
      return this.getPullRequestDetailWithApi(owner, repo, number);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided. Run 'gh auth login' to authenticate.");
  }

  /*
  FNXC:GitHubImport 2026-06-22-12:00:
  Fetch a PR/issue's conversation comments via `gh api graphql` so the author's authoritative
  Actor `__typename` (User | Bot | Organization | Mannequin) is available per comment. The
  `gh pr/issue view --json comments` path only surfaces `{ login }` with no type and a bot's bare
  display login (no `[bot]` suffix), which silently misclassified GitHub App reviewers as human.
  Returns the same `{ author, body, createdAt, authorAvatarUrl?, authorIsBot }` shape; `authorIsBot`
  is true when `__typename === "Bot"` (or the `[bot]`-login suffix fallback inside resolveCommentAuthor).
  */
  private async fetchCommentsWithGhGraphql(
    owner: string,
    repo: string,
    number: number,
    kind: "pullRequest" | "issue",
  ): Promise<Array<{ author: string; body: string; createdAt: string; authorAvatarUrl?: string; authorIsBot: boolean }>> {
    const query = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    ${kind}(number:$number){
      comments(first:100){
        nodes{ author{ __typename login avatarUrl } body createdAt }
      }
    }
  }
}`;
    const result = await runGhJsonAsync<{
      data?: {
        repository?: {
          pullRequest?: { comments?: { nodes?: GhGraphqlCommentNode[] } } | null;
          issue?: { comments?: { nodes?: GhGraphqlCommentNode[] } } | null;
        } | null;
      };
    }>([
      "api", "graphql",
      "-f", `query=${query}`,
      "-F", `owner=${owner}`,
      "-F", `repo=${repo}`,
      "-F", `number=${number}`,
    ]);

    const container = kind === "pullRequest"
      ? result.data?.repository?.pullRequest
      : result.data?.repository?.issue;
    const nodes = container?.comments?.nodes ?? [];

    return nodes.map((c) => {
      const author = c.author?.login ?? "unknown";
      const { authorIsBot, authorAvatarUrl } = resolveCommentAuthor({
        login: author,
        // Actor.__typename is the real signal: "Bot" for any GitHub App (CodeRabbit, Greptile, ...).
        typename: c.author?.__typename,
        avatarUrl: c.author?.avatarUrl,
      });
      return { author, body: c.body ?? "", createdAt: c.createdAt ?? "", authorAvatarUrl, authorIsBot };
    });
  }

  private async getPullRequestDetailWithGh(
    owner: string,
    repo: string,
    number: number
  ): Promise<{
    comments: Array<{ author: string; body: string; createdAt: string; authorAvatarUrl?: string; authorIsBot: boolean }>;
    checks: Array<{ name: string; status: string; conclusion?: string; detailsUrl?: string }>;
  }> {
    // FNXC:GitHubImport 2026-06-22-12:00:
    // `gh pr view --json comments` author is just `{ login }` — no `__typename`/`type`/`is_bot`,
    // and the surfaced login is the app's bare display login (e.g. `coderabbitai`, `greptileai`)
    // WITHOUT the `[bot]` suffix. That made every GitHub App reviewer (CodeRabbit, Greptile, etc.)
    // misclassify as HUMAN, since neither the type field nor the `[bot]` suffix heuristic could fire.
    // Fix: read the authoritative Actor `__typename` (User | Bot | Organization | Mannequin) via
    // `gh api graphql`, so `authorIsBot = __typename === "Bot"` catches ANY app bot by type, not by name.
    // statusCheckRollup is still only on `gh pr view`, so it stays a separate (best-effort) call.
    const comments = await this.fetchCommentsWithGhGraphql(owner, repo, number, "pullRequest");

    let checks: Array<{ name: string; status: string; conclusion?: string; detailsUrl?: string }> = [];
    const pr = await runGhJsonAsync<{
      // `gh pr view --json statusCheckRollup` returns a flat array of mixed CheckRun/StatusContext shapes.
      statusCheckRollup?: Array<{
        name?: string;
        context?: string;
        status?: string;
        state?: string;
        conclusion?: string;
        detailsUrl?: string;
        targetUrl?: string;
        link?: string;
      }> | null;
    }>([
      "pr", "view", String(number),
      "--repo", `${owner}/${repo}`,
      "--json", "statusCheckRollup",
    ]);

    checks = (pr.statusCheckRollup ?? []).map((c) => ({
      name: c.name ?? c.context ?? "check",
      // CheckRun uses `status`; StatusContext uses `state`. Surface whichever is present.
      status: (c.status ?? c.state ?? "").toLowerCase(),
      conclusion: c.conclusion ? c.conclusion.toLowerCase() : undefined,
      detailsUrl: c.detailsUrl ?? c.targetUrl ?? c.link ?? undefined,
    }));

    return { comments, checks };
  }

  private async getPullRequestDetailWithApi(
    owner: string,
    repo: string,
    number: number
  ): Promise<{
    comments: Array<{ author: string; body: string; createdAt: string; authorAvatarUrl?: string; authorIsBot: boolean }>;
    checks: Array<{ name: string; status: string; conclusion?: string; detailsUrl?: string }>;
  }> {
    const headers = this.buildHeaders();

    // Issue comments thread (the PR conversation tab), chronological.
    const commentsUrl = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments?per_page=100`;
    const commentsRes = await fetch(commentsUrl, { headers });
    if (!commentsRes.ok) {
      if (commentsRes.status === 404) {
        throw new Error(`PR #${number} not found in ${owner}/${repo}`);
      }
      throw new Error(`GitHub API error: ${commentsRes.status} ${commentsRes.statusText}`);
    }
    const commentData = (await commentsRes.json()) as Array<{
      user?: { login?: string; avatar_url?: string; type?: string } | null;
      body?: string;
      created_at?: string;
    }>;
    const comments = commentData.map((c) => {
      const author = c.user?.login ?? "unknown";
      const { authorIsBot, authorAvatarUrl } = resolveCommentAuthor({
        login: author,
        type: c.user?.type,
        avatarUrl: c.user?.avatar_url,
      });
      return { author, body: c.body ?? "", createdAt: c.created_at ?? "", authorAvatarUrl, authorIsBot };
    });

    // Per-check status via the combined check-runs endpoint on the PR head sha.
    // Check failures degrade to an empty checks array rather than failing the whole detail.
    let checks: Array<{ name: string; status: string; conclusion?: string; detailsUrl?: string }> = [];
    try {
      const prUrl = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
      const prRes = await fetch(prUrl, { headers });
      if (prRes.ok) {
        const prJson = (await prRes.json()) as { head?: { sha?: string } };
        const sha = prJson.head?.sha;
        if (sha) {
          const checksUrl = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/check-runs?per_page=100`;
          const checksRes = await fetch(checksUrl, { headers });
          if (checksRes.ok) {
            const checksJson = (await checksRes.json()) as {
              check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null; details_url?: string | null }>;
            };
            checks = (checksJson.check_runs ?? []).map((c) => ({
              name: c.name ?? "check",
              status: (c.status ?? "").toLowerCase(),
              conclusion: c.conclusion ? c.conclusion.toLowerCase() : undefined,
              detailsUrl: c.details_url ?? undefined,
            }));
          }
        }
      }
    } catch {
      checks = [];
    }

    return { comments, checks };
  }

  /*
  FNXC:GitHubImport 2026-06-23-03:15:
  Issues preview pane mirrors the PR preview: on selection it fetches the issue's full comment thread (issues have no checks rollup, so only comments).
  `gh issue view --json comments` returns the conversation; REST `issues/{n}/comments` is the token fallback. 404 maps to "not found" upstream of the route.
  */
  async getIssueDetail(
    owner: string,
    repo: string,
    number: number
  ): Promise<{
    comments: Array<{ author: string; body: string; createdAt: string; authorAvatarUrl?: string; authorIsBot: boolean }>;
  }> {
    if (this.hasGhAuth()) {
      try {
        return await this.getIssueDetailWithGh(owner, repo, number);
      } catch (err) {
        if (this.token) {
          return this.getIssueDetailWithApi(owner, repo, number);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }
    if (this.token) {
      return this.getIssueDetailWithApi(owner, repo, number);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided. Run 'gh auth login' to authenticate.");
  }

  private async getIssueDetailWithGh(
    owner: string,
    repo: string,
    number: number
  ): Promise<{
    comments: Array<{ author: string; body: string; createdAt: string; authorAvatarUrl?: string; authorIsBot: boolean }>;
  }> {
    // FNXC:GitHubImport 2026-06-22-12:00:
    // Use the graphql Actor.__typename path (not `gh issue view --json comments`, which omits the
    // type) so GitHub App reviewers like CodeRabbit/Greptile are correctly flagged as bots.
    const comments = await this.fetchCommentsWithGhGraphql(owner, repo, number, "issue");

    return { comments };
  }

  private async getIssueDetailWithApi(
    owner: string,
    repo: string,
    number: number
  ): Promise<{
    comments: Array<{ author: string; body: string; createdAt: string; authorAvatarUrl?: string; authorIsBot: boolean }>;
  }> {
    const headers = this.buildHeaders();

    const commentsUrl = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments?per_page=100`;
    const commentsRes = await fetch(commentsUrl, { headers });
    if (!commentsRes.ok) {
      if (commentsRes.status === 404) {
        throw new Error(`Issue #${number} not found in ${owner}/${repo}`);
      }
      throw new Error(`GitHub API error: ${commentsRes.status} ${commentsRes.statusText}`);
    }
    const commentData = (await commentsRes.json()) as Array<{
      user?: { login?: string; avatar_url?: string; type?: string } | null;
      body?: string;
      created_at?: string;
    }>;
    const comments = commentData.map((c) => {
      const author = c.user?.login ?? "unknown";
      const { authorIsBot, authorAvatarUrl } = resolveCommentAuthor({
        login: author,
        type: c.user?.type,
        avatarUrl: c.user?.avatar_url,
      });
      return { author, body: c.body ?? "", createdAt: c.created_at ?? "", authorAvatarUrl, authorIsBot };
    });

    return { comments };
  }

  /*
  FNXC:GitHubImport 2026-06-23-03:15:
  Close-issue action for the Import Tasks issue preview pane. `gh issue close <n>` closes via CLI; REST PATCH state=closed is the token fallback.
  Returns void; the route maps 404/401 like the detail route. The preview reflects the closed state locally without re-fetching.
  */
  async closeIssue(owner: string, repo: string, number: number): Promise<void> {
    if (this.hasGhAuth()) {
      try {
        await runGhAsync([
          "issue", "close", String(number),
          "--repo", `${owner}/${repo}`,
        ]);
        return;
      } catch (err) {
        if (this.token) {
          await this.closeIssueWithApi(owner, repo, number);
          return;
        }
        throw new Error(getGhErrorMessage(err));
      }
    }
    if (this.token) {
      await this.closeIssueWithApi(owner, repo, number);
      return;
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided. Run 'gh auth login' to authenticate.");
  }

  private async closeIssueWithApi(owner: string, repo: string, number: number): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
      {
        method: "PATCH",
        headers: { ...this.buildHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      }
    );
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Issue #${number} not found in ${owner}/${repo}`);
      }
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }
  }


  /*
  FNXC:GitHubImport 2026-07-17-12:00:
  Import-preview operators can post a new comment to the upstream issue without leaving Fusion.
  Prefer `gh issue comment` and fall back to the authenticated REST endpoint, matching closeIssue
  so hosts with either CLI authentication or GITHUB_TOKEN remain supported.
  */
  async addIssueComment(owner: string, repo: string, number: number, body: string): Promise<void> {
    if (this.hasGhAuth()) {
      try {
        await runGhAsync([
          "issue", "comment", String(number),
          "--repo", `${owner}/${repo}`,
          "--body", body,
        ]);
        return;
      } catch (err) {
        if (this.token) {
          await this.addIssueCommentWithApi(owner, repo, number, body);
          return;
        }
        throw new Error(getGhErrorMessage(err));
      }
    }
    if (this.token) {
      await this.addIssueCommentWithApi(owner, repo, number, body);
      return;
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided. Run 'gh auth login' to authenticate.");
  }

  private async addIssueCommentWithApi(owner: string, repo: string, number: number, body: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
      {
        method: "POST",
        headers: { ...this.buildHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Issue #${number} not found in ${owner}/${repo}`);
      }
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${response.status} ${error.message || response.statusText}`);
    }
  }

  /**
   * Fetch a single pull request by number.
   * Uses gh CLI if available, otherwise falls back to REST API.
   * Returns null if the pull request is not found.
   */
  async getPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    headBranch: string;
    baseBranch: string;
    state: "open" | "closed" | "merged";
  } | null> {
    if (this.hasGhAuth()) {
      try {
        return await this.getPullRequestWithGh(owner, repo, number);
      } catch (err) {
        if (this.token) {
          return this.getPullRequestWithApi(owner, repo, number);
        }
        throw new Error(getGhErrorMessage(err));
      }
    }

    if (this.token) {
      return this.getPullRequestWithApi(owner, repo, number);
    }
    throw new Error("GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided. Run 'gh auth login' to authenticate.");
  }

  private async getPullRequestWithGh(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    headBranch: string;
    baseBranch: string;
    state: "open" | "closed" | "merged";
  } | null> {
    try {
      const pr = await runGhJsonAsync<{
        number: number;
        title: string;
        body: string;
        url: string;
        headRefName: string;
        baseRefName: string;
        state: "OPEN" | "CLOSED" | "MERGED";
        mergedAt?: string | null;
      }>([
        "pr", "view", String(number),
        "--repo", `${owner}/${repo}`,
        "--json", "number,title,body,url,headRefName,baseRefName,state,mergedAt",
      ]);

      return {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        html_url: pr.url,
        headBranch: pr.headRefName,
        baseBranch: pr.baseRefName,
        state: pr.mergedAt ? "merged" : this.mapGhPrState(pr.state),
      };
    } catch (err) {
      // gh pr view returns error if the PR doesn't exist
      if (err instanceof Error && err.message.includes("not found")) {
        return null;
      }
      throw err;
    }
  }

  private async getPullRequestWithApi(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    headBranch: string;
    baseBranch: string;
    state: "open" | "closed" | "merged";
  } | null> {
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
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
      merged: boolean;
      head: { ref: string };
      base: { ref: string };
    };

    return {
      number: data.number,
      title: data.title,
      body: data.body,
      html_url: data.html_url,
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
      state: data.merged ? "merged" : this.mapPrState(data.state) === "open" ? "open" : "closed",
    };
  }

  // ==========================================
  // GitHub App Installation Auth Methods
  // ==========================================

  /**
   * Generate a JWT for GitHub App authentication.
   * Used to request installation access tokens.
   */
  static async generateAppJWT(appId: string, privateKey: string): Promise<string> {
    const { createSign } = await import("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    const expiration = now + 600; // 10 minutes max per GitHub requirements

    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iat: now - 60, // 1 minute ago to account for clock skew
      exp: expiration,
      iss: appId,
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const signature = createSign("RSA-SHA256")
      .update(signingInput)
      .sign(privateKey, "base64url");

    return `${signingInput}.${signature}`;
  }

  /**
   * Fetch an installation access token for a GitHub App.
   * This token is used to make API calls on behalf of the app installation.
   */
  static async fetchInstallationToken(
    installationId: number,
    appId: string,
    privateKey: string,
  ): Promise<string | null> {
    try {
      const jwt = await GitHubClient.generateAppJWT(appId, privateKey);

      const response = await fetch(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: `Bearer ${jwt}`,
            "User-Agent": "fn/1.0",
          },
        },
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as { token: string };
      return data.token;
    } catch {
      return null;
    }
  }

  /**
   * Fetch canonical PR info using GitHub App installation authentication.
   * This bypasses the gh CLI and user tokens for webhook-driven updates.
   */
  static async fetchPrWithInstallationToken(
    owner: string,
    repo: string,
    number: number,
    installationToken: string,
  ): Promise<Omit<PrInfo, "lastCheckedAt"> | null> {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: `Bearer ${installationToken}`,
            "User-Agent": "fn/1.0",
          },
        },
      );

      if (!response.ok) {
        return null;
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
        status: data.merged ? "merged" : data.state === "open" ? "open" : "closed",
        title: data.title,
        headBranch: data.head.ref,
        baseBranch: data.base.ref,
        commentCount: data.comments,
        lastCommentAt: data.updated_at,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch canonical issue info using GitHub App installation authentication.
   */
  static async fetchIssueWithInstallationToken(
    owner: string,
    repo: string,
    number: number,
    installationToken: string,
  ): Promise<Omit<IssueInfo, "lastCheckedAt"> | null> {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: `Bearer ${installationToken}`,
            "User-Agent": "fn/1.0",
          },
        },
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as {
        number: number;
        html_url: string;
        title: string;
        state: string;
        state_reason?: "completed" | "not_planned" | "reopened" | null;
        pull_request?: unknown;
      };

      // Skip PRs - they come through the issues endpoint too
      if (data.pull_request) {
        return null;
      }

      return {
        url: data.html_url,
        number: data.number,
        state: data.state === "open" ? "open" : "closed",
        title: data.title,
        stateReason: data.state_reason ?? undefined,
      };
    } catch {
      return null;
    }
  }
}

function uniqueBatchNumbers(numbers: number[]): number[] {
  return [...new Set(numbers.filter((number) => Number.isInteger(number) && number > 0))];
}

function chunkBadgeRequests(requests: BadgeBatchRequest[], size: number): BadgeBatchRequest[][] {
  if (requests.length === 0) return [];

  const chunks: BadgeBatchRequest[][] = [];
  for (let index = 0; index < requests.length; index += size) {
    chunks.push(requests.slice(index, index + size));
  }
  return chunks;
}

async function retryBatchRequest<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_BATCH_RETRIES || !shouldRetryBatchRequestError(error)) {
        throw error;
      }

      await delay(BATCH_RETRY_DELAY_MS);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Batch request failed"));
}

function shouldRetryBatchRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit|secondary rate limit|timed out|timeout|fetch failed|econnreset|econnrefused|socket hang up|502|503|504/i.test(message);
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

/**
 * FNXC:GithubSourceIssueAnalytics 2026-06-18-18:10:
 * GitHub source-issue reconciliation must only persist real closure timestamps, so `getIssue()` surfaces provider close times while normalizing absent and sentinel values to undefined for open or not-yet-observed issues.
 */
function normalizeIssueClosedAt(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("0001-01-01T00:00:00")) return undefined;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : undefined;
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
 * Parse a GitHub badge URL (PR or issue) into its components.
 * Supports formats like:
 * - https://github.com/owner/repo/pull/123
 * - https://github.com/owner/repo/issues/123
 * 
 * This is a shared helper used by routes.ts, server.ts, and the webhook handler
 * to ensure consistent badge URL parsing across the codebase.
 */
export function parseBadgeUrl(url: string): { owner: string; repo: string; number: number; resourceType: "pr" | "issue" } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") {
      return null;
    }

    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length < 4) {
      return null;
    }

    const [owner, repo, type, numberStr] = pathParts;
    const number = parseInt(numberStr, 10);

    if (!owner || !repo || !Number.isFinite(number) || number < 1) {
      return null;
    }

    let resourceType: "pr" | "issue";
    if (type === "pull") {
      resourceType = "pr";
    } else if (type === "issues") {
      resourceType = "issue";
    } else {
      return null;
    }

    return { owner, repo, number, resourceType };
  } catch {
    return null;
  }
}

/**
 * @deprecated Use parseBadgeUrl instead
 */
export function parseGitHubBadgeUrl(url: string): { owner: string; repo: string } | null {
  const parsed = parseBadgeUrl(url);
  if (!parsed) return null;
  return { owner: parsed.owner, repo: parsed.repo };
}

/**
 * Resolve the repo, throwing if it can't be determined. Pass the per-project
 * `cwd` so multi-project servers resolve the right repo; without it the repo is
 * resolved from the process cwd, which is wrong outside single-project flows.
 */
function getCurrentRepoOrThrow(cwd?: string): { owner: string; repo: string } {
  const currentRepo = getCurrentRepo(cwd);
  if (!currentRepo) {
    throw new Error(
      "Could not determine repository. Run from a git repository with a GitHub remote.",
    );
  }
  return currentRepo;
}

/** Map a `PrInfo.status` to the persisted `BranchGroup.prState`. */
function prInfoToBranchGroupPrState(prInfo: PrInfo | null): BranchGroupPrState {
  if (!prInfo) return "none";
  if (prInfo.status === "merged") return "merged";
  if (prInfo.status === "closed") return "closed";
  return "open";
}

export interface CreateGroupPrResult {
  prNumber: number;
  prUrl: string;
  prState: BranchGroupPrState;
}

/**
 * Read-only reconciliation of the single managed group PR against GitHub (Fix
 * #3). Reads the current PR status and maps it to the persisted `prState`. Used
 * by the dashboard's single-group read path (`GET /branch-groups/:id`) to flip
 * `prState` → merged/closed when the PR was merged/closed out-of-band. Does not
 * mutate the PR; if GitHub still reports it open, returns the open state so the
 * caller writes nothing.
 */
export async function reconcileGroupPullRequest(
  github: Pick<GitHubClient, "getPrStatus">,
  group: Pick<BranchGroup, "id" | "prNumber">,
  /**
   * Per-project working directory. Multi-project servers MUST pass this so the
   * repo identity is resolved per-project rather than from the process cwd.
   */
  cwd?: string,
): Promise<CreateGroupPrResult> {
  const prNumber = group.prNumber;
  if (prNumber == null) {
    throw new Error(`reconcileGroupPullRequest: group ${group.id} has no persisted prNumber`);
  }
  const { owner, repo } = getCurrentRepoOrThrow(cwd);
  const current = await github.getPrStatus(owner, repo, prNumber);
  return {
    prNumber: current.number,
    prUrl: current.url,
    prState: prInfoToBranchGroupPrState(current),
  };
}

/**
 * Close the single managed group PR (U6, R7) — best-effort terminal
 * reconciliation when a branch group is abandoned. If the PR is already
 * closed/merged out-of-band on GitHub, returns the reconciled state instead of
 * erroring.
 */
export async function closeGroupPullRequest(
  github: Pick<GitHubClient, "getPrStatus" | "closePr">,
  group: Pick<BranchGroup, "id" | "prNumber">,
  /**
   * Per-project working directory. Multi-project servers MUST pass this so the
   * repo identity is resolved per-project rather than from the process cwd.
   */
  cwd?: string,
): Promise<CreateGroupPrResult> {
  const prNumber = group.prNumber;
  if (prNumber == null) {
    throw new Error(`closeGroupPullRequest: group ${group.id} has no persisted prNumber`);
  }

  const { owner, repo } = getCurrentRepoOrThrow(cwd);
  const current = await github.getPrStatus(owner, repo, prNumber);
  const currentState = prInfoToBranchGroupPrState(current);

  // Already terminal (closed or merged) — reconcile rather than re-close.
  if (currentState !== "open") {
    return { prNumber: current.number, prUrl: current.url, prState: currentState };
  }

  // Target the same per-project repo for the close call (closePr would
  // otherwise re-resolve from the process cwd).
  const closed = await github.closePr({ owner, repo, number: prNumber });
  return {
    prNumber: closed.number,
    prUrl: closed.url,
    prState: prInfoToBranchGroupPrState(closed),
  };
}

