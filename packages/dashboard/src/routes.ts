import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { createReadStream, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, sep } from "node:path";
import * as nodeFs from "node:fs";
import * as nodeChildProcess from "node:child_process";
import type { TaskStore, Column, MergeResult, ScheduleType, ActivityEventType, ModelPreset, AutomationStep } from "@fusion/core";
import { COLUMNS, VALID_TRANSITIONS, GLOBAL_SETTINGS_KEYS, type BatchStatusEntry, type BatchStatusResponse, type BatchStatusResult, type IssueInfo, type PrInfo, type Task, isGhAuthenticated, AUTOMATION_PRESETS, AutomationStore, validateBackupSchedule, validateBackupRetention, validateBackupDir, syncBackupAutomation, exportSettings, importSettings, validateImportData } from "@fusion/core";
import type { ServerOptions } from "./server.js";
import { GitHubClient, getCurrentGitHubRepo, parseBadgeUrl } from "./github.js";
import { githubRateLimiter } from "./github-poll.js";
import { terminalSessionManager } from "./terminal.js";
import { getTerminalService } from "./terminal-service.js";
import { listFiles, readFile, writeFile, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile, copyWorkspaceFile, moveWorkspaceFile, deleteWorkspaceFile, renameWorkspaceFile, getWorkspaceFileForDownload, getWorkspaceFolderForZip, FileServiceError, type FileListResponse, type FileContentResponse, type SaveFileResponse, type FileOperationResponse } from "./file-service.js";
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
    const message = err.message || String(err);
    if (message.includes("CONFLICT") || message.includes("Merge conflict")) {
      return { success: false, message: "Merge conflict detected. Resolve manually.", conflict: true };
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
      res.status(500).json({ error: err.message });
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
        res.status(400).json({
          error: `Cannot update global settings via this endpoint. Use PUT /settings/global instead. Global fields found: ${globalFieldsFound.join(", ")}`,
        });
        return;
      }

      if (Object.prototype.hasOwnProperty.call(clientSettings, "modelPresets")) {
        clientSettings.modelPresets = validateModelPresets(clientSettings.modelPresets);
      }

      // Validate backup settings if provided
      if (clientSettings.autoBackupSchedule !== undefined && !validateBackupSchedule(clientSettings.autoBackupSchedule)) {
        res.status(400).json({ error: "Invalid cron expression for autoBackupSchedule" });
        return;
      }
      if (clientSettings.autoBackupRetention !== undefined && !validateBackupRetention(clientSettings.autoBackupRetention)) {
        res.status(400).json({ error: "autoBackupRetention must be between 1 and 100" });
        return;
      }
      if (clientSettings.autoBackupDir !== undefined && !validateBackupDir(clientSettings.autoBackupDir)) {
        res.status(400).json({ error: "autoBackupDir must be a relative path without '..' traversal" });
        return;
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
      const status = typeof err?.message === "string" && (
        err.message.includes("modelPresets") || err.message.includes("must include both provider and modelId")
      ) ? 400 : 500;
      res.status(status).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /api/settings/global
   * Update global (user-level) settings in ~/.pi/fusion/settings.json.
   * These settings persist across all kb projects for the current user.
   */
  router.put("/settings/global", async (req, res) => {
    try {
      const settings = await store.updateGlobalSettings(req.body);
      res.json(settings);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "ntfy notifications are not enabled" });
        return;
      }

      // Validate topic exists and matches required format
      const topic = settings.ntfyTopic;
      if (!topic || !/^[a-zA-Z0-9_-]{1,64}$/.test(topic)) {
        res.status(400).json({ error: "ntfy topic is not configured or invalid" });
        return;
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
        res.status(502).json({ error: `ntfy.sh returned ${response.status}: ${response.statusText}` });
        return;
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Failed to send test notification" });
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
      res.status(500).json({ error: err.message ?? "Failed to export settings" });
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
        res.status(400).json({
          success: false,
          error: `Validation failed: ${validationErrors.join("; ")}`,
        });
        return;
      }

      // Perform the import
      const result = await importSettings(scopedStore, data, { scope, merge });

      if (!result.success) {
        res.status(500).json({
          success: false,
          error: result.error ?? "Import failed",
          globalCount: result.globalCount,
          projectCount: result.projectCount,
        });
        return;
      }

      res.json({
        success: true,
        globalCount: result.globalCount,
        projectCount: result.projectCount,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Failed to import settings" });
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
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message ?? "Failed to list backups" });
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
        res.status(500).json({
          success: false,
          error: result.output,
        });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Failed to create backup" });
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
        res.status(400).json({ error: "limit must be a non-negative integer" });
        return;
      }

      if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
        res.status(400).json({ error: "offset must be a non-negative integer" });
        return;
      }

      const tasks = await scopedStore.listTasks({ limit, offset });
      res.json(tasks);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      } = req.body;
      if (!description || typeof description !== "string") {
        res.status(400).json({ error: "description is required" });
        return;
      }
      if (breakIntoSubtasks !== undefined && typeof breakIntoSubtasks !== "boolean") {
        res.status(400).json({ error: "breakIntoSubtasks must be a boolean" });
        return;
      }

      const validatedModelProvider = validateOptionalModelField(modelProvider, "modelProvider");
      const validatedModelId = validateOptionalModelField(modelId, "modelId");
      const validatedValidatorModelProvider = validateOptionalModelField(validatorModelProvider, "validatorModelProvider");
      const validatedValidatorModelId = validateOptionalModelField(validatorModelId, "validatorModelId");

      const executorModel = normalizeModelSelectionPair(validatedModelProvider, validatedModelId);
      const validatorModel = normalizeModelSelectionPair(validatedValidatorModelProvider, validatedValidatorModelId);

      // Validate enabledWorkflowSteps if provided
      if (enabledWorkflowSteps !== undefined) {
        if (!Array.isArray(enabledWorkflowSteps) || !enabledWorkflowSteps.every((id: unknown) => typeof id === "string")) {
          res.status(400).json({ error: "enabledWorkflowSteps must be an array of strings" });
          return;
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
          summarize,
        },
        { onSummarize, settings: { autoSummarizeTitles: settings.autoSummarizeTitles } }
      );
      res.status(201).json(task);
    } catch (err: any) {
      const status = err.message?.includes("must be a string") || err.message?.includes("must be an array of strings") ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Move task to column
  router.post("/tasks/:id/move", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { column } = req.body;
      if (!column || !COLUMNS.includes(column as Column)) {
        res.status(400).json({
          error: `Invalid column. Must be one of: ${COLUMNS.join(", ")}`,
        });
        return;
      }
      const task = await scopedStore.moveTask(req.params.id, column as Column);
      res.json(task);
    } catch (err: any) {
      const status = err.message.includes("Invalid transition") ? 400 : 500;
      res.status(status).json({ error: err.message });
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
      const status = err.message.includes("Cannot merge") ? 400
        : err.message.includes("conflict") ? 409
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Retry failed or stuck-killed task
  router.post("/tasks/:id/retry", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);
      if (task.status !== "failed" && task.status !== "stuck-killed") {
        res.status(400).json({ error: `Task is not in a retryable state (current status: ${task.status || 'none'})` });
        return;
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
      res.status(500).json({ error: err.message });
    }
  });

  // Duplicate task
  router.post("/tasks/:id/duplicate", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const newTask = await scopedStore.duplicateTask(req.params.id);
      res.status(201).json(newTask);
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Create refinement task from a completed or in-review task
  router.post("/tasks/:id/refine", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { feedback } = req.body;
      if (!feedback || typeof feedback !== "string") {
        res.status(400).json({ error: "feedback is required and must be a string" });
        return;
      }
      // Trim before checking length to catch whitespace-only input
      const trimmedFeedback = feedback.trim();
      if (trimmedFeedback.length === 0 || trimmedFeedback.length > 2000) {
        res.status(400).json({ error: "feedback must be between 1 and 2000 characters" });
        return;
      }

      const refinedTask = await scopedStore.refineTask(req.params.id, trimmedFeedback);
      await scopedStore.logEntry(req.params.id, "Refinement requested", trimmedFeedback);
      res.status(201).json(refinedTask);
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404
        : err.message?.includes("must be in 'done' or 'in-review'") ? 400
        : err.message?.includes("Feedback is required") ? 400
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Archive task (done → archived)
  router.post("/tasks/:id/archive", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.archiveTask(req.params.id);
      res.json(task);
    } catch (err: any) {
      const status = err.message?.includes("must be in") ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Unarchive task (archived → done)
  router.post("/tasks/:id/unarchive", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.unarchiveTask(req.params.id);
      res.json(task);
    } catch (err: any) {
      const status = err.message?.includes("must be in") ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Archive all done tasks
  router.post("/tasks/archive-all-done", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const archived = await scopedStore.archiveAllDone();
      res.json({ archived });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/tasks/batch-update-models
   * Batch update AI model configuration for multiple tasks.
   * Body: { taskIds: string[], modelProvider?: string | null, modelId?: string | null, validatorModelProvider?: string | null, validatorModelId?: string | null }
   * Returns: { updated: Task[], count: number }
   */
  router.post("/tasks/batch-update-models", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { taskIds, modelProvider, modelId, validatorModelProvider, validatorModelId } = req.body;

      // Validate taskIds
      if (!Array.isArray(taskIds)) {
        res.status(400).json({ error: "taskIds must be an array" });
        return;
      }
      if (taskIds.length === 0) {
        res.status(400).json({ error: "taskIds must contain at least one task ID" });
        return;
      }
      if (taskIds.some((id) => typeof id !== "string" || id.trim().length === 0)) {
        res.status(400).json({ error: "taskIds must contain non-empty strings" });
        return;
      }

      // Validate that at least one model field is being updated
      const hasExecutorModel = modelProvider !== undefined || modelId !== undefined;
      const hasValidatorModel = validatorModelProvider !== undefined || validatorModelId !== undefined;
      if (!hasExecutorModel && !hasValidatorModel) {
        res.status(400).json({ error: "At least one model field must be provided" });
        return;
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

      try {
        validatedExecutor = validateModelPair(modelProvider, modelId, "Executor model");
        validatedValidator = validateModelPair(validatorModelProvider, validatorModelId, "Validator model");
      } catch (err: any) {
        res.status(400).json({ error: err.message });
        return;
      }

      // Verify all tasks exist
      const tasksById = new Map<string, Awaited<ReturnType<TaskStore["getTask"]>>>();
      for (const taskId of taskIds) {
        try {
          const task = await scopedStore.getTask(taskId);
          tasksById.set(taskId, task);
        } catch (err: any) {
          if (err?.code === "ENOENT" || err?.message?.includes("not found")) {
            res.status(404).json({ error: `Task ${taskId} not found` });
            return;
          }
          throw err;
        }
      }

      // Build update payload (only include fields that were explicitly provided)
      const updates: { modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null } = {};
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

      // Update all tasks in parallel
      const updatePromises = taskIds.map(async (taskId) => {
        try {
          const updated = await scopedStore.updateTask(taskId, updates);
          return { success: true, task: updated };
        } catch (err: any) {
          console.error(`Failed to update task ${taskId}:`, err);
          return { success: false, taskId, error: err.message };
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
      res.status(500).json({ error: err.message || "Failed to batch update models" });
    }
  });

  // Upload attachment
  router.post("/tasks/:id/attachments", upload.single("file"), async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      if (!req.file) {
        res.status(400).json({ error: "No file provided" });
        return;
      }
      const attachment = await scopedStore.addAttachment(
        req.params.id as string,
        req.file.originalname,
        req.file.buffer,
        req.file.mimetype,
      );
      res.status(201).json(attachment);
    } catch (err: any) {
      const status = err.message.includes("Invalid mime type") || err.message.includes("File too large") ? 400 : 500;
      res.status(status).json({ error: err.message });
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
      if (err.code === "ENOENT") {
        res.status(404).json({ error: "Attachment not found" });
      } else {
        res.status(500).json({ error: err.message });
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
      if (err.code === "ENOENT") {
        res.status(404).json({ error: "Attachment not found" });
      } else {
        res.status(500).json({ error: err.message });
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
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else {
        res.status(500).json({ error: err.message });
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
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
      // ENOENT means the task directory/file genuinely doesn't exist → 404.
      // Any other error (e.g. JSON parse failure from a concurrent partial write,
      // or a transient FS error) should surface as 500 so clients can retry.
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
      res.status(500).json({ error: err.message });
    }
  });

  // Unpause task
  router.post("/tasks/:id/unpause", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.pauseTask(req.params.id, false);
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Approve plan for a task in awaiting-approval status
  router.post("/tasks/:id/approve-plan", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);

      // Verify task is in triage column with awaiting-approval status
      if (task.column !== "triage") {
        res.status(400).json({ error: "Task must be in 'triage' column to approve plan" });
        return;
      }
      if (task.status !== "awaiting-approval") {
        res.status(400).json({ error: "Task must have status 'awaiting-approval' to approve plan" });
        return;
      }

      // Log the approval
      await scopedStore.logEntry(task.id, "Plan approved by user");

      // Move to todo and clear status
      const updated = await scopedStore.moveTask(task.id, "todo");
      await scopedStore.updateTask(task.id, { status: undefined });

      res.json({ ...updated, status: undefined });
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Reject plan for a task in awaiting-approval status
  router.post("/tasks/:id/reject-plan", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);

      // Verify task is in triage column with awaiting-approval status
      if (task.column !== "triage") {
        res.status(400).json({ error: "Task must be in 'triage' column to reject plan" });
        return;
      }
      if (task.status !== "awaiting-approval") {
        res.status(400).json({ error: "Task must have status 'awaiting-approval' to reject plan" });
        return;
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
      const status = err.code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  router.get("/tasks/:id/comments", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.getTask(req.params.id);
      res.json(task.comments || []);
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  router.post("/tasks/:id/comments", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { text, author } = req.body;
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "text is required and must be a string" });
        return;
      }
      if (text.length === 0 || text.length > 2000) {
        res.status(400).json({ error: "text must be between 1 and 2000 characters" });
        return;
      }
      if (author !== undefined && typeof author !== "string") {
        res.status(400).json({ error: "author must be a string" });
        return;
      }
      const task = await scopedStore.addTaskComment(req.params.id, text, author?.trim() || "user");
      res.json(task);
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  router.patch("/tasks/:id/comments/:commentId", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "text is required and must be a string" });
        return;
      }
      if (text.length === 0 || text.length > 2000) {
        res.status(400).json({ error: "text must be between 1 and 2000 characters" });
        return;
      }
      const task = await scopedStore.updateTaskComment(req.params.id, req.params.commentId, text);
      res.json(task);
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404
        : err.message?.includes("not found") ? 404
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  router.delete("/tasks/:id/comments/:commentId", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.deleteTaskComment(req.params.id, req.params.commentId);
      res.json(task);
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404
        : err.message?.includes("not found") ? 404
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Add steering comment to task
  router.post("/tasks/:id/steer", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "text is required and must be a string" });
        return;
      }
      if (text.length === 0 || text.length > 2000) {
        res.status(400).json({ error: "text must be between 1 and 2000 characters" });
        return;
      }
      const task = await scopedStore.addSteeringComment(req.params.id, text, "user");
      res.json(task);
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Request AI revision of task spec
  router.post("/tasks/:id/spec/revise", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { feedback } = req.body;
      if (!feedback || typeof feedback !== "string") {
        res.status(400).json({ error: "feedback is required and must be a string" });
        return;
      }
      if (feedback.length === 0 || feedback.length > 2000) {
        res.status(400).json({ error: "feedback must be between 1 and 2000 characters" });
        return;
      }

      // Get current task state
      const task = await scopedStore.getTask(req.params.id);

      // Check if task can transition to triage
      const canTransition = VALID_TRANSITIONS[task.column]?.includes("triage");
      if (!canTransition) {
        res.status(400).json({
          error: `Cannot request spec revision for tasks in '${task.column}' column. ` +
                 `Move task to 'todo' or 'in-progress' first.`,
        });
        return;
      }

      // Log the revision request
      await scopedStore.logEntry(task.id, "AI spec revision requested", feedback);

      // Move to triage for re-specification (only valid for todo/in-progress)
      const updated = await scopedStore.moveTask(task.id, "triage");

      // Update status to indicate needs re-specification
      await scopedStore.updateTask(task.id, { status: "needs-respecify" });

      res.json(updated);
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404
        : err.message?.includes("Invalid transition") ? 400
        : 500;
      res.status(status).json({ error: err.message });
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
        res.status(400).json({
          error: `Cannot rebuild spec for tasks in '${task.column}' column. ` +
                 `Move task to a valid column first.`,
        });
        return;
      }

      // Log the rebuild request
      await scopedStore.logEntry(task.id, "Specification rebuild requested by user");

      // Move to triage for re-specification
      const updated = await scopedStore.moveTask(task.id, "triage");

      // Update status to indicate needs re-specification
      await scopedStore.updateTask(task.id, { status: "needs-respecify" });

      res.json(updated);
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404
        : err.message?.includes("Invalid transition") ? 400
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Update task
  router.patch("/tasks/:id", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { title, description, prompt, dependencies, enabledWorkflowSteps, modelProvider, modelId, validatorModelProvider, validatorModelId } = req.body;

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
      });
      res.json(task);
    } catch (err: any) {
      const status = err.message?.includes("must be a string") || err.message?.includes("must be an array of strings") ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Delete task
  router.delete("/tasks/:id", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const task = await scopedStore.deleteTask(req.params.id);
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const remotes = listGitRemotes(rootDir);
      res.json(remotes);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { name, url } = req.body;
      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!url || typeof url !== "string") {
        res.status(400).json({ error: "url is required" });
        return;
      }
      addGitRemote(name, url, rootDir);
      res.status(201).json({ name, added: true });
    } catch (err: any) {
      if (err.message?.includes("Invalid remote name")) {
        res.status(400).json({ error: err.message });
      } else if (err.message?.includes("Invalid git URL")) {
        res.status(400).json({ error: err.message });
      } else if (err.message?.includes("already exists")) {
        res.status(409).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { name } = req.params;
      removeGitRemote(name, rootDir);
      res.json({ name, removed: true });
    } catch (err: any) {
      if (err.message?.includes("Invalid remote name")) {
        res.status(400).json({ error: err.message });
      } else if (err.message?.includes("does not exist")) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { name } = req.params;
      const { newName } = req.body;
      if (!newName || typeof newName !== "string") {
        res.status(400).json({ error: "newName is required" });
        return;
      }
      renameGitRemote(name, newName, rootDir);
      res.json({ oldName: name, newName, renamed: true });
    } catch (err: any) {
      if (err.message?.includes("Invalid")) {
        res.status(400).json({ error: err.message });
      } else if (err.message?.includes("does not exist")) {
        res.status(404).json({ error: err.message });
      } else if (err.message?.includes("already exists")) {
        res.status(409).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { name } = req.params;
      const { url } = req.body;
      if (!url || typeof url !== "string") {
        res.status(400).json({ error: "url is required" });
        return;
      }
      setGitRemoteUrl(name, url, rootDir);
      res.json({ name, url, updated: true });
    } catch (err: any) {
      if (err.message?.includes("Invalid")) {
        res.status(400).json({ error: err.message });
      } else if (err.message?.includes("does not exist")) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const status = getGitStatus(rootDir);
      if (!status) {
        res.status(500).json({ error: "Failed to get git status" });
        return;
      }
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
      const commits = getGitCommits(limit, rootDir);
      res.json(commits);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { hash } = req.params;
      // Validate hash format (only hex characters, 7-40 chars)
      if (!/^[a-f0-9]{7,40}$/i.test(hash)) {
        res.status(400).json({ error: "Invalid commit hash format" });
        return;
      }
      const diff = getCommitDiff(hash, rootDir);
      if (!diff) {
        res.status(404).json({ error: "Commit not found" });
        return;
      }
      res.json(diff);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const commits = getAheadCommits(rootDir);
      res.json(commits);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }

      const { name } = req.params;
      if (!isValidBranchName(name)) {
        res.status(400).json({ error: "Invalid remote name" });
        return;
      }

      const ref = req.query.ref as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 10, 50);

      // Build the full remote ref: if ref is given, use "remote/ref", otherwise use "remote/HEAD"
      let remoteRef: string;
      if (ref) {
        if (!isValidGitRef(ref)) {
          res.status(400).json({ error: "Invalid ref name" });
          return;
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
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const branches = getGitBranches(rootDir);
      res.json(branches);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { name } = req.params;
      if (!isValidGitRef(name)) {
        res.status(400).json({ error: "Invalid branch name" });
        return;
      }
      const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 10, 1), 100);
      const commits = getGitCommitsForBranch(name, limit, rootDir);
      res.json(commits);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      // Get tasks to correlate with worktrees
      const tasks = await store.listTasks();
      const worktrees = getGitWorktrees(tasks, rootDir);
      res.json(worktrees);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { name, base } = req.body;
      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const branchName = createGitBranch(name, base, rootDir);
      res.status(201).json({ name: branchName, created: true });
    } catch (err: any) {
      if (err.message.includes("Invalid branch name")) {
        res.status(400).json({ error: err.message });
      } else if (err.message.includes("already exists")) {
        res.status(409).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { name } = req.params;
      checkoutGitBranch(name, rootDir);
      res.json({ checkedOut: name });
    } catch (err: any) {
      if (err.message.includes("Invalid branch name")) {
        res.status(400).json({ error: err.message });
      } else if (err.message.includes("Uncommitted changes")) {
        res.status(409).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { name } = req.params;
      const force = req.query.force === "true";
      deleteGitBranch(name, force, rootDir);
      res.json({ deleted: name });
    } catch (err: any) {
      if (err.message.includes("Invalid branch name")) {
        res.status(400).json({ error: err.message });
      } else if (err.message.includes("Cannot delete branch") || err.message.includes("is currently checked out")) {
        res.status(409).json({ error: err.message });
      } else if (err.message.includes("not fully merged")) {
        res.status(409).json({ error: "Branch has unmerged commits. Use force=true to delete anyway." });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { remote } = req.body;
      const result = fetchGitRemote(remote || "origin", rootDir);
      res.json(result);
    } catch (err: any) {
      if (err.message.includes("Invalid remote name")) {
        res.status(400).json({ error: err.message });
      } else if (err.message.includes("Failed to connect")) {
        res.status(503).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const result = pullGitBranch(rootDir);
      if (result.conflict) {
        res.status(409).json(result);
      } else {
        res.json(result);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const result = pushGitBranch(rootDir);
      res.json(result);
    } catch (err: any) {
      if (err.message.includes("rejected") || err.message.includes("Pull latest")) {
        res.status(409).json({ error: err.message });
      } else if (err.message.includes("Failed to connect")) {
        res.status(503).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const stashes = getGitStashList(rootDir);
      res.json(stashes);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { message } = req.body;
      const result = createGitStash(message, rootDir);
      res.status(201).json({ message: result });
    } catch (err: any) {
      if (err.message?.includes("No local changes")) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const index = parseInt(req.params.index, 10);
      if (isNaN(index) || index < 0) {
        res.status(400).json({ error: "Invalid stash index" });
        return;
      }
      const { drop } = req.body;
      const result = applyGitStash(index, drop === true, rootDir);
      res.json({ message: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const index = parseInt(req.params.index, 10);
      if (isNaN(index) || index < 0) {
        res.status(400).json({ error: "Invalid stash index" });
        return;
      }
      const result = dropGitStash(index, rootDir);
      res.json({ message: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const diff = getGitWorkingDiff(rootDir);
      res.json(diff);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const changes = getGitFileChanges(rootDir);
      res.json(changes);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        res.status(400).json({ error: "files array is required" });
        return;
      }
      const staged = stageGitFiles(files, rootDir);
      res.json({ staged });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        res.status(400).json({ error: "files array is required" });
        return;
      }
      const unstaged = unstageGitFiles(files, rootDir);
      res.json({ unstaged });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { message } = req.body;
      if (!message || typeof message !== "string" || !message.trim()) {
        res.status(400).json({ error: "Commit message is required" });
        return;
      }
      const result = createGitCommit(message, rootDir);
      res.status(201).json(result);
    } catch (err: any) {
      if (err.message?.includes("No staged changes")) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        res.status(400).json({ error: "files array is required" });
        return;
      }
      const discarded = discardGitChanges(files, rootDir);
      res.json({ discarded });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "owner is required" });
        return;
      }
      if (!repo || typeof repo !== "string") {
        res.status(400).json({ error: "repo is required" });
        return;
      }

      // Check gh authentication
      if (!isGhAuthenticated()) {
        res.status(401).json({
          error: "Not authenticated with GitHub. Run `gh auth login`.",
        });
        return;
      }

      const client = new GitHubClient();

      try {
        const issues = await client.listIssues(owner, repo, { limit, labels });
        res.json(issues);
      } catch (err: any) {
        // Handle specific error cases from gh CLI
        const errorMessage = err instanceof Error ? err.message : String(err);
        
        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          res.status(404).json({ error: `Repository not found: ${owner}/${repo}` });
          return;
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          res.status(401).json({
            error: "Not authenticated with GitHub. Run `gh auth login`.",
          });
          return;
        }
        
        res.status(502).json({ error: `GitHub CLI error: ${errorMessage}` });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/github/issues/import
   * Import a specific GitHub issue as a kb task.
   * Body: { owner: string, repo: string, issueNumber: number }
   * Returns: Created Task object
   */
  router.post("/github/issues/import", async (req, res) => {
    try {
      const { owner, repo, issueNumber } = req.body;

      if (!owner || typeof owner !== "string") {
        res.status(400).json({ error: "owner is required" });
        return;
      }
      if (!repo || typeof repo !== "string") {
        res.status(400).json({ error: "repo is required" });
        return;
      }
      if (!issueNumber || typeof issueNumber !== "number" || issueNumber < 1) {
        res.status(400).json({ error: "issueNumber is required and must be a positive number" });
        return;
      }

      // Check gh authentication
      if (!isGhAuthenticated()) {
        res.status(401).json({
          error: "Not authenticated with GitHub. Run `gh auth login`.",
        });
        return;
      }

      const client = new GitHubClient();

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
          res.status(400).json({ error: `#${issueNumber} is a pull request, not an issue` });
          return;
        }
      } catch (err: any) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        
        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          res.status(404).json({ error: `Issue #${issueNumber} not found in ${owner}/${repo}` });
          return;
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          res.status(401).json({
            error: "Not authenticated with GitHub. Run `gh auth login`.",
          });
          return;
        }
        
        res.status(502).json({ error: `GitHub CLI error: ${errorMessage}` });
        return;
      }

      // Check if already imported
      const existingTasks = await store.listTasks();
      const sourceUrl = issue.html_url;
      for (const existingTask of existingTasks) {
        if (existingTask.description.includes(sourceUrl)) {
          res.status(409).json({
            error: `Issue #${issueNumber} already imported as ${existingTask.id}`,
            existingTaskId: existingTask.id,
          });
          return;
        }
      }

      // Create the task
      const title = issue.title.slice(0, 200);
      const body = issue.body?.trim() || "(no description)";
      const description = `${body}\n\nSource: ${sourceUrl}`;

      const task = await store.createTask({
        title: title || undefined,
        description,
        column: "triage",
        dependencies: [],
      });

      // Log the import action
      await store.logEntry(task.id, "Imported from GitHub", sourceUrl);

      res.status(201).json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/github/issues/batch-import
   * Import multiple GitHub issues as kb tasks with throttling.
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
        res.status(429).json({ error: "Batch import rate limit exceeded. Try again in a few seconds." });
        return;
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
        res.status(400).json({ error: "owner is required" });
        return;
      }

      // Validate repo
      if (!repo || typeof repo !== "string") {
        res.status(400).json({ error: "repo is required" });
        return;
      }

      // Validate issueNumbers
      if (!Array.isArray(issueNumbers)) {
        res.status(400).json({ error: "issueNumbers is required and must be an array" });
        return;
      }

      if (issueNumbers.length === 0) {
        res.status(400).json({ error: "issueNumbers must contain at least 1 issue number" });
        return;
      }

      if (issueNumbers.length > 50) {
        res.status(400).json({ error: "issueNumbers cannot contain more than 50 issue numbers" });
        return;
      }

      if (!issueNumbers.every((n) => typeof n === "number" && n > 0 && Number.isInteger(n))) {
        res.status(400).json({ error: "issueNumbers must contain only positive integers" });
        return;
      }

      const token = process.env.GITHUB_TOKEN;
      const githubClient = new GitHubClient(token);

      // Get existing tasks to check for duplicates
      const existingTasks = await store.listTasks();

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
          const task = await store.createTask({
            title: title || undefined,
            description,
            column: "triage",
            dependencies: [],
          });

          // Log the import action
          await store.logEntry(task.id, "Imported from GitHub", sourceUrl);

          results.push({
            issueNumber,
            success: true,
            taskId: task.id,
          });

          // Add to existingTasks to avoid duplicate imports within the same batch
          existingTasks.push({ ...task, description });
        } catch (err: any) {
          results.push({
            issueNumber,
            success: false,
            error: err.message ?? "Failed to create task",
          });
        }
      }

      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "owner is required" });
        return;
      }
      if (!repo || typeof repo !== "string") {
        res.status(400).json({ error: "repo is required" });
        return;
      }

      // Check gh authentication
      if (!isGhAuthenticated()) {
        res.status(401).json({
          error: "Not authenticated with GitHub. Run `gh auth login`.",
        });
        return;
      }

      const client = new GitHubClient();

      try {
        const pulls = await client.listPullRequests(owner, repo, { limit });
        res.json(pulls);
      } catch (err: any) {
        // Handle specific error cases from gh CLI
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          res.status(404).json({ error: `Repository not found: ${owner}/${repo}` });
          return;
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          res.status(401).json({
            error: "Not authenticated with GitHub. Run `gh auth login`.",
          });
          return;
        }

        res.status(502).json({ error: `GitHub CLI error: ${errorMessage}` });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/github/pulls/import
   * Import a specific GitHub pull request as a kb review task.
   * Body: { owner: string, repo: string, prNumber: number }
   * Returns: Created Task object
   */
  router.post("/github/pulls/import", async (req, res) => {
    try {
      const { owner, repo, prNumber } = req.body;

      if (!owner || typeof owner !== "string") {
        res.status(400).json({ error: "owner is required" });
        return;
      }
      if (!repo || typeof repo !== "string") {
        res.status(400).json({ error: "repo is required" });
        return;
      }
      if (!prNumber || typeof prNumber !== "number" || prNumber < 1) {
        res.status(400).json({ error: "prNumber is required and must be a positive number" });
        return;
      }

      // Check gh authentication
      if (!isGhAuthenticated()) {
        res.status(401).json({
          error: "Not authenticated with GitHub. Run `gh auth login`.",
        });
        return;
      }

      const client = new GitHubClient();

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
          res.status(404).json({ error: `PR #${prNumber} not found in ${owner}/${repo}` });
          return;
        }
      } catch (err: any) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          res.status(404).json({ error: `PR #${prNumber} not found in ${owner}/${repo}` });
          return;
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          res.status(401).json({
            error: "Not authenticated with GitHub. Run `gh auth login`.",
          });
          return;
        }

        res.status(502).json({ error: `GitHub CLI error: ${errorMessage}` });
        return;
      }

      // Check if already imported
      const existingTasks = await store.listTasks();
      const sourceUrl = pr.html_url;
      for (const existingTask of existingTasks) {
        if (existingTask.description.includes(sourceUrl)) {
          res.status(409).json({
            error: `PR #${prNumber} already imported as ${existingTask.id}`,
            existingTaskId: existingTask.id,
          });
          return;
        }
      }

      // Create the task with "Review PR:" prefix
      const title = `Review PR #${pr.number}: ${pr.title.slice(0, 180)}`;
      const body = pr.body?.trim() || "(no description)";
      const description = `Review and address any issues in this pull request.\n\nPR: ${sourceUrl}\nBranch: ${pr.headBranch} → ${pr.baseBranch}\n\n${body}`;

      const task = await store.createTask({
        title: title || undefined,
        description,
        column: "triage",
        dependencies: [],
      });

      // Log the import action
      await store.logEntry(task.id, "Imported PR from GitHub", sourceUrl);

      res.status(201).json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "title is required and must be a string" });
        return;
      }

      // Get task and validate
      const task = await scopedStore.getTask(req.params.id);
      if (task.column !== "in-review") {
        res.status(400).json({ error: "Task must be in 'in-review' column to create a PR" });
        return;
      }

      if (task.prInfo) {
        res.status(409).json({ error: `Task already has PR #${task.prInfo.number}: ${task.prInfo.url}` });
        return;
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
          res.status(400).json({ error: "Could not determine GitHub repository. Set GITHUB_REPOSITORY env var or configure git remote." });
          return;
        }
        owner = gitRepo.owner;
        repo = gitRepo.repo;
      }

      // Check rate limit
      const repoKey = `${owner}/${repo}`;
      if (!githubRateLimiter.canMakeRequest(repoKey)) {
        const resetTime = githubRateLimiter.getResetTime(repoKey);
        res.status(429).json({
          error: "GitHub API rate limit exceeded for this repository",
          resetAt: resetTime?.toISOString(),
        });
        return;
      }

      // Create the PR
      const client = new GitHubClient(githubToken);

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
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else if (err.message?.includes("already exists")) {
        res.status(409).json({ error: err.message });
      } else if (err.message?.includes("No commits between")) {
        res.status(400).json({ error: "Branch has no commits. Push changes before creating PR." });
      } else {
        res.status(500).json({ error: err.message || "Failed to create PR" });
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
      res.status(503).json({ error: "GitHub App not configured" });
      return;
    }

    // Get raw body (Buffer from express.raw() middleware)
    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody)) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    // Verify signature
    const signatureHeader = req.headers["x-hub-signature-256"] as string | undefined;
    const verification = verifyWebhookSignature(rawBody, signatureHeader, config.webhookSecret);
    if (!verification.valid) {
      res.status(403).json({ error: verification.error ?? "Invalid signature" });
      return;
    }

    // Parse payload after verification
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      res.status(400).json({ error: "Invalid JSON payload" });
      return;
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
      res.status(400).json({ error: "Missing repository or installation data" });
      return;
    }

    // Fetch installation token
    const installationToken = await GitHubClient.fetchInstallationToken(
      classification.installationId,
      config.appId,
      config.privateKey,
    );
    if (!installationToken) {
      res.status(500).json({ error: "Failed to fetch installation token" });
      return;
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
        res.status(404).json({ error: "Task has no associated PR" });
        return;
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
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(404).json({ error: "Task has no associated PR" });
        return;
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
            res.status(400).json({ error: "Could not determine GitHub repository" });
            return;
          }
          owner = gitRepo.owner;
          repo = gitRepo.repo;
        }
      }

      // Check rate limit
      const repoKey = `${owner}/${repo}`;
      if (!githubRateLimiter.canMakeRequest(repoKey)) {
        const resetTime = githubRateLimiter.getResetTime(repoKey);
        res.status(429).json({
          error: "GitHub API rate limit exceeded for this repository",
          resetAt: resetTime?.toISOString(),
        });
        return;
      }

      // Fetch fresh PR status + merge readiness
      const client = new GitHubClient(githubToken);
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
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else if (err.message?.includes("not found")) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(404).json({ error: "Task has no associated issue" });
        return;
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
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(404).json({ error: "Task has no associated issue" });
        return;
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
            res.status(400).json({ error: "Could not determine GitHub repository" });
            return;
          }
          owner = gitRepo.owner;
          repo = gitRepo.repo;
        }
      }

      const repoKey = `${owner}/${repo}`;
      if (!githubRateLimiter.canMakeRequest(repoKey)) {
        const resetTime = githubRateLimiter.getResetTime(repoKey);
        res.status(429).json({
          error: "GitHub API rate limit exceeded for this repository",
          resetAt: resetTime?.toISOString(),
        });
        return;
      }

      const client = new GitHubClient(githubToken);
      const issueInfo = await client.getIssueStatus(owner, repo, task.issueInfo.number);

      if (!issueInfo) {
        res.status(404).json({ error: `Issue #${task.issueInfo.number} not found in ${owner}/${repo}` });
        return;
      }

      const updatedIssueInfo = {
        ...issueInfo,
        lastCheckedAt: new Date().toISOString(),
      };

      await scopedStore.updateIssueInfo(task.id, updatedIssueInfo);
      res.json(updatedIssueInfo);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else if (err.message?.includes("not found")) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "taskIds must be an array" });
        return;
      }
      if (taskIds.some((taskId) => typeof taskId !== "string" || taskId.trim().length === 0)) {
        res.status(400).json({ error: "taskIds must contain non-empty strings" });
        return;
      }
      if (taskIds.length > 100) {
        res.status(400).json({ error: "taskIds must contain at most 100 items" });
        return;
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
          res.status(429).json({
            error: "GitHub API rate limit exceeded for this repository",
            resetAt: resetTime?.toISOString(),
          });
          return false;
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
          res.status(429).json({
            error: "GitHub API rate limit exceeded for this repository",
            resetAt: resetTime?.toISOString(),
          });
          return false;
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
      res.status(500).json({ error: err.message || "Failed to batch refresh GitHub status" });
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
        res.status(400).json({ error: "command is required and must be a string" });
        return;
      }
      
      if (command.length > 4096) {
        res.status(400).json({ error: "command exceeds maximum length of 4096 characters" });
        return;
      }
      
      const rootDir = store.getRootDir();
      const result = terminalSessionManager.createSession(command, rootDir);
      
      if (result.error) {
        res.status(403).json({ error: result.error });
        return;
      }
      
      res.status(201).json({ sessionId: result.sessionId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to execute command" });
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
          res.status(404).json({ error: "Session not found" });
        } else {
          res.status(400).json({ error: "Session is not running" });
        }
        return;
      }
      
      res.json({ killed: true, sessionId: id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(404).json({ error: "Session not found" });
        return;
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
      res.status(500).json({ error: err.message });
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
        res.status(404).json({ error: "Session not found" });
        return;
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
      res.status(500).json({ error: err.message });
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

        res.status(statusByCode[result.code]).json({ error: result.error, code: result.code });
        return;
      }

      res.status(201).json({
        sessionId: result.session.id,
        shell: result.session.shell,
        cwd: result.session.cwd,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to create terminal session" });
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
      res.status(500).json({ error: err.message || "Failed to list sessions" });
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
          res.status(404).json({ error: "Session not found" });
        } else {
          res.status(400).json({ error: "Failed to kill session" });
        }
        return;
      }

      res.json({ killed: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOENT" ? 404
          : err.code === "ENOTASK" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : err.code === "EINVAL" && err.message.includes("Binary file") ? 415
          : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
        res.status(400).json({ error: "content is required and must be a string" });
        return;
      }

      const result = await writeFile(scopedStore, req.params.id, filePath, content);
      res.json(result);
    } catch (err: any) {
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOENT" ? 404
          : err.code === "ENOTASK" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
      res.status(500).json({ error: err.message || "Internal server error" });
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
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : err.code === "EINVAL" && err.message.includes("Binary file") ? 415
          : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
        res.status(400).json({ error: "content is required and must be a string" });
        return;
      }

      const result = await writeWorkspaceFile(store, workspace, filePath, content);
      res.json(result);
    } catch (err: any) {
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
        res.status(400).json({ error: "destination is required and must be a string" });
        return;
      }

      const result = await copyWorkspaceFile(store, workspace, filePath, destination);
      res.json(result);
    } catch (err: any) {
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EEXIST" ? 409
          : err.code === "EACCES" ? 403
          : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
        res.status(400).json({ error: "destination is required and must be a string" });
        return;
      }

      const result = await moveWorkspaceFile(store, workspace, filePath, destination);
      res.json(result);
    } catch (err: any) {
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EEXIST" ? 409
          : err.code === "EACCES" ? 403
          : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
        res.status(400).json({ error: "newName is required and must be a string" });
        return;
      }

      const result = await renameWorkspaceFile(store, workspace, filePath, newName);
      res.json(result);
    } catch (err: any) {
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EEXIST" ? 409
          : err.code === "EACCES" ? 403
          : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EISDIR" ? 400
          : err.code === "EACCES" ? 403
          : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "ENOTDIR" ? 400
          : err.code === "EACCES" ? 403
          : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
      }
    }
  });

  // ── Planning Mode Routes ──────────────────────────────────────────────────

  router.post("/subtasks/start-streaming", async (req, res) => {
    try {
      const { description } = req.body;

      if (!description || typeof description !== "string") {
        res.status(400).json({ error: "description is required and must be a string" });
        return;
      }

      if (description.length > 1000) {
        res.status(400).json({ error: "description must be 1000 characters or less" });
        return;
      }

      const { createSubtaskSession } = await import("./subtask-breakdown.js");
      const session = await createSubtaskSession(description, store, store.getRootDir());
      res.status(201).json({ sessionId: session.sessionId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to start subtask breakdown" });
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
        res.write(`event: error\ndata: ${JSON.stringify("Session not found or expired")}\n\n`);
        res.end();
        return;
      }

      const unsubscribe = subtaskStreamManager.subscribe(sessionId, (event) => {
        try {
          const data = (event as { data?: unknown }).data;
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
          if (event.type === "complete" || event.type === "error") {
            unsubscribe();
            res.end();
          }
        } catch {
          unsubscribe();
        }
      });

      if (session.status === "complete") {
        res.write(`event: subtasks\ndata: ${JSON.stringify(session.subtasks)}\n\n`);
        res.write("event: complete\ndata: {}\n\n");
        unsubscribe();
        res.end();
        return;
      }

      if (session.status === "error") {
        res.write(`event: error\ndata: ${JSON.stringify(String(session.error || "Unknown error"))}\n\n`);
        unsubscribe();
        res.end();
        return;
      }

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
      res.write(`event: error\ndata: ${JSON.stringify(String(err?.message) || "Unknown error")}\n\n`);
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
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      if (!Array.isArray(subtasks) || subtasks.length === 0) {
        res.status(400).json({ error: "subtasks must be a non-empty array" });
        return;
      }

      const { getSubtaskSession, cleanupSubtaskSession } = await import("./subtask-breakdown.js");
      const session = getSubtaskSession(sessionId);
      if (!session) {
        res.status(404).json({ error: `Subtask session ${sessionId} not found or expired` });
        return;
      }

      // Fetch parent task to inherit model settings if parentTaskId is provided
      let parentTask: Awaited<ReturnType<typeof store.getTask>> | undefined;
      if (typeof parentTaskId === "string" && parentTaskId.trim()) {
        try {
          parentTask = await store.getTask(parentTaskId);
        } catch {
          // Parent task not found or error - proceed without inheritance
          parentTask = undefined;
        }
      }

      const createdTasks = [] as Awaited<ReturnType<typeof store.createTask>>[];
      const tempIdToTaskId = new Map<string, string>();

      for (const item of subtasks) {
        if (!item || typeof item.tempId !== "string" || typeof item.title !== "string" || !item.title.trim()) {
          res.status(400).json({ error: "Each subtask must include tempId and title" });
          return;
        }

        const task = await store.createTask({
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
          await store.updateTask(task.id, { size: item.size });
        }
      }

      for (let index = 0; index < subtasks.length; index++) {
        const item = subtasks[index]!;
        const created = createdTasks[index]!;
        const resolvedDependencies = Array.isArray(item.dependsOn)
          ? item.dependsOn.map((dep) => tempIdToTaskId.get(dep)).filter((dep): dep is string => Boolean(dep))
          : [];

        if (resolvedDependencies.length > 0) {
          const updated = await store.updateTask(created.id, { dependencies: resolvedDependencies });
          createdTasks[index] = updated;
        }

        await store.logEntry(created.id, "Created via subtask breakdown", `Source: ${session.initialDescription.slice(0, 200)}`);
      }

      let parentTaskClosed = false;
      if (typeof parentTaskId === "string" && parentTaskId.trim()) {
        try {
          await store.deleteTask(parentTaskId);
          parentTaskClosed = true;
        } catch {
          parentTaskClosed = false;
        }
      }

      cleanupSubtaskSession(sessionId);
      res.status(201).json({ tasks: createdTasks, parentTaskClosed });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to create tasks from breakdown" });
    }
  });

  router.post("/subtasks/cancel", async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId || typeof sessionId !== "string") {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      const { cancelSubtaskSession } = await import("./subtask-breakdown.js");
      await cancelSubtaskSession(sessionId);
      res.json({ success: true });
    } catch (err: any) {
      if (err.name === "SessionNotFoundError") {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message || "Failed to cancel subtask session" });
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
        res.status(400).json({ error: "initialPlan is required and must be a string" });
        return;
      }

      if (initialPlan.length > 500) {
        res.status(400).json({ error: "initialPlan must be 500 characters or less" });
        return;
      }

      const ip = req.ip || req.socket.remoteAddress || "unknown";

      const { createSession, RateLimitError } = await import("./planning.js");
      const result = await createSession(ip, initialPlan);
      res.status(201).json(result);
    } catch (err: any) {
      if (err.name === "RateLimitError") {
        res.status(429).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message || "Failed to start planning session" });
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
      const { initialPlan } = req.body;

      if (!initialPlan || typeof initialPlan !== "string") {
        res.status(400).json({ error: "initialPlan is required and must be a string" });
        return;
      }

      if (initialPlan.length > 500) {
        res.status(400).json({ error: "initialPlan must be 500 characters or less" });
        return;
      }

      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const rootDir = store.getRootDir();

      const { createSessionWithAgent, RateLimitError } = await import("./planning.js");
      const sessionId = await createSessionWithAgent(ip, initialPlan, rootDir);
      res.status(201).json({ sessionId });
    } catch (err: any) {
      if (err.name === "RateLimitError") {
        res.status(429).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message || "Failed to start planning session" });
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
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      if (!responses || typeof responses !== "object") {
        res.status(400).json({ error: "responses is required and must be an object" });
        return;
      }

      const { submitResponse, SessionNotFoundError, InvalidSessionStateError } = await import("./planning.js");
      const result = await submitResponse(sessionId, responses);
      res.json(result);
    } catch (err: any) {
      if (err.name === "SessionNotFoundError") {
        res.status(404).json({ error: err.message });
      } else if (err.name === "InvalidSessionStateError") {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message || "Failed to process response" });
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
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      const { cancelSession, SessionNotFoundError } = await import("./planning.js");
      await cancelSession(sessionId);
      res.json({ success: true });
    } catch (err: any) {
      if (err.name === "SessionNotFoundError") {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message || "Failed to cancel session" });
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
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      const { getSession, getSummary, cleanupSession, SessionNotFoundError } = await import("./planning.js");

      const session = getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: `Planning session ${sessionId} not found or expired` });
        return;
      }

      const summary = getSummary(sessionId);
      if (!summary) {
        res.status(400).json({ error: "Planning session is not complete" });
        return;
      }

      // Create the task
      const task = await store.createTask({
        title: summary.title,
        description: summary.description,
        column: "triage",
        dependencies: summary.suggestedDependencies.length > 0 ? summary.suggestedDependencies : undefined,
      });

      // Update task with suggested size if provided
      if (summary.suggestedSize) {
        await store.updateTask(task.id, { size: summary.suggestedSize });
      }

      // Log the planning mode creation
      await store.logEntry(task.id, "Created via Planning Mode", `Initial plan: ${session.initialPlan.slice(0, 200)}`);

      // Cleanup the session
      cleanupSession(sessionId);

      res.status(201).json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to create task" });
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
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      const { getSession, generateSubtasksFromPlanning } = await import("./planning.js");

      const session = getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: `Planning session ${sessionId} not found or expired` });
        return;
      }

      if (!session.summary) {
        res.status(400).json({ error: "Planning session is not complete" });
        return;
      }

      const subtasks = generateSubtasksFromPlanning(sessionId);
      if (subtasks.length === 0) {
        res.status(400).json({ error: "Could not generate subtasks from planning session" });
        return;
      }

      // Return a synthetic session ID (based on the planning session) and the generated subtasks
      // We use the planning session ID directly as the breakdown session ID
      res.json({ sessionId, subtasks });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to start planning breakdown" });
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
        res.status(400).json({ error: "planningSessionId is required" });
        return;
      }

      if (!Array.isArray(subtasks) || subtasks.length === 0) {
        res.status(400).json({ error: "subtasks must be a non-empty array" });
        return;
      }

      const { getSession, cleanupSession } = await import("./planning.js");

      const session = getSession(planningSessionId);
      if (!session) {
        res.status(404).json({ error: `Planning session ${planningSessionId} not found or expired` });
        return;
      }

      if (!session.summary) {
        res.status(400).json({ error: "Planning session is not complete" });
        return;
      }

      // Validate each subtask
      for (const item of subtasks) {
        if (!item || typeof item.id !== "string" || typeof item.title !== "string" || !item.title.trim()) {
          res.status(400).json({ error: "Each subtask must include id and title" });
          return;
        }
      }

      const createdTasks = [] as Awaited<ReturnType<typeof store.createTask>>[];
      const tempIdToTaskId = new Map<string, string>();

      // Create tasks
      for (const item of subtasks) {
        const task = await store.createTask({
          title: item.title.trim(),
          description: typeof item.description === "string" ? item.description.trim() : item.title.trim(),
          column: "triage",
          dependencies: undefined,
        });

        tempIdToTaskId.set(item.id, task.id);
        createdTasks.push(task);

        if (item.suggestedSize === "S" || item.suggestedSize === "M" || item.suggestedSize === "L") {
          await store.updateTask(task.id, { size: item.suggestedSize });
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
          const updated = await store.updateTask(created.id, { dependencies: resolvedDependencies });
          createdTasks[index] = updated;
        }

        await store.logEntry(
          created.id,
          "Created via Planning Mode (multi-task)",
          `Source: ${session.initialPlan.slice(0, 200)}`
        );
      }

      // Cleanup the planning session
      cleanupSession(planningSessionId);

      res.status(201).json({ tasks: createdTasks });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to create tasks from planning" });
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
      const { planningStreamManager, getSession, SessionNotFoundError } = await import("./planning.js");
      
      // Verify session exists
      const session = getSession(sessionId);
      if (!session) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: "Session not found or expired" })}\n\n`);
        res.end();
        return;
      }

      // Subscribe to session events
      const unsubscribe = planningStreamManager.subscribe(sessionId, (event) => {
        try {
          const data = (event as { data?: unknown }).data;
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
          
          // End stream on complete or error
          if (event.type === "complete" || event.type === "error") {
            unsubscribe();
            res.end();
          }
        } catch (err) {
          // Client disconnected
          unsubscribe();
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
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message || "Stream error" })}\n\n`);
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
        res.status(429).json({
          error: `Rate limit exceeded. Maximum 10 refinement requests per hour. Reset at ${resetTime?.toISOString() || "unknown"}`,
        });
        return;
      }

      // Validate request body
      let validated;
      try {
        validated = validateRefineRequest(text, type);
      } catch (err) {
        if (err instanceof ValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        if (err instanceof InvalidTypeError) {
          res.status(422).json({ error: err.message });
          return;
        }
        throw err;
      }

      // Process refinement
      const refined = await refineText(validated.text, validated.type, rootDir);
      res.json({ refined });
    } catch (err: any) {
      // Check error by name since error classes are from dynamic import
      if (err?.name === "RateLimitError") {
        res.status(429).json({ error: err.message });
      } else if (err?.name === "AiServiceError") {
        res.status(500).json({ error: err.message || "AI service error" });
      } else {
        res.status(500).json({ error: err?.message || "Failed to refine text" });
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
        res.status(429).json({
          error: `Rate limit exceeded. Maximum 10 summarization requests per hour. Reset at ${resetTime?.toISOString() || "unknown"}`,
        });
        return;
      }

      // Validate request body
      try {
        validateDescription(description);
      } catch (err: any) {
        if (err?.name === "ValidationError") {
          res.status(400).json({ error: err.message });
          return;
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
        res.status(400).json({
          error: `Description must be at least ${MIN_DESCRIPTION_LENGTH} characters for summarization`,
        });
        return;
      }

      res.json({ title });
    } catch (err: any) {
      // Check error by name since error classes are from dynamic import
      if (err?.name === "RateLimitError") {
        res.status(429).json({ error: err.message });
      } else if (err?.name === "AiServiceError") {
        res.status(503).json({ error: err.message || "AI service temporarily unavailable" });
      } else if (err?.name === "ValidationError") {
        res.status(400).json({ error: err.message });
      } else {
        console.error("[ai-summarize] Unexpected error:", err);
        res.status(500).json({ error: err?.message || "Failed to generate title" });
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
      res.status(500).json({ error: err.message || "Failed to fetch usage data" });
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
      res.status(500).json({ error: err.message });
    }
  });

  // POST /automations — create a new schedule
  router.post("/automations", async (req: Request, res: Response) => {
    if (!automationStore) {
      return res.status(503).json({ error: "Automation store not available" });
    }
    try {
      const { name, description, scheduleType, cronExpression, command, enabled, timeoutMs, steps } = req.body;

      // Validation
      if (!name?.trim()) {
        return res.status(400).json({ error: "Name is required" });
      }
      const hasSteps = Array.isArray(steps) && steps.length > 0;
      if (!hasSteps && !command?.trim()) {
        return res.status(400).json({ error: "Command is required when no steps are provided" });
      }
      const validTypes = ["hourly", "daily", "weekly", "monthly", "custom", "every15Minutes", "every30Minutes", "every2Hours", "every6Hours", "every12Hours", "weekdays"];
      if (!scheduleType || !validTypes.includes(scheduleType)) {
        return res.status(400).json({ error: `Invalid schedule type. Must be one of: ${validTypes.join(", ")}` });
      }
      if (scheduleType === "custom") {
        if (!cronExpression?.trim()) {
          return res.status(400).json({ error: "Cron expression is required for custom schedule type" });
        }
        if (!AutomationStore.isValidCron(cronExpression)) {
          return res.status(400).json({ error: `Invalid cron expression: "${cronExpression}"` });
        }
      }
      // Validate steps if provided
      if (hasSteps) {
        const stepErr = validateAutomationSteps(steps);
        if (stepErr) {
          return res.status(400).json({ error: stepErr });
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
      res.status(500).json({ error: err.message });
    }
  });

  // GET /automations/:id — get a single schedule
  router.get("/automations/:id", async (req, res) => {
    if (!automationStore) {
      return res.status(503).json({ error: "Automation store not available" });
    }
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const schedule = await automationStore.getSchedule(id);
      res.json(schedule);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return res.status(404).json({ error: "Schedule not found" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /automations/:id — update a schedule
  router.patch("/automations/:id", async (req, res) => {
    if (!automationStore) {
      return res.status(503).json({ error: "Automation store not available" });
    }
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { name, description, scheduleType, cronExpression, command, enabled, timeoutMs, steps } = req.body;

      // Validate cron if switching to custom
      if (scheduleType === "custom" && cronExpression) {
        if (!AutomationStore.isValidCron(cronExpression)) {
          return res.status(400).json({ error: `Invalid cron expression: "${cronExpression}"` });
        }
      }

      // Validate steps if provided
      if (Array.isArray(steps) && steps.length > 0) {
        const stepErr = validateAutomationSteps(steps);
        if (stepErr) {
          return res.status(400).json({ error: stepErr });
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
      if (err.code === "ENOENT") {
        return res.status(404).json({ error: "Schedule not found" });
      }
      if (err.message?.includes("cannot be empty") || err.message?.includes("Invalid cron")) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /automations/:id — delete a schedule
  router.delete("/automations/:id", async (req, res) => {
    if (!automationStore) {
      return res.status(503).json({ error: "Automation store not available" });
    }
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const deleted = await automationStore.deleteSchedule(id);
      res.json(deleted);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return res.status(404).json({ error: "Schedule not found" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // POST /automations/:id/run — trigger a manual run
  router.post("/automations/:id/run", async (req, res) => {
    if (!automationStore) {
      return res.status(503).json({ error: "Automation store not available" });
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
      if (err.code === "ENOENT") {
        return res.status(404).json({ error: "Schedule not found" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // POST /automations/:id/toggle — toggle enabled/disabled
  router.post("/automations/:id/toggle", async (req, res) => {
    if (!automationStore) {
      return res.status(503).json({ error: "Automation store not available" });
    }
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const schedule = await automationStore.getSchedule(id);
      const updated = await automationStore.updateSchedule(id, {
        enabled: !schedule.enabled,
      });
      res.json(updated);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return res.status(404).json({ error: "Schedule not found" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // POST /automations/:id/steps/reorder — reorder steps
  router.post("/automations/:id/steps/reorder", async (req, res) => {
    if (!automationStore) {
      return res.status(503).json({ error: "Automation store not available" });
    }
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { stepIds } = req.body;
      if (!Array.isArray(stepIds)) {
        return res.status(400).json({ error: "stepIds must be an array" });
      }
      const schedule = await automationStore.reorderSteps(id, stepIds);
      res.json(schedule);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return res.status(404).json({ error: "Schedule not found" });
      }
      if (err.message?.includes("mismatch") || err.message?.includes("Unknown step") || err.message?.includes("no steps")) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
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
          res.status(400).json({ error: "limit must be a non-negative integer" });
          return;
        }
        limit = Math.min(parsed, 1000); // Max 1000
      }

      // Validate type if provided
      const validTypes = ["task:created", "task:moved", "task:updated", "task:deleted", "task:merged", "task:failed", "settings:updated"];
      if (typeParam !== undefined && !validTypes.includes(typeParam as string)) {
        res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` });
        return;
      }

      const options: { limit?: number; since?: string; type?: ActivityEventType } = {
        limit,
        since: sinceParam as string | undefined,
        type: typeParam as ActivityEventType | undefined,
      };

      const entries = await store.getActivityLog(options);
      res.json(entries);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!description || typeof description !== "string" || !description.trim()) {
        res.status(400).json({ error: "description is required" });
        return;
      }

      // Validate mode
      const resolvedMode: "prompt" | "script" = mode || "prompt";
      if (resolvedMode !== "prompt" && resolvedMode !== "script") {
        res.status(400).json({ error: "mode must be 'prompt' or 'script'" });
        return;
      }

      // Validate phase
      if (phase !== undefined && phase !== "pre-merge" && phase !== "post-merge") {
        res.status(400).json({ error: "phase must be 'pre-merge' or 'post-merge'" });
        return;
      }

      if (prompt !== undefined && typeof prompt !== "string") {
        res.status(400).json({ error: "prompt must be a string" });
        return;
      }
      if (toolMode !== undefined && toolMode !== "readonly" && toolMode !== "coding") {
        res.status(400).json({ error: "toolMode must be 'readonly' or 'coding'" });
        return;
      }
      if (scriptName !== undefined && typeof scriptName !== "string") {
        res.status(400).json({ error: "scriptName must be a string" });
        return;
      }
      if (enabled !== undefined && typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean" });
        return;
      }
      if (defaultOn !== undefined && typeof defaultOn !== "boolean") {
        res.status(400).json({ error: "defaultOn must be a boolean" });
        return;
      }

      // Validate script mode: scriptName must reference a named script in settings
      if (resolvedMode === "script") {
        if (!scriptName?.trim()) {
          res.status(400).json({ error: "scriptName is required when mode is 'script'" });
          return;
        }
        const settings = await scopedStore.getSettings();
        const scripts = settings.scripts || {};
        if (!(scriptName.trim() in scripts)) {
          res.status(400).json({ error: `Script '${scriptName.trim()}' not found in project settings. Available scripts: ${Object.keys(scripts).join(", ") || "none"}` });
          return;
        }
      }

      // Validate model override pair (only relevant for prompt mode)
      const modelPair = assertConsistentOptionalPair(modelProvider, modelId, "workflow step model");

      // Check for name conflicts
      const existing = await scopedStore.listWorkflowSteps();
      if (existing.some((ws) => ws.name.toLowerCase() === name.trim().toLowerCase())) {
        res.status(409).json({ error: `A workflow step named '${name.trim()}' already exists` });
        return;
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
      const status = typeof err?.message === "string" && (err.message.includes("must include both provider and modelId") || err.message.includes("Script mode requires")) ? 400 : 500;
      res.status(status).json({ error: err.message });
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
          res.status(400).json({ error: "name must be a non-empty string" });
          return;
        }
        updates.name = name.trim();
      }
      if (description !== undefined) {
        if (typeof description !== "string" || !description.trim()) {
          res.status(400).json({ error: "description must be a non-empty string" });
          return;
        }
        updates.description = description.trim();
      }
      if (mode !== undefined) {
        if (mode !== "prompt" && mode !== "script") {
          res.status(400).json({ error: "mode must be 'prompt' or 'script'" });
          return;
        }
        updates.mode = mode;
      }
      if (phase !== undefined) {
        if (phase !== "pre-merge" && phase !== "post-merge") {
          res.status(400).json({ error: "phase must be 'pre-merge' or 'post-merge'" });
          return;
        }
        updates.phase = phase;
      }
      if (prompt !== undefined) {
        if (typeof prompt !== "string") {
          res.status(400).json({ error: "prompt must be a string" });
          return;
        }
        updates.prompt = prompt;
      }
      if (toolMode !== undefined) {
        if (toolMode !== "readonly" && toolMode !== "coding") {
          res.status(400).json({ error: "toolMode must be 'readonly' or 'coding'" });
          return;
        }
        updates.toolMode = toolMode;
      }
      if (scriptName !== undefined) {
        if (typeof scriptName !== "string") {
          res.status(400).json({ error: "scriptName must be a string" });
          return;
        }
        updates.scriptName = scriptName;
      }
      if (enabled !== undefined) {
        if (typeof enabled !== "boolean") {
          res.status(400).json({ error: "enabled must be a boolean" });
          return;
        }
        updates.enabled = enabled;
      }
      if (defaultOn !== undefined) {
        if (typeof defaultOn !== "boolean") {
          res.status(400).json({ error: "defaultOn must be a boolean" });
          return;
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
          res.status(400).json({ error: "scriptName is required when mode is 'script'" });
          return;
        }
        const settings = await scopedStore.getSettings();
        const scripts = settings.scripts || {};
        if (!(resultingScriptName.trim() in scripts)) {
          res.status(400).json({ error: `Script '${resultingScriptName.trim()}' not found in project settings. Available scripts: ${Object.keys(scripts).join(", ") || "none"}` });
          return;
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
      if (err.message?.includes("not found")) {
        res.status(404).json({ error: err.message });
      } else {
        const status = typeof err?.message === "string" && (err.message.includes("must include both provider and modelId") || err.message.includes("Script mode requires")) ? 400 : 500;
        res.status(status).json({ error: err.message });
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
      if (err.message?.includes("not found")) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(404).json({ error: `Workflow step '${req.params.id}' not found` });
        return;
      }

      if (step.mode === "script") {
        res.status(400).json({ error: "Cannot refine prompt for script-mode workflow steps" });
        return;
      }

      if (!step.description?.trim()) {
        res.status(400).json({ error: "Workflow step has no description to refine" });
        return;
      }

      // Use AI to refine the description into a detailed agent prompt
      let refinedPrompt: string;
      try {
        // Dynamic import to avoid resolution issues in tests
        const engineModule = "@fusion/engine";
        const { createKbAgent } = await import(/* @vite-ignore */ engineModule);
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
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
        res.status(404).json({ error: `Template '${req.params.id}' not found` });
        return;
      }

      // Check for name conflicts with existing workflow steps
      const existing = await scopedStore.listWorkflowSteps();
      if (existing.some((ws) => ws.name.toLowerCase() === template.name.toLowerCase())) {
        res.status(409).json({ error: `A workflow step named '${template.name}' already exists` });
        return;
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
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "Script name is required" });
        return;
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(scriptName)) {
        res.status(400).json({ error: "Script name must contain only alphanumeric characters, hyphens, and underscores (no spaces)" });
        return;
      }

      // Get the script from settings
      const settings = await scopedStore.getSettings();
      const currentScripts = settings.scripts ?? {};

      if (currentScripts[scriptName] === undefined) {
        res.status(404).json({ error: `Script '${scriptName}' not found` });
        return;
      }

      const baseCommand = currentScripts[scriptName];
      const { args } = req.body ?? {};

      // Validate args if provided
      if (args !== undefined && !Array.isArray(args)) {
        res.status(400).json({ error: "args must be an array of strings" });
        return;
      }
      if (args && !args.every((a: unknown) => typeof a === "string")) {
        res.status(400).json({ error: "args must be an array of strings" });
        return;
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
        res.status(status).json({ error: result.error || "Failed to create terminal session" });
        return;
      }

      const sessionId = result.session.id;

      // Write the command to the PTY (use writeInput for compatibility with test mocks)
      terminalService.writeInput(sessionId, `${fullCommand}\n`);

      res.status(201).json({
        sessionId,
        command: fullCommand,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/agents
   * Create a new agent.
   * Body: { name: string, role: string, metadata?: object }
   */
  router.post("/agents", async (req, res) => {
    try {
      const { name, role, metadata } = req.body;
      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!role || typeof role !== "string") {
        res.status(400).json({ error: "role is required" });
        return;
      }

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.createAgent({ name, role: role as import("@fusion/core").AgentCapability, metadata });
      res.status(201).json(agent);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json(agent);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PATCH /api/agents/:id
   * Update agent fields.
   */
  router.patch("/agents/:id", async (req, res) => {
    try {
      const { name, role, metadata } = req.body;

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, { name, role, metadata });
      res.json(agent);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
      }
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
        res.status(400).json({ error: "state is required" });
        return;
      }

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgentState(req.params.id, state as import("@fusion/core").AgentState);
      res.json(agent);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        res.status(404).json({ error: err.message });
      } else if (err.message?.includes("Invalid state transition") || err.message?.includes("Cannot transition from terminated")) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
      if (err.message?.includes("not found")) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  /**
   * POST /api/agents/:id/heartbeat
   * Record a heartbeat for an agent.
   */
  router.post("/agents/:id/heartbeat", async (req, res) => {
    try {
      const { status = "ok" } = req.body;

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const event = await agentStore.recordHeartbeat(req.params.id, status as "ok" | "missed" | "recovered");
      res.json(event);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
      if (err.message?.includes("not found")) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  /**
   * POST /api/agents/:id/runs
   * Manually start a heartbeat run for an agent.
   * Body: { source?: HeartbeatInvocationSource, triggerDetail?: string }
   */
  router.post("/agents/:id/runs", async (req, res) => {
    try {
      const { source, triggerDetail } = req.body || {};

      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const run = await agentStore.startHeartbeatRun(req.params.id);

      // Enrich with invocation source and trigger detail
      if (source) {
        (run as any).invocationSource = source;
      } else {
        (run as any).invocationSource = "on_demand";
      }
      if (triggerDetail) {
        (run as any).triggerDetail = triggerDetail;
      }

      await agentStore.saveRun(run);
      res.status(201).json(run);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
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
        res.status(404).json({ error: "Run not found" });
        return;
      }
      res.json(run);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  /**
   * GET /api/agents/:id/children
   * Fetch agents that report to a given agent (parent-child hierarchy).
   * Response 200: Agent[] — Array of agents where reportsTo equals :id
   * Response 404: { error: "Agent not found" } — When parent agent doesn't exist
   */
  router.get("/agents/:id/children", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      // Validate the parent agent exists
      const parent = await agentStore.getAgent(req.params.id);
      if (!parent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const children = await agentStore.getAgentsByReportsTo(req.params.id);
      res.json(children);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

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
        res.status(400).json({ error: "role is required and must be a string" });
        return;
      }

      const trimmedRole = role.trim();
      if (trimmedRole.length === 0) {
        res.status(400).json({ error: "role must not be empty" });
        return;
      }
      if (trimmedRole.length > 1000) {
        res.status(400).json({ error: "role must not exceed 1000 characters" });
        return;
      }

      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const session = await startAgentGeneration(ip, trimmedRole);

      res.status(201).json({
        sessionId: session.id,
        roleDescription: session.roleDescription,
      });
    } catch (err: any) {
      if (err instanceof AgentGenerationRateLimitError) {
        res.status(429).json({ error: err.message });
        return;
      }
      console.error("[agent-generation] Error starting session:", err);
      res.status(500).json({ error: err.message || "Failed to start agent generation session" });
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
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      const scopedStore = await getScopedStore(req);
      const rootDir = scopedStore.getRootDir();

      const spec = await generateAgentSpec(sessionId, rootDir);
      res.json({ spec });
    } catch (err: any) {
      if (err instanceof AgentGenerationSessionNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      console.error("[agent-generation] Error generating spec:", err);
      res.status(500).json({ error: err.message || "Failed to generate agent specification" });
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
        res.status(404).json({ error: `Session ${sessionId} not found or expired` });
        return;
      }

      res.json({ session });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
      res.status(404).json({ error: "AI sessions not available" });
      return;
    }
    const session = aiSessionStore.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session);
  });

  /**
   * DELETE /api/ai-sessions/:id
   * Dismiss/cancel a background AI session.
   * Also cleans up the in-memory agent if still alive.
   */
  router.delete("/ai-sessions/:id", (req, res) => {
    if (!aiSessionStore) {
      res.status(404).json({ error: "AI sessions not available" });
      return;
    }
    const { id } = req.params;
    const session = aiSessionStore.get(id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Clean up the in-memory agent based on session type
    try {
      switch (session.type) {
        case "planning":
          if (getPlanningSession(id)) cleanupPlanningSession(id);
          break;
        case "subtask":
          if (getSubtaskSession(id)) cleanupSubtaskSession(id);
          break;
        case "mission_interview":
          if (getMissionInterviewSession(id)) cleanupMissionInterviewSession(id);
          break;
      }
    } catch {
      // Agent may already be cleaned up — that's fine
    }

    aiSessionStore.delete(id);
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
        res.status(400).json({ error: "Path must not contain '..' traversal" });
        return;
      }
      if (resolvedPath !== resolve(resolvedPath)) {
        res.status(400).json({ error: "Path must be absolute" });
        return;
      }

      // Check path exists and is a directory
      let pathStat;
      try {
        pathStat = await stat(resolvedPath);
      } catch {
        res.status(404).json({ error: "Directory not found" });
        return;
      }
      if (!pathStat.isDirectory()) {
        res.status(400).json({ error: "Path is not a directory" });
        return;
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
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "name is required and must be a non-empty string" });
        return;
      }
      if (!path || typeof path !== "string" || !path.trim()) {
        res.status(400).json({ error: "path is required and must be a non-empty string" });
        return;
      }
      if (!["in-process", "child-process"].includes(isolationMode)) {
        res.status(400).json({ error: "isolationMode must be 'in-process' or 'child-process'" });
        return;
      }
      
      // Check if path exists and has .fusion/ directory
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      if (!existsSync(path)) {
        res.status(400).json({ error: "Project path does not exist" });
        return;
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
      const status = err.message?.includes("already registered") ? 409 
        : err.message?.includes("Duplicate path") ? 409
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  /**
   * POST /api/projects/detect
   * Auto-detect kb projects in a directory.
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
        res.status(400).json({ error: "Base path does not exist" });
        return;
      }

      // Get list of existing projects to check for duplicates
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      const existingProjects = await central.listProjects();
      await central.close();
      
      const existingPaths = new Set(existingProjects.map((p: { path: string }) => p.path));
      
      // Scan for .fusion/fusion.db or .fusion/fusion.db files (indicating kb projects)
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
      res.status(500).json({ error: err.message });
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
        res.status(404).json({ error: "Project not found" });
        return;
      }
      
      res.json(project);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PATCH /api/projects/:id
   * Update a project.
   */
  router.patch("/projects/:id", async (req, res) => {
    try {
      const { name, status, isolationMode } = req.body;
      
      const updates: Partial<import("@fusion/core").RegisteredProject> = {};
      if (name !== undefined) updates.name = name;
      if (status !== undefined) updates.status = status as import("@fusion/core").ProjectStatus;
      if (isolationMode !== undefined) updates.isolationMode = isolationMode as "in-process" | "child-process";
      
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const project = await central.updateProject(req.params.id, updates);
      await central.close();
      
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      
      res.json(project);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      const status = err.message?.includes("not found") ? 404 : 500;
      res.status(status).json({ error: err.message });
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
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const health = await central.getProjectHealth(req.params.id);
      await central.close();
      
      if (!health) {
        res.status(404).json({ error: "Project health not found" });
        return;
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
      res.status(500).json({ error: err.message });
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
        res.status(404).json({ error: "Project not found" });
        return;
      }
      
      res.json({
        maxConcurrent: 2,
        rootDir: project.path,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      const status = err.message?.includes("not found") ? 404 : 500;
      res.status(status).json({ error: err.message });
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
      const status = err.message?.includes("not found") ? 404 : 500;
      res.status(status).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "projects must be an array" });
        return;
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
      res.status(500).json({ error: err.message });
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
        res.status(404).json({ error: "Task not found" });
        return;
      }

      // Done tasks: compute diff from merge base to isolate only this task's changes.
      // Using `git show SHA` on merge commits shows ALL files changed in the merge,
      // including files from unrelated commits on main. Instead, find the true
      // divergence point (where the feature branch started) and diff from that point.
      if (task.column === "done" && task.mergeDetails?.commitSha) {
        const rootDir = scopedStore.getRootDir();
        const sha = task.mergeDetails.commitSha;

        // Resolve the diff base:
        // 1. task.baseCommitSha (exact starting commit of the worktree)
        // 2. First parent of the merge commit (safe for squash merges)
        let mergeBase: string | undefined;

        // Priority 1: Use task.baseCommitSha if it's a valid ancestor of the merge commit
        if (task.baseCommitSha) {
          try {
            nodeChildProcess.execSync(
              `git merge-base --is-ancestor ${task.baseCommitSha} ${sha}`,
              { cwd: rootDir, encoding: "utf-8", timeout: 5000, stdio: "pipe" },
            );
            mergeBase = task.baseCommitSha;
          } catch {
            // baseCommitSha is stale or not an ancestor — fall through
          }
        }

        // Priority 2: Fall back to first parent of the merge commit (safe for squash merges)
        // This is more reliable than merge-base with baseBranch, which can return incorrect
        // results when baseBranch is another merged feature branch (for dependent tasks).
        if (!mergeBase) {
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
      res.status(500).json({ error: err.message });
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

      // Done tasks: compute diff from merge base to isolate only this task's changes.
      // Using `git show SHA` on merge commits shows ALL files changed in the merge,
      // including files from unrelated commits on main. Instead, find the true
      // divergence point (where the feature branch started) and diff from that point.
      if (task.column === "done" && task.mergeDetails?.commitSha) {
        const rootDir = scopedStore.getRootDir();
        const sha = task.mergeDetails.commitSha;

        // Resolve the diff base:
        // 1. task.baseCommitSha (exact starting commit of the worktree)
        // 2. First parent of the merge commit (safe for squash merges)
        let mergeBase: string | undefined;

        // Priority 1: Use task.baseCommitSha if it's a valid ancestor of the merge commit
        if (task.baseCommitSha) {
          try {
            nodeChildProcess.execSync(
              `git merge-base --is-ancestor ${task.baseCommitSha} ${sha}`,
              { cwd: rootDir, encoding: "utf-8", timeout: 5000, stdio: "pipe" },
            );
            mergeBase = task.baseCommitSha;
          } catch {
            // baseCommitSha is stale or not an ancestor — fall through
          }
        }

        // Priority 2: Fall back to first parent of the merge commit (safe for squash merges)
        // This is more reliable than merge-base with baseBranch, which can return incorrect
        // results when baseBranch is another merged feature branch (for dependent tasks).
        if (!mergeBase) {
          try {
            mergeBase = nodeChildProcess.execSync(
              `git rev-parse ${sha}^`,
              { cwd: rootDir, encoding: "utf-8", timeout: 5000 },
            ).trim();
          } catch {
            res.json([]);
            return;
          }
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
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
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
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (command === undefined || typeof command !== "string") {
        res.status(400).json({ error: "command is required" });
        return;
      }
      
      const settings = await scopedStore.getSettings();
      const scripts = {
        ...(settings.scripts ?? {}),
        [name.trim()]: command.trim(),
      };
      await scopedStore.updateSettings({ scripts });
      res.json(scripts);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
    }
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
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "provider is required" });
        return;
      }

      // Prevent concurrent logins for the same provider
      if (loginInProgress.has(provider)) {
        res.status(409).json({ error: `Login already in progress for ${provider}` });
        return;
      }

      const storage = getAuthStorage();
      const oauthProviders = storage.getOAuthProviders();
      const found = oauthProviders.find((p) => p.id === provider);
      if (!found) {
        res.status(400).json({ error: `Unknown provider: ${provider}` });
        return;
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
      // Clean up on error
      const provider = req.body?.provider;
      if (provider) loginInProgress.delete(provider);
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "provider is required" });
        return;
      }

      const storage = getAuthStorage();
      storage.logout(provider);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "provider is required" });
        return;
      }
      if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
        res.status(400).json({ error: "apiKey is required and must be a non-empty string" });
        return;
      }

      const storage = getAuthStorage();

      // Check that the storage supports API key management
      if (!storage.setApiKey) {
        res.status(400).json({ error: "API key management is not supported" });
        return;
      }

      // Validate the provider is an API-key-backed provider
      const apiKeyProviders = storage.getApiKeyProviders?.() ?? [];
      const found = apiKeyProviders.find((p) => p.id === provider);
      if (!found) {
        res.status(400).json({ error: `Unknown API key provider: ${provider}` });
        return;
      }

      storage.setApiKey(provider, apiKey.trim());
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: "provider is required" });
        return;
      }

      const storage = getAuthStorage();
      if (!storage.clearApiKey) {
        res.status(400).json({ error: "API key management is not supported" });
        return;
      }

      storage.clearApiKey(provider);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
