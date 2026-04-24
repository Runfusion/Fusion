/**
 * Fusion Daemon command - API server with bearer token authentication.
 *
 * ⚠️ ARCHITECTURAL BOUNDARY: This module must NOT import from ./dashboard.js.
 *
 * The daemon command runs independently of the dashboard UI with secure
 * bearer token authentication. Shared task lifecycle helpers are imported
 * from ./task-lifecycle.js, and interactive port prompts from ./port-prompt.js.
 */

import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  CentralCore,
  PluginStore,
  PluginLoader,
  getTaskMergeBlocker,
  INSIGHT_EXTRACTION_SCHEDULE_NAME,
  processAndAuditInsightExtraction,
  DaemonTokenManager,
  GlobalSettingsStore,
  resolveGlobalDir,
  getEnabledPiExtensionPaths,
} from "@fusion/core";
import type { AutomationRunResult, ScheduledTask } from "@fusion/core";
import { createServer, GitHubClient, createSkillsAdapter, getProjectSettingsPath, loadTlsCredentialsFromEnv } from "@fusion/dashboard";
import { ProjectEngineManager, PeerExchangeService } from "@fusion/engine";
import {
  AuthStorage,
  DefaultPackageManager,
  ModelRegistry,
  discoverAndLoadExtensions,
  createExtensionRuntime,
} from "@mariozechner/pi-coding-agent";
import {
  getMergeStrategy,
  processPullRequestMergeTask,
} from "./task-lifecycle.js";
import { promptForPort } from "./port-prompt.js";
import { createReadOnlyProviderSettingsView } from "./provider-settings.js";
import {
  ensureClaudeSkillsForAllProjectsOnStartup,
  maybeInstallClaudeSkillForNewProject,
} from "./claude-skills-runner.js";
import {
  getCachedClaudeCliResolution,
  resolveClaudeCliExtensionPaths,
  setCachedClaudeCliResolution,
} from "./claude-cli-extension.js";
import { createReadOnlyAuthFileStorage, mergeAuthStorageReads, wrapAuthStorageWithApiKeyProviders } from "./provider-auth.js";
import { getFusionAuthPath, getLegacyAuthPaths, getModelRegistryModelsPath, getPackageManagerAgentDir } from "./auth-paths.js";
import { resolveProject } from "../project-context.js";

const DIAGNOSTIC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let daemonStartTime = 0;
let daemonDbHealthCheck: (() => boolean) | null = null;

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
 * @param dbHealthCheck - Optional function to check database health
 */
function logDiagnostics(dbHealthCheck?: () => boolean): void {
  const mem = process.memoryUsage();
  const uptime = Date.now() - daemonStartTime;

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

  let dbHealth = "unknown";
  if (dbHealthCheck) {
    try {
      dbHealth = dbHealthCheck() ? "ok" : "failed";
    } catch {
      dbHealth = "error";
    }
  }

  const logLine = `[daemon] diagnostics: uptime=${formatUptime(uptime)} ` +
    `rss=${formatBytes(mem.rss)} heap=${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapTotal)} ` +
    `external=${formatBytes(mem.external)} arrayBuffers=${formatBytes(mem.arrayBuffers)} ` +
    `handles=${handleCount} requests=${requestCount} db=${dbHealth}`;

  console.log(logLine);
}

/**
 * Mask a token for display, showing only first 3 and last 4 characters.
 */
function maskToken(token: string): string {
  if (token.length <= 10) {
    return "***";
  }
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function isValidDaemonToken(token: string): boolean {
  // Accept generated tokens (fn_<32 hex>) and user-provided prefixed variants.
  return /^fn_[A-Za-z0-9_-]{8,}$/.test(token);
}

export interface DaemonOptions {
  /** Port to listen on (default: 0 for random port) */
  port?: number;
  /** Host to bind to (default: 127.0.0.1 — localhost only). Pass "0.0.0.0" to
   *  expose on all interfaces. */
  host?: string;
  /** Specific token to use (generated if not provided) */
  token?: string;
  /** Start with engine paused */
  paused?: boolean;
  /** Interactive port selection */
  interactive?: boolean;
  /** Just print/generate token without starting server */
  tokenOnly?: boolean;
}

export async function runDaemon(opts: DaemonOptions = {}) {
  daemonStartTime = Date.now();

  // ── Token management ──────────────────────────────────────────────
  //
  // Token-only mode: just generate/print token and exit
  //
  if (opts.tokenOnly) {
    const globalDir = resolveGlobalDir();
    const settingsStore = new GlobalSettingsStore(globalDir);
    const tokenManager = new DaemonTokenManager(settingsStore);

    try {
      // Try to get existing token, or generate a new one
      let token = await tokenManager.getToken();
      if (!token) {
        token = await tokenManager.generateToken();
      }
      console.log(token);
    } catch (err) {
      console.error(`Error managing daemon token: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    process.exit(0);
    return;
  }

  // For server mode, we need to start the engine
  // Get or generate token
  let daemonToken: string;
  if (opts.token) {
    daemonToken = opts.token;
  } else {
    const globalDir = resolveGlobalDir();
    const settingsStore = new GlobalSettingsStore(globalDir);
    const tokenManager = new DaemonTokenManager(settingsStore);

    // Check for token in environment (fallback). Ignore legacy/invalid values
    // so daemon auth always uses the expected fn_* token format.
    const envToken = process.env.FUSION_DAEMON_TOKEN;
    if (envToken && isValidDaemonToken(envToken)) {
      daemonToken = envToken;
    } else {
      // Get or create token
      try {
        const existing = await tokenManager.getToken();
        daemonToken = existing ?? await tokenManager.generateToken();
      } catch (err) {
        console.error(`Error managing daemon token: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
        return;
      }
    }
  }

  let selectedPort = opts.port ?? 0;
  if (opts.interactive) {
    try {
      selectedPort = await promptForPort(selectedPort);
    } catch (err: any) {
      if (err.message === "Interactive prompt cancelled") {
        console.log("Cancelled — exiting");
        process.exit(0);
      }
      throw err;
    }
  }

  const selectedHost = opts.host ?? "127.0.0.1";
  const cwd = await resolveRuntimeProjectPath();

  // ── CentralCore: global coordination + ntfy project ID lookup ─────────
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
  const githubClient = new GitHubClient(process.env.GITHUB_TOKEN);

  // Post-run callback for memory insight extraction processing
  const onMemoryInsightRunProcessed = async (
    schedule: ScheduledTask,
    result: AutomationRunResult,
  ): Promise<void> => {
    if (schedule.name !== INSIGHT_EXTRACTION_SCHEDULE_NAME) {
      return;
    }

    const stepResults = result.stepResults ?? [];
    const aiStep = stepResults.find(
      (sr) => sr.stepName === "Extract Memory Insights and Prune" || sr.stepName === "Extract Memory Insights",
    );

    if (!aiStep) {
      return;
    }

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

  await engineManager.startAll();
  engineManager.startReconciliation();

  // Backfill Claude Code skills for all registered projects. No-op when
  // pi-claude-cli isn't configured; non-blocking to protect startup latency.
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

  // ── PeerExchangeService: gossip protocol for mesh peer discovery ──────
  let peerExchangeService: PeerExchangeService | null = null;
  if (sharedCentralCore) {
    peerExchangeService = new PeerExchangeService(sharedCentralCore);
    try {
      peerExchangeService.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[daemon] Failed to start peer exchange service: ${message}`);
    }
  }

  // Get the cwd project's engine and store for the HTTP layer
  const cwdEngine = ntfyProjectId ? engineManager.getEngine(ntfyProjectId) : undefined;
  if (!cwdEngine) {
    console.error("[daemon] No engine started for the current project — exiting");
    process.exit(1);
    return;
  }
  const store = cwdEngine.getTaskStore();

  await store.watch();

  // Set up database health check for diagnostics
  daemonDbHealthCheck = () => store.healthCheck();

  if (opts.paused) {
    await store.updateSettings({ enginePaused: true });
    console.log("[engine] Starting in paused mode — automation disabled");
  }

  // ── PluginStore: plugin installation management ─────────────────────
  // Some mocked stores used in tests may not implement getRootDir(); fall
  // back to the resolved runtime cwd in that case.
  const storeRootDir = typeof (store as { getRootDir?: () => string }).getRootDir === "function"
    ? (store as { getRootDir: () => string }).getRootDir()
    : cwd;
  const pluginStore = new PluginStore(storeRootDir);
  await pluginStore.init();

  // ── PluginLoader: plugin lifecycle management ───────────────────────
  const pluginLoader = new PluginLoader({
    pluginStore,
    taskStore: store,
  });

  // Get subsystems from the cwd engine for the HTTP layer
  const heartbeatMonitor = cwdEngine.getRuntime().getHeartbeatMonitor();
  const missionAutopilot = cwdEngine.getRuntime().getMissionAutopilot();
  const missionExecutionLoop = cwdEngine.getRuntime().getMissionExecutionLoop();
  const automationStore = cwdEngine.getAutomationStore();

  const authStorage = AuthStorage.create(getFusionAuthPath());
  const legacyAuthStorage = createReadOnlyAuthFileStorage(getLegacyAuthPaths());
  const mergedAuthStorage = mergeAuthStorageReads(authStorage, [legacyAuthStorage]);
  const modelRegistry = ModelRegistry.create(mergedAuthStorage, getModelRegistryModelsPath());
  const dashboardAuthStorage = wrapAuthStorageWithApiKeyProviders(mergedAuthStorage, modelRegistry);

  // PackageManager may be used for skills adapter even if extension loading fails
  let packageManager: DefaultPackageManager | undefined;
  try {
    const agentDir = getPackageManagerAgentDir();
    packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: createReadOnlyProviderSettingsView(cwd, agentDir) as any,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[extensions] Failed to discover extensions: ${message}`);
    createExtensionRuntime();
    modelRegistry.refresh();
  }

  // ── Skills adapter for skills discovery and execution toggling ─────────────
  const skillsAdapter = packageManager
    ? createSkillsAdapter({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        packageManager: packageManager as any,
        getSettingsPath: (rootDir: string) => getProjectSettingsPath(rootDir),
      })
    : undefined;

  // Diagnostic interval
  setInterval(() => {
    logDiagnostics(daemonDbHealthCheck ?? undefined);
  }, DIAGNOSTIC_INTERVAL_MS).unref?.();

  const app = createServer(store, {
    engine: cwdEngine,
    engineManager,
    centralCore: sharedCentralCore ?? undefined,
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
    headless: true,
    daemon: { token: daemonToken },
    skillsAdapter,
    https: loadTlsCredentialsFromEnv(),
  });

  const server = app.listen(selectedPort, selectedHost);

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const actualPort = (server.address() as AddressInfo).port;

  // ── CentralCore: node registration ────────────────────────────────────
  let centralCore: CentralCore | null = sharedCentralCore;
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
    console.warn(`[daemon] Failed to set local node online: ${message}`);
  }

  // Print startup banner with a masked token. The full token is persisted in
  // global settings (~/.fusion/settings.json, chmod 0600) and can be retrieved
  // with `fn daemon --token-only` — printing it here would write the raw
  // secret to terminal scrollback, CI logs, and screen-capture tools.
  console.log();
  console.log(`  Fusion Daemon`);
  console.log(`  ────────────────────────`);
  console.log(`  → http://${selectedHost}:${actualPort}`);
  console.log();
  console.log(`  Token:      ${maskToken(daemonToken)} (run "fn daemon --token-only" to retrieve)`);
  console.log();
  console.log(`  Health:     GET /api/health`);
  console.log(`  API:        /api/* (bearer token required)`);
  console.log(`  AI engine:  ✓ active`);
  console.log(`  Press Ctrl+C to stop`);
  console.log();

  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Stop all project engines uniformly
    await engineManager.stopAll();

    // Stop peer exchange service
    if (peerExchangeService) {
      try {
        await peerExchangeService.stop();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[daemon] Failed to stop peer exchange service: ${message}`);
      }
    }

    if (centralCore && localNodeId) {
      try {
        await centralCore.updateNode(localNodeId, { status: "offline" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[daemon] Failed to set local node offline: ${message}`);
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

    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  // Ignore SIGHUP so the daemon survives SSH session disconnects
  process.on("SIGHUP", () => {
    console.log("[daemon] Received SIGHUP (terminal disconnected) — ignoring");
  });
}
