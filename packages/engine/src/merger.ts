/* eslint-disable @typescript-eslint/no-explicit-any */
import { execSync, exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
import {
  runVerificationCommand as runVerificationCommandShared,
  summarizeVerificationOutput,
  truncateWithEllipsis,
  VERIFICATION_COMMAND_MAX_BUFFER,
  VERIFICATION_LOG_MAX_CHARS,
  type VerificationCommandResult,
  type VerificationResult,
} from "./verification-utils.js";

// Re-export for backward compatibility (tests import from merger.ts)
export {
  execWithProcessGroup,
  summarizeVerificationOutput,
  truncateWithEllipsis,
  VERIFICATION_COMMAND_MAX_BUFFER,
  VERIFICATION_COMMAND_TIMEOUT_MS,
  VERIFICATION_LOG_MAX_CHARS,
  type VerificationCommandResult,
  type VerificationResult,
} from "./verification-utils.js";

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { hostname } from "node:os";
import {
  getTaskMergeBlocker,
  normalizeMergeConflictStrategy,
  resolveProjectDefaultModel,
  resolveTitleSummarizerSettingsModel,
  resolveAgentPrompt,
  summarizeCommitBody,
  summarizeCommitSubject,
  summarizeMergeCommit,
  type TaskStore,
  type AutostashOutcome,
  type MergeResult,
  type MergeDetails,
  type WorkflowStep,
  type WorkflowStepResult,
  type Settings,
  type AgentPromptsConfig,
  type CanonicalMergeConflictStrategy,
  type TaskSourceIssue,
  type Task,
} from "@fusion/core";
import { describeModel, promptWithFallback } from "./pi.js";
import { accumulateSessionTokenUsage } from "./session-token-usage.js";
import { createResolvedAgentSession, extractRuntimeHint } from "./agent-session-helpers.js";
import { createFallbackModelObserver } from "./fallback-model-observer.js";
import { buildSessionSkillContext } from "./session-skill-context.js";
import type { WorktreePool } from "./worktree-pool.js";
import { AgentLogger } from "./agent-logger.js";
import { mergerLog } from "./logger.js";
import { isUsageLimitError, checkSessionError, type UsageLimitPauser } from "./usage-limit-detector.js";
import { isContextLimitError } from "./context-limit-detector.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { resolveAgentInstructions, buildSystemPromptWithInstructions } from "./agent-instructions.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { createRunAuditor, generateSyntheticRunId, type EngineRunContext } from "./run-audit.js";
import { createWebFetchTool } from "./agent-tools.js";

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

const WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS = 4_000;
const PULL_REBASE_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 60_000;

/** Maximum characters for commit log in merge prompt — prevents context overflow on large branches */
const MERGE_COMMIT_LOG_MAX_CHARS = 5000;

/** Maximum characters for diff stat in merge prompt — prevents context overflow on large diffs */
const MERGE_DIFF_STAT_MAX_CHARS = 3000;

/**
 * @deprecated Use summarizeVerificationOutput from verification-utils.js instead
 */
export const summarizeVerificationOutputLocal = summarizeVerificationOutput;

function truncateWorkflowScriptOutput(output: string): string {
  if (output.length <= WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS) return output;
  return `... output truncated to last ${WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS} characters ...\n${output.slice(-WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS)}`;
}

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

export async function getStagedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git diff --cached --name-only", {
      cwd,
      encoding: "utf-8",
    });
    const output = stdout.trim();
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

const INSTALL_MARKER_RELPATH = join("node_modules", ".fusion-install-marker");
const LOCKFILE_CANDIDATES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "bun.lock"];

function computeLockfileHash(rootDir: string): string | null {
  for (const name of LOCKFILE_CANDIDATES) {
    const p = join(rootDir, name);
    if (existsSync(p)) {
      try {
        return createHash("sha256").update(readFileSync(p)).digest("hex");
      } catch {
        return null;
      }
    }
  }
  return null;
}

function readInstallMarker(rootDir: string): string | null {
  try {
    const value = readFileSync(join(rootDir, INSTALL_MARKER_RELPATH), "utf-8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function writeInstallMarker(rootDir: string, hash: string): void {
  try {
    writeFileSync(join(rootDir, INSTALL_MARKER_RELPATH), hash);
  } catch {
    // Best-effort: a missing marker just means the next merge re-runs install.
  }
}

async function syncDependenciesForMerge(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<void> {
  const installCommand = getDependencySyncCommand(rootDir);
  if (!installCommand) return;

  // Skip the install if node_modules is present and the lockfile content
  // matches the hash recorded after the last successful install. Caller's
  // shouldSyncDependenciesForMerge gate already filters most no-ops; this
  // covers the case where package.json (but not the lockfile) is staged, and
  // the case where multiple merge attempts hit the same worktree in a row.
  const lockHash = computeLockfileHash(rootDir);
  if (lockHash && hasInstallState(rootDir) && readInstallMarker(rootDir) === lockHash) {
    mergerLog.log(`${taskId}: skipping dependency sync (lockfile unchanged since last install)`);
    await store.logEntry(
      taskId,
      `Skipping dependency sync: lockfile hash matches last successful ${installCommand}`,
    );
    return;
  }

  throwIfAborted(signal, taskId);
  mergerLog.log(`${taskId}: syncing dependencies before merge build verification`);
  await store.logEntry(taskId, `Syncing dependencies before merge build verification: ${installCommand}`);
  try {
    await execAsync(installCommand, {
      cwd: rootDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000,
    });
    throwIfAborted(signal, taskId);
    if (lockHash) writeInstallMarker(rootDir, lockHash);
  } catch (error: any) {
    throwIfAborted(signal, taskId);
    const details = error?.stderr || error?.stdout || error?.message || String(error);
    throw new Error(`Dependency sync failed for ${taskId}: ${details}`.trim());
  }
}

// ── Default test command inference ────────────────────────────────────

/** Result of inferring a default test command */
interface InferredTestCommand {
  command: string;
  /** Source indicates whether this was explicitly configured or inferred from project files */
  testSource: "explicit" | "inferred";
  buildSource?: "explicit" | "inferred";
}

interface OwnedLandedCommit {
  sha: string;
  subject?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

function commitOwnedByTask(taskId: string, subject: string, body: string): boolean {
  return body.includes(`${FUSION_TASK_ID_TRAILER_KEY}: ${taskId}`) || subject.includes(taskId);
}

async function findOwnedLandedCommitForTask(rootDir: string, task: Task): Promise<OwnedLandedCommit | null> {
  const tryHydrate = async (sha: string): Promise<OwnedLandedCommit | null> => {
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: rootDir });
      const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%H%x1f%s%x1f%b", sha], {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const [resolvedSha, subject = "", body = ""] = stdout.trim().split("\x1f");
      if (!resolvedSha || !commitOwnedByTask(task.id, subject, body)) return null;
      const owned: OwnedLandedCommit = { sha: resolvedSha, subject };
      try {
        const { stdout: statsOut } = await execFileAsync("git", ["show", "--shortstat", "--format=", resolvedSha], {
          cwd: rootDir,
          encoding: "utf-8",
        });
        Object.assign(owned, parseDiffStat(statsOut));
      } catch {
        // stats optional
      }
      return owned;
    } catch {
      return null;
    }
  };

  if (task.mergeDetails?.commitSha) {
    const ownedStored = await tryHydrate(task.mergeDetails.commitSha);
    if (ownedStored) return ownedStored;
  }

  const trailer = `${FUSION_TASK_ID_TRAILER_KEY}: ${task.id}`;
  const searches: string[][] = [
    ["log", "--format=%H%x1f%s", "--max-count=20", "--fixed-strings", `--grep=${trailer}`, "HEAD"],
    ["log", "--format=%H%x1f%s", "--max-count=20", "--fixed-strings", `--grep=${task.id}`, "HEAD"],
  ];

  for (const args of searches) {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: rootDir, encoding: "utf-8" });
      const first = stdout.trim().split("\n").find(Boolean);
      if (!first) continue;
      const [sha] = first.split("\x1f");
      if (!sha) continue;
      const owned = await tryHydrate(sha);
      if (owned) return owned;
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Infer a default test command based on project files.
 * Returns the command and whether it was explicitly configured or inferred.
 *
 * Inference rules:
 * - pnpm-lock.yaml → "pnpm test"
 * - yarn.lock → "yarn test"
 * - bun.lock/bun.lockb → "bun test"
 * - package-lock.json → "npm test"
 *
 * Returns null if no test command can be inferred.
 */
export function inferDefaultTestCommand(
  rootDir: string,
  explicitTestCommand?: string,
  explicitBuildCommand?: string,
): InferredTestCommand | null {
  // If explicit test command is set, use it (no inference needed)
  if (explicitTestCommand?.trim()) {
    return {
      command: explicitTestCommand.trim(),
      testSource: "explicit",
      buildSource: explicitBuildCommand?.trim() ? "explicit" : undefined,
    };
  }

  // Infer test command from lock files
  if (existsSync(join(rootDir, "pnpm-lock.yaml"))) {
    // Monorepo heuristic: a pnpm-workspace.yaml means `pnpm test` will fan out
    // across every workspace package on every merge, which is usually far slower
    // than necessary. Warn so the user sets an explicit scoped testCommand
    // (e.g. `pnpm -r --filter "...[main]" test`). We don't auto-scope because
    // the default branch name isn't guaranteed and git context may be unavailable.
    if (existsSync(join(rootDir, "pnpm-workspace.yaml"))) {
      mergerLog.warn(
        `Inferred test command "pnpm test" in a pnpm workspace (${rootDir}). ` +
        `This runs the full monorepo suite on every merge. Consider setting an explicit ` +
        `scoped testCommand in project settings, e.g. \`pnpm -r --filter "...[main]" test\`.`,
      );
    }
    return {
      command: "pnpm test",
      testSource: "inferred",
      buildSource: explicitBuildCommand?.trim() ? "explicit" : undefined,
    };
  }

  if (existsSync(join(rootDir, "yarn.lock"))) {
    return {
      command: "yarn test",
      testSource: "inferred",
      buildSource: explicitBuildCommand?.trim() ? "explicit" : undefined,
    };
  }

  if (existsSync(join(rootDir, "bun.lock")) || existsSync(join(rootDir, "bun.lockb"))) {
    return {
      command: "bun test",
      testSource: "inferred",
      buildSource: explicitBuildCommand?.trim() ? "explicit" : undefined,
    };
  }

  if (existsSync(join(rootDir, "package-lock.json"))) {
    return {
      command: "npm test",
      testSource: "inferred",
      buildSource: explicitBuildCommand?.trim() ? "explicit" : undefined,
    };
  }

  // No inference possible — return null, letting the caller decide what to do
  return null;
}

// ── Deterministic merge verification ──────────────────────────────────

/**
 * Run verification commands deterministically in the engine.
 * Executes testCommand first, then buildCommand (when both are configured).
 * Returns structured results so failures are logged with actionable detail.
 * Throws VerificationError on failure with command details.
 */
export class VerificationError extends Error {
  constructor(
    message: string,
    public readonly verificationResult: VerificationResult,
  ) {
    super(message);
    this.name = "VerificationError";
  }
}

/** Raised when a merge is explicitly cancelled (for example engine shutdown). */
export class MergeAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeAbortedError";
  }
}

export function throwIfAborted(signal: AbortSignal | undefined, taskId: string): void {
  if (!signal?.aborted) return;
  throw new MergeAbortedError(`Merge aborted for ${taskId}: engine shutdown requested`);
}

/**
 * Return the union of all dirty paths in `rootDir`:
 * - tracked files modified vs the index (`git diff --name-only`)
 * - staged but not yet committed (`git diff --cached --name-only`)
 * - untracked files (`git status --porcelain` lines starting with `??`)
 *
 * Errors are swallowed and an empty set is returned so callers are never
 * blocked by a failing porcelain query.
 *
 * All three git queries use NUL-delimited output (`-z`) so paths with
 * embedded spaces or special characters are parsed correctly without quoting.
 */
export async function snapshotDirtyFiles(rootDir: string): Promise<Set<string>> {
  const paths = new Set<string>();
  try {
    const [unstagedOut, stagedOut, porcelainOut] = await Promise.all([
      execFileAsync("git", ["diff", "-z", "--name-only"], { cwd: rootDir, encoding: "utf-8" }).then(
        (r) => r.stdout,
        () => "",
      ),
      execFileAsync("git", ["diff", "-z", "--cached", "--name-only"], { cwd: rootDir, encoding: "utf-8" }).then(
        (r) => r.stdout,
        () => "",
      ),
      execFileAsync("git", ["status", "-z", "--porcelain"], { cwd: rootDir, encoding: "utf-8" }).then(
        (r) => r.stdout,
        () => "",
      ),
    ]);

    for (const entry of unstagedOut.split("\0")) {
      const p = entry.trim();
      if (p) paths.add(p);
    }
    for (const entry of stagedOut.split("\0")) {
      const p = entry.trim();
      if (p) paths.add(p);
    }
    // Untracked files: entries beginning with `?? ` (3-char prefix, no quoting in -z mode)
    for (const entry of porcelainOut.split("\0")) {
      if (!entry.startsWith("?? ")) continue;
      const p = entry.slice(3);
      if (p) paths.add(p);
    }
  } catch {
    // Best-effort — an empty snapshot is safe: the allowlist logic will simply
    // not add any fix-agent files, which is conservative.
  }
  return paths;
}

/**
 * Hash the working tree's dirty content (full diff against HEAD plus porcelain
 * status). Returns "" on failure or when nothing is dirty. Used to detect
 * whether an in-merge fix agent actually changed anything before paying for
 * a verification re-run.
 */
async function gitDirtyFingerprint(rootDir: string): Promise<string> {
  try {
    const [diffOut, statusOut] = await Promise.all([
      execFileAsync("git", ["diff", "HEAD"], {
        cwd: rootDir,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      }).then((r) => r.stdout, () => ""),
      execFileAsync("git", ["status", "-z", "--porcelain"], { cwd: rootDir, encoding: "utf-8" }).then(
        (r) => r.stdout,
        () => "",
      ),
    ]);
    if (!diffOut && !statusOut) return "";
    return createHash("sha256").update(diffOut).update("\0").update(statusOut).digest("hex");
  } catch {
    return "";
  }
}

function rethrowIfMergeAborted(error: unknown): void {
  if (error instanceof Error && error.name === "MergeAbortedError") {
    throw error;
  }
}

/**
 * Run execSync and always return a trimmed UTF-8 string.
 * execSync may return a Buffer, string, or null depending on the encoding option;
 * this helper normalises all three cases.
 */
function execSyncText(command: string, options: Parameters<typeof execSync>[1]): string {
  const output = execSync(command, options);
  if (output == null) return "";
  if (typeof output === "string") return output.trim();
  return (output as Buffer).toString("utf-8").trim();
}

/** Extra environment variables injected into verification child processes to boost concurrency. */
const VERIFICATION_EXTRA_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  (
    [
      ["FUSION_TEST_TOTAL_WORKERS", "8"],
      ["FUSION_TEST_CONCURRENCY", "4"],
      ["FUSION_TEST_WORKSPACE_CONCURRENCY", "4"],
    ] as [string, string][]
  ).filter(([key]) => !(key in process.env)),
);

async function runDeterministicVerification(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  testCommand?: string,
  buildCommand?: string,
  testSource?: "explicit" | "inferred",
  buildSource?: "explicit" | "inferred",
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const result: VerificationResult = { allPassed: true };

  // Nothing to verify
  if (!testCommand && !buildCommand) {
    mergerLog.log(`${taskId}: no verification commands configured — skipping`);
    return result;
  }

  const normalizedTestCommand = testCommand?.trim();
  const normalizedBuildCommand = buildCommand?.trim();
  const hasTestCommand = !!normalizedTestCommand;
  const hasBuildCommand = !!normalizedBuildCommand;

  // ── Tree-hash verification cache (Layer 1) ─────────────────────────────
  const effectiveTestCommand = normalizedTestCommand ?? "";
  const effectiveBuildCommand = normalizedBuildCommand ?? "";
  let treeSha: string | null = null;
  try {
    treeSha = execSync("git rev-parse HEAD^{tree}", { cwd: rootDir, stdio: "pipe" })
      .toString()
      .trim();
  } catch (err) {
    mergerLog.warn(`${taskId}: could not resolve tree sha — skipping verification cache: ${String(err)}`);
  }

  if (treeSha) {
    const cacheHit = store.getVerificationCacheHit(treeSha, effectiveTestCommand, effectiveBuildCommand);
    if (cacheHit) {
      const sha7 = treeSha.slice(0, 7);
      const msg = `Skipping deterministic verification — cached pass for tree ${sha7} (recorded at ${cacheHit.recordedAt}, by ${cacheHit.taskId ?? "unknown"})`;
      mergerLog.log(`${taskId}: ${msg}`);
      await store.logEntry(taskId, msg);
      await store.appendAgentLog(taskId, msg, "text", undefined, "merger");
      const syntheticResult: VerificationCommandResult = {
        command: "",
        exitCode: 0,
        stdout: "",
        stderr: "",
        success: true,
        cached: true,
      };
      if (hasTestCommand) result.testResult = { ...syntheticResult, command: effectiveTestCommand };
      if (hasBuildCommand) result.buildResult = { ...syntheticResult, command: effectiveBuildCommand };
      return result;
    }
  }
  // ── End cache lookup ───────────────────────────────────────────────────

  // Build source indicator for logging
  const testSourceLabel = testSource === "inferred" ? " [inferred]" : "";
  const buildSourceLabel = buildSource === "inferred" ? " [inferred]" : "";

  mergerLog.log(
    `${taskId}: running deterministic verification` +
    (hasTestCommand ? ` [test:${testSourceLabel} ${normalizedTestCommand}]` : "") +
    (hasBuildCommand ? ` [build:${buildSourceLabel} ${normalizedBuildCommand}]` : ""),
  );
  const deterministicVerificationMessage =
    "Running deterministic merge verification" +
    (hasTestCommand ? ` (test${testSource === "inferred" ? " [inferred]" : ""}: ${normalizedTestCommand})` : "") +
    (hasBuildCommand ? ` (build${buildSource === "inferred" ? " [inferred]" : ""}: ${normalizedBuildCommand})` : "");
  await store.logEntry(taskId, deterministicVerificationMessage);
  await store.appendAgentLog(taskId, deterministicVerificationMessage, "text", undefined, "merger");

  // Run test command first if configured
  if (hasTestCommand) {
    const testResult = await runVerificationCommand(
      store, rootDir, taskId, normalizedTestCommand!, "test", signal,
    );
    result.testResult = testResult;

    if (!testResult.success) {
      result.allPassed = false;
      result.failedCommand = "testCommand";
      await store.logEntry(
        taskId,
        `Deterministic test verification failed (exit ${testResult.exitCode}) — see prior [verification] entry for truncated output`,
        "VerificationError",
      );
      await store.appendAgentLog(
        taskId,
        "Verification failed",
        "tool_error",
        `exit ${testResult.exitCode}`,
        "merger",
      );
      throw new VerificationError(
        `Deterministic test verification failed for ${taskId}`,
        result,
      );
    }
  }

  // Run build command second if configured
  if (hasBuildCommand) {
    const buildResult = await runVerificationCommand(
      store, rootDir, taskId, normalizedBuildCommand!, "build", signal,
    );
    result.buildResult = buildResult;

    if (!buildResult.success) {
      result.allPassed = false;
      result.failedCommand = "buildCommand";
      await store.logEntry(
        taskId,
        `Deterministic build verification failed (exit ${buildResult.exitCode}) — see prior [verification] entry for truncated output`,
        "VerificationError",
      );
      await store.appendAgentLog(
        taskId,
        "Verification failed",
        "tool_error",
        `exit ${buildResult.exitCode}`,
        "merger",
      );
      throw new VerificationError(
        `Deterministic build verification failed for ${taskId}`,
        result,
      );
    }
  }

  mergerLog.log(`${taskId}: deterministic verification passed`);
  await store.logEntry(taskId, "Deterministic merge verification passed");
  await store.appendAgentLog(taskId, "Deterministic merge verification passed", "text", undefined, "merger");

  // ── Record cache pass ──────────────────────────────────────────────────
  if (treeSha) {
    try {
      store.recordVerificationCachePass(treeSha, effectiveTestCommand, effectiveBuildCommand, taskId);
      mergerLog.log(`${taskId}: Recorded verification pass for tree ${treeSha.slice(0, 7)}`);
      await store.logEntry(taskId, `Recorded verification pass for tree ${treeSha.slice(0, 7)}`);
    } catch (err) {
      mergerLog.warn(`${taskId}: could not record verification cache pass: ${String(err)}`);
    }
  }

  return result;
}

async function runVerificationCommand(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  command: string,
  type: "test" | "build",
  signal?: AbortSignal,
): Promise<VerificationCommandResult> {
  throwIfAborted(signal, taskId);
  return runVerificationCommandShared(store, rootDir, taskId, command, type, signal, mergerLog, "merger", VERIFICATION_EXTRA_ENV);
}

/**
 * Attempt an in-merge verification fix by spawning an AI agent on the main branch.
 * Returns true if verification passes after the fix, false otherwise.
 * Never throws — errors are caught and logged, and the function returns false.
 *
 * @param fixModifiedFiles - Mutable set that this function populates with every
 *   path that changed during the fix agent's run (post-snapshot minus
 *   pre-snapshot). The caller passes this set across all fix attempts so that
 *   `commitOrAmendMergeWithFixes` can build an allowlist that covers every file
 *   the fix agent touched, regardless of how many retries were needed.
 */
async function attemptInMergeVerificationFix(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  failureContext: {
    command: string;
    exitCode: number | null;
    output: string;
    type: "test" | "build";
  },
  settings: Settings,
  options: MergerOptions,
  mergeRunContext?: Pick<EngineRunContext, "runId" | "agentId">,
  fixAttemptNumber?: number,
  testCommand?: string,
  buildCommand?: string,
  testSource?: "explicit" | "inferred",
  buildSource?: "explicit" | "inferred",
  fixModifiedFiles?: Set<string>,
): Promise<boolean> {
  // Snapshot the working tree before doing anything so the diff reflects only
  // what the fix agent touched, not pre-existing dirty state.
  const preFixSnapshot = await snapshotDirtyFiles(rootDir);
  const preFixFingerprint = await gitDirtyFingerprint(rootDir);
  try {
    mergerLog.log(`${taskId}: spawning in-merge verification fix agent`);

    const logger = new AgentLogger({
      store,
      taskId,
      agent: "merger",
      persistAgentToolOutput: settings.persistAgentToolOutput,
      onAgentText: options.onAgentText,
      onAgentTool: options.onAgentTool,
    });

    // Build skill selection context
    let skillContext = undefined;
    let taskForSkillContext: Awaited<ReturnType<typeof store.getTask>> | null = null;
    if (options.agentStore) {
      try {
        taskForSkillContext = await store.getTask(taskId);
        skillContext = await buildSessionSkillContext({
          agentStore: options.agentStore,
          task: taskForSkillContext,
          sessionPurpose: "merger",
          projectRootDir: rootDir,
          pluginRunner: options.pluginRunner,
        });
      } catch {
        // Graceful fallback - no skill selection
      }
    }

    // Create the fix agent session
    throwIfAborted(options.signal, taskId);
    const assignedAgentId = taskForSkillContext?.assignedAgentId?.trim();
    const agentStoreWithGetAgent = options.agentStore && typeof (options.agentStore as { getAgent?: unknown }).getAgent === "function"
      ? options.agentStore
      : null;
    const assignedAgent = assignedAgentId && agentStoreWithGetAgent
      ? await agentStoreWithGetAgent.getAgent(assignedAgentId).catch(() => null)
      : null;
    const mergerRuntimeHint = extractRuntimeHint(assignedAgent?.runtimeConfig);
    const { session } = await createResolvedAgentSession({
      sessionPurpose: "merger",
      runtimeHint: mergerRuntimeHint,
      pluginRunner: options.pluginRunner,
      cwd: rootDir, // Runs on the main branch in the project root
      systemPrompt: `You are a verification fix agent running during a merge on the main branch.

A merge has been applied and the verification command failed. Your job is to fix the failing code directly in the working directory.

## Scope
Only fix what is required to make the failing verification pass.
Do not refactor, rename broadly, or make opportunistic improvements.

## Rules
1. Read the error output carefully to understand what is failing before editing anything
2. Before assuming a code fix is needed, check whether the failure is caused by stale/missing build artifacts in a sibling workspace package — typical signatures: \`Failed to resolve import "./X.js"\` pointing into another package's \`dist/\`, \`Cannot find module\`, or \`ERR_MODULE_NOT_FOUND\` referencing a workspace-internal path. In that case, rebuild the affected package(s) (e.g. \`pnpm --filter <pkg> build\`, or \`pnpm --filter "<scope>/*" build\` for a group) and re-run verification before editing source files.
3. Make targeted fixes to the failing code path
4. After fixing, verify your changes keep both deterministic test and build commands passing
5. Do NOT make any git commits — just fix the code
6. You MAY modify any files needed to make the verification pass, including files unrelated to this task's original change. Pre-existing build/test breakage on the base branch is in scope: fix it. Prefer the smallest change that makes verification green.
7. If you cannot fix the issue within scope, explain why and what evidence indicates a deeper/root problem`,
      tools: "coding", // Agent needs read/write file access
      onText: logger.onText,
      onThinking: logger.onThinking,
      onToolStart: logger.onToolStart,
      onToolEnd: logger.onToolEnd,
      defaultProvider: settings.defaultProviderOverride && settings.defaultModelIdOverride
        ? settings.defaultProviderOverride
        : settings.defaultProvider,
      defaultModelId: settings.defaultProviderOverride && settings.defaultModelIdOverride
        ? settings.defaultModelIdOverride
        : settings.defaultModelId,
      fallbackProvider: settings.fallbackProvider,
      fallbackModelId: settings.fallbackModelId,
      defaultThinkingLevel: settings.defaultThinkingLevel,
      // Skill selection: use assigned agent skills if available, otherwise role fallback
      ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
      taskId,
      taskTitle: taskForSkillContext?.title,
      onFallbackModelUsed: createFallbackModelObserver({
        agent: "merger",
        label: "merge verification fix agent",
        store,
        taskId,
        taskTitle: taskForSkillContext?.title,
      }),
    });
    // Register so engine.stop() can dispose this session — without this the
    // fix agent keeps streaming past shutdown because it's not the autostash
    // session that the engine tracks.
    options.onSession?.(session);

    const runId = mergeRunContext?.runId;
    const agentId = mergeRunContext?.agentId ?? "merger";
    await store.logEntry(
      taskId,
      `In-merge verification fix agent started (model: ${describeModel(session)}, runId: ${runId ?? "unknown"}, agentId: ${agentId})`,
    );
    await store.appendAgentLog(
      taskId,
      `Fix agent started (model: ${describeModel(session)})`,
      "text",
      undefined,
      "merger",
    );

    try {
      // Build the fix prompt
      const fixPrompt = `Fix the failing ${failureContext.type} verification for task ${taskId}.

## Failed command
Command: \`${failureContext.command}\`
Exit code: ${failureContext.exitCode}

## Error output
${failureContext.output.slice(0, VERIFICATION_LOG_MAX_CHARS)}

## Instructions
1. Read the error output and identify the root cause
2. Make targeted fixes to resolve the failure
3. Use \`${failureContext.command}\` while iterating, but ensure your final changes keep both deterministic test and build commands passing
4. If the fix doesn't work, try a different approach
5. Do NOT make any git commits`;

      // Run the agent with rate limit retry
      await withRateLimitRetry(async () => {
        throwIfAborted(options.signal, taskId);
        await promptWithFallback(session, fixPrompt);
      }, {
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          mergerLog.warn(`⏳ ${taskId} in-merge fix rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
        },
        signal: options.signal,
      });
      await accumulateSessionTokenUsage(store, taskId, session);

      // Compute which paths the fix agent introduced or modified, then
      // accumulate them into the caller's mutable set.
      const postFixSnapshot = await snapshotDirtyFiles(rootDir);
      const newlyTouched: string[] = [];
      for (const p of postFixSnapshot) {
        if (!preFixSnapshot.has(p)) newlyTouched.push(p);
      }
      if (fixModifiedFiles) {
        for (const p of newlyTouched) fixModifiedFiles.add(p);
      }

      // If the fix agent didn't actually edit anything, re-running the same
      // failing verification can only yield the same failure — skip the
      // multi-minute test/build cycle and report the attempt as unsuccessful.
      // Use a git content fingerprint (diff + porcelain status) so we also
      // catch in-place edits to already-dirty files, not just newly added
      // paths. Only skip when we have a non-empty fingerprint to compare
      // against; an empty pre-fingerprint means the snapshot tool failed and
      // we should fall back to actually re-running verification.
      const postFixFingerprint = await gitDirtyFingerprint(rootDir);
      const fingerprintsMatch =
        preFixFingerprint.length > 0 && preFixFingerprint === postFixFingerprint;
      if (newlyTouched.length === 0 && fingerprintsMatch) {
        mergerLog.warn(`${taskId}: in-merge fix agent made no changes — skipping verification re-run`);
        await store.logEntry(
          taskId,
          `In-merge fix agent made no changes — skipping verification re-run (attempt ${fixAttemptNumber ?? "unknown"})`,
        );
        await store.appendAgentLog(
          taskId,
          `Fix agent made no changes — skipping verification re-run`,
          "text",
          undefined,
          "merger",
        );
        return false;
      }

      // Re-run deterministic verification command after the fix attempt.
      await store.logEntry(
        taskId,
        `Re-running deterministic merge verification (attempt ${fixAttemptNumber ?? "unknown"})`,
      );
      await store.appendAgentLog(
        taskId,
        `Re-running verification (attempt ${fixAttemptNumber ?? "unknown"})`,
        "text",
        undefined,
        "merger",
      );
      try {
        await runDeterministicVerification(
          store,
          rootDir,
          taskId,
          testCommand,
          buildCommand,
          testSource,
          buildSource,
          options.signal,
        );
        return true;
      } catch (error: unknown) {
        if (error instanceof VerificationError) {
          return false;
        }
        throw error;
      }
    } finally {
      // Flush buffered output before disposal so fix-attempt activity is visible.
      await logger.flush();
      await session.dispose();
    }
  } catch (err: unknown) {
    rethrowIfMergeAborted(err);
    // Even on failure, try to surface any paths the agent partially touched.
    if (fixModifiedFiles) {
      try {
        const postFixSnapshot = await snapshotDirtyFiles(rootDir);
        for (const p of postFixSnapshot) {
          if (!preFixSnapshot.has(p)) {
            fixModifiedFiles.add(p);
          }
        }
      } catch {
        // Best-effort only
      }
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: in-merge fix agent error: ${errorMessage}`);
    await store.logEntry(taskId, "In-merge verification fix agent encountered an error", errorMessage);
    await store.appendAgentLog(taskId, "Fix agent encountered an error", "tool_error", errorMessage, "merger");
    return false;
  }
}

/**
 * Best-effort `git reset --merge` with a labeled warning on failure.
 * `label` describes the cleanup site so operators can correlate the warning
 * back to the merge phase that left state behind. The label is included in
 * the warning text so test assertions can match on it.
 */
function resetMergeWithWarn(rootDir: string, taskId: string, label: string): void {
  runObservedDestructiveSyncOp(rootDir, taskId, `reset --merge (${label})`, () => {
    try {
      execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: git reset --merge cleanup failed during ${label}: ${msg}`);
    }
  });
}

/** Identity returned by `stashUnrelatedRootDirChanges`. The SHA is the stable
 *  handle (commit object id, never moves) — used for apply / drop instead of
 *  position-relative `stash@{N}` refs that shift when other stashes are
 *  pushed during or after the merge. The label is purely for human display.
 *  `rescueShas` lists any race-rescue stashes the autostash captured for
 *  late-dirty paths (concurrent dev edits during the merger run). They are
 *  surfaced separately so the caller can log them to the task feed. */
interface AutostashHandle {
  sha: string;
  label: string;
  rescueShas?: { sha: string; label: string }[];
}

const AUTOSTASH_LABEL_PREFIX = "fusion-merger-autostash:";

/** Return the set of paths a stash commit recorded as changed against its
 *  parent (HEAD-at-stash-time). Used to compare a new dirty snapshot against
 *  the primary autostash and avoid producing duplicate race-rescue stashes
 *  for the same paths the primary already captured. */
async function listStashChangedPaths(rootDir: string, stashSha: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { stdout } = await execAsync(
      `git stash show -z --name-only ${quoteArg(stashSha)}`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    for (const entry of stdout.split("\0")) {
      const p = entry.trim();
      if (p) out.add(p);
    }
  } catch {
    // Best-effort: an empty set means we'll be slightly more aggressive
    // about rescuing (everything dirty gets rescued), which is the safe
    // direction — false positives are noise, false negatives are data loss.
  }
  return out;
}

/** True iff two stash commits point to the exact same tree object. Cheap
 *  way to detect "stash create produced a duplicate" without diffing files. */
async function stashTreesEqual(rootDir: string, aSha: string, bSha: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      execAsync(`git rev-parse ${quoteArg(aSha)}^{tree}`, { cwd: rootDir, encoding: "utf-8" }),
      execAsync(`git rev-parse ${quoteArg(bSha)}^{tree}`, { cwd: rootDir, encoding: "utf-8" }),
    ]);
    return a.stdout.trim() === b.stdout.trim();
  } catch {
    return false;
  }
}

/** Filename of the advisory "merger active" status file. Lives at
 *  `<rootDir>/.git/<this filename>` so it travels with the repo and is
 *  automatically scoped to the right working tree. Not a lock — purely
 *  informational, intended for dashboards / status lines / pre-Edit hooks
 *  that want to warn devs that rootDir is volatile until the merge finishes. */
const ACTIVE_MERGER_STATUS_FILENAME = ".fusion-merger-active.json";

/** Shape of the advisory status file. PID + hostname let readers detect
 *  stale files left behind by a crashed merger run. */
export interface ActiveMergerStatus {
  taskId: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

/** Write the advisory status file at `<rootDir>/.git/...`. Best-effort:
 *  failures are logged and the merge proceeds without the advisory — losing
 *  the dashboard signal is preferable to blocking the merge. Returns the
 *  path of the file that was written so the caller can pass it back to
 *  `clearActiveMergerStatus` on cleanup. */
function writeActiveMergerStatus(rootDir: string, taskId: string): string | null {
  try {
    const statusPath = join(rootDir, ".git", ACTIVE_MERGER_STATUS_FILENAME);
    const payload: ActiveMergerStatus = {
      taskId,
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    };
    // Atomic write via temp + rename. Without this, a reader that hits
    // existsSync() between `open` and the final flush sees a partial /
    // empty file. JSON.parse rejects partial writes so we'd just return
    // null, but that produces false "no merger active" advisories.
    // POSIX guarantees rename is atomic on the same filesystem.
    const tempPath = `${statusPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf-8");
    renameSync(tempPath, statusPath);
    return statusPath;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: writeActiveMergerStatus failed (${msg}) — proceeding without advisory file`);
    return null;
  }
}

/** Best-effort delete of the status file. */
function clearActiveMergerStatus(statusPath: string | null, taskId: string): void {
  if (!statusPath) return;
  try {
    unlinkSync(statusPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: clearActiveMergerStatus failed (${msg}) — file may linger as a stale advisory`);
  }
}

/** Public reader for tooling (CLI / dashboard / TUI / Claude Code hook).
 *  Returns null if no merger is active OR if the advisory file is malformed.
 *  Callers can correlate `pid` + `hostname` with their own process list to
 *  distinguish a live merger from a stale post-crash file. */
export function readActiveMergerStatus(rootDir: string): ActiveMergerStatus | null {
  try {
    const statusPath = join(rootDir, ".git", ACTIVE_MERGER_STATUS_FILENAME);
    if (!existsSync(statusPath)) return null;
    const raw = readFileSync(statusPath, "utf-8");
    const parsed = JSON.parse(raw) as ActiveMergerStatus;
    if (!parsed?.taskId || typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Wrap a destructive op in `rootDir` with snapshot-before / snapshot-after
 *  observability. Pure logging — does not rescue. Designed for ops that are
 *  *supposed* to preserve unrelated working-tree edits (e.g. `git reset
 *  --merge`, `git checkout main`). When such an op silently wipes a path
 *  that was dirty before, the warning surfaces it as actionable signal
 *  instead of letting the loss go unnoticed.
 *
 *  Not used for the autostash's own `git reset --hard HEAD` / `git clean
 *  -fd` (those are intentionally destructive and have race-rescue stashes
 *  capturing dirty state up-front).
 *
 *  Synchronous variant — the destructive ops themselves are mostly
 *  `execSync` for "best-effort cleanup" semantics, so the wrapper matches
 *  to avoid scattering Promise-juggling at every call site. */
function runObservedDestructiveSyncOp(
  rootDir: string,
  taskId: string,
  label: string,
  op: () => void,
): void {
  // snapshotDirtyFiles is async by design (uses Promise.all over three git
  // queries); we read it via a quick sync fallback so the observer doesn't
  // change the call shape of resetMergeWithWarn et al.
  let beforeRaw = "";
  try {
    beforeRaw = execSync("git status -z --porcelain", { cwd: rootDir, stdio: ["ignore", "pipe", "ignore"] }).toString("utf-8");
  } catch {
    // best-effort — skip observation if we can't read status
    op();
    return;
  }
  const before = parsePorcelainZ(beforeRaw);

  op();

  let afterRaw = "";
  try {
    afterRaw = execSync("git status -z --porcelain", { cwd: rootDir, stdio: ["ignore", "pipe", "ignore"] }).toString("utf-8");
  } catch {
    return;
  }
  const after = parsePorcelainZ(afterRaw);

  const lost = [...before].filter((p) => !after.has(p));
  if (lost.length > 0) {
    const sample = lost.slice(0, 10).join(", ");
    const ellipsis = lost.length > 10 ? ` … (+${lost.length - 10} more)` : "";
    mergerLog.warn(
      `${taskId}: destructive op "${label}" cleared ${lost.length} dirty path(s) that were present before — possible silent wipe of unrelated dev edits: ${sample}${ellipsis}`,
    );
  }
}

/** Parse `git status -z --porcelain` into a Set of paths.
 *
 *  Format per entry: `XY <space> <path>\0` where X = staged status, Y =
 *  unstaged status. Renames and copies are special: they emit TWO
 *  NUL-separated entries, `R  <new>\0<old>\0` (or `C  <new>\0<old>\0`).
 *  We must consume the trailing `<old>` entry without treating it as a
 *  separate path, otherwise observability code over-reports "cleared
 *  paths" with the historical names of renames. */
export function parsePorcelainZ(raw: string): Set<string> {
  const paths = new Set<string>();
  const entries = raw.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    paths.add(path);
    // Rename/copy: the very next entry is the old path — skip it so it
    // isn't mistaken for an independent dirty path.
    if (status.charAt(0) === "R" || status.charAt(0) === "C") {
      i++;
    }
  }
  return paths;
}

/** Find autostashes from PRIOR runs that are still sitting in the stash list.
 *  These are leftovers from past merges whose pop/apply conflicted — under the
 *  old code path the warning was logged once and then forgotten, and the
 *  next merge would silently bury them by pushing a new stash on top. We now
 *  surface them at the start of every merge so the developer notices. */
async function listOrphanedAutostashes(
  rootDir: string,
): Promise<Array<{ sha: string; ref: string; label: string }>> {
  try {
    const { stdout } = await execAsync(
      `git stash list --format="%H %gd %s"`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    const lines = String(stdout).split("\n").map((l) => l.trim()).filter(Boolean);
    const orphans: Array<{ sha: string; ref: string; label: string }> = [];
    for (const line of lines) {
      // Format: "<sha> stash@{N} <subject including label>"
      const idx = line.indexOf(AUTOSTASH_LABEL_PREFIX);
      if (idx === -1) continue;
      const parts = line.split(/\s+/);
      const sha = parts[0] ?? "";
      const ref = parts[1] ?? "";
      const label = line.slice(idx);
      if (sha && ref) orphans.push({ sha, ref, label });
    }
    return orphans;
  } catch {
    return [];
  }
}

function parseAutostashTaskId(label: string): string | null {
  const match = /^fusion-merger-autostash:([A-Za-z]+-\d+):/.exec(label.trim());
  return match?.[1] ?? null;
}

/**
 * Stash any unrelated dirty changes in `rootDir` before a merge runs.
 *
 * The merger frequently issues `git reset --hard` / `git reset --merge` /
 * forced checkouts against `rootDir`. When `rootDir` happens to be the
 * developer's primary checkout (the common case for solo / single-host
 * setups), those resets discard any uncommitted dev edits in the working
 * tree — silently and without recourse. We've burned developer work this
 * way (FN-3329 retro): dashboard-tui edits were wiped mid-flight by an
 * unrelated FN-3329 merge.
 *
 * The fix: snapshot dirty state up-front using `git stash create` + `git
 * stash store` to capture a deterministic SHA *before* any working-tree
 * mutation, then apply it back after the merge finishes — success OR
 * failure — via a try/finally in `aiMergeTask`.
 *
 * Why create+store instead of `git stash push`: `push` returns no
 * machine-readable identifier and forces us to grep the stash list for our
 * label, which races against any other tool that stashes concurrently.
 * `create` returns the SHA atomically with snapshot creation, then `store`
 * registers it in the reflog under a recognizable label so it's protected
 * from GC and visible to humans via `git stash list`.
 *
 * Untracked files are captured by first staging them via `git add -A` so
 * `stash create` (which otherwise ignores untracked) sees them as part of
 * the index snapshot. The subsequent `git reset --hard` + `git clean -fd`
 * bring the working tree back to HEAD so the merge can proceed cleanly.
 *
 * Returns the stash handle (SHA + label) when a stash was created, or
 * `null` when the working tree was already clean. Best-effort: any failure
 * to stash logs and returns null — the merge still proceeds, but with the
 * old behavior. We do NOT want a stash failure to block the merge entirely
 * (that would be a strictly worse regression than the current state).
 */
/**
 * Inspect every leftover `fusion-merger-autostash:*` from prior runs. For
 * each, classify:
 *
 *  - **Subsumed** — `git diff HEAD <stashSha> -- <stashFiles>` produces no
 *    output, meaning every path in the stash is already byte-identical to
 *    HEAD. The dev's work either landed in HEAD via the merge itself or
 *    was committed independently; the stash is redundant. Drop it.
 *  - **Live** — at least one path still differs from HEAD. The stash is
 *    real lost work; warn loudly so the dev can recover it manually.
 *
 *  Without this sweep, every silent restore failure (apply hard-fails on
 *  untracked-overwrite, ref already gone, transient git error) leaves a
 *  permanent stash entry. They pile up indefinitely — we observed 50+
 *  orphans on a single working tree — and the warn-only behavior means
 *  developers stop reading the warnings entirely, defeating the safety
 *  net.
 */
async function sweepAutostashOrphans(
  rootDir: string,
  taskId: string,
  store: TaskStore,
): Promise<void> {
  let orphans: Array<{ sha: string; ref: string; label: string }> = [];
  try {
    orphans = await listOrphanedAutostashes(rootDir);
  } catch {
    return;
  }
  if (orphans.length === 0) return;

  const subsumed: Array<{ sha: string; ref: string; label: string }> = [];
  const live: Array<{ sha: string; ref: string; label: string }> = [];

  const droppedClosedTask: Array<{ sha: string; taskId: string; column: Task["column"] }> = [];

  for (const orphan of orphans) {
    try {
      const stashFiles = await listStashChangedPaths(rootDir, orphan.sha);
      if (stashFiles.size === 0) {
        // Empty stash — nothing to lose by dropping.
        subsumed.push(orphan);
        continue;
      }
      const pathsArg = [...stashFiles].map(quoteArg).join(" ");
      const { stdout: pathDiffOut } = await execAsync(
        `git diff --name-only HEAD ${quoteArg(orphan.sha)} -- ${pathsArg}`,
        { cwd: rootDir, encoding: "utf-8" },
      );
      const isPathSubsumed = pathDiffOut.trim() === "";
      if (isPathSubsumed) {
        subsumed.push(orphan);
        continue;
      }

      const sourceTaskId = parseAutostashTaskId(orphan.label);
      if (!sourceTaskId) {
        live.push(orphan);
        continue;
      }

      let sourceTask: Task | null = null;
      try {
        sourceTask = await store.getTask(sourceTaskId);
      } catch {
        live.push(orphan);
        continue;
      }
      if (!sourceTask || (sourceTask.column !== "done" && sourceTask.column !== "archived")) {
        live.push(orphan);
        continue;
      }

      try {
        const { stdout: netDiffOut } = await execAsync(
          `git diff HEAD ${quoteArg(orphan.sha)}`,
          { cwd: rootDir, encoding: "utf-8" },
        );
        if (netDiffOut.trim() === "") {
          subsumed.push(orphan);
          droppedClosedTask.push({ sha: orphan.sha, taskId: sourceTaskId, column: sourceTask.column });
          continue;
        }
      } catch {
        live.push(orphan);
        continue;
      }

      live.push(orphan);
    } catch {
      // If we can't classify, treat as live — better to leave a real stash
      // sitting around than to drop one that still contains lost work.
      live.push(orphan);
    }
  }

  for (const orphan of subsumed) {
    await dropAutostashBySha(rootDir, taskId, orphan.sha);
    const closedTaskDrop = droppedClosedTask.find((entry) => entry.sha === orphan.sha);
    if (closedTaskDrop) {
      mergerLog.log(
        `${taskId}: dropped closed-task autostash ${orphan.sha.slice(0, 7)} (task ${closedTaskDrop.taskId} is ${closedTaskDrop.column})`,
      );
      continue;
    }
    mergerLog.log(
      `${taskId}: dropped subsumed autostash ${orphan.sha.slice(0, 7)} (${orphan.label}) — content already present on HEAD`,
    );
  }

  if (subsumed.length > 0) {
    await store
      .logEntry(
        taskId,
        `Cleaned up ${subsumed.length} subsumed autostash orphan(s) — their content already on HEAD`,
        subsumed.map((o) => `${o.ref}@${o.sha.slice(0, 7)} (${o.label})`).join("\n"),
      )
      .catch(() => undefined);
  }

  if (live.length > 0) {
    const refs = live.map((o) => `${o.ref}@${o.sha.slice(0, 7)}`).join(", ");
    mergerLog.warn(
      `${taskId}: ${live.length} live fusion-merger-autostash entry(ies) in stash list (${refs}) — uncommitted dev changes from prior merges whose restore failed. Recover with: cd ${rootDir} && git stash list && git stash apply <sha>`,
    );
    await store
      .logEntry(
        taskId,
        `${live.length} autostash orphan(s) still hold uncommitted dev work — recover manually`,
        live
          .map(
            (o) =>
              `${o.ref}@${o.sha.slice(0, 7)} (${o.label})\n  recover: git stash apply ${o.sha}`,
          )
          .join("\n\n"),
      )
      .catch(() => undefined);
  }
}

export const __test__ = {
  sweepAutostashOrphans,
  parseAutostashTaskId,
};

async function stashUnrelatedRootDirChanges(
  rootDir: string,
  taskId: string,
): Promise<AutostashHandle | null> {
  try {
    const dirty = await snapshotDirtyFiles(rootDir);
    if (dirty.size === 0) return null;

    const label = `${AUTOSTASH_LABEL_PREFIX}${taskId}:${Date.now()}`;

    // Stage everything so `git stash create` captures untracked files too.
    // `stash create` only includes index + tracked working-tree changes by
    // default; `git add -A` stages untracked under .gitignore rules.
    await execAsync("git add -A", { cwd: rootDir });

    // Atomically snapshot working state into a commit object. SHA is
    // deterministic the moment this returns — no list-grep race.
    const { stdout: createOut } = await execAsync("git stash create", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const sha = String(createOut).trim();
    if (!sha) {
      // No-op snapshot (shouldn't happen given the dirty check above, but
      // bail safely and unstage what we just staged).
      await execAsync("git reset", { cwd: rootDir }).catch(() => undefined);
      return null;
    }

    // Persist into the stash reflog so the SHA is reachable and humans see
    // it in `git stash list`. Without store, the SHA would be GC-eligible.
    await execAsync(
      `git stash store -m ${quoteArg(label)} ${sha}`,
      { cwd: rootDir },
    );

    // Race-rescue: re-snapshot AFTER the stash is persisted but BEFORE the
    // destructive `git reset --hard` below. If any new dirty paths showed up
    // between our initial `git add -A` and now — concurrent dev edits, a
    // parallel merger run interleaving its own ops, or test/build artifacts
    // landing late — capture ONLY those new paths in a separate rescue stash
    // so they survive the wipe.
    //
    // Subtlety: `git add -A && git stash create` does NOT clean the working
    // tree. Files stay dirty post-stash. So a naive "snapshot dirty again"
    // sees the SAME files as the primary stash and produces duplicate rescues
    // every run. We instead diff the post-stash dirty set against the SET OF
    // PATHS ALREADY CAPTURED BY THE PRIMARY STASH and only rescue paths that
    // were not in the primary — those are the genuine late-dirty writes.
    const primaryStashPaths = await listStashChangedPaths(rootDir, sha);
    const rescueShas: { sha: string; label: string }[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const currentDirty = await snapshotDirtyFiles(rootDir);
      const newlyDirty = [...currentDirty].filter((p) => !primaryStashPaths.has(p));
      if (newlyDirty.length === 0) break;
      const rescueLabel = `${AUTOSTASH_LABEL_PREFIX}${taskId}:race-rescue-${attempt}:${Date.now()}`;
      // Unstage before re-adding: `git stash create` snapshots the index
      // but does NOT clear it, so a second iteration's `git add -A` would
      // re-stage atop iteration-1 leftovers and produce a tree that
      // differs from current dirt for stale-staging reasons rather than
      // genuine new writes. The upcoming `git reset --hard HEAD` clears
      // it eventually, but inside this loop we want a clean baseline.
      await execAsync("git reset", { cwd: rootDir }).catch(() => undefined);
      await execAsync("git add -A", { cwd: rootDir });
      const { stdout: rescueOut } = await execAsync("git stash create", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const rescueSha = String(rescueOut).trim();
      if (!rescueSha) break;
      // Defensive check: if `git stash create` produced an SHA whose tree
      // exactly matches the primary stash, drop it — same race that motivates
      // the path-set check above can land us with an identical SHA when the
      // working tree didn't change between primary and rescue (e.g. git's own
      // internal index dedup). Don't pollute the stash list.
      const rescueTreeSame = await stashTreesEqual(rootDir, sha, rescueSha);
      if (rescueTreeSame) break;
      await execAsync(
        `git stash store -m ${quoteArg(rescueLabel)} ${rescueSha}`,
        { cwd: rootDir },
      );
      rescueShas.push({ sha: rescueSha, label: rescueLabel });
      mergerLog.warn(
        `${taskId}: race-rescue stash ${rescueSha.slice(0, 7)} captured ${newlyDirty.length} late-dirty path(s) not in primary stash (${rescueLabel}) — recover with: cd ${rootDir} && git stash apply ${rescueSha}`,
      );
      // Track them in primaryStashPaths so subsequent loop iterations don't
      // re-rescue the same set if writes are still landing.
      for (const p of newlyDirty) primaryStashPaths.add(p);
    }

    // Bring working tree back to HEAD so the merge can proceed. Reset
    // un-stages everything we just staged AND drops tracked-file
    // modifications. `git clean -fd` removes any untracked files / dirs
    // that survived (gitignored ones stay because we didn't pass -x).
    await execAsync("git reset --hard HEAD", { cwd: rootDir });
    await execAsync("git clean -fd", { cwd: rootDir });

    const rescueSuffix = rescueShas.length > 0
      ? ` + ${rescueShas.length} race-rescue stash(es): ${rescueShas.map((r) => r.sha.slice(0, 7)).join(", ")}`
      : "";
    mergerLog.log(
      `${taskId}: stashed ${dirty.size} unrelated dirty path(s) in rootDir as ${sha.slice(0, 7)} (${label})${rescueSuffix}`,
    );
    return rescueShas.length > 0 ? { sha, label, rescueShas } : { sha, label };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(
      `${taskId}: pre-merge autostash failed (${msg}) — proceeding without stash; concurrent dev edits in rootDir may be wiped`,
    );
    // Best-effort: try to unstage anything `git add -A` may have staged
    // before the failure, so the working tree is at least back to a sane
    // state for the merge.
    try {
      await execAsync("git reset", { cwd: rootDir });
    } catch {
      // Nothing more we can do.
    }
    return null;
  }
}

/** Resolve the autostash SHA back to its current `stash@{N}` ref so we can
 *  drop it. Stash positions shift when other stashes are pushed, so we
 *  can't cache the original ref. Returns null if the stash is no longer
 *  in the reflog (already dropped). */
async function findStashRefBySha(rootDir: string, sha: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `git stash list --format="%H %gd"`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    for (const line of String(stdout).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [entrySha, ref] = trimmed.split(/\s+/);
      if (entrySha === sha && ref) return ref;
    }
    return null;
  } catch {
    return null;
  }
}

/** Drop an autostash by SHA, defending against the TOCTOU race where another
 *  process pushes a stash between our `findStashRefBySha` and the actual
 *  `git stash drop stash@{N}` (drop only takes positional refs, so the index
 *  is what git uses — not our SHA). Without this guard we silently drop
 *  someone else's stash while leaving ours behind, and the task log lies
 *  about a clean restore.
 *
 *  Strategy: re-resolve ref → SHA, verify the ref still points at our SHA
 *  with `git rev-parse`, then drop. If the SHA at the ref drifted (race),
 *  retry up to 5x. Returns whether the drop landed cleanly so callers can
 *  surface failure to the task feed. */
async function dropAutostashBySha(
  rootDir: string,
  taskId: string,
  sha: string,
): Promise<{ dropped: boolean; reason?: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = await findStashRefBySha(rootDir, sha);
    if (!ref) {
      mergerLog.log(`${taskId}: autostash ${sha.slice(0, 7)} no longer in stash list (already dropped)`);
      return { dropped: true };
    }

    // Defend against the index-shift race: confirm the ref still resolves to
    // our SHA before dropping. If another process pushed a stash, ref now
    // points at theirs — back off and re-resolve.
    let refSha = "";
    try {
      const { stdout } = await execAsync(`git rev-parse ${ref}`, { cwd: rootDir, encoding: "utf-8" });
      refSha = String(stdout).trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: rev-parse ${ref} failed (${msg}) on drop attempt ${attempt + 1} — retrying`);
      continue;
    }
    if (refSha !== sha) {
      mergerLog.log(`${taskId}: autostash ${sha.slice(0, 7)} shifted off ${ref} (now ${refSha.slice(0, 7)}); re-resolving`);
      continue;
    }

    try {
      await execAsync(`git stash drop ${ref}`, { cwd: rootDir });
      return { dropped: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Final attempt: surface the failure. Earlier attempts get retried.
      if (attempt === 4) {
        mergerLog.warn(`${taskId}: failed to drop autostash ${ref} after ${attempt + 1} attempts (${msg}) — stash will linger in stash list`);
        return { dropped: false, reason: msg };
      }
      mergerLog.warn(`${taskId}: drop ${ref} attempt ${attempt + 1} failed (${msg}) — retrying`);
    }
  }
  return { dropped: false, reason: "exhausted retry attempts" };
}

/**
 * AI fix-agent for autostash apply conflicts. Spawned only when applying
 * the stashed dev work hits a conflict — the merge has already committed
 * cleanly, so this agent's job is narrow: edit the working-tree files in
 * place to remove conflict markers, picking the right combination of the
 * developer's pre-merge edits and the just-committed merge content. It
 * does NOT commit anything; the resolved files stay uncommitted (matching
 * the developer's pre-merge state).
 *
 * Mirrors the in-merge fix-agent pattern at the top of this file
 * (createResolvedAgentSession with sessionPurpose: "merger") so we reuse
 * skill selection, fallback models, rate-limit retry, and audit logging.
 *
 * Returns true on success (conflict markers gone, files staged-or-not as
 * the agent decided). On failure or abort, returns false and the caller
 * leaves the stash in place for manual recovery.
 */
async function runAiAgentForAutostashConflict(params: {
  store: TaskStore;
  rootDir: string;
  taskId: string;
  conflictedFiles: string[];
  options: MergerOptions;
  settings: Settings;
}): Promise<{ success: boolean; error?: string }> {
  const { store, rootDir, taskId, conflictedFiles, options, settings } = params;

  const agentLogger = new AgentLogger({
    store,
    taskId,
    agent: "merger",
    persistAgentToolOutput: settings.persistAgentToolOutput,
    onAgentText: options.onAgentText
      ? (_id: string, delta: string) => options.onAgentText!(delta)
      : undefined,
    onAgentTool: options.onAgentTool
      ? (_id: string, name: string) => options.onAgentTool!(name)
      : undefined,
  });

  // Skill / runtime resolution mirrors runAiAgentForCommit.
  let taskForSkillContext: Awaited<ReturnType<typeof store.getTask>> | null = null;
  let skillContext = undefined;
  if (options.agentStore) {
    try {
      taskForSkillContext = await store.getTask(taskId);
      skillContext = await buildSessionSkillContext({
        agentStore: options.agentStore,
        task: taskForSkillContext,
        sessionPurpose: "merger",
        projectRootDir: rootDir,
        pluginRunner: options.pluginRunner,
      });
    } catch {
      // Graceful fallback.
    }
  }
  const assignedAgentId = taskForSkillContext?.assignedAgentId?.trim();
  const agentStoreWithGetAgent = options.agentStore && typeof (options.agentStore as { getAgent?: unknown }).getAgent === "function"
    ? options.agentStore
    : null;
  const assignedAgent = assignedAgentId && agentStoreWithGetAgent
    ? await agentStoreWithGetAgent.getAgent(assignedAgentId).catch(() => null)
    : null;
  const mergerRuntimeHint = extractRuntimeHint(assignedAgent?.runtimeConfig);

  const systemPrompt = `You are an autostash-conflict resolution agent running after a Fusion merge has already committed on the main branch.

Before the merge ran, the developer had uncommitted local changes in their working tree. The merger snapshotted those changes into a git stash, ran the merge cleanly, and is now reapplying the stash on top of the merged HEAD. The reapply hit conflicts because the merge committed changes that overlap the developer's stashed edits.

## Your job
Edit the conflicted files in place to remove every conflict marker (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) and produce a coherent merged result that:
- Preserves the developer's intended uncommitted changes (the "Updated upstream" / branch-side, depending on which side the stash pop wrote)
- Layers them onto the merged HEAD content (the other side)

## Rules
1. Read each conflicted file carefully before editing
2. Resolve every conflict marker — none may remain after you finish
3. Do NOT make any git commits. Do NOT run \`git add\` or \`git stash drop\`. Just edit the files.
4. Do NOT touch files that are not in the conflicted-files list
5. If you genuinely cannot determine the right resolution for a hunk, prefer the developer's stashed edits (their work is the unsaved context) and add a brief \`// TODO(autostash-conflict)\` comment so they can review

The orchestrator will verify post-run that no conflict markers remain. If any do, this attempt is treated as a failure and the stash is left intact for manual recovery.`;

  const fileList = conflictedFiles.map((f) => `- ${f}`).join("\n");
  const prompt = `Resolve autostash apply conflicts for task ${taskId}.

## Conflicted files
${fileList}

## Steps
1. For each file above, read its current contents (it has conflict markers from the failed \`git stash apply\`)
2. Edit it to a clean state with no conflict markers — preserving the developer's intended changes layered on top of the merged HEAD
3. After all files are clean, you are done. Do NOT commit or run git stash commands.`;

  mergerLog.log(`${taskId}: starting autostash-conflict resolution agent (${conflictedFiles.length} file(s))`);

  const { session } = await createResolvedAgentSession({
    sessionPurpose: "merger",
    runtimeHint: mergerRuntimeHint,
    pluginRunner: options.pluginRunner,
    cwd: rootDir,
    systemPrompt,
    tools: "coding",
    onText: agentLogger.onText,
    onThinking: agentLogger.onThinking,
    onToolStart: agentLogger.onToolStart,
    onToolEnd: agentLogger.onToolEnd,
    defaultProvider: settings.defaultProviderOverride && settings.defaultModelIdOverride
      ? settings.defaultProviderOverride
      : settings.defaultProvider,
    defaultModelId: settings.defaultProviderOverride && settings.defaultModelIdOverride
      ? settings.defaultModelIdOverride
      : settings.defaultModelId,
    fallbackProvider: settings.fallbackProvider,
    fallbackModelId: settings.fallbackModelId,
    defaultThinkingLevel: settings.defaultThinkingLevel,
    ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    taskId,
    taskTitle: taskForSkillContext?.title,
    onFallbackModelUsed: createFallbackModelObserver({
      agent: "merger",
      label: "autostash conflict agent",
      store,
      taskId,
      taskTitle: taskForSkillContext?.title,
    }),
  });
  options.onSession?.(session);

  try {
    await store.appendAgentLog(
      taskId,
      `Autostash conflict agent started (model: ${describeModel(session)}, files: ${conflictedFiles.length})`,
      "text",
      undefined,
      "merger",
    );

    await withRateLimitRetry(async () => {
      throwIfAborted(options.signal, taskId);
      await promptWithFallback(session, prompt);
      checkSessionError(session);
    }, {
      onRetry: (attempt, delayMs, error) => {
        const delaySec = Math.round(delayMs / 1000);
        mergerLog.warn(`⏳ ${taskId} autostash-conflict agent rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
      },
      signal: options.signal,
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: autostash-conflict agent error: ${msg}`);
    await store.logEntry(taskId, "Autostash conflict agent encountered an error", msg);
    return { success: false, error: msg };
  } finally {
    try {
      session.dispose();
    } catch {
      // ignore
    }
  }
}

/** Verify no conflict markers remain in any of the listed files. Returns
 *  the subset that still has markers (empty = all clean). */
async function findFilesWithConflictMarkers(rootDir: string, files: string[]): Promise<string[]> {
  const stillConflicted: string[] = [];
  for (const file of files) {
    try {
      const fullPath = join(rootDir, file);
      if (!existsSync(fullPath)) continue;
      const { stdout } = await execAsync(
        `git grep -l -e "^<<<<<<< " -e "^=======$" -e "^>>>>>>> " --no-index -- ${quoteArg(fullPath)}`,
        { cwd: rootDir, encoding: "utf-8" },
      ).catch(() => ({ stdout: "" }));
      if (String(stdout).trim()) stillConflicted.push(file);
    } catch {
      // best-effort
    }
  }
  return stillConflicted;
}

/**
 * Recovery path for the hard-fail branch of `git stash apply`: the stash
 * couldn't even start applying (typical causes: untracked-overwrite, the
 * stash mentions a path that no longer exists at HEAD, or an index conflict
 * where git refuses to write any markers). The working tree has no conflict
 * markers because nothing was applied.
 *
 * Layered fallback:
 *   1. Pull the stash patch via `git stash show -p <sha>` and try
 *      `git apply --3way` against the working tree. This is more permissive
 *      than `stash apply` for several common failure shapes (especially
 *      untracked overwrites: --3way can produce conflict markers we can
 *      then resolve, where stash apply just refuses).
 *   2. If --3way left conflict markers: route to the existing AI conflict
 *      resolver.
 *   3. If --3way also hard-failed and smart conflict resolution is enabled:
 *      spawn an AI agent armed with the patch + error context, ask it to
 *      reconstruct the developer's edits on top of HEAD by editing files
 *      directly.
 *
 * Returns the appropriate AutostashOutcome. If recovery succeeds, the stash
 * is dropped (since its content is now applied to the working tree). If
 * recovery fails, the stash is left intact for manual recovery.
 */
async function tryRecoverHardFailApply(params: {
  rootDir: string;
  taskId: string;
  sha: string;
  applyErrorMsg: string;
  applyStderr: string;
  ctx: {
    store: TaskStore;
    options: MergerOptions;
    settings: Settings;
  };
}): Promise<AutostashOutcome> {
  const { rootDir, taskId, sha, applyErrorMsg, applyStderr, ctx } = params;
  const stashFiles = [...await listStashChangedPaths(rootDir, sha)];
  const smartConflictResolution =
    (ctx.settings.smartConflictResolution ?? ctx.settings.autoResolveConflicts) !== false;

  // Step 1: try `git apply --3way`. This pulls the diff out of the stash and
  // applies it as a regular patch with three-way merging, which behaves
  // better than `stash apply` in several common hard-fail shapes.
  let threeWayConflicted: string[] = [];
  let threeWayApplied = false;
  try {
    // Get the patch text from the stash.
    const { stdout: patchOut } = await execAsync(
      `git stash show -p --binary ${sha}`,
      { cwd: rootDir, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
    );
    const patchText = String(patchOut);
    if (!patchText.trim()) {
      // Nothing to apply — stash was empty or show failed.
      mergerLog.warn(`${taskId}: autostash ${sha.slice(0, 7)} produced empty patch; cannot 3-way recover`);
    } else {
      // Pipe the patch into `git apply --3way` via stdin.
      const patchPath = join(rootDir, ".git", `fusion-autostash-${sha.slice(0, 7)}.patch`);
      writeFileSync(patchPath, patchText, "utf-8");
      try {
        await execAsync(`git apply --3way --whitespace=nowarn ${quoteArg(patchPath)}`, { cwd: rootDir });
        threeWayApplied = true;
        mergerLog.log(`${taskId}: autostash ${sha.slice(0, 7)} recovered via git apply --3way`);
      } catch (threeWayErr: unknown) {
        const conflicted = await getConflictedFiles(rootDir);
        if (conflicted.length > 0) {
          threeWayConflicted = conflicted;
          mergerLog.log(`${taskId}: 3-way produced ${conflicted.length} conflict file(s) — handing to AI resolver`);
        } else {
          const tweMsg = threeWayErr instanceof Error ? threeWayErr.message : String(threeWayErr);
          mergerLog.warn(`${taskId}: 3-way apply also failed (${tweMsg}); falling through to AI patch recovery`);
        }
      } finally {
        try { unlinkSync(patchPath); } catch { /* ignore */ }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: failed to extract patch from stash ${sha.slice(0, 7)} (${msg})`);
  }

  // 3-way produced a clean working tree → drop stash and report restored.
  if (threeWayApplied) {
    const dropResult = await dropAutostashBySha(rootDir, taskId, sha);
    await ctx.store.logEntry(
      taskId,
      `Autostash apply hit hard failure but recovered via git apply --3way (stash ${sha.slice(0, 7)})`,
      `Original error: ${applyErrorMsg}\n${applyStderr ? `\nGit stderr:\n${applyStderr}\n` : ""}${dropResult.dropped ? "" : `\nStash drop failed (${dropResult.reason ?? "unknown"}); clean up manually.`}`,
    ).catch(() => undefined);
    return { status: "restored", stashSha: sha };
  }

  // 3-way produced conflict markers → existing AI conflict resolver handles it.
  if (threeWayConflicted.length > 0) {
    if (!smartConflictResolution) {
      const message = `Autostash 3-way produced conflict markers in ${threeWayConflicted.length} file(s) and smartConflictResolution is disabled. Stash ${sha.slice(0, 7)} left intact.`;
      await ctx.store.logEntry(
        taskId,
        `Autostash 3-way left conflict markers — manual resolution required (smart resolution disabled)`,
        message,
      ).catch(() => undefined);
      return { status: "conflict-needs-manual", stashSha: sha, conflictedFiles: threeWayConflicted, message };
    }

    await ctx.store.logEntry(
      taskId,
      `Autostash 3-way left conflicts in ${threeWayConflicted.length} file(s) — invoking AI to resolve`,
      threeWayConflicted.join("\n"),
    ).catch(() => undefined);

    const aiResult = await runAiAgentForAutostashConflict({
      store: ctx.store,
      rootDir,
      taskId,
      conflictedFiles: threeWayConflicted,
      options: ctx.options,
      settings: ctx.settings,
    });

    const stillConflicted = aiResult.success
      ? await findFilesWithConflictMarkers(rootDir, threeWayConflicted)
      : threeWayConflicted;

    if (aiResult.success && stillConflicted.length === 0) {
      const dropResult = await dropAutostashBySha(rootDir, taskId, sha);
      await ctx.store.logEntry(
        taskId,
        `Autostash hard-fail recovered via 3-way + AI conflict resolution (${threeWayConflicted.length} file(s))`,
        `Resolved files:\n${threeWayConflicted.join("\n")}${dropResult.dropped ? "" : `\n\nStash drop failed (${dropResult.reason ?? "unknown"}); clean up manually.`}`,
      ).catch(() => undefined);
      return { status: "ai-resolved", stashSha: sha, conflictedFiles: threeWayConflicted };
    }

    const failureMsg = `3-way+AI resolution incomplete; markers remain in ${stillConflicted.join(", ") || "(unknown)"}. Stash ${sha.slice(0, 7)} left intact.`;
    await ctx.store.logEntry(taskId, `Autostash 3-way+AI resolution failed`, failureMsg).catch(() => undefined);
    return { status: "conflict-needs-manual", stashSha: sha, conflictedFiles: stillConflicted, message: failureMsg };
  }

  // Step 3: 3-way also hard-failed. AI patch recovery if enabled.
  if (!smartConflictResolution || stashFiles.length === 0) {
    const message = `Autostash apply hard-failed (${applyErrorMsg})${applyStderr ? `; git stderr: ${applyStderr}` : ""}. Stash ${sha.slice(0, 7)} left intact.`;
    mergerLog.warn(`${taskId}: ${message}`);
    await ctx.store.logEntry(
      taskId,
      `Autostash apply failed — stash ${sha.slice(0, 7)} left intact for manual recovery`,
      `${applyErrorMsg}${applyStderr ? `\n\nGit stderr:\n${applyStderr}` : ""}\n\nRecover with:\n  cd ${rootDir} && git stash apply ${sha}`,
    ).catch(() => undefined);
    return { status: "failed", stashSha: sha, errorMessage: applyErrorMsg };
  }

  await ctx.store.logEntry(
    taskId,
    `Autostash apply hard-failed — invoking AI patch-recovery agent (${stashFiles.length} file(s))`,
    `${applyErrorMsg}${applyStderr ? `\n\nGit stderr:\n${applyStderr}` : ""}\n\nFiles in stash:\n${stashFiles.join("\n")}`,
  ).catch(() => undefined);

  const patchAiResult = await runAiAgentForAutostashHardFail({
    store: ctx.store,
    rootDir,
    taskId,
    stashSha: sha,
    stashFiles,
    applyErrorMsg,
    applyStderr,
    options: ctx.options,
    settings: ctx.settings,
  });

  if (!patchAiResult.success) {
    const failMsg = `AI patch-recovery failed (${patchAiResult.error ?? "unknown"}). Stash ${sha.slice(0, 7)} left intact.`;
    await ctx.store.logEntry(taskId, `Autostash AI patch-recovery failed`, failMsg).catch(() => undefined);
    return { status: "failed", stashSha: sha, errorMessage: failMsg };
  }

  // Verify any remaining conflict markers — agent may have left some.
  const remainingMarkers = await findFilesWithConflictMarkers(rootDir, stashFiles);
  if (remainingMarkers.length > 0) {
    const failMsg = `AI patch-recovery left conflict markers in: ${remainingMarkers.join(", ")}. Stash ${sha.slice(0, 7)} left intact.`;
    await ctx.store.logEntry(taskId, `AI patch-recovery incomplete — manual recovery required`, failMsg).catch(() => undefined);
    return { status: "conflict-needs-manual", stashSha: sha, conflictedFiles: remainingMarkers, message: failMsg };
  }

  const dropResult = await dropAutostashBySha(rootDir, taskId, sha);
  await ctx.store.logEntry(
    taskId,
    `Autostash hard-fail recovered by AI patch-recovery agent (${stashFiles.length} file(s))`,
    `Recovered files:\n${stashFiles.join("\n")}${dropResult.dropped ? "" : `\n\nStash drop failed (${dropResult.reason ?? "unknown"}); clean up manually.`}`,
  ).catch(() => undefined);
  return { status: "ai-resolved", stashSha: sha, conflictedFiles: stashFiles };
}

/**
 * AI agent for autostash apply HARD failures (no conflict markers, nothing
 * applied). Receives the stash patch + git stderr and reconstructs the
 * developer's edits on top of HEAD by editing files directly. Mirrors
 * `runAiAgentForAutostashConflict` but with a different prompt because
 * there are no in-tree conflict markers to resolve — the agent has to
 * re-apply changes from the patch by hand.
 */
async function runAiAgentForAutostashHardFail(params: {
  store: TaskStore;
  rootDir: string;
  taskId: string;
  stashSha: string;
  stashFiles: string[];
  applyErrorMsg: string;
  applyStderr: string;
  options: MergerOptions;
  settings: Settings;
}): Promise<{ success: boolean; error?: string }> {
  const { store, rootDir, taskId, stashSha, stashFiles, applyErrorMsg, applyStderr, options, settings } = params;

  const agentLogger = new AgentLogger({
    store,
    taskId,
    agent: "merger",
    persistAgentToolOutput: settings.persistAgentToolOutput,
    onAgentText: options.onAgentText
      ? (_id: string, delta: string) => options.onAgentText!(delta)
      : undefined,
    onAgentTool: options.onAgentTool
      ? (_id: string, name: string) => options.onAgentTool!(name)
      : undefined,
  });

  let taskForSkillContext: Awaited<ReturnType<typeof store.getTask>> | null = null;
  let skillContext = undefined;
  if (options.agentStore) {
    try {
      taskForSkillContext = await store.getTask(taskId);
      skillContext = await buildSessionSkillContext({
        agentStore: options.agentStore,
        task: taskForSkillContext,
        sessionPurpose: "merger",
        projectRootDir: rootDir,
        pluginRunner: options.pluginRunner,
      });
    } catch {
      // graceful fallback
    }
  }
  const assignedAgentId = taskForSkillContext?.assignedAgentId?.trim();
  const agentStoreWithGetAgent = options.agentStore && typeof (options.agentStore as { getAgent?: unknown }).getAgent === "function"
    ? options.agentStore
    : null;
  const assignedAgent = assignedAgentId && agentStoreWithGetAgent
    ? await agentStoreWithGetAgent.getAgent(assignedAgentId).catch(() => null)
    : null;
  const mergerRuntimeHint = extractRuntimeHint(assignedAgent?.runtimeConfig);

  const systemPrompt = `You are an autostash hard-failure recovery agent for the Fusion merger.

Before the merge ran, the developer had uncommitted local changes. We snapshotted them into a git stash, ran the merge cleanly on top, and tried to re-apply the stash. Both \`git stash apply\` and \`git apply --3way\` failed without producing conflict markers — meaning git refused to attempt the apply at all (typical causes: untracked-file overwrite, a path in the stash no longer exists at HEAD, or an index conflict that produced no in-tree markers).

## Your job
Reconstruct the developer's intended uncommitted changes on top of the current HEAD by editing files directly. The stash patch (sourced from \`git stash show -p ${stashSha}\`) is your authoritative source for what changed.

## Rules
1. Run \`git stash show -p ${stashSha}\` (or read it via your shell) to get the patch text. Read it carefully.
2. For each file in the patch, decide how to apply the developer's intent on top of HEAD's current contents:
   - If the file still exists at HEAD: apply the patch hunks, integrating with any merge changes that overlap.
   - If the file was deleted at HEAD: re-create it (the developer presumably wanted it) UNLESS the patch was deleting it too — in which case do nothing.
   - If the file is new (added by the patch): create it with the patch contents.
3. Do NOT make git commits. Do NOT run \`git add\` or \`git stash drop\`. Just edit files in the working tree.
4. Do NOT touch files outside the patch.
5. If a hunk's surrounding context no longer exists at HEAD (e.g., merge changed the function signature), make a reasonable best-effort placement and add a brief \`// TODO(autostash-recovery)\` comment so the developer can review.
6. NO conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) may remain in the working tree when you finish — those would block follow-up tooling.

The orchestrator will scan the working tree for conflict markers post-run; any remaining will be treated as a failed recovery.`;

  const fileList = stashFiles.map((f) => `- ${f}`).join("\n");
  const prompt = `Recover the developer's uncommitted changes for task ${taskId}.

## Original git error
${applyErrorMsg}
${applyStderr ? `\n## Git stderr\n\`\`\`\n${applyStderr}\n\`\`\`` : ""}

## Stash SHA (source of truth for the patch)
${stashSha}

## Files mentioned in the stash
${fileList}

## Steps
1. Run \`git stash show -p ${stashSha}\` to read the developer's intended changes
2. For each file, integrate those changes onto the current HEAD by editing the file directly
3. When done, NO conflict markers may remain in the working tree
4. Do NOT commit, do NOT touch the stash, do NOT modify files outside the list above`;

  mergerLog.log(`${taskId}: starting autostash hard-fail recovery agent (${stashFiles.length} file(s))`);

  const { session } = await createResolvedAgentSession({
    sessionPurpose: "merger",
    runtimeHint: mergerRuntimeHint,
    pluginRunner: options.pluginRunner,
    cwd: rootDir,
    systemPrompt,
    tools: "coding",
    onText: agentLogger.onText,
    onThinking: agentLogger.onThinking,
    onToolStart: agentLogger.onToolStart,
    onToolEnd: agentLogger.onToolEnd,
    defaultProvider: settings.defaultProviderOverride && settings.defaultModelIdOverride
      ? settings.defaultProviderOverride
      : settings.defaultProvider,
    defaultModelId: settings.defaultProviderOverride && settings.defaultModelIdOverride
      ? settings.defaultModelIdOverride
      : settings.defaultModelId,
    fallbackProvider: settings.fallbackProvider,
    fallbackModelId: settings.fallbackModelId,
    defaultThinkingLevel: settings.defaultThinkingLevel,
    ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    taskId,
    taskTitle: taskForSkillContext?.title,
    onFallbackModelUsed: createFallbackModelObserver({
      agent: "merger",
      label: "autostash hard-fail recovery agent",
      store,
      taskId,
      taskTitle: taskForSkillContext?.title,
    }),
  });
  options.onSession?.(session);

  try {
    await store.appendAgentLog(
      taskId,
      `Autostash hard-fail recovery agent started (model: ${describeModel(session)}, files: ${stashFiles.length})`,
      "text",
      undefined,
      "merger",
    );

    await withRateLimitRetry(async () => {
      throwIfAborted(options.signal, taskId);
      await promptWithFallback(session, prompt);
      checkSessionError(session);
    }, {
      onRetry: (attempt, delayMs, error) => {
        const delaySec = Math.round(delayMs / 1000);
        mergerLog.warn(`⏳ ${taskId} autostash hard-fail agent rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
      },
      signal: options.signal,
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: autostash hard-fail agent error: ${msg}`);
    await store.logEntry(taskId, "Autostash hard-fail recovery agent encountered an error", msg);
    return { success: false, error: msg };
  } finally {
    try {
      session.dispose();
    } catch {
      // ignore
    }
  }
}

/**
 * Restore the autostash created by `stashUnrelatedRootDirChanges` after a
 * merge completes. Best-effort: any failure logs a warning but does not
 * throw — by the time we reach the finally block the merge result has
 * already been recorded, and a stash failure should never mask or undo a
 * successful merge.
 *
 * Flow:
 *   1. `git stash apply <sha>` — does NOT auto-drop, so on conflict the
 *      stash stays put without us having to rely on pop's keep-on-fail
 *      behavior. SHA is used so the operation is robust to stash list
 *      reordering from concurrent tools.
 *   2. On clean apply: drop the stash by SHA, return `restored`.
 *   3. On apply conflict (working tree has conflict markers): if smart
 *      conflict resolution is enabled, spawn an AI fix-agent to resolve
 *      the markers in place; on success drop the stash and return
 *      `ai-resolved`. Otherwise return `conflict-needs-manual` and leave
 *      the stash for the developer to recover by hand.
 *   4. On apply HARD failure (no markers, nothing applied): try
 *      `git apply --3way` from the patch, fall through to AI patch-recovery
 *      if needed. See `tryRecoverHardFailApply`.
 */
async function restoreUnrelatedRootDirChanges(
  rootDir: string,
  taskId: string,
  handle: AutostashHandle,
  ctx: {
    store: TaskStore;
    options: MergerOptions;
    settings: Settings;
  },
): Promise<AutostashOutcome> {
  const { sha } = handle;

  // Use apply (not pop) so a conflict doesn't leave us in an ambiguous
  // half-popped state — apply never auto-drops, so the stash is always
  // recoverable under any failure mode.
  let applyConflicted = false;
  let applyStderr = "";
  let applyErrorMsg = "";
  try {
    await execAsync(`git stash apply ${sha}`, { cwd: rootDir });
  } catch (err: unknown) {
    const errAsRecord = err as { stderr?: string; stdout?: string; message?: string };
    applyErrorMsg = err instanceof Error ? err.message : String(err);
    // execAsync (util.promisify of child_process.exec) attaches stderr/stdout
    // to the error object. Capture them so the operator can distinguish
    // untracked-overwrite ("would be overwritten by merge") from index-conflict
    // from missing-SHA without having to grep runtime logs.
    applyStderr = String(errAsRecord.stderr ?? errAsRecord.stdout ?? "").trim();
    // git stash apply exits non-zero both on hard failure (e.g. SHA gone)
    // and on conflict-with-applied-changes. Distinguish by checking the
    // working tree for conflict markers.
    const conflicted = await getConflictedFiles(rootDir);
    if (conflicted.length === 0) {
      // Hard failure — apply put nothing in the working tree (no conflict
      // markers). Try AI recovery before giving up.
      mergerLog.warn(
        `${taskId}: autostash ${sha.slice(0, 7)} hard-fail apply (${applyErrorMsg}); stderr=${applyStderr || "(empty)"}`,
      );
      const hardFailOutcome = await tryRecoverHardFailApply({
        rootDir,
        taskId,
        sha,
        applyErrorMsg,
        applyStderr,
        ctx,
      });
      return hardFailOutcome;
    }
    applyConflicted = true;
    mergerLog.warn(
      `${taskId}: autostash apply hit conflict in ${conflicted.length} file(s): ${conflicted.join(", ")}`,
    );
  }

  if (!applyConflicted) {
    // Clean apply — drop the stash and we're done.
    mergerLog.log(`${taskId}: restored autostash ${sha.slice(0, 7)} cleanly`);
    const dropResult = await dropAutostashBySha(rootDir, taskId, sha);
    if (dropResult.dropped) {
      await ctx.store
        .logEntry(
          taskId,
          `Restored pre-merge autostash ${sha.slice(0, 7)} cleanly`,
        )
        .catch(() => undefined);
    } else {
      // Apply succeeded but drop failed — the working tree has the dev's
      // changes but the stash is still in the list. Surface honestly so the
      // operator can `git stash drop` it manually.
      await ctx.store
        .logEntry(
          taskId,
          `Restored pre-merge autostash ${sha.slice(0, 7)} (apply clean), but stash entry failed to drop and is still in the list`,
          `Drop failure: ${dropResult.reason ?? "unknown"}\n\nClean up manually with:\n  cd ${rootDir} && git stash list | grep ${sha.slice(0, 7)} && git stash drop <ref>`,
        )
        .catch(() => undefined);
    }
    return { status: "restored", stashSha: sha };
  }

  // Conflict path: try AI resolution if enabled.
  const conflictedFiles = await getConflictedFiles(rootDir);
  const smartConflictResolution =
    (ctx.settings.smartConflictResolution ?? ctx.settings.autoResolveConflicts) !== false;

  if (!smartConflictResolution) {
    const message = `Autostash apply conflicted in ${conflictedFiles.length} file(s) and smartConflictResolution is disabled. Stash ${sha.slice(0, 7)} left intact; resolve manually with: cd ${rootDir} && # edit files, then git stash drop <ref>`;
    mergerLog.warn(`${taskId}: ${message}`);
    await ctx.store
      .logEntry(
        taskId,
        `Autostash apply conflicted in ${conflictedFiles.length} file(s) — manual resolution required (smart resolution disabled)`,
        message,
      )
      .catch(() => undefined);
    return {
      status: "conflict-needs-manual",
      stashSha: sha,
      conflictedFiles,
      message,
    };
  }

  await ctx.store.logEntry(
    taskId,
    `Autostash apply conflicted in ${conflictedFiles.length} file(s) — invoking AI to resolve`,
    conflictedFiles.join("\n"),
  );

  const aiResult = await runAiAgentForAutostashConflict({
    store: ctx.store,
    rootDir,
    taskId,
    conflictedFiles,
    options: ctx.options,
    settings: ctx.settings,
  });

  if (!aiResult.success) {
    const message = `Autostash apply conflict, AI resolution failed (${aiResult.error ?? "unknown error"}). Stash ${sha.slice(0, 7)} left intact; recover with: cd ${rootDir} && git status (conflicts in working tree) && # resolve, then git stash drop <ref>`;
    mergerLog.warn(`${taskId}: ${message}`);
    await ctx.store
      .logEntry(taskId, `Autostash AI conflict resolution failed — manual recovery required`, message)
      .catch(() => undefined);
    return {
      status: "conflict-needs-manual",
      stashSha: sha,
      conflictedFiles,
      message,
    };
  }

  // Verify the agent actually removed all conflict markers.
  const stillConflicted = await findFilesWithConflictMarkers(rootDir, conflictedFiles);
  if (stillConflicted.length > 0) {
    const message = `AI agent reported success but conflict markers remain in: ${stillConflicted.join(", ")}. Stash ${sha.slice(0, 7)} left intact; recover manually.`;
    mergerLog.warn(`${taskId}: ${message}`);
    await ctx.store
      .logEntry(taskId, `Autostash AI conflict resolution incomplete — manual recovery required`, message)
      .catch(() => undefined);
    return {
      status: "conflict-needs-manual",
      stashSha: sha,
      conflictedFiles: stillConflicted,
      message,
    };
  }

  // Success — AI resolved the conflict. Drop the stash since its content
  // has been applied (with conflict resolution edits on top).
  mergerLog.log(
    `${taskId}: AI-resolved autostash conflict in ${conflictedFiles.length} file(s); dropping stash ${sha.slice(0, 7)}`,
  );
  const aiDropResult = await dropAutostashBySha(rootDir, taskId, sha);
  if (aiDropResult.dropped) {
    await ctx.store.logEntry(
      taskId,
      `Autostash conflict resolved by AI in ${conflictedFiles.length} file(s)`,
      conflictedFiles.join("\n"),
    );
  } else {
    await ctx.store.logEntry(
      taskId,
      `Autostash conflict resolved by AI in ${conflictedFiles.length} file(s), but stash entry failed to drop`,
      `Resolved files:\n${conflictedFiles.join("\n")}\n\nDrop failure: ${aiDropResult.reason ?? "unknown"}\n\nClean up manually with:\n  cd ${rootDir} && git stash list | grep ${sha.slice(0, 7)} && git stash drop <ref>`,
    );
  }

  return {
    status: "ai-resolved",
    stashSha: sha,
    conflictedFiles,
  };
}

async function generateAiMergeSummary(
  commitLog: string,
  diffStat: string,
  settings: Settings,
  rootDir: string,
): Promise<string | null> {
  try {
    const resolved = resolveTitleSummarizerSettingsModel(settings);
    return await summarizeMergeCommit(
      commitLog,
      diffStat,
      rootDir,
      resolved.provider,
      resolved.modelId,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`AI merge summary failed; using deterministic fallback (${message})`);
    return null;
  }
}

async function generateAiMergeSubject(
  commitLog: string,
  diffStat: string,
  settings: Settings,
  rootDir: string,
  branch: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const resolved = resolveTitleSummarizerSettingsModel(settings);
    return await summarizeCommitSubject(
      diffStat,
      rootDir,
      resolved.provider,
      resolved.modelId,
      { branch, taskId, commitLog, signal },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`AI merge subject failed; using deterministic fallback (${message})`);
    return null;
  }
}

/**
 * Derive a non-AI subject summary from the branch's step commit log. The log
 * is `- subj1\n- subj2\n…` (most recent first). The naive "use lines[0]" choice
 * is wrong in practice: when a quality-gate revision lands as the final commit
 * (e.g. a token-cleanup fixup after Step 4), the most-recent subject describes
 * the *fixup*, not the task. So we prefer, in order:
 *   1. The lowest-numbered `complete Step N — …` commit (the headline step)
 *   2. The oldest commit (lines[last]) — typically Step 1 / the first feat
 *      commit on the branch
 *
 * Conventional-commit prefix is stripped to avoid `feat: feat(...): …`, and we
 * tack on `(+N more)` when the branch has multiple step commits.
 */
export function deriveDeterministicSubjectSummary(commitLog: string): string | null {
  const lines = commitLog
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  const stripBullet = (l: string) => l.replace(/^[-*]\s+/, "").trim();
  const stripConventional = (l: string) =>
    l.replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "").trim();
  const cleaned = lines.map((l) => stripConventional(stripBullet(l)));

  // Separator is em-dash (U+2014), ASCII hyphen, or colon. Spelled with
  // explicit alternation rather than a character class so the em-dash
  // intent is obvious to anyone auditing this regex.
  const stepRe = /^complete Step (\d+)\s*(?:—|-|:)\s*(.+)$/i;
  let bestStep: { n: number; summary: string } | null = null;
  for (const c of cleaned) {
    const m = c.match(stepRe);
    if (!m) continue;
    const n = Number(m[1]);
    const summary = m[2].trim();
    if (!summary) continue;
    if (!bestStep || n < bestStep.n) bestStep = { n, summary };
  }

  const headline = bestStep?.summary ?? cleaned[cleaned.length - 1];
  if (!headline) return null;

  const extras = lines.length - 1;
  const summary = extras > 0 ? `${headline} (+${extras} more)` : headline;
  return summary;
}

/**
 * Build the canonical merge commit message from the branch's step commits.
 * Subject preference order:
 *   1. AI summarizer (`summarizeCommitSubject`) when it succeeded
 *   2. First step commit subject (with conventional prefix stripped) + `(+N more)`
 *   3. `merge <branch>` (last-resort, only when no step commits exist)
 */
async function buildDeterministicMergeMessage(params: {
  taskId: string;
  branch: string;
  commitLog: string;
  diffStat?: string;
  includeTaskId: boolean;
  aiSummary?: string | null;
  aiSubject?: string | null;
}): Promise<{ subjectArg: string; bodyArg: string }> {
  const { taskId, branch, commitLog, diffStat, includeTaskId, aiSummary, aiSubject } = params;
  const prefix = includeTaskId ? `feat(${taskId})` : "feat";
  const trimmedAiSubject = aiSubject?.trim() ?? "";
  const derived = trimmedAiSubject.length === 0
    ? deriveDeterministicSubjectSummary(commitLog ?? "")
    : null;
  const subjectSummary = trimmedAiSubject.length > 0
    ? trimmedAiSubject
    : (derived ?? `merge ${branch}`);
  const subject = `${prefix}: ${subjectSummary}`;

  const trimmedCommitLog = commitLog?.trim() ?? "";
  const trimmedDiffStat = diffStat?.trim() ?? "";

  const commitsSection = trimmedCommitLog.length > 0
    ? trimmedCommitLog
    : `- merge ${branch}`;

  const body = aiSummary?.trim().length
    ? aiSummary.trim()
    : [
      `Commits merged:\n${commitsSection}`,
      trimmedDiffStat.length > 0 ? `Files changed:\n${trimmedDiffStat}` : "",
    ].filter(Boolean).join("\n\n");

  // -m args are double-quoted in the shell command, so escape backslashes,
  // double quotes, dollar signs, and backticks.
  const escape = (s: string) => s.replace(/(["\\$`])/g, "\\$1");
  return {
    subjectArg: `-m "${escape(subject)}"`,
    bodyArg: `-m "${escape(body)}"`,
  };
}

/**
 * Stage current changes and either:
 *   (a) create a fresh squash commit when HEAD has not advanced past
 *       `preAttemptHeadSha` — i.e. the AI agent never ran `git commit` (e.g.
 *       fn_report_build_failure path) and the in-merge fix is finalizing the
 *       merge in its place; or
 *   (b) amend the existing merge commit (with a deterministic message) when
 *       HEAD has moved past `preAttemptHeadSha` — i.e. the AI agent already
 *       committed and the fix is folding follow-up changes into it.
 *
 * Always rewrites the commit message to the deterministic form built from the
 * branch's actual step commits, so consumers of mergeDetails never see a
 * hallucinated body that talks about files that aren't in the diff.
 *
 * Only files that are part of the squash or that the fix agent explicitly
 * modified are staged. Any other dirty files in the working tree are left
 * untouched and a warning is emitted for each one.
 *
 * Returns true on a successful commit/amend. Never throws — errors are logged
 * and the function returns false (callers decide whether to abort the merge).
 *
 * @internal Exported for integration tests only — not part of the public API.
 */
export async function commitOrAmendMergeWithFixes(
  rootDir: string,
  taskId: string,
  branch: string,
  commitLog: string,
  includeTaskId: boolean,
  preAttemptHeadSha: string,
  authorArg: string,
  diffStat?: string,
  settings?: Settings,
  signal?: AbortSignal,
  aiSummary?: string | null,
  aiSubject?: string | null,
  fixModifiedFiles: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  try {
    // Build an allowlist of paths we are permitted to stage.
    // Allowlist = (already staged by squash) ∪ (unstaged ∩ fixModifiedFiles)
    // We also handle untracked files created by the fix agent.
    //
    // FN-2152 still applies: the submodule-gitlink filter below removes any
    // gitlinks that slip through (nested worktrees, etc.).

    // 1. Read currently-staged files (squash produced these) for diagnostic logging.
    const { stdout: squashStagedOut } = await execAsync("git diff --cached --name-only", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const squashStaged = new Set(squashStagedOut.split("\n").map((l) => l.trim()).filter(Boolean));

    // 2. What is currently unstaged (tracked, modified-but-not-staged).
    const { stdout: unstagedOut } = await execAsync("git diff --name-only", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const unstaged = new Set(unstagedOut.split("\n").map((l) => l.trim()).filter(Boolean));

    // 3. Untracked files created by the fix agent (NUL-delimited, no quoting needed).
    const { stdout: porcelainOut } = await execFileAsync("git", ["status", "-z", "--porcelain"], {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const untracked = new Set<string>();
    for (const entry of porcelainOut.split("\0")) {
      if (!entry.startsWith("?? ")) continue;
      const p = entry.slice(3);
      if (p) untracked.add(p);
    }

    // 4. Stage each unstaged path that the fix agent touched (batched, no shell).
    const unstagedToStage: string[] = [];
    for (const p of unstaged) {
      if (fixModifiedFiles.has(p)) {
        unstagedToStage.push(p);
      } else {
        mergerLog.warn(
          `${taskId}: refusing to stage unrelated working-tree change: ${p} (not part of squash or in-merge fix)`,
        );
      }
    }
    if (unstagedToStage.length > 0) {
      await execFileAsync("git", ["add", "--", ...unstagedToStage], { cwd: rootDir });
    }

    // 5. Stage untracked files created by the fix agent (batched, no shell).
    const untrackedToStage: string[] = [];
    for (const p of untracked) {
      if (fixModifiedFiles.has(p)) {
        untrackedToStage.push(p);
      } else {
        mergerLog.warn(
          `${taskId}: refusing to stage unrelated working-tree change: ${p} (not part of squash or in-merge fix)`,
        );
      }
    }
    if (untrackedToStage.length > 0) {
      await execFileAsync("git", ["add", "--", ...untrackedToStage], { cwd: rootDir });
    }

    // Fix 3: cap long path lists to avoid unreadable single-line logs.
    const cap = (arr: string[], n = 20) =>
      arr.length <= n ? arr.join(", ") : `${arr.slice(0, n).join(", ")} ... (+${arr.length - n} more)`;

    mergerLog.log(
      `${taskId}: staging allowlist — squash: [${cap([...squashStaged])}], fixModified: [${cap([...fixModifiedFiles])}]`,
    );

    const { stdout: staged } = await execAsync("git diff --cached --raw", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    for (const line of staged.split("\n")) {
      const match = line.match(/^:\d{6} 160000 [^\t]+\t(.+)$/);
      if (!match) continue;
      const path = match[1];
      mergerLog.warn(`${taskId}: refusing to stage gitlink "${path}" (project uses no submodules — likely a nested worktree). Unstaging.`);
      try {
        await execAsync(`git reset HEAD -- "${path}"`, { cwd: rootDir });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        mergerLog.warn(`${taskId}: failed to unstage gitlink "${path}": ${msg}`);
      }
    }

    const { stdout: finalStaged } = await execAsync("git diff --cached --name-only", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const hasStaged = finalStaged.trim().length > 0;

    const { stdout: currentHeadOut } = await execAsync("git rev-parse HEAD", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const currentHead = currentHeadOut.trim();
    const headMoved = currentHead !== preAttemptHeadSha;

    if (!hasStaged && !headMoved) {
      // FN-1858 guardrail: never claim merge success when we cannot prove this
      // task produced commit content. This finalize path distinguishes three
      // terminal states: (1) committed-by-AI (HEAD already has this task ID),
      // (2) no-op fix where squash state was cleared and must be restored, and
      // (3) real phantom where there is truly no task content to commit.
      if (await headCarriesTaskIdTrailer(rootDir, taskId)) {
        mergerLog.log(
          `${taskId}: HEAD already carries Fusion-Task-Id trailer — treating in-merge fix finalize as no-op success`,
        );
        return true;
      }

      // No commit and no staged content can still be recoverable when the
      // in-merge fix path cleared the previous squash index state. Rebuild the
      // squash from branch -> preAttemptHeadSha and continue normally.
      try {
        await execAsync(`git reset --hard ${preAttemptHeadSha}`, {
          cwd: rootDir,
          encoding: "utf-8",
        });
        await execAsync("git clean -fd", {
          cwd: rootDir,
          encoding: "utf-8",
        });
        await execAsync(`git merge --squash ${branch}`, {
          cwd: rootDir,
          encoding: "utf-8",
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        mergerLog.warn(`${taskId}: failed to restore squash state before finalize: ${msg}`);
      }

      const { stdout: restoredStagedOut } = await execAsync("git diff --cached --name-only", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      if (restoredStagedOut.trim().length === 0) {
        mergerLog.warn(
          `${taskId}: refusing to record merge — no commit was created and no changes are staged. ` +
          `This usually means the AI agent never ran git commit and the in-merge fix had nothing to add.`,
        );
        return false;
      }

      mergerLog.log(`${taskId}: restored squash state after no-op verification fix; proceeding to commit`);
    }

    // Build the message from the actual commit content rather than the
    // wide-range branch context that was gathered before merge. The
    // pre-merge commitLog/diffStat use `merge-base(branch, main)` as base,
    // which under squash-merge workflows can predate already-merged sibling
    // tasks — leading to messages that describe files not in the diff.
    // `preAttemptHeadSha` is the integration target (main's tip just before
    // this merge), so diffing against it gives content truth.
    const actualContext = await computeActualMergeCommitContext({
      rootDir,
      integrationTargetSha: preAttemptHeadSha,
      branch,
    });
    const messageCommitLog = actualContext.commitLog || commitLog;
    const messageDiffStat = actualContext.diffStat || diffStat;

    const { subjectArg, bodyArg } = await buildDeterministicMergeMessage({
      taskId,
      branch,
      commitLog: messageCommitLog,
      diffStat: messageDiffStat,
      includeTaskId,
      aiSummary,
      aiSubject,
    });
    const trailerArg = buildTaskIdTrailerArg(taskId);

    if (!headMoved) {
      // No merge commit yet — create one fresh on top of preAttemptHeadSha.
      // This is the phantom-merge fix: previously the code blindly amended
      // HEAD (the previous task's commit), silently dropping the current
      // task's branch and inheriting the prior task's stats.
      await execAsync(
        `git commit ${subjectArg} ${bodyArg}${trailerArg}${authorArg}`,
        { cwd: rootDir },
      );
      mergerLog.log(`${taskId}: created fresh merge commit after verification fix (no prior commit to amend)`);
      return true;
    }

    // HEAD moved — AI agent committed already. Amend with deterministic
    // message + any new staged fixes folded in. `--amend -m` replaces both
    // the message and includes any newly-staged content.
    await execAsync(
      `git commit --amend ${subjectArg} ${bodyArg}${trailerArg}${authorArg}`,
      { cwd: rootDir },
    );
    mergerLog.log(`${taskId}: amended merge commit with verification fixes (deterministic message)`);
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: failed to finalize merge commit: ${errorMessage}`);
    return false;
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

interface DiffBaseResolutionInput {
  cwd: string;
  headRef: string;
  baseBranch?: string;
  baseCommitSha?: string;
}

/**
 * Resolve the commit ref used as diff base for task-scoped changed-file views.
 *
 * IMPORTANT: This ordering must stay in lockstep with dashboard `resolveDiffBase`
 * so merge-time scope warnings evaluate the exact same change set operators see.
 *
 * Strategy (priority order):
 * 1. Live merge-base between `headRef` and `{baseBranch}` (fallback to
 *    `origin/{baseBranch}` when local ref is missing).
 * 2. `baseCommitSha` when merge-base is unavailable or equals `headRef`, and
 *    the SHA is still an ancestor of `headRef`.
 * 3. `headRef~1` as last resort.
 */
export async function resolveTaskDiffBaseRef({
  cwd,
  headRef,
  baseBranch,
  baseCommitSha,
}: DiffBaseResolutionInput): Promise<string | undefined> {
  // When baseBranch was nulled (e.g., upstream dep merged and its branch was
  // deleted) but a task-scoped baseCommitSha is still recorded, skip the
  // merge-base step so we don't widen the diff range to merge-base(HEAD, main)
  // and surface unrelated history. Only fall back to "main" when neither hint
  // is available (legacy tasks).
  const resolvedBaseBranch = baseBranch?.trim() || (baseCommitSha ? undefined : "main");
  const quotedHeadRef = quoteArg(headRef);
  let mergeBase: string | undefined;

  if (resolvedBaseBranch) {
    try {
      try {
        const { stdout } = await execAsync(`git merge-base ${quotedHeadRef} ${quoteArg(resolvedBaseBranch)}`, {
          cwd,
          encoding: "utf-8",
        });
        mergeBase = stdout.trim() || undefined;
      } catch {
        const { stdout } = await execAsync(`git merge-base ${quotedHeadRef} ${quoteArg(`origin/${resolvedBaseBranch}`)}`, {
          cwd,
          encoding: "utf-8",
        });
        mergeBase = stdout.trim() || undefined;
      }
    } catch {
      // Base branch may not exist locally/remotely.
    }
  }

  // Same guard as dashboard routes: when merge-base === headRef, the range
  // would be empty, so prefer a still-valid task-scoped baseCommitSha.
  if (mergeBase) {
    try {
      const { stdout } = await execAsync(`git rev-parse ${quotedHeadRef}`, {
        cwd,
        encoding: "utf-8",
      });
      const headSha = stdout.trim();
      if (headSha && headSha !== mergeBase) return mergeBase;
    } catch {
      return mergeBase;
    }
  }

  if (baseCommitSha) {
    try {
      await execAsync(`git merge-base --is-ancestor ${quoteArg(baseCommitSha)} ${quotedHeadRef}`, {
        cwd,
        encoding: "utf-8",
      });
      return baseCommitSha;
    } catch {
      // stale or unreachable — fall through
    }
  }

  try {
    const { stdout } = await execAsync(`git rev-parse ${quoteArg(`${headRef}~1`)}`, {
      cwd,
      encoding: "utf-8",
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get list of conflicted files from git.
 * Runs `git diff --name-only --diff-filter=U` and returns array of file paths.
 */
export async function getConflictedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git diff --name-only --diff-filter=U", {
      cwd,
      encoding: "utf-8",
    });
    const output = stdout.trim();

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
export async function isTrivialWhitespaceConflict(filePath: string, cwd: string): Promise<boolean> {
  try {
    // Use git diff-tree to compare index entries with whitespace ignored
    // :2 = ours (current branch), :3 = theirs (incoming branch)
    // -w flag ignores whitespace
    const { stdout } = await execAsync(
      `git diff-tree -p -w -- :2:"${filePath}" :3:"${filePath}"`,
      { cwd, encoding: "utf-8" }
    );

    // If the diff output is empty or contains no actual changes, it's trivial
    // The diff output will have headers but no +/- content lines for whitespace-only changes
    const lines = stdout.split("\n");
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
export async function classifyConflict(filePath: string, cwd: string): Promise<ConflictType> {
  // Check for lock files - always take "ours" (current branch's version)
  if (LOCKFILE_PATTERNS.some((pattern) => matchGlob(filePath, pattern))) {
    return "lockfile-ours";
  }

  // Check for generated files - take "theirs" (keep branch's fresh generation)
  if (GENERATED_PATTERNS.some((pattern) => matchGlob(filePath, pattern))) {
    return "generated-theirs";
  }

  // Check for trivial conflicts (whitespace-only)
  if (await isTrivialWhitespaceConflict(filePath, cwd)) {
    return "trivial-whitespace";
  }

  // Complex conflicts require AI intervention
  return "complex";
}

/**
 * Resolve a conflicted file using "ours" (current branch's version).
 * Runs `git checkout --ours` and `git add`.
 */
export async function resolveWithOurs(filePath: string, cwd: string): Promise<void> {
  try {
    await execFileAsync("git", ["checkout", "--ours", "--", filePath], { cwd });
    await execFileAsync("git", ["add", "--", filePath], { cwd });
    mergerLog.log(`Auto-resolved ${filePath} using --ours`);
  } catch (error) {
    throw new Error(`Failed to auto-resolve ${filePath} with ours: ${error}`);
  }
}

/**
 * Resolve a conflicted file using "theirs" (incoming branch's version).
 * Runs `git checkout --theirs` and `git add`.
 */
export async function resolveWithTheirs(filePath: string, cwd: string): Promise<void> {
  try {
    await execFileAsync("git", ["checkout", "--theirs", "--", filePath], { cwd });
    await execFileAsync("git", ["add", "--", filePath], { cwd });
    mergerLog.log(`Auto-resolved ${filePath} using --theirs`);
  } catch (error) {
    throw new Error(`Failed to auto-resolve ${filePath} with theirs: ${error}`);
  }
}

/**
 * Resolve a trivial whitespace conflict.
 * For trivial conflicts, we can just stage the file (git considers it resolved).
 */
export async function resolveTrivialWhitespace(filePath: string, cwd: string): Promise<void> {
  try {
    await execFileAsync("git", ["add", "--", filePath], { cwd });
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
export async function detectResolvableConflicts(rootDir: string): Promise<ConflictCategory[]> {
  const files = await getConflictedFiles(rootDir);
  const results: ConflictCategory[] = [];
  for (const filePath of files) {
    const type = await classifyConflict(filePath, rootDir);
    switch (type) {
      case "lockfile-ours":
        results.push({ filePath, autoResolvable: true, strategy: "ours", reason: "lock-file" });
        break;
      case "generated-theirs":
        results.push({ filePath, autoResolvable: true, strategy: "theirs", reason: "generated-file" });
        break;
      case "trivial-whitespace":
        results.push({ filePath, autoResolvable: true, strategy: "ours", reason: "trivial" });
        break;
      case "complex":
        results.push({ filePath, autoResolvable: false, reason: "complex" });
        break;
    }
  }
  return results;
}

/**
 * Auto-resolve a single file using git checkout --ours or --theirs.
 * @deprecated Use resolveWithOurs() or resolveWithTheirs() instead.
 */
export async function autoResolveFile(
  filePath: string,
  resolution: ConflictResolution,
  rootDir: string,
): Promise<void> {
  if (resolution === "ours") {
    await resolveWithOurs(filePath, rootDir);
  } else {
    await resolveWithTheirs(filePath, rootDir);
  }
}

/**
 * Auto-resolve all resolvable conflicts from the categorization.
 * @deprecated Use classifyConflict + resolveWithOurs/resolveWithTheirs instead.
 */
export async function resolveConflicts(
  categories: ConflictCategory[],
  rootDir: string,
): Promise<string[]> {
  const remainingComplex: string[] = [];
  for (const category of categories) {
    if (category.autoResolvable && category.strategy) {
      await autoResolveFile(category.filePath, category.strategy, rootDir);
    } else {
      remainingComplex.push(category.filePath);
    }
  }
  return remainingComplex;
}

/** Trailer key written into every Fusion-managed merge commit body. Used by
 *  recovery (findLandedTaskCommit) to identify a task's commit even when the
 *  configured commit subject doesn't include the task ID
 *  (`includeTaskIdInCommit: false`). */
export const FUSION_TASK_ID_TRAILER_KEY = "Fusion-Task-Id";

/** Build the `-m "Fusion-Task-Id: <id>"` arg fragment used in fallback commit
 *  invocations. Returns a leading space + quoted -m arg. */
function buildTaskIdTrailerArg(taskId: string): string {
  // Task IDs are constrained ([A-Z]+-[0-9]+) so embedding directly is safe.
  return ` -m "${FUSION_TASK_ID_TRAILER_KEY}: ${taskId}"`;
}

/** True iff HEAD's commit message contains the `Fusion-Task-Id: <taskId>`
 *  trailer. Used by the in-merge fix finalizer to recognize that the merge
 *  commit already landed on HEAD (e.g. via the AI commit on a prior attempt)
 *  before tripping the phantom-merge guard. Best-effort: any error returns
 *  false so callers fall back to the conservative "refuse to fabricate" path. */
async function headCarriesTaskIdTrailer(rootDir: string, taskId: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git log -1 --pretty=%B HEAD", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    // Anchor to line boundaries so e.g. FN-37 doesn't match a body line
    // mentioning FN-3727. Trailer lines are produced by git itself, so the
    // exact `Key: Value` form is what we look for.
    const escapedId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|\\n)${FUSION_TASK_ID_TRAILER_KEY}: ${escapedId}\\s*(?:\\n|$)`);
    return pattern.test(stdout);
  } catch {
    return false;
  }
}

/** Idempotently add the Fusion-Task-Id trailer to HEAD's commit. Used after
 *  the AI agent commits to guarantee the trailer is present even when the
 *  agent didn't include it (especially under includeTaskIdInCommit=false,
 *  where the subject also lacks the task ID and recovery has nothing to
 *  grep against). No-op if the trailer is already on HEAD. */
async function ensureTaskIdTrailerOnHead(rootDir: string, taskId: string): Promise<void> {
  try {
    const { stdout: existingMessage } = await execAsync("git log -1 --pretty=%B", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const trailerLine = `${FUSION_TASK_ID_TRAILER_KEY}: ${taskId}`;
    if (existingMessage.includes(trailerLine)) return;
    // git interpret-trailers is the canonical way to add trailers without
    // disturbing the rest of the body. --if-exists addIfDifferentNeighbor
    // ensures we don't double-up if a slightly different trailer is present.
    await execAsync(
      `git -c trailer.ifExists=addIfDifferent commit --amend --no-edit --trailer "${trailerLine}"`,
      { cwd: rootDir },
    );
  } catch (err) {
    // Best-effort: if amending fails (detached HEAD, sign-off conflict, etc.)
    // we still recorded mergeDetails further on. Recovery will fall back to
    // subject grep. Don't surface this as a merge failure.
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: failed to add ${FUSION_TASK_ID_TRAILER_KEY} trailer to HEAD (${msg}) — relying on subject grep for recovery`);
  }
}

/** Build the --author flag for git commits based on project settings. */
function getCommitAuthorArg(settings: {
  commitAuthorEnabled?: boolean;
  commitAuthorName?: string;
  commitAuthorEmail?: string;
}): string {
  if (settings.commitAuthorEnabled === false) return "";
  const name = settings.commitAuthorName || "Fusion";
  const email = settings.commitAuthorEmail || "noreply@runfusion.ai";
  return ` --author="${name} <${email}>"`;
}

export function buildSourceIssueRef(sourceIssue?: TaskSourceIssue | null): string {
  if (!sourceIssue || sourceIssue.provider !== "github" || !sourceIssue.repository) return "";

  const issueNumber = sourceIssue.issueNumber
    ?? Number.parseInt(sourceIssue.externalIssueId ?? "", 10);

  if (!Number.isInteger(issueNumber) || issueNumber < 1) return "";
  return `${sourceIssue.repository}#${issueNumber}`;
}

/**
 * Build the merge system prompt. When `includeTaskId` is true (default),
 * the commit format uses `<type>(<scope>): <summary>` where scope is the
 * task ID. When false, it uses `<type>: <summary>` with no scope.
 */
function buildMergeSystemPrompt(includeTaskId: boolean, agentPrompts?: AgentPromptsConfig, authorArg?: string): string {
  const commitFormat = includeTaskId
    ? `\`\`\`
git commit -m "<type>(<scope>): <summary>" -m "<body>"${authorArg || ""}
\`\`\`

Message format:
- **Type:** feat, fix, refactor, docs, test, chore
- **Scope:** the task ID (e.g., KB-001)
- **Summary:** one line describing what the squash brings in (imperative mood)
- **Body:** 2-5 bullet points summarizing the key changes, each starting with "- "
- **GitHub reference:** when the prompt includes a source issue reference, add \`Ref: owner/repo#N\` to the commit body
${authorArg ? `- **Author:** Always include the --author flag as shown in the example above.` : ""}

Example:
\`\`\`
git commit -m "feat(KB-003): add user profile page" -m "- Add /profile route with avatar upload
- Create ProfileCard and EditProfileForm components
- Add profile image resizing via sharp
- Update nav bar with profile link
- Add profile e2e tests"${authorArg || ""}
\`\`\``
    : `\`\`\`
git commit -m "<type>: <summary>" -m "<body>"${authorArg || ""}
\`\`\`

Message format:
- **Type:** feat, fix, refactor, docs, test, chore
- **Summary:** one line describing what the squash brings in (imperative mood)
- **Body:** 2-5 bullet points summarizing the key changes, each starting with "- "
- **GitHub reference:** when the prompt includes a source issue reference, add \`Ref: owner/repo#N\` to the commit body
${authorArg ? `- **Author:** Always include the --author flag as shown in the example above.` : ""}
Do NOT include a scope in the commit message type.

Example:
\`\`\`
git commit -m "feat: add user profile page" -m "- Add /profile route with avatar upload
- Create ProfileCard and EditProfileForm components
- Add profile image resizing via sharp
- Update nav bar with profile link
- Add profile e2e tests"${authorArg || ""}
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
   - Call the \`fn_report_build_failure\` tool with the real error details
   - Stop immediately and do not run \`git commit\`
   - Do not claim success in plain text

The merge will only be completed if the build passes or no build command is configured.`;
  }

  return `You are a merge agent for "fn", an AI-orchestrated task board.

## Your Role
You are the final integration gate between completed task work and mainline history.
Your responsibility is to preserve intent from both sides, avoid regressions, and produce a clean, auditable squash merge commit.

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

Common conflict guidance:
- Preserve both sides when each contributes non-overlapping behavior.
- Choose one side only when the other is obsolete, duplicated, or clearly incorrect.
- When in doubt, reconcile explicitly and keep tests/build green as source of truth.

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
   - Call the \`fn_report_build_failure\` tool with the real error details
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
  const tasks = await store.listTasks({ slim: true, includeArchived: false });
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
  /** Abort signal used to stop an in-flight merge when the engine is shutting down. */
  signal?: AbortSignal;
  /** AgentStore for resolving per-agent custom instructions. */
  agentStore?: import("@fusion/core").AgentStore;
  /** Plugin runner for runtime selection. When provided, enables plugin runtime lookup. */
  pluginRunner?: import("./plugin-runner.js").PluginRunner;
}

function quoteArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * Resolve a non-empty commit body for fallback merge commits. Used by sites
 * that would otherwise emit `-m ""` when the branch's commit log is empty
 * (no unique commits, `git log` failed, etc.).
 *
 * Cascade — most informative first, deterministic fallback at the end so
 * the function NEVER returns an empty string and NEVER throws:
 *   1. The branch's commit log if non-empty.
 *   2. AI-generated body via `summarizeCommitBody` from `@fusion/core`,
 *      using the title-summarizer model lane when configured. Bounded by
 *      a timeout; any failure / timeout / empty response falls through.
 *   3. The diff stat formatted as a "Files changed" listing.
 *   4. A synthetic `- merge <branch>` placeholder.
 */
async function resolveSafeCommitBody(opts: {
  rootDir: string;
  taskId: string;
  branch: string;
  commitLog: string;
  diffStat: string;
  settings: Settings;
  signal?: AbortSignal;
  aiTimeoutMs?: number;
}): Promise<string> {
  const cleanLog = opts.commitLog.trim();
  if (cleanLog.length > 0) return cleanLog;

  const cleanStat = opts.diffStat.trim();
  if (cleanStat.length > 0) {
    if (opts.settings.useAiMergeCommitSummary) {
      // Prefer the dedicated title-summarization model — a small, fast tier
      // intended for short summarization. Falls back to the project / global
      // default model when the summarizer lane isn't configured. The core
      // `summarizeCommitBody` helper handles missing-runtime / timeout / empty
      // response gracefully and returns null.
      const useTitleSummarizer =
        !!opts.settings.titleSummarizerProvider && !!opts.settings.titleSummarizerModelId;
      const provider = useTitleSummarizer
        ? opts.settings.titleSummarizerProvider!
        : (opts.settings.defaultProviderOverride && opts.settings.defaultModelIdOverride
            ? opts.settings.defaultProviderOverride
            : opts.settings.defaultProvider);
      const modelId = useTitleSummarizer
        ? opts.settings.titleSummarizerModelId!
        : (opts.settings.defaultProviderOverride && opts.settings.defaultModelIdOverride
            ? opts.settings.defaultModelIdOverride
            : opts.settings.defaultModelId);

      const ai = await summarizeCommitBody(cleanStat, opts.rootDir, provider, modelId, {
        branch: opts.branch,
        taskId: opts.taskId,
        signal: opts.signal,
        timeoutMs: opts.aiTimeoutMs,
      }).catch(() => null);
      if (ai && ai.trim().length > 0) return ai.trim();
    }
    return `Files changed:\n\n${cleanStat}`;
  }

  return `- merge ${opts.branch}`;
}

/**
 * Compute `git patch-id` for a single commit. Returns the patch-id string on
 * success or undefined when the commit has no diff (root, empty merge) or the
 * pipeline failed. Patch-ids are stable across squash/cherry-pick operations
 * — two commits with the same logical change produce the same patch-id even
 * if their tree/parent SHAs differ.
 */
async function commitPatchId(rootDir: string, sha: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(
      `git diff-tree -p ${quoteArg(sha)} | git patch-id --stable`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    const line = stdout.trim();
    if (!line) return undefined;
    // Output format: "<patch-id> <commit-sha>"; we only need the first token.
    const [pid] = line.split(/\s+/, 1);
    return pid || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collect patch-ids for the last `windowSize` commits reachable from `target`.
 * Bounded so we don't pay for full-repo scans on large histories. The window
 * is large enough to catch typical squash-merge orphans (which match recent
 * main commits) without being expensive.
 */
async function collectPatchIds(
  rootDir: string,
  target: string,
  windowSize: number,
): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const { stdout } = await execAsync(
      `git log -n ${Math.max(1, windowSize)} --format=%H ${quoteArg(target)}`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    const shas = stdout.trim().split("\n").filter(Boolean);
    for (const sha of shas) {
      const pid = await commitPatchId(rootDir, sha);
      if (pid) ids.add(pid);
    }
  } catch {
    // Fall through with whatever we collected; caller treats empty as
    // "no duplicates found, proceed without stripping".
  }
  return ids;
}

/**
 * Compute the actual content of the merge commit being finalized, expressed as
 * `{ commitLog, diffStat }` ready to feed into `buildDeterministicMergeMessage`.
 *
 * The wide-range values gathered before merge (`baseCommitSha..branch`) are
 * unreliable as commit-message context in a squash-merge workflow: when an
 * earlier task is squash-merged onto `main`, branches that forked off the
 * pre-squash `main` no longer share ancestry with it, so `merge-base(branch,
 * main)` resolves to a point *before* the earlier task — and the resulting
 * diffstat/commitLog describe work that was already merged via the prior
 * squash. The commit message then talks about files that aren't in the diff.
 *
 * This helper computes truth from content:
 * - `diffStat` = `git diff --cached <integrationTargetSha> --stat` when there
 *   are staged changes (covers both the pre-commit and amend-with-staged
 *   paths), otherwise `git diff <integrationTargetSha> HEAD --stat` (covers
 *   the message-only amend path where the commit already exists).
 * - `commitLog` = subjects of `git log integrationTarget..branch`, with
 *   already-squashed commits filtered out by patch-id (using
 *   `collectPatchIds` / `commitPatchId`, the same primitives the rest of the
 *   merger uses for orphan detection).
 *
 * Best-effort: any git failure returns an empty string for that field, and
 * the caller's downstream fallback (`buildDeterministicMergeMessage`) handles
 * empty inputs gracefully.
 */
async function computeActualMergeCommitContext(params: {
  rootDir: string;
  integrationTargetSha: string;
  branch: string;
}): Promise<{ commitLog: string; diffStat: string }> {
  const { rootDir, integrationTargetSha, branch } = params;
  const targetArg = quoteArg(integrationTargetSha);

  let diffStat = "";
  try {
    const { stdout: stagedStat } = await execAsync(
      `git diff --cached ${targetArg} --stat`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    diffStat = stagedStat.trim();
    if (diffStat.length === 0) {
      const { stdout: headStat } = await execAsync(
        `git diff ${targetArg} HEAD --stat`,
        { cwd: rootDir, encoding: "utf-8" },
      );
      diffStat = headStat.trim();
    }
  } catch {
    // best-effort
  }

  let commitLog = "";
  try {
    const targetPatchIds = await collectPatchIds(rootDir, integrationTargetSha, 200);
    const { stdout: branchShas } = await execAsync(
      `git log ${targetArg}..${quoteArg(branch)} --format=%H`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    const shas = branchShas.trim().split("\n").filter(Boolean);
    const lines: string[] = [];
    for (const sha of shas) {
      const pid = await commitPatchId(rootDir, sha);
      if (pid && targetPatchIds.has(pid)) continue;
      try {
        const { stdout: subj } = await execAsync(
          `git log -1 ${quoteArg(sha)} --format=%s`,
          { cwd: rootDir, encoding: "utf-8" },
        );
        const s = subj.trim();
        if (s) lines.push(`- ${s}`);
      } catch {
        // skip this commit on failure
      }
    }
    commitLog = lines.join("\n");
  } catch {
    // best-effort
  }

  return { commitLog, diffStat };
}

/**
 * List commits unique to `branch` relative to `target`, oldest-first so they
 * can be cherry-picked in order.
 */
async function listBranchCommits(
  rootDir: string,
  target: string,
  branch: string,
): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `git log --reverse --format=%H ${quoteArg(target)}..${quoteArg(branch)}`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function getCommandErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as Error & { stderr?: string | Buffer }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
    if (Buffer.isBuffer(stderr) && stderr.toString().trim()) return stderr.toString().trim();
    return error.message;
  }
  return String(error);
}

function isNonFastForwardPushError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("non-fast-forward")
    || normalized.includes("[rejected]")
    || normalized.includes("fetch first")
    || normalized.includes("failed to push some refs");
}

function isRebaseInProgress(rootDir: string): boolean {
  try {
    execSync("git rev-parse --verify REBASE_HEAD", {
      cwd: rootDir,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function parsePushRemoteTarget(rootDir: string, pushRemote?: string): { remote: string; branch: string } {
  const rawTarget = pushRemote?.trim() || "origin";
  const [remoteToken, ...branchTokens] = rawTarget.split(/\s+/).filter(Boolean);
  const remote = remoteToken || "origin";

  let branch = branchTokens.join(" ").trim();
  if (!branch) {
    branch = execSyncText("git symbolic-ref --short HEAD", {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  }

  if (!branch) {
    throw new Error(`Unable to determine branch for push target "${rawTarget}"`);
  }

  return { remote, branch };
}

async function resolveComplexRebaseConflictsWithAi(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  settings: Settings,
  conflictedFiles: string[],
  options?: {
    onAgentText?: (delta: string) => void;
    pluginRunner?: import("./plugin-runner.js").PluginRunner;
    signal?: AbortSignal;
    runtimeHint?: string;
    onSession?: (session: { dispose: () => void }) => void;
  },
): Promise<void> {
  mergerLog.log(`${taskId}: resolving ${conflictedFiles.length} complex rebase conflict(s) with AI`);

  const includeTaskId = settings.includeTaskIdInCommit !== false;
  const authorArg = getCommitAuthorArg(settings);
  const basePrompt = buildMergeSystemPrompt(includeTaskId, settings.agentPrompts, authorArg);
  const systemPrompt = `${basePrompt}

## Rebase conflict-only mode
You are assisting with a paused \`git pull --rebase\`.
- Resolve conflicted files and stage them with \`git add\`.
- Do NOT run \`git commit\`, \`git merge\`, or \`git rebase --continue\`.
- Do NOT perform unrelated edits outside conflicted files.
- Finish when all conflicts are resolved and staged.`;

  const agentLogger = new AgentLogger({
    store,
    taskId,
    agent: "merger",
    persistAgentToolOutput: settings.persistAgentToolOutput,
    onAgentText: options?.onAgentText
      ? (_id, delta) => options.onAgentText?.(delta)
      : undefined,
  });

  throwIfAborted(options?.signal, taskId);
  const { session } = await createResolvedAgentSession({
    sessionPurpose: "merger",
    runtimeHint: options?.runtimeHint,
    pluginRunner: options?.pluginRunner,
    cwd: rootDir,
    systemPrompt,
    tools: "coding",
    onText: agentLogger.onText,
    onThinking: agentLogger.onThinking,
    onToolStart: agentLogger.onToolStart,
    onToolEnd: agentLogger.onToolEnd,
    defaultProvider: settings.defaultProviderOverride && settings.defaultModelIdOverride
      ? settings.defaultProviderOverride
      : settings.defaultProvider,
    defaultModelId: settings.defaultProviderOverride && settings.defaultModelIdOverride
      ? settings.defaultModelIdOverride
      : settings.defaultModelId,
    fallbackProvider: settings.fallbackProvider,
    fallbackModelId: settings.fallbackModelId,
    defaultThinkingLevel: settings.defaultThinkingLevel,
    taskId,
    onFallbackModelUsed: createFallbackModelObserver({
      agent: "merger",
      label: "rebase conflict resolver",
      store,
      taskId,
    }),
  });
  // Register so engine.stop() can dispose this session — without this, an
  // in-progress rebase conflict resolution keeps streaming past shutdown
  // (the engine only tracks the autostash session by default).
  options?.onSession?.(session);

  const prompt = [
    `Resolve rebase conflicts for task ${taskId}.`,
    "",
    "Conflicted files:",
    ...conflictedFiles.map((file) => `- ${file}`),
    "",
    "After resolving each file, stage it with `git add <file>`. Do not create a commit.",
  ].join("\n");

  try {
    await withRateLimitRetry(async () => {
      throwIfAborted(options?.signal, taskId);
      await promptWithFallback(session, prompt);
      checkSessionError(session);
    }, {
      onRetry: (attempt, delayMs, error) => {
        mergerLog.warn(
          `${taskId}: rate limited while resolving rebase conflicts — retry ${attempt} in ${Math.round(delayMs / 1000)}s: ${error.message}`,
        );
      },
      signal: options?.signal,
    });
    await accumulateSessionTokenUsage(store, taskId, session);
  } finally {
    session.dispose();
  }
}

async function resolveRebaseConflictSet(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  settings: Settings,
  options?: {
    onAgentText?: (delta: string) => void;
    signal?: AbortSignal;
    runtimeHint?: string;
    onSession?: (session: { dispose: () => void }) => void;
  },
): Promise<void> {
  const conflictedFiles = await getConflictedFiles(rootDir);
  if (conflictedFiles.length === 0) return;

  mergerLog.log(`${taskId}: found ${conflictedFiles.length} rebase conflict(s)`);

  const complexFiles: string[] = [];

  for (const file of conflictedFiles) {
    const conflictType = await classifyConflict(file, rootDir);
    if (conflictType === "lockfile-ours") {
      await resolveWithOurs(file, rootDir);
      continue;
    }
    if (conflictType === "generated-theirs") {
      await resolveWithTheirs(file, rootDir);
      continue;
    }
    if (conflictType === "trivial-whitespace") {
      await resolveTrivialWhitespace(file, rootDir);
      continue;
    }
    complexFiles.push(file);
  }

  if (complexFiles.length > 0) {
    await resolveComplexRebaseConflictsWithAi(store, rootDir, taskId, settings, complexFiles, options);
  }

  const remaining = await getConflictedFiles(rootDir);
  if (remaining.length > 0) {
    throw new Error(`Unresolved rebase conflicts remain: ${remaining.join(", ")}`);
  }
}

async function pullWithRebaseAndResolveConflicts(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  settings: Settings,
  remote: string,
  branch: string,
  options?: {
    onAgentText?: (delta: string) => void;
    signal?: AbortSignal;
    runtimeHint?: string;
    onSession?: (session: { dispose: () => void }) => void;
  },
): Promise<void> {
  const pullCommand = `git pull --rebase ${quoteArg(remote)} ${quoteArg(branch)}`;
  try {
    throwIfAborted(options?.signal, taskId);
    await execAsync(pullCommand, {
      cwd: rootDir,
      timeout: PULL_REBASE_TIMEOUT_MS,
      maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
      encoding: "utf-8",
    });
    mergerLog.log(`${taskId}: git pull --rebase succeeded for ${remote}/${branch}`);
    return;
  } catch (pullError: unknown) {
    const conflictedFiles = await getConflictedFiles(rootDir);
    if (conflictedFiles.length === 0) {
      throw new Error(`git pull --rebase failed: ${getCommandErrorMessage(pullError)}`);
    }

    mergerLog.warn(
      `${taskId}: git pull --rebase produced ${conflictedFiles.length} conflict(s); attempting resolution`,
    );

    try {
      await resolveRebaseConflictSet(store, rootDir, taskId, settings, options);

      for (let attempt = 1; attempt <= 10; attempt++) {
        throwIfAborted(options?.signal, taskId);
        if (!isRebaseInProgress(rootDir)) {
          mergerLog.log(`${taskId}: rebase conflicts resolved`);
          return;
        }

        try {
          throwIfAborted(options?.signal, taskId);
          await execAsync("GIT_EDITOR=true git rebase --continue", {
            cwd: rootDir,
            timeout: PULL_REBASE_TIMEOUT_MS,
            maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
            encoding: "utf-8",
          });
          mergerLog.log(`${taskId}: git rebase --continue succeeded (attempt ${attempt})`);
        } catch (continueError: unknown) {
          const currentConflicts = await getConflictedFiles(rootDir);
          if (currentConflicts.length === 0) {
            throw new Error(`git rebase --continue failed: ${getCommandErrorMessage(continueError)}`);
          }
          mergerLog.warn(`${taskId}: rebase continue hit additional conflicts; retrying resolution`);
          await resolveRebaseConflictSet(store, rootDir, taskId, settings, options);
          continue;
        }

        const remainingConflicts = await getConflictedFiles(rootDir);
        if (remainingConflicts.length > 0) {
          mergerLog.warn(`${taskId}: rebase continue left conflicts; retrying resolution`);
          await resolveRebaseConflictSet(store, rootDir, taskId, settings, options);
          continue;
        }
      }

      throw new Error("Exceeded maximum rebase conflict resolution attempts");
    } catch (resolutionError: unknown) {
      if (isRebaseInProgress(rootDir)) {
        try {
          await execAsync("git rebase --abort", {
            cwd: rootDir,
            timeout: PUSH_TIMEOUT_MS,
            maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
            encoding: "utf-8",
          });
          mergerLog.warn(`${taskId}: aborted rebase after unresolved conflicts`);
        } catch (abortError: unknown) {
          mergerLog.warn(`${taskId}: failed to abort rebase: ${getCommandErrorMessage(abortError)}`);
        }
      }

      rethrowIfMergeAborted(resolutionError);
      throw new Error(`unable to resolve rebase conflicts: ${getCommandErrorMessage(resolutionError)}`);
    }
  }
}

/**
 * Push the merged result to the configured remote after a successful direct merge.
 * Failures are non-fatal because the merge commit already exists locally.
 */
export async function pushToRemoteAfterMerge(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  settings: Settings,
  options?: {
    onAgentText?: (delta: string) => void;
    signal?: AbortSignal;
    runtimeHint?: string;
    onSession?: (session: { dispose: () => void }) => void;
  },
): Promise<{ pushed: boolean; error?: string }> {
  let target: { remote: string; branch: string };

  try {
    throwIfAborted(options?.signal, taskId);
    target = parsePushRemoteTarget(rootDir, settings.pushRemote);
  } catch (error: unknown) {
    rethrowIfMergeAborted(error);
    const message = getCommandErrorMessage(error);
    mergerLog.error(`${taskId}: invalid push remote configuration: ${message}`);
    return { pushed: false, error: message };
  }

  const { remote, branch } = target;
  mergerLog.log(`${taskId}: push-after-merge enabled; syncing ${remote}/${branch}`);

  try {
    throwIfAborted(options?.signal, taskId);
    await pullWithRebaseAndResolveConflicts(store, rootDir, taskId, settings, remote, branch, options);
  } catch (error: unknown) {
    rethrowIfMergeAborted(error);
    const message = getCommandErrorMessage(error);
    mergerLog.error(`${taskId}: pull --rebase before push failed: ${message}`);
    return { pushed: false, error: message };
  }

  const pushCommand = `git push ${quoteArg(remote)} ${quoteArg(branch)}`;

  try {
    throwIfAborted(options?.signal, taskId);
    await execAsync(pushCommand, {
      cwd: rootDir,
      timeout: PUSH_TIMEOUT_MS,
      maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
      encoding: "utf-8",
    });
    mergerLog.log(`${taskId}: pushed merged result to ${remote}/${branch}`);
    return { pushed: true };
  } catch (firstPushError: unknown) {
    const firstMessage = getCommandErrorMessage(firstPushError);
    mergerLog.warn(`${taskId}: initial push failed: ${firstMessage}`);

    if (!isNonFastForwardPushError(firstMessage)) {
      return { pushed: false, error: firstMessage };
    }

    mergerLog.log(`${taskId}: push rejected as non-fast-forward; retrying pull --rebase and push once`);

    try {
      throwIfAborted(options?.signal, taskId);
      await pullWithRebaseAndResolveConflicts(store, rootDir, taskId, settings, remote, branch, options);
      throwIfAborted(options?.signal, taskId);
      await execAsync(pushCommand, {
        cwd: rootDir,
        timeout: PUSH_TIMEOUT_MS,
        maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
        encoding: "utf-8",
      });
      mergerLog.log(`${taskId}: push succeeded after non-fast-forward retry`);
      return { pushed: true };
    } catch (retryError: unknown) {
      rethrowIfMergeAborted(retryError);
      const retryMessage = getCommandErrorMessage(retryError);
      mergerLog.error(`${taskId}: push retry failed: ${retryMessage}`);
      return { pushed: false, error: retryMessage };
    }
  }
}

/**
 * Create a temporary worktree from the current HEAD for isolated post-merge step execution.
 * Returns the worktree path, or null if creation fails (graceful fallback to rootDir).
 */
async function createPostMergeWorktree(
  rootDir: string,
  taskId: string,
): Promise<string | null> {
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  const postMergeWorktree = join(rootDir, ".worktrees", `post-merge-${taskId}-${randomSuffix}`);

  try {
    await execAsync(`git worktree add ${quoteArg(postMergeWorktree)} HEAD`, { cwd: rootDir });
    return postMergeWorktree;
  } catch (err: unknown) {
    mergerLog.warn(`${taskId}: failed to create post-merge worktree: ${getCommandErrorMessage(err)}`);
    return null;
  }
}

/**
 * Remove a temporary worktree created for post-merge step execution.
 * Non-fatal: logs and swallows errors.
 */
async function removePostMergeWorktree(
  rootDir: string,
  postMergeWorktree: string,
  taskId: string,
): Promise<void> {
  try {
    await execAsync(`git worktree remove --force ${quoteArg(postMergeWorktree)}`, { cwd: rootDir });
  } catch (err: unknown) {
    mergerLog.warn(`${taskId}: failed to remove post-merge worktree ${postMergeWorktree}: ${getCommandErrorMessage(err)}`);
  }
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
  throwIfAborted(options.signal, taskId);

  // 1. Validate task state
  const task = await store.getTask(taskId);
  const mergeBlocker = getTaskMergeBlocker(task);
  if (mergeBlocker) {
    throw new Error(`Cannot merge ${taskId}: ${mergeBlocker}`);
  }

  // Advisory: announce that rootDir is volatile until this merge finishes.
  // Dashboards / status lines / pre-Edit hooks can read this file to warn
  // devs that edits made now may end up in a race-rescue stash. Not a lock —
  // we explicitly do NOT block dev edits, just make the timing risk legible.
  const activeStatusPath = writeActiveMergerStatus(rootDir, taskId);

  // Sweep autostash orphans from prior merges before creating a new one.
  // Subsumed orphans (content fully on HEAD) get dropped; live orphans get
  // surfaced on the task feed so the developer notices them.
  await sweepAutostashOrphans(rootDir, taskId, store);

  // Pre-merge guard against the common single-checkout setup where rootDir
  // is the developer's working tree. The merge flow below issues several
  // `git reset --hard/--merge` calls and forced checkouts that would
  // otherwise wipe any unrelated unstaged/untracked dev edits. Stash them
  // here, restore in the finally below — see stashUnrelatedRootDirChanges
  // for the full rationale.
  const autostashHandle = await stashUnrelatedRootDirChanges(rootDir, taskId);
  // Surface any race-rescue stashes (mid-run dev edits caught between
  // initial snapshot and the destructive reset) on the task feed so the
  // operator sees the recovery handle without having to grep `git stash list`.
  if (autostashHandle?.rescueShas?.length) {
    for (const r of autostashHandle.rescueShas) {
      await store.logEntry(
        taskId,
        `Race-rescue stash created during pre-merge autostash: ${r.sha.slice(0, 7)} (${r.label})`,
        `These are working-tree changes that landed AFTER the initial autostash snapshot but BEFORE the destructive reset. Recover with:\n  cd ${rootDir} && git stash apply ${r.sha}`,
      ).catch(() => undefined);
    }
  }
  // Hoisted so the finally block (below) can attach the autostash outcome
  // to the result object the caller will receive.
  let resultForFinally: MergeResult | undefined;
  try {

  const branch = task.branch || `fusion/${taskId.toLowerCase()}`;
  const sourceIssueRef = buildSourceIssueRef(task.sourceIssue);
  const worktreePath = task.worktree;
  const result: MergeResult = {
    task,
    branch,
    merged: false,
    worktreeRemoved: false,
    branchDeleted: false,
  };
  resultForFinally = result;

  // Build merge-run context for audit instrumentation (FN-1404)
  const mergeRunId = generateSyntheticRunId("merge", taskId);
  const engineRunContext: EngineRunContext = {
    runId: mergeRunId,
    agentId: "merger",
    taskId,
    phase: "merge",
  };

  // Create run auditor for TaskStore-backed audit emission (no-ops if store doesn't support it)
  const audit = createRunAuditor(store, engineRunContext);

  if (!worktreePath) {
    mergerLog.warn(`${taskId}: no worktree path set — skipping worktree cleanup`);
  }

  // 2. Read settings
  const settings = await store.getSettings();
  const includeTaskId = settings.includeTaskIdInCommit !== false;
  // Support both setting names: smartConflictResolution (new) and autoResolveConflicts (legacy)
  const smartConflictResolution = (settings.smartConflictResolution ?? settings.autoResolveConflicts) !== false;
  const mergeConflictStrategy: CanonicalMergeConflictStrategy = normalizeMergeConflictStrategy(
    settings.mergeConflictStrategy,
  );

  // Pre-merge sync: for the smart strategies, opportunistically fast-forward
  // local main from origin so a freshly-pushed sibling commit isn't clobbered
  // by `-X ours`/`-X theirs` falling back to a stale base. Best-effort: any
  // failure (no remote, network down, divergent local) logs and continues.
  if (mergeConflictStrategy === "smart-prefer-main" || mergeConflictStrategy === "smart-prefer-branch") {
    await tryFastForwardFromOrigin(rootDir, taskId);
  }

  // Tracks the "empty squash" success path — when `git merge --squash`
  // staged nothing, mergeAttempt returns true without making a new commit.
  // HEAD then points at pre-merge main, which has nothing to do with this
  // task. We avoid recording that sha as commitSha (which would mislead
  // every consumer of mergeDetails). Set by the squashIsEmpty / staged===0
  // sites in mergeAttempt + attemptWithSideStrategy.
  let mergeWasEmpty = false;

  // 3. Check branch exists
  try {
    execSync(`git rev-parse --verify "${branch}"`, {
      cwd: rootDir,
      stdio: "pipe",
    });
  } catch {
    result.error = `Branch '${branch}' not found — moving to done without merge`;
    // Branch is gone; never infer ownership from raw HEAD. Only persist commit
    // metadata when we can prove a landed commit belongs to this task.
    const ownedCommit = await findOwnedLandedCommitForTask(rootDir, task);
    if (ownedCommit) {
      await store.updateTask(taskId, {
        mergeDetails: {
          commitSha: ownedCommit.sha,
          filesChanged: ownedCommit.filesChanged,
          insertions: ownedCommit.insertions,
          deletions: ownedCommit.deletions,
          mergeCommitMessage: ownedCommit.subject,
          mergedAt: new Date().toISOString(),
          mergeConfirmed: true,
          prNumber: task.prInfo?.number,
        },
      });
      mergerLog.log(`${taskId}: branch missing; recovered owned landed commit ${ownedCommit.sha.slice(0, 8)}`);
    }
    // Audit trail: record merge completion (FN-1404)
    await audit.database({ type: "task:move", target: taskId, metadata: { to: "done", merged: false } });
    await completeTask(store, taskId, result);
    return result;
  }

  // 3b. Ensure rootDir is on the main branch before merging.
  // Without this, a merge could land on whatever branch was last checked out,
  // causing feature code to be committed to the wrong lineage.
  try {
    throwIfAborted(options.signal, taskId);
    const currentBranch = execSyncText("git symbolic-ref --short HEAD", {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const mainBranch = execSyncText("git rev-parse --abbrev-ref origin/HEAD", {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim().replace(/^origin\//, "");
    if (currentBranch !== mainBranch) {
      mergerLog.log(`${taskId}: rootDir on '${currentBranch}', checking out '${mainBranch}' before merge`);
      await execAsync(`git checkout "${mainBranch}"`, {
        cwd: rootDir,
      });
      // Audit trail: record git checkout (FN-1404)
      await audit.git({ type: "branch:checkout", target: mainBranch });
    }
  } catch (error: unknown) {
    rethrowIfMergeAborted(error);

    // Fallback: try checking out main directly
    try {
      throwIfAborted(options.signal, taskId);
      await execAsync("git checkout main", { cwd: rootDir });
      // Audit trail: record git checkout (FN-1404)
      await audit.git({ type: "branch:checkout", target: "main" });
    } catch (fallbackError: unknown) {
      rethrowIfMergeAborted(fallbackError);
      mergerLog.warn(`${taskId}: unable to verify/checkout main branch — proceeding on current HEAD`);
    }
  }

  // 3c. Pre-merge remote rebase.
  //
  // When another collaborator (or another fusion worker on a different
  // machine) pushes to the remote while our task branch is in flight, the
  // merge would otherwise surface as a conflict. Rebasing the task branch
  // onto the latest remote tip beforehand turns most of those into trivial
  // fast-forwards. When conflicts do appear the existing smart/AI resolve
  // flow (Attempts 1–3 below) picks them up just like normal merge
  // conflicts — the caller doesn't need to distinguish.
  //
  // Controlled by `settings.worktreeRebaseBeforeMerge` (default true) and
  // `settings.worktreeRebaseRemote` (empty → use repo's default remote).
  //
  // For "smart-prefer-main" we treat a rebase abort as a hard error: a stale
  // branch base means the -X ours fallback can silently re-add code that main
  // recently deleted (the merge sees branch additions vs main deletions as
  // non-conflicting). Track here and throw outside the catch wrapper.
  //
  // The block runs as TWO INDEPENDENT STAGES so that prefer-main always gets
  // the strongest available rebase coverage:
  //   Stage 1 (remote): rebase onto remote/main when enabled + remote resolves.
  //                     Picks up upstream pushes from collaborators / other
  //                     workers.
  //   Stage 2 (local-base): rebase onto rootDir's HEAD when enabled. Picks up
  //                         sibling-task merges that landed locally but
  //                         haven't pushed yet, AND covers the no-remote case
  //                         where Stage 1 silently skipped.
  // Either stage failing under prefer-main is a hard error.
  let rebaseHappened = false;
  let preferMainRebaseFailureMessage: string | undefined;

  // Semantic guards: prefer-main with no rebase available is incoherent —
  // the strategy depends on rebase to honor main's deletions. Fail fast
  // before we waste work attempting a merge that can't deliver its promise.
  if (
    settings.worktreeRebaseBeforeMerge === false
    && settings.worktreeRebaseLocalBase === false
    && mergeConflictStrategy === "smart-prefer-main"
  ) {
    throw new Error(
      `Incompatible settings for ${taskId}: mergeConflictStrategy="smart-prefer-main" ` +
      `requires at least one of worktreeRebaseBeforeMerge or worktreeRebaseLocalBase ` +
      `to remain enabled. The strategy relies on rebasing the branch onto current main ` +
      `to preserve main's deletions; with both disabled it can silently re-introduce ` +
      `branch-only content. Re-enable a rebase stage or switch to "smart-prefer-branch" ` +
      `/ "ai-only".`,
    );
  }

  // Helper: run the local-base rebase (Stage 2). Centralized so both
  // entry points (after Stage 1, or standalone when Stage 1 is disabled)
  // share the same logic for ancestor check, rebase, and abort handling.
  async function runLocalBaseRebase(label: string): Promise<void> {
    if (!worktreePath) return;
    try {
      const { stdout: localHeadOut } = await execAsync("git rev-parse HEAD", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const localHead = localHeadOut.trim();
      if (!localHead) return;

      // Skip if worktree branch already contains local HEAD.
      let alreadyContains = false;
      try {
        await execAsync(`git merge-base --is-ancestor "${localHead}" HEAD`, { cwd: worktreePath });
        alreadyContains = true;
      } catch {
        // not an ancestor — rebase needed
      }

      if (alreadyContains) {
        // Branch is already up-to-date with current main; prefer-main is
        // satisfied without re-running git rebase.
        rebaseHappened = true;
        return;
      }

      throwIfAborted(options.signal, taskId);
      await execAsync(`git rebase "${localHead}"`, { cwd: worktreePath });
      rebaseHappened = true;
      mergerLog.log(`${taskId}: rebased ${branch} onto local HEAD ${localHead.slice(0, 8)}${label ? ` (${label})` : ""}`);
      await store.appendAgentLog(
        taskId,
        `Pre-merge rebase: ${branch} → local HEAD ${localHead.slice(0, 8)}${label ? ` (${label})` : ""}`,
        "text",
        undefined,
        "merger",
      );
    } catch (localRebaseErr) {
      rethrowIfMergeAborted(localRebaseErr);
      const lmsg = localRebaseErr instanceof Error ? localRebaseErr.message : String(localRebaseErr);
      mergerLog.warn(`${taskId}: pre-merge rebase onto local HEAD failed (${lmsg}) — aborting and falling through`);
      try {
        await execAsync("git rebase --abort", { cwd: worktreePath });
      } catch (abortError: unknown) {
        mergerLog.warn(`${taskId}: failed to abort local-HEAD rebase: ${getCommandErrorMessage(abortError)}`);
      }
      if (mergeConflictStrategy === "smart-prefer-main" && !preferMainRebaseFailureMessage) {
        preferMainRebaseFailureMessage = `Pre-merge rebase onto local HEAD aborted (${lmsg})`;
      }
    }
  }

  // ── Stage 1: remote rebase ────────────────────────────────────────────
  if (settings.worktreeRebaseBeforeMerge !== false) {
    try {
      // Resolve which remote to fetch. An explicit setting wins; otherwise
      // the repo's configured default (branch.<main>.remote) or the sole
      // remote if there's exactly one.
      let remote = settings.worktreeRebaseRemote?.trim();
      if (!remote) {
        try {
          const { stdout: mainBranchOut } = await execAsync(
            "git rev-parse --abbrev-ref HEAD",
            { cwd: rootDir, encoding: "utf-8" },
          );
          const mainBranch = mainBranchOut.trim();
          const { stdout: configuredRemote } = await execAsync(
            `git config --get branch.${mainBranch}.remote`,
            { cwd: rootDir, encoding: "utf-8" },
          ).catch(() => ({ stdout: "" }));
          remote = configuredRemote.trim();
        } catch {
          // Fall through to listing remotes below.
        }
      }
      if (!remote) {
        try {
          const { stdout: remotesOut } = await execAsync("git remote", {
            cwd: rootDir,
            encoding: "utf-8",
          });
          const remotes = remotesOut.trim().split(/\s+/).filter(Boolean);
          if (remotes.length === 1) {
            remote = remotes[0];
          } else if (remotes.includes("origin")) {
            remote = "origin";
          }
        } catch {
          // Ignore — we'll skip the rebase if no remote is resolvable.
        }
      }

      if (!remote) {
        mergerLog.log(`${taskId}: no remote resolvable — skipping remote rebase stage (local-base stage may still run)`);
      } else if (!worktreePath) {
        mergerLog.warn(`${taskId}: no worktreePath — skipping remote rebase stage`);
      } else {
        throwIfAborted(options.signal, taskId);
        mergerLog.log(`${taskId}: fetching ${remote} before merge`);
        await execAsync(`git fetch "${remote}"`, { cwd: rootDir });

        try {
          const { stdout: mainBranchOut } = await execAsync(
            "git rev-parse --abbrev-ref HEAD",
            { cwd: rootDir, encoding: "utf-8" },
          );
          const mainBranch = mainBranchOut.trim();
          const remoteRef = `${remote}/${mainBranch}`;
          throwIfAborted(options.signal, taskId);
          await execAsync(`git rebase "${remoteRef}"`, { cwd: worktreePath });
          rebaseHappened = true;
          mergerLog.log(`${taskId}: rebased ${branch} onto ${remoteRef}`);
          await store.appendAgentLog(
            taskId,
            `Pre-merge rebase: ${branch} → ${remoteRef}`,
            "text",
            undefined,
            "merger",
          );
        } catch (rebaseErr) {
          rethrowIfMergeAborted(rebaseErr);
          const msg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
          mergerLog.warn(`${taskId}: pre-merge rebase failed (${msg}) — aborting rebase and falling through`);
          if (worktreePath) {
            try {
              await execAsync("git rebase --abort", { cwd: worktreePath });
            } catch (abortError: unknown) {
              mergerLog.warn(`${taskId}: failed to abort pre-merge rebase: ${getCommandErrorMessage(abortError)}`);
            }
          }
          if (mergeConflictStrategy === "smart-prefer-main") {
            preferMainRebaseFailureMessage = `Pre-merge rebase onto remote main aborted (${msg})`;
          }
        }
      }
    } catch (err) {
      rethrowIfMergeAborted(err);
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: pre-merge remote rebase pipeline failed (${msg}) — proceeding without remote rebase`);
    }
  }

  // ── Stage 2: local-base rebase ─────────────────────────────────────────
  // Runs independently of Stage 1, so the no-remote case still gets coverage.
  // Skipped if Stage 1 already aborted under prefer-main (we'll throw below
  // anyway, and a second attempt just adds noise).
  if (
    settings.worktreeRebaseLocalBase !== false
    && !preferMainRebaseFailureMessage
  ) {
    await runLocalBaseRebase(
      settings.worktreeRebaseBeforeMerge === false ? "remote rebase disabled" : "",
    );
  }

  // ── Recovery cascade for prefer-main rebase failures ──────────────────
  //
  // Previous behavior: throw immediately when prefer-main rebase aborted.
  // This left tasks stuck in in-review forever when the conflict was a known
  // recoverable shape (e.g., a dependency task was squash-merged to main, so
  // the dependent's branch carries orphan raw commits whose content is
  // already in main but in a different commit shape).
  //
  // New behavior: try increasingly broad recovery strategies in order. Each
  // layer is fail-soft — if it can't help, we move on without changing
  // worktree state. After all layers run, if rebase still hasn't succeeded,
  // we log the situation and proceed to AI arbitration (the standard
  // 3-attempt merge cascade), which is gated by post-merge `pnpm test` and
  // `pnpm build` verification — so the safety constraint that prefer-main
  // exists to enforce (no silent re-introduction of main's deletions) is
  // preserved by the deterministic verification gate.
  let preMergeRebaseFallthrough: string | undefined;
  if (preferMainRebaseFailureMessage && worktreePath) {
    // Resolve the rebase target the same way Stage 2 did: rootDir's HEAD.
    // Stage 1 (remote) already ran if enabled; Stage 2 (local) is what
    // would have unified branch+local. We use local HEAD as the target so
    // Layers 1/2 land where Stage 2 wanted to.
    let rebaseTarget = "";
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      rebaseTarget = stdout.trim();
    } catch {
      rebaseTarget = "";
    }

    // Layer 1: surgical drop of declared-dependency commits.
    // When `task.executionStartBranch` is a non-main branch (a sibling task's branch),
    // the dependent worktree was forked off it and inherited its commits.
    // If the dep was later squash-merged to main, those raw commits are now
    // orphans whose content already exists in main. Re-rebase the task
    // branch onto main using `git rebase --onto <target> <dep-tip> <branch>`,
    // which peels off the dep's commits cleanly.
    if (rebaseTarget && task.executionStartBranch && task.executionStartBranch !== "main") {
      // Resolve the dep's tip — prefer the live branch ref, fall back to
      // the recorded baseCommitSha if the branch was already deleted.
      let depTip: string | undefined;
      try {
        const { stdout } = await execAsync(
          `git rev-parse --verify "${task.executionStartBranch}^{commit}"`,
          { cwd: rootDir, encoding: "utf-8" },
        );
        depTip = stdout.trim() || undefined;
      } catch {
        depTip = undefined;
      }
      if (!depTip && task.baseCommitSha) {
        try {
          const { stdout } = await execAsync(
            `git rev-parse --verify "${task.baseCommitSha}^{commit}"`,
            { cwd: rootDir, encoding: "utf-8" },
          );
          depTip = stdout.trim() || undefined;
        } catch {
          depTip = undefined;
        }
      }

      if (depTip && depTip !== rebaseTarget) {
        try {
          throwIfAborted(options.signal, taskId);
          // Reset rebase state defensively in case a previous attempt left
          // a half-applied rebase in place.
          await execAsync("git rebase --abort", { cwd: worktreePath }).catch(
            () => undefined,
          );
          await execAsync(
            `git rebase --onto "${rebaseTarget}" "${depTip}" "${branch}"`,
            { cwd: worktreePath },
          );
          preferMainRebaseFailureMessage = undefined;
          rebaseHappened = true;
          mergerLog.log(
            `${taskId}: Layer 1 recovery — rebased ${branch} --onto ${rebaseTarget.slice(0, 8)} dropping commits up to dep tip ${depTip.slice(0, 8)} (executionStartBranch=${task.executionStartBranch})`,
          );
          await store.logEntry(
            taskId,
            `Pre-merge recovery (Layer 1): dropped dependency commits from ${task.executionStartBranch} via rebase --onto ${rebaseTarget.slice(0, 8)} ${depTip.slice(0, 8)} ${branch}; the merge will proceed against the cleaned branch`,
          );
        } catch (layer1Err) {
          rethrowIfMergeAborted(layer1Err);
          mergerLog.warn(
            `${taskId}: Layer 1 (dep-drop) recovery failed: ${layer1Err instanceof Error ? layer1Err.message : String(layer1Err)}`,
          );
          await execAsync("git rebase --abort", { cwd: worktreePath }).catch(
            () => undefined,
          );
        }
      }
    }

    // Layer 2: generic patch-id duplicate stripping.
    // Compute patch-ids of recent main commits (last 500). Walk the task
    // branch's commits in target..branch and identify those whose patch-id
    // already exists in main — they're duplicates whose content has landed
    // (via squash, cherry-pick, manual replay, etc.). Cherry-pick the
    // non-duplicate commits onto target to produce a clean branch.
    if (preferMainRebaseFailureMessage && rebaseTarget && worktreePath) {
      try {
        throwIfAborted(options.signal, taskId);
        const mainPatchIds = await collectPatchIds(rootDir, rebaseTarget, 500);
        const branchCommits = await listBranchCommits(rootDir, rebaseTarget, branch);
        if (branchCommits.length === 0) {
          // Nothing to replay — branch is up-to-date with target.
          rebaseHappened = true;
          preferMainRebaseFailureMessage = undefined;
        } else {
          const surviving: string[] = [];
          let dropped = 0;
          for (const sha of branchCommits) {
            const pid = await commitPatchId(rootDir, sha);
            if (pid && mainPatchIds.has(pid)) {
              dropped += 1;
            } else {
              surviving.push(sha);
            }
          }
          if (dropped > 0 && surviving.length === branchCommits.length) {
            // Should be impossible (dropped>0 means some were filtered), but
            // guard against logic errors before mutating worktree state.
            mergerLog.warn(`${taskId}: Layer 2 internal accounting mismatch — skipping`);
          } else if (dropped > 0) {
            // Capture the branch's pre-mutation SHA so we can restore on any
            // partial-failure path. Without this, a failed cherry-pick midway
            // through would leave the branch at a half-replayed state worse
            // than the original conflict.
            let originalBranchSha = "";
            try {
              const { stdout } = await execAsync(
                `git rev-parse --verify "${branch}^{commit}"`,
                { cwd: worktreePath, encoding: "utf-8" },
              );
              originalBranchSha = stdout.trim();
            } catch {
              originalBranchSha = "";
            }
            const restoreOriginalBranch = async () => {
              if (!originalBranchSha) return;
              // Hard-reset clears any in-progress cherry-pick / merge state
              // and resets the index, so the subsequent forced checkout has
              // no conflicting unmerged paths to refuse on.
              await execAsync(`git reset --hard "${originalBranchSha}"`, {
                cwd: worktreePath,
              }).catch(() => undefined);
              await execAsync(`git checkout -f "${branch}"`, { cwd: worktreePath }).catch(
                () => undefined,
              );
              await execAsync(`git reset --hard "${originalBranchSha}"`, {
                cwd: worktreePath,
              }).catch(() => undefined);
            };

            try {
              await execAsync("git rebase --abort", { cwd: worktreePath }).catch(
                () => undefined,
              );
              await execAsync(`git checkout "${branch}"`, { cwd: worktreePath });
              await execAsync(`git reset --hard "${rebaseTarget}"`, {
                cwd: worktreePath,
              });
              for (const sha of surviving) {
                throwIfAborted(options.signal, taskId);
                try {
                  await execAsync(`git cherry-pick --allow-empty "${sha}"`, {
                    cwd: worktreePath,
                  });
                } catch (pickErr) {
                  rethrowIfMergeAborted(pickErr);
                  // A surviving commit conflicts with target despite its
                  // patch-id not matching — abort the cherry-pick, restore
                  // the branch to its original tip, and let Layer 3 take over.
                  await execAsync("git cherry-pick --abort", { cwd: worktreePath }).catch(
                    () => undefined,
                  );
                  await restoreOriginalBranch();
                  throw pickErr;
                }
              }
              preferMainRebaseFailureMessage = undefined;
              rebaseHappened = true;
              mergerLog.log(
                `${taskId}: Layer 2 recovery — patch-id stripped ${dropped} duplicate commit(s); replayed ${surviving.length} survivor(s) onto ${rebaseTarget.slice(0, 8)}`,
              );
              await store.logEntry(
                taskId,
                `Pre-merge recovery (Layer 2): patch-id matched ${dropped} branch commit(s) against the last 500 main commits and dropped them as duplicates; cherry-picked ${surviving.length} unique commit(s) onto ${rebaseTarget.slice(0, 8)}`,
              );
            } catch (replayErr) {
              await restoreOriginalBranch();
              throw replayErr;
            }
          } else {
            mergerLog.log(
              `${taskId}: Layer 2 found no duplicate-content commits to drop (window=500)`,
            );
          }
        }
      } catch (layer2Err) {
        rethrowIfMergeAborted(layer2Err);
        mergerLog.warn(
          `${taskId}: Layer 2 (patch-id strip) recovery failed: ${layer2Err instanceof Error ? layer2Err.message : String(layer2Err)}`,
        );
      }
    }

    // Layer 3: if the rebase still couldn't be unblocked, fall through to
    // the AI merge cascade with a safety preamble logged to the task. The
    // existing post-merge deterministic verification (test + build) gates
    // whatever the AI produces — if the AI silently re-introduces main's
    // deletions and breaks tests/build, the task bounces back to in-progress
    // via the engine's verification-failure path. The AI never gets to
    // commit a regression that wasn't caught by tests.
    if (preferMainRebaseFailureMessage) {
      preMergeRebaseFallthrough = preferMainRebaseFailureMessage;
      preferMainRebaseFailureMessage = undefined;
      mergerLog.warn(
        `${taskId}: Layers 1 & 2 could not unblock the prefer-main rebase — falling through to AI arbitration (Layer 3). Deterministic verification will gate the result.`,
      );
      await store.logEntry(
        taskId,
        `Pre-merge recovery (Layer 3): both surgical and patch-id recovery failed; AI arbiter takes over. SAFETY CONSTRAINT for the AI: do NOT re-introduce content that current main has deleted. If hunks are ambiguous, prefer main's version. Post-merge test/build verification will reject any resolution that breaks main's intent.`,
        "PreMergeRebaseFallthrough",
      );
    }
  }

  if (preferMainRebaseFailureMessage) {
    // Reached only when there's no worktreePath — no recovery is possible
    // without a worktree to operate on.
    throw new Error(
      `${preferMainRebaseFailureMessage} for ${taskId}. ` +
      `Strategy "smart-prefer-main" requires a successful rebase to preserve main's deletions; ` +
      `recovery layers 1–3 require a worktree path which is missing for this task. ` +
      `Resolve the rebase conflict manually, or switch mergeConflictStrategy to ` +
      `"smart-prefer-branch" / "ai-only".`,
    );
  }
  // Surface the fallthrough to anything downstream that wants to vary
  // behavior under it. Currently informational only; the verification gate
  // is what enforces safety.
  void preMergeRebaseFallthrough;
  // Silent-skip observability: when prefer-main couldn't run a rebase at all
  // (no remote resolvable, no worktreePath), warn loudly so the gap is visible
  // in logs. Not a hard fail — environmental skips are common in tests and
  // some setups, and would cause too much breakage to enforce here. Production
  // monitoring can alert on this warning.
  if (mergeConflictStrategy === "smart-prefer-main" && !rebaseHappened) {
    mergerLog.warn(
      `${taskId}: smart-prefer-main ran without a successful pre-merge rebase ` +
      `(${worktreePath ? "no remote resolvable or rebase disabled" : "no worktreePath"}). ` +
      `Main's deletions may not be preserved if the branch re-introduces them.`,
    );
  }

  // 4. Gather context for the agent (used in all attempts)
  // Keep this range strategy aligned with dashboard changed-files endpoints.
  const diffBaseRef = await resolveTaskDiffBaseRef({
    cwd: rootDir,
    headRef: branch,
    baseBranch: task.baseBranch,
    baseCommitSha: task.baseCommitSha,
  });
  const contextDiffRange = diffBaseRef ? `${diffBaseRef}..${branch}` : `HEAD..${branch}`;

  let commitLog = "";
  let diffStat = "";
  try {
    const { stdout: logOutput } = await execAsync(`git log ${contextDiffRange} --format="- %s"`, {
      cwd: rootDir,
      encoding: "utf-8",
    });
    commitLog = logOutput.trim();
  } catch {
    commitLog = "(unable to read commit log)";
  }
  try {
    const { stdout: diffOutput } = await execAsync(`git diff ${contextDiffRange} --stat`, {
      cwd: rootDir,
      encoding: "utf-8",
    });
    diffStat = diffOutput.trim();
  } catch {
    diffStat = "(unable to read diff)";
  }

  const aiMergeSummary = settings.useAiMergeCommitSummary
    ? await generateAiMergeSummary(commitLog, diffStat, settings, rootDir)
    : null;
  const aiMergeSubject = settings.useAiMergeCommitSummary
    ? await generateAiMergeSubject(commitLog, diffStat, settings, rootDir, branch, taskId, options.signal)
    : null;

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
  // Cross-process safety net: abort if another task is already mid-merge.
  // The engine's drainMergeQueue also checks, but this catches direct callers.
  const activeMerge = store.getActiveMergingTask(taskId);
  if (activeMerge) {
    throw new Error(
      `Cannot merge ${taskId}: task ${activeMerge} is already merging (cross-process conflict)`,
    );
  }
  await store.updateTask(taskId, { status: "merging" });

  // Normalize explicit verification commands from settings
  const explicitTestCommand = settings.testCommand?.trim() || undefined;
  const explicitBuildCommand = settings.buildCommand?.trim() || undefined;

  // Infer default test command if explicit testCommand is not set
  // This ensures merge verification runs even when settings.testCommand is not configured
  const inferredTest = inferDefaultTestCommand(rootDir, explicitTestCommand, explicitBuildCommand);
  const effectiveTestCommand = inferredTest?.command || explicitTestCommand;
  const effectiveTestSource = inferredTest?.testSource;
  const effectiveBuildCommand = explicitBuildCommand;
  const effectiveBuildSource = inferredTest?.buildSource;

  // Log what verification commands will be used
  if (effectiveTestCommand || effectiveBuildCommand) {
    mergerLog.log(
      `${taskId}: merge verification commands` +
      (effectiveTestCommand ? ` [test: ${effectiveTestCommand} (${effectiveTestSource || "explicit"})]` : "") +
      (effectiveBuildCommand ? ` [build: ${effectiveBuildCommand} (${effectiveBuildSource || "explicit"})]` : ""),
    );
  }

  const mergeAttempt = async (attemptNum: 1 | 2 | 3): Promise<boolean> => {
    mergerLog.log(`${taskId}: merge attempt ${attemptNum}/3...`);
    const attemptLabel = attemptNum === 1
      ? "Attempt 1: AI merge"
      : attemptNum === 2
        ? "Attempt 2: auto-resolve known conflicts, then AI"
        : `Attempt 3: ${mergeConflictStrategy === "smart-prefer-main" ? "-X ours" : "-X theirs"} fallback`;
    await store.appendAgentLog(
      taskId,
      `Starting merge ${attemptLabel}`,
      "text",
      undefined,
      "merger",
    );

    // Capture HEAD before the squash so the verification-fix finalizer can
    // tell whether the AI agent actually created a commit (HEAD moved) or
    // bailed via fn_report_build_failure (HEAD didn't move). Without this,
    // the amend path silently mutated the previous task's merge commit.
    let preAttemptHeadSha = "";
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      preAttemptHeadSha = stdout.trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: failed to capture pre-attempt HEAD (${msg}) — verification-fix finalizer will fall back to amend`);
    }

    try {
      // Try the merge with appropriate strategy for this attempt
      const success = await executeMergeAttempt({
        store,
        rootDir,
        taskId,
        branch,
        commitLog,
        diffStat,
        aiSummary: aiMergeSummary,
        aiSubject: aiMergeSubject,
        includeTaskId,
        sourceIssueRef,
        smartConflictResolution,
        mergeConflictStrategy,
        attemptNum,
        options,
        result,
        settings,
        testCommand: effectiveTestCommand,
        buildCommand: effectiveBuildCommand,
        testSource: effectiveTestSource,
        buildSource: effectiveBuildSource,
        preMergeRebaseFallthrough,
      }, aiTracker);

      if (success) {
        result.attemptsMade = attemptNum;
        result.resolutionStrategy = getResolutionStrategy(attemptNum, smartConflictResolution, mergeConflictStrategy);
        result.resolutionMethod = getResolutionMethod(result.resolutionStrategy, result.autoResolvedCount, aiTracker.aiWasInvoked);
        result.merged = true;
        return true;
      }

      // If not successful and we have more attempts, clean up and try again
      if (attemptNum < 3) {
        mergerLog.log(`${taskId}: attempt ${attemptNum} failed, cleaning up for retry...`);
        try {
          execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
          // Audit trail: record git reset for merge cleanup (FN-1404)
          await audit.git({ type: "reset:hard", target: branch, metadata: { purpose: "merge-cleanup", attempt: attemptNum } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          mergerLog.warn(`${taskId}: git reset --merge cleanup failed (merge-cleanup, attempt ${attemptNum}): ${msg}`);
        }
      }

      return false;
    } catch (error: any) {
      if (error instanceof Error && error.name === "MergeAbortedError") {
        try {
          execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
        } catch {
          // best-effort abort cleanup
        }
        throw error;
      }

      // Check if it's a deterministic verification failure (testCommand or buildCommand failed)
      // Try in-merge fix attempts before propagating
      if (error.name === "VerificationError") {
        const verificationErr = error as VerificationError;
        const maxFixRetries = Math.min(settings.verificationFixRetries ?? 3, 3);

        if (maxFixRetries > 0 && (verificationErr.verificationResult.testResult || verificationErr.verificationResult.buildResult)) {
          mergerLog.log(`${taskId}: deterministic verification failed — attempting in-merge fix (up to ${maxFixRetries} attempts)`);
          await store.logEntry(taskId, `Verification failed during merge — attempting in-merge fix (up to ${maxFixRetries} attempts)`);
          await store.appendAgentLog(
            taskId,
            `Verification failed — attempting in-merge fix (up to ${maxFixRetries} attempts)`,
            "text",
            undefined,
            "merger",
          );

          // Extract failure context from the VerificationError
          const failedResult = verificationErr.verificationResult.testResult?.success === false
            ? verificationErr.verificationResult.testResult
            : verificationErr.verificationResult.buildResult;
          const failedType = verificationErr.verificationResult.testResult?.success === false
            ? "test" as const
            : "build" as const;

          if (failedResult) {
            let fixSuccess = false;
            // Accumulate all paths the fix agent touches across retries so
            // commitOrAmendMergeWithFixes can build a precise allowlist.
            const verificationFixModifiedFiles = new Set<string>();
            for (let fixAttempt = 1; fixAttempt <= maxFixRetries; fixAttempt++) {
              const fixAttemptStartedAt = Date.now();
              mergerLog.log(`${taskId}: in-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`);
              await store.logEntry(taskId, `In-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`);
              await store.appendAgentLog(
                taskId,
                `In-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`,
                "text",
                undefined,
                "merger",
              );

              throwIfAborted(options.signal, taskId);
              fixSuccess = await attemptInMergeVerificationFix(
                store, rootDir, taskId,
                {
                  command: failedResult.command,
                  exitCode: failedResult.exitCode,
                  output: summarizeVerificationOutput(failedResult.stderr || failedResult.stdout, failedType),
                  type: failedType,
                },
                settings,
                options,
                { runId: mergeRunId, agentId: engineRunContext.agentId },
                fixAttempt,
                effectiveTestCommand,
                effectiveBuildCommand,
                effectiveTestSource,
                effectiveBuildSource,
                verificationFixModifiedFiles,
              );

              const fixAttemptDurationMs = Date.now() - fixAttemptStartedAt;
              if (fixSuccess) {
                mergerLog.log(`${taskId}: in-merge verification fix succeeded on attempt ${fixAttempt} in ${fixAttemptDurationMs}ms`);
                await store.logEntry(taskId, `[timing] In-merge verification fix succeeded on attempt ${fixAttempt} in ${fixAttemptDurationMs}ms — verification now passes`);
                await store.appendAgentLog(
                  taskId,
                  `In-merge verification fix succeeded on attempt ${fixAttempt}`,
                  "tool_result",
                  `${fixAttemptDurationMs}ms — verification now passes`,
                  "merger",
                );
                break;
              }

              mergerLog.warn(`${taskId}: in-merge verification fix attempt ${fixAttempt} — verification still fails (${fixAttemptDurationMs}ms)`);
              await store.logEntry(taskId, `[timing] In-merge verification fix attempt ${fixAttempt} — verification still fails (${fixAttemptDurationMs}ms)`);
              await store.appendAgentLog(
                taskId,
                `In-merge verification fix attempt ${fixAttempt} failed`,
                "tool_error",
                `${fixAttemptDurationMs}ms — verification still fails`,
                "merger",
              );
            }

            if (fixSuccess) {
              // Finalize the merge commit (fresh commit if HEAD didn't move,
              // amend if AI agent already committed). Always rewrites the
              // message deterministically from branch step commits.
              const authorArg = getCommitAuthorArg(settings);
              const finalized = await commitOrAmendMergeWithFixes(
                rootDir,
                taskId,
                branch,
                commitLog,
                includeTaskId,
                preAttemptHeadSha,
                authorArg,
                diffStat,
                settings,
                options.signal,
                aiMergeSummary,
                aiMergeSubject,
                verificationFixModifiedFiles,
              );
              if (!finalized) {
                // Phantom-merge guard: refused to fabricate a commit. Reset
                // any leftover squash state and propagate failure.
                resetMergeWithWarn(rootDir, taskId, "verification-fix finalize");
                throw new Error(
                  `${taskId}: verification fix succeeded but no merge commit could be created — refusing to mark merge complete.`,
                );
              }
              return true; // Merge succeeds
            }
          }
        }

        // Fix attempts exhausted or disabled — fall back to existing behavior
        mergerLog.error(`${taskId}: deterministic verification failed — aborting merge (in-merge fix exhausted or disabled)`);
        resetMergeWithWarn(rootDir, taskId, "deterministic-verification rollback");
        throw error;
      }

      // Check if it's a build verification failure
      if (error.message?.includes("Build verification failed")) {
        const maxFixRetries = Math.min(settings.verificationFixRetries ?? 3, 3);

        // Try in-merge fix before falling back to build retry
        if (maxFixRetries > 0 && (effectiveTestCommand || effectiveBuildCommand)) {
          mergerLog.log(`${taskId}: build verification failed — attempting in-merge fix`);
          await store.logEntry(taskId, `Build verification failed during merge — attempting in-merge fix`);
          await store.appendAgentLog(
            taskId,
            "Build verification failed — attempting in-merge fix",
            "text",
            undefined,
            "merger",
          );

          const fixCommand = effectiveBuildCommand || effectiveTestCommand!;
          const fixType = effectiveBuildCommand ? "build" as const : "test" as const;

          let fixSuccess = false;
          // Accumulate all paths the fix agent touches across retries so
          // commitOrAmendMergeWithFixes can build a precise allowlist.
          const buildFixModifiedFiles = new Set<string>();
          for (let fixAttempt = 1; fixAttempt <= maxFixRetries; fixAttempt++) {
            const fixAttemptStartedAt = Date.now();
            mergerLog.log(`${taskId}: in-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`);
            await store.logEntry(taskId, `In-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`);
            await store.appendAgentLog(
              taskId,
              `In-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`,
              "text",
              undefined,
              "merger",
            );

            throwIfAborted(options.signal, taskId);
            fixSuccess = await attemptInMergeVerificationFix(
              store, rootDir, taskId,
              {
                command: fixCommand,
                exitCode: 1,
                output: error.message || "Build verification failed",
                type: fixType,
              },
              settings,
              options,
              { runId: mergeRunId, agentId: engineRunContext.agentId },
              fixAttempt,
              effectiveTestCommand,
              effectiveBuildCommand,
              effectiveTestSource,
              effectiveBuildSource,
              buildFixModifiedFiles,
            );

            const fixAttemptDurationMs = Date.now() - fixAttemptStartedAt;
            if (fixSuccess) {
              mergerLog.log(`${taskId}: in-merge verification fix succeeded on attempt ${fixAttempt} in ${fixAttemptDurationMs}ms`);
              await store.logEntry(taskId, `[timing] In-merge verification fix succeeded on attempt ${fixAttempt} in ${fixAttemptDurationMs}ms`);
              await store.appendAgentLog(
                taskId,
                `In-merge verification fix succeeded on attempt ${fixAttempt}`,
                "tool_result",
                `${fixAttemptDurationMs}ms`,
                "merger",
              );
              break;
            }
            await store.logEntry(taskId, `[timing] In-merge verification fix attempt ${fixAttempt} — verification still fails (${fixAttemptDurationMs}ms)`);
            await store.appendAgentLog(
              taskId,
              `In-merge verification fix attempt ${fixAttempt} failed`,
              "tool_error",
              `${fixAttemptDurationMs}ms — verification still fails`,
              "merger",
            );
          }

          if (fixSuccess) {
            const authorArg = getCommitAuthorArg(settings);
            const finalized = await commitOrAmendMergeWithFixes(
              rootDir,
              taskId,
              branch,
              commitLog,
              includeTaskId,
              preAttemptHeadSha,
              authorArg,
              diffStat,
              settings,
              options.signal,
              aiMergeSummary,
              aiMergeSubject,
              buildFixModifiedFiles,
            );
            if (!finalized) {
              // Phantom-merge guard: the verification fix passed but no
              // commit could be produced (no staged content + HEAD never
              // moved). Reset and propagate failure rather than silently
              // mutating a previous task's commit.
              resetMergeWithWarn(rootDir, taskId, "build-verification fix finalize");
              throw new Error(
                `${taskId}: build verification fix succeeded but no merge commit could be created — refusing to mark merge complete.`,
              );
            }
            return true; // Merge succeeds
          }
        }

        // Fall through to existing buildRetryCount logic
        const buildRetryCount = settings.buildRetryCount ?? 0;
        if (buildRetryCount > 0 && !result._buildRetried) {
          // Allow one build retry — reset merge state and re-attempt same strategy
          mergerLog.log(`${taskId}: build failed, retrying (${buildRetryCount} retry allowed)...`);
          await store.logEntry(taskId, "Build failed — retrying merge attempt");
          result._buildRetried = true;
          try {
            execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
            // Audit trail: record git reset for build retry (FN-1404)
            await audit.git({ type: "reset:hard", target: branch, metadata: { purpose: "build-retry" } });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            mergerLog.warn(`${taskId}: git reset --merge cleanup failed during build-verification rollback (build-retry): ${msg}`);
          }
          return false; // Retry
        }
        // No fix path took effect and no build retry — reset the squash state
        // we deliberately preserved at the build-failure throw site so it
        // doesn't leak into the next attempt or the caller.
        resetMergeWithWarn(rootDir, taskId, "build-verification rollback (no retries left)");
        throw error; // No retries left — fatal
      }

      // Non-conflict squash failure: don't retry — the underlying cause
      // (broken hook, IO error, locked repo) won't fix itself by retrying.
      if (error.name === "MergeNonConflictError") {
        try {
          execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
        } catch { /* best-effort */ }
        throw error;
      }

      // Clean up on error before potentially rethrowing or retrying
      if (attemptNum < 3 && smartConflictResolution) {
        mergerLog.log(`${taskId}: attempt ${attemptNum} error, cleaning up for retry...`);
        try {
          execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
          // Audit trail: record git reset for retry (FN-1404)
          await audit.git({ type: "reset:hard", target: branch, metadata: { purpose: "merge-retry", attempt: attemptNum } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          mergerLog.warn(`${taskId}: git reset --merge cleanup failed (merge-retry, attempt ${attemptNum}): ${msg}`);
        }
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

  // Attempt 2: Auto-resolve lock/generated files, then AI (if enabled).
  // Skipped for "abort" — that strategy gives the user one AI shot, no more.
  if (!merged && smartConflictResolution && mergeConflictStrategy !== "abort") {
    merged = await mergeAttempt(2);
  }

  // Attempt 3: -X theirs (smart-prefer-branch) or -X ours (smart-prefer-main) fallback.
  // Skipped for "ai-only" (no silent side-pick) and "abort" (one shot only).
  //
  // Also skipped when `preMergeRebaseFallthrough` is set: under prefer-main
  // the whole purpose of refusing -X ours after a failed rebase is to
  // prevent silent re-introduction of main's deletions. Layers 1+2 couldn't
  // unblock the rebase, so the worktree is still in a state where -X ours
  // would re-introduce branch-only content. Trust only AI Attempts 1+2 here
  // — their output is gated by deterministic verification (test + build),
  // which is what enforces the prefer-main safety contract.
  if (
    !merged
    && smartConflictResolution
    && mergeConflictStrategy !== "ai-only"
    && mergeConflictStrategy !== "abort"
    && !preMergeRebaseFallthrough
  ) {
    merged = await mergeAttempt(3);
  } else if (!merged && preMergeRebaseFallthrough) {
    await store.logEntry(
      taskId,
      `Attempt 3 (-X ours fallback) suppressed: pre-merge rebase recovery layers 1+2 failed under smart-prefer-main, so the unsafe ours-side fallback is skipped to honor the strategy's safety contract. Verification-gated AI Attempts 1+2 already exhausted; merge cannot complete safely without manual intervention.`,
      "PreMergeRebaseFallthrough",
    );
  }

  // Bubble the empty-merge flag up to the metadata block.
  if (aiTracker.mergeWasEmpty) {
    mergeWasEmpty = true;
  }

  // If all attempts failed
  if (!merged) {
    // Final cleanup
    try {
      execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: git reset --merge cleanup failed: ${errorMessage}`);
    }
    if (mergeConflictStrategy === "abort") {
      result.resolutionStrategy = "abort";
      throw new Error(`Merge conflict for ${taskId}: aborted per mergeConflictStrategy="abort" — manual resolution required`);
    }
    throw new Error(`AI merge failed for ${taskId}: all 3 attempts exhausted`);
  }

  // 5b. Collect merge details and store on task
  try {
    const commitSha = execSyncText("git rev-parse HEAD", {
      cwd: rootDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim() || undefined;

    let filesChanged: number | undefined;
    let insertions: number | undefined;
    let deletions: number | undefined;

    try {
      const { stdout: statsOutput } = await execAsync("git show --shortstat --format= HEAD", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const normalized = statsOutput.trim().replace(/\n/g, " ");
      const filesMatch = normalized.match(/(\d+) files? changed/);
      const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
      const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);
      filesChanged = filesMatch ? Number.parseInt(filesMatch[1], 10) : 0;
      insertions = insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0;
      deletions = deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0;
    } catch { /* non-fatal */ }

    // Guard 1: if the squash collapsed to an empty commit, recording its SHA
    // misleads every consumer (TaskChangesTab shows "no changes" even though
    // modifiedFiles is non-empty). Real cause: the branch contained commits
    // already on main (duplicate cherry-picks), and conflict resolution
    // dropped them. The actual landing typically happens later via PR merge
    // on a different SHA — let recoverInterruptedMergingTasks /
    // findLandedTaskCommit populate the right SHA when that lands. Until
    // then, store mergeDetails without commitSha so the UI falls back to
    // task.modifiedFiles instead of a broken diff.
    const isEmptyCommit = filesChanged === 0;
    // Guard 2: the empty-squash success paths in mergeAttempt /
    // attemptWithSideStrategy return true without committing when nothing
    // was staged. The recorded HEAD then has nothing to do with this task.
    const recordedSha = (isEmptyCommit || mergeWasEmpty) ? undefined : commitSha;
    if (isEmptyCommit) {
      mergerLog.warn(
        `${taskId}: local squash produced an empty commit (${commitSha?.slice(0, 8)}) — branch likely contained dupes of main. Skipping commitSha; recovery will backfill when real commit lands.`,
      );
    } else if (mergeWasEmpty) {
      mergerLog.warn(
        `${taskId}: merge succeeded without committing (branch already on main). Skipping commitSha; nothing new landed locally.`,
      );
    }

    // When the merge was empty (no commit made), the captured stats describe
    // pre-merge HEAD's commit, not anything this task did. Clear them so
    // consumers don't display unrelated numbers next to "no commit landed".
    const recordedFilesChanged = mergeWasEmpty ? 0 : filesChanged;
    const recordedInsertions = mergeWasEmpty ? 0 : insertions;
    const recordedDeletions = mergeWasEmpty ? 0 : deletions;

    const mergeDetails: MergeDetails = {
      commitSha: recordedSha,
      filesChanged: recordedFilesChanged,
      insertions: recordedInsertions,
      deletions: recordedDeletions,
      mergeCommitMessage: aiMergeSummary || commitLog,
      mergedAt: new Date().toISOString(),
      mergeConfirmed: true,
      resolutionStrategy: result.resolutionStrategy,
      resolutionMethod: result.resolutionMethod,
      attemptsMade: result.attemptsMade,
      autoResolvedCount: result.autoResolvedCount,
    };

    await store.updateTask(taskId, { mergeDetails });
    mergerLog.log(`${taskId}: merge details stored (commitSha: ${recordedSha?.slice(0, 8) ?? "<deferred>"})`);

    // Surface the high-level outcome on the agent-log timeline so users can
    // see the merge's strategy, attempt count, and final commit at a glance.
    const summaryParts: string[] = [
      `Merge completed via ${result.resolutionStrategy ?? "unknown"} (attempt ${result.attemptsMade ?? "?"}/3)`,
    ];
    if (recordedSha) {
      summaryParts.push(`commit ${recordedSha.slice(0, 8)}`);
    } else if (mergeWasEmpty) {
      summaryParts.push("no commit landed (branch already on main)");
    } else if (isEmptyCommit) {
      summaryParts.push("squash collapsed to empty (sha deferred)");
    }
    if (!mergeWasEmpty && filesChanged !== undefined) {
      summaryParts.push(`${filesChanged} file${filesChanged === 1 ? "" : "s"} changed (+${insertions ?? 0}/-${deletions ?? 0})`);
    }
    await store.appendAgentLog(
      taskId,
      summaryParts.join(" · "),
      "text",
      undefined,
      "merger",
    );
  } catch (err: any) {
    mergerLog.warn(`${taskId}: failed to collect/store merge details: ${err.message}`);
  }

  // 6. Delete branch
  try {
    await execAsync(`git branch -d "${branch}"`, { cwd: rootDir });
    result.branchDeleted = true;
    // Audit trail: record branch deletion (FN-1404)
    await audit.git({ type: "branch:delete", target: branch });
  } catch {
    try {
      await execAsync(`git branch -D "${branch}"`, { cwd: rootDir });
      result.branchDeleted = true;
      // Audit trail: record branch deletion (force) (FN-1404)
      await audit.git({ type: "branch:delete", target: branch, metadata: { force: true } });
    } catch { /* non-fatal */ }
  }

  if (result.branchDeleted) {
    // FN-2165 regression guard: if any other task had this branch stored as
    // its baseBranch (common when a dependent task was dispatched off a
    // conflict-suffixed branch), null it so the dependent task doesn't
    // hard-fail at worktree creation once this branch is gone.
    try {
      const cleared = store.clearStaleExecutionStartBranchReferences([branch], taskId);
      if (cleared.length > 0) {
        mergerLog.log(`${taskId}: cleared stale baseBranch on ${cleared.length} dependent task(s): ${cleared.join(", ")}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: failed to clear stale baseBranch references: ${msg}`);
    }
  }

  // 7. Run post-merge workflow steps (in temporary worktree for isolation)
  throwIfAborted(options.signal, taskId);
  const hasPostMergeSteps = await hasEnabledPostMergeWorkflowSteps(store, taskId, task.enabledWorkflowSteps);
  if (hasPostMergeSteps) {
    const postMergeWorktree = await createPostMergeWorktree(rootDir, taskId);
    const postMergeCwd = postMergeWorktree || rootDir;
    if (postMergeWorktree) {
      mergerLog.log(`${taskId}: running post-merge workflow steps in isolated worktree: ${postMergeWorktree}`);
    } else {
      mergerLog.warn(`${taskId}: could not create post-merge worktree — falling back to rootDir`);
    }

    try {
      await runPostMergeWorkflowSteps(store, taskId, rootDir, postMergeCwd, settings, options);
    } catch (err: any) {
      rethrowIfMergeAborted(err);
      mergerLog.error(`${taskId}: post-merge workflow steps error: ${err.message}`);
      // Non-fatal — task still moves to done
    } finally {
      if (postMergeWorktree) {
        await removePostMergeWorktree(rootDir, postMergeWorktree, taskId);
      }
    }
  }

  // 8. Clean up worktree
  throwIfAborted(options.signal, taskId);
  if (worktreePath && existsSync(worktreePath)) {
    const otherUser = await findWorktreeUser(store, worktreePath, taskId);
    if (otherUser) {
      mergerLog.log(`Worktree retained — still needed by ${otherUser}`);
      result.worktreeRemoved = false;
    } else if (options.pool && settings.recycleWorktrees) {
      options.pool.release(worktreePath);
      result.worktreeRemoved = false;
      // Detach the path from this task so future diff queries don't read
      // a foreign branch's state once the pool reassigns this worktree.
      try {
        await store.updateTask(taskId, { worktree: null, branch: null });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        mergerLog.warn(`${taskId}: failed to clear worktree pointer after pool release: ${msg}`);
      }
    } else {
      try {
        await execAsync(`git worktree remove "${worktreePath}" --force`, {
          cwd: rootDir,
        });
        // Audit trail: record worktree removal (FN-1404)
        await audit.git({ type: "worktree:remove", target: worktreePath });
        result.worktreeRemoved = true;
        try {
          await store.updateTask(taskId, { worktree: null, branch: null });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          mergerLog.warn(`${taskId}: failed to clear worktree pointer after removal: ${msg}`);
        }
      } catch { /* non-fatal */ }
    }
  }

  // 8b. Push to remote if configured
  if (settings.pushAfterMerge && settings.mergeStrategy !== "pull-request") {
    try {
      throwIfAborted(options.signal, taskId);
      const pushTask = await store.getTask(taskId).catch(() => null);
      const pushAssignedAgentId = pushTask?.assignedAgentId?.trim();
      const pushAgentStoreWithGetAgent = options.agentStore && typeof (options.agentStore as { getAgent?: unknown }).getAgent === "function"
        ? options.agentStore
        : null;
      const pushAssignedAgent = pushAssignedAgentId && pushAgentStoreWithGetAgent
        ? await pushAgentStoreWithGetAgent.getAgent(pushAssignedAgentId).catch(() => null)
        : null;
      const pushRuntimeHint = extractRuntimeHint(pushAssignedAgent?.runtimeConfig);
      const pushResult = await pushToRemoteAfterMerge(store, rootDir, taskId, settings, {
        onAgentText: options.onAgentText,
        signal: options.signal,
        runtimeHint: pushRuntimeHint,
        onSession: options.onSession,
      });
      if (pushResult.pushed) {
        mergerLog.log(`${taskId}: pushed merged result to remote`);
        // Push may trigger an internal pull --rebase that rewrites HEAD (see
        // pushToRemoteAfterMerge); refresh the recorded commitSha so
        // mergeDetails / recovery don't reference a now-orphaned commit.
        try {
          const postPushSha = execSync("git rev-parse HEAD", {
            cwd: rootDir,
            stdio: "pipe",
            encoding: "utf-8",
          }).trim() || undefined;
          if (postPushSha) {
            const existingTask = await store.getTask(taskId).catch(() => null);
            const existingDetails = existingTask?.mergeDetails;
            if (existingDetails?.commitSha && existingDetails.commitSha !== postPushSha) {
              await store.updateTask(taskId, {
                mergeDetails: { ...existingDetails, commitSha: postPushSha },
              });
              mergerLog.log(
                `${taskId}: post-push HEAD changed from ${existingDetails.commitSha.slice(0, 8)} to ${postPushSha.slice(0, 8)} — refreshed mergeDetails.commitSha`,
              );
            }
          }
        } catch (refreshErr: any) {
          mergerLog.warn(`${taskId}: failed to refresh mergeDetails after push: ${refreshErr.message}`);
        }
      } else {
        mergerLog.warn(`${taskId}: push to remote failed: ${pushResult.error}`);
      }
      result.pushedToRemote = pushResult.pushed;
      if (pushResult.error) {
        result.pushError = pushResult.error;
      }
    } catch (err: any) {
      mergerLog.error(`${taskId}: push to remote error: ${err.message}`);
      result.pushedToRemote = false;
      result.pushError = err.message;
    }
  }

  // 9. Move task to done
  // Audit trail: record merge completion (FN-1404)
  await audit.database({
    type: "task:move",
    target: taskId,
    metadata: {
      to: "done",
      merged: true,
      resolutionStrategy: result.resolutionStrategy,
      resolutionMethod: result.resolutionMethod,
      attemptsMade: result.attemptsMade,
    },
  });
  await completeTask(store, taskId, result);
  return result;

  } finally {
    if (autostashHandle) {
      try {
        const settings = await store.getSettings();
        const outcome = await restoreUnrelatedRootDirChanges(
          rootDir,
          taskId,
          autostashHandle,
          { store, options, settings },
        );
        // Attach outcome to result so callers (dashboard, daemon, CLI) can
        // surface autostash status to the developer. result is undefined
        // only when the try body threw before constructing it — in that
        // case the merge already failed and the outcome warning logs are
        // the best we can do.
        if (resultForFinally) {
          resultForFinally.autostash = outcome;
        }
      } catch (err: unknown) {
        // Any throw from restore should never propagate out of the merger
        // — the merge result has already been recorded. Log and swallow.
        const msg = err instanceof Error ? err.message : String(err);
        mergerLog.warn(`${taskId}: autostash restore threw unexpectedly (${msg}) — stash may be left in place; check git stash list`);
        if (resultForFinally) {
          resultForFinally.autostash = {
            status: "failed",
            stashSha: autostashHandle.sha,
            errorMessage: msg,
          };
        }
      }
    }
    // Always clear the advisory status file last, even if everything above
    // threw — a stale advisory makes the dashboard show a phantom "merge
    // running" indefinitely, which is worse than a missing one.
    clearActiveMergerStatus(activeStatusPath, taskId);
  }
}

/** Best-effort `git fetch origin <currentBranch>` + fast-forward of local
 *  HEAD when origin is strictly ahead. Returns silently on any failure
 *  (no remote configured, network down, divergent local commits, etc.).
 *  Only called for the smart strategies, which want to avoid resolving a
 *  conflict against a stale local base. */
async function tryFastForwardFromOrigin(rootDir: string, taskId: string): Promise<void> {
  let currentBranch: string;
  try {
    currentBranch = execSyncText("git rev-parse --abbrev-ref HEAD", {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return;
  }
  if (!currentBranch || currentBranch === "HEAD") return;

  try {
    await execAsync(`git fetch origin "${currentBranch}"`, { cwd: rootDir });
  } catch (err) {
    mergerLog.log(`${taskId}: pre-merge fetch failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Detect divergence: local must be strictly behind remote (no local-only commits).
  let behind = 0;
  let ahead = 0;
  try {
    const counts = execSyncText(`git rev-list --left-right --count "origin/${currentBranch}...HEAD"`, {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const [b, a] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
    behind = b;
    ahead = a;
  } catch {
    return;
  }

  if (behind === 0) return; // already up to date
  if (ahead > 0) {
    mergerLog.log(`${taskId}: local ${currentBranch} has ${ahead} unpushed commit(s); skipping fast-forward`);
    return;
  }

  try {
    await execAsync(`git merge --ff-only "origin/${currentBranch}"`, { cwd: rootDir });
    mergerLog.log(`${taskId}: fast-forwarded ${currentBranch} by ${behind} commit(s) from origin`);
  } catch (err) {
    mergerLog.log(`${taskId}: fast-forward failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Get the resolution strategy based on attempt number and settings.
 *  `mergeConflictStrategy` controls the FALLBACK on attempt 3 (and gates the
 *  whole cascade on "abort"); attempts 1–2 always try AI then auto-resolve so
 *  trivial conflicts don't pay an unnecessary price. */
function getResolutionStrategy(
  attemptNum: 1 | 2 | 3,
  smartConflictResolution: boolean,
  mergeConflictStrategy: CanonicalMergeConflictStrategy = "smart-prefer-main",
): MergeResult["resolutionStrategy"] {
  if (!smartConflictResolution || attemptNum === 1) {
    return "ai";
  }
  if (attemptNum === 2) {
    return "auto-resolve";
  }
  // Attempt 3: fallback strategy
  switch (mergeConflictStrategy) {
    case "ai-only":
      return "ai";
    case "smart-prefer-main":
      return "ours";
    case "abort":
      return "abort";
    case "smart-prefer-branch":
    default:
      return "theirs";
  }
}

/** Map resolutionStrategy and autoResolvedCount to resolutionMethod for metrics/debugging */
function getResolutionMethod(
  strategy: MergeResult["resolutionStrategy"],
  autoResolvedCount?: number,
  aiWasUsed?: boolean,
): MergeResult["resolutionMethod"] {
  if (strategy === "ai") return "ai";
  if (strategy === "theirs") return "theirs";
  if (strategy === "ours") return "ours";
  if (strategy === "abort") return "abort";
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
  aiSummary?: string | null;
  aiSubject?: string | null;
  includeTaskId: boolean;
  sourceIssueRef?: string;
  smartConflictResolution: boolean;
  mergeConflictStrategy: CanonicalMergeConflictStrategy;
  attemptNum: 1 | 2 | 3;
  options: MergerOptions;
  result: MergeResult;
  settings: Settings;
  testCommand?: string;
  buildCommand?: string;
  /** Source of the test command: 'explicit' from settings or 'inferred' from project files */
  testSource?: "explicit" | "inferred";
  /** Source of the build command: 'explicit' from settings or 'inferred' (future use) */
  buildSource?: "explicit" | "inferred";
  /** Set when the pre-merge rebase recovery cascade (Layers 1–2) failed and
   *  the merge proceeds under smart-prefer-main fall-through. The AI prompt
   *  uses this to inject the safety preamble; the merge cascade uses it to
   *  suppress the unsafe `-X ours` Attempt 3. Carries the original rebase
   *  failure message for diagnostic context. */
  preMergeRebaseFallthrough?: string;
}

/** Mutable flags carried through the merge cascade. */
interface AiInvocationTracker {
  aiWasInvoked: boolean;
  /** True when a "success" was the empty-squash path (no commit made). The
   *  merge metadata block uses this to avoid recording pre-merge HEAD as
   *  this task's commitSha. */
  mergeWasEmpty?: boolean;
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
    aiSummary,
    aiSubject,
    includeTaskId,
    sourceIssueRef,
    smartConflictResolution,
    attemptNum,
    options,
    result,
    settings,
    testCommand,
    buildCommand,
    testSource,
    buildSource,
  } = params;

  // Attempt 3: dispatch on the configured fallback strategy.
  // Note: "ai-only" and "abort" are filtered out by the mergeAttempt cascade
  // before reaching here — only the two smart variants legitimately run attempt 3.
  if (attemptNum === 3) {
    if (params.mergeConflictStrategy === "smart-prefer-main") {
      return attemptWithSideStrategy(params, "ours", aiTracker);
    }
    return attemptWithSideStrategy(params, "theirs", aiTracker);
  }

  // Attempt 1 & 2: Standard squash merge
  let hasConflicts = false;
  try {
    // For attempt 2, try with smart auto-resolution first
    if (attemptNum === 2 && smartConflictResolution) {
      // First, do a standard merge to get conflicts
      // Note: git merge --squash exits with code 1 when conflicts exist
      // This is expected - we catch it and proceed with auto-resolution
      let mergeError: unknown;
      try {
        await execAsync(`git merge --squash "${branch}"`, {
          cwd: rootDir,
        });
        throwIfAborted(options.signal, taskId);
      } catch (error: unknown) {
        rethrowIfMergeAborted(error);
        // Capture the error so we can distinguish "exit code 1 with conflicts"
        // (expected, recoverable) from "any other failure" (hooks, IO, locks).
        mergeError = error;
      }

      // Use new API: get conflicted files and classify them
      const conflictedFiles = await getConflictedFiles(rootDir);

      // Don't paper over non-conflict failures: if the merge errored AND no
      // U files exist, the failure was something other than a merge conflict
      // (pre-commit hook, disk error, repo lock, etc.). Returning success
      // here would store merge metadata for a merge that never happened.
      // The outer mergeAttempt catch propagates this sentinel name without
      // retrying (retrying would just re-run the same broken command).
      if (mergeError && conflictedFiles.length === 0) {
        const cause = mergeError instanceof Error ? mergeError.message : String(mergeError);
        const fatal = new Error(
          `${taskId}: git merge --squash failed without producing conflicts ` +
          `(${cause}) — refusing to treat as a no-op merge.`,
        );
        fatal.name = "MergeNonConflictError";
        throw fatal;
      }
      const mergeExitedWithConflicts = mergeError !== undefined;
      if (conflictedFiles.length > 0 || mergeExitedWithConflicts) {
        // Classify each conflicted file
        const classified: { file: string; type: ConflictType }[] = [];
        for (const file of conflictedFiles) {
          const type = await classifyConflict(file, rootDir);
          classified.push({ file, type });
        }

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
                await resolveWithOurs(file, rootDir);
              } else if (type === "generated-theirs") {
                await resolveWithTheirs(file, rootDir);
              } else if (type === "trivial-whitespace") {
                await resolveTrivialWhitespace(file, rootDir);
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
          const staged = execSyncText("git diff --cached --quiet 2>&1; echo $?", {
            cwd: rootDir,
            encoding: "utf-8",
          }).trim();

          if (staged !== "0") {
            throwIfAborted(options.signal, taskId);
            // Body cascade: branch's commit log → AI summary of diff stat →
            // diff stat itself → synthetic placeholder. Guarantees the
            // merge commit carries a non-empty body even when the branch
            // has no unique commits to summarize.
            const safeBody = await resolveSafeCommitBody({
              rootDir,
              taskId,
              branch,
              commitLog,
              diffStat,
              settings: settings as Settings,
              signal: options.signal,
            });
            const authorArg = getCommitAuthorArg(settings);
            const trailerArg = buildTaskIdTrailerArg(taskId);
            const { subjectArg, bodyArg } = await buildDeterministicMergeMessage({
              taskId,
              branch,
              commitLog,
              diffStat,
              includeTaskId,
              aiSummary: safeBody,
              aiSubject,
            });
            await execAsync(
              `git commit ${subjectArg} ${bodyArg}${trailerArg}${authorArg}`,
              { cwd: rootDir },
            );
            mergerLog.log(`${taskId}: committed after auto-resolving all conflicts`);
          } else {
            // Auto-resolution left nothing to commit — branch's changes were
            // either fully duplicated on main or all-resolved-to-ours.
            aiTracker.mergeWasEmpty = true;
          }
          // Run deterministic verification before completing the merge
          if (testCommand || buildCommand) {
            throwIfAborted(options.signal, taskId);
            await runDeterministicVerification(
              store,
              rootDir,
              taskId,
              testCommand,
              buildCommand,
              testSource,
              buildSource,
              options.signal,
            );
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
          aiTracker.mergeWasEmpty = true;
          // Run deterministic verification (nothing staged but still verify)
          if (testCommand || buildCommand) {
            throwIfAborted(options.signal, taskId);
            await runDeterministicVerification(
              store,
              rootDir,
              taskId,
              testCommand,
              buildCommand,
              testSource,
              buildSource,
              options.signal,
            );
          }
          return true;
        }
        // No conflicts but has staged changes - continue to AI for commit message
      }
    } else {
      // Attempt 1: Standard merge
      await execAsync(`git merge --squash "${branch}"`, {
        cwd: rootDir,
      });
      throwIfAborted(options.signal, taskId);

      // Check if squash is empty
      const squashIsEmpty = execSync(
        "git diff --cached --quiet 2>&1; echo $?",
        { cwd: rootDir, encoding: "utf-8" },
      ).trim() === "0";

      if (squashIsEmpty) {
        mergerLog.log(`${taskId}: squash merge staged nothing — already merged`);
        aiTracker.mergeWasEmpty = true;
        // Run deterministic verification (nothing staged but still verify)
        if (testCommand || buildCommand) {
          throwIfAborted(options.signal, taskId);
          await runDeterministicVerification(
            store,
            rootDir,
            taskId,
            testCommand,
            buildCommand,
            testSource,
            buildSource,
            options.signal,
          );
        }
        return true;
      }

      // Check for conflicts
      const conflictedOutput = execSyncText("git diff --name-only --diff-filter=U", {
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
      throwIfAborted(options.signal, taskId);
      const stagedFiles = await getStagedFiles(rootDir);
      if (shouldSyncDependenciesForMerge(stagedFiles, hasInstallState(rootDir))) {
        await syncDependenciesForMerge(store, rootDir, taskId, options.signal);
      }
    }

    // At this point, either:
    // - No conflicts (attempt 1) - AI writes commit message
    // - Complex conflicts remain after attempt 2 auto-resolution - AI resolves them
    // Spawn AI agent
    throwIfAborted(options.signal, taskId);
    aiTracker.aiWasInvoked = true; // Track that AI was invoked
    const agentResult = await runAiAgentForCommit({
      store,
      rootDir,
      taskId,
      branch,
      commitLog,
      diffStat,
      aiSummary,
      aiSubject,
      includeTaskId,
      hasConflicts,
      simplifiedContext: attemptNum === 2,
      options,
      testCommand,
      buildCommand,
      sourceIssueRef,
      preMergeRebaseFallthrough: params.preMergeRebaseFallthrough,
    });

    // Handle build failure
    if (!agentResult.success) {
      // Build verification failed via fn_report_build_failure. DO NOT reset
      // here: the squash state must survive for the in-merge verification
      // fix path (mergeAttempt's catch handler) to either fold its fix into
      // a fresh commit or — if the fix is disabled/exhausted — reset and
      // propagate. Resetting here previously caused the phantom-merge bug:
      // the fix agent ran on a clean main, then commitOrAmendMergeWithFixes
      // amended the *previous* task's commit because HEAD looked unchanged
      // and there was nothing left of the current task's branch to commit.
      const errorMessage = agentResult.error || "Build verification failed";
      await store.logEntry(taskId, "Build verification failed during merge", errorMessage);
      throw new Error(`Build verification failed for ${taskId}: ${errorMessage}`);
    }

    // Run deterministic verification after AI agent commits
    if (testCommand || buildCommand) {
      throwIfAborted(options.signal, taskId);
      await runDeterministicVerification(
        store,
        rootDir,
        taskId,
        testCommand,
        buildCommand,
        testSource,
        buildSource,
        options.signal,
      );
    }

    // Replace the AI-written commit message with a deterministic body built
    // from the branch's actual step-commit subjects. The AI's free-form body
    // routinely hallucinates bullets that describe work from neighbouring
    // tasks (especially on small diffs), and that message is what consumers
    // of mergeDetails surface. Subject keeps the conventional-commit shape.
    try {
      const authorArg = getCommitAuthorArg(params.settings);
      // Recompute context against the AI commit's parent (= integration
      // target) so the message describes only what this commit actually
      // adds — not the wide branch range, which under squash-merge can
      // include work already landed via prior task merges.
      let integrationTargetSha: string | undefined;
      try {
        const { stdout } = await execAsync("git rev-parse HEAD~1", {
          cwd: rootDir,
          encoding: "utf-8",
        });
        integrationTargetSha = stdout.trim() || undefined;
      } catch {
        // Root commit / detached state — fall through to wide-range values.
      }
      const actualContext = integrationTargetSha
        ? await computeActualMergeCommitContext({
            rootDir,
            integrationTargetSha,
            branch,
          })
        : { commitLog: "", diffStat: "" };
      const { subjectArg, bodyArg } = await buildDeterministicMergeMessage({
        taskId,
        branch,
        commitLog: actualContext.commitLog || commitLog,
        diffStat: actualContext.diffStat || diffStat,
        includeTaskId,
        aiSummary,
        aiSubject,
      });
      const trailerArg = buildTaskIdTrailerArg(taskId);
      await execAsync(
        `git commit --amend ${subjectArg} ${bodyArg}${trailerArg}${authorArg}`,
        { cwd: rootDir },
      );
      mergerLog.log(`${taskId}: rewrote AI-authored merge commit message with deterministic body`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: failed to canonicalize merge commit message (${msg}) — keeping AI-written message`);
    }

    return true;
  } catch (error: any) {
    if (error instanceof Error && error.name === "MergeAbortedError") {
      try {
        execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
      } catch {
        // best-effort abort cleanup
      }
      throw error;
    }

    // Check if it's a build verification failure - don't retry, propagate immediately
    if (error.message?.includes("Build verification failed")) {
      throw error; // Fatal - don't retry build failures
    }

    // Check if it's a non-conflict merge failure
    if (error.message?.includes("Merge failed")) {
      throw error; // Fatal
    }

    // VerificationError must propagate so mergeAttempt's catch can run the
    // in-merge fix against THIS attempt's preAttemptHeadSha baseline. Falling
    // through to the attempt-1 retry path here would swallow the error,
    // trigger attempt 2 with a stale baseline (= AI's commit from attempt 1),
    // and then the in-merge fix's finalizer would see !hasStaged && !headMoved
    // and trip the phantom-merge guard even though the task's content is
    // already on HEAD. Retrying with auto-conflict-resolution can't help a
    // verification failure anyway — there are no conflicts to resolve.
    if (error?.name === "VerificationError") {
      throw error;
    }

    // For attempt 1, return false to trigger attempt 2 (conflict-only path)
    if (attemptNum === 1 && smartConflictResolution) {
      return false;
    }

    // Otherwise propagate
    throw error;
  }
}

/**
 * Attempt 3: Use git merge -X{theirs,ours} --squash strategy.
 * Side controls which version wins on conflicts:
 *   - "theirs" — the task branch wins (mergeConflictStrategy="smart-prefer-branch")
 *   - "ours" — the main branch wins (mergeConflictStrategy="smart-prefer-main", default)
 */
async function attemptWithSideStrategy(
  params: MergeAttemptParams,
  side: "theirs" | "ours" = "theirs",
  aiTracker?: AiInvocationTracker,
): Promise<boolean> {
  const { rootDir, branch, commitLog, diffStat, aiSummary, aiSubject, includeTaskId, sourceIssueRef, taskId, store, settings, testCommand, buildCommand, testSource, buildSource } = params;

  mergerLog.log(`${taskId}: attempting merge with -X ${side} strategy`);

  try {
    throwIfAborted(params.options.signal, taskId);
    await execAsync(`git merge -X ${side} --squash "${branch}"`, {
      cwd: rootDir,
    });

    // Check if there are still conflicts (some types can't be auto-resolved)
    const conflictedOutput = execSyncText("git diff --name-only --diff-filter=U", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();

    if (conflictedOutput.length > 0) {
      mergerLog.warn(`${taskId}: -X ${side} left unresolved conflicts: ${conflictedOutput}`);
      return false;
    }

    // Check if there's anything staged
    const staged = execSyncText("git diff --cached --quiet 2>&1; echo $?", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();

    if (staged === "0") {
      // Nothing staged - already merged. Mark empty so the metadata block
      // doesn't record pre-merge HEAD as this task's commitSha.
      if (aiTracker) aiTracker.mergeWasEmpty = true;
      // Run deterministic verification even when nothing is staged
      if (testCommand || buildCommand) {
        throwIfAborted(params.options.signal, taskId);
        await runDeterministicVerification(
          store,
          rootDir,
          taskId,
          testCommand,
          buildCommand,
          testSource,
          buildSource,
          params.options.signal,
        );
      }
      return true;
    }

    // Commit with fallback message. Body cascade: branch's commit log →
    // AI summary of diff stat → diff stat itself → synthetic placeholder.
    // Guarantees the merge commit carries a non-empty body that downstream
    // consumers (release notes, dashboard summaries) can rely on.
    throwIfAborted(params.options.signal, taskId);
    const safeBody = await resolveSafeCommitBody({
      rootDir,
      taskId,
      branch,
      commitLog,
      diffStat,
      settings: settings as Settings,
      signal: params.options.signal,
    });
    const authorArg = getCommitAuthorArg(settings);
    const trailerArg = buildTaskIdTrailerArg(taskId);
    const issueRefBodyArg = sourceIssueRef ? ` -m "Ref: ${sourceIssueRef}"` : "";
    const { subjectArg, bodyArg } = await buildDeterministicMergeMessage({
      taskId,
      branch,
      commitLog,
      diffStat,
      includeTaskId,
      aiSummary: aiSummary?.trim().length ? aiSummary : safeBody,
      aiSubject,
    });
    await execAsync(
      `git commit ${subjectArg} ${bodyArg}${issueRefBodyArg}${trailerArg}${authorArg}`,
      { cwd: rootDir },
    );
    mergerLog.log(`${taskId}: committed with -X ${side} auto-resolution`);

    // Run deterministic verification after committing
    if (testCommand || buildCommand) {
      throwIfAborted(params.options.signal, taskId);
      await runDeterministicVerification(
        store,
        rootDir,
        taskId,
        testCommand,
        buildCommand,
        testSource,
        buildSource,
        params.options.signal,
      );
    }

    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "MergeAbortedError") {
      throw error;
    }
    mergerLog.error(`${taskId}: -X ${side} merge failed: ${error}`);
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
  aiSummary?: string | null;
  aiSubject?: string | null;
  includeTaskId: boolean;
  hasConflicts: boolean;
  simplifiedContext: boolean;
  sourceIssueRef?: string;
  options: MergerOptions;
  testCommand?: string;
  buildCommand?: string;
  /** Forwarded from MergeAttemptParams; injects the safety preamble into
   *  the merge prompt when the pre-merge rebase recovery cascade fell
   *  through. See MergePromptParams.preMergeRebaseFallthrough for details. */
  preMergeRebaseFallthrough?: string;
}

/**
 * Run the AI agent to resolve conflicts and/or write commit message.
 *
 * Each invocation creates a **fresh session** via `createFnAgent` to ensure
 * no stale conversation state from previous merge attempts or unrelated sessions
 * pollutes the merge context. The session is disposed in the `finally` block
 * regardless of success or failure.
 *
 * **Context-limit recovery:** If the session's `prompt()` call throws a
 * context-window overflow error (detected via `isContextLimitError`), this
 * function attempts a single **compact-and-retry** cycle:
 * 1. Calls `compactSessionContext()` to compress the conversation history
 * 2. Retries the `prompt()` call with the compacted session
 * 3. If compaction is unavailable or fails, propagates the original error
 *
 * Non-context errors (network, rate limits, build failures) are propagated
 * immediately without compaction recovery.
 *
 * @returns `{ success: true }` on successful commit, `{ success: false, error }`
 *          when build verification fails, or throws on unrecoverable errors.
 */
async function runAiAgentForCommit(params: AiAgentParams): Promise<{ success: boolean; error?: string }> {
  const {
    store,
    rootDir,
    taskId,
    branch,
    commitLog,
    diffStat,
    aiSummary,
    aiSubject,
    includeTaskId,
    hasConflicts,
    simplifiedContext,
    sourceIssueRef,
    options,
    testCommand,
    buildCommand,
    preMergeRebaseFallthrough,
  } = params;

  const settings = await store.getSettings();

  // Track build failure state
  let buildFailed = false;
  let buildErrorMessage = "";

  // Create custom tool for reporting build failures
  const reportBuildFailureTool: ToolDefinition = {
    name: "fn_report_build_failure",
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
    persistAgentToolOutput: settings.persistAgentToolOutput,
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
  const authorArg = getCommitAuthorArg(settings);
  const mergerSystemPrompt = buildSystemPromptWithInstructions(
    buildMergeSystemPrompt(includeTaskId, settings.agentPrompts, authorArg),
    mergerInstructions,
  );

  throwIfAborted(options.signal, taskId);

  // Build skill selection context (assigned agent skills take precedence over role fallback)
  let skillContext = undefined;
  let taskForSkillContext: Awaited<ReturnType<typeof store.getTask>> | null = null;
  if (options.agentStore) {
    try {
      taskForSkillContext = await store.getTask(taskId);
      skillContext = await buildSessionSkillContext({
        agentStore: options.agentStore,
        task: taskForSkillContext,
        sessionPurpose: "merger",
        projectRootDir: rootDir,
        pluginRunner: options.pluginRunner,
      });
    } catch {
      // Graceful fallback - no skill selection
    }
  }

  const assignedAgentId = taskForSkillContext?.assignedAgentId?.trim();
  const agentStoreWithGetAgent = options.agentStore && typeof (options.agentStore as { getAgent?: unknown }).getAgent === "function"
    ? options.agentStore
    : null;
  const assignedAgent = assignedAgentId && agentStoreWithGetAgent
    ? await agentStoreWithGetAgent.getAgent(assignedAgentId).catch(() => null)
    : null;
  const mergerRuntimeHint = extractRuntimeHint(assignedAgent?.runtimeConfig);

  const { session } = await createResolvedAgentSession({
    sessionPurpose: "merger",
    runtimeHint: mergerRuntimeHint,
    pluginRunner: options.pluginRunner,
    cwd: rootDir,
    systemPrompt: mergerSystemPrompt,
    tools: "coding",
    customTools: [reportBuildFailureTool, createWebFetchTool()],
    onText: agentLogger.onText,
    onThinking: agentLogger.onThinking,
    onToolStart: agentLogger.onToolStart,
    onToolEnd: agentLogger.onToolEnd,
    defaultProvider: settings.defaultProviderOverride && settings.defaultModelIdOverride
      ? settings.defaultProviderOverride
      : settings.defaultProvider,
    defaultModelId: settings.defaultProviderOverride && settings.defaultModelIdOverride
      ? settings.defaultModelIdOverride
      : settings.defaultModelId,
    fallbackProvider: settings.fallbackProvider,
    fallbackModelId: settings.fallbackModelId,
    defaultThinkingLevel: settings.defaultThinkingLevel,
    // Skill selection: use assigned agent skills if available, otherwise role fallback
    ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    taskId,
    taskTitle: taskForSkillContext?.title,
    onFallbackModelUsed: createFallbackModelObserver({
      agent: "merger",
      label: "merge agent",
      store,
      taskId,
      taskTitle: taskForSkillContext?.title,
    }),
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
      testCommand,
      buildCommand,
      authorArg,
      sourceIssueRef,
      preMergeRebaseFallthrough,
    });

    // Attempt prompting with fresh session (first attempt).
    // Log message distinguishes fresh-session start from compaction recovery path.
    mergerLog.log(`${taskId}: starting fresh merge agent session`);

    try {
      await withRateLimitRetry(async () => {
        throwIfAborted(options.signal, taskId);
        await promptWithFallback(session, prompt);
        checkSessionError(session);
      }, {
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          mergerLog.warn(`⏳ ${taskId} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
        },
        signal: options.signal,
      });
    } catch (err: unknown) {
      // Context-limit error after promptWithFallback's auto-compaction already attempted recovery.
      // Try truncated prompt retry as second-level fallback.
      // This detects when the LLM rejects the prompt due to context-window overflow.
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (isContextLimitError(errorMessage)) {
        mergerLog.warn(`${taskId}: context limit hit after auto-compaction — retrying with minimal merge prompt`);
        await store.logEntry(taskId, "Context limit reached during merge after auto-compaction — retrying with reduced prompt");

        // Build minimal prompt: omit diff stat, use placeholder for commit log.
        // The fall-through preamble is preserved (it's the safety constraint,
        // not bulk context) so the AI's truncated retry still knows main's
        // deletions are authoritative.
        const truncatedPrompt = buildMergePrompt({
          taskId,
          branch,
          commitLog: "(see git log)", // Minimal placeholder instead of full commit log
          diffStat: "", // Omit diff stat entirely
          hasConflicts,
          simplifiedContext: true, // Also skip detailed context
          testCommand,
          buildCommand,
          authorArg,
          sourceIssueRef,
          preMergeRebaseFallthrough,
        });

        try {
          await withRateLimitRetry(async () => {
            throwIfAborted(options.signal, taskId);
            await promptWithFallback(session, truncatedPrompt);
            checkSessionError(session);
          }, {
            onRetry: (attempt, delayMs, error) => {
              const delaySec = Math.round(delayMs / 1000);
              mergerLog.warn(`⏳ ${taskId} rate limited during truncated retry — retry ${attempt} in ${delaySec}s: ${error.message}`);
            },
            signal: options.signal,
          });
        } catch (retryErr: unknown) {
          // Truncated retry also failed: propagate original error
          const retryErrorMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (isContextLimitError(retryErrorMessage)) {
            mergerLog.error(`${taskId}: truncated retry also hit context limit — propagating original error`);
            throw err; // Throw original error with original context
          }
          throw retryErr; // Non-context error or other failure
        }
      } else {
        // Non-context error (network, rate limit, build failure): propagate immediately.
        // Rate limit errors are handled by withRateLimitRetry above; this catches
        // errors that bubble up after retries are exhausted.
        throw err;
      }
    }

    // Check if build failed
    if (buildFailed) {
      mergerLog.error(`Build verification failed for ${taskId}: ${buildErrorMessage}`);
      return { success: false, error: buildErrorMessage };
    }

    // Verify commit happened
    const staged = execSyncText("git diff --cached --quiet 2>&1; echo $?", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();

    if (staged !== "0") {
      // Only use fallback commit if no build command was configured
      // If build command was configured, agent should have committed or reported failure
      if (!buildCommand) {
        throwIfAborted(options.signal, taskId);
        mergerLog.log("Agent didn't commit — committing with fallback message");
        // Body cascade: branch's commit log → AI summary of diff stat →
        // diff stat itself → synthetic placeholder. Guarantees the merge
        // commit carries a non-empty body even when the AI agent didn't
        // commit and the branch has no unique commits to summarize.
        const safeBody = await resolveSafeCommitBody({
          rootDir,
          taskId,
          branch,
          commitLog,
          diffStat,
          settings: settings as Settings,
          signal: options.signal,
        });
        const authorArg = getCommitAuthorArg(settings);
        const trailerArg = buildTaskIdTrailerArg(taskId);
        const issueRefBodyArg = sourceIssueRef ? ` -m "Ref: ${sourceIssueRef}"` : "";
        const { subjectArg, bodyArg } = await buildDeterministicMergeMessage({
          taskId,
          branch,
          commitLog,
          diffStat,
          includeTaskId,
          aiSummary: aiSummary?.trim().length ? aiSummary : safeBody,
          aiSubject,
        });
        await execAsync(
          `git commit ${subjectArg} ${bodyArg}${issueRefBodyArg}${trailerArg}${authorArg}`,
          { cwd: rootDir },
        );
      } else {
        // Build command was configured but agent didn't commit and didn't report failure
        // This is an error condition - agent didn't follow instructions
        throw new Error(`Agent did not commit and did not report build failure for ${taskId}`);
      }
    } else {
      // The agent committed. Idempotently ensure the Fusion-Task-Id trailer
      // is present on HEAD — recovery (findLandedTaskCommit) relies on it
      // when includeTaskIdInCommit=false, since the subject won't carry the
      // task ID and subject grep would miss the commit.
      await ensureTaskIdTrailerOnHead(rootDir, taskId);
    }

    return { success: true };
  } catch (err: any) {
    mergerLog.error(`Agent failed: ${err.message}`);

    if (options.usageLimitPauser && isUsageLimitError(err.message)) {
      await options.usageLimitPauser.onUsageLimitHit("merger", taskId, err.message);
    }

    throw err;
  } finally {
    await accumulateSessionTokenUsage(store, taskId, session);
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
  sourceIssueRef?: string;
  testCommand?: string;
  buildCommand?: string;
  authorArg?: string;
  /** When set, the pre-merge rebase aborted under smart-prefer-main and the
   *  surgical/patch-id recovery layers couldn't unblock it. The prompt
   *  injects an explicit safety preamble so the AI knows main's deletions
   *  are authoritative and to prefer main on ambiguous hunks. The
   *  deterministic post-merge verification (test + build) is the safety
   *  gate; this preamble gives the AI a fighting chance to do the right
   *  thing on its first try. */
  preMergeRebaseFallthrough?: string;
}

export function buildMergePrompt(params: MergePromptParams): string {
  const { taskId, branch, commitLog, diffStat, hasConflicts, simplifiedContext, sourceIssueRef, testCommand, buildCommand, authorArg, preMergeRebaseFallthrough } = params;

  // Apply truncation to prevent context overflow for large branches/diffs
  const truncatedCommitLog = truncateWithEllipsis(commitLog, MERGE_COMMIT_LOG_MAX_CHARS);
  const truncatedDiffStat = truncateWithEllipsis(diffStat, MERGE_DIFF_STAT_MAX_CHARS);

  const parts: string[] = [];

  // When pre-merge rebase recovery layers (1+2) couldn't reconcile this
  // branch with main, this AI invocation is the final automated arbiter.
  // Give it the context and the safety constraint up front — verification
  // (test + build) is what enforces the constraint, but the AI should still
  // know what's expected so its first attempt has a real chance.
  if (preMergeRebaseFallthrough) {
    parts.push(
      "## ⚠️ Pre-merge rebase recovery exhausted — you are the final arbiter",
      "",
      "The pre-merge rebase against main aborted, and the surgical (Layer 1) and",
      "patch-id (Layer 2) recovery layers could not reconcile the branch. You are",
      "running under `smart-prefer-main` strategy, which means:",
      "",
      "**SAFETY CONSTRAINT — main's deletions are authoritative.**",
      "- If a hunk shows main has deleted lines that the branch re-adds, prefer",
      "  main's deletion. Branch-only re-additions are likely orphan content from",
      "  a squash-merged dependency and must NOT be re-introduced.",
      "- If a hunk is genuinely ambiguous, prefer main's version.",
      "- The merge result MUST pass `pnpm test` and `pnpm build`. If you can't",
      "  produce a result that does, call `fn_report_build_failure` with concrete",
      "  output rather than committing a regression.",
      "",
      `Original rebase failure for context: ${preMergeRebaseFallthrough.slice(0, 800)}`,
      "",
      "---",
      "",
    );
  }

  parts.push(
    `Finalize the merge of branch \`${branch}\` for task ${taskId}.`,
    "",
    "## Branch commits",
    "```",
    truncatedCommitLog,
    "```",
  );

  if (!simplifiedContext) {
    parts.push(
      "",
      "## Files changed",
      "```",
      truncatedDiffStat,
      "```",
    );
  }

  if (hasConflicts) {
    parts.push(
      "",
      "## ⚠️ There are merge conflicts",
      "Run `git diff --name-only --diff-filter=U` to see which files.",
      "Resolve each conflict, then `git add` the resolved files.",
      `After resolving all conflicts, write and run the commit command.${authorArg ? ` Be sure to include \`${authorArg.trim()}\` in the commit command.` : ""}`,
    );
  } else {
    parts.push(
      "",
      "## No conflicts",
      "The merge applied cleanly. All changes are staged.",
      `Write and run the \`git commit\` command with a good message summarizing the work.${authorArg ? ` Be sure to include \`${authorArg.trim()}\` in the commit command.` : ""}`,
    );
  }

  if (sourceIssueRef) {
    parts.push(
      "",
      "Include this in the commit message body:",
      `- Ref: ${sourceIssueRef}`,
    );
  }

  // Add test command section if provided
  if (testCommand) {
    parts.push(
      "",
      "## Test command",
      `Test command: \`${testCommand}\``,
      "",
      "This command is mandatory before commit.",
      "Run it with the bash tool in the current worktree and inspect the actual exit code.",
      "Only proceed if it exits 0.",
      "If it exits non-zero, call `fn_report_build_failure` with the concrete error output and stop without committing.",
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
      "If it exits non-zero, call `fn_report_build_failure` with the concrete error output and stop without committing.",
    );
  }

  return parts.join("\n");
}

async function hasEnabledPostMergeWorkflowSteps(
  store: TaskStore,
  taskId: string,
  enabledWorkflowSteps: string[] | undefined,
): Promise<boolean> {
  if (!enabledWorkflowSteps?.length) return false;

  for (const wsId of enabledWorkflowSteps) {
    try {
      const ws = await store.getWorkflowStep(wsId);
      if (!ws) continue;
      const stepPhase = ws.phase || "pre-merge";
      // readonly review steps always run pre-merge to reuse the coding worktree — see FN-2185 post-mortem.
      if (stepPhase === "post-merge" && ws.toolMode !== "readonly") {
        return true;
      }
    } catch (err: unknown) {
      mergerLog.warn(`${taskId}: failed to inspect workflow step ${wsId} for post-merge phase: ${getCommandErrorMessage(err)}`);
    }
  }

  return false;
}

/**
 * Run post-merge workflow steps for a task after the merge succeeds.
 * Steps execute in an isolated worktree (created from merged HEAD) to prevent
 * modifications to the main project directory. Falls back to rootDir if worktree
 * creation fails. Failures are logged but do NOT block task completion.
 */
async function runPostMergeWorkflowSteps(
  store: TaskStore,
  taskId: string,
  rootDir: string,
  cwd: string,
  settings: Settings,
  mergeOptions: MergerOptions = {},
): Promise<void> {
  throwIfAborted(mergeOptions.signal, taskId);
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

    // Only run post-merge steps here.
    // readonly review steps always run pre-merge to reuse the coding worktree — see FN-2185 post-mortem.
    if (stepPhase !== "post-merge" || ws.toolMode === "readonly") continue;

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
        ? await executePostMergeScriptStep(store, taskId, ws, cwd, settings)
        : await executePostMergePromptStep(store, taskId, ws, rootDir, cwd, settings, mergeOptions);
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
        mergerLog.error(`${taskId}: [post-merge] workflow step failed: ${ws.name}; output captured in task log`);
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

/** Execute a script-mode post-merge workflow step in the provided execution directory. */
async function executePostMergeScriptStep(
  store: TaskStore,
  taskId: string,
  workflowStep: WorkflowStep,
  cwd: string,
  settings: Settings,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const scriptName = workflowStep.scriptName!.trim();
  const scripts = settings.scripts || {};
  const scriptCommand = scripts[scriptName];

  if (!scriptCommand) {
    return { success: false, error: `Script '${scriptName}' not found in project settings` };
  }

  try {
    await execAsync(scriptCommand, {
      cwd,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { success: true, output: `Script '${scriptName}' completed successfully` };
  } catch (err: any) {
    const stderr = err.stderr?.toString()?.trim() || "";
    const stdout = err.stdout?.toString()?.trim() || "";
    const exitCode = err.code ?? err.status;
    const parts: string[] = [];
    if (exitCode !== undefined) parts.push(`Exit code: ${exitCode}`);
    if (stdout) parts.push(`stdout: ${truncateWorkflowScriptOutput(stdout)}`);
    if (stderr) parts.push(`stderr: ${truncateWorkflowScriptOutput(stderr)}`);
    if (!parts.length) parts.push(err.message || "Unknown error");
    return { success: false, error: parts.join("\n") };
  }
}

/** Execute a prompt-mode post-merge workflow step using an AI agent in the provided execution directory. */
async function executePostMergePromptStep(
  store: TaskStore,
  taskId: string,
  workflowStep: WorkflowStep,
  rootDir: string,
  cwd: string,
  settings: Settings,
  mergeOptions: MergerOptions = {},
): Promise<{ success: boolean; output?: string; error?: string }> {
  const toolMode: "coding" | "readonly" = workflowStep.toolMode || "readonly";
  const systemPrompt = `You are a post-merge workflow step agent executing: ${workflowStep.name}

Task Context:
- Task ID: ${taskId}
- The merge has already been completed successfully.
- You are running in a temporary worktree with the merged code.

Your role:
- Execute this step exactly as requested.
- Validate outcomes against evidence in the merged tree.
- Report findings in clear, actionable language with file-level references when possible.

Your Instructions:
${workflowStep.prompt}

You have access to the file system to review the merged changes.
When your review is complete and everything looks good, simply state your findings.
If issues are found that need attention, describe them clearly and include concrete remediation direction.`;

  const agentLogger = new AgentLogger({
    store,
    taskId,
    agent: "merger",
    persistAgentToolOutput: settings.persistAgentToolOutput,
  });

  try {
    const defaultModel = resolveProjectDefaultModel(settings);
    const stepProvider = workflowStep.modelProvider || defaultModel.provider;
    const stepModelId = workflowStep.modelId || defaultModel.modelId;
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

    // Build skill selection context for post-merge session
    let postMergeSkillContext = undefined;
    let taskForSkillContext: Awaited<ReturnType<typeof store.getTask>> | null = null;
    if (mergeOptions.agentStore) {
      try {
        taskForSkillContext = await store.getTask(taskId);
        postMergeSkillContext = await buildSessionSkillContext({
          agentStore: mergeOptions.agentStore,
          task: taskForSkillContext,
          sessionPurpose: "merger",
          projectRootDir: rootDir,
          pluginRunner: mergeOptions.pluginRunner,
        });
      } catch {
        // Graceful fallback - no skill selection
      }
    }

    const assignedAgentId = taskForSkillContext?.assignedAgentId?.trim();
    const agentStoreWithGetAgent = mergeOptions.agentStore && typeof (mergeOptions.agentStore as { getAgent?: unknown }).getAgent === "function"
      ? mergeOptions.agentStore
      : null;
    const assignedAgent = assignedAgentId && agentStoreWithGetAgent
      ? await agentStoreWithGetAgent.getAgent(assignedAgentId).catch(() => null)
      : null;
    const mergerRuntimeHint = extractRuntimeHint(assignedAgent?.runtimeConfig);
    const { session } = await createResolvedAgentSession({
      sessionPurpose: "merger",
      runtimeHint: mergerRuntimeHint,
      pluginRunner: mergeOptions.pluginRunner,
      cwd,
      systemPrompt: postMergeSystemPrompt,
      tools: toolMode,
      defaultProvider: stepProvider,
      defaultModelId: stepModelId,
      fallbackProvider: settings.fallbackProvider,
      fallbackModelId: settings.fallbackModelId,
      defaultThinkingLevel: settings.defaultThinkingLevel,
      // Skill selection: use assigned agent skills if available, otherwise role fallback
      ...(postMergeSkillContext?.skillSelectionContext ? { skillSelection: postMergeSkillContext.skillSelectionContext } : {}),
      taskId,
      onFallbackModelUsed: createFallbackModelObserver({
        agent: "merger",
        label: `post-merge workflow step '${workflowStep.name}'`,
        store,
        taskId,
      }),
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
      `Review the merged code in the temporary worktree and evaluate it against your instructions.`,
    );

    checkSessionError(session);
    await accumulateSessionTokenUsage(store, taskId, session);
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
