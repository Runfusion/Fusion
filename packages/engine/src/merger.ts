import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { TaskStore, Task, MergeResult } from "@kb/core";
import { createKbAgent } from "./pi.js";
import type { WorktreePool } from "./worktree-pool.js";
import { AgentLogger } from "./agent-logger.js";
import { mergerLog } from "./logger.js";
import { isUsageLimitError, checkSessionError, type UsageLimitPauser } from "./usage-limit-detector.js";

/** Conflict type classification for merge conflict resolution */
export type ConflictType =
  | "lockfile-ours"
  | "generated-theirs"
  | "trivial-whitespace"
  | "complex";

/** Lock file patterns that should auto-resolve using "ours" (keep current branch's version) */
export const LOCKFILE_PATTERNS = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "bun.lockb",
  "go.sum",
];

/** Generated file patterns that should auto-resolve using "theirs" (keep branch's fresh generation) */
export const GENERATED_PATTERNS = [
  "*.gen.ts",
  "*.gen.js",
  "*.min.js",
  "*.min.css",
  "dist/*",
  "build/*",
  "coverage/*",
  ".next/*",
  ".nuxt/*",
  ".output/*",
  ".cache/*",
  "out/*",
  "__generated__/*",
  "generated/*",
];

/** Check if a path matches a glob pattern (simple glob support: * and **) */
function matchGlob(path: string, pattern: string): boolean {
  // Handle ** which matches across directory boundaries (must do before single *)
  if (pattern.includes("**")) {
    // Convert ** to match any characters including /
    const regexPattern = pattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<<DOUBLESTAR>>>/g, ".*");
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(path);
  }
  
  // Handle patterns with single directory wildcards (e.g., "src/*.ts")
  const lastSlash = pattern.lastIndexOf("/");
  if (lastSlash !== -1) {
    const patternDir = pattern.slice(0, lastSlash);
    const patternFile = pattern.slice(lastSlash + 1);
    const pathDir = path.lastIndexOf("/") !== -1 ? path.slice(0, path.lastIndexOf("/")) : "";
    const pathFile = path.lastIndexOf("/") !== -1 ? path.slice(path.lastIndexOf("/")) : path;
    
    // Check if directories match
    if (patternDir.includes("*")) {
      const dirRegex = new RegExp(`^${patternDir.replace(/\./g, "\\.").replace(/\*/g, "[^/]*")}$`);
      if (!dirRegex.test(pathDir)) return false;
    } else if (!pathDir.endsWith(patternDir) && patternDir !== pathDir) {
      return false;
    }
    
    // Match filename pattern
    return matchGlob(pathFile, patternFile);
  }
  
  // Simple pattern without directory - match against filename only or full path
  const fileName = path.lastIndexOf("/") !== -1 ? path.slice(path.lastIndexOf("/") + 1) : path;
  
  // Convert glob to regex
  const regexPattern = pattern
    .replace(/\./g, "\\.")
    .replace(/\*/g, "[^/]*");
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(fileName) || regex.test(path);
}

/**
 * Get list of conflicted files from git.
 * Runs `git diff --name-only --diff-filter=U` and returns array of file paths.
 */
export function getConflictedFiles(cwd: string): string[] {
  try {
    const output = execSync("git diff --name-only --diff-filter=U", {
      cwd,
      encoding: "utf-8",
    }).trim();

    if (!output) return [];
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if a file has only trivial whitespace conflicts using git.
 * Compares ours (:2) and theirs (:3) versions with whitespace ignored.
 */
export function isTrivialWhitespaceConflict(filePath: string, cwd: string): boolean {
  try {
    // Use git diff-tree to compare index entries with whitespace ignored
    // :2 = ours (current branch), :3 = theirs (incoming branch)
    // -w flag ignores whitespace
    const result = execSync(
      `git diff-tree -p -w -- :2:"${filePath}" :3:"${filePath}"`,
      { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
    );

    // If the diff output is empty or contains no actual changes, it's trivial
    // The diff output will have headers but no +/- content lines for whitespace-only changes
    const lines = result.split("\n");
    const contentChanges = lines.filter(
      (line: string) => (line.startsWith("+") || line.startsWith("-")) &&
                !line.startsWith("+++") && !line.startsWith("---")
    );
    return contentChanges.length === 0;
  } catch (error: any) {
    // git diff-tree may exit with code 1 when there are differences
    // Check if the error output indicates substantive changes
    if (error.stdout && typeof error.stdout === "string") {
      const lines = error.stdout.split("\n");
      const contentChanges = lines.filter(
        (line: string) => (line.startsWith("+") || line.startsWith("-")) &&
                  !line.startsWith("+++") && !line.startsWith("---")
      );
      return contentChanges.length === 0;
    }
    // On other errors, assume complex conflict (don't fallback to isTrivialConflict
    // which reads working directory files with conflict markers)
    return false;
  }
}

/**
 * Classify a single conflicted file for auto-resolution.
 * Returns one of: 'lockfile-ours', 'generated-theirs', 'trivial-whitespace', 'complex'
 */
export function classifyConflict(filePath: string, cwd: string): ConflictType {
  // Check for lock files - always take "ours" (current branch's version)
  if (LOCKFILE_PATTERNS.some((pattern) => matchGlob(filePath, pattern))) {
    return "lockfile-ours";
  }

  // Check for generated files - take "theirs" (keep branch's fresh generation)
  if (GENERATED_PATTERNS.some((pattern) => matchGlob(filePath, pattern))) {
    return "generated-theirs";
  }

  // Check for trivial conflicts (whitespace-only)
  if (isTrivialWhitespaceConflict(filePath, cwd)) {
    return "trivial-whitespace";
  }

  // Complex conflicts require AI intervention
  return "complex";
}

/**
 * Resolve a conflicted file using "ours" (current branch's version).
 * Runs `git checkout --ours` and `git add`.
 */
export function resolveWithOurs(filePath: string, cwd: string): void {
  try {
    execSync(`git checkout --ours "${filePath}"`, { cwd, stdio: "pipe" });
    execSync(`git add "${filePath}"`, { cwd, stdio: "pipe" });
    mergerLog.log(`Auto-resolved ${filePath} using --ours`);
  } catch (error) {
    throw new Error(`Failed to auto-resolve ${filePath} with ours: ${error}`);
  }
}

/**
 * Resolve a conflicted file using "theirs" (incoming branch's version).
 * Runs `git checkout --theirs` and `git add`.
 */
export function resolveWithTheirs(filePath: string, cwd: string): void {
  try {
    execSync(`git checkout --theirs "${filePath}"`, { cwd, stdio: "pipe" });
    execSync(`git add "${filePath}"`, { cwd, stdio: "pipe" });
    mergerLog.log(`Auto-resolved ${filePath} using --theirs`);
  } catch (error) {
    throw new Error(`Failed to auto-resolve ${filePath} with theirs: ${error}`);
  }
}

/**
 * Resolve a trivial whitespace conflict.
 * For trivial conflicts, we can just stage the file (git considers it resolved).
 */
export function resolveTrivialWhitespace(filePath: string, cwd: string): void {
  try {
    execSync(`git add "${filePath}"`, { cwd, stdio: "pipe" });
    mergerLog.log(`Auto-resolved ${filePath} (trivial whitespace)`);
  } catch (error) {
    throw new Error(`Failed to auto-resolve ${filePath} trivial conflict: ${error}`);
  }
}

// TODO(KB-023 Step 4): Consolidate with new API above. The following legacy API
// (ConflictCategory, detectResolvableConflicts, isTrivialConflict, autoResolveFile,
// resolveConflicts) duplicates functionality with the new Step 2 API. Migrate
// callers to use classifyConflict, resolveWithOurs, resolveWithTheirs, etc.

/** Conflict category for a file with merge conflicts - LEGACY API, see above */
export type ConflictResolution = "ours" | "theirs";

export interface ConflictCategory {
  filePath: string;
  /** Whether this conflict can be auto-resolved without AI */
  autoResolvable: boolean;
  /** Resolution strategy: 'ours' = take current branch, 'theirs' = take incoming branch */
  strategy?: ConflictResolution;
  /** Reason for the categorization */
  reason: "lock-file" | "generated-file" | "trivial" | "complex";
}

/** Lock file patterns that should auto-resolve using "ours" (keep current branch's version) */
const LOCK_FILE_PATTERNS = [
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /Gemfile\.lock$/,
  /Cargo\.lock$/,
  /composer\.lock$/,
  /poetry\.lock$/,
  /bun\.lockb$/,
  /go\.sum$/,
];

/** Generated file patterns that should auto-resolve using "theirs" (keep branch's fresh generation) */
const GENERATED_FILE_PATTERNS = [
  /\.gen\.(ts|js|tsx|jsx|mjs|cjs)$/,
  /\.min\.(js|css)$/,
  /dist\//,
  /build\//,
  /coverage\//,
  /\.next\//,
  /\.nuxt\//,
  /\.output\//,
  /\.cache\//,
  /out\//,
  /__generated__\//,
  /generated\//,
];

/**
 * Detect and categorize merge conflicts in the working directory.
 * Returns array of ConflictCategory for each conflicted file.
 */
export function detectResolvableConflicts(rootDir: string): ConflictCategory[] {
  try {
    // Get list of conflicted files
    const conflictedOutput = execSync("git diff --name-only --diff-filter=U", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();

    if (!conflictedOutput) {
      return [];
    }

    const conflictedFiles = conflictedOutput.split("\n").filter(Boolean);

    return conflictedFiles.map((filePath): ConflictCategory => {
      // Check for lock files - always take "ours" (current branch's version)
      if (LOCK_FILE_PATTERNS.some((pattern) => pattern.test(filePath))) {
        return {
          filePath,
          autoResolvable: true,
          strategy: "ours",
          reason: "lock-file",
        };
      }

      // Check for generated files - take "theirs" (keep branch's fresh generation)
      if (GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(filePath))) {
        return {
          filePath,
          autoResolvable: true,
          strategy: "theirs",
          reason: "generated-file",
        };
      }

      // Check for trivial conflicts (whitespace-only)
      if (isTrivialConflict(filePath, rootDir)) {
        return {
          filePath,
          autoResolvable: true,
          strategy: "ours", // Either would work, but ours is current branch
          reason: "trivial",
        };
      }

      // Complex conflicts require AI intervention
      return {
        filePath,
        autoResolvable: false,
        reason: "complex",
      };
    });
  } catch (error) {
    mergerLog.error(`Failed to detect conflicts: ${error}`);
    return [];
  }
}

/**
 * Check if a conflicted file has only trivial changes (whitespace-only differences).
 * Reads the working directory file and compares the conflict sections.
 */
function isTrivialConflict(filePath: string, rootDir: string): boolean {
  try {
    const fullPath = `${rootDir}/${filePath}`;
    const content = readFileSync(fullPath, "utf-8");

    // Look for conflict markers - support any text after <<<<<<< (HEAD, ours, Updated upstream, etc.)
    const conflictRegex = /<<<<<<<\s+.+?[\s\S]*?^=======([\s\S]*?)^>>>>>>>\s+/gm;
    let hasConflicts = false;

    for (const match of content.matchAll(conflictRegex)) {
      hasConflicts = true;
      const fullMatch = match[0];
      const theirsContent = match[1];

      // Extract "ours" content (between <<<<<<< line and ======= line)
      const oursMatch = fullMatch.match(/<<<<<<<\s+.+?\n([\s\S]*?)\n=======/);
      if (!oursMatch) continue;

      const oursContent = oursMatch[1];

      // Normalize: remove all whitespace and compare
      const oursNormalized = oursContent.replace(/\s+/g, "");
      const theirsNormalized = theirsContent.replace(/\s+/g, "");

      // If content is the same after stripping whitespace, it's trivial
      if (oursNormalized !== theirsNormalized) {
        return false; // Real content difference found
      }
    }

    return hasConflicts; // Only trivial if we found conflicts and they're all trivial
  } catch {
    return false; // On error, assume complex
  }
}

/**
 * Auto-resolve a single file using git checkout --ours or --theirs.
 * Stages the resolved file.
 */
export function autoResolveFile(
  filePath: string,
  resolution: ConflictResolution,
  rootDir: string,
): void {
  try {
    execSync(`git checkout --${resolution} "${filePath}"`, {
      cwd: rootDir,
      stdio: "pipe",
    });
    execSync(`git add "${filePath}"`, {
      cwd: rootDir,
      stdio: "pipe",
    });
    mergerLog.log(`Auto-resolved ${filePath} using --${resolution}`);
  } catch (error) {
    throw new Error(`Failed to auto-resolve ${filePath}: ${error}`);
  }
}

/**
 * Auto-resolve all resolvable conflicts from the categorization.
 * Returns the list of remaining complex conflicts that need AI resolution.
 */
export function resolveConflicts(
  categories: ConflictCategory[],
  rootDir: string,
): string[] {
  const remainingComplex: string[] = [];

  for (const category of categories) {
    if (category.autoResolvable && category.strategy) {
      autoResolveFile(category.filePath, category.strategy, rootDir);
    } else {
      remainingComplex.push(category.filePath);
    }
  }

  return remainingComplex;
}

/**
 * Build the merge system prompt. When `includeTaskId` is true (default),
 * the commit format uses `<type>(<scope>): <summary>` where scope is the
 * task ID. When false, it uses `<type>: <summary>` with no scope.
 */
function buildMergeSystemPrompt(includeTaskId: boolean): string {
  const commitFormat = includeTaskId
    ? `\`\`\`
git commit -m "<type>(<scope>): <summary>" -m "<body>"
\`\`\`

Message format:
- **Type:** feat, fix, refactor, docs, test, chore
- **Scope:** the task ID (e.g., KB-001)
- **Summary:** one line describing what the squash brings in (imperative mood)
- **Body:** 2-5 bullet points summarizing the key changes, each starting with "- "

Example:
\`\`\`
git commit -m "feat(KB-003): add user profile page" -m "- Add /profile route with avatar upload
- Create ProfileCard and EditProfileForm components
- Add profile image resizing via sharp
- Update nav bar with profile link
- Add profile e2e tests"
\`\`\``
    : `\`\`\`
git commit -m "<type>: <summary>" -m "<body>"
\`\`\`

Message format:
- **Type:** feat, fix, refactor, docs, test, chore
- **Summary:** one line describing what the squash brings in (imperative mood)
- **Body:** 2-5 bullet points summarizing the key changes, each starting with "- "

Do NOT include a scope in the commit message type.

Example:
\`\`\`
git commit -m "feat: add user profile page" -m "- Add /profile route with avatar upload
- Create ProfileCard and EditProfileForm components
- Add profile image resizing via sharp
- Update nav bar with profile link
- Add profile e2e tests"
\`\`\``;

  return `You are a merge agent for "kb", an AI-orchestrated task board.

Your job is to finalize a squash merge: resolve any conflicts and write a good commit message.
All changes from the branch are squashed into a single commit.

## Conflict resolution
If there are merge conflicts:
1. Run \`git diff --name-only --diff-filter=U\` to list conflicted files
2. Read each conflicted file — look for the <<<<<<< / ======= / >>>>>>> markers
3. Understand the intent of BOTH sides, then edit the file to produce the correct merged result
4. Remove ALL conflict markers — the result must be clean, compilable code
5. Run \`git add <file>\` for each resolved file
6. Do NOT change anything beyond what's needed to resolve the conflict

## Commit message
After all conflicts are resolved (or if there were none), write and execute the squash commit.

Look at the branch commits and diff to understand what was done, then run:
${commitFormat}

Do NOT use generic messages like "merge branch" or "resolve conflicts".
Base the message on the ACTUAL work done in the branch commits.`;
}

/**
 * Check if any non-done task (other than `excludeTaskId`) references the given
 * worktree path. Returns the first matching task ID, or null if the worktree
 * is safe to remove. Used by both the merger and executor cleanup to avoid
 * deleting worktrees that are shared across dependent tasks.
 */
export async function findWorktreeUser(
  store: TaskStore,
  worktreePath: string,
  excludeTaskId: string,
): Promise<string | null> {
  const tasks = await store.listTasks();
  for (const t of tasks) {
    if (t.id === excludeTaskId) continue;
    if (t.worktree === worktreePath && t.column !== "done") {
      return t.id;
    }
  }
  return null;
}

export interface MergerOptions {
  /** Called with agent text output */
  onAgentText?: (delta: string) => void;
  /** Called with agent tool usage */
  onAgentTool?: (toolName: string) => void;
  /** Worktree pool — when provided and `recycleWorktrees` is enabled,
   *  worktrees are released to the pool instead of being removed. */
  pool?: WorktreePool;
  /** Usage limit pauser — triggers global pause when API limits are detected. */
  usageLimitPauser?: UsageLimitPauser;
  /** Called with the agent session immediately after creation. Enables the
   *  caller (e.g. dashboard.ts) to track and externally dispose the session
   *  when a global pause is triggered. */
  onSession?: (session: { dispose: () => void }) => void;
}

/**
 * AI-powered merge with 3-attempt retry logic when autoResolveConflicts is enabled.
 *
 * Attempt 1: Standard merge + AI agent with full context
 * Attempt 2 (if enabled and Attempt 1 failed): Auto-resolve lock/generated files, retry AI
 * Attempt 3 (if enabled and Attempt 2 failed): Reset and use git merge -X theirs --squash
 *
 * When `options.pool` is provided and `recycleWorktrees` is enabled in
 * settings, the worktree is detached from its branch and released to the
 * idle pool instead of being removed. The task's branch is always deleted
 * regardless of pooling. On next task execution, the pooled worktree will
 * be acquired and prepared with a fresh branch via {@link WorktreePool.prepareForTask}.
 */
export async function aiMergeTask(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  options: MergerOptions = {},
): Promise<MergeResult> {
  // 1. Validate task state
  const task = await store.getTask(taskId);
  if (task.column !== "in-review") {
    throw new Error(
      `Cannot merge ${taskId}: task is in '${task.column}', must be in 'in-review'`,
    );
  }

  const branch = `kb/${taskId.toLowerCase()}`;
  const worktreePath = task.worktree;
  const result: MergeResult = {
    task,
    branch,
    merged: false,
    worktreeRemoved: false,
    branchDeleted: false,
  };

  if (!worktreePath) {
    mergerLog.warn(`${taskId}: no worktree path set — skipping worktree cleanup`);
  }

  // 2. Read settings
  const settings = await store.getSettings();
  const includeTaskId = settings.includeTaskIdInCommit !== false;
  // Support both setting names: smartConflictResolution (new) and autoResolveConflicts (legacy)
  const smartConflictResolution = (settings.smartConflictResolution ?? settings.autoResolveConflicts) !== false;

  // 3. Check branch exists
  try {
    execSync(`git rev-parse --verify "${branch}"`, {
      cwd: rootDir,
      stdio: "pipe",
    });
  } catch {
    result.error = `Branch '${branch}' not found — moving to done without merge`;
    await completeTask(store, taskId, result);
    return result;
  }

  // 4. Gather context for the agent (used in all attempts)
  let commitLog = "";
  let diffStat = "";
  try {
    commitLog = execSync(`git log HEAD..${branch} --format="- %s"`, {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();
  } catch {
    commitLog = "(unable to read commit log)";
  }
  try {
    diffStat = execSync(`git diff HEAD..${branch} --stat`, {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();
  } catch {
    diffStat = "(unable to read diff)";
  }

  // 5. Execute merge with retry logic
  await store.updateTask(taskId, { status: "merging" });

  const mergeAttempt = async (attemptNum: 1 | 2 | 3): Promise<boolean> => {
    mergerLog.log(`${taskId}: merge attempt ${attemptNum}/3...`);

    try {
      // Try the merge with appropriate strategy for this attempt
      const success = await executeMergeAttempt({
        store,
        rootDir,
        taskId,
        branch,
        commitLog,
        diffStat,
        includeTaskId,
        smartConflictResolution,
        attemptNum,
        options,
        result,
      }, aiTracker);

      if (success) {
        result.attemptsMade = attemptNum;
        result.resolutionStrategy = getResolutionStrategy(attemptNum, smartConflictResolution);
        result.resolutionMethod = getResolutionMethod(result.resolutionStrategy, result.autoResolvedCount, aiTracker.aiWasInvoked);
        result.merged = true;
        return true;
      }

      // If not successful and we have more attempts, clean up and try again
      if (attemptNum < 3) {
        mergerLog.log(`${taskId}: attempt ${attemptNum} failed, cleaning up for retry...`);
        try {
          execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
        } catch { /* ignore cleanup errors */ }
      }

      return false;
    } catch (error: any) {
      // Clean up on error before potentially rethrowing or retrying
      if (attemptNum < 3 && smartConflictResolution) {
        mergerLog.log(`${taskId}: attempt ${attemptNum} error, cleaning up for retry...`);
        try {
          execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
        } catch { /* ignore cleanup errors */ }
        return false; // Allow retry
      }
      throw error; // Last attempt or auto-resolve disabled - propagate error
    }
  };

  // Track AI agent invocation for resolutionMethod calculation
  const aiTracker: AiInvocationTracker = { aiWasInvoked: false };

  // Execute attempts with escalation
  let merged = false;

  // Attempt 1: Standard AI merge
  merged = await mergeAttempt(1);

  // Attempt 2: Auto-resolve lock/generated files, then AI (if enabled)
  if (!merged && smartConflictResolution) {
    merged = await mergeAttempt(2);
  }

  // Attempt 3: Use -X theirs merge strategy (if enabled)
  if (!merged && smartConflictResolution) {
    merged = await mergeAttempt(3);
  }

  // If all attempts failed
  if (!merged) {
    // Final cleanup
    try {
      execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
    } catch { /* */ }
    throw new Error(`AI merge failed for ${taskId}: all 3 attempts exhausted`);
  }

  // 6. Delete branch
  try {
    execSync(`git branch -d "${branch}"`, { cwd: rootDir, stdio: "pipe" });
    result.branchDeleted = true;
  } catch {
    try {
      execSync(`git branch -D "${branch}"`, { cwd: rootDir, stdio: "pipe" });
      result.branchDeleted = true;
    } catch { /* non-fatal */ }
  }

  // 7. Clean up worktree
  if (worktreePath && existsSync(worktreePath)) {
    const otherUser = await findWorktreeUser(store, worktreePath, taskId);
    if (otherUser) {
      mergerLog.log(`Worktree retained — still needed by ${otherUser}`);
      result.worktreeRemoved = false;
    } else if (options.pool && settings.recycleWorktrees) {
      options.pool.release(worktreePath);
      result.worktreeRemoved = false;
    } else {
      try {
        execSync(`git worktree remove "${worktreePath}" --force`, {
          cwd: rootDir,
          stdio: "pipe",
        });
        result.worktreeRemoved = true;
      } catch { /* non-fatal */ }
    }
  }

  // 8. Move task to done
  await completeTask(store, taskId, result);
  return result;
}

/** Get the resolution strategy based on attempt number and settings */
function getResolutionStrategy(
  attemptNum: 1 | 2 | 3,
  smartConflictResolution: boolean,
): MergeResult["resolutionStrategy"] {
  if (!smartConflictResolution || attemptNum === 1) {
    return "ai";
  }
  if (attemptNum === 2) {
    return "auto-resolve";
  }
  return "theirs";
}

/** Map resolutionStrategy and autoResolvedCount to resolutionMethod for metrics/debugging */
function getResolutionMethod(
  strategy: MergeResult["resolutionStrategy"],
  autoResolvedCount?: number,
  aiWasUsed?: boolean,
): MergeResult["resolutionMethod"] {
  if (strategy === "ai") return "ai";
  if (strategy === "theirs") return "theirs";
  if (strategy === "auto-resolve") {
    // auto-resolve strategy: determine if pure auto or mixed with AI
    if (autoResolvedCount && autoResolvedCount > 0) {
      // If AI was actually invoked during auto-resolve attempt, it's mixed
      return aiWasUsed ? "mixed" : "auto";
    }
    return "auto";
  }
  return undefined;
}

interface MergeAttemptParams {
  store: TaskStore;
  rootDir: string;
  taskId: string;
  branch: string;
  commitLog: string;
  diffStat: string;
  includeTaskId: boolean;
  smartConflictResolution: boolean;
  attemptNum: 1 | 2 | 3;
  options: MergerOptions;
  result: MergeResult;
}

/** Mutable flag to track AI agent invocation */
interface AiInvocationTracker {
  aiWasInvoked: boolean;
}

/**
 * Execute a single merge attempt with the specified strategy.
 * Returns true if merge succeeded, false if should retry (for attempts 1-2).
 * Throws on unrecoverable errors.
 */
async function executeMergeAttempt(
  params: MergeAttemptParams,
  aiTracker: AiInvocationTracker,
): Promise<boolean> {
  const {
    store,
    rootDir,
    taskId,
    branch,
    commitLog,
    diffStat,
    includeTaskId,
    smartConflictResolution,
    attemptNum,
    options,
    result,
  } = params;

  // Attempt 3: Use -X theirs strategy
  if (attemptNum === 3) {
    return attemptWithTheirsStrategy(params);
  }

  // Attempt 1 & 2: Standard squash merge
  let hasConflicts = false;
  try {
    // For attempt 2, try with smart auto-resolution first
    if (attemptNum === 2 && smartConflictResolution) {
      // First, do a standard merge to get conflicts
      // Note: git merge --squash exits with code 1 when conflicts exist
      // This is expected - we catch it and proceed with auto-resolution
      let mergeExitedWithConflicts = false;
      try {
        execSync(`git merge --squash "${branch}"`, {
          cwd: rootDir,
          stdio: "pipe",
        });
      } catch {
        // Merge exits with code 1 when conflicts exist - this is expected
        mergeExitedWithConflicts = true;
      }

      // Use new API: get conflicted files and classify them
      const conflictedFiles = getConflictedFiles(rootDir);
      if (conflictedFiles.length > 0 || mergeExitedWithConflicts) {
        // Classify each conflicted file
        const classified = conflictedFiles.map((file) => ({
          file,
          type: classifyConflict(file, rootDir),
        }));

        const autoResolvable = classified.filter(
          (c) => c.type !== "complex",
        );
        const complex = classified.filter(
          (c) => c.type === "complex",
        );

        // Auto-resolve each file based on its classification
        if (autoResolvable.length > 0) {
          mergerLog.log(
            `${taskId}: auto-resolving ${autoResolvable.length} lock/generated/trivial file(s) before AI retry`,
          );
          for (const { file, type } of autoResolvable) {
            try {
              if (type === "lockfile-ours") {
                resolveWithOurs(file, rootDir);
              } else if (type === "generated-theirs") {
                resolveWithTheirs(file, rootDir);
              } else if (type === "trivial-whitespace") {
                resolveTrivialWhitespace(file, rootDir);
              }
              result.autoResolvedCount = (result.autoResolvedCount || 0) + 1;
            } catch (error) {
              // If auto-resolution fails, treat as complex conflict
              mergerLog.warn(`${taskId}: auto-resolution failed for ${file}: ${error}`);
              complex.push({ file, type: "complex" });
            }
          }
        }

        // If only auto-resolvable conflicts (or all were resolved), commit directly
        if (complex.length === 0) {
          // All conflicts auto-resolved, commit with fallback message
          const staged = execSync("git diff --cached --quiet 2>&1; echo $?", {
            cwd: rootDir,
            encoding: "utf-8",
          }).trim();

          if (staged !== "0") {
            const escapedLog = commitLog.replace(/"/g, '\\"');
            const fallbackPrefix = includeTaskId ? `feat(${taskId})` : "feat";
            execSync(
              `git commit -m "${fallbackPrefix}: merge ${branch}" -m "${escapedLog}"`,
              { cwd: rootDir, stdio: "pipe" },
            );
            mergerLog.log(`${taskId}: committed after auto-resolving all conflicts`);
          }
          return true;
        }

        // Has complex conflicts - continue to AI agent
        hasConflicts = true;
      } else {
        // No conflicts - check if squash is empty
        const squashIsEmpty = execSync(
          "git diff --cached --quiet 2>&1; echo $?",
          { cwd: rootDir, encoding: "utf-8" },
        ).trim() === "0";

        if (squashIsEmpty) {
          mergerLog.log(`${taskId}: squash merge staged nothing — already merged`);
          return true;
        }
        // No conflicts but has staged changes - continue to AI for commit message
      }
    } else {
      // Attempt 1: Standard merge
      execSync(`git merge --squash "${branch}"`, {
        cwd: rootDir,
        stdio: "pipe",
      });

      // Check if squash is empty
      const squashIsEmpty = execSync(
        "git diff --cached --quiet 2>&1; echo $?",
        { cwd: rootDir, encoding: "utf-8" },
      ).trim() === "0";

      if (squashIsEmpty) {
        mergerLog.log(`${taskId}: squash merge staged nothing — already merged`);
        return true;
      }

      // Check for conflicts
      const conflictedOutput = execSync("git diff --name-only --diff-filter=U", {
        cwd: rootDir,
        encoding: "utf-8",
      }).trim();
      hasConflicts = conflictedOutput.length > 0;

      if (hasConflicts && !smartConflictResolution) {
        // No auto-resolve - AI will handle all conflicts
        mergerLog.log(`${taskId}: conflicts detected, AI will resolve`);
      } else if (hasConflicts && smartConflictResolution) {
        // Has conflicts and auto-resolve enabled - should be handled in attempt 2
        // Reset and return false to trigger attempt 2
        mergerLog.log(`${taskId}: conflicts detected, will retry with auto-resolution`);
        return false;
      }
    }

    // At this point, either:
    // - No conflicts (attempt 1) - AI writes commit message
    // - Complex conflicts remain after attempt 2 auto-resolution - AI resolves them
    // Spawn AI agent
    aiTracker.aiWasInvoked = true; // Track that AI was invoked
    return await runAiAgentForCommit({
      store,
      rootDir,
      taskId,
      branch,
      commitLog,
      diffStat,
      includeTaskId,
      hasConflicts,
      simplifiedContext: attemptNum === 2,
      options,
    });
  } catch (error: any) {
    // Check if it's a non-conflict merge failure
    if (error.message?.includes("Merge failed")) {
      throw error; // Fatal
    }

    // For attempt 1, return false to trigger attempt 2
    if (attemptNum === 1 && smartConflictResolution) {
      return false;
    }

    // Otherwise propagate
    throw error;
  }
}

/**
 * Attempt 3: Use git merge -X theirs --squash strategy
 */
async function attemptWithTheirsStrategy(params: MergeAttemptParams): Promise<boolean> {
  const { rootDir, branch, commitLog, includeTaskId, taskId } = params;

  mergerLog.log(`${taskId}: attempting merge with -X theirs strategy`);

  try {
    // Use -X theirs to auto-resolve conflicts favoring the incoming branch
    execSync(`git merge -X theirs --squash "${branch}"`, {
      cwd: rootDir,
      stdio: "pipe",
    });

    // Check if there are still conflicts (some types can't be auto-resolved)
    const conflictedOutput = execSync("git diff --name-only --diff-filter=U", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();

    if (conflictedOutput.length > 0) {
      mergerLog.warn(`${taskId}: -X theirs left unresolved conflicts: ${conflictedOutput}`);
      return false; // Still has conflicts after -X theirs
    }

    // Check if there's anything staged
    const staged = execSync("git diff --cached --quiet 2>&1; echo $?", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();

    if (staged === "0") {
      // Nothing staged - already merged
      return true;
    }

    // Commit with fallback message
    const escapedLog = commitLog.replace(/"/g, '\\"');
    const fallbackPrefix = includeTaskId ? `feat(${taskId})` : "feat";
    execSync(
      `git commit -m "${fallbackPrefix}: merge ${branch} (auto-resolved)" -m "${escapedLog}"`,
      { cwd: rootDir, stdio: "pipe" },
    );
    mergerLog.log(`${taskId}: committed with -X theirs auto-resolution`);
    return true;
  } catch (error) {
    mergerLog.error(`${taskId}: -X theirs merge failed: ${error}`);
    return false;
  }
}

interface AiAgentParams {
  store: TaskStore;
  rootDir: string;
  taskId: string;
  branch: string;
  commitLog: string;
  diffStat: string;
  includeTaskId: boolean;
  hasConflicts: boolean;
  simplifiedContext: boolean;
  options: MergerOptions;
}

/**
 * Run the AI agent to resolve conflicts and/or write commit message.
 */
async function runAiAgentForCommit(params: AiAgentParams): Promise<boolean> {
  const {
    store,
    rootDir,
    taskId,
    branch,
    commitLog,
    diffStat,
    includeTaskId,
    hasConflicts,
    simplifiedContext,
    options,
  } = params;

  const settings = await store.getSettings();

  mergerLog.log(`${taskId}: ${hasConflicts ? "resolving conflicts + " : ""}writing commit message`);

  const agentLogger = new AgentLogger({
    store,
    taskId,
    agent: "merger",
    onAgentText: options.onAgentText
      ? (_id, delta) => options.onAgentText!(delta)
      : undefined,
    onAgentTool: options.onAgentTool
      ? (_id, name) => options.onAgentTool!(name)
      : undefined,
  });

  const { session } = await createKbAgent({
    cwd: rootDir,
    systemPrompt: buildMergeSystemPrompt(includeTaskId),
    tools: "coding",
    onText: agentLogger.onText,
    onThinking: agentLogger.onThinking,
    onToolStart: agentLogger.onToolStart,
    onToolEnd: agentLogger.onToolEnd,
    defaultProvider: settings.defaultProvider,
    defaultModelId: settings.defaultModelId,
    defaultThinkingLevel: settings.defaultThinkingLevel,
  });

  options.onSession?.(session);

  try {
    // Build appropriate prompt
    const prompt = buildMergePrompt({
      taskId,
      branch,
      commitLog: simplifiedContext ? "(see branch commits)" : commitLog,
      diffStat,
      hasConflicts,
      simplifiedContext,
    });
    await session.prompt(prompt);

    checkSessionError(session);

    // Verify commit happened
    const staged = execSync("git diff --cached --quiet 2>&1; echo $?", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();

    if (staged !== "0") {
      mergerLog.log("Agent didn't commit — committing with fallback message");
      const escapedLog = commitLog.replace(/"/g, '\\"');
      const fallbackPrefix = includeTaskId ? `feat(${taskId})` : "feat";
      execSync(
        `git commit -m "${fallbackPrefix}: merge ${branch}" -m "${escapedLog}"`,
        { cwd: rootDir, stdio: "pipe" },
      );
    }

    return true;
  } catch (err: any) {
    mergerLog.error(`Agent failed: ${err.message}`);

    if (options.usageLimitPauser && isUsageLimitError(err.message)) {
      await options.usageLimitPauser.onUsageLimitHit("merger", taskId, err.message);
    }

    throw err;
  } finally {
    await agentLogger.flush();
    session.dispose();
  }
}

interface MergePromptParams {
  taskId: string;
  branch: string;
  commitLog: string;
  diffStat: string;
  hasConflicts: boolean;
  simplifiedContext?: boolean;
}

function buildMergePrompt(params: MergePromptParams): string {
  const { taskId, branch, commitLog, diffStat, hasConflicts, simplifiedContext } = params;

  const parts = [
    `Finalize the merge of branch \`${branch}\` for task ${taskId}.`,
    "",
    "## Branch commits",
    "```",
    commitLog,
    "```",
  ];

  if (!simplifiedContext) {
    parts.push(
      "",
      "## Files changed",
      "```",
      diffStat,
      "```",
    );
  }

  if (hasConflicts) {
    parts.push(
      "",
      "## ⚠️ There are merge conflicts",
      "Run `git diff --name-only --diff-filter=U` to see which files.",
      "Resolve each conflict, then `git add` the resolved files.",
      "After resolving all conflicts, write and run the commit command.",
    );
  } else {
    parts.push(
      "",
      "## No conflicts",
      "The merge applied cleanly. All changes are staged.",
      "Write and run the `git commit` command with a good message summarizing the work.",
    );
  }

  return parts.join("\n");
}

async function completeTask(
  store: TaskStore,
  taskId: string,
  result: MergeResult,
): Promise<void> {
  // Clear transient status before moving to done
  await store.updateTask(taskId, { status: null });
  // Use moveTask for proper event emission
  const task = await store.moveTask(taskId, "done");
  result.task = task;
  store.emit("task:merged", result);
}
