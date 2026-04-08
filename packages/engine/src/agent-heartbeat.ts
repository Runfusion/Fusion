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

import type { AgentStore, AgentHeartbeatRun, HeartbeatInvocationSource, AgentHeartbeatConfig, AgentBudgetStatus, Message, MessageStore, TaskStore, TaskDetail, AgentRole, Agent } from "@fusion/core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@mariozechner/pi-ai";
import { createTaskCreateTool, createTaskLogTool, taskCreateParams } from "./agent-tools.js";
import { AgentLogger } from "./agent-logger.js";
import { heartbeatLog } from "./logger.js";

// Lazy import for pi — avoids pulling the pi SDK into the module graph
// when heartbeat execution isn't needed.
type CreateKbAgentFn = (options: import("./pi.js").AgentOptions) => Promise<import("./pi.js").AgentResult>;
type PromptWithFallbackFn = (session: import("@mariozechner/pi-coding-agent").AgentSession, prompt: string) => Promise<void>;

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
  /** Polling interval in milliseconds (default: 30000) */
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

/**
 * System prompt for heartbeat agent sessions.
 * Instructs the agent to perform a single-pass check on its assigned task
 * and use `task_create` / `task_log` to record findings or spawn follow-up work.
 */
export const HEARTBEAT_SYSTEM_PROMPT = `You are a heartbeat agent running in a short execution window.

Your job:
1. Check your assigned task — read the description and PROMPT.md if present.
2. Do ONE useful action: analyze, review, create follow-up tasks, or log findings.
3. Use task_create to spawn follow-up work, task_log to record observations.
4. Call heartbeat_done when finished with an optional summary of what was accomplished.

Keep work lightweight — this is a single-pass check, not a full implementation run.
You have readonly file access plus task_create and task_log tools.`;

/** Parameter schema for the heartbeat_done tool */
const heartbeatDoneParams = Type.Object({
  summary: Type.Optional(Type.String({ description: "Summary of what was accomplished this heartbeat" })),
});

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
    this.pollIntervalMs = options.pollIntervalMs ?? 30000;
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
    const operation = existing.then(fn, fn);
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
    } catch {
      // May fail if already in running state - that's ok
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

    // Clear accumulated run state for this agent
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
      } catch {
        // Non-critical, skip
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
      } catch {
        // If budget check fails, proceed with normal state transition
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
      } catch {
        // State transition may fail if already in target state
      }
    }

    // End the heartbeat run tracking
    await this.store.endHeartbeatRun(runId, completionResult.status === "completed" ? "completed" : "terminated");

    this.onRunCompleted?.(agentId, completedRun);
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

    const config = this.getAgentConfig(agentId);
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
    const { agentId, source, triggerDetail, taskId: explicitTaskId, contextSnapshot } = options;

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
      } catch {
        // If preloading fails, resolve again in the execution path below.
      }

      const resolvedTaskId = explicitTaskId ?? preloadedAgent?.taskId;
      const runContextSnapshot = {
        ...(contextSnapshot ?? {}),
        ...(resolvedTaskId ? { taskId: resolvedTaskId } : {}),
      };

      // Start run
      const run = await this.startRun(agentId, {
        source,
        triggerDetail,
        contextSnapshot: Object.keys(runContextSnapshot).length > 0 ? runContextSnapshot : undefined,
      });

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
        } catch {
          // If getBudgetStatus fails (e.g., method not available), proceed without budget check
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

        // Resolve task assignment
        const taskId = explicitTaskId ?? agent.taskId;
        if (taskId && run.contextSnapshot?.taskId !== taskId) {
          const updatedRun: AgentHeartbeatRun = {
            ...run,
            contextSnapshot: {
              ...(run.contextSnapshot ?? {}),
              taskId,
            },
          };
          await this.store.saveRun(updatedRun);
        }

        if (!taskId) {
          heartbeatLog.log(`Agent ${agentId} has no task assignment — graceful exit`);
          await this.completeRun(agentId, run.id, {
            status: "completed",
            resultJson: { reason: "no_assignment" },
          });
          return (await this.store.getRunDetail(agentId, run.id))!;
        }

        // Validate agent state
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

        // Fetch task context
        let taskDetail: TaskDetail;
        try {
          taskDetail = await taskStore.getTask(taskId);
        } catch {
          heartbeatLog.warn(`Task ${taskId} not found — graceful exit`);
          await this.completeRun(agentId, run.id, {
            status: "completed",
            resultJson: { reason: "task_not_found", taskId },
          });
          return (await this.store.getRunDetail(agentId, run.id))!;
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

        // Lazy-load createKbAgent and promptWithFallback
        const { createKbAgent, promptWithFallback } = await import("./pi.js");

        // Build tools with task creation tracking
        const heartbeatTools = this.createHeartbeatTools(agentId, taskStore, taskId);
        heartbeatTools.push(heartbeatDoneTool);

        agentLogger = new AgentLogger({
          store: taskStore,
          taskId,
          agent: agent.role as AgentRole,
        });

        // Create agent session
        const { session } = await createKbAgent({
          cwd: rootDir,
          systemPrompt: HEARTBEAT_SYSTEM_PROMPT,
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
        });

        // Track for monitoring
        this.trackAgent(agentId, { dispose: () => session.dispose() }, run.id);

        try {
          // Build execution prompt
          const taskTitle = taskDetail.title ?? taskDetail.description.slice(0, 100);
          const executionPrompt = [
            `Heartbeat execution for agent "${agent.name}" (ID: ${agent.id})`,
            `Source: ${source}${triggerDetail ? ` (${triggerDetail})` : ""}`,
            `Assigned task: ${taskId} — ${taskTitle}`,
            "",
            "Task description:",
            taskDetail.description,
            "",
            taskDetail.prompt ? `PROMPT.md:\n${taskDetail.prompt}` : "No PROMPT.md available.",
            "",
            "Review the task status and take appropriate action. Call heartbeat_done when finished.",
          ].join("\n");

          // Execute
          await promptWithFallback(session, executionPrompt);

          // Estimate output tokens (rough: ~4 chars per token)
          const estimatedOutputTokens = Math.ceil(outputLength / 4);
          await flushAgentLogger();

          // Complete run successfully
          await this.completeRun(agentId, run.id, {
            status: "completed",
            usageJson: { inputTokens: 0, outputTokens: estimatedOutputTokens, cachedTokens: 0 },
            resultJson: { summary: heartbeatSummary, toolCallCount },
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
          this.untrackAgent(agentId);
          try { session.dispose(); } catch { /* ignore */ }
        }

        return (await this.store.getRunDetail(agentId, run.id))!;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        heartbeatLog.error(`Heartbeat execution error for ${agentId}: ${errorMessage}`);
        await flushAgentLogger();

        // Attempt to complete the run as failed if it's still active
        try {
          await this.completeRun(agentId, run.id, {
            status: "failed",
            stderrExcerpt: errorMessage,
          });
        } catch {
          // If completeRun also fails, the run remains active — nothing more we can do
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
   * @returns Array of ToolDefinitions for the heartbeat session
   */
  createHeartbeatTools(agentId: string, taskStore: TaskStore, taskId: string): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    // Wrap createTaskCreateTool with tracking and agent-link logging
    const baseCreateTool = createTaskCreateTool(taskStore);
    const trackedCreateTool: ToolDefinition = {
      ...baseCreateTool,
      execute: async (id: string, params: Static<typeof taskCreateParams>, _signal?: unknown, _onUpdate?: unknown, _ctx?: unknown) => {
        const result = await baseCreateTool.execute(id, params, undefined as any, undefined as any, undefined as any);

        // Extract created task ID from the response text ("Created FN-XXX: ...")
        const firstContent = result.content[0];
        const responseText = firstContent && "text" in firstContent ? firstContent.text : "";
        const taskIdMatch = responseText.match(/Created (FN-\d+|KB-\d+|\w+-\d+):/);
        const createdTaskId = taskIdMatch?.[1] ?? "unknown";

        // Log agent link on the created task
        try {
          await taskStore.logEntry(createdTaskId, `Created by agent ${agentId} during heartbeat run`);
        } catch {
          // Non-critical — task was created, just the log failed
        }

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

    // task_log tool (standard, no tracking needed)
    tools.push(createTaskLogTool(taskStore, taskId));

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
  getAgentHeartbeatConfig(agentId: string): ResolvedHeartbeatConfig {
    return this.getAgentConfig(agentId);
  }

  /**
   * Resolve per-agent heartbeat config from runtimeConfig with validation and fallbacks.
   */
  private getAgentConfig(agentId: string): ResolvedHeartbeatConfig {
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
    } catch {
      // If agent lookup fails, use monitor defaults
    }

    return result;
  }

  private async checkMissedHeartbeats(): Promise<void> {
    const now = Date.now();

    for (const tracked of this.trackedAgents.values()) {
      const config = this.getAgentConfig(tracked.agentId);
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
      console.error(`[HeartbeatMonitor] Error disposing session for ${tracked.agentId}:`, err);
    }

    // Update agent state to terminated
    try {
      await this.store.updateAgentState(tracked.agentId, "terminated");
    } catch (err) {
      console.error(`[HeartbeatMonitor] Error terminating agent ${tracked.agentId}:`, err);
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
 * scheduler.registerAgent("agent-123", { heartbeatIntervalMs: 30000, enabled: true });
 * scheduler.start();
 * ```
 */
export class HeartbeatTriggerScheduler {
  private store: AgentStore;
  private callback: TriggerCallback;
  private timers: Map<string, AgentTimer> = new Map();
  private running = false;
  private assignedListener: ((agent: import("@fusion/core").Agent, taskId: string) => void) | null = null;

  constructor(store: AgentStore, callback: TriggerCallback) {
    this.store = store;
    this.callback = callback;
  }

  /**
   * Start the scheduler. Enables assignment watching.
   * Individual agents must be registered separately via registerAgent().
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.watchAssignments();
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

    // Skip if no interval configured
    const rawIntervalMs = config.heartbeatIntervalMs;
    if (!rawIntervalMs || typeof rawIntervalMs !== "number" || !Number.isFinite(rawIntervalMs) || rawIntervalMs <= 0) {
      heartbeatLog.log(`Skipping timer registration for ${agentId} (no interval)`);
      return;
    }

    const intervalMs = Math.max(1000, Math.round(rawIntervalMs));

    // Clear existing timer if re-registering
    this.unregisterAgent(agentId);

    const handle = setInterval(() => {
      void this.onTimerTick(agentId, intervalMs);
    }, intervalMs);

    this.timers.set(agentId, { intervalMs, handle });
    heartbeatLog.log(`Registered timer for ${agentId} (every ${intervalMs}ms)`);
  }

  /**
   * Unregister an agent, clearing its timer.
   * @param agentId - The agent ID
   */
  unregisterAgent(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) {
      clearInterval(timer.handle);
      this.timers.delete(agentId);
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
        } catch {
          // If getBudgetStatus fails, proceed without budget check
        }

        heartbeatLog.log(`Assignment trigger for ${agent.id} (task: ${taskId})`);
        await this.callback(agent.id, "assignment", {
          taskId,
          wakeReason: "assignment",
          triggerDetail: "task-assigned",
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

  /**
   * Handle a timer tick for an agent.
   * Checks for active runs before invoking the callback.
   */
  private async onTimerTick(agentId: string, intervalMs: number): Promise<void> {
    if (!this.running) return;

    try {
      // Check for active runs
      const activeRun = await this.store.getActiveHeartbeatRun(agentId);
      if (activeRun) {
        heartbeatLog.log(`Timer tick skipped for ${agentId} (active run)`);
        return;
      }

      // Budget governance: skip timer triggers for over-budget agents
      try {
        const budgetStatus = await this.store.getBudgetStatus(agentId);
        if (budgetStatus.isOverBudget) {
          heartbeatLog.log(`Agent ${agentId} budget exhausted — timer tick skipped`);
          return;
        }
        if (budgetStatus.isOverThreshold) {
          heartbeatLog.log(`Agent ${agentId} over budget threshold (${budgetStatus.usagePercent}%) — timer tick skipped`);
          return;
        }
      } catch {
        // If getBudgetStatus fails, proceed without budget check
      }

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
