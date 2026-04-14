/**
 * Headless Fusion Node server command.
 *
 * ⚠️ ARCHITECTURAL BOUNDARY: This module must NOT import from ./dashboard.js.
 *
 * The headless command (runServe) runs independently of the dashboard UI.
 * Shared task lifecycle helpers are imported from ./task-lifecycle.js, and
 * interactive port prompts from ./port-prompt.js. This ensures clean separation
 * between the runtime (headless) and UI (dashboard) command paths.
 */

import type { AddressInfo } from "node:net";
import {
  CentralCore,
  PluginStore,
  PluginLoader,
  getTaskMergeBlocker,
  INSIGHT_EXTRACTION_SCHEDULE_NAME,
  processAndAuditInsightExtraction,
} from "@fusion/core";
import type { AutomationRunResult, ScheduledTask } from "@fusion/core";
import { createServer, GitHubClient, createSkillsAdapter, getProjectSettingsPath } from "@fusion/dashboard";
import { ProjectEngineManager } from "@fusion/engine";
import {
  AuthStorage,
  DefaultPackageManager,
  ModelRegistry,
  discoverAndLoadExtensions,
  getAgentDir,
  createExtensionRuntime,
} from "@mariozechner/pi-coding-agent";
import {
  getMergeStrategy,
  processPullRequestMergeTask,
} from "./task-lifecycle.js";
import { promptForPort } from "./port-prompt.js";
import { createReadOnlyProviderSettingsView, createProjectSettingsPersistence } from "./provider-settings.js";
import { wrapAuthStorageWithApiKeyProviders } from "./provider-auth.js";

const DIAGNOSTIC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let diagnosticIntervalHandle: ReturnType<typeof setInterval> | null = null;
let serveStartTime = 0;
let serveDbHealthCheck: (() => boolean) | null = null;

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
 * @param dbHealthCheck - Optional function to check database health
 */
function logDiagnostics(prefix: string, dbHealthCheck?: () => boolean): void {
  const mem = process.memoryUsage();
  const uptime = Date.now() - serveStartTime;

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
  if (serveDbHealthCheck) {
    try {
      // This would be for store listener counts - not applicable in serve without store
      listenerInfo = "";
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
function setServeDbHealthCheck(check: () => boolean): void {
  serveDbHealthCheck = check;
}

/**
 * Register process lifecycle diagnostics for long-running process monitoring.
 * Logs memory usage, handle counts, and uptime at startup and every 30 minutes.
 * Also logs beforeExit and exit events for shutdown analysis.
 */
function ensureProcessDiagnostics(): void {
  // Log initial diagnostics at startup (before store is created)
  logDiagnostics("serve");

  // Register periodic diagnostics every 30 minutes
  diagnosticIntervalHandle = setInterval(() => {
    logDiagnostics("serve", serveDbHealthCheck ?? undefined);
  }, DIAGNOSTIC_INTERVAL_MS);
  diagnosticIntervalHandle.unref?.(); // Don't prevent process exit

  // Log beforeExit when event loop drains naturally
  process.on("beforeExit", (code: number) => {
    const uptime = Date.now() - serveStartTime;
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
    console.log(`[serve] beforeExit code=${code} uptime=${formatUptime(uptime)} handles=${handleCount} requests=${requestCount}`);
  });

  // Log exit event with exit code and uptime
  process.on("exit", (code: number) => {
    const uptime = Date.now() - serveStartTime;
    console.log(`[serve] exit code=${code} uptime=${formatUptime(uptime)}`);
  });

  // Log uncaught exceptions
  process.on("uncaughtExceptionMonitor", (error: Error) => {
    console.error(`[serve] uncaught exception pid=${process.pid}: ${error.stack || error.message}`);
  });

  // Log unhandled rejections
  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[serve] unhandled rejection pid=${process.pid}: ${message}`);
  });
}

export async function runServe(
  port: number,
  opts: { interactive?: boolean; paused?: boolean; host?: string } = {},
) {
  serveStartTime = Date.now();
  ensureProcessDiagnostics();

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

  const selectedHost = opts.host ?? "0.0.0.0";
  const cwd = process.cwd();

  // ── CentralCore: global coordination + ntfy project ID lookup ─────────
  //
  // Created once and reused for:
  //   1. Looking up the registered project ID for NtfyNotifier (via ProjectEngine)
  //   2. Passed to ProjectEngine/InProcessRuntime for concurrency coordination
  //   3. Node registration for cluster awareness
  //
  let ntfyProjectId: string | undefined;
  let sharedCentralCore: CentralCore | null = null;
  try {
    sharedCentralCore = new CentralCore();
    await sharedCentralCore.init();
    const registered = await sharedCentralCore.getProjectByPath(cwd);
    if (registered) {
      ntfyProjectId = registered.id;
    }
  } catch {
    // Central DB unavailable or project not registered — backward compatible
  }

  // ── ProjectEngineManager: uniform engine lifecycle for all projects ──
  //
  // Every registered project gets an identical ProjectEngine with the
  // full subsystem set (Scheduler, Triage, Executor, auto-merge, PR
  // monitor, notifier, cron, settings listeners). No project is special.
  //
  const githubClient = new GitHubClient(process.env.GITHUB_TOKEN);

  // Post-run callback for memory insight extraction processing
  const onMemoryInsightRunProcessed = async (
    schedule: ScheduledTask,
    result: AutomationRunResult,
  ): Promise<void> => {
    // Only process the memory insight extraction schedule
    if (schedule.name !== INSIGHT_EXTRACTION_SCHEDULE_NAME) {
      return;
    }

    // Extract the AI step output from the result
    const stepResults = result.stepResults ?? [];
    // Step name updated in FN-1477 to include pruning
    const aiStep = stepResults.find(
      (sr) => sr.stepName === "Extract Memory Insights and Prune" || sr.stepName === "Extract Memory Insights",
    );

    if (!aiStep) {
      console.log(`[memory-audit] No insight extraction step found in ${schedule.name} result`);
      return;
    }

    console.log(`[memory-audit] Processing memory insight extraction run...`);

    try {
      const auditReport = await processAndAuditInsightExtraction(cwd, {
        rawResponse: aiStep.output ?? "",
        stepSuccess: aiStep.success,
        runAt: result.startedAt,
        error: aiStep.error,
      });

      const pruneStatus = auditReport.pruning.applied
        ? ` | Pruned: ${auditReport.pruning.originalSize} → ${auditReport.pruning.newSize} chars`
        : ` | Pruning: ${auditReport.pruning.reason}`;

      console.log(
        `[memory-audit] ✓ Audit complete — Health: ${auditReport.health}, ` +
        `Insights: ${auditReport.insightsMemory.insightCount}${pruneStatus}`,
      );
    } catch (err) {
      console.error(
        `[memory-audit] ✗ Failed to process insight extraction: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  if (!sharedCentralCore) {
    sharedCentralCore = new CentralCore();
    try {
      await sharedCentralCore.init();
    } catch {
      // Non-fatal — engine uses fallback defaults
    }
  }

  const engineManager = new ProjectEngineManager(sharedCentralCore, {
    getMergeStrategy,
    processPullRequestMerge: (s, wd, taskId) =>
      processPullRequestMergeTask(s, wd, taskId, githubClient, getTaskMergeBlocker),
    getTaskMergeBlocker,
    onInsightRunProcessed: onMemoryInsightRunProcessed as any,
  });

  // Start engines for all registered projects eagerly
  await engineManager.startAll();

  // Start background reconciliation to detect and start engines for projects
  // registered after startup (without requiring headless node API access).
  // This ensures project task execution starts from backend runtime alone.
  // The onProjectFirstAccessed callback in createServer remains as a fast-path
  // fallback for immediate engine startup on project access, but it is NOT
  // required for correctness — reconciliation handles all cases.
  engineManager.startReconciliation();

  // Get the cwd project's engine and store for the HTTP layer.
  // serve.ts needs a store for plugin setup, diagnostics, and the server.
  const cwdEngine = ntfyProjectId ? engineManager.getEngine(ntfyProjectId) : undefined;
  if (!cwdEngine) {
    console.error("[serve] No engine started for the current project — exiting");
    process.exit(1);
  }
  const store = cwdEngine.getTaskStore();

  // InProcessRuntime does not call store.watch() — do it here so SSE events
  // and file-watcher triggers are active for the HTTP layer.
  await store.watch();

  // Set up database health check for diagnostics
  setServeDbHealthCheck(() => store.healthCheck());

  if (opts.paused) {
    await store.updateSettings({ enginePaused: true });
    console.log("[engine] Starting in paused mode — automation disabled");
  }

  // ── PluginStore: plugin installation management ─────────────────────
  //
  // SQLite-backed plugin persistence for the Settings → Plugins experience.
  // Enables the PluginManager UI to list, install, enable, disable, and
  // configure plugins via the /api/plugins REST endpoints.
  //
  // Note: InProcessRuntime creates its own PluginStore/PluginLoader/PluginRunner
  // internally for task-execution plugin hooks. These instances here serve the
  // HTTP plugin-management API routes and are intentionally separate.
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

  // Get subsystems from the cwd engine for the HTTP layer
  const heartbeatMonitor = cwdEngine.getRuntime().getHeartbeatMonitor();
  const missionAutopilot = cwdEngine.getRuntime().getMissionAutopilot();
  const missionExecutionLoop = cwdEngine.getRuntime().getMissionExecutionLoop();
  const automationStore = cwdEngine.getAutomationStore();

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  // PackageManager may be used for skills adapter even if extension loading fails
  let packageManager: DefaultPackageManager | undefined;
  try {
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

    const extensionsResult = await discoverAndLoadExtensions(
      packageExtensionPaths,
      cwd,
      undefined,
    );

    for (const { path, error } of extensionsResult.errors) {
      console.log(`[extensions] Failed to load ${path}: ${error}`);
    }

    for (const {
      name,
      config,
      extensionPath,
    } of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        modelRegistry.registerProvider(name, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(
          `[extensions] Failed to register provider from ${extensionPath}: ${message}`,
        );
      }
    }

    extensionsResult.runtime.pendingProviderRegistrations = [];
    modelRegistry.refresh();

    (async () => {
      try {
        const settings = await store.getSettings();
        if (settings.openrouterModelSync === false) return;
        const hasOrAuth = await authStorage.getApiKey("openrouter");
        const headers: Record<string, string> = {};
        if (hasOrAuth) headers["Authorization"] = `Bearer ${hasOrAuth}`;
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers,
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          data?: Array<{
            id: string;
            name: string;
            context_length?: number;
            top_provider?: { max_completion_tokens?: number };
            pricing?: Record<string, string>;
            architecture?: {
              modality?: string;
              input_modalities?: string[];
            };
          }>;
        };
        const orModels = (json.data || []).map((m: any) => {
          const id = (m.id || "").toLowerCase();
          const name = (m.name || "").toLowerCase();
          const reasoning =
            id.includes(":thinking") ||
            id.includes("-r1") ||
            id.includes("/r1") ||
            id.includes("o1-") ||
            id.includes("o3-") ||
            id.includes("o4-") ||
            id.includes("reasoner") ||
            name.includes("thinking") ||
            name.includes("reasoner");
          const hasVision =
            m.architecture?.input_modalities?.includes("image") ??
            m.architecture?.modality?.includes("multimodal") ??
            false;
          function parseCost(v?: string) {
            const n = parseFloat(v || "0");
            return isNaN(n) ? 0 : n * 1_000_000;
          }
          return {
            id: m.id,
            name: m.name || m.id,
            reasoning,
            input: (hasVision ? ["text", "image"] : ["text"]) as (
              | "text"
              | "image"
            )[],
            cost: {
              input: parseCost(m.pricing?.prompt),
              output: parseCost(m.pricing?.completion),
              cacheRead: parseCost(m.pricing?.input_cache_read),
              cacheWrite: parseCost(m.pricing?.input_cache_write),
            },
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
        console.log(
          `[openrouter] Synced ${orModels.length} models from OpenRouter API`,
        );
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

  const app = createServer(store, {
    engine: cwdEngine,
    engineManager,
    onMerge: (taskId) => cwdEngine.onMerge(taskId),
    authStorage: dashboardAuthStorage,
    modelRegistry,
    automationStore,
    missionAutopilot,
    missionExecutionLoop,
    heartbeatMonitor: heartbeatMonitor
      ? {
          rootDir: cwd,
          startRun: heartbeatMonitor.startRun.bind(heartbeatMonitor),
          executeHeartbeat: heartbeatMonitor.executeHeartbeat.bind(heartbeatMonitor),
          stopRun: heartbeatMonitor.stopRun.bind(heartbeatMonitor),
        }
      : undefined,
    pluginStore,
    pluginLoader,
    pluginRunner: pluginLoader,
    onProjectFirstAccessed: (projectId: string) => engineManager.onProjectAccessed(projectId),
    headless: true,
    skillsAdapter,
  });

  const server = app.listen(selectedPort, selectedHost);

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const actualPort = (server.address() as AddressInfo).port;

  // ── CentralCore: node registration ────────────────────────────────────
  //
  // Reuse the shared CentralCore instance created earlier (for ntfyProjectId).
  // If it wasn't initialized successfully, create a new one for node registration.
  //
  let centralCore: CentralCore | null = sharedCentralCore;
  // sharedCentralCore was already init'd; if null, try again for node registration
  if (!centralCore) {
    try {
      centralCore = new CentralCore();
      await centralCore.init();
    } catch {
      centralCore = null;
    }
  }
  let localNodeId: string | undefined;

  try {
    if (centralCore) {
      const nodes = await centralCore.listNodes();
      const localNode = nodes.find((node) => node.type === "local");
      if (localNode) {
        localNodeId = localNode.id;
        await centralCore.updateNode(localNode.id, { status: "online" });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[serve] Failed to set local node online: ${message}`);
  }

  console.log();
  console.log(`  Fusion Node`);
  console.log(`  ────────────────────────`);
  console.log(`  → http://${selectedHost}:${actualPort}`);
  console.log();
  console.log(`  Health:     GET /api/health`);
  console.log(`  API:        /api/*`);
  console.log(`  AI engine:  ✓ active`);
  console.log(`  Press Ctrl+C to stop`);
  console.log();

  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

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
      console.log(`[serve] active handles at shutdown: ${handleSummary}`);
    } catch {
      // Ignore errors getting handle types
    }

    // Stop all project engines uniformly
    await engineManager.stopAll();

    if (centralCore && localNodeId) {
      try {
        await centralCore.updateNode(localNodeId, { status: "offline" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[serve] Failed to set local node offline: ${message}`);
      }
    }

    if (centralCore) {
      await centralCore.close().catch(() => {
        // best-effort
      });
      centralCore = null;
    }

    try {
      server.close();
    } catch {
      // best-effort
    }

    stopDiagnosticInterval();
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  // Ignore SIGHUP so the server survives SSH session disconnects.
  // Without this, SIGHUP (sent when the controlling terminal closes) kills
  // the process silently — the exit handler tries to log to the now-dead
  // PTY and the write is lost.
  process.on("SIGHUP", () => {
    console.log("[serve] Received SIGHUP (terminal disconnected) — ignoring");
  });
}
