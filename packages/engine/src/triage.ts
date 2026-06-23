/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fusionCore from "@fusion/core";
import type {
  TaskStore,
  Task,
  TaskDetail,
  TaskAttachment,
  Settings,
} from "@fusion/core";
import {
  DUPLICATE_OF_METADATA_KEY,
  TaskDeletedError,
  buildTriageMemoryInstructions,
  getTaskDuplicateLineage,
  parseExplicitDuplicateMarker,
  resolveAgentPrompt,
  builtinSeamPrompt,
  renderTriagePolicyPlaceholders,
  resolveTaskPlanningPrompt,
  resolveTaskSeamPrompt,
  resolvePersistAgentThinkingLog,
  compareTaskPriority,
  sortTasksByPriorityThenAgeAndId,
  compareTaskIdNumeric,
  resolveAgentMemoryInclusionMode,
  extractIntentSignature,
  findNearDuplicates,
  isNearDuplicateCanonicalInactive,
  applyFrontendUxCriteria,
  MAX_TASK_LIST_TEXT_CHARS,
  type NearDuplicateCandidate,
} from "@fusion/core";

type TaskListClamp = (lines: string[], opts?: { maxChars?: number }) => string;
type TaskListFormatter = (
  lines: string[],
  opts?: { maxChars?: number; clamp?: TaskListClamp },
) => string;

export function inlineTaskListFallback(
  lines: string[],
  opts: { maxChars?: number } = {},
): string {
  /*
  FNXC:TaskListOutput 2026-06-18-03:20:
  FN-6629 requires stale-runtime fallback formatting to mirror the shared host-safe task-list budget; otherwise missing @fusion/core formatter exports can re-emit imageified duplicate-check listings.
  */
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? MAX_TASK_LIST_TEXT_CHARS));
  try {
    const text = lines.join("\n");
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, Math.max(0, maxChars - 1)) + "…";
  } catch {
    return "";
  }
}

export function resolveTaskListFormatter(core: { formatTaskListText?: unknown }): TaskListFormatter {
  return typeof core.formatTaskListText === "function"
    ? (core.formatTaskListText as TaskListFormatter)
    : inlineTaskListFallback;
}

import type { ImageContent } from "@earendil-works/pi-ai";
import { Type, type Static } from "@earendil-works/pi-ai";
import type {
  ToolDefinition,
  AgentSession,
} from "@earendil-works/pi-coding-agent";
import { describeModel, promptWithFallback } from "./pi.js";
import {
  createResolvedAgentSession,
  extractRuntimeHint,
  resolvePlanningSessionModel,
} from "./agent-session-helpers.js";
import { reviewStep, type ReviewVerdict } from "./reviewer.js";
import { mergeEffectiveSettings } from "./effective-settings.js";
import { detectDanglingTaskDocReferences, formatDanglingDiagnostic } from "./spec-validation/task-document-references.js";
import {
  detectExternalIntegrationEvidenceGaps,
  formatExternalIntegrationEvidenceDiagnostic,
} from "./spec-validation/external-integration-evidence.js";
import { buildSessionSkillContext } from "./session-skill-context.js";
import { PRIORITY_SPECIFY, recoverIdleSemaphoreLeakCandidate, type AgentSemaphore } from "./concurrency.js";
import { AgentLogger } from "./agent-logger.js";
import {
  resolveAgentInstructions,
  resolveAgentInstructionsWithRatings,
  buildPluginPromptSection,
} from "./agent-instructions.js";
import { buildPromptLayers, collapsePromptLayers } from "./prompt-layers.js";
import { createFallbackModelObserver } from "./fallback-model-observer.js";
import { planLog, reviewerLog, formatError } from "./logger.js";
import {
  isUsageLimitError,
  checkSessionError,
  type UsageLimitPauser,
} from "./usage-limit-detector.js";
import { isTransientError, isSilentTransientError } from "./transient-error-detector.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "./recovery-policy.js";
import type { StuckTaskDetector } from "./stuck-task-detector.js";
import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createAgentTask,
  createDelegateTaskTool,
  createListAgentsTool,
  createMemoryTools,
  createGoalRetrievalTools,
  createResearchTools,
  createWebFetchTool,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
  createWorkflowListTool,
  createWorkflowSelectTool,
} from "./agent-tools.js";
import {
  getResearchGuidanceForSurface,
  isResearchToolSurfaceEnabled,
} from "./tool-availability.js";
import { runGhostBugPreflight } from "./triage-preflight.js";
import { evaluateReleaseAuthorizationGate } from "./triage-release-authorization.js";
import { archiveAsGhostBug } from "./self-healing.js";
import { createRunAuditor, generateSyntheticRunId } from "./run-audit.js";
import { resolveAndEmitGoalContext } from "./goal-injection-diagnostics.js";


export interface TriageProcessorOptions {
  pollIntervalMs?: number;
  semaphore?: AgentSemaphore;
  /** Usage limit pauser — triggers global pause when API limits are detected. */
  usageLimitPauser?: UsageLimitPauser;
  /** Stuck task detector — monitors triage sessions for stagnation and triggers recovery. */
  stuckTaskDetector?: StuckTaskDetector;
  onSpecifyStart?: (task: Task) => void;
  onSpecifyComplete?: (task: Task) => void;
  onSpecifyError?: (task: Task, error: Error) => void;
  onAgentText?: (taskId: string, delta: string) => void;
  /** AgentStore for resolving per-agent custom instructions. */
  agentStore?: import("@fusion/core").AgentStore;
  /** Plugin runner for runtime selection. When provided, enables plugin runtime lookup. */
  pluginRunner?: import("./plugin-runner.js").PluginRunner;
}

/**
 * Processes tasks in the triage column by running an AI agent to generate
 * a full PROMPT.md specification.
 *
 * **Dynamic poll interval:** On every `poll()` call the processor reads
 * `pollIntervalMs` from the persisted store settings (`store.getSettings()`).
 * If the value has changed since the last cycle the `setInterval` timer is
 * transparently restarted, so dashboard setting changes take effect without
 * an engine restart.
 */
export class TriageProcessor {
  private running = false;
  private polling = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  /** The interval (ms) of the currently active `setInterval` timer. */
  private activePollMs: number | null = null;
  private processing = new Set<string>();
  /** Timestamps when tasks entered the `processing` set, for staleness detection. */
  private processingSince = new Map<string, number>();
  private wasGlobalPaused = false;
  private wasEnginePaused = false;
  private idleSemaphoreLeakCandidateSince: number | null = null;
  /** Active agent sessions per task, used to terminate on pause. */
  private activeSessions = new Map<string, { dispose: () => void }>();
  /**
   * Reviewer subagent sessions per task. The spec reviewer (`reviewer.ts`)
   * creates its own AgentSession that isn't part of `activeSessions`, so
   * without this map it survives a global pause and continues producing
   * verdicts. Mirrors `TaskExecutor.activeSubagentSessions`.
   */
  private activeSubagentSessions = new Map<string, Set<AgentSession>>();
  /** Tasks aborted due to globalPause (to avoid reporting as errors). */
  private pauseAborted = new Set<string>();
  /** Tasks killed by the stuck task detector (to avoid reporting as errors). */
  private stuckAborted = new Set<string>();
  private taskDeletedHandler?: (task: Task) => void;
  private taskPausedHandler?: (task: Task) => void;

  /**
   * @param store — Task store instance (also used to listen for `settings:updated` events)
   * @param rootDir — Project root directory
   * @param options — Processor configuration
   *
   * Listens for `settings:updated` events: when `globalPause` transitions from
   * `false` to `true`, all active triage specification sessions are immediately
   * terminated. When `enginePaused` transitions, only new work dispatch is
   * affected — running sessions continue to completion.
   */
  constructor(
    private store: TaskStore,
    private rootDir: string,
    private options: TriageProcessorOptions = {},
  ) {
    // When globalPause transitions from false → true, terminate all active triage sessions.
    store.on("settings:updated", ({ settings, previous }) => {
      if (settings.globalPause && !previous.globalPause) {
        this.abortAndDisposeActiveSessions("global pause");
      }
    });

    /**
     * Immediate unpause resume: when `globalPause` transitions from `true`
     * to `false`, trigger a triage poll right away instead of waiting for
     * the next poll interval (up to 15 s). Only reacts to true→false
     * transitions — no-ops on false→false and true→true.
     *
     * The re-entrance guard (`this.polling`) inside `poll()` safely drops
     * the call if a poll-based pass is already in flight.
     */
    store.on("settings:updated", ({ settings, previous }) => {
      if (previous.globalPause && !settings.globalPause && this.running) {
        this.poll();
      }
    });

    /**
     * Immediate engine-unpause resume: when `enginePaused` transitions from
     * `true` to `false`, trigger a triage poll right away instead of
     * waiting for the next poll interval. Same pattern as the globalPause
     * unpause handler above.
     */
    store.on("settings:updated", ({ settings, previous }) => {
      if (previous.enginePaused && !settings.enginePaused && this.running) {
        this.poll();
      }
    });

    this.taskDeletedHandler = (task: Task) => {
      if (this.activeSubagentSessions.has(task.id)) {
        this.disposeSubagentsForTask(task.id, "task soft-deleted");
      }
      if (this.activeSessions.has(task.id)) {
        const session = this.activeSessions.get(task.id)!;
        planLog.log(`task soft-deleted — terminating triage session for ${task.id}`);
        this.pauseAborted.add(task.id);
        this.options.stuckTaskDetector?.untrackTask(task.id);
        const sessionWithAbort = session as {
          abort?: () => Promise<void>;
          dispose: () => void;
        };
        if (typeof sessionWithAbort.abort === "function") {
          void sessionWithAbort.abort().catch((err) => {
            planLog.warn(`Failed to abort triage session for ${task.id}: ${err}`);
          });
        }
        session.dispose();
        this.activeSessions.delete(task.id);
      }
    };

    this.taskPausedHandler = (task: Task) => {
      if (!task?.id || (task.paused !== true && task.userPaused !== true)) {
        return;
      }
      if (this.activeSubagentSessions.has(task.id)) {
        this.disposeSubagentsForTask(task.id, "task paused");
      }
      if (this.activeSessions.has(task.id)) {
        const session = this.activeSessions.get(task.id)!;
        planLog.log(`task paused — terminating triage session for ${task.id}`);
        this.pauseAborted.add(task.id);
        this.options.stuckTaskDetector?.untrackTask(task.id);
        const sessionWithAbort = session as {
          abort?: () => Promise<void>;
          dispose: () => void;
        };
        if (typeof sessionWithAbort.abort === "function") {
          void sessionWithAbort.abort().catch((err) => {
            planLog.warn(`Failed to abort triage session for ${task.id}: ${err}`);
          });
        }
        session.dispose();
        this.activeSessions.delete(task.id);
      }
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.taskDeletedHandler && typeof this.store.on === "function") {
      this.store.on("task:deleted", this.taskDeletedHandler);
    }
    if (this.taskPausedHandler && typeof this.store.on === "function") {
      this.store.on("task:updated", this.taskPausedHandler);
    }

    // Clear stale "planning" statuses left by a prior crash/restart.
    // No triage agent is actually running at startup, so any task still
    // marked as "planning" is a leftover from a previous engine lifecycle.
    // Without this, stale statuses consume concurrency slots and block
    // new triage work indefinitely.
    this.clearStaleSpecifyingStatuses().catch((err) => {
      planLog.error("Failed to clear stale planning statuses:", err);
    });

    const interval = this.options.pollIntervalMs ?? 10_000;
    this.activePollMs = interval;
    this.pollInterval = setInterval(() => this.poll(), interval);
    this.poll();
    planLog.log("Processor started");
  }

  private async clearStaleSpecifyingStatuses(): Promise<void> {
    const tasks = await this.store.listTasks({ column: "triage", slim: true });
    const stale = tasks.filter(
      (t) => t.status === "planning" && !this.processing.has(t.id),
    );
    for (const t of stale) {
      planLog.log(`Startup sweep: clearing stale 'planning' status on ${t.id}`);
      await this.store.updateTask(t.id, { status: null });
    }
    if (stale.length > 0) {
      planLog.log(`Startup sweep: cleared ${stale.length} stale planning task(s)`);
    }
  }

  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.activePollMs = null;
    }
    if (this.taskDeletedHandler && typeof this.store.off === "function") {
      this.store.off("task:deleted", this.taskDeletedHandler);
    }
    if (this.taskPausedHandler && typeof this.store.off === "function") {
      this.store.off("task:updated", this.taskPausedHandler);
    }
    // Tear down any in-flight specify sessions and reviewer subagents so they
    // don't keep streaming LLM tokens / tool calls past engine shutdown.
    this.abortAndDisposeActiveSessions("engine stop");
    planLog.log("Processor stopped");
  }

  /**
   * Abort and dispose every active specify session and reviewer subagent.
   * Used by the global-pause handler and by `stop()`.
   *
   * Reviewer subagents are torn down first so they don't keep streaming
   * verdicts while the main triage session is being disposed. abort()
   * interrupts any in-flight LLM stream / tool call; dispose() then
   * releases session resources.
   */
  private abortAndDisposeActiveSessions(reason: string): void {
    for (const taskId of [...this.activeSubagentSessions.keys()]) {
      this.disposeSubagentsForTask(taskId, reason);
    }
    for (const [taskId, session] of this.activeSessions) {
      planLog.log(`${reason} — terminating triage session for ${taskId}`);
      this.pauseAborted.add(taskId);
      this.options.stuckTaskDetector?.untrackTask(taskId);
      const sessionWithAbort = session as {
        abort?: () => Promise<void>;
        dispose: () => void;
      };
      if (typeof sessionWithAbort.abort === "function") {
        void sessionWithAbort.abort().catch((err) => {
          planLog.warn(`Failed to abort triage session for ${taskId}: ${err}`);
        });
      }
      session.dispose();
    }
  }

  /**
   * Mark a task as stuck-aborted so the catch block knows not to treat
   * the disposed session as a genuine failure.
   * Called by the stuck task detector's onStuck callback.
   */
  markStuckAborted(taskId: string): void {
    this.stuckAborted.add(taskId);
  }

  /**
   * Register a reviewer subagent session under its parent task. Used as the
   * `onSessionCreated` callback passed to `reviewStep`. Mirrors the
   * TaskExecutor implementation.
   */
  private registerSubagentSession(taskId: string, session: AgentSession): void {
    let set = this.activeSubagentSessions.get(taskId);
    if (!set) {
      set = new Set();
      this.activeSubagentSessions.set(taskId, set);
    }
    set.add(session);
  }

  /** Deregister a reviewer subagent that finished naturally. */
  private unregisterSubagentSession(taskId: string, session: AgentSession): void {
    const set = this.activeSubagentSessions.get(taskId);
    if (!set) return;
    set.delete(session);
    if (set.size === 0) this.activeSubagentSessions.delete(taskId);
  }

  /** Dispose all reviewer subagents for a task and remove them from the map. */
  private disposeSubagentsForTask(taskId: string, reason: string): void {
    const set = this.activeSubagentSessions.get(taskId);
    if (!set || set.size === 0) return;
    planLog.log(`${taskId}: disposing ${set.size} subagent session(s) — ${reason}`);
    for (const session of set) {
      try {
        session.dispose();
      } catch (err) {
        planLog.warn(`${taskId}: failed to dispose subagent session: ${err}`);
      }
    }
    this.activeSubagentSessions.delete(taskId);
  }

  /**
   * Return a snapshot of tasks currently being specified by this processor.
   * Used by self-healing maintenance to avoid recovering live sessions.
   */
  getProcessingTaskIds(): Set<string> {
    return new Set(this.processing);
  }

  /**
   * Maximum time a task can remain in the `processing` set before it's
   * considered stale (30 minutes). By this point the stuck detector
   * (default 20-min timeout) should have already killed the session
   * and the `finally` block should have cleaned up. If it hasn't,
   * the promise is hung (e.g., `promptWithFallback` never settled
   * after dispose) and self-healing recovery needs to force-evict it.
   */
  private static readonly STALE_PROCESSING_THRESHOLD_MS = 30 * 60 * 1000;

  /**
   * Evict tasks from the `processing` set that have been there longer than
   * the staleness threshold. This handles the case where a stuck-kill
   * disposes the session but the `specifyTask` promise never settles
   * (hung `promptWithFallback`), leaving the task in `processing` forever
   * and blocking self-healing recovery.
   *
   * @returns the set of evicted task IDs
   */
  evictStaleProcessing(): Set<string> {
    const now = Date.now();
    const threshold = TriageProcessor.STALE_PROCESSING_THRESHOLD_MS;
    const evicted = new Set<string>();

    for (const [taskId, since] of this.processingSince) {
      if (now - since >= threshold) {
        planLog.warn(
          `${taskId} has been in processing for ${Math.round((now - since) / 60_000)}min ` +
          `(threshold: ${Math.round(threshold / 60_000)}min) — evicting (likely hung promise)`,
        );
        this.processing.delete(taskId);
        this.processingSince.delete(taskId);
        this.activeSessions.delete(taskId);
        this.stuckAborted.delete(taskId);
        evicted.add(taskId);
      }
    }

    return evicted;
  }

  /**
   * Recover a triage task whose spec was already approved but the final
   * handoff out of `status: "planning"` never completed.
   */
  async recoverApprovedTask(task: Task): Promise<boolean> {
    if (task.column !== "triage" || task.status !== "planning") {
      return false;
    }

    if (task.paused === true || task.userPaused === true) {
      planLog.log(`${task.id} approved-spec recovery skipped — task is paused`);
      return false;
    }

    if (!hasLatestSpecReviewApproval(task)) {
      return false;
    }

    // Merge per-task effective workflow settings (U3, KTD-3) so requirePlanApproval
    // resolves from the workflow. Behavior-inert when nothing is customized.
    const settings = await mergeEffectiveSettings(this.store, task, await this.store.getSettings());
    const promptPath = join(this.rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
    const written = await readFile(promptPath, "utf-8").catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${task.id}: failed to read PROMPT.md during approved-spec recovery (${promptPath}): ${msg}`);
      return "";
    });

    if (!written.trim()) {
      planLog.warn(`${task.id} approved-spec recovery skipped — PROMPT.md missing or empty`);
      return false;
    }

    await this.finalizeApprovedTask(task, written, settings, {
      recoveryLogAction: settings.requirePlanApproval
        ? "Auto-recovered approved specification stuck in planning — awaiting manual approval"
        : "Auto-recovered approved specification stuck in planning — moved to todo",
    });

    return true;
  }

  /**
   * If `newIntervalMs` differs from the currently active timer, restart
   * the `setInterval` so the new cadence takes effect immediately.
   */
  private refreshPollInterval(newIntervalMs?: number): void {
    if (!this.running || !newIntervalMs) return;
    if (newIntervalMs === this.activePollMs) return;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this.activePollMs = newIntervalMs;
    this.pollInterval = setInterval(() => this.poll(), newIntervalMs);
    planLog.log(`Poll interval updated to ${newIntervalMs}ms`);
  }

  /**
   * Discover triage tasks and dispatch `specifyTask()` for each one.
   *
   * **Concurrent dispatch:** `specifyTask()` calls are fired without awaiting,
   * so multiple triage tasks can be specified concurrently (bounded by the
   * shared `AgentSemaphore`). The `polling` re-entrance guard prevents
   * overlapping discovery cycles, but resets as soon as dispatch completes —
   * well before the dispatched tasks finish — so subsequent polls can discover
   * newly arrived triage tasks promptly.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;
    if (this.polling) return;
    this.polling = true;

    try {
      const settings = await this.store.getSettings();
      this.refreshPollInterval(settings.pollIntervalMs);

      // Global pause (hard stop): halt all triage activity
      if (settings.globalPause) {
        if (!this.wasGlobalPaused) {
          planLog.log("Global pause active — triage halted");
          this.wasGlobalPaused = true;
        }
        return;
      }
      this.wasGlobalPaused = false;

      // Engine paused (soft pause): halt new triage work, but let agents finish
      if (settings.enginePaused) {
        if (!this.wasEnginePaused) {
          planLog.log(
            "Engine paused — triage halted (in-flight agents continue)",
          );
          this.wasEnginePaused = true;
        }
        return;
      }
      this.wasEnginePaused = false;

      // Fetch all tasks (not just triage) to count active agents across columns.
      const allTasks = await this.store.listTasks({ slim: true, includeArchived: false });
      const now = Date.now();

      if (this.options.semaphore) {
        const result = recoverIdleSemaphoreLeakCandidate({
          semaphore: this.options.semaphore,
          tasks: allTasks,
          candidateSinceMs: this.idleSemaphoreLeakCandidateSince,
          inFlightCount: this.processing.size,
          nowMs: now,
        });
        if (result.reconciliation?.changed) {
          planLog.warn(
            `triage: recovered stale semaphore active count ${result.reconciliation.before} -> ${result.reconciliation.after} ` +
            "(no persisted in-progress/planning/review agent work)",
          );
        }
        this.idleSemaphoreLeakCandidateSince = result.candidateSinceMs;
      }

      const eligibleTriageTasks = allTasks.filter(
        (t) => t.column === "triage" && !this.processing.has(t.id) && !t.paused
          // Skip tasks awaiting manual plan approval — they should not be auto-discovered
          && t.status !== "awaiting-approval"
          // Skip failed specifications until the user explicitly retries them.
          && t.status !== "failed"
          && t.status !== "stuck-killed"
          // Skip tasks with a recovery backoff that hasn't elapsed yet
          && !(t.nextRecoveryAt && new Date(t.nextRecoveryAt).getTime() > now),
      );
      const triageTasks = sortTasksByPriorityThenAgeAndId(eligibleTriageTasks).sort((a, b) => {
        const priorityCmp = compareTaskPriority(a.priority, b.priority);
        if (priorityCmp !== 0) {
          return priorityCmp;
        }

        // Keep the global priority contract intact, but for same-priority tasks,
        // prefer refinements so follow-up work does not starve behind bulk triage imports.
        const aIsRefinement = a.sourceType === "task_refine";
        const bIsRefinement = b.sourceType === "task_refine";
        if (aIsRefinement !== bIsRefinement) {
          return aIsRefinement ? -1 : 1;
        }

        if (a.createdAt !== b.createdAt) {
          return a.createdAt.localeCompare(b.createdAt);
        }

        return compareTaskIdNumeric(a.id, b.id);
      });

      // Respect both per-project maxTriageConcurrent and the global semaphore.
      // Only planning tasks count against the triage limit; execution is governed by maxConcurrent.
      const maxTriageConcurrent = settings.maxTriageConcurrent ?? settings.maxConcurrent ?? 2;
      const planning = allTasks.filter(
        (t) => t.column === "triage" && t.status === "planning" && !t.paused,
      ).length;
      const activeAgents = planning;

      const perProjectAvailable = Math.max(0, maxTriageConcurrent - activeAgents);
      const semaphoreAvailable = this.options.semaphore
        ? Math.max(0, this.options.semaphore.availableCount)
        : Infinity;
      const maxToStart = Math.min(perProjectAvailable, semaphoreAvailable);

      if (maxToStart <= 0 && triageTasks.length > 0) {
        const semaphoreSnapshot = this.options.semaphore?.snapshot();
        const semaphoreDetail = semaphoreSnapshot
          ? `, semaphore active=${semaphoreSnapshot.activeCount}/${semaphoreSnapshot.limit}, available=${semaphoreSnapshot.availableCount}, waiting=${semaphoreSnapshot.waitingCount}`
          : ", semaphore unavailable";
        const processingIds = [...this.processing].slice(0, 5);
        const eligibleIds = triageTasks.slice(0, 5).map((t) => t.id);
        const blockedBy = perProjectAvailable <= 0 ? "triage concurrency" : "global semaphore";
        planLog.log(
          `Plan throttled by ${blockedBy}: eligible=${triageTasks.length} [${eligibleIds.join(", ")}], ` +
          `planning=${activeAgents}/${maxTriageConcurrent}, processing=${this.processing.size}` +
          `${processingIds.length > 0 ? ` [${processingIds.join(", ")}]` : ""}${semaphoreDetail}`,
        );
      }

      for (let i = 0; i < Math.min(triageTasks.length, maxToStart); i++) {
        void this.specifyTask(triageTasks[i]);
      }
    } catch (err) {
      planLog.error("Poll error:", err);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Specify a triage task by spawning an AI agent to generate a PROMPT.md.
   *
   * After the agent writes the PROMPT.md, it calls `fn_review_spec()` to spawn
   * an independent reviewer agent that evaluates the specification quality.
   * The review loop works as follows:
   * - **APPROVE**: the spec is accepted and the task moves to `todo`
   * - **REVISE**: the agent revises the spec and calls `fn_review_spec()` again.
   *   If the agent finishes without getting APPROVE, the task is NOT moved to
   *   `todo` — a post-session gate requires an explicit APPROVE verdict.
   * - **RETHINK**: the conversation rewinds to a pre-planning checkpoint
   *   and the agent starts over with a fundamentally different approach.
   */
  async specifyTask(task: Task): Promise<void> {
    if (this.processing.has(task.id)) return;
    this.processing.add(task.id);
    this.processingSince.set(task.id, Date.now());

    planLog.log(
      `Specifying ${task.id}: ${task.title || task.description.slice(0, 60)}`,
    );
    this.options.onSpecifyStart?.(task);

    try {
      const detail = await this.store.getTask(task.id);
      // Merge per-task effective workflow settings (U3, KTD-3) over the base so the
      // planning-phase reads (requirePlanApproval, planning/validator model lanes)
      // pick up workflow values. Behavior-inert when nothing is customized.
      const settings = await mergeEffectiveSettings(this.store, task, await this.store.getSettings());
      const promptPath = `.fusion/tasks/${task.id}/PROMPT.md`;
      const isFast = task.executionMode === "fast";
      // FN-6236: this is the only legacy executionMode="fast" bridge. Downstream
      // triage policy reads resolved workflow flags instead of the raw string.
      const leanPlanning = settings.leanPlanning === true || isFast;
      const autoApproveSpec = settings.autoApproveSpec === true || isFast;

      const agentWork = async () => {
        // Set status only after the semaphore slot has been acquired, so
        // tasks waiting in the queue don't appear as "planning".
        await this.store.updateTask(task.id, { status: "planning" });

        const stuckDetector = this.options.stuckTaskDetector;

        const agentLogger = new AgentLogger({
          store: this.store,
          taskId: task.id,
          agent: "triage",
          persistAgentToolOutput: settings.persistAgentToolOutput,
          // Triage runs in a task-scoped ephemeral worker session.
          persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
          onAgentText: (id, delta) => {
            stuckDetector?.recordActivity(task.id);
            this.options.onAgentText?.(id, delta);
          },
          onAgentTool: (_id, _name) => {
            stuckDetector?.recordActivity(task.id);
            // Tool events are persisted via AgentLogger (tool/tool_result/tool_error)
            // for fn task logs and agent log history — no stdout spam
          },
        });

        // Mutable ref — populated after createFnAgent, tools access lazily via closure
        const sessionRef: { current: AgentSession | null } = { current: null };
        // Checkpoint for RETHINK rewind — captured lazily on first fn_review_spec call
        const checkpointRef: { current: string | null } = { current: null };
        // Track the last spec review verdict for post-session enforcement
        const specReviewVerdictRef: { current: ReviewVerdict | null } = {
          current: null,
        };
        // Track the user-comment fingerprint at the time of APPROVE for stale-approval detection
        const approvedCommentFingerprintRef: { current: string } = {
          current: "",
        };
        // Track subtasks created during triage when breakIntoSubtasks was requested.
        const createdSubtasksRef: { current: string[] } = { current: [] };

        const assignedAgent = task.assignedAgentId && this.options.agentStore
          ? await this.options.agentStore.getAgent(task.assignedAgentId).catch(() => null)
          : null;

        const triageRunContext = {
          runId: generateSyntheticRunId("triage", task.id),
          agentId: assignedAgent?.id ?? "triage",
          taskId: task.id,
          taskLineageId: task.lineageId,
          phase: "plan",
          source: "triage",
        } as const;

        const customTools = [
          ...this.createTriageTools({
            parentTaskId: task.id,
            allowTaskCreate: true,
            createdSubtasksRef,
          }),
          createTaskDocumentWriteTool(this.store, task.id),
          createTaskDocumentReadTool(this.store, task.id),
          createWorkflowListTool(this.store),
          createWorkflowSelectTool(this.store, task.id),
          ...(isResearchToolSurfaceEnabled(settings)
            ? createResearchTools({
              store: this.store,
              rootDir: this.rootDir,
              getSettings: async () => this.store.getSettings(),
            })
            : []),
          ...createGoalRetrievalTools(this.store, {
            runContext: {
              runId: triageRunContext.runId,
              agentId: triageRunContext.agentId,
            },
            taskId: task.id,
          }),
          ...createMemoryTools(this.rootDir, settings, assignedAgent
            ? {
              agentMemory: {
                agentId: assignedAgent.id,
                agentName: assignedAgent.name,
                memory: assignedAgent.memory,
              },
            }
            : undefined),
          createWebFetchTool(),
          // Agent delegation tools — discover and delegate work to other agents.
          ...(this.options.agentStore ? [
            createListAgentsTool(this.options.agentStore),
            createDelegateTaskTool(this.options.agentStore, this.store, { rootDir: this.rootDir }),
          ] : []),
          this.createReviewSpecTool(
            task.id,
            promptPath,
            sessionRef,
            checkpointRef,
            specReviewVerdictRef,
            approvedCommentFingerprintRef,
            settings,
            autoApproveSpec,
          ),
        ];

        let triageRuntimeHint = extractRuntimeHint(assignedAgent?.runtimeConfig);

        // Resolve per-agent custom instructions for the triage role or assigned agent.
        let triageInstructions = "";
        if (assignedAgent) {
          const memoryMode = resolveAgentMemoryInclusionMode({ agent: assignedAgent, globalSettings: settings }).mode;
          triageInstructions = await resolveAgentInstructionsWithRatings(
            assignedAgent,
            this.rootDir,
            this.options.agentStore,
            memoryMode,
          );
        } else if (this.options.agentStore) {
          try {
            const agents = await this.options.agentStore.listAgents({ role: "triage" });
            for (const agent of agents) {
              triageRuntimeHint ??= extractRuntimeHint(agent.runtimeConfig);
              if (agent.instructionsText || agent.instructionsPath || agent.soul || agent.memory) {
                const memoryMode = resolveAgentMemoryInclusionMode({ agent, globalSettings: settings }).mode;
                triageInstructions = await resolveAgentInstructions(agent, this.rootDir, undefined, memoryMode);
                break;
              }
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            planLog.warn(`${task.id}: failed to resolve triage agent instructions, continuing with defaults: ${msg}`);
          }
        }
        planLog.log(`${task.id}: planning in ${leanPlanning ? "fast" : "standard"} mode`);
        const triageIdentitySection = assignedAgent
          ? `## Identity\n\nYou are ${assignedAgent.name}${assignedAgent.title?.trim() ? `, ${assignedAgent.title.trim()}` : ""} (agent ID: ${assignedAgent.id}, role: ${assignedAgent.role}).`
          : "";
        // Build structured layers for cross-session prompt caching.
        const triagePluginContributions = buildPluginPromptSection(
          "triage",
          this.options.pluginRunner,
        );
        if (triagePluginContributions) {
          planLog.log(`${task.id}: applied plugin prompt contributions for triage surface`);
        }

        const runAuditor = createRunAuditor(this.store, triageRunContext);
        const triageGoalResolution = await resolveAndEmitGoalContext({
          lane: "planning",
          store: this.store,
          audit: runAuditor,
          taskId: task.id,
          runContext: triageRunContext,
        });

        const workflowPlanningPrompt = leanPlanning
          ? undefined
          : await resolveTaskPlanningPrompt(this.store, task.id).catch(() => undefined);
        const workflowFastPlanningPrompt = leanPlanning
          ? await resolveTaskSeamPrompt(this.store, task.id, "planning-fast").catch(() => undefined)
          : undefined;
        // FN-6232: standard-mode built-in triage policy is sourced from the workflow IR planning node; the former engine duplicate was removed.
        const userTriagePrompt = settings.agentPrompts?.roleAssignments?.triage
          ? resolveAgentPrompt("triage", settings.agentPrompts)
          : "";
        const defaultTriagePrompt = resolveAgentPrompt("triage");
        const resolvedBasePrompt = userTriagePrompt
          || (leanPlanning
            ? (workflowFastPlanningPrompt || builtinSeamPrompt("planning-fast") || defaultTriagePrompt)
            : (workflowPlanningPrompt || defaultTriagePrompt));
        // Apply the workflow-native triage policy renderer to both standard and
        // fast prompts. Fast mode currently has no policy placeholders, making
        // this a no-op there while still guaranteeing no dangling token leaks.
        const renderedBasePrompt = renderTriagePolicyPlaceholders(resolvedBasePrompt, settings);
        const triageLayers = buildPromptLayers({
          basePrompt: renderedBasePrompt,
          goalContext: triageGoalResolution.goalContext,
          agentInstructions: [
            triageIdentitySection,
            triageInstructions,
            isResearchToolSurfaceEnabled(settings)
              ? getResearchGuidanceForSurface("triage")
              : "",
          ].filter((section) => section.trim()).join("\n\n"),
          pluginContributions: triagePluginContributions,
        });

        const triageSystemPromptFinal = collapsePromptLayers(triageLayers);

        // Build skill selection context (assigned agent skills take precedence over role fallback)
        const skillContext = await buildSessionSkillContext({
          agentStore: this.options.agentStore!,
          task,
          sessionPurpose: "triage",
          projectRootDir: this.rootDir,
          pluginRunner: this.options.pluginRunner,
        });

        // Resolve planning model using executor-style precedence:
        // 1. Task planning override pair
        // 2. Planning/project/global fallbacks
        // 3. Assigned durable agent runtime model pair when no fresh model pair exists
        const planningModel = resolvePlanningSessionModel(
          task.planningModelProvider,
          task.planningModelId,
          settings,
          assignedAgent?.runtimeConfig,
        );

        const planningSessionModelOptions = {
          defaultProvider: planningModel.provider,
          defaultModelId: planningModel.modelId,
        };

        let { session } = await createResolvedAgentSession({
          sessionPurpose: "triage",
          runtimeHint: triageRuntimeHint,
          pluginRunner: this.options.pluginRunner,
          cwd: this.rootDir,
          systemPrompt: triageSystemPromptFinal,
          systemPromptLayers: triageLayers,
          tools: "coding",
          customTools,
          onText: agentLogger.onText,
          onThinking: agentLogger.onThinking,
          onToolStart: agentLogger.onToolStart,
          onToolEnd: agentLogger.onToolEnd,
          ...planningSessionModelOptions,
          fallbackProvider: settings.planningFallbackProvider && settings.planningFallbackModelId
            ? settings.planningFallbackProvider
            : settings.fallbackProvider,
          fallbackModelId: settings.planningFallbackProvider && settings.planningFallbackModelId
            ? settings.planningFallbackModelId
            : settings.fallbackModelId,
          defaultThinkingLevel: settings.defaultThinkingLevel,
          runAuditor,
          settings,
          // Skill selection: use assigned agent skills if available, otherwise role fallback
          ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
          taskId: task.id,
          taskTitle: task.title,
          onFallbackModelUsed: createFallbackModelObserver({
            agent: "triage",
            label: "triage",
            store: this.store,
            taskId: task.id,
            taskTitle: task.title,
          }),
        });

        const modelDesc = describeModel(session);
        planLog.log(`${task.id}: using model ${modelDesc}`);
        await this.store.logEntry(task.id, `Triage using model: ${modelDesc}`);
        await this.store.appendAgentLog(
          task.id,
          `Triage using model: ${modelDesc}`,
          "text",
          undefined,
          "triage",
        );

        // Make session available to fn_review_spec tool (for RETHINK rewind)
        sessionRef.current = session;

        // Register session so the global pause listener can terminate it
        this.activeSessions.set(task.id, session);

        // Register with stuck task detector for heartbeat monitoring
        stuckDetector?.trackTask(task.id, session);
        stuckDetector?.recordActivity(task.id);

        try {
          // Read attachment contents for inlining in prompt
          const { attachmentContents, imageContents } =
            await readAttachmentContents(
              this.rootDir,
              detail.id,
              detail.attachments,
            );

          // Check if this is a re-planning request
          const isReplan = task.status === "needs-replan";
          let existingPrompt: string | undefined;
          let feedback: string | undefined;

          if (isReplan) {
            // Prefer explicit re-specification feedback logged by comment-triggered
            // and approval-invalidation flows; fall back to legacy revision logs.
            const feedbackLogEntry = [...task.log]
              .reverse()
              .find((entry) =>
                entry.action === "User comment requested re-specification of planned task"
                || entry.action === "User comment invalidated spec approval — task needs re-specification"
                || entry.action === "AI spec revision requested"
              );
            feedback = feedbackLogEntry?.outcome;

            // Ensure the latest user feedback is always actionable for re-plans.
            if (!feedback) {
              const latestUserComment = [...(detail.comments || [])]
                .reverse()
                .find((comment) => comment.author === "user");
              feedback = latestUserComment?.text;
            }

            planLog.log(
              `${task.id} re-planning with feedback: ${feedback?.slice(0, 100)}...`,
            );
          }

          const agentPrompt = buildSpecificationPrompt(
            detail,
            promptPath,
            settings,
            attachmentContents,
            existingPrompt,
            feedback,
          );
          await promptWithFallback(
            session,
            agentPrompt,
            imageContents.length > 0 ? { images: imageContents } : undefined,
          );

          // Re-raise errors that pi-coding-agent swallowed after exhausting retries.
          checkSessionError(session);

          if (this.pauseAborted.has(task.id)) {
            this.pauseAborted.delete(task.id);
            planLog.log(`${task.id} aborted by pause — clearing status`);
            const restoreStatus = task.status === "needs-replan" ? "needs-replan" : null;
            await this.store.updateTask(task.id, { status: restoreStatus }).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              planLog.warn(`${task.id}: failed to restore status to '${restoreStatus}' during pause-abort cleanup: ${msg}`);
            });
            return;
          }

          if (this.stuckAborted.has(task.id)) {
            this.stuckAborted.delete(task.id);
            planLog.log(`${task.id} killed by stuck detector — clearing status for retry`);
            const restoreStatus = task.status === "needs-replan" ? "needs-replan" : null;
            await this.store.updateTask(task.id, { status: restoreStatus }).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              planLog.warn(`${task.id}: failed to restore status to '${restoreStatus}' during stuck-detector abort cleanup: ${msg}`);
            });
            return;
          }

          if (createdSubtasksRef.current.length > 0) {
            const childTaskIds = createdSubtasksRef.current.join(", ");
            await this.store.logEntry(
              task.id,
              `Converted into subtasks: ${childTaskIds}`,
            );
            try {
              // FN-5129 / FN-5131: split-close must unlink lineage children when deleting the parent.
              await this.store.deleteTask(task.id, {
                removeLineageReferences: true,
                auditContext: {
                  agentId: task.assignedAgentId ?? "triage",
                  runId: generateSyntheticRunId("triage-delete", task.id),
                },
              });
              planLog.log(`✓ ${task.id} split into subtasks (${childTaskIds}) and closed`);
            } catch (err: unknown) {
              // deleteTask refuses when live tasks still depend on this id.
              // If fn_task_create's validation worked correctly this branch is
              // unreachable, but we keep it as defense-in-depth: leaving the
              // parent alive is always safer than stranding dependents.
              const msg = err instanceof Error ? err.message : String(err);
              planLog.error(
                `${task.id}: cannot close parent after split (${msg}). ` +
                  `Parent kept alive to avoid orphaning dependents; subtasks were still created.`,
              );
              await this.store.logEntry(
                task.id,
                `Split-close aborted: ${msg}. Subtasks created but parent kept alive to avoid orphaning dependents.`,
              );
            }
            return;
          }

          // Before swapping to the fallback model, give the primary one more
          // shot with a pointed reminder. The model may have written PROMPT.md
          // but stopped without calling fn_review_spec — that's recoverable
          // with a nudge, no need to discard the session and pay the cold-start
          // tax of a new triage on a different model.
          const MAX_REVIEW_REMINDERS = 2;
          let reviewReminders = 0;
          while (
            specReviewVerdictRef.current !== "APPROVE" &&
            !this.pauseAborted.has(task.id) &&
            !this.stuckAborted.has(task.id) &&
            createdSubtasksRef.current.length === 0 &&
            reviewReminders < MAX_REVIEW_REMINDERS
          ) {
            reviewReminders += 1;
            const verdictDesc =
              specReviewVerdictRef.current === null
                ? "fn_review_spec was never called"
                : `verdict was ${specReviewVerdictRef.current}`;
            planLog.warn(
              `${task.id} primary planning model returned without APPROVE (${verdictDesc}) — reminder ${reviewReminders}/${MAX_REVIEW_REMINDERS}`,
            );
            await this.store.logEntry(
              task.id,
              `Primary planning model returned without APPROVE (${verdictDesc}) — reminder ${reviewReminders}/${MAX_REVIEW_REMINDERS}`,
            );
            const reminder =
              specReviewVerdictRef.current === null
                ? "You wrote the PROMPT.md but did not call `fn_review_spec()`. Call `fn_review_spec()` now to validate the spec. Do not stop until the verdict is APPROVE."
                : `Spec review verdict was ${specReviewVerdictRef.current}. Address the feedback, rewrite the PROMPT.md as needed, and call \`fn_review_spec()\` again. Do not stop until the verdict is APPROVE.`;
            stuckDetector?.recordActivity(task.id);
            await promptWithFallback(session, reminder);
            checkSessionError(session);
            if (this.pauseAborted.has(task.id) || this.stuckAborted.has(task.id)) {
              break;
            }
          }

          const planningFallbackProvider = settings.planningFallbackProvider;
          const planningFallbackModelId = settings.planningFallbackModelId;
          const canRetryWithPlanningFallback =
            specReviewVerdictRef.current !== "APPROVE" &&
            planningFallbackProvider &&
            planningFallbackModelId &&
            modelDesc !== `${planningFallbackProvider}/${planningFallbackModelId}`;

          if (canRetryWithPlanningFallback) {
            const verdictDesc =
              specReviewVerdictRef.current === null
                ? "fn_review_spec was never called"
                : `verdict was ${specReviewVerdictRef.current}`;
            const fallbackDesc = `${planningFallbackProvider}/${planningFallbackModelId}`;
            planLog.warn(
              `${task.id} primary planning model produced no approved spec (${verdictDesc}) — retrying with fallback ${fallbackDesc}`,
            );
            await this.store.logEntry(
              task.id,
              `Primary planning model produced no approved spec (${verdictDesc}) — retrying with fallback ${fallbackDesc}`,
            );

            session.dispose();
            this.activeSessions.delete(task.id);
            stuckDetector?.untrackTask(task.id);
            specReviewVerdictRef.current = null;
            approvedCommentFingerprintRef.current = "";

            const fallbackResult = await createResolvedAgentSession({
              sessionPurpose: "triage",
              runtimeHint: triageRuntimeHint,
              pluginRunner: this.options.pluginRunner,
              cwd: this.rootDir,
              systemPrompt: triageSystemPromptFinal,
              systemPromptLayers: triageLayers,
              tools: "coding",
              customTools,
              onText: agentLogger.onText,
              onThinking: agentLogger.onThinking,
              onToolStart: agentLogger.onToolStart,
              onToolEnd: agentLogger.onToolEnd,
              defaultProvider: planningFallbackProvider,
              defaultModelId: planningFallbackModelId,
              defaultThinkingLevel: settings.defaultThinkingLevel,
              runAuditor,
              settings,
              ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
              taskId: task.id,
              taskTitle: task.title,
              onFallbackModelUsed: createFallbackModelObserver({
                agent: "triage",
                label: "triage",
                store: this.store,
                taskId: task.id,
                taskTitle: task.title,
              }),
            });

            session = fallbackResult.session;
            const fallbackModelDesc = describeModel(session);
            planLog.log(`${task.id}: using fallback model ${fallbackModelDesc}`);
            await this.store.logEntry(task.id, `Triage using fallback model: ${fallbackModelDesc}`);
            await this.store.appendAgentLog(
              task.id,
              `Triage using fallback model: ${fallbackModelDesc}`,
              "text",
              undefined,
              "triage",
            );

            sessionRef.current = session;
            this.activeSessions.set(task.id, session);
            stuckDetector?.trackTask(task.id, session);
            stuckDetector?.recordActivity(task.id);

            await promptWithFallback(
              session,
              agentPrompt,
              imageContents.length > 0 ? { images: imageContents } : undefined,
            );
            checkSessionError(session);

            if (createdSubtasksRef.current.length > 0) {
              const childTaskIds = createdSubtasksRef.current.join(", ");
              await this.store.logEntry(
                task.id,
                `Converted into subtasks: ${childTaskIds}`,
              );
              // FN-5129 / FN-5131: split-close must unlink lineage children when deleting the parent.
              await this.store.deleteTask(task.id, {
                removeLineageReferences: true,
                auditContext: {
                  agentId: task.assignedAgentId ?? "triage",
                  runId: generateSyntheticRunId("triage-delete", task.id),
                },
              });
              planLog.log(`✓ ${task.id} split into subtasks (${childTaskIds}) and closed`);
              return;
            }
          }

          const written = await readFile(
            join(this.rootDir, promptPath),
            "utf-8",
          ).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            planLog.warn(`${task.id}: failed to read generated PROMPT.md before finalization (${promptPath}): ${msg}`);
            return "";
          });

          // FN-5220: planning agents that emit a `DUPLICATE: FN-NNNN` redirect
          // do not call `fn_review_spec()`; short-circuit the APPROVE gate.
          if (await this.tryFinalizeExplicitDuplicateMarker(task, written, settings, {
            isReplan,
            feedback,
          })) {
            this.options.onSpecifyComplete?.(task);
            return;
          }

          // Post-session APPROVE gate: only advance to todo when the spec
          // reviewer explicitly approved. Any other verdict (REVISE,
          // RETHINK, UNAVAILABLE) or a missing review (null) stays in triage
          // and is retried with bounded backoff instead of immediately failing.
          if (specReviewVerdictRef.current !== "APPROVE") {
            const verdictDesc =
              specReviewVerdictRef.current === null
                ? "fn_review_spec was never called"
                : `verdict was ${specReviewVerdictRef.current}`;
            const decision = computeRecoveryDecision({
              recoveryRetryCount: task.recoveryRetryCount,
              nextRecoveryAt: task.nextRecoveryAt,
            });

            if (decision.shouldRetry) {
              const attempt = decision.nextState.recoveryRetryCount;
              const delay = formatDelay(decision.delayMs);
              const retryMessage =
                `Spec review not approved (${verdictDesc}) — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}.`;
              planLog.warn(`${task.id} ${retryMessage}`);
              await this.store.logEntry(task.id, retryMessage);
              const restoreStatus = task.status === "needs-replan" ? "needs-replan" : null;
              await this.store.updateTask(task.id, {
                status: restoreStatus,
                error: null,
                recoveryRetryCount: decision.nextState.recoveryRetryCount,
                nextRecoveryAt: decision.nextState.nextRecoveryAt,
              });
              return;
            }

            const failureMessage =
              `Specification failed after ${MAX_RECOVERY_RETRIES} unapproved spec reviews (${verdictDesc}). ` +
              "Retry after adjusting the task prompt or model.";
            planLog.log(
              `${task.id} spec review not approved (${verdictDesc}) — retry budget exhausted`,
            );
            await this.store.logEntry(
              task.id,
              failureMessage,
            );
            await this.store.updateTask(task.id, {
              status: "failed",
              error: failureMessage,
              recoveryRetryCount: null,
              nextRecoveryAt: null,
            });
            return;
          }

          // Stale-approval detection: re-read the task to check if new user
          // comments arrived after the spec was approved.  If the comment
          // fingerprint changed, the approval is stale and the task needs
          // re-planning.
          const latestTask = await this.store.getTask(task.id);
          const currentFingerprint = computeUserCommentFingerprint(latestTask.comments);
          if (currentFingerprint !== approvedCommentFingerprintRef.current) {
            planLog.log(
              `${task.id} stale approval detected — user comments changed after approval, triggering re-planning`,
            );
            await this.store.logEntry(
              task.id,
              "Spec approval invalidated — new user comments arrived after approval. Task needs re-planning.",
            );
            await this.store.updateTask(task.id, { status: "needs-replan" });
            return;
          }

          await this.finalizeApprovedTask(task, written, settings, {
            isReplan,
            feedback,
          });
          this.options.onSpecifyComplete?.(task);
        } finally {
          this.activeSessions.delete(task.id);
          stuckDetector?.untrackTask(task.id);
          await agentLogger.flush();
          session.dispose();
        }
      };

      const retryableWork = () => withRateLimitRetry(agentWork, {
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          planLog.warn(`⏳ ${task.id} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
          this.store.logEntry(task.id, `Rate limited — retry ${attempt} in ${delaySec}s`).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            planLog.warn(`${task.id}: failed to log rate-limit retry entry: ${msg}`);
          });
        },
      });

      if (this.options.semaphore) {
        await this.options.semaphore.run(retryableWork, PRIORITY_SPECIFY);
      } else {
        await retryableWork();
      }
    } catch (err: unknown) {
      const { message: errorMessage, detail: errorDetail, stack: errorStack } = formatError(err);
      // Race condition: task was deleted (e.g. as a duplicate) between listTasks()
      // and specifyTask(). The file is gone, so just log and skip — no point retrying.
      if ((err as Record<string, unknown>).code === "ENOENT") {
        planLog.log(`${task.id} no longer exists — skipping`);
      } else if (err instanceof TaskDeletedError) {
        planLog.log(`[triage] ${task.id}: skipping spec write — task soft-deleted`);
        this.disposeSubagentsForTask(task.id, "task soft-deleted");
        return;
      } else if (this.pauseAborted.has(task.id)) {
        // Pause (global or engine) — clear planning status without reporting an error
        this.pauseAborted.delete(task.id);
        planLog.log(`${task.id} aborted by pause — clearing status`);
        // For re-planning, restore needs-replan status; otherwise clear to null
        // so the next poll can re-pick this task up.
        const restoreStatus = task.status === "needs-replan" ? "needs-replan" : null;
        await this.store.updateTask(task.id, { status: restoreStatus }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          planLog.warn(`${task.id}: failed to restore status to '${restoreStatus}' during pause-abort error cleanup: ${msg}`);
        });
      } else if (this.stuckAborted.has(task.id)) {
        // Stuck task detector killed this session — clear planning status so the
        // next poll retries the task from scratch without reporting an error.
        this.stuckAborted.delete(task.id);
        planLog.log(`${task.id} killed by stuck detector — clearing status for retry`);
        const restoreStatus = task.status === "needs-replan" ? "needs-replan" : null;
        await this.store.updateTask(task.id, { status: restoreStatus }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          planLog.warn(`${task.id}: failed to restore status to '${restoreStatus}' during stuck-detector error cleanup: ${msg}`);
        });
      } else {
        // Check if the error is a usage-limit error and trigger global pause
        if (this.options.usageLimitPauser && isUsageLimitError(errorMessage)) {
          await this.options.usageLimitPauser.onUsageLimitHit(
            "triage",
            task.id,
            errorMessage,
          );
        } else if (isTransientError(errorMessage)) {
          // Transient network/infrastructure error — use bounded recovery policy
          const decision = computeRecoveryDecision({
            recoveryRetryCount: task.recoveryRetryCount,
            nextRecoveryAt: task.nextRecoveryAt,
          });

          if (decision.shouldRetry) {
            const attempt = decision.nextState.recoveryRetryCount;
            const delay = formatDelay(decision.delayMs);
            // Silent transient errors (e.g., "request was aborted") are noisy — skip logging
            if (!isSilentTransientError(errorMessage)) {
              planLog.warn(`⚡ ${task.id} transient error during triage — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}: ${errorMessage}`);
              await this.store.logEntry(task.id, `Transient error during specification (retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                planLog.warn(`${task.id}: failed to log transient-error retry entry: ${msg}`);
              });
            }
            const restoreStatus = task.status === "needs-replan" ? "needs-replan" : null;
            await this.store.updateTask(task.id, {
              status: restoreStatus,
              recoveryRetryCount: decision.nextState.recoveryRetryCount,
              nextRecoveryAt: decision.nextState.nextRecoveryAt,
            }).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              planLog.warn(`${task.id}: failed to restore status to '${restoreStatus}' during transient-error retry scheduling: ${msg}`);
            });
            return;
          }

          // Recovery budget exhausted — freeze in triage with error for manual intervention
          planLog.error(`✗ ${task.id} transient error retries exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorMessage}`);
          await this.store.logEntry(task.id, `Specification failed after ${MAX_RECOVERY_RETRIES} transient errors: ${errorMessage}`).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            planLog.warn(`${task.id}: failed to log transient-error retries-exhausted entry: ${msg}`);
          });
          await this.store.updateTask(task.id, {
            error: `Specification failed after ${MAX_RECOVERY_RETRIES} transient errors: ${errorMessage}`,
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            planLog.warn(`${task.id}: failed to persist transient-error retries-exhausted state: ${msg}`);
          });
          this.options.onSpecifyError?.(task, err instanceof Error ? err : new Error(errorMessage));
          return;
        }
        // For re-planning, restore needs-replan status so it can be retried;
        // otherwise clear to null so the next poll can re-pick the task up.
        const restoreStatus = task.status === "needs-replan" ? "needs-replan" : null;
        await this.store.updateTask(task.id, { status: restoreStatus }).catch((restoreErr: unknown) => {
          const msg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
          planLog.warn(`${task.id}: failed to restore status to '${restoreStatus}' after planning error: ${msg}`);
        });
        planLog.error(`✗ ${task.id} planning failed:`, errorDetail);
        if (errorStack) {
          await this.store.logEntry(task.id, `Specification failed: ${errorMessage}`, errorStack).catch((logErr: unknown) => {
            const msg = logErr instanceof Error ? logErr.message : String(logErr);
            planLog.warn(`${task.id}: failed to persist specification-failure stack trace: ${msg}`);
          });
        }
        this.options.onSpecifyError?.(task, err instanceof Error ? err : new Error(errorMessage));
      }
    } finally {
      this.processing.delete(task.id);
      this.processingSince.delete(task.id);
    }
  }

  private createTriageTools(options: {
    parentTaskId: string;
    allowTaskCreate: boolean;
    createdSubtasksRef: { current: string[] };
  }): ToolDefinition[] {
    const store = this.store;

    const taskGetParams = Type.Object({
      id: Type.String({ description: "Task ID (e.g. KB-001)" }),
    });
    const taskCreatePriorityValues = ["low", "normal", "high", "urgent"] as const;
    const taskSearchParams = Type.Object({
      query: Type.String({ minLength: 1, description: "Search query" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: "Max results (default 20, max 50)" })),
      includeDone: Type.Optional(Type.Boolean({ description: "Include done tasks (default true)" })),
      includeArchived: Type.Optional(Type.Boolean({ description: "Include archived tasks (default true)" })),
    });
    const taskCreateParams = Type.Object({
      title: Type.Optional(Type.String({ description: "Short child task title" })),
      description: Type.String({ description: "Child task description/mission" }),
      dependencies: Type.Optional(
        Type.Array(Type.String({ description: "Task ID dependency (e.g. KB-001)" })),
      ),
      priority: Type.Optional(
        Type.Union(taskCreatePriorityValues.map((priority) => Type.Literal(priority)), {
          description: "Task priority (low, normal, high, urgent)",
        }),
      ),
      workflow_id: Type.Optional(
        Type.String({
          description: "Workflow ID to assign (e.g. 'builtin:coding', 'builtin:quick-fix'). Use fn_workflow_list to discover valid IDs.",
        }),
      ),
      noCommitsExpected: Type.Optional(
        Type.Boolean({
          description: "Set true for investigation/audit/decision tasks that produce no code changes.",
        }),
      ),
    });

    const taskList: ToolDefinition = {
      name: "fn_task_list",
      label: "List Tasks",
      description:
        "List all tasks that aren't done. Returns ID, description, column, " +
        "and dependencies for each. Use to check for duplicates before planning.",
      parameters: Type.Object({}),
      execute: async () => {
        const tasks = await store.listTasks({ slim: true, includeArchived: false });
        const active = tasks.filter((t) => t.column !== "done");
        if (active.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No active tasks." }],
            details: {},
          };
        }
        const lines = active.map((t) => {
          const desc = t.title || t.description.slice(0, 80);
          const deps = t.dependencies.length
            ? ` [deps: ${t.dependencies.join(", ")}]`
            : "";
          return `${t.id} (${t.column}): ${desc}${deps}`;
        });
        /*
        FNXC:TaskListOutput 2026-06-16-17:47:
        FN-6492 keeps engine triage duplicate-detection listings bounded with the shared fn_task_list text clamp so large active boards never require attachment/image fallback.

        FNXC:TaskListOutput 2026-06-17-05:47:
        FN-6570 guards the triage fn_task_list formatter against stale @fusion/core runtime namespaces where clampTaskListText is absent, so duplicate-detection board reads degrade to bounded text instead of throwing.

        FNXC:TaskListOutput 2026-06-17-07:25:
        FN-6573 requires engine triage fn_task_list to resolve formatTaskListText from the runtime @fusion/core namespace with a typeof guard and a self-contained bounded fallback. A stale @fusion/core dist missing the FN-6570 formatter export crashed ambient heartbeat agents as `(0 , _core.formatTaskListText) is not a function`; duplicate detection must now return bounded text instead.
        */
        const formatter = resolveTaskListFormatter(fusionCore);
        return {
          content: [{ type: "text" as const, text: formatter(lines, { clamp: fusionCore.clampTaskListText }) }],
          details: {},
        };
      },
    };

    const taskSearch: ToolDefinition = {
      name: "fn_task_search",
      label: "Search Tasks",
      description:
        "Keyword search across tasks, including done and archived tasks by default. " +
        "Use for duplicate detection before filing a new task.",
      parameters: taskSearchParams,
      execute: async (
        _callId: string,
        params: Static<typeof taskSearchParams>,
      ) => {
        const query = params.query.trim();
        if (query.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No tasks matched." }],
            details: {},
          };
        }
        const results = await store.searchTasks(query, {
          slim: true,
          includeArchived: params.includeArchived ?? true,
          limit: params.limit ?? 20,
        });
        const includeDone = params.includeDone ?? true;
        const filtered = includeDone
          ? results
          : results.filter((t) => t.column !== "done");
        if (filtered.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No tasks matched." }],
            details: {},
          };
        }
        const lines = filtered.map((t) => {
          const desc = t.title || t.description.slice(0, 80);
          const deps = t.dependencies.length
            ? ` [deps: ${t.dependencies.join(", ")}]`
            : "";
          return `${t.id} (${t.column}): ${desc}${deps}`;
        });
        return {
          content: [{ type: "text" as const, text: `Search results for "${query}" (${filtered.length}):\n${lines.join("\n")}` }],
          details: {},
        };
      },
    };

    const taskGet: ToolDefinition = {
      name: "fn_task_get",
      label: "Get Task",
      description:
        "Get full details of a specific task including its PROMPT.md content. " +
        "Use to verify duplicates and to read dependency task specs before writing a new PROMPT.md.",
      parameters: taskGetParams,
      execute: async (
        _callId: string,
        params: Static<typeof taskGetParams>,
      ) => {
        try {
          const task = await store.getTask(params.id);
          const parts = [
            `ID: ${task.id}`,
            `Column: ${task.column}`,
            `Description: ${task.description}`,
            task.dependencies.length
              ? `Dependencies: ${task.dependencies.join(", ")}`
              : null,
            "",
            "PROMPT.md:",
            task.prompt || "(not yet specified)",
          ].filter(Boolean);
          return {
            content: [{ type: "text" as const, text: parts.join("\n") }],
            details: {},
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          planLog.warn(`${options.parentTaskId}: fn_task_get lookup failed for ${params.id}: ${msg}`);
          return {
            content: [
              { type: "text" as const, text: `Task ${params.id} not found.` },
            ],
            details: {},
          };
        }
      },
    };

    const taskCreate: ToolDefinition = {
      name: "fn_task_create",
      label: "Create Child Task",
      description:
        "Create a child task (subtask) while breaking a larger task into smaller pieces. " +
        "Use this when the work can be split into 2-5 independently executable tasks, " +
        "either because the user requested subtask breakdown or because the task is " +
        "genuinely oversized (12+ steps OR multiple clearly independent deliverables that could ship separately). " +
        "The created task will be a child of the current task being triaged. " +
        "IMPORTANT: `dependencies` may ONLY reference other subtasks you have created " +
        "in this same triage session. Never depend on the parent task — the parent is " +
        "deleted after splitting, and stale dependency ids permanently block the dependent.",
      parameters: taskCreateParams,
      execute: async (
        _callId: string,
        params: Static<typeof taskCreateParams>,
      ) => {
        // fn_task_create is always available during triage to support both
        // explicit breakIntoSubtasks and proactive splitting of oversized tasks.
        try {
          // Validate dependencies before creating the child:
          //   1. Cannot depend on the parent (it's about to be deleted).
          //   2. Each id must either (a) already exist in the store, or
          //      (b) reference a sibling created earlier in this split.
          // This is the load-bearing guard that prevents the AI from stranding
          // children behind a never-to-exist parent id.
          const requestedDeps = params.dependencies || [];
          const siblings = new Set(options.createdSubtasksRef.current);
          const validDeps: string[] = [];
          const rejected: Array<{ id: string; reason: string }> = [];

          for (const depId of requestedDeps) {
            if (depId === options.parentTaskId) {
              rejected.push({
                id: depId,
                reason: "parent task is deleted after splitting; depend on a sibling child task instead",
              });
              continue;
            }
            if (siblings.has(depId)) {
              validDeps.push(depId);
              continue;
            }
            try {
              await store.getTask(depId);
              validDeps.push(depId);
            } catch {
              rejected.push({
                id: depId,
                reason: "task not found (only existing tasks or siblings created earlier in this split are allowed)",
              });
            }
          }

          if (rejected.length > 0) {
            const summary = rejected
              .map((r) => `  - ${r.id}: ${r.reason}`)
              .join("\n");
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `ERROR: fn_task_create rejected. Invalid dependencies:\n${summary}\n\n` +
                    `Remove or replace these ids and call fn_task_create again.`,
                },
              ],
              details: { rejectedDependencies: rejected },
            };
          }

          // Fetch parent task to inherit model settings
          let parentTask: Awaited<ReturnType<typeof store.getTask>> | undefined;
          try {
            parentTask = await store.getTask(options.parentTaskId);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            planLog.warn(`${options.parentTaskId}: failed to load parent task for fn_task_create inheritance: ${msg}`);
            // Parent task not found or error - proceed without inheritance
            parentTask = undefined;
          }

          const { task: newTask, wasDuplicate } = await createAgentTask(store, {
            title: params.title,
            description: params.description,
            dependencies: validDeps,
            column: "triage",
            priority: params.priority,
            workflowId: params.workflow_id,
            noCommitsExpected: params.noCommitsExpected,
            // Inherit parent's model settings if available
            modelProvider: parentTask?.modelProvider,
            modelId: parentTask?.modelId,
            validatorModelProvider: parentTask?.validatorModelProvider,
            validatorModelId: parentTask?.validatorModelId,
            source: {
              sourceType: "agent_heartbeat",
              sourceParentTaskId: options.parentTaskId,
            },
          }, { rootDir: this.rootDir });

          // Track the created subtask
          options.createdSubtasksRef.current.push(newTask.id);

          return {
            content: [
              {
                type: "text" as const,
                text: `${wasDuplicate ? "Linked existing child task" : "Created child task"} ${newTask.id}: ${params.title || params.description.slice(0, 60)}`,
              },
            ],
            details: { taskId: newTask.id },
          };
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: `ERROR: Failed to create task: ${errorMessage}`,
              },
            ],
            details: {},
          };
        }
      },
    };

    return [taskList, taskSearch, taskGet, taskCreate];
  }

  /**
   * Create the `fn_review_spec` tool for the triage agent.
   *
   * Spawns an independent reviewer agent to evaluate the generated PROMPT.md.
   * Verdict handling:
   * - **APPROVE**: returns "APPROVE" — the triage agent's work is done.
   * - **REVISE**: returns the review feedback. The triage agent must fix the
   *   PROMPT.md and call `fn_review_spec` again. A post-session gate in
   *   `specifyTask()` prevents moving to `todo` if the last verdict is REVISE.
   * - **RETHINK**: rewinds the conversation to a pre-planning checkpoint
   *   using `session.navigateTree()`. Returns a re-prompt instructing the agent
   *   to take a fundamentally different approach.
   */
  private createReviewSpecTool(
    taskId: string,
    promptPath: string,
    sessionRef: { current: AgentSession | null },
    checkpointRef: { current: string | null },
    specReviewVerdictRef: { current: ReviewVerdict | null },
    approvedCommentFingerprintRef: { current: string },
    _settings: {
      defaultProvider?: string;
      defaultModelId?: string;
      defaultThinkingLevel?: string;
      validatorProvider?: string;
      validatorModelId?: string;
    },
    skipSpecReview: boolean,
  ): ToolDefinition {
    const store = this.store;
    const rootDir = this.rootDir;
    const options = this.options;

    return {
      name: "fn_review_spec",
      label: "Review Specification",
      description:
        "Spawn a reviewer agent to evaluate the generated PROMPT.md specification. " +
        "Returns APPROVE, REVISE, RETHINK, or UNAVAILABLE. " +
        "Call after writing the PROMPT.md.",
      parameters: Type.Object({}),
      execute: async () => {
        reviewerLog.log(`${taskId}: spec review requested`);
        await store.logEntry(taskId, "Spec review requested");

        // Capture checkpoint lazily on first call — at this point the session
        // has already started and has a valid conversation state to rewind to.
        if (!checkpointRef.current && sessionRef.current) {
          checkpointRef.current =
            sessionRef.current.sessionManager.getLeafId() ?? null;
        }

        try {
          // Read the generated PROMPT.md from disk
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const promptContent = await readFile(
            join(rootDir, promptPath),
            "utf-8",
          ).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            planLog.warn(`${taskId}: failed to read PROMPT.md for fn_review_spec (${promptPath}): ${msg}`);
            return "";
          });

          if (!promptContent) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "UNAVAILABLE — PROMPT.md file not found or empty. Write the specification first, then call fn_review_spec.",
                },
              ],
              details: {},
            };
          }

          const danglingRefs = await detectDanglingTaskDocReferences(promptContent, {
            rootDir,
            taskId,
          });
          if (danglingRefs.length > 0) {
            const diagnostic = formatDanglingDiagnostic(danglingRefs);
            specReviewVerdictRef.current = "REVISE";
            planLog.warn(`${taskId}: ${diagnostic}`);
            await store.logEntry(taskId, "Spec review: REVISE (dangling task-document references)");
            return {
              content: [{ type: "text" as const, text: diagnostic }],
              details: {},
            };
          }

          const evidenceGaps = detectExternalIntegrationEvidenceGaps({
            promptContent,
          });
          if (evidenceGaps.length > 0) {
            const diagnostic = formatExternalIntegrationEvidenceDiagnostic(evidenceGaps);
            specReviewVerdictRef.current = "REVISE";
            planLog.warn(`${taskId}: ${diagnostic}`);
            await store.logEntry(taskId, "Spec review: REVISE (external-integration evidence gaps)");
            return {
              content: [{ type: "text" as const, text: diagnostic }],
              details: {},
            };
          }

          // Re-read task detail to get latest user comments
          const currentDetail = await store.getTask(taskId);
          const currentUserComments = (currentDetail.comments || []).filter(
            (c: any) => c.author === "user",
          );

          if (skipSpecReview) {
            specReviewVerdictRef.current = "APPROVE";
            approvedCommentFingerprintRef.current = currentUserComments.length > 0
              ? computeUserCommentFingerprint(currentUserComments)
              : "";
            planLog.log(`${taskId}: spec review auto-approved (auto-approve spec)`);
            await store.logEntry(taskId, "Spec review: APPROVE (auto-approve spec)");
            return { content: [{ type: "text" as const, text: "APPROVE" }], details: {} };
          }

          // Re-read settings at review time so long-lived triage sessions pick up
          // model changes made after the session started. Merge per-task effective
          // workflow settings (U3, KTD-3) so the validator model-lane reads below
          // pick up workflow values. Behavior-inert when nothing is customized.
          const currentSettings = await mergeEffectiveSettings(store, currentDetail, await store.getSettings());

          // Spec reviewer runs via semaphore.runNested so it transiently
          // bumps activeCount for honest observability while bypassing the
          // wait queue (no fairness regression at low maxConcurrent). See
          // concurrency.ts:runNested for the contract.
          const sem = options.semaphore;
          const invokeReviewer = () => reviewStep(
            rootDir,
            taskId,
            0,
            "Specification",
            "spec",
            promptContent,
            undefined,
            {
              onText: (delta) => options.onAgentText?.(taskId, delta),
              // Execution defaults as final fallback
              defaultProvider: currentSettings.defaultProvider,
              defaultModelId: currentSettings.defaultModelId,
              // Project-level validator override
              projectValidatorProvider: currentSettings.validatorProvider,
              projectValidatorModelId: currentSettings.validatorModelId,
              // Project-level validator fallback
              projectValidatorFallbackProvider: currentSettings.validatorFallbackProvider,
              projectValidatorFallbackModelId: currentSettings.validatorFallbackModelId,
              // FNXC:SpecReviewerFallback 2026-06-23-08:50:
              // Spec review must inherit global/default fallback reviewer model settings when no validator-specific fallback is configured, plus the project settings/prompt payload that reviewer sessions use for memory and custom prompt behavior.
              fallbackProvider: currentSettings.fallbackProvider,
              fallbackModelId: currentSettings.fallbackModelId,
              // Global validator lane
              globalValidatorProvider: currentSettings.validatorGlobalProvider,
              globalValidatorModelId: currentSettings.validatorGlobalModelId,
              // Project-level default override (fallback before execution defaults)
              projectDefaultOverrideProvider: currentSettings.defaultProviderOverride,
              projectDefaultOverrideModelId: currentSettings.defaultModelIdOverride,
              defaultThinkingLevel: currentSettings.defaultThinkingLevel,
              store,
              taskId,
              task: currentDetail,
              userComments: currentUserComments.length > 0 ? currentUserComments : undefined,
              agentPrompts: currentSettings.agentPrompts,
              agentStore: this.options.agentStore,
              rootDir,
              settings: currentSettings,
              // Track the spec reviewer's session under this task so it's
              // disposed alongside the main triage session on global pause.
              onSessionCreated: (s) => this.registerSubagentSession(taskId, s),
              onSessionEnded: (s) => this.unregisterSubagentSession(taskId, s),
            },
          );
          const result = sem
            ? await sem.runNested(invokeReviewer)
            : await invokeReviewer();

          // Track verdict for post-session enforcement
          specReviewVerdictRef.current = result.verdict;

          await store.logEntry(
            taskId,
            `Spec review: ${result.verdict}`,
            result.summary,
          );
          reviewerLog.log(`${taskId}: spec review → ${result.verdict}`);

          let text: string;
          switch (result.verdict) {
            case "APPROVE":
              // Capture the user-comment fingerprint at approval time for stale-approval detection
              approvedCommentFingerprintRef.current = computeUserCommentFingerprint(currentUserComments);
              text = "APPROVE";
              break;
            case "REVISE":
              text = `REVISE — fix the issues below, rewrite the PROMPT.md, and call fn_review_spec() again.\n\n${result.review}`;
              break;
            case "RETHINK": {
              // Rewind conversation to pre-planning checkpoint
              const checkpointId = checkpointRef.current;
              if (checkpointId && sessionRef.current) {
                try {
                  await sessionRef.current.navigateTree(checkpointId, {
                    summarize: false,
                  });
                  planLog.log(
                    `${taskId}: RETHINK — session rewound to checkpoint ${checkpointId}`,
                  );
                } catch (rewindErr: unknown) {
                  const msg = rewindErr instanceof Error ? rewindErr.message : String(rewindErr);
                  planLog.warn(`${taskId}: RETHINK navigateTree rewind failed, falling back to branchWithSummary: ${msg}`);
                  // Fallback to branchWithSummary
                  try {
                    sessionRef.current.sessionManager.branchWithSummary(
                      checkpointId,
                      `RETHINK: ${result.summary || "Approach rejected by reviewer"}`,
                    );
                    planLog.log(
                      `${taskId}: RETHINK — branched from checkpoint ${checkpointId}`,
                    );
                  } catch (branchErr: unknown) {
                    const branchErrMessage = branchErr instanceof Error ? branchErr.message : String(branchErr);
                    planLog.error(
                      `${taskId}: RETHINK session rewind failed: ${branchErrMessage}`,
                    );
                  }
                }
              } else {
                planLog.log(
                  `${taskId}: RETHINK — no session checkpoint, skipping rewind`,
                );
              }

              await store.logEntry(
                taskId,
                `RETHINK: spec rewound — session checkpoint ${checkpointId || "N/A"}`,
                result.summary,
              );
              text = `RETHINK\n\nYour specification was rejected. Here is why:\n\n${result.review}\n\nTake a completely different approach to writing this specification. Do NOT repeat the rejected strategy.`;
              break;
            }
            default:
              text = "UNAVAILABLE — reviewer did not produce a usable verdict.";
          }

          return { content: [{ type: "text" as const, text }], details: {} };
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          reviewerLog.error(`${taskId}: spec review failed: ${errorMessage}`);
          await store.logEntry(taskId, `Spec review failed: ${errorMessage}`);
          return {
            content: [
              {
                type: "text" as const,
                text: `UNAVAILABLE — reviewer error: ${errorMessage}`,
              },
            ],
            details: {},
          };
        }
      },
    };
  }

  private async tryFinalizeExplicitDuplicateMarker(
    task: Task,
    written: string,
    settings: Settings,
    options: {
      isReplan?: boolean;
      feedback?: string;
    } = {},
  ): Promise<boolean> {
    try {
      const explicitDuplicateMarker = parseExplicitDuplicateMarker(written);
      if (!explicitDuplicateMarker) {
        return false;
      }

      const canonicalId = explicitDuplicateMarker.canonicalId;
      const canonicalTask = await this.store.getTask(canonicalId).catch(() => null);
      if (
        !canonicalTask ||
        canonicalTask.deletedAt ||
        canonicalTask.id.toLowerCase() === task.id.toLowerCase()
      ) {
        return false;
      }

      planLog.log(`${task.id} explicit duplicate marker detected — redirecting to ${canonicalId}`);
      await this.finalizeApprovedTask(task, written, settings, options);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${task.id}: explicit duplicate marker short-circuit failed; proceeding with normal approval gate (${msg})`);
      return false;
    }
  }

  private async finalizeApprovedTask(
    task: Task,
    writtenInput: string,
    settings: Settings,
    options: {
      isReplan?: boolean;
      feedback?: string;
      recoveryLogAction?: string;
    } = {},
  ): Promise<void> {
    let written = writtenInput;
    const dupMatch = written.match(/^DUPLICATE:\s*([A-Z]+-\d+)/i);

    if (dupMatch) {
      const dupId = dupMatch[1];
      planLog.log(`${task.id} is a duplicate of ${dupId} — closing`);
      await this.store.logEntry(
        task.id,
        `Duplicate of ${dupId} — closed`,
      );
      try {
        await this.store.recordActivity({
          type: "task:auto-archived-duplicate",
          taskId: task.id,
          taskTitle: task.title ?? "",
          details: `Duplicate of ${dupId} — closed`,
          metadata: {
            canonicalTaskId: dupId,
            source: "explicit-marker",
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        planLog.warn(`${task.id}: failed to record explicit duplicate-marker activity (${msg})`);
      }
      // Pass removeLineageReferences so a duplicate-close cannot be blocked by lineage children (FN-5129 / FN-5131).
      await this.store.deleteTask(task.id, {
        removeLineageReferences: true,
        auditContext: {
          agentId: task.assignedAgentId ?? "triage",
          runId: generateSyntheticRunId("triage-delete", task.id),
        },
      });
      return;
    }

    const parsedDeps = await this.store.parseDependenciesFromPrompt(task.id);

    const taskUpdates: Record<string, any> = { status: null, error: null };

    if (parsedDeps.length > 0) {
      taskUpdates.dependencies = parsedDeps;
      planLog.log(`${task.id} dependencies: ${parsedDeps.join(", ")}`);
    }

    const parsedSteps = await this.store.parseStepsFromPrompt(task.id);
    if (parsedSteps.length > 0) {
      taskUpdates.steps = parsedSteps;
    }

    const duplicateLineage = getTaskDuplicateLineage({
      id: task.id,
      title: task.title,
      description: task.description,
      sourceType: task.sourceType,
      sourceParentTaskId: task.sourceParentTaskId,
      sourceMetadata: task.sourceMetadata,
      promptText: written,
    }).filter((candidateId) => {
      return !(task.sourceType === "task_duplicate" && task.sourceParentTaskId?.toUpperCase() === candidateId);
    });

    if (duplicateLineage.length > 0) {
      const existingMetadataIds = Array.isArray(task.sourceMetadata?.[DUPLICATE_OF_METADATA_KEY])
        ? task.sourceMetadata[DUPLICATE_OF_METADATA_KEY].filter((value): value is string => typeof value === "string")
        : [];
      const existingNormalized = existingMetadataIds.map((value) => value.toUpperCase());
      const matchesExisting =
        existingNormalized.length === duplicateLineage.length
        && existingNormalized.every((value, index) => value === duplicateLineage[index]);
      if (!matchesExisting) {
        taskUpdates.sourceMetadataPatch = { [DUPLICATE_OF_METADATA_KEY]: duplicateLineage };
      }
      planLog.log(`${task.id} duplicate-of lineage: ${duplicateLineage.join(", ")}`);
    }

    const sizeMatch = written.match(/^\*\*Size:\*\*\s+(S|M|L)\b/m);
    if (sizeMatch) {
      taskUpdates.size = sizeMatch[1] as "S" | "M" | "L";
    }

    const reviewMatch = written.match(/^##\s+Review\s+Level:\s+(\d+)/m);
    if (reviewMatch) {
      taskUpdates.reviewLevel = parseInt(reviewMatch[1], 10);
    }

    const noCommitsExpectedMatch = written.match(/^\*\*No commits expected:\*\*\s*(true|yes)\b/im);
    if (noCommitsExpectedMatch) {
      taskUpdates.noCommitsExpected = true;
    }

    let parsedFileScope = parseFileScopeFromPrompt(written);
    try {
      const persistedFileScope = await this.store.parseFileScopeFromPrompt(task.id);
      if (persistedFileScope.length > parsedFileScope.length) {
        parsedFileScope = persistedFileScope;
      }
    } catch {
      // Fail open on persisted PROMPT.md parsing and keep using the in-memory parse.
    }

    const promptWithFrontendUxCriteria = applyFrontendUxCriteria(written, parsedFileScope);
    if (promptWithFrontendUxCriteria !== written) {
      const promptPath = join(this.rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      try {
        await writeFile(promptPath, promptWithFrontendUxCriteria, "utf-8");
        written = promptWithFrontendUxCriteria;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        planLog.warn(`${task.id}: failed to write Frontend UX Criteria to PROMPT.md (${message})`);
      }
    }

    let taskIntentSignature: ReturnType<typeof extractIntentSignature> = {
      routePaths: [],
      filePaths: [],
      identifiers: [],
      titleTokens: [],
    };
    try {
      taskIntentSignature = extractIntentSignature({
        title: task.title ?? "",
        description: task.description ?? "",
        fileScope: parsedFileScope,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      planLog.warn(`${task.id}: near-duplicate signature extraction failed open: ${message}`);
    }
    if (parsedFileScope.length > 0 || taskIntentSignature.routePaths.length + taskIntentSignature.filePaths.length + taskIntentSignature.identifiers.length > 0) {
      taskUpdates.sourceMetadataPatch = {
        ...(taskUpdates.sourceMetadataPatch ?? {}),
        intentSignature: taskIntentSignature,
        ...(parsedFileScope.length > 0 ? { fileScope: parsedFileScope } : {}),
      };
    }

    // Apply non-title metadata first. The title is held back and applied AFTER
    // the column transition (see below) because store.updateTask regenerates
    // PROMPT.md when title/description change, and the triage-stub regen path
    // would overwrite the freshly-written specification while column='triage'.
    // The store now also guards that regen against real specs, but we keep this
    // ordering as defense in depth so a future change to the guard can't
    // resurrect the regression.
    const promptDeclaredTitle = extractPromptDeclaredTitle(written, task.id);
    const shouldApplyPromptDeclaredTitle = shouldReplaceTaskTitleFromPrompt(task, promptDeclaredTitle);

    await this.store.updateTask(task.id, taskUpdates);

    try {
      const preflightDecision = await Promise.race([
        runGhostBugPreflight(
          { title: task.title ?? "", description: task.description ?? "" },
          written,
          {
            cwd: this.rootDir,
            exec: promisify(exec),
          },
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]);

      if (preflightDecision && preflightDecision.decision === "archive") {
        await archiveAsGhostBug(this.store, task.id, task.title ?? "", preflightDecision);
        const auditor = createRunAuditor(this.store, {
          taskId: task.id,
          agentId: task.assignedAgentId ?? "triage",
          runId: generateSyntheticRunId("triage", task.id),
          phase: "triage",
          source: "triage",
        });
        await auditor.database({
          type: "task:auto-archived-ghost-bug",
          target: task.id,
          metadata: {
            reason: preflightDecision.reason,
            findings: preflightDecision.findings.slice(0, 10),
          },
        });
        planLog.log(`${task.id} auto-archived as ghost bug`);
        return;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      planLog.warn(`${task.id}: ghost-bug preflight failed open: ${message}`);
    }

    // FN-5152: post-PROMPT near-duplicate backstop (fail-open, bounded) before triage→todo transition.
    try {
      const nearDuplicateResult = await Promise.race([
        (async () => {
          const signalCount = taskIntentSignature.routePaths.length + taskIntentSignature.filePaths.length + taskIntentSignature.identifiers.length;
          if (signalCount === 0 && parsedFileScope.length === 0) {
            return;
          }

          const nowMs = Date.now();
          const candidates = (await this.store.listTasks({ slim: false, includeArchived: false }))
            .filter((candidate) => candidate.id !== task.id)
            .filter((candidate) => candidate.column !== "done")
            .filter((candidate) => Date.parse(candidate.createdAt) >= nowMs - 7 * 24 * 60 * 60 * 1000)
            .map((candidate) => ({
              id: candidate.id,
              title: candidate.title ?? "",
              description: candidate.description ?? "",
              column: candidate.column,
              createdAt: Date.parse(candidate.createdAt),
              fileScope: Array.isArray(candidate.sourceMetadata?.fileScope)
                ? candidate.sourceMetadata.fileScope.filter((entry): entry is string => typeof entry === "string")
                : undefined,
            } satisfies NearDuplicateCandidate));

          const matches = findNearDuplicates(
            { title: task.title ?? "", description: task.description ?? "", fileScope: parsedFileScope },
            candidates,
            { windowMs: 7 * 24 * 60 * 60 * 1000, nowMs },
          );
          if (matches.length === 0) {
            return;
          }

          const taskCreatedAt = Date.parse(task.createdAt);
          const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
          const isStrictlyOlderOrTieCanonical = (candidate: NearDuplicateCandidate): boolean => {
            const candidateCreatedAt =
              typeof candidate.createdAt === "number" ? candidate.createdAt : Number.NaN;
            if (Number.isNaN(candidateCreatedAt)) {
              return false;
            }
            if (candidateCreatedAt < taskCreatedAt) return true;
            if (candidateCreatedAt > taskCreatedAt) return false;
            return candidate.id.localeCompare(task.id, undefined, { numeric: true }) < 0;
          };
          const olderMatches = matches.filter((match) => {
            const candidate = candidatesById.get(match.id);
            return candidate ? isStrictlyOlderOrTieCanonical(candidate) : false;
          });
          const canonical = olderMatches[0] ?? matches[0];
          const canonicalTask = candidatesById.get(canonical.id);
          if (!canonicalTask) {
            return;
          }

          /**
           * FNXC:NearDuplicateDetection 2026-06-14-12:00:
           * FN-6439 makes the triage backstop defense-in-depth: never persist a user-decision duplicate flag when the canonical is inactive, even if candidate filtering regresses or a stale snapshot slips through.
           */
          if (isNearDuplicateCanonicalInactive(canonicalTask)) {
            planLog.log(`${task.id}: near-duplicate candidate ${canonical.id} is inactive; skipping near-duplicate flag`);
            return;
          }

          // FN-5152: when the candidate is older (or tie-canonical), flag for user confirmation.
          if (isStrictlyOlderOrTieCanonical(canonicalTask)) {
            await this.store.updateTask(task.id, {
              sourceMetadataPatch: {
                nearDuplicateOf: canonical.id,
                nearDuplicateScore: canonical.score,
                nearDuplicateSharedTokens: canonical.sharedTokens,
                intentSignature: taskIntentSignature,
                ...(parsedFileScope.length > 0 ? { fileScope: parsedFileScope } : {}),
              },
            });
            await this.store.logEntry(
              task.id,
              `Flagged as near-duplicate of ${canonical.id} (awaiting user decision)`,
              `Shared tokens: ${canonical.sharedTokens.join(", ")}`,
            );
            await this.store.recordActivity({
              type: "task:near-duplicate-flagged",
              taskId: task.id,
              taskTitle: task.title ?? "",
              details: `Near-duplicate of ${canonical.id}`,
              metadata: {
                canonicalTaskId: canonical.id,
                sharedTokens: canonical.sharedTokens,
                score: canonical.score,
              },
            });
            planLog.log(`${task.id} flagged as near-duplicate of ${canonical.id}; awaiting user decision`);
            return;
          }

          planLog.warn(`${task.id}: near-duplicate candidate ${canonical.id} is newer; skipping near-duplicate flag`);
        })(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
      ]);
      if (nearDuplicateResult === "timeout") {
        planLog.warn(`${task.id}: near-duplicate backstop timed out; proceeding`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      planLog.warn(`${task.id}: near-duplicate backstop failed open: ${message}`);
    }

    let latestTransitionTask: Task | undefined;
    try {
      latestTransitionTask = await this.store.getTask(task.id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      planLog.warn(`${task.id}: failed to re-read task before approved-spec transition (${message}); proceeding with original task snapshot`);
      latestTransitionTask = task;
    }
    try {
      /**
       * FNXC:ReleaseAuthorizationGate 2026-06-15-02:47:
       * FN-6469 showed that agent-authored release specs can otherwise flow from triage directly to execution and publish npm packages. FN-6481 parks release-class tasks before every final triage dispatch branch unless a user-authored source supplied the explicit authorization marker.
       */
      const releaseGateDecision = evaluateReleaseAuthorizationGate({
        sourceType: latestTransitionTask?.sourceType ?? task.sourceType,
        title: latestTransitionTask?.title ?? task.title ?? "",
        description: latestTransitionTask?.description ?? task.description ?? "",
        promptText: written,
      });
      if (releaseGateDecision.action === "block") {
        const approvalUpdates: Record<string, unknown> = { status: "awaiting-approval" };
        if (shouldApplyPromptDeclaredTitle && promptDeclaredTitle) {
          approvalUpdates.title = promptDeclaredTitle;
        }
        const signals = releaseGateDecision.signals.length > 0
          ? releaseGateDecision.signals.join(", ")
          : "release intent";
        const details = `${releaseGateDecision.reason} Matched signals: ${signals}.`;
        await this.store.updateTask(task.id, approvalUpdates);
        await this.store.logEntry(
          task.id,
          "Release authorization required — leaving task in triage awaiting manual approval",
          details,
        );
        try {
          await this.store.recordActivity({
            type: "task:release-authorization-required",
            taskId: task.id,
            taskTitle: promptDeclaredTitle ?? latestTransitionTask?.title ?? task.title ?? "",
            details,
            metadata: {
              reason: releaseGateDecision.reason,
              signals: releaseGateDecision.signals,
              sourceType: latestTransitionTask?.sourceType ?? task.sourceType ?? "unknown",
            },
          });
        } catch (activityError: unknown) {
          const message = activityError instanceof Error ? activityError.message : String(activityError);
          planLog.warn(`${task.id}: failed to record release-authorization-required activity (${message})`);
        }
        planLog.log(`${task.id} release authorization required — leaving in triage awaiting manual approval (${signals})`);
        return;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      planLog.warn(`${task.id}: release-authorization gate failed open: ${message}`);
    }

    if (latestTransitionTask?.paused === true || latestTransitionTask?.userPaused === true) {
      const restoreStatus = options.isReplan ? "needs-replan" : null;
      await this.store.updateTask(task.id, { status: restoreStatus });
      await this.store.logEntry(
        task.id,
        "Specification approved but task is paused — leaving in triage, will resume on unpause",
      );
      planLog.log(`${task.id} approved specification paused — leaving in triage, will resume on unpause`);
      return;
    }

    if (settings.requirePlanApproval) {
      const approvalUpdates: Record<string, unknown> = { status: "awaiting-approval" };
      if (shouldApplyPromptDeclaredTitle && promptDeclaredTitle) {
        approvalUpdates.title = promptDeclaredTitle;
      }
      await this.store.updateTask(task.id, approvalUpdates);
      await this.store.logEntry(
        task.id,
        options.recoveryLogAction ?? "Specification approved by AI — awaiting manual approval",
      );
      planLog.log(`✓ ${task.id} specified and awaiting manual approval`);
      return;
    }

    await this.store.moveTask(task.id, "todo");

    if (shouldApplyPromptDeclaredTitle && promptDeclaredTitle) {
      await this.store.updateTask(task.id, { title: promptDeclaredTitle });
    }

    if (options.recoveryLogAction) {
      await this.store.logEntry(task.id, options.recoveryLogAction);
      planLog.log(`✓ ${task.id} recovered and moved to todo`);
      return;
    }

    if (options.isReplan) {
      await this.store.logEntry(task.id, "Spec revised by AI", options.feedback);
      planLog.log(`✓ ${task.id} re-planned and moved to todo`);
    } else {
      planLog.log(`✓ ${task.id} specified and moved to todo`);
    }
  }
}

function parseFileScopeFromPrompt(text: string): string[] {
  const match = text.match(/^##\s+File Scope\s*\n([\s\S]*?)(?=^##\s+|$)/m);
  if (!match) return [];
  const entries: string[] = [];
  for (const rawLine of match[1].split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("-")) continue;
    const line = trimmed.replace(/^-+\s*/, "").replace(/`/g, "").trim();
    if (!line || /^out of scope/i.test(line)) break;
    const pathOnly = line.split(" ")[0]?.trim();
    if (!pathOnly) continue;
    entries.push(pathOnly);
    if (entries.length >= 50) break;
  }
  return entries;
}

function extractPromptDeclaredTitle(prompt: string, taskId: string): string | null {
  const headingMatch = prompt.match(/^#\s+Task:\s+([A-Z]+-\d+)\s+-\s+(.+)$/m);
  if (!headingMatch) return null;
  const [, headingTaskId, rawTitle] = headingMatch;
  if (headingTaskId !== taskId) return null;

  const title = rawTitle.trim().replace(/[\s.!?,;:]+$/g, "");
  if (!title) return null;

  // Conservative guard: do not overwrite metadata with confirmation prose.
  if (isMalformedTaskTitle(title)) {
    return null;
  }

  return title;
}

function isMalformedTaskTitle(title: string): boolean {
  return /^created\s+(?:task\s+)?(?:fn-\d+\b|\*\*\s*fn-\d+\s*\*\*)/i.test(title.trim());
}

function shouldReplaceTaskTitleFromPrompt(task: Task, promptDeclaredTitle: string | null): boolean {
  if (!promptDeclaredTitle) return false;

  if (
    task.sourceType === "github_import" &&
    task.sourceIssue?.provider === "github" &&
    task.title?.trim() &&
    !isMalformedTaskTitle(task.title)
  ) {
    return false;
  }

  return true;
}

function hasLatestSpecReviewApproval(task: Task): boolean {
  for (let i = task.log.length - 1; i >= 0; i--) {
    const action = task.log[i]?.action ?? "";
    if (action.startsWith("Spec review: ")) {
      return action === "Spec review: APPROVE";
    }
  }
  return false;
}

/** Content read from an attachment file for inlining in the prompt. */
export interface AttachmentContent {
  originalName: string;
  mimeType: string;
  /** Text content for text files, null for images (handled via image content blocks). */
  text: string | null;
}

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const TEXT_INLINE_LIMIT = 50 * 1024; // 50KB

/**
 * Read attachment files from disk, returning text contents for inlining
 * and image contents for pi image content blocks.
 */
export async function readAttachmentContents(
  rootDir: string,
  taskId: string,
  attachments?: TaskAttachment[],
): Promise<{
  attachmentContents: AttachmentContent[];
  imageContents: ImageContent[];
}> {
  const attachmentContents: AttachmentContent[] = [];
  const imageContents: ImageContent[] = [];

  if (!attachments || attachments.length === 0) {
    return { attachmentContents, imageContents };
  }

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  for (const att of attachments) {
    const filePath = join(
      rootDir,
      ".fusion",
      "tasks",
      taskId,
      "attachments",
      att.filename,
    );

    try {
      if (IMAGE_MIME_TYPES.has(att.mimeType)) {
        const data = await readFile(filePath);
        imageContents.push({
          type: "image",
          data: data.toString("base64"),
          mimeType: att.mimeType,
        });
        attachmentContents.push({
          originalName: att.originalName,
          mimeType: att.mimeType,
          text: null,
        });
      } else {
        const data = await readFile(filePath, "utf-8");
        const text =
          data.length > TEXT_INLINE_LIMIT
            ? data.slice(0, TEXT_INLINE_LIMIT) + "\n... (truncated at 50KB)"
            : data;
        attachmentContents.push({
          originalName: att.originalName,
          mimeType: att.mimeType,
          text,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${taskId}: failed to read attachment '${att.filename}', skipping: ${msg}`);
      // Skip unreadable attachments
      continue;
    }
  }

  return { attachmentContents, imageContents };
}

/**
 * Compute a deterministic fingerprint from user comments on a task.
 * Returns a sorted, semicolon-joined string of comment IDs (user-authored only).
 * Used to detect whether user comments changed after spec approval.
 */
export function computeUserCommentFingerprint(
  comments?: import("@fusion/core").TaskComment[],
): string {
  if (!comments || comments.length === 0) return "";
  const userIds = comments
    .filter((c) => c.author === "user")
    .map((c) => c.id)
    .sort();
  return userIds.join(";");
}

export function buildSpecificationPrompt(
  task: TaskDetail,
  promptPath: string,
  settings?: Settings,
  attachmentContents?: AttachmentContent[],
  existingPrompt?: string,
  feedback?: string,
): string {
  const hasFeedback = Boolean(feedback?.trim());
  const isRevision = Boolean(existingPrompt && hasFeedback);
  const isFreshRespecification = Boolean(!existingPrompt && hasFeedback);

  let commandsSection = "";
  if (settings?.testCommand || settings?.buildCommand) {
    const lines = ["## Project Commands"];
    if (settings.testCommand)
      lines.push(`- **Test:** \`${settings.testCommand}\``);
    if (settings.buildCommand)
      lines.push(`- **Build:** \`${settings.buildCommand}\``);
    lines.push("Use these exact commands in testing/verification steps.");
    commandsSection = "\n\n" + lines.join("\n");
  }

  const completionDocumentationMode = settings?.completionDocumentationMode ?? "off";
  let completionDocumentationSection = "";
  if (completionDocumentationMode !== "off") {
    const instruction = completionDocumentationMode === "changeset"
      ? "If the task changes published-package behavior, require a `.changeset/*.md` entry and call out the repository's changeset workflow."
      : "Require updating an existing changelog file as part of completion; do not invent a new changelog file when none exists.";
    completionDocumentationSection = `\n\n## Completion Documentation Preference\nProject setting \`completionDocumentationMode\` is set to \`${completionDocumentationMode}\`.

When writing PROMPT.md, add this as an explicit requirement under completion documentation/delivery expectations (not a side note):
- ${instruction}`;
  }

  // Build project memory section from settings.
  // When enabled, agents consult project memory for durable project learnings.
  // Backend-aware: instructions branch based on memoryBackendType (file, readonly, qmd)
  const memoryEnabled = settings?.memoryEnabled !== false;
  let memorySection = "";
  if (memoryEnabled) {
    memorySection = "\n\n" + buildTriageMemoryInstructions("", settings);
  }

  let attachmentsSection = "";
  if (attachmentContents && attachmentContents.length > 0) {
    const parts = ["## Attachments", ""];
    for (const att of attachmentContents) {
      if (att.text === null) {
        // Image — will be passed via image content blocks
        parts.push(
          `- **${att.originalName}** (${att.mimeType}) — included as image below`,
        );
      } else {
        parts.push(
          `### ${att.originalName} (${att.mimeType})\n\n\`\`\`\n${att.text}\n\`\`\``,
        );
      }
    }
    attachmentsSection = "\n\n" + parts.join("\n");
  }

  // Include user comments as context for the triage agent
  let userCommentsSection = "";
  const userComments = (task.comments || []).filter(
    (c) => c.author === "user",
  );
  if (userComments.length > 0) {
    const parts = [
      "## User Comments",
      "",
      "The following user comments have been posted on this task. **Address every comment** in the specification — each comment represents explicit user feedback or requirements that must be reflected in the PROMPT.md.",
      "",
    ];
    for (const comment of userComments) {
      const date = comment.updatedAt || comment.createdAt;
      parts.push(
        `- **[${date}]** ${comment.text}`,
      );
    }
    parts.push(
      "",
      "Ensure the specification addresses all of the above comments. Missing comment coverage is a spec quality failure.",
    );
    userCommentsSection = "\n\n" + parts.join("\n");
  }

  let revisionSection = "";
  if (isRevision) {
    revisionSection = `

## Revision Instructions
You are revising an existing task specification based on user feedback.

**Important:** Keep the same overall PROMPT.md structure (headings, sections, format) but improve the content to address the feedback below. Do not drastically change the file structure unless necessary.

## Existing Specification
\`\`\`markdown
${existingPrompt}
\`\`\`

## User Feedback
${feedback}

Please revise the specification above to address this feedback. Write the complete revised PROMPT.md to \`${promptPath}\`.`;
  } else if (isFreshRespecification) {
    revisionSection = `

## Re-specification Instructions
You are creating a fresh replacement specification based on user feedback.

**Important:** Do not reuse stale PROMPT.md content. Treat the current task title and description as required primary inputs, inspect the codebase, and write a complete new specification that addresses the feedback below.

## User Feedback
${feedback}

Please write the complete fresh PROMPT.md to \`${promptPath}\`.`;
  }

  let subtaskSection = "";
  if (task.breakIntoSubtasks) {
    subtaskSection = `

## Subtask Breakdown Requested
The user has requested that this task be broken into smaller subtasks if it is complex enough to warrant splitting.

**When to split:**
- Only split when the work is meaningfully decomposable into 2-5 independently executable child tasks
- Each child task should be completable on its own with a clear scope and acceptance criteria
- Child tasks should have logical dependencies between them if order matters

**How to split:**
1. First, analyze the task to determine if it should be split
2. If splitting: use the \\\`fn_task_create\\\` tool to create child tasks in order, setting up dependencies as needed
3. Include clear descriptions and acceptance criteria for each child task
4. After creating all subtasks, stop — do NOT write a PROMPT.md for the parent task
5. If NOT splitting: proceed with a normal PROMPT.md specification for this task

**Subtask dependencies rule:** \`dependencies\` on a child may only reference **sibling subtasks created earlier in this same split** or **pre-existing tasks in the store**. They must NEVER reference the parent task being split — the parent is deleted after the split completes, and a dependency on a deleted task permanently blocks the dependent. If a child "needs the rest of the parent's work to finish first", create another sibling subtask for that remaining work and depend on the sibling. The \`fn_task_create\` tool rejects parent-id dependencies.

**Important:** If you create subtasks, this parent task will be closed and replaced by the children. Make sure each child is a complete, executable task.`;
  } else {
    subtaskSection = `

## Subtask Consideration
The user did not explicitly request subtask breakdown. Default to keeping the task whole; only split when the work is genuinely large or has clearly independent deliverables.

**Split into 2-5 child tasks when ANY of these apply:**
- The task will require MORE THAN 7 implementation steps
- The task affects MORE THAN 3 different packages/modules with distinct concerns (touching multiple packages as a coherent vertical change does NOT count — e.g. types + store + UI + tests for one feature is one task)
- Any single step would take more than 1-2 hours to complete
- The task has multiple clearly independent deliverables that could be developed and shipped in parallel by different people

**GOOD TO SPLIT:**
- A task that would require 12+ implementation steps spanning genuinely separate concerns
- A multi-feature epic where each feature can be shipped independently
- A refactor that has both a "rip out the old" phase and an "add the new" phase that can land separately

**NOT NECESSARY TO SPLIT (and SHOULD NOT be split):**
- A bug fix with clear scope, regardless of how many files it touches
- A single-file refactor
- A vertical feature that touches core + dashboard + tests as one coherent unit (this is the common case in this monorepo — keep it together)
- Any task with 10 or fewer focused steps within a coherent scope

**How to decide:**
- If you choose to split: use the \\\`fn_task_create\\\` tool to create the child tasks, set dependencies where needed, and then stop without writing a PROMPT.md for the parent task.
- **Subtask dependencies must only reference sibling subtasks created earlier in this same split, or pre-existing tasks. NEVER depend on the parent task being split — the parent is deleted after splitting, and the tool will reject parent-id dependencies.**
- When in doubt, do NOT split. Coordination overhead (worktrees, dependency wiring, merge sequencing) is real — splitting must clearly pay for itself.
- If size is uncertain at first, make a quick assessment from the available context before deciding.`;
  }

  return `${isRevision ? "Revise" : isFreshRespecification ? "Re-specify" : "Specify"} this task and write the result to \`${promptPath}\`.

## Task
- **ID:** ${task.id}
- **Title:** ${task.title || "(none)"}
- **Description:** ${task.description}
${task.breakIntoSubtasks ? "- **Break into subtasks:** Yes (user requested)" : ""}
${task.dependencies.length > 0 ? `- **Dependencies:** ${task.dependencies.join(", ")}` : ""}${revisionSection}${subtaskSection}

## Instructions
${isRevision ? "1. Review the existing specification and user feedback carefully\n2. Revise the PROMPT.md to address the feedback while maintaining the structure\n3. Ensure the specification is detailed enough for an AI agent to execute" : isFreshRespecification ? "1. Read the project structure to understand context (package.json, source files, etc.)\n2. Treat the current task title and description as mandatory primary inputs for a new spec\n3. Write a fresh complete PROMPT.md specification to the given path following the format in your system prompt\n4. Address the user feedback without carrying forward stale assumptions from the old spec\n5. Name actual files, functions, and patterns from the codebase — be specific" : "1. Read the project structure to understand context (package.json, source files, etc.)\n2. Write a complete PROMPT.md specification to the given path following the format in your system prompt\n3. The specification must be detailed enough for an autonomous AI agent to implement without asking questions\n4. Name actual files, functions, and patterns from the codebase — be specific"}

Use the write tool to write the specification file.${commandsSection}${completionDocumentationSection}${memorySection}${attachmentsSection}${userCommentsSection}`;
}
