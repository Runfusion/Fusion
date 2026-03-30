import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import type { TaskStore, Column, MergeResult } from "@kb/core";
import { COLUMNS, VALID_TRANSITIONS, type PrInfo, isGhAuthenticated } from "@kb/core";
import type { ServerOptions } from "./server.js";
import { GitHubClient, getCurrentGitHubRepo } from "./github.js";
import { githubPoller as globalGithubPoller, GitHubPollingService, githubRateLimiter } from "./github-poll.js";
import { terminalSessionManager } from "./terminal.js";
import { getTerminalService } from "./terminal-service.js";
import { listFiles, readFile, writeFile, FileServiceError, type FileListResponse, type FileContentResponse, type SaveFileResponse } from "./file-service.js";
import { fetchAllProviderUsage } from "./usage.js";

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

/**
 * Get GitHub remotes from the current git repository.
 * Executes `git remote -v` and parses the output.
 */
function getGitHubRemotes(): GitRemote[] {
  try {
    // Execute git remote -v to get all remotes with their URLs
    const output = execSync("git remote -v", { encoding: "utf-8", timeout: 5000 });

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
function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --git-dir", { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current git status including branch, commit hash, and dirty state.
 * Returns structured data for the Git Manager UI.
 */
function getGitStatus(): {
  branch: string;
  commit: string;
  isDirty: boolean;
  ahead: number;
  behind: number;
} | null {
  try {
    // Get current branch
    const branch = execSync("git branch --show-current", { encoding: "utf-8", timeout: 5000 }).trim() || "HEAD detached";

    // Get current commit hash (short)
    const commit = execSync("git rev-parse --short HEAD", { encoding: "utf-8", timeout: 5000 }).trim();

    // Check if working directory is dirty
    const statusOutput = execSync("git status --porcelain", { encoding: "utf-8", timeout: 5000 }).trim();
    const isDirty = statusOutput.length > 0;

    // Get ahead/behind counts from origin
    let ahead = 0;
    let behind = 0;
    try {
      const revListOutput = execSync("git rev-list --left-right --count HEAD...@{u}", { encoding: "utf-8", timeout: 5000 }).trim();
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
function getGitCommits(limit: number = 20): GitCommit[] {
  try {
    // Format: hash|shortHash|message|author|date|parents
    const format = "%H|%h|%s|%an|%aI|%P";
    const output = execSync(`git log --max-count=${limit} --pretty=format:"${format}"`, {
      encoding: "utf-8",
      timeout: 10000,
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
function getCommitDiff(hash: string): { stat: string; patch: string } | null {
  try {
    // Validate the hash is a valid git object
    execSync(`git cat-file -t ${hash}`, { encoding: "utf-8", timeout: 5000 });

    // Get diff stat
    const stat = execSync(`git show --stat --format="" ${hash}`, { encoding: "utf-8", timeout: 10000 }).trim();

    // Get patch
    const patch = execSync(`git show --format="" ${hash}`, { encoding: "utf-8", timeout: 10000 });

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
function getGitBranches(): GitBranch[] {
  try {
    // Get current branch name
    let currentBranch = "";
    try {
      currentBranch = execSync("git branch --show-current", { encoding: "utf-8", timeout: 5000 }).trim();
    } catch {
      // Detached HEAD - no current branch
    }

    // Get all branches with info
    const format = "%(refname:short)|%(upstream:short)|%(committerdate:iso8601)|%(HEAD)";
    const output = execSync(`git for-each-ref --format="${format}" refs/heads/`, {
      encoding: "utf-8",
      timeout: 10000,
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
function getGitWorktrees(tasks: { id: string; worktree?: string }[] = []): GitWorktree[] {
  try {
    const output = execSync("git worktree list --porcelain", { encoding: "utf-8", timeout: 10000 });

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
function createGitBranch(name: string, base?: string): string {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid branch name");
  }
  if (base && !isValidBranchName(base)) {
    throw new Error("Invalid base branch name");
  }
  const cmd = base
    ? `git checkout -b ${name} ${base}`
    : `git checkout -b ${name}`;
  execSync(cmd, { encoding: "utf-8", timeout: 10000 });
  return name;
}

/**
 * Checkout an existing branch.
 * Throws if there are uncommitted changes that would be lost.
 */
function checkoutGitBranch(name: string): void {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid branch name");
  }
  // Check for uncommitted changes that would be lost
  try {
    execSync("git diff-index --quiet HEAD --", { encoding: "utf-8", timeout: 5000 });
  } catch {
    // Has uncommitted changes - check if they'd be lost
    const diff = execSync("git diff --name-only", { encoding: "utf-8", timeout: 5000 }).trim();
    if (diff) {
      throw new Error("Uncommitted changes would be lost. Commit or stash changes first.");
    }
  }
  execSync(`git checkout ${name}`, { encoding: "utf-8", timeout: 10000 });
}

/**
 * Delete a branch.
 * Throws if it's the current branch or has unmerged commits.
 */
function deleteGitBranch(name: string, force: boolean = false): void {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid branch name");
  }
  const flag = force ? "-D" : "-d";
  execSync(`git branch ${flag} ${name}`, { encoding: "utf-8", timeout: 10000 });
}

/** Result of a fetch operation */
export interface GitFetchResult {
  fetched: boolean;
  message: string;
}

/**
 * Fetch from origin or specified remote.
 */
function fetchGitRemote(remote: string = "origin"): GitFetchResult {
  if (!isValidBranchName(remote)) {
    throw new Error("Invalid remote name");
  }
  try {
    const output = execSync(`git fetch ${remote}`, { encoding: "utf-8", timeout: 30000 });
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
function pullGitBranch(): GitPullResult {
  try {
    const output = execSync("git pull", { encoding: "utf-8", timeout: 30000 });
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
function pushGitBranch(): GitPushResult {
  try {
    const output = execSync("git push", { encoding: "utf-8", timeout: 30000 });
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

export function createApiRoutes(store: TaskStore, options?: ServerOptions): Router {
  const router = Router();

  // Get GitHub token from options or env
  const githubToken = options?.githubToken ?? process.env.GITHUB_TOKEN;
  
  // Use injected githubPoller if provided, otherwise use global singleton
  const githubPoller = options?.githubPoller ?? globalGithubPoller;

  // Scheduler config (includes persisted settings)
  router.get("/config", async (_req, res) => {
    try {
      const settings = await store.getSettings();
      res.json({
        maxConcurrent: settings.maxConcurrent ?? options?.maxConcurrent ?? 2,
        maxWorktrees: settings.maxWorktrees ?? 4,
      });
    } catch {
      res.json({ maxConcurrent: options?.maxConcurrent ?? 2, maxWorktrees: 4 });
    }
  });

  // Settings CRUD
  router.get("/settings", async (_req, res) => {
    try {
      const settings = await store.getSettings();
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
      const settings = await store.updateSettings(req.body);
      res.json(settings);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Models
  registerModelsRoute(router, options?.modelRegistry);

  // List all tasks
  router.get("/tasks", async (req, res) => {
    try {
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

      const tasks = await store.listTasks({ limit, offset });
      res.json(tasks);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create task
  router.post("/tasks", async (req, res) => {
    try {
      const {
        title,
        description,
        column,
        dependencies,
        breakIntoSubtasks,
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

      const task = await store.createTask({
        title,
        description,
        column,
        dependencies,
        breakIntoSubtasks,
        modelProvider: executorModel.provider,
        modelId: executorModel.modelId,
        validatorModelProvider: validatorModel.provider,
        validatorModelId: validatorModel.modelId,
      });
      res.status(201).json(task);
    } catch (err: any) {
      const status = err.message?.includes("must be a string") ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Move task to column
  router.post("/tasks/:id/move", async (req, res) => {
    try {
      const { column } = req.body;
      if (!column || !COLUMNS.includes(column as Column)) {
        res.status(400).json({
          error: `Invalid column. Must be one of: ${COLUMNS.join(", ")}`,
        });
        return;
      }
      const task = await store.moveTask(req.params.id, column as Column);
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
      const merge = options?.onMerge ?? ((id: string) => store.mergeTask(id));
      const result = await merge(req.params.id);
      res.json(result);
    } catch (err: any) {
      const status = err.message.includes("Cannot merge") ? 400
        : err.message.includes("conflict") ? 409
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Retry failed task
  router.post("/tasks/:id/retry", async (req, res) => {
    try {
      const task = await store.getTask(req.params.id);
      if (task.status !== "failed") {
        res.status(400).json({ error: "Task is not in a failed state" });
        return;
      }
      await store.updateTask(req.params.id, { status: undefined, error: undefined });
      await store.logEntry(req.params.id, "Retry requested from dashboard");
      const updated = await store.moveTask(req.params.id, "todo");
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Duplicate task
  router.post("/tasks/:id/duplicate", async (req, res) => {
    try {
      const newTask = await store.duplicateTask(req.params.id);
      res.status(201).json(newTask);
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Create refinement task from a completed or in-review task
  router.post("/tasks/:id/refine", async (req, res) => {
    try {
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

      const refinedTask = await store.refineTask(req.params.id, trimmedFeedback);
      await store.logEntry(req.params.id, "Refinement requested", trimmedFeedback);
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
      const task = await store.archiveTask(req.params.id);
      res.json(task);
    } catch (err: any) {
      const status = err.message?.includes("must be in") ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Unarchive task (archived → done)
  router.post("/tasks/:id/unarchive", async (req, res) => {
    try {
      const task = await store.unarchiveTask(req.params.id);
      res.json(task);
    } catch (err: any) {
      const status = err.message?.includes("must be in") ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Upload attachment
  router.post("/tasks/:id/attachments", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file provided" });
        return;
      }
      const attachment = await store.addAttachment(
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
      const { path, mimeType } = await store.getAttachment(req.params.id, req.params.filename);
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
      const task = await store.deleteAttachment(req.params.id, req.params.filename);
      res.json(task);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        res.status(404).json({ error: "Attachment not found" });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // Get historical agent logs for a task
  router.get("/tasks/:id/logs", async (req, res) => {
    try {
      const logs = await store.getAgentLogs(req.params.id);
      res.json(logs);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // Get single task with prompt content
  router.get("/tasks/:id", async (req, res) => {
    try {
      const task = await store.getTask(req.params.id);
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
      const task = await store.pauseTask(req.params.id, true);
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Unpause task
  router.post("/tasks/:id/unpause", async (req, res) => {
    try {
      const task = await store.pauseTask(req.params.id, false);
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Approve plan for a task in awaiting-approval status
  router.post("/tasks/:id/approve-plan", async (req, res) => {
    try {
      const task = await store.getTask(req.params.id);

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
      await store.logEntry(task.id, "Plan approved by user");

      // Move to todo and clear status
      const updated = await store.moveTask(task.id, "todo");
      await store.updateTask(task.id, { status: undefined });

      res.json({ ...updated, status: undefined });
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Reject plan for a task in awaiting-approval status
  router.post("/tasks/:id/reject-plan", async (req, res) => {
    try {
      const task = await store.getTask(req.params.id);

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
      await store.logEntry(task.id, "Plan rejected by user", "Specification will be regenerated");

      // Clear status to return to normal triage state
      await store.updateTask(task.id, { status: undefined });

      // Remove PROMPT.md to force regeneration
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(store.getRootDir(), ".kb", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      const updated = await store.getTask(task.id);
      res.json(updated);
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Add steering comment to task
  router.post("/tasks/:id/steer", async (req, res) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "text is required and must be a string" });
        return;
      }
      if (text.length === 0 || text.length > 2000) {
        res.status(400).json({ error: "text must be between 1 and 2000 characters" });
        return;
      }
      const task = await store.addSteeringComment(req.params.id, text, "user");
      res.json(task);
    } catch (err: any) {
      const status = err.code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Request AI revision of task spec
  router.post("/tasks/:id/spec/revise", async (req, res) => {
    try {
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
      const task = await store.getTask(req.params.id);

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
      await store.logEntry(task.id, "AI spec revision requested", feedback);

      // Move to triage for re-specification (only valid for todo/in-progress)
      const updated = await store.moveTask(task.id, "triage");

      // Update status to indicate needs re-specification
      await store.updateTask(task.id, { status: "needs-respecify" });

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
      const { title, description, prompt, dependencies, modelProvider, modelId, validatorModelProvider, validatorModelId } = req.body;

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

      const task = await store.updateTask(req.params.id, {
        title,
        description,
        prompt,
        dependencies,
        modelProvider: validatedModelProvider,
        modelId: validatedModelId,
        validatorModelProvider: validatedValidatorModelProvider,
        validatorModelId: validatedValidatorModelId,
      });
      res.json(task);
    } catch (err: any) {
      const status = err.message?.includes("must be a string") ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Delete task
  router.delete("/tasks/:id", async (req, res) => {
    try {
      const task = await store.deleteTask(req.params.id);
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
      const remotes = getGitHubRemotes();
      res.json(remotes);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/git/status
   * Returns current git status: branch, commit hash, dirty state, ahead/behind counts.
   * Response: { branch: string, commit: string, isDirty: boolean, ahead: number, behind: number }
   */
  router.get("/git/status", (_req, res) => {
    try {
      if (!isGitRepo()) {
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const status = getGitStatus();
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
      if (!isGitRepo()) {
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
      const commits = getGitCommits(limit);
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
      if (!isGitRepo()) {
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { hash } = req.params;
      // Validate hash format (only hex characters, 7-40 chars)
      if (!/^[a-f0-9]{7,40}$/i.test(hash)) {
        res.status(400).json({ error: "Invalid commit hash format" });
        return;
      }
      const diff = getCommitDiff(hash);
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
   * GET /api/git/branches
   * Returns all local branches with current indicator, remote tracking info, and last commit date.
   * Response: Array of GitBranch objects
   */
  router.get("/git/branches", (_req, res) => {
    try {
      if (!isGitRepo()) {
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const branches = getGitBranches();
      res.json(branches);
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
      if (!isGitRepo()) {
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      // Get tasks to correlate with worktrees
      const tasks = await store.listTasks();
      const worktrees = getGitWorktrees(tasks);
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
      if (!isGitRepo()) {
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { name, base } = req.body;
      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const branchName = createGitBranch(name, base);
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
      if (!isGitRepo()) {
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { name } = req.params;
      checkoutGitBranch(name);
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
      if (!isGitRepo()) {
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { name } = req.params;
      const force = req.query.force === "true";
      deleteGitBranch(name, force);
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
      if (!isGitRepo()) {
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const { remote } = req.body;
      const result = fetchGitRemote(remote || "origin");
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
      if (!isGitRepo()) {
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const result = pullGitBranch();
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
      if (!isGitRepo()) {
        res.status(400).json({ error: "Not a git repository" });
        return;
      }
      const result = pushGitBranch();
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
    const windowMs = 10_000; // 10 seconds

    setInterval(() => {
      const now = Date.now();
      for (const [ip, resetTime] of clients) {
        if (now >= resetTime) {
          clients.delete(ip);
        }
      }
    }, windowMs);

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

      clients.set(ip, now + windowMs);
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
      const { title, body, base } = req.body;

      if (!title || typeof title !== "string") {
        res.status(400).json({ error: "title is required and must be a string" });
        return;
      }

      // Get task and validate
      const task = await store.getTask(req.params.id);
      if (task.column !== "in-review") {
        res.status(400).json({ error: "Task must be in 'in-review' column to create a PR" });
        return;
      }

      if (task.prInfo) {
        res.status(409).json({ error: `Task already has PR #${task.prInfo.number}: ${task.prInfo.url}` });
        return;
      }

      // Determine branch name from task
      const branchName = `kb/${task.id.toLowerCase()}`;

      // Get owner/repo from git remote or GITHUB_REPOSITORY env
      let owner: string;
      let repo: string;

      const envRepo = process.env.GITHUB_REPOSITORY;
      if (envRepo) {
        const [o, r] = envRepo.split("/");
        owner = o;
        repo = r;
      } else {
        const gitRepo = getCurrentGitHubRepo(store.getRootDir());
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
      await store.updatePrInfo(task.id, prInfo);
      await store.logEntry(task.id, "Created PR", `PR #${prInfo.number}: ${prInfo.url}`);

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
   * GET /api/tasks/:id/pr/status
   * Get cached PR status for a task. Triggers background refresh if stale (>5 min).
   */
  router.get("/tasks/:id/pr/status", async (req, res) => {
    try {
      const task = await store.getTask(req.params.id);

      if (!task.prInfo) {
        res.status(404).json({ error: "Task has no associated PR" });
        return;
      }

      // Check if data is stale (>5 minutes since last check)
      const fiveMinutesMs = 5 * 60 * 1000;
      const lastChecked = githubPoller.getLastCheckedAt(task.id, "pr")
        || task.prInfo.lastCheckedAt
        || task.updatedAt;
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
        refreshPrInBackground(store, task.id, task.prInfo, githubToken);
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
      const task = await store.getTask(req.params.id);

      if (!task.prInfo) {
        res.status(404).json({ error: "Task has no associated PR" });
        return;
      }

      // Get owner/repo from git remote or GITHUB_REPOSITORY env
      let owner: string;
      let repo: string;

      const envRepo = process.env.GITHUB_REPOSITORY;
      if (envRepo) {
        const [o, r] = envRepo.split("/");
        owner = o;
        repo = r;
      } else {
        const gitRepo = getCurrentGitHubRepo(store.getRootDir());
        if (!gitRepo) {
          res.status(400).json({ error: "Could not determine GitHub repository" });
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

      // Fetch fresh PR status + merge readiness
      const client = new GitHubClient(githubToken);
      const mergeStatus = await client.getPrMergeStatus(owner, repo, task.prInfo.number);

      const prInfo = {
        ...mergeStatus.prInfo,
        lastCheckedAt: new Date().toISOString(),
      };

      // Update stored PR info
      await store.updatePrInfo(task.id, prInfo);

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
   */
  router.get("/tasks/:id/issue/status", async (req, res) => {
    try {
      const task = await store.getTask(req.params.id);

      if (!task.issueInfo) {
        res.status(404).json({ error: "Task has no associated issue" });
        return;
      }

      const fiveMinutesMs = 5 * 60 * 1000;
      const lastChecked = githubPoller.getLastCheckedAt(task.id, "issue")
        || task.issueInfo.lastCheckedAt
        || task.updatedAt;
      const lastCheckedTime = new Date(lastChecked).getTime();
      const isStale = Date.now() - lastCheckedTime > fiveMinutesMs;

      res.json({
        issueInfo: task.issueInfo,
        stale: isStale,
      });

      if (isStale) {
        refreshIssueInBackground(store, task.id, task.issueInfo, githubToken);
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
      const task = await store.getTask(req.params.id);

      if (!task.issueInfo) {
        res.status(404).json({ error: "Task has no associated issue" });
        return;
      }

      let owner: string;
      let repo: string;

      const envRepo = process.env.GITHUB_REPOSITORY;
      if (envRepo) {
        const [o, r] = envRepo.split("/");
        owner = o;
        repo = r;
      } else {
        const gitRepo = getCurrentGitHubRepo(store.getRootDir());
        if (!gitRepo) {
          res.status(400).json({ error: "Could not determine GitHub repository" });
          return;
        }
        owner = gitRepo.owner;
        repo = gitRepo.repo;
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

      await store.updateIssueInfo(task.id, updatedIssueInfo);
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

      const session = await terminalService.createSession({
        cwd,
        cols: typeof cols === "number" ? cols : undefined,
        rows: typeof rows === "number" ? rows : undefined,
      });

      if (!session) {
        res.status(503).json({ error: "Failed to create session. Max sessions may be reached." });
        return;
      }

      res.status(201).json({
        sessionId: session.id,
        shell: session.shell,
        cwd: session.cwd,
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
      const { path: subPath } = req.query;
      const result = await listFiles(store, req.params.id, typeof subPath === "string" ? subPath : undefined);
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
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const result = await readFile(store, req.params.id, filePath);
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
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const { content } = req.body;
      
      if (typeof content !== "string") {
        res.status(400).json({ error: "content is required and must be a string" });
        return;
      }

      const result = await writeFile(store, req.params.id, filePath, content);
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

  // ── Planning Mode Routes ──────────────────────────────────────────────────

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

  return router;
}

/**
 * Background PR refresh - updates PR status without blocking the response.
 * Silently logs errors without affecting the user experience.
 */
async function refreshPrInBackground(store: TaskStore, taskId: string, currentPrInfo: PrInfo, token?: string): Promise<void> {
  try {
    // Get owner/repo from git remote or GITHUB_REPOSITORY env
    let owner: string;
    let repo: string;

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
  currentIssueInfo: import("@kb/core").IssueInfo,
  token?: string,
): Promise<void> {
  try {
    let owner: string;
    let repo: string;

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
 * Returns available AI models from the ModelRegistry for the UI model selector.
 * If no ModelRegistry is provided, returns an empty array.
 */
function registerModelsRoute(router: Router, modelRegistry?: ModelRegistryLike): void {
  router.get("/models", (_req, res) => {
    try {
      // Always return 200 with empty array instead of 404 when no models available.
      // This ensures the frontend can handle empty states gracefully.
      if (!modelRegistry) {
        res.json([]);
        return;
      }
      modelRegistry.refresh();
      const models = modelRegistry.getAvailable().map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
      }));
      res.json(models);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
   * Returns list of OAuth providers with their authentication status.
   * Response: { providers: [{ id: string, name: string, authenticated: boolean }] }
   */
  router.get("/auth/status", (_req, res) => {
    try {
      const storage = getAuthStorage();
      storage.reload();
      const oauthProviders = storage.getOAuthProviders();
      const providers = oauthProviders.map((p) => ({
        id: p.id,
        name: p.name,
        authenticated: storage.hasAuth(p.id),
      }));
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
}
