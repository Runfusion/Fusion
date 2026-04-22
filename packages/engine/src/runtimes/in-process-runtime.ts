import { EventEmitter } from "node:events";
import type {
  TaskStore,
  Task,
  CentralCore,
  AgentStore,
  HeartbeatInvocationSource,
  AgentHeartbeatRun,
  PluginStore,
  PluginLoader,
  MessageStore,
  RoutineStore,
} from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import { TaskExecutor, type TaskExecutorOptions } from "../executor.js";
import { WorktreePool } from "../worktree-pool.js";
import { AgentSemaphore } from "../concurrency.js";
import { HeartbeatMonitor, HeartbeatTriggerScheduler, type WakeContext } from "../agent-heartbeat.js";
import { RoutineRunner, type RoutineRunnerOptions } from "../routine-runner.js";
import { RoutineScheduler } from "../routine-scheduler.js";
import { createAiPromptExecutor } from "../cron-runner.js";
import type {
  ProjectRuntime,
  ProjectRuntimeConfig,
  RuntimeStatus,
  RuntimeMetrics,
  ProjectRuntimeEvents,
} from "../project-runtime.js";
import { runtimeLog } from "../logger.js";
import { StuckTaskDetector } from "../stuck-task-detector.js";
import type { UsageLimitPauser } from "../usage-limit-detector.js";
import { SelfHealingManager } from "../self-healing.js";
import { PluginRunner } from "../plugin-runner.js";
import { MissionAutopilot } from "../mission-autopilot.js";
import { MissionExecutionLoop } from "../mission-execution-loop.js";
import { TriageProcessor } from "../triage.js";

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
  private triggerScheduler?: HeartbeatTriggerScheduler;
  /** Maps task IDs to agent IDs for lifecycle tracking */
  private taskAgentMap = new Map<string, string>();
  private lastActivityAt: string = new Date().toISOString();
  private pluginRunner?: PluginRunner;
  private pluginStore?: PluginStore;
  private pluginLoader?: PluginLoader;
  private routineRunner?: RoutineRunner;
  private routineStore?: RoutineStore;
  private routineScheduler?: RoutineScheduler;
  private missionExecutionLoop?: MissionExecutionLoop;
  private missionAutopilot?: MissionAutopilot;
  private triageProcessor?: TriageProcessor;
  private messageStore?: MessageStore;
  private concurrencyChangedListener?: (state: { globalMaxConcurrent: number }) => void;
  private agentCreatedListener?: (agent: import("@fusion/core").Agent) => void;
  private agentUpdatedListener?: (agent: import("@fusion/core").Agent, previousState?: import("@fusion/core").AgentState) => void;

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
      // 1. Initialize TaskStore (use external if provided, otherwise create new)
      const {
        TaskStore,
        PluginStore: PluginStoreClass,
        PluginLoader: PluginLoaderClass,
        MessageStore: MessageStoreClass,
      } = await import("@fusion/core");
      if (this.config.externalTaskStore) {
        this.taskStore = this.config.externalTaskStore;
        runtimeLog.log(`TaskStore provided externally for project ${this.config.projectId}`);
      } else {
        this.taskStore = new TaskStore(this.config.workingDirectory);
        await this.taskStore.init();
        runtimeLog.log(`TaskStore initialized for project ${this.config.projectId}`);
      }

      // Initialize MessageStore early so TaskExecutor receives send_message capability.
      this.messageStore = new MessageStoreClass(this.taskStore.getDatabase());

      // 2. Initialize Plugin system (PluginStore + PluginLoader + PluginRunner)
      this.pluginStore = new PluginStoreClass(this.taskStore.getFusionDir());
      await this.pluginStore.init();

      this.pluginLoader = new PluginLoaderClass({
        pluginStore: this.pluginStore,
        taskStore: this.taskStore,
      });

      this.pluginRunner = new PluginRunner({
        pluginLoader: this.pluginLoader,
        pluginStore: this.pluginStore,
        taskStore: this.taskStore,
        rootDir: this.config.workingDirectory,
      });
      await this.pluginRunner.init();
      runtimeLog.log(`PluginRunner initialized`);

      // 3. Initialize WorktreePool

      // Reap half-initialized orphan worktree directories before doing anything
      // else with the pool.  These are directories under .worktrees/ that exist
      // on disk but were never fully registered with git (e.g. the process was
      // killed between `mkdir` and `git worktree add`).  Removing them here
      // ensures scanIdleWorktrees / rehydrate never sees broken entries, and
      // prevents assertValidWorktreeSession from permanently blocking retries.
      const { reapOrphanWorktrees, scanIdleWorktrees } = await import("../worktree-pool.js");
      try {
        const reaped = await reapOrphanWorktrees(this.config.workingDirectory);
        if (reaped > 0) {
          runtimeLog.log(`Reaped ${reaped} half-initialized orphan worktree(s) on startup`);
        }
      } catch (err: unknown) {
        // Non-fatal — log and continue; a missed orphan is better than a failed start.
        const msg = err instanceof Error ? err.message : String(err);
        runtimeLog.warn(`reapOrphanWorktrees failed (continuing): ${msg}`);
      }

      this.worktreePool = new WorktreePool();

      // Rehydrate pool from disk state (idle worktrees)
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

      // 4. Initialize global semaphore — use shared one from ProjectManager if provided,
      // otherwise create a local one from CentralCore (single-project mode).
      if (this.config.globalSemaphore) {
        this.globalSemaphore = this.config.globalSemaphore;
      } else {
        // Dynamic getter that re-reads from CentralCore on each semaphore acquire.
        // This ensures changes via PUT /api/global-concurrency take effect immediately.
        let cachedLimit = await this.getGlobalConcurrencyLimit();
        this.globalSemaphore = new AgentSemaphore(() => cachedLimit);

        // Listen for concurrency changes from CentralCore (if it supports events)
        if (typeof this.centralCore.on === "function") {
          this.concurrencyChangedListener = (state: { globalMaxConcurrent: number }) => {
            cachedLimit = state.globalMaxConcurrent;
            runtimeLog.log(`Global concurrency limit updated to ${cachedLimit}`);
          };
          this.centralCore.on("concurrency:changed", this.concurrencyChangedListener);
        }
      }

      // 5. Initialize Scheduler
      const missionStore = this.taskStore.getMissionStore();
      this.missionAutopilot = missionStore
        ? new MissionAutopilot(this.taskStore, missionStore)
        : undefined;
      const missionAutopilot = this.missionAutopilot;

      // Initialize MissionExecutionLoop for validation cycle handling
      const missionExecutionLoop = missionStore
        ? new MissionExecutionLoop({
            taskStore: this.taskStore,
            missionStore,
            missionAutopilot: missionAutopilot
              ? {
                  notifyValidationComplete: async (featureId: string) => {
                    // Pass the feature's linked taskId to handleTaskCompletion, not the featureId
                    const feature = missionStore.getFeature(featureId);
                    if (feature?.taskId) {
                      await missionAutopilot.handleTaskCompletion(feature.taskId);
                    }
                  },
                }
              : undefined,
            rootDir: this.config.workingDirectory,
          })
        : undefined;

      this.scheduler = new Scheduler(this.taskStore, {
        maxConcurrent: this.config.maxConcurrent,
        maxWorktrees: this.config.maxWorktrees,
        semaphore: this.globalSemaphore,
        missionStore,
        missionAutopilot,
        missionExecutionLoop,
        onTaskFailed: (taskId) => {
          if (missionAutopilot) {
            void missionAutopilot.handleTaskFailure(taskId);
          }
        },
        onSchedule: (task) => {
          this.recordActivity();
          runtimeLog.log(`Scheduled task ${task.id}`);
        },
        onBlocked: (task, blockedBy) => {
          runtimeLog.log(`Task ${task.id} blocked by: ${blockedBy.join(", ")}`);
        },
      });

      // 5b. Initialize TaskExecutor
      this.stuckTaskDetector = new StuckTaskDetector(this.taskStore, {
        beforeRequeue: (taskId) => this.selfHealingManager?.checkStuckBudget(taskId) ?? Promise.resolve(true),
        onLoopDetected: (event) => this.executor?.handleLoopDetected(event) ?? Promise.resolve(false),
        onStuck: (event) => {
          this.triageProcessor?.markStuckAborted(event.taskId);
          this.executor?.markStuckAborted(event.taskId, event.shouldRequeue);
          runtimeLog.warn(
            `Task ${event.taskId} stuck (${event.reason}) — ` +
            `${event.shouldRequeue ? "will retry" : "budget exhausted"}`,
          );
        },
      });

      // 5a. Initialize AgentStore (required for reflection service and heartbeat monitoring)
      let agentStoreForReflection: import("@fusion/core").AgentStore | undefined;
      try {
        const { AgentStore: AgentStoreClass } = await import("@fusion/core");
        agentStoreForReflection = new AgentStoreClass({ rootDir: this.taskStore.getFusionDir() });
        await agentStoreForReflection.init();
        runtimeLog.log("AgentStore initialized for reflection service");
      } catch (agentErr) {
        runtimeLog.warn(`AgentStore initialization failed (reflection service will be unavailable):`, agentErr instanceof Error ? agentErr.message : agentErr);
      }
      this.agentStore = agentStoreForReflection;

      // 5b. Initialize ReflectionStore for agent reflections
      let reflectionStoreForService: import("@fusion/core").ReflectionStore | undefined;
      try {
        const { ReflectionStore: ReflectionStoreClass } = await import("@fusion/core");
        reflectionStoreForService = new ReflectionStoreClass({ rootDir: this.taskStore.getFusionDir() });
        await reflectionStoreForService.init();
        runtimeLog.log("ReflectionStore initialized for reflection service");
      } catch (reflErr) {
        runtimeLog.warn(`ReflectionStore initialization failed (reflection service will be unavailable):`, reflErr instanceof Error ? reflErr.message : reflErr);
      }

      // 5c. Initialize AgentReflectionService (requires agentStore and reflectionStore)
      let reflectionService: import("../agent-reflection.js").AgentReflectionService | undefined;
      if (agentStoreForReflection && reflectionStoreForService) {
        try {
          const { AgentReflectionService: AgentReflectionServiceClass } = await import("../agent-reflection.js");
          reflectionService = new AgentReflectionServiceClass({
            agentStore: agentStoreForReflection,
            taskStore: this.taskStore,
            reflectionStore: reflectionStoreForService,
            rootDir: this.config.workingDirectory,
          });
          runtimeLog.log("AgentReflectionService initialized");
        } catch (reflServiceErr) {
          runtimeLog.warn(`AgentReflectionService initialization failed:`, reflServiceErr instanceof Error ? reflServiceErr.message : reflServiceErr);
        }
      }

      const executorOptions: TaskExecutorOptions = {
        semaphore: this.globalSemaphore,
        pool: this.worktreePool,
        usageLimitPauser: this.usageLimitPauser,
        stuckTaskDetector: this.stuckTaskDetector,
        pluginRunner: this.pluginRunner,
        messageStore: this.messageStore,
        missionStore,
        reflectionService,
        onSliceComplete: (slice) => {
          void this.scheduler.onSliceComplete(slice);
        },
        onStart: (task, worktreePath) => {
          this.recordActivity();
          runtimeLog.log(`Started executing task ${task.id} in ${worktreePath}`);
          // Create a runtime-managed task worker agent for lifecycle tracking.
          // These workers are not heartbeat-managed dashboard agents, so mark them
          // explicitly and disable heartbeat triggers/timers.
          if (this.agentStore) {
            this.agentStore.createAgent({
              name: `executor-${task.id}`,
              role: "executor",
              metadata: {
                agentKind: "task-worker",
                taskWorker: true,
                managedBy: "task-executor",
              },
              runtimeConfig: {
                enabled: false,
              },
            }).then(async (agent: { id: string }) => {
              this.taskAgentMap.set(task.id, agent.id);
              await this.agentStore!.assignTask(agent.id, task.id);
              await this.agentStore!.updateAgentState(agent.id, "active");
              await this.agentStore!.updateAgentState(agent.id, "running");
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
            void this.agentStore.updateAgentState(agentId, "terminated").catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              runtimeLog.warn(`Failed to update agent ${agentId} state to terminated (completion): ${msg}`);
            });
            this.taskAgentMap.delete(task.id);
            // Auto-delete the task-worker agent after a short delay so the UI
            // can observe the terminal state before the agent is removed.
            void setTimeout(() => {
              this.agentStore?.deleteAgent(agentId).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                runtimeLog.warn(`Failed to delete agent ${agentId} after completion: ${msg}`);
              });
            }, 5000);
          }
        },
        onError: (task, error) => {
          this.recordActivity();
          runtimeLog.error(`Task ${task.id} failed:`, error.message);
          this.recordTaskCompletion(task.id, false);

          // Mission-linked failures should be re-queued to todo so autopilot retry
          // policies can decide whether to retry or block the feature.
          if (task.sliceId) {
            void (async () => {
              try {
                const latest = await this.taskStore.getTask(task.id);
                if (latest?.column === "in-progress") {
                  await this.taskStore.moveTask(task.id, "todo");
                }
              } catch (moveErr) {
                runtimeLog.warn(`Failed to requeue mission task ${task.id} after error:`, moveErr);
              }
            })();
          }

          // Update agent state to terminated (failed)
          const agentId = this.taskAgentMap.get(task.id);
          if (agentId && this.agentStore) {
            void this.agentStore.updateAgentState(agentId, "terminated").catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              runtimeLog.warn(`Failed to update agent ${agentId} state to terminated (error): ${msg}`);
            });
            this.taskAgentMap.delete(task.id);
            // Auto-delete the task-worker agent after a short delay so the UI
            // can observe the terminal state before the agent is removed.
            void setTimeout(() => {
              this.agentStore?.deleteAgent(agentId).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                runtimeLog.warn(`Failed to delete agent ${agentId} after error: ${msg}`);
              });
            }, 5000);
          }
        },
      };

      this.executor = new TaskExecutor(
        this.taskStore,
        this.config.workingDirectory,
        executorOptions
      );

      // 6. Initialize HeartbeatMonitor (reuses AgentStore from step 5a)
      if (this.heartbeatMonitor) {
        // Already started — nothing to do
      }
      if (!this.heartbeatMonitor && this.agentStore) {
        this.heartbeatMonitor = new HeartbeatMonitor({
          store: this.agentStore,
          agentStore: this.agentStore, // enables per-agent config resolution
          taskStore: this.taskStore,
          rootDir: this.config.workingDirectory,
          messageStore: this.messageStore,
          onMissed: (agentId) => {
            runtimeLog.warn(`Agent ${agentId} missed heartbeat`);
          },
          onTerminated: (agentId) => {
            runtimeLog.warn(`Agent ${agentId} terminated (unresponsive)`);
          },
        });
        this.heartbeatMonitor.start();
      }

      // 6a. Initialize HeartbeatTriggerScheduler (only if agentStore is available)
      if (this.agentStore) {
        this.triggerScheduler = new HeartbeatTriggerScheduler(
          this.agentStore,
          async (agentId, source, context: WakeContext) => {
            if (!this.heartbeatMonitor) return;

            await this.heartbeatMonitor.executeHeartbeat({
              agentId,
              source,
              triggerDetail: context.triggerDetail,
              taskId: typeof context.taskId === "string" ? context.taskId : undefined,
              triggeringCommentIds: Array.isArray(context.triggeringCommentIds)
                ? context.triggeringCommentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
                : undefined,
              triggeringCommentType:
                context.triggeringCommentType === "steering"
                || context.triggeringCommentType === "task"
                || context.triggeringCommentType === "pr"
                  ? context.triggeringCommentType
                  : undefined,
              contextSnapshot: { ...context },
            });
          },
          this.taskStore,
        );
        this.triggerScheduler.start();

        // Set up dynamic registration for agents created or updated after startup
        this.agentCreatedListener = (agent) => {
          if (!this.triggerScheduler) return;
          const rc = agent.runtimeConfig;
          if (rc?.enabled === false) return;
          this.triggerScheduler.registerAgent(agent.id, {
            heartbeatIntervalMs: rc?.heartbeatIntervalMs as number | undefined,
            enabled: rc?.enabled as boolean | undefined,
            maxConcurrentRuns: rc?.maxConcurrentRuns as number | undefined,
          });
          runtimeLog.log(`Registered new agent ${agent.id} for heartbeat triggers`);
        };
        this.agentStore.on("agent:created", this.agentCreatedListener);

        this.agentUpdatedListener = (agent) => {
          if (!this.triggerScheduler) return;
          const rc = agent.runtimeConfig;
          if (rc?.enabled === false) {
            this.triggerScheduler.unregisterAgent(agent.id);
            runtimeLog.log(`Unregistered agent ${agent.id} from heartbeat triggers (disabled)`);
          } else {
            this.triggerScheduler.registerAgent(agent.id, {
              heartbeatIntervalMs: rc?.heartbeatIntervalMs as number | undefined,
              enabled: rc?.enabled as boolean | undefined,
              maxConcurrentRuns: rc?.maxConcurrentRuns as number | undefined,
            });
            runtimeLog.log(`Re-registered agent ${agent.id} for heartbeat triggers`);
          }
        };
        this.agentStore.on("agent:updated", this.agentUpdatedListener);

        // Register existing agents with heartbeat monitoring not explicitly disabled
        // Agents without explicit heartbeat config will use the default 3600-second interval (1 hour)
        try {
          const agents = await this.agentStore.listAgents();
          let registeredCount = 0;
          for (const agent of agents) {
            const rc = agent.runtimeConfig;
            if (rc?.enabled !== false) {
              this.triggerScheduler.registerAgent(agent.id, {
                heartbeatIntervalMs: rc?.heartbeatIntervalMs as number | undefined,
                enabled: rc?.enabled as boolean | undefined,
                maxConcurrentRuns: rc?.maxConcurrentRuns as number | undefined,
              });
              registeredCount++;
            }
          }
          if (agents.length > 0) {
            runtimeLog.log(`Registered ${registeredCount} of ${agents.length} agents for heartbeat triggers`);
          }
        } catch (regErr) {
          runtimeLog.warn(`Failed to register agents for heartbeat triggers:`, regErr);
        }

        runtimeLog.log(`HeartbeatMonitor and TriggerScheduler initialized`);
      }

      // 7. Initialize TriageProcessor (task specification)
      // Created after AgentStore so per-agent custom instructions are available.
      this.triageProcessor = new TriageProcessor(
        this.taskStore,
        this.config.workingDirectory,
        {
          semaphore: this.globalSemaphore,
          stuckTaskDetector: this.stuckTaskDetector,
          agentStore: this.agentStore,
          onSpecifyStart: (t) => {
            this.recordActivity();
            runtimeLog.log(`Specifying ${t.id}...`);
          },
          onSpecifyComplete: (t) => {
            this.recordActivity();
            runtimeLog.log(`Specified ${t.id} → todo`);
          },
          onSpecifyError: (t, e) => {
            runtimeLog.error(`Triage failed for ${t.id}: ${e.message}`);
          },
        },
      );

      // Initialize RoutineScheduler (requires RoutineStore from FN-1519)
      try {
        const { RoutineStore: RoutineStoreClass } = await import("@fusion/core");
        // Verify RoutineStore actually has the expected methods (FN-1519 complete)
        if (typeof RoutineStoreClass.prototype.getDueRoutines === "function") {
          const routineStore = new RoutineStoreClass(this.taskStore.getFusionDir());
          await routineStore.init();
          this.routineStore = routineStore;

          if (this.heartbeatMonitor) {
            const aiPromptExecutor = await createAiPromptExecutor(this.config.workingDirectory);
            const routineRunnerOptions: RoutineRunnerOptions = {
              routineStore,
              heartbeatMonitor: this.heartbeatMonitor,
              rootDir: this.config.workingDirectory,
              taskStore: this.taskStore,
              aiPromptExecutor,
            };
            this.routineRunner = new RoutineRunner(routineRunnerOptions);

            this.routineScheduler = new RoutineScheduler({
              taskStore: this.taskStore,
              routineStore,
              routineRunner: this.routineRunner,
              pollIntervalMs: 60000,
              scope: "project", // Project-scoped execution — global routines run separately
            });
            this.routineScheduler.start();
            runtimeLog.log("RoutineScheduler initialized and started");
          }
        } else {
          runtimeLog.log("RoutineStore not available (FN-1519 types not complete) — skipping RoutineScheduler");
        }
      } catch (routineErr) {
        // Non-fatal — RoutineStore may not be exported if FN-1519 is not complete
        runtimeLog.warn("RoutineScheduler initialization skipped:", routineErr instanceof Error ? routineErr.message : routineErr);
      }

      // 7. Initialize SelfHealingManager
      this.selfHealingManager = new SelfHealingManager(this.taskStore, {
        rootDir: this.config.workingDirectory,
        recoverCompletedTask: (task) => this.executor.recoverCompletedTask(task),
        recoverFailedPreMergeStep: (task) => this.executor.recoverFailedPreMergeWorkflowStep(task),
        getExecutingTaskIds: () => this.executor.getExecutingTaskIds(),
        recoverApprovedTriageTask: (task) => this.triageProcessor?.recoverApprovedTask(task) ?? Promise.resolve(false),
        getSpecifyingTaskIds: () => this.triageProcessor?.getProcessingTaskIds() ?? new Set<string>(),
        evictStaleTriageProcessing: () => this.triageProcessor?.evictStaleProcessing() ?? new Set<string>(),
      });
      this.selfHealingManager.start();
      this.stuckTaskDetector.start();

      // 8. Set up event forwarding from TaskStore
      this.setupEventForwarding();

      // 9. Requeue no-progress no-task_done failures before resumeOrphaned
      // can restart them.
      await this.selfHealingManager.recoverNoProgressNoTaskDoneFailures();

      // 10. Resume orphaned in-progress tasks
      await this.executor.resumeOrphaned();

      // Some "stuck" tasks are already orphaned by the time the runtime boots:
      // they no longer have a tracked session/worktree, so the stuck detector
      // cannot recover them. Delegate the startup recovery pass to
      // SelfHealingManager so the policy lives in one place.
      void this.selfHealingManager.runStartupRecovery().catch((err) => {
        runtimeLog.error("Self-healing startup recovery failed:", err);
      });

      // 11. Start scheduler and triage processor
      this.scheduler.start();
      this.triageProcessor?.start();

      // 12. Start MissionExecutionLoop for validation cycle handling
      this.missionExecutionLoop = missionExecutionLoop;
      if (missionExecutionLoop) {
        missionExecutionLoop.start();
        // Recover active missions to re-enqueue pending validations
        void missionExecutionLoop.recoverActiveMissions().catch((err) => {
          runtimeLog.error("Failed to recover active missions:", err);
        });
      }

      // Mission crash recovery: restore autopilot state for missions that were active before crash
      const activeMissionStore = this.taskStore.getMissionStore();
      const activeMissionAutopilot = this.scheduler.getMissionAutopilot?.();
      if (activeMissionStore && activeMissionAutopilot) {
        void activeMissionAutopilot.recoverMissions(activeMissionStore);
      }

      // 13. Reconcile feature status for all active missions (not just autopilot)
      if (activeMissionStore) {
        void this.scheduler.reconcileAllMissionFeatures();
      }

      // 14. Start MissionAutopilot background polling
      this.missionAutopilot?.start();

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
   * 2. Stop self-healing manager
   * 3. Stop routine scheduler
   * 4. Stop trigger scheduler
   * 5. Stop stuck task detector
   * 6. Stop heartbeat monitor
   * 7. Stop scheduler
   * 8. Stop mission execution loop
   * 9. Wait for executor to finish active tasks (with timeout)
   * 10. Shutdown plugin runner
   * 11. Drain and cleanup worktree pool
   * 12. Set status to "stopped"
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
      // 1. Remove concurrency change listener (if we registered one)
      if (this.concurrencyChangedListener && typeof this.centralCore.off === "function") {
        this.centralCore.off("concurrency:changed", this.concurrencyChangedListener);
        this.concurrencyChangedListener = undefined;
      }

      // 2. Stop self-healing manager
      if (this.selfHealingManager) {
        this.selfHealingManager.stop();
        runtimeLog.log("SelfHealingManager stopped");
      }

      // 2. Stop routine scheduler (stops new routine triggers; in-flight executions continue)
      if (this.routineScheduler) {
        this.routineScheduler.stop();
        runtimeLog.log("RoutineScheduler stopped");
      }

      // 3. Remove agent event listeners (before stopping trigger scheduler)
      // Guard on this.agentStore being defined - it may not exist if AgentStore init failed
      if (this.agentCreatedListener && this.agentStore) {
        this.agentStore.off("agent:created", this.agentCreatedListener);
        this.agentCreatedListener = undefined;
        runtimeLog.log("AgentStore agent:created listener removed");
      }
      if (this.agentUpdatedListener && this.agentStore) {
        this.agentStore.off("agent:updated", this.agentUpdatedListener);
        this.agentUpdatedListener = undefined;
        runtimeLog.log("AgentStore agent:updated listener removed");
      }

      // 4. Stop trigger scheduler
      if (this.triggerScheduler) {
        this.triggerScheduler.stop();
        runtimeLog.log("TriggerScheduler stopped");
      }

      // 4. Stop stuck task detector
      if (this.stuckTaskDetector) {
        this.stuckTaskDetector.stop();
        runtimeLog.log("StuckTaskDetector stopped");
      }

      // 5. Stop heartbeat monitor
      if (this.heartbeatMonitor) {
        this.heartbeatMonitor.stop();
        runtimeLog.log("HeartbeatMonitor stopped");
      }

      // 6. Stop triage processor (prevents new specifications)
      if (this.triageProcessor) {
        this.triageProcessor.stop();
        runtimeLog.log("TriageProcessor stopped");
      }

      // 7. Stop scheduler (prevents new task scheduling)
      if (this.scheduler) {
        this.scheduler.stop();
        runtimeLog.log("Scheduler stopped");
      }

      // 7. Stop mission autopilot background polling
      if (this.missionAutopilot) {
        this.missionAutopilot.stop();
        runtimeLog.log("MissionAutopilot stopped");
      }

      // 7. Stop mission execution loop
      if (this.missionExecutionLoop) {
        this.missionExecutionLoop.stop();
        runtimeLog.log("MissionExecutionLoop stopped");
      }

      // 8. Wait for active tasks to complete (30 second timeout)
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

      // 8. Shutdown plugin runner
      if (this.pluginRunner) {
        await this.pluginRunner.shutdown();
        runtimeLog.log("PluginRunner shutdown complete");
      }

      // 9. Drain and cleanup worktree pool
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
   * Get the AgentStore instance (if initialized).
   * Returns undefined before start() or if init fails.
   */
  getAgentStore(): import("@fusion/core").AgentStore | undefined {
    return this.agentStore;
  }

  /**
   * Get the MessageStore instance (if initialized).
   * Returns undefined before start() or if initialization fails.
   */
  getMessageStore(): import("@fusion/core").MessageStore | undefined {
    return this.messageStore;
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
   * Get the HeartbeatMonitor instance (if initialized).
   * Returns undefined when agent monitoring is not available.
   */
  getHeartbeatMonitor(): HeartbeatMonitor | undefined {
    return this.heartbeatMonitor;
  }

  /**
   * Get the HeartbeatTriggerScheduler instance (if initialized).
   * Returns undefined when agent monitoring is not available.
   */
  getTriggerScheduler(): HeartbeatTriggerScheduler | undefined {
    return this.triggerScheduler;
  }

  /**
   * Get the RoutineRunner instance (if initialized).
   * Returns undefined when RoutineStore is not available.
   */
  getRoutineRunner(): RoutineRunner | undefined {
    return this.routineRunner;
  }

  /**
   * Get the RoutineStore instance (if initialized).
   * Returns undefined when RoutineStore is not available.
   */
  getRoutineStore(): RoutineStore | undefined {
    return this.routineStore;
  }

  /**
   * Get the RoutineScheduler instance (if initialized).
   * Returns undefined when RoutineStore is not available.
   */
  getRoutineScheduler(): RoutineScheduler | undefined {
    return this.routineScheduler;
  }

  /**
   * Get the TriageProcessor instance (if initialized).
   * Returns undefined before start() completes.
   */
  getTriageProcessor(): TriageProcessor | undefined {
    return this.triageProcessor;
  }

  /**
   * Get the MissionAutopilot instance (if initialized).
   * Returns undefined when no MissionStore is available.
   */
  getMissionAutopilot(): MissionAutopilot | undefined {
    return this.missionAutopilot;
  }

  /**
   * Get the MissionExecutionLoop instance (if initialized).
   * Returns undefined when no MissionStore is available.
   */
  getMissionExecutionLoop(): MissionExecutionLoop | undefined {
    return this.missionExecutionLoop;
  }

  /**
   * Execute a heartbeat run for an agent.
   *
   * Delegates to HeartbeatMonitor.executeHeartbeat().
   * Throws if the runtime is not active or the heartbeat monitor is not initialized.
   *
   * @param agentId - The agent ID to execute a heartbeat for
   * @param source - What triggered this heartbeat
   * @param options - Optional task ID override and trigger detail
   * @returns The completed heartbeat run
   */
  async executeHeartbeat(
    agentId: string,
    source: HeartbeatInvocationSource,
    options?: { taskId?: string; triggerDetail?: string; contextSnapshot?: Record<string, unknown> }
  ): Promise<AgentHeartbeatRun | null> {
    if (this.status !== "active") {
      throw new Error(`Cannot execute heartbeat: runtime status is ${this.status}`);
    }
    if (!this.heartbeatMonitor) {
      return null;
    }

    runtimeLog.log(`Executing heartbeat for agent ${agentId} (source=${source})`);
    const result = await this.heartbeatMonitor.executeHeartbeat({
      agentId,
      source,
      ...options,
    });
    runtimeLog.log(`Heartbeat completed for agent ${agentId}`);
    return result;
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(`Failed to fetch global concurrency from CentralCore, falling back to default (4): ${msg}`);
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
