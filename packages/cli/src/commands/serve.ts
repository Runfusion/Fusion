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
import { join, resolve as pathResolve } from "node:path";
import {
  CentralCore,
  TaskStore,
  PluginLoader,
  PluginStore,
  getTaskMergeBlocker,
  INSIGHT_EXTRACTION_SCHEDULE_NAME,
  processAndAuditInsightExtraction,
  DaemonTokenManager,
  GlobalSettingsStore,
  resolveGlobalDir,
  getEnabledPiExtensionPaths,
  mergeBuiltInGrokProviderModels,
  mergeBuiltInZaiProviderModels,
  registerBuiltInGrokProvider,
  registerBuiltInZaiProvider,
} from "@fusion/core";
import type { AutomationRunResult, ScheduledTask } from "@fusion/core";
import { createServer, GitHubClient, createSkillsAdapter, getProjectSettingsPath, loadTlsCredentialsFromEnv, refreshAllCustomProviderModels, registerGithubTrackingHook } from "@fusion/dashboard";
import {
  ProjectEngineManager,
  PeerExchangeService,
  HybridExecutor,
  shouldUseHybridExecutor,
  setHostExtensionPaths,
  createFusionAuthStorage,
} from "@fusion/engine";
import {
  DefaultPackageManager,
  ModelRegistry,
  SettingsManager,
  discoverAndLoadExtensions,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  getMergeStrategy,
  processPullRequestMergeTask,
  createGroupPrCallback,
  syncGroupPrCallback,
  createPrNodeGithubOps,
  createPrReconcileGithubOps,
} from "./task-lifecycle.js";
import { promptForPort } from "./port-prompt.js";
import { createReadOnlyProviderSettingsView } from "./provider-settings.js";
import { wrapAuthStorageWithApiKeyProviders } from "./provider-auth.js";
import { getModelRegistryModelsPath, getPackageManagerAgentDir } from "./auth-paths.js";
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
import {
  getCachedDroidCliResolution,
  resolveDroidCliExtensionPaths,
  setCachedDroidCliResolution,
} from "./droid-cli-extension.js";
import {
  getCachedLlamaCppResolution,
  resolveLlamaCppExtensionPaths,
  setCachedLlamaCppResolution,
} from "./llama-cpp-extension.js";
import { resolveSelfExtension } from "./self-extension.js";
import { registerCustomProviders, reregisterCustomProviders } from "./custom-provider-registry.js";
import { handleOpencodeGoApiKeySaved, syncStartupModels } from "./startup-model-sync.js";
import { ensureBundledDependencyGraphPluginInstalled, ensureBundledGrokRuntimePluginInstalled, ensureBundledPluginInstalled, isBundledPluginId } from "../plugins/bundled-plugin-install.js";
import { ensureCwdProjectRegistered } from "./ensure-project-registered.js";

const DIAGNOSTIC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let diagnosticIntervalHandle: ReturnType<typeof setInterval> | null = null;
let serveStartTime = 0;
let serveDbHealthCheck: (() => boolean) | null = null;

async function resolveRuntimeProjectPath(): Promise<string> {
  try {
    return (await resolveProject(undefined)).projectPath;
  } catch {
    return process.cwd();
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
  opts: { interactive?: boolean; paused?: boolean; host?: string; daemon?: boolean; noAutoRegister?: boolean; project?: string } = {},
) {
  serveStartTime = Date.now();
  ensureProcessDiagnostics();

  // Port resolution priority: CLI --port arg > process.env.PORT > default (4040)
  // The env var fallback is critical for Docker containers where the mesh config
  // injects PORT as an environment variable to control the container's listen port.
  let selectedPort = port;
  if (!opts.interactive && (port === 4040 || port === 0) && process.env.PORT) {
    const envPort = Number(process.env.PORT);
    if (Number.isFinite(envPort) && envPort > 0) {
      selectedPort = envPort;
    }
  }
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

  const selectedHost = opts.host ?? "127.0.0.1";
  const cwd = await resolveRuntimeProjectPath();

  // ── CentralCore: global coordination + ntfy project ID lookup ─────────
  //
  // Created once and reused for:
  //   1. Looking up the registered project ID for NtfyNotifier (via ProjectEngine)
  //   2. Passed to ProjectEngine/InProcessRuntime for concurrency coordination
  //   3. Node registration for cluster awareness
  //
  let ntfyProjectId: string | undefined;
  let sharedCentralCore: CentralCore | null = null;
  /*
   * FNXC:SqliteFinalRemoval 2026-06-26-11:10:
   * The SQLite CentralDatabase path is removed (VAL-REMOVAL-005). CentralCore
   * needs its AsyncDataLayer attached to function against PostgreSQL. We use
   * the same startup factory the engine uses to resolve the backend, extract
   * the asyncLayer for CentralCore, then pass the full boot result (including
   * the TaskStore) as the externalTaskStore for the cwd project's engine so
   * the connection pool is shared — no second embedded PG instance is started.
   */
  let centralBootResult: { taskStore: import("@fusion/core").TaskStore; asyncLayer: import("@fusion/core").AsyncDataLayer; shutdown: () => Promise<void> } | null = null;
  try {
    const { createTaskStoreForBackend } = await import("@fusion/core");
    centralBootResult = await createTaskStoreForBackend({ rootDir: cwd });
    if (centralBootResult) {
      sharedCentralCore = new CentralCore(undefined, { asyncLayer: centralBootResult.asyncLayer });
    } else {
      sharedCentralCore = new CentralCore();
    }
    await sharedCentralCore.init();
  } catch {
    if (!sharedCentralCore) {
      sharedCentralCore = new CentralCore();
      try {
        await sharedCentralCore.init();
      } catch {
        // Non-fatal — engine uses fallback defaults
      }
    }
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

  if (sharedCentralCore) {
    const registered = await ensureCwdProjectRegistered({
      cwd,
      central: sharedCentralCore,
      logPrefix: "serve",
      autoRegister: !opts.noAutoRegister,
    });
    ntfyProjectId = registered?.id;
  }

  try {
    registerGithubTrackingHook?.();
  } catch {
    // Some tests partially mock @fusion/dashboard and omit this export.
  }

  const engineManager = new ProjectEngineManager(sharedCentralCore, {
    getMergeStrategy,
    processPullRequestMerge: (s, wd, taskId, pool) =>
      processPullRequestMergeTask(s, wd, taskId, githubClient, getTaskMergeBlocker, pool),
    createGroupPr: createGroupPrCallback(githubClient),
    syncGroupPr: syncGroupPrCallback(githubClient),
    prNodeGithubOps: createPrNodeGithubOps(githubClient),
    prReconcileGithubOps: createPrReconcileGithubOps(githubClient),
    getTaskMergeBlocker,
    onInsightRunProcessed: (s: unknown, r: unknown) => onMemoryInsightRunProcessed(s as ScheduledTask, r as AutomationRunResult),
    // FNXC:SqliteFinalRemoval 2026-06-26-11:15: share the central boot's TaskStore
    // as the externalTaskStore so the cwd engine reuses the same connection pool
    // (no second embedded PG). When centralBootResult is null (legacy mode), the
    // engine creates its own TaskStore via createTaskStoreForBackend as before.
    ...(centralBootResult ? { externalTaskStore: centralBootResult.taskStore } : {}),
  });

  // Start engines for all registered projects eagerly
  await engineManager.startAll();

  let hybridExecutor: HybridExecutor | null = null;
  const hybridGate = await shouldUseHybridExecutor(sharedCentralCore);
  console.log(`[serve] hybrid executor gate: enabled=${hybridGate.enabled} reason=${hybridGate.reason}`);
  if (hybridGate.enabled) {
    hybridExecutor = new HybridExecutor(sharedCentralCore);
    await hybridExecutor.initialize();
  }

  // Backfill Claude Code skills for any registered project that's missing
  // `.claude/skills/fusion`. Runs only when pi-claude-cli is configured; for
  // users on the direct Anthropic provider this is a no-op and leaves no
  // trace in the project tree. Non-blocking — we don't want a slow FS to
  // delay server listen.
  void (async () => {
    try {
      if (!sharedCentralCore) return;
      const projects = await sharedCentralCore.listProjects();
      ensureClaudeSkillsForAllProjectsOnStartup(
        projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
      );
    } catch (err) {
      console.warn(
        `[fusion] Claude skill reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();

  // Start background reconciliation to detect and start engines for projects
  // registered after startup (without requiring headless node API access).
  // This ensures project task execution starts from backend runtime alone.
  // The onProjectFirstAccessed callback in createServer remains as a fast-path
  // fallback for immediate engine startup on project access, but it is NOT
  // required for correctness — reconciliation handles all cases.
  engineManager.startReconciliation();

  // ── PeerExchangeService: gossip protocol for mesh peer discovery ──────
  //
  // Periodically exchanges peer information with connected remote nodes
  // to keep the mesh state up-to-date across all nodes.
  // Uses sharedCentralCore since it's the CentralCore instance available at this point.
  //
  let peerExchangeService: PeerExchangeService | null = null;
  if (sharedCentralCore) {
    peerExchangeService = new PeerExchangeService(sharedCentralCore);
    try {
      peerExchangeService.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[serve] Failed to start peer exchange service: ${message}`);
    }
  }

  const startedEngines = [...engineManager.getAllEngines().values()];
  const projects = sharedCentralCore ? await sharedCentralCore.listProjects() : [];

  const resolvePrimaryEngine = async (): Promise<{
    engine: (typeof startedEngines)[number];
    source: "cli-flag" | "default-setting" | "cwd" | "fallback";
  } | null> => {
    if (opts.project) {
      const byId = startedEngines.find((engine) => engine.getProjectId() === opts.project);
      if (byId) {
        return { engine: byId, source: "cli-flag" };
      }

      const projectMatch = projects.find((project) => project.name === opts.project);
      if (projectMatch) {
        const byName = engineManager.getEngine(projectMatch.id);
        if (byName) {
          return { engine: byName, source: "cli-flag" };
        }
      }

      console.error(`[serve] --project "${opts.project}" did not match any started engine`);
      process.exit(1);
      return null;
    }

    const defaultProjectId = await sharedCentralCore?.getDefaultProjectId?.();
    if (defaultProjectId) {
      const defaultEngine = engineManager.getEngine(defaultProjectId);
      if (defaultEngine) {
        return { engine: defaultEngine, source: "default-setting" };
      }
      console.warn(`[serve] defaultProjectId ${defaultProjectId} is set but no engine started for it — falling through`);
    }

    const cwdEngine = ntfyProjectId ? engineManager.getEngine(ntfyProjectId) : undefined;
    if (cwdEngine) {
      return { engine: cwdEngine, source: "cwd" };
    }

    const fallback = startedEngines[0];
    if (!fallback) {
      return null;
    }

    return { engine: fallback, source: "fallback" };
  };

  const primarySelection = await resolvePrimaryEngine();
  if (!primarySelection) {
    console.error("[serve] No engines started — registry empty or all engines failed to start. Exiting.");
    process.exit(1);
    return;
  }

  const primaryEngine = primarySelection.engine;
  const primaryProjectId = primaryEngine.getProjectId();
  ntfyProjectId = primaryProjectId;
  const primaryProject = projects.find((project) => project.id === primaryProjectId);
  const primaryProjectName = primaryProject?.name ?? primaryProjectId;
  const primaryCwd = primaryEngine.getWorkingDirectory();
  console.log(
    `[serve] HTTP layer bound to project ${primaryProjectName} (${primaryProjectId}) [source: ${primarySelection.source}]`,
  );

  const store = primaryEngine.getTaskStore();

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
  const pluginStore = store.getPluginStore();
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

  try {
    const installStatus = await ensureBundledDependencyGraphPluginInstalled(pluginStore, pluginLoader);
    if (installStatus === "installed") {
      console.log("[plugins] Installed bundled Dependency Graph plugin");
    } else if (installStatus === "missing-bundle") {
      console.warn("[plugins] Bundled Dependency Graph plugin was not found in this build");
    }
  } catch (err) {
    console.warn(`[plugins] Failed to auto-install bundled Dependency Graph plugin: ${err instanceof Error ? err.message : err}`);
  }

  /*
   * FNXC:GrokCliRouting 2026-07-09-23:05:
   * FN-7761: packaged `fn serve` must make the bundled Grok CLI runtime discoverable before any message-sending lane starts. Otherwise grok-cli/no-key selections fall through to the direct xAI endpoint and incorrectly ask for GROK_API_KEY even though the `grok` CLI owns auth.
   */
  try {
    const installStatus = await ensureBundledGrokRuntimePluginInstalled(pluginStore, pluginLoader);
    if (installStatus === "installed") {
      console.log("[plugins] Installed bundled Grok CLI runtime plugin");
    } else if (installStatus === "missing-bundle") {
      console.warn("[plugins] Bundled Grok CLI runtime plugin was not found in this build");
    }
  } catch (err) {
    console.warn(`[plugins] Failed to auto-install bundled Grok CLI runtime plugin: ${err instanceof Error ? err.message : err}`);
  }

  // Lazy-install hook for bundled runtime plugins (Hermes/OpenClaw/Paperclip/Grok).
  const ensureBundledPluginInstalledCallback = async (pluginId: string): Promise<boolean> => {
    if (!isBundledPluginId(pluginId)) {
      console.warn(`[plugins] ensureBundledPluginInstalled: unknown bundled plugin id "${pluginId}"`);
      return false;
    }
    try {
      const status = await ensureBundledPluginInstalled(pluginStore, pluginLoader, pluginId);
      if (status === "missing-bundle") {
        console.warn(`[plugins] Bundled plugin "${pluginId}" was not found in this build`);
        return false;
      }
      if (status === "installed") {
        console.log(`[plugins] Installed bundled plugin "${pluginId}"`);
      } else if (status === "updated") {
        console.log(`[plugins] Updated bundled plugin "${pluginId}"`);
      }
      return true;
    } catch (err) {
      console.warn(`[plugins] Failed to auto-install bundled plugin "${pluginId}": ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  };

  // Auto-load all enabled plugins so runtime UI (NewAgentDialog, AgentDetailView)
  // can discover installed runtimes like Hermes and OpenClaw.
  try {
    const { loaded, errors } = await pluginLoader.loadAllPlugins();
    console.log(`[plugins] Loaded ${loaded} plugins (${errors} errors)`);

    const schemaHooks = pluginLoader.getPluginSchemaInitHooks();
    if (schemaHooks.length > 0) {
      try {
        /*
         * FNXC:SqliteFinalRemoval 2026-06-25-16:25:
         * In backend mode (PostgreSQL), plugin schema inits are handled by the
         * Drizzle schema applier at startup, not the SQLite Database class.
         * Skip the SQLite-specific runPluginSchemaInits path in backend mode.
         */
        if (store.isBackendMode()) {
          console.log("[plugins] Schema initialization skipped — backend mode (PostgreSQL Drizzle migrations)");
        } else {
          await store.getDatabase().runPluginSchemaInits(schemaHooks);
        }
      } catch (err) {
        console.error(
          `[plugins] Schema initialization failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[plugins] Failed to load plugins: ${err instanceof Error ? err.message : err}`
    );
  }

  // Get subsystems from the primary engine for the HTTP layer
  const heartbeatMonitor = primaryEngine.getRuntime().getHeartbeatMonitor();
  const missionAutopilot = primaryEngine.getRuntime().getMissionAutopilot();
  const missionExecutionLoop = primaryEngine.getRuntime().getMissionExecutionLoop();
  const automationStore = primaryEngine.getAutomationStore();

  const authStorage = createFusionAuthStorage();
  const modelRegistry = ModelRegistry.create(authStorage, getModelRegistryModelsPath());
  registerBuiltInZaiProvider(modelRegistry, (message) => console.log(`[extensions] ${message}`));
  registerBuiltInGrokProvider(modelRegistry, (message) => console.log(`[extensions] ${message}`));
  const dashboardAuthStorage = wrapAuthStorageWithApiKeyProviders(authStorage, modelRegistry);

  // PackageManager may be used for skills adapter even if extension loading fails
  let packageManager: DefaultPackageManager | undefined;
  try {
    const agentDir = getPackageManagerAgentDir();
    packageManager = new DefaultPackageManager({
      cwd: primaryCwd,
      agentDir,
      settingsManager: createReadOnlyProviderSettingsView(primaryCwd, agentDir) as unknown as SettingsManager,
    });
    const resolvedPaths = await packageManager.resolve();
    const packageExtensionPaths = resolvedPaths.extensions
      .filter((r) => r.enabled)
      .map((r) => r.path);

    // Conditionally load the vendored pi-claude-cli extension so the user's
    // "Anthropic — via Claude CLI" provider routing takes effect without
    // requiring a manual `pi-claude-cli` install.
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

    const droidCliPaths = await (async () => {
      try {
        const globalSettings = await store.getGlobalSettingsStore().getSettings();
        const result = resolveDroidCliExtensionPaths(globalSettings);
        setCachedDroidCliResolution(result.resolution);
        if (result.warning) {
          console.warn(`[extensions] droid-cli: ${result.warning}`);
        }
        return result.paths;
      } catch (err) {
        console.warn(
          `[extensions] Unable to evaluate useDroidCli setting: ${err instanceof Error ? err.message : String(err)}`,
        );
        setCachedDroidCliResolution(null);
        return [];
      }
    })();

    const llamaCppPaths = await (async () => {
      try {
        const globalSettings = await store.getGlobalSettingsStore().getSettings();
        const result = resolveLlamaCppExtensionPaths(globalSettings);
        setCachedLlamaCppResolution(result.resolution);
        if (result.warning) {
          console.warn(`[extensions] llama-cpp: ${result.warning}`);
        }
        return result.paths;
      } catch (err) {
        console.warn(
          `[extensions] Unable to evaluate useLlamaCpp setting: ${err instanceof Error ? err.message : String(err)}`,
        );
        setCachedLlamaCppResolution(null);
        return [];
      }
    })();

    // Inject the cli's own extension so fn_* tools register globally without
    // requiring `pi install npm:@runfusion/fusion`.
    const selfExtension = resolveSelfExtension();
    const selfExtensionPaths = selfExtension.status === "ok" ? [selfExtension.path] : [];
    if (selfExtension.status !== "ok") {
      console.warn(`[extensions] self: ${selfExtension.reason}`);
    }
    setHostExtensionPaths(selfExtensionPaths);

    const extensionsResult = await discoverAndLoadExtensions(
      [
        ...selfExtensionPaths,
        ...getEnabledPiExtensionPaths(primaryCwd),
        ...packageExtensionPaths,
        ...claudeCliPaths,
        ...droidCliPaths,
        ...llamaCppPaths,
      ],
      primaryCwd,
      join(primaryCwd, ".fusion", "disabled-auto-extension-discovery"),
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
    mergeBuiltInZaiProviderModels(modelRegistry, (message) => console.log(`[extensions] ${message}`));
    mergeBuiltInGrokProviderModels(modelRegistry, (message) => console.log(`[extensions] ${message}`));
    modelRegistry.refresh();

    try {
      const globalSettings = await store.getGlobalSettingsStore().getSettings();
      registerCustomProviders(
        modelRegistry,
        globalSettings.customProviders,
        (message) => console.log(`[custom-providers] ${message}`),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[custom-providers] Failed to load custom providers from global settings: ${message}`);
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[extensions] Failed to discover extensions: ${message}`);
    createExtensionRuntime();
    modelRegistry.refresh();
  }

  void syncStartupModels({
    getSettings: () => store.getSettings(),
    authStorage: dashboardAuthStorage,
    modelRegistry,
    log: (scope, message) => console.log(`[${scope}] ${message}`),
  });

  store.on("settings:updated", ({ settings, previous }) => {
    const currentProviders = settings.customProviders;
    const previousProviders = previous.customProviders;
    if (JSON.stringify(currentProviders ?? []) === JSON.stringify(previousProviders ?? [])) {
      return;
    }

    reregisterCustomProviders(
      modelRegistry,
      previousProviders,
      currentProviders,
      (message) => console.log(`[custom-providers] ${message}`),
    );
  });

  // ── Daemon token resolution ─────────────────────────────────────────────
  //
  // When --daemon flag is set, resolve the daemon token using the same
  // priority as fn daemon: env var > stored token > generate new token.
  //
  let daemonToken: string | undefined;
  if (opts.daemon) {
    // 1. Check environment variable first
    daemonToken = process.env.FUSION_DAEMON_TOKEN;

    // 2. Check stored token in global settings
    if (!daemonToken) {
      const globalDir = resolveGlobalDir();
      const settingsStore = new GlobalSettingsStore(globalDir);
      const tokenManager = new DaemonTokenManager(settingsStore);
      daemonToken = await tokenManager.getToken();
    }

    // 3. Generate and store a new token if none exists
    if (!daemonToken) {
      const globalDir = resolveGlobalDir();
      const settingsStore = new GlobalSettingsStore(globalDir);
      const tokenManager = new DaemonTokenManager(settingsStore);
      daemonToken = await tokenManager.generateToken();
    }
  }

  // ── Skills adapter for skills discovery and execution toggling ─────────────
  //
  // Create the skills adapter using the same DefaultPackageManager instance
  // that was set up earlier for extension resolution.
  const pluginSkillCache = new Map<
    string,
    { enabledKey: string; skills: ReturnType<PluginLoader["getPluginSkills"]> }
  >();
  const getProjectScopedPluginSkills = async (rootDir: string): Promise<ReturnType<PluginLoader["getPluginSkills"]>> => {
    const normalizedRootDir = pathResolve(rootDir);
    const stateStore = new PluginStore(normalizedRootDir, { centralGlobalDir: resolveGlobalDir() });
    await stateStore.init();
    try {
      const enabledPlugins = await stateStore.listPlugins({ enabled: true });
      const enabledKey = enabledPlugins
        .map((plugin) => `${plugin.id}:${plugin.updatedAt}`)
        .sort()
        .join("\0");
      const cached = pluginSkillCache.get(normalizedRootDir);
      if (cached?.enabledKey === enabledKey) return cached.skills;
      if (enabledPlugins.length === 0) {
        const skills: ReturnType<PluginLoader["getPluginSkills"]> = [];
        pluginSkillCache.set(normalizedRootDir, { enabledKey, skills });
        return skills;
      }

      /*
       * FNXC:PluginSkills 2026-07-10-00:00:
       * Same-root skill discovery must reuse the daemon's active PluginLoader; request-scoped loaders are only for other project roots and are stopped after metadata collection to avoid leaking plugin side effects or SQLite handles.
       */
      if (normalizedRootDir === pathResolve(store.getRootDir())) {
        const enabledIds = new Set(enabledPlugins.map((plugin) => plugin.id));
        const skills = pluginLoader.getPluginSkills().filter((entry) => enabledIds.has(entry.pluginId));
        pluginSkillCache.set(normalizedRootDir, { enabledKey, skills });
        return skills;
      }

      const scopedPluginStore = new PluginStore(normalizedRootDir, { centralGlobalDir: resolveGlobalDir() });
      const scopedTaskStore = new TaskStore(normalizedRootDir);
      const scopedPluginLoader = new PluginLoader({ pluginStore: scopedPluginStore, taskStore: scopedTaskStore });
      try {
        await scopedPluginStore.init();
        await scopedTaskStore.init();
        const { errors } = await scopedPluginLoader.loadAllPlugins();
        if (errors > 0) {
          console.warn(`[plugins] Project-scoped plugin skill loading for ${normalizedRootDir} had ${errors} error(s)`);
        }
        const skills = scopedPluginLoader.getPluginSkills();
        pluginSkillCache.set(normalizedRootDir, { enabledKey, skills });
        return skills;
      } finally {
        await scopedPluginLoader.stopAllPlugins();
        scopedPluginStore.close();
        scopedTaskStore.close();
      }
    } finally {
      stateStore.close();
    }
  };

  const skillsAdapter = packageManager
    ? createSkillsAdapter({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dashboard's resolve() uses a looser onMissing signature than pi's DefaultPackageManager
        packageManager: packageManager as any,
        getSettingsPath: (rootDir: string) => getProjectSettingsPath(rootDir),
        /*
         * FNXC:PluginSkills 2026-07-10-00:00:
         * `fn serve` may serve a project other than the daemon startup root. Resolve plugin skills through a requesting-root PluginStore so plugin:<id> catalog entries follow that project's enablement and cannot leak from the daemon root.
         */
        getPluginSkills: getProjectScopedPluginSkills,
      })
    : undefined;

  const app = createServer(store, {
    engine: primaryEngine,
    engineManager,
    centralCore: sharedCentralCore ?? undefined,
    onMerge: (taskId) => primaryEngine.onMerge(taskId),
    authStorage: dashboardAuthStorage,
    modelRegistry,
    automationStore,
    missionAutopilot,
    missionExecutionLoop,
    heartbeatMonitor: heartbeatMonitor
      ? {
          rootDir: primaryCwd,
          startRun: heartbeatMonitor.startRun.bind(heartbeatMonitor),
          executeHeartbeat: heartbeatMonitor.executeHeartbeat.bind(heartbeatMonitor),
          stopRun: heartbeatMonitor.stopRun.bind(heartbeatMonitor),
        }
      : undefined,
    pluginStore,
    pluginLoader,
    pluginRunner: pluginLoader,
    ensureBundledPluginInstalled: ensureBundledPluginInstalledCallback,
    onProjectFirstAccessed: (projectId: string) => engineManager.onProjectAccessed(projectId),
    onProjectRegistered: ({ path }) => {
      // Fire-and-forget: install the fusion Claude-skill when pi-claude-cli
      // is configured. The runner logs its own outcome and swallows errors.
      maybeInstallClaudeSkillForNewProject(path);
    },
    onApiKeySaved: async (providerId: string) => {
      if (providerId !== "opencode" && providerId !== "opencode-go") {
        return undefined;
      }
      return await handleOpencodeGoApiKeySaved(
        dashboardAuthStorage,
        store,
        modelRegistry,
        (scope, message) => console.log(`[${scope}] ${message}`),
      );
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
    getDroidCliExtensionStatus: () => {
      const r = getCachedDroidCliResolution();
      if (!r) return null;
      if (r.status === "ok") {
        return { status: "ok", path: r.path, packageVersion: r.packageVersion };
      }
      if (r.status === "not-installed") {
        return { status: "not-installed" };
      }
      return { status: r.status, reason: r.reason };
    },
    getLlamaCppExtensionStatus: () => {
      const r = getCachedLlamaCppResolution();
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
      if (!next) return; // Toggle-off leaves existing skill symlinks alone.
      void (async () => {
        try {
          if (!sharedCentralCore) return;
          const projects = await sharedCentralCore.listProjects();
          ensureClaudeSkillsForAllProjectsOnStartup(
            projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
          );
        } catch (err) {
          console.warn(
            `[fusion] Claude skill backfill on toggle failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },
    onUseDroidCliToggled: (_prev, next) => {
      if (next) {
        console.log("[extensions] Droid CLI enabled — restart required for full effect");
      }
    },
    headless: true,
    skillsAdapter,
    daemon: daemonToken ? { token: daemonToken } : undefined,
    https: loadTlsCredentialsFromEnv(),
  });

  const server = app.listen(selectedPort, selectedHost);

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const actualPort = (server.address() as AddressInfo).port;

  /*
  FNXC:CustomProviders 2026-06-30-00:00:
  Headless serve must become reachable before custom-provider /models probes run. Refresh in the background after listen, then rely on the settings:updated listener to re-register refreshed model lists without delaying startup on slow or unreachable endpoints.
  */
  void refreshAllCustomProviderModels(store, (message) => console.log(`[custom-providers] ${message}`)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[custom-providers] Failed to refresh custom provider models from global settings: ${message}`);
  });

  // ── mDNS discovery: broadcast presence and listen for other nodes ───────
  //
  // Advertises this node on the local network and discovers other Fusion nodes
  // without requiring manual configuration.
  // Uses sharedCentralCore since it's the CentralCore instance available at this point.
  //
  if (sharedCentralCore) {
    try {
      await sharedCentralCore.startDiscovery({
        broadcast: true,
        listen: true,
        serviceType: "_fusion._tcp",
        port: actualPort,
        staleTimeoutMs: 300_000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[serve] Failed to start mDNS discovery: ${message}`);
    }
  }

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

  // Import maskApiKey helper for token display
  const { maskApiKey } = await import("./node.js");

  console.log();
  if (daemonToken) {
    console.log(`  Fusion Node (daemon mode)`);
    console.log(`  ────────────────────────`);
    console.log(`  → http://${selectedHost}:${actualPort}`);
    console.log();
    console.log(`  Token: fn_${maskApiKey(daemonToken)}`);
    console.log();
    console.log(`  Connect from another machine:`);
    console.log(`    fn node connect <name> --url http://<host>:<port> --api-key ${daemonToken}`);
    console.log();
    console.log(`  Health:     GET /api/health`);
    console.log(`  API:        /api/* (bearer token required)`);
    console.log(`  AI engine:  ✓ active`);
    console.log(`  Press Ctrl+C to stop`);
  } else {
    console.log(`  Fusion Node`);
    console.log(`  ────────────────────────`);
    console.log(`  → http://${selectedHost}:${actualPort}`);
    console.log();
    console.log(`  Health:     GET /api/health`);
    console.log(`  API:        /api/*`);
    console.log(`  AI engine:  ✓ active`);
    console.log(`  Press Ctrl+C to stop`);
  }
  console.log();

  let shuttingDown = false;

  /*
  FNXC:DaemonSignalExit 2026-07-10-14:00:
  Same invariant as `fn daemon`: a memory-pressure SIGTERM must exit non-zero so a
  `Restart=on-failure` supervisor restarts the server rather than treating the kill
  as a clean stop. Exit 128+signal (SIGINT=130, SIGTERM=143); a non-signal caller
  still exits 0. A deliberate `systemctl stop` won't restart regardless (systemd
  honors the requested inactive state).
  */
  const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

  const shutdown = async (signal?: NodeJS.Signals) => {
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

    if (hybridExecutor) {
      await hybridExecutor.shutdown();
    }

    // Stop all project engines uniformly
    await engineManager.stopAll();

    // Stop peer exchange service
    if (peerExchangeService) {
      try {
        await peerExchangeService.stop();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[serve] Failed to stop peer exchange service: ${message}`);
      }
    }

    if (centralCore && localNodeId) {
      try {
        await centralCore.updateNode(localNodeId, { status: "offline" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[serve] Failed to set local node offline: ${message}`);
      }
    }

    if (centralCore) {
      // Stop mDNS discovery
      try {
        centralCore.stopDiscovery();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[serve] Failed to stop mDNS discovery: ${message}`);
      }

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
    process.exit(signal ? (SIGNAL_EXIT_CODES[signal] ?? 128) : 0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  // Ignore SIGHUP so the server survives SSH session disconnects.
  // Without this, SIGHUP (sent when the controlling terminal closes) kills
  // the process silently — the exit handler tries to log to the now-dead
  // PTY and the write is lost.
  process.on("SIGHUP", () => {
    console.log("[serve] Received SIGHUP (terminal disconnected) — ignoring");
  });
}
