import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  TaskStore,
  AutomationStore,
  CentralCore,
  AgentStore,
  PluginStore,
  PluginLoader,
  getTaskMergeBlocker,
  getEnabledPiExtensionPaths,
  isEphemeralAgent,
  DaemonTokenManager,
  GlobalSettingsStore,
  resolveGlobalDir,
} from "@fusion/core";
import {
  createServer,
  GitHubClient,
  createSkillsAdapter,
  getProjectSettingsPath,
  loadTlsCredentialsFromEnv,
  type RuntimeLogger,
} from "@fusion/dashboard";
import { aiMergeTask, MissionAutopilot, MissionExecutionLoop, HeartbeatMonitor, HeartbeatTriggerScheduler, type WakeContext, ProjectEngineManager, PeerExchangeService } from "@fusion/engine";
import { AuthStorage, DefaultPackageManager, ModelRegistry, SettingsManager, discoverAndLoadExtensions, createExtensionRuntime } from "@mariozechner/pi-coding-agent";
import {
  getMergeStrategy,
  processPullRequestMergeTask,
} from "./task-lifecycle.js";
import { promptForPort } from "./port-prompt.js";
import { createReadOnlyProviderSettingsView } from "./provider-settings.js";
import { createReadOnlyAuthFileStorage, mergeAuthStorageReads, wrapAuthStorageWithApiKeyProviders } from "./provider-auth.js";
import { getFusionAuthPath, getLegacyAuthPaths, getModelRegistryModelsPath, getPackageManagerAgentDir } from "./auth-paths.js";
import { resolveProject } from "../project-context.js";
import {
  ensureClaudeSkillsForAllProjectsOnStartup,
  maybeInstallClaudeSkillForNewProject,
} from "./claude-skills-runner.js";
import {
  getCachedClaudeCliResolution,
  resolveClaudeCliExtensionPaths,
  setCachedClaudeCliResolution,
} from "./claude-cli-extension.js";
import { DashboardTUI, DashboardLogSink, isTTYAvailable, type SystemInfo } from "./dashboard-tui.js";

// Re-export for backward compatibility with tests
export { promptForPort };

let processDiagnosticsRegistered = false;
let diagnosticIntervalHandle: ReturnType<typeof setInterval> | null = null;
const DIAGNOSTIC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let diagnosticStartTime = 0;
let diagnosticDbHealthCheck: (() => boolean) | null = null;
let diagnosticStoreListenerCheck: (() => Record<string, number>) | null = null;

const STREAM_LOG_FLUSH_IDLE_MS = 100;

function formatRuntimeContext(context: Record<string, unknown> | undefined): string {
  if (context === undefined) {
    return "";
  }

  try {
    return ` ${JSON.stringify(context)}`;
  } catch {
    return ` ${String(context)}`;
  }
}

function createDashboardRuntimeLogger(logSink: DashboardLogSink, scope: string): RuntimeLogger {
  return {
    scope,
    info(message, context) {
      logSink.log(`${message}${formatRuntimeContext(context)}`, scope);
    },
    warn(message, context) {
      logSink.warn(`${message}${formatRuntimeContext(context)}`, scope);
    },
    error(message, context) {
      logSink.error(`${message}${formatRuntimeContext(context)}`, scope);
    },
    child(childScope) {
      return createDashboardRuntimeLogger(logSink, `${scope}:${childScope}`);
    },
  };
}

export class StreamedLogBuffer {
  private pending = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emitLine: (line: string) => void,
    private readonly flushIdleMs: number = STREAM_LOG_FLUSH_IDLE_MS,
  ) {}

  push(delta: string): void {
    if (!delta) return;

    this.pending += delta;
    this.flushCompletedLines();
    this.scheduleFlush();
  }

  flush(): void {
    this.clearFlushTimer();
    const trailing = this.pending.trim();
    if (trailing.length > 0) {
      this.emitLine(trailing);
    }
    this.pending = "";
  }

  dispose(): void {
    this.clearFlushTimer();
    this.pending = "";
  }

  private flushCompletedLines(): void {
    if (!this.pending.includes("\n")) {
      return;
    }

    const splitLines = this.pending.split(/\r?\n/);
    const completeLines = splitLines.slice(0, -1);
    this.pending = splitLines[splitLines.length - 1] ?? "";

    for (const line of completeLines) {
      const normalized = line.trim();
      if (normalized.length > 0) {
        this.emitLine(normalized);
      }
    }
  }

  private scheduleFlush(): void {
    this.clearFlushTimer();
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, this.flushIdleMs);
    this.flushTimer.unref?.();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

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
function logDiagnostics(logger: RuntimeLogger, prefix: string, startTime: number, dbHealthCheck?: () => boolean): void {
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

  logger.info(logLine);
}

/**
 * Register process lifecycle diagnostics for long-running process monitoring.
 * Logs memory usage, handle counts, and uptime at startup and every 30 minutes.
 * Also logs beforeExit and exit events for shutdown analysis.
 */
function ensureProcessDiagnostics(logger: RuntimeLogger): void {
  if (processDiagnosticsRegistered) {
    return;
  }
  processDiagnosticsRegistered = true;

  diagnosticStartTime = Date.now();

  // Log initial diagnostics at startup (before store is created)
  logDiagnostics(logger, "dashboard", diagnosticStartTime);

  // Register periodic diagnostics every 30 minutes
  diagnosticIntervalHandle = setInterval(() => {
    logDiagnostics(logger, "dashboard", diagnosticStartTime, diagnosticDbHealthCheck ?? undefined);
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
    logger.info(`[dashboard] beforeExit code=${code} uptime=${formatUptime(uptime)} handles=${handleCount} requests=${requestCount}`);
  });

  // Log exit event with exit code and uptime
  process.on("exit", (code: number) => {
    const uptime = Date.now() - diagnosticStartTime;
    logger.info(`[dashboard] exit code=${code} uptime=${formatUptime(uptime)}`);
  });

  // Log uncaught exceptions
  process.on("uncaughtExceptionMonitor", (error: Error) => {
    logger.error(`[dashboard] uncaught exception pid=${process.pid}: ${error.stack || error.message}`);
  });

  // Log unhandled rejections
  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    logger.error(`[dashboard] unhandled rejection pid=${process.pid}: ${message}`);
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

async function resolveRuntimeProjectPath(): Promise<string> {
  try {
    return (await resolveProject(undefined)).projectPath;
  } catch {
    return process.cwd();
  }
}

async function resolveDashboardAuthToken(opts: { noAuth?: boolean; token?: string }): Promise<string | undefined> {
  if (opts.noAuth) {
    return undefined;
  }

  const explicitToken = opts.token
    ?? process.env.FUSION_DASHBOARD_TOKEN
    ?? process.env.FUSION_DAEMON_TOKEN;

  if (explicitToken) {
    return explicitToken;
  }

  const globalDir = resolveGlobalDir();
  const settingsStore = new GlobalSettingsStore(globalDir);
  const tokenManager = new DaemonTokenManager(settingsStore);

  if (typeof tokenManager.getOrCreateToken === "function") {
    return tokenManager.getOrCreateToken();
  }

  const existingToken = await tokenManager.getToken();
  if (existingToken) {
    return existingToken;
  }
  return tokenManager.generateToken();
}

export async function runDashboard(port: number, opts: { paused?: boolean; dev?: boolean; interactive?: boolean; open?: boolean; host?: string; noAuth?: boolean; token?: string } = {}) {
  // Default to localhost so the dashboard (and its shell-capable terminal API)
  // is not exposed on the LAN. Pass --host 0.0.0.0 explicitly to opt-in.
  const selectedHost = opts.host ?? "127.0.0.1";

  // ── Bearer-token auth ────────────────────────────────────────────────
  //
  // By default the dashboard API is gated by a bearer token so that when the
  // server is bound to a non-localhost interface (e.g. `pnpm dev dashboard`
  // which injects --host 0.0.0.0 for LAN testing) nearby users can't hit the
  // terminal or exec endpoints uninvited. Precedence:
  //   1. `opts.token`             — explicit override (mostly for tests)
  //   2. `FUSION_DASHBOARD_TOKEN` — user-provided env
  //   3. `FUSION_DAEMON_TOKEN`    — back-compat with daemon mode
  //   4. stored token in ~/.fusion/settings.json
  //   5. newly generated persisted token (first authenticated run only)
  // `--no-auth` skips the middleware entirely. The token is embedded in the
  // launch URL (as `?token=...`) so the user can click once and the browser
  // stores it to localStorage for subsequent loads.
  const dashboardAuthToken = await resolveDashboardAuthToken(opts);

  // Single sink/logger pair for all dashboard command diagnostics.
  // In TTY mode this routes to DashboardTUI; in non-TTY mode it falls back to console.*.
  const logSink = new DashboardLogSink();
  const runtimeLogger = createDashboardRuntimeLogger(logSink, "dashboard");

  // Handle interactive port selection
  let selectedPort = port;
  if (opts.interactive) {
    try {
      selectedPort = await promptForPort(port);
    } catch (err) {
      if (err instanceof Error && err.message === "Interactive prompt cancelled") {
        console.log("Cancelled — exiting");
        process.exit(0);
      }
      throw err;
    }
  }
  const cwd = await resolveRuntimeProjectPath();

  // ── TTY Detection & TUI Initialization ─────────────────────────────
  //
  // When both stdout and stdin are TTY, we activate the interactive TUI
  // instead of plain console output. The TUI provides 5 sections:
  // system, logs, utilities, stats, settings with keyboard navigation.
  //
  // In non-TTY mode (CI, piped output), we fall back to plain console
  // output to maintain compatibility with automated workflows.
  //
  const isTTY = isTTYAvailable();
  let tui: DashboardTUI | undefined;
  const dashboardStartedAt = Date.now();

  // Declare store and agentStore early so callbacks can safely reference them
  // (they're assigned after initialization, but the variables exist from the start).
  // prefer-const disabled: callbacks close over these identifiers before the
  // single assignment below, which requires `let` even though no reassignment occurs.
  // eslint-disable-next-line prefer-const
  let store: TaskStore | undefined;
  // eslint-disable-next-line prefer-const
  let agentStore: AgentStore | undefined;

  if (isTTY) {
    tui = new DashboardTUI();
    // Set up callbacks for utility actions
    tui.setCallbacks({
      onRefreshStats: async () => {
        if (store && agentStore) {
          const tasks = await store.listTasks({ slim: true, includeArchived: false });
          const counts = new Map<string, number>();
          for (const task of tasks) {
            counts.set(task.column, (counts.get(task.column) ?? 0) + 1);
          }
          const active = tasks.filter((task) =>
            task.column === "in-progress" || task.column === "in-review"
          ).length;
          const agents = await agentStore.listAgents();
          const agentStats = { idle: 0, active: 0, running: 0, error: 0 };
          for (const agent of agents) {
            const state = agent.state as keyof typeof agentStats;
            if (state in agentStats) {
              agentStats[state]++;
            }
          }
          tui!.setTaskStats({
            total: tasks.length,
            byColumn: Object.fromEntries(counts),
            active,
            agents: agentStats,
          });
        }
      },
      onClearLogs: () => {
        // Logs are already cleared in TUI, this is for external notification
      },
      onTogglePause: async (paused: boolean) => {
        if (store) {
          await store.updateSettings({ enginePaused: paused });
          tui!.log(`Engine ${paused ? "paused" : "resumed"}`);
          const fullSettings = await store.getSettings();
          // Return SettingsValues subset for TUI
          return {
            maxConcurrent: fullSettings.maxConcurrent ?? 1,
            maxWorktrees: fullSettings.maxWorktrees ?? 2,
            autoMerge: fullSettings.autoMerge ?? false,
            mergeStrategy: fullSettings.mergeStrategy ?? "direct",
            pollIntervalMs: fullSettings.pollIntervalMs ?? 60_000,
            enginePaused: fullSettings.enginePaused ?? false,
            globalPause: fullSettings.globalPause ?? false,
          };
        }
        return {
          maxConcurrent: 1,
          maxWorktrees: 2,
          autoMerge: false,
          mergeStrategy: "direct",
          pollIntervalMs: 60_000,
          enginePaused: paused,
          globalPause: false,
        };
      },
    });
    // Start the TUI
    await tui.start();

    // Wire the TUI into the log sink so all console output routes through TUI
    logSink.setTUI(tui);
    // Capture stdlib console.* so engine/scheduler/pi/etc. log lines (which
    // go straight to console.error via createLogger in @fusion/engine) land
    // in the TUI's ring buffer instead of being overwritten by the alt screen.
    logSink.captureConsole();
  }

  // Register long-running process diagnostics after TTY sink wiring so
  // startup/runtime lines flow into the TUI log buffer when interactive.
  ensureProcessDiagnostics(runtimeLogger);

  store = new TaskStore(cwd);
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

  // ── Reactive TUI Updates ─────────────────────────────────────────────
  //
  // Subscribe to store and agent events to keep the TUI Stats/Settings
  // panels in sync without manual refresh.
  //
  let tuiRefreshPending = false;
  let tuiRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Debounced refresh of TUI stats - batches rapid task updates
   */
  async function refreshTUIStats(): Promise<void> {
    if (!tui || !isTTY) return;
    if (!store || !agentStore) return;

    // Mark pending to prevent duplicate refreshes
    if (tuiRefreshPending) return;
    tuiRefreshPending = true;

    try {
      const tasks = await store.listTasks({ slim: true, includeArchived: false });
      const counts = new Map<string, number>();
      for (const task of tasks) {
        counts.set(task.column, (counts.get(task.column) ?? 0) + 1);
      }
      const active = tasks.filter((task) =>
        task.column === "in-progress" || task.column === "in-review"
      ).length;
      const agents = await agentStore.listAgents();
      const agentStats = { idle: 0, active: 0, running: 0, error: 0 };
      for (const agent of agents) {
        const state = agent.state as keyof typeof agentStats;
        if (state in agentStats) {
          agentStats[state]++;
        }
      }
      tui.setTaskStats({
        total: tasks.length,
        byColumn: Object.fromEntries(counts),
        active,
        agents: agentStats,
      });
    } finally {
      tuiRefreshPending = false;
    }
  }

  /**
   * Debounced settings refresh
   */
  async function refreshTUISettings(): Promise<void> {
    if (!tui || !isTTY) return;
    if (!store) return;

    try {
      const settings = await store.getSettings();
      tui.setSettings({
        maxConcurrent: settings.maxConcurrent ?? 1,
        maxWorktrees: settings.maxWorktrees ?? 2,
        autoMerge: settings.autoMerge ?? false,
        mergeStrategy: settings.mergeStrategy ?? "direct",
        pollIntervalMs: settings.pollIntervalMs ?? 60_000,
        enginePaused: settings.enginePaused ?? false,
        globalPause: settings.globalPause ?? false,
      });
    } catch {
      // Ignore errors refreshing settings
    }
  }

  /**
   * Schedule a debounced stats refresh (batches rapid changes)
   */
  function scheduleStatsRefresh(): void {
    if (tuiRefreshDebounceTimer) {
      clearTimeout(tuiRefreshDebounceTimer);
    }
    tuiRefreshDebounceTimer = setTimeout(() => {
      void refreshTUIStats();
    }, 500); // 500ms debounce
  }

  const handlers: Array<{
    target: NodeJS.EventEmitter;
    event: string | symbol;
    handler: (...args: any[]) => void;
  }> = [];
  const disposeCallbacks: Array<() => void> = [];
  let disposed = false;
  let shutdownInProgress = false;

  async function logShutdownDiagnostics(reason: string): Promise<void> {
    const uptimeSeconds = Math.round((Date.now() - dashboardStartedAt) / 1000);
    let taskSummary = "tasks=unknown";
    try {
      if (!store) {
        taskSummary = "tasks=unavailable (store not initialized)";
        logSink.log(`shutdown requested reason=${reason} pid=${process.pid} ppid=${process.ppid} uptime=${uptimeSeconds}s ${taskSummary}`, "dashboard");
        return;
      }
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

    logSink.log(
      `shutdown requested reason=${reason} pid=${process.pid} ppid=${process.ppid} uptime=${uptimeSeconds}s ${taskSummary}`,
      "dashboard",
    );
  }

  async function closeCentralCoreBestEffort(core: CentralCore, context: string): Promise<void> {
    try {
      await core.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSink.warn(`CentralCore.close() failed during ${context}: ${message}`, "dashboard");
    }
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
  agentStore = new AgentStore({ rootDir: store.getFusionDir() });
  await agentStore.init();

  // ── Reactive TUI Updates ─────────────────────────────────────────────
  //
  // Subscribe to store and agent events to keep the TUI Stats/Settings
  // panels in sync without manual refresh.
  //
  if (tui && isTTY) {
    // Subscribe to task events for reactive stats updates
    registerHandler(store, "task:created", scheduleStatsRefresh);
    registerHandler(store, "task:moved", scheduleStatsRefresh);
    registerHandler(store, "task:updated", scheduleStatsRefresh);
    registerHandler(store, "task:deleted", scheduleStatsRefresh);

    // Subscribe to settings updates
    registerHandler(store, "settings:updated", () => {
      void refreshTUISettings();
    });

    // Subscribe to agent events via agentStore
    registerHandler(agentStore, "agent:created", scheduleStatsRefresh);
    registerHandler(agentStore, "agent:updated", scheduleStatsRefresh);
    registerHandler(agentStore, "agent:deleted", scheduleStatsRefresh);
  }

  // ── PluginStore: plugin installation management ─────────────────────
  //
  // SQLite-backed plugin persistence for the Settings → Plugins experience.
  // Enables the PluginManager UI to list, install, enable, disable, and
  // configure plugins via the /api/plugins REST endpoints.
  //
  const pluginStoreRootDir =
    typeof (store as { getRootDir?: () => string }).getRootDir === "function"
      ? store.getRootDir()
      : store.getFusionDir();
  const pluginStore = new PluginStore(pluginStoreRootDir);
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
    logSink.log("Starting in paused mode — automation disabled", "engine");
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
  const onMergeImpl = async (taskId: string) => {
    const streamedMergeLog = new StreamedLogBuffer(
      (line) => logSink.log(line, "merge"),
      STREAM_LOG_FLUSH_IDLE_MS,
    );

    try {
      return await aiMergeTask(store, cwd, taskId, {
        agentStore,
        onAgentText: (delta) => streamedMergeLog.push(delta),
      });
    } finally {
      streamedMergeLog.flush();
      streamedMergeLog.dispose();
    }
  };

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
  // AuthStorage manages OAuth/API-key credentials (stored in ~/.fusion/agent/auth.json).
  // ModelRegistry discovers available models from configured providers.
  // Passing these to createServer enables the dashboard's Authentication
  // tab (login/logout) and Model selector.
  const authStorage = AuthStorage.create(getFusionAuthPath());
  const legacyAuthStorage = createReadOnlyAuthFileStorage(getLegacyAuthPaths());
  const mergedAuthStorage = mergeAuthStorageReads(authStorage, [legacyAuthStorage]);
  const modelRegistry = ModelRegistry.create(mergedAuthStorage, getModelRegistryModelsPath());
  const dashboardAuthStorage = wrapAuthStorageWithApiKeyProviders(mergedAuthStorage, modelRegistry);

  // PackageManager may be used for skills adapter even if extension loading fails
  let packageManager: DefaultPackageManager | undefined;
  try {
    // Resolve extension paths from pi settings packages (npm, git, local).
    // This picks up extensions like @howaboua/pi-glm-via-anthropic that
    // register custom providers (e.g. glm-5.1) via registerProvider().
    const agentDir = getPackageManagerAgentDir();
    packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: createReadOnlyProviderSettingsView(cwd, agentDir) as unknown as SettingsManager,
    });
    const resolvedPaths = await packageManager.resolve();
    const packageExtensionPaths = resolvedPaths.extensions
      .filter((r) => r.enabled)
      .map((r) => r.path);

    const claudeCliPaths = await (async () => {
      try {
        const globalSettings = await store.getGlobalSettingsStore().getSettings();
        const result = resolveClaudeCliExtensionPaths(globalSettings);
        setCachedClaudeCliResolution(result.resolution);
        if (result.warning) {
          console.warn(`[extensions] pi-claude-cli: ${result.warning}`);
        }
        return result.paths;
      } catch (err) {
        console.warn(
          `[extensions] Unable to evaluate useClaudeCli setting: ${err instanceof Error ? err.message : String(err)}`,
        );
        setCachedClaudeCliResolution(null);
        return [];
      }
    })();

    // Load all enabled extensions: Fusion/Pi filesystem-discovered + package-resolved.
    const extensionsResult = await discoverAndLoadExtensions(
      [
        ...getEnabledPiExtensionPaths(cwd),
        ...packageExtensionPaths,
        ...claudeCliPaths,
      ],
      cwd,
      join(cwd, ".fusion", "disabled-auto-extension-discovery"),
    );

    for (const { path, error } of extensionsResult.errors) {
      logSink.log(`Failed to load ${path}: ${error}`, "extensions");
    }

    for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        modelRegistry.registerProvider(name, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSink.log(`Failed to register provider from ${extensionPath}: ${message}`, "extensions");
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
        const hasOrAuth = await dashboardAuthStorage.getApiKey("openrouter");
        const headers: Record<string, string> = {};
        if (hasOrAuth) headers["Authorization"] = `Bearer ${hasOrAuth}`;
        const res = await fetch("https://openrouter.ai/api/v1/models", { headers });
        if (!res.ok) return;
        const json = await res.json() as { data?: Array<{ id: string; name: string; context_length?: number; top_provider?: { max_completion_tokens?: number }; pricing?: Record<string, string>; architecture?: { modality?: string; input_modalities?: string[] } }> };
        const orModels = (json.data || []).map((m) => {
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
        logSink.log(`Synced ${orModels.length} models from OpenRouter API`, "openrouter");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSink.log(`Failed to sync models: ${message}`, "openrouter");
      }
    })();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logSink.log(`Failed to discover extensions: ${message}`, "extensions");
    createExtensionRuntime();
    modelRegistry.refresh();
  }

  // ── Skills adapter for skills discovery and execution toggling ─────────────
  //
  // Create the skills adapter using the same DefaultPackageManager instance
  // that was set up earlier for extension resolution.
  const skillsAdapter = packageManager
    ? createSkillsAdapter({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dashboard's resolve() uses a looser onMissing signature than pi's DefaultPackageManager
        packageManager: packageManager as any,
        getSettingsPath: (rootDir: string) => getProjectSettingsPath(rootDir),
      })
    : undefined;

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    // Clear pending debounce timer
    if (tuiRefreshDebounceTimer) {
      clearTimeout(tuiRefreshDebounceTimer);
      tuiRefreshDebounceTimer = null;
    }

    // Stop TUI if active
    if (tui) {
      // Restore console.* before stopping the TUI so any log lines emitted
      // during teardown (or by late-firing listeners) go to the real terminal
      // instead of a ring buffer that's about to disappear.
      logSink.releaseConsole();
      void tui.stop();
    }

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

  // ── Mesh networking: peer exchange + mDNS discovery ──────────────────
  //
  // peerExchangeService: periodically syncs peer info with connected nodes
  // centralCoreForMesh: CentralCore for discovery/node lifecycle (may differ from centralCoreForEngine)
  // localNodeIdForMesh: tracks the local node ID for cleanup on shutdown
  //
  let peerExchangeService: PeerExchangeService | null = null;
  let centralCoreForMesh: CentralCore | null = null;
  let localNodeIdForMesh: string | undefined;

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

    // Backfill Claude Code skills for all registered projects. No-op when
    // pi-claude-cli isn't configured; non-blocking to protect startup latency.
    void (async () => {
      try {
        if (!centralCoreForEngine) return;
        const projects = await centralCoreForEngine.listProjects();
        ensureClaudeSkillsForAllProjectsOnStartup(
          projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
        );
      } catch (err) {
        logSink.log(
          `Claude skill reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
          "engine",
        );
      }
    })();

    // ── PeerExchangeService: gossip protocol for mesh peer discovery ──────
    //
    // Reuse centralCoreForEngine for peer exchange since it handles all mesh ops.
    //
    peerExchangeService = new PeerExchangeService(centralCoreForEngine);
    try {
      peerExchangeService.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSink.warn(`Failed to start peer exchange service: ${message}`, "dashboard");
    }

    // Use the same CentralCore instance for mesh operations
    centralCoreForMesh = centralCoreForEngine;

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
      await closeCentralCoreBestEffort(centralCoreForEngine, "dispose cleanup");
    });

    app = createServer(store, {
      engine: cwdEngine,
      engineManager,
      centralCore: centralCoreForEngine,
      authStorage: dashboardAuthStorage,
      modelRegistry,
      automationStore,
      pluginStore,
      pluginLoader,
      pluginRunner: pluginLoader,
      onProjectFirstAccessed: (projectId: string) => engineManager.onProjectAccessed(projectId),
      onProjectRegistered: ({ path }) => {
        maybeInstallClaudeSkillForNewProject(path);
      },
      getClaudeCliExtensionStatus: () => {
        const r = getCachedClaudeCliResolution();
        if (!r) return null;
        if (r.status === "ok") {
          return { status: "ok", path: r.path, packageVersion: r.packageVersion };
        }
        if (r.status === "not-installed") {
          return { status: "not-installed" };
        }
        return { status: r.status, reason: r.reason };
      },
      onUseClaudeCliToggled: (_prev, next) => {
        if (!next) return;
        void (async () => {
          try {
            if (!centralCoreForEngine) return;
            const projects = await centralCoreForEngine.listProjects();
            ensureClaudeSkillsForAllProjectsOnStartup(
              projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
            );
          } catch (err) {
            logSink.log(
              `Claude skill backfill on toggle failed: ${err instanceof Error ? err.message : String(err)}`,
              "engine",
            );
          }
        })();
      },
      skillsAdapter,
      https: loadTlsCredentialsFromEnv(),
      daemon: dashboardAuthToken ? { token: dashboardAuthToken } : undefined,
      noAuth: opts.noAuth,
      runtimeLogger,
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
        logSink.log(`active handles at shutdown: ${handleSummary}`, "dashboard");
      } catch {
        // Ignore errors getting handle types
      }

      await logShutdownDiagnostics(signal);
      dispose();
      stopDiagnosticInterval();

      // Stop all project engines uniformly
      await engineManager.stopAll();

      // Stop peer exchange service
      if (peerExchangeService) {
        try {
          await peerExchangeService.stop();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logSink.warn(`Failed to stop peer exchange service: ${message}`, "dashboard");
        }
      }

      // Stop mDNS discovery and set local node offline
      if (centralCoreForMesh && localNodeIdForMesh) {
        try {
          centralCoreForMesh.stopDiscovery();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logSink.warn(`Failed to stop mDNS discovery: ${message}`, "dashboard");
        }
        try {
          await centralCoreForMesh.updateNode(localNodeIdForMesh, { status: "offline" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logSink.warn(`Failed to set local node offline: ${message}`, "dashboard");
        }
      }

      await closeCentralCoreBestEffort(centralCoreForEngine, `shutdown (${signal})`);

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
      logSink.log("Received SIGHUP (terminal disconnected) — ignoring", "dashboard");
    });
  } else {
  // Dev mode: create HeartbeatMonitor + TriggerScheduler inline (engine not started)

    // ── Mesh networking for dev mode ─────────────────────────────────────
    //
    // In dev mode we don't use the engine's CentralCore, so create a separate
    // instance for peer exchange and mDNS discovery.
    //
    try {
      centralCoreForMesh = new CentralCore();
      await centralCoreForMesh.init();

      peerExchangeService = new PeerExchangeService(centralCoreForMesh);
      peerExchangeService.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSink.warn(`Failed to initialize mesh networking: ${message}`, "dashboard");
    }

    try {
      heartbeatMonitorImpl = new HeartbeatMonitor({
        store: agentStore,
        agentStore,
        taskStore: store,
        rootDir: cwd,
        onMissed: (agentId) => {
          logSink.log(`Agent ${agentId} missed heartbeat`, "engine");
        },
        onTerminated: (agentId) => {
          logSink.log(`Agent ${agentId} terminated (unresponsive)`, "engine");
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
        // State is the source of truth: arm timers only for non-ephemeral
        // agents that are currently active/running. Transitions into
        // tickable states while the scheduler is already running are
        // handled by the scheduler's own agent:updated listener.
        if (isEphemeralAgent(agent)) continue;
        if (agent.state !== "active" && agent.state !== "running") continue;
        const rc = agent.runtimeConfig;
        triggerScheduler.registerAgent(agent.id, {
          heartbeatIntervalMs: rc?.heartbeatIntervalMs as number | undefined,
          maxConcurrentRuns: rc?.maxConcurrentRuns as number | undefined,
        });
      }
      if (agents.length > 0) {
        logSink.log(`Registered ${triggerScheduler.getRegisteredAgents().length} agents for heartbeat triggers`, "engine");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSink.log(`HeartbeatMonitor initialization failed (continuing without agent monitoring): ${message}`, "engine");
    }

    // Dev mode: no engine, pass individual proxy objects to createServer
    app = createServer(store, {
      onMerge,
      centralCore: centralCoreForMesh ?? undefined,
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
      onProjectRegistered: ({ path }) => {
        maybeInstallClaudeSkillForNewProject(path);
      },
      getClaudeCliExtensionStatus: () => {
        const r = getCachedClaudeCliResolution();
        if (!r) return null;
        if (r.status === "ok") {
          return { status: "ok", path: r.path, packageVersion: r.packageVersion };
        }
        if (r.status === "not-installed") {
          return { status: "not-installed" };
        }
        return { status: r.status, reason: r.reason };
      },
      onUseClaudeCliToggled: (_prev, next) => {
        if (!next) return;
        void (async () => {
          try {
            if (!centralCoreForMesh) return;
            const projects = await centralCoreForMesh.listProjects();
            ensureClaudeSkillsForAllProjectsOnStartup(
              projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
            );
          } catch (err) {
            logSink.log(
              `Claude skill backfill on toggle failed: ${err instanceof Error ? err.message : String(err)}`,
              "engine",
            );
          }
        })();
      },
      skillsAdapter,
      https: loadTlsCredentialsFromEnv(),
      daemon: dashboardAuthToken ? { token: dashboardAuthToken } : undefined,
      noAuth: opts.noAuth,
      runtimeLogger,
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
        logSink.log(`active handles at shutdown: ${handleSummary}`, "dashboard");
      } catch {
        // Ignore errors getting handle types
      }

      await logShutdownDiagnostics(signal);
      dispose();
      stopDiagnosticInterval();
      if (triggerScheduler) triggerScheduler.stop();
      if (heartbeatMonitorImpl) heartbeatMonitorImpl.stop();

      // Stop peer exchange service
      if (peerExchangeService) {
        try {
          await peerExchangeService.stop();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logSink.warn(`Failed to stop peer exchange service: ${message}`, "dashboard");
        }
      }

      // Stop mDNS discovery and set local node offline
      if (centralCoreForMesh && localNodeIdForMesh) {
        try {
          centralCoreForMesh.stopDiscovery();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logSink.warn(`Failed to stop mDNS discovery: ${message}`, "dashboard");
        }
        try {
          await centralCoreForMesh.updateNode(localNodeIdForMesh, { status: "offline" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logSink.warn(`Failed to set local node offline: ${message}`, "dashboard");
        }
      }

      if (centralCoreForMesh) {
        await closeCentralCoreBestEffort(centralCoreForMesh, `dev shutdown (${signal})`);
      }

      store.close();
      process.exit(0);
    };
    registerHandler(process, "SIGINT", () => void devShutdown("SIGINT"));
    registerHandler(process, "SIGTERM", () => void devShutdown("SIGTERM"));

    // Ignore SIGHUP so the dashboard survives SSH session disconnects
    registerHandler(process, "SIGHUP", () => {
      logSink.log("Received SIGHUP (terminal disconnected) — ignoring", "dashboard");
    });
  }

  const server = app.listen(selectedPort, selectedHost);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      server.listen(0, selectedHost);
    } else {
      logSink.error(`Failed to start server: ${err.message}`, "dashboard");
      process.exit(1);
    }
  });

  server.on("listening", async () => {
    const actualPort = (server.address() as AddressInfo).port;

    if (actualPort !== selectedPort) {
      logSink.warn(`Port ${selectedPort} in use, using ${actualPort} instead`, "dashboard");
    }

    // ── mDNS discovery: broadcast presence and listen for other nodes ───────
    //
    // Advertises this node on the local network and discovers other Fusion nodes
    // without requiring manual configuration.
    //
    if (centralCoreForMesh) {
      try {
        await centralCoreForMesh.startDiscovery({
          broadcast: true,
          listen: true,
          serviceType: "_fusion._tcp",
          port: actualPort,
          staleTimeoutMs: 300_000,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSink.warn(`Failed to start mDNS discovery: ${message}`, "dashboard");
      }
    }

    // ── CentralCore: set local node online ─────────────────────────────────
    //
    // Find the local node and mark it as online now that we know the port.
    //
    if (centralCoreForMesh) {
      try {
        const nodes = await centralCoreForMesh.listNodes();
        const localNode = nodes.find((node) => node.type === "local");
        if (localNode) {
          localNodeIdForMesh = localNode.id;
          await centralCoreForMesh.updateNode(localNode.id, { status: "online" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSink.warn(`Failed to set local node online: ${message}`, "dashboard");
      }
    }

    // Compose the user-visible URL. When we're bound to a non-localhost
    // interface (LAN testing), surface the actual host so the URL is
    // usable from another device. Otherwise keep it as `localhost` for
    // the nicer click-to-open experience.
    const displayHost =
      selectedHost === "0.0.0.0" || selectedHost === "::" ? selectedHost : "localhost";
    const baseUrl = `http://${displayHost}:${actualPort}`;
    const tokenizedUrl = dashboardAuthToken
      ? `${baseUrl}/?token=${encodeURIComponent(dashboardAuthToken)}`
      : baseUrl;

    // ── TTY Mode: Set system info on TUI ───────────────────────────────
    //
    // In TTY mode, we populate the TUI System panel instead of printing
    // the plain-text banner. The TUI provides navigation and real-time
    // log streaming.
    //
    if (isTTY && tui) {
      // Determine engine mode
      const settings = await store.getSettings();
      const engineMode = opts.dev ? "dev" : settings.enginePaused ? "paused" : "active";

      const systemInfo: SystemInfo = {
        host: displayHost,
        port: actualPort,
        baseUrl,
        authEnabled: Boolean(dashboardAuthToken),
        authToken: dashboardAuthToken,
        tokenizedUrl: dashboardAuthToken ? tokenizedUrl : undefined,
        engineMode,
        fileWatcher: true,
        startTimeMs: dashboardStartedAt,
      };
      tui.setSystemInfo(systemInfo);
      tui.setSettings({
        maxConcurrent: settings.maxConcurrent ?? 1,
        maxWorktrees: settings.maxWorktrees ?? 2,
        autoMerge: settings.autoMerge ?? false,
        mergeStrategy: settings.mergeStrategy ?? "direct",
        pollIntervalMs: settings.pollIntervalMs ?? 60_000,
        enginePaused: settings.enginePaused ?? false,
        globalPause: settings.globalPause ?? false,
      });

      // Populate initial stats
      const tasks = await store.listTasks({ slim: true, includeArchived: false });
      const counts = new Map<string, number>();
      for (const task of tasks) {
        counts.set(task.column, (counts.get(task.column) ?? 0) + 1);
      }
      const active = tasks.filter((task) =>
        task.column === "in-progress" || task.column === "in-review"
      ).length;
      const agents = await agentStore.listAgents();
      const agentStats = { idle: 0, active: 0, running: 0, error: 0 };
      for (const agent of agents) {
        const state = agent.state as keyof typeof agentStats;
        if (state in agentStats) {
          agentStats[state]++;
        }
      }
      tui.setTaskStats({
        total: tasks.length,
        byColumn: Object.fromEntries(counts),
        active,
        agents: agentStats,
      });

      // Log startup messages to TUI
      tui.log(`Dashboard started at ${baseUrl}`);
      if (engineMode === "active") {
        tui.log("AI engine active");
      } else if (engineMode === "dev") {
        tui.log("AI engine disabled (dev mode)");
      } else {
        tui.log("AI engine paused");
      }
      tui.log("File watcher active");
    } else {
      // ── Non-TTY Mode: Print plain-text banner ───────────────────────────
      //
      // Preserve the original banner format for CI/automated workflows
      // and backward compatibility.
      //
      console.log();
      console.log(`  fn board`);
      console.log(`  ────────────────────────`);
      console.log(`  → ${baseUrl}`);
      if (dashboardAuthToken) {
        console.log(`  Auth:    bearer token required`);
        console.log(`  Token:   ${dashboardAuthToken}`);
        console.log(`  Open:    ${tokenizedUrl}`);
        console.log(`           (the browser stores the token so you only need to click once)`);
      } else {
        console.log(`  Auth:    disabled (--no-auth)`);
      }
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
    }
  });

  return { dispose };
}
