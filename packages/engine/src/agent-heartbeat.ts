/**
 * HeartbeatMonitor - Runtime monitoring and execution for agents
 * 
 * Monitors agents via periodic polling, detects missed heartbeats,
 * and provides the Paperclip-style heartbeat execution engine:
 * 
 *   wake → check inbox → work → exit
 * 
 * When `executeHeartbeat()` is called (via API, timer, or assignment),
 * the system wakes the agent, checks its assigned task from AgentStore,
 * executes work in a lightweight agent session with `task_create` capability,
 * records results, and transitions the run to completed.
 * 
 * Callback pattern (not EventEmitter):
 * - onMissed: Called when an agent misses its heartbeat
 * - onRecovered: Called when an agent recovers after a missed heartbeat
 * - onTerminated: Called when an unresponsive agent is terminated
 */

import type { AgentStore, AgentHeartbeatRun, HeartbeatInvocationSource, AgentHeartbeatConfig, AgentBudgetStatus, Message, MessageStore, TaskStore, TaskDetail, AgentRole, Agent, InboxTask, BlockedStateSnapshot, RunMutationContext, Settings } from "@fusion/core";
import { buildExecutionMemoryInstructions, isEphemeralAgent, hasAgentIdentity } from "@fusion/core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@mariozechner/pi-ai";
import { createTaskCreateTool, createTaskLogToolWithContext, createTaskDocumentWriteTool, createTaskDocumentReadTool, createListAgentsTool, createDelegateTaskTool, createSendMessageTool, createReadMessagesTool, createMemoryTools, taskCreateParams } from "./agent-tools.js";
import { AgentLogger } from "./agent-logger.js";
import { resolveAgentInstructionsWithRatings, buildSystemPromptWithInstructions } from "./agent-instructions.js";
import { heartbeatLog } from "./logger.js";
import { createRunAuditor, type EngineRunContext } from "./run-audit.js";

// Lazy import for pi — avoids pulling the pi SDK into the module graph
// when heartbeat execution isn't needed.

/** Resolved per-agent heartbeat config after validation and fallback */
interface ResolvedHeartbeatConfig {
  pollIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxConcurrentRuns: number;
}

/** Options for HeartbeatMonitor constructor */
export interface HeartbeatMonitorOptions {
  /** AgentStore instance for persistence */
  store: AgentStore;
  /** Optional separate AgentStore reference for reading per-agent runtimeConfig.
   *  If not provided, falls back to `store`. */
  agentStore?: AgentStore;
  /** Optional MessageStore for wake-on-message behavior */
  messageStore?: MessageStore;
  /** Polling interval in milliseconds (default: 3600000) */
  pollIntervalMs?: number;
  /** Heartbeat timeout in milliseconds (default: 60000) */
  heartbeatTimeoutMs?: number;
  /** Max concurrent runs per agent (default: 1) */
  maxConcurrentRuns?: number;
  /** Callback when an agent misses its heartbeat */
  onMissed?: (agentId: string) => void;
  /** Callback when an agent recovers after a missed heartbeat */
  onRecovered?: (agentId: string) => void;
  /** Callback when an unresponsive agent is terminated */
  onTerminated?: (agentId: string) => void;
  /** Callback when a run starts */
  onRunStarted?: (agentId: string, run: AgentHeartbeatRun) => void;
  /** Callback when a run completes */
  onRunCompleted?: (agentId: string, run: AgentHeartbeatRun) => void;
  /** TaskStore for task_create and task_log tools during heartbeat execution.
   *  When not provided, executeHeartbeat() will throw. */
  taskStore?: TaskStore;
  /** Project root directory for agent session CWD.
   *  When not provided, executeHeartbeat() will throw. */
  rootDir?: string;
}

/** Options for waking up an agent */
export interface WakeupOptions {
  /** What triggered the wakeup */
  source: HeartbeatInvocationSource;
  /** Detail about the trigger (manual, ping, scheduler, system) */
  triggerDetail?: string;
  /** Context snapshot for the run */
  contextSnapshot?: Record<string, unknown>;
}

/** Options for executing a heartbeat run */
export interface HeartbeatExecutionOptions {
  /** Agent ID to execute heartbeat for */
  agentId: string;
  /** What triggered this heartbeat */
  source: HeartbeatInvocationSource;
  /** Human-readable trigger detail */
  triggerDetail?: string;
  /** Optional task ID override (uses agent.taskId if not set) */
  taskId?: string;
  /** IDs of comments that triggered this wake (if any) */
  triggeringCommentIds?: string[];
  /** Type of comment that triggered this wake */
  triggeringCommentType?: "steering" | "task" | "pr";
  /** Optional structured context persisted on the run record */
  contextSnapshot?: Record<string, unknown>;
}

/** Session interface for disposing agent resources */
export interface AgentSession {
  /** Dispose the agent session (stop execution, cleanup resources) */
  dispose(): void;
}

/** In-memory tracking data for a monitored agent */
interface TrackedAgent {
  agentId: string;
  session: AgentSession;
  runId: string;
  lastSeen: number; // timestamp from Date.now()
  missedHeartbeatReported: boolean;
  /** Session ID before this execution started */
  sessionIdBefore?: string;
}

/** Compare blocked-state snapshots to decide whether blocked messaging is duplicate noise. */
export function isBlockedStateDuplicate(current: BlockedStateSnapshot, previous: BlockedStateSnapshot): boolean {
  return current.blockedBy === previous.blockedBy && current.contextHash === previous.contextHash;
}

/**
 * System prompt for heartbeat agent sessions.
 * Instructs the agent to perform a single-pass check on its assigned task
 * and use `task_create` / `task_log` / task documents to record findings or spawn follow-up work.
 */
export const HEARTBEAT_SYSTEM_PROMPT = `You are a heartbeat agent running in a short execution window.

Your job:
1. Check your assigned task — read the description and PROMPT.md if present.
2. Do ONE useful action: analyze, review, create follow-up tasks, or log findings.
3. Use task_create to spawn follow-up work, task_log to record observations.
4. Use task_document_write to save durable findings, plans, or research notes.
5. Call heartbeat_done when finished with an optional summary of what was accomplished.

Keep work lightweight — this is a single-pass check, not a full implementation run.
You have readonly file access plus task_create, task_log, and task_document tools.

**Task Documents:** Save important findings with task_document_write(key="...", content="...").
Documents persist across sessions and are visible in the dashboard's Documents tab.

## Memory Boundaries

You may receive an Agent Memory section and a Project Memory section.
- Agent Memory is specific to you, including imported and user-created agents such as CEO-style coordinator agents. It has its own long-term memory, daily notes, dreams, and qmd-backed retrieval under .fusion/agent-memory/{agentId}/.
- Project Memory is the workspace memory system under .fusion/memory/ with long-term memory, daily notes, dreams, and qmd-backed retrieval.
- Keep these separate: do not copy personal agent operating notes into Project Memory unless they are genuinely useful to every future agent in this workspace.

## Processing Messages

When you are woken by an incoming message (source includes "wake-on-message"), you should:
1. Use read_messages to check your inbox for unread messages.
2. Review each message and determine the appropriate action:
   - If the message requires a response, use send_message to reply.
   - If the message is informational, acknowledge it by logging with task_log.
   - If the message requests work, create a follow-up task with task_create or handle it directly.
3. After processing messages, continue with your normal heartbeat duties.

When sending messages:
- Be concise and clear about what you need or what you've done.
- Include relevant context (task IDs, file paths) in metadata when applicable.
- Use agent-to-agent for inter-agent communication.`;

/**
 * System prompt for no-task heartbeat agent sessions.
 * Instructs the agent to perform ambient work only with tools that do not require task context.
 */
export const HEARTBEAT_NO_TASK_SYSTEM_PROMPT = `You are a heartbeat agent running in a short execution window with no task assignment.

Your job:
1. Review your context — check messages, memory, and project state.
2. Do ONE useful action: analyze, create follow-up tasks, delegate work, or update memory.
3. Use task_create to spawn follow-up work.
4. Use list_agents and delegate_task to coordinate with other agents.
5. Call heartbeat_done when finished with an optional summary of what was accomplished.

Keep work lightweight — this is a single-pass ambient check, not a full implementation run.
You have readonly file access plus:
- task_create
- list_agents and delegate_task
- memory_search, memory_get, and memory_append
- heartbeat_done
- send_message and read_messages when messaging is enabled for this run (they may not always be available)

## Memory Boundaries

You may receive an Agent Memory section and a Project Memory section.
- Agent Memory is specific to you, including imported and user-created agents such as CEO-style coordinator agents. It has its own long-term memory, daily notes, dreams, and qmd-backed retrieval under .fusion/agent-memory/{agentId}/.
- Project Memory is the workspace memory system under .fusion/memory/ with long-term memory, daily notes, dreams, and qmd-backed retrieval.
- Keep these separate: do not copy personal agent operating notes into Project Memory unless they are genuinely useful to every future agent in this workspace.

## Processing Messages

When you are woken by an incoming message (source includes "wake-on-message"), you should:
1. If read_messages is available, use it to check your inbox for unread messages.
2. Review each message and determine the appropriate action:
   - If the message requires a response and send_message is available, use send_message to reply.
   - If the message is informational, acknowledge it and respond via send_message when appropriate.
   - If the message requests work, create a follow-up task with task_create.
3. After processing messages, continue with your ambient work.

When sending messages:
- Be concise and clear about what you need or what you've done.
- Include relevant context (task IDs, file paths) in metadata when applicable.
- Use agent-to-agent for inter-agent communication.`;

// Backward-compatible alias; prefer HEARTBEAT_NO_TASK_SYSTEM_PROMPT.
export const HEARTBEAT_SYSTEM_PROMPT_NO_TASK = HEARTBEAT_NO_TASK_SYSTEM_PROMPT;

/** Parameter schema for the heartbeat_done tool */
const heartbeatDoneParams = Type.Object({
  summary: Type.Optional(Type.String({ description: "Summary of what was accomplished this heartbeat" })),
});

async function getHeartbeatMemorySettings(taskStore: TaskStore): Promise<Settings | undefined> {
  const maybeGetSettings = (taskStore as { getSettings?: () => Promise<Settings> }).getSettings;
  if (!maybeGetSettings) {
    return undefined;
  }
  return maybeGetSettings.call(taskStore);
}

/**
 * HeartbeatMonitor monitors agents via periodic polling.
 * Detects missed heartbeats, auto-terminates unresponsive agents,
 * and provides the Paperclip-style execution engine via executeHeartbeat().
 */
export class HeartbeatMonitor {
  private store: AgentStore;
  private configStore: AgentStore;
  private pollIntervalMs: number;
  private heartbeatTimeoutMs: number;
  private maxConcurrentRuns: number;
  private onMissed?: (agentId: string) => void;
  private onRecovered?: (agentId: string) => void;
  private onTerminated?: (agentId: string) => void;
  private onRunStarted?: (agentId: string, run: AgentHeartbeatRun) => void;
  private onRunCompleted?: (agentId: string, run: AgentHeartbeatRun) => void;
  private taskStore?: TaskStore;
  private rootDir?: string;
  private messageStore?: MessageStore;

  private trackedAgents: Map<string, TrackedAgent> = new Map();
  private agentStartLocks: Map<string, Promise<unknown>> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  /** Tasks created per agent during heartbeat runs (keyed by agentId) */
  private runCreatedTasks: Map<string, Array<{ id: string; description: string }>> = new Map();

  constructor(options: HeartbeatMonitorOptions) {
    this.store = options.store;
    this.configStore = options.agentStore ?? options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? 3_600_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60000;
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 1;
    this.onMissed = options.onMissed;
    this.onRecovered = options.onRecovered;
    this.onTerminated = options.onTerminated;
    this.onRunStarted = options.onRunStarted;
    this.onRunCompleted = options.onRunCompleted;
    this.taskStore = options.taskStore;
    this.rootDir = options.rootDir;
    this.messageStore = options.messageStore;
  }

  /**
   * Start the heartbeat monitoring loop.
   * Safe to call multiple times - no-op if already running.
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    if (this.messageStore) {
      this.messageStore.setMessageToAgentHook(this.handleMessageToAgent.bind(this));
    }
    this.pollInterval = setInterval(() => {
      void this.checkMissedHeartbeats();
    }, this.pollIntervalMs);
  }

  /**
   * Stop the heartbeat monitoring loop.
   * Does not untrack agents - they remain in memory.
   */
  stop(): void {
    if (this.messageStore) {
      this.messageStore.setMessageToAgentHook(() => {});
    }
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Check if the monitor is currently running.
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get the project root directory this monitor is bound to.
   * Returns undefined when not configured for execution.
   */
  getRootDir(): string | undefined {
    return this.rootDir;
  }

  /**
   * Register an agent for monitoring with optional session context.
   * @param agentId - The agent ID
   * @param session - Session with dispose() for cleanup
   * @param runId - The heartbeat run ID
   * @param sessionIdBefore - Optional session ID from before execution
   */
  trackAgent(agentId: string, session: AgentSession, runId: string, sessionIdBefore?: string): void {
    const tracked: TrackedAgent = {
      agentId,
      session,
      runId,
      lastSeen: Date.now(),
      missedHeartbeatReported: false,
      sessionIdBefore,
    };

    this.trackedAgents.set(agentId, tracked);

    // Record initial heartbeat
    void this.store.recordHeartbeat(agentId, "ok", runId);
  }

  /**
   * Serialize run starts per agent to prevent concurrent execution.
   * @param agentId - The agent ID
   * @param fn - Function to execute with the lock
   */
  async withAgentStartLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.agentStartLocks.get(agentId) ?? Promise.resolve();
    const operation = existing.then(
      async () => {
        try {
          return await fn();
        } finally {
          // Clean up accumulated run state for this agent at end of each serialized run.
          // This guarantees cleanup even when the run path throws without calling completeRun
          // (e.g., execution error before completeRun is reached, or completeRun itself throws).
          // Because withAgentStartLock serializes runs per agent, the finally runs after each
          // run completes but before the next concurrent call's callback starts.
          this.clearRunState(agentId);
        }
      },
      async (err) => {
        try {
          throw err;
        } finally {
          this.clearRunState(agentId);
        }
      },
    );
    this.agentStartLocks.set(agentId, operation);
    return operation as Promise<T>;
  }

  /**
   * Start a rich heartbeat run with full context capture.
   * Creates a structured run record and saves it to the run store.
   * @param agentId - The agent ID
   * @param options - Wakeup options with trigger context
   * @returns The created run
   */
  async startRun(agentId: string, options?: WakeupOptions): Promise<AgentHeartbeatRun> {
    // Safety net: fail any existing active runs for this agent before creating a new one.
    // This prevents accumulation of zombie runs when startRun is called multiple times
    // (e.g., concurrent timer + on-demand triggers, or retries after crashes).
    try {
      const existingRun = await this.store.getActiveHeartbeatRun(agentId);
      if (existingRun) {
        heartbeatLog.warn(
          `Agent ${agentId} has active run ${existingRun.id} — marking failed before starting new run`,
        );
        try {
          const existingDetail = await this.store.getRunDetail(agentId, existingRun.id);
          if (existingDetail) {
            await this.store.saveRun({
              ...existingDetail,
              endedAt: new Date().toISOString(),
              status: "terminated",
              stderrExcerpt: "Superseded by new heartbeat run (previous run was stale)",
            });
          }
          await this.store.endHeartbeatRun(existingRun.id, "terminated");
          this.clearRunState(agentId);
        } catch (failErr) {
          const failErrMessage = failErr instanceof Error ? failErr.message : String(failErr);
          heartbeatLog.warn(
            `Failed to terminate stale active run ${existingRun.id} for ${agentId}: ${failErrMessage} — continuing anyway`,
          );
        }
      }
    } catch (activeRunCheckErr) {
      const msg = activeRunCheckErr instanceof Error ? activeRunCheckErr.message : String(activeRunCheckErr);
      heartbeatLog.warn(`Failed to check for existing active run for ${agentId}: ${msg} — continuing with new run`);
    }

    const run = await this.store.startHeartbeatRun(agentId);

    // Enrich with execution context
    const enrichedRun: AgentHeartbeatRun = {
      ...run,
      invocationSource: options?.source ?? "on_demand",
      triggerDetail: options?.triggerDetail ?? "manual",
      contextSnapshot: options?.contextSnapshot,
      processPid: process.pid,
    };

    // Save rich run data
    await this.store.saveRun(enrichedRun);

    // Transition agent to running state
    try {
      await this.store.updateAgentState(agentId, "running");
    } catch (startRunErr) {
      heartbeatLog.warn(`updateAgentState(running) failed for ${agentId}: ${startRunErr instanceof Error ? startRunErr.message : String(startRunErr)} — continuing`);
    }

    this.onRunStarted?.(agentId, enrichedRun);
    return enrichedRun;
  }

  /**
   * Complete a heartbeat run with results.
   * @param agentId - The agent ID
   * @param runId - The run ID to complete
   * @param result - Execution results
   */
  async completeRun(
    agentId: string,
    runId: string,
    result: {
      status: "completed" | "failed" | "terminated";
      exitCode?: number;
      sessionIdAfter?: string;
      usageJson?: { inputTokens: number; outputTokens: number; cachedTokens: number };
      resultJson?: Record<string, unknown>;
      stdoutExcerpt?: string;
      stderrExcerpt?: string;
      /** When true, preserve current agent state instead of forcing a terminal transition. */
      skipStateTransition?: boolean;
    }
  ): Promise<void> {
    // Load and update the run
    const run = await this.store.getRunDetail(agentId, runId);
    if (!run) return;

    const tracked = this.trackedAgents.get(agentId);
    let completionResult = result;

    // Merge accumulated task creations into resultJson
    const createdTasks = this.runCreatedTasks.get(agentId);
    const enrichedResultJson = createdTasks?.length
      ? { ...completionResult.resultJson, tasksCreated: createdTasks }
      : completionResult.resultJson;

    const completedRun: AgentHeartbeatRun = {
      ...run,
      endedAt: new Date().toISOString(),
      status: completionResult.status,
      exitCode: completionResult.exitCode,
      sessionIdBefore: tracked?.sessionIdBefore,
      sessionIdAfter: completionResult.sessionIdAfter,
      usageJson: completionResult.usageJson,
      resultJson: enrichedResultJson,
      stdoutExcerpt: completionResult.stdoutExcerpt,
      stderrExcerpt: completionResult.stderrExcerpt,
    };

    await this.store.saveRun(completedRun);

    // Clear accumulated run state for this agent.
    // Safe to call even when runCreatedTasks was already cleared by withAgentStartLock's
    // finally block (idempotent Map.delete), and necessary for direct completeRun calls
    // that bypass the lock (e.g., test scenarios, edge-case error paths).
    this.clearRunState(agentId);

    // Update cumulative usage on agent
    if (completionResult.usageJson) {
      try {
        const agent = await this.store.getAgent(agentId);
        if (agent) {
          await this.store.updateAgent(agentId, {
            totalInputTokens: (agent.totalInputTokens ?? 0) + completionResult.usageJson.inputTokens,
            totalOutputTokens: (agent.totalOutputTokens ?? 0) + completionResult.usageJson.outputTokens,
          });
        }
      } catch (usageUpdateErr) {
        heartbeatLog.warn(`Agent ${agentId} usage update failed: ${usageUpdateErr instanceof Error ? usageUpdateErr.message : String(usageUpdateErr)} — continuing`);
      }
    }

    // Budget governance: pause agent if over budget after usage update
    if (completionResult.usageJson && completionResult.status !== "failed" && completionResult.status !== "terminated") {
      try {
        const budgetStatus = await this.store.getBudgetStatus(agentId);
        if (budgetStatus.isOverBudget) {
          heartbeatLog.log(`Agent ${agentId} is over budget — pausing with reason "budget-exhausted"`);
          await this.store.updateAgentState(agentId, "paused");
          await this.store.updateAgent(agentId, { pauseReason: "budget-exhausted" });
          // Skip the normal state transition below since we already set the correct state
          completionResult = { ...completionResult, skipStateTransition: true };
        }
      } catch (budgetCheckErr) {
        heartbeatLog.warn(`Agent ${agentId} budget check failed: ${budgetCheckErr instanceof Error ? budgetCheckErr.message : String(budgetCheckErr)} — proceeding with normal state transition`);
      }
    }

    // Transition agent state based on result
    if (!completionResult.skipStateTransition) {
      try {
        if (completionResult.status === "failed") {
          await this.store.updateAgentState(agentId, "error");
          await this.store.updateAgent(agentId, { lastError: completionResult.stderrExcerpt ?? "Run failed" });
        } else if (completionResult.status === "terminated") {
          await this.store.updateAgentState(agentId, "terminated");
        } else {
          // Completed successfully - back to active
          await this.store.updateAgentState(agentId, "active");
        }
      } catch (stateTransErr) {
        heartbeatLog.warn(`Agent ${agentId} state transition failed: ${stateTransErr instanceof Error ? stateTransErr.message : String(stateTransErr)} — continuing`);
      }
    }

    // End the heartbeat run tracking
    await this.store.endHeartbeatRun(runId, completionResult.status === "completed" ? "completed" : "terminated");

    this.onRunCompleted?.(agentId, completedRun);
  }

  /**
   * Stop an active heartbeat run for an agent.
   *
   * If an in-memory tracked session exists, dispose it and complete the run as terminated.
   * If no tracked session exists, fall back to persisted active-run state and terminate that run record.
   *
   * No-op when no active run exists.
   */
  async stopRun(agentId: string): Promise<void> {
    const tracked = this.trackedAgents.get(agentId);

    if (tracked) {
      heartbeatLog.log(`Stopping tracked run ${tracked.runId} for ${agentId}`);

      try {
        tracked.session.dispose();
      } catch (error) {
        heartbeatLog.warn(`Failed to dispose tracked session while stopping run for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      }

      this.untrackAgent(agentId);

      await this.completeRun(agentId, tracked.runId, {
        status: "terminated",
        stderrExcerpt: "Run stopped by user",
      });

      try {
        await this.store.updateAgentState(agentId, "active");
      } catch (stopStateErr) {
        heartbeatLog.warn(`Agent ${agentId} updateAgentState(active) failed during stop: ${stopStateErr instanceof Error ? stopStateErr.message : String(stopStateErr)}`);
      }

      this.clearRunState(agentId);
      return;
    }

    const activeRun = await this.store.getActiveHeartbeatRun(agentId);
    if (!activeRun) {
      this.clearRunState(agentId);
      return;
    }

    heartbeatLog.log(`Stopping persisted run ${activeRun.id} for ${agentId} (no tracked session)`);

    const existingRun = await this.store.getRunDetail(agentId, activeRun.id);
    if (existingRun) {
      await this.store.saveRun({
        ...existingRun,
        endedAt: new Date().toISOString(),
        status: "terminated",
        stderrExcerpt: existingRun.stderrExcerpt ?? "Run stopped by user",
      });
    }

    await this.store.endHeartbeatRun(activeRun.id, "terminated");

    try {
      await this.store.updateAgentState(agentId, "active");
    } catch (stopPersistErr) {
      heartbeatLog.warn(`Agent ${agentId} updateAgentState(active) failed during persisted-run stop: ${stopPersistErr instanceof Error ? stopPersistErr.message : String(stopPersistErr)}`);
    }

    this.clearRunState(agentId);
  }

  /**
   * Remove an agent from monitoring.
   * Does NOT end the heartbeat run - caller's responsibility.
   * @param agentId - The agent ID
   */
  untrackAgent(agentId: string): void {
    this.trackedAgents.delete(agentId);
  }

  /**
   * Record a heartbeat for a tracked agent.
   * @param agentId - The agent ID
   */
  recordHeartbeat(agentId: string): void {
    const tracked = this.trackedAgents.get(agentId);
    if (!tracked) return;

    tracked.lastSeen = Date.now();

    // If recovering from a missed heartbeat
    if (tracked.missedHeartbeatReported) {
      tracked.missedHeartbeatReported = false;
      void this.store.recordHeartbeat(agentId, "recovered", tracked.runId);
      this.onRecovered?.(agentId);
    } else {
      void this.store.recordHeartbeat(agentId, "ok", tracked.runId);
    }
  }

  /**
   * Check if an agent is healthy (heartbeat within timeout window).
   * Uses per-agent heartbeatTimeoutMs from runtimeConfig if available,
   * otherwise falls back to the monitor-level default.
   * @param agentId - The agent ID
   * @returns true if healthy, false if missed heartbeat or not tracked
   */
  isAgentHealthy(agentId: string): boolean {
    const tracked = this.trackedAgents.get(agentId);
    if (!tracked) return false;

    const config = this.resolveAgentConfig(agentId);
    const elapsed = Date.now() - tracked.lastSeen;
    return elapsed < config.heartbeatTimeoutMs;
  }

  /**
   * Get list of currently tracked agent IDs.
   * Useful for testing and debugging.
   */
  getTrackedAgents(): string[] {
    return Array.from(this.trackedAgents.keys());
  }

  /**
   * Get the last seen timestamp for a tracked agent.
   * @param agentId - The agent ID
   * @returns Last seen timestamp, or undefined if not tracked
   */
  getLastSeen(agentId: string): number | undefined {
    return this.trackedAgents.get(agentId)?.lastSeen;
  }

  private handleMessageToAgent(message: Message): void {
    if (message.toType !== "agent") {
      return;
    }

    const agent = this.configStore.getCachedAgent(message.toId);
    if (!agent) {
      return;
    }

    const runtimeConfig = agent.runtimeConfig as AgentHeartbeatConfig | undefined;
    if (runtimeConfig?.messageResponseMode !== "immediate") {
      return;
    }

    const validStates = new Set(["active", "idle", "running"]);
    if (!validStates.has(agent.state)) {
      return;
    }

    void this.executeHeartbeat({
      agentId: message.toId,
      source: "on_demand",
      triggerDetail: "wake-on-message",
    }).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      heartbeatLog.warn(`Wake-on-message heartbeat failed for ${message.toId}: ${errorMessage}`);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Heartbeat execution (Paperclip wake → check → work → exit)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute a heartbeat run for an agent.
   * 
   * Implements the Paperclip-style execution model:
   * 1. Wake — start a heartbeat run record
   * 2. Check inbox — resolve the agent's assigned task
   * 3. Work — run a lightweight agent session with readonly tools + task_create/task_log
   * 4. Exit — record results and complete the run
   * 
   * Budget governance:
   * - Skip all triggers when the agent is over budget (`isOverBudget`)
   * - Skip timer triggers when over the warning threshold (`isOverThreshold`)
   * - Continue normal execution for critical triggers (assignment/on_demand) when only over threshold
   * 
   * Per-agent execution is serialized via `withAgentStartLock` — concurrent calls
   * for the same agent wait for the previous run to complete.
   * 
   * @param options - Execution options (agent ID, source, optional task override)
   * @returns The completed heartbeat run, or null if the monitor isn't configured for execution
   * @throws Error if taskStore or rootDir are not configured
   */
  async executeHeartbeat(options: HeartbeatExecutionOptions): Promise<AgentHeartbeatRun> {
    const {
      agentId,
      source,
      triggerDetail,
      taskId: explicitTaskId,
      contextSnapshot,
      triggeringCommentIds,
      triggeringCommentType,
    } = options;

    // Validate execution dependencies
    if (!this.taskStore || !this.rootDir) {
      throw new Error("HeartbeatMonitor not configured for execution (missing taskStore/rootDir)");
    }
    const taskStore = this.taskStore;
    const rootDir = this.rootDir;

    // Serialize per-agent
    return this.withAgentStartLock(agentId, async () => {
      heartbeatLog.log(`Executing heartbeat for ${agentId} (source=${source})`);

      let preloadedAgent: Agent | null = null;
      try {
        preloadedAgent = await this.store.getAgent(agentId);
      } catch (preloadErr) {
        heartbeatLog.warn(`Agent ${agentId} agent preloading failed: ${preloadErr instanceof Error ? preloadErr.message : String(preloadErr)} — will resolve in execution path`);
      }

      const resolvedTaskId = explicitTaskId ?? preloadedAgent?.taskId;
      const contextTriggeringCommentIds = Array.isArray(contextSnapshot?.triggeringCommentIds)
        ? contextSnapshot.triggeringCommentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : undefined;
      const contextTriggeringCommentType =
        contextSnapshot?.triggeringCommentType === "steering"
        || contextSnapshot?.triggeringCommentType === "task"
        || contextSnapshot?.triggeringCommentType === "pr"
          ? contextSnapshot.triggeringCommentType
          : undefined;
      const effectiveTriggeringCommentIds = triggeringCommentIds ?? contextTriggeringCommentIds;
      const effectiveTriggeringCommentType = triggeringCommentType ?? contextTriggeringCommentType;

      const runContextSnapshot = {
        ...(contextSnapshot ?? {}),
        ...(resolvedTaskId ? { taskId: resolvedTaskId } : {}),
        ...(effectiveTriggeringCommentIds?.length
          ? { triggeringCommentIds: effectiveTriggeringCommentIds }
          : {}),
        ...(effectiveTriggeringCommentType ? { triggeringCommentType: effectiveTriggeringCommentType } : {}),
      };

      // Start run
      const run = await this.startRun(agentId, {
        source,
        triggerDetail,
        contextSnapshot: Object.keys(runContextSnapshot).length > 0 ? runContextSnapshot : undefined,
      });

      // Build run context for mutation correlation
      const runContext: RunMutationContext = {
        runId: run.id,
        agentId,
        source,
      };

      // Build engine run context for audit instrumentation
      const engineRunContext: EngineRunContext = {
        runId: run.id,
        agentId,
        source,
        phase: "heartbeat",
      };

      // Create run auditor for audit trail (FN-1404)
      // Uses TaskStore.recordRunAuditEvent when available; no-ops otherwise
      const audit = createRunAuditor(taskStore, engineRunContext);

      let agentLogger: AgentLogger | null = null;
      const flushAgentLogger = async (): Promise<void> => {
        if (!agentLogger) {
          return;
        }
        try {
          await agentLogger.flush();
        } catch (error) {
          heartbeatLog.warn(`Failed to flush heartbeat logs for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };

      try {
        // Budget governance: check if agent can run
        try {
          const budgetStatus = await this.store.getBudgetStatus(agentId);
          if (budgetStatus.isOverBudget) {
            heartbeatLog.log(`Agent ${agentId} budget exhausted — heartbeat skipped`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "budget_exhausted", budgetStatus },
              skipStateTransition: true,
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }
          // Above threshold: only allow critical triggers (assignment, on_demand)
          if (budgetStatus.isOverThreshold && source === "timer") {
            heartbeatLog.log(`Agent ${agentId} over budget threshold (${budgetStatus.usagePercent}%) — timer heartbeat skipped`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "budget_threshold_exceeded", budgetStatus },
              skipStateTransition: true,
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }
        } catch (budgetErr) {
          heartbeatLog.warn(`Agent ${agentId} budget status check failed: ${budgetErr instanceof Error ? budgetErr.message : String(budgetErr)} — proceeding without budget check`);
        }

        // Resolve agent
        const agent = preloadedAgent ?? await this.store.getAgent(agentId);
        if (!agent) {
          heartbeatLog.warn(`Agent ${agentId} not found — completing run as failed`);
          await this.completeRun(agentId, run.id, {
            status: "failed",
            stderrExcerpt: `Agent ${agentId} not found`,
          });
          return (await this.store.getRunDetail(agentId, run.id))!;
        }

        // Check if agent has identity (used later for no-task run decisions)
        const agentHasIdentity = hasAgentIdentity(agent);
        const isAgentEphemeral = isEphemeralAgent(agent);

        // Resolve task assignment (explicit override → existing assignment → inbox-lite selection)
        let taskId = explicitTaskId ?? agent.taskId;
        let inboxSelection: InboxTask | null = null;

        if (!taskId) {
          inboxSelection = await taskStore.selectNextTaskForAgent(agentId);
          if (inboxSelection) {
            taskId = inboxSelection.task.id;
            heartbeatLog.log(`Inbox selected task ${taskId} (priority: ${inboxSelection.priority}) for agent ${agentId}`);

            // Persist assignment to AgentStore so subsequent runs retain linkage.
            if (agent.taskId !== taskId) {
              await this.store.assignTask(agentId, taskId, runContext);
              // Audit trail: record assignment mutation (FN-1404)
              await audit.database({ type: "task:assign", target: taskId });
            }

            // FN-1253 compatibility: if checkout API is available on TaskStore,
            // try to claim the lease. On conflict, skip this task gracefully.
            const checkoutTask = (taskStore as TaskStore & {
              checkoutTask?: (taskId: string, agentId: string, runContext?: RunMutationContext) => Promise<unknown>;
            }).checkoutTask;
            if (typeof checkoutTask === "function") {
              try {
                await checkoutTask.call(taskStore, taskId, agentId, runContext);
                // Audit trail: record checkout mutation (FN-1404)
                await audit.database({ type: "task:checkout", target: taskId });
              } catch (checkoutErr) {
                heartbeatLog.warn(`Task ${taskId} checkout failed: ${checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr)} — skipping`);
                taskId = undefined;
                inboxSelection = null;
              }
            }
          }
        }

        if (taskId && run.contextSnapshot?.taskId !== taskId) {
          const updatedRun: AgentHeartbeatRun = {
            ...run,
            contextSnapshot: {
              ...(run.contextSnapshot ?? {}),
              taskId,
            },
          };
          await this.store.saveRun(updatedRun);

          // Update engine run context with resolved taskId for audit trail (FN-1404)
          engineRunContext.taskId = taskId;
        }

        if (!taskId) {
          // Agents with identity (soul, instructions, memory) should run a full heartbeat
          // session even without a task, so they can do ambient work like messaging,
          // memory management, task creation, and delegation.
          // Ephemeral agents and agents without identity still exit gracefully.
          if (!agentHasIdentity || isAgentEphemeral) {
            heartbeatLog.log(`Agent ${agentId} has no task assignment — graceful exit`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "no_assignment" },
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }
          heartbeatLog.log(`Agent ${agentId} has no task but has identity — running no-task heartbeat`);
        }
        const isNoTaskRun = !taskId;

        // Validate agent state (only for task-scoped runs)
        if (!isNoTaskRun) {
          const validStates = ["active", "running", "idle"];
          if (!validStates.includes(agent.state)) {
            heartbeatLog.log(`Agent ${agentId} state is "${agent.state}" — graceful exit`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "invalid_state", state: agent.state },
              skipStateTransition: true,
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }
        }

        // Fetch task context (only for task-scoped runs)
        let taskDetail: TaskDetail | undefined;
        if (!isNoTaskRun) {
          // taskId is guaranteed to be defined here because isNoTaskRun = !taskId
          const resolvedTaskId = taskId!;
          try {
            taskDetail = await taskStore.getTask(resolvedTaskId);
          } catch (taskDetailErr) {
            heartbeatLog.warn(`Task ${resolvedTaskId} fetch failed: ${taskDetailErr instanceof Error ? taskDetailErr.message : String(taskDetailErr)} — graceful exit`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "task_not_found", taskId: resolvedTaskId },
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }

          // Checkout enforcement: agent must hold the lease to work on this task.
          // The heartbeat only validates existing checkout state — it does NOT attempt
          // to acquire a checkout itself. The calling system (scheduler, API trigger)
          // is responsible for checking out the task before the heartbeat starts.
          if (taskDetail.checkedOutBy && taskDetail.checkedOutBy !== agentId) {
            heartbeatLog.warn(
              `Agent ${agentId} does not hold checkout for ${resolvedTaskId} (held by ${taskDetail.checkedOutBy}) — graceful exit`
            );
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: {
                reason: "checkout_conflict",
                taskId: resolvedTaskId,
                checkedOutBy: taskDetail.checkedOutBy,
              },
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }

          const blockedBy = typeof taskDetail.blockedBy === "string" ? taskDetail.blockedBy.trim() : "";
          const isBlockedTask = taskDetail.status === "queued" && blockedBy.length > 0;

          if (isBlockedTask) {
            const commentCount = (taskDetail.comments?.length ?? 0) + (taskDetail.steeringComments?.length ?? 0);
            const lastCommentId = taskDetail.comments?.at(-1)?.id;
            const lastSteeringCommentId = taskDetail.steeringComments?.at(-1)?.id;
            const contextHash = Buffer.from(
              JSON.stringify({ commentCount, lastCommentId, lastSteeringCommentId, blockedBy }),
            )
              .toString("base64")
              .slice(0, 16);

            const currentBlockedState: BlockedStateSnapshot = {
              taskId: resolvedTaskId,
              blockedBy,
              recordedAt: new Date().toISOString(),
              contextHash,
            };

            const previousBlockedState = await this.store.getLastBlockedState(agentId);
            if (previousBlockedState && isBlockedStateDuplicate(currentBlockedState, previousBlockedState)) {
              heartbeatLog.log(`Task ${resolvedTaskId} is still blocked by ${blockedBy} (duplicate state) — skipping comment`);
              await this.completeRun(agentId, run.id, {
                status: "completed",
                resultJson: { reason: "blocked_duplicate", taskId: resolvedTaskId, blockedBy },
              });
              return (await this.store.getRunDetail(agentId, run.id))!;
            }

            const blockedMessage = `Task is blocked by ${blockedBy}; waiting for dependency/context changes before retrying.`;
            await taskStore.addComment(resolvedTaskId, blockedMessage, "agent", undefined, runContext);
            // Audit trail: record comment mutation (FN-1404)
            await audit.database({ type: "task:comment:add", target: resolvedTaskId, metadata: { blockedBy } });
            await this.store.setLastBlockedState(agentId, currentBlockedState);

            heartbeatLog.log(`Task ${resolvedTaskId} is blocked by ${blockedBy} — recorded blocked state`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "blocked", taskId: resolvedTaskId, blockedBy },
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }
        }

        // Clear blocked state when task is no longer blocked (only for task-scoped runs)
        if (!isNoTaskRun) {
          await this.store.clearLastBlockedState(agentId);
        }

        // Track usage via callbacks
        const STDOUT_EXCERPT_LIMIT = 4000;
        let outputLength = 0;
        let toolCallCount = 0;
        let heartbeatSummary: string | undefined;
        let stdoutExcerpt = "";

        const appendStdoutExcerpt = (delta: string): void => {
          if (stdoutExcerpt.length >= STDOUT_EXCERPT_LIMIT) {
            return;
          }
          const remaining = STDOUT_EXCERPT_LIMIT - stdoutExcerpt.length;
          stdoutExcerpt += delta.slice(0, remaining);
        };

        // Create heartbeat_done tool
        const heartbeatDoneTool: ToolDefinition = {
          name: "heartbeat_done",
          label: "Heartbeat Done",
          description: "Signal that the heartbeat execution is complete. Call when finished.",
          parameters: heartbeatDoneParams,
          execute: async (_id: string, params: Static<typeof heartbeatDoneParams>) => {
            if (params.summary) {
              heartbeatSummary = params.summary;
            }
            return {
              content: [{
                type: "text" as const,
                text: `Heartbeat complete.${params.summary ? ` Summary: ${params.summary}` : ""}`,
              }],
              details: {},
            };
          },
        };

        // Lazy-load createFnAgent and promptWithFallback
        const { createFnAgent, promptWithFallback } = await import("./pi.js");
        const { buildSessionSkillContextSync } = await import("./session-skill-context.js");

        // Build tools with task creation tracking and run context for mutation correlation
        // For no-task runs, exclude task_log and document tools (they require a taskId)
        let heartbeatTools: ToolDefinition[];
        if (isNoTaskRun) {
          // No-task runs: task_create, list_agents, delegate_task, messaging, memory, heartbeat_done
          heartbeatTools = [];

          // task_create tool (no tracking needed for no-task runs)
          heartbeatTools.push(createTaskCreateTool(taskStore));

          // Agent delegation tools
          heartbeatTools.push(createListAgentsTool(this.store));
          heartbeatTools.push(createDelegateTaskTool(this.store, taskStore));

          // Messaging tools — when MessageStore is available
          if (this.messageStore) {
            heartbeatTools.push(createSendMessageTool(this.messageStore, agentId));
            heartbeatTools.push(createReadMessagesTool(this.messageStore, agentId));
          }
        } else {
          // Task-scoped runs: full tool set including task_log and document tools
          // taskId is guaranteed to be defined here because isNoTaskRun = !taskId
          heartbeatTools = this.createHeartbeatTools(agentId, taskStore, taskId!, runContext, audit, this.messageStore);
        }

        let memorySettings: Settings | undefined;
        try {
          memorySettings = await getHeartbeatMemorySettings(taskStore);
          heartbeatTools.push(...createMemoryTools(rootDir, memorySettings, {
            agentMemory: {
              agentId: agent.id,
              agentName: agent.name,
              memory: agent.memory,
            },
          }));
        } catch (memorySettingsError) {
          const message = memorySettingsError instanceof Error ? memorySettingsError.message : String(memorySettingsError);
          heartbeatLog.warn(`Failed to configure heartbeat memory tools for ${agentId}: ${message}`);
        }
        heartbeatTools.push(heartbeatDoneTool);

        // AgentLogger requires a taskId — only create for task-scoped runs
        if (!isNoTaskRun && taskId) {
          agentLogger = new AgentLogger({
            store: taskStore,
            taskId,
            agent: agent.role as AgentRole,
          });
        }

        // Build skill selection context for heartbeat session (uses waking agent's skills, no role fallback)
        const skillContext = buildSessionSkillContextSync(agent, "heartbeat", rootDir);

        let systemPrompt = isNoTaskRun
          ? HEARTBEAT_NO_TASK_SYSTEM_PROMPT
          : HEARTBEAT_SYSTEM_PROMPT;
        const baseHeartbeatSystemPrompt = systemPrompt;
        try {
          const agentInstructions = await resolveAgentInstructionsWithRatings(agent, rootDir, this.store);
          const memoryInstructions = memorySettings?.memoryEnabled === false
            ? ""
            : buildExecutionMemoryInstructions(rootDir, memorySettings);
          systemPrompt = buildSystemPromptWithInstructions(
            baseHeartbeatSystemPrompt,
            [agentInstructions, memoryInstructions].filter((part) => part.trim()).join("\n\n"),
          );
        } catch (instructionError) {
          systemPrompt = baseHeartbeatSystemPrompt;
          const message = instructionError instanceof Error ? instructionError.message : String(instructionError);
          heartbeatLog.warn(`Failed to enrich heartbeat system prompt for ${agentId}: ${message}`);
        }

        // Create agent session
        const { session } = await createFnAgent({
          cwd: rootDir,
          systemPrompt,
          tools: "readonly",
          customTools: heartbeatTools,
          defaultProvider: agent.runtimeConfig?.modelProvider as string | undefined,
          defaultModelId: agent.runtimeConfig?.modelId as string | undefined,
          onText: (delta) => {
            outputLength += delta.length;
            appendStdoutExcerpt(delta);
            agentLogger?.onText(delta);
          },
          onThinking: (delta) => {
            agentLogger?.onThinking(delta);
          },
          onToolStart: (name, args) => {
            agentLogger?.onToolStart(name, args);
          },
          onToolEnd: (name, isError, result) => {
            toolCallCount++;
            agentLogger?.onToolEnd(name, isError, result);
          },
          // Skill selection: use waking agent's skills (heartbeat has no role fallback)
          ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
        });

        // Track for monitoring
        this.trackAgent(agentId, { dispose: () => session.dispose() }, run.id);

        try {
          // Build execution prompt
          let pendingMessages: Message[] = [];
          let executionPrompt: string;

          if (isNoTaskRun) {
            // No-task heartbeat: agent has identity but no assigned task
            // Fetch unread messages when messageStore is available (for all trigger types)
            if (this.messageStore) {
              try {
                pendingMessages = this.messageStore.getInbox(agentId, "agent", { read: false, limit: 10 });
              } catch (inboxErr) {
                heartbeatLog.warn(`Failed to fetch inbox messages for ${agentId}: ${inboxErr instanceof Error ? inboxErr.message : String(inboxErr)}`);
              }
            }

            // Build pending messages section
            const pendingMessagesLines: string[] = [];
            if (pendingMessages.length > 0) {
              pendingMessagesLines.push(
                "",
                "Pending Messages:",
                ...pendingMessages.map((msg) => {
                  const timestamp = new Date(msg.createdAt).toLocaleString();
                  return `- [from: ${msg.fromId}] ${msg.content} (${timestamp})`;
                }),
              );
            }

            executionPrompt = [
              `Heartbeat execution for agent "${agent.name}" (ID: ${agent.id})`,
              `Source: ${source}${triggerDetail ? ` (${triggerDetail})` : ""}`,
              "",
              "**No assigned task** — This heartbeat run has no task assignment.",
              "",
              "You have identity (soul, instructions, and/or memory) loaded, which means you can perform",
              "useful ambient work. Here are some things you can do:",
              "",
              "1. **Check your messages** — Use read_messages to review any pending messages",
              "   and use send_message to respond or communicate with other agents.",
              "",
              "2. **Create new tasks** — Use task_create to spawn follow-up work that needs",
              "   to be done. This is useful for surfacing issues or ideas you discover.",
              "",
              "3. **Delegate work** — Use list_agents to discover available agents and",
              "   delegate_task to assign work to them.",
              "",
              "4. **Update your memory** — Use memory_append to persist important learnings",
              "   or context that will help you in future sessions.",
              "",
              "5. **Monitor the project** — Review the task board and identify any issues",
              "   or opportunities that should be addressed.",
              ...pendingMessagesLines,
              "",
              "Your soul, instructions, and memory are already loaded in the system prompt.",
              "Focus on work that benefits the project without requiring a specific task context.",
              "Call heartbeat_done when finished.",
            ].join("\n");
          } else {
            // Task-scoped heartbeat: agent has an assigned task
            const taskTitle = taskDetail!.title ?? taskDetail!.description.slice(0, 100);

            // Fetch unread messages when messageStore is available (for all trigger types)
            if (this.messageStore) {
              try {
                pendingMessages = this.messageStore.getInbox(agentId, "agent", { read: false, limit: 10 });
              } catch (inboxErr) {
                heartbeatLog.warn(`Failed to fetch inbox messages for ${agentId}: ${inboxErr instanceof Error ? inboxErr.message : String(inboxErr)}`);
              }
            }

            const triggeringCommentLines: string[] = [];
            if (effectiveTriggeringCommentIds && effectiveTriggeringCommentIds.length > 0) {
              const commentLookup = new Map<string, { author: string; text: string }>();
              for (const comment of taskDetail!.comments ?? []) {
                commentLookup.set(comment.id, { author: comment.author, text: comment.text });
              }
              for (const steeringComment of taskDetail!.steeringComments ?? []) {
                commentLookup.set(steeringComment.id, { author: steeringComment.author, text: steeringComment.text });
              }

              const formatCommentText = (text: string): string => text.replace(/\s+/g, " ").trim();

              for (const commentId of effectiveTriggeringCommentIds) {
                const comment = commentLookup.get(commentId);
                if (comment) {
                  triggeringCommentLines.push(`- [${comment.author}]: "${formatCommentText(comment.text)}"`);
                }
              }

              if (triggeringCommentLines.length > 0) {
                triggeringCommentLines.unshift(
                  "",
                  "You were woken because of new comments on this task. Review them and take appropriate action.",
                  `Triggering comment type: ${effectiveTriggeringCommentType ?? "task"}`,
                  "New comments since last run:",
                );
              }
            }

            // Build pending messages section
            const pendingMessagesLines: string[] = [];
            if (pendingMessages.length > 0) {
              pendingMessagesLines.push(
                "",
                "Pending Messages:",
                ...pendingMessages.map((msg) => {
                  const timestamp = new Date(msg.createdAt).toLocaleString();
                  return `- [from: ${msg.fromId}] ${msg.content} (${timestamp})`;
                }),
              );
            }

            executionPrompt = [
              `Heartbeat execution for agent "${agent.name}" (ID: ${agent.id})`,
              `Source: ${source}${triggerDetail ? ` (${triggerDetail})` : ""}`,
              `Assigned task: ${taskId} — ${taskTitle}`,
              "",
              "Task description:",
              taskDetail!.description,
              "",
              taskDetail!.prompt ? `PROMPT.md:\n${taskDetail!.prompt}` : "No PROMPT.md available.",
              ...triggeringCommentLines,
              ...pendingMessagesLines,
              "",
              "Review the task status and take appropriate action. Call heartbeat_done when finished.",
            ].join("\n");
          }

          // Execute
          await promptWithFallback(session, executionPrompt);

          // Estimate output tokens (rough: ~4 chars per token)
          const estimatedOutputTokens = Math.ceil(outputLength / 4);
          await flushAgentLogger();

          // Mark messages as read after successful processing (only if messages were included in prompt)
          if (pendingMessages.length > 0 && this.messageStore) {
            try {
              this.messageStore.markAllAsRead(agentId, "agent");
            } catch (markReadErr) {
              heartbeatLog.warn(`Failed to mark messages as read for ${agentId}: ${markReadErr instanceof Error ? markReadErr.message : String(markReadErr)}`);
            }
          }

          // Complete run successfully
          const completionResultJson: Record<string, unknown> = {
            summary: heartbeatSummary,
            toolCallCount,
          };
          if (isNoTaskRun) {
            // Identity agents without tasks get a special reason for observability
            completionResultJson.reason = "no_assignment_identity_run";
          } else if (inboxSelection) {
            completionResultJson.reason = "inbox_selected";
            completionResultJson.priority = inboxSelection.priority;
            completionResultJson.taskId = taskId;
          }

          await this.completeRun(agentId, run.id, {
            status: "completed",
            usageJson: { inputTokens: 0, outputTokens: estimatedOutputTokens, cachedTokens: 0 },
            resultJson: completionResultJson,
            stdoutExcerpt: stdoutExcerpt || undefined,
          });

          heartbeatLog.log(`Heartbeat completed for ${agentId} (${toolCallCount} tool calls, ~${estimatedOutputTokens} output tokens)`);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          heartbeatLog.error(`Heartbeat execution failed for ${agentId}: ${errorMessage}`);
          await flushAgentLogger();
          await this.completeRun(agentId, run.id, {
            status: "failed",
            stderrExcerpt: errorMessage,
            stdoutExcerpt: stdoutExcerpt || undefined,
          });
        } finally {
          await flushAgentLogger();
          // Defensively untrack the agent — wrap in try/catch to guarantee cleanup
          // can't be blocked by an exception in untrackAgent itself.
          try { this.untrackAgent(agentId); } catch (untrackErr) {
            heartbeatLog.warn(`untrackAgent failed for ${agentId}: ${untrackErr instanceof Error ? untrackErr.message : String(untrackErr)}`);
          }
          try {
            session.dispose();
          } catch (disposeErr: unknown) {
            const errorMessage = disposeErr instanceof Error ? disposeErr.message : String(disposeErr);
            heartbeatLog.warn(`session.dispose() failed for ${agentId}: ${errorMessage}`);
          }
        }

        return (await this.store.getRunDetail(agentId, run.id))!;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        heartbeatLog.error(`Heartbeat execution error for ${agentId}: ${errorMessage}`);
        await flushAgentLogger();

        // Attempt to complete the run as failed if it's still active.
        // If completeRun also fails, fall back to a direct DB update to ensure
        // the run is not permanently stuck in "active" state.
        try {
          await this.completeRun(agentId, run.id, {
            status: "failed",
            stderrExcerpt: errorMessage,
          });
        } catch (completeRunErr) {
          const completeRunErrMsg = completeRunErr instanceof Error ? completeRunErr.message : String(completeRunErr);
          heartbeatLog.error(`completeRun failed for ${agentId}/${run.id}: ${completeRunErrMsg} — attempting safety-net completion`);

          // Safety net: directly update the run record to prevent zombie run state.
          // This runs only when completeRun itself threw, guaranteeing the run
          // doesn't remain permanently stuck in "active" state.
          try {
            const runDetail = await this.store.getRunDetail(agentId, run.id);
            if (runDetail && runDetail.status !== "completed" && runDetail.status !== "failed" && runDetail.status !== "terminated") {
              await this.store.saveRun({
                ...runDetail,
                endedAt: new Date().toISOString(),
                status: "failed",
                stderrExcerpt: `Heartbeat execution failed: ${errorMessage}. Run completion also failed: ${completeRunErrMsg}`,
              });
              await this.store.endHeartbeatRun(run.id, "terminated");
              // Also clean up run state accumulator
              this.clearRunState(agentId);
              heartbeatLog.log(`Safety-net run completion for ${agentId}/${run.id} — run terminated`);
            }
          } catch (safetyNetErr) {
            const safetyNetErrMsg = safetyNetErr instanceof Error ? safetyNetErr.message : String(safetyNetErr);
            heartbeatLog.error(`Safety-net run completion also failed for ${agentId}/${run.id}: ${safetyNetErrMsg} — run may be stuck permanently`);
          }
        }

        return (await this.store.getRunDetail(agentId, run.id))!;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Heartbeat tools: createHeartbeatTools / clearRunState
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create the tool set for a heartbeat agent session.
   *
   * Returns tools with tracking wrappers that record task creations
   * so they can be included in the run's `resultJson.tasksCreated`.
   *
   * @param agentId - The agent ID (used for tracking and logging)
   * @param taskStore - TaskStore for task creation and logging
   * @param taskId - The assigned task ID (for task_log context)
   * @param runContext - Optional run context for mutation correlation
   * @param audit - Optional run auditor for audit trail (FN-1404)
   * @param messageStore - Optional MessageStore for messaging tools
   * @returns Array of ToolDefinitions for the heartbeat session
   */
  createHeartbeatTools(
    agentId: string,
    taskStore: TaskStore,
    taskId: string,
    runContext?: RunMutationContext,
    audit?: ReturnType<typeof createRunAuditor>,
    messageStore?: MessageStore,
  ): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    // Wrap createTaskCreateTool with tracking and agent-link logging
    const baseCreateTool = createTaskCreateTool(taskStore);
    const trackedCreateTool: ToolDefinition = {
      ...baseCreateTool,
      execute: async (id: string, params: Static<typeof taskCreateParams>, signal, onUpdate, ctx) => {
        const result = await baseCreateTool.execute(id, params, signal, onUpdate, ctx);

        const createdTaskId = (result.details as { taskId?: string })?.taskId ?? "unknown";

        // Log agent link on the created task with run context for correlation
        try {
          await taskStore.logEntry(createdTaskId, `Created by agent ${agentId} during heartbeat run`, undefined, runContext);
        } catch (taskCreateLogErr) {
          heartbeatLog.warn(`Task ${createdTaskId} agent-link log failed: ${taskCreateLogErr instanceof Error ? taskCreateLogErr.message : String(taskCreateLogErr)}`);
        }

        // Audit trail: record task creation (FN-1404)
        await audit?.database({ type: "task:create", target: createdTaskId });

        // Accumulate for inclusion in run resultJson
        if (!this.runCreatedTasks.has(agentId)) {
          this.runCreatedTasks.set(agentId, []);
        }
        this.runCreatedTasks.get(agentId)!.push({
          id: createdTaskId,
          description: params.description,
        });

        return result;
      },
    };
    tools.push(trackedCreateTool);

    // task_log tool (with run context for mutation correlation)
    tools.push(createTaskLogToolWithContext(taskStore, taskId, runContext));

    // Document tools for persisting durable findings
    tools.push(createTaskDocumentWriteTool(taskStore, taskId));
    tools.push(createTaskDocumentReadTool(taskStore, taskId));
    // Agent delegation tools — discover and delegate work to other agents
    tools.push(createListAgentsTool(this.store));
    tools.push(createDelegateTaskTool(this.store, taskStore));

    // Messaging tools — when MessageStore is available, agents can send and receive messages
    if (messageStore) {
      tools.push(createSendMessageTool(messageStore, agentId));
      tools.push(createReadMessagesTool(messageStore, agentId));
    }

    return tools;
  }

  /**
   * Clear accumulated run state for an agent.
   * Called after completing a run to reset the `runCreatedTasks` accumulator.
   * @param agentId - The agent ID
   */
  clearRunState(agentId: string): void {
    this.runCreatedTasks.delete(agentId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the resolved heartbeat configuration for an agent.
   * Reads per-agent config from runtimeConfig with fallback to monitor defaults.
   * @param agentId - The agent ID
   * @returns Resolved config with validated values
   */
  async getAgentHeartbeatConfig(agentId: string): Promise<ResolvedHeartbeatConfig> {
    return this.getAgentConfig(agentId);
  }

  /**
   * Resolve per-agent heartbeat config from runtimeConfig with validation and fallbacks.
   */
  private resolveAgentConfig(agentId: string): ResolvedHeartbeatConfig {
    // Defaults from monitor-level construction
    const result: ResolvedHeartbeatConfig = {
      pollIntervalMs: this.pollIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      maxConcurrentRuns: this.maxConcurrentRuns,
    };

    try {
      const agent = this.configStore.getCachedAgent?.(agentId);
      if (agent?.runtimeConfig) {
        const rc = agent.runtimeConfig;

        if (typeof rc.heartbeatIntervalMs === "number" && Number.isFinite(rc.heartbeatIntervalMs)) {
          result.pollIntervalMs = Math.max(1000, rc.heartbeatIntervalMs);
        }
        if (typeof rc.heartbeatTimeoutMs === "number" && Number.isFinite(rc.heartbeatTimeoutMs)) {
          result.heartbeatTimeoutMs = Math.max(5000, rc.heartbeatTimeoutMs);
        }
        if (typeof rc.maxConcurrentRuns === "number" && Number.isFinite(rc.maxConcurrentRuns)) {
          result.maxConcurrentRuns = Math.max(1, Math.round(rc.maxConcurrentRuns));
        }
      }
    } catch (agentLookupErr) {
      heartbeatLog.warn(`getAgentConfig(${agentId}) agent lookup failed: ${agentLookupErr instanceof Error ? agentLookupErr.message : String(agentLookupErr)} — using monitor defaults`);
    }

    return result;
  }

  private async getAgentConfig(agentId: string): Promise<ResolvedHeartbeatConfig> {
    const result = this.resolveAgentConfig(agentId);

    if (!this.taskStore) {
      return result;
    }

    try {
      const settings = await getHeartbeatMemorySettings(this.taskStore);
      const rawMultiplier = settings?.heartbeatMultiplier;
      const multiplier =
        typeof rawMultiplier === "number" && Number.isFinite(rawMultiplier) && rawMultiplier > 0
          ? rawMultiplier
          : 1;

      result.pollIntervalMs = Math.max(1000, Math.round(result.pollIntervalMs * multiplier));
    } catch (settingsErr) {
      heartbeatLog.warn(`getAgentConfig(${agentId}) settings lookup failed: ${settingsErr instanceof Error ? settingsErr.message : String(settingsErr)} — using base interval`);
    }

    return result;
  }

  private async checkMissedHeartbeats(): Promise<void> {
    const now = Date.now();

    for (const tracked of this.trackedAgents.values()) {
      const config = await this.getAgentConfig(tracked.agentId);
      const elapsed = now - tracked.lastSeen;

      if (elapsed >= config.heartbeatTimeoutMs) {
        // Missed heartbeat detected
        if (!tracked.missedHeartbeatReported) {
          tracked.missedHeartbeatReported = true;
          await this.handleMissedHeartbeat(tracked);
        } else {
          // Already reported - check if we should terminate
          // Give 2x timeout for recovery before auto-terminate
          if (elapsed >= config.heartbeatTimeoutMs * 2) {
            await this.terminateUnresponsive(tracked);
          }
        }
      }
    }
  }

  private async handleMissedHeartbeat(tracked: TrackedAgent): Promise<void> {
    // Record missed heartbeat
    await this.store.recordHeartbeat(tracked.agentId, "missed", tracked.runId);

    // Notify callback
    this.onMissed?.(tracked.agentId);
  }

  private async terminateUnresponsive(tracked: TrackedAgent): Promise<void> {
    // Dispose the session
    try {
      tracked.session.dispose();
    } catch (err) {
      // Log but don't stop termination
      heartbeatLog.warn(`Error disposing session for ${tracked.agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Update agent state to terminated
    try {
      await this.store.updateAgentState(tracked.agentId, "terminated");
    } catch (err) {
      heartbeatLog.warn(`Error terminating agent ${tracked.agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Remove from tracking
    this.trackedAgents.delete(tracked.agentId);

    // Notify callback
    this.onTerminated?.(tracked.agentId);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HeartbeatTriggerScheduler — timer, assignment, and on-demand triggers
// ─────────────────────────────────────────────────────────────────────────

/** Structured context passed when a trigger fires. */
export interface WakeContext {
  /** Optional task ID associated with this trigger */
  taskId?: string;
  /** Why the agent was woken */
  wakeReason: string;
  /** Detail about the specific trigger */
  triggerDetail: string;
  /** IDs of comments that triggered this wake (if any) */
  triggeringCommentIds?: string[];
  /** Type of comment that triggered this wake */
  triggeringCommentType?: "steering" | "task" | "pr";
  /** Budget governance status for the agent at trigger time */
  budgetStatus?: AgentBudgetStatus;
  /** Additional context (intervalMs, etc.) */
  [key: string]: unknown;
}

/** Callback invoked when a trigger fires. */
export type TriggerCallback = (
  agentId: string,
  source: HeartbeatInvocationSource,
  context: WakeContext,
) => Promise<void>;

/** Per-agent timer state */
interface AgentTimer {
  intervalMs: number;
  handle: ReturnType<typeof setInterval>;
}

/**
 * HeartbeatTriggerScheduler manages timer-based heartbeat triggers for agents.
 *
 * Each agent can be registered with a heartbeat config that specifies
 * the timer interval. When the timer fires, the scheduler invokes the
 * provided callback with the appropriate source and context.
 *
 * The scheduler respects:
 * - `enabled`: Skip registration if false
 * - `heartbeatIntervalMs`: Timer interval (undefined = no timer)
 * - `maxConcurrentRuns`: Skip tick if agent already has an active run
 *
 * Usage:
 * ```typescript
 * const scheduler = new HeartbeatTriggerScheduler(agentStore, async (agentId, source, ctx) => {
 *   await heartbeatMonitor.startRun(agentId, { source, triggerDetail: ctx.triggerDetail, contextSnapshot: { ...ctx } });
 * });
 * scheduler.registerAgent("agent-123", { heartbeatIntervalMs: 3600000, enabled: true });
 * scheduler.start();
 * ```
 */
export class HeartbeatTriggerScheduler {
  private store: AgentStore;
  private callback: TriggerCallback;
  private taskStore?: TaskStore;
  private timers: Map<string, AgentTimer> = new Map();
  private registrationEpochs: Map<string, number> = new Map();
  private running = false;
  private assignedListener: ((agent: import("@fusion/core").Agent, taskId: string) => void) | null = null;
  private updatedListener: ((agent: import("@fusion/core").Agent) => void) | null = null;
  private deletedListener: ((agentId: string) => void) | null = null;

  constructor(store: AgentStore, callback: TriggerCallback, taskStore?: TaskStore) {
    this.store = store;
    this.callback = callback;
    this.taskStore = taskStore;
  }

  /**
   * Start the scheduler. Enables assignment watching.
   * Individual agents must be registered separately via registerAgent().
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.watchAssignments();
    this.watchAgentLifecycle();
    heartbeatLog.log("HeartbeatTriggerScheduler started");
  }

  /**
   * Stop the scheduler and clear all timers.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    // Unwatch assignments
    this.unwatchAssignments();
    this.unwatchAgentLifecycle();

    // Clear all timers
    for (const [agentId, timer] of this.timers) {
      clearInterval(timer.handle);
      heartbeatLog.log(`Cleared timer for ${agentId}`);
    }
    this.timers.clear();

    heartbeatLog.log("HeartbeatTriggerScheduler stopped");
  }

  /**
   * Check if the scheduler is running.
   */
  isActive(): boolean {
    return this.running;
  }

  /** Default heartbeat interval when not explicitly configured (3600 seconds / 1 hour) */
  private static readonly DEFAULT_HEARTBEAT_INTERVAL_MS = 3_600_000;

  /**
   * Register an agent for timer-based heartbeat triggers.
   * @param agentId - The agent ID
   * @param config - Per-agent heartbeat config
   */
  registerAgent(agentId: string, config: AgentHeartbeatConfig): void {
    // Skip if not enabled
    if (config.enabled === false) {
      heartbeatLog.log(`Skipping timer registration for ${agentId} (disabled)`);
      return;
    }

    // Apply default interval if not explicitly configured
    // This ensures agents with heartbeat monitoring enabled but no explicit interval
    // still get periodic timer triggers (matching HeartbeatMonitor constructor default)
    let rawIntervalMs = config.heartbeatIntervalMs;
    let usingDefaultInterval = false;
    if (!rawIntervalMs || typeof rawIntervalMs !== "number" || !Number.isFinite(rawIntervalMs) || rawIntervalMs <= 0) {
      rawIntervalMs = HeartbeatTriggerScheduler.DEFAULT_HEARTBEAT_INTERVAL_MS;
      usingDefaultInterval = true;
    }

    const intervalMs = Math.max(1000, Math.round(rawIntervalMs));
    const registrationEpoch = (this.registrationEpochs.get(agentId) ?? 0) + 1;
    this.registrationEpochs.set(agentId, registrationEpoch);

    // Register immediately with multiplier=1 so agents don't wait for async settings I/O.
    this.applyTimerRegistration(agentId, intervalMs, 1, usingDefaultInterval);

    // If project settings are available, refresh registration with the current multiplier.
    if (this.taskStore && typeof (this.taskStore as { getSettings?: () => Promise<Settings> }).getSettings === "function") {
      void this.applyProjectMultiplierRegistration(agentId, intervalMs, usingDefaultInterval, registrationEpoch);
    }
  }

  private async applyProjectMultiplierRegistration(
    agentId: string,
    baseIntervalMs: number,
    usingDefaultInterval: boolean,
    expectedEpoch: number,
  ): Promise<void> {
    let multiplier = 1;

    try {
      const settings = await getHeartbeatMemorySettings(this.taskStore!);
      multiplier = HeartbeatTriggerScheduler.resolveHeartbeatMultiplier(settings?.heartbeatMultiplier);
    } catch (settingsErr) {
      heartbeatLog.warn(
        `Failed to read heartbeatMultiplier for ${agentId}: ${settingsErr instanceof Error ? settingsErr.message : String(settingsErr)} — using 1x`,
      );
      multiplier = 1;
    }

    // Guard against stale async completions after subsequent register/unregister calls.
    if (this.registrationEpochs.get(agentId) !== expectedEpoch) {
      return;
    }

    this.applyTimerRegistration(agentId, baseIntervalMs, multiplier, usingDefaultInterval);
  }

  private applyTimerRegistration(
    agentId: string,
    baseIntervalMs: number,
    multiplier: number,
    usingDefaultInterval: boolean,
  ): void {
    const effectiveIntervalMs = Math.max(1000, Math.round(baseIntervalMs * multiplier));

    this.clearAgentTimer(agentId);

    const handle = setInterval(() => {
      void this.onTimerTick(agentId, effectiveIntervalMs);
    }, effectiveIntervalMs);

    this.timers.set(agentId, { intervalMs: effectiveIntervalMs, handle });

    if (multiplier !== 1) {
      heartbeatLog.log(
        `Registered timer for ${agentId} (every ${baseIntervalMs}ms, multiplier ${multiplier} → ${effectiveIntervalMs}ms effective)`,
      );
      return;
    }

    heartbeatLog.log(
      usingDefaultInterval
        ? `Registered timer for ${agentId} (every ${effectiveIntervalMs}ms, default interval)`
        : `Registered timer for ${agentId} (every ${effectiveIntervalMs}ms)`,
    );
  }

  private clearAgentTimer(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (!timer) {
      return;
    }
    clearInterval(timer.handle);
    this.timers.delete(agentId);
  }

  private static resolveHeartbeatMultiplier(rawMultiplier: unknown): number {
    if (typeof rawMultiplier !== "number" || !Number.isFinite(rawMultiplier) || rawMultiplier <= 0) {
      return 1;
    }
    return rawMultiplier;
  }

  /**
   * Unregister an agent, clearing its timer.
   * @param agentId - The agent ID
   */
  unregisterAgent(agentId: string): void {
    this.registrationEpochs.set(agentId, (this.registrationEpochs.get(agentId) ?? 0) + 1);
    if (this.timers.has(agentId)) {
      this.clearAgentTimer(agentId);
      heartbeatLog.log(`Unregistered timer for ${agentId}`);
    }
  }

  /**
   * Get the set of currently registered agent IDs.
   * Useful for testing.
   */
  getRegisteredAgents(): string[] {
    return Array.from(this.timers.keys());
  }

  /**
   * Subscribe to agent:assigned events on the AgentStore.
   * When a task is assigned to an agent, the trigger callback fires
   * with source "assignment" and the task ID in the context.
   */
  watchAssignments(): void {
    if (this.assignedListener) return; // Already watching

    this.assignedListener = async (agent, taskId) => {
      if (!this.running) return;

      try {
        if (agent.runtimeConfig?.enabled === false) {
          heartbeatLog.log(`Assignment trigger skipped for ${agent.id} (heartbeat disabled)`);
          return;
        }

        // Guard: skip if agent already has an active run
        const activeRun = await this.store.getActiveHeartbeatRun(agent.id);
        if (activeRun) {
          heartbeatLog.log(`Assignment trigger skipped for ${agent.id} (active run)`);
          return;
        }

        let budgetStatus: AgentBudgetStatus | undefined;
        // Budget governance: block even critical triggers when budget is fully exhausted
        try {
          budgetStatus = await this.store.getBudgetStatus(agent.id);
          if (budgetStatus.isOverBudget) {
            heartbeatLog.log(`Agent ${agent.id} budget exhausted — assignment trigger skipped`);
            return;
          }
        } catch (budgetErr) {
          heartbeatLog.warn(`Assignment trigger budget check failed for ${agent.id}: ${budgetErr instanceof Error ? budgetErr.message : String(budgetErr)} — proceeding without budget check`);
        }

        let triggeringCommentIds: string[] | undefined;
        if (this.taskStore && typeof this.taskStore.getTask === "function") {
          try {
            const [task, recentRuns] = await Promise.all([
              this.taskStore.getTask(taskId),
              this.store.getRecentRuns(agent.id, 1),
            ]);

            const lastRunAt = recentRuns[0]?.startedAt;
            const newSteeringComments = (task.steeringComments ?? []).filter((comment) =>
              !lastRunAt || comment.createdAt > lastRunAt,
            );
            if (newSteeringComments.length > 0) {
              triggeringCommentIds = newSteeringComments.map((comment) => comment.id);
            }
          } catch (error) {
            heartbeatLog.warn(
              `Failed to resolve triggering steering comments for assignment wake (${agent.id}/${taskId}): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        heartbeatLog.log(`Assignment trigger for ${agent.id} (task: ${taskId})`);
        await this.callback(agent.id, "assignment", {
          taskId,
          wakeReason: "assignment",
          triggerDetail: "task-assigned",
          ...(triggeringCommentIds?.length
            ? {
              triggeringCommentIds,
              triggeringCommentType: "steering" as const,
            }
            : {}),
          ...(budgetStatus && { budgetStatus }),
        });
      } catch (err) {
        heartbeatLog.error(`Assignment trigger error for ${agent.id}: ${err instanceof Error ? err.message : err}`);
      }
    };

    this.store.on("agent:assigned", this.assignedListener);
    heartbeatLog.log("Watching agent:assigned events");
  }

  /**
   * Unsubscribe from agent:assigned events.
   */
  unwatchAssignments(): void {
    if (this.assignedListener) {
      this.store.off("agent:assigned", this.assignedListener);
      this.assignedListener = null;
      heartbeatLog.log("Stopped watching agent:assigned events");
    }
  }

  private watchAgentLifecycle(): void {
    if (this.updatedListener || this.deletedListener) return;

    this.updatedListener = (agent) => {
      if (agent.state === "terminated" || agent.runtimeConfig?.enabled === false) {
        this.unregisterAgent(agent.id);
      }
    };
    this.deletedListener = (agentId) => {
      this.unregisterAgent(agentId);
    };

    this.store.on("agent:updated", this.updatedListener);
    this.store.on("agent:deleted", this.deletedListener);
  }

  private unwatchAgentLifecycle(): void {
    if (this.updatedListener) {
      this.store.off("agent:updated", this.updatedListener);
      this.updatedListener = null;
    }
    if (this.deletedListener) {
      this.store.off("agent:deleted", this.deletedListener);
      this.deletedListener = null;
    }
  }

  /**
   * Handle a timer tick for an agent.
   * Checks for active runs before invoking the callback.
   */
  private async onTimerTick(agentId: string, intervalMs: number): Promise<void> {
    if (!this.running) return;

    try {
      const agent = await this.store.getAgent(agentId);
      if (!agent) {
        heartbeatLog.log(`Timer tick skipped for ${agentId} (agent missing)`);
        this.unregisterAgent(agentId);
        return;
      }
      if (agent.state === "terminated" || agent.runtimeConfig?.enabled === false) {
        heartbeatLog.log(`Timer tick skipped for ${agentId} (disabled or terminated)`);
        this.unregisterAgent(agentId);
        return;
      }

      // Check for active runs
      const activeRun = await this.store.getActiveHeartbeatRun(agentId);
      if (activeRun) {
        heartbeatLog.log(`Timer tick skipped for ${agentId} (active run)`);
        return;
      }

      // Budget enforcement is handled in HeartbeatMonitor.executeHeartbeat() for timer sources.
      // The scheduler dispatches the callback regardless of budget status so that executeHeartbeat()
      // can create explicit run records with budget_exhausted/budget_threshold_exceeded reasons.
      // This makes timer budget skips observable rather than silent drops.

      await this.callback(agentId, "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs,
      });
    } catch (err) {
      heartbeatLog.error(`Timer tick error for ${agentId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
