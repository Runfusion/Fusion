/* eslint-disable @typescript-eslint/no-explicit-any */
import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getTaskMergeBlocker, type TaskStore, type MergeResult, type MergeDetails, type WorkflowStep, type WorkflowStepResult, type Settings, type AgentPromptsConfig } from "@fusion/core";
import { resolveAgentPrompt } from "@fusion/core";
import { createKbAgent, describeModel, promptWithFallback, compactSessionContext } from "./pi.js";
import { buildSessionSkillContext } from "./session-skill-context.js";
import type { WorktreePool } from "./worktree-pool.js";
import { AgentLogger } from "./agent-logger.js";
import { mergerLog } from "./logger.js";
import { isUsageLimitError, checkSessionError, type UsageLimitPauser } from "./usage-limit-detector.js";
import { isContextLimitError } from "./context-limit-detector.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { resolveAgentInstructions, buildSystemPromptWithInstructions } from "./agent-instructions.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createRunAuditor, generateSyntheticRunId, type EngineRunContext } from "./run-audit.js";

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

const VERIFICATION_COMMAND_MAX_BUFFER = 50 * 1024 * 1024;
const VERIFICATION_LOG_MAX_CHARS = 20_000;
const WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS = 4_000;

/** Maximum characters for commit log in merge prompt — prevents context overflow on large branches */
const MERGE_COMMIT_LOG_MAX_CHARS = 5000;

/** Maximum characters for diff stat in merge prompt — prevents context overflow on large diffs */
const MERGE_DIFF_STAT_MAX_CHARS = 3000;

/**
 * Truncate text to maxChars with ellipsis indicator.
 * Returns original text if under limit.
 */
function truncateWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

// Kept for potential future diagnostics use (may be helpful for detailed error analysis)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function truncateVerificationOutput(output: string): string {
  if (output.length <= VERIFICATION_LOG_MAX_CHARS) return output;
  return `... output truncated to last ${VERIFICATION_LOG_MAX_CHARS} characters ...\n${output.slice(-VERIFICATION_LOG_MAX_CHARS)}`;
}

/**
 * Summarize test/build verification failure output into a concise message.
 * Extracts test counts and failure names from common test runner formats,
 * falls back to truncated output for unstructured output.
 *
 * @param output - The raw command output to summarize
 * @param type - The verification type (reserved for future use; currently unused)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function summarizeVerificationOutput(output: string, type: "test" | "build"): string {
  const lines = output.split("\n");
  let summaryLine: string | null = null;
  const failureNames = new Set<string>();

  // 1. Extract summary line
  for (const line of lines) {
    // vitest/jest: "Tests: 2 failed, 48 passed, 50 total"
    const testsMatch = line.match(/^Tests:\s*(\d+)\s+failed,\s*(\d+)\s+passed(?:,\s*(\d+)\s+total)?/i);
    if (testsMatch) {
      const failed = testsMatch[1];
      const passed = testsMatch[2];
      const total = testsMatch[3] ? `, ${testsMatch[3]} total` : "";
      summaryLine = `Tests: ${failed} failed, ${passed} passed${total}`;
      break;
    }

    // Generic: "X tests failed, Y passed, Z total"
    const genericMatch = line.match(/^(\d+)\s+tests?\s+failed,\s*(\d+)\s+passed,\s*(\d+)\s+total/i);
    if (genericMatch) {
      summaryLine = `${genericMatch[1]} tests failed, ${genericMatch[2]} passed, ${genericMatch[3]} total`;
      break;
    }

    // Various runners: "X failing" / "X failures" / "X failed"
    const failCountMatch = line.match(/^(\d+)\s+(failings?|failures?|failed)/i);
    if (failCountMatch) {
      summaryLine = `${failCountMatch[1]} ${failCountMatch[2]}`;
      break;
    }
  }

  // 2. Extract failure names (up to 5 unique names)
  // Priority: markers (✗, ●, -) provide descriptive names, FAIL lines provide file context
  // Process markers first (they give actual test names), then FAIL lines (file context)
  const markerLines: string[] = [];
  const failLines: string[] = [];

  for (const line of lines) {
    // FAIL <file> — vitest file-level failure header (at start of line)
    const failMatch = line.match(/^(FAIL)\s+(.+)/);
    if (failMatch) {
      failLines.push(failMatch[2].trim());
      continue;
    }

    // Trim leading whitespace for marker detection (vitest indents failure details)
    const trimmedLine = line.trimStart();

    // Unicode cross markers: ✗ or ✕ or × (possibly indented)
    const crossMatch = trimmedLine.match(/^[✗✕×]\s*(.+)/);
    if (crossMatch) {
      markerLines.push(crossMatch[1].trim());
      continue;
    }

    // Jest failure bullet: ● (possibly indented)
    const bulletMatch = trimmedLine.match(/^●\s*(.+)/);
    if (bulletMatch) {
      markerLines.push(bulletMatch[1].trim());
      continue;
    }

    // Jest/Mocha indented test name: - MyTest › should do something (indented)
    const dashMatch = trimmedLine.match(/^-\s+(\S[\s\S]*?)$/);
    if (dashMatch) {
      const potential = dashMatch[1].trim();
      // Only include lines that look like test names (contain common test patterns)
      if (/[\s›>]|(should|cannot|does|doesn|to|not|throws)/i.test(potential)) {
        markerLines.push(potential);
      }
      continue;
    }

    // AssertionError — generic assertion failures (possibly indented)
    const assertionMatch = trimmedLine.match(/^(AssertionError|AssertionError:.*)$/i);
    if (assertionMatch) {
      markerLines.push(assertionMatch[1]);
    }
  }

  // Add marker names first (higher priority - they give actual test names)
  for (const name of markerLines) {
    const truncated = name.length > 120 ? name.slice(0, 120) : name;
    failureNames.add(truncated);
  }

  // Fill remaining slots with FAIL file names (lower priority - just file context)
  for (const name of failLines) {
    const truncated = name.length > 120 ? name.slice(0, 120) : name;
    failureNames.add(truncated);
  }

  // 3. Build the summary string
  const footer = "(full output available in engine logs)";
  const parts: string[] = [];

  if (summaryLine) {
    parts.push(summaryLine);
  }

  if (failureNames.size > 0) {
    const names = Array.from(failureNames);
    if (names.length <= 5) {
      for (const name of names) {
        parts.push(`  • ${name}`);
      }
    } else {
      // Show first 5 and note overflow
      for (let i = 0; i < 5; i++) {
        parts.push(`  • ${names[i]}`);
      }
      parts.push(`  • ... and ${names.length - 5} more failures`);
    }
  }

  if (parts.length > 0) {
    parts.push(footer);
    return parts.join("\n");
  }

  // 4. Fallback — no structured data found
  const trimmed = output.trim();
  if (!trimmed) {
    return `Verification command failed with no output\n${footer}`;
  }

  if (trimmed.length <= 500) {
    return `${trimmed}\n${footer}`;
  }

  // Truncate at last space or newline boundary
  let cutoff = 500;
  for (let i = 500; i < trimmed.length; i++) {
    if (trimmed[i] === " " || trimmed[i] === "\n") {
      cutoff = i;
      break;
    }
  }

  return `${trimmed.slice(0, cutoff)}...\n${footer}`;
}

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
    await execAsync(installCommand, {
      cwd: rootDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000,
    });
  } catch (error: any) {
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

/** Result of running a single verification command */
export interface VerificationCommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
}

/** Result of running all verification commands */
export interface VerificationResult {
  testResult?: VerificationCommandResult;
  buildResult?: VerificationCommandResult;
  allPassed: boolean;
  failedCommand?: string;
}

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

async function runDeterministicVerification(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  testCommand?: string,
  buildCommand?: string,
  testSource?: "explicit" | "inferred",
  buildSource?: "explicit" | "inferred",
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

  // Build source indicator for logging
  const testSourceLabel = testSource === "inferred" ? " [inferred]" : "";
  const buildSourceLabel = buildSource === "inferred" ? " [inferred]" : "";

  mergerLog.log(
    `${taskId}: running deterministic verification` +
    (hasTestCommand ? ` [test:${testSourceLabel} ${normalizedTestCommand}]` : "") +
    (hasBuildCommand ? ` [build:${buildSourceLabel} ${normalizedBuildCommand}]` : ""),
  );
  await store.logEntry(
    taskId,
    "Running deterministic merge verification" +
    (hasTestCommand ? ` (test${testSource === "inferred" ? " [inferred]" : ""}: ${normalizedTestCommand})` : "") +
    (hasBuildCommand ? ` (build${buildSource === "inferred" ? " [inferred]" : ""}: ${normalizedBuildCommand})` : ""),
  );

  // Run test command first if configured
  if (hasTestCommand) {
    const testResult = await runVerificationCommand(
      store, rootDir, taskId, normalizedTestCommand!, "test",
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
      throw new VerificationError(
        `Deterministic test verification failed for ${taskId}`,
        result,
      );
    }
  }

  // Run build command second if configured
  if (hasBuildCommand) {
    const buildResult = await runVerificationCommand(
      store, rootDir, taskId, normalizedBuildCommand!, "build",
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
      throw new VerificationError(
        `Deterministic build verification failed for ${taskId}`,
        result,
      );
    }
  }

  mergerLog.log(`${taskId}: deterministic verification passed`);
  await store.logEntry(taskId, "Deterministic merge verification passed");
  return result;
}

async function runVerificationCommand(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  command: string,
  type: "test" | "build",
): Promise<VerificationCommandResult> {
  mergerLog.log(`${taskId}: running ${type} command: ${command}`);
  await store.logEntry(taskId, `[verification] Running ${type} command: ${command}`);

  const result: VerificationCommandResult = {
    command,
    exitCode: null,
    stdout: "",
    stderr: "",
    success: false,
  };

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: rootDir,
      encoding: "utf-8",
      timeout: 300_000,
      maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
    });

    result.stdout = stdout?.toString?.() || "";
    result.stderr = stderr?.toString?.() || "";
    result.exitCode = 0;
    result.success = true;

    mergerLog.log(`${taskId}: ${type} command succeeded`);
    await store.logEntry(taskId, `[verification] ${type} command succeeded (exit 0)`);
    return result;
  } catch (error: any) {
    result.stdout = error?.stdout?.toString?.() || "";
    result.stderr = error?.stderr?.toString?.() || "";
    result.exitCode = typeof error?.status === "number"
      ? error.status
      : (typeof error?.code === "number" ? error.code : null);

    const maxBufferExceeded = error?.code === "ENOBUFS"
      || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      || String(error?.message ?? "").includes("maxBuffer");
    result.success = maxBufferExceeded && result.exitCode === 0;

    if (result.success) {
      mergerLog.log(`${taskId}: ${type} command succeeded (exit 0, output exceeded buffer)`);
      await store.logEntry(
        taskId,
        `[verification] ${type} command succeeded (exit 0, output exceeded buffer)`,
      );
      return result;
    }

    // Keep command output out of process logs. The bounded excerpt is stored on
    // the task for diagnostics without dumping test output to the engine stdout.
    const output = result.stderr || result.stdout || error?.message || "Unknown error";
    const summary = summarizeVerificationOutput(output, type);
    mergerLog.error(`${taskId}: ${type} command failed (exit ${result.exitCode}); output captured in task log`);
    await store.logEntry(
      taskId,
      `[verification] ${type} command failed (exit ${result.exitCode}):\n${summary}`,
    );
  }

  return result;
}

/**
 * Attempt an in-merge verification fix by spawning an AI agent on the main branch.
 * Returns true if verification passes after the fix, false otherwise.
 * Never throws — errors are caught and logged, and the function returns false.
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
  _testCommand?: string,
  _buildCommand?: string,
): Promise<boolean> {
  try {
    mergerLog.log(`${taskId}: spawning in-merge verification fix agent`);

    // Build skill selection context
    let skillContext = undefined;
    if (options.agentStore) {
      try {
        const task = await store.getTask(taskId);
        skillContext = await buildSessionSkillContext({
          agentStore: options.agentStore,
          task,
          sessionPurpose: "merger",
          projectRootDir: rootDir,
        });
      } catch {
        // Graceful fallback - no skill selection
      }
    }

    // Create the fix agent session
    const { session } = await createKbAgent({
      cwd: rootDir, // Runs on the main branch in the project root
      systemPrompt: `You are a verification fix agent running during a merge on the main branch.

A merge has been applied and the verification command failed. Your job is to fix the failing code directly in the working directory.

## Rules
1. Read the error output carefully to understand what's failing
2. Make targeted fixes to the failing code
3. After fixing, run the verification command to confirm the fix works
4. Do NOT make any git commits — just fix the code
5. Do NOT modify files unrelated to the failure
6. If you cannot fix the issue, explain why`,
      tools: "coding", // Agent needs read/write file access
      defaultProvider: settings.defaultProvider,
      defaultModelId: settings.defaultModelId,
      defaultThinkingLevel: settings.defaultThinkingLevel,
      // Skill selection: use assigned agent skills if available, otherwise role fallback
      ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    });

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
3. Run the verification command \`${failureContext.command}\` to confirm your fix works
4. If the fix doesn't work, try a different approach
5. Do NOT make any git commits`;

      // Run the agent with rate limit retry
      await withRateLimitRetry(async () => {
        await promptWithFallback(session, fixPrompt);
      }, {
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          mergerLog.warn(`⏳ ${taskId} in-merge fix rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
        },
      });

      // Re-run the verification command that failed
      const reRunResult = await runVerificationCommand(
        store, rootDir, taskId, failureContext.command, failureContext.type,
      );

      return reRunResult.success;
    } finally {
      // Always dispose the session
      await session.dispose();
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: in-merge fix agent error: ${errorMessage}`);
    await store.logEntry(taskId, "In-merge verification fix agent encountered an error", errorMessage);
    return false;
  }
}

/**
 * Stage any changes and amend the merge commit to include verification fixes.
 * Returns true if changes were amended, false if no changes to amend.
 * Never throws — errors are logged and the function returns false.
 */
async function amendMergeCommitWithFixes(
  rootDir: string,
  taskId: string,
  authorArg: string,
): Promise<boolean> {
  try {
    // Check for staged and unstaged changes
    const { stdout: stagedFiles } = await execAsync("git diff --cached --name-only", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const { stdout: unstagedFiles } = await execAsync("git diff --name-only", {
      cwd: rootDir,
      encoding: "utf-8",
    });

    const hasChanges = stagedFiles.trim().length > 0 || unstagedFiles.trim().length > 0;
    if (!hasChanges) {
      mergerLog.log(`${taskId}: no changes to amend after verification fix`);
      return false;
    }

    // Stage any unstaged changes
    if (unstagedFiles.trim().length > 0) {
      await execAsync("git add -A", { cwd: rootDir });
    }

    // Check if there are staged changes to amend
    const { stdout: finalStaged } = await execAsync("git diff --cached --name-only", {
      cwd: rootDir,
      encoding: "utf-8",
    });

    if (finalStaged.trim().length > 0) {
      await execAsync(`git commit --amend --no-edit${authorArg}`, { cwd: rootDir });
      mergerLog.log(`${taskId}: amended merge commit with verification fixes`);
      return true;
    }

    return false;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: failed to amend merge commit: ${errorMessage}`);
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
    await execAsync(`git checkout --ours "${filePath}"`, { cwd });
    await execAsync(`git add "${filePath}"`, { cwd });
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
    await execAsync(`git checkout --theirs "${filePath}"`, { cwd });
    await execAsync(`git add "${filePath}"`, { cwd });
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
    await execAsync(`git add "${filePath}"`, { cwd });
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
   - Call the \`report_build_failure\` tool with the real error details
   - Stop immediately and do not run \`git commit\`
   - Do not claim success in plain text

The merge will only be completed if the build passes or no build command is configured.`;
  }

  return `You are a merge agent for "fn", an AI-orchestrated task board.

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
    // Audit trail: record merge completion (FN-1404)
    await audit.database({ type: "task:move", target: taskId, metadata: { to: "done", merged: false } });
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
      await execAsync(`git checkout "${mainBranch}"`, {
        cwd: rootDir,
      });
      // Audit trail: record git checkout (FN-1404)
      await audit.git({ type: "branch:checkout", target: mainBranch });
    }
  } catch {
    // Fallback: try checking out main directly
    try {
      await execAsync("git checkout main", { cwd: rootDir });
      // Audit trail: record git checkout (FN-1404)
      await audit.git({ type: "branch:checkout", target: "main" });
    } catch {
      mergerLog.warn(`${taskId}: unable to verify/checkout main branch — proceeding on current HEAD`);
    }
  }

  // 4. Gather context for the agent (used in all attempts)
  let commitLog = "";
  let diffStat = "";
  try {
    const { stdout: logOutput } = await execAsync(`git log HEAD..${branch} --format="- %s"`, {
      cwd: rootDir,
      encoding: "utf-8",
    });
    commitLog = logOutput.trim();
  } catch {
    commitLog = "(unable to read commit log)";
  }
  try {
    const { stdout: mergeBaseOutput } = await execAsync(`git merge-base HEAD ${branch}`, {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const mergeBase = mergeBaseOutput.trim();
    const { stdout: diffOutput } = await execAsync(`git diff ${mergeBase}..${branch} --stat`, {
      cwd: rootDir,
      encoding: "utf-8",
    });
    diffStat = diffOutput.trim();
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
        settings,
        testCommand: effectiveTestCommand,
        buildCommand: effectiveBuildCommand,
        testSource: effectiveTestSource,
        buildSource: effectiveBuildSource,
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
          // Audit trail: record git reset for merge cleanup (FN-1404)
          await audit.git({ type: "reset:hard", target: branch, metadata: { purpose: "merge-cleanup", attempt: attemptNum } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          mergerLog.warn(`${taskId}: git reset --merge cleanup failed (merge-cleanup, attempt ${attemptNum}): ${msg}`);
        }
      }

      return false;
    } catch (error: any) {
      // Check if it's a deterministic verification failure (testCommand or buildCommand failed)
      // Try in-merge fix attempts before propagating
      if (error.name === "VerificationError") {
        const verificationErr = error as VerificationError;
        const maxFixRetries = Math.min(settings.verificationFixRetries ?? 1, 3);

        if (maxFixRetries > 0 && (verificationErr.verificationResult.testResult || verificationErr.verificationResult.buildResult)) {
          mergerLog.log(`${taskId}: deterministic verification failed — attempting in-merge fix (up to ${maxFixRetries} attempts)`);
          await store.logEntry(taskId, `Verification failed during merge — attempting in-merge fix (up to ${maxFixRetries} attempts)`);

          // Extract failure context from the VerificationError
          const failedResult = verificationErr.verificationResult.testResult?.success === false
            ? verificationErr.verificationResult.testResult
            : verificationErr.verificationResult.buildResult;
          const failedType = verificationErr.verificationResult.testResult?.success === false
            ? "test" as const
            : "build" as const;

          if (failedResult) {
            let fixSuccess = false;
            for (let fixAttempt = 1; fixAttempt <= maxFixRetries; fixAttempt++) {
              mergerLog.log(`${taskId}: in-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`);
              await store.logEntry(taskId, `In-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`);

              fixSuccess = await attemptInMergeVerificationFix(
                store, rootDir, taskId,
                {
                  command: failedResult.command,
                  exitCode: failedResult.exitCode,
                  output: summarizeVerificationOutput(failedResult.stderr || failedResult.stdout, failedType),
                  type: failedType,
                },
                settings, options, effectiveTestCommand, effectiveBuildCommand,
              );

              if (fixSuccess) {
                mergerLog.log(`${taskId}: in-merge verification fix succeeded on attempt ${fixAttempt}`);
                await store.logEntry(taskId, `In-merge verification fix succeeded — verification now passes`);
                break;
              }

              mergerLog.warn(`${taskId}: in-merge verification fix attempt ${fixAttempt} — verification still fails`);
              await store.logEntry(taskId, `In-merge verification fix attempt ${fixAttempt} — verification still fails`);
            }

            if (fixSuccess) {
              // Amend the merge commit to include the fixes
              const authorArg = getCommitAuthorArg(settings);
              await amendMergeCommitWithFixes(rootDir, taskId, authorArg);
              return true; // Merge succeeds
            }
          }
        }

        // Fix attempts exhausted or disabled — fall back to existing behavior
        mergerLog.error(`${taskId}: deterministic verification failed — aborting merge (in-merge fix exhausted or disabled)`);
        throw error;
      }

      // Check if it's a build verification failure
      if (error.message?.includes("Build verification failed")) {
        const maxFixRetries = Math.min(settings.verificationFixRetries ?? 1, 3);

        // Try in-merge fix before falling back to build retry
        if (maxFixRetries > 0 && (effectiveTestCommand || effectiveBuildCommand)) {
          mergerLog.log(`${taskId}: build verification failed — attempting in-merge fix`);
          await store.logEntry(taskId, `Build verification failed during merge — attempting in-merge fix`);

          const fixCommand = effectiveBuildCommand || effectiveTestCommand!;
          const fixType = effectiveBuildCommand ? "build" as const : "test" as const;

          let fixSuccess = false;
          for (let fixAttempt = 1; fixAttempt <= maxFixRetries; fixAttempt++) {
            mergerLog.log(`${taskId}: in-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`);
            await store.logEntry(taskId, `In-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`);

            fixSuccess = await attemptInMergeVerificationFix(
              store, rootDir, taskId,
              {
                command: fixCommand,
                exitCode: 1,
                output: error.message || "Build verification failed",
                type: fixType,
              },
              settings, options, effectiveTestCommand, effectiveBuildCommand,
            );

            if (fixSuccess) {
              mergerLog.log(`${taskId}: in-merge verification fix succeeded on attempt ${fixAttempt}`);
              await store.logEntry(taskId, `In-merge verification fix succeeded`);
              break;
            }
          }

          if (fixSuccess) {
            const authorArg = getCommitAuthorArg(settings);
            await amendMergeCommitWithFixes(rootDir, taskId, authorArg);
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
            mergerLog.warn(`${taskId}: git reset --merge cleanup failed (build-retry): ${msg}`);
          }
          return false; // Retry
        }
        throw error; // No retries left — fatal
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
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: git reset --merge cleanup failed: ${errorMessage}`);
    }
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
        await execAsync(`git worktree remove "${worktreePath}" --force`, {
          cwd: rootDir,
        });
        // Audit trail: record worktree removal (FN-1404)
        await audit.git({ type: "worktree:remove", target: worktreePath });
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
  settings: {
    commitAuthorEnabled?: boolean;
    commitAuthorName?: string;
    commitAuthorEmail?: string;
  };
  testCommand?: string;
  buildCommand?: string;
  /** Source of the test command: 'explicit' from settings or 'inferred' from project files */
  testSource?: "explicit" | "inferred";
  /** Source of the build command: 'explicit' from settings or 'inferred' (future use) */
  buildSource?: "explicit" | "inferred";
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
    settings,
    testCommand,
    buildCommand,
    testSource,
    buildSource,
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
        await execAsync(`git merge --squash "${branch}"`, {
          cwd: rootDir,
        });
      } catch {
        // Merge exits with code 1 when conflicts exist - this is expected
        mergeExitedWithConflicts = true;
      }

      // Use new API: get conflicted files and classify them
      const conflictedFiles = await getConflictedFiles(rootDir);
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
          const staged = execSync("git diff --cached --quiet 2>&1; echo $?", {
            cwd: rootDir,
            encoding: "utf-8",
          }).trim();

          if (staged !== "0") {
            const escapedLog = commitLog.replace(/"/g, '\\"');
            const fallbackPrefix = includeTaskId ? `feat(${taskId})` : "feat";
            const authorArg = getCommitAuthorArg(settings);
            await execAsync(
              `git commit -m "${fallbackPrefix}: merge ${branch}" -m "${escapedLog}"${authorArg}`,
              { cwd: rootDir },
            );
            mergerLog.log(`${taskId}: committed after auto-resolving all conflicts`);
          }
          // Run deterministic verification before completing the merge
          if (testCommand || buildCommand) {
            await runDeterministicVerification(store, rootDir, taskId, testCommand, buildCommand, testSource, buildSource);
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
          // Run deterministic verification (nothing staged but still verify)
          if (testCommand || buildCommand) {
            await runDeterministicVerification(store, rootDir, taskId, testCommand, buildCommand, testSource, buildSource);
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

      // Check if squash is empty
      const squashIsEmpty = execSync(
        "git diff --cached --quiet 2>&1; echo $?",
        { cwd: rootDir, encoding: "utf-8" },
      ).trim() === "0";

      if (squashIsEmpty) {
        mergerLog.log(`${taskId}: squash merge staged nothing — already merged`);
        // Run deterministic verification (nothing staged but still verify)
        if (testCommand || buildCommand) {
          await runDeterministicVerification(store, rootDir, taskId, testCommand, buildCommand, testSource, buildSource);
        }
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
      const stagedFiles = await getStagedFiles(rootDir);
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
      testCommand,
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        mergerLog.warn(`${taskId}: git reset --merge cleanup failed (build-verification reset): ${msg}`);
      }

      throw new Error(`Build verification failed for ${taskId}: ${errorMessage}`);
    }

    // Run deterministic verification after AI agent commits
    if (testCommand || buildCommand) {
      await runDeterministicVerification(store, rootDir, taskId, testCommand, buildCommand, testSource, buildSource);
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
  const { rootDir, branch, commitLog, includeTaskId, taskId, store, settings, testCommand, buildCommand, testSource, buildSource } = params;

  mergerLog.log(`${taskId}: attempting merge with -X theirs strategy`);

  try {
    // Use -X theirs to auto-resolve conflicts favoring the incoming branch
    await execAsync(`git merge -X theirs --squash "${branch}"`, {
      cwd: rootDir,
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
      // Run deterministic verification even when nothing is staged
      if (testCommand || buildCommand) {
        await runDeterministicVerification(store, rootDir, taskId, testCommand, buildCommand, testSource, buildSource);
      }
      return true;
    }

    // Commit with fallback message
    const escapedLog = commitLog.replace(/"/g, '\\"');
    const fallbackPrefix = includeTaskId ? `feat(${taskId})` : "feat";
    const authorArg = getCommitAuthorArg(settings);
    await execAsync(
      `git commit -m "${fallbackPrefix}: merge ${branch} (auto-resolved)" -m "${escapedLog}"${authorArg}`,
      { cwd: rootDir },
    );
    mergerLog.log(`${taskId}: committed with -X theirs auto-resolution`);

    // Run deterministic verification after committing
    if (testCommand || buildCommand) {
      await runDeterministicVerification(store, rootDir, taskId, testCommand, buildCommand, testSource, buildSource);
    }

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
  testCommand?: string;
  buildCommand?: string;
}

/**
 * Run the AI agent to resolve conflicts and/or write commit message.
 *
 * Each invocation creates a **fresh session** via `createKbAgent` to ensure
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
    includeTaskId,
    hasConflicts,
    simplifiedContext,
    options,
    testCommand,
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
  const authorArg = getCommitAuthorArg(settings);
  const mergerSystemPrompt = buildSystemPromptWithInstructions(
    buildMergeSystemPrompt(includeTaskId, settings.agentPrompts, authorArg),
    mergerInstructions,
  );

  // Build skill selection context (assigned agent skills take precedence over role fallback)
  let skillContext = undefined;
  if (options.agentStore) {
    try {
      const task = await store.getTask(taskId);
      skillContext = await buildSessionSkillContext({
        agentStore: options.agentStore,
        task,
        sessionPurpose: "merger",
        projectRootDir: rootDir,
      });
    } catch {
      // Graceful fallback - no skill selection
    }
  }

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
    // Skill selection: use assigned agent skills if available, otherwise role fallback
    ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
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
    });

    // Attempt prompting with fresh session (first attempt).
    // Log message distinguishes fresh-session start from compaction recovery path.
    mergerLog.log(`${taskId}: starting fresh merge agent session`);

    try {
      await withRateLimitRetry(async () => {
        await promptWithFallback(session, prompt);
        checkSessionError(session);
      }, {
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          mergerLog.warn(`⏳ ${taskId} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
        },
      });
    } catch (err: unknown) {
      // Context-limit error after promptWithFallback's auto-compaction already attempted recovery.
      // Try truncated prompt retry as second-level fallback.
      // This detects when the LLM rejects the prompt due to context-window overflow.
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (isContextLimitError(errorMessage)) {
        mergerLog.warn(`${taskId}: context limit hit after auto-compaction — retrying with minimal merge prompt`);
        await store.logEntry(taskId, "Context limit reached during merge after auto-compaction — retrying with reduced prompt");

        // Build minimal prompt: omit diff stat, use placeholder for commit log
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
        });

        try {
          await withRateLimitRetry(async () => {
            await promptWithFallback(session, truncatedPrompt);
            checkSessionError(session);
          }, {
            onRetry: (attempt, delayMs, error) => {
              const delaySec = Math.round(delayMs / 1000);
              mergerLog.warn(`⏳ ${taskId} rate limited during truncated retry — retry ${attempt} in ${delaySec}s: ${error.message}`);
            },
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
        const authorArg = getCommitAuthorArg(settings);
        await execAsync(
          `git commit -m "${fallbackPrefix}: merge ${branch}" -m "${escapedLog}"${authorArg}`,
          { cwd: rootDir },
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
  testCommand?: string;
  buildCommand?: string;
  authorArg?: string;
}

export function buildMergePrompt(params: MergePromptParams): string {
  const { taskId, branch, commitLog, diffStat, hasConflicts, simplifiedContext, testCommand, buildCommand, authorArg } = params;

  // Apply truncation to prevent context overflow for large branches/diffs
  const truncatedCommitLog = truncateWithEllipsis(commitLog, MERGE_COMMIT_LOG_MAX_CHARS);
  const truncatedDiffStat = truncateWithEllipsis(diffStat, MERGE_DIFF_STAT_MAX_CHARS);

  const parts = [
    `Finalize the merge of branch \`${branch}\` for task ${taskId}.`,
    "",
    "## Branch commits",
    "```",
    truncatedCommitLog,
    "```",
  ];

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
      "If it exits non-zero, call `report_build_failure` with the concrete error output and stop without committing.",
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
    await execAsync(scriptCommand, {
      cwd: rootDir,
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

    // Build skill selection context for post-merge session
    let postMergeSkillContext = undefined;
    if (mergeOptions.agentStore) {
      try {
        const task = await store.getTask(taskId);
        postMergeSkillContext = await buildSessionSkillContext({
          agentStore: mergeOptions.agentStore,
          task,
          sessionPurpose: "merger",
          projectRootDir: rootDir,
        });
      } catch {
        // Graceful fallback - no skill selection
      }
    }

    const { session } = await createKbAgent({
      cwd: rootDir,
      systemPrompt: postMergeSystemPrompt,
      tools: toolMode,
      defaultProvider: stepProvider,
      defaultModelId: stepModelId,
      fallbackProvider: settings.fallbackProvider,
      fallbackModelId: settings.fallbackModelId,
      defaultThinkingLevel: settings.defaultThinkingLevel,
      // Skill selection: use assigned agent skills if available, otherwise role fallback
      ...(postMergeSkillContext?.skillSelectionContext ? { skillSelection: postMergeSkillContext.skillSelectionContext } : {}),
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
