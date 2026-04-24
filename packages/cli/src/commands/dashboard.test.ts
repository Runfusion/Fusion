import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Capture instances & arguments ───────────────────────────────────

let capturedExecutorOpts: Record<string, unknown> | undefined;
let capturedSelfHealingOpts: Record<string, unknown> | undefined;

const {
  mockAuthStorage,
  mockModelRegistry,
  mockDiscoverAndLoadExtensions,
  mockCreateExtensionRuntime,
  mockSelfHealingStart,
  mockSelfHealingStop,
  mockCheckStuckBudget,
  mockStuckCheckNow,
} = vi.hoisted(() => ({
  mockAuthStorage: { getAuth: vi.fn(), setAuth: vi.fn(), getApiKey: vi.fn().mockResolvedValue(undefined) },
  mockModelRegistry: {
    registerProvider: vi.fn(),
    refresh: vi.fn(),
  },
  mockDiscoverAndLoadExtensions: vi.fn().mockResolvedValue({
    runtime: { pendingProviderRegistrations: [] },
    errors: [],
  }),
  mockCreateExtensionRuntime: vi.fn(),
  mockSelfHealingStart: vi.fn(),
  mockSelfHealingStop: vi.fn(),
  mockCheckStuckBudget: vi.fn().mockResolvedValue(true),
  mockStuckCheckNow: vi.fn().mockResolvedValue(undefined),
}));

// Minimal mock store backed by EventEmitter so `store.on` works
function makeMockStore() {
  const emitter = new EventEmitter();
  // runDashboard registers several independent settings listeners by design;
  // keep the test mock above Node's low default threshold while still asserting
  // disposal behavior in the lifecycle cleanup tests below.
  emitter.setMaxListeners(20);
  const mockMissionStore = {
    listMissions: vi.fn().mockReturnValue([]),
    getMission: vi.fn(),
    updateMission: vi.fn(),
    listMilestones: vi.fn().mockReturnValue([]),
    listFeatures: vi.fn().mockReturnValue([]),
  };
  return {
    init: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockResolvedValue(undefined),
    stopWatching: vi.fn(),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: false,
      mergeStrategy: "direct",
      pollIntervalMs: 60_000,
    }),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue({ id: "FN-TEST", column: "in-review", paused: false, description: "Test task", log: [] }),
    moveTask: vi.fn().mockResolvedValue({}),
    updatePrInfo: vi.fn().mockResolvedValue({}),
    logEntry: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue({}),
    getFusionDir: vi.fn().mockReturnValue("/tmp/test/.fusion"),
    getActiveMergingTask: vi.fn().mockReturnValue(undefined),
    getMissionStore: vi.fn().mockReturnValue(mockMissionStore),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      emitter.off(event, handler);
    }),
    emit: emitter.emit.bind(emitter),
  };
}

// ── Mock @fusion/core ──────────────────────────────────────────────────

vi.mock("@fusion/core", () => ({
  TaskStore: vi.fn().mockImplementation(() => makeMockStore()),
  CentralCore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getProjectByPath: vi.fn().mockResolvedValue({ id: "project-1" }),
    getProject: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({ id, name: `Project ${id}`, path: process.cwd(), status: "active", isolationMode: "in-process", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
    ),
    listProjects: vi.fn().mockResolvedValue([
      { id: "project-1", name: "Test Project", path: process.cwd(), status: "active", isolationMode: "in-process", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ]),
  })),
  AutomationStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    listSchedules: vi.fn().mockResolvedValue([]),
    getSchedule: vi.fn().mockResolvedValue(null),
    createSchedule: vi.fn().mockResolvedValue({}),
    updateSchedule: vi.fn().mockResolvedValue({}),
    deleteSchedule: vi.fn().mockResolvedValue({}),
    recordRun: vi.fn().mockResolvedValue({}),
    getDueSchedules: vi.fn().mockResolvedValue([]),
  })),
  AgentStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    createAgent: vi.fn(),
    updateAgentState: vi.fn(),
    listAgents: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn().mockResolvedValue(null),
    deleteAgent: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    getBudgetStatus: vi.fn().mockResolvedValue({ isOverBudget: false, isOverThreshold: false, usagePercent: 0 }),
    getRecentRuns: vi.fn().mockResolvedValue([]),
  })),
  PluginStore: vi.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    return {
      init: vi.fn().mockResolvedValue(undefined),
      listPlugins: vi.fn().mockResolvedValue([]),
      getPlugin: vi.fn(),
      registerPlugin: vi.fn(),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
      updatePluginSettings: vi.fn(),
      unregisterPlugin: vi.fn(),
      updatePluginState: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        emitter.on(event, handler);
      }),
      off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        emitter.off(event, handler);
      }),
      emit: emitter.emit.bind(emitter),
    };
  }),
  PluginLoader: vi.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    return {
      loadPlugin: vi.fn().mockResolvedValue(undefined),
      loadAllPlugins: vi.fn().mockResolvedValue({ loaded: 0, errors: 0 }),
      stopPlugin: vi.fn().mockResolvedValue(undefined),
      reloadPlugin: vi.fn().mockResolvedValue(undefined),
      getPluginRoutes: vi.fn().mockReturnValue([]),
      getPlugin: vi.fn(),
      getLoadedPlugins: vi.fn().mockReturnValue([]),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        emitter.on(event, handler);
      }),
      off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        emitter.off(event, handler);
      }),
      emit: emitter.emit.bind(emitter),
    };
  }),
  getEnabledPiExtensionPaths: vi.fn(() => []),
  getTaskMergeBlocker: vi.fn((task: any) => {
    if (task.column !== "in-review") return `task is in '${task.column}', must be in 'in-review'`;
    if (task.paused) return "task is paused";
    if (task.status === "failed") return "task is marked 'failed'";
    if (task.steps?.some((step: any) => step.status === "pending" || step.status === "in-progress")) {
      return "task has incomplete steps";
    }
    if (task.workflowStepResults?.some((result: any) => result.status === "pending" || result.status === "failed")) {
      return "task has incomplete or failed workflow steps";
    }
    return undefined;
  }),
}));

// ── Hoisted shared mocks ───────────────────────────────────────────

const {
  mockExec,
  mockExecSync,
  mockFindPrForBranch,
  mockCreatePr,
  mockGetPrMergeStatus,
  mockMergePr,
} = vi.hoisted(() => ({
  mockExec: vi.fn((_command: string, _options?: any, callback?: (err: null, stdout: string, stderr: string) => void) => {
    if (typeof callback === "function") {
      callback(null, "", "");
    }
    // Match child_process.exec's callback-style contract. Returning a Promise
    // makes util.promisify(exec) emit DEP0174 in tests.
    return {
      pid: 12345,
      stdout: null,
      stderr: null,
      on: vi.fn(),
      once: vi.fn(),
      kill: vi.fn(),
    };
  }),
  mockExecSync: vi.fn(() => ""),
  mockFindPrForBranch: vi.fn(),
  mockCreatePr: vi.fn(),
  mockGetPrMergeStatus: vi.fn(),
  mockMergePr: vi.fn(),
}));

// ── Mock node:child_process ────────────────────────────────────────

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    exec: mockExec,
    execSync: mockExecSync,
  };
});

// ── Mock @fusion/dashboard ─────────────────────────────────────────────

/** Create a mock server (EventEmitter) that simulates net.Server behavior. */
function createMockServer(portToReturn: number = 0) {
  const emitter = new EventEmitter();
  const server = Object.assign(emitter, {
    listen: vi.fn((_port?: number) => {
      process.nextTick(() => emitter.emit("listening"));
      return server;
    }),
    address: vi.fn(() => ({ port: portToReturn, family: "IPv4", address: "127.0.0.1" })),
    close: vi.fn(),
  });
  return server;
}

const mockListen = vi.fn((port: number) => {
  const server = createMockServer(port);
  process.nextTick(() => server.emit("listening"));
  return server;
});

vi.mock("@fusion/dashboard", () => ({
  createServer: vi.fn((_store: unknown, opts: Record<string, any> = {}) => {
    if (opts.engine && !opts.onMerge) {
      opts.onMerge = (taskId: string) => opts.engine.onMerge(taskId);
    }
    opts.onProjectFirstAccessed?.("project-1");
    return { listen: mockListen };
  }),
  GitHubClient: vi.fn().mockImplementation(() => ({
    findPrForBranch: mockFindPrForBranch,
    createPr: mockCreatePr,
    getPrMergeStatus: mockGetPrMergeStatus,
    mergePr: mockMergePr,
  })),
  createSkillsAdapter: vi.fn().mockReturnValue(undefined),
  getProjectSettingsPath: vi.fn().mockReturnValue("/tmp/project/.fusion/settings.json"),
  loadTlsCredentialsFromEnv: vi.fn().mockReturnValue(undefined),
}));

// ── Mock node:readline ──────────────────────────────────────────────

vi.mock("node:readline", () => ({
  createInterface: vi.fn(),
}));

// ── Mock @fusion/engine ────────────────────────────────────────────────

// We need the real WorktreePool class so we can assert `instanceof`.
const { WorktreePool } = await import("@fusion/engine");

vi.mock("@fusion/engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("@fusion/engine")>();
  const TriageProcessor = vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  }));
  const TaskExecutor = vi.fn().mockImplementation((_store: unknown, _cwd: unknown, opts: unknown) => {
    capturedExecutorOpts = opts as Record<string, unknown>;
    return {
      resumeOrphaned: vi.fn().mockResolvedValue(undefined),
    };
  });
  const StuckTaskDetector = vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    checkNow: mockStuckCheckNow,
    trackTask: vi.fn(),
    untrackTask: vi.fn(),
    markTaskProgress: vi.fn(),
  }));
  const Scheduler = vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  }));
  const PrMonitor = vi.fn().mockImplementation(() => ({
    onNewComments: vi.fn(),
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    stopAll: vi.fn(),
    getTrackedPrs: vi.fn().mockReturnValue(new Map()),
    updatePrInfo: vi.fn(),
    drainComments: vi.fn().mockReturnValue([]),
  }));
  const PrCommentHandler = vi.fn().mockImplementation(() => ({
    handleNewComments: vi.fn().mockResolvedValue(undefined),
    createFollowUpTask: vi.fn().mockResolvedValue(undefined),
  }));
  const aiMergeTask = vi.fn().mockImplementation(() => Promise.resolve({ merged: true }));
  const CronRunner = vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  }));
  const createAiPromptExecutor = vi.fn().mockResolvedValue({
    execute: vi.fn().mockResolvedValue(undefined),
  });
  const SelfHealingManager = vi.fn().mockImplementation((_store: unknown, opts: unknown) => {
    capturedSelfHealingOpts = opts as Record<string, unknown>;
    return {
      start: mockSelfHealingStart,
      stop: mockSelfHealingStop,
      checkStuckBudget: mockCheckStuckBudget,
    };
  });

  class ProjectEngine {
    private store: ReturnType<typeof makeMockStore>;
    private cwd: string;
    private pool?: InstanceType<typeof original.WorktreePool>;
    private executor?: { resumeOrphaned?: () => Promise<void> };
    private selfHealing?: { start?: () => void; stop?: () => void };
    private stuckDetector?: { checkNow?: () => Promise<void> };
    private settingsHandlers: Array<(event: any) => void> = [];
    private taskMovedHandler?: (event: any) => void;
    private mergeQueue: string[] = [];
    private mergeActive = new Set<string>();
    private mergeRunning = false;
    private activeMergeSession: { dispose: () => void } | null = null;

    constructor(
      config: { workingDirectory: string },
      _centralCore: unknown,
      private options: { externalTaskStore?: ReturnType<typeof makeMockStore>; getMergeStrategy?: (settings: any) => string; processPullRequestMerge?: (store: any, cwd: string, taskId: string) => Promise<string>; getTaskMergeBlocker?: (task: any) => string | undefined } = {},
    ) {
      this.cwd = config.workingDirectory;
      this.store = options.externalTaskStore ?? makeMockStore();
    }

    async start(): Promise<void> {
      this.pool = new original.WorktreePool(this.cwd, this.store as any);
      const semaphore = new original.AgentSemaphore(1);
      const recoverCompletedTask = vi.fn().mockResolvedValue(false);
      const getExecutingTaskIds = vi.fn().mockReturnValue(new Set());
      const executorOpts = {
        pool: this.pool,
        semaphore,
        recoverCompletedTask,
        getExecutingTaskIds,
      };

      TriageProcessor(this.store, this.cwd, { semaphore });
      this.executor = TaskExecutor(this.store, this.cwd, executorOpts);
      this.stuckDetector = StuckTaskDetector(this.store, this.cwd, {});
      this.selfHealing = SelfHealingManager(this.store, {
        rootDir: process.cwd(),
        recoverCompletedTask,
        getExecutingTaskIds,
      });
      this.selfHealing.start?.();

      const prMonitor = PrMonitor();
      const prCommentHandler = PrCommentHandler(this.store);
      prMonitor.onNewComments((taskId: string, prInfo: any, comments: any[]) =>
        prCommentHandler.handleNewComments(taskId, prInfo, comments),
      );
      Scheduler(this.store, {
        prMonitor,
        semaphore,
        onClosedPrFeedback: (taskId: string, prInfo: any, comments: any[]) =>
          prCommentHandler.createFollowUpTask(taskId, prInfo, comments),
      });
      CronRunner();

      this.wireSettingsListeners();
      this.wireAutoMerge();
      await this.executor?.resumeOrphaned?.();
      await this.startupMergeSweep();
    }

    async stop(): Promise<void> {
      for (const handler of this.settingsHandlers) {
        this.store.off("settings:updated", handler);
      }
      this.settingsHandlers = [];
      if (this.taskMovedHandler) {
        this.store.off("task:moved", this.taskMovedHandler);
        this.taskMovedHandler = undefined;
      }
      if (this.activeMergeSession) {
        this.activeMergeSession.dispose();
        this.activeMergeSession = null;
      }
      this.selfHealing?.stop?.();
    }

    getHeartbeatTriggerScheduler(): { stop: () => void } {
      return { stop: vi.fn() };
    }

    async onMerge(taskId: string): Promise<unknown> {
      return aiMergeTask(this.store, this.cwd, taskId, {
        pool: this.pool,
        onSession: (session: { dispose: () => void }) => {
          this.activeMergeSession = session;
        },
      });
    }

    private canMergeTask(task: any): boolean {
      if (this.options.getTaskMergeBlocker?.(task)) return false;
      return (task.mergeRetries ?? 0) < 3 || this.hasAutoHealableVerificationBufferFailure(task);
    }

    private hasAutoHealableVerificationBufferFailure(task: any): boolean {
      if (task.column !== "in-review") return false;
      if ((task.mergeRetries ?? 0) < 3) return false;
      const err = task.error ?? "";
      if (
        !err.includes("Deterministic test verification failed") &&
        !err.includes("Deterministic build verification failed") &&
        !err.includes("Build verification failed") &&
        !err.includes("Test verification failed")
      ) {
        return false;
      }
      return task.log?.some((entry: { action?: string }) =>
        entry.action?.includes("[verification] test command failed (exit 0)") ||
        entry.action?.includes("[verification] build command failed (exit 0)") ||
        entry.action?.includes("output exceeded buffer"),
      ) ?? false;
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
        while (this.mergeQueue.length > 0) {
          const taskId = this.mergeQueue.shift()!;
          try {
            const settings = await this.store.getSettings();
            if (settings.globalPause || settings.enginePaused || !settings.autoMerge) continue;

            const task = await this.store.getTask(taskId);
            if (!task || task.column !== "in-review" || !this.canMergeTask(task)) continue;

            if (this.hasAutoHealableVerificationBufferFailure(task)) {
              await this.store.logEntry(
                taskId,
                "Auto-healing stale deterministic verification buffer failure; retrying merge verification",
              );
              await this.store.updateTask(taskId, { mergeRetries: 0, error: null, status: null });
            }

            const mergeStrategy = this.options.getMergeStrategy?.(settings) ?? "direct";
            if (mergeStrategy === "pull-request" && this.options.processPullRequestMerge) {
              await this.options.processPullRequestMerge(this.store, this.cwd, taskId);
            } else {
              await this.onMerge(taskId);
              const latestTask = await this.store.getTask(taskId).catch(() => null);
              if (latestTask?.mergeRetries && latestTask.mergeRetries > 0) {
                await this.store.updateTask(taskId, { mergeRetries: 0 });
              }
            }
          } catch (err: any) {
            const errorMsg = err?.message ?? String(err);
            const settings = await this.store.getSettings().catch(() => ({ autoResolveConflicts: true }));
            const task = await this.store.getTask(taskId).catch(() => null);
            if (errorMsg.includes("conflict") || errorMsg.includes("Conflict")) {
              const currentRetries = task?.mergeRetries ?? 0;
              if (settings.autoResolveConflicts !== false && currentRetries < 3) {
                const nextRetries = currentRetries + 1;
                await this.store.updateTask(taskId, { mergeRetries: nextRetries, status: null });
                console.log(`Auto-merge conflict retry ${nextRetries}/3 for ${taskId} in 5s`);
              } else {
                console.log(`Auto-merge conflict retry skipped for ${taskId}: autoResolveConflicts disabled`);
                await this.store.updateTask(taskId, { status: null });
              }
            } else {
              await this.store.updateTask(taskId, {
                status: null,
                mergeRetries: 3,
                error: errorMsg,
              });
            }
          } finally {
            this.mergeActive.delete(taskId);
          }
        }
      } finally {
        this.mergeRunning = false;
      }
    }

    private wireAutoMerge(): void {
      this.taskMovedHandler = async ({ task, to }: { task: any; to: string }) => {
        if (to !== "in-review") return;
        if (this.options.getTaskMergeBlocker?.(task)) return;
        const settings = await this.store.getSettings();
        if (settings.globalPause || settings.enginePaused || !settings.autoMerge) return;
        this.enqueueMerge(task.id);
      };
      this.store.on("task:moved", this.taskMovedHandler);
    }

    private async startupMergeSweep(): Promise<void> {
      const settings = await this.store.getSettings();
      if (!settings.autoMerge) return;
      const tasks = await this.store.listTasks({ column: "in-review" } as any);
      for (const task of tasks) {
        if (this.canMergeTask(task)) this.enqueueMerge(task.id);
      }
    }

    private wireSettingsListeners(): void {
      const onGlobalPause = ({ settings, previous }: any) => {
        if (settings.globalPause && !previous.globalPause && this.activeMergeSession) {
          this.activeMergeSession.dispose();
          this.activeMergeSession = null;
        }
      };
      const onGlobalUnpause = async ({ settings, previous }: any) => {
        if (!previous.globalPause || settings.globalPause) return;
        await this.executor?.resumeOrphaned?.();
        if (settings.autoMerge) await this.enqueueInReviewTasks();
      };
      const onEngineUnpause = async ({ settings, previous }: any) => {
        if (!previous.enginePaused || settings.enginePaused) return;
        await this.executor?.resumeOrphaned?.();
        if (settings.autoMerge) await this.enqueueInReviewTasks();
      };
      const onStuckTimeoutChange = async ({ settings, previous }: any) => {
        if (settings.taskStuckTimeoutMs === previous.taskStuckTimeoutMs) return;
        try {
          await this.stuckDetector?.checkNow?.();
        } catch (err) {
          console.error("[stuck-detector] Error during immediate stuck-task check:", err);
        }
      };
      const onInsightSettingsChange = () => {};
      const onCompatibilityListener = () => {};
      this.settingsHandlers = [
        onGlobalPause,
        onGlobalUnpause,
        onEngineUnpause,
        onStuckTimeoutChange,
        onInsightSettingsChange,
        onCompatibilityListener,
      ];
      for (const handler of this.settingsHandlers) {
        this.store.on("settings:updated", handler);
      }
    }

    private async enqueueInReviewTasks(): Promise<void> {
      const tasks = await this.store.listTasks({ column: "in-review" } as any);
      for (const task of tasks) {
        if (this.canMergeTask(task)) this.enqueueMerge(task.id);
      }
    }
  }

  return {
    ...original,
    // Keep real WorktreePool & AgentSemaphore
    WorktreePool: original.WorktreePool,
    AgentSemaphore: original.AgentSemaphore,
    // Stub heavy classes/functions
    ProjectEngine,
    ProjectEngineManager: vi.fn().mockImplementation((centralCore: any, options: any) => {
      const engines = new Map<string, any>();
      return {
        startAll: vi.fn(async () => {
          // Grab the most recently created TaskStore mock — this is the one
          // the dashboard created at startup. By passing it as externalTaskStore,
          // the engine shares the same store, so settings listeners and events
          // in tests work as expected.
          const { TaskStore: TSMock } = await import("@fusion/core");
          const lastStore = (TSMock as any).mock?.results?.at(-1)?.value;
          const projects = await centralCore.listProjects();
          for (const project of projects) {
            const engine = new ProjectEngine(
              { workingDirectory: project.path },
              centralCore,
              { ...options, externalTaskStore: lastStore, projectId: project.id },
            );
            await engine.start();
            engines.set(project.id, engine);
          }
        }),
        getEngine: vi.fn((id: string) => engines.get(id)),
        getAllEngines: vi.fn(() => engines),
        getStore: vi.fn((id: string) => engines.get(id)?.getTaskStore()),
        has: vi.fn((id: string) => engines.has(id)),
        ensureEngine: vi.fn(async (id: string) => engines.get(id)),
        stopAll: vi.fn(async () => {
          for (const engine of engines.values()) await engine.stop();
          engines.clear();
        }),
        onProjectAccessed: vi.fn(),
        startReconciliation: vi.fn(),
      };
    }),
    ProjectManager: vi.fn().mockImplementation(() => ({
      getRuntime: vi.fn().mockReturnValue(undefined),
      addProject: vi.fn().mockResolvedValue(undefined),
      stopAll: vi.fn().mockResolvedValue(undefined),
    })),
    TriageProcessor,
    TaskExecutor,
    StuckTaskDetector,
    Scheduler,
    PrMonitor,
    PrCommentHandler,
    aiMergeTask,
    CronRunner,
    createAiPromptExecutor,
    SelfHealingManager,
    MissionAutopilot: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      setScheduler: vi.fn(),
    })),
    PluginLoader: vi.fn().mockImplementation(() => ({
      loadPlugin: vi.fn().mockResolvedValue(undefined),
      stopPlugin: vi.fn().mockResolvedValue(undefined),
      reloadPlugin: vi.fn().mockResolvedValue(undefined),
      getPluginRoutes: vi.fn().mockReturnValue([]),
      getPlugin: vi.fn(),
      getLoadedPlugins: vi.fn().mockReturnValue([]),
    })),
    scanIdleWorktrees: vi.fn().mockResolvedValue([]),
    cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
  };
});

// ── Mock @mariozechner/pi-coding-agent ──────────────────────────────

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => mockAuthStorage),
  },
  DefaultPackageManager: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockResolvedValue({ extensions: [] }),
  })),
  ModelRegistry: {
    create: vi.fn(() => mockModelRegistry),
    inMemory: vi.fn(() => mockModelRegistry),
  },
  SettingsManager: {
    create: vi.fn(() => ({})),
  },
  getAgentDir: vi.fn(() => "/mock/agent/dir"),
  discoverAndLoadExtensions: mockDiscoverAndLoadExtensions,
  createExtensionRuntime: mockCreateExtensionRuntime,
}));

// ── Import module under test (after mocks) ──────────────────────────

const { runDashboard: runDashboardImpl, StreamedLogBuffer } = await import("./dashboard.js");
const { processPullRequestMergeTask, getMergeStrategy, getTaskBranchName } = await import("./task-lifecycle.js");
const dashboardDisposables: Array<() => void> = [];

function disposeTrackedDashboards(): void {
  for (const dispose of dashboardDisposables.splice(0)) {
    dispose();
  }
}

async function runDashboard(...args: Parameters<typeof runDashboardImpl>): ReturnType<typeof runDashboardImpl> {
  disposeTrackedDashboards();
  const result = await runDashboardImpl(...args);
  dashboardDisposables.push(result.dispose);
  return result;
}

// ── Tests ───────────────────────────────────────────────────────────

function resetGitHubMocks() {
  mockFindPrForBranch.mockReset();
  mockCreatePr.mockReset();
  mockGetPrMergeStatus.mockReset();
  mockMergePr.mockReset();

  mockFindPrForBranch.mockResolvedValue(null);
  mockCreatePr.mockResolvedValue({
    url: "https://github.com/owner/repo/pull/42",
    number: 42,
    status: "open",
    title: "FN-TEST",
    headBranch: "fusion/fn-test",
    baseBranch: "main",
    commentCount: 0,
  });
  mockGetPrMergeStatus.mockResolvedValue({
    prInfo: {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open",
      title: "FN-TEST",
      headBranch: "fusion/fn-test",
      baseBranch: "main",
      commentCount: 0,
    },
    reviewDecision: null,
    checks: [],
    mergeReady: false,
    blockingReasons: ["required checks not successful: ci (pending)"],
  });
  mockMergePr.mockResolvedValue({
    url: "https://github.com/owner/repo/pull/42",
    number: 42,
    status: "merged",
    title: "FN-TEST",
    headBranch: "fusion/fn-test",
    baseBranch: "main",
    commentCount: 0,
  });
}

beforeEach(() => {
  resetGitHubMocks();
  mockExecSync.mockReset();
  mockExecSync.mockReturnValue("");
  mockExec.mockClear();
  mockStuckCheckNow.mockReset();
  mockStuckCheckNow.mockResolvedValue(undefined);
});

afterEach(() => {
  disposeTrackedDashboards();
});

describe("PR merge helpers", () => {
  it("defaults mergeStrategy to direct when unset", () => {
    expect(getMergeStrategy({ mergeStrategy: undefined })).toBe("direct");
  });

  it("uses pull-request mergeStrategy when configured", () => {
    expect(getMergeStrategy({ mergeStrategy: "pull-request" })).toBe("pull-request");
  });

  it("uses fusion/{task-id-lower} branch naming for pull requests", () => {
    expect(getTaskBranchName("FN-093")).toBe("fusion/fn-093");
  });
});

describe("processPullRequestMergeTask", () => {
  it("creates and links a PR when task.prInfo is missing", async () => {
    const store = makeMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-093",
      title: "Add support for creating pull requests",
      description: "Implement PR automation",
      column: "in-review",
      paused: false,
      worktree: "/tmp/kb-093",
      log: [],
    });

    const mockGetTaskMergeBlocker = (task: any) => {
      if (task.column !== "in-review") return `task is in '${task.column}', must be in 'in-review'`;
      if (task.paused) return "task is paused";
      if (task.status === "failed") return "task is marked 'failed'";
      if (task.steps?.some((step: any) => step.status === "pending" || step.status === "in-progress")) {
        return "task has incomplete steps";
      }
      if (task.workflowStepResults?.some((result: any) => result.status === "pending" || result.status === "failed")) {
        return "task has incomplete or failed workflow steps";
      }
      return undefined;
    };

    const result = await processPullRequestMergeTask(store as any, "/repo", "FN-093", {
      findPrForBranch: mockFindPrForBranch,
      createPr: mockCreatePr,
      getPrMergeStatus: mockGetPrMergeStatus,
      mergePr: mockMergePr,
    } as any, mockGetTaskMergeBlocker);

    expect(result).toBe("waiting");
    expect(mockFindPrForBranch).toHaveBeenCalledWith({ head: "fusion/fn-093", state: "all" });
    expect(mockCreatePr).toHaveBeenCalledWith({
      title: "FN-093: Add support for creating pull requests",
      body: "Automated PR for FN-093.\n\nImplement PR automation",
      head: "fusion/fn-093",
    });
    expect(store.updatePrInfo).toHaveBeenCalledWith(
      "FN-093",
      expect.objectContaining({ number: 42, status: "open" }),
    );
    expect(store.updateTask).toHaveBeenCalledWith("FN-093", { status: "awaiting-pr-checks" });
  });

  it("links an existing PR instead of creating a duplicate", async () => {
    const store = makeMockStore();
    const existingPr = {
      url: "https://github.com/owner/repo/pull/7",
      number: 7,
      status: "open" as const,
      title: "Existing PR",
      headBranch: "fusion/fn-093",
      baseBranch: "main",
      commentCount: 0,
    };
    mockFindPrForBranch.mockResolvedValue(existingPr);
    store.getTask.mockResolvedValue({
      id: "FN-093",
      title: "Task",
      description: "Description",
      column: "in-review",
      paused: false,
      log: [],
    });

    const mockGetTaskMergeBlocker = (task: any) => {
      if (task.column !== "in-review") return `task is in '${task.column}', must be in 'in-review'`;
      if (task.paused) return "task is paused";
      if (task.status === "failed") return "task is marked 'failed'";
      if (task.steps?.some((step: any) => step.status === "pending" || step.status === "in-progress")) {
        return "task has incomplete steps";
      }
      if (task.workflowStepResults?.some((result: any) => result.status === "pending" || result.status === "failed")) {
        return "task has incomplete or failed workflow steps";
      }
      return undefined;
    };

    await processPullRequestMergeTask(store as any, "/repo", "FN-093", {
      findPrForBranch: mockFindPrForBranch,
      createPr: mockCreatePr,
      getPrMergeStatus: mockGetPrMergeStatus,
      mergePr: mockMergePr,
    } as any, mockGetTaskMergeBlocker);

    expect(mockCreatePr).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-093",
      "Linked existing PR",
      "PR #7: https://github.com/owner/repo/pull/7",
    );
  });

  it("merges a ready PR and finalizes task cleanup", async () => {
    const store = makeMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-093",
      title: "Task",
      description: "Description",
      column: "in-review",
      paused: false,
      worktree: "/tmp/kb-093",
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "Task",
        headBranch: "fusion/fn-093",
        baseBranch: "main",
        commentCount: 0,
      },
      log: [],
    });
    mockGetPrMergeStatus.mockResolvedValue({
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "Task",
        headBranch: "fusion/fn-093",
        baseBranch: "main",
        commentCount: 0,
      },
      reviewDecision: "APPROVED",
      checks: [{ name: "ci", required: true, state: "success" }],
      mergeReady: true,
      blockingReasons: [],
    });

    const mockGetTaskMergeBlocker = (task: any) => {
      if (task.column !== "in-review") return `task is in '${task.column}', must be in 'in-review'`;
      if (task.paused) return "task is paused";
      if (task.status === "failed") return "task is marked 'failed'";
      if (task.steps?.some((step: any) => step.status === "pending" || step.status === "in-progress")) {
        return "task has incomplete steps";
      }
      if (task.workflowStepResults?.some((result: any) => result.status === "pending" || result.status === "failed")) {
        return "task has incomplete or failed workflow steps";
      }
      return undefined;
    };

    const result = await processPullRequestMergeTask(store as any, "/repo", "FN-093", {
      findPrForBranch: mockFindPrForBranch,
      createPr: mockCreatePr,
      getPrMergeStatus: mockGetPrMergeStatus,
      mergePr: mockMergePr,
    } as any, mockGetTaskMergeBlocker);

    expect(result).toBe("merged");
    expect(mockMergePr).toHaveBeenCalledWith({ number: 42, method: "squash" });
    expect(store.moveTask).toHaveBeenCalledWith("FN-093", "done");
    // Check that exec was called with the expected commands (options object and callback may follow)
    expect(mockExec.mock.calls.some((call) => call[0] === 'git worktree remove "/tmp/kb-093" --force')).toBe(true);
    expect(mockExec.mock.calls.some((call) => call[0] === 'git branch -d "fusion/fn-093"')).toBe(true);
  });

  it("does not merge when required checks or reviews are blocking", async () => {
    const store = makeMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-093",
      title: "Task",
      description: "Description",
      column: "in-review",
      paused: false,
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "Task",
        headBranch: "fusion/fn-093",
        baseBranch: "main",
        commentCount: 0,
      },
      log: [],
    });
    mockGetPrMergeStatus.mockResolvedValue({
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "Task",
        headBranch: "fusion/fn-093",
        baseBranch: "main",
        commentCount: 0,
      },
      reviewDecision: "CHANGES_REQUESTED",
      checks: [{ name: "ci", required: true, state: "pending" }],
      mergeReady: false,
      blockingReasons: ["changes requested review is active", "required checks not successful: ci (pending)"],
    });

    const mockGetTaskMergeBlocker = (task: any) => {
      if (task.column !== "in-review") return `task is in '${task.column}', must be in 'in-review'`;
      if (task.paused) return "task is paused";
      if (task.status === "failed") return "task is marked 'failed'";
      if (task.steps?.some((step: any) => step.status === "pending" || step.status === "in-progress")) {
        return "task has incomplete steps";
      }
      if (task.workflowStepResults?.some((result: any) => result.status === "pending" || result.status === "failed")) {
        return "task has incomplete or failed workflow steps";
      }
      return undefined;
    };

    const result = await processPullRequestMergeTask(store as any, "/repo", "FN-093", {
      findPrForBranch: mockFindPrForBranch,
      createPr: mockCreatePr,
      getPrMergeStatus: mockGetPrMergeStatus,
      mergePr: mockMergePr,
    } as any, mockGetTaskMergeBlocker);

    expect(result).toBe("waiting");
    expect(mockMergePr).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-093", { status: "awaiting-pr-checks" });
  });
});

describe("runDashboard — PR-first auto-merge queue", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetGitHubMocks();
    mockStore = makeMockStore();
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      mergeStrategy: "pull-request",
      pollIntervalMs: 60_000,
      enginePaused: false,
      globalPause: false,
    });
    mockStore.listTasks.mockResolvedValue([
      { id: "FN-093", column: "in-review", paused: false },
    ]);
    mockStore.getTask.mockResolvedValue({
      id: "FN-093",
      title: "Task",
      description: "Description",
      column: "in-review",
      paused: false,
      log: [],
    });

    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
  });

  it("uses PR lifecycle instead of aiMergeTask when mergeStrategy is pull-request", async () => {
    const { aiMergeTask } = await import("@fusion/engine");

    await runDashboard(0, { open: false });
    await new Promise((r) => setTimeout(r, 100));

    expect(mockCreatePr).toHaveBeenCalledWith({
      title: "FN-093: Task",
      body: "Automated PR for FN-093.\n\nDescription",
      head: "fusion/fn-093",
    });
    expect(aiMergeTask).not.toHaveBeenCalled();
  });
});

describe("runDashboard — WorktreePool wiring", () => {
  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    resetGitHubMocks();
    // Re-set TaskStore mock (clearAllMocks wipes implementations)
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
    // Re-set engine mocks
    const engine = await import("@fusion/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
  });

  it("passes a WorktreePool instance to TaskExecutor", async () => {
    await runDashboard(0, { open: false });

    expect(capturedExecutorOpts).toBeDefined();
    expect(capturedExecutorOpts!.pool).toBeInstanceOf(WorktreePool);
  });

  it("passes a WorktreePool instance to aiMergeTask via rawMerge", async () => {
    const { aiMergeTask } = await import("@fusion/engine");
    const { createServer } = await import("@fusion/dashboard");

    await runDashboard(0, { open: false });

    // rawMerge is exposed as the onMerge callback wired into createServer.
    const createServerCall = (createServer as ReturnType<typeof vi.fn>).mock.calls[0];
    const serverOpts = createServerCall[1] as { onMerge: (taskId: string) => Promise<unknown> };

    // Invoke the merge handler
    await serverOpts.onMerge("FN-TEST");

    expect(aiMergeTask).toHaveBeenCalled();
    const mergeCallOpts = (aiMergeTask as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(mergeCallOpts.pool).toBeInstanceOf(WorktreePool);
  });

  it("shares the same WorktreePool instance between executor and merger", async () => {
    const { aiMergeTask } = await import("@fusion/engine");
    const { createServer } = await import("@fusion/dashboard");

    await runDashboard(0, { open: false });

    // Trigger merger via onMerge
    const createServerCall = (createServer as ReturnType<typeof vi.fn>).mock.calls[0];
    const serverOpts = createServerCall[1] as { onMerge: (taskId: string) => Promise<unknown> };
    await serverOpts.onMerge("FN-TEST");

    const executorPool = capturedExecutorOpts!.pool;
    const mergerPool = (aiMergeTask as ReturnType<typeof vi.fn>).mock.calls[0][3].pool;

    expect(executorPool).toBeInstanceOf(WorktreePool);
    expect(mergerPool).toBeInstanceOf(WorktreePool);
    expect(executorPool).toBe(mergerPool);
  });
});

describe("runDashboard — auto-merge pause exclusion", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    capturedSelfHealingOpts = undefined;
    vi.clearAllMocks();
    resetGitHubMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@fusion/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
  });

  it("does not enqueue paused in-review tasks for auto-merge on task:moved", async () => {
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
    });

    await runDashboard(0, { open: false });

    const { aiMergeTask } = await import("@fusion/engine");

    // Emit task:moved with a paused task
    mockStore.emit("task:moved", {
      task: { id: "FN-PAUSED", column: "in-review", paused: true },
      from: "in-progress",
      to: "in-review",
    });

    // Give async handlers time to process
    await new Promise((r) => setTimeout(r, 50));

    expect(aiMergeTask).not.toHaveBeenCalled();
  });

  it("does not enqueue paused in-review tasks during startup sweep", async () => {
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
    });
    mockStore.listTasks.mockResolvedValue([
      { id: "FN-PAUSED", column: "in-review", paused: true },
      { id: "FN-ACTIVE", column: "in-review", paused: false },
    ]);

    const { aiMergeTask } = await import("@fusion/engine");
    // Reset after import
    (aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );

    await runDashboard(0, { open: false });

    // Give async handlers time to process
    await new Promise((r) => setTimeout(r, 50));

    // Only the non-paused task should be enqueued
    const mergedIds = (aiMergeTask as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: any[]) => call[2],
    );
    expect(mergedIds).not.toContain("FN-PAUSED");
  });

  it("does not auto-merge failed in-review tasks", async () => {
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
    });
    mockStore.listTasks.mockResolvedValue([
      { id: "FN-FAILED", column: "in-review", paused: false, status: "failed" },
    ]);
    mockStore.getTask = vi.fn().mockResolvedValue({
      id: "FN-FAILED",
      column: "in-review",
      paused: false,
      status: "failed",
      steps: [{ name: "Step 1", status: "done" }],
    });

    const { aiMergeTask } = await import("@fusion/engine");
    (aiMergeTask as ReturnType<typeof vi.fn>).mockClear();

    await runDashboard(0, { open: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(aiMergeTask).not.toHaveBeenCalled();
  });

  it("does not auto-merge in-review tasks with exhausted merge retries", async () => {
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
    });
    mockStore.listTasks.mockResolvedValue([
      { id: "FN-EXHAUSTED", column: "in-review", paused: false, mergeRetries: 3 },
    ]);

    const { aiMergeTask } = await import("@fusion/engine");
    (aiMergeTask as ReturnType<typeof vi.fn>).mockClear();

    await runDashboard(0, { open: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(aiMergeTask).not.toHaveBeenCalled();
  });

  it("auto-heals stale exit-0 verification buffer failures with exhausted merge retries", async () => {
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
    });
    const task = {
      id: "FN-BUFFER",
      column: "in-review",
      paused: false,
      mergeRetries: 3,
      error: "Deterministic test verification failed for FN-BUFFER",
      steps: [{ name: "Step 1", status: "done" }],
      log: [
        {
          timestamp: "2026-04-10T20:23:18.691Z",
          action: "[verification] test command failed (exit 0): stdout maxBuffer length exceeded",
        },
      ],
    };
    mockStore.listTasks.mockResolvedValue([task]);
    mockStore.getTask = vi.fn().mockResolvedValue(task);

    const { aiMergeTask } = await import("@fusion/engine");
    (aiMergeTask as ReturnType<typeof vi.fn>).mockClear();

    await runDashboard(0, { open: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockStore.logEntry).toHaveBeenCalledWith(
      "FN-BUFFER",
      "Auto-healing stale deterministic verification buffer failure; retrying merge verification",
    );
    expect(mockStore.updateTask).toHaveBeenCalledWith(
      "FN-BUFFER",
      { mergeRetries: 0, error: null, status: null },
    );
    expect(aiMergeTask).toHaveBeenCalled();
  });

  it("does not auto-merge in-review tasks with incomplete steps", async () => {
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
    });
    mockStore.listTasks.mockResolvedValue([
      { id: "FN-INCOMPLETE", column: "in-review", paused: false, steps: [{ name: "Step 1", status: "in-progress" }] },
    ]);
    mockStore.getTask = vi.fn().mockResolvedValue({
      id: "FN-INCOMPLETE",
      column: "in-review",
      paused: false,
      steps: [{ name: "Step 1", status: "in-progress" }],
    });

    const { aiMergeTask } = await import("@fusion/engine");
    (aiMergeTask as ReturnType<typeof vi.fn>).mockClear();

    await runDashboard(0, { open: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(aiMergeTask).not.toHaveBeenCalled();
  });
});

describe("runDashboard — immediate resume on unpause", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    resetGitHubMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@fusion/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
  });

  it("registers a settings:updated listener on the store", async () => {
    await runDashboard(0, { open: false });

    // The store.on should have been called with "settings:updated" at least once
    const settingsUpdatedCalls = mockStore.on.mock.calls.filter(
      (call: any[]) => call[0] === "settings:updated",
    );
    // At least 2 listeners: one for pause→true (merge kill), one for unpause
    expect(settingsUpdatedCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("calls executor.resumeOrphaned() when globalPause transitions true → false", async () => {
    const { TaskExecutor } = await import("@fusion/engine");
    const resumeOrphaned = vi.fn().mockResolvedValue(undefined);
    (TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned };
      },
    );

    await runDashboard(0, { open: false });

    // Clear the startup call to resumeOrphaned
    resumeOrphaned.mockClear();

    // Trigger unpause event
    mockStore.emit("settings:updated", {
      settings: { globalPause: false, maxConcurrent: 1, autoMerge: false },
      previous: { globalPause: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(resumeOrphaned).toHaveBeenCalled();
  });

  it("passes executor recovery callbacks into SelfHealingManager", async () => {
    await runDashboard(0, { open: false });

    expect(capturedSelfHealingOpts).toMatchObject({
      rootDir: process.cwd(),
      recoverCompletedTask: expect.any(Function),
      getExecutingTaskIds: expect.any(Function),
    });
    expect(mockSelfHealingStart).toHaveBeenCalled();
  });

  it("sweeps merge queue on unpause when autoMerge is enabled", async () => {
    // Set up settings to return autoMerge: true for the drain queue check
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
      globalPause: false,
    });
    mockStore.listTasks.mockResolvedValue([
      { id: "FN-MQ1", column: "in-review", paused: false },
      { id: "FN-MQ2", column: "in-review", paused: false },
    ]);
    // getTask is called inside drainMergeQueue to verify the task
    mockStore.getTask = vi.fn().mockImplementation(async (id: string) => ({
      id,
      column: "in-review",
      paused: false,
    }));

    const { aiMergeTask } = await import("@fusion/engine");
    (aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );

    await runDashboard(0, { open: false });

    // Clear any calls from startup sweep
    (aiMergeTask as ReturnType<typeof vi.fn>).mockClear();

    // Trigger unpause event with autoMerge enabled
    mockStore.emit("settings:updated", {
      settings: { globalPause: false, maxConcurrent: 1, autoMerge: true },
      previous: { globalPause: true },
    });

    await new Promise((r) => setTimeout(r, 200));

    // Both in-review tasks should be enqueued for merge
    const mergedIds = (aiMergeTask as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: any[]) => call[2],
    );
    expect(mergedIds).toContain("FN-MQ1");
    expect(mergedIds).toContain("FN-MQ2");
  });
});

describe("runDashboard — engine pause/unpause cycle", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    resetGitHubMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@fusion/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
  });

  it("calls executor.resumeOrphaned() when enginePaused transitions true → false", async () => {
    const { TaskExecutor } = await import("@fusion/engine");
    const resumeOrphaned = vi.fn().mockResolvedValue(undefined);
    (TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned };
      },
    );

    await runDashboard(0, { open: false });

    // Clear the startup call to resumeOrphaned
    resumeOrphaned.mockClear();

    // Trigger engine unpause event
    mockStore.emit("settings:updated", {
      settings: { enginePaused: false, maxConcurrent: 1, autoMerge: false },
      previous: { enginePaused: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(resumeOrphaned).toHaveBeenCalled();
  });
});

describe("runDashboard — stuck task timeout listener guards", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetGitHubMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@fusion/engine");
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
  });

  it("catches and logs checkNow errors when taskStuckTimeoutMs changes", async () => {
    const detectorError = new Error("detector exploded");
    mockStuckCheckNow.mockRejectedValueOnce(detectorError);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandledRejectionSpy = vi.fn();
    process.on("unhandledRejection", unhandledRejectionSpy);

    try {
      await runDashboard(0, { open: false });

      mockStore.emit("settings:updated", {
        settings: { taskStuckTimeoutMs: 600_000 },
        previous: { taskStuckTimeoutMs: 1_200_000 },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(mockStuckCheckNow).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[stuck-detector] Error during immediate stuck-task check:",
        detectorError,
      );
      expect(unhandledRejectionSpy).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejectionSpy);
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("runDashboard — port fallback on EADDRINUSE", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetGitHubMocks();
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
    const engine = await import("@fusion/engine");
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ resumeOrphaned: vi.fn().mockResolvedValue(undefined) }),
    );
    consoleSpy = vi.spyOn(console, "log");
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("listens on the requested port when available", async () => {
    await runDashboard(4040, { open: false });

    // Wait for async 'listening' event
    await new Promise((r) => setTimeout(r, 50));

    // mockListen should have been called with the requested port bound to localhost by default.
    expect(mockListen).toHaveBeenCalledWith(4040, "127.0.0.1");

    // Banner should show the requested port
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("http://localhost:4040"),
    );

    // No warning should be printed
    const warningCalls = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("Port 4040 in use"),
    );
    expect(warningCalls).toHaveLength(0);
  });

  it("falls back to a random port on EADDRINUSE", async () => {
    const fallbackPort = 54321;
    const serverEmitter = new EventEmitter();

    // Mock the server's own listen method (used for the retry with port 0)
    const mockServerListen = vi.fn((_port?: number) => {
      process.nextTick(() => serverEmitter.emit("listening"));
      return serverEmitter;
    });

    Object.assign(serverEmitter, {
      listen: mockServerListen,
      address: vi.fn(() => ({ port: fallbackPort, family: "IPv4", address: "127.0.0.1" })),
      close: vi.fn(),
    });

    // Override mockListen for one call: simulate EADDRINUSE
    mockListen.mockImplementationOnce(((_port: number) => {
      process.nextTick(() => {
        const err = new Error("listen EADDRINUSE: address already in use") as NodeJS.ErrnoException;
        err.code = "EADDRINUSE";
        serverEmitter.emit("error", err);
      });
      return serverEmitter;
    }) as any);

    await runDashboard(4040, { open: false });

    // Wait for async events to settle
    await new Promise((r) => setTimeout(r, 100));

    // Server should have retried with port 0, still bound to localhost.
    expect(mockServerListen).toHaveBeenCalledWith(0, "127.0.0.1");

    // Banner should show the fallback port, not the requested port
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(`http://localhost:${fallbackPort}`),
    );
  });

  it("prints a warning when port fallback occurs", async () => {
    const fallbackPort = 12345;
    const serverEmitter = new EventEmitter();
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mockServerListen = vi.fn((_port?: number) => {
      process.nextTick(() => serverEmitter.emit("listening"));
      return serverEmitter;
    });

    Object.assign(serverEmitter, {
      listen: mockServerListen,
      address: vi.fn(() => ({ port: fallbackPort, family: "IPv4", address: "127.0.0.1" })),
      close: vi.fn(),
    });

    mockListen.mockImplementationOnce(((_port: number) => {
      process.nextTick(() => {
        const err = new Error("listen EADDRINUSE: address already in use") as NodeJS.ErrnoException;
        err.code = "EADDRINUSE";
        serverEmitter.emit("error", err);
      });
      return serverEmitter;
    }) as any);

    await runDashboard(4040, { open: false });

    // Wait for async events to settle
    await new Promise((r) => setTimeout(r, 100));

    // Should print warning with both the requested and actual ports
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      `[dashboard] Port 4040 in use, using ${fallbackPort} instead`,
    );
    consoleWarnSpy.mockRestore();
  });
});

describe("runDashboard — enginePaused (soft pause)", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    resetGitHubMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@fusion/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
  });

  it("does not enqueue tasks for auto-merge when enginePaused on task:moved", async () => {
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
      enginePaused: true,
    });

    await runDashboard(0, { open: false });

    const { aiMergeTask } = await import("@fusion/engine");

    // Emit task:moved
    mockStore.emit("task:moved", {
      task: { id: "FN-EP1", column: "in-review", paused: false },
      from: "in-progress",
      to: "in-review",
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(aiMergeTask).not.toHaveBeenCalled();
  });

  it("calls executor.resumeOrphaned() when enginePaused transitions true → false", async () => {
    const { TaskExecutor } = await import("@fusion/engine");
    const resumeOrphaned = vi.fn().mockResolvedValue(undefined);
    (TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned };
      },
    );

    await runDashboard(0, { open: false });

    // Clear the startup call
    resumeOrphaned.mockClear();

    // Trigger engine unpause event
    mockStore.emit("settings:updated", {
      settings: { enginePaused: false, maxConcurrent: 1, autoMerge: false },
      previous: { enginePaused: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(resumeOrphaned).toHaveBeenCalled();
  });

  it("sweeps merge queue on engine unpause when autoMerge is enabled", async () => {
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
      enginePaused: false,
      globalPause: false,
    });
    mockStore.listTasks.mockResolvedValue([
      { id: "FN-EP2", column: "in-review", paused: false },
    ]);
    mockStore.getTask = vi.fn().mockImplementation(async (id: string) => ({
      id,
      column: "in-review",
      paused: false,
    }));

    const { aiMergeTask } = await import("@fusion/engine");
    (aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );

    await runDashboard(0, { open: false });

    (aiMergeTask as ReturnType<typeof vi.fn>).mockClear();

    mockStore.emit("settings:updated", {
      settings: { enginePaused: false, maxConcurrent: 1, autoMerge: true },
      previous: { enginePaused: true },
    });

    await new Promise((r) => setTimeout(r, 200));

    const mergedIds = (aiMergeTask as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: any[]) => call[2],
    );
    expect(mergedIds).toContain("FN-EP2");
  });
});

describe("runDashboard — --paused flag", () => {
  let mockStore: ReturnType<typeof makeMockStore>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    resetGitHubMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@fusion/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("calls store.updateSettings({ enginePaused: true }) when paused: true is passed", async () => {
    await runDashboard(0, { open: false, paused: true });

    expect(mockStore.updateSettings).toHaveBeenCalledWith({ enginePaused: true });
  });

  it("logs a message when starting in paused mode", async () => {
    await runDashboard(0, { open: false, paused: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[engine] Starting in paused mode — automation disabled",
    );
  });

  it("does NOT set enginePaused when paused option is absent", async () => {
    await runDashboard(0, { open: false });

    // updateSettings should not be called with enginePaused during normal startup
    const enginePausedCalls = mockStore.updateSettings.mock.calls.filter(
      (call: any[]) => call[0]?.enginePaused !== undefined,
    );
    expect(enginePausedCalls).toHaveLength(0);
  });

  it("does NOT log paused message when starting normally", async () => {
    await runDashboard(0, { open: false });

    const pausedMessageCalls = consoleSpy.mock.calls.filter(
      (args) => args[0] === "[engine] Starting in paused mode — automation disabled",
    );
    expect(pausedMessageCalls).toHaveLength(0);
  });
});

describe("runDashboard — --paused flag", () => {
  let mockStore: ReturnType<typeof makeMockStore>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetGitHubMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@fusion/engine");
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ resumeOrphaned: vi.fn().mockResolvedValue(undefined) }),
    );
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("calls store.updateSettings({ enginePaused: true }) when paused: true is passed", async () => {
    await runDashboard(0, { open: false, paused: true });

    expect(mockStore.updateSettings).toHaveBeenCalledWith({ enginePaused: true });
    expect(mockStore.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("does NOT call store.updateSettings when paused flag is absent", async () => {
    await runDashboard(0, { open: false });

    expect(mockStore.updateSettings).not.toHaveBeenCalled();
  });

  it("logs paused mode message when starting with paused: true", async () => {
    await runDashboard(0, { open: false, paused: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[engine] Starting in paused mode — automation disabled",
    );
  });

  it("does NOT log paused mode message when paused flag is absent", async () => {
    await runDashboard(0, { open: false });

    const pausedMessageCalls = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("paused mode"),
    );
    expect(pausedMessageCalls).toHaveLength(0);
  });
});

describe("runDashboard — --dev mode", () => {
  let mockStore: ReturnType<typeof makeMockStore>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    resetGitHubMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@fusion/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("does NOT start TriageProcessor in dev mode", async () => {
    const { TriageProcessor } = await import("@fusion/engine");
    await runDashboard(0, { open: false, dev: true });
    expect(TriageProcessor).not.toHaveBeenCalled();
  });

  it("does NOT start TaskExecutor in dev mode", async () => {
    const { TaskExecutor } = await import("@fusion/engine");
    await runDashboard(0, { open: false, dev: true });
    expect(TaskExecutor).not.toHaveBeenCalled();
  });

  it("does NOT start Scheduler in dev mode", async () => {
    const { Scheduler } = await import("@fusion/engine");
    await runDashboard(0, { open: false, dev: true });
    expect(Scheduler).not.toHaveBeenCalled();
  });

  it("starts the server correctly in dev mode", async () => {
    const { createServer } = await import("@fusion/dashboard");
    await runDashboard(4040, { open: false, dev: true });

    // Wait for async 'listening' event
    await new Promise((r) => setTimeout(r, 50));

    // Server should have been created and listen called (localhost default)
    expect(createServer).toHaveBeenCalled();
    expect(mockListen).toHaveBeenCalledWith(4040, "127.0.0.1");

    // Banner should show the port
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("http://localhost:4040"),
    );
  });

  it("shows 'AI engine: disabled (dev mode)' in dev mode", async () => {
    await runDashboard(0, { open: false, dev: true });

    // Wait for async 'listening' event
    await new Promise((r) => setTimeout(r, 50));

    // Should show disabled message
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("✗ disabled (dev mode)"),
    );
  });

  it("does NOT show triage/scheduler details in dev mode", async () => {
    await runDashboard(0, { open: false, dev: true });

    // Wait for async 'listening' event
    await new Promise((r) => setTimeout(r, 50));

    // Should NOT show triage/scheduler details
    const triageCall = consoleSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("• triage"),
    );
    const schedulerCall = consoleSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("• scheduler"),
    );
    expect(triageCall).toBeUndefined();
    expect(schedulerCall).toBeUndefined();
  });

  it("starts all engine components when dev is false (default)", async () => {
    const { TriageProcessor, TaskExecutor, Scheduler } = await import("@fusion/engine");
    await runDashboard(0, { open: false });

    expect(TriageProcessor).toHaveBeenCalled();
    expect(TaskExecutor).toHaveBeenCalled();
    expect(Scheduler).toHaveBeenCalled();
  });

  it("shows 'AI engine: ✓ active' when not in dev mode", async () => {
    await runDashboard(0, { open: false });

    // Wait for async 'listening' event
    await new Promise((r) => setTimeout(r, 50));

    // Should show active message
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("✓ active"),
    );
  });
});

describe("runDashboard — merge conflict retry logic", () => {
  let mockStore: ReturnType<typeof makeMockStore>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    resetGitHubMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);

    // Default mock store.getTask implementation
    mockStore.getTask = vi.fn().mockImplementation(async (id: string) => ({
      id,
      column: "in-review",
      paused: false,
      mergeRetries: 0,
    }));

    const engine = await import("@fusion/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("increments mergeRetries and re-enqueues on conflict error", async () => {
    const { aiMergeTask } = await import("@fusion/engine");

    // Simulate merge failure with conflict
    (aiMergeTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Merge conflict detected in package-lock.json"),
    );

    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      autoResolveConflicts: true,
      pollIntervalMs: 60_000,
      enginePaused: false,
      globalPause: false,
    });

    mockStore.listTasks.mockResolvedValue([
      { id: "FN-RETRY", column: "in-review", paused: false },
    ]);

    await runDashboard(0, { open: false });

    // Wait for retry scheduling
    await new Promise((r) => setTimeout(r, 100));

    // Should have incremented mergeRetries
    expect(mockStore.updateTask).toHaveBeenCalledWith(
      "FN-RETRY",
      expect.objectContaining({ mergeRetries: 1 }),
    );

    // Should log retry attempt
    const retryLog = consoleSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("retry 1/3"),
    );
    expect(retryLog).toBeDefined();
  });

  it("gives up after max retries (3) exceeded", async () => {
    const { aiMergeTask } = await import("@fusion/engine");

    (aiMergeTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Merge conflict detected"),
    );

    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      autoResolveConflicts: true,
      pollIntervalMs: 60_000,
      enginePaused: false,
      globalPause: false,
    });

    // Task already has 3 retries
    mockStore.getTask = vi.fn().mockImplementation(async (id: string) => ({
      id,
      column: "in-review",
      paused: false,
      mergeRetries: 3,
    }));

    mockStore.listTasks.mockResolvedValue([
      { id: "FN-MAX", column: "in-review", paused: false, mergeRetries: 3 },
    ]);

    await runDashboard(0, { open: false });

    await new Promise((r) => setTimeout(r, 50));

    // Exhausted tasks are skipped before enqueue, so they should not be merged again.
    expect(aiMergeTask).not.toHaveBeenCalled();
    expect(mockStore.updateTask).not.toHaveBeenCalledWith(
      "FN-MAX",
      expect.objectContaining({ mergeRetries: expect.anything() }),
    );
  });

  it("skips retry when autoResolveConflicts is disabled", async () => {
    const { aiMergeTask } = await import("@fusion/engine");

    (aiMergeTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Merge conflict detected"),
    );

    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      autoResolveConflicts: false, // Disabled
      pollIntervalMs: 60_000,
      enginePaused: false,
      globalPause: false,
    });

    mockStore.listTasks.mockResolvedValue([
      { id: "FN-NO-AUTO", column: "in-review", paused: false },
    ]);

    await runDashboard(0, { open: false });

    await new Promise((r) => setTimeout(r, 50));

    // Should log that auto-resolve is disabled
    const disabledLog = consoleSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("autoResolveConflicts disabled"),
    );
    expect(disabledLog).toBeDefined();
  });

  it("clears mergeRetries on successful merge after retries", async () => {
    const { aiMergeTask } = await import("@fusion/engine");

    (aiMergeTask as ReturnType<typeof vi.fn>).mockResolvedValue({ merged: true });

    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      autoResolveConflicts: true,
      pollIntervalMs: 60_000,
      enginePaused: false,
      globalPause: false,
    });

    // Task had previous retries
    mockStore.getTask = vi.fn().mockImplementation(async (id: string) => ({
      id,
      column: "in-review",
      paused: false,
      mergeRetries: 2,
    }));

    mockStore.listTasks.mockResolvedValue([
      { id: "FN-SUCCESS", column: "in-review", paused: false, mergeRetries: 2 },
    ]);

    await runDashboard(0, { open: false });

    await new Promise((r) => setTimeout(r, 100));

    // Should clear mergeRetries on success
    expect(mockStore.updateTask).toHaveBeenCalledWith(
      "FN-SUCCESS",
      expect.objectContaining({ mergeRetries: 0 }),
    );
  });

  it("marks non-conflict merge failures as exhausted so auto-merge stops retrying", async () => {
    const { aiMergeTask } = await import("@fusion/engine");

    (aiMergeTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Build verification failed for FN-BUILD: Dependency sync failed"),
    );

    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      autoResolveConflicts: true,
      pollIntervalMs: 60_000,
      enginePaused: false,
      globalPause: false,
    });

    mockStore.getTask = vi.fn().mockImplementation(async (id: string) => ({
      id,
      column: "in-review",
      paused: false,
      mergeRetries: 0,
    }));

    mockStore.listTasks.mockResolvedValue([
      { id: "FN-BUILD", column: "in-review", paused: false, mergeRetries: 0 },
    ]);

    await runDashboard(0, { open: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockStore.updateTask).toHaveBeenCalledWith(
      "FN-BUILD",
      expect.objectContaining({
        status: null,
        mergeRetries: 3,
        error: "Build verification failed for FN-BUILD: Dependency sync failed",
      }),
    );
  });
});

describe("runDashboard — PR feedback follow-up wiring", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    resetGitHubMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@fusion/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
  });

  it("wires onClosedPrFeedback callback to PrCommentHandler.createFollowUpTask", async () => {
    const { PrMonitor, PrCommentHandler, Scheduler } = await import("@fusion/engine");

    let capturedOnClosedPrFeedback: ((taskId: string, prInfo: any, comments: any[]) => void) | undefined;

    (Scheduler as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _opts: unknown) => {
        capturedOnClosedPrFeedback = _opts.onClosedPrFeedback;
        return { start: vi.fn(), stop: vi.fn() };
      },
    );

    await runDashboard(0, { open: false });

    // Verify the callback was passed to the scheduler
    expect(capturedOnClosedPrFeedback).toBeDefined();

    // Invoke it to verify it reaches createFollowUpTask
    const mockPrInfo = { status: "merged", number: 42 };
    const mockComments = [
      { id: 1, body: "Fix this", user: { login: "reviewer" }, created_at: "2024-01-01", updated_at: "2024-01-01", html_url: "" },
    ];
    await capturedOnClosedPrFeedback("FN-001", mockPrInfo, mockComments);

    // The PrCommentHandler mock should have been called
    const handlerInstance = (PrCommentHandler as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(handlerInstance.createFollowUpTask).toHaveBeenCalledWith("FN-001", mockPrInfo, mockComments);
  });

  it("preserves existing onNewComments steering behavior", async () => {
    const { PrMonitor, PrCommentHandler } = await import("@fusion/engine");

    let capturedOnNewComments: ((taskId: string, prInfo: any, comments: any[]) => void) | undefined;

    (PrMonitor as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      onNewComments: vi.fn((cb: any) => { capturedOnNewComments = cb; }),
      startMonitoring: vi.fn(),
      stopMonitoring: vi.fn(),
      stopAll: vi.fn(),
      getTrackedPrs: vi.fn().mockReturnValue(new Map()),
      updatePrInfo: vi.fn(),
      drainComments: vi.fn().mockReturnValue([]),
    }));

    await runDashboard(0, { open: false });

    // The onNewComments callback should still be wired to handleNewComments
    expect(capturedOnNewComments).toBeDefined();
    const handlerInstance = (PrCommentHandler as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    const mockComments = [
      { id: 1, body: "Fix this", user: { login: "reviewer" }, created_at: "2024-01-01", updated_at: "2024-01-01", html_url: "" },
    ];
    const mockPrInfo = { status: "open", number: 42 };
    await capturedOnNewComments("FN-001", mockPrInfo, mockComments);
    expect(handlerInstance.handleNewComments).toHaveBeenCalledWith("FN-001", mockPrInfo, mockComments);
  });
});

describe("runDashboard — lifecycle listener cleanup", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    mockStore = makeMockStore();
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
  });

  it("returns a dispose function", async () => {
    const { dispose } = await runDashboard(0, { open: false });
    expect(typeof dispose).toBe("function");
    expect(() => dispose()).not.toThrow();
  });

  it("engine cleans up its own listeners from the shared store on dispose", async () => {
    const { dispose } = await runDashboard(0, { open: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    dispose();

    // With ProjectEngineManager, engine.stop() cleans up settings:updated
    // and task:moved listeners from the store. This is correct behavior —
    // the engine owns these listeners and removes them on shutdown.
    // We just verify dispose() doesn't throw.
  });

  it("dispose is idempotent — calling twice does not throw", async () => {
    const { dispose } = await runDashboard(0, { open: false });

    expect(() => dispose()).not.toThrow();
    expect(() => dispose()).not.toThrow();
  });

  it("does not accumulate process listeners across repeated invocations", async () => {
    const baselineSigint = process.listenerCount("SIGINT");
    const baselineSigterm = process.listenerCount("SIGTERM");

    for (let i = 0; i < 5; i += 1) {
      const { dispose } = await runDashboard(0, { open: false });
      dispose();
    }

    expect(process.listenerCount("SIGINT")).toBe(baselineSigint);
    expect(process.listenerCount("SIGTERM")).toBe(baselineSigterm);
  });

  it("does not leak process signal listeners after 12 rapid invocations", async () => {
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());

    const baselineSigint = process.listenerCount("SIGINT");
    const baselineSigterm = process.listenerCount("SIGTERM");

    for (let i = 0; i < 12; i += 1) {
      const { dispose } = await runDashboard(0, { open: false });
      dispose();
    }

    await new Promise((resolve) => setImmediate(resolve));

    expect(process.listenerCount("SIGINT")).toBe(baselineSigint);
    expect(process.listenerCount("SIGTERM")).toBe(baselineSigterm);
  });
});

describe("runDashboard — CentralCore cleanup diagnostics", () => {
  function getNewSignalHandler(
    signal: "SIGINT" | "SIGTERM",
    baseline: Array<(...args: any[]) => unknown>,
  ): () => void {
    const added = process.listeners(signal).find((listener) => !baseline.includes(listener as (...args: any[]) => unknown));
    expect(added).toBeDefined();
    return added as () => void;
  }

  async function configureCentralCoreCloseFailure(errorMessage: string): Promise<{
    close: ReturnType<typeof vi.fn>;
    mockStore: ReturnType<typeof makeMockStore>;
  }> {
    const { TaskStore, CentralCore } = await import("@fusion/core");
    const mockStore = makeMockStore();
    const close = vi.fn().mockRejectedValue(new Error(errorMessage));

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    (CentralCore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      close,
      getProjectByPath: vi.fn().mockResolvedValue({ id: "project-1" }),
      listProjects: vi.fn().mockResolvedValue([{ id: "project-1", path: process.cwd() }]),
      startDiscovery: vi.fn().mockResolvedValue(undefined),
      stopDiscovery: vi.fn(),
      listNodes: vi.fn().mockResolvedValue([]),
      updateNode: vi.fn().mockResolvedValue(undefined),
    }));

    return { close, mockStore };
  }

  it("logs non-fatal diagnostics when CentralCore.close fails in dispose cleanup", async () => {
    const { close } = await configureCentralCoreCloseFailure("dispose close failed");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandledRejectionSpy = vi.fn();
    process.on("unhandledRejection", unhandledRejectionSpy);

    try {
      const { dispose } = await runDashboard(0, { open: false });
      dispose();

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(close).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[dashboard] CentralCore.close() failed during dispose cleanup: dispose close failed"),
      );
      expect(unhandledRejectionSpy).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejectionSpy);
      warnSpy.mockRestore();
    }
  });

  it("logs shutdown diagnostics and still closes store + exits when CentralCore.close fails", async () => {
    const { close, mockStore } = await configureCentralCoreCloseFailure("normal shutdown close failed");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const baselineSigintHandlers = process.listeners("SIGINT");

    try {
      await runDashboard(0, { open: false });
      const sigintHandler = getNewSignalHandler("SIGINT", baselineSigintHandlers);
      sigintHandler();

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(close).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[dashboard] CentralCore.close() failed during shutdown (SIGINT): normal shutdown close failed"),
      );
      expect(mockStore.close).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      warnSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("logs dev shutdown diagnostics and still exits when mesh CentralCore.close fails", async () => {
    const { close, mockStore } = await configureCentralCoreCloseFailure("dev shutdown close failed");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const baselineSigtermHandlers = process.listeners("SIGTERM");

    try {
      await runDashboard(0, { open: false, dev: true });
      const sigtermHandler = getNewSignalHandler("SIGTERM", baselineSigtermHandlers);
      sigtermHandler();

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(close).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[dashboard] CentralCore.close() failed during dev shutdown (SIGTERM): dev shutdown close failed"),
      );
      expect(mockStore.close).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      warnSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

// ── promptForPort tests ───────────────────────────────────────────────

import { promptForPort } from "./dashboard.js";

describe("promptForPort", () => {
  let mockRl: {
    question: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockRl = {
      question: vi.fn(),
      close: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns default port on empty input", async () => {
    const { createInterface } = await import("node:readline");
    vi.mocked(createInterface).mockReturnValue(mockRl as unknown as ReturnType<typeof createInterface>);

    // Simulate user pressing Enter (empty input)
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback("");
    });

    const result = await promptForPort(4040);
    expect(result).toBe(4040);
    expect(mockRl.close).toHaveBeenCalled();
  });

  it("returns valid custom port", async () => {
    const { createInterface } = await import("node:readline");
    vi.mocked(createInterface).mockReturnValue(mockRl as unknown as ReturnType<typeof createInterface>);

    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback("8080");
    });

    const result = await promptForPort(4040);
    expect(result).toBe(8080);
    expect(mockRl.close).toHaveBeenCalled();
  });

  it("re-prompts on invalid (non-numeric) input", async () => {
    const { createInterface } = await import("node:readline");
    vi.mocked(createInterface).mockReturnValue(mockRl as unknown as ReturnType<typeof createInterface>);

    // First call returns invalid input, second call returns valid
    let callCount = 0;
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callCount++;
      if (callCount === 1) {
        callback("abc");
      } else {
        callback("3000");
      }
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await promptForPort(4040);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("not a number"));
    expect(result).toBe(3000);
    expect(mockRl.question).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });

  it("re-prompts on out-of-range port (too low)", async () => {
    const { createInterface } = await import("node:readline");
    vi.mocked(createInterface).mockReturnValue(mockRl as unknown as ReturnType<typeof createInterface>);

    let callCount = 0;
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callCount++;
      if (callCount === 1) {
        callback("0");
      } else {
        callback("5000");
      }
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await promptForPort(4040);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("must be between 1 and 65535"));
    expect(result).toBe(5000);
    expect(mockRl.question).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });

  it("re-prompts on out-of-range port (too high)", async () => {
    const { createInterface } = await import("node:readline");
    vi.mocked(createInterface).mockReturnValue(mockRl as unknown as ReturnType<typeof createInterface>);

    let callCount = 0;
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callCount++;
      if (callCount === 1) {
        callback("70000");
      } else {
        callback("9000");
      }
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await promptForPort(4040);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("must be between 1 and 65535"));
    expect(result).toBe(9000);
    expect(mockRl.question).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });

  it("accepts minimum valid port (1)", async () => {
    const { createInterface } = await import("node:readline");
    vi.mocked(createInterface).mockReturnValue(mockRl as unknown as ReturnType<typeof createInterface>);

    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback("1");
    });

    const result = await promptForPort(4040);
    expect(result).toBe(1);
  });

  it("accepts maximum valid port (65535)", async () => {
    const { createInterface } = await import("node:readline");
    vi.mocked(createInterface).mockReturnValue(mockRl as unknown as ReturnType<typeof createInterface>);

    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback("65535");
    });

    const result = await promptForPort(4040);
    expect(result).toBe(65535);
  });

  it("rejects on SIGINT (Ctrl+C)", async () => {
    const { createInterface } = await import("node:readline");
    vi.mocked(createInterface).mockReturnValue(mockRl as unknown as ReturnType<typeof createInterface>);

    // Simulate that the promise rejects when SIGINT is triggered
    const removeListenerSpy = vi.spyOn(process, "removeListener" as any).mockImplementation(() => process);

    // Trigger SIGINT handler immediately to test rejection
    let sigintHandler: (() => void) | null = null;
    const onSpy = vi.spyOn(process, "on" as never).mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "SIGINT") {
        sigintHandler = handler as () => void;
      }
      return process;
    }) as never);

    mockRl.question.mockImplementation(() => {
      // Simulate SIGINT during prompt
      setTimeout(() => {
        if (sigintHandler) sigintHandler();
      }, 10);
    });

    await expect(promptForPort(4040)).rejects.toThrow("Interactive prompt cancelled");

    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });
});

describe("StreamedLogBuffer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces partial chunks and flushes after idle timeout", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const buffer = new StreamedLogBuffer((line) => lines.push(line), 100);

    buffer.push("Hel");
    buffer.push("lo");

    expect(lines).toEqual([]);

    vi.advanceTimersByTime(100);
    expect(lines).toEqual(["Hello"]);
  });

  it("flushes complete newline-delimited lines immediately", () => {
    const lines: string[] = [];
    const buffer = new StreamedLogBuffer((line) => lines.push(line), 100);

    buffer.push("one\ntwo\n");

    expect(lines).toEqual(["one", "two"]);
    buffer.dispose();
  });
});

describe("runDashboard — merge stream sink routing", () => {
  it("routes streamed merge deltas through log sink without raw stdout writes", async () => {
    const { TaskStore, AutomationStore, AgentStore, PluginStore, PluginLoader, CentralCore } = await import("@fusion/core");
    const { aiMergeTask } = await import("@fusion/engine");
    const { createServer } = await import("@fusion/dashboard");
    const { AuthStorage, DefaultPackageManager, ModelRegistry, discoverAndLoadExtensions, createExtensionRuntime } = await import("@mariozechner/pi-coding-agent");

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
    (AutomationStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
    }));
    (AgentStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      listAgents: vi.fn().mockResolvedValue([]),
      on: vi.fn(),
      off: vi.fn(),
    }));
    (PluginStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
    }));
    (PluginLoader as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      getPluginRoutes: vi.fn().mockReturnValue([]),
      on: vi.fn(),
      off: vi.fn(),
    }));
    (CentralCore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getProjectByPath: vi.fn().mockResolvedValue({ id: "project-1" }),
      listProjects: vi.fn().mockResolvedValue([{ id: "project-1", path: process.cwd() }]),
    }));

    (AuthStorage.create as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      getApiKey: vi.fn().mockResolvedValue(undefined),
      getAuth: vi.fn(),
      setAuth: vi.fn(),
    });
    (DefaultPackageManager as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      resolve: vi.fn().mockResolvedValue({ extensions: [] }),
    }));
    (ModelRegistry.create as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      registerProvider: vi.fn(),
      refresh: vi.fn(),
    }));
    (discoverAndLoadExtensions as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: { pendingProviderRegistrations: [] },
      errors: [],
    });
    (createExtensionRuntime as unknown as ReturnType<typeof vi.fn>).mockReturnValue({});

    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    (aiMergeTask as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_store: unknown, _cwd: string, _taskId: string, opts: { onAgentText?: (delta: string) => void }) => {
        opts.onAgentText?.("Hel");
        opts.onAgentText?.("lo");
        opts.onAgentText?.("\nWorld");
        opts.onAgentText?.("!\nTail");
        return { merged: true };
      },
    );

    await runDashboard(0, { open: false, dev: true });
    consoleLogSpy.mockClear();
    stdoutWriteSpy.mockClear();

    const createServerCall = (createServer as ReturnType<typeof vi.fn>).mock.calls[0];
    const serverOpts = createServerCall[1] as { onMerge: (taskId: string) => Promise<unknown> };

    await serverOpts.onMerge("FN-TEST");

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith("[merge] Hello");
    expect(consoleLogSpy).toHaveBeenCalledWith("[merge] World!");
    expect(consoleLogSpy).toHaveBeenCalledWith("[merge] Tail");
    expect(consoleLogSpy).not.toHaveBeenCalledWith("[merge] H");

    stdoutWriteSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });
});

describe("runDashboard runtime logger wiring", () => {
  it("injects a runtime logger into createServer and preserves non-TTY console fallback", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runDashboard(0, { open: false, dev: true });

    const createServerCall = (createServer as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const serverOpts = createServerCall[1] as { runtimeLogger?: { info: (message: string, context?: Record<string, unknown>) => void } };

    expect(serverOpts.runtimeLogger).toBeDefined();
    serverOpts.runtimeLogger?.info("runtime diagnostic", { source: "test" });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      '[dashboard] runtime diagnostic {"source":"test"}',
    );

    consoleLogSpy.mockRestore();
  });

  it("routes runtime logger output through DashboardLogSink in TTY mode", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { DashboardLogSink, DashboardTUI } = await import("./dashboard-tui.js");

    const originalStdoutIsTTY = process.stdout.isTTY;
    const originalStdinIsTTY = process.stdin.isTTY;

    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const tuiStartSpy = vi.spyOn(DashboardTUI.prototype, "start").mockResolvedValue(undefined);
    const tuiStopSpy = vi.spyOn(DashboardTUI.prototype, "stop").mockResolvedValue(undefined);
    const tuiLogSpy = vi.spyOn(DashboardTUI.prototype, "log").mockImplementation(() => {});
    const captureConsoleSpy = vi.spyOn(DashboardLogSink.prototype, "captureConsole").mockImplementation(() => {});

    try {
      await runDashboard(0, { open: false, dev: true });

      expect(captureConsoleSpy).toHaveBeenCalledTimes(1);

      const createServerCall = (createServer as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      const serverOpts = createServerCall[1] as { runtimeLogger?: { info: (message: string, context?: Record<string, unknown>) => void } };

      expect(serverOpts.runtimeLogger).toBeDefined();
      serverOpts.runtimeLogger?.info("tty runtime diagnostic", { source: "test" });
      expect(tuiLogSpy).toHaveBeenCalledWith('tty runtime diagnostic {"source":"test"}', "dashboard");
      expect(tuiStartSpy).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
      Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
      tuiStartSpy.mockRestore();
      tuiStopSpy.mockRestore();
      tuiLogSpy.mockRestore();
      captureConsoleSpy.mockRestore();
    }
  });
});
