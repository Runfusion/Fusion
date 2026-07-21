import { createHash } from "node:crypto";
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
  GithubIssueAction,
  CliSession,
  NotificationPayload,
  WorkflowWorkItem,
} from "@fusion/core";
import {
  AsyncCentralClaimStore,
  ChatStore,
  computeWorkflowIrPin,
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  isEphemeralAgent,
  resolveWorkflowIrForTask,
} from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import type { PrMonitor, PrComment } from "../pr-monitor.js";
import type { PrInfo } from "@fusion/core";
import { TaskExecutor, type TaskExecutorOptions } from "../executor.js";
import { buildPrNodeDeps } from "../pr-nodes.js";
import { isExperimentalFeatureEnabled } from "@fusion/core";
import { createCliAgentRuntime, type BootstrappedCliAgentRuntime } from "../cli-agent/runtime.js";
import { WorktreePool, detectGitRepository, type GitRepoDetection, type PoolInvariantViolation } from "../worktree-pool.js";
import { AgentSemaphore, ScopedAgentSemaphore } from "../concurrency.js";
import { HeartbeatMonitor, HeartbeatTriggerScheduler, type WakeContext } from "../agent-heartbeat.js";
import { AutoClaimSnapshotManager } from "../auto-claim-snapshot.js";
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
import { getActiveNotificationService } from "../notifier.js";
import { StuckTaskDetector } from "../stuck-task-detector.js";
import type { UsageLimitPauser } from "../usage-limit-detector.js";
import { SelfHealingManager, VALIDATOR_RUN_STALE_MAX_AGE_MS } from "../self-healing.js";
import { RestartRecoveryCoordinator } from "../restart-recovery-coordinator.js";
import { MeshLeaseManager } from "../mesh-lease-manager.js";
import { PluginRunner } from "../plugin-runner.js";
import { MissionAutopilot } from "../mission-autopilot.js";
import { MissionExecutionLoop } from "../mission-execution-loop.js";
import { TriageProcessor } from "../triage.js";
import { EphemeralWorkerManager } from "../ephemeral-worker-manager.js";
import { validateProjectNodeMapping } from "../node-dispatch-validation.js";
import { attachAgentLinkSync } from "../task-agent-sync.js";
import { createRunAuditor, generateSyntheticRunId } from "../run-audit.js";
import { setImmediate as setImmediateCb } from "node:timers";
import { resolvePreReleasePlanReviewNode } from "../hold-release.js";

const yieldEventLoop = (): Promise<void> => new Promise((resolve) => setImmediateCb(resolve));

export const CLI_AGENT_AWAITING_INPUT_EVENT = "cli-agent-awaiting-input" as const;
const TASK_PLANNER_CHAT_AGENT_ID_PREFIX = "task-planner:";

export interface PlanningContinuationCandidate {
  item: WorkflowWorkItem;
  task: Task | null | undefined;
}

/** FNXC:WorkflowScheduling 2026-07-21-12:30:
 * Select due planning continuations whose task remains dispatchable. */
export function selectActionablePlanningContinuations(
  candidates: readonly PlanningContinuationCandidate[],
): Array<{ item: WorkflowWorkItem; task: Task }> {
  return candidates.filter(
    (candidate): candidate is { item: WorkflowWorkItem; task: Task } =>
      candidate.item.waitReason === "planning"
      && candidate.task !== null
      && candidate.task !== undefined
      && candidate.task.paused !== true
      && candidate.task.userPaused !== true,
  );
}

export interface CliAgentAwaitingInputNotificationInfo {
  sessionId: string;
  notification: Record<string, unknown> | undefined;
}

function stableNotificationJson(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableNotificationJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableNotificationJson(record[key])}`);
  return `{${fields.join(",")}}`;
}

function buildCliAgentNotificationDedupeKey(input: {
  projectId: string;
  info: CliAgentAwaitingInputNotificationInfo;
  session: CliSession | undefined;
}): string {
  const notificationFingerprint = createHash("sha256")
    .update(stableNotificationJson(input.info.notification ?? null))
    .digest("hex")
    .slice(0, 16);
  const waitingEpoch = input.session?.updatedAt ?? "unknown-waiting-epoch";
  return [
    "cli-agent",
    input.projectId,
    input.info.sessionId,
    CLI_AGENT_AWAITING_INPUT_EVENT,
    waitingEpoch,
    notificationFingerprint,
  ].join(":");
}

export function buildCliAgentAwaitingInputNotificationPayload(input: {
  projectId: string;
  info: CliAgentAwaitingInputNotificationInfo;
  session: CliSession | undefined;
  task: Task | undefined;
}): NotificationPayload {
  const taskId = input.session?.taskId ?? undefined;
  const adapterId = input.session?.adapterId;
  const notificationKind = typeof input.info.notification?.kind === "string"
    ? input.info.notification.kind
    : "waiting_on_input";

  return {
    ...(taskId ? { taskId } : {}),
    taskTitle: input.task?.title,
    taskDescription: input.task?.description,
    event: CLI_AGENT_AWAITING_INPUT_EVENT,
    metadata: {
      sessionId: input.info.sessionId,
      projectId: input.projectId,
      ...(adapterId ? { adapterId } : {}),
      notificationKind,
      notification: input.info.notification ?? null,
      // FNXC:ToolPermissionNotifications 2026-06-27-00:00: CLI adapters can emit duplicate waiting-on-input records for one blocked prompt. The external notification path carries a waiting-epoch plus prompt-fingerprint key so repeated telemetry for the same blocked prompt does not spam providers, while later tool requests in the same session still notify operators.
      notificationDedupeKey: buildCliAgentNotificationDedupeKey(input),
    },
  };
}

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
 * Lifecycle boundary:
 * - Mesh networking services (PeerExchangeService + mDNS discovery) are process-level
 *   concerns owned by CLI startup paths (`runServe`/`runDashboard`) because discovery
 *   requires the final bound HTTP port. InProcessRuntime remains project-scoped and
 *   intentionally does not start process-level mesh services.
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
function formatRuntimeGitDetectionWarning(workingDirectory: string, detection: Extract<GitRepoDetection, { status: "error" }>): string {
  const stderr = detection.stderr.trim() || "git rev-parse --git-dir failed without stderr";
  const remedy = detection.reason === "dubious-ownership"
    ? ` Resolve Git safe-directory ownership with: git config --global --add safe.directory "${workingDirectory}"`
    : "";
  return `Project directory "${workingDirectory}" could not be verified as a Git repository. ` +
    `Task execution will fail until the Git error is resolved. Git reported: ${stderr}.${remedy}`;
}

export class InProcessRuntime
  extends EventEmitter<ProjectRuntimeEvents>
  implements ProjectRuntime
{
  private status: RuntimeStatus = "stopped";
  private taskStore!: TaskStore;
  /**
   * FNXC:RuntimeStartupWiring 2026-06-24-09:55:
   * When the engine booted a PostgreSQL-backed TaskStore via
   * createTaskStoreForBackend, this holds the result's shutdown() handle so
   * the runtime's stop() path can release the connection pool and stop the
   * embedded PostgreSQL process (if one was started). Undefined on the legacy
   * SQLite path (the TaskStore owns its own SQLite teardown).
   */
  private backendShutdown?: () => Promise<void>;
  private scheduler!: Scheduler;
  private executor!: TaskExecutor;
  private worktreePool!: WorktreePool;
  private globalSemaphore?: AgentSemaphore;
  private projectSemaphore?: ScopedAgentSemaphore;
  private stuckTaskDetector?: StuckTaskDetector;
  /**
   * Per-project CLI Agent Executor runtime bundle (PTY manager + telemetry hub +
   * adapter registry + resume coordinator). Built in `start()` when the
   * `cliAgentExecutor` experimental flag is on; threaded into the executor +
   * self-healing/stuck seams; disposed in `stop()`.
   */
  private cliAgentRuntime?: BootstrappedCliAgentRuntime;
  private usageLimitPauser?: UsageLimitPauser;
  private selfHealingManager?: SelfHealingManager;
  private leaseManager?: MeshLeaseManager;
  private leaseCentralClaimStore?: AsyncCentralClaimStore;
  private agentStore?: AgentStore;
  private heartbeatMonitor?: HeartbeatMonitor;
  private triggerScheduler?: HeartbeatTriggerScheduler;
  /**
   * Coordinates the ephemeral task-worker lifecycle (spawn dedup, finalize,
   * halt-listener cleanup, startup sweep). See `ephemeral-worker-manager.ts`.
   * Created once the AgentStore is available; guard call sites with `?`.
   */
  private workerManager?: EphemeralWorkerManager;
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
  private workflowContinuationTimer?: ReturnType<typeof setInterval>;
  private workflowContinuationDrainActive = false;
  private messageStore?: MessageStore;
  private chatStore?: ChatStore;
  private detachAgentLinkSync?: () => void;
  private concurrencyChangedListener?: (state: { globalMaxConcurrent: number }) => void;
  /**
   * Optional callback the runtime forwards to SelfHealingManager so that
   * stale-merge recovery can re-enqueue tasks immediately. Set by ProjectEngine
   * before `start()` via `setMergeEnqueuer`.
   */
  private mergeEnqueuer?: (taskId: string) => boolean;
  private mergeRequester?: (
    taskId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<import("@fusion/core").MergeResult>;
  private clearMergeActive?: (taskId: string) => void;
  private activeMergeTaskIdProvider?: () => string | null;
  private activeMergeStartedAtMsProvider?: () => number | null;
  private activeMergeAborter?: (taskId: string, reason: string) => boolean;
  /**
   * FNXC:Workspace 2026-06-22-16:40 (Phase D P1 TOCTOU): predicate that reports whether a task is
   * anywhere in ProjectEngine's in-memory merge pipeline (queued OR dequeued-and-merging). Set by
   * ProjectEngine before `start()` via `setMergePendingProvider`. Used by the workspace
   * self-healing reconcilers to avoid re-dispatching / reclaiming a task mid-dequeue→rawMerge.
   */
  private mergePendingProvider?: (taskId: string) => boolean;
  /** Tracks whether startup recovery was intentionally deferred due to pause state. */
  private startupRecoveryDeferred = false;
  /** Prevent duplicate unpause recovery dispatches from racing each other. */
  private resumeAfterUnpauseRunning = false;
  private restartRecoveryCoordinator?: RestartRecoveryCoordinator;

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
        PluginStore: PluginStoreClass,
        PluginLoader: PluginLoaderClass,
        MessageStore: MessageStoreClass,
        // FNXC:BackendFlip 2026-06-26-14:40:
        // createTaskStoreForBackend is the startup factory that boots a
        // PostgreSQL-backed TaskStore. Post default-flip: it boots embedded PG
        // by default when DATABASE_URL is unset (the zero-config production
        // path) and external PG when DATABASE_URL is set. The engine is the primary construction site for `fn serve`
        // / dashboard: every project's TaskStore flows through
        // InProcessRuntime.start(). When the factory returns a backend result,
        // the engine owns the result's shutdown() for process teardown.
        createTaskStoreForBackend,
      } = await import("@fusion/core");
      if (this.config.externalTaskStore) {
        this.taskStore = this.config.externalTaskStore;
        runtimeLog.log(`TaskStore provided externally for project ${this.config.projectId}`);
      } else {
        const backendBoot = await createTaskStoreForBackend({
          rootDir: this.config.workingDirectory,
          projectId: this.config.projectId,
          onMigrationProgress: this.config.onMigrationProgress,
        });
        // FNXC:PostgresFinalCutover 2026-07-14-17:20: Engine runtimes must fail
        // startup when PostgreSQL cannot boot; constructing a SQLite TaskStore is no longer valid.
        this.taskStore = backendBoot.taskStore;
        this.backendShutdown = backendBoot.shutdown;
        runtimeLog.log(
          `TaskStore initialized on PostgreSQL (${backendBoot.backend.mode}) for project ${this.config.projectId}`,
        );
      }

      // Initialize MessageStore early so TaskExecutor receives send_message capability.
      // FNXC:RuntimeSatelliteAsync 2026-06-24-12:45:
      // In backend mode, pass the AsyncDataLayer so MessageStore delegates to the
      // async helpers; otherwise pass the sync SQLite Database (legacy path).
      const messageLayer = this.taskStore.getAsyncLayer();
      if (!messageLayer) {
        throw new Error("PostgreSQL TaskStore did not expose its AsyncDataLayer");
      }
      // FNXC:PostgresMeshClaims 2026-07-14-17:31: Cross-node checkout and
      // recovery share the central.task_claims table through the project pool.
      this.leaseCentralClaimStore = new AsyncCentralClaimStore(messageLayer);

      // FNXC:CentralCore 2026-06-26-13:30:
      // In backend mode, attach the TaskStore's AsyncDataLayer to the shared
      // CentralCore so it migrates off its SQLite CentralDatabase and shares the
      // SAME PostgreSQL connection pool as everything else. The shared CentralCore
      // is constructed before the backend is resolved (serve.ts/daemon.ts), so we
      // attach the layer here once the TaskStore is available. If the CentralCore
      // is already in backend mode (constructed with the layer) this is a no-op
      // via the init() idempotency guard. Safe in legacy mode (messageLayer null).
      if (messageLayer && !this.centralCore.backendMode) {
        try {
          await this.centralCore.attachBackendLayer(messageLayer);
        } catch (err) {
          runtimeLog.warn(
            `Failed to attach backend layer to CentralCore: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.messageStore = new MessageStoreClass(null, { asyncLayer: messageLayer });

      await yieldEventLoop();

      // 2. Initialize Plugin system (PluginStore + PluginLoader + PluginRunner)
      // FNXC:SqliteFinalRemoval 2026-06-26-10:50:
      // In backend mode, pass the AsyncDataLayer so PluginStore delegates to the
      // async helpers; otherwise use the legacy SQLite path.
      const pluginLayer = this.taskStore.getAsyncLayer();
      if (!pluginLayer) {
        throw new Error("PostgreSQL TaskStore did not expose the plugin AsyncDataLayer");
      }
      this.pluginStore = new PluginStoreClass(this.config.workingDirectory, { asyncLayer: pluginLayer });
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

      await yieldEventLoop();

      // 3. Initialize WorktreePool

      // Reap half-initialized orphan worktree directories before doing anything
      // else with the pool.  These are directories under .worktrees/ that exist
      // on disk but were never fully registered with git (e.g. the process was
      // killed between `mkdir` and `git worktree add`).  Removing them here
      // ensures scanIdleWorktrees / rehydrate never sees broken entries, and
      // prevents assertValidWorktreeSession from permanently blocking retries.
      const { reapOrphanWorktrees, scanIdleWorktrees } = await import("../worktree-pool.js");
      const settings = await this.taskStore.getSettings();
      try {
        const reaped = await reapOrphanWorktrees(this.config.workingDirectory, settings);
        if (reaped > 0) {
          runtimeLog.log(`Reaped ${reaped} half-initialized orphan worktree(s) on startup`);
        }
      } catch (err: unknown) {
        // Non-fatal — log and continue; a missed orphan is better than a failed start.
        const msg = err instanceof Error ? err.message : String(err);
        runtimeLog.warn(`reapOrphanWorktrees failed (continuing): ${msg}`);
      }

      const gitDetection = await detectGitRepository(this.config.workingDirectory);
      if (gitDetection.status === "not-repo") {
        runtimeLog.warn(
          `Project directory "${this.config.workingDirectory}" is not a Git repository. ` +
          `Task execution will fail until a Git repository is initialized. ` +
          `Run 'git init' in the project directory to enable worktree-based task execution.`,
        );
      } else if (gitDetection.status === "error") {
        runtimeLog.warn(formatRuntimeGitDetectionWarning(this.config.workingDirectory, gitDetection));
      }

      this.worktreePool = new WorktreePool();

      // Rehydrate pool from disk state (idle worktrees)
      const idleWorktrees = await scanIdleWorktrees(
        this.config.workingDirectory,
        this.taskStore,
        settings,
      );
      if (idleWorktrees.length > 0) {
        this.worktreePool.rehydrate(idleWorktrees);
        runtimeLog.log(
          `Rehydrated worktree pool with ${idleWorktrees.length} idle worktrees`
        );
      }

      await yieldEventLoop();

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

      this.projectSemaphore = new ScopedAgentSemaphore(this.globalSemaphore);

      await yieldEventLoop();

      // 5a. Initialize AgentStore (required for scheduler assignment, reflection service, and heartbeat monitoring)
      // FNXC:SqliteFinalRemoval 2026-06-26-10:50:
      // In backend mode, pass the AsyncDataLayer so AgentStore delegates to the
      // async helpers; otherwise use the legacy SQLite path.
      let agentStoreForReflection: import("@fusion/core").AgentStore | undefined;
      try {
        const { AgentStore: AgentStoreClass } = await import("@fusion/core");
        const agentLayer = this.taskStore.getAsyncLayer();
        agentStoreForReflection = new AgentStoreClass({
          rootDir: this.taskStore.getFusionDir(),
          taskStore: this.taskStore,
          claimStore: this.leaseCentralClaimStore,
          projectId: this.config.projectId,
          ...(agentLayer ? { asyncLayer: agentLayer } : {}),
        });
        await agentStoreForReflection.init();
        runtimeLog.log("AgentStore initialized for reflection service");

        /*
         * FNXC:AgentStore 2026-07-09-08:15:
         * FN-7723 — this is the ONE long-lived engine AgentStore instance for
         * this project/runtime, so it is the only one that should opt into
         * cross-process change detection (fs.watch + poll re-emitting
         * agent:updated/agent:stateChanged). The CLI's short-lived AgentStore
         * (packages/cli/src/commands/agent.ts) and dashboard per-request
         * stores never call startWatching(). Failure here is non-fatal — the
         * 60s auditTimerRegistrations sweep remains the durable backstop.
         */
        try {
          await agentStoreForReflection.startWatching();
          runtimeLog.log("AgentStore cross-process change detection started");
        } catch (watchErr) {
          runtimeLog.warn(`AgentStore.startWatching() failed (falling back to the 60s audit sweep only):`, watchErr instanceof Error ? watchErr.message : watchErr);
        }
      } catch (agentErr) {
        runtimeLog.warn(`AgentStore initialization failed (reflection service will be unavailable):`, agentErr instanceof Error ? agentErr.message : agentErr);
      }
      this.agentStore = agentStoreForReflection;

      await yieldEventLoop();

      // 5. Initialize Scheduler
      /*
       * FNXC:PostgresMissionRuntime 2026-07-14-17:20:
       * Resolve one mission store for autopilot, scheduler, and validator-loop
       * behavior. Each consumer awaits the sync-or-async union, so backend mode
       * no longer disables mission execution or feature reconciliation.
       */
      let missionStore:
        | import("@fusion/core").MissionStore
        | import("@fusion/core").AsyncMissionStore
        | undefined;
      // FNXC:MissionStore 2026-06-28-12:45:
      // MissionAutopilot, Scheduler, and MissionExecutionLoop all await the
      // MissionStore | AsyncMissionStore contract, so one resolved instance
      // drives every mission lifecycle surface in both backends.
      let autopilotMissionStore:
        | import("@fusion/core").MissionStore
        | import("@fusion/core").AsyncMissionStore
        | undefined;
      try {
        const resolvedMissionStore = this.taskStore.getMissionStore();
        // Union store for the autopilot — works in both SQLite and PG backends.
        autopilotMissionStore = resolvedMissionStore;
        // FNXC:PostgresMissionRuntime 2026-07-14-17:20:
        // Scheduler and validator execution await the MissionStore union, so
        // PostgreSQL receives the same mission recovery/validation lifecycle.
        missionStore = resolvedMissionStore;
      } catch (msErr) {
        runtimeLog.warn(
          `MissionStore unavailable (${this.taskStore.isBackendMode() ? "backend mode" : "init error"}); mission autopilot disabled:`,
          msErr instanceof Error ? msErr.message : msErr,
        );
        missionStore = undefined;
        autopilotMissionStore = undefined;
      }
      this.missionAutopilot = autopilotMissionStore
        ? new MissionAutopilot(this.taskStore, autopilotMissionStore)
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
                    const feature = await missionStore.getFeature(featureId);
                    if (!feature?.taskId) {
                      return;
                    }
                    const slice = await missionStore.getSlice(feature.sliceId);
                    const milestone = slice ? await missionStore.getMilestone(slice.milestoneId) : undefined;
                    const missionId = milestone?.missionId;
                    if (missionId) {
                      const mission = await missionStore.getMission(missionId);
                      if (mission?.autopilotEnabled && !missionAutopilot.isWatching(missionId)) {
                        missionAutopilot.watchMission(missionId);
                      }
                    }
                    await missionAutopilot.handleTaskCompletion(feature.taskId);
                  },
                }
              : undefined,
            rootDir: this.config.workingDirectory,
            pluginRunner: this.pluginRunner,
            agentStore: this.agentStore,
          })
        : undefined;

      this.leaseManager = new MeshLeaseManager({
        taskStore: this.taskStore,
        agentStore: this.agentStore,
        getHandoffPolicy: () => this.taskStore.getSettings().then((settings) => settings.owningNodeHandoffPolicy),
        getExecutingTaskIds: () => this.executor?.getExecutingTaskIds() ?? new Set<string>(),
        centralClaimStore: this.leaseCentralClaimStore,
        projectId: this.config.projectId,
      });

      const autoClaimSnapshotManager = new AutoClaimSnapshotManager({ taskStore: this.taskStore });

      this.scheduler = new Scheduler(this.taskStore, {
        maxConcurrent: this.config.maxConcurrent,
        maxWorktrees: this.config.maxWorktrees,
        semaphore: this.projectSemaphore,
        // FNXC:GlobalConcurrencyControls 2026-07-17-00:00: Feed the triage service's
        // live pre-planning in-flight count into the scheduler's stale-semaphore
        // recovery so a triage session holding a slot before it writes
        // status:"planning" is never mistaken for a leaked slot. Read lazily —
        // triageProcessor is constructed after the scheduler but exists by the
        // time the first scheduling pass runs.
        getInFlightTopLevelCount: () => this.triageProcessor?.getProcessingTaskIds().size ?? 0,
        agentStore: this.agentStore,
        hasActiveAgentExecution: (agentId: string) => this.heartbeatMonitor?.getTrackedAgents().includes(agentId) ?? false,
        missionStore,
        missionAutopilot,
        missionExecutionLoop,
        leaseManager: this.leaseManager,
        onTaskFailed: (taskId) => {
          if (missionAutopilot) {
            void missionAutopilot.handleTaskFailure(taskId);
          }
        },
        onSchedule: (task) => {
          this.recordActivity();
          runtimeLog.log(`Scheduled task ${task.id}`);
        },
        onBlocked: () => {},
        validateNodeDispatch: async (nodeId) => {
          const mappedPath = await this.centralCore.getProjectNodePath(this.config.projectId, nodeId);
          return validateProjectNodeMapping({ nodeId, mappedPath });
        },
        snapshotManager: autoClaimSnapshotManager,

      });

      await yieldEventLoop();

      // 5a-cli. Initialize the CLI Agent Executor runtime (behind the
      // `cliAgentExecutor` experimental flag). Reuses the project's existing
      // PostgreSQL data layer; predicates feed self-healing + stuck-task seams.
      if (isExperimentalFeatureEnabled(settings, "cliAgentExecutor")) {
        /*
         * FNXC:CliAgentPostgres 2026-07-14-12:00:
         * The experimental executor is a supported PostgreSQL runtime surface;
         * enabling it must not silently disable sessions after the cutover.
         */
        try {
          const asyncLayer = this.taskStore.getAsyncLayer();
          if (!asyncLayer) {
            throw new Error("CLI Agent Executor requires the PostgreSQL data layer");
          }
          this.cliAgentRuntime = await createCliAgentRuntime({
            fusionDir: this.taskStore.getFusionDir(),
            asyncLayer,
            projectId: this.config.projectId,
            hookEndpointUrl: this.resolveCliAgentHookEndpointUrl(),
            onNotification: (info) => {
              /*
               * FNXC:ToolPermissionNotifications 2026-06-27-00:00:
               * CLI tool-permission prompts must notify operators through configured external providers, not only through in-app session state. Keep this callback wired to the active NotificationService so ntfy/webhook users see blocked terminal sessions.
               */
              void this.dispatchCliAgentAwaitingInputNotification(info);
            },
          });
          runtimeLog.log("CLI Agent Executor runtime initialized");
        } catch (cliErr) {
          runtimeLog.warn(
            `CLI Agent Executor runtime initialization failed (cli-agent nodes will report a config error):`,
            cliErr instanceof Error ? cliErr.message : cliErr,
          );
        }
      }

      // 5b. Initialize TaskExecutor
      this.stuckTaskDetector = new StuckTaskDetector(this.taskStore, {
        isCliSessionWaitingOnInput: this.cliAgentRuntime?.isCliSessionWaitingOnInput,
        beforeRequeue: (taskId, reason, event) => this.selfHealingManager?.checkStuckBudget(taskId, reason, event) ?? Promise.resolve(true),
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

      let selfImproveService: import("../agent-self-improve.js").AgentSelfImproveService | undefined;
      if (agentStoreForReflection && reflectionStoreForService) {
        try {
          const { AgentSelfImproveService: AgentSelfImproveServiceClass } = await import("../agent-self-improve.js");
          selfImproveService = new AgentSelfImproveServiceClass({
            agentStore: agentStoreForReflection,
            reflectionStore: reflectionStoreForService,
            rootDir: this.config.workingDirectory,
          });
          runtimeLog.log("AgentSelfImproveService initialized");
        } catch (selfImproveErr) {
          runtimeLog.warn(`AgentSelfImproveService initialization failed:`, selfImproveErr instanceof Error ? selfImproveErr.message : selfImproveErr);
        }
      }

      const prNodeGithubOps = this.config.prNodeGithubOps;
      const executorOptions: TaskExecutorOptions = {
        semaphore: this.projectSemaphore,
        pool: this.worktreePool,
        usageLimitPauser: this.usageLimitPauser,
        stuckTaskDetector: this.stuckTaskDetector,
        cliAgentRuntime: this.cliAgentRuntime?.bundle,
        pluginRunner: this.pluginRunner,
        messageStore: this.messageStore,
        missionStore,
        reflectionService,
        // PR-entity nodes (U3): assemble the handler deps from the CLI-injected
        // GitHub ops (createPr/mergePr/respond) + the engine-owned store. The CLI
        // layer never holds a store reference; the engine binds it here. Absent
        // ops → undefined → the pr-* node kinds fail closed.
        /*
         * FNXC:GrokCliRouting 2026-07-15-09:58:
         * Thread this.pluginRunner into buildPrNodeDeps so pr-respond agent sessions share chat/executor Grok CLI plugin-runtime injection.
         */
        prNodes: prNodeGithubOps
          ? buildPrNodeDeps(() => this.taskStore, prNodeGithubOps, this.pluginRunner)
          : undefined,
        onSliceComplete: (slice) => {
          void this.scheduler.onSliceComplete(slice);
        },
        onStart: (task, worktreePath) => {
          this.recordActivity();
          runtimeLog.log(`Started executing task ${task.id} in ${worktreePath}`);
          // Legacy invariant (implemented in EphemeralWorkerManager):
          // if (this.taskAgentMap.has(task.id)) { ... "Skipping task-worker creation for" ... }
          void this.workerManager?.onTaskStart(task);
        },
        onComplete: (task) => {
          this.recordActivity();
          runtimeLog.log(`Completed task ${task.id}`);
          this.recordTaskCompletion(task.id, true);
          void this.workerManager?.onTaskComplete(task.id);
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

          void this.workerManager?.onTaskError(task.id);
        },
      };

      this.executor = new TaskExecutor(
        this.taskStore,
        this.config.workingDirectory,
        executorOptions
      );
      if (this.mergeRequester) {
        this.executor.setMergeRequester(this.mergeRequester);
      }

      this.worktreePool.setInvariantViolationHandler((violation: PoolInvariantViolation) => {
        void (async () => {
          try {
            runtimeLog.warn(
              `[worktree-pool] invariant violation detected (${violation.phase}) path=${violation.path} holder=${violation.existingHolder} requester=${violation.requestingTaskId}`,
            );
            const audit = createRunAuditor(this.taskStore, {
              runId: generateSyntheticRunId("worktree-pool-invariant", violation.requestingTaskId),
              taskId: violation.requestingTaskId,
              agentId: "system",
              phase: "execute",
            });
            await audit.database({
              type: "worktree:pool-double-lease-detected",
              target: violation.path,
              metadata: violation,
            });
            await this.taskStore.logEntry(
              violation.requestingTaskId,
              `Worktree pool invariant violation (${violation.phase}): ${violation.path} is held by ${violation.existingHolder}`,
            );
          } catch (error) {
            runtimeLog.warn(`Failed to process worktree pool invariant violation: ${error instanceof Error ? error.message : String(error)}`);
          }
        })();
      });

      await yieldEventLoop();

      // 6. Initialize HeartbeatMonitor (reuses AgentStore from step 5a)
      if (this.heartbeatMonitor) {
        // Already started — nothing to do
      }
      if (!this.heartbeatMonitor && this.agentStore) {
        const chatLayer = this.taskStore.getAsyncLayer();
        if (!chatLayer) throw new Error("Heartbeat ChatStore requires the project PostgreSQL AsyncDataLayer");
        /* FNXC:PostgresSatelliteCutover 2026-07-14-17:30: Engine chat services share the authoritative project PostgreSQL layer and never reopen SQLite. */
        this.chatStore ??= new ChatStore(chatLayer);
        this.heartbeatMonitor = new HeartbeatMonitor({
          store: this.agentStore,
          agentStore: this.agentStore, // enables per-agent config resolution
          taskStore: this.taskStore,
          rootDir: this.config.workingDirectory,
          messageStore: this.messageStore,
          chatStore: this.chatStore,
          pluginRunner: this.pluginRunner,
          reflectionStore: reflectionStoreForService,
          reflectionService,
          selfImproveService,
          snapshotManager: autoClaimSnapshotManager,
          onMissed: (agentId, reason) => {
            runtimeLog.warn(`Agent ${agentId} missed heartbeat: ${reason}`);
          },
          onTerminated: (agentId, reason) => {
            runtimeLog.warn(`Agent ${agentId} terminated (unresponsive): ${reason}`);
          },
          onRunCompleted: (agentId) => {
            if (this.executor) {
              void this.executor.resumeTaskForAgent(agentId).catch((err) => {
                runtimeLog.warn(`resumeTaskForAgent failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
            void this.triggerScheduler?.drainPendingAssignment(agentId).catch((err) => {
              runtimeLog.warn(`drainPendingAssignment failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
            });
          },
          /*
           * FNXC:WorktreeAcquisition 2026-07-09-00:00:
           * A heartbeat-driven task worktree acquisition that exhausts its bounded
           * retry cap (agent-heartbeat.ts MAX_HEARTBEAT_WORKTREE_ACQUISITION_RETRIES)
           * is a real task failure that must be counted the same way `Executor`'s
           * `onError` counts a failure, so `performanceSummary.totalTasksFailed` /
           * project health stats are not silently starved (FN-7721).
           */
          onTaskAcquisitionExhausted: (taskId, detail) => {
            runtimeLog.error(`Heartbeat worktree acquisition exhausted retry cap for ${taskId}:`, detail);
            this.recordTaskCompletion(taskId, false);
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
          {
            isTaskExecuting: (taskId) => this.executor.getExecutingTaskIds().has(taskId),
            // Column-agent principal alignment (plan U5, R6): reverse-direction guard
            // — an override/defer column agent must not heartbeat concurrently with a
            // column-bound session it runs but is not assigned to.
            isAgentEffectivelyExecuting: (agentId) => this.executor.isAgentEffectivelyExecuting(agentId),
          },
        );
        this.triggerScheduler.start();

        // Startup bootstrap for already-persisted agents. Ongoing lifecycle
        // updates are handled inside HeartbeatTriggerScheduler itself.
        const isHeartbeatEnabledAgent = (agent: import("@fusion/core").Agent) =>
          !isEphemeralAgent(agent) && agent.runtimeConfig?.enabled !== false;
        const isTickableHeartbeatState = (state: import("@fusion/core").AgentState) =>
          state === "active" || state === "running" || state === "idle";
        const isTimerManagedAgent = (agent: import("@fusion/core").Agent) =>
          isHeartbeatEnabledAgent(agent) && isTickableHeartbeatState(agent.state);

        // Wire the ephemeral worker manager (now that the executor exists, so
        // its spawned-child pending-deletion set can be consulted) and run
        // the startup orphan sweep. See ephemeral-worker-manager.ts for the
        // full lifecycle contract. Non-fatal: failures are logged and never
        // block startup.
        if (this.agentStore && !this.workerManager) {
          this.workerManager = new EphemeralWorkerManager({
            agentStore: this.agentStore,
            taskStore: this.taskStore,
            logger: runtimeLog,
            isDeletionPendingExternal: (agentId) => this.executor?.isEphemeralDeletionPending(agentId) ?? false,
            getSettings: async () => {
              const settings = await this.taskStore.getSettings();
              return { ephemeralAgentsEnabled: settings.ephemeralAgentsEnabled };
            },
          });
        }
        if (this.workerManager) {
          this.workerManager.attachStateChangeListener();
          void this.workerManager.reconcileOrphaned().catch((err) => {
            runtimeLog.warn(`Deferred workerManager.reconcileOrphaned failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }

        // Register existing non-ephemeral, heartbeat-enabled agents in tickable states.
        try {
          const agents = await this.agentStore.listAgents();
          let registeredCount = 0;
          for (const agent of agents) {
            if (!isTimerManagedAgent(agent)) continue;
            const rc = agent.runtimeConfig;
            this.triggerScheduler.registerAgent(
              agent.id,
              {
                enabled: rc?.enabled as boolean | undefined,
                heartbeatIntervalMs: rc?.heartbeatIntervalMs as number | undefined,
                maxConcurrentRuns: rc?.maxConcurrentRuns as number | undefined,
              },
              { lastHeartbeatAt: agent.lastHeartbeatAt },
            );
            registeredCount++;
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
          semaphore: this.projectSemaphore,
          stuckTaskDetector: this.stuckTaskDetector,
          agentStore: this.agentStore,
          pluginRunner: this.pluginRunner,
          onSpecifyStart: (t) => {
            this.recordActivity();
            runtimeLog.log(`Specifying ${t.id}...`);
          },
          onSpecifyComplete: (t) => {
            this.recordActivity();
            runtimeLog.log(`Specified ${t.id} → todo`);
            void (async () => {
              const live = await this.taskStore.getTask(t.id);
              if (!live || live.paused || live.userPaused) return;
              const ir = await resolveWorkflowIrForTask(this.taskStore, live.id);
              const planReview = resolvePreReleasePlanReviewNode(ir);
              if (!planReview || planReview.column !== live.column) return;

              /*
              FNXC:PlanReview 2026-07-21-12:20:
              Specification completion creates a planning continuation only
              when the review node belongs to the card's current column and no
              active continuation already owns the task.
              */
              const active = await this.taskStore.listWorkflowWorkItemsForTask(live.id, { kinds: ["task"] });
              if (!active.some((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state))) {
                await this.taskStore.replaceActiveTaskWorkflowContinuation({
                  runId: `${live.id}:planning-continuation:${planReview.id}:${active.length}`,
                  taskId: live.id,
                  nodeId: planReview.id,
                  kind: "task",
                  state: "runnable",
                  stableWorkflowRunId: `${live.id}:${ir.name}`,
                  continuationSequence: active.length,
                  waitReason: "planning",
                  sourceColumn: live.column,
                  targetColumn: live.column,
                  irHash: computeWorkflowIrPin(ir, planReview.id).irHash,
                });
              }
              this.kickWorkflowContinuationProcessor();
            })().catch((error) => {
              runtimeLog.error(`Failed to start Todo plan review for ${t.id}:`, error);
            });
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
          // FNXC:SqliteFinalRemoval 2026-06-26-10:55:
          // In backend mode, pass the AsyncDataLayer so RoutineStore delegates
          // to the async helpers; otherwise use the legacy SQLite path.
          const routineLayer = this.taskStore.getAsyncLayer();
          const routineStore = routineLayer
            ? new RoutineStoreClass(this.config.workingDirectory, { asyncLayer: routineLayer })
            : new RoutineStoreClass(this.config.workingDirectory);
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

      await yieldEventLoop();

      // 7. Initialize SelfHealingManager
      {
        const chatLayer2 = this.taskStore.getAsyncLayer();
        if (!chatLayer2) throw new Error("Self-healing ChatStore requires the project PostgreSQL AsyncDataLayer");
        this.chatStore ??= new ChatStore(chatLayer2);
      }
      this.selfHealingManager = new SelfHealingManager(this.taskStore, {
        rootDir: this.config.workingDirectory,
        agentStore: this.agentStore,
        isWorktreeResumeReserved: this.cliAgentRuntime?.isWorktreeResumeReserved,
        recoverCompletedTask: (task) => this.executor.recoverCompletedTask(task),
        recoverFailedPreMergeStep: (task) => this.executor.recoverFailedPreMergeWorkflowStep(task),
        getExecutingTaskIds: () => this.executor?.getExecutingTaskIds() ?? new Set<string>(),
        clearPhantomExecutorBinding: (taskId: string, options?: { preserveWorktrees?: boolean }) => this.executor?.clearPhantomExecutorBinding(taskId, options),
        listWorktreeHolders: () => this.executor?.listWorktreeHolders() ?? [],
        recoverApprovedTriageTask: (task) => this.triageProcessor?.recoverApprovedTask(task) ?? Promise.resolve(false),
        getPlanningTaskIds: () => this.triageProcessor?.getPlanningTaskIds() ?? new Set<string>(),
        // FNXC:TaskTiming 2026-08-01-12:00: orphan planning recovery must defer
        // while executor-owned graph Plan Review holds the sole planning anchor.
        hasActivePlanningWorkflowSession: (taskId) => this.executor?.hasActivePlanningWorkflowSession(taskId) ?? false,
        reserveAdvancedTriageRecovery: (taskId) => this.triageProcessor?.tryReserveAdvancedRecovery(taskId),
        evictStaleTriageProcessing: () => this.triageProcessor?.evictStaleProcessing() ?? new Set<string>(),
        enqueueMerge: this.mergeEnqueuer ? (taskId: string) => this.mergeEnqueuer?.(taskId) ?? false : undefined,
        requeueForAutoMerge: this.mergeEnqueuer ? (taskId: string) => this.mergeEnqueuer?.(taskId) ?? false : undefined,
        isTaskActive: (taskId: string) => this.executor.isTaskActive(taskId),
        clearMergeActive: this.clearMergeActive ? (taskId: string) => this.clearMergeActive?.(taskId) : undefined,
        getActiveMergeTaskId: () => this.activeMergeTaskIdProvider?.() ?? null,
        getActiveMergeStartedAtMs: () => this.activeMergeStartedAtMsProvider?.() ?? null,
        abortActiveMerge: this.activeMergeAborter
          ? (taskId: string, reason: string) => this.activeMergeAborter?.(taskId, reason) ?? false
          : undefined,
        // FNXC:Workspace 2026-06-22-16:40 (Phase D P1 TOCTOU): undefined provider → "not pending"
        // (graceful when unwired; existing guards still apply). In production it is always wired.
        isMergePending: this.mergePendingProvider ? (taskId: string) => this.mergePendingProvider?.(taskId) ?? false : undefined,
        leaseManager: this.leaseManager,
        hasActiveAgentExecution: (agentId: string) => this.heartbeatMonitor?.getTrackedAgents().includes(agentId) ?? false,
        resumeAssignedTaskForAgent: (agentId: string) => this.executor.resumeTaskForAgent(agentId),
        recoverActiveMissionValidations: async () => {
          if (!this.missionExecutionLoop) {
            return { recoveredCount: 0 };
          }
          return this.missionExecutionLoop.recoverActiveMissions();
        },
        reapStaleMissionValidatorRuns: async () => {
          if (!this.missionExecutionLoop) {
            return { reapedCount: 0 };
          }
          return this.missionExecutionLoop.reapStaleValidatorRuns(VALIDATOR_RUN_STALE_MAX_AGE_MS);
        },
        reconcileAllMissionFeatures: async () => this.scheduler.reconcileAllMissionFeatures(),
        chatStore: this.chatStore,
        messageStore: this.messageStore,
        restartDurableAgentHeartbeat: async (agentId: string, context: { reason: string; attempt: number }) => {
          if (!this.heartbeatMonitor) {
            return false;
          }
          const run = await this.heartbeatMonitor.executeHeartbeat({
            agentId,
            source: "automation",
            triggerDetail: `self-healing durable-agent transient recovery (${context.reason}, attempt ${context.attempt})`,
            contextSnapshot: {
              selfHealing: {
                reason: context.reason,
                attempt: context.attempt,
                source: "durable-agent-transient-error-recovery",
              },
            },
          });
          return !!run;
        },
      });
      this.selfHealingManager.start();
      this.stuckTaskDetector.start();
      this.detachAgentLinkSync = attachAgentLinkSync({
        store: this.taskStore,
        agentStore: this.agentStore!,
        hasActiveAgentExecution: (agentId: string) => this.heartbeatMonitor?.getTrackedAgents().includes(agentId) ?? false,
        logger: runtimeLog,
      });
      this.restartRecoveryCoordinator = new RestartRecoveryCoordinator(this.taskStore, this.executor);

      // 8. Set up event forwarding from TaskStore
      this.setupEventForwarding();

      const startupSettings = await this.taskStore.getSettings();
      if (startupSettings.globalPause || startupSettings.enginePaused) {
        this.startupRecoveryDeferred = true;
        runtimeLog.log(
          `Startup recovery deferred — ${
            startupSettings.globalPause ? "global pause" : "engine pause"
          } is active`,
        );
      } else {
        this.startupRecoveryDeferred = false;
        // Defer recovery sequence so the runtime start() returns quickly.
        // The sequence runs git operations and may resume orphaned tasks,
        // both of which can block the event loop for several seconds.
        // Running it in the background lets the HTTP server become
        // responsive sooner while still performing the recovery work.
        void this.resumeStartupRecoverySequence().catch((err) => {
          runtimeLog.error("Deferred startup recovery sequence failed:", err);
        });
      }

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
      /*
       * FNXC:PostgresMissionRuntime 2026-07-14-17:20:
       * Crash recovery and scheduler reconciliation use the same union store in
       * both backends; initialization errors remain fail-soft for engine boot.
       */
      let activeMissionStore:
        | import("@fusion/core").MissionStore
        | import("@fusion/core").AsyncMissionStore
        | undefined;
      // FNXC:MissionStore 2026-06-28-12:45: autopilot crash-recovery now runs in BOTH
      // backends. `recoverMissions` accepts the `MissionStore | AsyncMissionStore`
      // union and awaits every store call, so resolve the store WITHOUT an instanceof
      // gate here. Scheduler reconciliation now awaits that same union.
      let activeAutopilotMissionStore:
        | import("@fusion/core").MissionStore
        | import("@fusion/core").AsyncMissionStore
        | undefined;
      try {
        const resolvedActive = this.taskStore.getMissionStore();
        activeAutopilotMissionStore = resolvedActive;
        activeMissionStore = resolvedActive;
      } catch (error) {
        activeMissionStore = undefined;
        activeAutopilotMissionStore = undefined;
        runtimeLog.warn(`[runtime] mission crash recovery skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
      const activeMissionAutopilot = this.scheduler.getMissionAutopilot?.();
      if (activeAutopilotMissionStore && activeMissionAutopilot) {
        void activeMissionAutopilot.recoverMissions(activeAutopilotMissionStore);
      }

      // 13. Reconcile feature status for all active missions (not just autopilot)
      if (activeMissionStore) {
        void this.scheduler.reconcileAllMissionFeatures();
      }

      // 14. Start MissionAutopilot background polling
      this.missionAutopilot?.start();

      try {
        await this.taskStore.updateSettings({ engineActiveSinceMs: Date.now() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runtimeLog.warn(`Failed to stamp engineActiveSinceMs on runtime start: ${message}`);
      }

      // 15. CLI Agent Executor: recover orphaned-live sessions left by a prior
      // engine death. Non-blocking; errors are logged, never thrown.
      if (this.cliAgentRuntime) {
        const cliRuntime = this.cliAgentRuntime;
        void cliRuntime.resumeCoordinator
          .recoverOnStart()
          .then((results) => {
            if (results.length > 0) {
              runtimeLog.log(`CLI Agent Executor recovered ${results.length} orphaned session(s) on start`);
            }
          })
          .catch((err) => {
            runtimeLog.warn(
              `CLI Agent Executor recoverOnStart failed (continuing):`,
              err instanceof Error ? err.message : err,
            );
          });
      }

      this.setStatus("active");
      this.workflowContinuationTimer = setInterval(() => {
        this.kickWorkflowContinuationProcessor();
      }, 2_000);
      this.workflowContinuationTimer.unref?.();
      this.kickWorkflowContinuationProcessor();
      runtimeLog.log(`InProcessRuntime started for project ${this.config.projectId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      /*
      FNXC:RuntimeStartupWiring 2026-07-14-18:18:
      A failed partial startup must unwind every initialized subsystem and the owned PostgreSQL backend before surfacing the original startup error. The normal stop path is deliberately safe against partially initialized fields.
      */
      try {
        await this.stop();
      } catch (cleanupError) {
        runtimeLog.warn(
          `Failed to fully unwind partial runtime startup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
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

    /*
    FNXC:PostgresResourceLifecycle 2026-07-14-18:42:
    Runtime shutdown owns the startup-factory backend handle. Capture and clear it before any subsystem cleanup so concurrent/retried stop calls cannot invoke it twice, then release it from finally even when settings, plugins, or worktree cleanup fails. The first subsystem error remains the observable stop failure; backend cleanup is best-effort and never masks it.
    */
    const backendShutdown = this.backendShutdown;
    this.backendShutdown = undefined;
    let stopError: Error | undefined;
    try {
      if (this.workflowContinuationTimer) {
        clearInterval(this.workflowContinuationTimer);
        this.workflowContinuationTimer = undefined;
      }
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

      // 2c. Dispose the CLI Agent Executor runtime (scoped SIGKILL of this
      // runtime's own PTYs only — never the dashboard / port 4040).
      if (this.cliAgentRuntime) {
        try {
          await this.cliAgentRuntime.dispose();
          runtimeLog.log("CLI Agent Executor runtime disposed");
        } catch (cliErr) {
          runtimeLog.warn(
            `CLI Agent Executor dispose failed:`,
            cliErr instanceof Error ? cliErr.message : cliErr,
          );
        }
        this.cliAgentRuntime = undefined;
      }

      // 2. Stop routine scheduler (stops new routine triggers; in-flight executions continue)
      if (this.routineScheduler) {
        this.routineScheduler.stop();
        runtimeLog.log("RoutineScheduler stopped");
      }

      this.detachAgentLinkSync?.();
      this.detachAgentLinkSync = undefined;

      // 3. Tear down the ephemeral worker manager (detaches the
      // agent:stateChanged listener and clears in-memory tracking). Safe to
      // call when uninitialized.
      this.workerManager?.detachStateChangeListener();
      this.workerManager?.reset();
      this.executor?.disposeEphemeralTimers();

      // 4. Stop trigger scheduler
      if (this.triggerScheduler) {
        this.triggerScheduler.stop();
        runtimeLog.log("TriggerScheduler stopped");
      }

      // 4a. Stop AgentStore cross-process change detection (FN-7723). This
      // engine store is the only AgentStore instance in this process that
      // ever called startWatching(); stopping it here clears the fs.watch
      // handle and poll interval so shutdown does not leak them.
      if (this.agentStore) {
        try {
          this.agentStore.stopWatching();
          runtimeLog.log("AgentStore cross-process change detection stopped");
        } catch (watchStopErr) {
          runtimeLog.warn(`AgentStore.stopWatching() failed:`, watchStopErr instanceof Error ? watchStopErr.message : watchStopErr);
        }
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

      // 7b. Abort in-flight bash subprocess trees on every active agent
      // session. Each bash command was spawned with `detached: true` (own
      // process group), so killing the worker alone leaks vitest / npm / build
      // grandchildren as orphans. This call routes through pi-coding-agent's
      // AbortController -> killProcessTree, taking down the whole subtree.
      if (this.executor) {
        try {
          this.executor.abortAllSessionBash();
          runtimeLog.log("Aborted in-flight bash subprocesses on active sessions");
        } catch (err) {
          runtimeLog.warn(`Failed to abort in-flight bash subprocesses: ${err}`);
        }
      }

      // 7c. Abort and dispose all in-flight AI sessions so shutdown does not
      // continue streaming LLM output or tool calls during the drain phase.
      if (this.executor) {
        try {
          await this.executor.abortAllInFlight("engine stop");
          this.executor.disposeStoreLifecycleDisposers();
          runtimeLog.log("Aborted in-flight executor AI sessions");
        } catch (err) {
          runtimeLog.warn(`Failed to abort in-flight executor AI sessions: ${err}`);
        }
      }

      // 8. Wait for active tasks to drain after aborting live sessions.
      const settings = this.taskStore ? await this.taskStore.getSettings() : undefined;
      const shutdownTimeout = settings?.runtimeStopDrainMs ?? 2000;
      const startTime = Date.now();

      if (shutdownTimeout > 0) {
        const pollIntervalMs = Math.min(500, shutdownTimeout);
        while (Date.now() - startTime < shutdownTimeout) {
          const metrics = this.getMetrics();
          if (metrics.inFlightTasks === 0) {
            break;
          }
          runtimeLog.log(
            `Waiting for ${metrics.inFlightTasks} in-flight tasks to complete...`
          );
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
      }

      // Check if we timed out
      const finalMetrics = this.getMetrics();
      if (finalMetrics.inFlightTasks > 0) {
        runtimeLog.warn(
          `post-abort drain timeout: shutdown reached with ${finalMetrics.inFlightTasks} tasks still in-flight`
        );
      }

      /**
       * FNXC:Scheduler-Concurrency 2026-06-27-20:05:
       * After stop aborts a project's agents and waits the bounded drain window, any slots still attributed to this runtime are residual leaks from sessions that did not settle their normal finally path. Return only this project's scoped slots so pauseProject/stopAll promptly free shared global capacity without clobbering other projects' active slots.
       */
      const returnedResidualSlots = this.projectSemaphore?.returnAllHeldSlots() ?? 0;
      if (returnedResidualSlots > 0) {
        runtimeLog.warn(
          `Returned ${returnedResidualSlots} residual global concurrency slot(s) after project stop drain`,
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

      this.leaseCentralClaimStore = undefined;

      this.setStatus("stopped");
      runtimeLog.log(`InProcessRuntime stopped for project ${this.config.projectId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      stopError = err;
      this.setStatus("errored");
      runtimeLog.error(`Error during shutdown:`, err.message);
      this.emit("error", err);
    } finally {
      if (backendShutdown) {
        try {
          await backendShutdown();
        } catch (err) {
          runtimeLog.warn(
            `Backend shutdown failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    if (stopError) throw stopError;
  }

  /**
   * Get the current runtime status.
   */
  getStatus(): RuntimeStatus {
    return this.status;
  }

  /**
   * Register a callback used by SelfHealingManager to re-enqueue tasks for
   * auto-merge after clearing a stale `merging` status. Must be called before
   * `start()` because SelfHealingManager is constructed during startup.
   */
  setMergeEnqueuer(enqueueMerge: (taskId: string) => boolean): void {
    this.mergeEnqueuer = enqueueMerge;
  }

  /**
   * Wire the workflow-graph merge seam to ProjectEngine.onMerge. Late-bindable:
   * forwards immediately when the executor already exists, and is re-applied at
   * executor construction during start().
   */
  setMergeRequester(
    requestMerge: (
      taskId: string,
      options?: { signal?: AbortSignal },
    ) => Promise<import("@fusion/core").MergeResult>,
  ): void {
    this.mergeRequester = requestMerge;
    this.executor?.setMergeRequester(requestMerge);
  }

  setMergeActiveClearer(clearMergeActive: (taskId: string) => void): void {
    this.clearMergeActive = clearMergeActive;
  }

  setActiveMergeTaskIdProvider(getActiveMergeTaskId: () => string | null): void {
    this.activeMergeTaskIdProvider = getActiveMergeTaskId;
  }

  setActiveMergeStartedAtMsProvider(getActiveMergeStartedAtMs: () => number | null): void {
    this.activeMergeStartedAtMsProvider = getActiveMergeStartedAtMs;
  }

  setActiveMergeAborter(abortActiveMerge: (taskId: string, reason: string) => boolean): void {
    this.activeMergeAborter = abortActiveMerge;
  }

  setMergePendingProvider(isMergePending: (taskId: string) => boolean): void {
    this.mergePendingProvider = isMergePending;
  }

  /**
   * Resume executor/self-healing activity after an unpause transition.
   *
   * When startup recovery had been deferred, this replays the original startup
   * ordering so orphan resume and self-healing cannot race each other.
   */
  async resumeAfterUnpause(): Promise<void> {
    if (!this.taskStore || !this.executor || !this.selfHealingManager) {
      return;
    }
    if (this.resumeAfterUnpauseRunning) {
      return;
    }

    this.resumeAfterUnpauseRunning = true;
    try {
      const settings = await this.taskStore.getSettings();
      if (settings.globalPause || settings.enginePaused) {
        runtimeLog.log(
          `Unpause recovery still blocked — ${
            settings.globalPause ? "global pause" : "engine pause"
          } remains active`,
        );
        return;
      }

      if (this.startupRecoveryDeferred) {
        await this.resumeStartupRecoverySequence();
        this.startupRecoveryDeferred = false;
        return;
      }

      await this.executor.resumeOrphaned();
    } finally {
      this.resumeAfterUnpauseRunning = false;
    }
  }

  private async resumeStartupRecoverySequence(): Promise<void> {
    // Restart recovery decides when interrupted runs can safely resume versus
    // when they must be reset to todo for a clean retry.
    await this.restartRecoveryCoordinator!.recoverInterruptedRuns();

    // Some "stuck" tasks are already orphaned by the time the runtime boots:
    // they no longer have a tracked session/worktree, so the stuck detector
    // cannot recover them. Delegate the startup recovery pass to
    // SelfHealingManager so the policy lives in one place.
    void this.selfHealingManager!.runStartupRecovery().catch((err) => {
      runtimeLog.error("Self-healing startup recovery failed:", err);
    });
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
   * FNXC:PlannerOversight 2026-07-13-23:05:
   * Expose TaskExecutor so ProjectEngine can wire session-advisor log flush.
   */
  getExecutor(): TaskExecutor | undefined {
    return this.executor;
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
   * Get the ChatStore instance (if initialized).
   * Returns undefined before start() or if initialization fails.
   */
  getChatStore(): import("@fusion/core").ChatStore | undefined {
    return this.chatStore;
  }

  /**
   * Get the project-scoped PluginRunner (if initialized).
   * Dashboard chat needs this runner, not the top-level PluginLoader, so
   * runtime hints such as `hermes` can resolve plugin runtimes correctly.
   */
  getPluginRunner(): PluginRunner | undefined {
    return this.pluginRunner;
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

  clearTaskPauseAbortState(taskId: string): void {
    this.executor?.clearPauseAbortStateForManualRetry(taskId);
  }

  configurePrMonitoring(options: {
    prMonitor: PrMonitor;
    onClosedPrFeedback?: (taskId: string, prInfo: PrInfo, comments: PrComment[]) => void | Promise<void>;
  }): void {
    if (!this.scheduler) {
      throw new Error("Scheduler not initialized. Call start() first.");
    }

    this.scheduler.configurePrMonitoring(options);
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

  getSelfHealingManager(): SelfHealingManager | undefined {
    return this.selfHealingManager;
  }

  /**
   * Get the bootstrapped CLI Agent Executor runtime (if the experimental flag is
   * on and construction succeeded). The dashboard reads this to resolve the
   * project's TelemetryHub (hook route) and supply the cli-session transport.
   */
  getCliAgentRuntime(): BootstrappedCliAgentRuntime | undefined {
    return this.cliAgentRuntime;
  }

  private async dispatchCliAgentAwaitingInputNotification(
    info: CliAgentAwaitingInputNotificationInfo,
  ): Promise<void> {
    const notificationService = getActiveNotificationService();
    if (!notificationService) {
      return;
    }

    const session = this.cliAgentRuntime?.bundle.store.getSession(info.sessionId);
    let task: Task | undefined;
    if (session?.taskId) {
      try {
        task = await this.taskStore.getTask(session.taskId);
      } catch {
        task = undefined;
      }
    }

    const payload = buildCliAgentAwaitingInputNotificationPayload({
      projectId: this.config.projectId,
      info,
      session,
      task,
    });
    await notificationService.dispatch(CLI_AGENT_AWAITING_INPUT_EVENT, payload);
  }

  /**
   * Resolve the dashboard CLI-agent hook ingestion endpoint URL. Prefers the
   * value threaded from server boot (once the listening port is known); falls
   * back to a localhost URL derived from `FUSION_DASHBOARD_PORT` (default 4040).
   */
  private resolveCliAgentHookEndpointUrl(): string {
    if (this.config.cliAgentHookEndpointUrl) {
      return this.config.cliAgentHookEndpointUrl;
    }
    const port = Number(process.env.FUSION_DASHBOARD_PORT) || 4040;
    return `http://127.0.0.1:${port}/api/cli-agent/hooks`;
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
   * FNXC:WorkflowScheduling 2026-07-21-12:20:
   * Wake the durable task-continuation consumer in a microtask so triage can
   * release its own execution slot before continuation dispatch begins.
   */
  private kickWorkflowContinuationProcessor(): void {
    queueMicrotask(() => {
      void this.drainWorkflowContinuations().catch((error) => {
        runtimeLog.error("Workflow continuation processor failed:", error);
      });
    });
  }

  private async drainWorkflowContinuations(): Promise<void> {
    /*
    FNXC:WorkflowScheduling 2026-07-21-12:20:
    A single runtime drain owns selection at a time. Concurrent wakeups collapse
    behind this guard and the recurring processor supplies the next bounded pass.
    */
    if (this.workflowContinuationDrainActive || this.status !== "active") return;
    this.workflowContinuationDrainActive = true;
    try {
      const items = await this.taskStore.listDueWorkflowWorkItems({
        kinds: ["task"],
        states: ["runnable", "retrying"],
        limit: 20,
      });
      const candidates: PlanningContinuationCandidate[] = [];
      for (const item of items) {
        const task = await this.taskStore.getTask(item.taskId);
        candidates.push({ item, task });
      }
      for (const { item, task } of selectActionablePlanningContinuations(candidates)) {
        void this.executor.execute(task).catch((error) => {
          runtimeLog.error(`Workflow continuation ${item.id} failed:`, error);
        });
      }
    } finally {
      this.workflowContinuationDrainActive = false;
    }
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
   * Set up event forwarding from TaskStore to runtime listeners
   * for task:created, task:moved, task:updated, and task:deleted.
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
      if (data.to === "archived") {
        /*
        FNXC:TaskDetailPlannerChatRetention 2026-06-30-18:45:
        In-process task archival is the retention cutoff for task-local planner chats. Keep interacted planner chats when tasks reach done, but delete exact task-planner sessions on archive through ChatStore so normal conversations and other tasks remain untouched.
        */
        void this.chatStore?.deleteSessionsForAgentId(`${TASK_PLANNER_CHAT_AGENT_ID_PREFIX}${data.task.id}`, { projectId: this.config.projectId });
      }
      this.emit("task:moved", data);
    });

    // Forward task:updated events
    this.taskStore.on("task:updated", (task: Task) => {
      this.recordActivity();
      this.emit("task:updated", task);
    });

    // Forward task:deleted events
    this.taskStore.on("task:deleted", (task: Task, meta?: { githubIssueAction?: GithubIssueAction }) => {
      this.recordActivity();
      this.emit("task:deleted", task, meta);
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
