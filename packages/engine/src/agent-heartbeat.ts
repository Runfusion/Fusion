/**
 * HeartbeatMonitor - Runtime monitoring for agent health
 * 
 * Monitors agents via periodic polling and detects missed heartbeats.
 * Follows the StuckTaskDetector pattern for consistency.
 * 
 * Callback pattern (not EventEmitter):
 * - onMissed: Called when an agent misses its heartbeat
 * - onRecovered: Called when an agent recovers after a missed heartbeat
 * - onTerminated: Called when an unresponsive agent is terminated
 */

import type { AgentStore, AgentHeartbeatRun, HeartbeatInvocationSource } from "@fusion/core";

/** Options for HeartbeatMonitor constructor */
export interface HeartbeatMonitorOptions {
  /** AgentStore instance for persistence */
  store: AgentStore;
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
 * HeartbeatMonitor monitors agents via periodic polling.
 * Detects missed heartbeats and auto-terminates unresponsive agents.
 */
export class HeartbeatMonitor {
  private store: AgentStore;
  private pollIntervalMs: number;
  private heartbeatTimeoutMs: number;
  private maxConcurrentRuns: number;
  private onMissed?: (agentId: string) => void;
  private onRecovered?: (agentId: string) => void;
  private onTerminated?: (agentId: string) => void;
  private onRunStarted?: (agentId: string, run: AgentHeartbeatRun) => void;
  private onRunCompleted?: (agentId: string, run: AgentHeartbeatRun) => void;

  private trackedAgents: Map<string, TrackedAgent> = new Map();
  private agentStartLocks: Map<string, Promise<unknown>> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(options: HeartbeatMonitorOptions) {
    this.store = options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? 30000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60000;
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 1;
    this.onMissed = options.onMissed;
    this.onRecovered = options.onRecovered;
    this.onTerminated = options.onTerminated;
    this.onRunStarted = options.onRunStarted;
    this.onRunCompleted = options.onRunCompleted;
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
   * @param agentId - The agent ID
   * @returns true if healthy, false if missed heartbeat or not tracked
   */
  isAgentHealthy(agentId: string): boolean {
    const tracked = this.trackedAgents.get(agentId);
    if (!tracked) return false;

    const elapsed = Date.now() - tracked.lastSeen;
    return elapsed < this.heartbeatTimeoutMs;
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
  // Private methods
  // ─────────────────────────────────────────────────────────────────────────

  private async checkMissedHeartbeats(): Promise<void> {
    const now = Date.now();

    for (const tracked of this.trackedAgents.values()) {
      const elapsed = now - tracked.lastSeen;

      if (elapsed >= this.heartbeatTimeoutMs) {
        // Missed heartbeat detected
        if (!tracked.missedHeartbeatReported) {
          tracked.missedHeartbeatReported = true;
          await this.handleMissedHeartbeat(tracked);
        } else {
          // Already reported - check if we should terminate
          // Give 2x timeout for recovery before auto-terminate
          if (elapsed >= this.heartbeatTimeoutMs * 2) {
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