import type { AddressInfo } from "node:net";
import { TaskStore, AutomationStore, CentralCore, AgentStore, PluginStore, PluginLoader, getTaskMergeBlocker } from "@fusion/core";
import { createServer, GitHubClient, createSkillsAdapter, getProjectSettingsPath } from "@fusion/dashboard";
import { aiMergeTask, MissionAutopilot, MissionExecutionLoop, HeartbeatMonitor, HeartbeatTriggerScheduler, type WakeContext, ProjectEngineManager } from "@fusion/engine";
import { AuthStorage, DefaultPackageManager, ModelRegistry, discoverAndLoadExtensions, getAgentDir, createExtensionRuntime } from "@mariozechner/pi-coding-agent";
import {
  getMergeStrategy,
  processPullRequestMergeTask,
} from "./task-lifecycle.js";
import { promptForPort } from "./port-prompt.js";
import { createReadOnlyProviderSettingsView, createProjectSettingsPersistence } from "./provider-settings.js";
import { wrapAuthStorageWithApiKeyProviders } from "./provider-auth.js";

// Re-export for backward compatibility with tests
export { promptForPort };

let processDiagnosticsRegistered = false;
let diagnosticIntervalHandle: ReturnType<typeof setInterval> | null = null;
const DIAGNOSTIC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let diagnosticStartTime = 0;
let diagnosticDbHealthCheck: (() => boolean) | null = null;
let diagnosticStoreListenerCheck: (() => Record<string, number>) | null = null;

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Format milliseconds to human-readable uptime string
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d${hours % 24}h`;
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Get and log current process diagnostics (memory, handles, requests)
 * @param prefix - Log prefix (e.g., "dashboard", "serve")
 * @param startTime - Process start timestamp
 * @param dbHealthCheck - Optional function to check database health
 */
function logDiagnostics(prefix: string, startTime: number, dbHealthCheck?: () => boolean): void {
  const mem = process.memoryUsage();
  const uptime = Date.now() - startTime;

  // Get active handles/requests if available (Node.js internal)
  let handleCount = -1;
  let requestCount = -1;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleCount = (process as any)._getActiveHandles?.()?.length ?? -1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requestCount = (process as any)._getActiveRequests?.()?.length ?? -1;
  } catch {
    // Ignore errors if these internal APIs are not available
  }

  // Check database health if provided
  let dbHealth = "unknown";
  if (dbHealthCheck) {
    try {
      dbHealth = dbHealthCheck() ? "ok" : "failed";
    } catch {
      dbHealth = "error";
    }
  }

  // Get listener counts if provided
  let listenerInfo = "";
  if (diagnosticStoreListenerCheck) {
    try {
      const counts = diagnosticStoreListenerCheck();
      const listenerEntries = Object.entries(counts)
        .map(([event, count]) => `${event}:${count}`)
        .join(",");
      listenerInfo = ` listeners=${listenerEntries}`;
    } catch {
      // Ignore errors getting listener counts
    }
  }

  const logLine = `[${prefix}] diagnostics: uptime=${formatUptime(uptime)} ` +
    `rss=${formatBytes(mem.rss)} heap=${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapTotal)} ` +
    `external=${formatBytes(mem.external)} arrayBuffers=${formatBytes(mem.arrayBuffers)} ` +
    `handles=${handleCount} requests=${requestCount} db=${dbHealth}${listenerInfo}`;

  console.log(logLine);
}

/**
 * Register process lifecycle diagnostics for long-running process monitoring.
 * Logs memory usage, handle counts, and uptime at startup and every 30 minutes.
 * Also logs beforeExit and exit events for shutdown analysis.
 */
function ensureProcessDiagnostics(): void {
  if (processDiagnosticsRegistered) {
    return;
  }
  processDiagnosticsRegistered = true;

  diagnosticStartTime = Date.now();

  // Log initial diagnostics at startup (before store is created)
  logDiagnostics("dashboard", diagnosticStartTime);

  // Register periodic diagnostics every 30 minutes
  diagnosticIntervalHandle = setInterval(() => {
    logDiagnostics("dashboard", diagnosticStartTime, diagnosticDbHealthCheck ?? undefined);
  }, DIAGNOSTIC_INTERVAL_MS);
  diagnosticIntervalHandle.unref?.(); // Don't prevent process exit

  // Log beforeExit when event loop drains naturally
  process.on("beforeExit", (code: number) => {
    const uptime = Date.now() - diagnosticStartTime;
    let handleCount = -1;
    let requestCount = -1;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleCount = (process as any)._getActiveHandles?.()?.length ?? -1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requestCount = (process as any)._getActiveRequests?.()?.length ?? -1;
    } catch {
      // Ignore
    }
    console.log(`[dashboard] beforeExit code=${code} uptime=${formatUptime(uptime)} handles=${handleCount} requests=${requestCount}`);
  });

  // Log exit event with exit code and uptime
  process.on("exit", (code: number) => {
    const uptime = Date.now() - diagnosticStartTime;
    console.log(`[dashboard] exit code=${code} uptime=${formatUptime(uptime)}`);
  });

  // Log uncaught exceptions
  process.on("uncaughtExceptionMonitor", (error: Error) => {
    console.error(`[dashboard] uncaught exception pid=${process.pid}: ${error.stack || error.message}`);
  });

  // Log unhandled rejections
  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[dashboard] unhandled rejection pid=${process.pid}: ${message}`);
  });
}

/**
 * Stop the diagnostic interval timer. Call during shutdown.
 */
function stopDiagnosticInterval(): void {
  if (diagnosticIntervalHandle) {
    clearInterval(diagnosticIntervalHandle);
    diagnosticIntervalHandle = null;
  }
}

/**
 * Set the database health check function for diagnostics.
 * Call this after the TaskStore is created.
 */
function setDiagnosticDbHealthCheck(check: () => boolean): void {
  diagnosticDbHealthCheck = check;
}

/**
 * Set the store listener count check function for diagnostics.
 * Call this after the TaskStore is created.
 */
function setDiagnosticStoreListenerCheck(check: () => Record<string, number>): void {
  diagnosticStoreListenerCheck = check;
}

export async function runDashboard(port: number, opts: { paused?: boolean; dev?: boolean; interactive?: boolean; open?: boolean } = {}) {
  ensureProcessDiagnostics();

  // Handle interactive port selection
  let selectedPort = port;
  if (opts.interactive) {
    try {
      selectedPort = await promptForPort(port);
    } catch (err: any) {
      if (err.message === "Interactive prompt cancelled") {
        console.log("Cancelled — exiting");
        process.exit(0);
      }
      throw err;
    }
  }
  const cwd = process.cwd();
  const store = new TaskStore(cwd);
  await store.init();
  await store.watch();

  // Set up database health check for diagnostics
  setDiagnosticDbHealthCheck(() => store.healthCheck());

  // Set up store listener count check for diagnostics
  setDiagnosticStoreListenerCheck(() => ({
    "task:created": store.listenerCount("task:created"),
    "task:moved": store.listenerCount("task:moved"),
    "task:updated": store.listenerCount("task:updated"),
    "task:deleted": store.listenerCount("task:deleted"),
    "settings:updated": store.listenerCount("settings:updated"),
    "agent:log": store.listenerCount("agent:log"),
  }));

  const handlers: Array<{
    target: NodeJS.EventEmitter;
    event: string | symbol;
    handler: (...args: any[]) => void;
  }> = [];
  const disposeCallbacks: Array<() => void> = [];
  let disposed = false;
  let shutdownInProgress = false;
  const dashboardStartedAt = Date.now();

  async function logShutdownDiagnostics(reason: string): Promise<void> {
    const uptimeSeconds = Math.round((Date.now() - dashboardStartedAt) / 1000);
    let taskSummary = "tasks=unknown";
    try {
      const tasks = await store.listTasks({ slim: true, includeArchived: false });
      const counts = new Map<string, number>();
      for (const task of tasks) {
        counts.set(task.column, (counts.get(task.column) ?? 0) + 1);
      }
      const active = tasks.filter((task) =>
        task.column === "in-progress" || task.column === "in-review"
      ).length;
      taskSummary = `tasks=${tasks.length} active=${active} columns=${Array.from(counts.entries())
        .map(([column, count]) => `${column}:${count}`)
        .join(",")}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      taskSummary = `tasks=unavailable (${message})`;
    }

    console.log(
      `[dashboard] shutdown requested reason=${reason} pid=${process.pid} ppid=${process.ppid} uptime=${uptimeSeconds}s ${taskSummary}`,
    );
  }

  function registerHandler(
    target: NodeJS.EventEmitter,
    event: string | symbol,
    handler: (...args: any[]) => void,
  ): void {
    target.on(event, handler);
    handlers.push({ target, event, handler });
  }

  // ── AutomationStore: scheduled task persistence ──────────────────────
  const automationStore = new AutomationStore(cwd);
  await automationStore.init();

  // ── AgentStore: agent lifecycle tracking ──────────────────────────
  //
  // Tracks spawned agents so they appear in the dashboard's Agents view
  // and are properly managed throughout their lifecycle (creation, state
  // transitions, termination). Passed to TaskExecutor for agent spawning.
  //
  const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
  await agentStore.init();

  // ── PluginStore: plugin installation management ─────────────────────
  //
  // SQLite-backed plugin persistence for the Settings → Plugins experience.
  // Enables the PluginManager UI to list, install, enable, disable, and
  // configure plugins via the /api/plugins REST endpoints.
  //
  const pluginStore = new PluginStore(store.getFusionDir());
  await pluginStore.init();

  // ── PluginLoader: plugin lifecycle management ───────────────────────
  //
  // Manages dynamic plugin loading, hot-reload, hook invocation, and
  // dependency resolution. The PluginLoader instance also serves as the
  // PluginRunner for the REST routes (provides getPluginRoutes and
  // reloadPlugin methods).
  //
  const pluginLoader = new PluginLoader({
    pluginStore,
    taskStore: store,
  });

  // ── HeartbeatMonitor + HeartbeatTriggerScheduler ──────────────────────
  //
  // In non-dev mode: obtained from ProjectEngine after engine.start(), which
  // delegates to InProcessRuntime's already-initialized instances. This avoids
  // running duplicate heartbeat infrastructure alongside the engine's own.
  //
  // In dev mode: created inline inside the opts.dev block below, since the
  // engine does not start in dev mode.
  //
  // heartbeatMonitorImpl is a mutable reference. The proxy passed to
  // createServer delegates through it so routes work in both modes.
  //
  let heartbeatMonitorImpl: HeartbeatMonitor | undefined;
  let triggerScheduler: HeartbeatTriggerScheduler | undefined;

  // Set enginePaused if starting in paused mode
  if (opts.paused) {
    await store.updateSettings({ enginePaused: true });
    console.log("[engine] Starting in paused mode — automation disabled");
  }

  // ── onMerge: AI-powered merge ─────────────────────────────────────
  //
  // onMergeImpl is a mutable reference so createServer always gets a stable
  // wrapper function while the underlying implementation is swapped when the
  // engine starts in non-dev mode.
  //
  // In dev mode: calls aiMergeTask directly (no engine, no semaphore).
  // In non-dev mode: replaced by engine.onMerge() after ProjectEngine starts
  // (semaphore-gated via the engine's InProcessRuntime).
  //
  const onMergeImpl = (taskId: string) =>
    aiMergeTask(store, cwd, taskId, {
      agentStore,
      onAgentText: (delta) => process.stdout.write(delta),
    });

  const onMerge = (taskId: string) => onMergeImpl(taskId);

  // ── MissionAutopilot + MissionExecutionLoop: mission lifecycle ────
  //
  // Created inline for dev mode (engine doesn't start in dev mode).
  // In non-dev mode, the engine is passed to createServer which derives these.
  //
  const missionAutopilotImpl: MissionAutopilot | undefined = new MissionAutopilot(store, store.getMissionStore());
  const missionExecutionLoopImpl: MissionExecutionLoop | undefined = new MissionExecutionLoop({
    taskStore: store,
    missionStore: store.getMissionStore(),
    missionAutopilot: {
      notifyValidationComplete: async (featureId: string, _status: "passed" | "failed" | "blocked" | "error") => {
        if (missionAutopilotImpl) {
          const missionStore = store.getMissionStore();
          const feature = missionStore?.getFeature(featureId);
          if (feature?.taskId) {
            await missionAutopilotImpl.handleTaskCompletion(feature.taskId);
          }
        }
      },
    },
    rootDir: cwd,
  });

  // ── Auth & model wiring ────────────────────────────────────────────
  // AuthStorage manages OAuth/API-key credentials (stored in ~/.pi/agent/auth.json).
  // ModelRegistry discovers available models from configured providers.
  // Passing these to createServer enables the dashboard's Authentication
  // tab (login/logout) and Model selector.
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  // PackageManager may be used for skills adapter even if extension loading fails
  let packageManager: DefaultPackageManager | undefined;
  try {
    // Resolve extension paths from pi settings packages (npm, git, local).
    // This picks up extensions like @howaboua/pi-glm-via-anthropic that
    // register custom providers (e.g. glm-5.1) via registerProvider().
    const agentDir = getAgentDir();
    packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: createReadOnlyProviderSettingsView(cwd, agentDir) as any,
    });
    const resolvedPaths = await packageManager.resolve();
    const packageExtensionPaths = resolvedPaths.extensions
      .filter((r) => r.enabled)
      .map((r) => r.path);

    // Load all extensions: filesystem-discovered + package-resolved
    const extensionsResult = await discoverAndLoadExtensions(packageExtensionPaths, cwd, undefined);

    for (const { path, error } of extensionsResult.errors) {
      console.log(`[extensions] Failed to load ${path}: ${error}`);
    }

    for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        modelRegistry.registerProvider(name, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[extensions] Failed to register provider from ${extensionPath}: ${message}`);
      }
    }

    extensionsResult.runtime.pendingProviderRegistrations = [];
    modelRegistry.refresh();

    // Eagerly sync OpenRouter models — the pi-openrouter-realtime extension
    // only registers providers on session_start (TUI-only event), so kick off
    // a fetch here so the dashboard model list is populated. Respects the
    // openrouterModelSync setting (defaults to true).
    (async () => {
      try {
        const settings = await store.getSettings();
        if (settings.openrouterModelSync === false) return;
        const hasOrAuth = await authStorage.getApiKey("openrouter");
        const headers: Record<string, string> = {};
        if (hasOrAuth) headers["Authorization"] = `Bearer ${hasOrAuth}`;
        const res = await fetch("https://openrouter.ai/api/v1/models", { headers });
        if (!res.ok) return;
        const json = await res.json() as { data?: Array<{ id: string; name: string; context_length?: number; top_provider?: { max_completion_tokens?: number }; pricing?: Record<string, string>; architecture?: { modality?: string; input_modalities?: string[] } }> };
        const orModels = (json.data || []).map((m: any) => {
          const id = (m.id || "").toLowerCase();
          const name = (m.name || "").toLowerCase();
          const reasoning = id.includes(":thinking") || id.includes("-r1") || id.includes("/r1") || id.includes("o1-") || id.includes("o3-") || id.includes("o4-") || id.includes("reasoner") || name.includes("thinking") || name.includes("reasoner");
          const hasVision = m.architecture?.input_modalities?.includes("image") ?? m.architecture?.modality?.includes("multimodal") ?? false;
          function parseCost(v?: string) { const n = parseFloat(v || "0"); return isNaN(n) ? 0 : n * 1_000_000; }
          return {
            id: m.id,
            name: m.name || m.id,
            reasoning,
            input: (hasVision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
            cost: { input: parseCost(m.pricing?.prompt), output: parseCost(m.pricing?.completion), cacheRead: parseCost(m.pricing?.input_cache_read), cacheWrite: parseCost(m.pricing?.input_cache_write) },
            contextWindow: m.context_length || 128000,
            maxTokens: m.top_provider?.max_completion_tokens || 16384,
          };
        });
        modelRegistry.registerProvider("openrouter", {
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "OPENROUTER_API_KEY",
          api: "openai-completions",
          models: orModels,
        });
        console.log(`[openrouter] Synced ${orModels.length} models from OpenRouter API`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[openrouter] Failed to sync models: ${message}`);
      }
    })();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[extensions] Failed to discover extensions: ${message}`);
    createExtensionRuntime();
    modelRegistry.refresh();
  }

  const dashboardAuthStorage = wrapAuthStorageWithApiKeyProviders(authStorage, modelRegistry);

  // ── Skills adapter for skills discovery and execution toggling ─────────────
  //
  // Create the skills adapter using the same DefaultPackageManager instance
  // that was set up earlier for extension resolution.
  //
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const skillsAdapter = packageManager
    ? createSkillsAdapter({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        packageManager: packageManager as any,
        getSettingsPath: (rootDir: string) => getProjectSettingsPath(rootDir),
      })
    : undefined;

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    for (const { target, event, handler } of handlers) {
      target.off(event, handler);
    }
    handlers.length = 0;
    for (const callback of disposeCallbacks.splice(0)) {
      callback();
    }
  }

  // ── createServer: deferred until engine is conditionally started ────
  //
  // In non-dev mode, pass the engine so createServer derives subsystem
  // options (onMerge, automationStore, missionAutopilot, etc.) automatically.
  // In dev mode, no engine — pass individual proxy objects instead.
  //
  let app: ReturnType<typeof createServer>;

  // Start the AI engine (unless in dev mode)
  if (!opts.dev) {
    // ── ProjectEngineManager: uniform engine lifecycle for all projects ──
    //
    // Every registered project gets an identical ProjectEngine with the
    // full subsystem set (Scheduler, Triage, Executor, auto-merge, PR
    // monitor, notifier, cron, settings listeners). No project is special.
    //
    const githubClient = new GitHubClient();

    const centralCoreForEngine = new CentralCore();
    try {
      await centralCoreForEngine.init();
    } catch {
      // Non-fatal — engine uses fallback concurrency defaults
    }

    const engineManager = new ProjectEngineManager(centralCoreForEngine, {
      getMergeStrategy,
      processPullRequestMerge: (s, wd, taskId) =>
        processPullRequestMergeTask(s, wd, taskId, githubClient, getTaskMergeBlocker),
      getTaskMergeBlocker,
    });

    // Start engines for all registered projects eagerly
    await engineManager.startAll();

    // Start background reconciliation to detect and start engines for projects
    // registered after startup (without requiring dashboard UI access).
    // This ensures project task execution starts from backend runtime alone.
    // The onProjectFirstAccessed callback in createServer remains as a fast-path
    // fallback for immediate engine startup on project access, but it is NOT
    // required for correctness — reconciliation handles all cases.
    engineManager.startReconciliation();

    // Resolve the cwd project's engine for the dashboard's HTTP layer defaults.
    // The engine for the cwd project provides onMerge, automationStore, etc.
    // for requests that arrive without ?projectId=. This is transitional —
    // Phase 5 removes this fallback entirely.
    let cwdEngine: ReturnType<typeof engineManager.getEngine>;
    try {
      const registered = await centralCoreForEngine.getProjectByPath(cwd).catch(() => null);
      if (registered) {
        cwdEngine = engineManager.getEngine(registered.id);
      }
    } catch {
      // cwd not registered — no engine defaults for HTTP layer
    }

    // Get the trigger scheduler from any running engine
    for (const engine of engineManager.getAllEngines().values()) {
      const ts = engine.getHeartbeatTriggerScheduler();
      if (ts) {
        triggerScheduler = ts;
        break;
      }
    }

    disposeCallbacks.push(async () => {
      await engineManager.stopAll();
      await centralCoreForEngine.close().catch(() => {});
    });

    app = createServer(store, {
      engine: cwdEngine,
      engineManager,
      authStorage: dashboardAuthStorage,
      modelRegistry,
      automationStore,
      pluginStore,
      pluginLoader,
      pluginRunner: pluginLoader,
      onProjectFirstAccessed: (projectId: string) => engineManager.onProjectAccessed(projectId),
      skillsAdapter,
    });

    const shutdown = async (signal: NodeJS.Signals) => {
      if (shutdownInProgress) return;
      shutdownInProgress = true;

      // Log active handles at shutdown for diagnostics
      const handleTypes: Record<string, number> = {};
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handles = (process as any)._getActiveHandles?.() ?? [];
        for (const handle of handles) {
          const type = handle.constructor?.name ?? "unknown";
          handleTypes[type] = (handleTypes[type] ?? 0) + 1;
        }
        const handleSummary = Object.entries(handleTypes)
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `${type}:${count}`)
          .join(", ");
        console.log(`[dashboard] active handles at shutdown: ${handleSummary}`);
      } catch {
        // Ignore errors getting handle types
      }

      await logShutdownDiagnostics(signal);
      dispose();
      stopDiagnosticInterval();

      // Stop all project engines uniformly
      await engineManager.stopAll();
      await centralCoreForEngine.close().catch(() => {});

      store.close();
      process.exit(0);
    };
    registerHandler(process, "SIGINT", () => void shutdown("SIGINT"));
    registerHandler(process, "SIGTERM", () => void shutdown("SIGTERM"));

    // Ignore SIGHUP so the dashboard survives SSH session disconnects.
    // Without this, SIGHUP (sent when the controlling terminal closes) kills
    // the process silently — the exit handler tries to log to the now-dead
    // PTY and the write is lost.
    registerHandler(process, "SIGHUP", () => {
      console.log("[dashboard] Received SIGHUP (terminal disconnected) — ignoring");
    });
  } else {
  // Dev mode: create HeartbeatMonitor + TriggerScheduler inline (engine not started)
    try {
      heartbeatMonitorImpl = new HeartbeatMonitor({
        store: agentStore,
        agentStore,
        taskStore: store,
        rootDir: cwd,
        onMissed: (agentId) => {
          console.log(`[engine] Agent ${agentId} missed heartbeat`);
        },
        onTerminated: (agentId) => {
          console.log(`[engine] Agent ${agentId} terminated (unresponsive)`);
        },
      });
      heartbeatMonitorImpl.start();

      triggerScheduler = new HeartbeatTriggerScheduler(
        agentStore,
        async (agentId, source, context: WakeContext) => {
          if (!heartbeatMonitorImpl) return;
          await heartbeatMonitorImpl.executeHeartbeat({
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
        store,
      );
      triggerScheduler.start();

      const agents = await agentStore.listAgents();
      for (const agent of agents) {
        const rc = agent.runtimeConfig;
        if (rc && (rc.heartbeatIntervalMs || rc.enabled !== undefined || rc.maxConcurrentRuns)) {
          triggerScheduler.registerAgent(agent.id, {
            heartbeatIntervalMs: rc.heartbeatIntervalMs as number | undefined,
            enabled: rc.enabled as boolean | undefined,
            maxConcurrentRuns: rc.maxConcurrentRuns as number | undefined,
          });
        }
      }
      if (agents.length > 0) {
        console.log(`[engine] Registered ${triggerScheduler.getRegisteredAgents().length} agents for heartbeat triggers`);
      }
    } catch (err) {
      console.log(`[engine] HeartbeatMonitor initialization failed (continuing without agent monitoring):`, err);
    }

    // Dev mode: no engine, pass individual proxy objects to createServer
    app = createServer(store, {
      onMerge,
      authStorage: dashboardAuthStorage,
      modelRegistry,
      automationStore,
      missionAutopilot: {
        watchMission: (missionId: string) => missionAutopilotImpl?.watchMission(missionId),
        unwatchMission: (missionId: string) => missionAutopilotImpl?.unwatchMission(missionId),
        isWatching: (missionId: string) => missionAutopilotImpl?.isWatching(missionId) ?? false,
        getAutopilotStatus: (missionId: string) => missionAutopilotImpl!.getAutopilotStatus(missionId),
        checkAndStartMission: (missionId: string) => missionAutopilotImpl?.checkAndStartMission(missionId) ?? Promise.resolve(),
        recoverStaleMission: (missionId: string) => missionAutopilotImpl?.recoverStaleMission(missionId) ?? Promise.resolve(),
        start: () => missionAutopilotImpl?.start(),
        stop: () => missionAutopilotImpl?.stop(),
      },
      missionExecutionLoop: {
        recoverActiveMissions: () => missionExecutionLoopImpl?.recoverActiveMissions() ?? Promise.resolve({ recoveredCount: 0 }),
        isRunning: () => missionExecutionLoopImpl?.isRunning() ?? false,
      },
      heartbeatMonitor: {
        rootDir: cwd,
        startRun: (...args: Parameters<HeartbeatMonitor["startRun"]>) => heartbeatMonitorImpl!.startRun(...args),
        executeHeartbeat: (...args: Parameters<HeartbeatMonitor["executeHeartbeat"]>) => heartbeatMonitorImpl!.executeHeartbeat(...args),
        stopRun: (...args: Parameters<HeartbeatMonitor["stopRun"]>) => heartbeatMonitorImpl!.stopRun(...args),
      },
      pluginStore,
      pluginLoader,
      pluginRunner: pluginLoader,
      skillsAdapter,
    });
  }

  // Dev mode: simplified shutdown handlers (no engine components)
  if (opts.dev) {
    const devShutdown = async (signal: NodeJS.Signals) => {
      if (shutdownInProgress) return;
      shutdownInProgress = true;

      // Log active handles at shutdown for diagnostics
      const handleTypes: Record<string, number> = {};
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handles = (process as any)._getActiveHandles?.() ?? [];
        for (const handle of handles) {
          const type = handle.constructor?.name ?? "unknown";
          handleTypes[type] = (handleTypes[type] ?? 0) + 1;
        }
        const handleSummary = Object.entries(handleTypes)
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `${type}:${count}`)
          .join(", ");
        console.log(`[dashboard] active handles at shutdown: ${handleSummary}`);
      } catch {
        // Ignore errors getting handle types
      }

      await logShutdownDiagnostics(signal);
      dispose();
      stopDiagnosticInterval();
      if (triggerScheduler) triggerScheduler.stop();
      if (heartbeatMonitorImpl) heartbeatMonitorImpl.stop();
      store.close();
      process.exit(0);
    };
    registerHandler(process, "SIGINT", () => void devShutdown("SIGINT"));
    registerHandler(process, "SIGTERM", () => void devShutdown("SIGTERM"));

    // Ignore SIGHUP so the dashboard survives SSH session disconnects
    registerHandler(process, "SIGHUP", () => {
      console.log("[dashboard] Received SIGHUP (terminal disconnected) — ignoring");
    });
  }

  const server = app.listen(selectedPort);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      server.listen(0);
    } else {
      console.error(`Failed to start server: ${err.message}`);
      process.exit(1);
    }
  });

  server.on("listening", () => {
    const actualPort = (server.address() as AddressInfo).port;

    if (actualPort !== selectedPort) {
      console.log(`⚠ Port ${selectedPort} in use, using ${actualPort} instead`);
    }

    console.log();
    console.log(`  fn board`);
    console.log(`  ────────────────────────`);
    console.log(`  → http://localhost:${actualPort}`);
    console.log();
    console.log(`  Tasks stored in .fusion/tasks/`);
    console.log(`  Merge:      AI-assisted (conflict resolution + commit messages)`);
    if (opts.dev) {
      console.log(`  AI engine:  ✗ disabled (dev mode)`);
    } else {
      console.log(`  AI engine:  ✓ active`);
      console.log(`    • triage: auto-specifying tasks`);
      console.log(`    • scheduler: dependency-aware execution`);
      console.log(`    • cron: scheduled task execution`);
    }
    console.log(`  File watcher: ✓ active`);
    console.log(`  Press Ctrl+C to stop`);
    console.log();
  });

  return { dispose };
}
