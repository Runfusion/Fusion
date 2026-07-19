/**
 * StepSessionExecutor — runs task steps with graph-controlled step boundaries.
 *
 * This module enables per-step error recovery with retry semantics, optional
 * parallel execution for non-conflicting steps (via git worktree isolation),
 * optional primary-worktree session reuse, and clean lifecycle management
 * (pause, cleanup).
 *
 * The class is a standalone engine subsystem with minimal integration surface.
 * It receives TaskDetail (read-only), a TaskStore for agent logs, and emits
 * execution progress via callbacks.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentHeartbeatRun, AgentStore, MessageStore, PermanentAgentGatingContext, ResolvedMcpServerDefinition, TaskDetail, Settings, SteeringComment, TaskStore } from "@fusion/core";
import { resolvePersistAgentThinkingLog, resolveExecutorFallbackModel } from "@fusion/core";

import {
  createResolvedAgentSession,
  describeAgentModel,
  promptWithAutoRetry,
  resolveExecutorSessionModel,
  resolveExecutorThinkingLevel,
  resolveExecutorFallbackThinkingLevel,
} from "./agent-session-helpers.js";
import type { AgentActionGateContext } from "./agent-action-gate.js";
import type { SkillSelectionContext } from "./skill-resolver.js";
import { generateWorktreeName } from "./worktree-names.js";
import { resolveTaskWorktreePath } from "./worktree-paths.js";
import { installTaskWorktreeIdentityGuard } from "./worktree-hooks.js";
import { AgentSemaphore } from "./concurrency.js";
import { StuckTaskDetector } from "./stuck-task-detector.js";
import { AgentLogger } from "./agent-logger.js";
import { createLogger } from "./logger.js";
import { createFallbackModelObserver } from "./fallback-model-observer.js";
import { createRunAuditor, generateSyntheticRunId } from "./run-audit.js";
import { isContextLimitError } from "./context-limit-detector.js";
import { checkSessionError } from "./usage-limit-detector.js";
import {
  createDelegateTaskTool,
  createTaskAssignTool,
  createListAgentsTool,
  createMemoryTools,
  createWebFetchTool,
  createReadMessagesTool,
  createSendMessageTool,
  createTaskCreateTool,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
  createTaskLogTool,
  createTaskLogsReadTool,
} from "./agent-tools.js";
import { RemovalReason, removeWorktree } from "./worktree-backend.js";
import { pruneWorktreeAdminEntries } from "./worktree-prune.js";
import { activeSessionRegistry } from "./active-session-registry.js";

const stepExecLog = createLogger("step-session-executor");

type WorkflowStepActivityRun = AgentHeartbeatRun & {
  contextSnapshot: NonNullable<AgentHeartbeatRun["contextSnapshot"]>;
};

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
  /** Optional per-step token usage extracted from session stats. */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    /** Provider of the model that produced these step tokens. */
    modelProvider?: string;
    /** Id of the model that produced these step tokens. */
    modelId?: string;
  };
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
  /** Optional runtime hint resolved from assigned agent runtimeConfig. */
  runtimeHint?: string;
  /** Optional assigned-agent runtime config for model override precedence. */
  assignedAgentRuntimeConfig?: Record<string, unknown>;
  /** Callback invoked when a step starts executing. */
  onStepStart?: (stepIndex: number) => void;
  /** Callback invoked when a step completes (success or failure). */
  onStepComplete?: (stepIndex: number, result: StepResult) => void;
  /** Optional skill selection context for session creation. */
  skillSelection?: SkillSelectionContext;
  /** Optional extra skill body directories for session resource discovery. */
  additionalSkillPaths?: string[];
  /** Optional agent store for delegation tools. */
  agentStore?: AgentStore;
  /** Optional message store for messaging tools and validated follow-up proposals. */
  messageStore?: MessageStore;
  /** Whether this step session is a runtime ephemeral worker subject to task-proposal policy. */
  callerIsEphemeral?: boolean;
  sourceTaskId?: string;
  sourceAgentId?: string;
  /** Optional action-gate context for permanent assigned agents. */
  actionGateContext?: AgentActionGateContext;
  /** Optional permanent-agent action gating context. */
  permanentAgentGating?: PermanentAgentGatingContext;
  /** Optional resolved MCP servers to forward into workflow step sessions. */
  mcpServers?: ResolvedMcpServerDefinition[];
  /** Optional workflow node/step reasoning-effort override for all sessions in this graph-pinned step pass. */
  workflowStepThinkingLevel?: string;
  /** Task-scoped environment injected into non-git subprocesses. */
  taskEnv?: NodeJS.ProcessEnv;
  /**
   * Column-agent identity override for session attribution (column-agent plan U4,
   * R2/R3/R4). When the governing foreach/step-execute node's declared column
   * binds an agent that supersedes the task's `assignedAgentId` (override, or
   * defer with no own settings), the executor passes the column agent's id here so
   * the per-step run auditor attributes the session to who actually ran — not
   * `taskDetail.assignedAgentId`. Absent → attribution falls back to
   * `taskDetail.assignedAgentId ?? "executor"` (byte-identical legacy path). The
   * column agent's MODEL flows separately via {@link assignedAgentRuntimeConfig}
   * (the executor swaps it to the column agent's `runtimeConfig` at the seam).
   */
  effectiveAgentId?: string;
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
 * Group dependency-ready, non-conflicting steps into parallel execution waves.
 *
 * Uses a greedy left-to-right scan: for each wave, add steps whose dependencies
 * have all been assigned to earlier waves and that don't conflict with any step
 * already in the wave. Each wave's `indices` array is capped at `maxParallel`.
 * Remaining steps spill into subsequent waves.
 *
 * @param stepScopes - Map from step index to array of file paths.
 * @param maxParallel - Maximum number of steps per wave (range 1–4).
 * @returns Array of {@link ParallelWave} objects with ascending wave numbers.
 */
export function determineParallelWaves(
  stepScopes: Map<number, string[]>,
  maxParallel: number,
  steps: Array<{ dependsOn?: number[] }> = [],
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
      const deps = resolveStepSessionDependsOn(steps, idx);
      if (!deps.every((dep) => assigned.has(dep))) continue;

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
      // Safety: malformed/cyclic dependencies should not infinite-loop the
      // executor. Force the next unassigned step and let downstream execution/
      // validation report the real problem.
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

function resolveStepSessionDependsOn(steps: Array<{ dependsOn?: number[] }>, stepIndex: number): number[] {
  const deps = steps[stepIndex]?.dependsOn;
  if (Array.isArray(deps)) return deps;
  return stepIndex > 0 ? [stepIndex - 1] : [];
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

  // Build steering comments section (last 10 comments only to avoid context bloat)
  const steeringSection = buildStepSteeringCommentsSection(taskDetail.steeringComments);

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
    lines.push(
      "",
      `> **Note:** Attachment files are at the project root under \`.fusion/tasks/${id}/attachments/\` — you may read them even when working in a worktree.`,
    );
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

  if (steeringSection) {
    parts.push(steeringSection, "");
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
      "**Document your deliverables:** When this task produces written output (documentation, specifications, reports, API references, README updates, guides, or any other content), save that content as a task document using `fn_task_document_write(key='...', content='...')`. Use a key that describes the deliverable (e.g., key=\"readme\", key=\"api-docs\"). The document persists in the task for review even after the worktree is cleaned up.",
      "",
    );
  }

  /*
   * FNXC:WorkflowStepControl 2026-06-29-10:18:
   * Graph-owned step execution must not ask the per-step worker to operate board lifecycle tools. Step sessions do not receive fn_task_done/fn_task_update; they finish the scoped step and return so the workflow graph can mark in-progress/done/skipped, order out-of-index completions, and route review/rework.
   */
  parts.push(
    "After completing this step, commit your changes, then stop.",
    "Do NOT call task lifecycle tools. Do NOT call `fn_task_update`, `task_update`, `fn_task_done`, or any tool to mark this step in-progress/done/skipped.",
    "Do NOT proceed to subsequent steps. The workflow graph records step status, ordering, review, and completion.",
  );

  return parts.join("\n");
}

function buildStepSteeringCommentsSection(comments: SteeringComment[] | undefined): string {
  if (!comments || comments.length === 0) return "";

  const recentComments = [...comments].slice(-10);
  const lines = [
    "## Steering Comments",
    "",
    "The following comments were added during execution. Consider adjusting your approach for this step based on this feedback.",
    "",
  ];
  for (const comment of recentComments) {
    lines.push(`**${comment.author}** — ${new Date(comment.createdAt).toLocaleString()}`);
    lines.push(`> ${comment.text}`);
    lines.push("");
  }
  return lines.join("\n");
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
export function extractSection(prompt: string, sectionName: string): string {
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
 * @param rootDir - Optional project root directory used to render absolute attachment paths.
 * @returns A reduced prompt string focused on the current step only.
 */
export function buildReducedStepPrompt(taskDetail: TaskDetail, stepIndex: number, rootDir?: string): string {
  const { prompt, id, title, attachments } = taskDetail;

  // Extract the step-specific section
  const stepSection = extractStepSection(prompt, stepIndex);
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  const attachmentDir = rootDir ? `${rootDir}/.fusion/tasks/${id}/attachments/` : `.fusion/tasks/${id}/attachments/`;
  const steeringSection = buildStepSteeringCommentsSection(taskDetail.steeringComments);

  // Build a minimal prompt that focuses on the step without excessive context
  const parts: string[] = [
    `You are executing step ${stepIndex} of task ${id}.`,
    title ? `Task: ${title}` : "",
    "",
    "Focus on completing this step efficiently:",
    "",
    stepSection,
    "",
    hasAttachments
      ? `${attachments?.length ?? 0} attachment(s) available at \`${attachmentDir}\` — read the files there for context. They live at the project root and are readable even when working in a worktree.`
      : "",
    "",
    steeringSection,
    "",
    "IMPORTANT: Your previous attempt hit the context window limit.",
    "Do NOT repeat work that's already been done.",
    "Check git status and git log to see what's been committed.",
    "Complete the remaining step work, commit your changes, then stop.",
    "Do NOT call `fn_task_update`, `task_update`, `fn_task_done`, or any tool to mark this step in-progress/done/skipped. The workflow graph records step status and completion.",
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
  /** Abort the session's currently-running bash command (if any) so its
   *  detached subprocess tree — including grandchildren like vitest workers —
   *  is killed via pi-coding-agent's killProcessTree. dispose() alone only
   *  disconnects listeners and leaves bash subtrees orphaned. */
  abortBash: () => void;
  /** Inject mid-flight steering into the live step session. */
  steer: (message: string) => Promise<void>;
}


/** Fallback store used when step logging persistence is not configured. */
const NOOP_TASK_STORE: Pick<TaskStore, "appendAgentLog"> = {
  appendAgentLog: async () => undefined,
};

/**
 * StepSessionExecutor — runs each task step behind a deterministic boundary.
 *
 * This class orchestrates per-step agent sessions with:
 * - **Sequential execution** (default): steps run one at a time
 * - **Session policy**: `runStepsInNewSessions=false` reuses one primary-worktree
 *   session across sequential steps; `true` creates a fresh session per step
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
  private deliveredSteeringCommentIds = new Set<string>();
  private reusablePrimarySession: AgentSession | null = null;
  private reusablePrimaryHandle: SessionHandle | null = null;
  private reusableStepTelemetry: { agentLogger: AgentLogger; trackingKey: string } | null = null;
  private reusablePrimaryLastTokenUsage: StepResult["tokenUsage"] | undefined;

  private registerActiveStepSession(stepIndex: number, handle: SessionHandle, worktreePath: string): void {
    this.activeSessions.set(stepIndex, handle);
    activeSessionRegistry.registerPath(worktreePath, {
      taskId: this.options.taskDetail.id,
      kind: "step-session",
      ownerKey: `${this.options.taskDetail.id}#step-${stepIndex}`,
    });
  }

  private unregisterActiveStepSession(stepIndex: number, worktreePath: string): void {
    this.activeSessions.delete(stepIndex);
    activeSessionRegistry.unregisterPath(worktreePath);
  }

  private registerParallelWorktree(stepIndex: number, worktreePath: string): void {
    this.parallelWorktrees.set(stepIndex, worktreePath);
    activeSessionRegistry.registerPath(worktreePath, {
      taskId: this.options.taskDetail.id,
      kind: "step-session-parallel",
      ownerKey: `${this.options.taskDetail.id}#parallel-${stepIndex}`,
    });
  }

  private unregisterParallelWorktree(stepIndex: number): void {
    const path = this.parallelWorktrees.get(stepIndex);
    if (path) {
      activeSessionRegistry.unregisterPath(path);
    }
    this.parallelWorktrees.delete(stepIndex);
  }

  /*
   * FNXC:WorkflowStepSessions 2026-06-29-22:58:
   * Coding (per-step review) still needs the StepSessionExecutor boundary so the graph can run `step-review` between steps, but the operator's "Each step in a new session" switch must control session freshness. Reuse only the primary sequential worktree when `runStepsInNewSessions` is false; parallel/isolated worktrees always need their own sessions because their cwd differs and they may run concurrently.
   */
  private shouldReusePrimarySession(worktreePath: string): boolean {
    return this.options.settings.runStepsInNewSessions === false && worktreePath === this.options.worktreePath;
  }

  private selectReusableTelemetry(fallback: { agentLogger: AgentLogger; trackingKey: string }): { agentLogger: AgentLogger; trackingKey: string } {
    return this.reusableStepTelemetry ?? fallback;
  }

  private async disposeReusablePrimarySession(): Promise<void> {
    if (!this.reusablePrimarySession) return;
    try {
      this.reusablePrimaryHandle?.abortBash();
    } catch (err) {
      stepExecLog.warn(`Failed to abort reusable primary step session: ${err}`);
    }
    try {
      this.reusablePrimarySession.dispose();
    } catch (err) {
      stepExecLog.warn(`Failed to dispose reusable primary step session: ${err}`);
    } finally {
      this.reusablePrimarySession = null;
      this.reusablePrimaryHandle = null;
      this.reusableStepTelemetry = null;
      this.reusablePrimaryLastTokenUsage = undefined;
    }
  }

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

    /*
     * FNXC:WorkflowStepControl 2026-06-29-10:45:
     * Step-session parallelism must respect the workflow graph's dependency model. FN-7228 showed Testing & Verification running while Preflight/implementation were still in progress because this planner considered only file conflicts. Unannotated steps are sequential by default; only explicit dependsOn metadata may unlock out-of-index parallelism.
     */
    const waves = determineParallelWaves(stepScopes, this.maxParallel, taskDetail.steps ?? []);

    stepExecLog.log(
      `Executing ${stepCount} steps in ${waves.length} wave(s) for task ${taskDetail.id} ` +
      `(maxParallel=${this.maxParallel})`,
    );

    // Execute waves sequentially
    for (const wave of waves) {
      if (this.aborted) break;

      /*
       * FNXC:WorkflowResume 2026-06-29-18:26:
       * Engine restart/resume may construct StepSessionExecutor with a stale taskDetail snapshot while TaskStore already shows earlier steps as done/skipped. Re-read live step status before scheduling each wave so resumed graph-owned execution does not fire onStepStart for completed steps and produce noisy done→in-progress regressions like FN-7248.
       */
      const runnableIndices = await this.filterLiveRunnableStepIndices(wave.indices);
      if (runnableIndices.length === 0) {
        continue;
      }

      if (runnableIndices.length === 1) {
        // Single step — use primary worktree
        const stepIdx = runnableIndices[0]!;
        const result = await this.executeStep(stepIdx, this.options.worktreePath);
        this.stepResults.push(result);
      } else {
        // Multiple steps — parallel wave
        const waveResults = await this.executeParallelWave({ ...wave, indices: runnableIndices });
        this.stepResults.push(...waveResults);
      }
    }

    // Sort results by step index for deterministic output
    return this.stepResults.sort((a, b) => a.stepIndex - b.stepIndex);
  }

  private async filterLiveRunnableStepIndices(stepIndices: number[]): Promise<number[]> {
    if (!this.options.store || stepIndices.length === 0) {
      return stepIndices;
    }

    try {
      const liveTask = await this.options.store.getTask(this.options.taskDetail.id);
      if (!liveTask || liveTask.id !== this.options.taskDetail.id) {
        return stepIndices;
      }
      return stepIndices.filter((stepIndex) => {
        const liveStatus = liveTask.steps?.[stepIndex]?.status;
        if (liveStatus === "done" || liveStatus === "skipped") {
          stepExecLog.log(
            `Skipping step ${stepIndex} for task ${this.options.taskDetail.id}: live status is ${liveStatus}`,
          );
          return false;
        }
        return true;
      });
    } catch (err) {
      stepExecLog.warn(
        `Failed to inspect live step status for task ${this.options.taskDetail.id}; continuing from snapshot: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return stepIndices;
    }
  }

  /**
   * Terminate all active agent sessions and set the aborted flag.
   *
   * Call this to pause execution (e.g., when the task is paused externally).
   * After calling this method, any in-progress or future `executeStep()` calls
   * will return a failed result immediately.
   */
  /**
   * Abort in-flight bash on every active step session without disposing the
   * sessions. Used during runtime shutdown so detached bash subprocess trees
   * (including vitest workers) are killed via pi-coding-agent's
   * killProcessTree. Sessions remain alive so near-complete steps can still
   * finish during the runtime's graceful drain window.
   */
  abortAllSessionBash(): void {
    for (const [stepIdx, handle] of this.activeSessions) {
      try {
        handle.abortBash();
      } catch (err) {
        stepExecLog.warn(`Failed to abort bash for step ${stepIdx}: ${err}`);
      }
    }
  }

  updateSteeringComments(comments: SteeringComment[] | undefined): void {
    this.options = {
      ...this.options,
      taskDetail: {
        ...this.options.taskDetail,
        steeringComments: comments ? [...comments] : comments,
      },
    };
  }

  markSteeringCommentsDelivered(commentIds: string[]): void {
    for (const commentId of commentIds) {
      this.deliveredSteeringCommentIds.add(commentId);
    }
  }

  private consumeTaskDetailForStepPrompt(): TaskDetail {
    const pendingSteeringComments = (this.options.taskDetail.steeringComments ?? []).filter(
      (comment) => !this.deliveredSteeringCommentIds.has(comment.id),
    );
    for (const comment of pendingSteeringComments) {
      this.deliveredSteeringCommentIds.add(comment.id);
    }
    return {
      ...this.options.taskDetail,
      steeringComments: pendingSteeringComments.length > 0 ? pendingSteeringComments : undefined,
    };
  }

  async steerActiveSessions(message: string): Promise<number> {
    const activeSessionCount = this.activeSessions.size;
    for (const [stepIdx, handle] of this.activeSessions) {
      try {
        await handle.steer(message);
      } catch (err) {
        stepExecLog.warn(`Failed to steer active session for step ${stepIdx}: ${err}`);
      }
    }
    return activeSessionCount;
  }

  async terminateAllSessions(): Promise<void> {
    this.aborted = true;
    stepExecLog.log(
      `Terminating ${this.activeSessions.size} active session(s) for task ${this.options.taskDetail.id}`,
    );

    for (const [stepIdx, handle] of this.activeSessions) {
      try {
        handle.abortBash();
      } catch (err) {
        stepExecLog.warn(`Failed to abort bash for step ${stepIdx}: ${err}`);
      }
      try {
        handle.dispose();
      } catch (err) {
        stepExecLog.warn(`Failed to dispose session for step ${stepIdx}: ${err}`);
      }

      // Unregister from stuck-task detector
      const trackingKey = this.makeTrackingKey(stepIdx);
      this.options.stuckTaskDetector?.untrackTask(trackingKey);
    }

    for (const worktreePath of activeSessionRegistry.pathsForTask(this.options.taskDetail.id)) {
      activeSessionRegistry.unregisterPath(worktreePath);
    }
    this.activeSessions.clear();
    await this.disposeReusablePrimarySession();
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
    await this.disposeReusablePrimarySession();

    // Remove parallel worktrees
    for (const [stepIdx, worktreePath] of this.parallelWorktrees) {
      try {
        if (existsSync(worktreePath)) {
          await removeWorktree({
            worktreePath,
            rootDir: this.options.rootDir,
            settings: this.options.settings,
            taskId: this.options.taskDetail.id,
            reason: RemovalReason.StepSessionCleanup,
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

    for (const [stepIdx] of this.parallelWorktrees) {
      this.unregisterParallelWorktree(stepIdx);
    }
    this.parallelBranches.clear();

    stepExecLog.log(`Cleanup complete for task ${this.options.taskDetail.id}`);
  }

  private async extractTokenUsageFromSession(session: AgentSession | null | undefined): Promise<StepResult["tokenUsage"] | undefined> {
    if (!session) return undefined;

    try {
      const statsResult = (session as AgentSession & {
        getSessionStats?: () =>
          | {
              tokens?: {
                input?: number;
                output?: number;
                cacheRead?: number;
                cacheWrite?: number;
                total?: number;
              };
            }
          | Promise<{
              tokens?: {
                input?: number;
                output?: number;
                cacheRead?: number;
                cacheWrite?: number;
                total?: number;
              };
            }>;
      }).getSessionStats?.();

      const stats = await Promise.resolve(statsResult);
      const tokens = stats?.tokens;
      if (!tokens) return undefined;

      const inputTokens = tokens.input ?? 0;
      const outputTokens = tokens.output ?? 0;
      const cachedTokens = tokens.cacheRead ?? 0;
      const cacheWriteTokens = tokens.cacheWrite ?? 0;
      const totalTokens = tokens.total ?? (inputTokens + outputTokens + cachedTokens + cacheWriteTokens);
      const model = (session as { model?: { provider?: string; id?: string } }).model;

      return {
        inputTokens,
        outputTokens,
        cachedTokens,
        cacheWriteTokens,
        totalTokens,
        modelProvider: model?.provider,
        modelId: model?.id,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      stepExecLog.warn(`Failed to read session stats for step token usage: ${message}`);
      return undefined;
    }
  }

  private async extractStepTokenUsage(session: AgentSession | null | undefined, reusePrimarySession: boolean): Promise<StepResult["tokenUsage"] | undefined> {
    const current = await this.extractTokenUsageFromSession(session);
    if (!reusePrimarySession || !current) {
      return current;
    }

    const previous = this.reusablePrimaryLastTokenUsage;
    this.reusablePrimaryLastTokenUsage = current;
    if (!previous) {
      return current;
    }

    return {
      inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
      outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
      cachedTokens: Math.max(0, current.cachedTokens - previous.cachedTokens),
      cacheWriteTokens: Math.max(0, current.cacheWriteTokens - previous.cacheWriteTokens),
      totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
      modelProvider: current.modelProvider,
      modelId: current.modelId,
    };
  }

  private createWorkflowStepActivityRun(stepIndex: number, startedAt: string): WorkflowStepActivityRun {
    const { taskDetail } = this.options;
    const step = taskDetail.steps?.[stepIndex];
    const agentId = this.options.effectiveAgentId ?? taskDetail.assignedAgentId ?? "executor";

    /*
     * FNXC:CommandCenterActivity 2026-07-01-00:00:
     * Graph-owned workflow step sessions must publish agentRuns rows because Command Center active-agent, daily activity, and throughput metrics consume agentRuns for ephemeral task-worker activity that may not emit usage_events rows.
     */
    return {
      id: `${generateSyntheticRunId("workflow-step", taskDetail.id)}-step-${stepIndex}`,
      agentId,
      taskId: taskDetail.id,
      startedAt,
      endedAt: null,
      status: "active",
      invocationSource: "assignment",
      triggerDetail: "workflow-step-session",
      processPid: process.pid,
      contextSnapshot: {
        source: "step-session-executor",
        sessionPurpose: "executor",
        workflowStep: true,
        taskId: taskDetail.id,
        taskLineageId: taskDetail.lineageId,
        taskTitle: taskDetail.title,
        assignedAgentId: taskDetail.assignedAgentId,
        effectiveAgentId: this.options.effectiveAgentId,
        agentId,
        stepIndex,
        stepName: step?.name ?? `Step ${stepIndex}`,
      },
      resultJson: {
        source: "step-session-executor",
        sessionPurpose: "executor",
        workflowStep: true,
        stepIndex,
        stepName: step?.name ?? `Step ${stepIndex}`,
      },
    };
  }

  private async saveWorkflowStepActivityRun(run: WorkflowStepActivityRun): Promise<void> {
    const saveRun = this.options.agentStore?.saveRun?.bind(this.options.agentStore);
    if (!saveRun) return;

    try {
      await saveRun(run);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stepExecLog.warn(
        `Failed to publish workflow-step activity run ${run.id} for task ${this.options.taskDetail.id}: ${msg}`,
      );
    }
  }

  private async completeWorkflowStepActivityRun(
    run: WorkflowStepActivityRun,
    status: Extract<AgentHeartbeatRun["status"], "completed" | "failed" | "terminated">,
    result: StepResult,
  ): Promise<void> {
    const terminalRun: WorkflowStepActivityRun = {
      ...run,
      endedAt: new Date().toISOString(),
      status,
      usageJson: result.tokenUsage
        ? {
            inputTokens: result.tokenUsage.inputTokens,
            outputTokens: result.tokenUsage.outputTokens,
            cachedTokens: result.tokenUsage.cachedTokens,
            cacheWriteTokens: result.tokenUsage.cacheWriteTokens,
          }
        : run.usageJson,
      resultJson: {
        ...(run.resultJson ?? {}),
        success: result.success,
        error: result.error,
        retries: result.retries,
        tokenUsage: result.tokenUsage,
      },
    };
    await this.saveWorkflowStepActivityRun(terminalRun);
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
    const promptTaskDetail = this.consumeTaskDetailForStepPrompt();
    const stepPrompt = buildStepPrompt(promptTaskDetail, stepIndex, this.options.rootDir, settings, worktreePath);

    // Build reduced step prompt for context-limit recovery (simpler, shorter)
    const reducedStepPrompt = buildReducedStepPrompt(promptTaskDetail, stepIndex, this.options.rootDir);
    const reusePrimarySession = this.shouldReusePrimarySession(worktreePath);

    // Acquire semaphore if provided
    if (semaphore) {
      await semaphore.acquire();
    }

    const activityRun = this.createWorkflowStepActivityRun(stepIndex, new Date().toISOString());
    await this.saveWorkflowStepActivityRun(activityRun);

    const trackingKey = this.makeTrackingKey(stepIndex);
    let retries = 0;
    // Track context-limit recovery attempts separately from retry attempts.
    // Recovery does NOT count toward MAX_STEP_RETRIES to prevent premature failure.
    let recoveryAttempts = 0;

    try {
      for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
        if (this.aborted) {
          const result: StepResult = { stepIndex, success: false, error: "Execution aborted", retries };
          await this.completeWorkflowStepActivityRun(activityRun, "terminated", result);
          return result;
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
          persistAgentToolOutput: settings.persistAgentToolOutput,
          // Step-session workers are task-scoped ephemeral agents.
          persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
        });
        let session: AgentSession | null = null;
        const localTelemetry = { agentLogger, trackingKey };

        /*
         * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
         * Reusable primary step sessions resolve reasoning effort as workflow node/step override first, then parsed step metadata, task thinking, workflow execution lane, global lane, and default thinking settings.
         */
        const stepThinkingLevel = this.options.workflowStepThinkingLevel
          ?? (taskDetail.steps[stepIndex] as { thinkingLevel?: string } | undefined)?.thinkingLevel;
        const effectiveThinkingLevel = resolveExecutorThinkingLevel(stepThinkingLevel ?? taskDetail.thinkingLevel, settings);

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
          const webFetchTool = createWebFetchTool();
          const memoryTools = createMemoryTools(this.options.rootDir, settings);

          // Task log and create tools — task context for step sessions.
          const taskLogTool = this.options.store
            ? [
                createTaskLogTool(this.options.store, taskDetail.id),
                createTaskLogsReadTool(this.options.store, taskDetail.id),
              ]
            : [];
          const taskCreateTool = this.options.store
            ? [createTaskCreateTool(this.options.store, undefined, { rootDir: this.options.rootDir, callerIsEphemeral: this.options.callerIsEphemeral, sourceTaskId: this.options.sourceTaskId ?? taskDetail.id, sourceAgentId: this.options.sourceAgentId ?? taskDetail.assignedAgentId, messageStore: this.options.messageStore })]
            : [];

          // Agent delegation tools — discover and delegate work to other agents.
          const delegationTools = this.options.agentStore
            ? [
                createListAgentsTool(this.options.agentStore),
                createDelegateTaskTool(this.options.agentStore, this.options.store!, { rootDir: this.options.rootDir }),
                createTaskAssignTool(this.options.agentStore, this.options.store!),
              ]
            : [];

          // Messaging tools — allows step sessions to send and receive messages.
          const messagingTools =
            this.options.messageStore && taskDetail.assignedAgentId
              ? [
                  createSendMessageTool(this.options.messageStore, taskDetail.assignedAgentId, { autoRecovery: settings.autoRecovery, taskStore: this.options.store!, settings, agentStore: this.options.agentStore }),
                  createReadMessagesTool(this.options.messageStore, taskDetail.assignedAgentId),
                ]
              : [];

          // Create or reuse the agent session for this attempt
          // Resolve executor model using canonical lane hierarchy:
          // 1. Task override pair (taskDetail.modelProvider + taskDetail.modelId)
          // 2. Project execution lane pair (settings.executionProvider + settings.executionModelId)
          // 3. Global execution lane pair (settings.executionGlobalProvider + settings.executionGlobalModelId)
          // 4. Project default override pair (settings.defaultProviderOverride + settings.defaultModelIdOverride)
          // 5. Global default pair (settings.defaultProvider + settings.defaultModelId)
          const { provider: executorProvider, modelId: executorModelId } = resolveExecutorSessionModel(
            taskDetail.modelProvider,
            taskDetail.modelId,
            settings,
            this.options.assignedAgentRuntimeConfig,
          );

          if (reusePrimarySession && this.reusablePrimarySession) {
            session = this.reusablePrimarySession;
          } else {
            const createResult = await createResolvedAgentSession({
              sessionPurpose: "executor",
              runtimeHint: this.options.runtimeHint,
              pluginRunner: this.options.pluginRunner,
              cwd: worktreePath,
              systemPrompt: `You are an AI agent executing steps for task ${taskDetail.id}.

Your role:
- Complete only the current step's scoped outcomes.
- Read step context before editing.
- Reuse existing patterns in nearby code.
- Run relevant tests for changes made in this step.
- Report blockers clearly instead of guessing.

Follow instructions precisely and avoid unrelated changes.`,
              defaultProvider: executorProvider,
              defaultModelId: executorModelId,
              fallbackProvider: resolveExecutorFallbackModel(settings).provider,
              fallbackModelId: resolveExecutorFallbackModel(settings).modelId,
              fallbackThinkingLevel: resolveExecutorFallbackThinkingLevel(taskDetail.thinkingLevel, settings),
              defaultThinkingLevel: effectiveThinkingLevel,
              runAuditor: createRunAuditor(this.store, {
                runId: generateSyntheticRunId("workflow-step", taskDetail.id),
                // Column-agent attribution (U4): the effective column agent is the
                // principal that actually ran when the seam node's column governs;
                // fall back to the task's assigned agent (legacy, byte-identical).
                agentId: this.options.effectiveAgentId ?? taskDetail.assignedAgentId ?? "executor",
                taskId: taskDetail.id,
                taskLineageId: taskDetail.lineageId,
                phase: "execute",
                source: "step-session-executor",
              }),
              settings,
              // FNXC:McpConfig 2026-06-25-23:02: Workflow model-node step sessions receive the same resolved, secret-materialized MCP server set as the parent executor; runtime support is still enforced inside the pi session seam without logging server contents.
              mcpServers: this.options.mcpServers,
              customTools: [
                ...pluginTools,
                ...documentTools,
                webFetchTool,
                ...memoryTools,
                ...taskLogTool,
                ...taskCreateTool,
                ...delegationTools,
                ...messagingTools,
              ],
              onText: (delta) => {
                const telemetry = reusePrimarySession ? this.selectReusableTelemetry(localTelemetry) : localTelemetry;
                telemetry.agentLogger.onText(delta);
                stuckTaskDetector?.recordActivity(telemetry.trackingKey);
              },
              onThinking: (delta) => {
                const telemetry = reusePrimarySession ? this.selectReusableTelemetry(localTelemetry) : localTelemetry;
                telemetry.agentLogger.onThinking(delta);
              },
              onToolStart: (name, args) => {
                const telemetry = reusePrimarySession ? this.selectReusableTelemetry(localTelemetry) : localTelemetry;
                telemetry.agentLogger.onToolStart(name, args);
                stuckTaskDetector?.recordActivity(telemetry.trackingKey);
              },
              onToolEnd: (name, isError, result) => {
                const telemetry = reusePrimarySession ? this.selectReusableTelemetry(localTelemetry) : localTelemetry;
                telemetry.agentLogger.onToolEnd(name, isError, result);
                stuckTaskDetector?.recordActivity(telemetry.trackingKey);
              },
              // FNXC:PluginSkills 2026-07-12-00:00: Step-session createFnAgent must receive plugin skill body dirs from TaskExecutor; names alone do not make plugin-package SKILL.md files discoverable.
              ...(this.options.skillSelection ? { skillSelection: this.options.skillSelection } : {}),
              ...(this.options.additionalSkillPaths && this.options.additionalSkillPaths.length > 0 ? { additionalSkillPaths: this.options.additionalSkillPaths } : {}),
              actionGateContext: this.options.actionGateContext,
              permanentAgentGating: this.options.permanentAgentGating,
              taskId: taskDetail.id,
              taskTitle: taskDetail.title,
              onFallbackModelUsed: createFallbackModelObserver({
                agent: "executor",
                label: "workflow step agent",
                store: this.store,
                taskId: taskDetail.id,
                taskTitle: taskDetail.title,
              }),
              taskEnv: this.options.taskEnv,
            });
            session = createResult.session;
            if (reusePrimarySession) {
              this.reusablePrimarySession = session;
            }
          }

          // Track session for termination and stuck-task detection.
          // Pass the canonical task ID (e.g. "FN-1452") as the third argument so
          // that stuck-kill callbacks (beforeRequeue, onStuck) operate on the real
          // task rather than the compound step key ("FN-1452-step-1").
          const handle: SessionHandle = reusePrimarySession && this.reusablePrimaryHandle
            ? this.reusablePrimaryHandle
            : {
                dispose: () => session?.dispose(),
                abortBash: () => session?.abortBash(),
                steer: async (message) => {
                  if (!session) return;
                  await session.steer(message);
                },
              };
          if (reusePrimarySession && !this.reusablePrimaryHandle) {
            this.reusablePrimaryHandle = handle;
          }
          if (reusePrimarySession) {
            this.reusableStepTelemetry = localTelemetry;
          }
          this.registerActiveStepSession(stepIndex, handle, worktreePath);
          stuckTaskDetector?.trackTask(trackingKey, { dispose: () => session?.dispose() }, taskDetail.id);

          const sessionModel = await describeAgentModel(session);
          stepExecLog.log(
            `Step ${stepIndex} attempt ${attempt + 1} session created ` +
            `(model=${sessionModel}) for task ${taskDetail.id}`,
          );

          // Send prompt
          await promptWithAutoRetry(session, stepPrompt);

          // Re-raise errors that pi-coding-agent swallowed after exhausting retries.
          // session.prompt() resolves normally even when retries are exhausted —
          // the error is stored on session.state.error instead of being thrown.
          checkSessionError(session);

          const result: StepResult = {
            stepIndex,
            success: true,
            retries,
            tokenUsage: await this.extractStepTokenUsage(session, reusePrimarySession),
          };
          await this.completeWorkflowStepActivityRun(activityRun, "completed", result);
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
              await promptWithAutoRetry(session, reducedStepPrompt);
              checkSessionError(session);
              stepExecLog.log(`Step ${stepIndex} reduced-prompt recovery succeeded`);
              await this.store.appendAgentLog(
                taskDetail.id,
                `[step-exec] Reduced-prompt recovery succeeded for step ${stepIndex}`,
                "status",
              );
              const result: StepResult = {
                stepIndex,
                success: true,
                retries,
                tokenUsage: await this.extractStepTokenUsage(session, reusePrimarySession),
              };
              await this.completeWorkflowStepActivityRun(activityRun, "completed", result);
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
              tokenUsage: await this.extractStepTokenUsage(session, reusePrimarySession),
            };
            await this.completeWorkflowStepActivityRun(activityRun, "failed", result);
            this.options.onStepComplete?.(stepIndex, result);
            return result;
          }
          if (reusePrimarySession) {
            await this.disposeReusablePrimarySession();
            session = null;
          }
        } finally {
          try {
            await agentLogger.flush();
          } catch (err) {
            const flushError = err instanceof Error ? err.message : String(err);
            stepExecLog.warn(`Failed to flush agent logs for step ${stepIndex}: ${flushError}`);
          }

          this.unregisterActiveStepSession(stepIndex, worktreePath);
          stuckTaskDetector?.untrackTask(trackingKey);
          if (reusePrimarySession) {
            this.reusableStepTelemetry = null;
          } else {
            try {
              session?.dispose();
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              stepExecLog.warn(`Failed to dispose session for step ${stepIndex}: ${msg}`);
            }
          }
        }
      }

      // Should not reach here, but safety fallback
      const result: StepResult = { stepIndex, success: false, error: "Max retries exceeded", retries };
      await this.completeWorkflowStepActivityRun(activityRun, "failed", result);
      return result;
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
            this.unregisterParallelWorktree(stepIdx);
            await removeWorktree({
              worktreePath,
              rootDir: this.options.rootDir,
              settings: this.options.settings,
              taskId: this.options.taskDetail.id,
              reason: RemovalReason.StepSessionCleanup,
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
          this.unregisterParallelWorktree(stepIdx);
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
    const { rootDir, settings } = this.options;
    const name = generateWorktreeName(rootDir, settings);
    const worktreePath = resolveTaskWorktreePath(rootDir, settings, name);
    const branchName = `fusion/step-${stepIndex}-${name}`;

    stepExecLog.log(`Creating worktree for step ${stepIndex}: ${worktreePath} (branch: ${branchName})`);

    try {
      await execAsync(
        `git worktree add -b "${branchName}" "${worktreePath}" HEAD`,
        { cwd: this.options.worktreePath },
      );
    } catch (err) {
      // Remove any partial directory left behind so the invariant holds:
      // "if .worktrees/<slug> exists on disk, it is a fully registered git worktree."
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; log but don't mask the original error
        stepExecLog.log(`Warning: failed to remove partial worktree directory after creation failure: ${worktreePath}`);
      }
      await pruneWorktreeAdminEntries({
        rootDir,
        reason: "step-session-create-failed",
        target: worktreePath,
        logger: stepExecLog,
      }).catch(() => undefined);
      throw err;
    }

    try {
      await installTaskWorktreeIdentityGuard({
        worktreePath,
        taskId: this.options.taskDetail.id,
        commitMsgHookEnabled: settings.commitMsgHookEnabled,
        taskPrefix: settings.taskPrefix,
        taskAttributionTrailerName: settings.taskAttributionTrailerNames?.[0],
        commitAuthorEnabled: settings.commitAuthorEnabled,
        commitAuthorName: settings.commitAuthorName,
        commitAuthorEmail: settings.commitAuthorEmail,
      });
    } catch (err) {
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        stepExecLog.log(`Warning: failed to remove worktree after identity-guard install failure: ${worktreePath}`);
      }
      await pruneWorktreeAdminEntries({
        rootDir,
        reason: "step-session-guard-failed",
        target: worktreePath,
        logger: stepExecLog,
      }).catch(() => undefined);
      throw err;
    }

    this.registerParallelWorktree(stepIndex, worktreePath);
    this.parallelBranches.set(stepIndex, branchName);

    return worktreePath;
  }

  /**
   * Cherry-pick commits from a parallel step's worktree into the primary worktree.
   */
  private async cherryPickCommits(stepIndex: number, worktreePath: string): Promise<void> {
    const { worktreePath: primaryPath, taskDetail } = this.options;

    /*
     * FNXC:WorkflowStepControl 2026-06-29-10:31:
     * Parallel step-session worktrees must land their step commits back into the primary task worktree before modifiedFiles capture runs. Use the actual merge-base with the primary worktree HEAD; the old time/HEAD~10 range could include already-present ancestors, hit an empty cherry-pick first, and leave the task branch with no files changed.
     */
    let commits: string;
    try {
      const { stdout: primaryHeadRaw } = await execAsync("git rev-parse HEAD", {
        cwd: primaryPath,
        encoding: "utf-8",
      });
      const primaryHead = primaryHeadRaw.trim();
      const { stdout: mergeBaseRaw } = await execAsync(`git merge-base HEAD ${primaryHead}`, {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      const mergeBase = mergeBaseRaw.trim();
      const { stdout } = await execAsync(
        `git rev-list --reverse ${mergeBase}..HEAD`,
        { cwd: worktreePath, encoding: "utf-8" },
      );
      commits = stdout.trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      stepExecLog.warn(`Could not list commits in parallel worktree for step ${stepIndex}: ${msg}`);
      return;
    }

    if (!commits) {
      stepExecLog.log(`No commits to cherry-pick for step ${stepIndex}`);
      return;
    }

    const shas = commits.split("\n").map((line) => line.trim()).filter(Boolean);
    stepExecLog.log(
      `Cherry-picking ${shas.length} commit(s) from step ${stepIndex} ` +
      `into primary worktree for task ${taskDetail.id}`,
    );

    for (const sha of shas) {
      try {
        await execAsync(`git cherry-pick "${sha}"`, {
          cwd: primaryPath,
        });
      } catch (err) {
        const errText = `${err instanceof Error ? err.message : String(err)} ${String((err as { stdout?: unknown; stderr?: unknown })?.stdout ?? "")} ${String((err as { stderr?: unknown })?.stderr ?? "")}`;
        if (
          errText.includes("The previous cherry-pick is now empty") ||
          errText.includes("nothing to commit") ||
          errText.includes("is empty")
        ) {
          await execAsync("git cherry-pick --skip", { cwd: primaryPath }).catch(async () => {
            await execAsync("git cherry-pick --abort", { cwd: primaryPath }).catch(() => undefined);
          });
          stepExecLog.warn(`Skipped empty cherry-pick for step ${stepIndex}: ${sha}`);
          continue;
        }
        // Cherry-pick conflict — abort and log
        try {
          await execAsync("git cherry-pick --abort", { cwd: primaryPath });
        } catch (abortErr: unknown) {
          const msg = abortErr instanceof Error ? abortErr.message : String(abortErr);
          stepExecLog.warn(`Cherry-pick --abort failed for step ${stepIndex}: ${msg}`);
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
