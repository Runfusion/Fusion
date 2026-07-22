/**
 * EphemeralWorkerManager
 *
 * Owns the lifecycle of runtime-spawned task-worker agents — the short-lived
 * `executor-FN-XXXX` agents created by the executor to track ownership of an
 * in-progress task. Coordinates between TaskExecutor callbacks and AgentStore
 * so that workers are:
 *
 * - Spawned at most once per task (deduplicated across runtime restarts).
 * - Cleaned up when the task completes, errors, or the parent runtime is
 *   restarted with stale on-disk state from a previous session.
 * - Reconciled on startup: anything not bound to an in-progress task is a
 *   zombie and gets deleted.
 *
 * This logic used to live inline inside InProcessRuntime, where it relied
 * solely on an in-memory `taskAgentMap` that reset on every process start.
 * That meant any restart between `onStart` and `onComplete` would orphan
 * the ephemeral worker on disk; over time hundreds piled up. The dedup
 * lookup on creation, the on-disk fallback on completion, and the startup
 * sweep here close that gap.
 */
import type { AgentStore, AgentState, Agent, TaskStore, Task, Settings } from "@fusion/core";
import { isEphemeralAgent } from "@fusion/core";

export interface TaskOwner {
  agentId: string;
  /** True for runtime-spawned workers; false for durable assigned agents. */
  ephemeral: boolean;
}

export interface EphemeralWorkerLogger {
  log: (msg: string, ...rest: unknown[]) => void;
  warn: (msg: string, ...rest: unknown[]) => void;
}

export interface EphemeralWorkerManagerOptions {
  agentStore: AgentStore;
  taskStore: TaskStore;
  logger: EphemeralWorkerLogger;
  /**
   * External pending-deletion check — TaskExecutor maintains its own set
   * for spawned-child cleanup; we treat those as "already handled" so we
   * don't race the executor on the same agentId.
   */
  isDeletionPendingExternal?: (agentId: string) => boolean;
  getSettings?: () => Promise<Pick<Settings, "ephemeralAgentsEnabled">>;
}

const TERMINAL_TASK_COLUMNS = new Set<Task["column"]>(["done", "archived"]);

export class EphemeralWorkerManager {
  private readonly agentStore: AgentStore;
  private readonly taskStore: TaskStore;
  private readonly log: EphemeralWorkerLogger;
  private readonly isDeletionPendingExternal: (agentId: string) => boolean;
  private readonly getSettings: () => Promise<Pick<Settings, "ephemeralAgentsEnabled">>;

  /** taskId → owner. In-memory only; on-disk fallback covers restart gaps. */
  private readonly taskAgentMap = new Map<string, TaskOwner>();
  /** agentIds with in-flight delete; prevents racing parallel cleanup paths. */
  private readonly pendingDeletions = new Set<string>();

  private stateChangeListener?: (agentId: string, from: AgentState, to: AgentState) => void;

  constructor(options: EphemeralWorkerManagerOptions) {
    this.agentStore = options.agentStore;
    this.taskStore = options.taskStore;
    this.log = options.logger;
    this.isDeletionPendingExternal = options.isDeletionPendingExternal ?? (() => false);
    this.getSettings = options.getSettings ?? (async () => ({ ephemeralAgentsEnabled: true }));
  }

  // ── public surface ───────────────────────────────────────────────────────

  /**
   * Establish ownership for a task that just started executing.
   * - If the task carries an `assignedAgentId` pointing at a durable agent,
   *   bind that agent to the task and flip it through active → running.
   * - Otherwise spawn (or reclaim) an ephemeral `executor-${task.id}` worker.
   *
   * Cross-restart safe: looks up an existing ephemeral by name before
   * creating a new one.
   */
  async onTaskStart(task: Task): Promise<TaskOwner | null> {
    try {
      const assignedAgentId = task.assignedAgentId;
      if (assignedAgentId) {
        const assignedAgent = await this.agentStore.getAgent(assignedAgentId);
        if (assignedAgent && !isEphemeralAgent(assignedAgent)) {
          this.taskAgentMap.set(task.id, { agentId: assignedAgent.id, ephemeral: false });
          await this.agentStore.syncExecutionTaskLink(assignedAgent.id, task.id);
          const currentState = assignedAgent.state;
          if (currentState !== "running") {
            if (currentState !== "active") {
              await this.agentStore.updateAgentState(assignedAgent.id, "active");
            }
            await this.agentStore.updateAgentState(assignedAgent.id, "running");
          }
          return { agentId: assignedAgent.id, ephemeral: false };
        }
      }

      // Already-tracked in this session: leave alone.
      const cached = this.taskAgentMap.get(task.id);
      if (cached) {
        this.log.warn(`Skipping task-worker creation for ${task.id}: task already has execution owner`);
        return cached;
      }

      // Cross-restart dedup. taskAgentMap resets per process, so without
      // this check a task started in a prior session would get a fresh
      // duplicate on every retry — historically how `executor-FN-XXXX`
      // duplicates piled up by the hundreds on disk.
      const existing = await this.lookupExistingByName(`executor-${task.id}`);
      if (existing) {
        if (existing.taskId === task.id) {
          this.taskAgentMap.set(task.id, { agentId: existing.id, ephemeral: true });
          this.log.log(`Reusing existing ephemeral worker ${existing.id} for task ${task.id} after restart`);
          return { agentId: existing.id, ephemeral: true };
        }
        // Stale ephemeral from a prior attempt — delete so the executor- name
        // is reusable.
        try {
          await this.agentStore.deleteAgent(existing.id);
          this.log.log(`Deleted stale ephemeral worker ${existing.id} for task ${task.id} before respawn`);
        } catch (delErr) {
          this.log.warn(`Failed to delete stale ephemeral worker ${existing.id} for ${task.id}:`, delErr);
        }
      }

      const settings = await this.getSettings();
      if (settings.ephemeralAgentsEnabled === false) {
        this.log.warn(
          `Task ${task.id} has no permanent agent assignment; ephemeralAgentsEnabled=false — refusing to spawn ephemeral worker`,
        );
        return null;
      }

      const agent = await this.agentStore.createAgent({
        name: `executor-${task.id}`,
        role: "executor",
        metadata: {
          agentKind: "task-worker",
          taskWorker: true,
          managedBy: "task-executor",
        },
        runtimeConfig: { enabled: false },
      });
      this.taskAgentMap.set(task.id, { agentId: agent.id, ephemeral: true });
      await this.agentStore.assignTask(agent.id, task.id);
      await this.agentStore.updateAgentState(agent.id, "active");
      await this.agentStore.updateAgentState(agent.id, "running");
      return { agentId: agent.id, ephemeral: true };
    } catch (err) {
      this.log.warn(`Failed to initialize execution owner for task ${task.id}:`, err);
      return null;
    }
  }

  /**
   * Tear down ownership after a task completes or errors.
   * Final state for durable agents matches the outcome (idle/error).
   * Ephemeral workers are deleted regardless; if the in-memory owner is
   * missing (e.g. restart between onStart and this callback), falls back
   * to a name-based lookup so the worker still gets cleaned up.
   */
  async onTaskComplete(taskId: string): Promise<void> {
    // After a successful task, durable agents return to "active" (heartbeat
    // ready). Ephemerals are deleted regardless.
    return this.finalize(taskId, "active", "completion");
  }

  async onTaskError(taskId: string): Promise<void> {
    return this.finalize(taskId, "error", "error");
  }

  /**
   * Listener for agent:stateChanged. Cleans up ephemerals that get halted
   * out-of-band — e.g. by HeartbeatMonitor flipping them to paused/error
   * outside the onComplete/onError callbacks.
   *
   * Returns the listener fn so the caller can detach it on shutdown.
   */
  attachStateChangeListener(): (agentId: string, from: AgentState, to: AgentState) => void {
    if (this.stateChangeListener) return this.stateChangeListener;
    const listener = (agentId: string, from: AgentState, to: AgentState): void => {
      if (to !== "paused" && to !== "error") return;
      if (from === to) return;
      if (this.pendingDeletions.has(agentId) || this.isDeletionPendingExternal(agentId)) return;
      void (async () => {
        try {
          const agent = await this.agentStore.getAgent(agentId);
          if (!agent) return;
          const isWorkerLike = isEphemeralAgent(agent)
            || agent.metadata?.taskWorker === true
            || agent.metadata?.agentKind === "task-worker"
            || agent.metadata?.agentKind === "spawned";
          if (!isWorkerLike) return;
          await this.deleteEphemeralAgent(agentId, "halt-listener");
        } catch (err) {
          this.log.warn(`Failed to process halt event for agent ${agentId}: ${this.formatError(err)}`);
        }
      })();
    };
    this.stateChangeListener = listener;
    this.agentStore.on("agent:stateChanged", listener);
    return listener;
  }

  detachStateChangeListener(): void {
    if (!this.stateChangeListener) return;
    this.agentStore.off("agent:stateChanged", this.stateChangeListener);
    this.stateChangeListener = undefined;
  }

  /**
   * Startup sweep. Returns the count of zombies cleaned up. Best-effort —
   * failures are logged and skipped so they never block runtime startup.
   *
   * Survivors after this pass: agents bound to a still-in-progress task.
   * Anything else (no taskId, terminal task column, or halted state) is
   * by definition a leak.
   */
  async reconcileOrphaned(): Promise<number> {
    let cleanedCount = 0;
    try {
      const allAgents = await this.agentStore.listAgents({ includeEphemeral: true });
      for (const agent of allAgents) {
        if (!isEphemeralAgent(agent)) continue;
        if (!(await this.shouldDeleteOnSweep(agent))) continue;
        try {
          await this.agentStore.deleteAgent(agent.id);
          cleanedCount += 1;
        } catch (err) {
          if (this.isBenignDeleteRace(agent.id, err)) {
            cleanedCount += 1;
            continue;
          }
          this.log.warn(`Startup sweep failed to delete ephemeral agent ${agent.id}: ${this.formatError(err)}`);
        }
      }
    } catch (err) {
      this.log.warn(`Startup ephemeral sweep failed: ${this.formatError(err)}`);
    }
    if (cleanedCount > 0) {
      this.log.log(`Startup ephemeral sweep cleaned ${cleanedCount} orphaned agent(s)`);
    }
    return cleanedCount;
  }

  /** Drop in-memory state. Call on runtime stop. */
  reset(): void {
    this.taskAgentMap.clear();
    this.pendingDeletions.clear();
  }

  /** True if a delete is in flight; lets external callers avoid double-delete races. */
  isDeletionPending(agentId: string): boolean {
    return this.pendingDeletions.has(agentId);
  }

  getOwner(taskId: string): TaskOwner | undefined {
    return this.taskAgentMap.get(taskId);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async finalize(
    taskId: string,
    terminalState: "active" | "error",
    reason: "completion" | "error",
  ): Promise<void> {
    const owner = this.taskAgentMap.get(taskId) ?? await this.recoverOwnerFromDisk(taskId);
    if (!owner) return;
    const { agentId, ephemeral } = owner;
    if (ephemeral) {
      this.pendingDeletions.add(agentId);
    }

    const effectiveTerminalState = reason === "error" && !ephemeral ? "active" : terminalState;

    try {
      await this.agentStore.updateAgentState(agentId, effectiveTerminalState);
    } catch (err) {
      this.log.warn(`Failed to update agent ${agentId} to ${effectiveTerminalState} (${reason}): ${this.formatError(err)}`);
    }
    try {
      await this.agentStore.syncExecutionTaskLink(agentId, undefined);
    } catch (err) {
      this.log.warn(`Failed to clear execution task link for agent ${agentId} on ${reason}: ${this.formatError(err)}`);
    }
    this.taskAgentMap.delete(taskId);

    if (!ephemeral) return;
    try {
      await this.agentStore.deleteAgent(agentId);
    } catch (err) {
      if (this.isBenignDeleteRace(agentId, err)) return;
      this.log.warn(`Failed to delete agent ${agentId} after ${reason}: ${this.formatError(err)}`);
    } finally {
      this.pendingDeletions.delete(agentId);
    }
  }

  /**
   * Look up the ephemeral worker on disk when the in-memory map has no
   * record. Covers the cross-restart case where onComplete fires in a
   * different process session than the onStart that created the worker.
   */
  private async recoverOwnerFromDisk(taskId: string): Promise<TaskOwner | null> {
    try {
      const candidate = await this.lookupExistingByName(`executor-${taskId}`);
      if (candidate) {
        this.log.log(`Recovered ephemeral owner ${candidate.id} for task ${taskId} from disk (cross-restart)`);
        return { agentId: candidate.id, ephemeral: true };
      }
    } catch (err) {
      this.log.warn(`Cross-restart owner lookup failed for task ${taskId}: ${this.formatError(err)}`);
    }
    return null;
  }

  private async lookupExistingByName(name: string): Promise<Agent | null> {
    try {
      const found = await this.agentStore.findAgentByName(name);
      if (found && isEphemeralAgent(found)) return found;
      return null;
    } catch (err) {
      this.log.warn(`findAgentByName(${name}) failed: ${this.formatError(err)}`);
      return null;
    }
  }

  private async shouldDeleteOnSweep(agent: Agent): Promise<boolean> {
    // Halt states are always zombies — the live path would have deleted them.
    if (agent.state === "paused" || agent.state === "error") return true;
    // No task binding means no work in progress.
    if (!agent.taskId) return true;
    try {
      const task = await this.taskStore.getTask(agent.taskId);
      if (!task) return true;
      if (TERMINAL_TASK_COLUMNS.has(task.column)) return true;
      return task.column !== "in-progress";
    } catch {
      // If we can't even read the task, assume the binding is broken.
      return true;
    }
  }

  private async deleteEphemeralAgent(agentId: string, reason: string): Promise<void> {
    if (this.pendingDeletions.has(agentId)) return;
    this.pendingDeletions.add(agentId);
    try {
      await this.agentStore.deleteAgent(agentId);
    } catch (err) {
      if (this.isBenignDeleteRace(agentId, err)) return;
      this.log.warn(`Failed to delete ephemeral agent ${agentId} (${reason}): ${this.formatError(err)}`);
    } finally {
      this.pendingDeletions.delete(agentId);
    }
  }

  private isBenignDeleteRace(agentId: string, err: unknown): boolean {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (msg.includes("already deleted") || msg.includes("already removed")) return true;
    if (msg.includes(`agent ${agentId.toLowerCase()} not found`)) return true;
    return false;
  }

  private formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
