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

import type { AgentStore, Agent, AgentState } from "@kb/core";

/** Options for HeartbeatMonitor constructor */
export interface HeartbeatMonitorOptions {
  /** AgentStore instance for persistence */
  store: AgentStore;
  /** Polling interval in milliseconds (default: 30000) */
  pollIntervalMs?: number;
  /** Heartbeat timeout in milliseconds (default: 60000) */
  heartbeatTimeoutMs?: number;
  /** Callback when an agent misses its heartbeat */
  onMissed?: (agentId: string) => void;
  /** Callback when an agent recovers after a missed heartbeat */
  onRecovered?: (agentId: string) => void;
  /** Callback when an unresponsive agent is terminated */
  onTerminated?: (agentId: string) => void;
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
}

/**
 * HeartbeatMonitor monitors agents via periodic polling.
 * Detects missed heartbeats and auto-terminates unresponsive agents.
 */
export class HeartbeatMonitor {
  private store: AgentStore;
  private pollIntervalMs: number;
  private heartbeatTimeoutMs: number;
  private onMissed?: (agentId: string) => void;
  private onRecovered?: (agentId: string) => void;
  private onTerminated?: (agentId: string) => void;

  private trackedAgents: Map<string, TrackedAgent> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(options: HeartbeatMonitorOptions) {
    this.store = options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? 30000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60000;
    this.onMissed = options.onMissed;
    this.onRecovered = options.onRecovered;
    this.onTerminated = options.onTerminated;
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
   * Register an agent for monitoring.
   * @param agentId - The agent ID
   * @param session - Session with dispose() for cleanup
   * @param runId - The heartbeat run ID
   */
  trackAgent(agentId: string, session: AgentSession, runId: string): void {
    const tracked: TrackedAgent = {
      agentId,
      session,
      runId,
      lastSeen: Date.now(),
      missedHeartbeatReported: false,
    };

    this.trackedAgents.set(agentId, tracked);

    // Record initial heartbeat
    void this.store.recordHeartbeat(agentId, "ok", runId);
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