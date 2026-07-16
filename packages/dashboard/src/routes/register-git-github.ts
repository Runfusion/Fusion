import { type NextFunction, type Request, type Response } from "express";
import { isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { exec as execCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import type {
  BatchStatusEntry,
  BatchStatusResponse,
  BatchStatusResult,
  DirectMergeCommitStrategy,
  IssueInfo,
  PrInfo,
  RunAuditEvent,
  RunAuditEventInput,
  Settings,
  StructuredGhError,
  Task,
  TaskStore,
} from "@fusion/core";
import { classifyGhError, getCurrentRepo, isGhAuthenticated, loadWorkspaceConfig, resolveTaskGithubTracking } from "@fusion/core";
import {
  dropAutostashHandle,
  generateSyntheticRunId,
  getConflictedFiles,
  resolveIntegrationRemote,
  restoreUnrelatedRootDirChanges,
  stashUnrelatedRootDirChanges,
  tryFastForwardFromOrigin,
  type MergerOptions,
} from "@fusion/engine";
import {
  ApiError,
  badRequest,
  conflict,
  internalError,
  notFound,
  rateLimited,
  unauthorized,
} from "../api-error.js";
import { GitHubClient, buildGitHubIssueSource, isGitHubIssueAlreadyImported, type PrReviewSnapshot, parseBadgeUrl } from "../github.js";
import { importIssueImageAttachments, githubImagePolicy } from "../issue-image-attachments.js";
import { GitHubIssueCommentService } from "../github-issue-comment.js";
import { GitHubTrackingCommentService } from "../github-tracking-comments.js";
import { GitHubTrackingStateService } from "../github-tracking-state.js";
import { GitHubTrackingReconciler, RECONCILE_SCAN_LIMIT } from "../github-tracking-reconciler.js";
import { GitHubSourceIssueCloseService } from "../github-source-issue-close.js";
import { GitLabIssueCommentService } from "../gitlab-issue-comment.js";
import { GitLabTrackingCommentService } from "../gitlab-tracking-comments.js";
import { GitLabTrackingStateService } from "../gitlab-tracking-state.js";
import { GitLabSourceIssueCloseService } from "../gitlab-source-issue-close.js";
import { KnowledgeIndexRefreshService } from "../knowledge-index-refresh.js";
import { githubRateLimiter } from "../github-poll.js";
import * as projectStoreResolver from "../project-store-resolver.js";
import { buildFallbackPrMetadata, generatePrMetadata } from "../pr-metadata-generator.js";
import { resolvePrConflicts } from "../pr-conflict-resolver.js";
import {
  classifyWebhookEvent,
  getGitHubAppConfig,
  hasIssueBadgeFieldsChanged,
  hasPrBadgeFieldsChanged,
  verifyWebhookSignature,
} from "../github-webhooks.js";
import type { ApiRoutesContext } from "./types.js";
import { runGitCommand } from "./resolve-diff-base.js";
import { assertWorktreePathSafe, isPathWithin, listRegisteredWorktreePaths } from "../git-worktree-safety.js";

const execAsync = promisify(execCb);
const PR_ROUTE_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const PR_PREFLIGHT_TIMEOUT_MS = 15_000;
const PR_OPTIONS_TIMEOUT_MS = 10_000;
const PR_METADATA_ROUTE_TIMEOUT_MS = 25_000;
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
export const GITHUB_TRACKING_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;

function getCommandErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const anyError = error as Error & { stdout?: string; stderr?: string };
    return [anyError.stderr, anyError.stdout, anyError.message].filter(Boolean).join("\n").trim() || anyError.message;
  }
  return String(error);
}

function mapStructuredGhErrorToStatus(code: StructuredGhError["code"]): number {
  switch (code) {
    case "not-authenticated":
      return 401;
    case "permission":
      return 403;
    case "rate-limited":
      return 429;
    case "not-found":
      return 404;
    case "validation":
    case "merge-conflict":
      return 422;
    default:
      return 502;
  }
}

function toPrApiError(err: unknown, fallbackMessage: string): ApiError {
  const githubError = classifyGhError(err);
  return new ApiError(mapStructuredGhErrorToStatus(githubError.code), githubError.message || fallbackMessage, {
    githubError,
    ...(typeof githubError.retryAfterMs === "number" ? { retryAfterMs: githubError.retryAfterMs } : {}),
  });
}

export { runGitCommand };

/** Git remote info returned by the remotes endpoint */
export interface GitRemote {
  name: string;
  owner: string;
  repo: string;
  url: string;
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

export function parseGitHubBadgeUrl(url: string | undefined): { owner: string; repo: string } | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return null;
    const [owner, repo, resourceType] = parts;
    if ((resourceType !== "issues" && resourceType !== "pull") || !owner || !repo) {
      return null;
    }
    return { owner, repo };
  } catch {
    return null;
  }
}

export async function getGitHubRemotes(cwd?: string): Promise<GitRemote[]> {
  try {
    const output = await runGitCommand(["remote", "-v"], cwd, 5000);

    const remotes: GitRemote[] = [];
    const seen = new Set<string>();

    for (const line of output.split("\n")) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match) continue;

      const [, name, url] = match;
      const key = `${name}-${url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const parsed = parseGitHubUrl(url);
      if (parsed) {
        remotes.push({
          name,
          owner: parsed.owner,
          repo: parsed.repo,
          url,
        });
      }
    }

    return remotes;
  } catch {
    return [];
  }
}

const RECENT_ISSUES_CACHE_TTL_MS = 60_000;

// Intentionally module-scoped and TTL-only. We do not proactively invalidate on remote
// changes because the 60s window is short and keeps per-keystroke chat lookups cheap.
const recentIssuesCache = new Map<string, { fetchedAt: number; items: Array<{
  number: number;
  title: string;
  state: "open" | "closed";
  htmlUrl: string;
  repository: string;
  updatedAt?: string;
}> }>();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function ensureSafeGitRef(value: string, fieldName = "branch"): string {
  const trimmed = value.trim();
  if (!trimmed || !SAFE_GIT_REF_PATTERN.test(trimmed)) {
    throw badRequest(`Invalid ${fieldName}`);
  }
  return trimmed;
}

function getExecErrorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}

async function runPrShellCommand(command: string, cwd: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execAsync(command, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: PR_ROUTE_MAX_BUFFER_BYTES,
  });
  return stdout.trim();
}

async function tryRunPrShellCommand(command: string, cwd: string, timeoutMs: number): Promise<
  | { ok: true; stdout: string }
  | { ok: false; error: unknown; code?: number; stdout: string; stderr: string }
> {
  try {
    const stdout = await runPrShellCommand(command, cwd, timeoutMs);
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      error,
      code: getExecErrorCode(error),
      stdout: ((error as { stdout?: string } | undefined)?.stdout ?? "").trim(),
      stderr: ((error as { stderr?: string } | undefined)?.stderr ?? "").trim(),
    };
  }
}

export const prRouteCommandRunner = {
  run: runPrShellCommand,
  tryRun: tryRunPrShellCommand,
};

async function resolvePrBaseRef(repoRoot: string, baseBranch: string): Promise<string> {
  const safeBase = ensureSafeGitRef(baseBranch, "base branch");
  const localCheck = await prRouteCommandRunner.tryRun(
    `git rev-parse --verify ${shellQuote(safeBase)}`,
    repoRoot,
    PR_PREFLIGHT_TIMEOUT_MS,
  );
  if (localCheck.ok) {
    return safeBase;
  }

  await prRouteCommandRunner.tryRun(
    `git fetch origin ${shellQuote(safeBase)} --no-tags`,
    repoRoot,
    PR_PREFLIGHT_TIMEOUT_MS,
  );

  const remoteRef = `origin/${safeBase}`;
  const remoteCheck = await prRouteCommandRunner.tryRun(
    `git rev-parse --verify ${shellQuote(remoteRef)}`,
    repoRoot,
    PR_PREFLIGHT_TIMEOUT_MS,
  );
  return remoteCheck.ok ? remoteRef : safeBase;
}

async function resolveDefaultPrBaseBranch(task: Task, repoRoot: string): Promise<string> {
  const taskBaseBranch = task.prInfo?.baseBranch?.trim();
  if (taskBaseBranch) {
    return taskBaseBranch;
  }

  try {
    const stdout = await prRouteCommandRunner.run(
      "gh repo view --json defaultBranchRef -q .defaultBranchRef.name",
      repoRoot,
      PR_OPTIONS_TIMEOUT_MS,
    );
    if (stdout) {
      return stdout;
    }
  } catch {
    // fall through to main
  }

  return "main";
}

function parsePreflightCommits(output: string): Array<{ sha: string; subject: string; author: string }> {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = "", author = ""] = line.split("\t");
      return { sha, subject, author };
    })
    .filter((entry) => entry.sha && entry.subject)
    .slice(0, 50);
}

interface PrPreflightResponse {
  branchOnRemote: boolean;
  commitsPresent: boolean;
  conflictsWithBase: boolean;
  ghAuthOk: boolean;
  defaultBaseBranch: string;
  head: string;
  commits: Array<{ sha: string; subject: string; author: string }>;
  changedFiles: Array<{ path: string; additions: number; deletions: number; status: "added" | "modified" | "deleted" | "renamed" }>;
}

function parsePreflightChangedFiles(numstatOutput: string, nameStatusOutput: string): Array<{
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
}> {
  const numstatLines = numstatOutput.split(/\r?\n/).filter(Boolean);
  const nameStatusLines = nameStatusOutput.split(/\r?\n/).filter(Boolean);
  const results: Array<{ path: string; additions: number; deletions: number; status: "added" | "modified" | "deleted" | "renamed" }> = [];

  for (let index = 0; index < nameStatusLines.length && results.length < 200; index += 1) {
    const nameParts = nameStatusLines[index]?.split("\t").filter(Boolean) ?? [];
    if (nameParts.length === 0) {
      continue;
    }

    const statusToken = nameParts[0] ?? "M";
    const numstatParts = numstatLines[index]?.split("\t") ?? [];
    const additions = Number.parseInt(numstatParts[0] ?? "0", 10);
    const deletions = Number.parseInt(numstatParts[1] ?? "0", 10);
    const fallbackPath = numstatParts[2] ?? "";
    const path = statusToken.startsWith("R") ? (nameParts[2] ?? fallbackPath) : (nameParts[1] ?? fallbackPath);

    if (!path) {
      continue;
    }

    results.push({
      path,
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      status: statusToken === "A"
        ? "added"
        : statusToken === "D"
          ? "deleted"
          : statusToken.startsWith("R")
            ? "renamed"
            : "modified",
    });
  }

  return results;
}

async function computePrPreflight(task: Task, repoRoot: string, requestedBase?: string): Promise<PrPreflightResponse> {
  const defaultBaseBranch = requestedBase?.trim()
    ? ensureSafeGitRef(requestedBase, "base branch")
    : await resolveDefaultPrBaseBranch(task, repoRoot);
  const head = `fusion/${task.id.toLowerCase()}`;
  const safeHead = ensureSafeGitRef(head, "head branch");
  const response: PrPreflightResponse = {
    branchOnRemote: false,
    commitsPresent: false,
    conflictsWithBase: false,
    ghAuthOk: isGhAuthenticated(),
    defaultBaseBranch,
    head,
    commits: [],
    changedFiles: [],
  };

  const baseRef = await resolvePrBaseRef(repoRoot, defaultBaseBranch).catch(() => defaultBaseBranch);

  const remoteBranchCheck = await prRouteCommandRunner.tryRun(
    `git ls-remote --exit-code --heads origin ${shellQuote(safeHead)}`,
    repoRoot,
    PR_PREFLIGHT_TIMEOUT_MS,
  );
  if (remoteBranchCheck.ok) {
    response.branchOnRemote = true;
  } else if (remoteBranchCheck.code !== 2) {
    response.branchOnRemote = false;
  }

  const commitCountOutput = await prRouteCommandRunner.run(
    `git rev-list --count ${shellQuote(baseRef)}..${shellQuote(safeHead)}`,
    repoRoot,
    PR_PREFLIGHT_TIMEOUT_MS,
  ).catch(() => "0");
  response.commitsPresent = Number.parseInt(commitCountOutput, 10) > 0;

  const mergeTreeResult = await prRouteCommandRunner.tryRun(
    `git merge-tree --write-tree --name-only ${shellQuote(baseRef)} ${shellQuote(safeHead)}`,
    repoRoot,
    PR_PREFLIGHT_TIMEOUT_MS,
  );
  // `git merge-tree --write-tree` exits 0 for clean merges and 1 for real conflicts;
  // stdout can be non-empty in both cases, so conflict state must come from the exit code.
  response.conflictsWithBase = !mergeTreeResult.ok && mergeTreeResult.code === 1;

  const [commitLogOutput, numstatOutput, nameStatusOutput] = await Promise.all([
    prRouteCommandRunner.run(
      `git log --no-merges ${shellQuote(baseRef)}..${shellQuote(safeHead)} --format=%H%x09%s%x09%an`,
      repoRoot,
      PR_PREFLIGHT_TIMEOUT_MS,
    ).catch(() => ""),
    prRouteCommandRunner.run(
      `git diff --numstat ${shellQuote(baseRef)}..${shellQuote(safeHead)}`,
      repoRoot,
      PR_PREFLIGHT_TIMEOUT_MS,
    ).catch(() => ""),
    prRouteCommandRunner.run(
      `git diff --name-status ${shellQuote(baseRef)}..${shellQuote(safeHead)}`,
      repoRoot,
      PR_PREFLIGHT_TIMEOUT_MS,
    ).catch(() => ""),
  ]);

  response.commits = parsePreflightCommits(commitLogOutput);
  response.changedFiles = parsePreflightChangedFiles(numstatOutput, nameStatusOutput);
  return response;
}

function parseGhJsonLines<T>(output: string): T[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

export async function isGitRepo(cwd?: string): Promise<boolean> {
  try {
    await runGitCommand(["rev-parse", "--git-dir"], cwd, 5000);
    return true;
  } catch {
    return false;
  }
}

export async function getGitStatus(cwd?: string): Promise<{
  branch: string;
  commit: string;
  isDirty: boolean;
  ahead: number;
  behind: number;
} | null> {
  try {
    const branchOutput = await runGitCommand(["branch", "--show-current"], cwd, 5000);
    const branch = branchOutput.trim() || "HEAD detached";

    const commit = (await runGitCommand(["rev-parse", "--short", "HEAD"], cwd, 5000)).trim();

    const statusOutput = (await runGitCommand(["status", "--porcelain"], cwd, 5000)).trim();
    const isDirty = statusOutput.length > 0;

    let ahead = 0;
    let behind = 0;
    try {
      const revListOutput = (await runGitCommand(["rev-list", "--left-right", "--count", "HEAD...@{u}"], cwd, 5000)).trim();
      const match = revListOutput.match(/(\d+)\s+(\d+)/);
      if (match) {
        ahead = parseInt(match[1], 10);
        behind = parseInt(match[2], 10);
      }
    } catch {
      // ignore
    }

    return { branch, commit, isDirty, ahead, behind };
  } catch {
    return null;
  }
}

export interface ExtendedGitStatus {
  headSha?: string;
  integrationBranch?: string;
  integrationBranchSource?: "settings" | "origin-head" | "fallback";
  isOnIntegrationBranch?: boolean;
  /** True when `git branch --show-current` failed (timeout, permission, etc.)
   *  — distinct from the legitimate detached-HEAD case where the command
   *  succeeds with empty stdout. UI should surface "branch detection
   *  unavailable" rather than silently hiding the wrong-branch warning. */
  currentBranchDetectionFailed?: boolean;
  integrationTipSha?: string | null;
  /** Where `integrationTipSha` was resolved from. `"local"` = the branch
   *  exists locally; `"remote-only"` = the branch only exists as
   *  `refs/remotes/origin/<branch>` and was used as a fallback; `"missing"` =
   *  neither ref exists, so the integration tip is null. */
  integrationTipSource?: "local" | "remote-only" | "missing";
  originIntegrationTipSha?: string | null;
  /** HEAD vs the **local** integration tip. Undefined when the branch
   *  exists only as a remote-tracking ref. */
  aheadOfIntegration?: number;
  behindIntegration?: number;
  /** HEAD vs `origin/<integrationBranch>`. Defined whenever the remote
   *  tracking ref exists, regardless of whether the local ref does. Useful
   *  in remote-only mode (and as an unambiguous comparison in any mode). */
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

async function resolveIntegrationBranchForStatus(
  cwd: string,
  settings: { integrationBranch?: unknown; baseBranch?: unknown } | null | undefined,
): Promise<{ branch: string; source: "settings" | "origin-head" | "fallback" }> {
  const explicit = typeof settings?.integrationBranch === "string" ? settings.integrationBranch.trim() : "";
  if (explicit.length > 0) return { branch: explicit, source: "settings" };
  const legacyBase = typeof settings?.baseBranch === "string" ? (settings.baseBranch as string).trim() : "";
  if (legacyBase.length > 0) return { branch: legacyBase, source: "settings" };
  try {
    const ref = (await runGitCommand(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd, 5_000)).trim();
    const m = /^refs\/remotes\/origin\/(.+)$/.exec(ref);
    if (m) return { branch: m[1], source: "origin-head" };
  } catch {
    // fall through
  }
  return { branch: "main", source: "fallback" };
}

async function revParse(cwd: string, ref: string): Promise<string | null> {
  try {
    const out = (await runGitCommand(["rev-parse", "--verify", ref], cwd, 5_000)).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

async function aheadBehind(cwd: string, leftRef: string, rightRef: string): Promise<{ ahead: number; behind: number } | null> {
  try {
    const out = (await runGitCommand(["rev-list", "--left-right", "--count", `${leftRef}...${rightRef}`], cwd, 5_000)).trim();
    const m = out.match(/(\d+)\s+(\d+)/);
    if (!m) return null;
    return { ahead: parseInt(m[1], 10), behind: parseInt(m[2], 10) };
  } catch {
    return null;
  }
}

async function computeDirtyDetails(cwd: string): Promise<ExtendedGitStatus["dirtyDetails"]> {
  try {
    const out = await runGitCommand(["-c", "core.quotePath=false", "status", "--porcelain=v1", "--untracked-files=all"], cwd, 10_000);
    let staged = 0, modified = 0, untracked = 0, conflicted = 0;
    const sample: string[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      const path = line.slice(3);
      if (sample.length < 12) sample.push(`${x}${y} ${path}`);
      if (x === "?" && y === "?") { untracked += 1; continue; }
      if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) { conflicted += 1; continue; }
      if (x !== " " && x !== "?") staged += 1;
      if (y !== " " && y !== "?") modified += 1;
    }
    return { staged, modified, untracked, conflicted, sample };
  } catch {
    return { staged: 0, modified: 0, untracked: 0, conflicted: 0, sample: [] };
  }
}

async function isIndexStale(
  cwd: string,
  integrationBranch: string,
  isOnIntegrationBranch: boolean | undefined,
): Promise<boolean | undefined> {
  // The FN-INDEX-DESYNC scenario: the merger advanced refs/heads/<integration>
  // locally so HEAD points at the new tip, but the index still reflects an
  // *earlier* tip. Detect by walking `refs/heads/<integration>` reflog and
  // checking whether the index exactly matches any of the recent prior tips
  // (with HEAD descending from that prior tip). Walking the reflog (not just
  // `@{1}`) catches multi-hop misses: if the merger advanced A→B→C without
  // the rootDir worktree being synced in between, the index still holds A's
  // tree while `@{1}` is now B; comparing only against B would miss this.
  //
  // Only fires when the worktree is actually on the integration branch.
  // A feature-branch worktree whose HEAD happens to equal `<integration>@{1}`
  // (e.g. user just `git switch -c hotfix main@{N}`) is a perfectly healthy
  // state, not a stale-index situation.
  if (isOnIntegrationBranch !== true) return false;
  try {
    const headSha = await revParse(cwd, "HEAD");
    if (!headSha) return false;
    // Walk up to 16 reflog entries. The merger's typical burst is a handful
    // of advances; 16 is a comfortable ceiling that still bounds the work.
    const REFLOG_DEPTH = 16;
    for (let i = 1; i <= REFLOG_DEPTH; i++) {
      const prevTip = await revParse(cwd, `refs/heads/${integrationBranch}@{${i}}`);
      if (!prevTip) return false; // reflog exhausted (or pruned)
      if (prevTip === headSha) continue; // not actually a prior state
      // HEAD must descend from this prior tip — otherwise the operator
      // rolled back the branch and the "stale" framing doesn't apply.
      let isDescendant = false;
      try {
        await runGitCommand(["merge-base", "--is-ancestor", prevTip, "HEAD"], cwd, 5_000);
        isDescendant = true;
      } catch {
        isDescendant = false;
      }
      if (!isDescendant) continue;
      const diffOut = (await runGitCommand(["diff-index", "--cached", "--name-only", prevTip], cwd, 5_000)).trim();
      if (diffOut.length === 0) return true; // index exactly matches this prior tip → stale
    }
    return false;
  } catch {
    return undefined;
  }
}

async function computeStashCount(cwd: string): Promise<number | undefined> {
  try {
    const out = (await runGitCommand(["stash", "list", "--format=%H"], cwd, 5_000)).trim();
    if (out.length === 0) return 0;
    return out.split("\n").filter((l) => l.length > 0).length;
  } catch {
    return undefined;
  }
}

/** Canonicalize a filesystem path for cross-process equality checks. The
 *  merger emits audit events with `worktreePath` run through `realpath` (via
 *  `canonicalizePath` in worktree-pool.ts); the route is called with the
 *  store's raw `rootDir`. On macOS the two routinely differ through
 *  `/private` symlinks. Resolving both ends through `realpathSync` (with a
 *  graceful fallback if the path no longer exists) gives a stable key. */
function canonicalForCompare(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

async function getPatchFingerprint(cwd: string, sha: string): Promise<string | null> {
  try {
    const out = await runGitCommand(["show", sha, "--pretty=format:", "--patch", "--no-color"], cwd, 5_000);
    const normalized = out
      .split("\n")
      .filter((line) => !line.startsWith("index ") && !line.startsWith("@@ "))
      .join("\n")
      .trim();
    return normalized || null;
  } catch {
    return null;
  }
}

export async function collectRecentMergeAdvances(
  scopedStore: TaskStore & {
    getRunAuditEventsAsync: (filters: {
      taskId?: string;
      domain?: "database" | "git" | "filesystem" | "sandbox";
      mutationType?: string;
      limit?: number;
    }) => Promise<RunAuditEvent[]>;
  },
  worktreePath: string,
  headSha: string | undefined,
  localIntegrationTipSha: string | undefined,
): Promise<ExtendedGitStatus["recentMergeAdvances"]> {
  const advances = await scopedStore.getRunAuditEventsAsync({
    domain: "git",
    mutationType: "merge:integration-ref-advance",
    limit: 10,
  });
  const wantPath = canonicalForCompare(worktreePath);
  const autoSyncByAdvance = new Map<string, string>();
  const autoSyncByTaskFallback = new Map<string, string>();
  const pairKey = (tid: string, toSha: string) => `${tid}:${toSha}`;
  for (const ev of await scopedStore.getRunAuditEventsAsync({
    domain: "git",
    mutationType: "merge:auto-sync",
    limit: 200,
  })) {
    const md = ev.metadata as { worktreePath?: unknown; outcome?: unknown; taskId?: unknown; newSha?: unknown } | undefined;
    if (!md || typeof md !== "object") continue;
    if (typeof md.outcome !== "string") continue;
    const tid = typeof md.taskId === "string" ? md.taskId : (typeof ev.taskId === "string" ? ev.taskId : "");
    if (!tid) continue;
    const hasPath = typeof md.worktreePath === "string";
    const hasNewSha = typeof md.newSha === "string";
    if (hasPath && hasNewSha) {
      if (canonicalForCompare(md.worktreePath as string) !== wantPath) continue;
      const key = pairKey(tid, md.newSha as string);
      if (!autoSyncByAdvance.has(key)) autoSyncByAdvance.set(key, md.outcome);
    } else if (!hasPath && !hasNewSha) {
      if (!autoSyncByTaskFallback.has(tid)) autoSyncByTaskFallback.set(tid, md.outcome);
    }
  }
  const successOutcomes = new Set(["clean-sync", "synced-with-edits-restored"]);
  const out: NonNullable<ExtendedGitStatus["recentMergeAdvances"]> = [];
  const headPatchIds = new Set<string>();
  let headPatchIdsLoaded = false;
  for (const ev of advances) {
    const md = ev.metadata as { fromSha?: unknown; toSha?: unknown; succeeded?: unknown } | undefined;
    if (!md || typeof md !== "object") continue;
    if (typeof md.toSha !== "string") continue;
    if (md.succeeded === false) continue;
    const tid = typeof ev.taskId === "string" ? ev.taskId : "";
    if (!tid) continue;
    const autoSyncOutcome = autoSyncByAdvance.get(pairKey(tid, md.toSha)) ?? autoSyncByTaskFallback.get(tid);

    let resolution: "reachable" | "orphaned" | "subsumed" | "superseded" | "pending" = "pending";
    let toShaExists = true;
    if (headSha && headSha === md.toSha) {
      resolution = "reachable";
    } else if (headSha) {
      try {
        await runGitCommand(["cat-file", "-e", `${md.toSha}^{commit}`], worktreePath, 5_000);
      } catch {
        toShaExists = false;
        resolution = "orphaned";
      }

      if (toShaExists && resolution === "pending") {
        try {
          await runGitCommand(["merge-base", "--is-ancestor", md.toSha, headSha], worktreePath, 5_000);
          resolution = "reachable";
        } catch {
          // continue
        }
      }

      if (toShaExists && resolution === "pending") {
        const targetPatchId = await getPatchFingerprint(worktreePath, md.toSha);
        if (targetPatchId) {
          if (!headPatchIdsLoaded) {
            headPatchIdsLoaded = true;
            try {
              const commitsOut = (await runGitCommand(["log", "-n", "50", "--pretty=%H", headSha], worktreePath, 5_000)).trim();
              const commits = commitsOut ? commitsOut.split("\n").filter(Boolean) : [];
              for (const commitSha of commits) {
                const patchId = await getPatchFingerprint(worktreePath, commitSha);
                if (patchId) headPatchIds.add(patchId);
              }
            } catch {
              // degrade conservatively
            }
          }
          if (headPatchIds.has(targetPatchId)) {
            resolution = "subsumed";
          }
        }
      }

      // When HEAD is already aligned with the local integration tip, resetting
      // to that tip cannot make an unreachable advance SHA become reachable.
      // Treat this as handled (superseded by rewrite), not actionable pending.
      if (toShaExists && resolution === "pending" && localIntegrationTipSha && headSha === localIntegrationTipSha) {
        resolution = "superseded";
      }
    }

    const needsAction = resolution === "pending"
      && (autoSyncOutcome === undefined || !successOutcomes.has(autoSyncOutcome));

    out.push({
      taskId: tid,
      fromSha: typeof md.fromSha === "string" ? md.fromSha : null,
      toSha: md.toSha,
      advancedAt: ev.timestamp,
      autoSyncOutcome,
      needsAction,
      resolution,
    });
    if (out.length >= 5) break;
  }
  return out;
}

export async function computeExtendedGitStatus(rootDir: string, scopedStore: TaskStore): Promise<ExtendedGitStatus> {
  const settings = await scopedStore.getSettings().catch(() => null);
  const { branch: integrationBranch, source: integrationBranchSource } = await resolveIntegrationBranchForStatus(
    rootDir,
    settings as { integrationBranch?: unknown; baseBranch?: unknown } | null,
  );
  // Distinguish three states:
  //   - command succeeded with branch name → "on <name>"
  //   - command succeeded with empty stdout → detached HEAD (legitimate)
  //   - command threw → unknown (transient git failure, .git/index.lock
  //     contention, etc.)
  // The middle two collapse to `isOnIntegrationBranch: undefined` so the
  // UI suppresses the misleading "(not on <branch>)" sub-text in BOTH
  // cases. We tag the failure case separately so the UI can surface a
  // "branch detection unavailable" hint rather than silently rendering
  // nothing — masking a genuine wrong-branch state because of a
  // transient git error would mislead the operator just as much as the
  // detached-HEAD case the comment originally claimed to fix.
  let currentBranch: string | null = null;
  let currentBranchDetectionFailed = false;
  try {
    currentBranch = (await runGitCommand(["branch", "--show-current"], rootDir, 5_000)).trim();
  } catch {
    currentBranchDetectionFailed = true;
  }
  const isOnIntegrationBranch =
    currentBranchDetectionFailed || currentBranch === null || currentBranch.length === 0
      ? undefined
      : currentBranch === integrationBranch;
  const headSha = (await revParse(rootDir, "HEAD")) ?? undefined;
  // Prefer the local head; fall back to the remote-tracking ref so projects
  // whose `integrationBranch` setting names a branch that exists only on
  // origin (e.g. `release/v2` the operator has never `git switch`-ed
  // locally) still get a meaningful tip + ahead/behind comparison instead of
  // a silently-empty integration card.
  const localIntegrationTip = await revParse(rootDir, `refs/heads/${integrationBranch}`);
  const originIntegrationTipSha = await revParse(rootDir, `refs/remotes/origin/${integrationBranch}`);
  const integrationTipSha = localIntegrationTip ?? originIntegrationTipSha ?? null;
  const integrationTipSource: ExtendedGitStatus["integrationTipSource"] =
    localIntegrationTip ? "local" : originIntegrationTipSha ? "remote-only" : "missing";

  // `aheadOfIntegration` / `behindIntegration` is HEAD vs the **local**
  // integration tip — undefined when the branch exists only as a
  // remote-tracking ref. `aheadOfIntegrationRemote` / `behindIntegrationRemote`
  // is HEAD vs `origin/<branch>` — defined whenever the remote tracking ref
  // exists, regardless of local. Keeping the two distances under distinct
  // names removes the silent semantics shift the prior single-field flavor
  // produced in remote-only mode.
  let aheadOfIntegration: number | undefined;
  let behindIntegration: number | undefined;
  if (localIntegrationTip && headSha) {
    const ab = await aheadBehind(rootDir, "HEAD", localIntegrationTip);
    if (ab) { aheadOfIntegration = ab.ahead; behindIntegration = ab.behind; }
  }
  let aheadOfIntegrationRemote: number | undefined;
  let behindIntegrationRemote: number | undefined;
  if (originIntegrationTipSha && headSha) {
    const ab = await aheadBehind(rootDir, "HEAD", originIntegrationTipSha);
    if (ab) { aheadOfIntegrationRemote = ab.ahead; behindIntegrationRemote = ab.behind; }
  }
  let aheadOfOriginIntegration: number | undefined;
  let behindOriginIntegration: number | undefined;
  if (originIntegrationTipSha && localIntegrationTip) {
    const ab = await aheadBehind(rootDir, localIntegrationTip, originIntegrationTipSha);
    if (ab) { aheadOfOriginIntegration = ab.ahead; behindOriginIntegration = ab.behind; }
  }

  const [dirtyDetails, indexStaleVsHead, stashCount, recentMergeAdvances] = await Promise.all([
    computeDirtyDetails(rootDir),
    isIndexStale(rootDir, integrationBranch, isOnIntegrationBranch),
    computeStashCount(rootDir),
    collectRecentMergeAdvances(
      scopedStore as TaskStore & {
        getRunAuditEvents?: (filters: { taskId?: string; domain?: "database" | "git" | "filesystem" | "sandbox"; mutationType?: string; limit?: number }) => RunAuditEvent[];
      },
      rootDir,
      headSha,
      localIntegrationTip ?? undefined,
    ),
  ]);

  return {
    headSha,
    integrationBranch,
    integrationBranchSource,
    isOnIntegrationBranch,
    currentBranchDetectionFailed: currentBranchDetectionFailed || undefined,
    integrationTipSha,
    integrationTipSource,
    originIntegrationTipSha,
    aheadOfIntegrationRemote,
    behindIntegrationRemote,
    aheadOfIntegration,
    behindIntegration,
    aheadOfOriginIntegration,
    behindOriginIntegration,
    dirtyDetails,
    indexStaleVsHead,
    stashCount,
    recentMergeAdvances,
  };
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  body?: string;
  author: string;
  date: string;
  parents: string[];
}

function parseGitCommitsFromLogOutput(output: string): GitCommit[] {
  const commits: GitCommit[] = [];

  for (const record of output.split("\0")) {
    if (!record) continue;

    const parts = record.split("\x1f");
    if (parts.length < 7) continue;

    const [hash, shortHash, message, fullMessage, author, date, parentsStr] = parts;
    const trimmedFullMessage = fullMessage.trimEnd();
    const subjectLine = message || "";
    let body = trimmedFullMessage;

    if (subjectLine && body.startsWith(subjectLine)) {
      body = body.slice(subjectLine.length);
      body = body.replace(/^\n+/, "");
    }

    body = body.trim();
    const parents = parentsStr ? parentsStr.split(" ").filter(Boolean) : [];

    commits.push({
      hash,
      shortHash,
      message: subjectLine,
      body: body || undefined,
      author: author || "",
      date: date || "",
      parents,
    });
  }

  return commits;
}

export async function getGitCommits(limit = 20, cwd?: string): Promise<GitCommit[]> {
  try {
    const format = "%H%x1f%h%x1f%s%x1f%B%x1f%an%x1f%aI%x1f%P";
    const output = await runGitCommand(["log", "-z", `--max-count=${limit}`, `--pretty=format:${format}`], cwd, 10000);
    return parseGitCommitsFromLogOutput(output);
  } catch {
    return [];
  }
}

export function isValidGitRef(ref: string): boolean {
  if (!ref || ref.length === 0) return false;
  if (ref.startsWith("-")) return false;
  if (/[;<>&|`$(){}[\]\r\n]/.test(ref)) return false;
  if (/\s/.test(ref)) return false;
  if (!/^[a-zA-Z0-9/_.@-]+$/.test(ref)) return false;
  if (ref.includes("..")) return false;
  if (ref.includes("~")) return false;
  if (ref.includes("^")) return false;
  if (ref.includes(":")) return false;
  if (ref.startsWith("--")) return false;
  return true;
}

export async function getGitCommitsForBranch(branch: string, limit = 10, cwd?: string): Promise<GitCommit[]> {
  try {
    const format = "%H%x1f%h%x1f%s%x1f%B%x1f%an%x1f%aI%x1f%P";
    const output = await runGitCommand(["log", "-z", `--max-count=${limit}`, `--pretty=format:${format}`, branch], cwd, 10000);
    return parseGitCommitsFromLogOutput(output);
  } catch {
    return [];
  }
}

export async function getAheadCommits(cwd?: string): Promise<GitCommit[]> {
  try {
    try {
      await runGitCommand(["rev-parse", "--abbrev-ref", "@{u}"], cwd, 10000);
    } catch {
      return [];
    }

    const format = "%H%x1f%h%x1f%s%x1f%B%x1f%an%x1f%aI%x1f%P";
    const output = await runGitCommand(["log", "-z", "@{u}..HEAD", `--pretty=format:${format}`], cwd, 10000);
    return parseGitCommitsFromLogOutput(output);
  } catch {
    return [];
  }
}

export async function getRemoteCommits(remoteRef: string, limit = 10, cwd?: string): Promise<GitCommit[]> {
  try {
    if (!isValidGitRef(remoteRef)) {
      throw new Error("Invalid remote ref");
    }

    try {
      await runGitCommand(["rev-parse", "--verify", remoteRef], cwd, 5000);
    } catch {
      return [];
    }

    const format = "%H%x1f%h%x1f%s%x1f%B%x1f%an%x1f%aI%x1f%P";
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const output = await runGitCommand(["log", "-z", `--max-count=${safeLimit}`, `--pretty=format:${format}`, remoteRef], cwd, 10000);
    return parseGitCommitsFromLogOutput(output);
  } catch {
    return [];
  }
}

export async function getCommitDiff(hash: string, cwd?: string): Promise<{ stat: string; patch: string } | null> {
  try {
    await runGitCommand(["cat-file", "-t", hash], cwd, 5000);
    const stat = (await runGitCommand(["show", "--stat", "--format=", hash], cwd, 10000)).trim();
    const patch = await runGitCommand(["show", "--format=", hash], cwd, 10000);
    return { stat, patch };
  } catch {
    return null;
  }
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  remote?: string;
  lastCommitDate?: string;
}

export async function getGitBranches(cwd?: string): Promise<GitBranch[]> {
  try {
    let currentBranch = "";
    try {
      currentBranch = (await runGitCommand(["branch", "--show-current"], cwd, 5000)).trim();
    } catch {
      // ignore
    }

    const format = "%(refname:short)|%(upstream:short)|%(committerdate:iso8601)|%(HEAD)";
    const output = (await runGitCommand(["for-each-ref", `--format=${format}`, "refs/heads/"], cwd, 10000)).trim();

    const branches: GitBranch[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 4) continue;

      const [name, remote, lastCommitDate, headMarker] = parts;
      const isCurrent = headMarker === "*" || name === currentBranch;

      branches.push({
        name,
        isCurrent,
        remote: remote || undefined,
        lastCommitDate: lastCommitDate || undefined,
      });
    }

    return branches;
  } catch {
    return [];
  }
}

/*
FNXC:MergePush 2026-07-11-22:40:
The Merge settings push-target dropdown needs the branches that exist ON a given remote.
Read local remote-tracking refs (refs/remotes/<name>/) instead of `git ls-remote` so the
listing is instant and offline-safe; a branch created remotely since the last fetch is
covered by the dropdown's Custom… escape hatch.
*/
export async function getGitRemoteBranches(remoteName: string, cwd?: string): Promise<string[]> {
  try {
    const output = (await runGitCommand(
      ["for-each-ref", "--format=%(refname:short)", `refs/remotes/${remoteName}/`],
      cwd,
      10000,
    )).trim();
    const prefix = `${remoteName}/`;
    const branches: string[] = [];
    for (const line of output.split("\n")) {
      const short = line.trim();
      if (!short.startsWith(prefix)) continue;
      const branch = short.slice(prefix.length);
      // `<remote>/HEAD` is a symbolic pointer, not a pushable branch.
      if (!branch || branch === "HEAD") continue;
      branches.push(branch);
    }
    return branches;
  } catch {
    return [];
  }
}

export interface GitWorktree {
  path: string;
  branch?: string;
  isMain: boolean;
  isBare: boolean;
  taskId?: string;
}

export async function getGitWorktrees(tasks: { id: string; worktree?: string }[] = [], cwd?: string): Promise<GitWorktree[]> {
  try {
    const output = await runGitCommand(["worktree", "list", "--porcelain"], cwd, 10000);

    const worktrees: GitWorktree[] = [];
    let currentWorktree: Partial<GitWorktree> = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (currentWorktree.path) {
          const task = tasks.find((t) => t.worktree && currentWorktree.path === t.worktree);
          worktrees.push({
            path: currentWorktree.path,
            branch: currentWorktree.branch,
            isMain: currentWorktree.isMain || false,
            isBare: currentWorktree.isBare || false,
            taskId: task?.id,
          });
        }
        currentWorktree = { path: line.slice(9).trim() };
      } else if (line.startsWith("branch ")) {
        currentWorktree.branch = line.slice(8).trim().replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        currentWorktree.isBare = true;
      } else if (line === "main") {
        currentWorktree.isMain = true;
      } else if (line === "" && currentWorktree.path) {
        const task = tasks.find((t) => t.worktree && currentWorktree.path === t.worktree);
        worktrees.push({
          path: currentWorktree.path,
          branch: currentWorktree.branch,
          isMain: currentWorktree.isMain || false,
          isBare: currentWorktree.isBare || false,
          taskId: task?.id,
        });
        currentWorktree = {};
      }
    }

    if (currentWorktree.path) {
      const task = tasks.find((t) => t.worktree && currentWorktree.path === t.worktree);
      worktrees.push({
        path: currentWorktree.path,
        branch: currentWorktree.branch,
        isMain: currentWorktree.isMain || false,
        isBare: currentWorktree.isBare || false,
        taskId: task?.id,
      });
    }

    return worktrees;
  } catch {
    return [];
  }
}

export function isValidBranchName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.startsWith("-")) return false;
  if (/[;<>&|`$(){}[\]\r\n]/.test(name)) return false;
  if (/\s/.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.includes("~")) return false;
  if (name.includes("^")) return false;
  if (name.includes(":")) return false;
  const reserved = ["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD"];
  if (reserved.includes(name)) return false;
  return true;
}

export async function createGitBranch(name: string, base?: string, cwd?: string): Promise<string> {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid branch name");
  }
  if (base && !isValidBranchName(base)) {
    throw new Error("Invalid base branch name");
  }
  const args = base ? ["checkout", "-b", name, base] : ["checkout", "-b", name];
  await runGitCommand(args, cwd, 10000);
  return name;
}

export async function checkoutGitBranch(name: string, cwd?: string): Promise<void> {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid branch name");
  }
  try {
    await runGitCommand(["diff-index", "--quiet", "HEAD", "--"], cwd, 5000);
  } catch {
    const diff = (await runGitCommand(["diff", "--name-only"], cwd, 5000)).trim();
    if (diff) {
      throw new Error("Uncommitted changes would be lost. Commit or stash changes first.");
    }
  }
  await runGitCommand(["checkout", name], cwd, 10000);
}

export async function deleteGitBranch(name: string, force = false, cwd?: string): Promise<void> {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid branch name");
  }
  const flag = force ? "-D" : "-d";
  await runGitCommand(["branch", flag, name], cwd, 10000);
}

export interface GitFetchResult {
  fetched: boolean;
  message: string;
}

export async function fetchGitRemote(remote = "origin", cwd?: string): Promise<GitFetchResult> {
  if (!isValidBranchName(remote)) {
    throw new Error("Invalid remote name");
  }
  try {
    const output = await runGitCommand(["fetch", remote], cwd, 30000);
    return { fetched: true, message: output.trim() || "Fetch completed" };
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("Could not resolve host") || message.includes("Connection refused")) {
      throw new Error("Failed to connect to remote");
    }
    return { fetched: false, message: message || "No updates" };
  }
}

export interface GitPullResult {
  success: boolean;
  message: string;
  conflict?: boolean;
  autostashed?: boolean;
  stashReapplied?: boolean;
  stashConflict?: boolean;
}

interface PullAutostashHandle {
  sha: string;
  label: string;
}

function isGitConflictMessage(message: string): boolean {
  return message.includes("CONFLICT") || message.includes("Merge conflict") || message.includes("could not apply");
}

async function hasLocalChangesForPull(cwd?: string): Promise<boolean> {
  const output = await runGitCommand(["status", "--porcelain=v1", "--untracked-files=all"], cwd, 10_000);
  return output.trim().length > 0;
}

async function findStashRefBySha(sha: string, cwd?: string): Promise<string | null> {
  const output = await runGitCommand(["stash", "list", '--format=%H|%gd'], cwd, 5_000);
  for (const line of output.split("\n")) {
    const [entrySha, ref] = line.trim().split("|");
    if (entrySha === sha && ref) {
      return ref;
    }
  }
  return null;
}

async function dropStashBySha(sha: string, cwd?: string): Promise<void> {
  const ref = await findStashRefBySha(sha, cwd);
  if (!ref) return;
  await runGitCommand(["stash", "drop", ref], cwd, 10_000);
}

type DashboardGitMutationType = "stash:push" | "stash:pop" | "pull:fast-forward" | "stash:pop-conflict";

function assertRelativeFileSafe(worktreePath: string, file: string): string {
  if (typeof file !== "string" || file.trim().length === 0) {
    throw badRequest("file is required");
  }
  if (file.split("/").includes("..") || file.split("\\").includes("..")) {
    throw badRequest("file outside worktree");
  }
  const normalized = resolve(worktreePath, file);
  if (!isPathWithin(worktreePath, normalized)) {
    throw badRequest("file outside worktree");
  }
  return file;
}

function buildDashboardGitAuditEvent(input: {
  taskId?: string;
  mutationType: DashboardGitMutationType;
  target: string;
  metadata?: Record<string, unknown>;
}): RunAuditEventInput {
  return {
    taskId: input.taskId,
    agentId: "dashboard-api",
    runId: `dashboard-git-${Date.now()}`,
    domain: "git",
    mutationType: input.mutationType,
    target: input.target,
    metadata: input.metadata,
  };
}

async function createPullAutostash(cwd?: string): Promise<PullAutostashHandle | null> {
  if (!(await hasLocalChangesForPull(cwd))) {
    return null;
  }
  const label = `fusion-dashboard-pull-autostash:${Date.now()}`;
  const output = await runGitCommand(["stash", "push", "-u", "-m", label], cwd, 15_000);
  if (output.includes("No local changes to save")) {
    return null;
  }
  const sha = (await runGitCommand(["rev-parse", "stash@{0}"], cwd, 5_000)).trim();
  if (!sha) {
    throw new Error("Pull autostash failed: could not resolve created stash");
  }
  return { sha, label };
}

async function reapplyPullAutostash(
  handle: PullAutostashHandle,
  cwd?: string,
): Promise<{ applied: boolean; conflict: boolean; message?: string }> {
  try {
    await runGitCommand(["stash", "apply", handle.sha], cwd, 20_000);
  } catch (err: unknown) {
    const message = getCommandErrorMessage(err);
    if (isGitConflictMessage(message) || message.includes("Command failed: git stash apply")) {
      return {
        applied: false,
        conflict: true,
        message:
          `Pulled latest changes, but reapplying your local edits conflicted. ` +
          `Your work was preserved in stash ${handle.sha.slice(0, 7)} (${handle.label}). ` +
          `Resolve the conflicts in the working tree or reapply later from the Stashes view.`,
      };
    }
    throw err;
  }

  await dropStashBySha(handle.sha, cwd).catch(() => undefined);
  return { applied: true, conflict: false };
}

export interface PullGitBranchOptions {
  rebase?: boolean;
  integration?: {
    worktreePath: string;
    integrationBranch: string;
    taskId?: string;
    integrationRemote?: string;
    store: TaskStore;
    settings: Settings;
    runId: string;
    /**
     * When true, skip the `tryFastForwardFromOrigin` step entirely. Use this
     * for "the merger advanced local `refs/heads/<branch>` and my worktree is
     * stale relative to it" recovery — there's no need to fetch or merge from
     * origin, just hard-reset the worktree to the local ref. Avoids silently
     * pulling in unrelated remote work the operator didn't ask for.
     */
    skipOriginFetch?: boolean;
  };
}

export type IntegrationPullResult =
  | { kind: "pull-clean"; message: string; fromSha: string; toSha: string }
  | { kind: "pull-restored"; message: string; fromSha: string; toSha: string; autostash: { status: "restored" | "ai-resolved" } }
  | { kind: "stash-conflict"; message: string; fromSha: string; toSha: string; stashSha: string; stashLabel: string; conflictedFiles: string[]; autostashOutcome: "conflict-needs-manual" | "failed" };

function emitDashboardGitAuditEvent(
  store: TaskStore,
  input: {
    taskId?: string;
    runId: string;
    mutationType: DashboardGitMutationType;
    target: string;
    metadata?: Record<string, unknown>;
  },
): void {
  Promise.resolve(store.recordRunAuditEvent?.({
    taskId: input.taskId,
    agentId: "dashboard-api",
    runId: input.runId,
    domain: "git",
    mutationType: input.mutationType,
    target: input.target,
    metadata: input.metadata,
  })).catch(() => undefined);
}

export async function pullGitBranch(cwd?: string, options?: PullGitBranchOptions): Promise<GitPullResult | IntegrationPullResult> {
  const integration = options?.integration;
  if (integration) {
    const taskId = integration.taskId ?? "dashboard-pull";
    const rootDir = integration.worktreePath;
    if (!(await isGitRepo(rootDir))) {
      throw badRequest("Not a git repository");
    }

    const currentBranch = (await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], rootDir, 5_000)).trim();
    if (currentBranch !== integration.integrationBranch) {
      throw new ApiError(409, "Worktree is not on integration branch", { reason: "branch-mismatch", currentBranch });
    }

    const fromSha = (await runGitCommand(["rev-parse", "HEAD"], rootDir, 5_000)).trim();
    const stashHandle = await stashUnrelatedRootDirChanges(rootDir, taskId);
    if (stashHandle) {
      emitDashboardGitAuditEvent(integration.store, {
        taskId: integration.taskId,
        runId: integration.runId,
        mutationType: "stash:push",
        target: rootDir,
        metadata: {
          taskId: integration.taskId,
          worktreePath: rootDir,
          stashSha: stashHandle.sha,
          stashLabel: stashHandle.label,
          untrackedIncluded: true,
        },
      });
    }

    const pullStart = performance.now();
    if (!integration.skipOriginFetch) {
      await tryFastForwardFromOrigin(rootDir, taskId, integration.integrationBranch, integration.integrationRemote ?? "origin");
    }

    // Sync working tree + index to the local integration tip. The merger
    // advances `refs/heads/<integrationBranch>` via `git update-ref` without
    // touching any worktree. When HEAD here is symbolic to that branch
    // (the normal case in the user's project-root checkout), HEAD already
    // resolves to the new sha — but the working files and index don't
    // follow until something forces it. `tryFastForwardFromOrigin` only
    // updates the worktree when origin is ahead of local; when the local
    // tip is ahead of origin (the post-merge, pre-push state), it returns
    // a no-op and the user sees "Pull completed" with no visible change.
    // Reset against the branch ref explicitly so the worktree advances to
    // the local tip regardless of whether the origin FF ran. The autostash
    // above protects user edits, so --hard is safe here.
    const localIntegrationTip = (await runGitCommand(
      ["rev-parse", "--verify", `refs/heads/${integration.integrationBranch}`],
      rootDir,
      5_000,
    )).trim();
    if (localIntegrationTip) {
      await runGitCommand(["reset", "--hard", localIntegrationTip], rootDir, 10_000)
        .catch((err) => {
          // Log-and-continue: a failed worktree sync still leaves the ref
          // advanced, so downstream stash-pop and audit emission proceed.
          // The user's worktree just stays at its prior sha, matching today's
          // behavior. Logged loudly so the failure is visible.
          console.warn(
            `[integration-pull] taskId=${taskId} worktree sync to ${localIntegrationTip.slice(0, 8)} failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    const durationMs = Math.round(performance.now() - pullStart);
    const toSha = (await runGitCommand(["rev-parse", "HEAD"], rootDir, 5_000)).trim();

    emitDashboardGitAuditEvent(integration.store, {
      taskId: integration.taskId,
      runId: integration.runId,
      mutationType: "pull:fast-forward",
      target: rootDir,
      metadata: {
        taskId: integration.taskId,
        worktreePath: rootDir,
        integrationBranch: integration.integrationBranch,
        remote: integration.integrationRemote ?? "origin",
        fromSha,
        toSha,
        durationMs,
        succeeded: true,
        ...(toSha === fromSha ? { behind: 0 } : {}),
      },
    });

    if (!stashHandle) {
      console.info(`[integration-pull] taskId=${taskId} worktree=${rootDir.split("/").pop() ?? rootDir} kind=pull-clean from=${fromSha.slice(0, 7)} to=${toSha.slice(0, 7)}`);
      return { kind: "pull-clean", message: "Pull completed", fromSha, toSha };
    }

    const mergerOptions = {
      taskId,
      rootDir,
      branch: integration.integrationBranch,
      integrationBranch: integration.integrationBranch,
      mergeMode: "squash",
    } as MergerOptions;
    const outcome = await restoreUnrelatedRootDirChanges(rootDir, taskId, stashHandle, {
      store: integration.store,
      options: mergerOptions,
      settings: integration.settings,
    });

    if (outcome.status === "restored" || outcome.status === "ai-resolved") {
      emitDashboardGitAuditEvent(integration.store, {
        taskId: integration.taskId,
        runId: integration.runId,
        mutationType: "stash:pop",
        target: rootDir,
        metadata: {
          taskId: integration.taskId,
          worktreePath: rootDir,
          stashSha: stashHandle.sha,
          stashLabel: stashHandle.label,
          autostashOutcome: outcome.status,
        },
      });
      console.info(`[integration-pull] taskId=${taskId} worktree=${rootDir.split("/").pop() ?? rootDir} kind=pull-restored from=${fromSha.slice(0, 7)} to=${toSha.slice(0, 7)}`);
      return { kind: "pull-restored", message: "Pulled latest changes and restored local edits.", fromSha, toSha, autostash: { status: outcome.status } };
    }

    if (outcome.status === "conflict-needs-manual" || outcome.status === "failed") {
      const conflictedFiles = await getConflictedFiles(rootDir);
      emitDashboardGitAuditEvent(integration.store, {
        taskId: integration.taskId,
        runId: integration.runId,
        mutationType: "stash:pop-conflict",
        target: rootDir,
        metadata: {
          taskId: integration.taskId,
          worktreePath: rootDir,
          stashSha: stashHandle.sha,
          stashLabel: stashHandle.label,
          conflictedFiles,
          autostashOutcome: outcome.status,
        },
      });
      console.info(`[integration-pull] taskId=${taskId} worktree=${rootDir.split("/").pop() ?? rootDir} kind=stash-conflict from=${fromSha.slice(0, 7)} to=${toSha.slice(0, 7)}`);
      return {
        kind: "stash-conflict",
        message: "Pulled latest changes, but restoring local edits needs manual resolution.",
        fromSha,
        toSha,
        stashSha: stashHandle.sha,
        stashLabel: stashHandle.label,
        conflictedFiles,
        autostashOutcome: outcome.status,
      };
    }

    await dropAutostashHandle(rootDir, taskId, stashHandle, {
      keepIfLive: false,
      store: integration.store,
      context: "integration-pull",
    }).catch(() => undefined);
    console.info(`[integration-pull] taskId=${taskId} worktree=${rootDir.split("/").pop() ?? rootDir} kind=pull-clean from=${fromSha.slice(0, 7)} to=${toSha.slice(0, 7)}`);
    return { kind: "pull-clean", message: "Pull completed", fromSha, toSha };
  }

  const rebase = options?.rebase === true;
  const autostash = await createPullAutostash(cwd);
  try {
    const output = await runGitCommand(rebase ? ["pull", "--rebase"] : ["pull", "--ff-only"], cwd, 30_000);
    const message = output.trim() || (rebase ? "Pull completed (rebase)" : "Pull completed");

    if (!autostash) {
      return { success: true, message };
    }

    const reapply = await reapplyPullAutostash(autostash, cwd);
    if (reapply.conflict) {
      return {
        success: false,
        conflict: true,
        message: reapply.message ?? "Pulled latest changes, but reapplying local edits conflicted.",
        autostashed: true,
        stashConflict: true,
      };
    }

    return {
      success: true,
      message: `${message}\n\nRestored your local changes from an automatic pre-pull stash.`,
      autostashed: true,
      stashReapplied: true,
    };
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (isGitConflictMessage(message)) {
      const preservedMessage = autostash
        ? `Merge conflict detected during pull. Your local edits were preserved in stash ${autostash.sha.slice(0, 7)} (${autostash.label}). Resolve the pull conflict first, then reapply from the Stashes view.`
        : "Merge conflict detected. Resolve manually.";
      return { success: false, message: preservedMessage, conflict: true, autostashed: Boolean(autostash) };
    }
    if (autostash) {
      const restored = await reapplyPullAutostash(autostash, cwd).catch(() => null);
      if (restored?.applied) {
        throw new Error(`${message || "Pull failed"}\n\nYour local changes were restored from the automatic pre-pull stash.`);
      }
      if (restored?.conflict) {
        throw new Error(`${message || "Pull failed"}\n\n${restored.message}`);
      }
    }
    throw new Error(message || "Pull failed");
  }
}

export interface GitPushResult {
  success: boolean;
  message: string;
}

export async function pushGitBranch(cwd?: string): Promise<GitPushResult> {
  try {
    const output = await runGitCommand(["push"], cwd, 30000);
    return { success: true, message: output.trim() || "Push completed" };
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("rejected") || message.includes("non-fast-forward")) {
      throw new Error("Push rejected. Pull latest changes first.");
    }
    if (message.includes("Could not resolve host") || message.includes("Connection refused")) {
      throw new Error("Failed to connect to remote");
    }
    throw new Error(message || "Push failed");
  }
}

export interface GitRemoteDetailed {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export function isValidGitUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  if (/[;<>&|`$(){}[\]\r\n]/.test(url)) return false;
  if (url.startsWith("-")) return false;
  if (/^https?:\/\/.+/.test(url)) return true;
  if (/^git@[^:]+:.+/.test(url)) return true;
  if (/^file:\/\/.+/.test(url)) return true;
  if (/^ssh:\/\/.+/.test(url)) return true;
  return false;
}

export async function listGitRemotes(cwd?: string): Promise<GitRemoteDetailed[]> {
  try {
    const output = await runGitCommand(["remote", "-v"], cwd, 5000);

    const remotes = new Map<string, { fetchUrl: string; pushUrl: string }>();

    for (const line of output.split("\n")) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match) continue;

      const [, name, url, type] = match;

      if (!remotes.has(name)) {
        remotes.set(name, { fetchUrl: "", pushUrl: "" });
      }

      const remote = remotes.get(name)!;
      if (type === "fetch") {
        remote.fetchUrl = url;
      } else {
        remote.pushUrl = url;
      }
    }

    return Array.from(remotes.entries()).map(([name, urls]) => ({
      name,
      fetchUrl: urls.fetchUrl,
      pushUrl: urls.pushUrl,
    }));
  } catch {
    return [];
  }
}

export async function addGitRemote(name: string, url: string, cwd?: string): Promise<void> {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid remote name");
  }
  if (!isValidGitUrl(url)) {
    throw new Error("Invalid git URL format");
  }
  try {
    await runGitCommand(["remote", "add", name, url], cwd, 10000);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("already exists")) {
      throw new Error(`Remote '${name}' already exists`);
    }
    throw new Error(message || "Failed to add remote");
  }
}

export async function removeGitRemote(name: string, cwd?: string): Promise<void> {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid remote name");
  }
  try {
    await runGitCommand(["remote", "remove", name], cwd, 10000);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("No such remote")) {
      throw new Error(`Remote '${name}' does not exist`);
    }
    throw new Error(message || "Failed to remove remote");
  }
}

export async function renameGitRemote(oldName: string, newName: string, cwd?: string): Promise<void> {
  if (!isValidBranchName(oldName)) {
    throw new Error("Invalid remote name");
  }
  if (!isValidBranchName(newName)) {
    throw new Error("Invalid new remote name");
  }
  try {
    await runGitCommand(["remote", "rename", oldName, newName], cwd, 10000);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("No such remote")) {
      throw new Error(`Remote '${oldName}' does not exist`);
    }
    if (message.includes("already exists")) {
      throw new Error(`Remote '${newName}' already exists`);
    }
    throw new Error(message || "Failed to rename remote");
  }
}

export async function setGitRemoteUrl(name: string, url: string, cwd?: string): Promise<void> {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid remote name");
  }
  if (!isValidGitUrl(url)) {
    throw new Error("Invalid git URL format");
  }
  try {
    await runGitCommand(["remote", "set-url", name, url], cwd, 10000);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("No such remote")) {
      throw new Error(`Remote '${name}' does not exist`);
    }
    throw new Error(message || "Failed to update remote URL");
  }
}

export interface GitStash {
  index: number;
  message: string;
  date: string;
  branch: string;
}

export interface GitFileChange {
  file: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked";
  staged: boolean;
  oldFile?: string;
}

export async function getGitStashList(cwd?: string): Promise<GitStash[]> {
  try {
    const output = (await runGitCommand(["stash", "list", '--format="%gd|%gs|%ai"'], cwd, 5000)).trim();
    if (!output) return [];

    const stashes: GitStash[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 3) continue;
      const [ref, message, date] = parts;
      const indexMatch = ref.match(/stash@\{(\d+)\}/);
      const index = indexMatch ? parseInt(indexMatch[1], 10) : stashes.length;
      const branchMatch = message.match(/(?:WIP on|On) ([^:]+):/);
      const branch = branchMatch ? branchMatch[1] : "";
      stashes.push({ index, message, date, branch });
    }
    return stashes;
  } catch {
    return [];
  }
}

export async function createGitStash(message?: string, cwd?: string): Promise<string> {
  let output: string;
  if (message) {
    const sanitized = message.replace(/[`$\\!"]/g, "").trim();
    if (!sanitized) {
      throw new Error("Invalid stash message");
    }
    output = (await runGitCommand(["stash", "push", "-m", sanitized], cwd, 10000)).trim();
  } else {
    output = (await runGitCommand(["stash", "push"], cwd, 10000)).trim();
  }
  if (output.includes("No local changes to save")) {
    throw new Error("No local changes to stash");
  }
  return output || "Stash created";
}

export async function applyGitStash(index: number, drop = false, cwd?: string): Promise<string> {
  if (index < 0 || !Number.isInteger(index)) throw new Error("Invalid stash index");
  const args = drop ? ["stash", "pop", `stash@{${index}}`] : ["stash", "apply", `stash@{${index}}`];
  const output = (await runGitCommand(args, cwd, 10000)).trim();
  return output || (drop ? "Stash popped" : "Stash applied");
}

export async function dropGitStash(index: number, cwd?: string): Promise<string> {
  if (index < 0 || !Number.isInteger(index)) throw new Error("Invalid stash index");
  const output = (await runGitCommand(["stash", "drop", `stash@{${index}}`], cwd, 10000)).trim();
  return output || "Stash dropped";
}

export async function getGitStashDiff(index: number, cwd?: string): Promise<{ stat: string; patch: string } | null> {
  if (index < 0 || !Number.isInteger(index)) {
    throw new Error("Invalid stash index");
  }

  const stashRef = `stash@{${index}}`;
  try {
    await runGitCommand(["rev-parse", "--verify", stashRef], cwd, 5000);
  } catch {
    return null;
  }

  const stat = (await runGitCommand(["stash", "show", "--stat", stashRef], cwd, 10000)).trim();
  const patch = await runGitCommand(["stash", "show", "-p", stashRef], cwd, 10000);
  return { stat, patch };
}

export async function getGitFileChanges(cwd?: string): Promise<GitFileChange[]> {
  try {
    const output = await runGitCommand(["status", "--porcelain=v1"], cwd, 5000);
    if (!output.trim()) return [];

    const changes: GitFileChange[] = [];
    for (const line of output.split("\n")) {
      // Preserve leading status spaces from porcelain output. Trimming the
      // whole command output corrupts the first unstaged entry (`" M foo"` →
      // `"M foo"`), which misclassifies it as staged and truncates the path.
      const normalizedLine = line.replace(/\r$/, "");
      if (normalizedLine.length < 3) continue;
      const indexStatus = normalizedLine[0];
      const workTreeStatus = normalizedLine[1];
      const filePath = normalizedLine.slice(3).trim();

      const mapStatus = (code: string): GitFileChange["status"] => {
        switch (code) {
          case "A": return "added";
          case "M": return "modified";
          case "D": return "deleted";
          case "R": return "renamed";
          case "C": return "copied";
          case "?": return "untracked";
          default: return "modified";
        }
      };

      let file = filePath;
      let oldFile: string | undefined;
      if (filePath.includes(" -> ")) {
        const [old, newF] = filePath.split(" -> ");
        oldFile = old.trim();
        file = newF.trim();
      }

      if (indexStatus !== " " && indexStatus !== "?") {
        changes.push({ file, status: mapStatus(indexStatus), staged: true, oldFile });
      }

      if (workTreeStatus !== " ") {
        changes.push({
          file,
          status: workTreeStatus === "?" ? "untracked" : mapStatus(workTreeStatus),
          staged: false,
          oldFile,
        });
      }
    }
    return changes;
  } catch {
    return [];
  }
}

export async function getGitWorkingDiff(cwd?: string): Promise<{ stat: string; patch: string }> {
  try {
    const stat = (await runGitCommand(["diff", "--stat"], cwd, 10000)).trim();
    const patch = await runGitCommand(["diff"], cwd, 10000);
    return { stat, patch };
  } catch {
    return { stat: "", patch: "" };
  }
}

export function isValidGitFilePath(filePath: string): boolean {
  if (!filePath || !filePath.trim()) return false;
  if (filePath.startsWith("-")) return false;
  if (isAbsolute(filePath)) return false;
  if (filePath.includes("\0")) return false;
  if (filePath.includes("..")) return false;
  if (/[;&|`$(){}[\]\r\n]/.test(filePath)) return false;
  return true;
}

// `git diff --no-index` exits 1 when files differ — that's the success case
// for synthetic untracked-file diffs, not an error. Use spawn directly so we
// can accept exit code 1 with stdout, independent of how callers (or test
// mocks) wrap execFile / promisify.
async function runNoIndexDiff(args: string[], cwd?: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd, timeout: 10_000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        resolve(stdout);
      } else {
        reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`));
      }
    });
  });
}

export async function getGitFileDiff(filePath: string, staged: boolean, cwd?: string): Promise<{ stat: string; patch: string }> {
  if (!isValidGitFilePath(filePath)) {
    throw new Error(`Invalid file path: ${filePath}`);
  }

  if (staged) {
    const stat = (await runGitCommand(["diff", "--cached", "--stat", "--", filePath], cwd, 10000)).trim();
    const patch = await runGitCommand(["diff", "--cached", "--", filePath], cwd, 10000);
    return { stat, patch };
  }

  const untracked = (await runGitCommand(["ls-files", "--others", "--exclude-standard", "--", filePath], cwd, 5000)).trim();
  if (untracked === filePath) {
    const stat = (await runNoIndexDiff(["diff", "--no-index", "--stat", "/dev/null", filePath], cwd)).trim();
    const patch = await runNoIndexDiff(["diff", "--no-index", "/dev/null", filePath], cwd);
    return { stat, patch };
  }

  const stat = (await runGitCommand(["diff", "--stat", "--", filePath], cwd, 10000)).trim();
  const patch = await runGitCommand(["diff", "--", filePath], cwd, 10000);
  return { stat, patch };
}

export async function stageGitFiles(files: string[], cwd?: string): Promise<string[]> {
  if (!files.length) throw new Error("No files specified");
  for (const f of files) {
    if (!isValidGitFilePath(f)) {
      throw new Error(`Invalid file path: ${f}`);
    }
  }
  await runGitCommand(["add", ...files], cwd, 10000);
  return files;
}

export async function unstageGitFiles(files: string[], cwd?: string): Promise<string[]> {
  if (!files.length) throw new Error("No files specified");
  for (const f of files) {
    if (!isValidGitFilePath(f)) {
      throw new Error(`Invalid file path: ${f}`);
    }
  }
  await runGitCommand(["reset", "HEAD", "--", ...files], cwd, 10000);
  return files;
}

export async function createGitCommit(message: string, cwd?: string): Promise<{ hash: string; message: string }> {
  if (!message || !message.trim()) throw new Error("Commit message is required");
  const staged = (await runGitCommand(["diff", "--cached", "--name-only"], cwd, 5000)).trim();
  if (!staged) throw new Error("No staged changes to commit");
  await runGitCommand(["commit", "-m", message.trim()], cwd, 10000);
  const hash = (await runGitCommand(["rev-parse", "--short", "HEAD"], cwd, 5000)).trim();
  return { hash, message: message.trim() };
}

export async function discardGitChanges(files: string[], cwd?: string): Promise<string[]> {
  if (!files.length) throw new Error("No files specified");
  for (const f of files) {
    if (!isValidGitFilePath(f)) {
      throw new Error(`Invalid file path: ${f}`);
    }
  }
  const statusOutput = (await runGitCommand(["status", "--porcelain=v1"], cwd, 5000)).trim();
  const untracked = new Set<string>();
  for (const line of statusOutput.split("\n")) {
    if (line.startsWith("??")) {
      untracked.add(line.slice(3).trim());
    }
  }
  const trackedFiles = files.filter((f) => !untracked.has(f));
  const untrackedFiles = files.filter((f) => untracked.has(f));

  if (trackedFiles.length) {
    await runGitCommand(["checkout", "--", ...trackedFiles], cwd, 10000);
  }
  if (untrackedFiles.length) {
    await runGitCommand(["clean", "-f", "--", ...untrackedFiles], cwd, 10000);
  }
  return files;
}

const batchImportWindowMs = 10_000;
const batchImportInstances: Map<string, number>[] = [];
let batchImportCleanupInterval: ReturnType<typeof setInterval> | undefined;

export function __resetBatchImportRateLimiter(): void {
  for (const clients of batchImportInstances) {
    clients.clear();
  }
  batchImportInstances.length = 0;
  if (batchImportCleanupInterval) {
    clearInterval(batchImportCleanupInterval);
    batchImportCleanupInterval = undefined;
  }
}

export function createBatchImportRateLimiter(): (req: Request, res: Response, next: NextFunction) => void {
  const clients = new Map<string, number>();
  batchImportInstances.push(clients);

  if (!batchImportCleanupInterval) {
    batchImportCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const instanceClients of batchImportInstances) {
        for (const [ip, resetTime] of instanceClients) {
          if (now >= resetTime) {
            instanceClients.delete(ip);
          }
        }
      }
    }, batchImportWindowMs);
    batchImportCleanupInterval.unref?.();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();

    const resetTime = clients.get(ip);
    if (resetTime && now < resetTime) {
      const retryAfter = Math.ceil((resetTime - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      throw rateLimited("Batch import rate limit exceeded. Try again in a few seconds.");
    }

    clients.set(ip, now + batchImportWindowMs);
    next();
  };
}

/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Shared by BOTH import surfaces (single import and batch import) so a batch-imported task carries the same translation a singly-imported one does — the requirement is about imported issues, not about which button was pressed.
Returns null (import the original) whenever auto-translate is off, no target locale resolves, the issue is closed, or nothing is cached for the issue's CURRENT content. Never calls the model: import must not block on, or fail because of, a translation.
*/
async function resolveImportedIssueTranslation(
  req: Request,
  store: TaskStore,
  owner: string,
  repo: string,
  issue: { number: number; title: string; body: string | null; state: "open" | "closed" },
  projectSettings: Awaited<ReturnType<TaskStore["getSettings"]>>,
): Promise<{ title: string; body: string } | null> {
  try {
    /*
    FNXC:GitHubImportTranslate 2026-07-16-11:22:
    FN-8115 passes request-scoped project settings from both import routes so translation and tracking share one project-settings read. FN-8112 first made the prior two-read test setup stable; this consolidation preserves its behavior without a second store lookup.
    */
    if (projectSettings.githubImportAutoTranslate !== true) return null;

    const { getCachedImportTranslation, resolveTargetLocale } = await import(
      "../import-translate-service.js"
    );
    /*
    FNXC:GitHubImportTranslate 2026-07-15-14:10:
    The DEFAULT config leaves `importTranslateTargetLocale` unset ("follow the dashboard language"), so resolving from the project setting plus a client-sent locale alone made a default-configured import silently create the task from the ORIGINAL prose even though the panel showed a translation (PR #2141 review, P1).
    Resolution therefore falls through to the global `language` setting server-side, which also fixes direct API callers and stale clients; the request locale stays as the last tier because `language` is itself unset when a surface browser-detects its locale.
    */
    const targetLocale = resolveTargetLocale(
      projectSettings.importTranslateTargetLocale,
      // The panel forwards its active locale; a direct API caller may not.
      (req.body as { targetLocale?: unknown } | undefined)?.targetLocale,
      projectSettings.language,
    );
    if (!targetLocale) return null;

    return await getCachedImportTranslation(
      { store, provider: "github", repoKey: `${owner}/${repo}`, targetLocale },
      issue,
    );
  } catch {
    // Translation lookup must never break an import.
    return null;
  }
}

async function resolveImportedIssueGithubTracking(
  store: TaskStore,
  projectSettings: Awaited<ReturnType<TaskStore["getSettings"]>>,
): Promise<{ enabled: true } | undefined> {
  /*
  FNXC:GithubImportTracking 2026-07-16-11:22:
  FN-8115 shares the import request's project settings with translation and tracking, removing duplicate project-store reads after FN-8112 stabilized the prior test setup. The global settings read remains distinct because tracking precedence still requires it.
  */
  if (projectSettings.githubLinkImportedIssuesToTracking === true) {
    /*
    FNXC:GithubImportTracking 2026-07-01-00:00:
    The imported-issue linking option is narrower than the general new-task default. Dashboard imports force githubTracking.enabled only for GitHub source issues so the post-create hook adopts sourceIssue instead of opening a separate Fusion tracking issue.
    */
    return { enabled: true };
  }
  const globalSettings = await store.getGlobalSettingsStore().getSettings();
  const resolvedTracking = resolveTaskGithubTracking(
    { githubTracking: undefined },
    projectSettings,
    globalSettings,
  );
  /*
  FNXC:GithubImportTracking 2026-06-26-00:00:
  Dashboard GitHub issue imports must mark tasks tracking-enabled only when project/global defaults resolve on. The post-create hook uses the GitHub sourceIssue to link source_issue_linked and prevents duplicate Fusion-created tracking issues.
  */
  return resolvedTracking.enabled ? { enabled: true } : undefined;
}

export function getDefaultGitHubRepo(store: TaskStore): { owner: string; repo: string } | null {
  const envRepo = process.env.GITHUB_REPOSITORY;
  if (envRepo) {
    const [owner, repo] = envRepo.split("/");
    if (owner && repo) {
      return { owner, repo };
    }
  }

  const rootDir = typeof store.getRootDir === "function" ? store.getRootDir() : process.cwd();
  return getCurrentRepo(rootDir);
}

export function isBatchStatusStale(info: { lastCheckedAt?: string } | undefined, updatedAt?: string): boolean {
  const lastChecked = info?.lastCheckedAt ?? updatedAt;
  if (!lastChecked) return true;
  return Date.now() - new Date(lastChecked).getTime() > 5 * 60 * 1000;
}

export function ensureBatchStatusEntry(results: BatchStatusResult, taskId: string): BatchStatusEntry {
  results[taskId] ??= { stale: true };
  return results[taskId];
}

export function appendBatchStatusError(results: BatchStatusResult, taskId: string, message: string): void {
  const entry = ensureBatchStatusEntry(results, taskId);
  entry.error = entry.error ? `${entry.error}; ${message}` : message;
  entry.stale = true;
}

async function syncPrReviewsToTask(store: TaskStore, task: Task, snapshot: PrReviewSnapshot): Promise<void> {
  for (const item of snapshot.items) {
    const isReviewItem = item.id.startsWith("gh-review-");
    const source = isReviewItem ? "github-review" : "github-review-comment";
    const externalId = String(item.githubCommentId ?? item.id);
    const reviewState = item.state === "APPROVED" || item.state === "CHANGES_REQUESTED" || item.state === "COMMENTED"
      ? item.state
      : undefined;
    const header = isReviewItem
      ? `**Review by @${item.author.login} — ${item.state ?? "COMMENTED"}**`
      : `**Inline comment by @${item.author.login}**`;
    const body = `${header}\n\n${item.body}`;

    await store.addComment(task.id, body, `github:${item.author.login}`, {
      skipRefinement: true,
      source,
      externalId,
      reviewState,
    });
  }
}

async function applyChangesRequestedTransition(
  store: TaskStore,
  task: Task,
  snapshot: PrReviewSnapshot,
  prInfo: PrInfo,
): Promise<void> {
  if (snapshot.decision !== "CHANGES_REQUESTED") return;
  if (task.column !== "in-review") return;
  if (task.prInfo?.lastReviewDecision === "CHANGES_REQUESTED") return;

  const reviewItems = snapshot.items.filter((item) => item.id.startsWith("gh-review-") && item.state === "CHANGES_REQUESTED");
  const commentItems = snapshot.items.filter((item) => item.id.startsWith("gh-comment-")).slice(-5);
  const latestReview = reviewItems.at(-1);
  const feedbackBody = [
    `Reviewer requested changes for PR #${prInfo.number}.`,
    latestReview ? `\nLatest review by @${latestReview.author.login}:\n${latestReview.body}` : "",
    commentItems.length > 0
      ? `\nRecent inline comments:\n${commentItems.map((item) => `- @${item.author.login}: ${item.body}`).join("\n")}`
      : "",
  ].join("\n").trim();

  await store.upsertTaskDocument(task.id, {
    key: "review-feedback",
    content: feedbackBody || "Reviewer requested changes.",
    author: "system",
  });
  await store.moveTask(task.id, "todo", {
    preserveProgress: true,
    preserveWorktree: true,
    moveSource: "engine",
  });

  if ("recordRunAuditEvent" in store && typeof store.recordRunAuditEvent === "function") {
    const auditInput: RunAuditEventInput = {
      taskId: task.id,
      agentId: "dashboard-api",
      runId: `dashboard-pr-refresh-${task.id}`,
      domain: "database",
      mutationType: "pr:changes-requested-auto-move",
      target: task.id,
      metadata: {
        reviewDecision: snapshot.decision,
        reviewCount: reviewItems.length,
        commentCount: commentItems.length,
      },
    };
    void store.recordRunAuditEvent(auditInput);
  }
}

export function resolvePrMergeMethod(
  settings: Pick<import("@fusion/core").Settings, "directMergeCommitStrategy"> | null | undefined,
  prInfo: Pick<PrInfo, "autoMergeStrategy"> | null | undefined,
  explicit?: "merge" | "squash" | "rebase",
): "merge" | "squash" | "rebase" {
  if (explicit) return explicit;
  if (prInfo?.autoMergeStrategy) return prInfo.autoMergeStrategy;
  switch (settings?.directMergeCommitStrategy) {
    case "always-rebase":
      return "rebase";
    case "always-squash":
      return "squash";
    case "auto":
    default:
      return "squash";
  }
}

async function mergeTaskPr(
  scopedStore: TaskStore,
  task: Task,
  token: string | undefined,
  explicitMethod?: "merge" | "squash" | "rebase",
  runIdPrefix = "pr-merge",
): Promise<PrInfo> {
  if (!task.prInfo?.number) {
    throw badRequest("Task has no associated PR number");
  }
  if (task.prInfo.status !== "open") {
    throw badRequest(`PR is ${task.prInfo.status}`);
  }

  const badgeParsed = parseBadgeUrl(task.prInfo.url);
  const repo = badgeParsed ?? getCurrentRepo(scopedStore.getRootDir());
  if (!repo) {
    throw badRequest("Could not determine GitHub repository");
  }

  const settings = await scopedStore.getSettings();
  const method = resolvePrMergeMethod(settings, task.prInfo, explicitMethod);
  const client = new GitHubClient(token);

  try {
    const mergedPrInfo = await client.mergePr({ owner: repo.owner, repo: repo.repo, number: task.prInfo.number, method });
    const updated = {
      ...task.prInfo,
      ...mergedPrInfo,
      autoMergeOnGreen: task.prInfo.autoMergeOnGreen,
      autoMergeStrategy: task.prInfo.autoMergeStrategy,
      manual: task.prInfo.manual,
      lastMergeError: undefined,
      lastMergeErrorAt: undefined,
      draft: mergedPrInfo.draft ?? mergedPrInfo.isDraft,
    } satisfies PrInfo;
    await scopedStore.updatePrInfo(task.id, updated);
    await scopedStore.applyPrMergedTransition(task.id, {
      agentId: "dashboard",
      runId: `${runIdPrefix}-${task.id}-${Date.now()}`,
    });
    return updated;
  } catch (error) {
    const message = getCommandErrorMessage(error) || "Failed to merge pull request";
    await scopedStore.updatePrInfo(task.id, {
      ...task.prInfo,
      lastMergeError: message,
      lastMergeErrorAt: new Date().toISOString(),
    });
    const err = new ApiError(502, "Failed to merge pull request", {
      code: "pr_merge_failed",
      retryable: true,
      error: message,
    });
    throw err;
  }
}

function getTaskPrList(task: Pick<Task, "prInfo" | "prInfos">): PrInfo[] {
  return task.prInfos ?? (task.prInfo ? [task.prInfo] : []);
}

export async function refreshPrInBackground(
  store: TaskStore,
  taskId: string,
  currentPrInfos: PrInfo[],
  token?: string,
  options?: {
    onConflictDetected?: (taskId: string) => Promise<void>;
    repoRoot?: string;
    directMergeCommitStrategy?: DirectMergeCommitStrategy;
  },
): Promise<void> {
  try {
    const initialPrInfo = currentPrInfos[0];
    if (!initialPrInfo) return;
    let owner: string;
    let repo: string;

    const badgeParsed = parseBadgeUrl(initialPrInfo.url);
    if (badgeParsed) {
      owner = badgeParsed.owner;
      repo = badgeParsed.repo;
    } else {
      const envRepo = process.env.GITHUB_REPOSITORY;
      if (envRepo) {
        const [o, r] = envRepo.split("/");
        owner = o;
        repo = r;
      } else {
        const gitRepo = getCurrentRepo(store.getRootDir());
        if (!gitRepo) return;
        owner = gitRepo.owner;
        repo = gitRepo.repo;
      }
    }

    const repoKey = `${owner}/${repo}`;
    if (!githubRateLimiter.canMakeRequest(repoKey)) {
      return;
    }

    const client = new GitHubClient(token);
    const task = await store.getTask(taskId);
    const taskPrs = task ? getTaskPrList(task) : currentPrInfos;

    for (const currentPrInfo of taskPrs) {
      const reviewSnapshot = await client.getPrReviewSnapshot(owner, repo, currentPrInfo.number);
      const mergeStatus = await client.getPrMergeStatus(owner, repo, currentPrInfo.number);
      const prior = getTaskPrList(task).find((entry) => entry.number === currentPrInfo.number) ?? currentPrInfo;
      let conflictDiagnostics = mergeStatus.prInfo.conflictDiagnostics;
      if (mergeStatus.prInfo.mergeable === "conflicting" && mergeStatus.prInfo.headBranch && mergeStatus.prInfo.baseBranch) {
        try {
          conflictDiagnostics = await client.getPrConflictDiagnostics(owner, repo, currentPrInfo.number, {
            baseBranch: mergeStatus.prInfo.baseBranch,
            headBranch: mergeStatus.prInfo.headBranch,
            repoRoot: options?.repoRoot,
            directMergeCommitStrategy: options?.directMergeCommitStrategy,
          });
        } catch (err) {
          console.error("[pr-conflict-diagnostics]", err);
        }
      } else {
        conflictDiagnostics = undefined;
      }

      const prInfo = {
        ...prior,
        ...mergeStatus.prInfo,
        mergeable: mergeStatus.prInfo.mergeable,
        conflictDiagnostics,
        autoMergeOnGreen: prior?.autoMergeOnGreen,
        autoMergeStrategy: prior?.autoMergeStrategy,
        lastMergeError: prior?.lastMergeError,
        lastMergeErrorAt: prior?.lastMergeErrorAt,
        manual: prior?.manual,
        draft: mergeStatus.prInfo.draft ?? mergeStatus.prInfo.isDraft,
        lastCheckedAt: new Date().toISOString(),
        lastReviewDecision: reviewSnapshot.decision,
      } satisfies PrInfo;

      await store.updatePrInfoByNumber(taskId, currentPrInfo.number, prInfo);
      await syncPrReviewsToTask(store, task, reviewSnapshot);
      await applyChangesRequestedTransition(store, task, reviewSnapshot, prInfo);

      if (prInfo.mergeable === "conflicting" && task?.branch && task?.worktree && options?.onConflictDetected) {
        await options.onConflictDetected(taskId);
      }

      if (prInfo.status === "merged") {
        await store.applyPrMergedTransition(taskId, {
          agentId: "dashboard",
          runId: `pr-refresh-${taskId}-${Date.now()}`,
        });
        continue;
      }

      const lastMergeErrorAt = prior?.lastMergeErrorAt ? Date.parse(prior.lastMergeErrorAt) : Number.NaN;
      const recentlyFailed = Number.isFinite(lastMergeErrorAt) && Date.now() - lastMergeErrorAt < 5 * 60 * 1000;
      if (prior?.autoMergeOnGreen && mergeStatus.mergeReady && !recentlyFailed) {
        await mergeTaskPr(store, task, token, undefined, "pr-refresh");
      }
    }
  } catch {
    // best-effort
  }
}

export async function refreshIssueInBackground(
  store: TaskStore,
  taskId: string,
  currentIssueInfo: IssueInfo,
  token?: string,
): Promise<void> {
  try {
    let owner: string;
    let repo: string;

    const badgeParsed = parseBadgeUrl(currentIssueInfo.url);
    if (badgeParsed) {
      owner = badgeParsed.owner;
      repo = badgeParsed.repo;
    } else {
      const envRepo = process.env.GITHUB_REPOSITORY;
      if (envRepo) {
        const [o, r] = envRepo.split("/");
        owner = o;
        repo = r;
      } else {
        const gitRepo = getCurrentRepo(store.getRootDir());
        if (!gitRepo) return;
        owner = gitRepo.owner;
        repo = gitRepo.repo;
      }
    }

    const repoKey = `${owner}/${repo}`;
    if (!githubRateLimiter.canMakeRequest(repoKey)) {
      return;
    }

    const client = new GitHubClient(token);
    const issueInfo = await client.getIssueStatus(owner, repo, currentIssueInfo.number);
    if (!issueInfo) {
      return;
    }

    await store.updateIssueInfo(taskId, {
      ...issueInfo,
      lastCheckedAt: new Date().toISOString(),
    });
  } catch {
    // best-effort
  }
}

export function registerGitGitHubRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext, rethrowAsApiError, store, options } = ctx;

  /*
  FNXC:Workspace 2026-06-24-21:00:
  In workspace mode (multi-repo), git operations target a specific sub-repo.
  The `repoPath` query param selects which sub-repo. When absent, the project
  root directory is used (existing single-repo behavior).

  FNXC:Workspace 2026-06-24-22:30:
  `repoPath` is caller-supplied and untrusted. It must resolve to a directory
  contained within the project root; a `../`-prefixed or absolute value would
  otherwise redirect every git endpoint (read remote URLs, commit/push/discard)
  at an arbitrary repo on disk. Resolve to an absolute path and reject anything
  that escapes `projectRoot` via the shared `isPathWithin` containment check
  (the empty / `.` / exact-root case stays allowed — that is the root itself).
  */
  function resolveGitDir(req: Request, projectRoot: string): string {
    const repoPath = req.query.repoPath;
    if (typeof repoPath === "string" && repoPath.trim()) {
      const resolved = resolve(projectRoot, repoPath.trim());
      if (!isPathWithin(projectRoot, resolved)) {
        throw new ApiError(400, "Invalid repoPath: resolves outside the project root", {
          reason: "repo-path-escape",
        });
      }
      return resolved;
    }
    return projectRoot;
  }

  async function resolveReadOnlyCommitGitDir(req: Request, projectRoot: string): Promise<string> {
    const baseGitDir = resolveGitDir(req, projectRoot);
    const worktreePath = req.query.worktreePath;
    if (worktreePath === undefined || worktreePath === null || worktreePath === "") {
      return baseGitDir;
    }
    if (typeof worktreePath !== "string" || !isAbsolute(worktreePath)) {
      throw badRequest("worktreePath must be an absolute path");
    }
    const resolved = resolve(worktreePath);
    if (resolved !== worktreePath) {
      throw badRequest("worktreePath must be normalized");
    }

    /*
    FNXC:GitManager 2026-06-29-00:00:
    The Commits panel may inspect commit history and diffs for a Git-reported worktree of the currently selected repository checkout, but mutation routes must continue to target only resolveGitDir(repoPath). Validate this read-only override against `git worktree list` for the current repo instead of treating `repoPath` or `worktreePath` as arbitrary absolute filesystem access.
    */
    const registeredWorktrees = await listRegisteredWorktreePaths(baseGitDir);
    const canonicalResolved = canonicalForCompare(resolved);
    const registered = registeredWorktrees.find((candidate) => canonicalForCompare(candidate) === canonicalResolved);
    if (!registered) {
      throw badRequest("worktreePath is not a registered git worktree for this repository");
    }
    return registered;
  }

  /**
   * GET /api/git/workspace-repos
   * Returns the list of sub-repos for a workspace-mode project.
   * Non-workspace projects return an empty array.
   */
  router.get("/git/workspace-repos", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      const config = await loadWorkspaceConfig(rootDir);
      res.json({ repos: config?.repos ?? [] });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  const githubToken = ctx.options?.githubToken ?? process.env.GITHUB_TOKEN;
  if (typeof (store as Partial<{ on: unknown; off: unknown }>).on === "function" &&
      typeof (store as Partial<{ off: unknown }>).off === "function") {
    const githubIssueCommentService = new GitHubIssueCommentService(
      store,
      () => ctx.options?.githubToken ?? process.env.GITHUB_TOKEN,
    );
    githubIssueCommentService.start();
    ctx.registerDispose(() => githubIssueCommentService.stop());

    const githubTrackingCommentService = new GitHubTrackingCommentService(store);
    githubTrackingCommentService.start();
    ctx.registerDispose(() => githubTrackingCommentService.stop());

    const githubSourceIssueCloseService = new GitHubSourceIssueCloseService(store);
    githubSourceIssueCloseService.start();
    ctx.registerDispose(() => githubSourceIssueCloseService.stop());

    const gitlabIssueCommentService = new GitLabIssueCommentService(store);
    gitlabIssueCommentService.start();
    ctx.registerDispose(() => gitlabIssueCommentService.stop());

    const gitlabTrackingCommentService = new GitLabTrackingCommentService(store);
    gitlabTrackingCommentService.start();
    ctx.registerDispose(() => gitlabTrackingCommentService.stop());

    const gitlabSourceIssueCloseService = new GitLabSourceIssueCloseService(store);
    gitlabSourceIssueCloseService.start();
    ctx.registerDispose(() => gitlabSourceIssueCloseService.stop());

    // U14 — incremental knowledge-index refresh on task completion. Listens for
    // task:moved → done and re-indexes just that task as a knowledge page.
    const knowledgeIndexRefreshService = new KnowledgeIndexRefreshService(store);
    knowledgeIndexRefreshService.start();
    ctx.registerDispose(() => knowledgeIndexRefreshService.stop());

    const githubTrackingStateService = new GitHubTrackingStateService(store);
    const gitlabTrackingStateService = new GitLabTrackingStateService(store);
    const githubTrackingReconciler = new GitHubTrackingReconciler();
    const reconcileScheduledStores = new WeakSet<TaskStore>();
    const reconcileSweepOffsetByStore = new WeakMap<TaskStore, number>();
    const reconcileSweepInFlightByStore = new WeakMap<TaskStore, boolean>();
    githubTrackingStateService.start();
    gitlabTrackingStateService.start();

    const runReconcileSweep = async (projectStore: TaskStore, options?: { startup?: boolean }) => {
      if (typeof (projectStore as Partial<TaskStore>).listTasks !== "function"
        || typeof (projectStore as Partial<TaskStore>).listTasksForGithubTrackingReconcile !== "function"
        || typeof (projectStore as Partial<TaskStore>).getSettings !== "function"
        || typeof (projectStore as Partial<TaskStore>).logEntry !== "function") {
        return;
      }

      if (reconcileSweepInFlightByStore.get(projectStore) === true) {
        return;
      }
      reconcileSweepInFlightByStore.set(projectStore, true);

      try {
        /*
        FNXC:GithubTrackingReconcile 2026-07-16-15:40:
        Delegate to reconciler.runSweep so the three reconcile passes are isolated — a throw in the
        deleted/archived pass must not starve the done-task tracking + source-issue passes (the ones
        that actually close linked issues on Done). Previously they shared this try/catch and the
        silent swallow below meant a single early throw disabled the entire reconcile backstop, every
        sweep, with no diagnostic.
        */
        const offset = options?.startup ? 0 : reconcileSweepOffsetByStore.get(projectStore) ?? 0;
        const { nextOffset } = await githubTrackingReconciler.runSweep(projectStore, { offset });
        reconcileSweepOffsetByStore.set(projectStore, nextOffset);
      } catch (err) {
        // runSweep isolates per-pass failures internally; this guards only unexpected orchestration errors.
        console.warn(
          `[github-tracking-reconcile] sweep orchestration error: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        reconcileSweepInFlightByStore.set(projectStore, false);
      }
    };

    const attachedStateStores = new Set<TaskStore>();
    const attachStateStore = (projectStore: TaskStore) => {
      if (attachedStateStores.has(projectStore)) {
        return;
      }
      attachedStateStores.add(projectStore);
      githubTrackingStateService.attach(projectStore);
      githubSourceIssueCloseService.attach(projectStore);
      gitlabTrackingStateService.attach(projectStore);
      gitlabSourceIssueCloseService.attach(projectStore);
      // FNXC:Knowledge 2026-06-16-14:32:
      // Knowledge index refresh on task:moved→done must run for every registered project store, not just the primary.
      // Mirror the GitHubTrackingStateService/GitHubSourceIssueCloseService attach/detach lifecycle so non-primary
      // projects also re-index completed tasks. attach() is idempotent (guards on its per-store listener Map), so
      // re-attaching the primary store here is harmless even though start() already attached the default store.
      knowledgeIndexRefreshService.attach(projectStore);

      if (!reconcileScheduledStores.has(projectStore)) {
        reconcileScheduledStores.add(projectStore);
        setImmediate(() => {
          void runReconcileSweep(projectStore, { startup: true });
        });
      }
    };

    attachStateStore(store);

    const listProjectStores = (): Array<{ store: TaskStore }> => {
      try {
        const value = Reflect.get(projectStoreResolver as object, "listRegisteredProjectStores");
        if (typeof value !== "function") {
          return [];
        }
        const listed = value();
        return Array.isArray(listed) ? listed : [];
      } catch {
        return [];
      }
    };

    const subscribeProjectStoreRegistered = (handler: (projectId: string, projectStore: TaskStore) => void): (() => void) => {
      try {
        const value = Reflect.get(projectStoreResolver as object, "onProjectStoreRegistered");
        if (typeof value !== "function") {
          return () => {};
        }
        return value(handler) as () => void;
      } catch {
        return () => {};
      }
    };

    for (const { store: projectStore } of listProjectStores()) {
      attachStateStore(projectStore);
    }

    const unsubscribeProjectStoreRegistration = subscribeProjectStoreRegistered((_projectId, projectStore) => {
      attachStateStore(projectStore);
    });

    const periodicReconcileInterval = setInterval(() => {
      for (const projectStore of attachedStateStores) {
        void runReconcileSweep(projectStore);
      }
    }, GITHUB_TRACKING_RECONCILE_INTERVAL_MS);

    ctx.registerDispose(() => {
      clearInterval(periodicReconcileInterval);
      unsubscribeProjectStoreRegistration();
      for (const projectStore of attachedStateStores) {
        githubTrackingStateService.detach(projectStore);
        githubSourceIssueCloseService.detach(projectStore);
        gitlabTrackingStateService.detach(projectStore);
        gitlabSourceIssueCloseService.detach(projectStore);
        knowledgeIndexRefreshService.detach(projectStore);
      }
      githubTrackingStateService.stop();
      gitlabTrackingStateService.stop();
    });
  }

  /**
   * POST /api/git/github/backfill-source-issue-closed-at
   * FNXC:GithubSourceIssueBackfill 2026-06-18-18:53:
   * Historical source-issue closed-at backfills are opt-in manual sweeps, not periodic reconciliation work. The route is project-scoped, accepts offset/limit pagination, clamps batches to RECONCILE_SCAN_LIMIT, and returns { scanned, filled, skipped, errors, hasMore } so callers can iterate until hasMore is false without analytics-time network calls.
   */
  router.post("/git/github/backfill-source-issue-closed-at", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const body = (req.body ?? {}) as { offset?: unknown; limit?: unknown };
      const offset = body.offset === undefined ? 0 : Number(body.offset);
      const limit = body.limit === undefined ? RECONCILE_SCAN_LIMIT : Number(body.limit);
      if (!Number.isInteger(offset) || offset < 0) {
        throw badRequest("offset must be a non-negative integer");
      }
      if (!Number.isInteger(limit) || limit < 0) {
        throw badRequest("limit must be a non-negative integer");
      }

      const result = await new GitHubTrackingReconciler().backfillSourceIssueClosedAt(scopedStore, {
        offset,
        limit: Math.min(limit, RECONCILE_SCAN_LIMIT),
      });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/remotes
   * Returns GitHub remotes from the current git repository.
   * Response: Array of GitRemote objects [{ name: string, owner: string, repo: string, url: string }]
   */
  router.get("/git/remotes", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      const remotes = await getGitHubRemotes(rootDir);
      res.json(remotes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/remotes/detailed
   * Returns all git remotes with their fetch and push URLs.
   * Response: Array of GitRemoteDetailed objects [{ name: string, fetchUrl: string, pushUrl: string }]
   */
  router.get("/git/remotes/detailed", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const remotes = await listGitRemotes(rootDir);
      res.json(remotes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/git/remotes
   * Add a new git remote.
   * Body: { name: string, url: string }
   */
  router.post("/git/remotes", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      const { name, url } = req.body;
      if (!name || typeof name !== "string") {
        throw badRequest("name is required");
      }
      if (!url || typeof url !== "string") {
        throw badRequest("url is required");
      }
      if (!isValidBranchName(name)) {
        throw badRequest("Invalid remote name");
      }
      if (!isValidGitUrl(url)) {
        throw badRequest("Invalid git URL format");
      }
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      await addGitRemote(name, url, rootDir);
      res.status(201).json({ name, added: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid remote name")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("Invalid git URL")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("already exists")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * DELETE /api/git/remotes/:name
   * Remove a git remote.
   */
  router.delete("/git/remotes/:name", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      await removeGitRemote(name, rootDir);
      res.json({ name, removed: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid remote name")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("does not exist")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * PATCH /api/git/remotes/:name
   * Rename a git remote.
   * Body: { newName: string }
   */
  router.patch("/git/remotes/:name", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      const { newName } = req.body;
      if (!newName || typeof newName !== "string") {
        throw badRequest("newName is required");
      }
      await renameGitRemote(name, newName, rootDir);
      res.json({ oldName: name, newName, renamed: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("does not exist")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("already exists")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * PUT /api/git/remotes/:name/url
   * Update the URL for a git remote.
   * Body: { url: string }
   */
  router.put("/git/remotes/:name/url", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      const { url } = req.body;
      if (!url || typeof url !== "string") {
        throw badRequest("url is required");
      }
      await setGitRemoteUrl(name, url, rootDir);
      res.json({ name, url, updated: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("does not exist")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/git/status[?extended=1]
   * Returns current git status: branch, commit hash, dirty state, ahead/behind counts.
   * When `extended=1` is set, also returns integration-branch resolution, ahead/
   * behind vs both local and origin integration tip, dirty breakdown, stash count,
   * index-stale detection (the FN-INDEX-DESYNC scenario the auto-sync hook
   * fixes), and the most-recent merger ref-advance audit events for this
   * worktree (so operators can see what needs to be pulled even if the
   * Merge Advance Notice banner was dismissed).
   */
  router.get("/git/status", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const status = await getGitStatus(rootDir);
      if (!status) {
        throw internalError("Failed to get git status");
      }
      if (req.query.extended !== "1" && req.query.extended !== "true") {
        res.json(status);
        return;
      }
      // Compute extended status best-effort: if any unhandled git or store
      // failure escapes the helpers (timeout on `branch --show-current`,
      // missing reflog, store layer throws), degrade to the basic shape
      // rather than returning HTTP 500. The basic path swallows the same
      // failures via getGitStatus's broad try/catch — surface parity matters
      // because the dashboard always passes ?extended=1 and would otherwise
      // render an error toast where the legacy path would render a degraded
      // but usable panel.
      try {
        const extended = await computeExtendedGitStatus(rootDir, scopedStore);
        res.json({ ...status, ...extended });
      } catch (extErr: unknown) {
        const message = extErr instanceof Error ? extErr.message : String(extErr);
        console.warn(`[git-status] extended computation failed; returning basic status: ${message}`);
        res.json(status);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/commits
   * Returns recent commits (default 20, configurable via ?limit=).
   * Response: Array of GitCommit objects
   */
  router.get("/git/commits", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = await resolveReadOnlyCommitGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
      const commits = await getGitCommits(limit, rootDir);
      res.json(commits);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/commits/:hash/diff
   * Returns diff for a specific commit (stat + patch).
   * Response: { stat: string, patch: string }
   */
  router.get("/git/commits/:hash/diff", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = await resolveReadOnlyCommitGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { hash } = req.params;
      // Validate hash format (only hex characters, 7-40 chars)
      if (!/^[a-f0-9]{7,40}$/i.test(hash)) {
        throw badRequest("Invalid commit hash format");
      }
      const diff = await getCommitDiff(hash, rootDir);
      if (!diff) {
        throw notFound("Commit not found");
      }
      res.json(diff);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/commits/ahead
   * Returns local commits ahead of the upstream tracking branch (commits that would be pushed).
   * Response: Array of GitCommit objects (empty when no upstream is configured)
   */
  router.get("/git/commits/ahead", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const commits = await getAheadCommits(rootDir);
      res.json(commits);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/remotes/:name/branches
   * Returns branch names known on a specific remote (from local remote-tracking refs).
   * Response: string[] (e.g. ["main", "develop"]) — excludes the HEAD symbolic ref.
   */
  router.get("/git/remotes/:name/branches", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      if (!isValidBranchName(name)) {
        throw badRequest("Invalid remote name");
      }
      res.json(await getGitRemoteBranches(name, rootDir));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/remotes/:name/commits
   * Returns recent commits for a specific remote tracking ref.
   * Query: ?ref=branchName (defaults to HEAD of the remote's default branch)
   * Query: ?limit=N (defaults to 10, max 50)
   * Response: Array of GitCommit objects
   */
  router.get("/git/remotes/:name/commits", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }

      const { name } = req.params;
      if (!isValidBranchName(name)) {
        throw badRequest("Invalid remote name");
      }

      const ref = req.query.ref as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 10, 50);

      // Build the full remote ref: if ref is given, use "remote/ref", otherwise use "remote/HEAD"
      let remoteRef: string;
      if (ref) {
        if (!isValidGitRef(ref)) {
          throw badRequest("Invalid ref name");
        }
        // Strip any leading "refs/" or remote prefix the user might accidentally include
        const cleanRef = ref.replace(/^refs\/(heads\/)?/, "");
        // If the ref already starts with the remote name, use it as-is
        if (cleanRef.startsWith(`${name}/`)) {
          remoteRef = cleanRef;
        } else {
          remoteRef = `${name}/${cleanRef}`;
        }
      } else {
        // Default: try remote/HEAD symbolic ref, fall back to remote/main, remote/master
        try {
          const headRef = (await runGitCommand(["symbolic-ref", `refs/remotes/${name}/HEAD`], rootDir, 5000)).trim();
          // symbolic-ref returns full ref like refs/remotes/origin/main
          remoteRef = headRef.replace(/^refs\/remotes\//, "");
        } catch {
          // Try common defaults
          try {
            await runGitCommand(["rev-parse", "--verify", `${name}/main`], rootDir, 5000);
            remoteRef = `${name}/main`;
          } catch {
            try {
              await runGitCommand(["rev-parse", "--verify", `${name}/master`], rootDir, 5000);
              remoteRef = `${name}/master`;
            } catch {
              // Remote exists but no common branch found
              res.json([]);
              return;
            }
          }
        }
      }

      const commits = await getRemoteCommits(remoteRef, limit, rootDir);
      res.json(commits);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/branches
   * Returns all local branches with current indicator, remote tracking info, and last commit date.
   * Response: Array of GitBranch objects
   */
  router.get("/git/branches", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const branches = await getGitBranches(rootDir);
      res.json(branches);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/branches/:name/commits
   * Returns recent commits for a specific branch.
   * Query params: limit (default 10, max 100)
   * Response: Array of GitCommit objects
   */
  router.get("/git/branches/:name/commits", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      if (!isValidGitRef(name)) {
        throw badRequest("Invalid branch name");
      }
      const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 10, 1), 100);
      const commits = await getGitCommitsForBranch(name, limit, rootDir);
      res.json(commits);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/worktrees
   * Returns all worktrees with path, branch, isMain, and associated task ID.
   * Response: Array of GitWorktree objects
   */
  router.get("/git/worktrees", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      // Get tasks to correlate with worktrees
      const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
      const worktrees = await getGitWorktrees(tasks, rootDir);
      res.json(worktrees);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

// ── Git Action Routes ─────────────────────────────────────────────

  /**
   * POST /api/git/branches
   * Create a new branch from current HEAD or specified base.
   * Body: { name: string, base?: string }
   */
  router.post("/git/branches", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name, base } = req.body;
      if (!name || typeof name !== "string") {
        throw badRequest("name is required");
      }
      const branchName = await createGitBranch(name, base, rootDir);
      res.status(201).json({ name: branchName, created: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid branch name")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("already exists")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/git/branches/:name/checkout
   * Checkout an existing branch.
   */
  router.post("/git/branches/:name/checkout", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      await checkoutGitBranch(name, rootDir);
      res.json({ checkedOut: name });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid branch name")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("Uncommitted changes")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * DELETE /api/git/branches/:name
   * Delete a branch.
   * Query: ?force=true to force delete (even with unmerged commits)
   */
  router.delete("/git/branches/:name", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      const force = req.query.force === "true";
      await deleteGitBranch(name, force, rootDir);
      res.json({ deleted: name });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid branch name")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("Cannot delete branch") || (err instanceof Error ? err.message : String(err)).includes("is currently checked out")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("not fully merged")) {
        throw conflict("Branch has unmerged commits. Use force=true to delete anyway.");
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/git/fetch
   * Fetch from origin or specified remote.
   * Body: { remote?: string }
   */
  router.post("/git/fetch", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { remote } = req.body;
      const result = await fetchGitRemote(remote || "origin", rootDir);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid remote name")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("Failed to connect")) {
        throw new ApiError(503, err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/git/pull
   * Pull current branch, or integration worktree when provided.
   */
  router.post("/git/pull", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const requestCache = new Map<string, string[]>();
      const { rebase, worktreePath, integrationBranch, taskId, skipOriginFetch } = req.body ?? {};
      if (rebase !== undefined && typeof rebase !== "boolean") {
        throw badRequest("rebase must be a boolean");
      }
      if (taskId !== undefined && typeof taskId !== "string") {
        throw badRequest("taskId must be a string");
      }
      if (skipOriginFetch !== undefined && typeof skipOriginFetch !== "boolean") {
        throw badRequest("skipOriginFetch must be a boolean");
      }

      if (worktreePath !== undefined) {
        if (rebase === true) {
          throw badRequest("rebase not supported with worktreePath");
        }
        const safeWorktreePath = await assertWorktreePathSafe(scopedStore, worktreePath, requestCache);
        if (typeof integrationBranch !== "string" || integrationBranch.trim().length === 0) {
          throw badRequest("integrationBranch required when worktreePath set");
        }
        const settings = await scopedStore.getSettings();
        const integrationRemote = await resolveIntegrationRemote({
          settings,
          rootDir: safeWorktreePath,
          integrationBranch,
        }).catch(() => "origin");
        const runId = generateSyntheticRunId("dashboard-pull", taskId ?? "dashboard-pull");
        const result = await pullGitBranch(safeWorktreePath, {
          rebase: false,
          integration: {
            worktreePath: safeWorktreePath,
            integrationBranch,
            taskId,
            integrationRemote,
            store: scopedStore,
            settings,
            runId,
            skipOriginFetch: skipOriginFetch === true,
          },
        });
        res.json(result);
        return;
      }

      const result = await pullGitBranch(rootDir, { rebase: rebase === true });
      if ("conflict" in result && result.conflict) {
        throw new ApiError(409, result.message ?? "Merge conflict detected. Resolve manually.", {
          ...result,
        });
      }
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/git/stash-resolve", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { worktreePath, file, choice } = req.body ?? {};
      if (choice !== "ours" && choice !== "theirs") {
        throw badRequest("choice must be ours or theirs");
      }

      const requestCache = new Map<string, string[]>();
      const safeWorktreePath = await assertWorktreePathSafe(scopedStore, worktreePath, requestCache);
      const safeFile = assertRelativeFileSafe(safeWorktreePath, file);
      const conflictedFiles = await getConflictedFiles(safeWorktreePath);
      if (!conflictedFiles.includes(safeFile)) {
        throw badRequest("file is not conflicted");
      }

      await runGitCommand(["checkout", choice === "ours" ? "--ours" : "--theirs", "--", safeFile], safeWorktreePath, 10_000);
      await runGitCommand(["add", "--", safeFile], safeWorktreePath, 10_000);
      const remainingConflicts = await getConflictedFiles(safeWorktreePath);
      res.json({ resolvedFile: safeFile, choice, remainingConflicts });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/git/stash-drop", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { worktreePath, stashSha, taskId } = req.body ?? {};
      if (typeof stashSha !== "string" || stashSha.trim().length === 0) {
        throw badRequest("stashSha is required");
      }
      if (taskId !== undefined && typeof taskId !== "string") {
        throw badRequest("taskId must be a string");
      }

      const requestCache = new Map<string, string[]>();
      const safeWorktreePath = await assertWorktreePathSafe(scopedStore, worktreePath, requestCache);
      const remainingConflicts = await getConflictedFiles(safeWorktreePath);
      if (remainingConflicts.length > 0) {
        throw new ApiError(409, "Resolve conflicts before dropping stash", { remainingConflicts });
      }

      const ref = await findStashRefBySha(stashSha, safeWorktreePath);
      if (!ref) {
        res.json({ dropped: false });
        return;
      }

      await runGitCommand(["stash", "drop", ref], safeWorktreePath, 10_000);
      Promise.resolve(scopedStore.recordRunAuditEvent?.(buildDashboardGitAuditEvent({
        taskId,
        mutationType: "stash:pop",
        target: safeWorktreePath,
        metadata: {
          taskId,
          worktreePath: safeWorktreePath,
          stashSha,
          manualResolution: true,
        },
      }))).catch(() => undefined);

      res.json({ dropped: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/git/stash-apply", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { worktreePath, stashSha, taskId } = req.body ?? {};
      if (typeof stashSha !== "string" || stashSha.trim().length === 0) {
        throw badRequest("stashSha is required");
      }
      if (taskId !== undefined && typeof taskId !== "string") {
        throw badRequest("taskId must be a string");
      }

      const requestCache = new Map<string, string[]>();
      const safeWorktreePath = await assertWorktreePathSafe(scopedStore, worktreePath, requestCache);
      const ref = await findStashRefBySha(stashSha, safeWorktreePath);
      if (!ref) {
        res.json({ applied: false, conflict: false, conflictedFiles: [] });
        return;
      }

      try {
        await runGitCommand(["stash", "apply", ref], safeWorktreePath, 20_000);
        res.json({ applied: true, conflict: false, conflictedFiles: [] });
      } catch (err: unknown) {
        const message = getCommandErrorMessage(err);
        const conflictedFiles = await getConflictedFiles(safeWorktreePath);
        if (isGitConflictMessage(message)) {
          Promise.resolve(scopedStore.recordRunAuditEvent?.(buildDashboardGitAuditEvent({
            taskId,
            mutationType: "stash:pop-conflict",
            target: safeWorktreePath,
            metadata: {
              taskId,
              worktreePath: safeWorktreePath,
              stashSha,
              stashLabel: ref,
              conflictedFiles,
              autostashOutcome: "conflict-needs-manual",
            },
          }))).catch(() => undefined);
          res.json({ applied: true, conflict: true, conflictedFiles });
          return;
        }
        throw err;
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/git/push
   * Push the current branch.
   */
  router.post("/git/push", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const result = await pushGitBranch(rootDir);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("rejected") || (err instanceof Error ? err.message : String(err)).includes("Pull latest")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("Failed to connect")) {
        throw new ApiError(503, err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

// ── Git Stash, Stage, Commit Routes ────────────────────────────────

  /**
   * GET /api/git/stashes
   * Returns list of stash entries.
   */
  router.get("/git/stashes", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const stashes = await getGitStashList(rootDir);
      res.json(stashes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/git/stashes
   * Create a new stash.
   * Body: { message?: string }
   */
  router.post("/git/stashes", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { message } = req.body;
      const result = await createGitStash(message, rootDir);
      res.status(201).json({ message: result });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("No local changes")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/git/stashes/:index/apply
   * Apply a stash entry.
   * Body: { drop?: boolean }
   */
  router.post("/git/stashes/:index/apply", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const index = parseInt(req.params.index, 10);
      if (isNaN(index) || index < 0) {
        throw badRequest("Invalid stash index");
      }
      const { drop } = req.body;
      const result = await applyGitStash(index, drop === true, rootDir);
      res.json({ message: result });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/stashes/:index/diff
   * Returns stash diff (stat + patch) for a stash entry.
   */
  router.get("/git/stashes/:index/diff", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }

      const index = parseInt(req.params.index, 10);
      if (isNaN(index) || index < 0) {
        throw badRequest("Invalid stash index");
      }

      const diff = await getGitStashDiff(index, rootDir);
      if (!diff) {
        throw notFound("Stash not found");
      }

      res.json(diff);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/git/stashes/:index
   * Drop a stash entry.
   */
  router.delete("/git/stashes/:index", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const index = parseInt(req.params.index, 10);
      if (isNaN(index) || index < 0) {
        throw badRequest("Invalid stash index");
      }
      const result = await dropGitStash(index, rootDir);
      res.json({ message: result });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/diff
   * Returns working directory diff (unstaged changes).
   */
  router.get("/git/diff", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const diff = await getGitWorkingDiff(rootDir);
      res.json(diff);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/diff/file
   * Returns staged or unstaged diff for a specific file.
   * Query: path=<file-path>&staged=true|false
   */
  router.get("/git/diff/file", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }

      const rawPath = req.query.path;
      const rawStaged = req.query.staged;

      if (typeof rawPath !== "string" || !rawPath.trim()) {
        throw badRequest("path query parameter is required");
      }
      if (rawStaged !== "true" && rawStaged !== "false") {
        throw badRequest("staged query parameter must be 'true' or 'false'");
      }
      if (!isValidGitFilePath(rawPath)) {
        throw badRequest(`Invalid file path: ${rawPath}`);
      }

      const diff = await getGitFileDiff(rawPath, rawStaged === "true", rootDir);
      res.json(diff);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/changes
   * Returns file changes (staged and unstaged).
   */
  router.get("/git/changes", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const changes = await getGitFileChanges(rootDir);
      res.json(changes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/git/stage
   * Stage specific files.
   * Body: { files: string[] }
   */
  router.post("/git/stage", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        throw badRequest("files array is required");
      }
      const staged = await stageGitFiles(files, rootDir);
      res.json({ staged });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/git/unstage
   * Unstage specific files.
   * Body: { files: string[] }
   */
  router.post("/git/unstage", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        throw badRequest("files array is required");
      }
      const unstaged = await unstageGitFiles(files, rootDir);
      res.json({ unstaged });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/git/commit
   * Create a commit with staged changes.
   * Body: { message: string }
   */
  router.post("/git/commit", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { message } = req.body;
      if (!message || typeof message !== "string" || !message.trim()) {
        throw badRequest("Commit message is required");
      }
      const result = await createGitCommit(message, rootDir);
      res.status(201).json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("No staged changes")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/git/discard
   * Discard working directory changes for specific files.
   * Body: { files: string[] }
   */
  router.post("/git/discard", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        throw badRequest("files array is required");
      }
      const discarded = await discardGitChanges(files, rootDir);
      res.json({ discarded });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

// ── GitHub Import Routes ──────────────────────────────────────────

  /**
   * GET /api/github/issues/recent
   * Returns recent issues for the first GitHub remote (prefer origin when present).
   */
  router.get("/github/issues/recent", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = resolveGitDir(req, scopedStore.getRootDir());
      const remotes = await getGitHubRemotes(rootDir);
      const remote = remotes.find((item) => item.name === "origin") ?? remotes[0];

      if (!remote || !isGhAuthenticated()) {
        res.json([]);
        return;
      }

      const rawLimit = Number.parseInt(String(req.query.limit ?? "20"), 10);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 20;
      const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";

      const cacheKey = `${remote.owner}/${remote.repo}`;
      const now = Date.now();
      const cached = recentIssuesCache.get(cacheKey);

      let items = cached?.items;
      if (!cached || now - cached.fetchedAt > RECENT_ISSUES_CACHE_TTL_MS) {
        const client = new GitHubClient(githubToken);
        try {
          const issues = await client.listIssues(remote.owner, remote.repo, { limit: 100, state: "all" });
          items = issues
            .filter((issue) => issue.html_url.includes("/issues/"))
            .map((issue) => ({
              number: issue.number,
              title: issue.title,
              state: issue.state ?? "open",
              htmlUrl: issue.html_url,
              repository: cacheKey,
              updatedAt: issue.updatedAt,
            }));
          recentIssuesCache.set(cacheKey, { fetchedAt: now, items });
        } catch {
          res.json([]);
          return;
        }
      }

      const filtered = (items ?? []).filter((issue) => {
        if (!q) return true;
        return String(issue.number).startsWith(q) || issue.title.toLowerCase().includes(q);
      });

      res.json(filtered.slice(0, limit));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/github/issues/fetch
   * Fetch open issues from a GitHub repository.
   * Body: { owner: string, repo: string, limit?: number, labels?: string[] }
   * Returns: Array of GitHubIssue objects (filtered, no PRs)
   */
  router.post("/github/issues/fetch", async (req, res) => {
    try {
      const { owner, repo, limit = 30, labels } = req.body;

      if (!owner || typeof owner !== "string") {
        throw badRequest("owner is required");
      }
      if (!repo || typeof repo !== "string") {
        throw badRequest("repo is required");
      }

      // Check gh authentication
      if (!isGhAuthenticated()) {
        throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
      }

      const client = new GitHubClient();

      try {
        const issues = await client.listIssues(owner, repo, { limit, labels });
        res.json(issues);
      } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
        // Handle specific error cases from gh CLI
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          throw notFound(`Repository not found: ${owner}/${repo}`);
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
        }

        throw new ApiError(502, `GitHub CLI error: ${errorMessage}`);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/github/issues/import
   * Import a specific GitHub issue as a fn task.
   * Body: { owner: string, repo: string, issueNumber: number }
   * Returns: Created Task object
   */
  router.post("/github/issues/import", async (req, res) => {
    try {
      const { owner, repo, issueNumber } = req.body;

      if (!owner || typeof owner !== "string") {
        throw badRequest("owner is required");
      }
      if (!repo || typeof repo !== "string") {
        throw badRequest("repo is required");
      }
      if (!issueNumber || typeof issueNumber !== "number" || issueNumber < 1) {
        throw badRequest("issueNumber is required and must be a positive number");
      }

      // Check gh authentication
      if (!isGhAuthenticated()) {
        throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
      }

      const client = new GitHubClient();
      const { store: scopedStore } = await getProjectContext(req);

      let issue: {
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        state: "open" | "closed";
      } | null;

      try {
        issue = await client.getIssue(owner, repo, issueNumber);

        // getIssue returns null when the issue doesn't exist OR when it's a PR
        // We return a 400 error indicating it might be a PR (consistent with old behavior)
        if (issue === null) {
          throw badRequest(`#${issueNumber} is a pull request, not an issue`);
        }
      } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
        const errorMessage = err instanceof Error ? err.message : String(err);
        
        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          throw notFound(`Issue #${issueNumber} not found in ${owner}/${repo}`);
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
        }

        throw new ApiError(502, `GitHub CLI error: ${errorMessage}`);
      }

      // Check if already imported
      const existingTasks = await scopedStore.listTasks({ slim: false, includeArchived: false });
      const sourceUrl = issue.html_url;
      for (const existingTask of existingTasks) {
        if (isGitHubIssueAlreadyImported(existingTask, { owner, repo, issueNumber, sourceUrl })) {
          throw new ApiError(409, `Issue #${issueNumber} already imported as ${existingTask.id}`, {
            existingTaskId: existingTask.id,
          });
        }
      }

      /*
      FNXC:GitHubImportTranslate 2026-07-15-09:30:
      An imported issue carries the TRANSLATED prose when a translation exists, so the task an operator creates reads the same as the preview they approved.
      Cache-read only: a miss imports the original rather than blocking the import on a fresh model call, because import must stay fast and must never fail because translation failed.
      The `Source: <url>` suffix is appended AFTER translation so the URL is never rewritten by the model.
      */
      const projectSettings = await scopedStore.getSettings();
      const translatedIssue = await resolveImportedIssueTranslation(
        req,
        scopedStore,
        owner,
        repo,
        issue,
        projectSettings,
      );
      const title = (translatedIssue?.title || issue.title).slice(0, 200);
      const body = (translatedIssue?.body ?? issue.body)?.trim() || "(no description)";
      const description = `${body}\n\nSource: ${sourceUrl}`;

      const importedIssueGithubTracking = await resolveImportedIssueGithubTracking(scopedStore, projectSettings);
      const source = buildGitHubIssueSource(owner, repo, issue);
      /*
      FNXC:Workflows 2026-07-05-00:00:
      FN-7611: do not hardcode column here. This import path has no workflowId, so the
      store resolves the landing column from the PROJECT-DEFAULT workflow's intake trait
      (byte-identical "triage" for builtin:coding; a custom default workflow's own intake
      column otherwise).
      */
      const task = await scopedStore.createTask({
        title: title || undefined,
        description,
        dependencies: [],
        sourceIssue: source.sourceIssue,
        source: {
          sourceType: "github_import",
          sourceMetadata: source.sourceMetadata,
        },
        ...(importedIssueGithubTracking ? { githubTracking: importedIssueGithubTracking } : {}),
      });

      // Log the import action
      await scopedStore.logEntry(task.id, "Imported from GitHub", sourceUrl);

      /*
      FNXC:IssueImportAttachments 2026-07-15-11:20:
      Screenshots embedded in the issue are downloaded into the task's attachments so the agent can actually SEE them: the executor lists `.fusion/tasks/<id>/attachments/` in its `## Attachments` section and triage inlines images as vision blocks. Left as bare markdown URLs they are unreachable — `user-attachments` assets need repo credentials, which only exist here at import time.
      Extract from the ORIGINAL body, never the translated one: the translation model may rewrite or drop image URLs (same reasoning as the `Source:` suffix above).
      Best-effort and post-createTask: a screenshot that fails to download must not fail an import that already produced the task.

      FNXC:IssueImportAttachments 2026-07-15-13:40:
      Comments are scanned too: "here's the screenshot" is a comment far more often than it is the original body, so a body-only scan misses the common case. Comments are fetched best-effort — the issue itself already imported fine without them, so a comment-fetch failure must not fail the import or lose the body's own images.
      */
      const issueImageBodies: Array<string | null | undefined> = [issue.body];
      try {
        const detail = await client.getIssueDetail(owner, repo, issueNumber);
        issueImageBodies.push(...detail.comments.map((comment) => comment.body));
      } catch (err) {
        console.warn(
          `[fusion:github-import] Could not fetch comments for ${owner}/${repo}#${issueNumber}; importing body images only: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const imageImport = await importIssueImageAttachments(
        scopedStore,
        task.id,
        issueImageBodies,
        githubImagePolicy(),
      );
      if (imageImport.attached > 0) {
        try {
          await scopedStore.logEntry(
            task.id,
            `Imported ${imageImport.attached} image attachment${imageImport.attached === 1 ? "" : "s"} from GitHub issue`,
            sourceUrl,
          );
        } catch (error) {
          // FNXC:IssueImportAttachments 2026-07-15-14:10: Post-create audit
          // telemetry is best-effort; never turn a stored task into a failed import.
          console.warn(`[fusion:github-import] Could not log image attachments for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const importedTask = (await scopedStore.getTask(task.id)) ?? task;
      res.status(201).json(importedTask);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /*
  FNXC:GitHubImportTranslate 2026-07-15-09:30:
  Auto-translate endpoint for the Import Tasks list. The panel calls this once per load when `githubImportAutoTranslate` is on; it returns translated title+body for the foreign-language OPEN issues so the list reads in the operator's language rather than one issue at a time.
  Results are cached durably server-side, so a second load of the same repo costs no model calls, and the import path reads the same cache — which is what makes the imported task carry the translation the operator previewed.
  Requirement (2026-07-15): translate the 50 most recent OPEN issues; closed issues are never translated and their cached rows are pruned on sight.
  */
  /**
   * POST /api/github/issues/auto-translate
   * Body: { owner, repo, items: [{number,title,body,state}], targetLocale? }
   * Returns: { translations: Record<number, {title,body}>, enabled, targetLocale, capped }
   */
  router.post("/github/issues/auto-translate", async (req, res) => {
    try {
      const { owner, repo, items, targetLocale: requestedLocale } = req.body ?? {};
      if (!owner || typeof owner !== "string") throw badRequest("owner is required");
      if (!repo || typeof repo !== "string") throw badRequest("repo is required");
      if (!Array.isArray(items)) throw badRequest("items must be an array");

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();

      const {
        translateImportItems,
        resolveTargetLocale,
        selectEligibleItems,
        partitionImportItemsByCache,
        isTranslatable,
      } = await import("../import-translate-service.js");
      const {
        checkTranslateRateLimit,
        getTranslateRateLimitResetTime,
      } = await import("../ai-translate.js");

      /*
      FNXC:GitHubImportTranslate 2026-07-15-09:30:
      The setting is enforced server-side, not only by hiding UI: an off setting must mean "no model calls and no billing", even if a stale client or a direct API caller asks for translation.
      */
      if (settings.githubImportAutoTranslate !== true) {
        res.json({ translations: {}, enabled: false, targetLocale: null, capped: false });
        return;
      }

      const targetLocale = resolveTargetLocale(
        settings.importTranslateTargetLocale,
        requestedLocale,
        settings.language,
      );
      if (!targetLocale) {
        res.json({ translations: {}, enabled: true, targetLocale: null, capped: false });
        return;
      }

      const normalized = items
        .filter((item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
          number: Number(item.number),
          title: typeof item.title === "string" ? item.title : "",
          body: typeof item.body === "string" ? item.body : null,
          state: item.state === "closed" ? ("closed" as const) : ("open" as const),
        }))
        .filter((item) => Number.isInteger(item.number) && item.number > 0);

      const ctx = {
        store: scopedStore,
        rootDir: scopedStore.getRootDir(),
        provider: "github" as const,
        repoKey: `${owner}/${repo}`,
        targetLocale,
      };

      /*
      FNXC:GitHubImportTranslate 2026-07-15-14:10:
      Charge the budget for MODEL CALLS ONLY — partition against the durable cache BEFORE reserving.
      Reserving per foreign issue meant reopening a panel of 50 cached issues burned 50 slots while calling the model zero times, rate-limiting the panel for the rest of the hour despite costing nothing (PR #2141 review, P1).
      The `capped` flag likewise reflects eligible issues (what the operator sees capped), while `cost` reflects only the uncached ones.
      */
      const allEligible = normalized.filter((item) => isTranslatable(item, targetLocale));
      const eligible = selectEligibleItems(normalized, targetLocale);
      const capped = allEligible.length > eligible.length;
      const partition = await partitionImportItemsByCache(ctx, eligible);
      const cost = partition.uncached.length;

      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (cost > 0 && !checkTranslateRateLimit(ip, cost)) {
        const resetTime = getTranslateRateLimitResetTime(ip);
        throw rateLimited(
          `Translation rate limit exceeded. Reset at ${resetTime?.toISOString() || "unknown"}`,
        );
      }

      const translated = await translateImportItems(ctx, normalized, partition);

      const translations: Record<number, { title: string; body: string }> = {};
      for (const [number, value] of translated) {
        translations[number] = { title: value.title, body: value.body };
      }
      res.json({ translations, enabled: true, targetLocale, capped });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/github/issues/batch-import
   * Import multiple GitHub issues as fn tasks with throttling.
   * Body: { owner: string, repo: string, issueNumbers: number[], delayMs?: number }
   * Returns: { results: BatchImportResult[] }
   */
  // Batch import rate limiter: max 1 request per 10 seconds per IP
  const batchImportRateLimiter = createBatchImportRateLimiter();

  router.post("/github/issues/batch-import", batchImportRateLimiter, async (req, res) => {
    try {
      const { owner, repo, issueNumbers, delayMs } = req.body;

      // Validate owner
      if (!owner || typeof owner !== "string") {
        throw badRequest("owner is required");
      }

      // Validate repo
      if (!repo || typeof repo !== "string") {
        throw badRequest("repo is required");
      }

      // Validate issueNumbers
      if (!Array.isArray(issueNumbers)) {
        throw badRequest("issueNumbers is required and must be an array");
      }

      if (issueNumbers.length === 0) {
        throw badRequest("issueNumbers must contain at least 1 issue number");
      }

      if (issueNumbers.length > 50) {
        throw badRequest("issueNumbers cannot contain more than 50 issue numbers");
      }

      if (!issueNumbers.every((n) => typeof n === "number" && n > 0 && Number.isInteger(n))) {
        throw badRequest("issueNumbers must contain only positive integers");
      }

      const token = process.env.GITHUB_TOKEN;
      const githubClient = new GitHubClient(token);
      const { store: scopedStore } = await getProjectContext(req);

      // Get existing tasks to check for duplicates
      const existingTasks = await scopedStore.listTasks({ slim: false, includeArchived: false });
      const projectSettings = await scopedStore.getSettings();
      const importedIssueGithubTracking = await resolveImportedIssueGithubTracking(scopedStore, projectSettings);

      // Process issues sequentially with throttling
      const results: Array<{
        issueNumber: number;
        success: boolean;
        taskId?: string;
        error?: string;
        skipped?: boolean;
        retryAfter?: number;
      }> = [];

      for (const issueNumber of issueNumbers) {
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`;

        // Use throttled fetch to avoid rate limits
        /*
        FNXC:GitHubImportTranslate 2026-07-15-09:30:
        `state` is surfaced on the batch fetch so batch import applies the same closed-issue rule as single import: a closed issue never serves a cached translation.
        */
        /*
        FNXC:IssueImportAttachments 2026-07-15-13:40:
        `comments` (a count, free on the REST issue payload) is surfaced so batch import can skip the comment fetch entirely for issues that have none — a 50-issue batch must not pay 50 extra round trips to discover empty threads.
        */
        const fetchResult = await githubClient.fetchThrottled<{
          number: number;
          title: string;
          body: string | null;
          html_url: string;
          state?: "open" | "closed";
          comments?: number;
          pull_request?: unknown;
        }>(url, {}, { delayMs: delayMs ?? 1000, maxRetries: 3 });

        if (!fetchResult.success) {
          results.push({
            issueNumber,
            success: false,
            error: fetchResult.error ?? "Failed to fetch issue",
            retryAfter: fetchResult.retryAfter,
          });
          continue;
        }

        const issue = fetchResult.data!;

        // Check if it's a pull request
        if (issue.pull_request) {
          results.push({
            issueNumber,
            success: false,
            error: "This is a pull request, not an issue",
          });
          continue;
        }

        // Check if already imported
        const sourceUrl = issue.html_url;
        const existingTask = existingTasks.find((t) => isGitHubIssueAlreadyImported(t, { owner, repo, issueNumber, sourceUrl }));
        if (existingTask) {
          results.push({
            issueNumber,
            success: true,
            skipped: true,
            taskId: existingTask.id,
          });
          continue;
        }

        /*
        FNXC:GitHubImportTranslate 2026-07-15-09:30:
        Batch import carries translations exactly like single import (shared helper) — the requirement is about imported issues, not about which import button was used.
        */
        const batchTranslation = await resolveImportedIssueTranslation(
          req,
          scopedStore,
          owner,
          repo,
          {
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state === "closed" ? "closed" : "open",
          },
          projectSettings,
        );
        const title = (batchTranslation?.title || issue.title).slice(0, 200);
        const body = (batchTranslation?.body ?? issue.body)?.trim() || "(no description)";
        const description = `${body}\n\nSource: ${sourceUrl}`;

        try {
          const source = buildGitHubIssueSource(owner, repo, issue);
          // FNXC:Workflows 2026-07-05-00:00: FN-7611 — no workflowId here; let the store
          // resolve the project-default workflow's intake column (byte-identical "triage"
          // for builtin:coding).
          const task = await scopedStore.createTask({
            title: title || undefined,
            description,
            dependencies: [],
            sourceIssue: source.sourceIssue,
            source: {
              sourceType: "github_import",
              sourceMetadata: source.sourceMetadata,
            },
            ...(importedIssueGithubTracking ? { githubTracking: importedIssueGithubTracking } : {}),
          });

          // Log the import action
          await scopedStore.logEntry(task.id, "Imported from GitHub", sourceUrl);

          /*
          FNXC:IssueImportAttachments 2026-07-15-11:20:
          Batch import attaches issue screenshots exactly like single import (shared helper) — the requirement is about imported issues, not about which import button was used.
          Comments are only fetched when the issue reports a non-zero comment count, so a batch of comment-free issues costs no extra requests.
          */
          const batchImageBodies: Array<string | null | undefined> = [issue.body];
          if ((issue.comments ?? 0) > 0) {
            try {
              const detail = await githubClient.getIssueDetail(owner, repo, issueNumber);
              batchImageBodies.push(...detail.comments.map((comment) => comment.body));
            } catch (err) {
              console.warn(
                `[fusion:github-import] Could not fetch comments for ${owner}/${repo}#${issueNumber}; importing body images only: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          const batchImageImport = await importIssueImageAttachments(
            scopedStore,
            task.id,
            batchImageBodies,
            githubImagePolicy({ token }),
          );
          if (batchImageImport.attached > 0) {
            /*
            FNXC:GitHubImportAttachments 2026-07-15-14:18:
            Attachment audit history is observability, not part of persistence. A failed log must not turn an already-created batch task into a reported failure that retries as a duplicate.
            */
            try {
              await scopedStore.logEntry(
                task.id,
                `Imported ${batchImageImport.attached} image attachment${batchImageImport.attached === 1 ? "" : "s"} from GitHub issue`,
                sourceUrl,
              );
            } catch (error) {
              console.warn(`[fusion:github-import] Could not log image attachments for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          results.push({
            issueNumber,
            success: true,
            taskId: task.id,
          });

          // Add to existingTasks to avoid duplicate imports within the same batch
          existingTasks.push(task);
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          results.push({
            issueNumber,
            success: false,
            error: (err instanceof Error ? err.message : String(err)) || "Failed to create task",
          });
        }
      }

      res.json({ results });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/github/pulls/fetch
   * Fetch open pull requests from a GitHub repository.
   * Body: { owner: string, repo: string, limit?: number }
   * Returns: Array of GitHubPull objects
   */
  router.post("/github/pulls/fetch", async (req, res) => {
    try {
      const { owner, repo, limit = 30 } = req.body;

      if (!owner || typeof owner !== "string") {
        throw badRequest("owner is required");
      }
      if (!repo || typeof repo !== "string") {
        throw badRequest("repo is required");
      }

      // Check gh authentication
      if (!isGhAuthenticated()) {
        throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
      }

      const client = new GitHubClient();

      try {
        const pulls = await client.listPullRequests(owner, repo, { limit });
        res.json(pulls);
      } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
        // Handle specific error cases from gh CLI
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          throw notFound(`Repository not found: ${owner}/${repo}`);
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
        }

        throw new ApiError(502, `GitHub CLI error: ${errorMessage}`);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /*
  FNXC:GitHubImport 2026-06-23-01:00:
  POST /api/github/pulls/detail — per-PR detail fetch for the Import Tasks PR preview pane.
  `gh pr list` only yields comment COUNT + no per-check status, so the preview fetches the FULL comment thread + per-check status ON SELECTION via this route (never for the whole list — too expensive).
  Body: { repo: string ("owner/name"), number: number }. Returns { comments, checks }.
  */
  router.post("/github/pulls/detail", async (req, res) => {
    try {
      const { repo, number } = req.body;

      if (!repo || typeof repo !== "string" || !repo.includes("/")) {
        throw badRequest("repo is required and must be in 'owner/name' form");
      }
      if (!number || typeof number !== "number" || number < 1) {
        throw badRequest("number is required and must be a positive number");
      }

      const [owner, repoName] = repo.split("/");
      if (!owner || !repoName) {
        throw badRequest("repo must be in 'owner/name' form");
      }

      if (!isGhAuthenticated()) {
        throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
      }

      const client = new GitHubClient();

      try {
        const detail = await client.getPullRequestDetail(owner, repoName, number);
        res.json(detail);
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw err;
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          throw notFound(`Pull request not found: ${repo}#${number}`);
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
        }
        throw new ApiError(502, `GitHub CLI error: ${errorMessage}`);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /*
  FNXC:GitHubImport 2026-06-23-03:15:
  POST /api/github/issues/detail — per-issue detail fetch for the Import Tasks issue preview pane.
  `gh issue list` yields no comment thread, so the preview fetches the FULL comment thread ON SELECTION (never for the whole list).
  Body: { repo: string ("owner/name"), number: number }. Returns { comments }. Mirrors pulls/detail auth/404/401 handling.
  */
  router.post("/github/issues/detail", async (req, res) => {
    try {
      const { repo, number } = req.body;

      if (!repo || typeof repo !== "string" || !repo.includes("/")) {
        throw badRequest("repo is required and must be in 'owner/name' form");
      }
      if (!number || typeof number !== "number" || number < 1) {
        throw badRequest("number is required and must be a positive number");
      }

      const [owner, repoName] = repo.split("/");
      if (!owner || !repoName) {
        throw badRequest("repo must be in 'owner/name' form");
      }

      if (!isGhAuthenticated()) {
        throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
      }

      const client = new GitHubClient();

      try {
        const detail = await client.getIssueDetail(owner, repoName, number);
        res.json(detail);
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw err;
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          throw notFound(`Issue not found: ${repo}#${number}`);
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
        }
        throw new ApiError(502, `GitHub CLI error: ${errorMessage}`);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /*
  FNXC:GitHubImport 2026-06-23-03:15:
  POST /api/github/issues/close — closes the selected issue from the Import Tasks preview pane (Close issue button).
  Body: { repo: string ("owner/name"), number: number }. Returns { ok: true }. Mirrors pulls/detail auth/404/401 handling.
  */
  router.post("/github/issues/close", async (req, res) => {
    try {
      const { repo, number } = req.body;

      if (!repo || typeof repo !== "string" || !repo.includes("/")) {
        throw badRequest("repo is required and must be in 'owner/name' form");
      }
      if (!number || typeof number !== "number" || number < 1) {
        throw badRequest("number is required and must be a positive number");
      }

      const [owner, repoName] = repo.split("/");
      if (!owner || !repoName) {
        throw badRequest("repo must be in 'owner/name' form");
      }

      if (!isGhAuthenticated()) {
        throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
      }

      const client = new GitHubClient();

      try {
        await client.closeIssue(owner, repoName, number);
        res.json({ ok: true });
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw err;
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          throw notFound(`Issue not found: ${repo}#${number}`);
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
        }
        throw new ApiError(502, `GitHub CLI error: ${errorMessage}`);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/github/pulls/import
   * Import a specific GitHub pull request as a fn review task.
   * Body: { owner: string, repo: string, prNumber: number }
   * Returns: Created Task object
   */
  router.post("/github/pulls/import", async (req, res) => {
    try {
      const { owner, repo, prNumber } = req.body;

      if (!owner || typeof owner !== "string") {
        throw badRequest("owner is required");
      }
      if (!repo || typeof repo !== "string") {
        throw badRequest("repo is required");
      }
      if (!prNumber || typeof prNumber !== "number" || prNumber < 1) {
        throw badRequest("prNumber is required and must be a positive number");
      }

      // Check gh authentication
      if (!isGhAuthenticated()) {
        throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
      }

      const client = new GitHubClient();
      const { store: scopedStore } = await getProjectContext(req);

      let pr: {
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        headBranch: string;
        baseBranch: string;
        state: "open" | "closed" | "merged";
      } | null;

      try {
        pr = await client.getPullRequest(owner, repo, prNumber);

        if (pr === null) {
          throw notFound(`PR #${prNumber} not found in ${owner}/${repo}`);
        }
      } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          throw notFound(`PR #${prNumber} not found in ${owner}/${repo}`);
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
        }

        throw new ApiError(502, `GitHub CLI error: ${errorMessage}`);
      }

      // Check if already imported
      const existingTasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
      const sourceUrl = pr.html_url;
      for (const existingTask of existingTasks) {
        if (existingTask.description.includes(sourceUrl)) {
          throw new ApiError(409, `PR #${prNumber} already imported as ${existingTask.id}`, {
            existingTaskId: existingTask.id,
          });
        }
      }

      /*
      FNXC:GitHubImport 2026-07-16-18:00:
      PR imports are resolve-feedback work, so their executor prompt must explicitly cover reviewer feedback and failed CI while retaining URL, branch, and body provenance for deduplication and auditability.
      */
      const title = `Resolve feedback: PR #${pr.number} — ${pr.title.slice(0, 180)}`;
      const body = pr.body?.trim() || "(no description)";
      const description = `Resolve the pull request review feedback and address any failed CI checks.\n\nPR: ${sourceUrl}\nBranch: ${pr.headBranch} → ${pr.baseBranch}\n\n${body}`;

      // FNXC:Workflows 2026-07-05-00:00: FN-7611 — no workflowId here; let the store
      // resolve the project-default workflow's intake column (byte-identical "triage"
      // for builtin:coding).
      const task = await scopedStore.createTask({
        title: title || undefined,
        description,
        dependencies: [],
        source: {
          sourceType: "github_import",
          sourceMetadata: { prUrl: sourceUrl, prNumber },
        },
      });

      // Log the import action
      await scopedStore.logEntry(task.id, "Imported PR from GitHub", sourceUrl);

      res.status(201).json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /*
  FNXC:GitHubImport 2026-07-16-18:00:
  A reviewer or bot comment can become independent resolve-feedback work. Comments expose no stable source ID/URL, so repeated imports intentionally create separate tasks rather than applying PR-style deduplication.
  */
  router.post("/github/comments/import", async (req, res) => {
    try {
      const { owner, repo, number, type, comment } = req.body ?? {};
      const author = comment?.author;
      const body = comment?.body;

      if (!owner || typeof owner !== "string" || !owner.trim()) throw badRequest("owner is required");
      if (!repo || typeof repo !== "string" || !repo.trim()) throw badRequest("repo is required");
      if (!Number.isInteger(number) || number < 1) throw badRequest("number is required and must be a positive number");
      if (type !== "issue" && type !== "pull") throw badRequest("type must be 'issue' or 'pull'");
      if (!author || typeof author !== "string" || !author.trim()) throw badRequest("comment.author is required");
      if (!body || typeof body !== "string" || !body.trim()) throw badRequest("comment.body is required");
      if (comment.createdAt !== undefined && (typeof comment.createdAt !== "string" || !comment.createdAt.trim())) {
        throw badRequest("comment.createdAt must be a non-empty string when provided");
      }
      if (!isGhAuthenticated()) throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");

      const { store: scopedStore } = await getProjectContext(req);
      const sourceUrl = `https://github.com/${owner.trim()}/${repo.trim()}/${type === "pull" ? "pull" : "issues"}/${number}`;
      const task = await scopedStore.createTask({
        title: `Resolve feedback from @${author.trim()} on #${number}`,
        description: `Resolve or address this feedback comment.\n\n> ${author.trim()}\n> ${body.trim().replace(/\n/g, "\n> ")}\n\nSource: ${sourceUrl}`,
        dependencies: [],
        source: {
          sourceType: "github_import",
          sourceMetadata: { sourceUrl, number, type, commentAuthor: author.trim(), commentCreatedAt: comment.createdAt },
        },
      });
      await scopedStore.logEntry(task.id, "Imported PR/issue comment from GitHub", sourceUrl);
      res.status(201).json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/github/webhooks
   * GitHub App webhook endpoint for badge updates.
   * Accepts signed webhook deliveries for pull_request, issues, and issue_comment events.
   * Verifies X-Hub-Signature-256, fetches canonical badge state, and updates matching tasks.
   * 
   * Responses:
   * - 200: Valid ping event
   * - 202: Valid but unsupported/irrelevant event
   * - 401: Missing required webhook auth headers
   * - 403: Signature mismatch/tampering detected
   * - 503: GitHub App configuration missing or incomplete
   * - 500: Installation token refresh failed
   */
  router.post("/github/webhooks", async (req, res) => {
    const config = getGitHubAppConfig();
    if (!config) {
      throw new ApiError(503, "GitHub App not configured");
    }

    // Get raw body (Buffer from express.raw() middleware)
    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody)) {
      throw badRequest("Invalid request body");
    }

    // Verify signature
    const signatureHeader = req.headers["x-hub-signature-256"] as string | undefined;
    const verification = verifyWebhookSignature(rawBody, signatureHeader, config.webhookSecret);
    if (!verification.valid) {
      throw new ApiError(403, verification.error ?? "Invalid signature");
    }

    // Parse payload after verification
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      throw badRequest("Invalid JSON payload");
    }

    // Classify event
    const eventType = req.headers["x-github-event"] as string | undefined;
    const classification = classifyWebhookEvent(eventType, payload);

    // Handle ping
    if (eventType === "ping") {
      res.status(200).json({ message: "Pong" });
      return;
    }

    // Unsupported event
    if (!classification.supported) {
      res.status(202).json({ message: "Event type not supported" });
      return;
    }

    // Not relevant for badge updates (e.g., issue_comment on regular issue)
    if (!classification.relevant) {
      res.status(202).json({ message: "Event not relevant for badges" });
      return;
    }

    // Missing required data
    if (!classification.owner || !classification.repo || classification.number === undefined || !classification.installationId) {
      throw badRequest("Missing repository or installation data");
    }

    // Fetch installation token
    const installationToken = await GitHubClient.fetchInstallationToken(
      classification.installationId,
      config.appId,
      config.privateKey,
    );
    if (!installationToken) {
      throw internalError("Failed to fetch installation token");
    }

    // Fetch canonical badge state
    let badgeData: Omit<PrInfo, "lastCheckedAt"> | Omit<import("@fusion/core").IssueInfo, "lastCheckedAt"> | null = null;
    if (classification.resourceType === "pr") {
      badgeData = await GitHubClient.fetchPrWithInstallationToken(
        classification.owner,
        classification.repo,
        classification.number,
        installationToken,
      );
    } else {
      badgeData = await GitHubClient.fetchIssueWithInstallationToken(
        classification.owner,
        classification.repo,
        classification.number,
        installationToken,
      );
    }

    if (!badgeData) {
      res.status(202).json({ message: "Badge resource not found or inaccessible" });
      return;
    }

    // Find all matching tasks by badge URL (use project-scoped store if projectId is provided)
    const { store: scopedStore } = await getProjectContext(req);
    const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
    const matchingTasks: Array<{ id: string; resourceType: "pr" | "issue"; current: unknown }> = [];

    for (const task of tasks) {
      if (classification.resourceType === "pr" && task.prInfo) {
        const parsed = parseBadgeUrl(task.prInfo.url);
        if (parsed && 
            parsed.owner.toLowerCase() === classification.owner!.toLowerCase() &&
            parsed.repo.toLowerCase() === classification.repo!.toLowerCase() &&
            parsed.number === classification.number) {
          matchingTasks.push({ id: task.id, resourceType: "pr", current: task.prInfo });
        }
      } else if (classification.resourceType === "issue" && task.issueInfo) {
        const parsed = parseBadgeUrl(task.issueInfo.url);
        if (parsed &&
            parsed.owner.toLowerCase() === classification.owner!.toLowerCase() &&
            parsed.repo.toLowerCase() === classification.repo!.toLowerCase() &&
            parsed.number === classification.number) {
          matchingTasks.push({ id: task.id, resourceType: "issue", current: task.issueInfo });
        }
      }
    }

    if (matchingTasks.length === 0) {
      res.status(202).json({ message: "No tasks linked to this resource" });
      return;
    }

    // Update matching tasks
    const checkedAt = new Date().toISOString();
    let badgeFieldsChanged = false;

    for (const match of matchingTasks) {
      if (match.resourceType === "pr") {
        const current = match.current as PrInfo;
        /*
        FNXC:PrAutoMergeGate 2026-06-28-01:39:
        FN-7182: GitHub status refresh payloads do not carry Fusion provenance. Preserve `manual` so a badge refresh cannot erase the human PR handoff and re-enable auto-merge.
        */
        const next: PrInfo = { ...current, ...(badgeData as Omit<PrInfo, "lastCheckedAt">), manual: current.manual, lastCheckedAt: checkedAt };
        const changed = hasPrBadgeFieldsChanged(current, badgeData as Omit<PrInfo, "lastCheckedAt">);
        if (changed || current.lastCheckedAt !== checkedAt) {
          await scopedStore.updatePrInfo(match.id, next);
          if (changed) badgeFieldsChanged = true;
        }
      } else {
        const current = match.current as import("@fusion/core").IssueInfo;
        const next = { ...(badgeData as Omit<import("@fusion/core").IssueInfo, "lastCheckedAt">), lastCheckedAt: checkedAt };
        const changed = hasIssueBadgeFieldsChanged(current, badgeData as Omit<import("@fusion/core").IssueInfo, "lastCheckedAt">);
        if (changed || current.lastCheckedAt !== checkedAt) {
          await scopedStore.updateIssueInfo(match.id, next);
          if (changed) badgeFieldsChanged = true;
        }
      }
    }

    res.status(200).json({
      updated: matchingTasks.length,
      tasks: matchingTasks.map(m => m.id),
      badgeFieldsChanged,
    });
  });

  /**
   * POST /api/github/batch/status
   * Refresh issue/PR badge status for up to 100 tasks in grouped GitHub requests.
   * Body: { taskIds: string[] }
   */
  router.post("/github/batch/status", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { taskIds } = (req.body ?? {}) as import("@fusion/core").BatchStatusRequest;
      if (!Array.isArray(taskIds)) {
        throw badRequest("taskIds must be an array");
      }
      if (taskIds.some((taskId) => typeof taskId !== "string" || taskId.trim().length === 0)) {
        throw badRequest("taskIds must contain non-empty strings");
      }
      if (taskIds.length > 100) {
        throw badRequest("taskIds must contain at most 100 items");
      }
      if (taskIds.length === 0) {
        res.json({ results: {} } satisfies BatchStatusResponse);
        return;
      }

      const fallbackRepo = getDefaultGitHubRepo(scopedStore);
      const results: BatchStatusResult = {};
      const issueGroups = new Map<string, { owner: string; repo: string; numbers: Set<number>; taskIds: Set<string> }>();
      const prGroups = new Map<string, { owner: string; repo: string; numbers: Set<number>; taskIds: Set<string> }>();
      const tasksById = new Map<string, Awaited<ReturnType<TaskStore["getTask"]>>>();

      for (const taskId of taskIds) {
        try {
          const task = await scopedStore.getTask(taskId);
          tasksById.set(taskId, task);

          const entry = ensureBatchStatusEntry(results, taskId);
          if (task.issueInfo) entry.issueInfo = task.issueInfo;
          if (task.prInfo) entry.prInfo = task.prInfo;
          entry.stale = Boolean(
            (task.issueInfo && isBatchStatusStale(task.issueInfo, task.updatedAt))
            || (task.prInfo && isBatchStatusStale(task.prInfo, task.updatedAt)),
          );

          if (!task.issueInfo && !task.prInfo) {
            appendBatchStatusError(results, taskId, "Task has no GitHub badge metadata");
            continue;
          }

          if (task.issueInfo) {
            const issueRepo = parseGitHubBadgeUrl(task.issueInfo.url) ?? fallbackRepo;
            if (!issueRepo) {
              appendBatchStatusError(results, taskId, "Could not determine GitHub repository for issue badge");
            } else {
              const repoKey = `${issueRepo.owner}/${issueRepo.repo}`;
              const group = issueGroups.get(repoKey) ?? {
                owner: issueRepo.owner,
                repo: issueRepo.repo,
                numbers: new Set<number>(),
                taskIds: new Set<string>(),
              };
              group.numbers.add(task.issueInfo.number);
              group.taskIds.add(taskId);
              issueGroups.set(repoKey, group);
            }
          }

          if (task.prInfo) {
            const prRepo = parseGitHubBadgeUrl(task.prInfo.url) ?? fallbackRepo;
            if (!prRepo) {
              appendBatchStatusError(results, taskId, "Could not determine GitHub repository for PR badge");
            } else {
              const repoKey = `${prRepo.owner}/${prRepo.repo}`;
              const group = prGroups.get(repoKey) ?? {
                owner: prRepo.owner,
                repo: prRepo.repo,
                numbers: new Set<number>(),
                taskIds: new Set<string>(),
              };
              group.numbers.add(task.prInfo.number);
              group.taskIds.add(taskId);
              prGroups.set(repoKey, group);
            }
          }
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            appendBatchStatusError(results, taskId, `Task ${taskId} not found`);
          } else {
            appendBatchStatusError(results, taskId, err instanceof Error ? err.message : String(err) || `Failed to load task ${taskId}`);
          }
        }
      }

      const client = new GitHubClient(githubToken);
      const applyIssueGroup = async (group: { owner: string; repo: string; numbers: Set<number>; taskIds: Set<string> }) => {
        const repoKey = `${group.owner}/${group.repo}`;
        if (!githubRateLimiter.canMakeRequest(repoKey)) {
          const resetTime = githubRateLimiter.getResetTime(repoKey);
          const retryAfter = resetTime
            ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
            : undefined;
          throw new ApiError(429, "GitHub API rate limit exceeded for this repository", {
            retryAfter,
            resetAt: resetTime?.toISOString(),
          });
        }

        try {
          const issueStatuses = await client.getBatchIssueStatus(group.owner, group.repo, [...group.numbers]);
          const refreshedAt = new Date().toISOString();

          for (const taskId of group.taskIds) {
            const task = tasksById.get(taskId);
            if (!task?.issueInfo) continue;
            const issueInfo = issueStatuses.get(task.issueInfo.number);
            if (!issueInfo) {
              appendBatchStatusError(results, taskId, `Issue #${task.issueInfo.number} not found in ${group.owner}/${group.repo}`);
              continue;
            }

            const updatedIssueInfo: IssueInfo = {
              ...issueInfo,
              lastCheckedAt: refreshedAt,
            };
            await scopedStore.updateIssueInfo(taskId, updatedIssueInfo);
            const entry = ensureBatchStatusEntry(results, taskId);
            entry.issueInfo = updatedIssueInfo;
            entry.stale = entry.prInfo ? isBatchStatusStale(entry.prInfo, task.updatedAt) : false;
          }
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          for (const taskId of group.taskIds) {
            appendBatchStatusError(results, taskId, (err instanceof Error ? err.message : String(err)) || `Failed to refresh issue badges for ${repoKey}`);
          }
        }

        return true;
      };

      const applyPrGroup = async (group: { owner: string; repo: string; numbers: Set<number>; taskIds: Set<string> }) => {
        const repoKey = `${group.owner}/${group.repo}`;
        if (!githubRateLimiter.canMakeRequest(repoKey)) {
          const resetTime = githubRateLimiter.getResetTime(repoKey);
          const retryAfter = resetTime
            ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
            : undefined;
          throw new ApiError(429, "GitHub API rate limit exceeded for this repository", {
            retryAfter,
            resetAt: resetTime?.toISOString(),
          });
        }

        try {
          const prStatuses = await client.getBatchPrStatus(group.owner, group.repo, [...group.numbers]);
          const refreshedAt = new Date().toISOString();

          for (const taskId of group.taskIds) {
            const task = tasksById.get(taskId);
            if (!task?.prInfo) continue;
            const prInfo = prStatuses.get(task.prInfo.number);
            if (!prInfo) {
              appendBatchStatusError(results, taskId, `PR #${task.prInfo.number} not found in ${group.owner}/${group.repo}`);
              continue;
            }

            const updatedPrInfo: PrInfo = {
              ...task.prInfo,
              ...prInfo,
              manual: task.prInfo.manual,
              lastCheckedAt: refreshedAt,
            };
            await scopedStore.updatePrInfo(taskId, updatedPrInfo);
            const entry = ensureBatchStatusEntry(results, taskId);
            entry.prInfo = updatedPrInfo;
            entry.stale = entry.issueInfo ? isBatchStatusStale(entry.issueInfo, task.updatedAt) : false;
          }
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          for (const taskId of group.taskIds) {
            appendBatchStatusError(results, taskId, (err instanceof Error ? err.message : String(err)) || `Failed to refresh PR badges for ${repoKey}`);
          }
        }

        return true;
      };

      for (const group of issueGroups.values()) {
        const shouldContinue = await applyIssueGroup(group);
        if (!shouldContinue) return;
      }
      for (const group of prGroups.values()) {
        const shouldContinue = await applyPrGroup(group);
        if (!shouldContinue) return;
      }

      for (const taskId of taskIds) {
        ensureBatchStatusEntry(results, taskId);
      }

      res.json({ results } satisfies BatchStatusResponse);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to batch refresh GitHub status");
    }
  });


  // ── PR Management Routes ─────────────────────────────────────────

  /**
   * POST /api/tasks/:id/pr/create
   * Create a GitHub PR for an in-review task.
   * Body: { title: string, body: string, base?: string }
   * Returns: Created PrInfo
   */
  router.post("/tasks/:id/pr/create", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { title, body, base } = req.body;

      // Get task and validate
      const task = await scopedStore.getTask(req.params.id);
      if (task.column !== "in-review") {
        throw badRequest("Task must be in 'in-review' column to create a PR");
      }

      if (!title || typeof title !== "string") {
        throw badRequest("title is required and must be a string");
      }
      if (!body || typeof body !== "string" || !body.trim()) {
        throw badRequest("body is required and must be a non-empty string");
      }
      const prTitle = title.trim();
      const prBody = body.trim();

      const existingPrs = getTaskPrList(task);

      // Determine branch name from task
      const branchName = `fusion/${task.id.toLowerCase()}`;

      // Get owner/repo from git remote or GITHUB_REPOSITORY env
      let owner: string;
      let repo: string;

      const envRepo = process.env.GITHUB_REPOSITORY;
      if (envRepo) {
        const [o, r] = envRepo.split("/");
        owner = o;
        repo = r;
      } else {
        const gitRepo = getCurrentRepo(scopedStore.getRootDir());
        if (!gitRepo) {
          throw badRequest("Could not determine GitHub repository. Set GITHUB_REPOSITORY env var or configure git remote.");
        }
        owner = gitRepo.owner;
        repo = gitRepo.repo;
      }

      // Check rate limit
      const repoKey = `${owner}/${repo}`;
      if (!githubRateLimiter.canMakeRequest(repoKey)) {
        const resetTime = githubRateLimiter.getResetTime(repoKey);
        const retryAfter = resetTime
          ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
          : undefined;
        throw new ApiError(429, "GitHub API rate limit exceeded for this repository", {
          retryAfter,
          resetAt: resetTime?.toISOString(),
        });
      }

      const client = new GitHubClient();
      const existingPr = await client.findPrForBranch({ head: branchName, state: "all", owner, repo });

      let prInfo: PrInfo;
      if (existingPr) {
        prInfo = { ...existingPr, manual: true };
      } else {
        await runGitCommand(["push", "-u", "origin", branchName], scopedStore.getRootDir(), 60_000);
        const createdPrInfo = await client.createPr({
          owner,
          repo,
          title: prTitle,
          body: prBody,
          head: branchName,
          base,
        });
        prInfo = { ...createdPrInfo, manual: true };
      }

      /*
      FNXC:PrAutoMergeGate 2026-06-28-00:33:
      FN-7182: Create PR is an explicit human handoff. Persist `manual: true` only for dashboard-created/linked PRs so automatic merge processing stands down while manual Merge PR and PR monitor completion still work.
      */
      // Store PR info
      if (existingPrs.length > 0) {
        await scopedStore.addPrInfo(task.id, prInfo);
      } else {
        await scopedStore.updatePrInfo(task.id, prInfo);
      }
      await scopedStore.logEntry(task.id, existingPr ? "Linked existing PR" : "Created PR", `PR #${prInfo.number}: ${prInfo.url}`);

      res.status(201).json(prInfo);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else if ((err instanceof Error ? err.message : String(err)).includes("already exists")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("No commits between")) {
        throw badRequest("Branch has no commits. Push changes before creating PR.");
      } else {
        throw toPrApiError(err, "Failed to create PR");
      }
    }
  });

  /**
   * POST /api/tasks/:id/pr/push-branch
   * Push the task branch to origin and return refreshed preflight state.
   */
  router.post("/tasks/:id/pr/push-branch", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (task.column !== "in-review") {
        throw badRequest("Task must be in 'in-review' column to push PR branch");
      }

      if (req.body?.base !== undefined && typeof req.body.base !== "string") {
        throw badRequest("base must be a string when provided");
      }

      const repoRoot = scopedStore.getRootDir();
      const requestedBase = typeof req.body?.base === "string" ? req.body.base.trim() : "";
      const defaultBaseBranch = requestedBase || await resolveDefaultPrBaseBranch(task, repoRoot);
      const baseBranch = ensureSafeGitRef(defaultBaseBranch, "base branch");
      const head = ensureSafeGitRef(`fusion/${task.id.toLowerCase()}`, "head branch");
      const headRef = `refs/heads/${head}`;
      const baseRef = await resolvePrBaseRef(repoRoot, baseBranch).catch(() => baseBranch);

      try {
        await runGitCommand(["rev-parse", "--verify", headRef], repoRoot, 10_000);
      } catch {
        throw badRequest(`Branch ${head} does not exist locally. Commit changes before creating a PR.`);
      }

      let commitCount = 0;
      try {
        const commitCountOutput = await runGitCommand(["rev-list", "--count", `${baseRef}..${head}`], repoRoot, 10_000);
        commitCount = Number.parseInt(commitCountOutput, 10);
      } catch {
        throw badRequest(`Branch ${head} does not exist locally. Commit changes before creating a PR.`);
      }

      if (!Number.isFinite(commitCount) || commitCount <= 0) {
        throw badRequest("Branch has no commits. Push changes before creating PR.");
      }

      await runGitCommand(["push", "-u", "origin", head], repoRoot, 60_000);
      await scopedStore.logEntry(task.id, "Pushed PR branch", head);

      const preflight = await computePrPreflight(task, repoRoot, baseBranch);
      res.json({
        result: {
          pushed: true,
          head,
          message: `Pushed ${head} to origin.`,
        },
        preflight,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      if ((err instanceof Error ? err.message : String(err)).includes("already exists")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      }
      throw toPrApiError(err, "Failed to push PR branch");
    }
  });

  /**
   * POST /api/tasks/:id/pr/resolve-conflicts
   * Resolve Create-PR merge conflicts on the task branch, push the branch,
   * and return refreshed preflight state.
   */
  router.post("/tasks/:id/pr/resolve-conflicts", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (task.column !== "in-review") {
        throw badRequest("Task must be in 'in-review' column to resolve PR conflicts");
      }

      if (req.body?.base !== undefined && typeof req.body.base !== "string") {
        throw badRequest("base must be a string when provided");
      }

      const repoRoot = scopedStore.getRootDir();
      const envRepo = process.env.GITHUB_REPOSITORY?.trim();
      const repoInfo = envRepo
        ? (() => {
            const [owner = "", repo = ""] = envRepo.split("/");
            return owner && repo ? { owner, repo } : null;
          })()
        : getCurrentRepo(repoRoot);
      if (!repoInfo) {
        throw badRequest("Could not determine GitHub repository. Set GITHUB_REPOSITORY env var or configure git remote.");
      }

      const requestedBase = typeof req.body?.base === "string" ? req.body.base.trim() : "";
      const defaultBaseBranch = requestedBase || await resolveDefaultPrBaseBranch(task, repoRoot);
      const baseBranch = ensureSafeGitRef(defaultBaseBranch, "base branch");
      const head = ensureSafeGitRef(`fusion/${task.id.toLowerCase()}`, "head branch");
      const baseRef = await resolvePrBaseRef(repoRoot, baseBranch).catch(() => baseBranch);

      /*
      FNXC:GrokCliRouting 2026-07-15-09:58:
      Create-PR conflict resolution must forward a real PluginRunner (getRuntimeById) so grok-cli/no-key sessions resolve the Grok CLI runtime. Prefer the project engine runner (same pattern as resolveChatManagerPluginRunner); never pass a bare PluginLoader which lacks getRuntimeById. Fall back to options.pluginRunner only when it actually exposes getRuntimeById (UI-only may only have the loader — omit in that case so dual-remediation surfaces cleanly).
      */
      const engineRunner = engine?.getPluginRunner?.();
      const optionsRunner = options?.pluginRunner;
      const pluginRunner =
        engineRunner
        ?? (typeof optionsRunner?.getRuntimeById === "function" ? optionsRunner : undefined);

      const result = await resolvePrConflicts({
        taskId: task.id,
        baseRef,
        rootDir: repoRoot,
        store: scopedStore,
        settings: await scopedStore.getSettings(),
        pluginRunner,
      });

      if (!result.resolved) {
        throw conflict(result.message, {
          code: "conflict-resolution-failed",
          retryable: true,
          unresolvedFiles: result.conflictedFiles,
          head,
          base: baseBranch,
        });
      }

      await scopedStore.logEntry(task.id, "AI resolved PR conflicts", `${head} against ${baseRef} in ${repoInfo.owner}/${repoInfo.repo}`);
      if (result.pushed) {
        await scopedStore.logEntry(task.id, "Pushed branch after PR conflict resolution", head);
      }

      const preflight = await computePrPreflight(task, repoRoot, baseBranch);
      res.json({ result, preflight });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      throw toPrApiError(err, "Failed to resolve PR conflicts");
    }
  });

  /**
   * POST /api/tasks/:id/pr/generate-metadata
   * Generate AI PR title/body metadata for the Create PR dialog.
   * Returns: { title, body, templateUsed }
   */
  router.post("/tasks/:id/pr/generate-metadata", async (req, res) => {
    const controller = new AbortController();
    let responseCompleted = false;
    const abortRequest = () => {
      if (!responseCompleted && !controller.signal.aborted) {
        const error = new Error("PR metadata request aborted");
        error.name = "AbortError";
        controller.abort(error);
      }
    };
    const markCompleted = () => {
      responseCompleted = true;
    };
    req.on("aborted", abortRequest);
    res.on("close", abortRequest);
    res.on("finish", markCompleted);

    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const settings = await scopedStore.getSettings();
      /*
      FNXC:PrMetadataGeneration 2026-06-23-00:00:
      The dashboard route owns a shorter Create PR dialog budget than the reusable generator default. If a mocked or broken generator ignores aborts and never settles, return deterministic fallback metadata before the modal crosses the 30s UX threshold; do not treat the timeout abort as a disconnected-client signal.
      */
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const generatorPromise = generatePrMetadata({
        task,
        repoRoot: scopedStore.getRootDir(),
        settings,
        store: scopedStore,
        signal: controller.signal,
        timeoutMs: PR_METADATA_ROUTE_TIMEOUT_MS,
      });
      void generatorPromise.catch(() => undefined);
      const timeoutFallbackPromise = new Promise<Awaited<ReturnType<typeof generatePrMetadata>>>((resolve) => {
        timeoutId = setTimeout(() => {
          abortRequest();
          resolve(buildFallbackPrMetadata(task));
        }, PR_METADATA_ROUTE_TIMEOUT_MS);
      });
      let metadata: Awaited<ReturnType<typeof generatePrMetadata>>;
      try {
        metadata = await Promise.race([generatorPromise, timeoutFallbackPromise]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
      if (res.writableEnded || res.writableFinished || res.destroyed) {
        return;
      }
      res.json(metadata);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err, "Failed to generate PR metadata");
    } finally {
      req.removeListener("aborted", abortRequest);
      res.removeListener("close", abortRequest);
      res.removeListener("finish", markCompleted);
    }
  });

  /**
   * GET /api/tasks/:id/pr/preflight
   * Collect branch, commit, diff, conflict, and auth diagnostics for Create PR.
   */
  router.get("/tasks/:id/pr/preflight", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const repoRoot = scopedStore.getRootDir();
      const requestedBase = typeof req.query.base === "string" ? req.query.base.trim() : "";
      res.json(await computePrPreflight(task, repoRoot, requestedBase));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err, "Failed to load PR preflight");
    }
  });

  /**
   * GET /api/tasks/:id/pr/options
   * Load base branches, reviewers, assignees, and labels for Create PR.
   */
  router.get("/tasks/:id/pr/options", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const repoRoot = scopedStore.getRootDir();
      const envRepo = process.env.GITHUB_REPOSITORY;
      const gitRepo = getCurrentRepo(repoRoot);
      const [owner, repo] = envRepo?.split("/") ?? [gitRepo?.owner, gitRepo?.repo];
      if (!owner || !repo) {
        throw badRequest("Could not determine GitHub repository. Set GITHUB_REPOSITORY env var or configure git remote.");
      }

      const repoKey = `${owner}/${repo}`;
      const ghRequestsAllowed = githubRateLimiter.canMakeRequest(repoKey);
      const defaultBaseBranch = await resolveDefaultPrBaseBranch(task, repoRoot);

      const [ghBranchesResult, gitBranchesResult, collaboratorsResult, labelsResult] = await Promise.allSettled([
        ghRequestsAllowed
          ? prRouteCommandRunner.run(
            `gh api repos/${owner}/${repo}/branches --paginate -q '.[].name'`,
            repoRoot,
            PR_OPTIONS_TIMEOUT_MS,
          )
          : Promise.reject(new Error("GitHub API rate limited")),
        prRouteCommandRunner.run(
          "git for-each-ref refs/remotes/origin --format=%(refname:short)",
          repoRoot,
          PR_OPTIONS_TIMEOUT_MS,
        ),
        ghRequestsAllowed
          ? prRouteCommandRunner.run(
            `gh api repos/${owner}/${repo}/collaborators --paginate -q '.[] | {login, name: (.name // .login)}'`,
            repoRoot,
            PR_OPTIONS_TIMEOUT_MS,
          )
          : Promise.reject(new Error("GitHub API rate limited")),
        ghRequestsAllowed
          ? prRouteCommandRunner.run(
            `gh api repos/${owner}/${repo}/labels --paginate -q '.[] | {name, color}'`,
            repoRoot,
            PR_OPTIONS_TIMEOUT_MS,
          )
          : Promise.reject(new Error("GitHub API rate limited")),
      ]);

      const baseBranchSet = new Set<string>([defaultBaseBranch]);
      if (ghBranchesResult.status === "fulfilled") {
        for (const branch of ghBranchesResult.value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).slice(0, 100)) {
          baseBranchSet.add(branch);
        }
      }
      if (gitBranchesResult.status === "fulfilled") {
        for (const branch of gitBranchesResult.value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
          if (branch === "origin/HEAD") {
            continue;
          }
          baseBranchSet.add(branch.replace(/^origin\//, ""));
          if (baseBranchSet.size >= 100) {
            break;
          }
        }
      }

      const reviewers = collaboratorsResult.status === "fulfilled"
        ? parseGhJsonLines<{ login: string; name?: string }>(collaboratorsResult.value).slice(0, 50)
        : [];
      const labels = labelsResult.status === "fulfilled"
        ? parseGhJsonLines<{ name: string; color: string }>(labelsResult.value).slice(0, 50)
        : [];

      res.json({
        baseBranches: Array.from(baseBranchSet),
        reviewers,
        assignees: reviewers,
        labels,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err, "Failed to load PR options");
    }
  });

  /**
   * GET /api/tasks/:id/pr/status
   * Get cached PR status for a task. Triggers background refresh if stale (>5 min).
   * Uses only persisted badge timestamps (no in-memory poller state).
   */
  router.get("/tasks/:id/pr/status", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      const prList = getTaskPrList(task);
      if (prList.length === 0) {
        throw notFound("Task has no associated PR");
      }

      const primaryPr = prList[0];

      // Check if data is stale (>5 minutes since last check)
      const fiveMinutesMs = 5 * 60 * 1000;
      const lastChecked = primaryPr.lastCheckedAt || task.updatedAt;
      const lastCheckedTime = new Date(lastChecked).getTime();
      const isStale = Date.now() - lastCheckedTime > fiveMinutesMs;

      // Return cached data immediately
      res.json({
        prInfo: primaryPr,
        prInfos: prList,
        stale: isStale,
        automationStatus: task.status ?? null,
      });

      // Trigger background refresh if stale (don't await, let it run)
      if (isStale) {
        const settings = await scopedStore.getSettings();
        refreshPrInBackground(scopedStore, task.id, prList, githubToken, {
          repoRoot: scopedStore.getRootDir(),
          directMergeCommitStrategy: settings.directMergeCommitStrategy,
        });
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/tasks/:id/pr/refresh
   * Force refresh PR status from GitHub API.
   * Returns: Updated PrInfo
   */
  router.post("/tasks/:id/pr/refresh", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const prList = getTaskPrList(task);

      if (prList.length === 0) {
        throw notFound("Task has no associated PR");
      }

      let owner: string;
      let repo: string;
      const badgeParsed = parseBadgeUrl(prList[0].url);
      if (badgeParsed) {
        owner = badgeParsed.owner;
        repo = badgeParsed.repo;
      } else {
        const envRepo = process.env.GITHUB_REPOSITORY;
        if (envRepo) {
          const [o, r] = envRepo.split("/");
          owner = o;
          repo = r;
        } else {
          const gitRepo = getCurrentRepo(scopedStore.getRootDir());
          if (!gitRepo) throw badRequest("Could not determine GitHub repository");
          owner = gitRepo.owner;
          repo = gitRepo.repo;
        }
      }

      const repoKey = `${owner}/${repo}`;
      if (!githubRateLimiter.canMakeRequest(repoKey)) {
        const resetTime = githubRateLimiter.getResetTime(repoKey);
        const retryAfter = resetTime ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : undefined;
        throw new ApiError(429, "GitHub API rate limit exceeded for this repository", {
          retryAfter,
          resetAt: resetTime?.toISOString(),
        });
      }

      const settings = await scopedStore.getSettings();
      const client = new GitHubClient();
      const refreshedEntries: Array<{
        prInfo: PrInfo;
        conflictDiagnostics?: PrInfo["conflictDiagnostics"];
        mergeReady: boolean;
        mergeable?: PrInfo["mergeable"];
        blockingReasons: string[];
        reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
        checks: Array<{ name: string; required: boolean; state: string; detailsUrl?: string; startedAt?: string; completedAt?: string }>;
        automationStatus?: string | null;
        conflictReclaimQueued?: boolean;
      }> = [];
      const batchSize = 4;
      for (let i = 0; i < prList.length; i += batchSize) {
        const batch = prList.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(async (priorPr) => {
          const reviewSnapshot = await client.getPrReviewSnapshot(owner, repo, priorPr.number);
          const mergeStatus = await client.getPrMergeStatus(owner, repo, priorPr.number);
          let conflictDiagnostics = mergeStatus.prInfo.conflictDiagnostics;
          if (mergeStatus.prInfo.mergeable === "conflicting" && mergeStatus.prInfo.headBranch && mergeStatus.prInfo.baseBranch) {
            try {
              conflictDiagnostics = await client.getPrConflictDiagnostics(owner, repo, priorPr.number, {
                baseBranch: mergeStatus.prInfo.baseBranch,
                headBranch: mergeStatus.prInfo.headBranch,
                repoRoot: scopedStore.getRootDir(),
                directMergeCommitStrategy: settings.directMergeCommitStrategy,
              });
            } catch (err) {
              console.error("[pr-conflict-diagnostics]", err);
            }
          } else {
            conflictDiagnostics = undefined;
          }

          const prInfo: PrInfo = {
            ...priorPr,
            ...mergeStatus.prInfo,
            mergeable: mergeStatus.prInfo.mergeable,
            conflictDiagnostics,
            autoMergeOnGreen: priorPr.autoMergeOnGreen,
            autoMergeStrategy: priorPr.autoMergeStrategy,
            lastMergeError: priorPr.lastMergeError,
            lastMergeErrorAt: priorPr.lastMergeErrorAt,
            manual: priorPr.manual,
            draft: mergeStatus.prInfo.draft ?? mergeStatus.prInfo.isDraft,
            lastCheckedAt: new Date().toISOString(),
            lastReviewDecision: reviewSnapshot.decision,
          };

          await scopedStore.updatePrInfoByNumber(task.id, priorPr.number, prInfo);
          await syncPrReviewsToTask(scopedStore, task, reviewSnapshot);
          await applyChangesRequestedTransition(scopedStore, task, reviewSnapshot, prInfo);

          return {
            prInfo,
            conflictDiagnostics: prInfo.conflictDiagnostics,
            mergeReady: mergeStatus.mergeReady,
            mergeable: prInfo.mergeable,
            blockingReasons: mergeStatus.blockingReasons,
            reviewDecision: reviewSnapshot.decision,
            checks: mergeStatus.checks,
            automationStatus: task.status ?? null,
            conflictReclaimQueued: false,
          };
        }));
        refreshedEntries.push(...results);
      }

      const anyConflict = refreshedEntries.some((entry) => entry.prInfo.mergeable === "conflicting");
      let conflictReclaimQueued = false;
      if (anyConflict && task.branch && task.worktree) {
        const selfHealingManager =
          (engine as { getSelfHealingManager?: () => { reclaimPrConflictForTask: (taskId: string) => Promise<unknown> } } | undefined)?.getSelfHealingManager?.() ??
          (engine as { getRuntime?: () => { getSelfHealingManager?: () => { reclaimPrConflictForTask: (taskId: string) => Promise<unknown> } } } | undefined)
            ?.getRuntime?.()
            ?.getSelfHealingManager?.();
        if (selfHealingManager) {
          await selfHealingManager.reclaimPrConflictForTask(task.id);
          conflictReclaimQueued = true;
        }
      }

      const refreshedTask = await scopedStore.getTask(task.id);
      const latestPrs = getTaskPrList(refreshedTask);
      const primaryPr = refreshedTask.prInfo ?? latestPrs[0] ?? refreshedEntries[0]?.prInfo;
      const primaryEntry = refreshedEntries.find((entry) => entry.prInfo.number === primaryPr?.number) ?? refreshedEntries[0];
      if (!primaryEntry) {
        throw internalError("No refreshed PR entries were produced");
      }

      res.json({
        ...primaryEntry,
        prInfo: primaryEntry.prInfo,
        prInfos: latestPrs,
        primary: primaryEntry,
        all: refreshedEntries,
        automationStatus: refreshedTask.status ?? task.status ?? null,
        conflictReclaimQueued,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      throw toPrApiError(err, "Failed to refresh PR status");
    }
  });

  router.post("/tasks/:id/pr/:number/unlink", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const prNumber = Number.parseInt(req.params.number ?? "", 10);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        throw badRequest("PR number must be a positive integer");
      }

      const task = await scopedStore.getTask(req.params.id);
      const prList = getTaskPrList(task);
      if (!prList.some((pr) => pr.number === prNumber)) {
        throw notFound(`Task ${req.params.id} has no linked PR #${prNumber}`);
      }

      const updatedTask = await scopedStore.removePrInfoByNumber(task.id, prNumber);
      if (!updatedTask) {
        throw notFound(`Task ${req.params.id} not found`);
      }

      res.json({ task: updatedTask, prInfos: getTaskPrList(updatedTask) });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err, "Failed to unlink pull request");
    }
  });

  router.post("/tasks/:id/pr/reclaim-conflict", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task.prInfo) {
        throw notFound("Task has no associated PR");
      }
      if (!task.branch || !task.worktree) {
        throw conflict("Task has no branch/worktree to reclaim");
      }

      const selfHealingManager =
        (engine as { getSelfHealingManager?: () => { reclaimPrConflictForTask: (taskId: string) => Promise<unknown> } } | undefined)?.getSelfHealingManager?.() ??
        (engine as { getRuntime?: () => { getSelfHealingManager?: () => { reclaimPrConflictForTask: (taskId: string) => Promise<unknown> } } } | undefined)
          ?.getRuntime?.()
          ?.getSelfHealingManager?.();
      if (!selfHealingManager) {
        return res.json({ queued: false, reason: "engine-unavailable" });
      }

      await selfHealingManager.reclaimPrConflictForTask(task.id);
      res.json({ queued: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to queue PR conflict reclaim");
    }
  });

  router.post("/tasks/:id/pr/merge", async (req, res) => {
    try {
      const method = req.body?.method;
      if (method && !["merge", "squash", "rebase"].includes(method)) {
        throw badRequest("Invalid merge method");
      }
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const prList = getTaskPrList(task);
      const requestedPr = Number.parseInt(String(req.query.pr ?? ""), 10);
      const targetPr = Number.isInteger(requestedPr) && requestedPr > 0
        ? prList.find((pr) => pr.number === requestedPr)
        : (task.prInfo ?? prList[0]);
      if (!targetPr?.number) {
        throw notFound("Task has no associated PR");
      }
      if (targetPr.status === "merged") {
        await scopedStore.applyPrMergedTransition(task.id, {
          agentId: "dashboard",
          runId: `pr-merge-${task.id}-${Date.now()}`,
        });
        return res.json({ prInfo: targetPr, alreadyMerged: true });
      }
      const taskForPr = task.prInfo?.number === targetPr.number ? task : { ...task, prInfo: targetPr };
      const prInfo = await mergeTaskPr(scopedStore, taskForPr, githubToken, method);
      res.json({ prInfo });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw toPrApiError(err, "Failed to merge PR");
    }
  });

  router.post("/tasks/:id/pr/auto-merge", async (req, res) => {
    try {
      const { enabled, strategy } = req.body ?? {};
      if (typeof enabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }
      if (strategy && !["merge", "squash", "rebase"].includes(strategy)) {
        throw badRequest("Invalid auto-merge strategy");
      }
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const prList = getTaskPrList(task);
      const requestedPr = Number.parseInt(String(req.query.pr ?? ""), 10);
      const targetPr = Number.isInteger(requestedPr) && requestedPr > 0
        ? prList.find((pr) => pr.number === requestedPr)
        : (task.prInfo ?? prList[0]);
      if (!targetPr) {
        throw notFound("Task has no associated PR");
      }
      const prInfo: PrInfo = {
        ...targetPr,
        autoMergeOnGreen: enabled,
        autoMergeStrategy: strategy ?? targetPr.autoMergeStrategy,
        lastMergeError: undefined,
        lastMergeErrorAt: undefined,
      };
      await scopedStore.updatePrInfoByNumber(task.id, prInfo.number, prInfo);
      res.json({ prInfo });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to set PR auto-merge");
    }
  });

  /**
   * GET /api/tasks/:id/pr/reviews
   * Fetch PR review snapshot and merged Fusion comment thread view.
   */
  router.get("/tasks/:id/pr/reviews", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const prList = getTaskPrList(task);

      if (prList.length === 0) {
        throw notFound("Task has no associated PR");
      }

      const requestedPr = Number.parseInt(String(req.query.pr ?? ""), 10);
      const primaryPr = Number.isInteger(requestedPr) && requestedPr > 0
        ? prList.find((pr) => pr.number === requestedPr) ?? prList[0]
        : prList[0];
      let owner: string;
      let repo: string;
      const badgeParsed = parseBadgeUrl(primaryPr.url);
      if (badgeParsed) {
        owner = badgeParsed.owner;
        repo = badgeParsed.repo;
      } else {
        const envRepo = process.env.GITHUB_REPOSITORY;
        if (envRepo) {
          const [o, r] = envRepo.split("/");
          owner = o;
          repo = r;
        } else {
          const gitRepo = getCurrentRepo(scopedStore.getRootDir());
          if (!gitRepo) {
            throw badRequest("Could not determine GitHub repository");
          }
          owner = gitRepo.owner;
          repo = gitRepo.repo;
        }
      }

      const repoKey = `${owner}/${repo}`;
      if (!githubRateLimiter.canMakeRequest(repoKey)) {
        const resetTime = githubRateLimiter.getResetTime(repoKey);
        const retryAfter = resetTime
          ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
          : undefined;
        throw new ApiError(429, "GitHub API rate limit exceeded for this repository", {
          retryAfter,
          resetAt: resetTime?.toISOString(),
        });
      }

      const client = new GitHubClient();
      const snapshot = await client.getPrReviewSnapshot(owner, repo, primaryPr.number);
      const fusionThread = (task.comments ?? []).filter((comment) =>
        comment.source === "github-review" || comment.source === "github-review-comment"
      );

      res.json({
        snapshot,
        comments: fusionThread,
        prInfos: prList,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      throw toPrApiError(err, "Failed to fetch PR reviews");
    }
  });

  /**
   * GET /api/tasks/:id/pr/checks
   * Fetch all PR checks (required + optional) and rollup derived from required checks.
   */
  router.get("/tasks/:id/pr/checks", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const prList = getTaskPrList(task);

      if (prList.length === 0) {
        throw notFound("Task has no associated PR");
      }

      const requestedPr = Number.parseInt(String(req.query.pr ?? ""), 10);
      const primaryPr = Number.isInteger(requestedPr) && requestedPr > 0
        ? prList.find((pr) => pr.number === requestedPr) ?? prList[0]
        : prList[0];
      let owner: string;
      let repo: string;
      const badgeParsed = parseBadgeUrl(primaryPr.url);
      if (badgeParsed) {
        owner = badgeParsed.owner;
        repo = badgeParsed.repo;
      } else {
        const envRepo = process.env.GITHUB_REPOSITORY;
        if (envRepo) {
          const [o, r] = envRepo.split("/");
          owner = o;
          repo = r;
        } else {
          const gitRepo = getCurrentRepo(scopedStore.getRootDir());
          if (!gitRepo) {
            throw badRequest("Could not determine GitHub repository");
          }
          owner = gitRepo.owner;
          repo = gitRepo.repo;
        }
      }

      const repoKey = `${owner}/${repo}`;
      if (!githubRateLimiter.canMakeRequest(repoKey)) {
        const resetTime = githubRateLimiter.getResetTime(repoKey);
        const retryAfter = resetTime
          ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
          : undefined;
        throw new ApiError(429, "GitHub API rate limit exceeded for this repository", {
          retryAfter,
          resetAt: resetTime?.toISOString(),
        });
      }

      const client = new GitHubClient();
      const checksResult = await client.getAllPrChecks(owner, repo, primaryPr.number);

      res.json({
        checks: checksResult.checks,
        rollup: checksResult.rollupRequired,
        lastCheckedAt: new Date().toISOString(),
        prInfos: prList,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        throw toPrApiError(err, "Failed to fetch PR checks");
      }
    }
  });

  /**
   * GET /api/tasks/:id/issue/status
   * Get cached issue status for a task. Triggers background refresh if stale (>5 min).
   * Uses only persisted badge timestamps (no in-memory poller state).
   */
  router.get("/tasks/:id/issue/status", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      if (!task.issueInfo) {
        throw notFound("Task has no associated issue");
      }

      const fiveMinutesMs = 5 * 60 * 1000;
      const lastChecked = task.issueInfo.lastCheckedAt || task.updatedAt;
      const lastCheckedTime = new Date(lastChecked).getTime();
      const isStale = Date.now() - lastCheckedTime > fiveMinutesMs;

      res.json({
        issueInfo: task.issueInfo,
        stale: isStale,
      });

      if (isStale) {
        refreshIssueInBackground(scopedStore, task.id, task.issueInfo, githubToken);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/tasks/:id/issue/refresh
   * Force refresh issue status from GitHub API.
   * Returns: Updated IssueInfo
   */
  router.post("/tasks/:id/issue/refresh", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      if (!task.issueInfo) {
        throw notFound("Task has no associated issue");
      }

      let owner: string;
      let repo: string;

      // Get owner/repo from badge URL first, then fall back to env/git
      const badgeParsed = parseBadgeUrl(task.issueInfo.url);
      if (badgeParsed) {
        owner = badgeParsed.owner;
        repo = badgeParsed.repo;
      } else {
        const envRepo = process.env.GITHUB_REPOSITORY;
        if (envRepo) {
          const [o, r] = envRepo.split("/");
          owner = o;
          repo = r;
        } else {
          const gitRepo = getCurrentRepo(scopedStore.getRootDir());
          if (!gitRepo) {
            throw badRequest("Could not determine GitHub repository");
          }
          owner = gitRepo.owner;
          repo = gitRepo.repo;
        }
      }

      const repoKey = `${owner}/${repo}`;
      if (!githubRateLimiter.canMakeRequest(repoKey)) {
        const resetTime = githubRateLimiter.getResetTime(repoKey);
        const retryAfter = resetTime
          ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
          : undefined;
        throw new ApiError(429, "GitHub API rate limit exceeded for this repository", {
          retryAfter,
          resetAt: resetTime?.toISOString(),
        });
      }

      const client = new GitHubClient(githubToken);
      const issueInfo = await client.getIssueStatus(owner, repo, task.issueInfo.number);

      if (!issueInfo) {
        throw notFound(`Issue #${task.issueInfo.number} not found in ${owner}/${repo}`);
      }

      const updatedIssueInfo = {
        ...issueInfo,
        lastCheckedAt: new Date().toISOString(),
      };

      await scopedStore.updateIssueInfo(task.id, updatedIssueInfo);
      res.json(updatedIssueInfo);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });


}
