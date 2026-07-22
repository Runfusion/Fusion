/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fusionCore from "@fusion/core";
import type {
  TaskStore,
  Task,
  TaskDetail,
  TaskAttachment,
  Settings,
  Agent,
  AgentPermissionPolicy,
  PermanentAgentGatingContext,
} from "@fusion/core";
import {
  DUPLICATE_OF_METADATA_KEY,
  PLAN_REVIEW_GROUP_ID,
  TaskDeletedError,
  buildTriageMemoryInstructions,
  isUnplannedSeedPrompt,
  getTaskDuplicateLineage,
  parseExplicitDuplicateMarker,
  resolveAgentPrompt,
  builtinSeamPrompt,
  renderTriagePolicyPlaceholders,
  resolveEffectiveSettingsDetailed,
  resolveEffectivePlannerHeartbeatPatrolEnabled,
  resolveTaskPlanningPrompt,
  resolveTaskSeamPrompt,
  resolvePersistAgentThinkingLog,
  compareTaskIdNumeric,
  resolveAgentMemoryInclusionMode,
  resolvePlanApprovalRequired,
  resolveWorkflowIrForTask,
  getStepParser,
  computePlanApprovalFingerprint,
  extractIntentSignature,
  findNearDuplicates,
  isNearDuplicateCanonicalInactive,
  detectImageMimeFromBytes,
  applyFrontendUxCriteria,
  applyOriginalDescription,
  extractEffectiveWriteScopeFromPrompt,
  ApprovalRequestStore,
  AWAITING_APPROVAL_PAUSE_REASON,
  isEphemeralAgent,
  resolveEffectiveAgentPermissionPolicy,
  MAX_TASK_LIST_TEXT_CHARS,
  deriveFallbackTaskTitle,
  detectContentLanguage,
  localeDisplayName,
  parsePlanningPlanMd,
  type NearDuplicateCandidate,
} from "@fusion/core";


type TaskListClamp = (lines: string[], opts?: { maxChars?: number }) => string;
type TaskListFormatter = (
  lines: string[],
  opts?: { maxChars?: number; clamp?: TaskListClamp },
) => string;

const TRIAGE_STUCK_RESUME_LOG_ACTION = "Triage stuck re-queue will resume existing planning draft";
const TRIAGE_STUCK_RESUME_FEEDBACK = "The previous triage session was killed by the stuck-task detector after writing a non-empty planning draft. Resume from the existing draft below: preserve useful structure and decisions, fill gaps, and continue toward review instead of restarting planning from scratch.";

/*
FNXC:PlanReviewReplan 2026-07-13-00:00:
The triage pre-execution Plan Review gate (runPlanReviewBeforeExecution) routes a REVISE
verdict back to `needs-replan`, which re-plans and re-reviews. Without a ceiling, a planner
and reviewer that persistently disagree loop plan → Plan Review REVISE → replan forever
(observed on TC-002), and in `planApprovalMode: require-all` there is no human escape because
the task never reaches `awaiting-approval`. Bound the consecutive REVISE replans with a
cap (default 8, mirroring the executor graph's PLAN_REVIEW_REPLAN_HARD_CAP backstop): after
this many replans the gate escalates the task to `awaiting-approval` for a human decision
instead of replanning again. The counter (Task.planReviewReplanCount) resets when the gate passes.

FNXC:PlanReviewReplan 2026-07-15-11:09:
Raise the automatic REVISE replan ceiling from 3 to 8 so planner/reviewer pairs get more
room to converge before escalation. When the cap is hit, the dashboard must still make the
approval reason explicit (awaitingApprovalReason `plan-review-replan-cap`) so operators know
this is a non-converging Plan Review loop, not a routine require-all plan gate.
*/
export const PLAN_REVIEW_GATE_REPLAN_CAP = 8;

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
import { ModelFallbackExhaustedError, describeModel, formatModelMarkerDetails, promptWithFallback } from "./pi.js";
import { hasAdvancedPastPlanning, isTaskStillInPlanningStage } from "./replan-target.js";
import {
  createResolvedAgentSession,
  extractRuntimeHint,
  resolveImplicitPlanningFallbackModel,
  resolvePlanningSessionModel,
  resolvePlanningThinkingLevel,
} from "./agent-session-helpers.js";
import { mergeEffectiveSettings } from "./effective-settings.js";
import { detectDanglingTaskDocReferences, formatDanglingDiagnostic } from "./spec-validation/task-document-references.js";
import { buildSessionSkillContext } from "./session-skill-context.js";
import {
  PRIORITY_SPECIFY,
  computeTopLevelConcurrencyClaimedFromStore,
  dropPreHeldExecutorSlot,
  projectAdmissionCoordinator,
  registerPreHeldExecutorSlot,
  takePreHeldExecutorSlot,
  recoverIdleSemaphoreLeakCandidate,
  type AgentSemaphore,
} from "./concurrency.js";
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
import { isOperatorActionableAgentError, isTransientError, isSilentTransientError } from "./transient-error-detector.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "./recovery-policy.js";
import type { StuckTaskDetector } from "./stuck-task-detector.js";
import { exec } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createAgentTask,
  createDelegateTaskTool,
  createTaskAssignTool,
  createListAgentsTool,
  createMemoryTools,
  createGoalRetrievalTools,
  createMissionTools,
  createIdeationTools,
  createResearchTools,
  createWebFetchTool,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
  createTaskPromptWriteTool,
  createWorkflowListTool,
  createWorkflowSelectTool,
} from "./agent-tools.js";
import {
  getResearchGuidanceForSurface,
  isResearchToolSurfaceEnabled,
} from "./tool-availability.js";
import { runGhostBugPreflight } from "./triage-preflight.js";
import { archiveAsGhostBug } from "./self-healing.js";
import { createRunAuditor, generateSyntheticRunId } from "./run-audit.js";
import { resolveAndEmitGoalContext } from "./goal-injection-diagnostics.js";
import { accumulateSessionTokenUsage } from "./session-token-usage.js";
import { finalizePlanningSegment, startPlanningSegment } from "@fusion/core";
import type { AgentActionGateContext } from "./agent-action-gate.js";
import { buildAgentGatedActionSummary } from "./permanent-agent-gating.js";


export interface TriageProcessorOptions {
  pollIntervalMs?: number;
  semaphore?: AgentSemaphore;
  /**
   * FNXC:ProviderRateLimitIsolation 2026-07-21-18:00:
   * Parks only tasks routed through the provider whose API limit was detected.
   */
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
  /** Synchronous ownership fence shared with advanced-triage self-healing. */
  private advancedRecoveryReservations = new Set<string>();
  /** Prevent a selected planner from reappearing before specifyTask claims it. */
  private readonly coordinatorAdmittedTaskIds = new Set<string>();
  /** Durable planning provider keeps this lane visible to execute/merge polls. */
  private unregisterAdmissionProvider: (() => void) | null = null;
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
  /**
   * FNXC:TriageStuckKill 2026-07-18-21:05:
   * Tasks currently inside `finalizeApprovedTask` (PROMPT hygiene → Plan Review →
   * column handoff). The main planning session is often already untracked/disposed by
   * the time Plan Review runs, so without this set a stuck-kill + stale-processing
   * eviction can drop the card from `processing` and let a concurrent second planner
   * claim `status:"planning"` while the first finalize still moves triage→todo — the
   * move does not clear planning statuses, so the scheduler then holds the card as
   * unplanned until the second planner finishes (FN-1312: 6m+ idle after Plan Review
   * APPROVE). Finalizing tasks stay in getProcessingTaskIds and are not rediscovered.
   */
  private finalizing = new Set<string>();
  /** Tasks aborted due to globalPause (to avoid reporting as errors). */
  private pauseAborted = new Set<string>();
  /** Tasks killed by the stuck task detector (to avoid reporting as errors). */
  private stuckAborted = new Set<string>();
  private taskDeletedHandler?: (task: Task) => void;
  private taskPausedHandler?: (task: Task) => void;
  private _approvalRequestStore?: ApprovalRequestStore;

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
  private get approvalRequestStore(): ApprovalRequestStore {
    if (!this._approvalRequestStore) {
      const layer = this.store.getAsyncLayer();
      if (!layer) throw new Error("Triage TaskStore is missing its PostgreSQL AsyncDataLayer");
      this._approvalRequestStore = new ApprovalRequestStore(null, { asyncLayer: layer });
    }
    return this._approvalRequestStore;
  }

  /*
  FNXC:TriageMissionGating 2026-07-30-10:25:
  Mission hierarchy mutations are available during triage, but must use the same
  policy and approval contexts as executor and heartbeat sessions. A planner is
  not a policy bypass: every non-read Mission tool remains action-gated and
  permanent-agent gated under the effective assigned-agent or project policy.
  */
  private buildActionGateContext(
    taskId: string,
    runId: string,
    agent: Agent | null,
    projectDefaultPolicy?: { rules?: Partial<AgentPermissionPolicy["rules"]>; toolRules?: AgentPermissionPolicy["toolRules"] },
  ): AgentActionGateContext {
    const actorId = agent?.id ?? `triage-${taskId}`;
    const actorName = agent?.name ?? `Triage planner ${taskId}`;
    const permissionPolicy = resolveEffectiveAgentPermissionPolicy(agent?.permissionPolicy, projectDefaultPolicy);
    return {
      agentId: actorId,
      agentName: actorName,
      isEphemeral: !agent || isEphemeralAgent(agent),
      taskId,
      runId,
      permissionPolicy,
      createApprovalRequest: async (decision, args) => await this.approvalRequestStore.create({
        requester: { actorId, actorType: "agent", actorName },
        taskId,
        runId,
        targetAction: {
          category: decision.category === "exempt" ? "command_execution" : decision.category,
          action: decision.operation,
          summary: decision.summary,
          resourceType: decision.resourceType,
          resourceId: decision.resourceId ?? "",
          context: { ...decision.metadata, approvalDedupeKey: decision.approvalDedupeKey, toolName: decision.toolName, toolArgs: args },
        },
      }),
      findApprovalByDedupeKey: async (dedupeKey) => {
        const latest = await this.approvalRequestStore.findLatestByDedupeKey({ requesterActorId: actorId, taskId, dedupeKey });
        return latest ? { id: latest.id, status: latest.status } : null;
      },
      pauseForApproval: async ({ approvalRequestId, decision }) => {
        await this.store.pauseTask(taskId, true, { runId, agentId: actorId, source: "triage" }, { pausedByAgentId: actorId, pausedReason: AWAITING_APPROVAL_PAUSE_REASON });
        await this.store.logEntry(taskId, `Approval required for ${decision.toolName}. Request ${approvalRequestId} created; task and agent paused awaiting decision.`);
        if (agent && this.options.agentStore) {
          await this.options.agentStore.updateAgentState(agent.id, "paused");
          await this.options.agentStore.updateAgent(agent.id, { pauseReason: "awaiting-approval" });
        }
        queueMicrotask(() => this.activeSessions.get(taskId)?.dispose());
      },
      markApprovalCompleted: async (approvalRequestId) => {
        await this.approvalRequestStore.markCompleted(approvalRequestId, { actor: { actorId, actorType: "agent", actorName }, note: "Tool executed after approval" });
      },
    };
  }

  private buildPermanentAgentGatingContext(
    taskId: string,
    runId: string,
    agent: Agent | null,
    projectDefaultPolicy?: { rules?: Partial<AgentPermissionPolicy["rules"]>; toolRules?: AgentPermissionPolicy["toolRules"] },
  ): PermanentAgentGatingContext {
    const actorId = agent?.id ?? `triage-${taskId}`;
    const actorName = agent?.name ?? `Triage planner ${taskId}`;
    return {
      permissionPolicy: resolveEffectiveAgentPermissionPolicy(agent?.permissionPolicy, projectDefaultPolicy),
      requester: { actorId, actorType: "agent", actorName },
      taskId,
      runId,
      createApprovalRequest: async ({ category, toolName, args, approvalDedupeKey }) => await this.approvalRequestStore.create({
        requester: { actorId, actorType: "agent", actorName },
        taskId,
        runId,
        targetAction: {
          category,
          action: toolName,
          summary: buildAgentGatedActionSummary(toolName, args),
          resourceType: "tool",
          resourceId: toolName,
          context: { toolName, toolArgs: args, source: "agent-gating", ...(approvalDedupeKey ? { approvalDedupeKey } : {}) },
        },
      }),
      findPendingApprovalRequest: async (dedupeKey) => {
        const pending = await this.approvalRequestStore.list({ status: "pending", requesterActorId: actorId, taskId, limit: 100 });
        return pending.find((request) => request.targetAction.context?.approvalDedupeKey === dedupeKey) ?? null;
      },
    };
  }

  constructor(
    private store: TaskStore,
    private rootDir: string,
    private options: TriageProcessorOptions = {},
  ) {
    this.unregisterAdmissionProvider = projectAdmissionCoordinator.registerProvider(`specify:${this.rootDir}`, {
      projectId: this.rootDir,
      refresh: async () => {
        const settings = await this.store.getSettings();
        // poll() supplies its own fresh candidates to the same admission pass;
        // do not duplicate them through this durable provider or a provider
        // handoff can bypass the poll's bounded refinement scheduling.
        if (!this.running || this.polling || settings.globalPause || settings.enginePaused) return [];
        const now = Date.now();
        // FNXC:ConcurrencyAdmission 2026-08-07-10:30:
        // FN-8453/#2359 requires coordinator refresh to use the identical
        // discovery predicate as poll(). A seed is ready before specifyTask
        // stamps status:"planning"; exposing only that durable status lets newer
        // execute/merge work overtake an older planner.
        const tasks = await this.discoverReadyPlanningTasks(
          await this.store.listTasks({ slim: true, includeArchived: false }),
          now,
        );
        return tasks.filter((task) => !this.coordinatorAdmittedTaskIds.has(task.id)).map((task) => ({
          taskId: task.id, projectId: this.rootDir, createdAt: task.createdAt,
          reserve: () => { if (this.options.semaphore) registerPreHeldExecutorSlot(task.id); },
          start: async () => {
            this.coordinatorAdmittedTaskIds.add(task.id);
            void this.specifyTask(task);
          },
        }));
      },
    });
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
    /*
    FNXC:CodingIdeasWorkflow 2026-07-04-12:00:
    In the merged planner/capacity "todo" column a task can carry status "planning" when the triage service is specifying it in place. A crash/restart before planning completes leaves that status set, so the startup sweep must clear it from BOTH triage and todo — otherwise a stale planning todo task permanently occupies a maxTriageConcurrent slot and blocks new triage work.
    */
    const triageTasks = await this.store.listTasks({ column: "triage", slim: true });
    const todoTasks = await this.store.listTasks({ column: "todo", slim: true });
    const stale = [...triageTasks, ...todoTasks].filter(
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
    this.unregisterAdmissionProvider?.();
    this.unregisterAdmissionProvider = null;
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
   *
   * FNXC:TriageStuckKill 2026-07-18-21:05:
   * Include Plan Review subagents and in-flight finalize handoffs so self-healing
   * and poll rediscovery cannot start a second planner while the first session is
   * still completing Plan Review → todo after a stuck-kill of the main session.
   */
  getProcessingTaskIds(): Set<string> {
    const ids = this.getPlanningTaskIds();
    for (const taskId of this.advancedRecoveryReservations) ids.add(taskId);
    return ids;
  }

  /**
   * Return tasks owned by actual planner work, excluding recovery reservations.
   * Recovery uses this narrower view when revalidating its own reserved task.
   */
  getPlanningTaskIds(): Set<string> {
    const ids = new Set(this.processing);
    for (const taskId of this.finalizing) ids.add(taskId);
    for (const taskId of this.activeSubagentSessions.keys()) {
      const sessions = this.activeSubagentSessions.get(taskId);
      if (sessions && sessions.size > 0) ids.add(taskId);
    }
    return ids;
  }

  /**
   * Reserve a task for advanced-state recovery unless planning already owns it.
   * The check-and-add is synchronous, as is specifyTask's reciprocal guard, so
   * neither side can slip between ownership inspection and acquisition.
   */
  tryReserveAdvancedRecovery(taskId: string): (() => void) | undefined {
    if (
      this.advancedRecoveryReservations.has(taskId)
      || this.processing.has(taskId)
      || this.hasLivePlanningWork(taskId)
    ) {
      return undefined;
    }
    this.advancedRecoveryReservations.add(taskId);
    return () => this.advancedRecoveryReservations.delete(taskId);
  }

  /** True when this processor still owns live work for `taskId` (main, subagent, or finalize). */
  private hasLivePlanningWork(taskId: string): boolean {
    if (this.finalizing.has(taskId)) return true;
    const subagents = this.activeSubagentSessions.get(taskId);
    if (subagents && subagents.size > 0) return true;
    return this.activeSessions.has(taskId) && !this.stuckAborted.has(taskId);
  }

  /**
   * Maximum time a task can remain in the `processing` set before a hung,
   * non-live session is considered stale (30 minutes). A live session remains
   * protected regardless of elapsed time; a stuck-aborted session is still
   * reclaimable because its promise may never reach the cleanup `finally`.
   */
  private static readonly STALE_PROCESSING_THRESHOLD_MS = 30 * 60 * 1000;

  /**
   * Evict stale tasks from `processing` only when their triage promise is no
   * longer live. This reclaims a stuck-killed/disposed session whose
   * `specifyTask` promise never settles, while preserving a session still
   * streaming past the normal wall-clock threshold.
   *
   * @returns the set of evicted task IDs
   */
  evictStaleProcessing(): Set<string> {
    const now = Date.now();
    const threshold = TriageProcessor.STALE_PROCESSING_THRESHOLD_MS;
    const evicted = new Set<string>();

    for (const [taskId, since] of this.processingSince) {
      if (now - since < threshold) continue;

      /*
      FNXC:Triage 2026-07-16-18:29:
      Stale-processing eviction must retain a task with a live, non-aborted triage session (`activeSessions.has(id) && !stuckAborted.has(id)`). Removing it would drop genuinely active planning from `getProcessingTaskIds()` and let self-healing prematurely finalize it to todo/awaiting-approval, clear planning status, or nudge priority. Hung promises without a session and stuck-aborted/disposed sessions remain evictable.

      FNXC:TriageStuckKill 2026-07-18-21:05:
      Also retain Plan Review subagents and finalize handoffs after the main session is
      stuck-killed. Stuck kill often fires near the 30m threshold (same clock as this
      eviction), so without this guard the card is rediscovered while finalize is still
      moving triage→todo and a concurrent planner leaves `status:"planning"` on a
      todo card the scheduler refuses to release (FN-1312).
      */
      if (this.hasLivePlanningWork(taskId)) continue;

      planLog.warn(
        `${taskId} has been in processing for ${Math.round((now - since) / 60_000)}min ` +
        `(threshold: ${Math.round(threshold / 60_000)}min) — evicting (likely hung promise)`,
      );
      this.processing.delete(taskId);
      this.processingSince.delete(taskId);
      this.activeSessions.delete(taskId);
      this.stuckAborted.delete(taskId);
      this.finalizing.delete(taskId);
      evicted.add(taskId);
    }

    return evicted;
  }

  /** True when Plan Review already recorded a passed verdict on this task. */
  private hasPassedPlanReview(task: Pick<Task, "workflowStepResults">): boolean {
    return task.workflowStepResults?.some(
      (result) => result.workflowStepId === PLAN_REVIEW_GROUP_ID && result.status === "passed",
    ) === true;
  }

  /**
   * Recover a triage task whose PROMPT.md was already written but the final
   * handoff out of planning never completed.
   *
   * FNXC:TriageStuckKill 2026-07-18-21:05:
   * Classic path: status is `planning`. Extended path: status is null after finalize's
   * early clear ONLY when Plan Review already passed — null alone must not promote an
   * unapproved draft (a lightly-edited seed can fail the exact seed equality check).
   * Do not recover `needs-replan` / `plan-review-unavailable`.
   */
  async recoverApprovedTask(task: Task): Promise<boolean> {
    const recoverableStatus =
      task.status === "planning"
      || (task.status == null && this.hasPassedPlanReview(task));
    if (task.column !== "triage" || !recoverableStatus) {
      return false;
    }

    if (task.paused === true || task.userPaused === true) {
      planLog.log(`${task.id} planning recovery skipped — task is paused`);
      return false;
    }

    /*
    FNXC:PlanApproval 2026-07-01-08:12:
    Recovery finalizes an already-written PROMPT.md and must use the same merged project/workflow settings as fresh triage. The project planApprovalMode value stays project-scoped while workflow requirePlanApproval may overlay, so auto-approve-all still wins for ordinary plan approval.
    */
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

    // Bootstrap / refinement seeds are not approved specs — leave them for normal planning.
    if (isUnplannedSeedPrompt(written, task.id, task.title, task.description)) {
      planLog.warn(`${task.id} planning recovery skipped — PROMPT.md is still an unplanned seed`);
      return false;
    }

    const deterministicSpecFailure = await this.validateGeneratedPrompt(task.id, written);
    if (deterministicSpecFailure) {
      planLog.warn(`${task.id} planning recovery skipped — PROMPT.md failed deterministic validation (${deterministicSpecFailure})`);
      return false;
    }

    /*
    FNXC:TriageStuckRecovery 2026-07-20:
    A stuck planner may leave a partially edited seed that no longer matches the
    byte-exact unplanned-seed detector. For step-heading workflows, non-empty prose
    is not executable proof: require parsed steps unless the plan explicitly opts
    into the legitimate zero-work contract. Otherwise recovery would release the
    task to parse-steps, whose empty foreach could advance toward merge.

    FNXC:TriageStuckRecovery 2026-07-21-00:15:
    Explicit `DUPLICATE: FN-NNNN` markers are not implementation specs — they short-circuit
    to flag/delete/clear in finalizeApprovedTask. Requiring step headings for those markers
    withheld recovery forever (empty steps) so the marker path never ran.
    */
    const isExplicitDuplicateRedirect = Boolean(parseExplicitDuplicateMarker(written));
    const workflow = await resolveWorkflowIrForTask(this.store, task.id).catch(() => undefined);
    const requiresPromptImplementationSteps = workflow?.nodes.some((node) =>
      node.kind === "parse-steps"
      && (node.config?.artifact === undefined || node.config.artifact === "PROMPT.md")
      && node.config?.parser === "step-headings"
      && node.config?.requireStepsUnlessNoCommits === true
    ) === true;
    if (
      !isExplicitDuplicateRedirect
      && requiresPromptImplementationSteps
      && !promptDeclaresNoCommitsExpected(written)
    ) {
      const parsedSteps = getStepParser("step-headings")?.parse(written).steps ?? [];
      if (parsedSteps.length === 0) {
        const message = "Planning recovery withheld: PROMPT.md has no executable steps and does not declare no commits expected";
        planLog.warn(`${task.id} ${message}`);
        await this.store.logEntry(task.id, message);
        return false;
      }
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

    FNXC:TriageStuckKill 2026-07-18-21:05:
    Do not invalidate an already-approved plan. Finalize clears `status` to null before Plan
    Review, so a stuck-kill mid-review used to skip recoverApprovedTask (which required
    status:"planning") and force needs-replan — even when Plan Review had just APPROVEd and
    the card was about to move to todo. That left the scheduler holding an "unplanned" todo
    card until a second planner rewrote PROMPT.md (FN-1312). If Plan Review already passed
    or a valid draft exists after the early status clear, complete the handoff instead of
    replan-invalidating.
    */
    const freshTask = await this.store.getTask(task.id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${task.id}: failed to refresh task during stuck-detector ${context} cleanup: ${msg}`);
      return task;
    });

    /*
    FNXC:TriageStuckKill 2026-07-18-21:05:
    If finalize is still running Plan Review after the main session was killed, leave the
    card alone — the in-flight finalize owns the handoff. Setting needs-replan here races
    the APPROVE path and strands the card unplanned in todo.
    */
    if (this.finalizing.has(task.id) || (this.activeSubagentSessions.get(task.id)?.size ?? 0) > 0) {
      planLog.log(
        `${task.id} killed by stuck detector during Plan Review/finalize — deferring requeue to the in-flight handoff (${context})`,
      );
      await this.store.updateTask(task.id, {
        stuckKillCount: (freshTask.stuckKillCount ?? task.stuckKillCount ?? 0) + 1,
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        planLog.warn(`${task.id}: failed to increment stuckKillCount during deferred stuck-detector ${context} cleanup: ${msg}`);
      });
      return;
    }

    /*
    FNXC:TriageStuckKill 2026-07-18-22:30:
    Finalize can succeed (move to todo + clear status) and clear `finalizing` before the
    outer stuckAborted catch runs — e.g. dispose of an already-killed main session throws
    after handoff. Recovery then fails (column is no longer triage) and the draft path
    would write needs-replan, re-stranding an approved plan (Greptile P1 on PR #2326).

    FNXC:TriageStuckKill 2026-07-18-22:50:
    Do NOT treat every `todo` card as released. Plan-in-place workflows plan inside `todo`
    with status:"planning"/"needs-replan"; those must still requeue (CodeRabbit on PR #2326).
    hasAdvancedPastPlanning covers execution columns and released todo (steps/worktree).
    Released handoffs with status cleared but no steps yet are also preserved: todo without
    a planning-stage status means the scheduler can claim the card.
    */
    const planningStageStatus =
      freshTask.status === "planning"
      || freshTask.status === "needs-replan"
      || freshTask.status === "plan-review-unavailable";
    const releasedToTodo = freshTask.column === "todo" && !planningStageStatus;
    if (hasAdvancedPastPlanning(freshTask) || releasedToTodo) {
      const nextStuckKillCount = (freshTask.stuckKillCount ?? task.stuckKillCount ?? 0) + 1;
      planLog.log(
        `${task.id} killed by stuck detector after planning handoff completed (column=${freshTask.column}, status=${freshTask.status ?? "null"}) — preserving released state (${context})`,
      );
      await this.store.updateTask(task.id, { stuckKillCount: nextStuckKillCount }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        planLog.warn(`${task.id}: failed to increment stuckKillCount after post-handoff stuck-detector ${context} cleanup: ${msg}`);
      });
      return;
    }

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
  /**
   * Discover planner-ready work for both direct triage polling and coordinator
   * refresh. Keeping the seed-prompt checks here makes the cross-lane admission
   * union include cards before their planner writes status:"planning".
   */
  private async discoverReadyPlanningTasks(allTasks: Task[], now: number): Promise<Task[]> {
    const eligibleTriageTasks = allTasks.filter(
      (t) => t.column === "triage" && isTaskStillInPlanningStage(t)
        && !this.advancedRecoveryReservations.has(t.id)
        && !this.processing.has(t.id) && !this.hasLivePlanningWork(t.id) && !t.paused
        && t.status !== "awaiting-approval" && t.status !== "failed" && t.status !== "stuck-killed"
        && !(t.nextRecoveryAt && new Date(t.nextRecoveryAt).getTime() > now),
    );
    const eligibleTodoTasksRaw = allTasks.filter(
      (t) => t.column === "todo" && !this.processing.has(t.id) && !this.hasLivePlanningWork(t.id) && !t.paused
        && t.status !== "awaiting-approval" && t.status !== "failed" && t.status !== "stuck-killed"
        && t.status !== "planning"
        && !(t.nextRecoveryAt && new Date(t.nextRecoveryAt).getTime() > now),
    );
    const eligibleTodoTasks: Task[] = [];
    for (const todoTask of eligibleTodoTasksRaw) {
      if (todoTask.status === "needs-replan") {
        eligibleTodoTasks.push(todoTask);
        continue;
      }
      try {
        const promptPath = join(this.rootDir, ".fusion", "tasks", todoTask.id, "PROMPT.md");
        const content = await readFile(promptPath, "utf-8");
        if (isUnplannedSeedPrompt(content, todoTask.id, todoTask.title, todoTask.description)) {
          eligibleTodoTasks.push(todoTask);
        }
      } catch {
        // Missing/unreadable prompt — scheduler filesystem validation owns it.
      }
    }
    return [...eligibleTriageTasks, ...eligibleTodoTasks].sort((a, b) => {
      const aTime = Date.parse(a.createdAt);
      const bTime = Date.parse(b.createdAt);
      const aValid = Number.isFinite(aTime);
      const bValid = Number.isFinite(bTime);
      if (aValid !== bValid) return aValid ? -1 : 1;
      if (aValid && aTime !== bTime) return aTime - bTime;
      const numeric = compareTaskIdNumeric(a.id, b.id);
      return numeric !== 0 ? numeric : a.id.localeCompare(b.id);
    });
  }

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
            "(semaphore over-held vs persisted+in-flight top-level agent work)",
          );
        }
        this.idleSemaphoreLeakCandidateSince = result.candidateSinceMs;
      }

      const triageTasks = await this.discoverReadyPlanningTasks(allTasks, now);

      /*
      FNXC:ConcurrencyAdmission 2026-08-03-12:00:
      FN-8453 removes the separate maxTriageConcurrent pool. Planning uses the
      same maxConcurrent live-agent claim as execute/review so a project cannot
      exceed its operator-facing top-level capacity in a different lane.
      */
      const maxConcurrent = settings.maxConcurrent ?? 2;
      const semaphoreAvailable = this.options.semaphore
        ? Math.max(0, this.options.semaphore.availableCount)
        : Infinity;
      // processing entries that have not yet written status:"planning" still claim a future slot.
      let pendingSpecifyCount = 0;
      for (const id of this.processing) {
        const row = allTasks.find((t) => t.id === id);
        if (!row || row.status !== "planning") pendingSpecifyCount += 1;
      }
      const claimed = await computeTopLevelConcurrencyClaimedFromStore({
        store: this.store,
        tasks: allTasks,
        pendingSpecifyCount,
      });
      // `claimed` is project-local. The scoped/global host semaphore remains a
      // distinct process-wide availability gate, so project A cannot spend B's cap.
      const projectRoom = Math.max(0, maxConcurrent - claimed);
      const maxToStart = Math.min(projectRoom, semaphoreAvailable);

      if (maxToStart <= 0 && triageTasks.length > 0) {
        const semaphoreSnapshot = this.options.semaphore?.snapshot();
        const semaphoreDetail = semaphoreSnapshot
          ? `, semaphore active=${semaphoreSnapshot.activeCount}/${semaphoreSnapshot.limit}, available=${semaphoreSnapshot.availableCount}, waiting=${semaphoreSnapshot.waitingCount}`
          : ", semaphore unavailable";
        const processingIds = [...this.processing].slice(0, 5);
        const eligibleIds = triageTasks.slice(0, 5).map((t) => t.id);
        const blockedBy = projectRoom <= 0 ? "running-agent cap" : "global semaphore";
        planLog.log(
          `Plan throttled by ${blockedBy}: eligible=${triageTasks.length} [${eligibleIds.join(", ")}], ` +
          `maxConcurrent=${maxConcurrent}, claimed=${claimed}, processing=${this.processing.size}` +
          `${processingIds.length > 0 ? ` [${processingIds.join(", ")}]` : ""}${semaphoreDetail}`,
        );
      }

      // Keep handoff reservations visible even when a test/runtime wrapper delays
      // the planner's synchronous processing claim until after this poll returns.
      const admittedThisPoll = new Set<string>();
      for (let i = 0; i < Math.min(triageTasks.length, maxToStart); i++) {
        await projectAdmissionCoordinator.admitOldest({
          // rootDir is the stable per-project identity held by this processor.
          projectId: this.rootDir,
          maxConcurrent,
          claimed: async () => {
            const fresh = await this.store.listTasks({ slim: true, includeArchived: false });
            let pending = 0;
            for (const id of this.processing) {
              const row = fresh.find((task) => task.id === id);
              if (!row || row.status !== "planning") pending++;
            }
            return computeTopLevelConcurrencyClaimedFromStore({
              store: this.store,
              tasks: fresh,
              pendingSpecifyCount: pending,
            });
          },
          semaphore: this.options.semaphore,
          refresh: async () => triageTasks
            .filter((task) => !admittedThisPoll.has(task.id) && !this.coordinatorAdmittedTaskIds.has(task.id) && !this.processing.has(task.id) && !this.hasLivePlanningWork(task.id))
            .map((task) => ({
              taskId: task.id,
              projectId: this.rootDir,
              createdAt: task.createdAt,
              // FNXC:ConcurrencyAdmission 2026-08-05-10:00: the planner must
              // own the coordinator's real host reservation before it starts;
              // deferring to semaphore.run would reintroduce priority overtaking.
              reserve: () => { if (this.options.semaphore) registerPreHeldExecutorSlot(task.id); },
              start: async () => {
                admittedThisPoll.add(task.id);
                this.coordinatorAdmittedTaskIds.add(task.id);
                void this.specifyTask(task);
              },
            })),
        });
      }
    } catch (err) {
      planLog.error("Poll error:", err);
    } finally {
      this.polling = false;
    }
  }

  private async backfillBlankTitleAfterTerminalTriageFailure(task: Task): Promise<void> {
    /*
    FNXC:TriageTitleFallback 2026-07-14-00:00:
    Agent-created tasks may begin triage with a blank title because fn_task_create only accepts a description. Terminal planner failures must keep their original failed/error state, but they should best-effort derive a deterministic non-LLM title so dashboard and CLI rows are not permanently invisible.
    */
    try {
      const current = await this.store.getTask(task.id);
      if (current.title?.trim()) {
        return;
      }
      const fallbackTitle = deriveFallbackTaskTitle(current.description || task.description);
      await this.store.updateTask(task.id, { title: fallbackTitle });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      planLog.warn(`${task.id}: failed to backfill blank title after terminal triage failure: ${msg}`);
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
    /*
    FNXC:TriageStuckKill 2026-07-18-21:05:
    Refuse a second planner when finalize/Plan Review is still live even if
    `processing` was cleared by a stuck-kill eviction race. Concurrent claim is
    what leaves `status:"planning"` on a todo card after Plan Review APPROVE.
    */
    if (
      this.advancedRecoveryReservations.has(task.id)
      || this.processing.has(task.id)
      || this.hasLivePlanningWork(task.id)
    ) {
      // FNXC:ConcurrencyAdmission 2026-08-06-09:00:
      // A coordinator winner owns a real pre-held host slot. A duplicate/stale
      // planner handoff must return it instead of pinning max concurrency.
      dropPreHeldExecutorSlot(task.id, this.options.semaphore);
      this.coordinatorAdmittedTaskIds.delete(task.id);
      return;
    }
    this.processing.add(task.id);
    this.processingSince.set(task.id, Date.now());

    planLog.log(
      `Specifying ${task.id}: ${task.title || task.description.slice(0, 60)}`,
    );
    this.options.onSpecifyStart?.(task);

    let activePlanningProvider: string | undefined;
    try {
      const detail = await this.store.getTask(task.id);
      const currentTask = detail ?? task;
      // Merge per-task effective workflow settings (U3, KTD-3) over the base so the
      // planning-phase reads (requirePlanApproval, planning/validator model lanes)
      // pick up workflow values. Behavior-inert when nothing is customized.
      const settings = await mergeEffectiveSettings(this.store, currentTask, await this.store.getSettings());
      const promptPath = `.fusion/tasks/${task.id}/PROMPT.md`;

      /*
      FNXC:PlanReview 2026-07-19-00:22 (U3):
      The triage-owned `plan-review-unavailable` reviewer-outage retry lane
      (retryUnavailablePlanReview) is deleted — the graph is the sole Plan Review
      owner and its plan-review node holds in place on a provider outage without
      rewriting PROMPT.md (PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE). A legacy row
      still carrying this status (until U9 adoption) simply re-plans through the
      normal path below; the graph re-runs Plan Review under a CAS lease.
      */
      const isFast = task.executionMode === "fast";
      // FN-6236: this is the only legacy executionMode="fast" bridge. Downstream
      // triage policy reads resolved workflow flags instead of the raw string.
      const leanPlanning = settings.leanPlanning === true || isFast;

      const agentWork = async () => {
        // Set status only after the semaphore slot has been acquired, so
        // tasks waiting in the queue don't appear as "planning".
        /*
        FNXC:Triage 2026-07-16-05:35:
        A skip on this PRIMARY claim path is an anomaly, not a benign scheduler race: poll()
        already proved the card is an eligible planner candidate, so failing the guard here
        means it is re-claimed every poll, never planned, and holds a maxTriageConcurrent slot
        against healthy cards. Recovery-write skips stay silent by design (see
        updatePlanningStateIfStillCurrent); this one must be visible — the FN-7977 steps>0
        wedge stalled the whole planner for hours precisely because it logged nothing.
        */
        if (!await this.updatePlanningStateIfStillCurrent(task, { status: "planning" })) {
          planLog.warn(
            `${task.id}: planning claim skipped — live row is no longer in the planning stage; `
            + "it will be re-claimed on the next poll",
          );
          return;
        }

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

        /*
        FNXC:TriagePromptPersistence 2026-07-21-16:30:
        Planning sessions keep readonly built-in tools so they cannot mutate repository files, while the narrow TaskStore-backed prompt writer remains available as the only durable PROMPT.md creation and repair path.
        */
        const customTools = [
          ...this.createTriageTools({
            parentTaskId: task.id,
            allowTaskCreate: true,
            createdSubtasksRef,
          }),
          createTaskDocumentWriteTool(this.store, task.id),
          createTaskDocumentReadTool(this.store, task.id),
          createTaskPromptWriteTool(this.store, task.id, triageRunContext),
          createWorkflowListTool(this.store),
          createWorkflowSelectTool(this.store, task.id),
          ...(isResearchToolSurfaceEnabled(settings)
            ? createResearchTools({
              store: this.store,
              rootDir: this.rootDir,
              getSettings: async () => this.store.getSettings(),
            })
            : []),
          ...createMissionTools(this.store),
          ...createIdeationTools(this.store),
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
            createDelegateTaskTool(this.options.agentStore, this.store, { rootDir: this.rootDir, sourceTaskId: task.id, sourceAgentId: assignedAgent?.id }),
            createTaskAssignTool(this.options.agentStore, this.store),
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
        const triagePluginContributions = await buildPluginPromptSection(
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
        const resolvedWorkflowSettings = await resolveEffectiveSettingsDetailed(this.store, task).catch((): {
          effective: Record<string, unknown>;
          storedKeys: Set<string>;
        } => ({
          effective: {},
          storedKeys: new Set<string>(),
        }));
        const plannerHeartbeatPatrolEnabled = resolveEffectivePlannerHeartbeatPatrolEnabled(resolvedWorkflowSettings.effective);
        /*
         * FNXC:WorkflowRouting 2026-07-15-13:00:
         * Triage policy values are workflow-scoped, while defaultWorkflowId remains
         * project-scoped. Only an explicitly stored triageDefaultWorkflowId may
         * override the project settings; a declaration default must inherit the
         * project default and must not clobber legacy triage policy values.
         */
        const triageDefaultWorkflowId = resolvedWorkflowSettings.storedKeys.has("triageDefaultWorkflowId")
          ? resolvedWorkflowSettings.effective.triageDefaultWorkflowId
          : undefined;
        const triagePolicySettings = {
          ...settings,
          ...(triageDefaultWorkflowId === undefined ? {} : { triageDefaultWorkflowId }),
        } as Partial<Settings>;
        // FN-6232: standard-mode built-in triage policy is sourced from the workflow IR planning node; the former engine duplicate was removed.
        const userTriagePrompt = settings.agentPrompts?.roleAssignments?.triage
          ? resolveAgentPrompt("triage", settings.agentPrompts, { plannerHeartbeatPatrolEnabled })
          : "";
        const defaultTriagePrompt = resolveAgentPrompt("triage", undefined, { plannerHeartbeatPatrolEnabled });
        const resolvedBasePrompt = userTriagePrompt
          || (leanPlanning
            ? (workflowFastPlanningPrompt || builtinSeamPrompt("planning-fast") || defaultTriagePrompt)
            : (workflowPlanningPrompt || defaultTriagePrompt));
        // Apply the workflow-native triage policy renderer to both standard and
        // fast prompts. Fast mode currently has no policy placeholders, making
        // this a no-op there while still guaranteeing no dangling token leaks.
        const renderedBasePrompt = renderTriagePolicyPlaceholders(resolvedBasePrompt, triagePolicySettings);
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
        activePlanningProvider = planningModel.provider;

        const planningSessionModelOptions = {
          defaultProvider: planningModel.provider,
          defaultModelId: planningModel.modelId,
        };

        /*
         * FNXC:TriageModelFallback 2026-07-09-00:00:
         * When neither `planningFallback*` nor global `fallback*` is configured,
         * derive an implicit fallback from the project/global default (execution)
         * model so a retryable primary-planner failure (e.g. provider 404/429)
         * recovers via one distinct swap instead of failing triage permanently
         * (FN-7719: nvidia/moonshotai/kimi-k2.6 404 wrapped in a 429 stalled a
         * whole board's triage with "no fallback configured"). Self-swap (implicit
         * fallback === primary) and test mode are excluded so the single-swap,
         * no-loop invariant and the mock lane stay unchanged.
         */
        const hasExplicitPlanningFallback = Boolean(settings.planningFallbackProvider && settings.planningFallbackModelId);
        const hasExplicitGlobalFallback = Boolean(settings.fallbackProvider && settings.fallbackModelId);
        const implicitPlanningFallback = (!hasExplicitPlanningFallback && !hasExplicitGlobalFallback)
          ? resolveImplicitPlanningFallbackModel(
            settings,
            planningModel.provider,
            planningModel.modelId,
            assignedAgent?.runtimeConfig,
          )
          : { provider: undefined, modelId: undefined };

        /*
        FNXC:TriagePromptPersistence 2026-07-21-17:50:
        Planning must use the coding tool surface. The shared readonly policy filters
        mutation tools, including fn_task_prompt_write, before the model sees them;
        advertising that writer in the prompt while running readonly stranded triage
        on the original PROMPT.md stub and sent the stub into Plan Review.
        */
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
          fallbackProvider: hasExplicitPlanningFallback
            ? settings.planningFallbackProvider
            : (hasExplicitGlobalFallback ? settings.fallbackProvider : implicitPlanningFallback.provider),
          fallbackModelId: hasExplicitPlanningFallback
            ? settings.planningFallbackModelId
            : (hasExplicitGlobalFallback ? settings.fallbackModelId : implicitPlanningFallback.modelId),
          /*
           * FNXC:Settings-ThinkingLevel 2026-07-13-00:27:
           * Planning sessions honor the per-task planning override before the shared task thinking level, then the workflow-declared planning lane, global lane, and default thinking settings.
           */
          defaultThinkingLevel: resolvePlanningThinkingLevel(settings, task.planningThinkingLevel ?? task.thinkingLevel),
          runAuditor,
          settings,
          // FNXC:McpConfig 2026-06-25-23:17: Primary triage planning is an AI lane, so it receives the store-resolved MCP set while the pi runtime-support guard decides whether to forward it without logging secret material.
          mcpServers: (await resolveMcpServersForStore(this.store)).servers,
          // FNXC:PluginSkills 2026-07-12-00:00: Triage sessions forward plugin skill body dirs with requested names so plugin-authored planning guidance is discoverable by the pi loader.
          ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
          ...(skillContext.additionalSkillPaths.length > 0 ? { additionalSkillPaths: skillContext.additionalSkillPaths } : {}),
          taskId: task.id,
          taskTitle: task.title,
          actionGateContext: this.buildActionGateContext(task.id, triageRunContext.runId, assignedAgent, settings.defaultAgentPermissionPolicy),
          permanentAgentGating: this.buildPermanentAgentGatingContext(task.id, triageRunContext.runId, assignedAgent, settings.defaultAgentPermissionPolicy),
          onFallbackModelUsed: createFallbackModelObserver({
            agent: "triage",
            label: "triage",
            store: this.store,
            taskId: task.id,
            taskTitle: task.title,
          }),
        });

        const modelDesc = formatModelMarkerDetails(describeModel(session), resolvePlanningThinkingLevel(settings, task.planningThinkingLevel ?? task.thinkingLevel));
        /*
        FNXC:PlanningModelMarker 2026-07-21-12:00:
        Planning-lane provenance is operator-facing, so its task activity marker uses the board's Planning name while the persisted agent role remains the internal `triage` identifier.
        */
        planLog.log(`${task.id}: using model ${modelDesc}`);
        await this.store.logEntry(task.id, `Planning using model: ${modelDesc}`);
        await this.store.appendAgentLog(
          task.id,
          `Planning using model: ${modelDesc}`,
          "status",
          undefined,
          "triage",
        );

        // FNXC:TaskTiming 2026-08-01-10:00: triage owns the initial planning lane;
        // first-start wins so a crash between ownership and persistence cannot open a second segment.
        const planningStart = startPlanningSegment(task);
        if (planningStart.planningStartedAt) await this.store.updateTask(task.id, planningStart);
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

            /*
            FNXC:Triage 2026-06-27-16:18:
            Stuck-resume replans must load the existing PROMPT.md draft, or the saved plan task document when PROMPT.md is absent, into buildSpecificationPrompt so `isRevision` is reachable for either persisted planning surface.

            FNXC:PlanReviewReplan 2026-07-15-11:15:
            Load the rejected plan on EVERY needs-replan path, not only stuck-resume.
            Plan Review REVISE previously set feedback but left existingPrompt undefined, so
            buildSpecificationPrompt took the fresh-respecification branch ("Do not reuse
            stale PROMPT.md") and rewrote from title/description. That is the main
            non-convergence loop: surgical REVISE feedback without the rejected plan body
            causes the planner to invent a new spec, the reviewer finds new gaps, and the
            cycle repeats until the replan cap. Seed the draft whenever it exists so
            isRevision mode applies surgical edits against the actual PROMPT.md.
            */
            const replanSeedReason =
              feedbackLogEntry?.action === TRIAGE_STUCK_RESUME_LOG_ACTION
                ? "stuck-resume replan seed"
                : "needs-replan revision seed";
            const planningDraft = await this.readNonEmptyPlanningDraft(task.id, replanSeedReason);
            existingPrompt = planningDraft?.content;
            if (feedbackLogEntry?.action === TRIAGE_STUCK_RESUME_LOG_ACTION && !existingPrompt) {
              feedback = undefined;
            }

            // Ensure the latest user feedback is always actionable for re-plans.
            if (!feedback) {
              const latestUserComment = [...(detail.comments || [])]
                .reverse()
                .find((comment) => comment.author === "user");
              feedback = latestUserComment?.text;
            }

            /*
            FNXC:PlanReviewReplan 2026-07-13-00:00:
            When re-planning and neither an explicit user/AI re-specification comment nor a
            user comment supplied feedback, fall back to the most recent Plan Review REVISE
            verdict recorded in `workflowStepResults`. The pre-execution Plan Review gate
            (runPlanReviewBeforeExecution) stores its rejection reasoning there authoritatively
            (it is upserted every cycle and never evicted by the activity-log cap), so this
            keeps the planner regenerating against the reviewer's actual objections instead of
            reproducing the same rejected plan with `feedback: undefined` and looping. Explicit
            comment-derived feedback still wins because this only runs when none was found.
            */
            if (!feedback) {
              const latestPlanReviewRevise = [...(currentTask.workflowStepResults || [])]
                .reverse()
                .find((result) =>
                  result.workflowStepId === PLAN_REVIEW_GROUP_ID
                  && result.verdict === "REVISE"
                  && Boolean((result.output ?? result.notes)?.trim()),
                );
              feedback = latestPlanReviewRevise?.output ?? latestPlanReviewRevise?.notes ?? feedback;
            }

            planLog.log(
              `${task.id} re-planning with feedback: ${feedback?.slice(0, 100)}...`
              + (existingPrompt ? " (seeded existing PROMPT.md for surgical revision)" : " (no existing draft — fresh respec)"),
            );
          }

          const getTaskDocument = (this.store as unknown as { getTaskDocument?: (taskId: string, key: string) => Promise<{ content?: unknown } | null> }).getTaskDocument;
          const [planDocument, originalDescriptionDocument] = typeof getTaskDocument === "function"
            ? await Promise.all([getTaskDocument.call(this.store, task.id, "plan"), getTaskDocument.call(this.store, task.id, "original-description")])
            : [null, null];
          const agentPrompt = buildSpecificationPrompt(
            detail,
            promptPath,
            settings,
            attachmentContents,
            existingPrompt,
            feedback,
            {
              plan: typeof planDocument?.content === "string" ? planDocument.content : undefined,
              originalDescription: typeof originalDescriptionDocument?.content === "string" ? originalDescriptionDocument.content : undefined,
            },
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
            await this.updatePlanningStateIfStillCurrent(task, { status: restoreStatus }).catch((err: unknown) => {
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
              await this.updatePlanningStateIfStillCurrent(task, {
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
            if (await this.updatePlanningStateIfStillCurrent(task, {
              status: "failed",
              error: failureMessage,
              recoveryRetryCount: null,
              nextRecoveryAt: null,
            })) {
              await this.backfillBlankTitleAfterTerminalTriageFailure(task);
            }
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
          const livePlanningTask = await this.store.getTask(task.id);
          if (livePlanningTask) {
            const planningEnd = finalizePlanningSegment(livePlanningTask);
            if (planningEnd.planningStartedAt === null) await this.store.updateTask(task.id, planningEnd);
          }
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

      if (this.options.semaphore && takePreHeldExecutorSlot(task.id)) {
        // Coordinator already owns this top-level slot; run directly so it
        // cannot join the priority queue after age-based admission.
        try {
          await retryableWork();
        } finally {
          this.options.semaphore.release();
        }
      } else if (this.options.semaphore) {
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
        await this.updatePlanningStateIfStillCurrent(task, { status: restoreStatus }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          planLog.warn(`${task.id}: failed to restore status to '${restoreStatus}' during pause-abort error cleanup: ${msg}`);
        });
      } else if (this.stuckAborted.has(task.id)) {
        this.stuckAborted.delete(task.id);
        await this.handleStuckAbortRequeue(task, "catch");
      } else {
        // FNXC:ProviderRateLimitIsolation 2026-07-21-18:00: preserve the resolved
        // planning provider so health recovery can resume only its parked lane.
        if (this.options.usageLimitPauser && isUsageLimitError(errorMessage)) {
          await this.options.usageLimitPauser.onUsageLimitHit(
            "triage",
            task.id,
            errorMessage,
            activePlanningProvider,
          );
        } else if (err instanceof ModelFallbackExhaustedError) {
          /*
          FNXC:TriageModelFallback 2026-07-02-00:00:
          Exhausted planner model fallback is terminal and operator-actionable: clearing status lets the scheduler recreate the same primary/fallback pair forever, so triage persists a failed task error with the bounded attempt count and sanitized provider reason.
          */
          const failureMessage =
            `Triage failed: unable to select a usable model after ${err.attempts} attempt${err.attempts === 1 ? "" : "s"}. ${err.message}`;
          planLog.error(`✗ ${task.id} planner model fallback exhausted: ${failureMessage}`);
          await this.store.logEntry(task.id, failureMessage).catch((logErr: unknown) => {
            const msg = logErr instanceof Error ? logErr.message : String(logErr);
            planLog.warn(`${task.id}: failed to log planner fallback exhaustion: ${msg}`);
          });
          const persisted = await this.updatePlanningStateIfStillCurrent(task, {
            status: "failed",
            error: failureMessage,
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          }).catch((updateErr: unknown) => {
            const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
            planLog.warn(`${task.id}: failed to persist planner fallback exhaustion: ${msg}`);
            return false;
          });
          if (!persisted) return;
          await this.backfillBlankTitleAfterTerminalTriageFailure(task);
          this.options.onSpecifyError?.(task, err);
          return;
        } else if (isOperatorActionableAgentError(errorMessage) && !isTransientError(errorMessage)) {
          /*
          FNXC:TriageAuth 2026-07-14-15:46:
          Provider credentials, OAuth grants, billing, and model-access failures require operator action. Triage must park the task as failed instead of restoring its claimable status, because the scheduler otherwise repeats the same specification attempt every poll while no external state has changed.

          FNXC:TriageAuth 2026-07-14-16:08:
          Transient infrastructure signals take precedence when an error also mentions credentials, such as a connection reset during refresh. Those mixed failures keep the bounded retry policy; only genuinely permanent authentication failures park immediately.
          */
          const failureMessage = `Specification failed: ${errorMessage}`;
          planLog.error(`✗ ${task.id} planning needs operator action: ${errorDetail}`);
          await this.store.logEntry(task.id, failureMessage, errorStack).catch((logErr: unknown) => {
            const msg = logErr instanceof Error ? logErr.message : String(logErr);
            planLog.warn(`${task.id}: failed to persist operator-actionable specification failure: ${msg}`);
          });
          const persisted = await this.updatePlanningStateIfStillCurrent(task, {
            status: "failed",
            error: failureMessage,
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          }).catch((updateErr: unknown) => {
            const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
            planLog.warn(`${task.id}: failed to park operator-actionable specification failure: ${msg}`);
            return false;
          });
          if (!persisted) return;
          await this.backfillBlankTitleAfterTerminalTriageFailure(task);
          this.options.onSpecifyError?.(task, err instanceof Error ? err : new Error(errorMessage));
          return;
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
            await this.updatePlanningStateIfStillCurrent(task, {
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
          const persisted = await this.updatePlanningStateIfStillCurrent(task, {
            error: `Specification failed after ${MAX_RECOVERY_RETRIES} transient errors: ${errorMessage}`,
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            planLog.warn(`${task.id}: failed to persist transient-error retries-exhausted state: ${msg}`);
            return false;
          });
          if (!persisted) return;
          await this.backfillBlankTitleAfterTerminalTriageFailure(task);
          this.options.onSpecifyError?.(task, err instanceof Error ? err : new Error(errorMessage));
          return;
        }
        // For interrupted recovery states, restore the original triage-held status;
        // otherwise clear to null so the next poll can re-pick ordinary tasks up.
        const restoreStatus = this.restoreStatusAfterInterruptedTriageWork(task);
        await this.updatePlanningStateIfStillCurrent(task, { status: restoreStatus }).catch((restoreErr: unknown) => {
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
      // FNXC:ConcurrencyAdmission 2026-08-06-10:00: a coordinator reservation
      // can exist before planner setup reaches takePreHeldExecutorSlot(). Every
      // early setup failure must return that untransferred host slot; after a
      // successful transfer this is intentionally a no-op.
      dropPreHeldExecutorSlot(task.id, this.options.semaphore);
      this.processing.delete(task.id);
      this.processingSince.delete(task.id);
      this.coordinatorAdmittedTaskIds.delete(task.id);
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

  /**
   * Atomically preserve a task that advanced while this triage session awaited a
   * provider response. `updateTaskAtomic` holds the task lock across the live-row
   * predicate and patch, closing the scheduler-transition race.
   */
  private async updatePlanningStateIfStillCurrent(
    task: Task,
    patch: Parameters<TaskStore["updateTask"]>[1] | ((live: Task) => Parameters<TaskStore["updateTask"]>[1]),
  ): Promise<boolean> {
    if (typeof this.store.updateTaskAtomic !== "function") {
      // Compatibility adapters used by older embedded hosts do not expose the
      // core task lock; current TaskStore implementations always take the atomic path.
      const liveTask = await Promise.resolve(this.store.getTask(task.id)).catch(() => task) ?? task;
      if (!isTaskStillInPlanningStage(liveTask)) {
        return false;
      }
      await this.store.updateTask(task.id, typeof patch === "function" ? patch(liveTask) : patch);
      return true;
    }

    let persisted = false;
    await this.store.updateTaskAtomic(task.id, (liveTask) => {
      if (!isTaskStillInPlanningStage(liveTask)) {
        /*
         * FNXC:Triage 2026-07-15-16:35:
         * FN-7977: a provider or validation failure must never overwrite an
         * advanced task with planning/failed/retry state. Evaluate this predicate
         * under the task lock so scheduler advancement cannot race the recovery write.
         *
         * FNXC:Triage 2026-07-15-17:20:
         * FN-8024: skipping a stale recovery write is the expected outcome of a normal
         * scheduler advancement, not an anomaly — do not log it.
         */
        return null;
      }
      persisted = true;
      return typeof patch === "function" ? patch(liveTask) : patch;
    });
    return persisted;
  }

  /**
   * FNXC:Triage 2026-07-30-15:00:
   * FN-8361 requires filesystem recovery writes to keep the planning predicate and
   * mutation in one task-lock acquisition; row-only atomic patches cannot protect PROMPT.md.
   */
  private async runIfStillPlanningUnderTaskLock(task: Task, operation: () => Promise<void>): Promise<boolean> {
    const store = this.store as TaskStore;
    if (typeof store.withTaskLock !== "function" || typeof store.readTaskForMove !== "function") return false;
    return store.withTaskLock(task.id, async () => {
      if (!isTaskStillInPlanningStage(await store.readTaskForMove(task.id))) return false;
      await operation();
      return true;
    });
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

  private async validateGeneratedPrompt(taskId: string, promptContent: string): Promise<string | null> {
    /*
    FNXC:PlanReview 2026-06-29-01:52:
    Triage owns only deterministic PROMPT.md hygiene. AI plan quality review is graph-owned by the optional Plan Review step, so this helper must never call reviewer agents or require a fn_review_spec APPROVE verdict.

    FNXC:PlanValidation 2026-06-30-08:42:
    External-integration evidence is a planning/review expectation, not a deterministic triage blocker. Operators saw valid generated plans fail before Plan Review with "Generated plan failed deterministic validation"; keep this local validator limited to structural task-file references the engine can prove.
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

    return null;
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
      // A transient lookup failure must still fail open; only a genuine missing row is inactive.
      const canonicalTask = await this.store.getTask(canonicalId);
      if (canonicalTask?.id.toLowerCase() === task.id.toLowerCase()) {
        return false;
      }

      /*
      FNXC:NearDuplicateDetection 2026-07-17-20:10:
      FN-8356 requires missing, deleted, done, and archived duplicate canonicals to flow through
      marker cleanup instead of being rejected here. The detail banner cannot offer a decision for
      an inactive canonical, so parking the card would strand its Needs your decision badge.
      */
      if (isNearDuplicateCanonicalInactive(canonicalTask)) {
        planLog.log(`${task.id} explicit duplicate marker targets inactive ${canonicalId}; clearing marker for replanning`);
      } else {
        planLog.log(`${task.id} explicit duplicate marker detected — redirecting to ${canonicalId}`);
      }
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
    /*
    FNXC:TriageStuckKill 2026-07-18-21:05:
    Mark the card finalizing for the whole Plan Review → column handoff so stuck-kill
    eviction and poll rediscovery cannot start a concurrent planner (FN-1312).
    */
    this.finalizing.add(task.id);
    try {
      await this.finalizeApprovedTaskBody(task, writtenInput, settings, options);
    } finally {
      this.finalizing.delete(task.id);
    }
  }

  /*
  FNXC:WorkflowArtifacts 2026-07-21-17:00:
  Planning cannot release a task unless authoritative TaskStore read-back proves
  PROMPT.md survived persistence. Confirmed absence retries the planning owner
  within the shared recovery budget, then parks visibly when that budget expires.
  */
  private async recoverMissingPromptBeforeRelease(task: Task): Promise<boolean> {
    const live = await Promise.resolve(this.store.getTask(task.id)).catch(() => null);
    // Legacy/minimal stores may not expose prompt enrichment. Production TaskStore
    // always does; only enforce the read-back when the authoritative field exists.
    if (!live || !Object.prototype.hasOwnProperty.call(live, "prompt")) return false;
    if (typeof live.prompt === "string" && live.prompt.trim()) return false;

    const decision = computeRecoveryDecision({
      recoveryRetryCount: live.recoveryRetryCount ?? task.recoveryRetryCount,
      nextRecoveryAt: live.nextRecoveryAt ?? task.nextRecoveryAt,
    });
    const attempt = decision.nextState.recoveryRetryCount ?? MAX_RECOVERY_RETRIES;
    const auditor = createRunAuditor(this.store, {
      taskId: task.id,
      agentId: task.assignedAgentId ?? "triage",
      runId: generateSyntheticRunId("required-artifact-missing", task.id),
      phase: "triage",
      source: "triage",
    });
    await auditor.database({
      type: "task:required-artifact-missing",
      target: task.id,
      metadata: {
        taskId: task.id,
        artifactKeys: ["PROMPT.md"],
        owner: "planning",
        source: "planning-release",
        action: decision.shouldRetry ? "replan" : "park-failed",
        attempt,
        maxAttempts: MAX_RECOVERY_RETRIES,
      },
    });

    if (decision.shouldRetry) {
      const message = `PROMPT.md disappeared before planning release — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${formatDelay(decision.delayMs)}.`;
      await this.store.logEntry(task.id, message);
      await this.updatePlanningStateIfStillCurrent(task, {
        status: this.restoreStatusAfterInterruptedTriageWork(task),
        error: null,
        recoveryRetryCount: decision.nextState.recoveryRetryCount,
        nextRecoveryAt: decision.nextState.nextRecoveryAt,
      });
      return true;
    }

    const error = `REQUIRED_ARTIFACT_RECOVERY_EXHAUSTED: PROMPT.md remained missing after ${MAX_RECOVERY_RETRIES} automatic planning retries.`;
    await this.store.logEntry(task.id, error);
    await this.updatePlanningStateIfStillCurrent(task, {
      status: "failed",
      error,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    });
    return true;
  }

  private async finalizeApprovedTaskBody(
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
    // FNXC:WorkflowArtifacts 2026-07-21-17:00: Confirm the authoritative plan
    // exists before persisting any dependencies, steps, metadata, or review state
    // derived from it; a missing plan must leave no partially accepted projection.
    if (await this.recoverMissingPromptBeforeRelease(task)) return;
    const explicitDuplicateMarker = parseExplicitDuplicateMarker(written);

    /*
     * FNXC:DuplicateIntake 2026-07-16-13:00:
     * Issue #2225 makes triage marker deletion opt-in. Prompt parks a visible linked
     * near-duplicate decision; keep removes the marker before the next real plan.
     */
    if (explicitDuplicateMarker) {
      const canonicalId = explicitDuplicateMarker.canonicalId;
      const canonicalTask = await this.store.getTask(canonicalId).catch(() => null);
      const canClearInactiveMarker = task.userPaused !== true
        && (task.paused !== true || task.pausedReason === "duplicate-decision-required")
        && (task.pausedReason == null || task.pausedReason === "duplicate-decision-required");

      /*
      FNXC:NearDuplicateDetection 2026-07-17-20:10:
      FN-8356 prevents an inactive duplicate canonical from creating a prompt pause. The detail
      view deliberately hides decisions for missing, deleted, done, or archived canonicals, so
      remove only the marker and return eligible work to planning instead of stranding its badge;
      explicit, implicit, and unrelated pauses are preserved.
      */
      if (isNearDuplicateCanonicalInactive(canonicalTask ?? undefined)) {
        if (canClearInactiveMarker) {
          if (!await this.runIfStillPlanningUnderTaskLock(task, async () => {
            await rm(join(this.rootDir, ".fusion", "tasks", task.id, "PROMPT.md"), { force: true });
          })) return;
          await this.updatePlanningStateIfStillCurrent(task, { paused: false, pausedReason: null, status: null });
        }
        return;
      }

      const resolution = settings.triageDuplicateResolution ?? "prompt";
      /*
      FNXC:DuplicateIntake 2026-07-20-12:00:
      FN-8440 requires a Keep decision to survive marker re-ingestion during replan. The
      acknowledgement is scoped to this canonical id, so a marker targeting a different active
      task still receives its own prompt; user and unrelated pauses remain untouched.
      */
      const keepAcknowledged = fusionCore.isTriageDuplicateKeepAcknowledged(task.sourceMetadata, canonicalId);
      if (resolution === "prompt" && keepAcknowledged) {
        if (canClearInactiveMarker) {
          if (!await this.runIfStillPlanningUnderTaskLock(task, async () => {
            await rm(join(this.rootDir, ".fusion", "tasks", task.id, "PROMPT.md"), { force: true });
          })) return;
          await this.updatePlanningStateIfStillCurrent(task, {
            paused: false,
            pausedReason: null,
            status: null,
            sourceMetadataPatch: { nearDuplicateDismissed: true },
          });
        }
        return;
      }
      if (resolution === "delete") {
        const deleteTaskIf = (this.store as unknown as { deleteTaskIf?: TaskStore["deleteTaskIf"] }).deleteTaskIf;
        if (typeof deleteTaskIf !== "function") return;
        const result = await deleteTaskIf.call(this.store, task.id, isTaskStillInPlanningStage, {
          removeLineageReferences: true,
          auditContext: { agentId: task.assignedAgentId ?? "triage", runId: generateSyntheticRunId("triage-delete", task.id) },
        });
        if (!result.deleted) return;
        await this.store.recordActivity({
          type: "task:auto-archived-duplicate", taskId: task.id, taskTitle: task.title ?? "",
          details: `Duplicate of ${canonicalId} — closed`, metadata: { canonicalTaskId: canonicalId, source: "explicit-marker" },
        });
        return;
      }
      if (resolution === "prompt") {
        const applied = await this.updatePlanningStateIfStillCurrent(task, {
          paused: true,
          pausedReason: "duplicate-decision-required",
          status: null,
          sourceMetadataPatch: { nearDuplicateOf: canonicalId, nearDuplicateScore: 1, duplicateSource: "triage-marker", nearDuplicateDismissed: false },
        });
        if (!applied) return;
        await this.store.logEntry(task.id, "Flagged as triage duplicate", `Duplicate marker points to ${canonicalId}; awaiting operator decision`);
        await this.store.recordActivity({ type: "task:auto-archived-duplicate", taskId: task.id, details: "Flagged (not deleted) as triage-marker duplicate", metadata: { canonicalTaskId: canonicalId, source: "triage-marker-flagged" } });
        return;
      }
      if (!await this.runIfStillPlanningUnderTaskLock(task, async () => {
        await rm(join(this.rootDir, ".fusion", "tasks", task.id, "PROMPT.md"), { force: true });
      })) return;
      if (!await this.updatePlanningStateIfStillCurrent(task, {
        paused: false,
        pausedReason: null,
        status: null,
        sourceMetadataPatch: { nearDuplicateOf: canonicalId, nearDuplicateScore: 1, duplicateSource: "triage-marker", nearDuplicateDismissed: true },
      })) return;
      return;
    }

    const parsedDeps = await this.store.parseDependenciesFromPrompt(task.id);

    // Keep status in its planning state until the guarded release move; clearing it here
    // would make the finalizer's own later writes fail the planning-stage predicate.
    const taskUpdates: Record<string, any> = { error: null };

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

    /*
    FNXC:ReviewLevelPreset 2026-07-19-10:40 (U8 / R6):
    Removed the triage "## Review Level: N" parse-and-write. reviewLevel is now a
    CREATION-TIME preset (it writes enabledWorkflowSteps at create time, applied in
    task-creation.applyReviewLevelPreset); triage no longer re-derives or overrides
    the row's reviewLevel from the specified prompt.
    */

    if (promptDeclaresNoCommitsExpected(written)) {
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
      /*
      FNXC:PlanningMode 2026-07-20-12:00:
      FN-8441 keeps the operator request separate from plan.md. Finalization must inject
      original-description when present; a plan-shaped description falls back to its body.
      */
      const getTaskDocument = (this.store as unknown as { getTaskDocument?: (taskId: string, key: string) => Promise<{ content?: unknown } | null> }).getTaskDocument;
      const originalDescriptionDocument = typeof getTaskDocument === "function"
        ? await getTaskDocument.call(this.store, task.id, "original-description").catch(() => null)
        : null;
      const storedOriginalDescription = typeof originalDescriptionDocument?.content === "string"
        ? originalDescriptionDocument.content.trim()
        : "";
      const parsedDescriptionPlan = parsePlanningPlanMd(task.description ?? "");
      const originalDescription = storedOriginalDescription || parsedDescriptionPlan?.description || task.description || "";
      let nextPrompt = applyOriginalDescription(written, originalDescription);
      nextPrompt = applyFrontendUxCriteria(nextPrompt, parsedFileScope);
      if (nextPrompt !== written) {
        const promptPath = join(this.rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
        try {
          if (!await this.runIfStillPlanningUnderTaskLock(task, async () => {
            await writeFile(promptPath, nextPrompt, "utf-8");
          })) return;
          written = nextPrompt;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          planLog.warn(`${task.id}: failed to write prompt hygiene sections to PROMPT.md (${message})`);
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

    /*
    FNXC:Triage 2026-07-30-15:00:
    FN-8361 treats every delayed-finalization mutation as a live planning-stage
    transition. A normal scheduler advance skips and terminates this recovery body.
    */
    if (!await this.updatePlanningStateIfStillCurrent(task, taskUpdates)) return;

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
            if (!await this.updatePlanningStateIfStillCurrent(task, {
              sourceMetadataPatch: {
                nearDuplicateOf: canonical.id,
                nearDuplicateScore: canonical.score,
                nearDuplicateSharedTokens: canonical.sharedTokens,
                intentSignature: taskIntentSignature,
                ...(parsedFileScope.length > 0 ? { fileScope: parsedFileScope } : {}),
              },
            })) return;
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
    /*
    FNXC:ReleaseAuthorizationGate 2026-07-09-00:00:
    Removed the triage release-authorization gate (FN-6481/FN-6469). It over-fired: AI-authored specs routinely mention release tooling (`scripts/release.mjs`, `pnpm release`) in disclaimers and file-scope notes, and every non-user source made the in-band authorization marker inert, so ordinary revert/UI/refactor tasks were stranded in awaiting-approval with no exit (see FN-7560, FN-7525, FN-7554, FN-7556). Releases are now kept out of Fusion by agent instruction (AGENTS.md → "Releasing") instead of an engine gate: agents must never run `pnpm release`/publish from inside a Fusion task.
    */
    if (latestTransitionTask?.paused === true || latestTransitionTask?.userPaused === true) {
      const restoreStatus = options.isReplan ? "needs-replan" : null;
      if (!await this.updatePlanningStateIfStillCurrent(task, { status: restoreStatus })) return;
      await this.store.logEntry(
        task.id,
        "Specification approved but task is paused — leaving in triage, will resume on unpause",
      );
      planLog.log(`${task.id} specified task paused — leaving in triage, will resume on unpause`);
      return;
    }

    /*
    FNXC:PlanReview 2026-07-19-00:20 (U3):
    Triage no longer runs Plan Review out-of-graph. The graph is the SOLE Plan
    Review owner (runPlanReviewBeforeExecution deleted); triage writes PROMPT.md and
    proceeds straight to the ordinary plan-approval gate. The graph's plan-review
    optional-group runs where the IR places it and owns REVISE→plan-replan, the
    replan-cap awaiting-approval park (re-owned in executor.requestPreMergeOptionalStepFix),
    and provider-outage holds — with a CAS lease making a duplicate reviewer impossible.
    */

    /*
    FNXC:PlanApproval 2026-06-26-00:00:
    Project planApprovalMode has precedence over the workflow-resolved requirePlanApproval value so operators can force auto-approval or manual approval for every task in this project.

    FNXC:PlanApproval 2026-07-01-08:12:
    This is the ordinary manual plan-approval gate only, after release authorization and Workflow Plan Review have already made their independent decisions. Always call resolvePlanApprovalRequired with the merged settings object so project auto-approve-all can override workflow requirePlanApproval without weakening non-plan safety gates.

    FNXC:PlanApproval 2026-07-04-12:15:
    FN-7526 re-verified this invariant end to end: every finalizeApprovedTask caller (specifyTask, recoverApprovedTask, retryUnavailablePlanReview, tryFinalizeExplicitDuplicateMarker) already derives `settings` from mergeEffectiveSettings so planApprovalMode (never a MOVED_SETTINGS_KEYS/workflow-owned key) survives any stored workflow requirePlanApproval overlay untouched. No production defect was found; regression tests were added across every surface to lock the invariant so a future bare-settings call site (e.g. `{ requirePlanApproval }` without planApprovalMode) is caught immediately instead of silently reintroducing the reported parking behavior.
    */
    if (resolvePlanApprovalRequired(settings)) {
      /*
       * FNXC:PlanApproval 2026-07-04-22:41:
       * FN-7569 — idempotency short-circuit. Compare the freshly written PROMPT.md against
       * the fingerprint recorded when the operator last approved a plan for this task
       * (POST /tasks/:id/approve-plan, packages/core/src/plan-approval.ts). If they match,
       * this is a re-specification of an already-approved, unchanged plan (replan,
       * plan-review reviewer-outage retry, self-healing rebound to triage, duplicate-marker
       * retry) and must proceed straight through like an approved task rather than re-parking
       * at awaiting-approval and asking the operator to re-approve. A genuinely changed plan
       * (or one whose approval was cleared by reject-plan) produces a different/absent
       * fingerprint and falls through to the ordinary park below. This check lives strictly
       * inside the manual-gate branch, after release authorization and Plan Review have
       * already made their independent decisions, so it never weakens either of those gates
       * or auto-approve-all (which never reaches this branch at all).
       */
      /*
       * FNXC:PlanApproval 2026-07-15-21:05:
       * FN-7569 / FN-8009 — compare the normalized as-approved fingerprint after deterministic
       * Original Description or Frontend UX hygiene. approve-plan fingerprints the on-disk
       * PROMPT.md, while recovery can receive pre-injection text; the shared hasher removes only
       * those generated sections so an unchanged plan does not re-park. A genuinely changed plan
       * still produces a different fingerprint and requires approval.
       */
      const priorFingerprint = latestTransitionTask?.approvedPlanFingerprint ?? task.approvedPlanFingerprint;
      // FNXC:PlanApproval 2026-07-15-20:45: The shared hasher strips deterministic
      // Original Description / Frontend UX hygiene, so approve-plan's on-disk fingerprint and
      // this post-injection recovery fingerprint represent the same operator-authored plan.
      const currentFingerprint = computePlanApprovalFingerprint(written);
      if (priorFingerprint && priorFingerprint === currentFingerprint) {
        await this.store.logEntry(
          task.id,
          "Plan unchanged since prior approval — proceeding without re-approval",
        );
        planLog.log(`${task.id} plan unchanged since prior approval — proceeding without re-approval`);
      } else {
        /*
         * FNXC:PlanApproval 2026-07-04-21:35:
         * FN-7559: explicitly clear awaitingApprovalReason on the manual gate's own
         * awaiting-approval write so a stale "release-authorization" reason left over
         * from an earlier pass on this same task (e.g. a replan after the release
         * gate parked it, now passing the release gate but still requiring manual
         * approval) never survives into this genuinely-manual hold.
         */
        const approvalUpdates: Record<string, unknown> = { status: "awaiting-approval", awaitingApprovalReason: null };
        if (shouldApplyPromptDeclaredTitle && promptDeclaredTitle) {
          approvalUpdates.title = promptDeclaredTitle;
        }
        if (!await this.updatePlanningStateIfStillCurrent(task, approvalUpdates)) return;
        await this.store.logEntry(
          task.id,
          options.recoveryLogAction ?? "Specification approved by AI — awaiting manual approval",
        );
        planLog.log(`✓ ${task.id} specified and awaiting manual approval`);
        return;
      }
    }

    if (shouldClearWorkflowRunStepInstances) {
      /*
      FNXC:WorkflowReplan 2026-06-29-00:33:
      AI spec revision replaces the task's step-source PROMPT.md, so graph foreach instance pins from the previous plan must be discarded before execution reparses steps. Otherwise rebuilt tasks can fail at parse with a stale pin-mismatch even though the new plan is valid.

      FNXC:WorkflowReplan 2026-06-29-02:24:
      User-triggered spec rebuilds can race an old paused graph run that writes step-instance rows after the route cleared them. Clear again when triage accepts a fresh parsed plan over an existing step projection, even if the task snapshot no longer has status `needs-replan`.
      */
      const maybeStore = this.store as unknown as {
        clearWorkflowRunStepInstancesAsync?: (taskId: string) => Promise<void>;
        clearWorkflowRunStepInstances?: (taskId: string) => void;
      };
      try {
        await (maybeStore.clearWorkflowRunStepInstancesAsync?.(task.id)
          ?? maybeStore.clearWorkflowRunStepInstances?.(task.id));
      } catch {
        // Older stores may not persist graph step instances; replanning remains valid without cleanup.
      }
    }

    /*
    FNXC:CodingIdeasWorkflow 2026-07-04-10:35:
    A task planned in place inside the merged "todo" column (Coding (Ideas) and any workflow with a manual intake) is already where it needs to be. Skipping the move avoids a redundant same-column transition that would re-run reset-on-entry and capacity trait hooks on a card that never left the column. Legacy triage tasks (column "triage") still move to "todo" as before.
    */
    // Apply title while the live row is still planning; a post-release patch can race execution.
    if (shouldApplyPromptDeclaredTitle && promptDeclaredTitle) {
      if (!await this.updatePlanningStateIfStillCurrent(task, { title: promptDeclaredTitle })) return;
    }

    if (task.column !== "todo") {
      const moveTaskIf = (this.store as unknown as { moveTaskIf?: TaskStore["moveTaskIf"] }).moveTaskIf;
      if (typeof moveTaskIf !== "function") return;
      const release = await moveTaskIf.call(this.store, task.id, "todo", isTaskStillInPlanningStage);
      if (!release.moved) return;
    }

    /*
    FNXC:TriageStuckKill 2026-07-18-21:05:
    Re-assert status:null after the release move. finalize clears status early (before Plan
    Review); triage→todo does not clear planning statuses; a concurrent stuck-kill requeue
    or rediscovered planner can stamp status:"planning" between those points. Without this
    terminal clear the scheduler holds the card as unplanned after Plan Review APPROVE
    (FN-1312).

    FNXC:TriageStuckKill 2026-07-18-22:30:
    Only clear planning-stage statuses under the task lock. Do not wipe a concurrent
    operator/engine write of failed, awaiting-approval, or a genuine later needs-replan
    that is not the mid-handoff planner race (Greptile P2 on PR #2326). Concurrent
    `status:"planning"` from a rediscovered second planner is still cleared.
    */
    if (typeof this.store.updateTaskAtomic === "function") {
      await this.store.updateTaskAtomic(task.id, (live) => {
        if (
          live.status === "planning"
          || live.status === "plan-review-unavailable"
          || live.status == null
        ) {
          return { status: null, error: null };
        }
        // Leave needs-replan/failed/awaiting-approval and other durable statuses alone.
        return null;
      });
    } else {
      const live = await Promise.resolve(this.store.getTask(task.id)).catch(() => null);
      if (
        live
        && (live.status === "planning" || live.status === "plan-review-unavailable" || live.status == null)
      ) {
        await this.store.updateTask(task.id, { status: null, error: null });
      } else if (!live) {
        // Minimal test stores often omit getTask; still clear the mid-handoff planning stamp.
        await this.store.updateTask(task.id, { status: null, error: null });
      }
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

function promptDeclaresNoCommitsExpected(text: string): boolean {
  return /^\*\*No commits expected:\*\*\s*(true|yes)\b/im.test(text);
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
  planningContext?: { plan?: string; originalDescription?: string },
): string {
  const hasFeedback = Boolean(feedback?.trim());
  const planDocument = planningContext?.plan?.trim();
  const descriptionIsPlan = Boolean(parsePlanningPlanMd(task.description ?? ""));
  const planInput = planDocument || (descriptionIsPlan ? task.description : undefined);
  const originalDescription = planningContext?.originalDescription?.trim()
    || (!descriptionIsPlan ? task.description : parsePlanningPlanMd(task.description ?? "")?.description || task.description);
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

  let taskDefinitionLanguageSection = "";
  if (settings?.taskDefinitionInInputLanguage === true) {
    const detectedLanguage = detectContentLanguage(task.description);
    const isSupportedNonEnglishLanguage = (
      detectedLanguage.locale === "es"
      || detectedLanguage.locale === "fr"
      || detectedLanguage.locale === "ko"
      || detectedLanguage.locale === "zh-CN"
    ) && (detectedLanguage.confidence === "medium" || detectedLanguage.confidence === "high");

    /*
    FNXC:TaskDefinitionInputLanguage 2026-07-16-05:00:
    PROMPT.md gates parse canonical English headings and markers, so opt-in localization
    applies only to planner-authored prose. Conservative core detection limits authoring to
    confident es/fr/ko/zh-CN input; Chinese intentionally normalizes to zh-CN, while English,
    Japanese/unknown, short, and low-confidence descriptions keep byte-faithful English output.
    */
    if (isSupportedNonEnglishLanguage) {
      taskDefinitionLanguageSection = `\n\n## Task Definition Language
Write all human-readable, planner-authored prose in the operator's detected input language: ${localeDisplayName(detectedLanguage.locale)} (${detectedLanguage.locale}). This includes Mission, Before → After bullets, Review Level assessments, step descriptions, and Do NOT items.

Keep every \`##\`/\`###\` section heading, machine marker, the verbatim \`## Original Description\` block, fenced and inline code, file paths, \`fn_*\` tool names, and commit-message conventions in canonical English. Do not translate or alter them.`;
    }
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
    /*
    FNXC:PlanReviewReplan 2026-07-15-11:15:
    Plan Review REVISE and user re-spec feedback share this path. Label feedback generically
    (not "User Feedback" only) and force surgical edits: wholesale rewrites from title alone
    were the non-convergence failure mode (new plan → new reviewer findings → another REVISE).
    RETHINK-class feedback may still require structural change; REVISE must fix listed issues
    without inventing new scope.
    */
    revisionSection = `

## Revision Instructions
You are revising an existing task specification based on Plan Review or user feedback.

**Converge — do not rewrite from scratch.**
- Keep the same overall PROMPT.md structure (headings, sections, format) unless the feedback explicitly requires a fundamental rethink (RETHINK).
- Apply **surgical** edits that fully resolve every blocking issue in the revision feedback below.
- Preserve wording, steps, file scope, and acceptance criteria the feedback does not criticize.
- Do not expand scope, invent new deliverables, or churn File Scope to "improve" an otherwise approved plan.
- After editing, re-check each blocking item so a subsequent Plan Review can APPROVE without a new round of objections.

## Existing Specification
\`\`\`markdown
${existingPrompt}
\`\`\`

## Revision Feedback
${feedback}

Revise the specification above to address this feedback. Persist the complete revised PROMPT.md with \`fn_task_prompt_write\`.`;
  } else if (isFreshRespecification) {
    revisionSection = `

## Re-specification Instructions
You are creating a fresh replacement specification based on Plan Review or user feedback (no usable prior PROMPT.md draft is available).

**Important:** Treat the current task title and description as required primary inputs, inspect the codebase, and write a complete new specification that addresses the feedback below. Do not invent requirements beyond the feedback and task description.

## Revision Feedback
${feedback}

Persist the complete fresh PROMPT.md with \`fn_task_prompt_write\`.`;
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

  /*
  FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
  Planning instructions require a top-of-PROMPT `## Original Description` with the
  operator description verbatim. Deterministic finalize injection enforces the same
  contract if the planner omits or rewrites it.
  */
  return `${isRevision ? "Revise" : isFreshRespecification ? "Re-specify" : "Specify"} this task and persist the result with \`fn_task_prompt_write\`.

The authoritative artifact will be stored at \`${promptPath}\`. Do not use the generic filesystem write tool for PROMPT.md; only \`fn_task_prompt_write\` durably synchronizes the task store and artifact.

## Task
- **ID:** ${task.id}
- **Title:** ${task.title || "(none)"}
- **Description (current user context):** ${task.description}
${planInput ? `\n## Planning Mode plan.md\n\nTreat this validated lean plan as the primary specification input. Expand it into the full executor-ready PROMPT.md; plan.md is not PROMPT.md.\n\n\`\`\`markdown\n${planInput}\n\`\`\`\n` : ""}
## Original Request
\`\`\`text
${originalDescription}
\`\`\`
${task.breakIntoSubtasks ? "- **Break into subtasks:** Yes (user requested)" : ""}
${task.dependencies.length > 0 ? `- **Dependencies:** ${task.dependencies.join(", ")}` : ""}${revisionSection}${subtaskSection}

## Instructions
${isRevision ? "1. Read the existing specification and revision feedback carefully\n2. Apply surgical PROMPT.md edits that fully resolve every blocking feedback item — do not rewrite from title/description alone\n3. Keep structure stable unless feedback requires rethink; preserve uncriticized content\n4. Keep `## Original Description` at the top (after title/metadata) with the operator description **verbatim**\n5. Ensure the revised specification is still detailed enough for an AI agent to execute" : isFreshRespecification ? "1. Read the project structure to understand context (package.json, source files, etc.)\n2. Treat the current task title and description as mandatory primary inputs for a new spec\n3. Produce a fresh complete PROMPT.md specification following the format in your system prompt\n4. Include `## Original Description` near the top with the exact Original Request text above (verbatim, never plan.md)\n5. Address the revision feedback without inventing extra scope\n6. Name actual files, functions, and patterns from the codebase — be specific" : "1. Read the project structure to understand context (package.json, source files, etc.)\n2. Produce a complete PROMPT.md specification following the format in your system prompt\n3. Include `## Original Description` immediately after title/`Created`/`Size` with the exact Original Request text above (verbatim — do not paraphrase; never use plan.md)\n4. The specification must be detailed enough for an autonomous AI agent to implement without asking questions\n5. Name actual files, functions, and patterns from the codebase — be specific"}

Call \`fn_task_prompt_write\` after the complete final specification is ready. If it returns an error, correct the problem and retry; do not finish planning until the tool confirms the authoritative PROMPT.md read-back. Do not use the generic filesystem write tool for PROMPT.md.${commandsSection}${completionDocumentationSection}${memorySection}${taskDefinitionLanguageSection}${attachmentsSection}${userCommentsSection}`;
}
