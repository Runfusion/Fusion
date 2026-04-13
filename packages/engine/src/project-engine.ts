import type {
  TaskStore,
  Task,
  CentralCore,
  Settings,
  AutomationStore as AutomationStoreType,
} from "@fusion/core";
import { InProcessRuntime } from "./runtimes/in-process-runtime.js";
import type { ProjectRuntimeConfig } from "./project-runtime.js";
import { PrMonitor } from "./pr-monitor.js";
import { PrCommentHandler } from "./pr-comment-handler.js";
import { NtfyNotifier } from "./notifier.js";
import { CronRunner, createAiPromptExecutor } from "./cron-runner.js";
import { aiMergeTask } from "./merger.js";
import { PRIORITY_MERGE } from "./concurrency.js";
import { runtimeLog } from "./logger.js";

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
  private mergeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  private static readonly MAX_AUTO_MERGE_RETRIES = 3;

  // Event handler references for cleanup
  private settingsHandlers: Array<(...args: any[]) => void> = [];
  private taskMovedHandler?: (...args: any[]) => void;

  constructor(
    private config: ProjectRuntimeConfig,
    centralCore: CentralCore,
    private options: ProjectEngineOptions = {},
  ) {
    this.runtime = new InProcessRuntime(config, centralCore);
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

    // 3. Initialize NtfyNotifier
    this.notifier = new NtfyNotifier(store, {
      projectId: this.options.projectId,
      ntfyBaseUrl: this.options.ntfyBaseUrl,
    });
    await this.notifier.start();

    // 4. Initialize AutomationStore + CronRunner
    try {
      const { AutomationStore } = await import("@fusion/core");
      this.automationStore = new AutomationStore(cwd);
      await this.automationStore.init();

      const aiPromptExecutor = await createAiPromptExecutor(cwd);
      this.cronRunner = new CronRunner(store, this.automationStore, {
        aiPromptExecutor,
        onScheduleRunProcessed: this.options.onInsightRunProcessed as any,
      });

      // Sync insight extraction automation on startup
      try {
        const { syncInsightExtractionAutomation } = await import("@fusion/core");
        if (typeof syncInsightExtractionAutomation === "function") {
          const settings = await store.getSettings();
          await syncInsightExtractionAutomation(this.automationStore, settings);
        }
      } catch {
        // syncInsightExtractionAutomation may not be exported yet
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
   */
  async stop(): Promise<void> {
    this.shuttingDown = true;

    // Stop merge retry timer
    if (this.mergeRetryTimer) {
      clearTimeout(this.mergeRetryTimer);
      this.mergeRetryTimer = null;
    }

    // Terminate active merge session
    if (this.activeMergeSession) {
      this.activeMergeSession.dispose();
      this.activeMergeSession = null;
    }

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

  /** Get the PrMonitor (if initialized). */
  getPrMonitor(): PrMonitor | undefined {
    return this.prMonitor;
  }

  /** Get the CronRunner (if initialized). */
  getCronRunner(): CronRunner | undefined {
    return this.cronRunner;
  }

  // ── Auto-merge subsystem ──

  private canMergeTask(task: Task): boolean {
    const blocker = this.options.getTaskMergeBlocker?.(task);
    if (blocker) return false;
    return (task.mergeRetries ?? 0) < ProjectEngine.MAX_AUTO_MERGE_RETRIES;
  }

  private enqueueMerge(taskId: string): void {
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
        try {
          const task = await store.getTask(taskId);
          if (!task || task.column !== "in-review") {
            continue;
          }

          const settings = await store.getSettings();
          if (settings.globalPause || settings.enginePaused) break;

          const mergeStrategy = this.options.getMergeStrategy?.(settings) ?? "direct";

          if (mergeStrategy === "pull-request" && this.options.processPullRequestMerge) {
            runtimeLog.log(`Processing PR flow for ${taskId}...`);
            const result = await this.options.processPullRequestMerge(store, cwd, taskId);
            runtimeLog.log(`PR merge result for ${taskId}: ${result}`);
          } else {
            // Direct merge via AI agent, gated by semaphore
            runtimeLog.log(`Merging ${taskId}...`);
            const semaphore = (this.runtime as any).globalSemaphore;
            const pool = (this.runtime as any).worktreePool;
            const agentStore = (this.runtime as any).agentStore;
            const usageLimitPauser = (this.runtime as any).usageLimitPauser;

            const rawMerge = () =>
              aiMergeTask(store, cwd, taskId, {
                pool,
                usageLimitPauser,
                agentStore,
                onSession: (session) => {
                  this.activeMergeSession = session;
                },
              });

            if (semaphore) {
              await semaphore.run(rawMerge, PRIORITY_MERGE);
            } else {
              await rawMerge();
            }

            this.activeMergeSession = null;
            runtimeLog.log(`Merged ${taskId}`);

            // Reset retries on success
            if (task.mergeRetries && task.mergeRetries > 0) {
              await store.updateTask(taskId, { mergeRetries: 0 });
            }
          }
        } catch (err: any) {
          this.activeMergeSession = null;
          const errorMsg = err?.message ?? String(err);
          runtimeLog.error(`Merge failed for ${taskId}: ${errorMsg}`);

          // Conflict retry with exponential backoff
          const isConflictError =
            errorMsg.includes("conflict") || errorMsg.includes("Conflict");

          if (isConflictError) {
            try {
              const task = await store.getTask(taskId);
              const settings = await store.getSettings();
              if (
                task &&
                settings.autoResolveConflicts !== false &&
                (task.mergeRetries ?? 0) < ProjectEngine.MAX_AUTO_MERGE_RETRIES
              ) {
                const retryCount = (task.mergeRetries ?? 0) + 1;
                await store.updateTask(taskId, {
                  mergeRetries: retryCount,
                  status: null,
                });

                // Exponential backoff: 5s, 10s, 20s
                const delayMs = 5000 * Math.pow(2, (task.mergeRetries ?? 0));
                runtimeLog.log(
                  `Merge conflict retry ${retryCount}/${ProjectEngine.MAX_AUTO_MERGE_RETRIES} for ${taskId} in ${delayMs / 1000}s`,
                );

                setTimeout(() => {
                  if (!this.shuttingDown) this.enqueueMerge(taskId);
                }, delayMs);
              }
            } catch {
              // best-effort retry
            }
          }

          // Verification failure — move back to in-progress
          const isVerificationError =
            errorMsg.includes("Verification failed") ||
            errorMsg.includes("verification failed");

          if (isVerificationError && !isConflictError) {
            try {
              const task = await store.getTask(taskId);
              if (task?.column === "in-review") {
                await store.moveTask(taskId, "in-progress");
                runtimeLog.log(`Verification failure — ${taskId} moved back to in-progress`);
              }
            } catch {
              // best-effort
            }
          }
        } finally {
          this.mergeActive.delete(taskId);
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
        this.enqueueMerge(task.id);
      } catch {
        // ignore settings read errors
      }
    };
    store.on("task:moved", this.taskMovedHandler);
  }

  private async startupMergeSweep(store: TaskStore): Promise<void> {
    try {
      const settings = await store.getSettings();
      if (!settings.autoMerge) return;

      const tasks = await store.listTasks({ column: "in-review" });
      const eligible = tasks.filter((t) => this.canMergeTask(t));
      if (eligible.length > 0) {
        runtimeLog.log(`Auto-merge startup sweep: enqueueing ${eligible.length} task(s)`);
        for (const t of eligible) {
          this.enqueueMerge(t.id);
        }
      }
    } catch {
      // ignore startup sweep errors
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
            if (this.canMergeTask(t)) {
              this.enqueueMerge(t.id);
            }
          }
        }
      } catch {
        // ignore sweep errors
      }

      if (!this.shuttingDown) {
        const interval = await store
          .getSettings()
          .then((s) => s.pollIntervalMs ?? 15_000)
          .catch(() => 15_000);
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
    const onGlobalUnpause = async ({ settings: s, previous: prev }: { settings: Settings; previous: Settings }) => {
      if (prev.globalPause && !s.globalPause) {
        runtimeLog.log("Global unpause — resuming agentic activity");

        try {
          const executor = (this.runtime as any).executor;
          executor?.resumeOrphaned?.().catch((err: Error) =>
            runtimeLog.error("Failed to resume orphaned tasks on unpause:", err),
          );
        } catch { /* ignore */ }

        if (s.autoMerge) {
          try {
            const tasks = await store.listTasks({ column: "in-review" });
            for (const t of tasks) {
              if (this.canMergeTask(t)) {
                this.enqueueMerge(t.id);
              }
            }
          } catch { /* ignore */ }
        }
      }
    };
    store.on("settings:updated", onGlobalUnpause);
    this.settingsHandlers.push(onGlobalUnpause);

    // 3. Engine unpause — same as global unpause
    const onEngineUnpause = async ({ settings: s, previous: prev }: { settings: Settings; previous: Settings }) => {
      if (prev.enginePaused && !s.enginePaused) {
        runtimeLog.log("Engine unpaused — resuming agentic activity");

        try {
          const executor = (this.runtime as any).executor;
          executor?.resumeOrphaned?.().catch((err: Error) =>
            runtimeLog.error("Failed to resume orphaned tasks on engine unpause:", err),
          );
        } catch { /* ignore */ }

        if (s.autoMerge) {
          try {
            const tasks = await store.listTasks({ column: "in-review" });
            for (const t of tasks) {
              if (this.canMergeTask(t)) {
                this.enqueueMerge(t.id);
              }
            }
          } catch { /* ignore */ }
        }
      }
    };
    store.on("settings:updated", onEngineUnpause);
    this.settingsHandlers.push(onEngineUnpause);

    // 4. Stuck task timeout change — trigger immediate check
    const onStuckTimeoutChange = async ({ settings: s, previous: prev }: { settings: Settings; previous: Settings }) => {
      if (s.taskStuckTimeoutMs !== prev.taskStuckTimeoutMs) {
        runtimeLog.log(
          `Stuck task timeout changed to ${s.taskStuckTimeoutMs}ms — running immediate check`,
        );
        try {
          const detector = (this.runtime as any).stuckTaskDetector;
          await detector?.checkNow?.();
        } catch { /* ignore */ }
      }
    };
    store.on("settings:updated", onStuckTimeoutChange);
    this.settingsHandlers.push(onStuckTimeoutChange);

    // 5. Insight extraction settings change — sync automation
    const onInsightSettingsChange = async ({ settings: s, previous: prev }: { settings: Settings; previous: Settings }) => {
      const insightKeys = [
        "insightExtractionEnabled",
        "insightExtractionSchedule",
        "insightExtractionMinIntervalMs",
      ] as const;

      const changed = insightKeys.some(
        (key) => (s as any)[key] !== (prev as any)[key],
      );
      if (!changed || !this.automationStore) return;

      try {
        const { syncInsightExtractionAutomation } = await import("@fusion/core");
        if (typeof syncInsightExtractionAutomation === "function") {
          await syncInsightExtractionAutomation(this.automationStore, s);
          runtimeLog.log("Insight extraction automation synced with settings");
        }
      } catch (err) {
        runtimeLog.warn(
          "Failed to sync insight extraction automation:",
          err instanceof Error ? err.message : err,
        );
      }
    };
    store.on("settings:updated", onInsightSettingsChange);
    this.settingsHandlers.push(onInsightSettingsChange);
  }
}
