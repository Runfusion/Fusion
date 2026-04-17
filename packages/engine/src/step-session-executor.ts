/**
 * StepSessionExecutor — runs each task step in its own fresh agent session.
 *
 * This module enables per-step error recovery with retry semantics, optional
 * parallel execution for non-conflicting steps (via git worktree isolation),
 * and clean lifecycle management (pause, cleanup).
 *
 * The class is a standalone engine subsystem with minimal integration surface.
 * It receives TaskDetail (read-only), a TaskStore for agent logs, and emits
 * execution progress via callbacks.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { TaskDetail, Settings, TaskStore } from "@fusion/core";

import { createKbAgent, promptWithFallback, describeModel } from "./pi.js";
import type { SkillSelectionContext } from "./skill-resolver.js";
import { generateWorktreeName } from "./worktree-names.js";
import { AgentSemaphore } from "./concurrency.js";
import { StuckTaskDetector } from "./stuck-task-detector.js";
import { AgentLogger } from "./agent-logger.js";
import { createLogger } from "./logger.js";
import { isContextLimitError } from "./context-limit-detector.js";
import { checkSessionError } from "./usage-limit-detector.js";
import { createMemoryTools, createTaskDocumentWriteTool, createTaskDocumentReadTool } from "./agent-tools.js";

const stepExecLog = createLogger("step-session-executor");

// ── Exported Types ─────────────────────────────────────────────────────

/** Result of executing a single step. */
export interface StepResult {
  /** The 0-based step index. */
  stepIndex: number;
  /** Whether the step completed successfully. */
  success: boolean;
  /** Error message if the step failed (after all retries). */
  error?: string;
  /** Number of retry attempts made (0 = first attempt succeeded). */
  retries: number;
}

/** A group of step indices that can run in parallel. */
export interface ParallelWave {
  /** Step indices in this wave. */
  indices: number[];
  /** 0-based wave number (ascending). */
  waveNumber: number;
}

/** Options for creating a StepSessionExecutor. */
export interface StepSessionExecutorOptions {
  /** Optional task store used to persist agent logs for each step session. */
  store?: TaskStore;
  /** The task to execute (read-only). */
  taskDetail: TaskDetail;
  /** Path to the primary git worktree for this task. */
  worktreePath: string;
  /** Project root directory (parent of .worktrees/). */
  rootDir: string;
  /** Merged project settings. */
  settings: Settings;
  /** Optional concurrency semaphore. Parallel steps each acquire a slot. */
  semaphore?: AgentSemaphore;
  /** Optional stuck-task detector for session monitoring. */
  stuckTaskDetector?: StuckTaskDetector;
  /** Optional plugin runner for providing plugin tools to step sessions. */
  pluginRunner?: import("./plugin-runner.js").PluginRunner;
  /** Callback invoked when a step starts executing. */
  onStepStart?: (stepIndex: number) => void;
  /** Callback invoked when a step completes (success or failure). */
  onStepComplete?: (stepIndex: number, result: StepResult) => void;
  /** Optional skill selection context for session creation. */
  skillSelection?: SkillSelectionContext;
}

// ── File Scope Extraction ─────────────────────────────────────────────

/**
 * Parse a PROMPT.md string and extract file paths from each step's
 * `**Artifacts:**` section or `- \`path\`` list items under step headings.
 *
 * The function splits the prompt by step headings (`### Step N:` pattern),
 * then extracts backtick-wrapped paths from each step section. Path
 * normalization includes:
 * - Stripping trailing `(new)`, `(modified)`, `(new | modified)` suffixes
 * - Stripping trailing `/*` globs to the directory prefix
 * - Trimming whitespace
 *
 * Steps with no file scope entries get an empty array.
 *
 * @param prompt - The full PROMPT.md content.
 * @returns A Map keyed by 0-based step index with arrays of normalized file paths.
 */
export function parseStepFileScopes(prompt: string): Map<number, string[]> {
  const result = new Map<number, string[]>();

  if (!prompt) return result;

  // Split by step headings: ### Step 0: ..., ### Step 1: ..., etc.
  const stepRegex = /^### Step (\d+):.*/gm;
  const splits: { index: number; stepNum: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = stepRegex.exec(prompt)) !== null) {
    splits.push({ index: match.index, stepNum: parseInt(match[1], 10) });
  }

  if (splits.length === 0) return result;

  for (let i = 0; i < splits.length; i++) {
    const start = splits[i].index;
    const end = i + 1 < splits.length ? splits[i + 1].index : prompt.length;
    const section = prompt.slice(start, end);
    const stepNum = splits[i].stepNum;

    const paths = extractPathsFromSection(section);
    result.set(stepNum, paths);
  }

  return result;
}

/**
 * Extract backtick-wrapped file paths from a step section.
 *
 * Looks for lines matching `- \`path/to/file\`` patterns, including those
 * with optional parenthetical suffixes like `(new)`, `(modified)`, etc.
 */
function extractPathsFromSection(section: string): string[] {
  const paths: string[] = [];
  // Match backtick-wrapped paths in list items: - `path/to/file` (optional suffix)
  const pathRegex = /^- `([^`]+)`(?:\s*\([^)]*\))?\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = pathRegex.exec(section)) !== null) {
    const raw = match[1].trim();
    const normalized = normalizePath(raw);
    if (normalized) {
      paths.push(normalized);
    }
  }

  return paths;
}

/**
 * Normalize a file path extracted from a PROMPT.md:
 * - Strip trailing `/*` globs (keep directory prefix)
 * - Trim whitespace
 * - Remove trailing slashes
 */
function normalizePath(raw: string): string {
  let path = raw.trim();
  // Strip trailing /* glob patterns
  if (path.endsWith("/*")) {
    path = path.slice(0, -2);
  }
  // Remove trailing slash
  if (path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path;
}

// ── Conflict Detection ────────────────────────────────────────────────

/**
 * Build an N×N boolean conflict matrix from step file scopes.
 *
 * Two steps conflict if any path from step i is a prefix of (or equal to)
 * any path from step j, or vice versa. The diagonal is always `true`
 * (a step conflicts with itself). The matrix is symmetric.
 *
 * @param stepScopes - Map from step index to array of file paths.
 * @returns A 2D boolean matrix where `matrix[i][j]` is `true` if the steps conflict.
 */
export function buildConflictMatrix(stepScopes: Map<number, string[]>): boolean[][] {
  const indices = [...stepScopes.keys()].sort((a, b) => a - b);
  const n = indices.length;

  if (n === 0) return [];

  // Build index-to-position mapping
  const posMap = new Map<number, number>();
  indices.forEach((idx, pos) => posMap.set(idx, pos));

  const matrix: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));

  // Set diagonal to true
  for (let i = 0; i < n; i++) {
    matrix[i][i] = true;
  }

  // Check pairwise conflicts
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pathsI = stepScopes.get(indices[i]) ?? [];
      const pathsJ = stepScopes.get(indices[j]) ?? [];

      const conflicts = pathsOverlap(pathsI, pathsJ);
      matrix[i][j] = conflicts;
      matrix[j][i] = conflicts;
    }
  }

  return matrix;
}

/**
 * Check if any path in `a` overlaps with any path in `b`.
 * Two paths overlap if one is a prefix of the other.
 */
function pathsOverlap(a: string[], b: string[]): boolean {
  for (const pa of a) {
    for (const pb of b) {
      if (pa.startsWith(pb) || pb.startsWith(pa)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Group non-conflicting steps into parallel execution waves.
 *
 * Uses a greedy left-to-right scan: for each wave, add steps that don't
 * conflict with any step already in the wave. Each wave's `indices` array
 * is capped at `maxParallel`. Remaining steps spill into subsequent waves.
 *
 * @param stepScopes - Map from step index to array of file paths.
 * @param maxParallel - Maximum number of steps per wave (range 1–4).
 * @returns Array of {@link ParallelWave} objects with ascending wave numbers.
 */
export function determineParallelWaves(
  stepScopes: Map<number, string[]>,
  maxParallel: number,
): ParallelWave[] {
  const indices = [...stepScopes.keys()].sort((a, b) => a - b);
  if (indices.length === 0) return [];

  const clampedMax = Math.max(1, Math.min(4, maxParallel));
  const matrix = buildConflictMatrix(stepScopes);
  const posMap = new Map<number, number>();
  indices.forEach((idx, pos) => posMap.set(idx, pos));

  const assigned = new Set<number>();
  const waves: ParallelWave[] = [];
  let waveNumber = 0;

  while (assigned.size < indices.length) {
    const waveIndices: number[] = [];

    for (const idx of indices) {
      if (assigned.has(idx)) continue;
      if (waveIndices.length >= clampedMax) break;

      const pos = posMap.get(idx)!;

      // Check if this step conflicts with any step already in this wave
      const conflictsWithWave = waveIndices.some((existingIdx) => {
        const existingPos = posMap.get(existingIdx)!;
        return matrix[pos][existingPos];
      });

      if (!conflictsWithWave) {
        waveIndices.push(idx);
      }
    }

    if (waveIndices.length === 0) {
      // Safety: if no steps could be added (shouldn't happen with diagonal=true),
      // force-add the next unassigned step
      const next = indices.find((idx) => !assigned.has(idx));
      if (next !== undefined) {
        waveIndices.push(next);
      } else {
        break;
      }
    }

    for (const idx of waveIndices) {
      assigned.add(idx);
    }

    waves.push({ indices: waveIndices, waveNumber });
    waveNumber++;
  }

  return waves;
}

// ── Step Prompt Builder ───────────────────────────────────────────────

/**
 * Build a focused prompt for executing a single step.
 *
 * Extracts the relevant section from the task's PROMPT.md, includes global
 * sections (File Scope, Do NOT, Dependencies, etc.), and wraps it with
 * step-specific instructions.
 *
 * @param taskDetail - The task to build a prompt for.
 * @param stepIndex - The 0-based step index.
 * @param rootDir - Optional project root for attachment path resolution.
 * @param settings - Optional settings for project command injection.
 * @returns A complete prompt string for the step's agent session.
 */
export function buildStepPrompt(
  taskDetail: TaskDetail,
  stepIndex: number,
  rootDir?: string,
  settings?: Settings,
  worktreePath?: string,
): string {
  const { id, title, attachments } = taskDetail;
  const prompt = scopePromptToWorktree(taskDetail.prompt, rootDir, worktreePath);

  // Extract step-specific section
  const stepSection = extractStepSection(prompt, stepIndex);
  const totalSteps = countSteps(prompt);
  const isLastStep = stepIndex === totalSteps - 1;

  // Extract global sections from the prompt
  const fileScopeSection = extractSection(prompt, "File Scope");
  const doNotSection = extractSection(prompt, "Do NOT");
  const contextSection = extractSection(prompt, "Context to Read First");
  const depsSection = extractSection(prompt, "Dependencies");
  const completionSection = extractSection(prompt, "Completion Criteria");
  const gitSection = extractSection(prompt, "Git Commit Convention");

  // Build project commands section
  let commandsSection = "";
  if (settings?.testCommand || settings?.buildCommand) {
    const lines = ["## Project Commands", ""];
    if (settings.testCommand) lines.push(`- **Test:** \`${settings.testCommand}\``);
    if (settings.buildCommand) lines.push(`- **Build:** \`${settings.buildCommand}\``);
    commandsSection = lines.join("\n") + "\n\n";
  }

  // Build attachments section
  let attachmentsSection = "";
  if (attachments && attachments.length > 0 && rootDir) {
    const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    const lines = ["## Attachments", ""];
    for (const att of attachments) {
      const absPath = `${rootDir}/.fusion/tasks/${id}/attachments/${att.filename}`;
      if (IMAGE_MIMES.has(att.mimeType)) {
        lines.push(`- **${att.originalName}** (screenshot): \`${absPath}\``);
      } else {
        lines.push(`- **${att.originalName}** (${att.mimeType}): \`${absPath}\` — read for context`);
      }
    }
    attachmentsSection = "\n" + lines.join("\n") + "\n";
  }

  // Assemble the prompt
  const parts: string[] = [
    `You are executing Step ${stepIndex} of task ${id}. Focus ONLY on this step. Previous steps have been completed.`,
    "",
    `## Task: ${id}`,
    title ? `**${title}**` : "",
    "",
  ];

  if (depsSection) {
    parts.push(depsSection, "");
  }

  if (contextSection) {
    parts.push(contextSection, "");
  }

  if (fileScopeSection) {
    parts.push(fileScopeSection, "");
  }

  parts.push("## Step Content", "");
  parts.push(stepSection);
  parts.push("");

  if (doNotSection) {
    parts.push(doNotSection, "");
  }

  parts.push(commandsSection);

  if (attachmentsSection) {
    parts.push(attachmentsSection);
  }

  if (isLastStep && completionSection) {
    parts.push(completionSection, "");
  }

  if (gitSection) {
    parts.push(gitSection, "");
  }

  // Add document save guidance for the last step (delivery step)
  if (isLastStep) {
    parts.push(
      "",
      "**Document your deliverables:** When this task produces written output (documentation, specifications, reports, API references, README updates, guides, or any other content), save that content as a task document using `task_document_write(key='...', content='...')`. Use a key that describes the deliverable (e.g., key=\"readme\", key=\"api-docs\"). The document persists in the task for review even after the worktree is cleaned up.",
      "",
    );
  }

  parts.push("After completing this step, commit your changes and call task_done(). Do NOT proceed to subsequent steps.");

  return parts.join("\n");
}

function scopePromptToWorktree(prompt: string, rootDir?: string, worktreePath?: string): string {
  if (!rootDir || !worktreePath || rootDir === worktreePath || !prompt.includes(rootDir)) {
    return prompt;
  }

  return prompt
    .replaceAll(`${rootDir}/`, `${worktreePath}/`)
    .replaceAll(`${worktreePath}/.fusion/`, `${rootDir}/.fusion/`);
}

/**
 * Extract the content of a specific step from the PROMPT.md.
 */
function extractStepSection(prompt: string, stepIndex: number): string {
  const stepRegex = /^### Step (\d+):.*/gm;
  const splits: { index: number; stepNum: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = stepRegex.exec(prompt)) !== null) {
    splits.push({ index: match.index, stepNum: parseInt(match[1], 10) });
  }

  const targetSplit = splits.find((s) => s.stepNum === stepIndex);
  if (!targetSplit) return "";

  const splitPos = splits.indexOf(targetSplit);
  const start = targetSplit.index;
  const end = splitPos + 1 < splits.length ? splits[splitPos + 1].index : prompt.length;

  return prompt.slice(start, end).trim();
}

/**
 * Count the number of step headings in a PROMPT.md.
 */
function countSteps(prompt: string): number {
  const stepRegex = /^### Step \d+:/gm;
  const matches = prompt.match(stepRegex);
  return matches ? matches.length : 0;
}

/**
 * Extract a named section from the prompt (e.g. "File Scope", "Do NOT").
 * Returns the section from the heading to the next ## or ### heading, or end.
 */
function extractSection(prompt: string, sectionName: string): string {
  // Match ## Section Name or **Section Name** as a heading
  const regex = new RegExp(`^## ${escapeRegex(sectionName)}\\s*$`, "m");
  const match = regex.exec(prompt);
  if (!match) return "";

  const start = match.index;
  // Find next ## heading after this one
  const afterStart = start + match[0].length;
  const nextHeading = prompt.indexOf("\n## ", afterStart);
  const end = nextHeading === -1 ? prompt.length : nextHeading;

  return prompt.slice(start, end).trim();
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a reduced prompt for context-limit recovery.
 *
 * This is a simpler, shorter prompt that doesn't include the full task context,
 * designed to fit within context limits when the original prompt is too large.
 *
 * @param taskDetail - The task to build a prompt for.
 * @param stepIndex - The 0-based step index.
 * @returns A reduced prompt string focused on the current step only.
 */
function buildReducedStepPrompt(taskDetail: TaskDetail, stepIndex: number): string {
  const { prompt, id, title } = taskDetail;

  // Extract the step-specific section
  const stepSection = extractStepSection(prompt, stepIndex);

  // Build a minimal prompt that focuses on the step without excessive context
  const parts: string[] = [
    `You are executing step ${stepIndex} of task ${id}.`,
    title ? `Task: ${title}` : "",
    "",
    "Focus on completing this step efficiently:",
    "",
    stepSection,
    "",
    "IMPORTANT: Your previous attempt hit the context window limit.",
    "Do NOT repeat work that's already been done.",
    "Check git status and git log to see what's been committed.",
    "Complete the remaining work and call task_done().",
  ];

  return parts.join("\n").replace(/\n{3,}/g, "\n\n"); // Collapse multiple blank lines
}

// ── StepSessionExecutor ───────────────────────────────────────────────

/** Maximum retry attempts for a failed step. */
const MAX_STEP_RETRIES = 3;

/** Retry delays in milliseconds (exponential backoff). */
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

/** A minimal session handle stored for termination support. */
interface SessionHandle {
  dispose: () => void;
}

/** Fallback store used when step logging persistence is not configured. */
const NOOP_TASK_STORE: Pick<TaskStore, "appendAgentLog"> = {
  appendAgentLog: async () => undefined,
};

/**
 * StepSessionExecutor — runs each task step in its own fresh agent session.
 *
 * This class orchestrates per-step agent sessions with:
 * - **Sequential execution** (default): steps run one at a time
 * - **Parallel execution**: non-conflicting steps run simultaneously in
 *   separate git worktrees (when `maxParallelSteps > 1`)
 * - **Per-step retry**: failed steps retry up to 3 times with exponential backoff
 * - **Clean lifecycle**: pause via `terminateAllSessions()`, cleanup via `cleanup()`
 *
 * The class is a standalone engine subsystem.
 * It receives `TaskDetail` (read-only) and an optional `TaskStore` in its options,
 * then emits results via callbacks (`onStepStart`, `onStepComplete`).
 * The integration layer (FN-1040) is responsible for persisting step status updates.
 *
 * @example
 * ```ts
 * const executor = new StepSessionExecutor({
 *   taskDetail,
 *   worktreePath: "/project/.worktrees/swift-falcon",
 *   rootDir: "/project",
 *   settings,
 *   semaphore,
 *   stuckTaskDetector,
 *   onStepStart: (idx) => console.log(`Step ${idx} starting`),
 *   onStepComplete: (idx, result) => console.log(`Step ${idx}: ${result.success}`),
 * });
 * try {
 *   const results = await executor.executeAll();
 * } finally {
 *   await executor.cleanup();
 * }
 * ```
 */
export class StepSessionExecutor {
  private options: StepSessionExecutorOptions;
  private store: TaskStore;
  private activeSessions: Map<number, SessionHandle> = new Map();
  private parallelWorktrees: Map<number, string> = new Map();
  private parallelBranches: Map<number, string> = new Map();
  private stepResults: StepResult[] = [];
  private aborted = false;
  private maxParallel: number;

  constructor(options: StepSessionExecutorOptions) {
    this.options = options;
    this.store = options.store ?? (NOOP_TASK_STORE as TaskStore);
    // Clamp maxParallelSteps to 1–4 range
    this.maxParallel = Math.max(1, Math.min(4, options.settings.maxParallelSteps ?? 2));
  }

  /**
   * Execute all steps in the task, respecting conflict-based parallel waves.
   *
   * Parses file scopes from the task's PROMPT.md, builds a conflict matrix,
   * determines parallel waves, and executes them sequentially (with steps
   * within each wave potentially running in parallel).
   *
   * @returns Array of {@link StepResult} for all steps, in step-index order.
   */
  async executeAll(): Promise<StepResult[]> {
    const { taskDetail } = this.options;
    const prompt = taskDetail.prompt ?? "";

    // Parse file scopes and determine execution plan
    const stepScopes = parseStepFileScopes(prompt);

    // Add all step indices that don't appear in the prompt's step sections
    // (e.g. if steps are defined in taskDetail.steps but not in the prompt)
    const stepCount = taskDetail.steps?.length ?? 0;
    for (let i = 0; i < stepCount; i++) {
      if (!stepScopes.has(i)) {
        stepScopes.set(i, []);
      }
    }

    const waves = determineParallelWaves(stepScopes, this.maxParallel);

    stepExecLog.log(
      `Executing ${stepCount} steps in ${waves.length} wave(s) for task ${taskDetail.id} ` +
      `(maxParallel=${this.maxParallel})`,
    );

    // Execute waves sequentially
    for (const wave of waves) {
      if (this.aborted) break;

      if (wave.indices.length === 1) {
        // Single step — use primary worktree
        const stepIdx = wave.indices[0]!;
        const result = await this.executeStep(stepIdx, this.options.worktreePath);
        this.stepResults.push(result);
      } else {
        // Multiple steps — parallel wave
        const waveResults = await this.executeParallelWave(wave);
        this.stepResults.push(...waveResults);
      }
    }

    // Sort results by step index for deterministic output
    return this.stepResults.sort((a, b) => a.stepIndex - b.stepIndex);
  }

  /**
   * Terminate all active agent sessions and set the aborted flag.
   *
   * Call this to pause execution (e.g., when the task is paused externally).
   * After calling this method, any in-progress or future `executeStep()` calls
   * will return a failed result immediately.
   */
  async terminateAllSessions(): Promise<void> {
    this.aborted = true;
    stepExecLog.log(
      `Terminating ${this.activeSessions.size} active session(s) for task ${this.options.taskDetail.id}`,
    );

    for (const [stepIdx, handle] of this.activeSessions) {
      try {
        handle.dispose();
      } catch (err) {
        stepExecLog.warn(`Failed to dispose session for step ${stepIdx}: ${err}`);
      }

      // Unregister from stuck-task detector
      const trackingKey = this.makeTrackingKey(stepIdx);
      this.options.stuckTaskDetector?.untrackTask(trackingKey);
    }

    this.activeSessions.clear();
  }

  /**
   * Clean up all resources: terminate sessions, remove parallel worktrees and branches.
   *
   * Safe to call multiple times (idempotent). Call this in a `finally` block
   * after `executeAll()`.
   */
  async cleanup(): Promise<void> {
    // Terminate any remaining sessions
    if (this.activeSessions.size > 0) {
      await this.terminateAllSessions();
    }

    // Remove parallel worktrees
    for (const [stepIdx, worktreePath] of this.parallelWorktrees) {
      try {
        if (existsSync(worktreePath)) {
          await execAsync(`git worktree remove "${worktreePath}" --force`, {
            cwd: this.options.rootDir,
          });
        } else {
          stepExecLog.warn(`Parallel worktree for step ${stepIdx} already removed: ${worktreePath}`);
        }
      } catch (err) {
        stepExecLog.warn(`Failed to remove worktree for step ${stepIdx}: ${err}`);
      }
    }

    // Delete branches created for parallel worktrees
    for (const [stepIdx, branchName] of this.parallelBranches) {
      try {
        await execAsync(`git branch -D "${branchName}"`, {
          cwd: this.options.rootDir,
        });
      } catch (err) {
        stepExecLog.warn(`Failed to delete branch ${branchName} for step ${stepIdx}: ${err}`);
      }
    }

    this.parallelWorktrees.clear();
    this.parallelBranches.clear();

    stepExecLog.log(`Cleanup complete for task ${this.options.taskDetail.id}`);
  }

  // ── Internal: Step Execution ────────────────────────────────────────

  /**
   * Execute a single step in its own agent session.
   *
   * Creates a fresh session, sends the step-specific prompt, and handles
   * retries with exponential backoff on failure.
   *
   * Context-limit errors trigger bounded recovery before consuming a retry attempt:
   * 1. Compact-and-resume: compact session history, retry with original prompt
   * 2. Reduced-prompt retry: if compact unavailable/failed, retry with simpler prompt
   * Recovery attempts do NOT count toward MAX_STEP_RETRIES to prevent premature failure.
   */
  private async executeStep(stepIndex: number, worktreePath: string): Promise<StepResult> {
    const { taskDetail, settings, stuckTaskDetector, semaphore } = this.options;

    // Check aborted flag
    if (this.aborted) {
      return { stepIndex, success: false, error: "Execution aborted", retries: 0 };
    }

    // Notify caller that this step is starting
    this.options.onStepStart?.(stepIndex);

    // Build step prompt
    const stepPrompt = buildStepPrompt(taskDetail, stepIndex, this.options.rootDir, settings, worktreePath);

    // Build reduced step prompt for context-limit recovery (simpler, shorter)
    const reducedStepPrompt = buildReducedStepPrompt(taskDetail, stepIndex);

    // Acquire semaphore if provided
    if (semaphore) {
      await semaphore.acquire();
    }

    const trackingKey = this.makeTrackingKey(stepIndex);
    let retries = 0;
    // Track context-limit recovery attempts separately from retry attempts.
    // Recovery does NOT count toward MAX_STEP_RETRIES to prevent premature failure.
    let recoveryAttempts = 0;

    try {
      for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
        if (this.aborted) {
          return { stepIndex, success: false, error: "Execution aborted", retries };
        }

        if (attempt > 0) {
          retries++;
          const delay = RETRY_DELAYS_MS[attempt - 1] ?? 15_000;
          stepExecLog.log(
            `Step ${stepIndex} retry ${attempt}/${MAX_STEP_RETRIES} ` +
            `(delay=${delay}ms) for task ${taskDetail.id}`,
          );
          await sleep(delay);
        }

        const agentLogger = new AgentLogger({
          store: this.store,
          taskId: taskDetail.id,
          agent: "executor",
        });
        let session: AgentSession | null = null;

        try {
          // Get plugin tools from plugin runner if available
          const pluginTools = this.options.pluginRunner?.getPluginTools() ?? [];

          // Get document tools from task store if available
          const documentTools = this.options.store
            ? [
                createTaskDocumentWriteTool(this.options.store, taskDetail.id),
                createTaskDocumentReadTool(this.options.store, taskDetail.id),
              ]
            : [];
          const memoryTools = createMemoryTools(this.options.rootDir, settings);

          // Create fresh agent session for this attempt
          // Resolve executor model using canonical lane hierarchy:
          // 1. Task override pair (taskDetail.modelProvider + taskDetail.modelId)
          // 2. Project execution override pair (settings.executionProvider + settings.executionModelId)
          // 3. Global execution lane pair (settings.executionGlobalProvider + settings.executionGlobalModelId)
          // 4. Default pair (settings.defaultProvider + settings.defaultModelId)
          const executorProvider = taskDetail.modelProvider && taskDetail.modelId
            ? taskDetail.modelProvider
            : (settings.executionProvider && settings.executionModelId
                ? settings.executionProvider
                : (settings.executionGlobalProvider && settings.executionGlobalModelId
                    ? settings.executionGlobalProvider
                    : settings.defaultProvider));
          const executorModelId = taskDetail.modelProvider && taskDetail.modelId
            ? taskDetail.modelId
            : (settings.executionProvider && settings.executionModelId
                ? settings.executionModelId
                : (settings.executionGlobalProvider && settings.executionGlobalModelId
                    ? settings.executionGlobalModelId
                    : settings.defaultModelId));

          const createResult = await createKbAgent({
            cwd: worktreePath,
            systemPrompt: `You are an AI agent executing step ${stepIndex} of task ${taskDetail.id}. Follow instructions precisely.`,
            defaultProvider: executorProvider,
            defaultModelId: executorModelId,
            fallbackProvider: settings.fallbackProvider,
            fallbackModelId: settings.fallbackModelId,
            defaultThinkingLevel: taskDetail.thinkingLevel ?? settings.defaultThinkingLevel,
            customTools: [...pluginTools, ...documentTools, ...memoryTools],
            onText: (delta) => {
              agentLogger.onText(delta);
              stuckTaskDetector?.recordActivity(trackingKey);
            },
            onThinking: (delta) => {
              agentLogger.onThinking(delta);
            },
            onToolStart: (name, args) => {
              agentLogger.onToolStart(name, args);
              stuckTaskDetector?.recordActivity(trackingKey);
            },
            onToolEnd: (name, isError, result) => {
              agentLogger.onToolEnd(name, isError, result);
              stuckTaskDetector?.recordActivity(trackingKey);
            },
            // Skill selection from step-session executor options
            ...(this.options.skillSelection ? { skillSelection: this.options.skillSelection } : {}),
          });
          session = createResult.session;

          // Track session for termination and stuck-task detection.
          // Pass the canonical task ID (e.g. "FN-1452") as the third argument so
          // that stuck-kill callbacks (beforeRequeue, onStuck) operate on the real
          // task rather than the compound step key ("FN-1452-step-1").
          const handle: SessionHandle = { dispose: () => session?.dispose() };
          this.activeSessions.set(stepIndex, handle);
          stuckTaskDetector?.trackTask(trackingKey, { dispose: () => session?.dispose() }, taskDetail.id);

          stepExecLog.log(
            `Step ${stepIndex} attempt ${attempt + 1} session created ` +
            `(model=${describeModel(session)}) for task ${taskDetail.id}`,
          );

          // Send prompt
          await promptWithFallback(session, stepPrompt);

          // Re-raise errors that pi-coding-agent swallowed after exhausting retries.
          // session.prompt() resolves normally even when retries are exhausted —
          // the error is stored on session.state.error instead of being thrown.
          checkSessionError(session);

          const result: StepResult = { stepIndex, success: true, retries };
          this.options.onStepComplete?.(stepIndex, result);
          return result;
        } catch (err: unknown) {
          // Normalize error message for consistent classification
          const errorMessage = typeof err === "string" ? err : (err as { message?: string })?.message ?? String(err);
          stepExecLog.warn(
            `Step ${stepIndex} attempt ${attempt + 1} failed: ${errorMessage}`,
          );

          // Context-limit error after promptWithFallback's auto-compaction already attempted recovery.
          // Try reduced-prompt retry as second-level fallback.
          // Recovery is bounded to prevent infinite loops (MAX_STEP_RETRIES recovery)
          if (isContextLimitError(errorMessage) && recoveryAttempts < MAX_STEP_RETRIES && session) {
            stepExecLog.log(
              `Step ${stepIndex} context limit error after auto-compaction — attempting reduced-prompt retry ` +
              `(recoveryAttempt=${recoveryAttempts + 1}/${MAX_STEP_RETRIES})`,
            );
            await this.store.appendAgentLog(
              taskDetail.id,
              `[step-exec] Context limit error after auto-compaction on step ${stepIndex}: ${errorMessage}`,
              "tool_error",
            );

            recoveryAttempts++;
            try {
              stuckTaskDetector?.recordActivity(trackingKey);
              await promptWithFallback(session, reducedStepPrompt);
              checkSessionError(session);
              stepExecLog.log(`Step ${stepIndex} reduced-prompt recovery succeeded`);
              await this.store.appendAgentLog(
                taskDetail.id,
                `[step-exec] Reduced-prompt recovery succeeded for step ${stepIndex}`,
                "text",
              );
              const result: StepResult = { stepIndex, success: true, retries };
              this.options.onStepComplete?.(stepIndex, result);
              return result;
            } catch (reducedErr: unknown) {
              const reducedErrorMessage = typeof reducedErr === "string"
                ? reducedErr
                : (reducedErr as { message?: string })?.message ?? String(reducedErr);
              stepExecLog.warn(
                `Step ${stepIndex} reduced-prompt retry also failed: ${reducedErrorMessage}`,
              );
              await this.store.appendAgentLog(
                taskDetail.id,
                `[step-exec] Reduced-prompt recovery failed for step ${stepIndex}: ${reducedErrorMessage}`,
                "tool_error",
              );
              // Fall through to normal retry or failure
            }
          }

          // If this was the last attempt, return failure
          if (attempt === MAX_STEP_RETRIES) {
            const result: StepResult = {
              stepIndex,
              success: false,
              error: errorMessage,
              retries,
            };
            this.options.onStepComplete?.(stepIndex, result);
            return result;
          }
        } finally {
          try {
            await agentLogger.flush();
          } catch (err) {
            const flushError = err instanceof Error ? err.message : String(err);
            stepExecLog.warn(`Failed to flush agent logs for step ${stepIndex}: ${flushError}`);
          }

          this.activeSessions.delete(stepIndex);
          stuckTaskDetector?.untrackTask(trackingKey);
          try {
            session?.dispose();
          } catch {
            /* best-effort */
          }
        }
      }

      // Should not reach here, but safety fallback
      return { stepIndex, success: false, error: "Max retries exceeded", retries };
    } finally {
      // Release semaphore
      semaphore?.release();
    }
  }

  // ── Internal: Parallel Wave Execution ───────────────────────────────

  /**
   * Execute a wave of steps in parallel, each in its own git worktree.
   *
   * After all steps complete, successful steps' commits are cherry-picked
   * into the primary worktree. Parallel worktrees are cleaned up afterwards.
   */
  private async executeParallelWave(wave: ParallelWave): Promise<StepResult[]> {
    const { taskDetail } = this.options;

    stepExecLog.log(
      `Wave ${wave.waveNumber}: executing steps [${wave.indices.join(", ")}] in parallel ` +
      `for task ${taskDetail.id}`,
    );

    // Create worktrees for each step in the wave
    const worktreePaths = new Map<number, string>();
    const failedWorktreeSteps = new Set<number>();
    for (const stepIdx of wave.indices) {
      try {
        const path = await this.createStepWorktree(stepIdx);
        worktreePaths.set(stepIdx, path);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        stepExecLog.error(
          `Failed to create worktree for step ${stepIdx}: ${errorMessage}. ` +
          `Step will be deferred to sequential fallback on primary worktree.`,
        );
        failedWorktreeSteps.add(stepIdx);
      }
    }

    const sequentialFallbackSteps = [...failedWorktreeSteps].sort((a, b) => a - b);
    const parallelSteps = wave.indices.filter((stepIdx) => !failedWorktreeSteps.has(stepIdx));

    if (sequentialFallbackSteps.length > 0) {
      stepExecLog.warn(
        `Wave ${wave.waveNumber}: worktree creation failed for step(s) ` +
        `[${sequentialFallbackSteps.join(", ")}]; degrading those step(s) to sequential ` +
        `execution on primary worktree for task ${taskDetail.id}`,
      );
    }

    // Phase 1: Execute successful-worktree steps in parallel.
    const parallelResults: StepResult[] = [];
    if (parallelSteps.length > 0) {
      const promises = parallelSteps.map((stepIdx) => {
        const path = worktreePaths.get(stepIdx) ?? this.options.worktreePath;
        return this.executeStep(stepIdx, path);
      });

      const settled = await Promise.allSettled(promises);
      parallelResults.push(...settled.map((outcome, i) => {
        if (outcome.status === "fulfilled") {
          return outcome.value;
        }
        // Promise rejected (unexpected — should be caught inside executeStep)
        const stepIdx = parallelSteps[i]!;
        return {
          stepIndex: stepIdx,
          success: false,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          retries: 0,
        };
      }));
    }

    // Phase 2: Execute failed-worktree steps sequentially on primary worktree.
    const sequentialResults: StepResult[] = [];
    for (const stepIdx of sequentialFallbackSteps) {
      stepExecLog.warn(
        `Wave ${wave.waveNumber}: executing step ${stepIdx} sequentially on primary worktree ` +
        `after worktree creation failure for task ${taskDetail.id}`,
      );
      const result = await this.executeStep(stepIdx, this.options.worktreePath);
      sequentialResults.push(result);
    }

    const results = [...parallelResults, ...sequentialResults];

    // Cherry-pick successful steps into primary worktree
    for (const stepIdx of parallelSteps) {
      const result = results.find((r) => r.stepIndex === stepIdx);
      const worktreePath = worktreePaths.get(stepIdx);

      if (result?.success && worktreePath && worktreePath !== this.options.worktreePath) {
        try {
          await this.cherryPickCommits(stepIdx, worktreePath);
        } catch (err) {
          // Cherry-pick failure is non-fatal — log but don't fail the step
          const msg = err instanceof Error ? err.message : String(err);
          stepExecLog.warn(
            `Cherry-pick failed for step ${stepIdx} in task ${taskDetail.id}: ${msg}`,
          );
        }
      }
    }

    // Clean up parallel worktrees for this wave
    for (const [stepIdx, worktreePath] of worktreePaths) {
      if (worktreePath !== this.options.worktreePath) {
        try {
          if (existsSync(worktreePath)) {
            await execAsync(`git worktree remove "${worktreePath}" --force`, {
              cwd: this.options.rootDir,
            });
          }
          const branch = this.parallelBranches.get(stepIdx);
          if (branch) {
            await execAsync(`git branch -D "${branch}"`, {
              cwd: this.options.rootDir,
            });
          }
        } catch (err) {
          stepExecLog.warn(`Failed to clean up worktree for step ${stepIdx}: ${err}`);
        } finally {
          this.parallelWorktrees.delete(stepIdx);
          this.parallelBranches.delete(stepIdx);
        }
      }
    }

    return results.sort((a, b) => a.stepIndex - b.stepIndex);
  }

  // ── Internal: Worktree Management ───────────────────────────────────

  /**
   * Create a separate git worktree for a parallel step.
   *
   * @returns The path to the new worktree.
   */
  private async createStepWorktree(stepIndex: number): Promise<string> {
    const { rootDir } = this.options;
    const name = generateWorktreeName(rootDir);
    const worktreePath = join(rootDir, ".worktrees", name);
    const branchName = `fusion/step-${stepIndex}-${name}`;

    stepExecLog.log(`Creating worktree for step ${stepIndex}: ${worktreePath} (branch: ${branchName})`);

    await execAsync(
      `git worktree add -b "${branchName}" "${worktreePath}" HEAD`,
      { cwd: this.options.worktreePath },
    );

    this.parallelWorktrees.set(stepIndex, worktreePath);
    this.parallelBranches.set(stepIndex, branchName);

    return worktreePath;
  }

  /**
   * Cherry-pick commits from a parallel step's worktree into the primary worktree.
   */
  private async cherryPickCommits(stepIndex: number, worktreePath: string): Promise<void> {
    const { worktreePath: primaryPath, taskDetail } = this.options;

    // Get commits made in the parallel worktree since it was created
    let commits: string;
    try {
      const { stdout } = await execAsync(
        `git log --oneline --format="%H" HEAD...HEAD~10 --since="1 hour ago"`,
        { cwd: worktreePath, encoding: "utf-8" },
      );
      commits = stdout.trim();
    } catch {
      stepExecLog.warn(`Could not list commits in parallel worktree for step ${stepIndex}`);
      return;
    }

    if (!commits) {
      stepExecLog.log(`No commits to cherry-pick for step ${stepIndex}`);
      return;
    }

    const shas = commits.split("\n").filter(Boolean);
    stepExecLog.log(
      `Cherry-picking ${shas.length} commit(s) from step ${stepIndex} ` +
      `into primary worktree for task ${taskDetail.id}`,
    );

    for (const sha of shas.reverse()) {
      try {
        await execAsync(`git cherry-pick "${sha}"`, {
          cwd: primaryPath,
        });
      } catch (err) {
        // Cherry-pick conflict — abort and log
        try {
          await execAsync("git cherry-pick --abort", { cwd: primaryPath });
        } catch {
          // Ignore abort failure
        }
        throw new Error(
          `Cherry-pick conflict for commit ${sha} in step ${stepIndex}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Build the tracking key for the stuck-task detector.
   */
  private makeTrackingKey(stepIndex: number): string {
    return `${this.options.taskDetail.id}-step-${stepIndex}`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Promisified sleep for retry delays. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
