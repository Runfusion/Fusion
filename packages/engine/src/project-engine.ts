/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  TaskStore,
  Task,
  CentralCore,
  Settings,
  MergeResult,
  AutomationStore as AutomationStoreType,
  ScheduledTask,
  AutomationRunResult,
} from "@fusion/core";
import { InProcessRuntime } from "./runtimes/in-process-runtime.js";
import type { ProjectRuntimeConfig } from "./project-runtime.js";
import { PrMonitor } from "./pr-monitor.js";
import { PrCommentHandler } from "./pr-comment-handler.js";
import { NtfyNotifier } from "./notifier.js";
import { CronRunner, createAiPromptExecutor } from "./cron-runner.js";
import type { RoutineRunner } from "./routine-runner.js";
import { aiMergeTask } from "./merger.js";
import { PRIORITY_MERGE } from "./concurrency.js";
import { runtimeLog } from "./logger.js";
import type { HeartbeatTriggerScheduler } from "./agent-heartbeat.js";

/**
 * Callback for processing pull-request merge strategy.
 * Injected from the CLI layer since it depends on GitHubClient.
 */
export type ProcessPullRequestMergeFn = (
  store: TaskStore,
  cwd: string,
  taskId: string,
) => Promise<"merged" | "waiting" | "skipped">;

export interface ProjectEngineOptions {
  /** Project identifier for notification deep links */
  projectId?: string;
  /** Base URL for ntfy.sh notifications */
  ntfyBaseUrl?: string;
  /**
   * An already-initialized TaskStore to use instead of creating a new one.
   * When provided, InProcessRuntime will skip TaskStore construction and init().
   * Useful when the caller (e.g. dashboard.ts) owns and watches the store.
   */
  externalTaskStore?: TaskStore;
  /**
   * Returns the merge strategy for the current settings.
   * If not provided, defaults to "direct".
   */
  getMergeStrategy?: (settings: Settings) => "direct" | "pull-request";
  /**
   * Processes a pull-request merge flow. Required when merge strategy
   * can be "pull-request". Injected from CLI layer.
   */
  processPullRequestMerge?: ProcessPullRequestMergeFn;
  /**
   * Returns the merge blocker reason for a task, or null/undefined if
   * the task is eligible for merge. Imported from @fusion/core.
   */
  getTaskMergeBlocker?: (task: Task) => string | null | undefined;
  /**
   * Callback for insight extraction run processing.
   * Invoked after CronRunner completes a memory insight extraction schedule.
   */
  onInsightRunProcessed?: (schedule: unknown, result: unknown) => void | Promise<void>;
  /**
   * Whether to skip starting NtfyNotifier. Useful when the caller manages
   * notifications independently. Defaults to false (notifier is started).
   */
  skipNotifier?: boolean;
}

/**
 * ProjectEngine composes an InProcessRuntime with the higher-level
 * subsystems that were previously wired inline in serve.ts / dashboard.ts:
 *
 * - **Auto-merge queue** — serialized merge with conflict retry, semaphore gating
 * - **PrMonitor + PrCommentHandler** — GitHub PR feedback loop
 * - **NtfyNotifier** — push notifications
 * - **CronRunner + AutomationStore** — scheduled automations
 * - **Settings event listeners** — dynamic reconfiguration
 *
 * This ensures every InProcessRuntime (single-project CLI or multi-project
 * via ProjectManager) gets the full subsystem set, eliminating the class of
 * bugs where a subsystem is forgotten in one code path.
 */
export class ProjectEngine {
  private runtime: InProcessRuntime;
  private prMonitor?: PrMonitor;
  private prCommentHandler?: PrCommentHandler;
  private notifier?: NtfyNotifier;
  private cronRunner?: CronRunner;
  private automationStore?: AutomationStoreType;

  // ── Auto-merge state ──
  private mergeQueue: string[] = [];
  private mergeActive = new Set<string>();
  private mergeRunning = false;
  private activeMergeSession: { dispose: () => void } | null = null;
  private mergeAbortController: AbortController | null = null;
  private mergeRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Pending manual merge resolvers — keyed by taskId.
   * When `onMerge` is called, the task is enqueued like auto-merge but a
   * Promise is stored here so the caller can await the result.
   */
  private manualMergeResolvers = new Map<
    string,
    { resolve: (result: MergeResult) => void; reject: (err: Error) => void }
  >();
  private shuttingDown = false;

  private static readonly MAX_AUTO_MERGE_RETRIES = 3;
  /** 30-minute cooldown before a retry-exhausted task gets another sweep attempt */
  private static readonly AUTO_MERGE_COOLDOWN_MS = 30 * 60 * 1000;

  // Event handler references for cleanup
  private settingsHandlers: Array<(...args: any[]) => void> = [];
  private taskMovedHandler?: (...args: any[]) => void;

  constructor(
    private config: ProjectRuntimeConfig,
    centralCore: CentralCore,
    private options: ProjectEngineOptions = {},
  ) {
    // Pass through externalTaskStore to the runtime config if provided
    const runtimeConfig: ProjectRuntimeConfig = options.externalTaskStore
      ? { ...config, externalTaskStore: options.externalTaskStore }
      : config;
    this.runtime = new InProcessRuntime(runtimeConfig, centralCore);
  }

  /**
   * Start the engine: initialize the runtime and all auxiliary subsystems.
   */
  async start(): Promise<void> {
    // 1. Start the core runtime (TaskStore, Scheduler, Executor, Triage, etc.)
    await this.runtime.start();

    const store = this.runtime.getTaskStore();
    const cwd = this.config.workingDirectory;

    // 2. Initialize PrMonitor + PrCommentHandler
    this.prMonitor = new PrMonitor();
    this.prCommentHandler = new PrCommentHandler(store);
    this.prMonitor.onNewComments((taskId, prInfo, comments) =>
      this.prCommentHandler!.handleNewComments(taskId, prInfo, comments),
    );

    // 3. Initialize NtfyNotifier (unless caller manages it externally)
    if (!this.options.skipNotifier) {
      this.notifier = new NtfyNotifier(store, {
        projectId: this.options.projectId,
        ntfyBaseUrl: this.options.ntfyBaseUrl,
      });
      await this.notifier.start();
    }

    // 4. Initialize AutomationStore + CronRunner
    try {
      const { AutomationStore } = await import("@fusion/core");
      this.automationStore = new AutomationStore(cwd);
      await this.automationStore.init();

      const aiPromptExecutor = await createAiPromptExecutor(cwd);
      this.cronRunner = new CronRunner(store, this.automationStore, {
        aiPromptExecutor,
        onScheduleRunProcessed: this.buildInsightRunHandler(cwd),
        scope: "project", // Project-scoped execution — global schedules run separately
      });

      const settings = await store.getSettings();

      // Sync insight extraction automation on startup
      try {
        const { syncInsightExtractionAutomation } = await import("@fusion/core");
        if (typeof syncInsightExtractionAutomation === "function") {
          await syncInsightExtractionAutomation(this.automationStore, settings);
        }
      } catch {
        // syncInsightExtractionAutomation may not be exported yet
      }

      // Sync auto-summarize automation on startup
      try {
        const { syncAutoSummarizeAutomation } = await import("@fusion/core");
        if (typeof syncAutoSummarizeAutomation === "function") {
          await syncAutoSummarizeAutomation(this.automationStore, settings);
        }
      } catch {
        // syncAutoSummarizeAutomation may not be exported yet
      }

      // Sync memory dreams automation on startup
      try {
        const { syncMemoryDreamsAutomation } = await import("@fusion/core");
        if (typeof syncMemoryDreamsAutomation === "function") {
          await syncMemoryDreamsAutomation(this.automationStore, settings);
        }
      } catch {
        // syncMemoryDreamsAutomation may not be exported yet
      }

      this.cronRunner.start();
      runtimeLog.log("CronRunner initialized and started");
    } catch (err) {
      // Non-fatal — automations are optional
      runtimeLog.warn(
        "AutomationStore/CronRunner initialization failed (continuing without automations):",
        err instanceof Error ? err.message : err,
      );
    }

    // 5. Wire settings event listeners
    this.wireSettingsListeners(store);

    // 6. Wire auto-merge on task:moved
    this.wireAutoMerge(store, cwd);

    // 7. Auto-merge startup sweep
    await this.startupMergeSweep(store);

    // 8. Start periodic merge retry sweep
    this.scheduleMergeRetry(store);

    runtimeLog.log(`ProjectEngine started for ${this.config.projectId}`);
  }

  /**
   * Gracefully stop the engine and all subsystems.
   *
   * If a merge is currently running, its abort signal is triggered before the
   * active merge session is disposed so merge pipeline checkpoints can exit
   * promptly without continuing git/verification work after shutdown starts.
   */
  async stop(): Promise<void> {
    this.shuttingDown = true;

    // Stop merge retry timer
    if (this.mergeRetryTimer) {
      clearTimeout(this.mergeRetryTimer);
      this.mergeRetryTimer = null;
    }

    // Abort active/pending merge work before tearing down sessions.
    this.mergeAbortController?.abort();
    this.mergeAbortController = null;

    const queuedTaskIds = [...this.mergeQueue];
    this.mergeQueue.length = 0;
    for (const queuedTaskId of queuedTaskIds) {
      this.mergeActive.delete(queuedTaskId);
    }

    // Terminate active merge session
    if (this.activeMergeSession) {
      this.activeMergeSession.dispose();
      this.activeMergeSession = null;
    }

    // Reject any pending manual merge promises
    for (const [taskId, resolver] of this.manualMergeResolvers) {
      resolver.reject(new Error(`Engine shutting down — merge for ${taskId} aborted`));
    }
    this.manualMergeResolvers.clear();

    // Remove event listeners
    try {
      const store = this.runtime.getTaskStore();
      for (const handler of this.settingsHandlers) {
        store.off("settings:updated", handler);
      }
      if (this.taskMovedHandler) {
        store.off("task:moved", this.taskMovedHandler);
      }
    } catch {
      // Store may not be initialized if start() failed partway
    }

    // Stop auxiliary subsystems
    this.notifier?.stop();
    this.cronRunner?.stop();

    // Stop the core runtime (Triage, Scheduler, Executor, etc.)
    await this.runtime.stop();

    runtimeLog.log(`ProjectEngine stopped for ${this.config.projectId}`);
  }

  // ── Public accessors ──

  /** Get the underlying InProcessRuntime. */
  getRuntime(): InProcessRuntime {
    return this.runtime;
  }

  /** Get the TaskStore. Throws if not started. */
  getTaskStore(): TaskStore {
    return this.runtime.getTaskStore();
  }

  /** Get the AgentStore (if initialized). Returns undefined before start(). */
  getAgentStore(): import("@fusion/core").AgentStore | undefined {
    return this.runtime.getAgentStore();
  }

  /** Get the MessageStore (if initialized). Returns undefined before start(). */
  getMessageStore(): import("@fusion/core").MessageStore | undefined {
    return this.runtime.getMessageStore();
  }

  /** Get the HeartbeatMonitor (if initialized). */
  getHeartbeatMonitor() {
    return this.runtime.getHeartbeatMonitor();
  }

  /** Get the project working directory. */
  getWorkingDirectory(): string {
    return this.config.workingDirectory;
  }

  /** Get the PrMonitor (if initialized). */
  getPrMonitor(): PrMonitor | undefined {
    return this.prMonitor;
  }

  /** Get the CronRunner (if initialized). */
  getCronRunner(): CronRunner | undefined {
    return this.cronRunner;
  }

  /** Get the AutomationStore (if initialized). */
  getAutomationStore(): AutomationStoreType | undefined {
    return this.automationStore;
  }

  /** Get the RoutineStore (if initialized). */
  getRoutineStore(): import("@fusion/core").RoutineStore | undefined {
    return this.runtime.getRoutineStore();
  }

  /** Get the RoutineRunner (if initialized). */
  getRoutineRunner(): RoutineRunner | undefined {
    return this.runtime.getRoutineRunner();
  }

  /** Get the HeartbeatTriggerScheduler from the underlying runtime, if initialized. */
  getHeartbeatTriggerScheduler(): HeartbeatTriggerScheduler | undefined {
    return this.runtime.getTriggerScheduler();
  }

  /**
   * Enqueue a task ID for auto-merge if it is not already queued or active.
   * Exposed publicly so callers can integrate the engine's merge queue with
   * an external `onMerge` callback (e.g. dashboard's createServer call).
   */
  enqueueMerge(taskId: string): void {
    this.internalEnqueueMerge(taskId);
  }

  /**
   * Perform an AI-powered merge for a task, serialized through the merge queue.
   * This is the manual "merge now" path — it shares the same queue as auto-merge
   * so only one merge runs at a time per project.
   * Returns the full MergeResult so it can be used as the `onMerge` callback
   * in createServer().
   */
  async onMerge(taskId: string): Promise<MergeResult> {
    // If this task is already queued or actively merging, wait for the
    // existing merge to finish rather than starting a second one.
    if (this.mergeActive.has(taskId)) {
      return new Promise<MergeResult>((resolve, reject) => {
        this.manualMergeResolvers.set(taskId, { resolve, reject });
        // Don't re-enqueue — the task is already in the queue/active
      });
    }

    return new Promise<MergeResult>((resolve, reject) => {
      this.manualMergeResolvers.set(taskId, { resolve, reject });
      this.internalEnqueueMerge(taskId);
    });
  }

  // ── Merge eligibility helpers (richer logic from dashboard.ts) ──

  /**
   * True when a retry-exhausted task in "in-review" has a verification buffer
   * failure that can be auto-healed by resetting mergeRetries and re-running.
   */
  private hasAutoHealableVerificationBufferFailure(task: {
    mergeRetries?: number | null;
    column: string;
    error?: string | null;
    log?: Array<{ action?: string }>;
  }): boolean {
    if (task.column !== "in-review") return false;
    if ((task.mergeRetries ?? 0) < ProjectEngine.MAX_AUTO_MERGE_RETRIES) return false;
    const err = task.error ?? "";
    const matchesVerificationError =
      err.includes("Deterministic test verification failed") ||
      err.includes("Deterministic build verification failed") ||
      err.includes("Build verification failed") ||
      err.includes("Test verification failed");
    if (!matchesVerificationError) return false;

    return (
      task.log?.some(
        (entry) =>
          entry.action?.includes("[verification] test command failed (exit 0)") ||
          entry.action?.includes("[verification] build command failed (exit 0)") ||
          entry.action?.includes("output exceeded buffer"),
      ) ?? false
    );
  }

  /**
   * True when a retry-exhausted task has been idle long enough for a
   * 30-minute cooldown merge attempt.
   */
  private isRetryCooldownElapsed(task: { updatedAt?: string | null }): boolean {
    if (!task.updatedAt) return false;
    const updated = Date.parse(task.updatedAt);
    if (Number.isNaN(updated)) return false;
    return Date.now() - updated >= ProjectEngine.AUTO_MERGE_COOLDOWN_MS;
  }

  /**
   * Returns true if the task is eligible for auto-merge. Uses richer eligibility
   * checks: merge blocker, retry limit, auto-heal patterns, cooldown elapsed.
   */
  private canMergeTask(task: {
    id?: string;
    mergeRetries?: number | null;
    column: string;
    paused?: boolean;
    status?: string | null;
    error?: string | null;
    steps?: Array<{ status: string }>;
    workflowStepResults?: Array<{ status: string }>;
    log?: Array<{ action?: string }>;
    updatedAt?: string | null;
    mergeDetails?: { mergeConfirmed?: boolean } | null;
  }): boolean {
    // Already-confirmed merges always eligible — just need to move to done
    if (task.mergeDetails?.mergeConfirmed) return true;
    if (this.options.getTaskMergeBlocker?.(task as Task)) return false;
    return (
      (task.mergeRetries ?? 0) < ProjectEngine.MAX_AUTO_MERGE_RETRIES ||
      this.hasAutoHealableVerificationBufferFailure(task) ||
      this.isRetryCooldownElapsed(task)
    );
  }

  private internalEnqueueMerge(taskId: string): void {
    if (this.shuttingDown) return;
    if (this.mergeActive.has(taskId)) return;
    this.mergeActive.add(taskId);
    this.mergeQueue.push(taskId);
    void this.drainMergeQueue();
  }

  private async drainMergeQueue(): Promise<void> {
    if (this.mergeRunning) return;
    this.mergeRunning = true;

    try {
      const store = this.runtime.getTaskStore();
      const cwd = this.config.workingDirectory;

      while (this.mergeQueue.length > 0 && !this.shuttingDown) {
        const taskId = this.mergeQueue.shift()!;
        const manualResolver = this.manualMergeResolvers.get(taskId);
        try {
          // Manual merges (onMerge) skip auto-merge eligibility checks
          if (!manualResolver) {
            // Re-check autoMerge and pause before each merge
            const settings = await store.getSettings();
            if (settings.globalPause || settings.enginePaused) {
              runtimeLog.log(
                `Auto-merge skipping ${taskId} — ${settings.globalPause ? "global pause" : "engine paused"} active`,
              );
              continue;
            }
            if (!settings.autoMerge) {
              runtimeLog.log(`Auto-merge skipping ${taskId} — autoMerge disabled`);
              continue;
            }

            const task = await store.getTask(taskId);
            if (!task || task.column !== "in-review") {
              continue;
            }

            // Intentional cast to access Task properties needed by merge validation

            if (!this.canMergeTask(task as any)) {
              continue;
            }

            // Fast path: merge already confirmed (e.g. task was moved back to
            // in-review by auto-recovery after a successful merge) — just
            // complete the task without re-running the merge process.
            if (task.mergeDetails?.mergeConfirmed) {
              runtimeLog.log(
                `Auto-merge: ${taskId} already has mergeConfirmed — moving to done`,
              );
              await store.logEntry(
                taskId,
                "Merge already confirmed; completing task (recovered from post-merge state inconsistency)",
              );
              await store.updateTask(taskId, { status: null });
              await store.moveTask(taskId, "done");
              continue;
            }

            // Auto-heal verification buffer failures by resetting retry counter

            if (this.hasAutoHealableVerificationBufferFailure(task as any)) {
              await store.logEntry(
                taskId,
                "Auto-healing stale deterministic verification buffer failure; retrying merge verification",
              );
              await store.updateTask(taskId, { mergeRetries: 0, error: null, status: null });
            } else if (
              (task.mergeRetries ?? 0) >= ProjectEngine.MAX_AUTO_MERGE_RETRIES &&

              this.isRetryCooldownElapsed(task as any)
            ) {
              await store.logEntry(
                taskId,
                `Auto-merge retry cooldown elapsed (${Math.round(ProjectEngine.AUTO_MERGE_COOLDOWN_MS / 60000)}m idle); resetting retries for another attempt`,
              );
              await store.updateTask(taskId, { mergeRetries: 0 });
            }
          }

          const settings = await store.getSettings();

          // Cross-process guard: check if another process is already merging a
          // task for this project. The in-memory mergeQueue serializes within
          // this process, but multiple processes (e.g. dashboard + serve) share
          // the same SQLite database and can race.
          const activeMergingTask = store.getActiveMergingTask(taskId);
          if (activeMergingTask) {
            const retryMs = settings.pollIntervalMs ?? 15_000;
            runtimeLog.log(
              `Merge deferred for ${taskId} — ${activeMergingTask} is already merging (cross-process guard, retry in ${retryMs / 1000}s)`,
            );
            // Temporarily remove the manual resolver so the finally block
            // doesn't prematurely resolve it. The re-enqueue will restore it.
            if (manualResolver) {
              this.manualMergeResolvers.delete(taskId);
            }
            // Re-queue after the poll interval so we retry once the other merge finishes
            setTimeout(() => {
              if (this.shuttingDown) {
                manualResolver?.reject(new Error("Engine shutting down"));
                return;
              }
              if (manualResolver) {
                this.manualMergeResolvers.set(taskId, manualResolver);
              }
              this.internalEnqueueMerge(taskId);
            }, retryMs);
            continue;
          }

          const mergeStrategy = this.options.getMergeStrategy?.(settings) ?? "direct";

          if (mergeStrategy === "pull-request" && this.options.processPullRequestMerge) {
            runtimeLog.log(`${manualResolver ? "Manual" : "Auto"}-merge processing PR flow for ${taskId}...`);
            const result = await this.options.processPullRequestMerge(store, cwd, taskId);
            if (result === "merged") {
              runtimeLog.log(`${manualResolver ? "Manual" : "Auto"}-merge PR merged: ${taskId}`);
            } else if (result === "waiting") {
              runtimeLog.log(`${manualResolver ? "Manual" : "Auto"}-merge PR waiting: ${taskId}`);
            }
            if (manualResolver) {
              // PR merge path doesn't produce a full MergeResult — fetch the task
              // and construct one so the dashboard endpoint can respond.
              const prTask = await store.getTask(taskId).catch(() => null);
              this.manualMergeResolvers.delete(taskId);
              manualResolver.resolve({
                task: prTask!,
                branch: prTask?.branch ?? "",
                merged: result === "merged",
                worktreeRemoved: false,
                branchDeleted: false,
              } as MergeResult);
            }
          } else {
            // Direct merge via AI agent, gated by semaphore
            runtimeLog.log(`${manualResolver ? "Manual" : "Auto"}-merge merging ${taskId}...`);

            const semaphore = (this.runtime as any).globalSemaphore;

            const pool = (this.runtime as any).worktreePool;

            const agentStore = (this.runtime as any).agentStore;

            const usageLimitPauser = (this.runtime as any).usageLimitPauser;

            const rawMerge = () => {
              this.mergeAbortController = new AbortController();
              return aiMergeTask(store, cwd, taskId, {
                pool,
                usageLimitPauser,
                agentStore,
                signal: this.mergeAbortController.signal,
                onSession: (session) => {
                  this.activeMergeSession = session;
                },
              });
            };

            let result: MergeResult;
            if (semaphore) {
              result = await semaphore.run(rawMerge, PRIORITY_MERGE);
            } else {
              result = await rawMerge();
            }

            this.activeMergeSession = null;
            runtimeLog.log(`${manualResolver ? "Manual" : "Auto"}-merge merged: ${taskId}`);

            if (manualResolver) {
              this.manualMergeResolvers.delete(taskId);
              manualResolver.resolve(result);
            }

            // Reset retries on success
            const latestTask = await store.getTask(taskId).catch(() => null);
            if (latestTask?.mergeRetries && latestTask.mergeRetries > 0) {
              await store.updateTask(taskId, { mergeRetries: 0 });
            }
          }
        } catch (err: unknown) {
          this.activeMergeSession = null;
          const errorMsg = err instanceof Error ? err.message : String(err);
          const mergeWasAborted = err instanceof Error && err.name === "MergeAbortedError";

          if (mergeWasAborted) {
            runtimeLog.log(`${manualResolver ? "Manual" : "Auto"}-merge aborted for ${taskId}: ${errorMsg}`);
            this.mergeAbortController = null;
            if (manualResolver) {
              this.manualMergeResolvers.delete(taskId);
              manualResolver.reject(err instanceof Error ? err : new Error(errorMsg));
            } else {
              await store.updateTask(taskId, { status: null }).catch(() => undefined);
            }
            continue;
          }

          runtimeLog.error(`${manualResolver ? "Manual" : "Auto"}-merge failed for ${taskId}: ${errorMsg}`);

          // If this was a manual merge, reject the promise and skip auto-retry logic
          if (manualResolver) {
            this.manualMergeResolvers.delete(taskId);
            manualResolver.reject(err instanceof Error ? err : new Error(errorMsg));
            continue;
          }

          const settingsOnErr = await store
            .getSettings()
            .catch(() => ({ autoResolveConflicts: true }));
          const taskOnErr = await store.getTask(taskId).catch(() => null);
          const mergeStrategyOnErr =
            this.options.getMergeStrategy?.(settingsOnErr as Settings) ?? "direct";

          // Deterministic verification failure: move back to in-progress
          const isVerificationError =
            err instanceof Error && err.name === "VerificationError" ||
            errorMsg.includes("Deterministic test verification failed") ||
            errorMsg.includes("Deterministic build verification failed");

          if (taskOnErr && isVerificationError) {
            const failedKind = errorMsg.includes("build verification") ? "build" : "test";
            try {
              await store.addTaskComment(
                taskId,
                `Deterministic ${failedKind} verification failed during merge. ` +
                  `See the prior [verification] log entry for the truncated command output. ` +
                  `Please fix the failing ${failedKind} and push the update so the merge can retry.`,
                "agent",
              );
              await store.updateTask(taskId, { status: null, mergeRetries: 0, error: null });
              await store.moveTask(taskId, "in-progress");
              await store.logEntry(
                taskId,
                `Deterministic ${failedKind} verification failed — moved back to in-progress for remediation`,
              );
              runtimeLog.log(
                `Auto-merge: ${taskId} deterministic ${failedKind} verification failed — moved to in-progress`,
              );
            } catch {
              runtimeLog.error(
                `Auto-merge: failed to return ${taskId} to in-progress after verification failure`,
              );
            }
            continue;
          }

          if (mergeStrategyOnErr === "direct") {
            const isConflictError =
              errorMsg.includes("conflict") || errorMsg.includes("Conflict");

            if (taskOnErr && isConflictError) {
              const currentRetries = taskOnErr.mergeRetries ?? 0;

              if (
                (settingsOnErr as Settings).autoResolveConflicts !== false &&
                currentRetries < ProjectEngine.MAX_AUTO_MERGE_RETRIES
              ) {
                const newRetryCount = currentRetries + 1;
                await store.updateTask(taskId, { mergeRetries: newRetryCount, status: null });

                // Exponential backoff: 5s, 10s, 20s
                const delayMs = 5000 * Math.pow(2, currentRetries);
                runtimeLog.log(
                  `Auto-merge conflict retry ${newRetryCount}/${ProjectEngine.MAX_AUTO_MERGE_RETRIES} for ${taskId} in ${delayMs / 1000}s`,
                );
                setTimeout(() => {
                  if (!this.shuttingDown) this.internalEnqueueMerge(taskId);
                }, delayMs);
              } else {
                // Max retries exceeded or auto-resolve disabled
                try {
                  await store.updateTask(taskId, { status: null });
                } catch (recoveryErr) {
                  runtimeLog.error(
                    `Auto-merge: failed to clear status on ${taskId} after max retries exceeded: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`,
                  );
                }
              }
            } else {
              // Non-conflict error — stop retrying until user intervenes
              try {
                await store.updateTask(taskId, {
                  status: null,
                  mergeRetries: ProjectEngine.MAX_AUTO_MERGE_RETRIES,
                  error: errorMsg,
                });
              } catch (recoveryErr) {
                runtimeLog.error(
                  `Auto-merge: failed to update ${taskId} after non-conflict error: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`,
                );
              }
            }
          } else {
            try {
              await store.updateTask(taskId, {
                status: null,
                mergeRetries: ProjectEngine.MAX_AUTO_MERGE_RETRIES,
                error: errorMsg,
              });
            } catch (recoveryErr) {
              runtimeLog.error(
                `Auto-merge: failed to update ${taskId} after merge strategy error: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`,
              );
            }
          }
        } finally {
          this.mergeAbortController = null;
          this.mergeActive.delete(taskId);
          // If a manual merge was requested while this task was already in-flight,
          // the resolver was set but not consumed above. Resolve it now.
          const lateResolver = this.manualMergeResolvers.get(taskId);
          if (lateResolver) {
            this.manualMergeResolvers.delete(taskId);
            const finalTask = await store.getTask(taskId).catch(() => null);
            lateResolver.resolve({
              task: finalTask!,
              branch: finalTask?.branch ?? "",
              merged: finalTask?.column === "done",
              worktreeRemoved: false,
              branchDeleted: false,
            } as MergeResult);
          }
        }
      }
    } finally {
      this.mergeRunning = false;
    }
  }

  private wireAutoMerge(store: TaskStore, _cwd: string): void {
    this.taskMovedHandler = async ({ task, to }: { task: Task; to: string }) => {
      if (to !== "in-review") return;
      if (this.options.getTaskMergeBlocker?.(task)) return;
      try {
        const settings = await store.getSettings();
        if (settings.globalPause || settings.enginePaused) return;
        if (!settings.autoMerge) return;
        this.internalEnqueueMerge(task.id);
      } catch (err: unknown) {
        runtimeLog.warn(
          `Auto-merge: failed to read settings for task:moved on ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    store.on("task:moved", this.taskMovedHandler);
  }

  private async startupMergeSweep(store: TaskStore): Promise<void> {
    try {
      const tasks = await store.listTasks({ column: "in-review" });

      // Clear stale "merging"/"merging-pr" statuses left by a prior crash.
      // No merge is actually running at startup, so any task still marked
      // as merging is a leftover from a previous engine lifecycle.
      // This runs unconditionally (regardless of autoMerge setting) because
      // stale statuses block manual merges too.
      const staleStatuses = new Set(["merging", "merging-pr"]);
      for (const t of tasks) {
        if (t.status && staleStatuses.has(t.status)) {
          runtimeLog.log(`Startup sweep: clearing stale '${t.status}' status on ${t.id}`);
          await store.updateTask(t.id, { status: null });
          // Update in-memory object so canMergeTask sees the cleared status

          (t as any).status = null;
        }
      }

      const settings = await store.getSettings();
      if (!settings.autoMerge) return;


      const eligible = tasks.filter((t) => this.canMergeTask(t as any));
      if (eligible.length > 0) {
        runtimeLog.log(`Auto-merge startup sweep: enqueueing ${eligible.length} task(s)`);
        for (const t of eligible) {
          this.internalEnqueueMerge(t.id);
        }
      }
    } catch (err: unknown) {
      runtimeLog.warn(
        `Auto-merge startup sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleMergeRetry(store: TaskStore): void {
    if (this.shuttingDown) return;

    const schedule = async () => {
      if (this.shuttingDown) return;

      try {
        const settings = await store.getSettings();
        if (!settings.globalPause && !settings.enginePaused && settings.autoMerge) {
          const tasks = await store.listTasks({ column: "in-review" });
          for (const t of tasks) {

            if (this.canMergeTask(t as any)) {
              this.internalEnqueueMerge(t.id);
            }
          }
        }
      } catch (err: unknown) {
        runtimeLog.warn(
          `Auto-merge periodic sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!this.shuttingDown) {
        const interval = await store
          .getSettings()
          .then((s) => s.pollIntervalMs ?? 15_000)
          .catch((err: unknown) => {
            runtimeLog.warn(
              `Auto-merge retry: failed to read pollIntervalMs, using default 15s: ${err instanceof Error ? err.message : String(err)}`,
            );
            return 15_000;
          });
        this.mergeRetryTimer = setTimeout(() => void schedule(), interval);
      }
    };

    // Kick off the first sweep after a delay
    this.mergeRetryTimer = setTimeout(() => void schedule(), 15_000);
  }

  // ── Settings event listeners ──

  private wireSettingsListeners(store: TaskStore): void {
    // 1. Global pause — terminate active merge session
    const onGlobalPause = ({ settings, previous }: { settings: Settings; previous: Settings }) => {
      if (settings.globalPause && !previous.globalPause) {
        if (this.activeMergeSession) {
          runtimeLog.log("Global pause — terminating active merge session");
          this.activeMergeSession.dispose();
          this.activeMergeSession = null;
        }
      }
    };
    store.on("settings:updated", onGlobalPause);
    this.settingsHandlers.push(onGlobalPause);

    // 2. Global unpause — resume orphaned tasks + sweep in-review
    const onGlobalUnpause = async ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      if (prev.globalPause && !s.globalPause) {
        runtimeLog.log("Global unpause — resuming agentic activity");

        try {

          const executor = (this.runtime as any).executor;
          executor?.resumeOrphaned?.().catch((err: Error) =>
            runtimeLog.error("Failed to resume orphaned tasks on unpause:", err),
          );
        } catch (err: unknown) {
          runtimeLog.warn(
            `Global unpause: failed to dispatch resumeOrphaned: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (s.autoMerge) {
          try {
            const tasks = await store.listTasks({ column: "in-review" });
            for (const t of tasks) {

              if (this.canMergeTask(t as any)) {
                this.internalEnqueueMerge(t.id);
              }
            }
          } catch (err: unknown) {
            runtimeLog.warn(
              `Global unpause: failed to scan in-review tasks for auto-merge: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    };
    store.on("settings:updated", onGlobalUnpause);
    this.settingsHandlers.push(onGlobalUnpause);

    // 3. Engine unpause — same as global unpause
    const onEngineUnpause = async ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      if (prev.enginePaused && !s.enginePaused) {
        runtimeLog.log("Engine unpaused — resuming agentic activity");

        try {

          const executor = (this.runtime as any).executor;
          executor?.resumeOrphaned?.().catch((err: Error) =>
            runtimeLog.error("Failed to resume orphaned tasks on engine unpause:", err),
          );
        } catch (err: unknown) {
          runtimeLog.warn(
            `Engine unpause: failed to dispatch resumeOrphaned: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (s.autoMerge) {
          try {
            const tasks = await store.listTasks({ column: "in-review" });
            for (const t of tasks) {

              if (this.canMergeTask(t as any)) {
                this.internalEnqueueMerge(t.id);
              }
            }
          } catch (err: unknown) {
            runtimeLog.warn(
              `Engine unpause: failed to scan in-review tasks for auto-merge: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    };
    store.on("settings:updated", onEngineUnpause);
    this.settingsHandlers.push(onEngineUnpause);

    // 4. Stuck task timeout change — trigger immediate check
    const onStuckTimeoutChange = async ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      if (s.taskStuckTimeoutMs !== prev.taskStuckTimeoutMs) {
        runtimeLog.log(
          `Stuck task timeout changed to ${s.taskStuckTimeoutMs}ms — running immediate check`,
        );
        try {

          const detector = (this.runtime as any).stuckTaskDetector;
          await detector?.checkNow?.();
        } catch (err: unknown) {
          runtimeLog.warn(
            `Stuck-timeout change: detector.checkNow() failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    store.on("settings:updated", onStuckTimeoutChange);
    this.settingsHandlers.push(onStuckTimeoutChange);

    // 5. Memory maintenance settings change — sync automations
    const onInsightSettingsChange = async ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      const insightKeys = [
        "insightExtractionEnabled",
        "insightExtractionSchedule",
        "insightExtractionMinIntervalMs",
      ] as const;
      const dreamKeys = [
        "memoryDreamsEnabled",
        "memoryDreamsSchedule",
      ] as const;


      const changed = insightKeys.some((key) => (s as any)[key] !== (prev as any)[key]);

      const dreamsChanged = dreamKeys.some((key) => (s as any)[key] !== (prev as any)[key]);
      if ((!changed && !dreamsChanged) || !this.automationStore) return;

      try {
        const { syncInsightExtractionAutomation, syncMemoryDreamsAutomation } = await import("@fusion/core");
        if (changed && typeof syncInsightExtractionAutomation === "function") {
          await syncInsightExtractionAutomation(this.automationStore, s);
          runtimeLog.log("Insight extraction automation synced with settings");
        }
        if (dreamsChanged && typeof syncMemoryDreamsAutomation === "function") {
          await syncMemoryDreamsAutomation(this.automationStore, s);
          runtimeLog.log("Memory dreams automation synced with settings");
        }
      } catch (err) {
        runtimeLog.warn(
          "Failed to sync memory maintenance automation:",
          err instanceof Error ? err.message : err,
        );
      }
    };
    store.on("settings:updated", onInsightSettingsChange);
    this.settingsHandlers.push(onInsightSettingsChange);

    // 6. Auto-summarize settings change — sync automation
    const onAutoSummarizeSettingsChange = async ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      const autoSummarizeKeys = [
        "memoryAutoSummarizeEnabled",
        "memoryAutoSummarizeThresholdChars",
        "memoryAutoSummarizeSchedule",
      ] as const;


      const changed = autoSummarizeKeys.some((key) => (s as any)[key] !== (prev as any)[key]);
      if (!changed || !this.automationStore) return;

      try {
        const { syncAutoSummarizeAutomation } = await import("@fusion/core");
        if (typeof syncAutoSummarizeAutomation === "function") {
          await syncAutoSummarizeAutomation(this.automationStore, s);
          runtimeLog.log("Auto-summarize automation synced with settings");
        }
      } catch (err) {
        runtimeLog.warn(
          "Failed to sync auto-summarize automation:",
          err instanceof Error ? err.message : err,
        );
      }
    };
    store.on("settings:updated", onAutoSummarizeSettingsChange);
    this.settingsHandlers.push(onAutoSummarizeSettingsChange);
  }

  /**
   * Build the onScheduleRunProcessed callback for CronRunner.
   * Chains the built-in processAndAuditInsightExtraction with any
   * caller-provided onInsightRunProcessed callback.
   */
  private buildInsightRunHandler(
    cwd: string,
  ): (schedule: ScheduledTask, result: AutomationRunResult) => Promise<void> {
    const callerCallback = this.options.onInsightRunProcessed;

    return async (schedule: ScheduledTask, result: AutomationRunResult): Promise<void> => {
      // Invoke caller-provided callback first (e.g. for test hooks)
      if (callerCallback) {
        try {
          await callerCallback(schedule, result);
        } catch (err) {
          runtimeLog.warn(
            "onInsightRunProcessed callback error:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      // Run built-in processAndAuditInsightExtraction
      try {
        const { INSIGHT_EXTRACTION_SCHEDULE_NAME, processAndAuditInsightExtraction } =
          await import("@fusion/core");

        if (
          typeof INSIGHT_EXTRACTION_SCHEDULE_NAME !== "string" ||
          typeof processAndAuditInsightExtraction !== "function"
        ) {
          return;
        }

        if (schedule.name !== INSIGHT_EXTRACTION_SCHEDULE_NAME) {
          return;
        }

        const stepResults = result.stepResults ?? [];
        const aiStep = stepResults.find(
          (sr) =>
            sr.stepName === "Extract Memory Insights and Prune" ||
            sr.stepName === "Extract Memory Insights",
        );

        if (!aiStep) {
          runtimeLog.log(`No insight extraction step found in ${schedule.name} result`);
          return;
        }

        runtimeLog.log("Processing memory insight extraction run...");

        const auditReport = await processAndAuditInsightExtraction(cwd, {
          rawResponse: aiStep.output ?? "",
          stepSuccess: aiStep.success,
          runAt: result.startedAt,
          error: aiStep.error,
        });

        const pruneStatus = auditReport.pruning.applied
          ? ` | Pruned: ${auditReport.pruning.originalSize} -> ${auditReport.pruning.newSize} chars`
          : ` | Pruning: ${auditReport.pruning.reason}`;

        runtimeLog.log(
          `Memory audit complete — Health: ${auditReport.health}, ` +
            `Insights: ${auditReport.insightsMemory.insightCount}${pruneStatus}`,
        );
      } catch (err) {
        runtimeLog.warn(
          "Failed to process insight extraction:",
          err instanceof Error ? err.message : err,
        );
      }
    };
  }
}
