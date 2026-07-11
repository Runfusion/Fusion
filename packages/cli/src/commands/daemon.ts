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
  reconcileClaudeCliPaths,
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
import { wrapAuthStorageWithApiKeyProviders } from "./provider-auth.js";
import { getModelRegistryModelsPath, getPackageManagerAgentDir } from "./auth-paths.js";
import { resolveProject } from "../project-context.js";
import { ensureBundledDependencyGraphPluginInstalled, ensureBundledGrokRuntimePluginInstalled } from "../plugins/bundled-plugin-install.js";
import { handleOpencodeGoApiKeySaved, syncStartupModels } from "./startup-model-sync.js";
import { registerCustomProviders, reregisterCustomProviders } from "./custom-provider-registry.js";
import { ensureCwdProjectRegistered } from "./ensure-project-registered.js";

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
  /** Disable cwd auto-registration */
  noAutoRegister?: boolean;
  /** Preferred primary project (id or name). */
  project?: string;
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
  let ntfyProjectId: string | undefined;
  let sharedCentralCore: CentralCore | null = null;
  try {
    sharedCentralCore = new CentralCore();
    await sharedCentralCore.init();
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

  if (sharedCentralCore) {
    const registered = await ensureCwdProjectRegistered({
      cwd,
      central: sharedCentralCore,
      logPrefix: "daemon",
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
  });

  await engineManager.startAll();

  let hybridExecutor: HybridExecutor | null = null;
  const hybridGate = await shouldUseHybridExecutor(sharedCentralCore);
  console.log(`[daemon] hybrid executor gate: enabled=${hybridGate.enabled} reason=${hybridGate.reason}`);
  if (hybridGate.enabled) {
    hybridExecutor = new HybridExecutor(sharedCentralCore);
    await hybridExecutor.initialize();
  }

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

      console.error(`[daemon] --project "${opts.project}" did not match any started engine`);
      process.exit(1);
      return null;
    }

    const defaultProjectId = await sharedCentralCore?.getDefaultProjectId?.();
    if (defaultProjectId) {
      const defaultEngine = engineManager.getEngine(defaultProjectId);
      if (defaultEngine) {
        return { engine: defaultEngine, source: "default-setting" };
      }
      console.warn(`[daemon] defaultProjectId ${defaultProjectId} is set but no engine started for it — falling through`);
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
    console.error("[daemon] No engines started — registry empty or all engines failed to start. Exiting.");
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
    `[daemon] HTTP layer bound to project ${primaryProjectName} (${primaryProjectId}) [source: ${primarySelection.source}]`,
  );

  const store = primaryEngine.getTaskStore();

  const getGlobalSettingsStore = () => {
    const candidate = store as { getGlobalSettingsStore?: () => { getSettings: () => Promise<unknown> } };
    return typeof candidate.getGlobalSettingsStore === "function"
      ? candidate.getGlobalSettingsStore()
      : null;
  };

  if (peerExchangeService) {
    const globalSettingsStore = getGlobalSettingsStore();
    if (globalSettingsStore) {
      void globalSettingsStore.getSettings().then((globalSettings) => {
        peerExchangeService?.updateGlobalSettings(
          globalSettings as Parameters<PeerExchangeService["updateGlobalSettings"]>[0],
        );
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[daemon] Failed to load initial peer exchange settings: ${message}`);
      });
    }
  }

  store.on("settings:updated", () => {
    if (!peerExchangeService) return;
    const globalSettingsStore = getGlobalSettingsStore();
    if (!globalSettingsStore) return;
    void globalSettingsStore.getSettings().then((globalSettings) => {
      peerExchangeService?.updateGlobalSettings(
        globalSettings as Parameters<PeerExchangeService["updateGlobalSettings"]>[0],
      );
    }).catch(() => undefined);
  });

  await store.watch();

  // Set up database health check for diagnostics
  daemonDbHealthCheck = () => store.healthCheck();

  if (opts.paused) {
    await store.updateSettings({ enginePaused: true });
    console.log("[engine] Starting in paused mode — automation disabled");
  }

  // ── PluginStore: plugin installation management ─────────────────────
  const pluginStore = store.getPluginStore();
  await pluginStore.init();

  // ── PluginLoader: plugin lifecycle management ───────────────────────
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
   * FN-7761: packaged daemon sessions must load the bundled Grok CLI runtime before executors/reviewers create sessions, so grok-cli/no-key routing uses the logged-in `grok` CLI instead of pi's key-requiring direct endpoint.
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

  // Auto-load all enabled plugins so runtime UI (NewAgentDialog, AgentDetailView)
  // can discover installed runtimes like Hermes and OpenClaw.
  try {
    const { loaded, errors } = await pluginLoader.loadAllPlugins();
    console.log(`[plugins] Loaded ${loaded} plugins (${errors} errors)`);

    const schemaHooks = pluginLoader.getPluginSchemaInitHooks();
    if (schemaHooks.length > 0) {
      try {
        await store.getDatabase().runPluginSchemaInits(schemaHooks);
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

    // Always prefer Fusion's vendored `@fusion/pi-claude-cli` over any
    // external `pi-claude-cli` install. Drops shadowing externals (e.g. a
    // global `npm install -g pi-claude-cli`) so the upstream's once-and-lock
    // MCP-config bug can't poison sessions.
    // Inject the cli's own extension (@runfusion/fusion) so fn_* tools
    // register globally without requiring `pi install npm:@runfusion/fusion`.
    const selfExtension = resolveSelfExtension();
    const selfExtensionPaths = selfExtension.status === "ok" ? [selfExtension.path] : [];
    if (selfExtension.status !== "ok") {
      console.warn(`[extensions] self: ${selfExtension.reason}`);
    }
    setHostExtensionPaths(selfExtensionPaths);

    const reconciledExtensionPaths = reconcileClaudeCliPaths(
      [...selfExtensionPaths, ...getEnabledPiExtensionPaths(primaryCwd), ...packageExtensionPaths, ...claudeCliPaths],
      claudeCliPaths[0] ?? null,
    );

    const extensionsResult = await discoverAndLoadExtensions(
      [...reconciledExtensionPaths, ...droidCliPaths, ...llamaCppPaths],
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

  // ── Skills adapter for skills discovery and execution toggling ─────────────
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
         * `fn daemon` serves managed projects independently from its startup root. Resolve plugin skills with a PluginStore scoped to the requesting rootDir so disabled daemon-root plugins do not suppress project-enabled plugin:<id> skills.
         */
        getPluginSkills: getProjectScopedPluginSkills,
      })
    : undefined;

  // Diagnostic interval
  setInterval(() => {
    logDiagnostics(daemonDbHealthCheck ?? undefined);
  }, DIAGNOSTIC_INTERVAL_MS).unref?.();

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
    onProjectFirstAccessed: (projectId: string) => engineManager.onProjectAccessed(projectId),
    onProjectRegistered: ({ path }) => {
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
    onUseDroidCliToggled: (_prev, next) => {
      if (next) {
        console.log("[extensions] Droid CLI enabled — restart required for full effect");
      }
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

  /*
  FNXC:CustomProviders 2026-06-30-00:00:
  Daemon startup must not wait on custom-provider model probes because offline provider endpoints can take one timeout each. Start the refresh after listen and let settings:updated reconcile the model registry when persisted models change.
  */
  void refreshAllCustomProviderModels(store, (message) => console.log(`[custom-providers] ${message}`)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[custom-providers] Failed to refresh custom provider models from global settings: ${message}`);
  });

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

  /*
  FNXC:DaemonSignalExit 2026-07-10-14:00:
  When the host terminates the daemon under memory pressure it sends SIGTERM, which
  this handler turns into a graceful shutdown. Exiting 0 on a signal made a
  memory-pressure kill indistinguishable from a clean operator stop, so a
  `Restart=on-failure` systemd unit treated it as success and left the daemon dead.
  Exit with the POSIX 128+signal convention (SIGINT=130, SIGTERM=143) so
  `Restart=on-failure` restarts an externally-killed daemon; a deliberate
  `systemctl stop` still won't restart (systemd honors the requested inactive
  state regardless of exit code). A non-signal shutdown() caller still exits 0.
  */
  const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

  const shutdown = async (signal?: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Stop all project engines uniformly
    if (hybridExecutor) {
      await hybridExecutor.shutdown();
    }

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
    process.exit(signal ? (SIGNAL_EXIT_CODES[signal] ?? 128) : 0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  // Ignore SIGHUP so the daemon survives SSH session disconnects
  process.on("SIGHUP", () => {
    console.log("[daemon] Received SIGHUP (terminal disconnected) — ignoring");
  });
}
