/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fusionCore from "@fusion/core";
import type {
  TaskStore,
  Task,
  TaskDetail,
  TaskAttachment,
  Settings,
  WorkflowStepResult,
} from "@fusion/core";
import {
  DUPLICATE_OF_METADATA_KEY,
  PLAN_REVIEW_GROUP_ID,
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
  resolvePlanApprovalRequired,
  extractIntentSignature,
  findNearDuplicates,
  isNearDuplicateCanonicalInactive,
  detectImageMimeFromBytes,
  applyFrontendUxCriteria,
  extractEffectiveWriteScopeFromPrompt,
  MAX_TASK_LIST_TEXT_CHARS,
  type NearDuplicateCandidate,
} from "@fusion/core";

type TaskListClamp = (lines: string[], opts?: { maxChars?: number }) => string;
type TaskListFormatter = (
  lines: string[],
  opts?: { maxChars?: number; clamp?: TaskListClamp },
) => string;

const TRIAGE_STUCK_RESUME_LOG_ACTION = "Triage stuck re-queue will resume existing planning draft";
const TRIAGE_STUCK_RESUME_FEEDBACK = "The previous triage session was killed by the stuck-task detector after writing a non-empty planning draft. Resume from the existing draft below: preserve useful structure and decisions, fill gaps, and continue toward review instead of restarting planning from scratch.";

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
import { planLog, formatError } from "./logger.js";
import { resolveMcpServersForStore } from "./mcp-resolution.js";
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
import { accumulateSessionTokenUsage } from "./session-token-usage.js";
import { reviewStep } from "./reviewer.js";


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
        /*
        FNXC:TokenAnalytics 2026-06-27-14:52:
        Task delete may dispose the live triage session before agentWork reaches its finally; fire a fail-soft delta snapshot now, with the finally call serving as a zero-delta backstop when it unwinds.
        */
        this.recordTriageSessionTokenUsageSoon(task.id, session as AgentSession, { agentId: task.assignedAgentId ?? "triage" });
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
        /*
        FNXC:TokenAnalytics 2026-06-27-14:52:
        Task pause can force resource disposal before the normal triage finally runs; record the current model token delta immediately and rely on delta baselines to avoid double-counting.
        */
        this.recordTriageSessionTokenUsageSoon(task.id, session as AgentSession, { agentId: task.assignedAgentId ?? "triage" });
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
      /*
      FNXC:TokenAnalytics 2026-06-27-14:52:
      Engine stop/global pause force-disposes active triage sessions synchronously, so snapshot token deltas before disposal while preserving the existing non-blocking abort behavior.
      */
      this.recordTriageSessionTokenUsageSoon(taskId, session as AgentSession);
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

  /**
   * FNXC:TokenAnalytics 2026-06-27-14:52:
   * Triage and spec-review subagent sessions are AI lanes that must snapshot the actually-used model before resource teardown so Command Center Tokens by model includes triage-only models such as Anthropic.
   * Use one shared recorder for normal completion, fallback swaps, and abort disposal; the token helper is delta-based and fail-soft, so repeated emergency/finally calls do not inflate totals.
   */
  private async recordTriageSessionTokenUsage(
    taskId: string,
    session: AgentSession,
    options?: { agentId?: string },
  ): Promise<void> {
    await accumulateSessionTokenUsage(this.store, taskId, session, {
      agentId: options?.agentId,
      role: "triage",
    });
  }

  private recordTriageSessionTokenUsageSoon(
    taskId: string,
    session: AgentSession,
    options?: { agentId?: string },
  ): void {
    void this.recordTriageSessionTokenUsage(taskId, session, options).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${taskId}: failed to record triage session token usage before disposal: ${msg}`);
    });
  }

  /** Deregister a reviewer subagent that finished naturally. */
  private unregisterSubagentSession(taskId: string, session: AgentSession): void {
    /*
    FNXC:TokenAnalytics 2026-06-27-14:52:
    The spec-review subagent disposes inside reviewer.ts before this callback; record its retained session stats here before dropping the reference so normal APPROVE/REVISE/RETHINK reviews count in per-model analytics.
    */
    this.recordTriageSessionTokenUsageSoon(taskId, session);
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
        /*
        FNXC:TokenAnalytics 2026-06-27-14:52:
        Pause/delete/stop can force-dispose spec-review subagents outside the normal reviewer callback, so record their model token delta before disposal without blocking the synchronous abort path.
        */
        this.recordTriageSessionTokenUsageSoon(taskId, session);
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
   * Recover a triage task whose PROMPT.md was already written but the final
   * handoff out of `status: "planning"` never completed.
   */
  async recoverApprovedTask(task: Task): Promise<boolean> {
    if (task.column !== "triage" || task.status !== "planning") {
      return false;
    }

    if (task.paused === true || task.userPaused === true) {
      planLog.log(`${task.id} planning recovery skipped — task is paused`);
      return false;
    }

    // Merge per-task effective workflow settings (U3, KTD-3) so requirePlanApproval
    // resolves from the workflow. Behavior-inert when nothing is customized.
    const settings = await mergeEffectiveSettings(this.store, task, await this.store.getSettings());
    const approvalRequired = resolvePlanApprovalRequired(settings);
    const promptPath = join(this.rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
    const written = await readFile(promptPath, "utf-8").catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${task.id}: failed to read PROMPT.md during planning recovery (${promptPath}): ${msg}`);
      return "";
    });

    if (!written.trim()) {
      planLog.warn(`${task.id} planning recovery skipped — PROMPT.md missing or empty`);
      return false;
    }

    const deterministicSpecFailure = await this.validateGeneratedPrompt(task.id, written);
    if (deterministicSpecFailure) {
      planLog.warn(`${task.id} planning recovery skipped — PROMPT.md failed deterministic validation (${deterministicSpecFailure})`);
      return false;
    }

    await this.finalizeApprovedTask(task, written, settings, {
      recoveryLogAction: approvalRequired
        ? "Auto-recovered specified task stuck in planning — awaiting manual approval"
        : "Auto-recovered specified task stuck in planning — moved to todo",
    });

    return true;
  }

  private async readNonEmptyPromptDraft(taskId: string, context: string): Promise<string | undefined> {
    /*
    FNXC:Triage 2026-06-27-00:00:
    Stuck triage re-queues prefer a non-empty on-disk PROMPT.md draft. Match scheduler filesystem validation and approved recovery semantics (`trim().length > 0`) so empty or whitespace-only drafts cold-start safely instead of seeding a bogus revision.
    */
    const promptPath = join(this.rootDir, ".fusion", "tasks", taskId, "PROMPT.md");
    const written = await readFile(promptPath, "utf-8").catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${taskId}: failed to read PROMPT.md during ${context} (${promptPath}): ${msg}`);
      return "";
    });
    return written.trim().length > 0 ? written : undefined;
  }

  private async readNonEmptyPlanDocument(taskId: string, context: string): Promise<string | undefined> {
    /*
    FNXC:Triage 2026-06-27-16:18:
    Some triage agents persist the draft through fn_task_document_write key="plan" before PROMPT.md exists. Stuck re-queue must still resume from that non-empty plan document when the file draft is absent, while preserving PROMPT.md as the preferred executable draft when both are present.
    */
    const readTaskDocument = (this.store as unknown as { getTaskDocument?: (taskId: string, key: string) => Promise<{ content?: unknown } | null> }).getTaskDocument;
    if (typeof readTaskDocument !== "function") {
      return undefined;
    }
    const document = await readTaskDocument.call(this.store, taskId, "plan").catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${taskId}: failed to read plan task document during ${context}: ${msg}`);
      return null;
    });
    const content = typeof document?.content === "string" ? document.content : "";
    return content.trim().length > 0 ? content : undefined;
  }

  private async readNonEmptyPlanningDraft(taskId: string, context: string): Promise<{ content: string; source: "prompt" | "plan-document" } | undefined> {
    const promptDraft = await this.readNonEmptyPromptDraft(taskId, context);
    if (promptDraft) {
      return { content: promptDraft, source: "prompt" };
    }
    const planDocument = await this.readNonEmptyPlanDocument(taskId, context);
    return planDocument ? { content: planDocument, source: "plan-document" } : undefined;
  }

  private async handleStuckAbortRequeue(task: Task, context: "in-loop" | "catch"): Promise<void> {
    /*
    FNXC:Triage 2026-06-27-00:00:
    A stuck-killed planning session that already wrote a usable PROMPT.md or plan task document must resume in revision mode on the next poll, not re-triage from scratch. Reuse stuckKillCount and maxStuckKills for the triage retry budget so repeated stuck resumes escalate to manual intervention instead of looping forever.
    */
    const freshTask = await this.store.getTask(task.id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${task.id}: failed to refresh task during stuck-detector ${context} cleanup: ${msg}`);
      return task;
    });

    const recovered = await this.recoverApprovedTask(freshTask).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${task.id}: planning recovery failed during stuck-detector ${context} cleanup: ${msg}`);
      return false;
    });
    if (recovered) {
      return;
    }

    const maxStuckSettings = await this.store.getSettings().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${task.id}: failed to read maxStuckKills during stuck-detector ${context} cleanup, using default 6: ${msg}`);
      return {} as Settings;
    });
    const maxKills = Math.max(1, maxStuckSettings.maxStuckKills ?? 6);
    const nextStuckKillCount = (freshTask.stuckKillCount ?? task.stuckKillCount ?? 0) + 1;
    const draft = await this.readNonEmptyPlanningDraft(task.id, `stuck-detector ${context} cleanup`);

    if (nextStuckKillCount >= maxKills) {
      const exhaustedError = `STUCK_LOOP_EXHAUSTED: triage stuck detector killed ${task.id} ${nextStuckKillCount}/${maxKills} times without planning completion; task paused for manual intervention.`;
      planLog.error(exhaustedError);
      await this.store.logEntry(task.id, exhaustedError).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        planLog.warn(`${task.id}: failed to log stuck-loop exhaustion: ${msg}`);
      });
      await this.store.updateTask(task.id, {
        stuckKillCount: nextStuckKillCount,
        status: "failed",
        error: exhaustedError,
        paused: true,
        pausedReason: "stuck-loop-exhausted-manual-intervention-required",
        pausedByAgentId: "triage",
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        planLog.warn(`${task.id}: failed to persist stuck-loop exhaustion during stuck-detector ${context} cleanup: ${msg}`);
      });
      return;
    }

    if (draft) {
      const sourceLabel = draft.source === "prompt" ? "PROMPT.md draft" : "plan task document";
      planLog.log(`${task.id} killed by stuck detector — requeueing to resume existing ${sourceLabel} (${nextStuckKillCount}/${maxKills})`);
      await this.store.logEntry(task.id, TRIAGE_STUCK_RESUME_LOG_ACTION, TRIAGE_STUCK_RESUME_FEEDBACK).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        planLog.warn(`${task.id}: failed to log stuck-resume feedback: ${msg}`);
      });
      await this.store.updateTask(task.id, {
        status: "needs-replan",
        stuckKillCount: nextStuckKillCount,
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        planLog.warn(`${task.id}: failed to restore status to 'needs-replan' during stuck-detector ${context} cleanup: ${msg}`);
      });
      return;
    }

    planLog.log(`${task.id} killed by stuck detector — clearing status for cold retry (${nextStuckKillCount}/${maxKills})`);
    const restoreStatus = (freshTask.status ?? task.status) === "needs-replan" ? "needs-replan" : null;
    await this.store.updateTask(task.id, {
      status: restoreStatus,
      stuckKillCount: nextStuckKillCount,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${task.id}: failed to restore status to '${restoreStatus}' during stuck-detector ${context} cleanup: ${msg}`);
    });
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
   * After the agent writes PROMPT.md, triage runs deterministic spec hygiene
   * checks and finalizes. Workflow Plan Review is the single optional AI plan
   * quality gate before execution; triage does not inject a separate review tool.
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
      const currentTask = detail ?? task;
      // Merge per-task effective workflow settings (U3, KTD-3) over the base so the
      // planning-phase reads (requirePlanApproval, planning/validator model lanes)
      // pick up workflow values. Behavior-inert when nothing is customized.
      const settings = await mergeEffectiveSettings(this.store, currentTask, await this.store.getSettings());
      const promptPath = `.fusion/tasks/${task.id}/PROMPT.md`;

      /*
      FNXC:PlanReview 2026-06-29-12:58:
      `plan-review-unavailable` is a reviewer-outage retry state, not a planning request. Dispatch it before any createFnAgent path so the existing PROMPT.md is reused and only Plan Review/finalization reruns.

      FNXC:PlanReview 2026-06-29-23:02:
      Retry still launches the Plan Review reviewer lane, so it must consume the same global AgentSemaphore slot as planning work while continuing to avoid the planner session and PROMPT.md rewrite path.
      */
      if (currentTask.status === "plan-review-unavailable") {
        const retryWork = () => this.retryUnavailablePlanReview(currentTask, promptPath, settings);
        if (this.options.semaphore) {
          await this.options.semaphore.run(retryWork, PRIORITY_SPECIFY);
        } else {
          await retryWork();
        }
        return;
      }

      const isFast = task.executionMode === "fast";
      // FN-6236: this is the only legacy executionMode="fast" bridge. Downstream
      // triage policy reads resolved workflow flags instead of the raw string.
      const leanPlanning = settings.leanPlanning === true || isFast;

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

        const { session } = await createResolvedAgentSession({
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
          // FNXC:McpConfig 2026-06-25-23:17: Primary triage planning is an AI lane, so it receives the store-resolved MCP set while the pi runtime-support guard decides whether to forward it without logging secret material.
          mcpServers: (await resolveMcpServersForStore(this.store)).servers,
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
                || entry.action === TRIAGE_STUCK_RESUME_LOG_ACTION
              );
            feedback = feedbackLogEntry?.outcome;

            if (feedbackLogEntry?.action === TRIAGE_STUCK_RESUME_LOG_ACTION) {
              /*
              FNXC:Triage 2026-06-27-16:18:
              Stuck-resume replans must load the existing PROMPT.md draft, or the saved plan task document when PROMPT.md is absent, into buildSpecificationPrompt so `isRevision` is reachable for either persisted planning surface.
              */
              const planningDraft = await this.readNonEmptyPlanningDraft(task.id, "stuck-resume replan seed");
              existingPrompt = planningDraft?.content;
              if (!existingPrompt) {
                feedback = undefined;
              }
            }

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
            const restoreStatus = this.restoreStatusAfterInterruptedTriageWork(task);
            await this.store.updateTask(task.id, { status: restoreStatus }).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              planLog.warn(`${task.id}: failed to restore status to '${restoreStatus}' during pause-abort cleanup: ${msg}`);
            });
            return;
          }

          if (this.stuckAborted.has(task.id)) {
            this.stuckAborted.delete(task.id);
            await this.handleStuckAbortRequeue(task, "in-loop");
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

          /*
          FNXC:PlanReview 2026-06-29-01:52:
          Workflow Plan Review is the single operator-controlled AI plan gate. Triage must not remind agents to call fn_review_spec or retry planning only because that legacy tool was not approved; after PROMPT.md is written, triage itself runs optional Plan Review before releasing the task to execution.
          */

          const written = await readFile(
            join(this.rootDir, promptPath),
            "utf-8",
          ).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            planLog.warn(`${task.id}: failed to read generated PROMPT.md before finalization (${promptPath}): ${msg}`);
            return "";
          });

          // FN-5220: planning agents that emit a `DUPLICATE: FN-NNNN` redirect
          // short-circuit normal spec finalization.
          if (await this.tryFinalizeExplicitDuplicateMarker(task, written, settings, {
            isReplan,
            feedback,
          })) {
            this.options.onSpecifyComplete?.(task);
            return;
          }

          const deterministicSpecFailure = await this.validateGeneratedPrompt(task.id, written);
          if (deterministicSpecFailure) {
            const decision = computeRecoveryDecision({
              recoveryRetryCount: task.recoveryRetryCount,
              nextRecoveryAt: task.nextRecoveryAt,
            });

            if (decision.shouldRetry) {
              const attempt = decision.nextState.recoveryRetryCount;
              const delay = formatDelay(decision.delayMs);
              const retryMessage =
                `Generated plan failed deterministic validation (${deterministicSpecFailure}) — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}.`;
              planLog.warn(`${task.id} ${retryMessage}`);
              await this.store.logEntry(task.id, retryMessage);
              const restoreStatus = this.restoreStatusAfterInterruptedTriageWork(task);
              await this.store.updateTask(task.id, {
                status: restoreStatus,
                error: null,
                recoveryRetryCount: decision.nextState.recoveryRetryCount,
                nextRecoveryAt: decision.nextState.nextRecoveryAt,
              });
              return;
            }

            const failureMessage =
              `Specification failed deterministic validation after ${MAX_RECOVERY_RETRIES} retries (${deterministicSpecFailure}). ` +
              "Retry after adjusting the task prompt or model.";
            planLog.log(
              `${task.id} deterministic spec validation failed (${deterministicSpecFailure}) — retry budget exhausted`,
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

          await this.finalizeApprovedTask(task, written, settings, {
            isReplan,
            feedback,
          });
          this.options.onSpecifyComplete?.(task);
        } finally {
          this.activeSessions.delete(task.id);
          stuckDetector?.untrackTask(task.id);
          await agentLogger.flush();
          /*
          FNXC:TokenAnalytics 2026-06-27-14:52:
          Every triage planning exit path, including APPROVE, retry, pause/stuck abort, split/delete, and rate-limit wrapper attempts, records the active session's actual model before disposal so by-model analytics do not collapse triage usage to missing buckets.
          */
          await this.recordTriageSessionTokenUsage(task.id, session, { agentId: triageRunContext.agentId });
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
        // For interrupted recovery states, restore the original triage-held status;
        // otherwise clear to null so the next poll can re-pick ordinary tasks up.
        const restoreStatus = this.restoreStatusAfterInterruptedTriageWork(task);
        await this.store.updateTask(task.id, { status: restoreStatus }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          planLog.warn(`${task.id}: failed to restore status to '${restoreStatus}' during pause-abort error cleanup: ${msg}`);
        });
      } else if (this.stuckAborted.has(task.id)) {
        this.stuckAborted.delete(task.id);
        await this.handleStuckAbortRequeue(task, "catch");
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
            const restoreStatus = this.restoreStatusAfterInterruptedTriageWork(task);
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
        // For interrupted recovery states, restore the original triage-held status;
        // otherwise clear to null so the next poll can re-pick ordinary tasks up.
        const restoreStatus = this.restoreStatusAfterInterruptedTriageWork(task);
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

    /**
     * FNXC:AgentTooling 2026-06-27-00:00:
     * Triage must expose the task detail read tool as canonical `fn_task_show`, matching prompt text and the FN-7118 shared read-tool factory so every agent surface learns one model-visible show-tool name.
     */
    const taskShow: ToolDefinition = {
      name: "fn_task_show",
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
          planLog.warn(`${options.parentTaskId}: fn_task_show lookup failed for ${params.id}: ${msg}`);
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

    return [taskList, taskSearch, taskShow, taskCreate];
  }

  private restoreStatusAfterInterruptedTriageWork(task: Task): Task["status"] | null {
    /*
    FNXC:PlanReview 2026-06-29-16:56:
    Reviewer-outage retry is not an unplanned task. If a lifecycle write fails while rerunning Plan Review, preserve `plan-review-unavailable` so the next poll returns to the review-only retry path instead of clearing status and launching the planner.
    */
    if (task.status === "needs-replan" || task.status === "plan-review-unavailable") {
      return task.status;
    }
    return null;
  }

  private async retryUnavailablePlanReview(task: Task, promptPath: string, settings: Settings): Promise<void> {
    /*
    FNXC:PlanReview 2026-06-29-12:35:
    A reviewer outage parks tasks as plan-review-unavailable after PROMPT.md is already accepted. Backoff retry must reuse that exact PROMPT.md and rerun only the Plan Review gate; sending the task through the planner again would rewrite an approved draft without reviewer feedback.
    */
    const parkInvalidRetry = async (failure: string): Promise<void> => {
      planLog.warn(`${task.id}: ${failure}`);
      await this.store.logEntry(task.id, failure).catch((logError: unknown) => {
        const logMessage = logError instanceof Error ? logError.message : String(logError);
        planLog.warn(`${task.id}: failed to log invalid PROMPT.md during Plan Review retry: ${logMessage}`);
      });
      await this.store.updateTask(task.id, {
        status: "failed",
        error: failure,
        nextRecoveryAt: null,
      }).catch((updateError: unknown) => {
        const updateMessage = updateError instanceof Error ? updateError.message : String(updateError);
        planLog.warn(`${task.id}: failed to persist invalid PROMPT.md Plan Review retry failure: ${updateMessage}`);
      });
    };

    const written = await readFile(join(this.rootDir, promptPath), "utf-8").catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      await parkInvalidRetry(`Plan Review retry could not read existing PROMPT.md (${promptPath}): ${message}`);
      return null;
    });

    if (written === null) {
      return;
    }

    if (!written.trim()) {
      await parkInvalidRetry(`Plan Review retry found existing PROMPT.md (${promptPath}) but it is empty or whitespace-only.`);
      return;
    }

    const deterministicSpecFailure = await this.validateGeneratedPrompt(task.id, written);
    if (deterministicSpecFailure) {
      await parkInvalidRetry(
        `Plan Review retry PROMPT.md failed deterministic validation (${deterministicSpecFailure}). Fix the existing PROMPT.md or request a replan; reviewer-outage retry will not restart planning.`,
      );
      return;
    }

    await this.store.updateTask(task.id, { status: "planning", error: null }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      planLog.warn(`${task.id}: failed to mark Plan Review retry as planning: ${message}`);
    });

    await this.finalizeApprovedTask(
      { ...task, status: "planning" },
      written,
      settings,
      {
        recoveryLogAction: "Plan Review retry approved existing PROMPT.md — moved to execution",
        preservePromptContent: true,
      },
    );
  }

  private async validateGeneratedPrompt(taskId: string, promptContent: string): Promise<string | null> {
    /*
    FNXC:PlanReview 2026-06-29-01:52:
    Triage owns only deterministic PROMPT.md hygiene. AI plan quality review is graph-owned by the optional Plan Review step, so this helper must never call reviewer agents or require a fn_review_spec APPROVE verdict.
    */
    if (!promptContent.trim()) {
      return "PROMPT.md file not found or empty";
    }

    const danglingRefs = await detectDanglingTaskDocReferences(promptContent, {
      rootDir: this.rootDir,
      taskId,
    });
    if (danglingRefs.length > 0) {
      const diagnostic = formatDanglingDiagnostic(danglingRefs);
      planLog.warn(`${taskId}: ${diagnostic}`);
      await this.store.logEntry(taskId, "Generated plan validation failed: dangling task-document references");
      return diagnostic;
    }

    const evidenceGaps = detectExternalIntegrationEvidenceGaps({
      promptContent,
    });
    if (evidenceGaps.length > 0) {
      const diagnostic = formatExternalIntegrationEvidenceDiagnostic(evidenceGaps);
      planLog.warn(`${taskId}: ${diagnostic}`);
      await this.store.logEntry(taskId, "Generated plan validation failed: external-integration evidence gaps");
      return diagnostic;
    }

    return null;
  }

  private isPlanReviewEnabled(task: Task): boolean {
    /*
    FNXC:PlanReview 2026-06-29-02:40:
    Plan Review is a triage-owned pre-release gate. Task creation materializes default-on optional groups into `enabledWorkflowSteps`; an explicit empty array from Quick Add means the operator disabled every optional group. Use only that materialized list here so triage does not resurrect disabled Plan Review.
    */
    return Array.isArray(task.enabledWorkflowSteps) && task.enabledWorkflowSteps.includes(PLAN_REVIEW_GROUP_ID);
  }

  private async recordPlanReviewWorkflowResult(task: Task, result: WorkflowStepResult): Promise<void> {
    const live = await this.store.getTask(task.id).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      planLog.warn(`${task.id}: failed to load existing Plan Review workflow results; preserving in-memory result baseline: ${message}`);
      return task;
    });
    const existing = Array.isArray(live?.workflowStepResults)
      ? [...live.workflowStepResults]
      : [];
    const idx = existing.findIndex((entry) => entry.workflowStepId === PLAN_REVIEW_GROUP_ID);
    if (idx >= 0) existing[idx] = result;
    else existing.push(result);
    await this.store.updateTask(task.id, { workflowStepResults: existing });
  }

  private async runPlanReviewBeforeExecution(task: Task, promptContent: string, settings: Settings): Promise<"approved" | "blocked"> {
    if (!this.isPlanReviewEnabled(task)) {
      return "approved";
    }

    const alreadyPassed = task.workflowStepResults?.some(
      (result) => result.workflowStepId === PLAN_REVIEW_GROUP_ID && result.status === "passed",
    );
    if (alreadyPassed) {
      return "approved";
    }

    const startedAt = new Date().toISOString();
    await this.recordPlanReviewWorkflowResult(task, {
      workflowStepId: PLAN_REVIEW_GROUP_ID,
      workflowStepName: "Plan Review",
      phase: "pre-merge",
      status: "pending",
      startedAt,
    });
    await this.store.logEntry(task.id, "[pre-merge] Starting workflow step: Plan Review");

    const review = await reviewStep(
      this.rootDir,
      task.id,
      0,
      "PROMPT.md",
      "plan",
      promptContent,
      undefined,
      {
        store: this.store,
        taskId: task.id,
        taskTitle: task.title,
        settings,
        task,
        rootDir: this.rootDir,
        agentStore: this.options.agentStore,
        pluginRunner: this.options.pluginRunner,
        onSessionCreated: (session) => this.registerSubagentSession(task.id, session),
        onSessionEnded: (session) => this.unregisterSubagentSession(task.id, session),
      },
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      planLog.warn(`${task.id}: Plan Review unavailable before execution (${message})`);
      return {
        verdict: "UNAVAILABLE" as const,
        review: `Plan Review session failed before producing a verdict: ${message}`,
        summary: "Plan Review session unavailable.",
      };
    });

    const completedAt = new Date().toISOString();
    if (review.verdict === "APPROVE") {
      await this.recordPlanReviewWorkflowResult(task, {
        workflowStepId: PLAN_REVIEW_GROUP_ID,
        workflowStepName: "Plan Review",
        phase: "pre-merge",
        status: "passed",
        verdict: "APPROVE",
        output: review.review,
        notes: review.summary,
        startedAt,
        completedAt,
      });
      await this.store.logEntry(task.id, "[pre-merge] Workflow step completed: Plan Review", review.summary);
      return "approved";
    }

    if (review.verdict === "REVISE" || review.verdict === "RETHINK") {
      await this.recordPlanReviewWorkflowResult(task, {
        workflowStepId: PLAN_REVIEW_GROUP_ID,
        workflowStepName: "Plan Review",
        phase: "pre-merge",
        status: "failed",
        verdict: "REVISE",
        output: review.review,
        notes: review.summary,
        startedAt,
        completedAt,
      });
      await this.store.logEntry(task.id, "[pre-merge] Workflow step failed: Plan Review", review.review);
      await this.store.logEntry(
        task.id,
        "AI spec revision requested",
        `Plan Review requested a planning revision before execution.\n\nStatus: ${review.verdict}\nFeedback:\n${review.review || review.summary || "(no feedback captured)"}`,
      );
      await this.store.updateTask(task.id, {
        status: "needs-replan",
        error: null,
        recoveryRetryCount: null,
        nextRecoveryAt: null,
      });
      return "blocked";
    }

    /*
    FNXC:PlanReview 2026-06-29-02:40:
    UNAVAILABLE means the reviewer session did not produce a usable verdict. Keep the task in triage and retry with backoff; do not fabricate a REVISE or send the planner through another full rewrite loop when no reviewer actually rejected the plan.
    */
    const retryAt = new Date(Date.now() + 30_000).toISOString();
    const unavailableOutput = review.review || review.summary || "Plan Review was unavailable before producing a verdict.";
    await this.recordPlanReviewWorkflowResult(task, {
      workflowStepId: PLAN_REVIEW_GROUP_ID,
      workflowStepName: "Plan Review",
      phase: "pre-merge",
      status: "failed",
      output: unavailableOutput,
      notes: review.summary,
      startedAt,
      completedAt,
    });
    await this.store.logEntry(task.id, "[pre-merge] Workflow step unavailable: Plan Review", unavailableOutput);
    await this.store.updateTask(task.id, {
      status: "plan-review-unavailable",
      error: "Plan Review did not produce a verdict; retrying from triage.",
      nextRecoveryAt: retryAt,
    });
    return "blocked";
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
      preservePromptContent?: boolean;
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
    const shouldClearWorkflowRunStepInstances =
      parsedSteps.length > 0
      && (options.isReplan === true || (task.steps?.length ?? 0) > 0);

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

    if (!options.preservePromptContent) {
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
      planLog.warn(`${task.id}: failed to re-read task before planning transition (${message}); proceeding with original task snapshot`);
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
      planLog.log(`${task.id} specified task paused — leaving in triage, will resume on unpause`);
      return;
    }

    const planReviewTask = latestTransitionTask ?? task;
    const planReviewResult = await this.runPlanReviewBeforeExecution(planReviewTask, written, settings);
    if (planReviewResult === "blocked") {
      planLog.log(`${task.id} Plan Review blocked execution — staying in triage`);
      return;
    }

    /*
    FNXC:PlanApproval 2026-06-26-00:00:
    Project planApprovalMode has precedence over the workflow-resolved requirePlanApproval value so operators can force auto-approval or manual approval for every task in this project.
    */
    if (resolvePlanApprovalRequired(settings)) {
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

    if (shouldClearWorkflowRunStepInstances) {
      /*
      FNXC:WorkflowReplan 2026-06-29-00:33:
      AI spec revision replaces the task's step-source PROMPT.md, so graph foreach instance pins from the previous plan must be discarded before execution reparses steps. Otherwise rebuilt tasks can fail at parse with a stale pin-mismatch even though the new plan is valid.

      FNXC:WorkflowReplan 2026-06-29-02:24:
      User-triggered spec rebuilds can race an old paused graph run that writes step-instance rows after the route cleared them. Clear again when triage accepts a fresh parsed plan over an existing step projection, even if the task snapshot no longer has status `needs-replan`.
      */
      const maybeStore = this.store as unknown as {
        clearWorkflowRunStepInstances?: (taskId: string) => void;
      };
      try {
        maybeStore.clearWorkflowRunStepInstances?.(task.id);
      } catch {
        // Older stores may not persist graph step instances; replanning remains valid without cleanup.
      }
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
  return extractEffectiveWriteScopeFromPrompt(text);
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
        const detectedMimeType = detectImageMimeFromBytes(data);
        const imageMimeType = detectedMimeType ?? att.mimeType;
        if (detectedMimeType && detectedMimeType !== att.mimeType) {
          planLog.warn(`${taskId}: corrected image attachment media type for '${att.filename}' (${att.originalName}) from ${att.mimeType} to ${detectedMimeType}`);
        }
        imageContents.push({
          type: "image",
          data: data.toString("base64"),
          mimeType: imageMimeType,
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
