import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getTaskMergeBlocker, type TaskStore, type MergeResult, type MergeDetails, type WorkflowStep, type WorkflowStepResult, type Settings, type AgentPromptsConfig } from "@fusion/core";
import { resolveAgentPrompt } from "@fusion/core";
import { createKbAgent, describeModel, promptWithFallback } from "./pi.js";
import type { WorktreePool } from "./worktree-pool.js";
import { AgentLogger } from "./agent-logger.js";
import { mergerLog } from "./logger.js";
import { isUsageLimitError, checkSessionError, type UsageLimitPauser } from "./usage-limit-detector.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { resolveAgentInstructions, buildSystemPromptWithInstructions } from "./agent-instructions.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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

const DEPENDENCY_SYNC_TRIGGER_PATTERNS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "packages/*/package.json",
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

export function getStagedFiles(cwd: string): string[] {
  try {
    const output = execSync("git diff --cached --name-only", {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function hasInstallState(rootDir: string): boolean {
  return existsSync(join(rootDir, "node_modules")) || existsSync(join(rootDir, ".pnp.cjs"));
}

export function shouldSyncDependenciesForMerge(
  stagedFiles: string[],
  installStatePresent: boolean,
): boolean {
  if (!installStatePresent) return true;
  return stagedFiles.some((file) =>
    DEPENDENCY_SYNC_TRIGGER_PATTERNS.some((pattern) => matchGlob(file, pattern)),
  );
}

function getDependencySyncCommand(rootDir: string): string | null {
  if (existsSync(join(rootDir, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
  if (existsSync(join(rootDir, "package-lock.json"))) return "npm install";
  if (existsSync(join(rootDir, "yarn.lock"))) return "yarn install --frozen-lockfile";
  if (existsSync(join(rootDir, "bun.lock")) || existsSync(join(rootDir, "bun.lockb"))) {
    return "bun install --frozen-lockfile";
  }
  return null;
}

async function syncDependenciesForMerge(
  store: TaskStore,
  rootDir: string,
  taskId: string,
): Promise<void> {
  const installCommand = getDependencySyncCommand(rootDir);
  if (!installCommand) return;

  mergerLog.log(`${taskId}: syncing dependencies before merge build verification`);
  await store.logEntry(taskId, `Syncing dependencies before merge build verification: ${installCommand}`);
  try {
    execSync(installCommand, {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (error: any) {
    const details = error?.stderr || error?.stdout || error?.message || String(error);
    throw new Error(`Dependency sync failed for ${taskId}: ${details}`.trim());
  }
}

// ── Pre-merge diffstat scope validation ──────────────────────────────

interface DiffFileEntry {
  file: string;
  insertions: number;
  deletions: number;
}

interface DiffScopeResult {
  warnings: string[];
  outOfScopeFiles: string[];
  largeOutOfScopeDeletions: { file: string; deletions: number }[];
}

/**
 * Parse git `--stat` output into per-file insertion/deletion counts.
 *
 * Example line: ` packages/core/src/types.ts | 9 ++--`
 * Binary line:  ` some/image.png            | Bin 0 -> 1234 bytes`
 */
export function parseDiffStat(diffStat: string): DiffFileEntry[] {
  const entries: DiffFileEntry[] = [];
  for (const line of diffStat.split("\n")) {
    // Skip the summary line ("5 files changed, 10 insertions(+), 3 deletions(-)")
    if (line.includes("files changed") || line.includes("file changed")) continue;
    // Match: " path/to/file | 42 +++---" or " path/to/file | Bin ..."
    const match = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+(\+*)(-*)\s*$/);
    if (!match) continue;
    const file = match[1].trim();
    const plusses = match[3].length;
    const minuses = match[4].length;
    // The number is total changes; +/- chars show the ratio
    const total = parseInt(match[2], 10);
    if (total === 0) continue;
    const ratio = plusses + minuses > 0 ? plusses / (plusses + minuses) : 0.5;
    entries.push({
      file,
      insertions: Math.round(total * ratio),
      deletions: Math.round(total * (1 - ratio)),
    });
  }
  return entries;
}

/**
 * Extract the `## File Scope` section from a PROMPT.md string.
 * Returns an array of file/glob patterns (lines starting with `- \``).
 */
export function extractFileScope(promptContent: string): string[] {
  const lines = promptContent.split("\n");
  const patterns: string[] = [];
  let inScope = false;
  for (const line of lines) {
    if (/^##\s+File Scope/.test(line)) {
      inScope = true;
      continue;
    }
    if (inScope && /^##\s/.test(line)) break; // next section
    if (inScope) {
      // Match "- `path/to/file`" or "- path/to/file"
      const m = line.match(/^-\s+`?([^`\s]+)`?\s*(?:\(.*\))?\s*$/);
      if (m) patterns.push(m[1]);
    }
  }
  return patterns;
}

/**
 * Check whether a file path matches any of the declared scope patterns.
 * Reuses the existing `matchGlob` helper. Also matches if the file is
 * inside a directory that's in scope (e.g., scope has `src/utils/*` and
 * file is `src/utils/helpers.ts`).
 */
function matchesScope(filePath: string, scopePatterns: string[]): boolean {
  for (const pattern of scopePatterns) {
    if (matchGlob(filePath, pattern)) return true;
    // Directory match: if pattern ends with /* or /**, check prefix
    const dirPattern = pattern.replace(/\/\*+$/, "");
    if (dirPattern !== pattern && filePath.startsWith(dirPattern + "/")) return true;
    // Exact directory match: scope says `src/foo/` and file is inside it
    if (pattern.endsWith("/") && filePath.startsWith(pattern)) return true;
    // Also match if both share the same directory
    const patternDir = pattern.lastIndexOf("/") >= 0 ? pattern.slice(0, pattern.lastIndexOf("/")) : "";
    const fileDir = filePath.lastIndexOf("/") >= 0 ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    if (patternDir && fileDir === patternDir) return true;
  }
  return false;
}

/**
 * Validate that the diff stays within the task's declared File Scope.
 * Returns warnings for out-of-scope changes, especially large deletions.
 *
 * When `strict` is true, throws an error on scope violations instead of
 * just returning warnings (hard guardrail that blocks merge).
 */
export async function validateDiffScope(
  store: TaskStore,
  taskId: string,
  diffStat: string,
  strict: boolean = false,
): Promise<DiffScopeResult> {
  const result: DiffScopeResult = { warnings: [], outOfScopeFiles: [], largeOutOfScopeDeletions: [] };

  // Parse the diffstat
  const entries = parseDiffStat(diffStat);
  if (entries.length === 0) return result;

  // Read the task's PROMPT.md for file scope
  let promptContent = "";
  try {
    const task = await store.getTask(taskId);
    promptContent = task.prompt || "";
  } catch {
    return result; // can't validate without prompt
  }

  const scopePatterns = extractFileScope(promptContent);
  if (scopePatterns.length === 0) return result; // no scope declared, skip

  // Check each changed file
  for (const entry of entries) {
    // Skip changeset files — always allowed
    if (entry.file.startsWith(".changeset/")) continue;

    if (!matchesScope(entry.file, scopePatterns)) {
      result.outOfScopeFiles.push(entry.file);

      // Flag large deletions outside scope (>50 net deletions or 100% deletions)
      const netDeletions = entry.deletions - entry.insertions;
      if (netDeletions > 50 || (entry.deletions > 0 && entry.insertions === 0)) {
        result.largeOutOfScopeDeletions.push({ file: entry.file, deletions: entry.deletions });
      }
    }
  }

  // Build warnings
  if (result.largeOutOfScopeDeletions.length > 0) {
    const files = result.largeOutOfScopeDeletions
      .map((d) => `${d.file} (${d.deletions} deletions)`)
      .join(", ");
    result.warnings.push(
      `⚠ SCOPE WARNING: Large deletions outside File Scope: ${files}`,
    );
  } else if (result.outOfScopeFiles.length > 3) {
    result.warnings.push(
      `⚠ SCOPE WARNING: ${result.outOfScopeFiles.length} files changed outside declared File Scope`,
    );
  }

  // In strict mode, scope violations block the merge
  if (strict && result.warnings.length > 0) {
    throw new Error(
      `Scope enforcement failed for ${taskId}: ${result.warnings.join("; ")}`,
    );
  }

  return result;
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

// Legacy types re-exported for backward compatibility (tests may reference them)
/** @deprecated Use ConflictType instead */
export type ConflictResolution = "ours" | "theirs";

/** @deprecated Use classifyConflict + getConflictedFiles instead */
export interface ConflictCategory {
  filePath: string;
  autoResolvable: boolean;
  strategy?: ConflictResolution;
  reason: "lock-file" | "generated-file" | "trivial" | "complex";
}

/**
 * Detect and categorize merge conflicts. Delegates to the new classifyConflict API.
 * @deprecated Use getConflictedFiles() + classifyConflict() instead.
 */
export function detectResolvableConflicts(rootDir: string): ConflictCategory[] {
  const files = getConflictedFiles(rootDir);
  return files.map((filePath): ConflictCategory => {
    const type = classifyConflict(filePath, rootDir);
    switch (type) {
      case "lockfile-ours":
        return { filePath, autoResolvable: true, strategy: "ours", reason: "lock-file" };
      case "generated-theirs":
        return { filePath, autoResolvable: true, strategy: "theirs", reason: "generated-file" };
      case "trivial-whitespace":
        return { filePath, autoResolvable: true, strategy: "ours", reason: "trivial" };
      case "complex":
        return { filePath, autoResolvable: false, reason: "complex" };
    }
  });
}

/**
 * Auto-resolve a single file using git checkout --ours or --theirs.
 * @deprecated Use resolveWithOurs() or resolveWithTheirs() instead.
 */
export function autoResolveFile(
  filePath: string,
  resolution: ConflictResolution,
  rootDir: string,
): void {
  if (resolution === "ours") {
    resolveWithOurs(filePath, rootDir);
  } else {
    resolveWithTheirs(filePath, rootDir);
  }
}

/**
 * Auto-resolve all resolvable conflicts from the categorization.
 * @deprecated Use classifyConflict + resolveWithOurs/resolveWithTheirs instead.
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
function buildMergeSystemPrompt(includeTaskId: boolean, agentPrompts?: AgentPromptsConfig): string {
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

  // Resolve the base merger prompt from agent prompts config, falling back to the inline default
  const basePrompt = resolveAgentPrompt("merger", agentPrompts);

  // If a custom merger prompt is configured, use it as the base with commit format appended
  const customAssignment = agentPrompts?.roleAssignments?.merger;
  if (customAssignment && basePrompt) {
    return `${basePrompt}

## Commit message
After all conflicts are resolved (or if there were none), write and execute the squash commit.

Look at the branch commits and diff to understand what was done, then run:
${commitFormat}

Do NOT use generic messages like "merge branch" or "resolve conflicts".
Base the message on the ACTUAL work done in the branch commits.

## Build verification

If a build command is configured for this project, build verification is a hard gate.
You MUST run the exact configured build command in this worktree before committing.
Do not assume the build passes. Do not describe it as passing unless you actually ran it
and the bash tool returned exit code 0.

1. Run the build command (shown in the prompt context below)
2. If the build succeeds (exit code 0), proceed with the commit
3. If the build fails (non-zero exit code), DO NOT commit. Instead:
   - Call the \`report_build_failure\` tool with the real error details
   - Stop immediately and do not run \`git commit\`
   - Do not claim success in plain text

The merge will only be completed if the build passes or no build command is configured.`;
  }

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
Base the message on the ACTUAL work done in the branch commits.

## Build verification

If a build command is configured for this project, build verification is a hard gate.
You MUST run the exact configured build command in this worktree before committing.
Do not assume the build passes. Do not describe it as passing unless you actually ran it
and the bash tool returned exit code 0.

1. Run the build command (shown in the prompt context below)
2. If the build succeeds (exit code 0), proceed with the commit
3. If the build fails (non-zero exit code), DO NOT commit. Instead:
   - Call the \`report_build_failure\` tool with the real error details
   - Stop immediately and do not run \`git commit\`
   - Do not claim success in plain text

The merge will only be completed if the build passes or no build command is configured.`;
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
  /** AgentStore for resolving per-agent custom instructions. */
  agentStore?: import("@fusion/core").AgentStore;
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
  const mergeBlocker = getTaskMergeBlocker(task);
  if (mergeBlocker) {
    throw new Error(`Cannot merge ${taskId}: ${mergeBlocker}`);
  }

  const branch = task.branch || `fusion/${taskId.toLowerCase()}`;
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
    // Best-effort: try to capture current HEAD commitSha even though branch is missing
    try {
      const commitSha = execSync("git rev-parse HEAD", {
        cwd: rootDir,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim() || undefined;
      if (commitSha) {
        await store.updateTask(taskId, {
          mergeDetails: {
            commitSha,
            mergedAt: new Date().toISOString(),
            mergeConfirmed: false,
          },
        });
        mergerLog.log(`${taskId}: branch not found but captured commitSha ${commitSha.slice(0, 8)}`);
      }
    } catch {
      // No commit SHA available — task will show summary fallback
    }
    await completeTask(store, taskId, result);
    return result;
  }

  // 3b. Ensure rootDir is on the main branch before merging.
  // Without this, a merge could land on whatever branch was last checked out,
  // causing feature code to be committed to the wrong lineage.
  try {
    const currentBranch = execSync("git symbolic-ref --short HEAD", {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const mainBranch = execSync("git rev-parse --abbrev-ref origin/HEAD", {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim().replace(/^origin\//, "");
    if (currentBranch !== mainBranch) {
      mergerLog.log(`${taskId}: rootDir on '${currentBranch}', checking out '${mainBranch}' before merge`);
      execSync(`git checkout "${mainBranch}"`, {
        cwd: rootDir,
        stdio: "pipe",
      });
    }
  } catch {
    // Fallback: try checking out main directly
    try {
      execSync("git checkout main", { cwd: rootDir, stdio: "pipe" });
    } catch {
      mergerLog.warn(`${taskId}: unable to verify/checkout main branch — proceeding on current HEAD`);
    }
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
    const mergeBase = execSync(`git merge-base HEAD ${branch}`, {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();
    diffStat = execSync(`git diff ${mergeBase}..${branch} --stat`, {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();
  } catch {
    diffStat = "(unable to read diff)";
  }

  // 4b. Validate diff scope against task's declared File Scope
  try {
    const scopeResult = await validateDiffScope(store, taskId, diffStat, settings.strictScopeEnforcement);
    for (const warning of scopeResult.warnings) {
      mergerLog.warn(`${taskId}: ${warning}`);
      await store.logEntry(taskId, warning);
    }
  } catch (scopeError: any) {
    if (settings.strictScopeEnforcement && scopeError.message?.includes("Scope enforcement failed")) {
      // Strict mode — block the merge
      await store.logEntry(taskId, `Merge blocked: ${scopeError.message}`);
      throw scopeError;
    }
    // Soft mode — scope validation is best-effort
  }

  // 5. Execute merge with retry logic
  await store.updateTask(taskId, { status: "merging" });

  const mergeAttempt = async (attemptNum: 1 | 2 | 3): Promise<boolean> => {
    mergerLog.log(`${taskId}: merge attempt ${attemptNum}/3...`);

    // Normalize buildCommand: treat empty string as undefined
    const buildCommand = settings.buildCommand?.trim() || undefined;

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
        buildCommand,
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
      // Check if it's a build verification failure
      if (error.message?.includes("Build verification failed")) {
        const buildRetryCount = settings.buildRetryCount ?? 0;
        if (buildRetryCount > 0 && !result._buildRetried) {
          // Allow one build retry — reset merge state and re-attempt same strategy
          mergerLog.log(`${taskId}: build failed, retrying (${buildRetryCount} retry allowed)...`);
          await store.logEntry(taskId, "Build failed — retrying merge attempt");
          result._buildRetried = true;
          try {
            execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
          } catch { /* ignore cleanup errors */ }
          return false; // Retry
        }
        throw error; // No retries left — fatal
      }

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

  // 5b. Collect merge details and store on task
  try {
    const commitSha = execSync("git rev-parse HEAD", {
      cwd: rootDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim() || undefined;

    let filesChanged: number | undefined;
    let insertions: number | undefined;
    let deletions: number | undefined;

    try {
      const statsOutput = execSync("git show --shortstat --format= HEAD", {
        cwd: rootDir,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
      const normalized = statsOutput.replace(/\n/g, " ");
      const filesMatch = normalized.match(/(\d+) files? changed/);
      const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
      const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);
      filesChanged = filesMatch ? Number.parseInt(filesMatch[1], 10) : 0;
      insertions = insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0;
      deletions = deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0;
    } catch { /* non-fatal */ }

    const mergeDetails: MergeDetails = {
      commitSha,
      filesChanged,
      insertions,
      deletions,
      mergeCommitMessage: commitLog,
      mergedAt: new Date().toISOString(),
      mergeConfirmed: true,
      resolutionStrategy: result.resolutionStrategy,
      resolutionMethod: result.resolutionMethod,
      attemptsMade: result.attemptsMade,
      autoResolvedCount: result.autoResolvedCount,
    };

    await store.updateTask(taskId, { mergeDetails });
    mergerLog.log(`${taskId}: merge details stored (commitSha: ${commitSha?.slice(0, 8)})`);
  } catch (err: any) {
    mergerLog.warn(`${taskId}: failed to collect/store merge details: ${err.message}`);
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

  // 8. Run post-merge workflow steps (failures logged but do not block completion)
  try {
    await runPostMergeWorkflowSteps(store, taskId, rootDir, settings, options);
  } catch (err: any) {
    mergerLog.error(`${taskId}: post-merge workflow steps error: ${err.message}`);
    // Non-fatal — task still moves to done
  }

  // 9. Move task to done
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
  buildCommand?: string;
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
    buildCommand,
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

    if (buildCommand) {
      const stagedFiles = getStagedFiles(rootDir);
      if (shouldSyncDependenciesForMerge(stagedFiles, hasInstallState(rootDir))) {
        await syncDependenciesForMerge(store, rootDir, taskId);
      }
    }

    // At this point, either:
    // - No conflicts (attempt 1) - AI writes commit message
    // - Complex conflicts remain after attempt 2 auto-resolution - AI resolves them
    // Spawn AI agent
    aiTracker.aiWasInvoked = true; // Track that AI was invoked
    const agentResult = await runAiAgentForCommit({
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
      buildCommand,
    });

    // Handle build failure
    if (!agentResult.success) {
      // Build verification failed - log, reset staged changes, and throw
      const errorMessage = agentResult.error || "Build verification failed";
      await store.logEntry(taskId, "Build verification failed during merge", errorMessage);
      
      // Reset staged changes to abort the merge
      try {
        execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
      } catch {
        // Ignore reset errors
      }
      
      throw new Error(`Build verification failed for ${taskId}: ${errorMessage}`);
    }

    return true;
  } catch (error: any) {
    // Check if it's a build verification failure - don't retry, propagate immediately
    if (error.message?.includes("Build verification failed")) {
      throw error; // Fatal - don't retry build failures
    }
    
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
  buildCommand?: string;
}

/**
 * Run the AI agent to resolve conflicts and/or write commit message.
 * Returns { success: true } on success, { success: false, error: string } on build failure.
 * Throws on agent errors or unrecoverable failures.
 */
async function runAiAgentForCommit(params: AiAgentParams): Promise<{ success: boolean; error?: string }> {
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
    buildCommand,
  } = params;

  const settings = await store.getSettings();

  // Track build failure state
  let buildFailed = false;
  let buildErrorMessage = "";

  // Create custom tool for reporting build failures
  const reportBuildFailureTool: ToolDefinition = {
    name: "report_build_failure",
    label: "Report Build Failure",
    description: "Report that the build verification failed. Use this when the build command returns a non-zero exit code. Provide the error details in the message parameter.",
    parameters: Type.Object({
      message: Type.String({ description: "Error message describing why the build failed" }),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const { message } = params as { message: string };
      buildFailed = true;
      buildErrorMessage = message;
      return { 
        content: [{ type: "text", text: `Build failure reported: ${message}` }],
        details: undefined 
      };
    },
  };

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

  // Resolve per-agent custom instructions for the merger role
  let mergerInstructions = "";
  if (options.agentStore) {
    try {
      const agents = await options.agentStore.listAgents({ role: "merger" });
      for (const agent of agents) {
        if (agent.instructionsText || agent.instructionsPath) {
          mergerInstructions = await resolveAgentInstructions(agent, rootDir);
          break;
        }
      }
    } catch {
      // Graceful fallback
    }
  }
  const mergerSystemPrompt = buildSystemPromptWithInstructions(
    buildMergeSystemPrompt(includeTaskId, settings.agentPrompts),
    mergerInstructions,
  );

  const { session } = await createKbAgent({
    cwd: rootDir,
    systemPrompt: mergerSystemPrompt,
    tools: "coding",
    customTools: [reportBuildFailureTool],
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
      buildCommand,
    });
    await withRateLimitRetry(async () => {
      await promptWithFallback(session, prompt);
      checkSessionError(session);
    }, {
      onRetry: (attempt, delayMs, error) => {
        const delaySec = Math.round(delayMs / 1000);
        mergerLog.warn(`⏳ ${taskId} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
      },
    });

    // Check if build failed
    if (buildFailed) {
      mergerLog.error(`Build verification failed for ${taskId}: ${buildErrorMessage}`);
      return { success: false, error: buildErrorMessage };
    }

    // Verify commit happened
    const staged = execSync("git diff --cached --quiet 2>&1; echo $?", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();

    if (staged !== "0") {
      // Only use fallback commit if no build command was configured
      // If build command was configured, agent should have committed or reported failure
      if (!buildCommand) {
        mergerLog.log("Agent didn't commit — committing with fallback message");
        const escapedLog = commitLog.replace(/"/g, '\\"');
        const fallbackPrefix = includeTaskId ? `feat(${taskId})` : "feat";
        execSync(
          `git commit -m "${fallbackPrefix}: merge ${branch}" -m "${escapedLog}"`,
          { cwd: rootDir, stdio: "pipe" },
        );
      } else {
        // Build command was configured but agent didn't commit and didn't report failure
        // This is an error condition - agent didn't follow instructions
        throw new Error(`Agent did not commit and did not report build failure for ${taskId}`);
      }
    }

    return { success: true };
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
  buildCommand?: string;
}

function buildMergePrompt(params: MergePromptParams): string {
  const { taskId, branch, commitLog, diffStat, hasConflicts, simplifiedContext, buildCommand } = params;

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

  // Add build command section if provided
  if (buildCommand) {
    parts.push(
      "",
      "## Build command",
      `Build command: \`${buildCommand}\``,
      "",
      "This command is mandatory before commit.",
      "Run it with the bash tool in the current worktree and inspect the actual exit code.",
      "Only commit if it exits 0.",
      "If it exits non-zero, call `report_build_failure` with the concrete error output and stop without committing.",
    );
  }

  return parts.join("\n");
}

/**
 * Run post-merge workflow steps for a task after the merge succeeds.
 * These steps run in the root directory (after merge, worktree may be cleaned up).
 * Failures are logged but do NOT block task completion — the merge is already committed.
 */
async function runPostMergeWorkflowSteps(
  store: TaskStore,
  taskId: string,
  rootDir: string,
  settings: Settings,
  mergeOptions: MergerOptions = {},
): Promise<void> {
  const task = await store.getTask(taskId);
  if (!task.enabledWorkflowSteps?.length) return;

  // Get existing pre-merge results to append to
  const existingResults: WorkflowStepResult[] = task.workflowStepResults || [];

  for (const wsId of task.enabledWorkflowSteps) {
    const ws = await store.getWorkflowStep(wsId);
    if (!ws) {
      mergerLog.log(`${taskId}: [post-merge] workflow step ${wsId} not found — skipping`);
      continue;
    }

    // Normalize legacy steps: undefined phase → "pre-merge"
    const stepPhase = ws.phase || "pre-merge";

    // Only run post-merge steps here
    if (stepPhase !== "post-merge") continue;

    // Normalize legacy steps without mode to prompt-mode
    const stepMode: "prompt" | "script" = ws.mode || "prompt";

    // Skip validation per mode
    if (stepMode === "prompt" && !ws.prompt?.trim()) {
      await store.logEntry(taskId, `[post-merge] Workflow step '${ws.name}' has no prompt — skipping`);
      existingResults.push({
        workflowStepId: ws.id,
        workflowStepName: ws.name,
        phase: "post-merge",
        status: "skipped",
        output: "No prompt configured for this workflow step",
      });
      await store.updateTask(taskId, { workflowStepResults: existingResults });
      continue;
    }

    if (stepMode === "script" && !ws.scriptName?.trim()) {
      await store.logEntry(taskId, `[post-merge] Workflow step '${ws.name}' has no scriptName — skipping`);
      existingResults.push({
        workflowStepId: ws.id,
        workflowStepName: ws.name,
        phase: "post-merge",
        status: "skipped",
        output: "No scriptName configured for this workflow step",
      });
      await store.updateTask(taskId, { workflowStepResults: existingResults });
      continue;
    }

    await store.logEntry(taskId, `[post-merge] Starting workflow step: ${ws.name} (${stepMode} mode)`);
    mergerLog.log(`${taskId}: [post-merge] running workflow step: ${ws.name} (${stepMode} mode)`);

    const startedAt = new Date().toISOString();

    try {
      const result = stepMode === "script"
        ? await executePostMergeScriptStep(store, taskId, ws, rootDir, settings)
        : await executePostMergePromptStep(store, taskId, ws, rootDir, settings, mergeOptions);
      const completedAt = new Date().toISOString();

      if (result.success) {
        await store.logEntry(taskId, `[post-merge] Workflow step completed: ${ws.name}`);
        mergerLog.log(`${taskId}: [post-merge] workflow step passed: ${ws.name}`);
        existingResults.push({
          workflowStepId: ws.id,
          workflowStepName: ws.name,
          phase: "post-merge",
          status: "passed",
          output: result.output,
          startedAt,
          completedAt,
        });
      } else {
        // Post-merge failures are logged but do NOT block task completion
        await store.logEntry(taskId, `[post-merge] Workflow step failed: ${ws.name}`, result.error || "Unknown error");
        mergerLog.error(`${taskId}: [post-merge] workflow step failed: ${ws.name} — ${result.error}`);
        existingResults.push({
          workflowStepId: ws.id,
          workflowStepName: ws.name,
          phase: "post-merge",
          status: "failed",
          output: result.error || "Workflow step failed",
          startedAt,
          completedAt,
        });
      }
    } catch (err: any) {
      const completedAt = new Date().toISOString();
      await store.logEntry(taskId, `[post-merge] Workflow step error: ${ws.name}`, err.message || "Unknown error");
      mergerLog.error(`${taskId}: [post-merge] workflow step error: ${ws.name} — ${err.message}`);
      existingResults.push({
        workflowStepId: ws.id,
        workflowStepName: ws.name,
        phase: "post-merge",
        status: "failed",
        output: err.message || "Workflow step error",
        startedAt,
        completedAt,
      });
    }

    // Save results after each step (partial results preserved on crash)
    await store.updateTask(taskId, { workflowStepResults: existingResults });
  }
}

/** Execute a script-mode post-merge workflow step */
async function executePostMergeScriptStep(
  store: TaskStore,
  taskId: string,
  workflowStep: WorkflowStep,
  rootDir: string,
  settings: Settings,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const scriptName = workflowStep.scriptName!.trim();
  const scripts = settings.scripts || {};
  const scriptCommand = scripts[scriptName];

  if (!scriptCommand) {
    return { success: false, error: `Script '${scriptName}' not found in project settings` };
  }

  try {
    const output = execSync(scriptCommand, {
      cwd: rootDir,
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { success: true, output: output.trim() };
  } catch (err: any) {
    const stderr = err.stderr?.toString()?.trim() || "";
    const stdout = err.stdout?.toString()?.trim() || "";
    const exitCode = err.status;
    const parts: string[] = [];
    if (exitCode !== undefined) parts.push(`Exit code: ${exitCode}`);
    if (stdout) parts.push(`stdout: ${stdout}`);
    if (stderr) parts.push(`stderr: ${stderr}`);
    if (!parts.length) parts.push(err.message || "Unknown error");
    return { success: false, error: parts.join("\n") };
  }
}

/** Execute a prompt-mode post-merge workflow step using AI agent */
async function executePostMergePromptStep(
  store: TaskStore,
  taskId: string,
  workflowStep: WorkflowStep,
  rootDir: string,
  settings: Settings,
  mergeOptions: MergerOptions = {},
): Promise<{ success: boolean; output?: string; error?: string }> {
  const toolMode: "coding" | "readonly" = workflowStep.toolMode || "readonly";
  const systemPrompt = `You are a post-merge workflow step agent executing: ${workflowStep.name}

Task Context:
- Task ID: ${taskId}
- The merge has already been completed successfully.
- You are running in the project's root directory with the merged code.

Your Instructions:
${workflowStep.prompt}

You have access to the file system to review the merged changes.
When your review is complete and everything looks good, simply state your findings.
If issues are found that need attention, describe them clearly.`;

  const agentLogger = new AgentLogger({
    store,
    taskId,
    agent: "merger",
  });

  try {
    const stepProvider = workflowStep.modelProvider || settings.defaultProvider;
    const stepModelId = workflowStep.modelId || settings.defaultModelId;
    const useOverride = !!(workflowStep.modelProvider && workflowStep.modelId);

    // Post-merge step agents inherit merger instructions
    let postMergeInstructions = "";
    if (mergeOptions.agentStore) {
      try {
        const agents = await mergeOptions.agentStore.listAgents({ role: "merger" });
        for (const agent of agents) {
          if (agent.instructionsText || agent.instructionsPath) {
            postMergeInstructions = await resolveAgentInstructions(agent, rootDir);
            break;
          }
        }
      } catch {
        // Graceful fallback
      }
    }
    const postMergeSystemPrompt = buildSystemPromptWithInstructions(systemPrompt, postMergeInstructions);

    const { session } = await createKbAgent({
      cwd: rootDir,
      systemPrompt: postMergeSystemPrompt,
      tools: toolMode,
      defaultProvider: stepProvider,
      defaultModelId: stepModelId,
      fallbackProvider: settings.fallbackProvider,
      fallbackModelId: settings.fallbackModelId,
      defaultThinkingLevel: settings.defaultThinkingLevel,
    });

    mergerLog.log(`${taskId}: [post-merge] workflow step '${workflowStep.name}' using model ${describeModel(session)}${useOverride ? " (workflow step override)" : ""}`);
    await store.logEntry(taskId, `[post-merge] Workflow step '${workflowStep.name}' using model: ${describeModel(session)}${useOverride ? " (workflow step override)" : ""}`);

    let output = "";
    session.subscribe((event) => {
      if (event.type === "message_update") {
        const msgEvent = event.assistantMessageEvent;
        if (msgEvent.type === "text_delta") {
          output += msgEvent.delta;
        }
      }
    });

    await promptWithFallback(
      session,
      `Execute the post-merge workflow step "${workflowStep.name}" for task ${taskId}.\n\n` +
      `Review the merged code in the project root and evaluate it against your instructions.`,
    );

    checkSessionError(session);
    session.dispose();
    await agentLogger.flush();

    return { success: true, output };
  } catch (err: any) {
    await agentLogger.flush();
    return { success: false, error: err.message };
  }
}

async function completeTask(
  store: TaskStore,
  taskId: string,
  result: MergeResult,
): Promise<void> {
  mergerLog.log(`${taskId}: completeTask — clearing status, moving to done`);
  // Clear transient status before moving to done
  await store.updateTask(taskId, { status: null });
  // Use moveTask for proper event emission
  const task = await store.moveTask(taskId, "done");
  result.task = task;
  store.emit("task:merged", result);
}
