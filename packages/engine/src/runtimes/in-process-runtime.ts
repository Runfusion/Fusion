import { EventEmitter } from "node:events";
import type {
  TaskStore,
  Task,
  CentralCore,
  AgentStore,
} from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import { TaskExecutor, type TaskExecutorOptions } from "../executor.js";
import { WorktreePool } from "../worktree-pool.js";
import { AgentSemaphore } from "../concurrency.js";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import type {
  ProjectRuntime,
  ProjectRuntimeConfig,
  RuntimeStatus,
  RuntimeMetrics,
  ProjectRuntimeEvents,
} from "../project-runtime.js";
import { runtimeLog } from "../logger.js";
import type { StuckTaskDetector } from "../stuck-task-detector.js";
import type { UsageLimitPauser } from "../usage-limit-detector.js";
import { SelfHealingManager } from "../self-healing.js";

/**
 * InProcessRuntime runs a project within the main process.
 *
 * This is the default execution mode — all components (TaskStore, Scheduler,
 * Executor, WorktreePool) share the same memory space and event loop.
 *
 * Features:
 * - Direct access to TaskStore and Scheduler via getter methods
 * - Synchronous event forwarding from TaskStore to runtime listeners
 * - Graceful shutdown with configurable timeout
 * - Automatic orphaned task recovery on startup
 *
 * @example
 * ```typescript
 * const config: ProjectRuntimeConfig = {
 *   projectId: "proj_abc123",
 *   workingDirectory: "/path/to/project",
 *   isolationMode: "in-process",
 *   maxConcurrent: 2,
 *   maxWorktrees: 4,
 * };
 *
 * const runtime = new InProcessRuntime(config, centralCore);
 * await runtime.start();
 *
 * // Access components directly
 * const taskStore = runtime.getTaskStore();
 * const scheduler = runtime.getScheduler();
 *
 * await runtime.stop();
 * ```
 */
export class InProcessRuntime
  extends EventEmitter<ProjectRuntimeEvents>
  implements ProjectRuntime
{
  private status: RuntimeStatus = "stopped";
  private taskStore!: TaskStore;
  private scheduler!: Scheduler;
  private executor!: TaskExecutor;
  private worktreePool!: WorktreePool;
  private globalSemaphore?: AgentSemaphore;
  private stuckTaskDetector?: StuckTaskDetector;
  private usageLimitPauser?: UsageLimitPauser;
  private selfHealingManager?: SelfHealingManager;
  private agentStore?: AgentStore;
  private heartbeatMonitor?: HeartbeatMonitor;
  /** Maps task IDs to agent IDs for lifecycle tracking */
  private taskAgentMap = new Map<string, string>();
  private lastActivityAt: string = new Date().toISOString();

  /**
   * @param config - Runtime configuration
   * @param centralCore - CentralCore reference for global coordination
   */
  constructor(
    private config: ProjectRuntimeConfig,
    private centralCore: CentralCore
  ) {
    super();
    this.setMaxListeners(100);
    runtimeLog.log(`Created InProcessRuntime for project ${config.projectId}`);
  }

  /**
   * Start the runtime and initialize all subsystems.
   *
   * Initialization order:
   * 1. Initialize TaskStore
   * 2. Initialize WorktreePool
   * 3. Initialize Scheduler (with TaskStore)
   * 4. Initialize TaskExecutor (with TaskStore, worktree pool, global semaphore)
   * 5. Resume orphaned in-progress tasks
   * 6. Start scheduler
   */
  async start(): Promise<void> {
    if (this.status !== "stopped") {
      throw new Error(`Cannot start runtime: current status is ${this.status}`);
    }

    this.setStatus("starting");
    runtimeLog.log(`Starting InProcessRuntime for project ${this.config.projectId}`);

    try {
      // 1. Initialize TaskStore
      const { TaskStore } = await import("@fusion/core");
      this.taskStore = new TaskStore(this.config.workingDirectory);
      await this.taskStore.init();
      runtimeLog.log(`TaskStore initialized for project ${this.config.projectId}`);

      // 2. Initialize WorktreePool
      this.worktreePool = new WorktreePool();

      // Rehydrate pool from disk state (idle worktrees)
      const { scanIdleWorktrees } = await import("../worktree-pool.js");
      const idleWorktrees = await scanIdleWorktrees(
        this.config.workingDirectory,
        this.taskStore
      );
      if (idleWorktrees.length > 0) {
        this.worktreePool.rehydrate(idleWorktrees);
        runtimeLog.log(
          `Rehydrated worktree pool with ${idleWorktrees.length} idle worktrees`
        );
      }

      // 3. Initialize global semaphore from CentralCore
      const globalLimit = await this.getGlobalConcurrencyLimit();
      this.globalSemaphore = new AgentSemaphore(() => globalLimit);

      // 4. Initialize Scheduler
      const missionStore = this.taskStore.getMissionStore();
      this.scheduler = new Scheduler(this.taskStore, {
        maxConcurrent: this.config.maxConcurrent,
        maxWorktrees: this.config.maxWorktrees,
        semaphore: this.globalSemaphore,
        missionStore,
        onSchedule: (task) => {
          this.recordActivity();
          runtimeLog.log(`Scheduled task ${task.id}`);
        },
        onBlocked: (task, blockedBy) => {
          runtimeLog.log(`Task ${task.id} blocked by: ${blockedBy.join(", ")}`);
        },
      });

      // 5. Initialize TaskExecutor
      const executorOptions: TaskExecutorOptions = {
        semaphore: this.globalSemaphore,
        pool: this.worktreePool,
        usageLimitPauser: this.usageLimitPauser,
        stuckTaskDetector: this.stuckTaskDetector,
        missionStore,
        onSliceComplete: (slice) => {
          void this.scheduler.onSliceComplete(slice);
        },
        onStart: (task, worktreePath) => {
          this.recordActivity();
          runtimeLog.log(`Started executing task ${task.id} in ${worktreePath}`);
          // Create agent in AgentStore for lifecycle tracking
          if (this.agentStore) {
            this.agentStore.createAgent({
              name: `executor-${task.id}`,
              role: "executor",
            }).then(async (agent: { id: string }) => {
              this.taskAgentMap.set(task.id, agent.id);
              await this.agentStore!.assignTask(agent.id, task.id);
              await this.agentStore!.updateAgentState(agent.id, "active");
            }).catch((err: unknown) => {
              runtimeLog.warn(`Failed to create agent for task ${task.id}:`, err);
            });
          }
        },
        onComplete: (task) => {
          this.recordActivity();
          runtimeLog.log(`Completed task ${task.id}`);
          this.recordTaskCompletion(task.id, true);
          // Update agent state to terminated (completed)
          const agentId = this.taskAgentMap.get(task.id);
          if (agentId && this.agentStore) {
            void this.agentStore.updateAgentState(agentId, "terminated").catch(() => {});
            this.taskAgentMap.delete(task.id);
          }
        },
        onError: (task, error) => {
          this.recordActivity();
          runtimeLog.error(`Task ${task.id} failed:`, error.message);
          this.recordTaskCompletion(task.id, false);
          // Update agent state to terminated (failed)
          const agentId = this.taskAgentMap.get(task.id);
          if (agentId && this.agentStore) {
            void this.agentStore.updateAgentState(agentId, "terminated").catch(() => {});
            this.taskAgentMap.delete(task.id);
          }
        },
      };

      this.executor = new TaskExecutor(
        this.taskStore,
        this.config.workingDirectory,
        executorOptions
      );

      // 6. Initialize AgentStore and HeartbeatMonitor
      try {
        const { AgentStore: AgentStoreClass } = await import("@fusion/core");
        this.agentStore = new AgentStoreClass({ rootDir: this.taskStore.getRootDir() });
        await this.agentStore.init();

        this.heartbeatMonitor = new HeartbeatMonitor({
          store: this.agentStore,
          onMissed: (agentId) => {
            runtimeLog.warn(`Agent ${agentId} missed heartbeat`);
          },
          onTerminated: (agentId) => {
            runtimeLog.warn(`Agent ${agentId} terminated (unresponsive)`);
          },
        });
        this.heartbeatMonitor.start();
        runtimeLog.log(`AgentStore and HeartbeatMonitor initialized`);
      } catch (agentErr) {
        // Non-fatal — agent monitoring is optional
        runtimeLog.warn(`AgentStore initialization failed (continuing without agent monitoring):`, agentErr);
      }

      // 7. Initialize SelfHealingManager
      this.selfHealingManager = new SelfHealingManager(this.taskStore, {
        rootDir: this.config.workingDirectory,
      });
      this.selfHealingManager.start();

      // 8. Set up event forwarding from TaskStore
      this.setupEventForwarding();

      // 9. Resume orphaned in-progress tasks
      await this.executor.resumeOrphaned();

      // 10. Start scheduler
      this.scheduler.start();

      this.setStatus("active");
      runtimeLog.log(`InProcessRuntime started for project ${this.config.projectId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus("errored");
      runtimeLog.error(`Failed to start InProcessRuntime:`, err.message);
      this.emit("error", err);
      throw err;
    }
  }

  /**
   * Stop the runtime with graceful shutdown.
   *
   * Shutdown sequence:
   * 1. Set status to "stopping"
   * 2. Stop scheduler (no new tasks)
   * 3. Wait for executor to finish active tasks (with timeout)
   * 4. Drain and cleanup worktree pool
   * 5. Set status to "stopped"
   *
   * @throws Error if shutdown timeout is exceeded
   */
  async stop(): Promise<void> {
    if (this.status === "stopped" || this.status === "stopping") {
      return;
    }

    this.setStatus("stopping");
    runtimeLog.log(`Stopping InProcessRuntime for project ${this.config.projectId}`);

    try {
      // 1. Stop self-healing manager
      if (this.selfHealingManager) {
        this.selfHealingManager.stop();
        runtimeLog.log("SelfHealingManager stopped");
      }

      // 2. Stop heartbeat monitor
      if (this.heartbeatMonitor) {
        this.heartbeatMonitor.stop();
        runtimeLog.log("HeartbeatMonitor stopped");
      }

      // 3. Stop scheduler (prevents new task scheduling)
      if (this.scheduler) {
        this.scheduler.stop();
        runtimeLog.log("Scheduler stopped");
      }

      // 2. Wait for active tasks to complete (30 second timeout)
      const shutdownTimeout = 30000;
      const startTime = Date.now();

      while (Date.now() - startTime < shutdownTimeout) {
        const metrics = this.getMetrics();
        if (metrics.inFlightTasks === 0) {
          break;
        }
        runtimeLog.log(
          `Waiting for ${metrics.inFlightTasks} in-flight tasks to complete...`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Check if we timed out
      const finalMetrics = this.getMetrics();
      if (finalMetrics.inFlightTasks > 0) {
        runtimeLog.warn(
          `Shutdown timeout reached with ${finalMetrics.inFlightTasks} tasks still in-flight`
        );
      }

      // 3. Drain and cleanup worktree pool
      if (this.worktreePool) {
        const worktrees = this.worktreePool.drain();
        if (worktrees.length > 0) {
          runtimeLog.log(`Drained ${worktrees.length} worktrees from pool`);
        }
      }

      this.setStatus("stopped");
      runtimeLog.log(`InProcessRuntime stopped for project ${this.config.projectId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus("errored");
      runtimeLog.error(`Error during shutdown:`, err.message);
      this.emit("error", err);
      throw err;
    }
  }

  /**
   * Get the current runtime status.
   */
  getStatus(): RuntimeStatus {
    return this.status;
  }

  /**
   * Get the project's TaskStore instance.
   * @throws Error if runtime has not been started
   */
  getTaskStore(): TaskStore {
    if (!this.taskStore) {
      throw new Error("TaskStore not initialized. Call start() first.");
    }
    return this.taskStore;
  }

  /**
   * Get the project's Scheduler instance.
   * @throws Error if runtime has not been started
   */
  getScheduler(): Scheduler {
    if (!this.scheduler) {
      throw new Error("Scheduler not initialized. Call start() first.");
    }
    return this.scheduler;
  }

  /**
   * Get current runtime metrics.
   */
  getMetrics(): RuntimeMetrics {
    // Estimate in-flight tasks by checking active sessions
    const inFlightTasks = this.executor
      ? (this.executor as unknown as { activeWorktrees?: Map<string, string> }).activeWorktrees?.size ?? 0
      : 0;

    // Get active agent count from the semaphore
    const activeAgents = this.globalSemaphore?.activeCount ?? 0;

    // Get memory usage if available
    const memoryBytes = process.memoryUsage?.().heapUsed;

    return {
      inFlightTasks,
      activeAgents,
      lastActivityAt: this.lastActivityAt,
      memoryBytes,
    };
  }

  /**
   * Set the StuckTaskDetector for this runtime.
   */
  setStuckTaskDetector(detector: StuckTaskDetector): void {
    this.stuckTaskDetector = detector;
  }

  /**
   * Set the UsageLimitPauser for this runtime.
   */
  setUsageLimitPauser(pauser: UsageLimitPauser): void {
    this.usageLimitPauser = pauser;
  }

  /**
   * Set up event forwarding from TaskStore to runtime listeners.
   */
  private setupEventForwarding(): void {
    // Forward task:created events
    this.taskStore.on("task:created", (task: Task) => {
      this.recordActivity();
      this.emit("task:created", task);
    });

    // Forward task:moved events
    this.taskStore.on("task:moved", (data: { task: Task; from: string; to: string }) => {
      this.recordActivity();
      this.emit("task:moved", data);
    });

    // Forward task:updated events
    this.taskStore.on("task:updated", (task: Task) => {
      this.recordActivity();
      this.emit("task:updated", task);
    });

    runtimeLog.log("Event forwarding setup complete");
  }

  /**
   * Update status and emit health-changed event.
   */
  private setStatus(newStatus: RuntimeStatus): void {
    const previous = this.status;
    this.status = newStatus;

    if (previous !== newStatus) {
      this.emit("health-changed", { status: newStatus, previous });
    }
  }

  /**
   * Record activity timestamp.
   */
  private recordActivity(): void {
    this.lastActivityAt = new Date().toISOString();
  }

  /**
   * Get global concurrency limit from CentralCore.
   */
  private async getGlobalConcurrencyLimit(): Promise<number> {
    try {
      const state = await this.centralCore.getGlobalConcurrencyState();
      return state.globalMaxConcurrent;
    } catch {
      // Fallback to default if CentralCore is unavailable
      return 4;
    }
  }

  /**
   * Record task completion in CentralCore.
   */
  private async recordTaskCompletion(_taskId: string, success: boolean): Promise<void> {
    try {
      // Estimate duration (simplified - in reality, we'd track start time)
      const durationMs = 0; // Placeholder
      await this.centralCore.recordTaskCompletion(this.config.projectId, durationMs, success);
    } catch (error) {
      // Non-fatal: logging is best-effort
      runtimeLog.warn(`Failed to record task completion: ${error}`);
    }
  }
}
