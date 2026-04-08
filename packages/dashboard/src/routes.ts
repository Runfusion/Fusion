import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve, sep, join } from "node:path";
import { tmpdir } from "node:os";
import * as nodeFs from "node:fs";
import * as nodeChildProcess from "node:child_process";
import type { TaskStore, Column, MergeResult, ScheduleType, ActivityEventType, ModelPreset, AutomationStep, MessageType, ParticipantType, MessageCreateInput } from "@fusion/core";
import { COLUMNS, VALID_TRANSITIONS, GLOBAL_SETTINGS_KEYS, type BatchStatusEntry, type BatchStatusResponse, type BatchStatusResult, type IssueInfo, type PrInfo, type Task, isGhAuthenticated, AUTOMATION_PRESETS, AutomationStore, validateBackupSchedule, validateBackupRetention, validateBackupDir, syncBackupAutomation, exportSettings, importSettings, validateImportData, MessageStore, MEMORY_FILE_PATH } from "@fusion/core";
import type { ServerOptions } from "./server.js";
import { GitHubClient, getCurrentGitHubRepo, parseBadgeUrl } from "./github.js";
import { githubRateLimiter } from "./github-poll.js";
import { terminalSessionManager } from "./terminal.js";
import { getTerminalService } from "./terminal-service.js";
import { listFiles, readFile, writeFile, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile, copyWorkspaceFile, moveWorkspaceFile, deleteWorkspaceFile, renameWorkspaceFile, getWorkspaceFileForDownload, getWorkspaceFolderForZip, readProjectFile, writeProjectFile, FileServiceError, type FileListResponse, type FileContentResponse, type SaveFileResponse, type FileOperationResponse } from "./file-service.js";
import { fetchAllProviderUsage } from "./usage.js";
import {
  getGitHubAppConfig,
  verifyWebhookSignature,
  classifyWebhookEvent,
  isSameResource,
  hasPrBadgeFieldsChanged,
  hasIssueBadgeFieldsChanged,
  type BadgeUrlComponents,
} from "./github-webhooks.js";
import { createMissionRouter } from "./mission-routes.js";
import { getOrCreateProjectStore } from "./project-store-resolver.js";
import { AiSessionStore } from "./ai-session-store.js";
import { getSession as getPlanningSession, cleanupSession as cleanupPlanningSession } from "./planning.js";
import { getSubtaskSession, cleanupSubtaskSession } from "./subtask-breakdown.js";
import {
  startAgentGeneration,
  generateAgentSpec,
  getAgentGenerationSession,
  cleanupAgentGenerationSession,
  RateLimitError as AgentGenerationRateLimitError,
  SessionNotFoundError as AgentGenerationSessionNotFoundError,
} from "./agent-generation.js";
import { getMissionInterviewSession, cleanupMissionInterviewSession } from "./mission-interview.js";
import { writeSSEEvent } from "./sse-buffer.js";
import {
  ApiError,
  badRequest,
  conflict,
  internalError,
  notFound,
  rateLimited,
  sendErrorResponse,
  unauthorized,
} from "./api-error.js";

/**
 * Minimal interface matching pi-coding-agent's ModelRegistry API surface
 * used by the models route. Avoids a direct dependency on the pi-coding-agent package.
 */
export interface ModelRegistryLike {
  /** Reload models from disk to pick up changes. */
  refresh(): void;
  /** Get models that have auth configured. */
  getAvailable(): Array<{ id: string; name: string; provider: string; reasoning: boolean; contextWindow: number }>;
}

/**
 * Minimal interface matching pi-coding-agent's AuthStorage API surface
 * used by the auth routes. Avoids a direct dependency on the pi-coding-agent package.
 */
export interface AuthStorageLike {
  reload(): void;
  getOAuthProviders(): Array<{ id: string; name: string }>;
  hasAuth(provider: string): boolean;
  login(
    providerId: string,
    callbacks: {
      onAuth: (info: { url: string; instructions?: string }) => void;
      onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
      onProgress?: (message: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<void>;
  logout(provider: string): void;
  /** Get providers that accept API keys (non-OAuth). Returns provider id and name. */
  getApiKeyProviders?(): Array<{ id: string; name: string }>;
  /** Save an API key for a provider. Creates or overwrites the existing key. */
  setApiKey?(providerId: string, apiKey: string): void;
  /** Remove the stored API key for a provider. No-op if not set. */
  clearApiKey?(providerId: string): void;
  /** Check if a provider has an API key configured. */
  hasApiKey?(providerId: string): boolean;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// Dynamic import fallback for @fusion/engine with injectable override for tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createKbAgentForRefine: any;

/** @internal Inject a mock createKbAgent function for workflow-step refine route tests. */
export function __setCreateKbAgentForRefine(mock: typeof createKbAgentForRefine): void {
  createKbAgentForRefine = mock;
}

function validateOptionalModelField(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeModelSelectionPair(provider: string | undefined, modelId: string | undefined) {
  if (!provider || !modelId) {
    return { provider: undefined, modelId: undefined };
  }

  return { provider, modelId };
}

function assertConsistentOptionalPair(
  provider: unknown,
  modelId: unknown,
  pairName: string,
): { provider?: string; modelId?: string } {
  const normalizedProvider = validateOptionalModelField(provider, `${pairName} provider`);
  const normalizedModelId = validateOptionalModelField(modelId, `${pairName} modelId`);

  if ((normalizedProvider && !normalizedModelId) || (!normalizedProvider && normalizedModelId)) {
    throw new Error(`${pairName} must include both provider and modelId or neither`);
  }

  return {
    provider: normalizedProvider,
    modelId: normalizedModelId,
  };
}

function rethrowAsApiError(error: unknown, fallbackMessage = "Internal server error"): never {
  if (error instanceof ApiError) {
    throw error;
  }

  if (error instanceof Error && error.message) {
    throw internalError(error.message);
  }

  throw internalError(fallbackMessage);
}

function slugifyPresetName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32);
  return slug || "preset";
}

function validateModelPresets(value: unknown): ModelPreset[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("modelPresets must be an array");
  }

  const seenIds = new Set<string>();

  return value.map((preset, index) => {
    if (!preset || typeof preset !== "object") {
      throw new Error(`modelPresets[${index}] must be an object`);
    }

    const candidate = preset as Record<string, unknown>;
    const rawId = validateOptionalModelField(candidate.id, `modelPresets[${index}].id`);
    const name = validateOptionalModelField(candidate.name, `modelPresets[${index}].name`);

    if (!name) {
      throw new Error(`modelPresets[${index}].name is required`);
    }

    // Auto-generate ID from name when not provided
    let id = rawId || slugifyPresetName(name);

    // If the explicit ID collides, fall back to the slugified name
    if (seenIds.has(id)) {
      const slugId = slugifyPresetName(name);
      if (!seenIds.has(slugId)) {
        id = slugId;
      } else {
        // Both explicit ID and slug collide — append -1, -2, etc.
        const maxBase = 30;
        let idx = 1;
        while (seenIds.has(id) && idx < 100) {
          const suffix = `-${idx}`;
          id = `${slugId.slice(0, maxBase - suffix.length)}${suffix}`;
          idx++;
        }
      }
    }
    seenIds.add(id);

    const executor = assertConsistentOptionalPair(
      candidate.executorProvider,
      candidate.executorModelId,
      `modelPresets[${index}].executor`,
    );
    const validator = assertConsistentOptionalPair(
      candidate.validatorProvider,
      candidate.validatorModelId,
      `modelPresets[${index}].validator`,
    );

    return {
      id,
      name,
      executorProvider: executor.provider,
      executorModelId: executor.modelId,
      validatorProvider: validator.provider,
      validatorModelId: validator.modelId,
    };
  });
}

// ── Git Remote Detection ──────────────────────────────────────────

/** Git remote info returned by the remotes endpoint */
export interface GitRemote {
  name: string;
  owner: string;
  repo: string;
  url: string;
}

/**
 * Parse a GitHub URL to extract owner and repo.
 * Handles HTTPS (https://github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git) formats.
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  // HTTPS format: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH format: git@github.com:owner/repo.git or git@github.com:owner/repo
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

function parseGitHubBadgeUrl(url: string | undefined): { owner: string; repo: string } | null {
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

/**
 * Get GitHub remotes from the current git repository.
 * Executes `git remote -v` and parses the output.
 */
function getGitHubRemotes(cwd?: string): GitRemote[] {
  try {
    // Execute git remote -v to get all remotes with their URLs
    const execOptions = { encoding: "utf-8" as const, timeout: 5000, cwd };
    const output = execSync("git remote -v", execOptions);

    const remotes: GitRemote[] = [];
    const seen = new Set<string>();

    for (const line of output.split("\n")) {
      // Parse lines like: "origin  https://github.com/owner/repo.git (fetch)"
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match) continue;

      const [, name, url] = match;

      // Skip duplicates (fetch/push entries for same remote)
      const key = `${name}-${url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Only include GitHub URLs
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
    // Return empty array if not a git repo, git not available, or any error
    return [];
  }
}

/**
 * Check if the current directory is a git repository.
 * Used to validate git operations before executing commands.
 */
function isGitRepo(cwd?: string): boolean {
  try {
    const execOptions = { encoding: "utf-8" as const, timeout: 5000, cwd };
    execSync("git rev-parse --git-dir", execOptions);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current git status including branch, commit hash, and dirty state.
 * Returns structured data for the Git Manager UI.
 */
function getGitStatus(cwd?: string): {
  branch: string;
  commit: string;
  isDirty: boolean;
  ahead: number;
  behind: number;
} | null {
  try {
    const execOptions = { encoding: "utf-8" as const, timeout: 5000, cwd };
    // Get current branch
    const branch = execSync("git branch --show-current", execOptions).trim() || "HEAD detached";

    // Get current commit hash (short)
    const commit = execSync("git rev-parse --short HEAD", execOptions).trim();

    // Check if working directory is dirty
    const statusOutput = execSync("git status --porcelain", execOptions).trim();
    const isDirty = statusOutput.length > 0;

    // Get ahead/behind counts from origin
    let ahead = 0;
    let behind = 0;
    try {
      const revListOutput = execSync("git rev-list --left-right --count HEAD...@{u}", execOptions).trim();
      const match = revListOutput.match(/(\d+)\s+(\d+)/);
      if (match) {
        ahead = parseInt(match[1], 10);
        behind = parseInt(match[2], 10);
      }
    } catch {
      // No upstream or other error - leave as 0
    }

    return { branch, commit, isDirty, ahead, behind };
  } catch {
    return null;
  }
}

/** Git commit info returned by the commits endpoint */
export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  parents: string[];
}

/**
 * Get recent commits from the git log.
 * @param limit Maximum number of commits to return (default 20)
 */
function getGitCommits(limit: number = 20, cwd?: string): GitCommit[] {
  try {
    // Format: hash|shortHash|message|author|date|parents
    const format = "%H|%h|%s|%an|%aI|%P";
    const execOptions = { encoding: "utf-8" as const, timeout: 10000, cwd };
    const output = execSync(`git log --max-count=${limit} --pretty=format:"${format}"`, execOptions);

    const commits: GitCommit[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 5) continue;

      const [hash, shortHash, message, author, date, parentsStr] = parts;
      const parents = parentsStr ? parentsStr.split(" ").filter(Boolean) : [];

      commits.push({
        hash,
        shortHash,
        message: message || "",
        author: author || "",
        date: date || "",
        parents,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Validates a git ref name to prevent command injection.
 * Refs include branch names, remote tracking branches (remote/branch), and tags.
 * Must not contain shell metacharacters or start with dashes.
 */
function isValidGitRef(ref: string): boolean {
  if (!ref || ref.length === 0) return false;
  if (ref.startsWith("-")) return false;
  if (/[;<>&|`$(){}[\]\r\n]/.test(ref)) return false;
  if (/\s/.test(ref)) return false;
  // Allow slashes for remote/branch format, dots, hyphens, underscores, alphanumerics
  if (!/^[a-zA-Z0-9/_.@-]+$/.test(ref)) return false;
  if (ref.includes("..")) return false;
  if (ref.includes("~")) return false;
  if (ref.includes("^")) return false;
  if (ref.includes(":")) return false;
  // Must not look like an option
  if (ref.startsWith("--")) return false;
  return true;
}

/**
 * Get recent commits for a specific branch.
 * @param branch The branch name (validated before calling)
 * @param limit Maximum number of commits to return
 * @param cwd Working directory
 */
function getGitCommitsForBranch(branch: string, limit: number = 10, cwd?: string): GitCommit[] {
  try {
    const format = "%H|%h|%s|%an|%aI|%P";
    const execOptions = { encoding: "utf-8" as const, timeout: 10000, cwd };
    const output = execSync(`git log --max-count=${limit} --pretty=format:"${format}" "${branch}"`, execOptions);

    const commits: GitCommit[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 5) continue;

      const [hash, shortHash, message, author, date, parentsStr] = parts;
      const parents = parentsStr ? parentsStr.split(" ").filter(Boolean) : [];

      commits.push({
        hash,
        shortHash,
        message: message || "",
        author: author || "",
        date: date || "",
        parents,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Get commits ahead of the upstream tracking branch (commits that would be pushed).
 * Returns the list of local commits not yet present on the upstream.
 * Returns an empty array if there is no upstream configured.
 */
function getAheadCommits(cwd?: string): GitCommit[] {
  try {
    const execOptions = { encoding: "utf-8" as const, timeout: 10000, cwd };
    // Check if an upstream is configured
    try {
      execSync("git rev-parse --abbrev-ref @{u}", execOptions);
    } catch {
      // No upstream configured
      return [];
    }

    // Format: hash|shortHash|message|author|date|parents
    const format = "%H|%h|%s|%an|%aI|%P";
    const output = execSync(`git log @{u}..HEAD --pretty=format:"${format}"`, execOptions);

    const commits: GitCommit[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 5) continue;

      const [hash, shortHash, message, author, date, parentsStr] = parts;
      const parents = parentsStr ? parentsStr.split(" ").filter(Boolean) : [];

      commits.push({
        hash,
        shortHash,
        message: message || "",
        author: author || "",
        date: date || "",
        parents,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Get recent commits reachable from a remote tracking ref.
 * @param remoteRef The remote ref (e.g. "origin/main") to list commits for
 * @param limit Maximum number of commits to return (default 10)
 */
function getRemoteCommits(remoteRef: string, limit: number = 10, cwd?: string): GitCommit[] {
  try {
    if (!isValidGitRef(remoteRef)) {
      throw new Error("Invalid remote ref");
    }

    // Verify the ref exists
    const execOptions = { encoding: "utf-8" as const, timeout: 5000, cwd };
    try {
      execSync(`git rev-parse --verify "${remoteRef}"`, execOptions);
    } catch {
      return [];
    }

    // Format: hash|shortHash|message|author|date|parents
    const format = "%H|%h|%s|%an|%aI|%P";
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const output = execSync(`git log --max-count=${safeLimit} --pretty=format:"${format}" "${remoteRef}"`, {
      encoding: "utf-8",
      timeout: 10000,
      cwd,
    });

    const commits: GitCommit[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 5) continue;

      const [hash, shortHash, message, author, date, parentsStr] = parts;
      const parents = parentsStr ? parentsStr.split(" ").filter(Boolean) : [];

      commits.push({
        hash,
        shortHash,
        message: message || "",
        author: author || "",
        date: date || "",
        parents,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Get the diff for a specific commit.
 * @param hash The commit hash
 * @returns Object with stat and patch
 */
function getCommitDiff(hash: string, cwd?: string): { stat: string; patch: string } | null {
  try {
    const execOptions = { encoding: "utf-8" as const, timeout: 10000, cwd };
    // Validate the hash is a valid git object
    execSync(`git cat-file -t ${hash}`, { encoding: "utf-8", timeout: 5000, cwd });

    // Get diff stat
    const stat = execSync(`git show --stat --format="" ${hash}`, execOptions).trim();

    // Get patch
    const patch = execSync(`git show --format="" ${hash}`, execOptions);

    return { stat, patch };
  } catch {
    return null;
  }
}

/** Git branch info returned by the branches endpoint */
export interface GitBranch {
  name: string;
  isCurrent: boolean;
  remote?: string;
  lastCommitDate?: string;
}

/**
 * Get all local branches with their info.
 */
function getGitBranches(cwd?: string): GitBranch[] {
  try {
    const execOptions = { encoding: "utf-8" as const, timeout: 5000, cwd };
    // Get current branch name
    let currentBranch = "";
    try {
      currentBranch = execSync("git branch --show-current", execOptions).trim();
    } catch {
      // Detached HEAD - no current branch
    }

    // Get all branches with info
    const format = "%(refname:short)|%(upstream:short)|%(committerdate:iso8601)|%(HEAD)";
    const output = execSync(`git for-each-ref --format="${format}" refs/heads/`, {
      encoding: "utf-8",
      timeout: 10000,
      cwd,
    });

    const branches: GitBranch[] = [];
    for (const line of output.trim().split("\n")) {
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

/** Git worktree info returned by the worktrees endpoint */
export interface GitWorktree {
  path: string;
  branch?: string;
  isMain: boolean;
  isBare: boolean;
  taskId?: string;
}

/**
 * Get all git worktrees.
 * @param tasks Optional task list to correlate worktrees with tasks
 */
function getGitWorktrees(tasks: { id: string; worktree?: string }[] = [], cwd?: string): GitWorktree[] {
  try {
    const execOptions = { encoding: "utf-8" as const, timeout: 10000, cwd };
    const output = execSync("git worktree list --porcelain", execOptions);

    const worktrees: GitWorktree[] = [];
    let currentWorktree: Partial<GitWorktree> = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        // Save previous worktree if exists
        if (currentWorktree.path) {
          // Find associated task by matching worktree path
          const task = tasks.find((t) => t.worktree && currentWorktree.path === t.worktree);
          worktrees.push({
            path: currentWorktree.path,
            branch: currentWorktree.branch,
            isMain: currentWorktree.isMain || false,
            isBare: currentWorktree.isBare || false,
            taskId: task?.id,
          });
        }
        // Start new worktree
        currentWorktree = { path: line.slice(9).trim() };
      } else if (line.startsWith("branch ")) {
        currentWorktree.branch = line.slice(8).trim().replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        currentWorktree.isBare = true;
      } else if (line === "main") {
        currentWorktree.isMain = true;
      } else if (line === "" && currentWorktree.path) {
        // Empty line signals end of worktree entry
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

    // Handle last worktree if no trailing newline
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

// ── Git Action Helper Functions ──────────────────────────────────────────

/**
 * Validates a branch name to prevent command injection.
 * Branch names must not contain spaces, special shell characters, or start with dashes.
 */
function isValidBranchName(name: string): boolean {
  // Must not be empty
  if (!name || name.length === 0) return false;
  // Must not start with a dash (could be interpreted as an option)
  if (name.startsWith("-")) return false;
  // Must not contain shell metacharacters
  if (/[;<>&|`$(){}[\]\r\n]/.test(name)) return false;
  // Must be valid git ref format (no spaces, no double dots, etc)
  if (/\s/.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.includes("~")) return false;
  if (name.includes("^")) return false;
  if (name.includes(":")) return false;
  // Must not be a reserved git ref name
  const reserved = ["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD"];
  if (reserved.includes(name)) return false;
  return true;
}

/**
 * Create a new branch from current HEAD or specified base.
 * Returns the created branch name.
 */
function createGitBranch(name: string, base?: string, cwd?: string): string {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid branch name");
  }
  if (base && !isValidBranchName(base)) {
    throw new Error("Invalid base branch name");
  }
  const cmd = base
    ? `git checkout -b ${name} ${base}`
    : `git checkout -b ${name}`;
  execSync(cmd, { encoding: "utf-8", timeout: 10000, cwd });
  return name;
}

/**
 * Checkout an existing branch.
 * Throws if there are uncommitted changes that would be lost.
 */
function checkoutGitBranch(name: string, cwd?: string): void {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid branch name");
  }
  const execOptions = { encoding: "utf-8" as const, timeout: 5000, cwd };
  // Check for uncommitted changes that would be lost
  try {
    execSync("git diff-index --quiet HEAD --", execOptions);
  } catch {
    // Has uncommitted changes - check if they'd be lost
    const diff = execSync("git diff --name-only", execOptions).trim();
    if (diff) {
      throw new Error("Uncommitted changes would be lost. Commit or stash changes first.");
    }
  }
  execSync(`git checkout ${name}`, { encoding: "utf-8", timeout: 10000, cwd });
}

/**
 * Delete a branch.
 * Throws if it's the current branch or has unmerged commits.
 */
function deleteGitBranch(name: string, force: boolean = false, cwd?: string): void {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid branch name");
  }
  const flag = force ? "-D" : "-d";
  execSync(`git branch ${flag} ${name}`, { encoding: "utf-8", timeout: 10000, cwd });
}

/** Result of a fetch operation */
export interface GitFetchResult {
  fetched: boolean;
  message: string;
}

/**
 * Fetch from origin or specified remote.
 */
function fetchGitRemote(remote: string = "origin", cwd?: string): GitFetchResult {
  if (!isValidBranchName(remote)) {
    throw new Error("Invalid remote name");
  }
  try {
    const output = execSync(`git fetch ${remote}`, { encoding: "utf-8", timeout: 30000, cwd });
    return { fetched: true, message: output.trim() || "Fetch completed" };
  } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
    const message = err.message || String(err);
    if (message.includes("Could not resolve host") || message.includes("Connection refused")) {
      throw new Error("Failed to connect to remote");
    }
    // No updates is not an error
    return { fetched: false, message: message || "No updates" };
  }
}

/** Result of a pull operation */
export interface GitPullResult {
  success: boolean;
  message: string;
  conflict?: boolean;
}

/**
 * Pull the current branch.
 */
function pullGitBranch(cwd?: string): GitPullResult {
  try {
    const output = execSync("git pull", { encoding: "utf-8", timeout: 30000, cwd });
    return { success: true, message: output.trim() };
  } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
    const message = err.message || String(err);
    if (message.includes("CONFLICT") || message.includes("Merge conflict")) {
      const success = false;
      return { success, message: "Merge conflict detected. Resolve manually.", conflict: true };
    }
    throw new Error(message || "Pull failed");
  }
}

/** Result of a push operation */
export interface GitPushResult {
  success: boolean;
  message: string;
}

/**
 * Push the current branch.
 */
function pushGitBranch(cwd?: string): GitPushResult {
  try {
    const output = execSync("git push", { encoding: "utf-8", timeout: 30000, cwd });
    return { success: true, message: output.trim() || "Push completed" };
  } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
    const message = err.message || String(err);
    if (message.includes("rejected") || message.includes("non-fast-forward")) {
      throw new Error("Push rejected. Pull latest changes first.");
    }
    if (message.includes("Could not resolve host") || message.includes("Connection refused")) {
      throw new Error("Failed to connect to remote");
    }
    throw new Error(message || "Push failed");
  }
}

// ── Git Remote Management Helper Functions ───────────────────────────────

/** Detailed git remote info with fetch and push URLs */
export interface GitRemoteDetailed {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/**
 * Validates a git URL format.
 * Accepts: https://, git@, file://, or ssh:// formats
 * Rejects URLs containing shell metacharacters to prevent command injection.
 */
function isValidGitUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  // Reject URLs with shell metacharacters to prevent injection
  if (/[;<>&|`$(){}[\]\r\n]/.test(url)) return false;
  // Reject URLs starting with dash (could be interpreted as option)
  if (url.startsWith("-")) return false;
  // HTTPS URL: https://host.com/path.git or https://host.com/path
  if (/^https?:\/\/.+/.test(url)) return true;
  // SSH URL: git@host.com:path.git or git@host.com:path
  if (/^git@[^:]+:.+/.test(url)) return true;
  // File URL: file:///path/to/repo
  if (/^file:\/\/.+/.test(url)) return true;
  // SSH URL with protocol: ssh://git@host.com/path.git
  if (/^ssh:\/\/.+/.test(url)) return true;
  return false;
}

/**
 * Get all git remotes with their fetch and push URLs.
 * Executes `git remote -v` and parses the output.
 */
function listGitRemotes(cwd?: string): GitRemoteDetailed[] {
  try {
    const execOptions = { encoding: "utf-8" as const, timeout: 5000, cwd };
    const output = execSync("git remote -v", execOptions);

    const remotes = new Map<string, { fetchUrl: string; pushUrl: string }>();

    for (const line of output.split("\n")) {
      // Parse lines like: "origin  https://github.com/owner/repo.git (fetch)"
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

/**
 * Add a new git remote.
 */
function addGitRemote(name: string, url: string, cwd?: string): void {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid remote name");
  }
  if (!isValidGitUrl(url)) {
    throw new Error("Invalid git URL format");
  }
  try {
    execSync(`git remote add ${name} ${url}`, { encoding: "utf-8", timeout: 10000, cwd });
  } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
    const message = err.message || String(err);
    if (message.includes("already exists")) {
      throw new Error(`Remote '${name}' already exists`);
    }
    throw new Error(message || "Failed to add remote");
  }
}

/**
 * Remove a git remote.
 */
function removeGitRemote(name: string, cwd?: string): void {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid remote name");
  }
  try {
    execSync(`git remote remove ${name}`, { encoding: "utf-8", timeout: 10000, cwd });
  } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
    const message = err.message || String(err);
    if (message.includes("No such remote")) {
      throw new Error(`Remote '${name}' does not exist`);
    }
    throw new Error(message || "Failed to remove remote");
  }
}

/**
 * Rename a git remote.
 */
function renameGitRemote(oldName: string, newName: string, cwd?: string): void {
  if (!isValidBranchName(oldName)) {
    throw new Error("Invalid remote name");
  }
  if (!isValidBranchName(newName)) {
    throw new Error("Invalid new remote name");
  }
  try {
    execSync(`git remote rename ${oldName} ${newName}`, { encoding: "utf-8", timeout: 10000, cwd });
  } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
    const message = err.message || String(err);
    if (message.includes("No such remote")) {
      throw new Error(`Remote '${oldName}' does not exist`);
    }
    if (message.includes("already exists")) {
      throw new Error(`Remote '${newName}' already exists`);
    }
    throw new Error(message || "Failed to rename remote");
  }
}

/**
 * Set the URL for a git remote.
 */
function setGitRemoteUrl(name: string, url: string, cwd?: string): void {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid remote name");
  }
  if (!isValidGitUrl(url)) {
    throw new Error("Invalid git URL format");
  }
  try {
    execSync(`git remote set-url ${name} ${url}`, { encoding: "utf-8", timeout: 10000, cwd });
  } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
    const message = err.message || String(err);
    if (message.includes("No such remote")) {
      throw new Error(`Remote '${name}' does not exist`);
    }
    throw new Error(message || "Failed to update remote URL");
  }
}

// ── Git Stash, Stage, Commit Helper Functions ────────────────────────────

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

/**
 * Get list of stash entries.
 */
function getGitStashList(cwd?: string): GitStash[] {
  try {
    const output = execSync('git stash list --format="%gd|%gs|%ai"', {
      encoding: "utf-8",
      timeout: 5000,
      cwd,
    }).trim();
    if (!output) return [];

    const stashes: GitStash[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 3) continue;
      const [ref, message, date] = parts;
      const indexMatch = ref.match(/stash@\{(\d+)\}/);
      const index = indexMatch ? parseInt(indexMatch[1], 10) : stashes.length;
      // Extract branch from message like "WIP on main: abc1234 ..."
      const branchMatch = message.match(/(?:WIP on|On) ([^:]+):/);
      const branch = branchMatch ? branchMatch[1] : "";
      stashes.push({ index, message, date, branch });
    }
    return stashes;
  } catch {
    return [];
  }
}

/**
 * Create a new stash.
 */
function createGitStash(message?: string, cwd?: string): string {
  let output: string;
  const execOptions = { encoding: "utf-8" as const, timeout: 10000, cwd };
  if (message) {
    // Sanitize message: remove shell metacharacters to prevent injection
    const sanitized = message.replace(/[`$\\!"]/g, "").trim();
    if (!sanitized) {
      throw new Error("Invalid stash message");
    }
    output = execSync(`git stash push -m '${sanitized.replace(/'/g, "'\\''")}'`, execOptions).trim();
  } else {
    output = execSync("git stash push", execOptions).trim();
  }
  if (output.includes("No local changes to save")) {
    throw new Error("No local changes to stash");
  }
  return output || "Stash created";
}

/**
 * Apply a stash entry.
 */
function applyGitStash(index: number, drop: boolean = false, cwd?: string): string {
  if (index < 0 || !Number.isInteger(index)) throw new Error("Invalid stash index");
  const cmd = drop ? `git stash pop stash@{${index}}` : `git stash apply stash@{${index}}`;
  const output = execSync(cmd, { encoding: "utf-8", timeout: 10000, cwd }).trim();
  return output || (drop ? "Stash popped" : "Stash applied");
}

/**
 * Drop a stash entry.
 */
function dropGitStash(index: number, cwd?: string): string {
  if (index < 0 || !Number.isInteger(index)) throw new Error("Invalid stash index");
  const output = execSync(`git stash drop stash@{${index}}`, {
    encoding: "utf-8",
    timeout: 10000,
    cwd,
  }).trim();
  return output || "Stash dropped";
}

/**
 * Get file changes (staged and unstaged).
 */
function getGitFileChanges(cwd?: string): GitFileChange[] {
  try {
    const output = execSync("git status --porcelain=v1", {
      encoding: "utf-8",
      timeout: 5000,
      cwd,
    }).trim();
    if (!output) return [];

    const changes: GitFileChange[] = [];
    for (const line of output.split("\n")) {
      if (line.length < 3) continue;
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePath = line.slice(3).trim();

      // Map git status codes to our status type
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

      // Handle renamed files: "R  old -> new"
      let file = filePath;
      let oldFile: string | undefined;
      if (filePath.includes(" -> ")) {
        const [old, newF] = filePath.split(" -> ");
        oldFile = old.trim();
        file = newF.trim();
      }

      // Staged changes (index status is not space and not ?)
      if (indexStatus !== " " && indexStatus !== "?") {
        changes.push({
          file,
          status: mapStatus(indexStatus),
          staged: true,
          oldFile,
        });
      }

      // Unstaged changes (work tree status is not space)
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

/**
 * Get working directory diff.
 */
function getGitWorkingDiff(cwd?: string): { stat: string; patch: string } {
  try {
    const execOptions = { encoding: "utf-8" as const, timeout: 10000, cwd };
    const stat = execSync("git diff --stat", execOptions).trim();
    const patch = execSync("git diff", execOptions);
    return { stat, patch };
  } catch {
    return { stat: "", patch: "" };
  }
}

/**
 * Stage specific files.
 */
function stageGitFiles(files: string[], cwd?: string): string[] {
  if (!files.length) throw new Error("No files specified");
  // Validate file paths - no shell metacharacters
  for (const f of files) {
    if (/[;&|`$(){}[\]\r\n]/.test(f)) {
      throw new Error(`Invalid file path: ${f}`);
    }
  }
  const escaped = files.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(" ");
  execSync(`git add ${escaped}`, { encoding: "utf-8", timeout: 10000, cwd });
  return files;
}

/**
 * Unstage specific files.
 */
function unstageGitFiles(files: string[], cwd?: string): string[] {
  if (!files.length) throw new Error("No files specified");
  for (const f of files) {
    if (/[;&|`$(){}[\]\r\n]/.test(f)) {
      throw new Error(`Invalid file path: ${f}`);
    }
  }
  const escaped = files.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(" ");
  execSync(`git reset HEAD ${escaped}`, { encoding: "utf-8", timeout: 10000, cwd });
  return files;
}

/**
 * Create a commit with staged changes.
 */
function createGitCommit(message: string, cwd?: string): { hash: string; message: string } {
  if (!message || !message.trim()) throw new Error("Commit message is required");
  const execOptions = { encoding: "utf-8" as const, timeout: 10000, cwd };
  // Check there are staged changes
  const staged = execSync("git diff --cached --name-only", { encoding: "utf-8", timeout: 5000, cwd }).trim();
  if (!staged) throw new Error("No staged changes to commit");
  // Sanitize: use single quotes and escape embedded single quotes for shell safety
  const sanitized = message.trim().replace(/'/g, "'\\''");
  execSync(`git commit -m '${sanitized}'`, execOptions);
  const hash = execSync("git rev-parse --short HEAD", { encoding: "utf-8", timeout: 5000, cwd }).trim();
  return { hash, message: message.trim() };
}

/**
 * Discard changes for specific files.
 */
function discardGitChanges(files: string[], cwd?: string): string[] {
  if (!files.length) throw new Error("No files specified");
  for (const f of files) {
    if (/[;&|`$(){}[\]\r\n]/.test(f)) {
      throw new Error(`Invalid file path: ${f}`);
    }
  }
  const execOptions = { encoding: "utf-8" as const, timeout: 5000, cwd };
  // Separate untracked from tracked
  const statusOutput = execSync("git status --porcelain=v1", execOptions).trim();
  const untracked = new Set<string>();
  for (const line of statusOutput.split("\n")) {
    if (line.startsWith("??")) {
      untracked.add(line.slice(3).trim());
    }
  }
  const trackedFiles = files.filter((f) => !untracked.has(f));
  const untrackedFiles = files.filter((f) => untracked.has(f));

  if (trackedFiles.length) {
    const escaped = trackedFiles.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(" ");
    execSync(`git checkout -- ${escaped}`, { encoding: "utf-8", timeout: 10000, cwd });
  }
  if (untrackedFiles.length) {
    const escaped = untrackedFiles.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(" ");
    execSync(`git clean -f -- ${escaped}`, { encoding: "utf-8", timeout: 10000, cwd });
  }
  return files;
}

// ── Module-level batch-import rate limiter state (resettable for testing) ──
const batchImportWindowMs = 10_000; // 10 seconds
const batchImportInstances: Map<string, number>[] = [];
let batchImportCleanupInterval: ReturnType<typeof setInterval> | undefined;

/** @internal Reset batch-import rate limiter state (for test isolation) */
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

function parseLastEventId(req: Request): number | undefined {
  const rawHeader = req.headers["last-event-id"];
  const rawQuery = req.query.lastEventId;

  const raw = Array.isArray(rawHeader)
    ? rawHeader[0]
    : (typeof rawHeader === "string" ? rawHeader : Array.isArray(rawQuery) ? rawQuery[0] : rawQuery);

  if (raw === undefined || raw === null) return undefined;

  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  return parsed;
}

function replayBufferedSSE(
  res: Response,
  bufferedEvents: Array<{ id: number; event: string; data: string }>,
): boolean {
  for (const bufferedEvent of bufferedEvents) {
    if (!writeSSEEvent(res, bufferedEvent.event, bufferedEvent.data, bufferedEvent.id)) {
      return false;
    }
  }
  return true;
}

export function createApiRoutes(store: TaskStore, options?: ServerOptions): Router {
  const router = Router();

  function prioritizeProjectsForCurrentDirectory<T extends { path: string }>(projects: T[]): T[] {
    const cwd = resolve(process.cwd());

    const rankProject = (projectPath: string): number => {
      const normalizedProjectPath = resolve(projectPath);
      if (normalizedProjectPath === cwd) {
        return Number.MAX_SAFE_INTEGER;
      }

      const prefix = normalizedProjectPath.endsWith(sep)
        ? normalizedProjectPath
        : `${normalizedProjectPath}${sep}`;

      if (!cwd.startsWith(prefix)) {
        return -1;
      }

      return normalizedProjectPath.length;
    };

    return [...projects].sort((a, b) => rankProject(b.path) - rankProject(a.path));
  }

  function getProjectIdFromRequest(req: Request): string | undefined {
    if (req.query && typeof req.query.projectId === "string" && req.query.projectId.length > 0) {
      return req.query.projectId;
    }
    if (req.body && typeof req.body.projectId === "string" && req.body.projectId.length > 0) {
      return req.body.projectId;
    }
    return undefined;
  }

  async function getScopedStore(req: Request): Promise<TaskStore> {
    const projectId = getProjectIdFromRequest(req);
    if (!projectId) return store;

    // Use the shared project-store resolver so mutations emit events
    // on the same EventEmitter that SSE listeners are attached to.
    return getOrCreateProjectStore(projectId);
  }

  if (process.env.FUSION_DEBUG_PLANNING_ROUTES === "1") {
    const planningRoutes = [
      "POST /planning/start",
      "POST /planning/start-streaming",
      "POST /planning/respond",
      "POST /planning/:sessionId/retry",
      "POST /planning/cancel",
      "POST /planning/create-task",
      "POST /planning/start-breakdown",
      "POST /planning/create-tasks",
      "GET /planning/:sessionId/stream",
    ];
    console.debug("[planning:routes:registered]", planningRoutes);
  }
  const sessionFilesCache = new Map<string, { files: string[]; expiresAt: number }>();
  const fileDiffsCache = new Map<
    string,
    {
      files: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed"; diff: string; oldPath?: string }>;
      expiresAt: number;
    }
  >();

  // Get GitHub token from options or env
  const githubToken = options?.githubToken ?? process.env.GITHUB_TOKEN;

  // HeartbeatMonitor for triggering agent execution runs
  const heartbeatMonitor = options?.heartbeatMonitor;
  const hasHeartbeatExecutor = Boolean(heartbeatMonitor);

  // Scheduler config (includes persisted settings)
  router.get("/config", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const settings = await scopedStore.getSettings();
      res.json({
        maxConcurrent: settings.maxConcurrent ?? options?.maxConcurrent ?? 2,
        maxWorktrees: settings.maxWorktrees ?? 4,
        rootDir: scopedStore.getRootDir(),
      });
    } catch {
      const scopedStore = await getScopedStore(req);
      res.json({ maxConcurrent: options?.maxConcurrent ?? 2, maxWorktrees: 4, rootDir: scopedStore.getRootDir() });
    }
  });

  // Settings CRUD
  router.get("/settings", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const settings = await scopedStore.getSettings();
      // Inject server-side configuration flags
      res.json({
        ...settings,
        githubTokenConfigured: Boolean(githubToken),
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.put("/settings", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      // Strip server-owned fields that should never be persisted to config.json.
      // These are computed server-side and injected only on GET /settings.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { githubTokenConfigured, ...clientSettings } = req.body;

      // Reject global-only fields with a helpful error pointing to the correct endpoint
      const globalKeySet = new Set<string>(GLOBAL_SETTINGS_KEYS);
      const globalFieldsFound = Object.keys(clientSettings).filter((k) => globalKeySet.has(k));
      if (globalFieldsFound.length > 0) {
        throw badRequest(`Cannot update global settings via this endpoint. Use PUT /settings/global instead. Global fields found: ${globalFieldsFound.join(", ")}`);
      }

      if (Object.prototype.hasOwnProperty.call(clientSettings, "modelPresets")) {
        clientSettings.modelPresets = validateModelPresets(clientSettings.modelPresets);
      }

      // Validate backup settings if provided
      if (clientSettings.autoBackupSchedule !== undefined && !validateBackupSchedule(clientSettings.autoBackupSchedule)) {
        throw badRequest("Invalid cron expression for autoBackupSchedule");
      }
      if (clientSettings.autoBackupRetention !== undefined && !validateBackupRetention(clientSettings.autoBackupRetention)) {
        throw badRequest("autoBackupRetention must be between 1 and 100");
      }
      if (clientSettings.autoBackupDir !== undefined && !validateBackupDir(clientSettings.autoBackupDir)) {
        throw badRequest("autoBackupDir must be a relative path without '..' traversal");
      }

      const settings = await scopedStore.updateSettings(clientSettings);
      
      // Sync backup automation schedule when backup settings change
      if (options?.automationStore) {
        try {
          await syncBackupAutomation(options.automationStore, settings);
        } catch (err) {
          // Log but don't fail the settings update if automation sync fails
          console.error("Failed to sync backup automation:", err);
        }
      }
      
      res.json(settings);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = typeof err?.message === "string" && (
        err.message.includes("modelPresets") || err.message.includes("must include both provider and modelId")
      ) ? 400 : 500;
      throw new ApiError(status, err.message);
    }
  });

  // ── Project Memory Routes ─────────────────────────────────────

  /**
   * GET /api/memory
   * Returns the project memory file content.
   * If .fusion/memory.md does not exist yet, returns an empty string.
   */
  router.get("/memory", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const memory = await readProjectFile(scopedStore, MEMORY_FILE_PATH);
      res.json({ content: memory.content });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError && err.code === "ENOENT") {
        res.json({ content: "" });
        return;
      }
      rethrowAsApiError(err, "Failed to read memory");
    }
  });

  /**
   * PUT /api/memory
   * Updates the project memory file content.
   * Body: { content: string }
   */
  router.put("/memory", async (req, res) => {
    try {
      const { content } = req.body ?? {};
      if (typeof content !== "string") {
        throw badRequest("content must be a string");
      }

      const scopedStore = await getScopedStore(req);
      await writeProjectFile(scopedStore, MEMORY_FILE_PATH, content);
      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to save memory");
    }
  });

  // ── Global Settings Routes ─────────────────────────────────────

  /**
   * GET /api/settings/global
   * Returns the global (user-level) settings from ~/.pi/fusion/settings.json.
   * Does NOT include computed/server-only fields like githubTokenConfigured.
   */
  router.get("/settings/global", async (_req, res) => {
    try {
      const globalStore = store.getGlobalSettingsStore();
      const settings = await globalStore.getSettings();
      res.json(settings);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PUT /api/settings/global
   * Update global (user-level) settings in ~/.pi/fusion/settings.json.
   * These settings persist across all fn projects for the current user.
   */
  router.put("/settings/global", async (req, res) => {
    try {
      const settings = await store.updateGlobalSettings(req.body);
      res.json(settings);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/settings/scopes
   * Returns settings separated by scope: { global, project }.
   * Useful for the UI to show which scope each setting comes from.
   */
  router.get("/settings/scopes", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const scopes = await scopedStore.getSettingsByScope();
      res.json(scopes);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/settings/test-ntfy
   * Send a test notification to verify ntfy configuration.
   * Returns: { success: true } on success, { error: string } on failure.
   */
  router.post("/settings/test-ntfy", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const settings = await scopedStore.getSettings();

      // Validate ntfy is enabled
      if (!settings.ntfyEnabled) {
        throw badRequest("ntfy notifications are not enabled");
      }

      // Validate topic exists and matches required format
      const topic = settings.ntfyTopic;
      if (!topic || !/^[a-zA-Z0-9_-]{1,64}$/.test(topic)) {
        throw badRequest("ntfy topic is not configured or invalid");
      }

      // Send test notification to ntfy.sh
      const ntfyBaseUrl = "https://ntfy.sh";
      const url = `${ntfyBaseUrl}/${topic}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Title": "Fusion test notification",
          "Priority": "default",
          "Content-Type": "text/plain",
        },
        body: "Fusion test notification — your notifications are working!",
      });

      if (!response.ok) {
        throw new ApiError(502, `ntfy.sh returned ${response.status}: ${response.statusText}`);
      }

      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to send test notification");
    }
  });

  // ── Settings Export/Import Routes ─────────────────────────────────

  /**
   * GET /api/settings/export
   * Export settings as JSON for backup or migration.
   * Query params: ?scope=global|project|both (default: both)
   * Returns: SettingsExportData structure
   */
  router.get("/settings/export", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const scopeParam = req.query.scope as string | undefined;
      const scope = scopeParam === "global" || scopeParam === "project" || scopeParam === "both"
        ? scopeParam
        : "both";

      const exportData = await exportSettings(scopedStore, { scope });
      res.json(exportData);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to export settings");
    }
  });

  /**
   * POST /api/settings/import
   * Import settings from JSON data.
   * Body: { data: SettingsExportData, scope?: 'global'|'project'|'both', merge?: boolean }
   * Returns: { success: true, globalCount: number, projectCount: number }
   */
  router.post("/settings/import", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { data, scope = "both", merge = true } = req.body;

      // Validate the import data
      const validationErrors = validateImportData(data);
      if (validationErrors.length > 0) {
        throw badRequest(`Validation failed: ${validationErrors.join("; ")}`);
      }

      // Perform the import
      const result = await importSettings(scopedStore, data, { scope, merge });

      if (!result.success) {
        throw new ApiError(500, result.error ?? "Import failed", {
          globalCount: result.globalCount,
          projectCount: result.projectCount,
        });
      }

      res.json({
        success: true,
        globalCount: result.globalCount,
        projectCount: result.projectCount,
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to import settings");
    }
  });

  // ── Executor Stats Route ────────────────────────────────────────────

  /**
   * GET /api/executor/stats
   * Returns executor statistics for the status bar.
   * 
   * Counts (running, blocked, queued, in-review, stuck) are derived client-side
   * from the tasks array. This endpoint returns settings-based values and
   * lastActivityAt from the activity log.
   */
  router.get("/executor/stats", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const settings = await scopedStore.getSettings();
      
      // Get the most recent activity timestamp from the activity log
      let lastActivityAt: string | undefined;
      try {
        const activityLog = await scopedStore.getActivityLog({ limit: 1 });
        if (activityLog.length > 0) {
          lastActivityAt = activityLog[0].timestamp;
        }
      } catch {
        // If we can't get activity log, that's OK - just leave lastActivityAt undefined
      }

      res.json({
        globalPause: settings.globalPause ?? false,
        enginePaused: settings.enginePaused ?? false,
        maxConcurrent: settings.maxConcurrent ?? 2,
        lastActivityAt,
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Backup Routes ─────────────────────────────────────────────────

  /**
   * GET /api/backups
   * List all database backups with metadata.
   */
  router.get("/backups", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { createBackupManager } = await import("@fusion/core");
      const settings = await scopedStore.getSettings();
      const manager = createBackupManager(scopedStore["kbDir"], settings);
      const backups = await manager.listBackups();
      
      // Calculate total size
      const totalSize = backups.reduce((sum, b) => sum + b.size, 0);
      
      res.json({
        backups,
        count: backups.length,
        totalSize,
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to list backups");
    }
  });

  /**
   * POST /api/backups
   * Create a new database backup immediately.
   */
  router.post("/backups", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { runBackupCommand } = await import("@fusion/core");
      const settings = await scopedStore.getSettings();
      const result = await runBackupCommand(scopedStore["kbDir"], settings);
      
      if (result.success) {
        res.json({
          success: true,
          backupPath: result.backupPath,
          output: result.output,
          deletedCount: result.deletedCount,
        });
      } else {
        throw new ApiError(500, result.output);
      }
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create backup");
    }
  });

  // Models
  registerModelsRoute(router, options?.modelRegistry, store);

  // List all tasks
  router.get("/tasks", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
      const offset = typeof req.query.offset === "string" ? Number.parseInt(req.query.offset, 10) : undefined;

      if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
        throw badRequest("limit must be a non-negative integer");
      }

      if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
        throw badRequest("offset must be a non-negative integer");
      }

      const tasks = await scopedStore.listTasks({ limit, offset });
      res.json(tasks);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Create task
  router.post("/tasks", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
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
        planningModelProvider,
        planningModelId,
        thinkingLevel,
      } = req.body;
      if (!description || typeof description !== "string") {
        throw badRequest("description is required");
      }
      if (breakIntoSubtasks !== undefined && typeof breakIntoSubtasks !== "boolean") {
        throw badRequest("breakIntoSubtasks must be a boolean");
      }

      const validatedModelProvider = validateOptionalModelField(modelProvider, "modelProvider");
      const validatedModelId = validateOptionalModelField(modelId, "modelId");
      const validatedValidatorModelProvider = validateOptionalModelField(validatorModelProvider, "validatorModelProvider");
      const validatedValidatorModelId = validateOptionalModelField(validatorModelId, "validatorModelId");
      const validatedPlanningModelProvider = validateOptionalModelField(planningModelProvider, "planningModelProvider");
      const validatedPlanningModelId = validateOptionalModelField(planningModelId, "planningModelId");

      // Validate thinkingLevel if provided
      const validThinkingLevels = ["off", "minimal", "low", "medium", "high"];
      if (thinkingLevel !== undefined && thinkingLevel !== null && !validThinkingLevels.includes(thinkingLevel)) {
        throw badRequest(`thinkingLevel must be one of: ${validThinkingLevels.join(", ")}`);
      }

      const executorModel = normalizeModelSelectionPair(validatedModelProvider, validatedModelId);
      const validatorModel = normalizeModelSelectionPair(validatedValidatorModelProvider, validatedValidatorModelId);
      const planningModel = normalizeModelSelectionPair(validatedPlanningModelProvider, validatedPlanningModelId);

      // Validate enabledWorkflowSteps if provided
      if (enabledWorkflowSteps !== undefined) {
        if (!Array.isArray(enabledWorkflowSteps) || !enabledWorkflowSteps.every((id: unknown) => typeof id === "string")) {
          throw badRequest("enabledWorkflowSteps must be an array of strings");
        }
      }

      // Check for summarize flag in request
      const summarize = req.body.summarize === true;

      // Get settings for auto-summarization
      const settings = await scopedStore.getSettings();

      // Create onSummarize callback if summarization is enabled
      const onSummarize = (summarize || settings.autoSummarizeTitles)
        ? async (desc: string): Promise<string | null> => {
            try {
              const { summarizeTitle } = await import("@fusion/core");

              // Resolve model selection hierarchy for summarization
              const resolvedProvider =
                (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerProvider : undefined) ||
                (settings.planningProvider && settings.planningModelId ? settings.planningProvider : undefined) ||
                (settings.defaultProvider && settings.defaultModelId ? settings.defaultProvider : undefined);

              const resolvedModelId =
                (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerModelId : undefined) ||
                (settings.planningProvider && settings.planningModelId ? settings.planningModelId : undefined) ||
                (settings.defaultProvider && settings.defaultModelId ? settings.defaultModelId : undefined);

              return await summarizeTitle(desc, scopedStore.getRootDir(), resolvedProvider, resolvedModelId);
            } catch {
              // Return null on error so task creation continues without title
              return null;
            }
          }
        : undefined;

      const task = await scopedStore.createTask(
        {
          title,
          description,
          column,
          dependencies,
          breakIntoSubtasks,
          enabledWorkflowSteps,
          modelPresetId: validateOptionalModelField(modelPresetId, "modelPresetId"),
          modelProvider: executorModel.provider,
          modelId: executorModel.modelId,
          validatorModelProvider: validatorModel.provider,
          validatorModelId: validatorModel.modelId,
          planningModelProvider: planningModel.provider,
          planningModelId: planningModel.modelId,
          thinkingLevel: thinkingLevel || undefined,
          summarize,
        },
        { onSummarize, settings: { autoSummarizeTitles: settings.autoSummarizeTitles } }
      );
      res.status(201).json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("must be a string") || err.message?.includes("must be an array of strings") ? 400 : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Move task to column
  router.post("/tasks/:id/move", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { column } = req.body;
      if (!column || !COLUMNS.includes(column as Column)) {
        throw badRequest(`Invalid column. Must be one of: ${COLUMNS.join(", ")}`);
      }
      const task = await scopedStore.moveTask(req.params.id, column as Column);
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message.includes("Invalid transition") ? 400 : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Merge task (in-review → done, merges branch + cleans worktree)
  // Uses AI merge handler if provided, falls back to store.mergeTask
  router.post("/tasks/:id/merge", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const merge = options?.onMerge ?? ((id: string) => scopedStore.mergeTask(id));
      const result = await merge(req.params.id);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message.includes("Cannot merge") ? 400
        : err.message.includes("conflict") ? 409
        : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Retry failed or stuck-killed task
  router.post("/tasks/:id/retry", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);
      if (task.status !== "failed" && task.status !== "stuck-killed") {
        throw badRequest(`Task is not in a retryable state (current status: ${task.status || 'none'})`);
      }
      await scopedStore.updateTask(req.params.id, {
        status: null,
        error: null,
        worktree: null,
        branch: null,
      });
      await scopedStore.logEntry(req.params.id, "Retry requested from dashboard");
      const updated = await scopedStore.moveTask(req.params.id, "todo");
      res.json(updated);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Duplicate task
  router.post("/tasks/:id/duplicate", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const newTask = await scopedStore.duplicateTask(req.params.id);
      res.status(201).json(newTask);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Create refinement task from a completed or in-review task
  router.post("/tasks/:id/refine", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { feedback } = req.body;
      if (!feedback || typeof feedback !== "string") {
        throw badRequest("feedback is required and must be a string");
      }
      // Trim before checking length to catch whitespace-only input
      const trimmedFeedback = feedback.trim();
      if (trimmedFeedback.length === 0 || trimmedFeedback.length > 2000) {
        throw badRequest("feedback must be between 1 and 2000 characters");
      }

      const refinedTask = await scopedStore.refineTask(req.params.id, trimmedFeedback);
      await scopedStore.logEntry(req.params.id, "Refinement requested", trimmedFeedback);
      res.status(201).json(refinedTask);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.code === "ENOENT" ? 404
        : err.message?.includes("must be in 'done' or 'in-review'") ? 400
        : err.message?.includes("Feedback is required") ? 400
        : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Archive task (done → archived)
  router.post("/tasks/:id/archive", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.archiveTask(req.params.id);
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("must be in") ? 400 : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Unarchive task (archived → done)
  router.post("/tasks/:id/unarchive", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.unarchiveTask(req.params.id);
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("must be in") ? 400 : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Archive all done tasks
  router.post("/tasks/archive-all-done", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const archived = await scopedStore.archiveAllDone();
      res.json({ archived });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/tasks/batch-update-models
   * Batch update AI model configuration for multiple tasks.
   * Body: { taskIds: string[], modelProvider?: string | null, modelId?: string | null, validatorModelProvider?: string | null, validatorModelId?: string | null, planningModelProvider?: string | null, planningModelId?: string | null }
   * Returns: { updated: Task[], count: number }
   */
  router.post("/tasks/batch-update-models", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { taskIds, modelProvider, modelId, validatorModelProvider, validatorModelId, planningModelProvider, planningModelId } = req.body;

      // Validate taskIds
      if (!Array.isArray(taskIds)) {
        throw badRequest("taskIds must be an array");
      }
      if (taskIds.length === 0) {
        throw badRequest("taskIds must contain at least one task ID");
      }
      if (taskIds.some((id) => typeof id !== "string" || id.trim().length === 0)) {
        throw badRequest("taskIds must contain non-empty strings");
      }

      // Validate that at least one model field is being updated
      const hasExecutorModel = modelProvider !== undefined || modelId !== undefined;
      const hasValidatorModel = validatorModelProvider !== undefined || validatorModelId !== undefined;
      const hasPlanningModel = planningModelProvider !== undefined || planningModelId !== undefined;
      if (!hasExecutorModel && !hasValidatorModel && !hasPlanningModel) {
        throw badRequest("At least one model field must be provided");
      }

      // Validate model field pairs (both provider and modelId must be provided together or neither)
      const validateModelPair = (provider: unknown, modelIdValue: unknown, name: string): { provider?: string | null; modelId?: string | null } => {
        if (provider === undefined && modelIdValue === undefined) {
          return { provider: undefined, modelId: undefined };
        }
        if ((provider !== undefined && modelIdValue === undefined) || (provider === undefined && modelIdValue !== undefined)) {
          throw new Error(`${name} must include both provider and modelId or neither`);
        }
        if (provider !== null && typeof provider !== "string") {
          throw new Error(`${name} provider must be a string or null`);
        }
        if (modelIdValue !== null && typeof modelIdValue !== "string") {
          throw new Error(`${name} modelId must be a string or null`);
        }
        return { provider: provider as string | null, modelId: modelIdValue as string | null };
      };

      let validatedExecutor: { provider?: string | null; modelId?: string | null };
      let validatedValidator: { provider?: string | null; modelId?: string | null };
      let validatedPlanning: { provider?: string | null; modelId?: string | null };

      try {
        validatedExecutor = validateModelPair(modelProvider, modelId, "Executor model");
        validatedValidator = validateModelPair(validatorModelProvider, validatorModelId, "Validator model");
        validatedPlanning = validateModelPair(planningModelProvider, planningModelId, "Planning model");
      } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
        throw badRequest(err.message);
      }

      // Verify all tasks exist
      const tasksById = new Map<string, Awaited<ReturnType<TaskStore["getTask"]>>>();
      for (const taskId of taskIds) {
        try {
          const task = await scopedStore.getTask(taskId);
          tasksById.set(taskId, task);
        } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
          if (err?.code === "ENOENT" || err?.message?.includes("not found")) {
            throw notFound(`Task ${taskId} not found`);
          }
          throw err;
        }
      }

      // Build update payload (only include fields that were explicitly provided)
      const updates: { modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null; planningModelProvider?: string | null; planningModelId?: string | null } = {};
      if (validatedExecutor.provider !== undefined) {
        updates.modelProvider = validatedExecutor.provider;
      }
      if (validatedExecutor.modelId !== undefined) {
        updates.modelId = validatedExecutor.modelId;
      }
      if (validatedValidator.provider !== undefined) {
        updates.validatorModelProvider = validatedValidator.provider;
      }
      if (validatedValidator.modelId !== undefined) {
        updates.validatorModelId = validatedValidator.modelId;
      }
      if (validatedPlanning.provider !== undefined) {
        updates.planningModelProvider = validatedPlanning.provider;
      }
      if (validatedPlanning.modelId !== undefined) {
        updates.planningModelId = validatedPlanning.modelId;
      }

      // Update all tasks in parallel
      const updatePromises = taskIds.map(async (taskId) => {
        try {
          const updated = await scopedStore.updateTask(taskId, updates);
          return { success: true, task: updated };
        } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
          console.error(`Failed to update task ${taskId}:`, err);
          const success = false;
          return { success, taskId, error: err.message };
        }
      });

      const results = await Promise.all(updatePromises);

      // Collect successful updates
      const updated: Task[] = [];
      const errors: Array<{ taskId: string; error: string }> = [];

      for (const result of results) {
        if (result.success && "task" in result && result.task) {
          updated.push(result.task);
        } else if (!result.success) {
          errors.push({ taskId: result.taskId, error: result.error });
        }
      }

      // Log errors but don't fail the entire request
      if (errors.length > 0) {
        console.error(`[batch-update-models] ${errors.length} tasks failed to update:`, errors);
      }

      res.json({ updated, count: updated.length });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to batch update models");
    }
  });

  // Upload attachment
  router.post("/tasks/:id/attachments", upload.single("file"), async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      if (!req.file) {
        throw badRequest("No file provided");
      }
      const attachment = await scopedStore.addAttachment(
        req.params.id as string,
        req.file.originalname,
        req.file.buffer,
        req.file.mimetype,
      );
      res.status(201).json(attachment);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message.includes("Invalid mime type") || err.message.includes("File too large") ? 400 : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Download attachment
  router.get("/tasks/:id/attachments/:filename", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { path, mimeType } = await scopedStore.getAttachment(req.params.id, req.params.filename);
      res.setHeader("Content-Type", mimeType);
      createReadStream(path).pipe(res);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound("Attachment not found");
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Delete attachment
  router.delete("/tasks/:id/attachments/:filename", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.deleteAttachment(req.params.id, req.params.filename);
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound("Attachment not found");
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Get historical agent logs for a task.
  // Per-entry text and detail fields are returned in full — no truncation.
  // The 500-entry cap (MAX_LOG_ENTRIES) is a client-side whole-list limit.
  router.get("/tasks/:id/logs", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const logs = await scopedStore.getAgentLogs(req.params.id);
      res.json(logs);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * Resolve the diff base ref for a task's worktree.
   *
   * Strategy (in priority order):
   * 1. **Task-scoped** — When the task has a `baseCommitSha` that is still
   *    a valid ancestor of the current HEAD in the worktree, use it.  This
   *    keeps the changed-files list scoped to files introduced by *this*
   *    specific task, even in shared or recycled worktree scenarios.
   * 2. **Branch merge-base** — Fall back to the merge-base between HEAD and
   *    `origin/{baseBranch}` (or bare `{baseBranch}`).
   * 3. **HEAD~1** — Last resort when neither baseCommitSha nor merge-base
   *    can be resolved.
   */
  function resolveDiffBase(task: { baseCommitSha?: string; baseBranch?: string }, cwd: string): string | undefined {
    // 1. Try task-scoped baseCommitSha
    if (task.baseCommitSha) {
      try {
        // Validate that the stored SHA is still an ancestor of HEAD.
        // If the branch was rebased or the SHA is otherwise unreachable,
        // this will exit non-zero and we fall through.
        nodeChildProcess.execSync(
          `git merge-base --is-ancestor ${task.baseCommitSha} HEAD`,
          { cwd, encoding: "utf-8", timeout: 5000, stdio: "pipe" },
        );
        return task.baseCommitSha;
      } catch {
        // baseCommitSha is stale or invalid — fall through to merge-base
      }
    }

    // 2. Branch merge-base
    const baseBranch = task.baseBranch ?? "main";
    try {
      return nodeChildProcess.execSync(
        `git merge-base HEAD origin/${baseBranch} 2>/dev/null || git merge-base HEAD ${baseBranch}`,
        { cwd, encoding: "utf-8", timeout: 5000 },
      ).trim() || undefined;
    } catch {
      // merge-base unavailable — fall through to HEAD~1
    }

    // 3. HEAD~1 fallback
    try {
      return nodeChildProcess.execSync("git rev-parse HEAD~1", {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
      }).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  router.get("/tasks/:id/session-files", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task.worktree || !nodeFs.existsSync(task.worktree)) {
        res.json([]);
        return;
      }

      const cached = sessionFilesCache.get(task.id);
      if (cached && cached.expiresAt > Date.now()) {
        res.json(cached.files);
        return;
      }

      let files: string[] = [];

      try {
        const fileSet = new Set<string>();
        const baseRef = resolveDiffBase(task, task.worktree);

        if (baseRef) {
          const committedOutput = nodeChildProcess.execSync(`git diff --name-only ${baseRef}..HEAD`, {
            cwd: task.worktree,
            encoding: "utf-8",
            timeout: 5000,
          }).trim();
          for (const file of committedOutput.split("\n").filter(Boolean)) {
            fileSet.add(file);
          }
        }

        const workingTreeOutput = nodeChildProcess.execSync("git diff --name-only", {
          cwd: task.worktree,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        for (const file of workingTreeOutput.split("\n").filter(Boolean)) {
          fileSet.add(file);
        }

        files = Array.from(fileSet);
      } catch {
        files = [];
      }

      sessionFilesCache.set(task.id, {
        files,
        expiresAt: Date.now() + 10000,
      });

      res.json(files);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * GET /api/tasks/:id/workflow-results
   * Get workflow step execution results for a task.
   * Returns: WorkflowStepResult[]
   */
  router.get("/tasks/:id/workflow-results", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);
      res.json(task.workflowStepResults || []);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // Get single task with prompt content
  router.get("/tasks/:id", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      // ENOENT means the task directory/file genuinely doesn't exist → 404.
      // Any other error (e.g. JSON parse failure from a concurrent partial write,
      // or a transient FS error) should surface as 500 so clients can retry.
      if (err.code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // Pause task
  router.post("/tasks/:id/pause", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.pauseTask(req.params.id, true);
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Unpause task
  router.post("/tasks/:id/unpause", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.pauseTask(req.params.id, false);
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Approve plan for a task in awaiting-approval status
  router.post("/tasks/:id/approve-plan", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);

      // Verify task is in triage column with awaiting-approval status
      if (task.column !== "triage") {
        throw badRequest("Task must be in 'triage' column to approve plan");
      }
      if (task.status !== "awaiting-approval") {
        throw badRequest("Task must have status 'awaiting-approval' to approve plan");
      }

      // Log the approval
      await scopedStore.logEntry(task.id, "Plan approved by user");

      // Move to todo and clear status
      const updated = await scopedStore.moveTask(task.id, "todo");
      await scopedStore.updateTask(task.id, { status: undefined });

      res.json({ ...updated, status: undefined });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Reject plan for a task in awaiting-approval status
  router.post("/tasks/:id/reject-plan", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);

      // Verify task is in triage column with awaiting-approval status
      if (task.column !== "triage") {
        throw badRequest("Task must be in 'triage' column to reject plan");
      }
      if (task.status !== "awaiting-approval") {
        throw badRequest("Task must have status 'awaiting-approval' to reject plan");
      }

      // Log the rejection
      await scopedStore.logEntry(task.id, "Plan rejected by user", "Specification will be regenerated");

      // Clear status to return to normal triage state
      await scopedStore.updateTask(task.id, { status: undefined });

      // Remove PROMPT.md to force regeneration
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      const updated = await scopedStore.getTask(task.id);
      res.json(updated);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err.message);
    }
  });

  router.get("/tasks/:id/comments", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);
      res.json(task.comments || []);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err.message);
    }
  });

  router.post("/tasks/:id/comments", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { text, author } = req.body;
      if (!text || typeof text !== "string") {
        throw badRequest("text is required and must be a string");
      }
      if (text.length === 0 || text.length > 2000) {
        throw badRequest("text must be between 1 and 2000 characters");
      }
      if (author !== undefined && typeof author !== "string") {
        throw badRequest("author must be a string");
      }
      const task = await scopedStore.addTaskComment(req.params.id, text, author?.trim() || "user");
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err.message);
    }
  });

  router.patch("/tasks/:id/comments/:commentId", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        throw badRequest("text is required and must be a string");
      }
      if (text.length === 0 || text.length > 2000) {
        throw badRequest("text must be between 1 and 2000 characters");
      }
      const task = await scopedStore.updateTaskComment(req.params.id, req.params.commentId, text);
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.code === "ENOENT" ? 404
        : err.message?.includes("not found") ? 404
        : 500;
      throw new ApiError(status, err.message);
    }
  });

  router.delete("/tasks/:id/comments/:commentId", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.deleteTaskComment(req.params.id, req.params.commentId);
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.code === "ENOENT" ? 404
        : err.message?.includes("not found") ? 404
        : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Add steering comment to task
  router.post("/tasks/:id/steer", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        throw badRequest("text is required and must be a string");
      }
      if (text.length === 0 || text.length > 2000) {
        throw badRequest("text must be between 1 and 2000 characters");
      }
      const task = await scopedStore.addSteeringComment(req.params.id, text, "user");
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Request AI revision of task spec
  router.post("/tasks/:id/spec/revise", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { feedback } = req.body;
      if (!feedback || typeof feedback !== "string") {
        throw badRequest("feedback is required and must be a string");
      }
      if (feedback.length === 0 || feedback.length > 2000) {
        throw badRequest("feedback must be between 1 and 2000 characters");
      }

      // Get current task state
      const task = await scopedStore.getTask(req.params.id);

      // Check if task can transition to triage
      const canTransition = VALID_TRANSITIONS[task.column]?.includes("triage");
      if (!canTransition) {
        throw badRequest(
          `Cannot request spec revision for tasks in '${task.column}' column. Move task to 'todo' or 'in-progress' first.`,
        );
      }

      // Log the revision request
      await scopedStore.logEntry(task.id, "AI spec revision requested", feedback);

      // Move to triage for re-specification (only valid for todo/in-progress)
      const updated = await scopedStore.moveTask(task.id, "triage");

      // Update status to indicate needs re-specification
      await scopedStore.updateTask(task.id, { status: "needs-respecify" });

      res.json(updated);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.code === "ENOENT" ? 404
        : err.message?.includes("Invalid transition") ? 400
        : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Rebuild task spec without feedback
  router.post("/tasks/:id/spec/rebuild", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);

      // Get current task state
      const task = await scopedStore.getTask(req.params.id);

      // Check if task can transition to triage
      const canTransition = VALID_TRANSITIONS[task.column]?.includes("triage");
      if (!canTransition) {
        throw badRequest(`Cannot rebuild spec for tasks in '${task.column}' column. Move task to a valid column first.`);
      }

      // Log the rebuild request
      await scopedStore.logEntry(task.id, "Specification rebuild requested by user");

      // Move to triage for re-specification
      const updated = await scopedStore.moveTask(task.id, "triage");

      // Update status to indicate needs re-specification
      await scopedStore.updateTask(task.id, { status: "needs-respecify" });

      res.json(updated);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.code === "ENOENT" ? 404
        : err.message?.includes("Invalid transition") ? 400
        : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Update task
  router.patch("/tasks/:id", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { title, description, prompt, dependencies, enabledWorkflowSteps, modelProvider, modelId, validatorModelProvider, validatorModelId, planningModelProvider, planningModelId, thinkingLevel } = req.body;

      // Validate model fields are strings or undefined/null
      const validateModelField = (value: unknown, name: string): string | null | undefined => {
        if (value === undefined || value === null) return null;
        if (typeof value !== "string") {
          throw new Error(`${name} must be a string`);
        }
        return value;
      };

      const validatedModelProvider = validateModelField(modelProvider, "modelProvider");
      const validatedModelId = validateModelField(modelId, "modelId");
      const validatedValidatorModelProvider = validateModelField(validatorModelProvider, "validatorModelProvider");
      const validatedValidatorModelId = validateModelField(validatorModelId, "validatorModelId");
      const validatedPlanningModelProvider = validateModelField(planningModelProvider, "planningModelProvider");
      const validatedPlanningModelId = validateModelField(planningModelId, "planningModelId");

      // Validate thinkingLevel if provided
      const validThinkingLevels = ["off", "minimal", "low", "medium", "high"];
      if (thinkingLevel !== undefined && thinkingLevel !== null && !validThinkingLevels.includes(thinkingLevel)) {
        throw new Error(`thinkingLevel must be one of: ${validThinkingLevels.join(", ")}`);
      }

      if (enabledWorkflowSteps !== undefined) {
        if (!Array.isArray(enabledWorkflowSteps) || !enabledWorkflowSteps.every((id: unknown) => typeof id === "string")) {
          throw new Error("enabledWorkflowSteps must be an array of strings");
        }
      }

      const task = await scopedStore.updateTask(req.params.id, {
        title,
        description,
        prompt,
        dependencies,
        enabledWorkflowSteps,
        modelProvider: validatedModelProvider,
        modelId: validatedModelId,
        validatorModelProvider: validatedValidatorModelProvider,
        validatorModelId: validatedValidatorModelId,
        planningModelProvider: validatedPlanningModelProvider,
        planningModelId: validatedPlanningModelId,
        thinkingLevel: thinkingLevel === null ? null : thinkingLevel,
      });
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("must be a string") || err.message?.includes("must be an array of strings") || err.message?.includes("thinkingLevel must be one of") ? 400 : 500;
      throw new ApiError(status, err.message);
    }
  });

  // Assign or unassign a task to an explicit agent
  router.patch("/tasks/:id/assign", async (req, res) => {
    try {
      const { agentId } = req.body as { agentId?: string | null };
      if (agentId !== null && typeof agentId !== "string") {
        throw badRequest("agentId must be a string or null");
      }
      if (typeof agentId === "string" && agentId.trim().length === 0) {
        throw badRequest("agentId must be a non-empty string or null");
      }

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      if (typeof agentId === "string") {
        const agent = await agentStore.getAgent(agentId);
        if (!agent) {
          throw notFound("Agent not found");
        }
      }

      const task = await scopedStore.updateTask(req.params.id, {
        assignedAgentId: agentId === null ? null : agentId,
      });
      res.json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err?.code === "ENOENT" || err?.message?.includes("not found")) {
        throw notFound(err.message ?? "Task not found");
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Delete task
  router.delete("/tasks/:id", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.deleteTask(req.params.id);
      res.json(task);
    } catch (err: any) {
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
  router.get("/git/remotes", (_req, res) => {
    try {
      const rootDir = store.getRootDir();
      const remotes = getGitHubRemotes(rootDir);
      res.json(remotes);
    } catch (err: any) {
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
  router.get("/git/remotes/detailed", (_req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const remotes = listGitRemotes(rootDir);
      res.json(remotes);
    } catch (err: any) {
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { name, url } = req.body;
      if (!name || typeof name !== "string") {
        throw badRequest("name is required");
      }
      if (!url || typeof url !== "string") {
        throw badRequest("url is required");
      }
      addGitRemote(name, url, rootDir);
      res.status(201).json({ name, added: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("Invalid remote name")) {
        throw badRequest(err.message);
      } else if (err.message?.includes("Invalid git URL")) {
        throw badRequest(err.message);
      } else if (err.message?.includes("already exists")) {
        throw conflict(err.message);
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      removeGitRemote(name, rootDir);
      res.json({ name, removed: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("Invalid remote name")) {
        throw badRequest(err.message);
      } else if (err.message?.includes("does not exist")) {
        throw notFound(err.message);
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      const { newName } = req.body;
      if (!newName || typeof newName !== "string") {
        throw badRequest("newName is required");
      }
      renameGitRemote(name, newName, rootDir);
      res.json({ oldName: name, newName, renamed: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("Invalid")) {
        throw badRequest(err.message);
      } else if (err.message?.includes("does not exist")) {
        throw notFound(err.message);
      } else if (err.message?.includes("already exists")) {
        throw conflict(err.message);
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      const { url } = req.body;
      if (!url || typeof url !== "string") {
        throw badRequest("url is required");
      }
      setGitRemoteUrl(name, url, rootDir);
      res.json({ name, url, updated: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("Invalid")) {
        throw badRequest(err.message);
      } else if (err.message?.includes("does not exist")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/git/status
   * Returns current git status: branch, commit hash, dirty state, ahead/behind counts.
   * Response: { branch: string, commit: string, isDirty: boolean, ahead: number, behind: number }
   */
  router.get("/git/status", (_req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const status = getGitStatus(rootDir);
      if (!status) {
        throw internalError("Failed to get git status");
      }
      res.json(status);
    } catch (err: any) {
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
  router.get("/git/commits", (req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
      const commits = getGitCommits(limit, rootDir);
      res.json(commits);
    } catch (err: any) {
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
  router.get("/git/commits/:hash/diff", (req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { hash } = req.params;
      // Validate hash format (only hex characters, 7-40 chars)
      if (!/^[a-f0-9]{7,40}$/i.test(hash)) {
        throw badRequest("Invalid commit hash format");
      }
      const diff = getCommitDiff(hash, rootDir);
      if (!diff) {
        throw notFound("Commit not found");
      }
      res.json(diff);
    } catch (err: any) {
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
  router.get("/git/commits/ahead", (_req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const commits = getAheadCommits(rootDir);
      res.json(commits);
    } catch (err: any) {
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
  router.get("/git/remotes/:name/commits", (req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
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
          const headRef = execSync(`git symbolic-ref refs/remotes/${name}/HEAD`, {
            encoding: "utf-8",
            timeout: 5000,
            cwd: rootDir,
          }).trim();
          // symbolic-ref returns full ref like refs/remotes/origin/main
          remoteRef = headRef.replace(/^refs\/remotes\//, "");
        } catch {
          // Try common defaults
          try {
            execSync(`git rev-parse --verify "${name}/main"`, {
              encoding: "utf-8",
              timeout: 5000,
              cwd: rootDir,
            });
            remoteRef = `${name}/main`;
          } catch {
            try {
              execSync(`git rev-parse --verify "${name}/master"`, {
                encoding: "utf-8",
                timeout: 5000,
                cwd: rootDir,
              });
              remoteRef = `${name}/master`;
            } catch {
              // Remote exists but no common branch found
              res.json([]);
              return;
            }
          }
        }
      }

      const commits = getRemoteCommits(remoteRef, limit, rootDir);
      res.json(commits);
    } catch (err: any) {
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
  router.get("/git/branches", (_req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const branches = getGitBranches(rootDir);
      res.json(branches);
    } catch (err: any) {
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
  router.get("/git/branches/:name/commits", (req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      if (!isValidGitRef(name)) {
        throw badRequest("Invalid branch name");
      }
      const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 10, 1), 100);
      const commits = getGitCommitsForBranch(name, limit, rootDir);
      res.json(commits);
    } catch (err: any) {
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
  router.get("/git/worktrees", async (_req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      // Get tasks to correlate with worktrees
      const tasks = await store.listTasks();
      const worktrees = getGitWorktrees(tasks, rootDir);
      res.json(worktrees);
    } catch (err: any) {
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { name, base } = req.body;
      if (!name || typeof name !== "string") {
        throw badRequest("name is required");
      }
      const branchName = createGitBranch(name, base, rootDir);
      res.status(201).json({ name: branchName, created: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message.includes("Invalid branch name")) {
        throw badRequest(err.message);
      } else if (err.message.includes("already exists")) {
        throw conflict(err.message);
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      checkoutGitBranch(name, rootDir);
      res.json({ checkedOut: name });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message.includes("Invalid branch name")) {
        throw badRequest(err.message);
      } else if (err.message.includes("Uncommitted changes")) {
        throw conflict(err.message);
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      const force = req.query.force === "true";
      deleteGitBranch(name, force, rootDir);
      res.json({ deleted: name });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message.includes("Invalid branch name")) {
        throw badRequest(err.message);
      } else if (err.message.includes("Cannot delete branch") || err.message.includes("is currently checked out")) {
        throw conflict(err.message);
      } else if (err.message.includes("not fully merged")) {
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { remote } = req.body;
      const result = fetchGitRemote(remote || "origin", rootDir);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message.includes("Invalid remote name")) {
        throw badRequest(err.message);
      } else if (err.message.includes("Failed to connect")) {
        throw new ApiError(503, err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/git/pull
   * Pull the current branch.
   */
  router.post("/git/pull", async (_req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const result = pullGitBranch(rootDir);
      if (result.conflict) {
        throw new ApiError(409, result.message ?? "Merge conflict detected. Resolve manually.", {
          ...result,
        });
      }
      res.json(result);
    } catch (err: any) {
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
  router.post("/git/push", async (_req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const result = pushGitBranch(rootDir);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message.includes("rejected") || err.message.includes("Pull latest")) {
        throw conflict(err.message);
      } else if (err.message.includes("Failed to connect")) {
        throw new ApiError(503, err.message);
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
  router.get("/git/stashes", (_req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const stashes = getGitStashList(rootDir);
      res.json(stashes);
    } catch (err: any) {
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { message } = req.body;
      const result = createGitStash(message, rootDir);
      res.status(201).json({ message: result });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("No local changes")) {
        throw badRequest(err.message);
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const index = parseInt(req.params.index, 10);
      if (isNaN(index) || index < 0) {
        throw badRequest("Invalid stash index");
      }
      const { drop } = req.body;
      const result = applyGitStash(index, drop === true, rootDir);
      res.json({ message: result });
    } catch (err: any) {
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const index = parseInt(req.params.index, 10);
      if (isNaN(index) || index < 0) {
        throw badRequest("Invalid stash index");
      }
      const result = dropGitStash(index, rootDir);
      res.json({ message: result });
    } catch (err: any) {
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
  router.get("/git/diff", (_req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const diff = getGitWorkingDiff(rootDir);
      res.json(diff);
    } catch (err: any) {
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
  router.get("/git/changes", (_req, res) => {
    try {
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const changes = getGitFileChanges(rootDir);
      res.json(changes);
    } catch (err: any) {
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        throw badRequest("files array is required");
      }
      const staged = stageGitFiles(files, rootDir);
      res.json({ staged });
    } catch (err: any) {
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        throw badRequest("files array is required");
      }
      const unstaged = unstageGitFiles(files, rootDir);
      res.json({ unstaged });
    } catch (err: any) {
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { message } = req.body;
      if (!message || typeof message !== "string" || !message.trim()) {
        throw badRequest("Commit message is required");
      }
      const result = createGitCommit(message, rootDir);
      res.status(201).json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("No staged changes")) {
        throw badRequest(err.message);
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
      const rootDir = store.getRootDir();
      if (!isGitRepo(rootDir)) {
        throw badRequest("Not a git repository");
      }
      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        throw badRequest("files array is required");
      }
      const discarded = discardGitChanges(files, rootDir);
      res.json({ discarded });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

// ── GitHub Import Routes ──────────────────────────────────────────

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
      } catch (err: any) {
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
    } catch (err: any) {
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
      const scopedStore = await getScopedStore(req);

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
      } catch (err: any) {
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
      const existingTasks = await scopedStore.listTasks();
      const sourceUrl = issue.html_url;
      for (const existingTask of existingTasks) {
        if (existingTask.description.includes(sourceUrl)) {
          throw new ApiError(409, `Issue #${issueNumber} already imported as ${existingTask.id}`, {
            existingTaskId: existingTask.id,
          });
        }
      }

      // Create the task
      const title = issue.title.slice(0, 200);
      const body = issue.body?.trim() || "(no description)";
      const description = `${body}\n\nSource: ${sourceUrl}`;

      const task = await scopedStore.createTask({
        title: title || undefined,
        description,
        column: "triage",
        dependencies: [],
      });

      // Log the import action
      await scopedStore.logEntry(task.id, "Imported from GitHub", sourceUrl);

      res.status(201).json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
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
  const batchImportRateLimiter = (() => {
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
  })();

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
      const scopedStore = await getScopedStore(req);

      // Get existing tasks to check for duplicates
      const existingTasks = await scopedStore.listTasks();

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
        const fetchResult = await githubClient.fetchThrottled<{
          number: number;
          title: string;
          body: string | null;
          html_url: string;
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
        const existingTask = existingTasks.find((t) => t.description.includes(sourceUrl));
        if (existingTask) {
          results.push({
            issueNumber,
            success: true,
            skipped: true,
            taskId: existingTask.id,
          });
          continue;
        }

        // Create the task
        const title = issue.title.slice(0, 200);
        const body = issue.body?.trim() || "(no description)";
        const description = `${body}\n\nSource: ${sourceUrl}`;

        try {
          const task = await scopedStore.createTask({
            title: title || undefined,
            description,
            column: "triage",
            dependencies: [],
          });

          // Log the import action
          await scopedStore.logEntry(task.id, "Imported from GitHub", sourceUrl);

          results.push({
            issueNumber,
            success: true,
            taskId: task.id,
          });

          // Add to existingTasks to avoid duplicate imports within the same batch
          existingTasks.push({ ...task, description });
        } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
          results.push({
            issueNumber,
            success: false,
            error: err.message ?? "Failed to create task",
          });
        }
      }

      res.json({ results });
    } catch (err: any) {
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
      } catch (err: any) {
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
    } catch (err: any) {
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
      const scopedStore = await getScopedStore(req);

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
      } catch (err: any) {
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
      const existingTasks = await scopedStore.listTasks();
      const sourceUrl = pr.html_url;
      for (const existingTask of existingTasks) {
        if (existingTask.description.includes(sourceUrl)) {
          throw new ApiError(409, `PR #${prNumber} already imported as ${existingTask.id}`, {
            existingTaskId: existingTask.id,
          });
        }
      }

      // Create the task with "Review PR:" prefix
      const title = `Review PR #${pr.number}: ${pr.title.slice(0, 180)}`;
      const body = pr.body?.trim() || "(no description)";
      const description = `Review and address any issues in this pull request.\n\nPR: ${sourceUrl}\nBranch: ${pr.headBranch} → ${pr.baseBranch}\n\n${body}`;

      const task = await scopedStore.createTask({
        title: title || undefined,
        description,
        column: "triage",
        dependencies: [],
      });

      // Log the import action
      await scopedStore.logEntry(task.id, "Imported PR from GitHub", sourceUrl);

      res.status(201).json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ---------- Auth routes ----------
  registerAuthRoutes(router, options?.authStorage);

  // ── PR Management Routes ─────────────────────────────────────────

  /**
   * POST /api/tasks/:id/pr/create
   * Create a GitHub PR for an in-review task.
   * Body: { title: string, body?: string, base?: string }
   * Returns: Created PrInfo
   */
  router.post("/tasks/:id/pr/create", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { title, body, base } = req.body;

      if (!title || typeof title !== "string") {
        throw badRequest("title is required and must be a string");
      }

      // Get task and validate
      const task = await scopedStore.getTask(req.params.id);
      if (task.column !== "in-review") {
        throw badRequest("Task must be in 'in-review' column to create a PR");
      }

      if (task.prInfo) {
        throw conflict(`Task already has PR #${task.prInfo.number}: ${task.prInfo.url}`);
      }

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
        const gitRepo = getCurrentGitHubRepo(scopedStore.getRootDir());
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

      // Create the PR
      const client = new GitHubClient();

      const prInfo = await client.createPr({
        owner,
        repo,
        title,
        body,
        head: branchName,
        base,
      });

      // Store PR info
      await scopedStore.updatePrInfo(task.id, prInfo);
      await scopedStore.logEntry(task.id, "Created PR", `PR #${prInfo.number}: ${prInfo.url}`);

      res.status(201).json(prInfo);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else if (err.message?.includes("already exists")) {
        throw conflict(err.message);
      } else if (err.message?.includes("No commits between")) {
        throw badRequest("Branch has no commits. Push changes before creating PR.");
      } else {
        rethrowAsApiError(err, "Failed to create PR");
      }
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

    // Find all matching tasks by badge URL
    const tasks = await store.listTasks();
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
        const next = { ...(badgeData as Omit<PrInfo, "lastCheckedAt">), lastCheckedAt: checkedAt };
        const changed = hasPrBadgeFieldsChanged(current, badgeData as Omit<PrInfo, "lastCheckedAt">);
        if (changed || current.lastCheckedAt !== checkedAt) {
          await store.updatePrInfo(match.id, next);
          if (changed) badgeFieldsChanged = true;
        }
      } else {
        const current = match.current as import("@fusion/core").IssueInfo;
        const next = { ...(badgeData as Omit<import("@fusion/core").IssueInfo, "lastCheckedAt">), lastCheckedAt: checkedAt };
        const changed = hasIssueBadgeFieldsChanged(current, badgeData as Omit<import("@fusion/core").IssueInfo, "lastCheckedAt">);
        if (changed || current.lastCheckedAt !== checkedAt) {
          await store.updateIssueInfo(match.id, next);
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
   * GET /api/tasks/:id/pr/status
   * Get cached PR status for a task. Triggers background refresh if stale (>5 min).
   * Uses only persisted badge timestamps (no in-memory poller state).
   */
  router.get("/tasks/:id/pr/status", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);

      if (!task.prInfo) {
        throw notFound("Task has no associated PR");
      }

      // Check if data is stale (>5 minutes since last check)
      const fiveMinutesMs = 5 * 60 * 1000;
      const lastChecked = task.prInfo.lastCheckedAt || task.updatedAt;
      const lastCheckedTime = new Date(lastChecked).getTime();
      const isStale = Date.now() - lastCheckedTime > fiveMinutesMs;

      // Return cached data immediately
      res.json({
        prInfo: task.prInfo,
        stale: isStale,
        automationStatus: task.status ?? null,
      });

      // Trigger background refresh if stale (don't await, let it run)
      if (isStale) {
        refreshPrInBackground(scopedStore, task.id, task.prInfo, githubToken);
      }
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
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
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);

      if (!task.prInfo) {
        throw notFound("Task has no associated PR");
      }

      // Get owner/repo from badge URL first, then fall back to env/git
      let owner: string;
      let repo: string;

      const badgeParsed = parseBadgeUrl(task.prInfo.url);
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
          const gitRepo = getCurrentGitHubRepo(scopedStore.getRootDir());
          if (!gitRepo) {
            throw badRequest("Could not determine GitHub repository");
          }
          owner = gitRepo.owner;
          repo = gitRepo.repo;
        }
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

      // Fetch fresh PR status + merge readiness
      const client = new GitHubClient();
      const mergeStatus = await client.getPrMergeStatus(owner, repo, task.prInfo.number);

      const prInfo = {
        ...mergeStatus.prInfo,
        lastCheckedAt: new Date().toISOString(),
      };

      // Update stored PR info
      await scopedStore.updatePrInfo(task.id, prInfo);

      res.json({
        prInfo,
        mergeReady: mergeStatus.mergeReady,
        blockingReasons: mergeStatus.blockingReasons,
        reviewDecision: mergeStatus.reviewDecision,
        checks: mergeStatus.checks,
        automationStatus: task.status ?? null,
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
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
      const scopedStore = await getScopedStore(req);
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
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
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
      const scopedStore = await getScopedStore(req);
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
          const gitRepo = getCurrentGitHubRepo(scopedStore.getRootDir());
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
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/github/batch/status
   * Refresh issue/PR badge status for up to 100 tasks in grouped GitHub requests.
   * Body: { taskIds: string[] }
   */
  router.post("/github/batch/status", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
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
        } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
          if (err?.code === "ENOENT") {
            appendBatchStatusError(results, taskId, `Task ${taskId} not found`);
          } else {
            appendBatchStatusError(results, taskId, err.message || `Failed to load task ${taskId}`);
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
        } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
          for (const taskId of group.taskIds) {
            appendBatchStatusError(results, taskId, err.message || `Failed to refresh issue badges for ${repoKey}`);
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
              ...prInfo,
              lastCheckedAt: refreshedAt,
            };
            await scopedStore.updatePrInfo(taskId, updatedPrInfo);
            const entry = ensureBatchStatusEntry(results, taskId);
            entry.prInfo = updatedPrInfo;
            entry.stale = entry.issueInfo ? isBatchStatusStale(entry.issueInfo, task.updatedAt) : false;
          }
        } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
          for (const taskId of group.taskIds) {
            appendBatchStatusError(results, taskId, err.message || `Failed to refresh PR badges for ${repoKey}`);
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
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to batch refresh GitHub status");
    }
  });

  // ── Terminal Routes ─────────────────────────────────────────────────

  /**
   * POST /api/terminal/exec
   * Execute a shell command in the project root directory.
   * Body: { command: string }
   * Returns: { sessionId: string }
   * 
   * Output is streamed via SSE at /api/terminal/sessions/:id/stream
   */
  router.post("/terminal/exec", async (req, res) => {
    try {
      const { command } = req.body;
      
      if (!command || typeof command !== "string") {
        throw badRequest("command is required and must be a string");
      }
      
      if (command.length > 4096) {
        throw badRequest("command exceeds maximum length of 4096 characters");
      }
      
      const rootDir = store.getRootDir();
      const result = terminalSessionManager.createSession(command, rootDir);
      
      if (result.error) {
        throw new ApiError(403, result.error);
      }
      
      res.status(201).json({ sessionId: result.sessionId });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to execute command");
    }
  });

  /**
   * POST /api/terminal/sessions/:id/kill
   * Terminate a running terminal session.
   * Returns: { killed: boolean }
   */
  router.post("/terminal/sessions/:id/kill", (req, res) => {
    try {
      const { id } = req.params;
      const { signal } = req.body;
      
      const validSignals: NodeJS.Signals[] = ["SIGTERM", "SIGKILL", "SIGINT"];
      const killSignal = validSignals.includes(signal) ? signal : "SIGTERM";
      
      const killed = terminalSessionManager.killSession(id, killSignal);
      
      if (!killed) {
        const session = terminalSessionManager.getSession(id);
        if (!session) {
          throw notFound("Session not found");
        } else {
          throw badRequest("Session is not running");
        }
        return;
      }
      
      res.json({ killed: true, sessionId: id });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/terminal/sessions/:id
   * Get session status and output history.
   * Returns: { id, command, running, exitCode, output }
   */
  router.get("/terminal/sessions/:id", (req, res) => {
    try {
      const session = terminalSessionManager.getSession(req.params.id);
      
      if (!session) {
        throw notFound("Session not found");
      }
      
      res.json({
        id: session.id,
        command: session.command,
        running: session.exitCode === null && !session.killed,
        exitCode: session.exitCode,
        output: session.output.join(""),
        startTime: session.startTime.toISOString(),
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/terminal/sessions/:id/stream
   * SSE endpoint for real-time terminal output streaming.
   * Events: terminal:output (stdout/stderr), terminal:exit
   */
  router.get("/terminal/sessions/:id/stream", (req, res) => {
    try {
      const { id } = req.params;
      const session = terminalSessionManager.getSession(id);
      
      if (!session) {
        throw notFound("Session not found");
      }

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering if present

      // Send initial connection event
      res.write(`event: connected\ndata: ${JSON.stringify({ sessionId: id })}\n\n`);

      // Handler for output events
      const onOutput = (event: import("./terminal.js").TerminalOutputEvent) => {
        if (event.sessionId !== id) return;
        
        const eventName = event.type === "exit" ? "terminal:exit" : "terminal:output";
        const data = JSON.stringify({
          type: event.type,
          data: event.data,
          ...(event.exitCode !== undefined && { exitCode: event.exitCode }),
        });
        
        res.write(`event: ${eventName}\ndata: ${data}\n\n`);
        
        // Close connection on exit after a brief delay to ensure client receives final data
        if (event.type === "exit") {
          setTimeout(() => {
            res.end();
          }, 100);
        }
      };

      // Subscribe to session manager events
      terminalSessionManager.on("output", onOutput);

      // Handle client disconnect
      req.on("close", () => {
        terminalSessionManager.off("output", onOutput);
      });

      // Handle errors
      req.on("error", () => {
        terminalSessionManager.off("output", onOutput);
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── PTY Terminal Routes (WebSocket-based) ────────────────────────────

  /**
   * POST /api/terminal/sessions
   * Create a new PTY terminal session.
   * Body: { cwd?: string, cols?: number, rows?: number }
   * Returns: { sessionId: string, shell: string, cwd: string }
   */
  router.post("/terminal/sessions", async (req, res) => {
    try {
      const { cwd, cols, rows } = req.body;
      const terminalService = getTerminalService(store.getRootDir());

      const result = await terminalService.createSession({
        cwd,
        cols: typeof cols === "number" ? cols : undefined,
        rows: typeof rows === "number" ? rows : undefined,
      });

      if (!result.success) {
        const statusByCode = {
          max_sessions: 503,
          invalid_shell: 400,
          pty_load_failed: 503,
          pty_spawn_failed: 500,
        } as const;

        throw new ApiError(statusByCode[result.code], result.error, { code: result.code });
      }

      res.status(201).json({
        sessionId: result.session.id,
        shell: result.session.shell,
        cwd: result.session.cwd,
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create terminal session");
    }
  });

  /**
   * GET /api/terminal/sessions
   * List all active PTY terminal sessions.
   * Returns: [{ id: string, cwd: string, shell: string, createdAt: string }]
   */
  router.get("/terminal/sessions", async (_req, res) => {
    try {
      const terminalService = getTerminalService(store.getRootDir());
      const sessions = terminalService.getAllSessions();

      res.json(
        sessions.map((s) => ({
          id: s.id,
          cwd: s.cwd,
          shell: s.shell,
          createdAt: s.createdAt.toISOString(),
          lastActivityAt: s.lastActivityAt.toISOString(),
        }))
      );
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to list sessions");
    }
  });

  /**
   * DELETE /api/terminal/sessions/:id
   * Kill a PTY terminal session.
   * Returns: { killed: boolean }
   */
  router.delete("/terminal/sessions/:id", (req, res) => {
    try {
      const { id } = req.params;
      const terminalService = getTerminalService(store.getRootDir());

      const killed = terminalService.killSession(id);

      if (!killed) {
        const session = terminalService.getSession(id);
        if (!session) {
          throw notFound("Session not found");
        } else {
          throw badRequest("Failed to kill session");
        }
        return;
      }

      res.json({ killed: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── File API Routes ───────────────────────────────────────────────

  /**
   * GET /api/tasks/:id/files
   * List files in task directory (or worktree if available).
   * Query param: ?path=relative/path for subdirectory navigation.
   * Returns: { path: string; entries: FileNode[] }
   */
  router.get("/tasks/:id/files", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { path: subPath } = req.query;
      const result = await listFiles(scopedStore, req.params.id, typeof subPath === "string" ? subPath : undefined);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * GET /api/tasks/:id/files/:filepath
   * Read file contents.
   * Returns: { content: string; mtime: string; size: number }
   */
  router.get("/tasks/:id/files/{*filepath}", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const result = await readFile(scopedStore, req.params.id, filePath);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOENT" ? 404
          : err.code === "ENOTASK" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : err.code === "EINVAL" && err.message.includes("Binary file") ? 415
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * POST /api/tasks/:id/files/:filepath
   * Write file contents.
   * Body: { content: string }
   * Returns: { success: true; mtime: string; size: number }
   */
  router.post("/tasks/:id/files/{*filepath}", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const { content } = req.body;
      
      if (typeof content !== "string") {
        throw badRequest("content is required and must be a string");
      }

      const result = await writeFile(scopedStore, req.params.id, filePath, content);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOENT" ? 404
          : err.code === "ENOTASK" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // ── Workspace File API Routes ─────────────────────────────────────

  /**
   * GET /api/workspaces
   * List available file browser workspaces.
   * Returns: { project: string; tasks: Array<{ id: string; title?: string; worktree: string }> }
   */
  router.get("/workspaces", async (_req, res) => {
    try {
      const tasks = await store.listTasks();
      res.json({
        project: store.getRootDir(),
        tasks: tasks
          .filter((task) => typeof task.worktree === "string" && task.worktree.length > 0 && existsSync(task.worktree))
          .map((task) => ({
            id: task.id,
            title: task.title,
            worktree: task.worktree!,
          })),
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  /**
   * GET /api/files
   * List files in the requested workspace. Defaults to the project root when omitted.
   * Query params: ?workspace=project|TASK-ID and ?path=relative/path for subdirectory navigation.
   * Returns: { path: string; entries: FileNode[] }
   */
  router.get("/files", async (req, res) => {
    try {
      const { path: subPath, workspace } = req.query;
      const workspaceId = typeof workspace === "string" && workspace.length > 0 ? workspace : "project";
      const result = await listWorkspaceFiles(store, workspaceId, typeof subPath === "string" ? subPath : undefined);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * GET /api/files/{*filepath}
   * Read file contents from the requested workspace. Defaults to the project root when omitted.
   * Query param: ?workspace=project|TASK-ID
   * Returns: { content: string; mtime: string; size: number }
   */
  router.get("/files/{*filepath}", async (req, res) => {
    try {
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
        ? req.query.workspace
        : "project";
      const result = await readWorkspaceFile(store, workspace, filePath);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : err.code === "EINVAL" && err.message.includes("Binary file") ? 415
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * POST /api/files/{*filepath}
   * Write file contents to the requested workspace. Defaults to the project root when omitted.
   * Query param: ?workspace=project|TASK-ID
   * Body: { content: string }
   * Returns: { success: true; mtime: string; size: number }
   */
  router.post("/files/{*filepath}", async (req, res) => {
    try {
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const { content } = req.body;
      const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
        ? req.query.workspace
        : "project";
      
      if (typeof content !== "string") {
        throw badRequest("content is required and must be a string");
      }

      const result = await writeWorkspaceFile(store, workspace, filePath, content);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // ── File Operation Routes ─────────────────────────────────────────────

  /**
   * Helper to extract filepath and workspace from request.
   */
  function extractFileParams(req: Request): { filePath: string; workspace: string } {
    const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
    const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
      ? req.query.workspace
      : "project";
    return { filePath, workspace };
  }

  /**
   * POST /api/files/{*filepath}/copy
   * Copy a file or directory to a new location within the workspace.
   * Query param: ?workspace=project|TASK-ID
   * Body: { destination: string }
   * Returns: FileOperationResponse
   */
  router.post("/files/{*filepath}/copy", async (req, res) => {
    try {
      const { filePath, workspace } = extractFileParams(req);
      const { destination } = req.body;

      if (!destination || typeof destination !== "string") {
        throw badRequest("destination is required and must be a string");
      }

      const result = await copyWorkspaceFile(store, workspace, filePath, destination);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EEXIST" ? 409
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * POST /api/files/{*filepath}/move
   * Move a file or directory to a new location within the workspace.
   * Query param: ?workspace=project|TASK-ID
   * Body: { destination: string }
   * Returns: FileOperationResponse
   */
  router.post("/files/{*filepath}/move", async (req, res) => {
    try {
      const { filePath, workspace } = extractFileParams(req);
      const { destination } = req.body;

      if (!destination || typeof destination !== "string") {
        throw badRequest("destination is required and must be a string");
      }

      const result = await moveWorkspaceFile(store, workspace, filePath, destination);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EEXIST" ? 409
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * DELETE /api/files/{*filepath}
   * Note: This conflicts with the existing GET endpoint for files.
   * Instead, use POST /api/files/{*filepath}/delete to avoid route collision.
   * Delete a file or directory within the workspace.
   * Query param: ?workspace=project|TASK-ID
   * Returns: FileOperationResponse
   */
  router.post("/files/{*filepath}/delete", async (req, res) => {
    try {
      const { filePath, workspace } = extractFileParams(req);
      const result = await deleteWorkspaceFile(store, workspace, filePath);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * POST /api/files/{*filepath}/rename
   * Rename a file or directory within the workspace.
   * Query param: ?workspace=project|TASK-ID
   * Body: { newName: string }
   * Returns: FileOperationResponse
   */
  router.post("/files/{*filepath}/rename", async (req, res) => {
    try {
      const { filePath, workspace } = extractFileParams(req);
      const { newName } = req.body;

      if (!newName || typeof newName !== "string") {
        throw badRequest("newName is required and must be a string");
      }

      const result = await renameWorkspaceFile(store, workspace, filePath, newName);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EEXIST" ? 409
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * GET /api/files/{*filepath}/download
   * Download a single file from the workspace.
   * Query param: ?workspace=project|TASK-ID
   * Streams the file with Content-Disposition header.
   */
  router.get("/files/{*filepath}/download", async (req, res) => {
    try {
      const { filePath, workspace } = extractFileParams(req);
      const { absolutePath, stats, fileName } = await getWorkspaceFileForDownload(store, workspace, filePath);

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("Content-Length", stats.size);
      res.setHeader("Last-Modified", stats.mtime.toUTCString());

      const stream = createReadStream(absolutePath);
      stream.pipe(res);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EISDIR" ? 400
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * GET /api/files/{*filepath}/download-zip
   * Download a folder as a ZIP archive from the workspace.
   * Query param: ?workspace=project|TASK-ID
   * Streams the ZIP archive with Content-Disposition header.
   */
  router.get("/files/{*filepath}/download-zip", async (req, res) => {
    try {
      const { filePath, workspace } = extractFileParams(req);
      const { absolutePath, dirName } = await getWorkspaceFolderForZip(store, workspace, filePath);

      const archiver = await import("archiver");
      const archive = archiver.default("zip", { zlib: { level: 6 } });

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${dirName}.zip"`);

      archive.pipe(res);
      archive.directory(absolutePath, dirName);
      await archive.finalize();
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "ENOTDIR" ? 400
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // ── Planning Mode Routes ──────────────────────────────────────────────────

  router.post("/subtasks/start-streaming", async (req, res) => {
    try {
      const { description } = req.body;

      if (!description || typeof description !== "string") {
        throw badRequest("description is required and must be a string");
      }

      if (description.length > 1000) {
        throw badRequest("description must be 1000 characters or less");
      }

      const scopedStore = await getScopedStore(req);
      const { createSubtaskSession } = await import("./subtask-breakdown.js");
      const session = await createSubtaskSession(description, scopedStore, scopedStore.getRootDir());
      res.status(201).json({ sessionId: session.sessionId });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to start subtask breakdown");
    }
  });

  router.get("/subtasks/:sessionId/stream", async (req, res) => {
    const { sessionId } = req.params;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": connected\n\n");

    try {
      const { subtaskStreamManager, getSubtaskSession } = await import("./subtask-breakdown.js");
      const session = getSubtaskSession(sessionId);
      if (!session) {
        writeSSEEvent(res, "error", JSON.stringify("Session not found or expired"));
        res.end();
        return;
      }

      const lastEventId = parseLastEventId(req);
      if (lastEventId !== undefined) {
        const buffered = subtaskStreamManager.getBufferedEvents(sessionId, lastEventId);
        if (!replayBufferedSSE(res, buffered)) {
          res.end();
          return;
        }
      }

      if (session.status === "complete") {
        const existing = subtaskStreamManager.getBufferedEvents(sessionId, 0);

        const lastSubtasksEvent = [...existing].reverse().find((event) => event.event === "subtasks");
        const subtasksEventId = lastSubtasksEvent?.id
          ?? subtaskStreamManager.broadcast(sessionId, {
            type: "subtasks",
            data: session.subtasks,
          });

        if (lastEventId === undefined || subtasksEventId > lastEventId) {
          if (!writeSSEEvent(res, "subtasks", JSON.stringify(session.subtasks), subtasksEventId)) {
            res.end();
            return;
          }
        }

        const lastCompleteEvent = [...existing].reverse().find((event) => event.event === "complete");
        const completeEventId = lastCompleteEvent?.id
          ?? subtaskStreamManager.broadcast(sessionId, { type: "complete" });

        if (lastEventId === undefined || completeEventId > lastEventId) {
          writeSSEEvent(res, "complete", JSON.stringify({}), completeEventId);
        }

        res.end();
        return;
      }

      if (session.status === "error") {
        const errorMessage = String(session.error || "Unknown error");
        const existing = subtaskStreamManager.getBufferedEvents(sessionId, 0);
        const lastErrorEvent = [...existing].reverse().find((event) => event.event === "error");
        const errorEventId = lastErrorEvent?.id
          ?? subtaskStreamManager.broadcast(sessionId, {
            type: "error",
            data: errorMessage,
          });

        if (lastEventId === undefined || errorEventId > lastEventId) {
          writeSSEEvent(res, "error", JSON.stringify(errorMessage), errorEventId);
        }

        res.end();
        return;
      }

      const unsubscribe = subtaskStreamManager.subscribe(sessionId, (event, eventId) => {
        const data = (event as { data?: unknown }).data;
        if (!writeSSEEvent(res, event.type, JSON.stringify(data ?? {}), eventId)) {
          unsubscribe();
          return;
        }

        if (event.type === "complete" || event.type === "error") {
          unsubscribe();
          res.end();
        }
      });

      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        res.write(": heartbeat\n\n");
      }, 30_000);

      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      writeSSEEvent(res, "error", JSON.stringify(String(err?.message) || "Unknown error"));
      res.end();
    }
  });

  router.post("/subtasks/create-tasks", async (req, res) => {
    try {
      const { sessionId, subtasks, parentTaskId } = req.body as {
        sessionId?: string;
        subtasks?: Array<{ tempId: string; title: string; description: string; size?: "S" | "M" | "L"; dependsOn?: string[] }>;
        parentTaskId?: string;
      };

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      if (!Array.isArray(subtasks) || subtasks.length === 0) {
        throw badRequest("subtasks must be a non-empty array");
      }

      const scopedStore = await getScopedStore(req);
      const { getSubtaskSession, cleanupSubtaskSession } = await import("./subtask-breakdown.js");
      const session = getSubtaskSession(sessionId);
      if (!session) {
        throw notFound(`Subtask session ${sessionId} not found or expired`);
      }

      // Fetch parent task to inherit model settings if parentTaskId is provided
      let parentTask: Awaited<ReturnType<typeof store.getTask>> | undefined;
      if (typeof parentTaskId === "string" && parentTaskId.trim()) {
        try {
          parentTask = await scopedStore.getTask(parentTaskId);
        } catch {
          // Parent task not found or error - proceed without inheritance
          parentTask = undefined;
        }
      }

      const createdTasks = [] as Awaited<ReturnType<typeof store.createTask>>[];
      const tempIdToTaskId = new Map<string, string>();

      for (const item of subtasks) {
        if (!item || typeof item.tempId !== "string" || typeof item.title !== "string" || !item.title.trim()) {
          throw badRequest("Each subtask must include tempId and title");
        }

        const task = await scopedStore.createTask({
          title: item.title.trim(),
          description: typeof item.description === "string" ? item.description.trim() : item.title.trim(),
          column: "triage",
          dependencies: undefined,
          // Inherit parent's model settings if available
          modelProvider: parentTask?.modelProvider,
          modelId: parentTask?.modelId,
          validatorModelProvider: parentTask?.validatorModelProvider,
          validatorModelId: parentTask?.validatorModelId,
        });

        tempIdToTaskId.set(item.tempId, task.id);
        createdTasks.push(task);

        if (item.size === "S" || item.size === "M" || item.size === "L") {
          await scopedStore.updateTask(task.id, { size: item.size });
        }
      }

      for (let index = 0; index < subtasks.length; index++) {
        const item = subtasks[index]!;
        const created = createdTasks[index]!;
        const resolvedDependencies = Array.isArray(item.dependsOn)
          ? item.dependsOn.map((dep) => tempIdToTaskId.get(dep)).filter((dep): dep is string => Boolean(dep))
          : [];

        if (resolvedDependencies.length > 0) {
          const updated = await scopedStore.updateTask(created.id, { dependencies: resolvedDependencies });
          createdTasks[index] = updated;
        }

        await scopedStore.logEntry(created.id, "Created via subtask breakdown", `Source: ${session.initialDescription.slice(0, 200)}`);
      }

      let parentTaskClosed = false;
      if (typeof parentTaskId === "string" && parentTaskId.trim()) {
        try {
          await scopedStore.deleteTask(parentTaskId);
          parentTaskClosed = true;
        } catch {
          parentTaskClosed = false;
        }
      }

      cleanupSubtaskSession(sessionId);
      res.status(201).json({ tasks: createdTasks, parentTaskClosed });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create tasks from breakdown");
    }
  });

  router.post("/subtasks/cancel", async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const { cancelSubtaskSession } = await import("./subtask-breakdown.js");
      await cancelSubtaskSession(sessionId);
      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.name === "SessionNotFoundError") {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err, "Failed to cancel subtask session");
      }
    }
  });

  router.post("/subtasks/:sessionId/retry", async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const scopedStore = await getScopedStore(req);
      const { retrySubtaskSession } = await import("./subtask-breakdown.js");
      await retrySubtaskSession(sessionId, scopedStore.getRootDir());
      res.json({ success: true, sessionId });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.name === "SessionNotFoundError") {
        throw notFound(err.message);
      } else if (err.name === "InvalidSessionStateError") {
        throw badRequest(err.message);
      } else {
        rethrowAsApiError(err, "Failed to retry subtask session");
      }
    }
  });

  /**
   * POST /api/planning/start
   * Start a new planning session.
   * Body: { initialPlan: string }
   * Returns: { sessionId: string, firstQuestion: PlanningQuestion }
   */
  router.post("/planning/start", async (req, res) => {
    try {
      const { initialPlan } = req.body;

      if (!initialPlan || typeof initialPlan !== "string") {
        throw badRequest("initialPlan is required and must be a string");
      }

      if (initialPlan.length > 500) {
        throw badRequest("initialPlan must be 500 characters or less");
      }

      const scopedStore = await getScopedStore(req);
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const rootDir = scopedStore.getRootDir();

      const { createSession, RateLimitError } = await import("./planning.js");
      const result = await createSession(ip, initialPlan, scopedStore, rootDir);
      res.status(201).json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.name === "RateLimitError") {
        throw rateLimited(err.message);
      } else {
        rethrowAsApiError(err, "Failed to start planning session");
      }
    }
  });

  /**
   * POST /api/planning/start-streaming
   * Start a new planning session with AI agent streaming.
   * Body: { initialPlan: string }
   * Returns: { sessionId: string }
   * 
   * After receiving sessionId, connect to GET /api/planning/:sessionId/stream
   * for real-time thinking output and questions.
   */
  router.post("/planning/start-streaming", async (req, res) => {
    try {
      const { initialPlan, planningModelProvider, planningModelId } = req.body;

      if (!initialPlan || typeof initialPlan !== "string") {
        throw badRequest("initialPlan is required and must be a string");
      }

      if (initialPlan.length > 500) {
        throw badRequest("initialPlan must be 500 characters or less");
      }

      if (planningModelProvider !== undefined && typeof planningModelProvider !== "string") {
        throw badRequest("planningModelProvider must be a string when provided");
      }

      if (planningModelId !== undefined && typeof planningModelId !== "string") {
        throw badRequest("planningModelId must be a string when provided");
      }

      const scopedStore = await getScopedStore(req);
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const rootDir = scopedStore.getRootDir();

      const { createSessionWithAgent, RateLimitError } = await import("./planning.js");
      const sessionId = await createSessionWithAgent(
        ip,
        initialPlan,
        rootDir,
        planningModelProvider,
        planningModelId,
      );
      res.status(201).json({ sessionId });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.name === "RateLimitError") {
        throw rateLimited(err.message);
      } else {
        rethrowAsApiError(err, "Failed to start planning session");
      }
    }
  });

  /**
   * POST /api/planning/respond
   * Submit a response to the current planning question.
   * Body: { sessionId: string, responses: Record<string, unknown> }
   * Returns: { type: "question" | "complete", data: PlanningQuestion | PlanningSummary }
   */
  router.post("/planning/respond", async (req, res) => {
    try {
      const { sessionId, responses } = req.body;

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      if (!responses || typeof responses !== "object") {
        throw badRequest("responses is required and must be an object");
      }

      const { submitResponse, SessionNotFoundError, InvalidSessionStateError } = await import("./planning.js");
      const result = await submitResponse(sessionId, responses, store.getRootDir());
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.name === "SessionNotFoundError") {
        throw notFound(err.message);
      } else if (err.name === "InvalidSessionStateError") {
        throw badRequest(err.message);
      } else {
        rethrowAsApiError(err, "Failed to process response");
      }
    }
  });

  router.post("/planning/:sessionId/retry", async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const scopedStore = await getScopedStore(req);
      const { retrySession } = await import("./planning.js");
      await retrySession(sessionId, scopedStore.getRootDir());
      res.json({ success: true, sessionId });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.name === "SessionNotFoundError") {
        throw notFound(err.message);
      } else if (err.name === "InvalidSessionStateError") {
        throw badRequest(err.message);
      } else {
        rethrowAsApiError(err, "Failed to retry planning session");
      }
    }
  });

  /**
   * POST /api/planning/cancel
   * Cancel and cleanup a planning session.
   * Body: { sessionId: string }
   */
  router.post("/planning/cancel", async (req, res) => {
    try {
      const { sessionId } = req.body;

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const { cancelSession, SessionNotFoundError } = await import("./planning.js");
      await cancelSession(sessionId);
      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.name === "SessionNotFoundError") {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err, "Failed to cancel session");
      }
    }
  });

  /**
   * POST /api/planning/create-task
   * Create a task from a completed planning session.
   * Body: { sessionId: string }
   * Returns: Created Task
   */
  router.post("/planning/create-task", async (req, res) => {
    try {
      const { sessionId } = req.body;

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const scopedStore = await getScopedStore(req);
      const { getSession, getSummary, cleanupSession } = await import("./planning.js");

      const session = getSession(sessionId);
      let summary = getSummary(sessionId);
      let initialPlan = session?.initialPlan;
      let usedPersistedFallback = false;

      if (!session) {
        if (!aiSessionStore) {
          throw notFound(`Planning session ${sessionId} not found or expired`);
        }

        const persistedSession = aiSessionStore.get(sessionId);
        if (!persistedSession || persistedSession.type !== "planning") {
          throw notFound(`Planning session ${sessionId} not found or expired`);
        }

        if (persistedSession.status !== "complete") {
          throw badRequest("Planning session is not complete");
        }

        if (!persistedSession.result) {
          throw badRequest("Planning session result is not available");
        }

        try {
          const parsedSummary = JSON.parse(persistedSession.result) as {
            title?: unknown;
            description?: unknown;
            suggestedSize?: unknown;
            suggestedDependencies?: unknown;
            keyDeliverables?: unknown;
          };

          summary = {
            title:
              typeof parsedSummary.title === "string" && parsedSummary.title.trim().length > 0
                ? parsedSummary.title
                : persistedSession.title,
            description:
              typeof parsedSummary.description === "string" && parsedSummary.description.trim().length > 0
                ? parsedSummary.description
                : persistedSession.title,
            suggestedSize:
              parsedSummary.suggestedSize === "S" ||
              parsedSummary.suggestedSize === "M" ||
              parsedSummary.suggestedSize === "L"
                ? parsedSummary.suggestedSize
                : "M",
            suggestedDependencies: Array.isArray(parsedSummary.suggestedDependencies)
              ? parsedSummary.suggestedDependencies.filter((dep): dep is string => typeof dep === "string")
              : [],
            keyDeliverables: Array.isArray(parsedSummary.keyDeliverables)
              ? parsedSummary.keyDeliverables.filter((item): item is string => typeof item === "string")
              : [],
          };
        } catch {
          throw badRequest("Planning session result is invalid");
        }

        try {
          const parsedInput = JSON.parse(persistedSession.inputPayload) as { initialPlan?: unknown };
          if (typeof parsedInput.initialPlan === "string" && parsedInput.initialPlan.trim().length > 0) {
            initialPlan = parsedInput.initialPlan;
          }
        } catch {
          // Keep fallback value below
        }

        if (!initialPlan) {
          initialPlan = persistedSession.title;
        }

        usedPersistedFallback = true;
      }

      if (!summary) {
        throw badRequest("Planning session is not complete");
      }

      // Create the task
      const task = await scopedStore.createTask({
        title: summary.title,
        description: summary.description,
        column: "triage",
        dependencies: summary.suggestedDependencies.length > 0 ? summary.suggestedDependencies : undefined,
      });

      // Update task with suggested size if provided
      if (summary.suggestedSize) {
        await scopedStore.updateTask(task.id, { size: summary.suggestedSize });
      }

      // Log the planning mode creation
      await scopedStore.logEntry(task.id, "Created via Planning Mode", `Initial plan: ${(initialPlan ?? "").slice(0, 200)}`);

      // Cleanup the session
      if (usedPersistedFallback) {
        aiSessionStore?.delete(sessionId);
      } else {
        cleanupSession(sessionId);
      }

      res.status(201).json(task);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create task");
    }
  });

  /**
   * POST /api/planning/start-breakdown
   * Start subtask breakdown from a completed planning session.
   * Body: { sessionId: string }
   * Returns: { sessionId: string } — ID of the generated subtask breakdown
   */
  router.post("/planning/start-breakdown", async (req, res) => {
    try {
      const { sessionId } = req.body;

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const { getSession, generateSubtasksFromPlanning } = await import("./planning.js");

      const session = getSession(sessionId);
      if (!session) {
        throw notFound(`Planning session ${sessionId} not found or expired`);
      }

      if (!session.summary) {
        throw badRequest("Planning session is not complete");
      }

      const subtasks = generateSubtasksFromPlanning(sessionId);
      if (subtasks.length === 0) {
        throw badRequest("Could not generate subtasks from planning session");
      }

      // Return a synthetic session ID (based on the planning session) and the generated subtasks
      // We use the planning session ID directly as the breakdown session ID
      res.json({ sessionId, subtasks });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to start planning breakdown");
    }
  });

  /**
   * POST /api/planning/create-tasks
   * Create multiple tasks from a completed planning session (after optional editing).
   * Body: { planningSessionId: string, subtasks: Array<{id, title, description, suggestedSize, dependsOn}> }
   * Returns: { tasks: Task[] }
   */
  router.post("/planning/create-tasks", async (req, res) => {
    try {
      const { planningSessionId, subtasks } = req.body as {
        planningSessionId?: string;
        subtasks?: Array<{
          id: string;
          title: string;
          description: string;
          suggestedSize: "S" | "M" | "L";
          dependsOn: string[];
        }>;
      };

      if (!planningSessionId || typeof planningSessionId !== "string") {
        throw badRequest("planningSessionId is required");
      }

      if (!Array.isArray(subtasks) || subtasks.length === 0) {
        throw badRequest("subtasks must be a non-empty array");
      }

      const scopedStore = await getScopedStore(req);
      const { getSession, cleanupSession, formatInterviewQA } = await import("./planning.js");

      const session = getSession(planningSessionId);
      if (!session) {
        throw notFound(`Planning session ${planningSessionId} not found or expired`);
      }

      if (!session.summary) {
        throw badRequest("Planning session is not complete");
      }

      const qaSection = formatInterviewQA(session.history);
      const logDetails = qaSection
        ? `Source: ${session.initialPlan.slice(0, 200)}\n\n${qaSection}`
        : `Source: ${session.initialPlan.slice(0, 200)}`;

      // Validate each subtask
      for (const item of subtasks) {
        if (!item || typeof item.id !== "string" || typeof item.title !== "string" || !item.title.trim()) {
          throw badRequest("Each subtask must include id and title");
        }
      }

      const createdTasks = [] as Awaited<ReturnType<typeof store.createTask>>[];
      const tempIdToTaskId = new Map<string, string>();

      // Create tasks
      for (const item of subtasks) {
        const task = await scopedStore.createTask({
          title: item.title.trim(),
          description: typeof item.description === "string" ? item.description.trim() : item.title.trim(),
          column: "triage",
          dependencies: undefined,
        });

        tempIdToTaskId.set(item.id, task.id);
        createdTasks.push(task);

        if (item.suggestedSize === "S" || item.suggestedSize === "M" || item.suggestedSize === "L") {
          await scopedStore.updateTask(task.id, { size: item.suggestedSize });
        }
      }

      // Resolve dependencies
      for (let index = 0; index < subtasks.length; index++) {
        const item = subtasks[index]!;
        const created = createdTasks[index]!;
        const resolvedDependencies = Array.isArray(item.dependsOn)
          ? item.dependsOn.map((dep) => tempIdToTaskId.get(dep)).filter((dep): dep is string => Boolean(dep))
          : [];

        if (resolvedDependencies.length > 0) {
          const updated = await scopedStore.updateTask(created.id, { dependencies: resolvedDependencies });
          createdTasks[index] = updated;
        }

        await scopedStore.logEntry(created.id, "Created via Planning Mode (multi-task)", logDetails);
      }

      // Cleanup the planning session
      cleanupSession(planningSessionId);

      res.status(201).json({ tasks: createdTasks });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create tasks from planning");
    }
  });

  /**
   * GET /api/planning/:sessionId/stream
   * SSE endpoint for real-time planning session updates.
   * Streams thinking output, questions, summaries, and errors.
   * 
   * Event types:
   * - thinking: AI thinking output chunks
   * - question: New question to display
   * - summary: Planning summary when complete
   * - error: Error message
   * - complete: Stream completed
   */
  router.get("/planning/:sessionId/stream", async (req, res) => {
    const { sessionId } = req.params;

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Send initial connection confirmation
    res.write(": connected\n\n");

    try {
      const { planningStreamManager, getSession } = await import("./planning.js");

      // Verify session exists
      const session = getSession(sessionId);
      if (!session) {
        writeSSEEvent(res, "error", JSON.stringify({ message: "Session not found or expired" }));
        res.end();
        return;
      }

      const lastEventId = parseLastEventId(req);
      if (lastEventId !== undefined) {
        const buffered = planningStreamManager.getBufferedEvents(sessionId, lastEventId);
        if (!replayBufferedSSE(res, buffered)) {
          res.end();
          return;
        }
      }

      if (session.summary) {
        const existing = planningStreamManager.getBufferedEvents(sessionId, 0);
        const lastSummaryEvent = [...existing].reverse().find((event) => event.event === "summary");
        const summaryEventId = lastSummaryEvent?.id
          ?? planningStreamManager.broadcast(sessionId, {
            type: "summary",
            data: session.summary,
          });

        if (lastEventId === undefined || summaryEventId > lastEventId) {
          if (!writeSSEEvent(res, "summary", JSON.stringify(session.summary), summaryEventId)) {
            res.end();
            return;
          }
        }

        const lastCompleteEvent = [...existing].reverse().find((event) => event.event === "complete");
        const completeEventId = lastCompleteEvent?.id
          ?? planningStreamManager.broadcast(sessionId, { type: "complete" });

        if (lastEventId === undefined || completeEventId > lastEventId) {
          writeSSEEvent(res, "complete", JSON.stringify({}), completeEventId);
        }

        res.end();
        return;
      }

      // Subscribe to session events
      const unsubscribe = planningStreamManager.subscribe(sessionId, (event, eventId) => {
        const data = (event as { data?: unknown }).data;
        if (!writeSSEEvent(res, event.type, JSON.stringify(data ?? {}), eventId)) {
          unsubscribe();
          return;
        }

        // End stream on complete or error
        if (event.type === "complete" || event.type === "error") {
          unsubscribe();
          res.end();
        }
      });

      // Handle client disconnect
      req.on("close", () => {
        unsubscribe();
      });

      // Send heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        res.write(": heartbeat\n\n");
      }, 30_000);

      req.on("close", () => {
        clearInterval(heartbeat);
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      writeSSEEvent(res, "error", JSON.stringify({ message: err.message || "Stream error" }));
      res.end();
    }
  });

  /**
   * POST /api/ai/refine-text
   * AI-powered text refinement for task descriptions.
   * Body: { text: string, type: string }
   * Returns: { refined: string }
   *
   * Refinement types: clarify, add-details, expand, simplify
   * Rate limited: 10 requests per hour per IP
   */
  router.post("/ai/refine-text", async (req, res) => {
    try {
      const { text, type } = req.body;
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const rootDir = store.getRootDir();

      const {
        validateRefineRequest,
        checkRateLimit,
        getRateLimitResetTime,
        refineText,
        RateLimitError,
        ValidationError,
        InvalidTypeError,
        AiServiceError,
      } = await import("./ai-refine.js");

      // Check rate limit first
      if (!checkRateLimit(ip)) {
        const resetTime = getRateLimitResetTime(ip);
        throw rateLimited(`Rate limit exceeded. Maximum 10 refinement requests per hour. Reset at ${resetTime?.toISOString() || "unknown"}`);
      }

      // Validate request body
      let validated;
      try {
        validated = validateRefineRequest(text, type);
      } catch (err) {
        if (err instanceof ValidationError) {
          throw badRequest(err.message);
        }
        if (err instanceof InvalidTypeError) {
          throw new ApiError(422, err.message);
        }
        throw err;
      }

      // Process refinement
      const refined = await refineText(validated.text, validated.type, rootDir);
      res.json({ refined });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      // Check error by name since error classes are from dynamic import
      if (err?.name === "RateLimitError") {
        throw rateLimited(err.message);
      } else if (err?.name === "AiServiceError") {
        rethrowAsApiError(err, "AI service error");
      } else {
        rethrowAsApiError(err, "Failed to refine text");
      }
    }
  });

  /**
   * POST /api/ai/summarize-title
   * AI-powered title generation from task descriptions.
   * Body: { description: string, provider?: string, modelId?: string }
   * Returns: { title: string }
   *
   * Generates a concise title (≤60 characters) from descriptions longer than 200 characters.
   * Rate limited: 10 requests per hour per IP
   */
  router.post("/ai/summarize-title", async (req, res) => {
    try {
      const { description, provider, modelId } = req.body;
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const rootDir = store.getRootDir();

      const {
        checkRateLimit,
        getRateLimitResetTime,
        summarizeTitle,
        validateDescription,
        MIN_DESCRIPTION_LENGTH,
        MAX_DESCRIPTION_LENGTH,
        RateLimitError,
        ValidationError,
        AiServiceError,
      } = await import("@fusion/core");

      // Debug logging
      if (process.env.FUSION_DEBUG_AI) {
        console.log(`[ai-summarize] Request from ${ip}, description length: ${description?.length || 0}`);
      }

      // Check rate limit first
      if (!checkRateLimit(ip)) {
        const resetTime = getRateLimitResetTime(ip);
        throw rateLimited(`Rate limit exceeded. Maximum 10 summarization requests per hour. Reset at ${resetTime?.toISOString() || "unknown"}`);
      }

      // Validate request body
      try {
        validateDescription(description);
      } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
        if (err?.name === "ValidationError") {
          throw badRequest(err.message);
        }
        throw err;
      }

      // Resolve model selection hierarchy:
      // 1. Request body provider+modelId
      // 2. Settings titleSummarizerProvider + titleSummarizerModelId
      // 3. Settings planningProvider + planningModelId
      // 4. Settings defaultProvider + defaultModelId
      // 5. Automatic model resolution (no explicit model)
      const settings = await store.getSettings();

      const resolvedProvider =
        (provider && modelId ? provider : undefined) ||
        (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerProvider : undefined) ||
        (settings.planningProvider && settings.planningModelId ? settings.planningProvider : undefined) ||
        (settings.defaultProvider && settings.defaultModelId ? settings.defaultProvider : undefined);

      const resolvedModelId =
        (provider && modelId ? modelId : undefined) ||
        (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerModelId : undefined) ||
        (settings.planningProvider && settings.planningModelId ? settings.planningModelId : undefined) ||
        (settings.defaultProvider && settings.defaultModelId ? settings.defaultModelId : undefined);

      if (process.env.FUSION_DEBUG_AI) {
        console.log(`[ai-summarize] Resolved model: ${resolvedProvider || "auto"}/${resolvedModelId || "auto"}`);
      }

      // Process summarization
      const title = await summarizeTitle(description, rootDir, resolvedProvider, resolvedModelId);

      if (!title) {
        throw badRequest(`Description must be at least ${MIN_DESCRIPTION_LENGTH} characters for summarization`);
      }

      res.json({ title });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      // Check error by name since error classes are from dynamic import
      if (err?.name === "RateLimitError") {
        throw rateLimited(err.message);
      } else if (err?.name === "AiServiceError") {
        throw new ApiError(503, err.message || "AI service temporarily unavailable");
      } else if (err?.name === "ValidationError") {
        throw badRequest(err.message);
      } else {
        console.error("[ai-summarize] Unexpected error:", err);
        rethrowAsApiError(err, "Failed to generate title");
      }
    }
  });

  /**
   * GET /api/usage
   * Fetch AI provider subscription usage (Claude, Codex, Gemini).
   * Returns: { providers: ProviderUsage[] }
   * 
   * Cached for 30 seconds to avoid hitting provider API rate limits.
   * Each provider's status is independent — one failure doesn't break all.
   */
  router.get("/usage", async (_req, res) => {
    try {
      const providers = await fetchAllProviderUsage();
      res.json({ providers });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to fetch usage data");
    }
  });

  // ── Automation / Scheduled Task Routes ────────────────────────────

  const automationStore = options?.automationStore;

  // GET /automations — list all scheduled tasks
  router.get("/automations", async (_req: Request, res: Response) => {
    if (!automationStore) {
      return res.json([]);
    }
    try {
      const schedules = await automationStore.listSchedules();
      res.json(schedules);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // POST /automations — create a new schedule
  router.post("/automations", async (req: Request, res: Response) => {
    if (!automationStore) {
      throw new ApiError(503, "Automation store not available");
    }
    try {
      const { name, description, scheduleType, cronExpression, command, enabled, timeoutMs, steps } = req.body;

      // Validation
      if (!name?.trim()) {
        throw badRequest("Name is required");
      }
      const hasSteps = Array.isArray(steps) && steps.length > 0;
      if (!hasSteps && !command?.trim()) {
        throw badRequest("Command is required when no steps are provided");
      }
      const validTypes = ["hourly", "daily", "weekly", "monthly", "custom", "every15Minutes", "every30Minutes", "every2Hours", "every6Hours", "every12Hours", "weekdays"];
      if (!scheduleType || !validTypes.includes(scheduleType)) {
        throw badRequest(`Invalid schedule type. Must be one of: ${validTypes.join(", ")}`);
      }
      if (scheduleType === "custom") {
        if (!cronExpression?.trim()) {
          throw badRequest("Cron expression is required for custom schedule type");
        }
        if (!AutomationStore.isValidCron(cronExpression)) {
          throw badRequest(`Invalid cron expression: "${cronExpression}"`);
        }
      }
      // Validate steps if provided
      if (hasSteps) {
        const stepErr = validateAutomationSteps(steps);
        if (stepErr) {
          throw badRequest(stepErr);
        }
      }

      const schedule = await automationStore.createSchedule({
        name,
        description,
        scheduleType: scheduleType as ScheduleType,
        cronExpression,
        command: command ?? "",
        enabled,
        timeoutMs,
        steps: hasSteps ? steps : undefined,
      });
      res.status(201).json(schedule);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // GET /automations/:id — get a single schedule
  router.get("/automations/:id", async (req, res) => {
    if (!automationStore) {
      throw new ApiError(503, "Automation store not available");
    }
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const schedule = await automationStore.getSchedule(id);
      res.json(schedule);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  // PATCH /automations/:id — update a schedule
  router.patch("/automations/:id", async (req, res) => {
    if (!automationStore) {
      throw new ApiError(503, "Automation store not available");
    }
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { name, description, scheduleType, cronExpression, command, enabled, timeoutMs, steps } = req.body;

      // Validate cron if switching to custom
      if (scheduleType === "custom" && cronExpression) {
        if (!AutomationStore.isValidCron(cronExpression)) {
          throw badRequest(`Invalid cron expression: "${cronExpression}"`);
        }
      }

      // Validate steps if provided
      if (Array.isArray(steps) && steps.length > 0) {
        const stepErr = validateAutomationSteps(steps);
        if (stepErr) {
          throw badRequest(stepErr);
        }
      }

      const schedule = await automationStore.updateSchedule(id, {
        name,
        description,
        scheduleType,
        cronExpression,
        command,
        enabled,
        timeoutMs,
        steps: steps !== undefined ? steps : undefined,
      });
      res.json(schedule);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      if (err.message?.includes("cannot be empty") || err.message?.includes("Invalid cron")) {
        throw badRequest(err.message);
      }
      rethrowAsApiError(err);
    }
  });

  // DELETE /automations/:id — delete a schedule
  router.delete("/automations/:id", async (req, res) => {
    if (!automationStore) {
      throw new ApiError(503, "Automation store not available");
    }
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const deleted = await automationStore.deleteSchedule(id);
      res.json(deleted);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /automations/:id/run — trigger a manual run
  router.post("/automations/:id/run", async (req, res) => {
    if (!automationStore) {
      throw new ApiError(503, "Automation store not available");
    }
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const schedule = await automationStore.getSchedule(id);

      const startedAt = new Date().toISOString();
      let result: import("@fusion/core").AutomationRunResult;

      if (schedule.steps && schedule.steps.length > 0) {
        // Multi-step execution
        result = await executeScheduleSteps(schedule, startedAt);
      } else {
        // Legacy single-command execution
        result = await executeSingleCommand(schedule.command, schedule.timeoutMs, startedAt);
      }

      // Record the result
      const updated = await automationStore.recordRun(schedule.id, result);
      res.json({ schedule: updated, result });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /automations/:id/toggle — toggle enabled/disabled
  router.post("/automations/:id/toggle", async (req, res) => {
    if (!automationStore) {
      throw new ApiError(503, "Automation store not available");
    }
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const schedule = await automationStore.getSchedule(id);
      const updated = await automationStore.updateSchedule(id, {
        enabled: !schedule.enabled,
      });
      res.json(updated);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /automations/:id/steps/reorder — reorder steps
  router.post("/automations/:id/steps/reorder", async (req, res) => {
    if (!automationStore) {
      throw new ApiError(503, "Automation store not available");
    }
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { stepIds } = req.body;
      if (!Array.isArray(stepIds)) {
        throw badRequest("stepIds must be an array");
      }
      const schedule = await automationStore.reorderSteps(id, stepIds);
      res.json(schedule);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      if (err.message?.includes("mismatch") || err.message?.includes("Unknown step") || err.message?.includes("no steps")) {
        throw badRequest(err.message);
      }
      rethrowAsApiError(err);
    }
  });

  // ── Activity Log Routes ─────────────────────────────────────────────

  /**
   * GET /api/activity
   * Get activity log entries.
   * Query params: limit (default 100, max 1000), since (ISO timestamp), type (event type filter)
   * Returns: ActivityLogEntry[] sorted newest first
   */
  router.get("/activity", async (req, res) => {
    try {
      const limitParam = req.query.limit;
      const sinceParam = req.query.since;
      const typeParam = req.query.type;

      // Parse and validate limit
      let limit: number | undefined;
      if (limitParam !== undefined) {
        const parsed = Number.parseInt(limitParam as string, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw badRequest("limit must be a non-negative integer");
        }
        limit = Math.min(parsed, 1000); // Max 1000
      }

      // Validate type if provided
      const validTypes = ["task:created", "task:moved", "task:updated", "task:deleted", "task:merged", "task:failed", "settings:updated"];
      if (typeParam !== undefined && !validTypes.includes(typeParam as string)) {
        throw badRequest(`Invalid type. Must be one of: ${validTypes.join(", ")}`);
      }

      const options: { limit?: number; since?: string; type?: ActivityEventType } = {
        limit,
        since: sinceParam as string | undefined,
        type: typeParam as ActivityEventType | undefined,
      };

      const entries = await store.getActivityLog(options);
      res.json(entries);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/activity
   * Clear all activity log entries (maintenance endpoint).
   * Returns: { success: true }
   */
  router.delete("/activity", async (_req, res) => {
    try {
      await store.clearActivityLog();
      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Workflow Step Routes ──────────────────────────────────────────────

  /**
   * GET /api/workflow-steps
   * List all workflow step definitions.
   * Returns: WorkflowStep[]
   */
  router.get("/workflow-steps", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const steps = await scopedStore.listWorkflowSteps();
      res.json(steps);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/workflow-steps
   * Create a new workflow step.
   * Body: { name: string, description: string, mode?: "prompt"|"script", prompt?: string, scriptName?: string, enabled?: boolean, modelProvider?: string, modelId?: string }
   * Returns: WorkflowStep
   */
  router.post("/workflow-steps", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { name, description, mode, phase, prompt, toolMode, scriptName, enabled, defaultOn, modelProvider, modelId } = req.body;

      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required");
      }
      if (!description || typeof description !== "string" || !description.trim()) {
        throw badRequest("description is required");
      }

      // Validate mode
      const resolvedMode: "prompt" | "script" = mode || "prompt";
      if (resolvedMode !== "prompt" && resolvedMode !== "script") {
        throw badRequest("mode must be 'prompt' or 'script'");
      }

      // Validate phase
      if (phase !== undefined && phase !== "pre-merge" && phase !== "post-merge") {
        throw badRequest("phase must be 'pre-merge' or 'post-merge'");
      }

      if (prompt !== undefined && typeof prompt !== "string") {
        throw badRequest("prompt must be a string");
      }
      if (toolMode !== undefined && toolMode !== "readonly" && toolMode !== "coding") {
        throw badRequest("toolMode must be 'readonly' or 'coding'");
      }
      if (scriptName !== undefined && typeof scriptName !== "string") {
        throw badRequest("scriptName must be a string");
      }
      if (enabled !== undefined && typeof enabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }
      if (defaultOn !== undefined && typeof defaultOn !== "boolean") {
        throw badRequest("defaultOn must be a boolean");
      }

      // Validate script mode: scriptName must reference a named script in settings
      if (resolvedMode === "script") {
        if (!scriptName?.trim()) {
          throw badRequest("scriptName is required when mode is 'script'");
        }
        const settings = await scopedStore.getSettings();
        const scripts = settings.scripts || {};
        if (!(scriptName.trim() in scripts)) {
          throw badRequest(`Script '${scriptName.trim()}' not found in project settings. Available scripts: ${Object.keys(scripts).join(", ") || "none"}`);
        }
      }

      // Validate model override pair (only relevant for prompt mode)
      const modelPair = assertConsistentOptionalPair(modelProvider, modelId, "workflow step model");

      // Check for name conflicts
      const existing = await scopedStore.listWorkflowSteps();
      if (existing.some((ws) => ws.name.toLowerCase() === name.trim().toLowerCase())) {
        throw conflict(`A workflow step named '${name.trim()}' already exists`);
      }

      const step = await scopedStore.createWorkflowStep({
        name: name.trim(),
        description: description.trim(),
        mode: resolvedMode,
        phase,
        prompt: prompt?.trim(),
        toolMode,
        scriptName: scriptName?.trim(),
        enabled,
        defaultOn: defaultOn === true,
        modelProvider: modelPair.provider,
        modelId: modelPair.modelId,
      });
      res.status(201).json(step);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = typeof err?.message === "string" && (err.message.includes("must include both provider and modelId") || err.message.includes("Script mode requires")) ? 400 : 500;
      throw new ApiError(status, err.message);
    }
  });

  /**
   * PATCH /api/workflow-steps/:id
   * Update a workflow step.
   * Body: Partial<{ name, description, mode, prompt, scriptName, enabled, modelProvider, modelId }>
   * Returns: WorkflowStep
   */
  router.patch("/workflow-steps/:id", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { name, description, mode, phase, prompt, toolMode, scriptName, enabled, defaultOn, modelProvider, modelId } = req.body;

      const updates: Record<string, unknown> = {};
      if (name !== undefined) {
        if (typeof name !== "string" || !name.trim()) {
          throw badRequest("name must be a non-empty string");
        }
        updates.name = name.trim();
      }
      if (description !== undefined) {
        if (typeof description !== "string" || !description.trim()) {
          throw badRequest("description must be a non-empty string");
        }
        updates.description = description.trim();
      }
      if (mode !== undefined) {
        if (mode !== "prompt" && mode !== "script") {
          throw badRequest("mode must be 'prompt' or 'script'");
        }
        updates.mode = mode;
      }
      if (phase !== undefined) {
        if (phase !== "pre-merge" && phase !== "post-merge") {
          throw badRequest("phase must be 'pre-merge' or 'post-merge'");
        }
        updates.phase = phase;
      }
      if (prompt !== undefined) {
        if (typeof prompt !== "string") {
          throw badRequest("prompt must be a string");
        }
        updates.prompt = prompt;
      }
      if (toolMode !== undefined) {
        if (toolMode !== "readonly" && toolMode !== "coding") {
          throw badRequest("toolMode must be 'readonly' or 'coding'");
        }
        updates.toolMode = toolMode;
      }
      if (scriptName !== undefined) {
        if (typeof scriptName !== "string") {
          throw badRequest("scriptName must be a string");
        }
        updates.scriptName = scriptName;
      }
      if (enabled !== undefined) {
        if (typeof enabled !== "boolean") {
          throw badRequest("enabled must be a boolean");
        }
        updates.enabled = enabled;
      }
      if (defaultOn !== undefined) {
        if (typeof defaultOn !== "boolean") {
          throw badRequest("defaultOn must be a boolean");
        }
        updates.defaultOn = defaultOn;
      }

      // Validate script-mode requirements against the resulting state (existing + updates)
      // This catches cases where an existing script-mode step has its scriptName updated
      // without the mode field being explicitly sent.
      const existingStep = await scopedStore.getWorkflowStep(req.params.id);
      const resultingMode: string | undefined = updates.mode !== undefined ? (updates.mode as string) : existingStep?.mode;
      const resultingScriptName: string | undefined = updates.scriptName !== undefined ? (updates.scriptName as string) : existingStep?.scriptName;

      if (resultingMode === "script") {
        if (!resultingScriptName?.trim()) {
          throw badRequest("scriptName is required when mode is 'script'");
        }
        const settings = await scopedStore.getSettings();
        const scripts = settings.scripts || {};
        if (!(resultingScriptName.trim() in scripts)) {
          throw badRequest(`Script '${resultingScriptName.trim()}' not found in project settings. Available scripts: ${Object.keys(scripts).join(", ") || "none"}`);
        }
      }

      // Validate and apply model override pair
      if (modelProvider !== undefined || modelId !== undefined) {
        const modelPair = assertConsistentOptionalPair(modelProvider, modelId, "workflow step model");
        updates.modelProvider = modelPair.provider;
        updates.modelId = modelPair.modelId;
      }

      const step = await scopedStore.updateWorkflowStep(req.params.id, updates);
      res.json(step);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        const status = typeof err?.message === "string" && (err.message.includes("must include both provider and modelId") || err.message.includes("Script mode requires")) ? 400 : 500;
        throw new ApiError(status, err.message);
      }
    }
  });

  /**
   * DELETE /api/workflow-steps/:id
   * Delete a workflow step.
   * Returns: 204 No Content
   */
  router.delete("/workflow-steps/:id", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      await scopedStore.deleteWorkflowStep(req.params.id);
      res.status(204).send();
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/workflow-steps/:id/refine
   * Use AI to refine the workflow step's description into a detailed agent prompt.
   * Only available for prompt-mode steps.
   * Returns: { prompt: string, workflowStep: WorkflowStep }
   */
  router.post("/workflow-steps/:id/refine", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const step = await scopedStore.getWorkflowStep(req.params.id);
      if (!step) {
        throw notFound(`Workflow step '${req.params.id}' not found`);
      }

      if (step.mode === "script") {
        throw badRequest("Cannot refine prompt for script-mode workflow steps");
      }

      if (!step.description?.trim()) {
        throw badRequest("Workflow step has no description to refine");
      }

      // Use AI to refine the description into a detailed agent prompt
      let refinedPrompt: string;
      try {
        let createKbAgent = createKbAgentForRefine;
        if (!createKbAgent) {
          // Dynamic import to avoid resolution issues in tests
          const engineModule = "@fusion/engine";
          const engine = await import(/* @vite-ignore */ engineModule);
          createKbAgent = engine.createKbAgent;
        }

        const settings = await scopedStore.getSettings();

        const systemPrompt = `You are an expert at creating detailed agent prompts for workflow steps.

A workflow step is a quality gate that runs after a task is implemented but before it's marked complete.

Given a rough description, create a detailed prompt that an AI agent can follow to execute this workflow step.

The prompt should:
1. Define the purpose clearly
2. Specify what files/context to examine
3. List specific criteria to check
4. Describe what "success" looks like
5. Include guidance on handling common edge cases

Output ONLY the prompt text (no markdown, no explanations).`;

        const { session } = await createKbAgent({
          cwd: scopedStore.getRootDir(),
          systemPrompt,
          tools: "none",
          defaultProvider: settings.planningProvider || settings.defaultProvider,
          defaultModelId: settings.planningModelId || settings.defaultModelId,
          defaultThinkingLevel: settings.defaultThinkingLevel,
        });

        let output = "";
        session.on("text", (delta: string) => {
          output += delta;
        });

        await session.prompt(
          `Refine this workflow step description into a detailed agent prompt:\n\nName: ${step.name}\nDescription: ${step.description}`
        );
        session.dispose();

        refinedPrompt = output.trim();
      } catch (agentErr: any) {
        // Fallback: return the description as-is if AI is unavailable
        refinedPrompt = step.description;
      }

      // Update the workflow step with the refined prompt
      const updated = await scopedStore.updateWorkflowStep(step.id, { prompt: refinedPrompt });
      res.json({ prompt: refinedPrompt, workflowStep: updated });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Workflow Step Templates ───────────────────────────────────────────

  /**
   * GET /api/workflow-step-templates
   * List all built-in workflow step templates.
   * Returns: { templates: WorkflowStepTemplate[] }
   */
  router.get("/workflow-step-templates", async (_req, res) => {
    try {
      const { WORKFLOW_STEP_TEMPLATES } = await import("@fusion/core");
      res.json({ templates: WORKFLOW_STEP_TEMPLATES });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/workflow-step-templates/:id/create
   * Create a workflow step from a built-in template.
   * Returns: WorkflowStep
   */
  router.post("/workflow-step-templates/:id/create", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { WORKFLOW_STEP_TEMPLATES } = await import("@fusion/core");
      const template = WORKFLOW_STEP_TEMPLATES.find((t) => t.id === req.params.id);

      if (!template) {
        throw notFound(`Template '${req.params.id}' not found`);
      }

      // Check for name conflicts with existing workflow steps
      const existing = await scopedStore.listWorkflowSteps();
      if (existing.some((ws) => ws.name.toLowerCase() === template.name.toLowerCase())) {
        throw conflict(`A workflow step named '${template.name}' already exists`);
      }

      const step = await scopedStore.createWorkflowStep({
        templateId: template.id,
        name: template.name,
        description: template.description,
        prompt: template.prompt,
        toolMode: template.toolMode,
        enabled: true,
      });

      res.status(201).json(step);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Scripts Routes ──────────────────────────────────────────────────────────

  /**
   * POST /api/scripts/:name/run
   * Execute a saved script by name using terminal service.
   * Body: { args?: string[] } - Optional arguments to append to the command
   * Returns: { sessionId: string, command: string }
   */
  router.post("/scripts/:name/run", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const scriptName = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;

      if (!scriptName) {
        throw badRequest("Script name is required");
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(scriptName)) {
        throw badRequest("Script name must contain only alphanumeric characters, hyphens, and underscores (no spaces)");
      }

      // Get the script from settings
      const settings = await scopedStore.getSettings();
      const currentScripts = settings.scripts ?? {};

      if (currentScripts[scriptName] === undefined) {
        throw notFound(`Script '${scriptName}' not found`);
      }

      const baseCommand = currentScripts[scriptName];
      const { args } = req.body ?? {};

      // Validate args if provided
      if (args !== undefined && !Array.isArray(args)) {
        throw badRequest("args must be an array of strings");
      }
      if (args && !args.every((a: unknown) => typeof a === "string")) {
        throw badRequest("args must be an array of strings");
      }

      // Build the full command with args
      let fullCommand = baseCommand;
      if (args && args.length > 0) {
        // Properly escape arguments for shell execution
        const escapedArgs = args.map((arg: unknown) => {
          // Quote and escape the argument for shell
          const str = String(arg);
          // If the arg contains special characters, use double quotes with escaping
          if (str.includes('"') || str.includes("$") || str.includes("`") || str.includes("\\")) {
            // Use single quotes and escape embedded single quotes
            return `'${str.replace(/'/g, "'\\''")}'`;
          }
          // Simple case: use double quotes
          return `"${str}"`;
        });
        fullCommand = `${baseCommand} ${escapedArgs.join(" ")}`;
      }

      // Execute via terminal service
      const terminalService = getTerminalService(scopedStore.getRootDir());
      const result = await terminalService.createSession({
        cwd: scopedStore.getRootDir(),
      });

      if (!result.success) {
        const statusByCode = {
          max_sessions: 503,
          invalid_shell: 400,
          pty_load_failed: 503,
          pty_spawn_failed: 500,
        } as const;
        const status = result.code ? (statusByCode[result.code] ?? 500) : 500;
        throw new ApiError(status, result.error || "Failed to create terminal session");
      }

      const sessionId = result.session.id;

      // Write the command to the PTY (use writeInput for compatibility with test mocks)
      terminalService.writeInput(sessionId, `${fullCommand}\n`);

      res.status(201).json({
        sessionId,
        command: fullCommand,
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Agent Routes ───────────────────────────────────────────────────────────

  /**
   * GET /api/agents
   * List all agents with optional filtering.
   * Query params: state, role
   */
  router.get("/agents", async (req, res) => {
    try {
      const filter: { state?: string; role?: string } = {};
      if (req.query.state && typeof req.query.state === "string") {
        filter.state = req.query.state;
      }
      if (req.query.role && typeof req.query.role === "string") {
        filter.role = req.query.role;
      }

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agents = await agentStore.listAgents(filter as { state?: "idle" | "active" | "paused" | "terminated"; role?: import("@fusion/core").AgentCapability });
      res.json(agents);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  function validateAgentInstructionsPayload(
    res: Response,
    instructionsPath: unknown,
    instructionsText: unknown,
  ): boolean {
    if (instructionsPath !== undefined && instructionsPath !== null && instructionsPath !== "") {
      if (typeof instructionsPath !== "string") {
        throw badRequest("instructionsPath must be a string");
        return false;
      }
      if (instructionsPath.length > 500) {
        throw badRequest("instructionsPath must be at most 500 characters");
        return false;
      }
      if (instructionsPath.includes("..")) {
        throw badRequest("instructionsPath must not contain parent directory traversal (..)");
        return false;
      }
      const isAbsoluteUnix = instructionsPath.startsWith("/");
      const isAbsoluteWindows = /^[A-Za-z]:[\\/]/.test(instructionsPath);
      if (isAbsoluteUnix || isAbsoluteWindows) {
        throw badRequest("instructionsPath must be a project-relative path");
        return false;
      }
      if (!instructionsPath.endsWith(".md")) {
        throw badRequest("instructionsPath must end in .md");
        return false;
      }
    }

    if (instructionsText !== undefined && instructionsText !== null && instructionsText !== "") {
      if (typeof instructionsText !== "string") {
        throw badRequest("instructionsText must be a string");
        return false;
      }
      if (instructionsText.length > 50000) {
        throw badRequest("instructionsText must be at most 50,000 characters");
        return false;
      }
    }

    return true;
  }

  function serializeAccessState(state: import("@fusion/core").AgentAccessState) {
    return {
      ...state,
      resolvedPermissions: Array.from(state.resolvedPermissions),
      explicitPermissions: Array.from(state.explicitPermissions),
      roleDefaultPermissions: Array.from(state.roleDefaultPermissions),
    };
  }

  /**
   * POST /api/agents
   * Create a new agent.
   */
  router.post("/agents", async (req, res) => {
    try {
      const {
        name,
        role,
        metadata,
        title,
        icon,
        reportsTo,
        runtimeConfig,
        permissions,
        instructionsPath,
        instructionsText,
      } = req.body ?? {};

      if (!name || typeof name !== "string") {
        throw badRequest("name is required");
      }
      if (!role || typeof role !== "string") {
        throw badRequest("role is required");
      }
      if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
        throw badRequest("metadata must be an object");
      }
      if (title !== undefined && title !== null && typeof title !== "string") {
        throw badRequest("title must be a string");
      }
      if (icon !== undefined && icon !== null && typeof icon !== "string") {
        throw badRequest("icon must be a string");
      }
      if (reportsTo !== undefined && reportsTo !== null && typeof reportsTo !== "string") {
        throw badRequest("reportsTo must be a string");
      }
      if (runtimeConfig !== undefined && (typeof runtimeConfig !== "object" || runtimeConfig === null || Array.isArray(runtimeConfig))) {
        throw badRequest("runtimeConfig must be an object");
      }
      if (permissions !== undefined && (typeof permissions !== "object" || permissions === null || Array.isArray(permissions))) {
        throw badRequest("permissions must be an object");
      }
      if (!validateAgentInstructionsPayload(res, instructionsPath, instructionsText)) {
        return;
      }

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.createAgent({
        name,
        role: role as import("@fusion/core").AgentCapability,
        metadata,
        title: title ?? undefined,
        icon: icon ?? undefined,
        reportsTo: reportsTo ?? undefined,
        runtimeConfig,
        permissions,
        instructionsPath: instructionsPath ?? undefined,
        instructionsText: instructionsText ?? undefined,
      });
      res.status(201).json(agent);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("required") || err.message?.includes("cannot be empty")) {
        throw badRequest(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/agents/export
   * Export agents to an Agent Companies package directory.
   *
   * Body:
   *  - { agentIds?: string[]; companyName?: string; companySlug?: string; outputDir?: string }
   */
  router.post("/agents/export", async (req, res) => {
    try {
      const { agentIds, companyName, companySlug, outputDir } = req.body ?? {};

      if (agentIds !== undefined) {
        if (!Array.isArray(agentIds)) {
          throw badRequest("agentIds must be an array of strings");
        }
        if (agentIds.some((id: unknown) => typeof id !== "string" || id.trim().length === 0)) {
          throw badRequest("agentIds must contain non-empty strings");
        }
      }

      if (companyName !== undefined && typeof companyName !== "string") {
        throw badRequest("companyName must be a string");
      }
      if (companySlug !== undefined && typeof companySlug !== "string") {
        throw badRequest("companySlug must be a string");
      }
      if (outputDir !== undefined && typeof outputDir !== "string") {
        throw badRequest("outputDir must be a string");
      }

      const scopedStore = await getScopedStore(req);
      const { AgentStore, exportAgentsToDirectory } = await import("@fusion/core");

      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const allAgents = await agentStore.listAgents();
      const requestedIds = Array.isArray(agentIds) ? [...new Set(agentIds.map((id) => id.trim()))] : [];
      const agentsToExport = requestedIds.length > 0
        ? allAgents.filter((agent: any) => requestedIds.includes(agent.id))
        : allAgents;

      if (agentsToExport.length === 0) {
        throw badRequest("No agents found to export");
      }

      let resolvedOutputDir: string;
      if (typeof outputDir === "string" && outputDir.trim().length > 0) {
        resolvedOutputDir = resolve(outputDir.trim());
      } else if (typeof outputDir === "string") {
        throw badRequest("outputDir cannot be empty");
      } else {
        resolvedOutputDir = await mkdtemp(join(tmpdir(), "fusion-agent-export-"));
      }

      const result = await exportAgentsToDirectory(agentsToExport, resolvedOutputDir, {
        companyName: typeof companyName === "string" ? companyName : undefined,
        companySlug: typeof companySlug === "string" ? companySlug : undefined,
      });

      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/import
   * Import agents from Agent Companies sources.
   *
   * Body modes (checked in order):
   *  - { agents: AgentManifest[], skipExisting?, dryRun? }
   *  - { source: string, skipExisting?, dryRun? }   // server directory path
   *  - { manifest: string, skipExisting?, dryRun? } // raw AGENTS.md content
   */
  router.post("/agents/import", async (req, res) => {
    try {
      const { agents, source, manifest, skipExisting, dryRun } = req.body ?? {};
      const {
        AgentStore,
        parseCompanyDirectory,
        parseCompanyArchive,
        parseSingleAgentManifest,
        convertAgentCompanies,
        AgentCompaniesParseError,
      } = await import("@fusion/core");

      const scopedStore = await getScopedStore(req);
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const existingAgents = await agentStore.listAgents();
      const existingNames = new Set(existingAgents.map((a: any) => a.name));
      const conversionOptions = skipExisting ? { skipExisting: [...existingNames] } : undefined;

      let pkg: {
        company?: { name?: string; slug?: string };
        agents: unknown[];
        teams: unknown[];
        projects: unknown[];
        tasks: unknown[];
      };

      if (Array.isArray(agents)) {
        pkg = {
          company: undefined,
          agents,
          teams: [],
          projects: [],
          tasks: [],
        };
      } else if (typeof source === "string" && source.trim()) {
        const sourcePath = resolve(source);
        if (!existsSync(sourcePath)) {
          throw badRequest(`source does not exist: ${sourcePath}`);
        }

        const isArchive = sourcePath.endsWith(".tar.gz")
          || sourcePath.endsWith(".tgz")
          || sourcePath.endsWith(".zip");

        if (isArchive) {
          pkg = await parseCompanyArchive(sourcePath);
        } else if (nodeFs.statSync(sourcePath).isDirectory()) {
          pkg = parseCompanyDirectory(sourcePath);
        } else {
          throw badRequest("Source must be a server-side directory or archive path");
        }
      } else if (typeof manifest === "string") {
        const { manifest: singleAgent } = parseSingleAgentManifest(manifest);
        pkg = {
          company: undefined,
          agents: [singleAgent],
          teams: [],
          projects: [],
          tasks: [],
        };
      } else {
        throw badRequest("Provide one of: agents (array), source (path), or manifest (string)");
      }

      const { inputs, result } = convertAgentCompanies(pkg as any, conversionOptions);
      const companyName = pkg.company?.name ?? "Unknown";
      const companySlug = typeof pkg.company?.slug === "string" ? pkg.company.slug : undefined;

      if (inputs.length === 0 && result.errors.length === 0 && result.skipped.length === 0) {
        throw badRequest("No agents found in manifest");
      }

      if (dryRun) {
        const agentPreview = inputs.map((input: any) => ({
          name: input.name,
          role: input.role,
          title: typeof input.title === "string" ? input.title : undefined,
          skills: Array.isArray(input.metadata?.skills)
            ? input.metadata.skills.filter((skill: unknown): skill is string => typeof skill === "string")
            : undefined,
        }));

        res.json({
          dryRun: true,
          companyName,
          ...(companySlug ? { companySlug } : {}),
          agents: agentPreview,
          created: result.created,
          skipped: result.skipped,
          errors: result.errors,
        });
        return;
      }

      const created: Array<{ id: string; name: string }> = [];
      const errors: Array<{ name: string; error: string }> = [...result.errors];

      for (const input of inputs) {
        if (!skipExisting && existingNames.has(input.name)) {
          errors.push({ name: input.name, error: "Agent with this name already exists" });
          continue;
        }

        try {
          const agent = await agentStore.createAgent(input);
          created.push({ id: agent.id, name: agent.name });
        } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
          errors.push({ name: input.name, error: err.message });
        }
      }

      res.json({
        companyName,
        ...(companySlug ? { companySlug } : {}),
        created,
        skipped: result.skipped,
        errors,
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err?.name === "AgentCompaniesParseError") {
        throw badRequest(err.message);
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/stats
   * Return aggregate stats across all agents.
   * Must be registered before /agents/:id to avoid "stats" matching :id.
   */
  router.get("/agents/stats", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agents = await agentStore.listAgents();
      const activeCount = agents.filter((a: any) => a.state === "active" || a.state === "running").length;
      const assignedTaskCount = agents.filter((a: any) => a.taskId).length;

      let completedRuns = 0;
      let failedRuns = 0;
      for (const agent of agents) {
        const runs = await agentStore.getRecentRuns(agent.id, 100);
        completedRuns += runs.filter((r: any) => r.status === "completed").length;
        failedRuns += runs.filter((r: any) => r.status === "failed" || r.status === "terminated").length;
      }

      const total = completedRuns + failedRuns;
      const successRate = total > 0 ? completedRuns / total : 0;
      res.json({ activeCount, assignedTaskCount, completedRuns, failedRuns, successRate });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/org-tree
   * Return full agent org chart tree.
   * Must be registered before /agents/:id to avoid "org-tree" matching :id.
   */
  router.get("/agents/org-tree", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const tree = await agentStore.getOrgTree();
      res.json(tree);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/resolve/:shortname
   * Resolve an agent by shortname or ID.
   * Must be registered before /agents/:id to avoid "resolve" matching :id.
   */
  router.get("/agents/resolve/:shortname", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.resolveAgent(req.params.shortname);
      if (!agent) {
        throw notFound("Agent not found");
      }

      res.json({ agent });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id
   * Get agent by ID with heartbeat history.
   */
  router.get("/agents/:id", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgentDetail(req.params.id, 50);
      if (!agent) {
        throw notFound("Agent not found");
      }
      res.json(agent);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/agents/:id
   * Update agent fields.
   */
  router.patch("/agents/:id", async (req, res) => {
    try {
      const body = req.body ?? {};
      const updates: import("@fusion/core").AgentUpdateInput = {};

      if ("name" in body) {
        if (body.name !== null && typeof body.name !== "string") {
          throw badRequest("name must be a string");
        }
        updates.name = body.name ?? undefined;
      }

      if ("role" in body) {
        if (body.role !== null && typeof body.role !== "string") {
          throw badRequest("role must be a string");
        }
        updates.role = body.role ?? undefined;
      }

      if ("metadata" in body) {
        if (body.metadata !== null && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
          throw badRequest("metadata must be an object");
        }
        updates.metadata = body.metadata ?? undefined;
      }

      if ("title" in body) {
        if (body.title !== null && typeof body.title !== "string") {
          throw badRequest("title must be a string");
        }
        updates.title = body.title ?? undefined;
      }

      if ("icon" in body) {
        if (body.icon !== null && typeof body.icon !== "string") {
          throw badRequest("icon must be a string");
        }
        updates.icon = body.icon ?? undefined;
      }

      if ("reportsTo" in body) {
        if (body.reportsTo !== null && typeof body.reportsTo !== "string") {
          throw badRequest("reportsTo must be a string");
        }
        updates.reportsTo = body.reportsTo ?? undefined;
      }

      if ("pauseReason" in body) {
        if (body.pauseReason !== null && typeof body.pauseReason !== "string") {
          throw badRequest("pauseReason must be a string");
        }
        updates.pauseReason = body.pauseReason ?? undefined;
      }

      if ("runtimeConfig" in body) {
        if (body.runtimeConfig !== null && (typeof body.runtimeConfig !== "object" || Array.isArray(body.runtimeConfig))) {
          throw badRequest("runtimeConfig must be an object");
        }
        updates.runtimeConfig = body.runtimeConfig ?? undefined;
      }

      if ("permissions" in body) {
        if (body.permissions !== null && (typeof body.permissions !== "object" || Array.isArray(body.permissions))) {
          throw badRequest("permissions must be an object");
        }
        updates.permissions = body.permissions ?? undefined;
      }

      if ("totalInputTokens" in body) {
        if (body.totalInputTokens !== null && typeof body.totalInputTokens !== "number") {
          throw badRequest("totalInputTokens must be a number");
        }
        updates.totalInputTokens = body.totalInputTokens ?? undefined;
      }

      if ("totalOutputTokens" in body) {
        if (body.totalOutputTokens !== null && typeof body.totalOutputTokens !== "number") {
          throw badRequest("totalOutputTokens must be a number");
        }
        updates.totalOutputTokens = body.totalOutputTokens ?? undefined;
      }

      if (!validateAgentInstructionsPayload(res, body.instructionsPath, body.instructionsText)) {
        return;
      }
      if ("instructionsPath" in body) {
        updates.instructionsPath = body.instructionsPath ?? undefined;
      }
      if ("instructionsText" in body) {
        updates.instructionsText = body.instructionsText ?? undefined;
      }

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, updates);
      res.json(agent);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else if (err.message?.includes("cannot be empty")) {
        throw badRequest(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/access
   * Get computed access state for an agent.
   */
  router.get("/agents/:id/access", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore, computeAccessState } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const state = computeAccessState(agent);
      res.json(serializeAccessState(state));
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/agents/:id/permissions
   * Update agent permission grants.
   */
  router.patch("/agents/:id/permissions", async (req, res) => {
    try {
      const { permissions } = req.body ?? {};

      if (permissions === undefined || permissions === null || typeof permissions !== "object" || Array.isArray(permissions)) {
        throw badRequest("permissions must be an object");
      }

      const { AgentStore, isValidPermission } = await import("@fusion/core");

      for (const [key, value] of Object.entries(permissions as Record<string, unknown>)) {
        if (key.startsWith("budget:")) {
          throw badRequest("Budget permissions are not supported");
        }
        if (!isValidPermission(key)) {
          throw badRequest(`Invalid permission: ${key}`);
        }
        if (typeof value !== "boolean") {
          throw badRequest(`Permission value for ${key} must be boolean`);
        }
      }

      const scopedStore = await getScopedStore(req);
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, {
        permissions: permissions as Record<string, boolean>,
      });
      res.json(agent);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * PATCH /api/agents/:id/instructions
   * Update agent custom instructions.
   * Body: { instructionsPath?: string, instructionsText?: string }
   */
  router.patch("/agents/:id/instructions", async (req, res) => {
    try {
      const { instructionsPath, instructionsText } = req.body ?? {};
      if (!validateAgentInstructionsPayload(res, instructionsPath, instructionsText)) {
        return;
      }

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, {
        instructionsPath: instructionsPath ?? undefined,
        instructionsText: instructionsText ?? undefined,
      });
      res.json(agent);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/soul
   * Fetch agent soul/personality text.
   */
  router.get("/agents/:id/soul", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      res.json({ soul: agent.soul ?? null });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/agents/:id/soul
   * Update agent soul/personality text.
   * Body: { soul: string }
   */
  router.patch("/agents/:id/soul", async (req, res) => {
    try {
      const { soul } = req.body ?? {};
      if (typeof soul !== "string") {
        throw badRequest("soul must be a string");
      }
      if (soul.length > 10000) {
        throw badRequest("soul must be at most 10,000 characters");
      }

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, { soul });
      res.json(agent);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/memory
   * Fetch per-agent memory text.
   */
  router.get("/agents/:id/memory", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      res.json({ memory: agent.memory ?? null });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/agents/:id/memory
   * Update per-agent memory text.
   * Body: { memory: string }
   */
  router.patch("/agents/:id/memory", async (req, res) => {
    try {
      const { memory } = req.body ?? {};
      if (typeof memory !== "string") {
        throw badRequest("memory must be a string");
      }
      if (memory.length > 50000) {
        throw badRequest("memory must be at most 50,000 characters");
      }

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, { memory });
      res.json(agent);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/:id/state
   * Update agent state.
   * Body: { state: AgentState }
   */
  router.post("/agents/:id/state", async (req, res) => {
    try {
      const { state } = req.body;
      if (!state || typeof state !== "string") {
        throw badRequest("state is required");
      }

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgentState(req.params.id, state as import("@fusion/core").AgentState);
      res.json(agent);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else if (/invalid state transition/i.test(err.message ?? "")) {
        throw badRequest(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * DELETE /api/agents/:id
   * Delete an agent.
   */
  router.delete("/agents/:id", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      await agentStore.deleteAgent(req.params.id);
      res.status(204).send();
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/config-revisions
   * List config revisions for an agent.
   * Query: limit (default: 50)
   */
  router.get("/agents/:id/config-revisions", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const rawLimit = req.query.limit;
      const limit = rawLimit === undefined ? 50 : Number.parseInt(String(rawLimit), 10);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw badRequest("limit must be a positive integer");
      }

      const revisions = await agentStore.getConfigRevisions(req.params.id, limit);
      res.json(revisions);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/config-revisions/:revisionId
   * Get a specific config revision for an agent.
   */
  router.get("/agents/:id/config-revisions/:revisionId", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const revision = await agentStore.getConfigRevision(req.params.id, req.params.revisionId);
      if (!revision) {
        throw notFound("Config revision not found");
      }

      res.json(revision);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/:id/config-revisions/:revisionId/rollback
   * Roll back an agent to a previous config revision.
   */
  router.post("/agents/:id/config-revisions/:revisionId/rollback", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const result = await agentStore.rollbackConfig(req.params.id, req.params.revisionId);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("belongs to agent")) {
        throw badRequest(err.message);
      } else if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/agents/:id/keys
   * Create a new API key for an agent.
   * Body: { label?: string }
   */
  router.post("/agents/:id/keys", async (req, res) => {
    try {
      const { label } = req.body ?? {};
      if (label !== undefined && typeof label !== "string") {
        throw badRequest("label must be a string");
      }

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const result = await agentStore.createApiKey(req.params.id, { label });
      res.status(201).json(result);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/keys
   * List all API keys for an agent.
   */
  router.get("/agents/:id/keys", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const keys = await agentStore.listApiKeys(req.params.id);
      res.json(keys);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * DELETE /api/agents/:id/keys/:keyId
   * Revoke an API key for an agent.
   */
  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const revoked = await agentStore.revokeApiKey(req.params.id, req.params.keyId);
      res.json(revoked);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/tasks
   * List tasks explicitly assigned to the given agent.
   */
  router.get("/agents/:id/tasks", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const tasks = await scopedStore.listTasks();
      res.json(tasks.filter((task) => task.assignedAgentId === req.params.id));
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/:id/heartbeat
   * Record a heartbeat for an agent.
   * Body: { status?: "ok"|"missed"|"recovered", triggerExecution?: boolean }
   *
   * When triggerExecution is true AND HeartbeatMonitor is available,
   * also executes a heartbeat run after recording the heartbeat event.
   */
  router.post("/agents/:id/heartbeat", async (req, res) => {
    try {
      const { status = "ok", triggerExecution } = req.body;

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const event = await agentStore.recordHeartbeat(req.params.id, status as "ok" | "missed" | "recovered");

      // Optionally trigger execution
      let run: import("@fusion/core").AgentHeartbeatRun | undefined;
      if (triggerExecution && hasHeartbeatExecutor && heartbeatMonitor) {
        run = await heartbeatMonitor.executeHeartbeat({
          agentId: req.params.id,
          source: "on_demand",
          triggerDetail: "Triggered from heartbeat",
          contextSnapshot: {
            wakeReason: "on_demand",
            triggerDetail: "Triggered from heartbeat",
          },
        });
      }

      res.json(run ? { event, run } : event);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/heartbeats
   * Get heartbeat history for an agent.
   * Query: limit (default: 50)
   */
  router.get("/agents/:id/heartbeats", async (req, res) => {
    try {
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const history = await agentStore.getHeartbeatHistory(req.params.id, limit);
      res.json(history);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/runs
   * List recent runs for an agent.
   * Query: limit (default: 20)
   */
  router.get("/agents/:id/runs", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 20;
      const runs = await agentStore.getRecentRuns(req.params.id, limit);
      res.json(runs);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/agents/:id/runs
   * Manually start a heartbeat run for an agent.
   * Body: { source?: HeartbeatInvocationSource, triggerDetail?: string, taskId?: string }
   *
   * When HeartbeatMonitor is available, delegates to executeHeartbeat() with
   * a structured wake context snapshot. This ensures a single authoritative run
   * record is created and fully completed without duplicate startRun calls.
   *
   * Returns 409 Conflict if the agent already has an active run.
   */
  router.post("/agents/:id/runs", async (req, res) => {
    try {
      const { source, triggerDetail, taskId } = req.body || {};
      const invocationSource = source ?? "on_demand";
      const trigger = triggerDetail ?? "Triggered from dashboard";

      // Build structured wake context
      const contextSnapshot: Record<string, unknown> = {
        wakeReason: invocationSource,
        triggerDetail: trigger,
      };
      if (taskId) {
        contextSnapshot.taskId = taskId;
      }

      if (hasHeartbeatExecutor && heartbeatMonitor) {
        // Check for existing active run
        const scopedStore = await getScopedStore(req);
        const { AgentStore: AgentStoreClass } = await import("@fusion/core");
        const agentStore = new AgentStoreClass({ rootDir: scopedStore.getFusionDir() });
        await agentStore.init();

        const activeRun = await agentStore.getActiveHeartbeatRun(req.params.id);
        if (activeRun) {
          throw new ApiError(409, "Agent already has an active run", { runId: activeRun.id });
        }

        // Execute heartbeat end-to-end (single run record, no duplicate startRun call)
        const run = await heartbeatMonitor.executeHeartbeat({
          agentId: req.params.id,
          source: invocationSource,
          triggerDetail: trigger,
          taskId,
          contextSnapshot,
        });

        res.status(201).json(run);
      } else {
        // Fallback: record-only behavior without HeartbeatMonitor
        const scopedStore = await getScopedStore(req);
        const { AgentStore } = await import("@fusion/core");
        const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
        await agentStore.init();

        // Check for existing active run
        const activeRun = await agentStore.getActiveHeartbeatRun(req.params.id);
        if (activeRun) {
          throw new ApiError(409, "Agent already has an active run", { runId: activeRun.id });
        }

        const run = await agentStore.startHeartbeatRun(req.params.id);

        // Enrich with invocation source, trigger detail, and context snapshot
        (run as any).invocationSource = invocationSource;
        (run as any).triggerDetail = trigger;
        (run as any).contextSnapshot = contextSnapshot;

        await agentStore.saveRun(run);
        res.status(201).json(run);
      }
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/runs/:runId
   * Get detail for a specific agent run.
   */
  router.get("/agents/:id/runs/:runId", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const run = await agentStore.getRunDetail(req.params.id, req.params.runId);
      if (!run) {
        throw notFound("Run not found");
      }
      res.json(run);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/runs/:runId/logs
   * Get agent log entries for a specific run's time window.
   * Uses the run's contextSnapshot.taskId to locate the task's agent log,
   * then filters entries by the run's startedAt/endedAt timestamps.
   * Returns an empty array if the run has no associated task.
   */
  router.get("/agents/:id/runs/:runId/logs", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const run = await agentStore.getRunDetail(req.params.id, req.params.runId);
      if (!run) {
        throw notFound("Run not found");
      }

      // Only use the run's context snapshot for task ID — do not fall back
      // to agent.taskId since that represents the agent's *current* task,
      // not the task active during a historical run.
      const taskId = run.contextSnapshot?.taskId as string | undefined;
      if (!taskId) {
        res.json([]);
        return;
      }

      const logs = await scopedStore.getAgentLogsByTimeRange(
        taskId,
        run.startedAt,
        run.endedAt,
      );
      res.json(logs);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message?.includes("not found")) {
        throw notFound(err.message);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/chain-of-command
   * Fetch agent reporting chain from self to top-most manager.
   * Response 200: Agent[] — [self, manager, grand-manager, ...]
   * Response 404: { error: "Agent not found" } — When target agent doesn't exist
   */
  router.get("/agents/:id/chain-of-command", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const chain = await agentStore.getChainOfCommand(req.params.id);
      res.json(chain);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/children
   * Fetch agents that report to a given agent (parent-child hierarchy).
   * Response 200: Agent[] — Array of agents where reportsTo equals :id
   * Response 404: { error: "Agent not found" } — When parent agent doesn't exist
   */
  const getAgentEmployeesHandler = async (req: Request, res: Response) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the parent agent exists
      const parent = await agentStore.getAgent(agentId);
      if (!parent) {
        throw notFound("Agent not found");
      }

      const children = await agentStore.getAgentsByReportsTo(agentId);
      res.json(children);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  };

  router.get("/agents/:id/children", getAgentEmployeesHandler);

  /**
   * GET /api/agents/:id/employees
   * Alias for /api/agents/:id/children.
   */
  router.get("/agents/:id/employees", getAgentEmployeesHandler);

  // ── Agent Generation Routes ──────────────────────────────────────────────

  /**
   * POST /api/agents/generate/start
   * Start a new agent generation session.
   * Body: { role: string }
   * Response: { sessionId, roleDescription }
   */
  router.post("/agents/generate/start", async (req, res) => {
    try {
      const { role } = req.body as { role?: string };
      if (!role || typeof role !== "string") {
        throw badRequest("role is required and must be a string");
      }

      const trimmedRole = role.trim();
      if (trimmedRole.length === 0) {
        throw badRequest("role must not be empty");
      }
      if (trimmedRole.length > 1000) {
        throw badRequest("role must not exceed 1000 characters");
      }

      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const session = await startAgentGeneration(ip, trimmedRole);

      res.status(201).json({
        sessionId: session.id,
        roleDescription: session.roleDescription,
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof AgentGenerationRateLimitError) {
        throw rateLimited(err.message);
      }
      console.error("[agent-generation] Error starting session:", err);
      rethrowAsApiError(err, "Failed to start agent generation session");
    }
  });

  /**
   * POST /api/agents/generate/spec
   * Generate the agent specification for an existing session.
   * Body: { sessionId: string }
   * Response: { spec: AgentGenerationSpec }
   */
  router.post("/agents/generate/spec", async (req, res) => {
    try {
      const { sessionId } = req.body as { sessionId?: string };
      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const scopedStore = await getScopedStore(req);
      const rootDir = scopedStore.getRootDir();

      const spec = await generateAgentSpec(sessionId, rootDir);
      res.json({ spec });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof AgentGenerationSessionNotFoundError) {
        throw notFound(err.message);
      }
      console.error("[agent-generation] Error generating spec:", err);
      rethrowAsApiError(err, "Failed to generate agent specification");
    }
  });

  /**
   * GET /api/agents/generate/:sessionId
   * Get the current state of an agent generation session.
   * Response: { session: AgentGenerationSession }
   */
  router.get("/agents/generate/:sessionId", async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = getAgentGenerationSession(sessionId);

      if (!session) {
        throw notFound(`Session ${sessionId} not found or expired`);
      }

      res.json({ session });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/agents/generate/:sessionId
   * Cancel and clean up an agent generation session.
   * Response: { success: true }
   */
  router.delete("/agents/generate/:sessionId", async (req, res) => {
    try {
      const { sessionId } = req.params;
      cleanupAgentGenerationSession(sessionId);
      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Mission Routes ─────────────────────────────────────────────────────────
  // Mount mission routes at /api/missions
  router.use("/missions", createMissionRouter(store, options?.missionAutopilot));

  // ── AI Session Routes (Background Tasks) ─────────────────────────────────

  const aiSessionStore = options?.aiSessionStore;

  /**
   * GET /api/ai-sessions
   * List active background AI sessions (generating or awaiting_input).
   * Query: { projectId?: string }
   */
  router.get("/ai-sessions", (req, res) => {
    if (!aiSessionStore) {
      res.json({ sessions: [] });
      return;
    }
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const sessions = aiSessionStore.listActive(projectId);
    res.json({ sessions });
  });

  /**
   * GET /api/ai-sessions/:id
   * Get full session state for modal reconnection.
   */
  router.get("/ai-sessions/:id", (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }
    const session = aiSessionStore.get(req.params.id);
    if (!session) {
      throw notFound("Session not found");
    }
    res.json(session);
  });

  /**
   * POST /api/ai-sessions/:id/ping
   * Lightweight keep-alive touch for active AI sessions.
   */
  router.post("/ai-sessions/:id/ping", (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }

    const { id } = req.params;
    const updated = aiSessionStore.ping(id);
    if (!updated) {
      throw notFound("Session not found");
    }

    res.json({ ok: true });
  });

  /**
   * DELETE /api/ai-sessions/:id
   * Dismiss/cancel a background AI session.
   * Also cleans up the in-memory agent if still alive.
   */
  router.delete("/ai-sessions/:id", (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }
    const { id } = req.params;
    const session = aiSessionStore.get(id);
    if (!session) {
      throw notFound("Session not found");
    }

    aiSessionStore.delete(id);

    try {
      if (getPlanningSession(id)) cleanupPlanningSession(id);
    } catch {
      // Session may not belong to planning or may already be cleaned up.
    }

    try {
      if (getSubtaskSession(id)) cleanupSubtaskSession(id);
    } catch {
      // Session may not belong to subtask breakdown or may already be cleaned up.
    }

    try {
      if (getMissionInterviewSession(id)) cleanupMissionInterviewSession(id);
    } catch {
      // Session may not belong to mission interview or may already be cleaned up.
    }

    res.json({ ok: true });
  });

  // ── Directory Browsing ────────────────────────────────────────────────────────

  /**
   * GET /api/browse-directory
   * Browse filesystem directories for the directory picker.
   * Query: { path?: string, showHidden?: "true" }
   * Returns: { currentPath: string, parentPath: string | null, entries: Array<{ name: string, path: string, hasChildren: boolean }> }
   */
  router.get("/browse-directory", async (req, res) => {
    try {
      const { resolve, dirname, join } = await import("node:path");
      const { readdir, stat } = await import("node:fs/promises");

      const rawPath = (req.query.path as string) || process.env.HOME || process.env.USERPROFILE || "/";
      const showHidden = req.query.showHidden === "true";

      // Validate: must be absolute, no .. traversal
      const resolvedPath = resolve(rawPath);
      if (rawPath.includes("..")) {
        throw badRequest("Path must not contain '..' traversal");
      }
      if (resolvedPath !== resolve(resolvedPath)) {
        throw badRequest("Path must be absolute");
      }

      // Check path exists and is a directory
      let pathStat;
      try {
        pathStat = await stat(resolvedPath);
      } catch {
        throw notFound("Directory not found");
      }
      if (!pathStat.isDirectory()) {
        throw badRequest("Path is not a directory");
      }

      // Read directory entries
      const dirEntries = await readdir(resolvedPath, { withFileTypes: true });
      const entries: Array<{ name: string; path: string; hasChildren: boolean }> = [];

      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue;
        if (!showHidden && entry.name.startsWith(".")) continue;

        const entryPath = join(resolvedPath, entry.name);
        let hasChildren = false;
        try {
          const subEntries = await readdir(entryPath, { withFileTypes: true });
          hasChildren = subEntries.some((e) => e.isDirectory());
        } catch {
          // Can't read subdirectory — treat as no children
        }

        entries.push({ name: entry.name, path: entryPath, hasChildren });
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));

      const parentPath = resolvedPath === "/" ? null : dirname(resolvedPath);

      res.json({ currentPath: resolvedPath, parentPath, entries });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Project Management Routes (Multi-Project Support) ───────────────────────
  // These routes require CentralCore which is imported dynamically to avoid
  // circular dependencies and ensure the central database is initialized.

  /**
   * GET /api/projects
   * List all registered projects with their basic info.
   * Returns: ProjectInfo[]
   */
  router.get("/projects", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      // Reconcile stale "initializing" projects before listing so the
      // dashboard never shows permanent loading spinners for legacy records.
      await central.reconcileProjectStatuses();

      const projects = prioritizeProjectsForCurrentDirectory(await central.listProjects());
      await central.close();
      
      res.json(projects);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/projects
   * Register a new project.
   * Body: { name: string, path: string, isolationMode?: "in-process" | "child-process" }
   * Returns: RegisteredProject
   */
  router.post("/projects", async (req, res) => {
    try {
      const { name, path, isolationMode = "in-process" } = req.body;
      
      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required and must be a non-empty string");
      }
      if (!path || typeof path !== "string" || !path.trim()) {
        throw badRequest("path is required and must be a non-empty string");
      }
      if (!["in-process", "child-process"].includes(isolationMode)) {
        throw badRequest("isolationMode must be 'in-process' or 'child-process'");
      }
      
      // Check if path exists and has .fusion/ directory
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      if (!existsSync(path)) {
        throw badRequest("Project path does not exist");
      }
      const hasFusionDir = existsSync(join(path, ".fusion"));
      
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const project = await central.registerProject({
        name: name.trim(),
        path: path.trim(),
        isolationMode,
      });

      // Activate the project (registration sets it to 'initializing')
      const activeProject = await central.updateProject(project.id, { status: "active" });
      
      await central.close();
      
      res.status(201).json({ ...activeProject, _meta: { hasFusionDir: hasFusionDir ? undefined : false } });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("already registered") ? 409 
        : err.message?.includes("Duplicate path") ? 409
        : 500;
      throw new ApiError(status, err.message);
    }
  });

  /**
   * POST /api/projects/detect
   * Auto-detect fn projects in a directory.
   * Body: { basePath?: string }
   * Returns: { projects: DetectedProject[] }
   */
  router.post("/projects/detect", async (req, res) => {
    try {
      const { basePath } = req.body;
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { readdir } = await import("node:fs/promises");
      
      // Default to home directory if no basePath provided
      const searchPath = basePath || process.env.HOME || process.env.USERPROFILE || ".";
      
      if (!existsSync(searchPath)) {
        throw badRequest("Base path does not exist");
      }

      // Get list of existing projects to check for duplicates
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      const existingProjects = await central.listProjects();
      await central.close();
      
      const existingPaths = new Set(existingProjects.map((p: { path: string }) => p.path));
      
      // Scan for .fusion/fusion.db or .fusion/fusion.db files (indicating fn projects)
      const detected: Array<{ path: string; suggestedName: string; existing: boolean }> = [];
      
      try {
        const entries = await readdir(searchPath, { withFileTypes: true });
        
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          
          const dirPath = join(searchPath, entry.name);
          const hasKbDb = existsSync(join(dirPath, ".fusion", "fusion.db"));
          const hasFusionDir = existsSync(join(dirPath, ".fusion"));
          
          if (hasKbDb || hasFusionDir) {
            detected.push({
              path: dirPath,
              suggestedName: entry.name,
              existing: existingPaths.has(dirPath),
            });
          }
        }
      } catch {
        // Ignore read errors
      }
      
      res.json({ projects: detected });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/:id
   * Get a single project by ID.
   */
  router.get("/projects/:id", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const project = await central.getProject(req.params.id);
      await central.close();
      
      if (!project) {
        throw notFound("Project not found");
      }
      
      res.json(project);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/projects/:id
   * Update a project.
   */
  router.patch("/projects/:id", async (req, res) => {
    try {
      const { name, status, isolationMode, nodeId } = req.body;
      
      const updates: Partial<import("@fusion/core").RegisteredProject> = {};
      if (name !== undefined) updates.name = name;
      if (status !== undefined) updates.status = status as import("@fusion/core").ProjectStatus;
      if (isolationMode !== undefined) updates.isolationMode = isolationMode as "in-process" | "child-process";
      
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const project = await central.updateProject(req.params.id, updates);
      if (!project) {
        await central.close();
        throw notFound("Project not found");
      }

      let resultProject = project;
      if (nodeId !== undefined) {
        if (nodeId === null) {
          resultProject = await central.unassignProjectFromNode(req.params.id);
        } else if (typeof nodeId === "string" && nodeId.trim()) {
          resultProject = await central.assignProjectToNode(req.params.id, nodeId.trim());
        } else {
          await central.close();
          throw badRequest("nodeId must be a non-empty string or null");
        }
      }

      await central.close();
      
      res.json(resultProject);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("not found") ? 404 : 500;
      throw new ApiError(status, err.message);
    }
  });

  /**
   * DELETE /api/projects/:id
   * Unregister a project.
   */
  router.delete("/projects/:id", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      await central.unregisterProject(req.params.id);
      await central.close();
      
      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("not found") ? 404 : 500;
      throw new ApiError(status, err.message);
    }
  });

  /**
   * GET /api/projects/:id/health
   * Get health metrics for a specific project.
   * Returns: ProjectHealth
   */
  router.get("/projects/:id/health", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const { realpath } = await import("node:fs/promises");
      const central = new CentralCore();
      await central.init();

      const project = await central.getProject(req.params.id);
      if (!project) {
        await central.close();
        throw notFound("Project not found");
      }

      const health = await central.getProjectHealth(req.params.id);
      await central.close();
      
      if (!health) {
        throw notFound("Project health not found");
      }

      // If this dashboard serves the requested project, compute live counts
      // from the task store instead of relying on cached central DB values.
      try {
        const storePath = await realpath(store.getRootDir());
        const projectPath = await realpath(project.path);

        if (storePath === projectPath) {
          const tasks = await store.listTasks();
          const activeCols = new Set(["triage", "todo", "in-progress", "in-review"]);
          const activeTaskCount = tasks.filter((t) => activeCols.has(t.column)).length;
          const inFlightAgentCount = tasks.filter((t) => t.column === "in-progress").length;
          const totalTasksCompleted = tasks.filter((t) => t.column === "done" || t.column === "archived").length;

          res.json({
            ...health,
            activeTaskCount,
            inFlightAgentCount,
            totalTasksCompleted,
          });
          return;
        }
      } catch {
        // realpath may fail if a path doesn't exist; fall through to cached data
      }

      res.json(health);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/:id/config
   * Get project-specific configuration.
   * Returns: { maxConcurrent: number, rootDir: string }
   */
  router.get("/projects/:id/config", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const project = await central.getProject(req.params.id);
      await central.close();
      
      if (!project) {
        throw notFound("Project not found");
      }
      
      res.json({
        maxConcurrent: 2,
        rootDir: project.path,
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/projects/:id/pause
   * Pause a project.
   */
  router.post("/projects/:id/pause", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const project = await central.updateProject(req.params.id, { status: "paused" });
      await central.updateProjectHealth(req.params.id, { status: "paused" });
      await central.close();
      
      res.json(project);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("not found") ? 404 : 500;
      throw new ApiError(status, err.message);
    }
  });

  /**
   * POST /api/projects/:id/resume
   * Resume a paused project.
   */
  router.post("/projects/:id/resume", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const project = await central.updateProject(req.params.id, { status: "active" });
      await central.updateProjectHealth(req.params.id, { status: "active" });
      await central.close();
      
      res.json(project);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("not found") ? 404 : 500;
      throw new ApiError(status, err.message);
    }
  });

  // ── Node Management Routes (Multi-Node Support) ───────────────────────────

  /**
   * GET /api/nodes
   * List all registered nodes.
   * Returns: NodeConfig[]
   */
  router.get("/nodes", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const nodes = await central.listNodes();
      await central.close();

      nodes.sort((a, b) => a.name.localeCompare(b.name));
      res.json(nodes);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes
   * Register a new node.
   * Body: { name, type, url?, apiKey?, maxConcurrent?, capabilities? }
   */
  router.post("/nodes", async (req, res) => {
    try {
      const { name, type, url, apiKey, maxConcurrent, capabilities } = req.body;

      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required and must be a non-empty string");
      }

      if (type !== "local" && type !== "remote") {
        throw badRequest("type must be 'local' or 'remote'");
      }

      if (type === "remote" && (!url || typeof url !== "string" || !url.trim())) {
        throw badRequest("url is required for remote nodes");
      }

      if (
        maxConcurrent !== undefined
        && (typeof maxConcurrent !== "number" || !Number.isFinite(maxConcurrent) || maxConcurrent < 1)
      ) {
        throw badRequest("maxConcurrent must be a number >= 1");
      }

      if (
        capabilities !== undefined
        && (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== "string"))
      ) {
        throw badRequest("capabilities must be an array of strings");
      }

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.registerNode({
        name: name.trim(),
        type,
        url: typeof url === "string" ? url.trim() : undefined,
        apiKey: typeof apiKey === "string" ? apiKey : undefined,
        maxConcurrent,
        capabilities,
      });

      await central.close();
      res.status(201).json(node);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("already exists") ? 409 : err.message?.includes("must") ? 400 : 500;
      throw new ApiError(status, err.message);
    }
  });

  /**
   * GET /api/nodes/:id
   * Get node details by ID.
   */
  router.get("/nodes/:id", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      await central.close();

      if (!node) {
        throw notFound("Node not found");
      }

      res.json(node);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/nodes/:id
   * Update node config.
   */
  router.patch("/nodes/:id", async (req, res) => {
    try {
      const { name, url, apiKey, maxConcurrent, status, capabilities } = req.body;

      const updates: Partial<Omit<import("@fusion/core").NodeConfig, "id" | "createdAt">> = {};
      if (name !== undefined) updates.name = name;
      if (url !== undefined) updates.url = url;
      if (apiKey !== undefined) updates.apiKey = apiKey;
      if (maxConcurrent !== undefined) updates.maxConcurrent = maxConcurrent;
      if (status !== undefined) updates.status = status as import("@fusion/core").NodeStatus;
      if (capabilities !== undefined) updates.capabilities = capabilities;

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.updateNode(req.params.id, updates);
      await central.close();

      res.json(node);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("not found") ? 404 : err.message?.includes("must") ? 400 : 500;
      throw new ApiError(status, err.message);
    }
  });

  /**
   * DELETE /api/nodes/:id
   * Unregister a node.
   */
  router.delete("/nodes/:id", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const existing = await central.getNode(req.params.id);
      if (!existing) {
        await central.close();
        throw notFound("Node not found");
      }

      await central.unregisterNode(req.params.id);
      await central.close();

      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes/:id/health-check
   * Trigger health check for a node.
   */
  router.post("/nodes/:id/health-check", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const healthStatus = await central.checkNodeHealth(req.params.id);
      await central.close();

      res.json({ status: healthStatus });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("not found") ? 404 : 500;
      throw new ApiError(status, err.message);
    }
  });

  /**
   * GET /api/nodes/:id/metrics
   * Get node runtime metrics.
   */
  router.get("/nodes/:id/metrics", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      await central.close();

      if (!node) {
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        res.json({
          status: "online",
          activeTasks: 0,
          maxConcurrent: node.maxConcurrent,
        });
        return;
      }

      throw new ApiError(501, "Remote node metrics not yet implemented");
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Node Discovery Routes (mDNS / DNS-SD) ────────────────────────────────

  /**
   * GET /api/discovery/status
   * Returns whether discovery is active and the current config.
   */
  router.get("/discovery/status", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const active = central.isDiscoveryActive();
      const config = central.getDiscoveryConfig();
      await central.close();

      res.json({ active, config });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/discovery/start
   * Body: { broadcast?: boolean, listen?: boolean, port?: number, serviceType?: string }
   */
  router.post("/discovery/start", async (req, res) => {
    try {
      const broadcast = req.body?.broadcast ?? true;
      const listen = req.body?.listen ?? true;
      const requestPort = req.body?.port;
      const serviceType = typeof req.body?.serviceType === "string" && req.body.serviceType.trim().length > 0
        ? req.body.serviceType.trim()
        : "_fusion._tcp";

      if (typeof broadcast !== "boolean") {
        throw badRequest("broadcast must be a boolean");
      }
      if (typeof listen !== "boolean") {
        throw badRequest("listen must be a boolean");
      }
      if (
        requestPort !== undefined
        && (typeof requestPort !== "number" || !Number.isFinite(requestPort) || requestPort < 1)
      ) {
        throw badRequest("port must be a number >= 1");
      }

      const localPort = typeof req.socket.localPort === "number" && req.socket.localPort > 0
        ? req.socket.localPort
        : 4040;
      const port = requestPort ?? localPort;

      const config: import("@fusion/core").DiscoveryConfig = {
        broadcast,
        listen,
        serviceType,
        port,
        staleTimeoutMs: 300_000,
      };

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      await central.startDiscovery(config);
      await central.close();

      res.json({ success: true, config });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/discovery/stop
   * Stops active mDNS discovery.
   */
  router.post("/discovery/stop", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      central.stopDiscovery();
      await central.close();

      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/discovery/nodes
   * List currently discovered nodes.
   */
  router.get("/discovery/nodes", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const nodes = central.getDiscoveredNodes();
      await central.close();

      res.json(nodes);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/discovery/connect
   * Register a discovered node in the node registry.
   * Body: { name: string, host: string, port: number, apiKey?: string }
   */
  router.post("/discovery/connect", async (req, res) => {
    try {
      const { name, host, port, apiKey } = req.body as {
        name?: unknown;
        host?: unknown;
        port?: unknown;
        apiKey?: unknown;
      };

      if (typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required and must be a non-empty string");
      }
      if (typeof host !== "string" || !host.trim()) {
        throw badRequest("host is required and must be a non-empty string");
      }
      if (typeof port !== "number" || !Number.isFinite(port) || port < 1) {
        throw badRequest("port is required and must be a number >= 1");
      }
      if (apiKey !== undefined && typeof apiKey !== "string") {
        throw badRequest("apiKey must be a string");
      }

      let normalizedHost = host.trim();
      try {
        const url = new URL(normalizedHost);
        normalizedHost = url.hostname;
      } catch {
        normalizedHost = normalizedHost.replace(/^https?:\/\//, "");
      }
      normalizedHost = normalizedHost.split("/")[0] ?? normalizedHost;

      const normalizedUrl = `http://${normalizedHost}:${port}`;

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.registerNode({
        name: name.trim(),
        type: "remote",
        url: normalizedUrl,
        apiKey: typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined,
      });

      try {
        await central.checkNodeHealth(node.id);
      } catch {
        // Best effort only; registration itself succeeded.
      }

      await central.close();
      res.json(node);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = err.message?.includes("already exists") ? 409 : err.message?.includes("must") ? 400 : 500;
      throw new ApiError(status, err.message);
    }
  });

  /**
   * GET /api/activity-feed
   * Get unified activity feed across all projects.
   * Query: limit, projectId, types
   * Returns: ActivityFeedEntry[]
   */
  router.get("/activity-feed", async (req, res) => {
    try {
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      const typesParam = typeof req.query.types === "string" ? req.query.types.split(",") : undefined;
      const types = typesParam as import("@fusion/core").ActivityEventType[] | undefined;
      
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const entries = await central.getRecentActivity({ limit, projectId, types });
      await central.close();
      
      res.json(entries);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/global-concurrency
   * Get global concurrency state across all projects.
   * Returns: GlobalConcurrencyState
   */
  router.get("/global-concurrency", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const state = await central.getGlobalConcurrencyState();
      await central.close();
      
      res.json(state);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/first-run-status
   * Check if user has projects or needs setup wizard.
   * Returns: { hasProjects: boolean, singleProjectPath: string | null }
   */
  router.get("/first-run-status", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const projects = await central.listProjects();
      await central.close();
      
      const hasProjects = projects.length > 0;
      const singleProjectPath = projects.length === 1 ? projects[0].path : null;
      
      res.json({ hasProjects, singleProjectPath });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/setup-state
   * Returns the first-run state and any detected projects for migration.
   * This is used by the dashboard to determine what UI to show on startup.
   */
  router.get("/setup-state", async (_req, res) => {
    try {
      const { FirstRunDetector } = await import("@fusion/core");
      const { CentralCore } = await import("@fusion/core");

      const detector = new FirstRunDetector();
      const state = await detector.detectFirstRunState();
      const detectedProjects = await detector.detectExistingProjects(process.cwd());

      // Get central DB info
      const central = new CentralCore();
      await central.init();
      const projects = await central.listProjects();
      await central.close();

      res.json({
        state,
        detectedProjects,
        hasCentralDb: detector.hasCentralDb(),
        registeredProjects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
        })),
      });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/complete-setup
   * Complete the first-run setup by registering projects.
   * Body: { projects: Array<{ path: string, name: string, isolationMode?: "in-process" | "child-process" }> }
   */
  router.post("/complete-setup", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const { MigrationCoordinator } = await import("@fusion/core");

      const { projects } = req.body as {
        projects: Array<{ path: string; name: string; isolationMode?: "in-process" | "child-process" }>;
      };

      if (!Array.isArray(projects)) {
        throw badRequest("projects must be an array");
      }

      const central = new CentralCore();
      await central.init();

      try {
        const coordinator = new MigrationCoordinator(central);
        const result = await coordinator.completeSetup(projects);

        res.json({
          success: result.success,
          projectsRegistered: result.projectsRegistered,
          errors: result.errors,
        });
      } finally {
        await central.close();
      }
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/tasks/:id/diff
   * Fetch git diff for a task's changes.
   * Query: ?worktree=path
   * Returns: TaskDiff
   */
  router.get("/tasks/:id/diff", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        throw notFound("Task not found");
      }

      // Done tasks: diff from the squash commit's first parent.
      // The merger only performs squash merges, so sha^..sha contains exactly
      // this task's merged changes and excludes unrelated tasks merged in between.
      if (task.column === "done" && task.mergeDetails?.commitSha) {
        const rootDir = scopedStore.getRootDir();
        const sha = task.mergeDetails.commitSha;

        let mergeBase: string | undefined;

        try {
          mergeBase = nodeChildProcess.execSync(
            `git rev-parse ${sha}^`,
            { cwd: rootDir, encoding: "utf-8", timeout: 5000 },
          ).trim();
        } catch {
          // Last resort: no diff available
          res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
          return;
        }

        const nameStatus = nodeChildProcess.execSync(
          `git diff --name-status ${mergeBase}..${sha}`,
          { cwd: rootDir, encoding: "utf-8", timeout: 10000 },
        ).trim();

        const doneFiles: Array<{
          path: string;
          status: "added" | "modified" | "deleted";
          additions: number;
          deletions: number;
          patch: string;
        }> = [];

        for (const line of nameStatus.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const statusCode = parts[0] ?? "M";
          const filePath = parts[1] ?? "";
          if (!filePath) continue;

          let status: "added" | "modified" | "deleted" = "modified";
          if (statusCode.startsWith("A")) status = "added";
          else if (statusCode.startsWith("D")) status = "deleted";

          let patch = "";
          try {
            patch = nodeChildProcess.execSync(
              `git diff ${mergeBase}..${sha} -- "${filePath}"`,
              { cwd: rootDir, encoding: "utf-8", timeout: 10000 },
            );
          } catch { /* ignore */ }

          const additions = (patch.match(/^\+[^+]/gm) || []).length;
          const deletions = (patch.match(/^-[^-]/gm) || []).length;
          doneFiles.push({ path: filePath, status, additions, deletions, patch });
        }

        const doneStats = {
          filesChanged: doneFiles.length,
          additions: doneFiles.reduce((s, f) => s + f.additions, 0),
          deletions: doneFiles.reduce((s, f) => s + f.deletions, 0),
        };

        res.json({ files: doneFiles, stats: doneStats });
        return;
      }

      // Done tasks without a commit SHA: return safe, deterministic response.
      // Do NOT fall through to the worktree-based diff logic, which would use
      // the repo root as cwd and return an inflated repository-wide diff.
      if (task.column === "done") {
        const md = task.mergeDetails;
        res.json({
          files: [],
          stats: {
            filesChanged: md?.filesChanged ?? 0,
            additions: md?.insertions ?? 0,
            deletions: md?.deletions ?? 0,
          },
        });
        return;
      }

      const worktree = typeof req.query.worktree === "string" ? req.query.worktree : undefined;
      const cwd = worktree || task.worktree || scopedStore.getRootDir();

      // Use resolveDiffBase for consistent diff base across all endpoints
      const diffBase = resolveDiffBase(task, cwd);
      const diffRange = diffBase ? `${diffBase}..HEAD` : "HEAD";

      // Get list of changed files — include both committed and working-tree changes
      const fileMap = new Map<string, string>();

      if (diffBase) {
        try {
          const committedOutput = nodeChildProcess.execSync(
            `git diff --name-status ${diffBase}..HEAD`,
            { encoding: "utf-8", cwd, timeout: 10000 },
          ).trim();
          for (const line of committedOutput.split("\n").filter(Boolean)) {
            const parts = line.split("\t");
            fileMap.set(parts[1] ?? "", parts[0] ?? "M");
          }
        } catch {
          // committed diff failed
        }
      }

      try {
        const workingTreeOutput = nodeChildProcess.execSync("git diff --name-status", {
          encoding: "utf-8", cwd, timeout: 10000,
        }).trim();
        for (const line of workingTreeOutput.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          fileMap.set(parts[1] ?? "", parts[0] ?? "M");
        }
      } catch {
        // working tree diff failed
      }

      const files: Array<{
        path: string;
        status: "added" | "modified" | "deleted";
        additions: number;
        deletions: number;
        patch: string;
      }> = [];

      for (const [filePath, statusCode] of fileMap) {
        if (!filePath) continue;

        let status: "added" | "modified" | "deleted";
        if (statusCode.startsWith("A")) status = "added";
        else if (statusCode.startsWith("D")) status = "deleted";
        else status = "modified";

        // Get patch for this file
        let patch = "";
        try {
          patch = nodeChildProcess.execSync(`git diff ${diffRange} -- "${filePath}"`, {
            encoding: "utf-8",
            cwd,
            timeout: 10000,
          });
        } catch {
          // Ignore errors for individual files
        }

        // Count additions/deletions
        const additions = (patch.match(/^\+[^+]/gm) || []).length;
        const deletions = (patch.match(/^-[^-]/gm) || []).length;

        files.push({ path: filePath, status, additions, deletions, patch });
      }

      const stats = {
        filesChanged: files.length,
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      };

      res.json({ files, stats });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/tasks/:id/file-diffs
   * Fetch changed files with individual git diffs for a task worktree.
   * Uses the shared resolveDiffBase() helper so the board card count and the
   * changed-files viewer always agree. Prefers task.baseCommitSha when valid,
   * falling back to branch merge-base / HEAD~1.
   * Returns: Array<{ path, status, diff, oldPath? }>
   */
  router.get("/tasks/:id/file-diffs", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);

      // Done tasks: diff from the squash commit's first parent.
      // The merger only performs squash merges, so sha^..sha contains exactly
      // this task's merged changes and excludes unrelated tasks merged in between.
      if (task.column === "done" && task.mergeDetails?.commitSha) {
        const rootDir = scopedStore.getRootDir();
        const sha = task.mergeDetails.commitSha;

        let mergeBase: string | undefined;

        try {
          mergeBase = nodeChildProcess.execSync(
            `git rev-parse ${sha}^`,
            { cwd: rootDir, encoding: "utf-8", timeout: 5000 },
          ).trim();
        } catch {
          res.json([]);
          return;
        }

        try {
          const nameStatus = nodeChildProcess.execSync(
            `git diff --name-status ${mergeBase}..${sha}`,
            { cwd: rootDir, encoding: "utf-8", timeout: 5000 },
          ).trim();
          const doneFiles = nameStatus.split("\n").filter(Boolean).map((line) => {
            const parts = line.split("\t");
            const statusCode = parts[0] ?? "M";
            const filePath = parts[1] ?? "";
            let status: "added" | "modified" | "deleted" | "renamed" = "modified";
            if (statusCode.startsWith("A")) status = "added";
            else if (statusCode.startsWith("D")) status = "deleted";
            else if (statusCode.startsWith("R")) status = "renamed";
            let diff = "";
            try {
              diff = nodeChildProcess.execSync(
                `git diff ${mergeBase}..${sha} -- "${filePath}"`,
                { cwd: rootDir, encoding: "utf-8", timeout: 5000 },
              );
            } catch { /* ignore */ }
            return { path: filePath, status, diff };
          });
          res.json(doneFiles);
        } catch {
          res.json([]);
        }
        return;
      }

      // Done tasks without a commit SHA: return safe, empty response.
      // Do NOT fall through to worktree-based logic that could scan the
      // entire repository when the worktree has been cleaned up.
      if (task.column === "done") {
        res.json([]);
        return;
      }

      if (!task.worktree || !nodeFs.existsSync(task.worktree)) {
        res.json([]);
        return;
      }

      const cached = fileDiffsCache.get(task.id);
      if (cached && cached.expiresAt > Date.now()) {
        res.json(cached.files);
        return;
      }

      const cwd = task.worktree;

      // Resolve a diff base using the shared strategy so both endpoints
      // always agree on which files have changed.  Prefer task-scoped
      // baseCommitSha when it is still valid for the current HEAD.
      const diffBase = resolveDiffBase(task, cwd);

      // Collect file statuses from both committed changes (against diffBase)
      // and working-tree changes, deduplicating by path to match session-files.
      const fileMap = new Map<string, { statusCode: string; oldPath?: string }>();

      if (diffBase) {
        try {
          const committedOutput = nodeChildProcess.execSync(
            `git diff --name-status ${diffBase}..HEAD`,
            { cwd, encoding: "utf-8", timeout: 5000 },
          ).trim();
          for (const line of committedOutput.split("\n").filter(Boolean)) {
            const parts = line.split("\t");
            const statusCode = parts[0] ?? "M";
            if (statusCode.startsWith("R")) {
              fileMap.set(parts[2] ?? parts[1] ?? "", { statusCode, oldPath: parts[1] });
            } else {
              fileMap.set(parts[1] ?? "", { statusCode });
            }
          }
        } catch {
          // committed diff failed — continue with working-tree only
        }
      }

      try {
        const workingTreeOutput = nodeChildProcess.execSync("git diff --name-status", {
          cwd,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        for (const line of workingTreeOutput.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const statusCode = parts[0] ?? "M";
          if (statusCode.startsWith("R")) {
            fileMap.set(parts[2] ?? parts[1] ?? "", { statusCode, oldPath: parts[1] });
          } else {
            fileMap.set(parts[1] ?? "", { statusCode });
          }
        }
      } catch {
        // working tree diff failed — continue with committed only
      }

      // Build the result array with per-file diffs using the two-dot range
      // against the resolved merge-base.
      const diffRange = diffBase ? `${diffBase}..HEAD` : "HEAD";

      const files = Array.from(fileMap.entries()).flatMap(([filePath, { statusCode, oldPath }]) => {
        let status: "added" | "modified" | "deleted" | "renamed" = "modified";

        if (statusCode.startsWith("A")) {
          status = "added";
        } else if (statusCode.startsWith("D")) {
          status = "deleted";
        } else if (statusCode.startsWith("R")) {
          status = "renamed";
        }

        let diff = "";
        try {
          diff = nodeChildProcess.execSync(`git diff ${diffRange} -- "${filePath}"`, {
            cwd,
            encoding: "utf-8",
            timeout: 5000,
          });
        } catch {
          diff = "";
        }

        // Filter out files with empty diffs (mode-only changes, binary files, etc.)
        if (!diff) {
          return [];
        }

        return oldPath ? [{ path: filePath, status, diff, oldPath }] : [{ path: filePath, status, diff }];
      });

      fileDiffsCache.set(task.id, {
        files,
        expiresAt: Date.now() + 10000,
      });

      res.json(files);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // ── Scripts API ──────────────────────────────────────────────────────────

  /**
   * GET /api/scripts
   * Fetch all saved scripts.
   * Returns: Record<string, string> (name -> command)
   */
  router.get("/scripts", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const settings = await scopedStore.getSettings();
      res.json(settings.scripts ?? {});
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/scripts
   * Add or update a script.
   * Body: { name: string, command: string }
   * Returns: Record<string, string> (updated scripts)
   */
  router.post("/scripts", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { name, command } = req.body;
      
      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required");
      }
      if (command === undefined || typeof command !== "string") {
        throw badRequest("command is required");
      }
      
      const settings = await scopedStore.getSettings();
      const scripts = {
        ...(settings.scripts ?? {}),
        [name.trim()]: command.trim(),
      };
      await scopedStore.updateSettings({ scripts });
      res.json(scripts);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/scripts/:name
   * Remove a script.
   * Returns: Record<string, string> (updated scripts)
   */
  router.delete("/scripts/:name", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { name } = req.params;
      const settings = await scopedStore.getSettings();
      const scripts = { ...(settings.scripts ?? {}) };
      delete scripts[name];
      await scopedStore.updateSettings({ scripts });
      res.json(scripts);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Messaging Routes ──────────────────────────────────────────────────

  /** Cache of MessageStore instances keyed by rootDir */
  const messageStoreCache = new Map<string, MessageStore>();

  async function getMessageStore(req: Request): Promise<MessageStore> {
    const scopedStore = await getScopedStore(req);
    const rootDir = scopedStore.getRootDir();
    let msgStore = messageStoreCache.get(rootDir);
    if (!msgStore) {
      msgStore = new MessageStore({ rootDir: join(rootDir, ".fusion") });
      await msgStore.init();
      messageStoreCache.set(rootDir, msgStore);
    }
    return msgStore;
  }

  const VALID_MESSAGE_TYPES: MessageType[] = ["agent-to-agent", "agent-to-user", "user-to-agent", "system"];
  const VALID_PARTICIPANT_TYPES: ParticipantType[] = ["agent", "user", "system"];
  const DASHBOARD_USER_ID = "dashboard";

  /**
   * GET /api/messages/inbox
   * Fetch inbox messages for the dashboard user.
   * Query params: limit, offset, unreadOnly, type
   */
  router.get("/messages/inbox", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const filter = {
        limit: parseInt(req.query.limit as string) || 20,
        offset: parseInt(req.query.offset as string) || 0,
        read: req.query.unreadOnly === "true" ? false : undefined,
        type: req.query.type as MessageType | undefined,
      };
      const messages = await msgStore.getInbox(DASHBOARD_USER_ID, "user", filter);
      const mailbox = await msgStore.getMailbox(DASHBOARD_USER_ID, "user");
      res.json({ messages, total: messages.length, unreadCount: mailbox.unreadCount });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/messages/outbox
   * Fetch sent messages for the dashboard user.
   * Query params: limit, offset, type
   */
  router.get("/messages/outbox", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const filter = {
        limit: parseInt(req.query.limit as string) || 20,
        offset: parseInt(req.query.offset as string) || 0,
        type: req.query.type as MessageType | undefined,
      };
      const messages = await msgStore.getOutbox(DASHBOARD_USER_ID, "user", filter);
      res.json({ messages, total: messages.length });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/messages/unread-count
   * Get unread message count (lightweight for header badge).
   */
  router.get("/messages/unread-count", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const mailbox = await msgStore.getMailbox(DASHBOARD_USER_ID, "user");
      res.json({ unreadCount: mailbox.unreadCount });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/messages/read-all
   * Mark all inbox messages as read.
   * IMPORTANT: Must be registered before /messages/:id to avoid path conflicts.
   */
  router.post("/messages/read-all", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const count = await msgStore.markAllAsRead(DASHBOARD_USER_ID, "user");
      res.json({ markedAsRead: count });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/messages
   * Send a new message.
   * Body: { toId, toType, content, type, metadata? }
   */
  router.post("/messages", async (req, res) => {
    try {
      const { toId, toType, content, type, metadata } = req.body;

      // Validate required fields
      if (!toId || typeof toId !== "string") {
        throw badRequest("toId is required");
      }
      if (!toType || !VALID_PARTICIPANT_TYPES.includes(toType)) {
        throw badRequest(`toType must be one of: ${VALID_PARTICIPANT_TYPES.join(", ")}`);
      }
      if (!content || typeof content !== "string" || content.length === 0 || content.length > 2000) {
        throw badRequest("content is required and must be 1-2000 characters");
      }
      if (!type || !VALID_MESSAGE_TYPES.includes(type)) {
        throw badRequest(`type must be one of: ${VALID_MESSAGE_TYPES.join(", ")}`);
      }

      const msgStore = await getMessageStore(req);
      const message = await msgStore.sendMessage({
        fromId: DASHBOARD_USER_ID,
        fromType: "user",
        toId,
        toType,
        content,
        type,
        metadata,
      });
      res.status(201).json(message);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/messages/conversation/:participantType/:participantId
   * Get conversation between dashboard user and a specific participant.
   */
  router.get("/messages/conversation/:participantType/:participantId", async (req, res) => {
    try {
      const { participantType, participantId } = req.params;
      if (!VALID_PARTICIPANT_TYPES.includes(participantType as ParticipantType)) {
        throw badRequest(`participantType must be one of: ${VALID_PARTICIPANT_TYPES.join(", ")}`);
      }

      const msgStore = await getMessageStore(req);
      const messages = await msgStore.getConversation(
        { id: DASHBOARD_USER_ID, type: "user" },
        { id: participantId, type: participantType as ParticipantType },
      );
      res.json(messages);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/messages/:id
   * Fetch a single message.
   */
  router.get("/messages/:id", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const message = await msgStore.getMessage(req.params.id);
      if (!message) {
        throw notFound("Message not found");
      }
      res.json(message);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/messages/:id/read
   * Mark a specific message as read.
   */
  router.post("/messages/:id/read", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const message = await msgStore.markAsRead(req.params.id);
      res.json(message);
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message.includes("not found")) {
        throw notFound(err.message);
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/messages/:id
   * Delete a message.
   */
  router.delete("/messages/:id", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      await msgStore.deleteMessage(req.params.id);
      res.status(204).send();
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.message.includes("not found")) {
        throw notFound(err.message);
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/mailbox
   * View an agent's mailbox (admin read-only access).
   */
  router.get("/agents/:id/mailbox", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const agentId = req.params.id;
      const mailbox = await msgStore.getMailbox(agentId, "agent");
      const inbox = await msgStore.getInbox(agentId, "agent");
      res.json({ ...mailbox, messages: inbox });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof ApiError) {
      sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
      return;
    }

    if (err instanceof Error) {
      sendErrorResponse(res, 500, err.message);
      return;
    }

    sendErrorResponse(res, 500, "Internal server error");
  });

  return router;
}

// ── Automation step helpers ─────────────────────────────────────────

/**
 * Validate an array of automation steps.
 * Returns an error string if invalid, or null if valid.
 */
function validateAutomationSteps(steps: unknown[]): string | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as Record<string, unknown>;
    if (!step.id || typeof step.id !== "string") {
      return `Step ${i + 1}: id is required`;
    }
    if (!step.type || (step.type !== "command" && step.type !== "ai-prompt")) {
      return `Step ${i + 1}: type must be "command" or "ai-prompt"`;
    }
    if (!step.name || typeof step.name !== "string" || !step.name.trim()) {
      return `Step ${i + 1}: name is required`;
    }
    if (step.type === "command") {
      if (!step.command || typeof step.command !== "string" || !step.command.trim()) {
        return `Step ${i + 1}: command is required for command steps`;
      }
    }
    if (step.type === "ai-prompt") {
      if (!step.prompt || typeof step.prompt !== "string" || !step.prompt.trim()) {
        return `Step ${i + 1}: prompt is required for ai-prompt steps`;
      }
    }
    // Validate model fields are both present or both absent
    const hasProvider = step.modelProvider && typeof step.modelProvider === "string";
    const hasModelId = step.modelId && typeof step.modelId === "string";
    if ((hasProvider && !hasModelId) || (!hasProvider && hasModelId)) {
      return `Step ${i + 1}: modelProvider and modelId must both be present or both absent`;
    }
  }
  return null;
}

/**
 * Execute a single shell command (used by manual run endpoint).
 */
async function executeSingleCommand(
  command: string,
  timeoutMs: number | undefined,
  startedAt: string,
): Promise<import("@fusion/core").AutomationRunResult> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsyncFn = promisify(exec);
  const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
  const MAX_BUFFER = 1024 * 1024;
  const MAX_OUTPUT = 10240;

  try {
    const { stdout, stderr } = await execAsyncFn(command, {
      timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      shell: "/bin/sh",
    });

    let output = stdout;
    if (stderr) {
      output += stdout ? "\n--- stderr ---\n" : "";
      output += stderr;
    }
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n[output truncated]";
    }

    return { success: true, output, startedAt, completedAt: new Date().toISOString() };
  } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
    const stdout = err.stdout ?? "";
    const stderr = err.stderr ?? "";
    let output = stdout;
    if (stderr) {
      output += stdout ? "\n--- stderr ---\n" : "";
      output += stderr;
    }
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n[output truncated]";
    }

    return {
      success: false,
      output,
      error: err.killed
        ? `Command timed out after ${(timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`
        : err.message ?? String(err),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

/**
 * Execute all steps in a multi-step schedule (used by manual run endpoint).
 */
async function executeScheduleSteps(
  schedule: import("@fusion/core").ScheduledTask,
  startedAt: string,
): Promise<import("@fusion/core").AutomationRunResult> {
  const steps = schedule.steps!;
  const stepResults: import("@fusion/core").AutomationStepResult[] = [];
  let overallSuccess = true;
  let stoppedEarly = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStartedAt = new Date().toISOString();
    const timeoutMs = step.timeoutMs ?? schedule.timeoutMs ?? 300000;

    let stepResult: import("@fusion/core").AutomationStepResult;

    if (step.type === "command") {
      const cmdResult = await executeSingleCommand(step.command ?? "", timeoutMs, stepStartedAt);
      stepResult = {
        stepId: step.id,
        stepName: step.name,
        stepIndex: i,
        success: cmdResult.success,
        output: cmdResult.output,
        error: cmdResult.error,
        startedAt: stepStartedAt,
        completedAt: cmdResult.completedAt,
      };
    } else if (step.type === "ai-prompt") {
      // AI prompt steps return a placeholder in manual run mode
      const model = step.modelProvider && step.modelId
        ? `${step.modelProvider}/${step.modelId}`
        : "default";
      stepResult = {
        stepId: step.id,
        stepName: step.name,
        stepIndex: i,
        success: !!step.prompt?.trim(),
        output: step.prompt?.trim()
          ? `[AI prompt step — model: ${model}]\nPrompt: ${step.prompt}`
          : "",
        error: step.prompt?.trim() ? undefined : "AI prompt step has no prompt specified",
        startedAt: stepStartedAt,
        completedAt: new Date().toISOString(),
      };
    } else {
      stepResult = {
        stepId: step.id,
        stepName: step.name,
        stepIndex: i,
        success: false,
        output: "",
        error: `Unknown step type: "${step.type}"`,
        startedAt: stepStartedAt,
        completedAt: new Date().toISOString(),
      };
    }

    stepResults.push(stepResult);

    if (!stepResult.success) {
      overallSuccess = false;
      if (!step.continueOnFailure) {
        stoppedEarly = true;
        break;
      }
    }
  }

  // Aggregate output
  const outputParts: string[] = [];
  for (const sr of stepResults) {
    outputParts.push(`=== Step ${sr.stepIndex + 1}: ${sr.stepName} (${sr.success ? "success" : "FAILED"}) ===`);
    if (sr.output) outputParts.push(sr.output);
    if (sr.error) outputParts.push(`Error: ${sr.error}`);
  }
  let output = outputParts.join("\n");
  if (output.length > 10240) {
    output = output.slice(0, 10240) + "\n[output truncated]";
  }

  const failedSteps = stepResults.filter((sr) => !sr.success);
  const error = failedSteps.length > 0
    ? `${failedSteps.length} step(s) failed: ${failedSteps.map((s) => s.stepName).join(", ")}${stoppedEarly ? " (execution stopped)" : ""}`
    : undefined;

  return {
    success: overallSuccess,
    output,
    error,
    startedAt,
    completedAt: new Date().toISOString(),
    stepResults,
  };
}

function getDefaultGitHubRepo(store: TaskStore): { owner: string; repo: string } | null {
  const envRepo = process.env.GITHUB_REPOSITORY;
  if (envRepo) {
    const [owner, repo] = envRepo.split("/");
    if (owner && repo) {
      return { owner, repo };
    }
  }

  const rootDir = typeof store.getRootDir === "function" ? store.getRootDir() : process.cwd();
  return getCurrentGitHubRepo(rootDir);
}

function isBatchStatusStale(info: { lastCheckedAt?: string } | undefined, updatedAt?: string): boolean {
  const lastChecked = info?.lastCheckedAt ?? updatedAt;
  if (!lastChecked) return true;
  return Date.now() - new Date(lastChecked).getTime() > 5 * 60 * 1000;
}

function ensureBatchStatusEntry(results: BatchStatusResult, taskId: string): BatchStatusEntry {
  results[taskId] ??= { stale: true };
  return results[taskId];
}

function appendBatchStatusError(results: BatchStatusResult, taskId: string, message: string): void {
  const entry = ensureBatchStatusEntry(results, taskId);
  entry.error = entry.error ? `${entry.error}; ${message}` : message;
  entry.stale = true;
}

/**
 * Background PR refresh - updates PR status without blocking the response.
 * Silently logs errors without affecting the user experience.
 * Prefers badge URL for repo resolution to support multi-repo setups.
 */
async function refreshPrInBackground(store: TaskStore, taskId: string, currentPrInfo: PrInfo, token?: string): Promise<void> {
  try {
    // Get owner/repo from badge URL first, then fall back to env/git
    let owner: string;
    let repo: string;

    const badgeParsed = parseBadgeUrl(currentPrInfo.url);
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
        const gitRepo = getCurrentGitHubRepo(store.getRootDir());
        if (!gitRepo) return; // Silent fail - can't determine repo
        owner = gitRepo.owner;
        repo = gitRepo.repo;
      }
    }

    const repoKey = `${owner}/${repo}`;
    if (!githubRateLimiter.canMakeRequest(repoKey)) {
      return;
    }

    const client = new GitHubClient(token);

    const prInfo = await client.getPrStatus(owner, repo, currentPrInfo.number);
    prInfo.lastCheckedAt = new Date().toISOString();
    await store.updatePrInfo(taskId, prInfo);
  } catch {
    // Silent fail - background refresh is best-effort
  }
}

async function refreshIssueInBackground(
  store: TaskStore,
  taskId: string,
  currentIssueInfo: import("@fusion/core").IssueInfo,
  token?: string,
): Promise<void> {
  try {
    let owner: string;
    let repo: string;

    // Get owner/repo from badge URL first, then fall back to env/git
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
        const gitRepo = getCurrentGitHubRepo(store.getRootDir());
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
    // Silent fail - background refresh is best-effort
  }
}

/**
 * Register the GET /api/models route.
 * Returns available AI models from the ModelRegistry for the UI model selector,
 * along with favoriteProviders for UI ordering.
 * If no ModelRegistry is provided, returns an empty array.
 */
function registerModelsRoute(router: Router, modelRegistry?: ModelRegistryLike, store?: TaskStore): void {
  router.get("/models", async (_req, res) => {
    // Always return 200 with empty array instead of 404 when no models available.
    // This ensures the frontend can handle empty states gracefully.
    if (!modelRegistry) {
      res.json({ models: [], favoriteProviders: [], favoriteModels: [] });
      return;
    }

    try {
      modelRegistry.refresh();
      const models = modelRegistry.getAvailable().map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
      }));

      // Get favoriteProviders and favoriteModels from global settings
      let favoriteProviders: string[] = [];
      let favoriteModels: string[] = [];
      if (store) {
        try {
          const globalStore = store.getGlobalSettingsStore();
          const globalSettings = await globalStore.getSettings();
          favoriteProviders = globalSettings.favoriteProviders ?? [];
          favoriteModels = globalSettings.favoriteModels ?? [];
        } catch {
          // Silently ignore settings errors - just return empty favorites
        }
      }

      res.json({ models, favoriteProviders, favoriteModels });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[models] Failed to load models: ${message}`);
      res.json({ models: [], favoriteProviders: [], favoriteModels: [] });
    }
  });
}

/**
 * Register authentication status, login, and logout routes.
 * Uses pi-coding-agent's AuthStorage for credential management.
 * If no AuthStorage is provided, creates one internally (reads from ~/.pi/agent/auth.json).
 */
function registerAuthRoutes(router: Router, authStorage?: AuthStorageLike): void {
  // Use injected AuthStorage or fail gracefully if not provided.
  // When running via the CLI/engine, AuthStorage is passed in via ServerOptions.
  function getAuthStorage(): AuthStorageLike {
    if (!authStorage) {
      throw new Error("Authentication is not configured");
    }
    return authStorage;
  }

  /**
   * Track in-progress login flows to prevent concurrent logins for the same provider.
   * Maps provider ID → AbortController for the active login.
   */
  const loginInProgress = new Map<string, AbortController>();

  /**
   * GET /api/auth/status
   * Returns list of all providers with their authentication status and type.
   * Includes both OAuth-backed and API-key-backed providers.
   * Response: { providers: [{ id, name, authenticated, type }] }
   */
  router.get("/auth/status", (_req, res) => {
    try {
      const storage = getAuthStorage();
      storage.reload();
      const oauthProviders = storage.getOAuthProviders();
      const providers: { id: string; name: string; authenticated: boolean; type: "oauth" | "api_key" }[] = oauthProviders.map((p) => ({
        id: p.id,
        name: p.name,
        authenticated: storage.hasAuth(p.id),
        type: "oauth" as const,
      }));

      // Include API-key-backed providers if supported
      if (storage.getApiKeyProviders) {
        const apiKeyProviders = storage.getApiKeyProviders();
        for (const p of apiKeyProviders) {
          // Skip if already listed as an OAuth provider (avoid duplicates)
          if (providers.some((existing) => existing.id === p.id)) continue;
          providers.push({
            id: p.id,
            name: p.name,
            authenticated: storage.hasApiKey ? storage.hasApiKey(p.id) : false,
            type: "api_key" as const,
          });
        }
      }

      res.json({ providers });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/auth/login
   * Initiates OAuth login for a provider.
   * Body: { provider: string }
   * Response: { url: string, instructions?: string }
   *
   * The endpoint starts the OAuth flow and returns the auth URL from the
   * onAuth callback. The client should open this URL in a new tab and
   * poll GET /api/auth/status to detect completion.
   */
  router.post("/auth/login", async (req, res) => {
    try {
      const { provider } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }

      // Prevent concurrent logins for the same provider
      if (loginInProgress.has(provider)) {
        throw conflict(`Login already in progress for ${provider}`);
      }

      const storage = getAuthStorage();
      const oauthProviders = storage.getOAuthProviders();
      const found = oauthProviders.find((p) => p.id === provider);
      if (!found) {
        throw badRequest(`Unknown provider: ${provider}`);
      }

      const abortController = new AbortController();
      loginInProgress.set(provider, abortController);

      // We need to get the URL from the onAuth callback before responding.
      // The login() call continues in the background until the user completes OAuth.
      let authResolve: (info: { url: string; instructions?: string }) => void;
      let authReject: (err: Error) => void;
      const authUrlPromise = new Promise<{ url: string; instructions?: string }>((resolve, reject) => {
        authResolve = resolve;
        authReject = reject;
      });

      // Start login flow in background — don't await the full login
      const loginPromise = storage.login(provider, {
        onAuth: (info) => {
          authResolve({ url: info.url, instructions: info.instructions });
        },
        onPrompt: async (prompt) => {
          // Web UI cannot interactively prompt — return empty string if allowed
          if (prompt.allowEmpty) return "";
          return prompt.placeholder || "";
        },
        onProgress: () => {}, // no-op for web UI
        signal: abortController.signal,
      });

      // Race: either we get the auth URL or the login completes/fails first
      const timeout = setTimeout(() => {
        authReject(new Error("Login initiation timed out"));
      }, 30_000);

      loginPromise
        .then(() => {
          // Login completed (user finished OAuth in browser)
        })
        .catch((err) => {
          // Login failed — also reject auth URL if not yet received
          authReject(err);
        })
        .finally(() => {
          clearTimeout(timeout);
          loginInProgress.delete(provider);
        });

      const authInfo = await authUrlPromise;
      clearTimeout(timeout);
      res.json({ url: authInfo.url, instructions: authInfo.instructions });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      // Clean up on error
      const provider = req.body?.provider;
      if (provider) loginInProgress.delete(provider);
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/auth/logout
   * Removes credentials for a provider.
   * Body: { provider: string }
   * Response: { success: true }
   */
  router.post("/auth/logout", (req, res) => {
    try {
      const { provider } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }

      const storage = getAuthStorage();
      storage.logout(provider);
      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/auth/api-key
   * Save an API key for an API-key-backed provider.
   * Body: { provider: string, apiKey: string }
   * Response: { success: true }
   *
   * Validates the provider exists, is API-key-backed, and the key is non-empty.
   * Never returns the key in any response.
   */
  router.post("/auth/api-key", (req, res) => {
    try {
      const { provider, apiKey } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }
      if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
        throw badRequest("apiKey is required and must be a non-empty string");
      }

      const storage = getAuthStorage();

      // Check that the storage supports API key management
      if (!storage.setApiKey) {
        throw badRequest("API key management is not supported");
      }

      // Validate the provider is an API-key-backed provider
      const apiKeyProviders = storage.getApiKeyProviders?.() ?? [];
      const found = apiKeyProviders.find((p) => p.id === provider);
      if (!found) {
        throw badRequest(`Unknown API key provider: ${provider}`);
      }

      storage.setApiKey(provider, apiKey.trim());
      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/auth/api-key
   * Remove an API key for a provider.
   * Body: { provider: string }
   * Response: { success: true }
   */
  router.delete("/auth/api-key", (req, res) => {
    try {
      const { provider } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }

      const storage = getAuthStorage();
      if (!storage.clearApiKey) {
        throw badRequest("API key management is not supported");
      }

      storage.clearApiKey(provider);
      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
}
