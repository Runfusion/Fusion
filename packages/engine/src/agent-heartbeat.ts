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

import type { AgentStore, AgentHeartbeatRun, HeartbeatInvocationSource, TaskStore, TaskDetail } from "@fusion/core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@mariozechner/pi-ai";
import { createTaskCreateTool, createTaskLogTool } from "./agent-tools.js";
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

  private trackedAgents: Map<string, TrackedAgent> = new Map();
  private agentStartLocks: Map<string, Promise<unknown>> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

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
  }

  /**
   * Start the heartbeat monitoring loop.
   * Safe to call multiple times - no-op if already running.
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.pollInterval = setInterval(() => {
      void this.checkMissedHeartbeats();
    }, this.pollIntervalMs);
  }

  /**
   * Stop the heartbeat monitoring loop.
   * Does not untrack agents - they remain in memory.
   */
  stop(): void {
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
    }
  ): Promise<void> {
    // Load and update the run
    const run = await this.store.getRunDetail(agentId, runId);
    if (!run) return;

    const tracked = this.trackedAgents.get(agentId);
    const completedRun: AgentHeartbeatRun = {
      ...run,
      endedAt: new Date().toISOString(),
      status: result.status,
      exitCode: result.exitCode,
      sessionIdBefore: tracked?.sessionIdBefore,
      sessionIdAfter: result.sessionIdAfter,
      usageJson: result.usageJson,
      resultJson: result.resultJson,
      stdoutExcerpt: result.stdoutExcerpt,
      stderrExcerpt: result.stderrExcerpt,
    };

    await this.store.saveRun(completedRun);

    // Update cumulative usage on agent
    if (result.usageJson) {
      try {
        const agent = await this.store.getAgent(agentId);
        if (agent) {
          await this.store.updateAgent(agentId, {
            totalInputTokens: (agent.totalInputTokens ?? 0) + result.usageJson.inputTokens,
            totalOutputTokens: (agent.totalOutputTokens ?? 0) + result.usageJson.outputTokens,
          });
        }
      } catch {
        // Non-critical, skip
      }
    }

    // Transition agent state based on result
    try {
      if (result.status === "failed") {
        await this.store.updateAgentState(agentId, "error");
        await this.store.updateAgent(agentId, { lastError: result.stderrExcerpt ?? "Run failed" });
      } else if (result.status === "terminated") {
        await this.store.updateAgentState(agentId, "terminated");
      } else {
        // Completed successfully - back to active
        await this.store.updateAgentState(agentId, "active");
      }
    } catch {
      // State transition may fail if already in target state
    }

    // End the heartbeat run tracking
    await this.store.endHeartbeatRun(runId, result.status === "completed" ? "completed" : "terminated");

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
   * Per-agent execution is serialized via `withAgentStartLock` — concurrent calls
   * for the same agent wait for the previous run to complete.
   * 
   * @param options - Execution options (agent ID, source, optional task override)
   * @returns The completed heartbeat run, or null if the monitor isn't configured for execution
   * @throws Error if taskStore or rootDir are not configured
   */
  async executeHeartbeat(options: HeartbeatExecutionOptions): Promise<AgentHeartbeatRun> {
    const { agentId, source, triggerDetail, taskId: explicitTaskId } = options;

    // Validate execution dependencies
    if (!this.taskStore || !this.rootDir) {
      throw new Error("HeartbeatMonitor not configured for execution (missing taskStore/rootDir)");
    }
    const taskStore = this.taskStore;
    const rootDir = this.rootDir;

    // Serialize per-agent
    return this.withAgentStartLock(agentId, async () => {
      heartbeatLog.log(`Executing heartbeat for ${agentId} (source=${source})`);

      // Start run
      const run = await this.startRun(agentId, { source, triggerDetail });

      try {
        // Resolve agent
        const agent = await this.store.getAgent(agentId);
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
        let outputLength = 0;
        let toolCallCount = 0;
        let heartbeatSummary: string | undefined;

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

        // Create agent session
        const { session } = await createKbAgent({
          cwd: rootDir,
          systemPrompt: HEARTBEAT_SYSTEM_PROMPT,
          tools: "readonly",
          customTools: [
            createTaskCreateTool(taskStore),
            createTaskLogTool(taskStore, taskId),
            heartbeatDoneTool,
          ],
          defaultProvider: agent.runtimeConfig?.modelProvider as string | undefined,
          defaultModelId: agent.runtimeConfig?.modelId as string | undefined,
          onText: (delta) => { outputLength += delta.length; },
          onToolEnd: () => { toolCallCount++; },
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

          // Complete run successfully
          await this.completeRun(agentId, run.id, {
            status: "completed",
            usageJson: { inputTokens: 0, outputTokens: estimatedOutputTokens, cachedTokens: 0 },
            resultJson: { summary: heartbeatSummary, toolCallCount },
          });

          heartbeatLog.log(`Heartbeat completed for ${agentId} (${toolCallCount} tool calls, ~${estimatedOutputTokens} output tokens)`);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          heartbeatLog.error(`Heartbeat execution failed for ${agentId}: ${errorMessage}`);
          await this.completeRun(agentId, run.id, {
            status: "failed",
            stderrExcerpt: errorMessage,
          });
        } finally {
          this.untrackAgent(agentId);
          try { session.dispose(); } catch { /* ignore */ }
        }

        return (await this.store.getRunDetail(agentId, run.id))!;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        heartbeatLog.error(`Heartbeat execution error for ${agentId}: ${errorMessage}`);

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
