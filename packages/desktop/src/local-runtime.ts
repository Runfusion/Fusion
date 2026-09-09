import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { appendFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Server } from "node:http";
import type { AsyncDataLayer, LoadedPluginSchemaContract } from "@fusion/core";
import type { AddressInfo } from "node:net";

import { resolveDesktopRuntimePrimaryProject } from "./engine-runtime.js";
import { resolveDesktopBundlePluginDirs } from "./bundled-plugin-dirs.js";

/*
 * FNXC:DesktopRuntime 2026-07-02-14:35:
 * Env-gated startup trace. Packaged desktop builds have no file logging, so a stalled
 * or failed embedded-runtime start is invisible to operators (the symptom is only a
 * spinner that times out). Setting FUSION_STARTUP_TRACE=<path> appends a timestamped
 * step-by-step trace of startLocal()/startEmbedded()/createDashboardServer() to that
 * file — the diagnostic that pinpointed the launch-mode split-brain hang. Zero cost
 * when unset; keep it so this class of hang is diagnosable in the field.
 */
const STARTUP_TRACE_FILE = process.env.FUSION_STARTUP_TRACE;
const __traceStart = Date.now();
const STARTUP_TRACE_MAX_ENTRIES = 500;
const STARTUP_TRACE_ENTRY_MAX_LENGTH = 2_000;
let startupTraceEntries: string[] = [];
let startupTracePath: string | undefined;
let startupTraceRotated = false;
let startupTraceFlushChain: Promise<void> = Promise.resolve();

/*
FNXC:DesktopStartupDiagnostics 2026-09-08-19:44:
Issue #3589 arrived as a screenshot because packaged startup kept its useful trace behind an
operator-only environment variable. Keep a bounded trace in memory for every launch, then flush
only at terminal points so the runtime can explain failures without synchronously writing on launch.
*/
/*
FNXC:DesktopStartupDiagnostics 2026-09-08-20:25:
Startup failures can include persisted provider or database configuration rather than only environment
values. Redact bare, quoted, JSON-style, authorization credential values, and every non-empty runtime
environment value before diagnostics enter the record or automatic log, because a generic configuration
key can carry a short secret and the support payload must remain safe to copy from a failed host.
*/
function redactStartupDiagnostic(value: string): string {
  let redacted = value
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]+)?@/gi, "$1[REDACTED]@")
    .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;"']+/gi, "$1$2[REDACTED]")
    .replace(/\b(bearer)\s+[A-Za-z0-9._\-+/=]+/gi, "$1 [REDACTED]")
    .replace(/((?:["']?(?:api[_-]?key|key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*')/gi, "$1[REDACTED]")
    .replace(/((?:["']?(?:api[_-]?key|key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?)\s*[:=]\s*)[^\s,;}"']+/gi, "$1[REDACTED]")
    .replace(/\b(sk-|ghp_|gho_|github_pat_|xox[abpr]-|AKIA)[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[REDACTED]")
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "[REDACTED]");
  for (const key of Object.keys(process.env)) {
    if (key) redacted = redacted.replaceAll(key, "[REDACTED_ENV]");
  }
  /* FNXC:DesktopStartupDiagnostics 2026-09-08-20:25: Replace longer values first so a short
     value cannot leave a suffix of a longer secret exposed. */
  for (const envValue of [...new Set(Object.values(process.env).filter((value): value is string => Boolean(value)))].sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(envValue, "[REDACTED_ENV]");
  }
  return redacted;
}

function formatStartupFailureTrace(failure: DesktopStartupFailure): string[] {
  return [
    `failure phase=${failure.phase} attempts=${failure.attempts} name=${failure.name}`,
    `failure message=${failure.message}`,
    ...(failure.stack ? [`failure stack=${failure.stack}`] : []),
    `failure platform=${failure.platform} node=${failure.nodeVersion} occurredAt=${failure.occurredAt}`,
  ];
}

function strace(msg: string): void {
  const elapsed = `[+${((Date.now() - __traceStart) / 1000).toFixed(2)}s] `;
  const rawEntry = `${elapsed}${msg}`.slice(0, STARTUP_TRACE_ENTRY_MAX_LENGTH);
  const entry = `${elapsed}${redactStartupDiagnostic(msg)}`.slice(0, STARTUP_TRACE_ENTRY_MAX_LENGTH);
  startupTraceEntries.push(entry);
  if (startupTraceEntries.length > STARTUP_TRACE_MAX_ENTRIES) startupTraceEntries = startupTraceEntries.slice(-STARTUP_TRACE_MAX_ENTRIES);
  if (!STARTUP_TRACE_FILE) return;
  try {
    /* FNXC:DesktopStartupDiagnostics 2026-09-08-20:01: The explicit operator-selected trace
       remains verbatim; automatic persisted diagnostics use the redacted in-memory buffer. */
    appendFileSync(STARTUP_TRACE_FILE, `${rawEntry}\n`);
  } catch {
    // best-effort operator-selected synchronous sink
  }
}

function bindStartupTraceSink(rootDir: string): void {
  if (startupTracePath) return;
  startupTracePath = join(rootDir, ".fusion", "logs", "desktop-startup.log");
}

function flushStartupTrace(failure?: DesktopStartupFailure): Promise<string | undefined> {
  if (!startupTracePath) return Promise.resolve(undefined);
  const path = startupTracePath;
  const entries = failure ? [...startupTraceEntries, ...formatStartupFailureTrace(failure)] : startupTraceEntries;
  const body = entries.length > 0 ? `${entries.join("\n")}\n` : "";
  startupTraceFlushChain = startupTraceFlushChain.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    if (!startupTraceRotated) {
      startupTraceRotated = true;
      await rename(path, join(dirname(path), "desktop-startup.prev.log")).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    if (body) await appendFile(path, body, "utf8");
  });
  return startupTraceFlushChain.then(() => path);
}

export type RuntimeSource = "embedded-local" | "external-cli" | "none";
export type RuntimeState = "stopped" | "starting" | "running" | "error";

/*
FNXC:MigrationHoldingPage 2026-07-17-13:20:
The one-time SQLite→PostgreSQL migration runs inside createTaskStoreForBackend
BEFORE the embedded server listens, so during it the desktop window only shows
the static "Starting local Fusion runtime…" gate. Surface structured migration
progress through the runtime status → IPC getRuntimeStatus →
fusionShell.getState().localRuntime → DesktopLaunchGate poll, which renders it
and suspends its 30s startup timeout while progress advances. `label` is the
same formatMigrationProgress() string the CLI logs.
*/
export interface DesktopMigrationProgress {
  active: boolean;
  phase: string;
  label: string;
}

export interface DesktopStartupFailure {
  phase: "create-store" | "store-init" | "store-watch" | "create-dashboard-server" | "server-listen" | "resolve-port";
  attempts: number;
  name: string;
  message: string;
  stack?: string;
  logPath?: string;
  logUnavailableReason?: "write-failed" | "disabled";
  platform: string;
  appVersion?: string;
  nodeVersion: string;
  occurredAt: string;
}

export interface DesktopRuntimeStatus {
  source: RuntimeSource;
  state: RuntimeState;
  port?: number;
  baseUrl?: string;
  error?: string;
  startupFailure?: DesktopStartupFailure;
  migration?: DesktopMigrationProgress;
}

/*
 * FNXC:DesktopRuntime 2026-07-07-12:00:
 * FN-7623: the embedded desktop server must wire a PluginStore + PluginLoader into createServer
 * (as the CLI dashboard command does) or the Settings -> Plugins Browse-registry sub-router never
 * mounts ("Plugin \"registry\" not found") and plugin install throws "Plugin install mode is not
 * supported: plugin loader not available". getPluginStore()/getDatabase() are the two TaskStore
 * members this wiring needs beyond the pre-existing init/watch/close surface.
 */
type PluginStoreLike = { init(): Promise<void> };
type TaskStoreLike = {
  init(): Promise<void>;
  watch(): Promise<void>;
  close(): void;
  getPluginStore(): PluginStoreLike;
  runPluginSchemaInits(hooks: LoadedPluginSchemaContract[]): Promise<void>;
  getAsyncLayer(): AsyncDataLayer;
};

type RuntimeCleanup = () => Promise<void> | void;

type RuntimeInstance = {
  store: TaskStoreLike;
  server: Server;
  port: number;
  baseUrl: string;
  cleanup?: RuntimeCleanup;
};

export interface LocalRuntimeManagerOptions {
  rootDir: string;
  getExternalPort?: () => number | undefined;
  createStore?: (rootDir: string, onMigrationProgress?: (progress: DesktopMigrationProgress) => void) => Promise<TaskStoreLike>;
  createDashboardServer?: (store: TaskStoreLike, rootDir: string) => Promise<Server | { server: Server; cleanup?: RuntimeCleanup }>;
  /**
   * FNXC:DesktopRuntime 2026-07-05-00:00:
   * Total attempts (including the first) for embedded startup. Field reports (FN-7617)
   * show Windows first-launch embedded starts intermittently throw once (during store
   * init/watch or dashboard-server boot) and then succeed immediately on a manual
   * Retry (a renderer reload that re-invokes startLocal()). Default 3 total attempts
   * so that self-heal happens inside the manager before the operator ever sees the
   * "Couldn't start local Fusion" error screen. Only applies to the embedded-start
   * path (never external-cli / already-running). Overridable so tests can drive
   * deterministic attempt counts with zero delay.
   */
  startupRetries?: number;
  /** Delay between failed embedded-start attempts, in ms. Overridable (use 0 in tests). */
  startupRetryDelayMs?: number;
}

const DEFAULT_STARTUP_RETRIES = 3;
const DEFAULT_STARTUP_RETRY_DELAY_MS = 150;

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createStoreDefault(
  rootDir: string,
  onMigrationProgress?: (progress: DesktopMigrationProgress) => void,
): Promise<TaskStoreLike> {
  // FNXC:BackendFlip 2026-06-26-14:40:
  // Consult the startup factory to boot a PostgreSQL-backed TaskStore. Post
  // default-flip: the factory boots embedded PG by default when DATABASE_URL
  // is unset and external PG when DATABASE_URL is set. The backend shutdown handle is stashed on the returned object so
  // the runtime manager's stop path can release the pool / stop an embedded
  // cluster.
  const { createTaskStoreForBackend, formatMigrationProgress } = await import("@fusion/core");
  const backendBoot = await createTaskStoreForBackend({
    rootDir,
    /* FNXC:MigrationHoldingPage 2026-07-17-13:20: forward the SQLite→PG migration stream so the launch gate can show live progress instead of a silent multi-minute "Starting…". */
    onMigrationProgress: (event) =>
      onMigrationProgress?.({ active: true, phase: event.phase, label: formatMigrationProgress(event) }),
  });
  /* FNXC:PostgresDesktopRuntime 2026-07-14-18:34: Desktop startup must fail visibly if PostgreSQL cannot boot; the removed opt-out must never construct an unbacked SQLite TaskStore. */
  const store = backendBoot.taskStore as unknown as TaskStoreLike;
  // Attach the backend shutdown so LocalRuntimeManager can invoke it on stop.
  (store as TaskStoreLike & { __backendShutdown?: () => Promise<void> }).__backendShutdown =
    backendBoot.shutdown;
  // FNXC:DesktopClosePolicy 2026-07-18-06:00: detach variant for the "leave PostgreSQL running" quit answer.
  (store as TaskStoreLike & { __backendDetach?: () => Promise<void> }).__backendDetach =
    backendBoot.detachKeepingEmbedded;
  return store;
}

/*
FNXC:SystemPanel 2026-07-12-14:20:
Desktop restart support for the dashboard System panel. Electron owns the
process lifecycle, so "restart" = app.relaunch() then a GRACEFUL app.quit()
(after a short delay so the HTTP 202 flushes). quit() — not exit() — is
required so the app's `before-quit` teardown (which stops the embedded Fusion
runtime: engines, CentralCore, store) actually runs; app.exit() skipped it and
risked DB/state corruption on every restart. A bounded fallback still forces
app.exit(0) if quit is vetoed or stalls. Electron is resolved dynamically so
this module still loads under plain-node tests, where the electron package
exports a binary path instead of the runtime API — then systemControl is simply
omitted and the System panel disables its restart controls. Rebuild controls
never appear on desktop (no sourceWorkspaceRoot — nothing to rebuild).
Cross-reference: local-server.ts carries the matching wiring for the other
desktop startup path.
*/
const DESKTOP_RESTART_FLUSH_MS = 300;
const DESKTOP_QUIT_FALLBACK_MS = 5_000;

export async function resolveDesktopSystemControl(): Promise<
  Pick<import("@fusion/dashboard").ServerOptions, "systemControl">
> {
  try {
    const electron = (await import("electron")) as unknown as {
      app?: { relaunch: () => void; quit: () => void; exit: (code?: number) => void };
    };
    const electronApp = electron.app;
    if (!electronApp || typeof electronApp.relaunch !== "function") return {};
    return {
      systemControl: {
        supervised: true,
        requestRestart: (reason: string) => {
          /* FNXC:DesktopRestart 2026-07-12-23:45: Desktop accepts the dashboard restart reason for API parity even though Electron relaunch does not consume it; keep it explicitly used so lint catches real unused parameters. */
          void reason;
          setTimeout(() => {
            electronApp.relaunch();
            // Graceful quit runs before-quit teardown; force-exit only if it stalls.
            electronApp.quit();
            setTimeout(() => electronApp.exit(0), DESKTOP_QUIT_FALLBACK_MS).unref?.();
          }, DESKTOP_RESTART_FLUSH_MS);
          return true;
        },
      },
    };
  } catch {
    return {};
  }
}

async function createDashboardServerDefault(store: TaskStoreLike, rootDir: string): Promise<{ server: Server; cleanup: RuntimeCleanup }> {
  const { CentralCore, PluginLoader, ensureBundledPluginInstalled, isBundledPluginId } = await import("@fusion/core");
  const { createServer } = await import("@fusion/dashboard");
  const { ProjectEngineManager, createFusionAuthStorage, createFusionModelRegistry, seedDashboardProviders } = await import("@fusion/engine");

  /*
   * FNXC:DesktopRuntime 2026-06-20-23:39:
   * Embedded desktop local mode should be an executable Fusion node, not a dashboard-only shell. Start all registered project engines and pass the manager to the API server so project-scoped routes can start newly accessed engines.
   */
  /* FNXC:PostgresDesktopLifecycle 2026-07-14-19:10: Desktop engines and the dashboard share the TaskStore's AsyncDataLayer; constructing a layerless CentralCore would boot a second pool and repeat schema initialization. */
  const centralCore = new CentralCore(undefined, { asyncLayer: store.getAsyncLayer() });
  const engineManager = new ProjectEngineManager(centralCore);
  const providerSeeding: { dispose?: () => void } = {};
  const cleanup = async () => {
    providerSeeding.dispose?.();
    await engineManager.stopAll();
    await centralCore.close?.();
  };

  try {
    strace("createDashboardServer: centralCore.init");
    await centralCore.init();
    /*
     * FNXC:DesktopRuntime 2026-07-03-03:30:
     * Do NOT auto-register the home directory as a project. Start engines for whatever projects the
     * operator has already onboarded (none on a fresh install), and only pick a default/primary engine
     * when such a project exists. With zero projects the server starts engine-less and the dashboard
     * shows its onboarding empty state; new projects register via POST /api/projects and their engines
     * spin up lazily through onProjectFirstAccessed / reconciliation.
     */
    void rootDir; // runtime root no longer implies a project; kept for signature/back-compat.
    strace("createDashboardServer: startAll");
    await engineManager.startAll();
    strace("createDashboardServer: startAll DONE; startReconciliation");
    engineManager.startReconciliation();
    const rootProject = await resolveDesktopRuntimePrimaryProject(centralCore);
    strace(`createDashboardServer: primary project ${rootProject ? "resolved" : "absent"}`);
    const primaryEngine = rootProject ? await engineManager.ensureEngine(rootProject.id) : undefined;
    /*
     * FNXC:DesktopRuntime 2026-07-07-00:00:
     * FN-7622: wire an auth storage into the embedded server AND run it through the same
     * registration sequence the CLI serve/dashboard/daemon commands use — built-in Zai/API-key
     * provider seeding (registerBuiltInZaiProvider), wrapAuthStorageWithApiKeyProviders, and
     * registerCustomProviders(globalSettings.customProviders) — via the shared
     * @fusion/engine seedDashboardProviders() helper. Previously this path passed the RAW
     * authStorage/modelRegistry straight to createServer and skipped that whole sequence, so
     * desktop's Authentication page and model picker showed a truncated provider catalog
     * (stock API-key providers and user customProviders[] missing) versus the identical config
     * rendered by the web build. Passing the WRAPPED authStorage returned by
     * seedDashboardProviders (not the raw one) closes that gap; the disposer unsubscribes the
     * settings:updated -> reregisterCustomProviders listener on shutdown.
     */
    const authStorage = createFusionAuthStorage();
    // FNXC:DesktopRuntime 2026-07-03-07:00: a ModelRegistry is required for the /api/models endpoint;
    // without it the onboarding model picker shows "no models" even with a provider connected.
    const modelRegistry = await createFusionModelRegistry(authStorage);
    strace("createDashboardServer: seedDashboardProviders");
    const { authStorage: wrappedAuthStorage, dispose } = await seedDashboardProviders({
      store: store as never,
      authStorage,
      modelRegistry,
      // Provider registration may include operator configuration, so its detailed messages never enter the persisted startup trace.
      log: () => strace("createDashboardServer: provider registration event"),
    });
    providerSeeding.dispose = dispose;

    /*
     * FNXC:DesktopRuntime 2026-07-07-12:00:
     * FN-7623: mirror the CLI dashboard command's plugin wiring (packages/cli/src/commands/dashboard.ts)
     * — construct the store's PluginStore, build a PluginLoader, load enabled plugins, and run schema-init
     * hooks — so the desktop embedded server's registry sub-router mounts (GET /api/plugins/registry) and
     * POST /api/plugins install mode works. Failures here must not crash embedded startup: the dashboard
     * still needs to boot even if the plugin subsystem can't come up (e.g. a corrupt plugin manifest), so
     * this is wrapped and traced rather than left to throw.
     *
     * FNXC:DesktopRuntime 2026-07-07-12:30:
     * FN-7637: bundled-plugin auto-install (Dependency Graph, Hermes, OpenClaw, Paperclip, …) is now
     * host-agnostic in @fusion/core's ensureBundledPluginInstalled. The only host-specific input is
     * bundle-directory resolution: resolveDesktopBundlePluginDirs (./bundled-plugin-dirs.js) resolves
     * each manifest id to its staged `@fusion-plugin-examples/<short-name>` package directory via
     * import.meta.resolve, mirroring the CLI's `<cli>/dist/plugins/<id>` resolver
     * (packages/cli/src/plugins/bundled-plugin-install.ts). Mirrors the CLI dashboard command's startup
     * auto-install pass: install the bundled Dependency Graph plugin before loadAllPlugins() so it is
     * enabled/registered before the general load pass runs, and expose the same lazy-install callback the
     * CLI wires so PUT /api/plugins/:id/settings can auto-install Hermes/OpenClaw/Paperclip/etc. on first
     * save. Cross-reference: local-server.ts carries the matching wiring for the other desktop startup path.
     */
    let pluginStore: PluginStoreLike | undefined;
    let pluginLoader: InstanceType<typeof PluginLoader> | undefined;
    let ensureBundledPluginInstalledCallback: ((pluginId: string) => Promise<boolean>) | undefined;
    try {
      strace("createDashboardServer: pluginStore.init");
      pluginStore = store.getPluginStore();
      await pluginStore.init();
      pluginLoader = new PluginLoader({ pluginStore: pluginStore as never, taskStore: store as never });

      const boundPluginStore = pluginStore;
      const boundPluginLoader = pluginLoader;

      try {
        strace("createDashboardServer: bundled dependency-graph auto-install");
        const installStatus = await ensureBundledPluginInstalled(
          boundPluginStore as never,
          boundPluginLoader,
          "fusion-plugin-dependency-graph",
          resolveDesktopBundlePluginDirs,
        );
        void installStatus;
        strace("createDashboardServer: bundled dependency-graph auto-install completed");
      } catch (error) {
        void error;
        strace("createDashboardServer: bundled dependency-graph auto-install failed (non-fatal)");
      }

      strace("createDashboardServer: pluginLoader.loadAllPlugins");
      const { loaded, errors } = await pluginLoader.loadAllPlugins();
      void loaded;
      void errors;
      strace("createDashboardServer: plugins loaded");
      /* FNXC:DesktopPluginSchema 2026-07-14-23:31: PluginLoader runs backend-aware schema contracts before onLoad; embedded desktop must not replay them after loadAllPlugins. */

      ensureBundledPluginInstalledCallback = async (pluginId: string): Promise<boolean> => {
        if (!isBundledPluginId(pluginId)) {
          void pluginId;
          strace("ensureBundledPluginInstalled: unknown bundled plugin id");
          return false;
        }
        try {
          const status = await ensureBundledPluginInstalled(boundPluginStore as never, boundPluginLoader, pluginId, resolveDesktopBundlePluginDirs);
          if (status === "missing-bundle") {
            strace("ensureBundledPluginInstalled: bundled plugin not found in this build");
            return false;
          }
          strace("ensureBundledPluginInstalled: bundled plugin completed");
          return true;
        } catch (error) {
          void error;
          strace("ensureBundledPluginInstalled: auto-install failed");
          throw error;
        }
      };
    } catch (error) {
      console.error(`[plugins] Desktop plugin initialization failed: ${error instanceof Error ? error.message : String(error)}`);
      void error;
      strace("createDashboardServer: plugin subsystem init failed (non-fatal)");
      pluginStore = undefined;
      pluginLoader = undefined;
      ensureBundledPluginInstalledCallback = undefined;
    }

    strace("createDashboardServer: createServer");
    const app = createServer(store as never, {
      ...(primaryEngine ? { engine: primaryEngine } : {}),
      engineManager,
      centralCore,
      authStorage: wrappedAuthStorage,
      modelRegistry,
      ...(pluginStore && pluginLoader ? { pluginStore: pluginStore as never, pluginLoader, pluginRunner: pluginLoader } : {}),
      ...(ensureBundledPluginInstalledCallback ? { ensureBundledPluginInstalled: ensureBundledPluginInstalledCallback } : {}),
      onProjectFirstAccessed: (projectId: string) => engineManager.onProjectAccessed(projectId),
      ...(await resolveDesktopSystemControl()),
    });

    strace("createDashboardServer: app.listen(0)");
    const server = app.listen(0);
    strace("createDashboardServer: returning server object");
    return {
      server,
      cleanup,
    };
  } catch (error) {
    void error;
    strace("createDashboardServer: failed");
    await cleanup();
    throw error;
  }
}

function parsePort(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function getAddressPort(server: Server): number {
  const address = server.address() as AddressInfo | null;
  const port = address?.port;
  if (!port) {
    throw new Error("Failed to resolve local server port");
  }
  return port;
}

export class LocalRuntimeManager {
  private runtime: RuntimeInstance | null = null;
  private startupPromise: Promise<DesktopRuntimeStatus> | null = null;
  private stopPromise: Promise<DesktopRuntimeStatus> | null = null;
  private status: DesktopRuntimeStatus = { source: "none", state: "stopped" };

  private readonly getExternalPort: () => number | undefined;
  private readonly createStore: (rootDir: string, onMigrationProgress?: (progress: DesktopMigrationProgress) => void) => Promise<TaskStoreLike>;
  private readonly createDashboardServer: (store: TaskStoreLike, rootDir: string) => Promise<Server | { server: Server; cleanup?: RuntimeCleanup }>;
  private readonly startupRetries: number;
  private readonly startupRetryDelayMs: number;
  private lastAttemptPhase: DesktopStartupFailure["phase"] = "create-store";

  constructor(private readonly options: LocalRuntimeManagerOptions) {
    this.getExternalPort = options.getExternalPort ?? (() => parsePort(process.env.FUSION_SERVER_PORT));
    this.createStore = options.createStore ?? createStoreDefault;
    this.createDashboardServer = options.createDashboardServer ?? createDashboardServerDefault;
    this.startupRetries = Math.max(1, options.startupRetries ?? DEFAULT_STARTUP_RETRIES);
    this.startupRetryDelayMs = options.startupRetryDelayMs ?? DEFAULT_STARTUP_RETRY_DELAY_MS;
  }

  getStatus(): DesktopRuntimeStatus {
    if (this.runtime) {
      return {
        source: "embedded-local",
        state: "running",
        port: this.runtime.port,
        baseUrl: this.runtime.baseUrl,
      };
    }

    const externalPort = this.getExternalPort();
    if (externalPort) {
      this.status = {
        source: "external-cli",
        state: "running",
        port: externalPort,
        baseUrl: `http://127.0.0.1:${externalPort}`,
      };
    }

    return this.status;
  }

  getServerPort(): number | undefined {
    return this.getStatus().port;
  }

  async startLocal(): Promise<DesktopRuntimeStatus> {
    strace("startLocal: ENTER");
    const externalPort = this.getExternalPort();
    if (externalPort) {
      strace("startLocal: external-cli branch — not starting embedded");
      this.status = {
        source: "external-cli",
        state: "running",
        port: externalPort,
        baseUrl: `http://127.0.0.1:${externalPort}`,
      };
      return this.status;
    }

    if (this.runtime) {
      return this.getStatus();
    }

    if (this.startupPromise) {
      return this.startupPromise;
    }

    bindStartupTraceSink(this.options.rootDir);
    this.status = { source: "embedded-local", state: "starting" };
    this.startupPromise = this.startEmbedded();

    try {
      return await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  /*
   * FNXC:DesktopRuntime 2026-07-05-00:00:
   * Windows first-launch field report (FN-7617): the embedded runtime start intermittently
   * throws on its very first attempt (store init/watch or dashboard-server boot), but a
   * manual Retry (a renderer reload that re-invokes startLocal()) always succeeds — proving
   * the failure is transient rather than a hard misconfiguration. Rather than surface that
   * transient to the renderer (which renders the scary "Couldn't start local Fusion"
   * local-error phase in DesktopLaunchGate.tsx), retry the embedded attempt internally,
   * bounded and with full cleanup between attempts, so a healthy install self-heals before
   * the operator ever sees an error screen. `status.state` stays "starting" across retries;
   * only the LAST attempt's real error sets state "error" and is thrown, so genuine failures
   * (e.g. a bad dashboard import) still surface their real message unchanged.
   */
  private async startEmbedded(): Promise<DesktopRuntimeStatus> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.startupRetries; attempt++) {
      strace(`startEmbedded: attempt ${attempt}/${this.startupRetries}`);
      try {
        const status = await this.startEmbeddedAttempt();
        void this.settleStartupTrace();
        return status;
      } catch (error) {
        lastError = error;
        strace(`startEmbedded: attempt ${attempt}/${this.startupRetries} failed`);
        void this.settleStartupTrace();
        if (attempt < this.startupRetries) {
          this.status = { source: "embedded-local", state: "starting" };
          if (this.startupRetryDelayMs > 0) await delay(this.startupRetryDelayMs);
        }
      }
    }

    const error = lastError instanceof Error ? lastError : new Error(String(lastError));
    /*
    FNXC:DesktopStartupDiagnostics 2026-09-08-20:01:
    The host that fails to start may also be unable to write its data root. Publish a complete,
    redacted failure before detached logging, and persist only this approved diagnostic shape rather
    than provider/configuration trace payloads that could contain credentials.
    */
    const startupFailure: DesktopStartupFailure = {
      phase: this.lastAttemptPhase,
      attempts: this.startupRetries,
      name: redactStartupDiagnostic(error.name || "Error"),
      message: redactStartupDiagnostic(error.message || String(lastError)),
      stack: error.stack ? redactStartupDiagnostic(error.stack) : undefined,
      platform: process.platform,
      nodeVersion: process.versions.node,
      occurredAt: new Date().toISOString(),
    };
    this.runtime = null;
    this.status = { source: "embedded-local", state: "error", error: startupFailure.message, startupFailure };
    strace(`startEmbedded: all ${this.startupRetries} attempts failed — surfacing final error`);
    void this.settleStartupTrace(startupFailure);
    throw lastError;
  }

  /** The trace write is detached because a read-only host is often the startup failure itself. */
  private async settleStartupTrace(failure?: DesktopStartupFailure): Promise<void> {
    try {
      const logPath = await flushStartupTrace(failure);
      if (failure && logPath && this.status.state === "error" && this.status.startupFailure === failure) {
        this.status = { ...this.status, startupFailure: { ...failure, logPath } };
      }
    } catch {
      if (failure && this.status.state === "error" && this.status.startupFailure === failure) {
        this.status = { ...this.status, startupFailure: { ...failure, logUnavailableReason: "write-failed" } };
      }
    }
  }

  /** Test-only synchronization seam; startup itself never awaits trace I/O. */
  waitForStartupTraceFlush(): Promise<void> {
    return startupTraceFlushChain.catch(() => undefined);
  }

  private async startEmbeddedAttempt(): Promise<DesktopRuntimeStatus> {
    let store: TaskStoreLike | null = null;
    let server: Server | null = null;
    let cleanup: RuntimeCleanup | undefined;

    try {
      strace("startEmbedded: begin");
      /*
      FNXC:MigrationHoldingPage 2026-07-17-13:20:
      Publish live migration progress into the "starting" status so the renderer's
      DesktopLaunchGate (polling getRuntimeStatus every 250ms) can show it. Only
      overwrite while still starting — a late/stale event must never clobber a
      terminal running/error status.
      */
      this.lastAttemptPhase = "create-store";
      store = await this.createStore(this.options.rootDir, (progress) => {
        if (this.status.state === "starting") {
          this.status = { source: "embedded-local", state: "starting", migration: progress };
        }
      });
      strace("startEmbedded: store.init");
      this.lastAttemptPhase = "store-init";
      await store.init();
      strace("startEmbedded: store.watch");
      this.lastAttemptPhase = "store-watch";
      await store.watch();
      strace("startEmbedded: createDashboardServer()");
      this.lastAttemptPhase = "create-dashboard-server";
      const dashboardServer = await this.createDashboardServer(store, this.options.rootDir);
      cleanup = "server" in dashboardServer ? dashboardServer.cleanup : undefined;
      server = "server" in dashboardServer ? dashboardServer.server : dashboardServer;
      strace("startEmbedded: awaiting server 'listening' | 'error'");
      this.lastAttemptPhase = "server-listen";
      await Promise.race([
        once(server, "listening"),
        once(server, "error").then(([error]) => {
          throw error;
        }),
      ]);

      this.lastAttemptPhase = "resolve-port";
      const port = getAddressPort(server);
      const baseUrl = `http://127.0.0.1:${port}`;
      this.runtime = { store, server, port, baseUrl, cleanup };
      this.status = { source: "embedded-local", state: "running", port, baseUrl };
      strace("startEmbedded: running");
      return this.status;
    } catch (error) {
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
      }
      await Promise.resolve(cleanup?.()).catch(() => undefined);
      if (store) {
        const backendShutdown = (store as TaskStoreLike & { __backendShutdown?: () => Promise<void> }).__backendShutdown;
        if (backendShutdown) await backendShutdown().catch(() => undefined);
        else store.close();
      }
      this.runtime = null;
      strace("startEmbedded: failed");
      throw error;
    }
  }

  async stopLocal(options: { keepEmbeddedPostgres?: boolean } = {}): Promise<DesktopRuntimeStatus> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopInternal(options);
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async stopInternal(options: { keepEmbeddedPostgres?: boolean } = {}): Promise<DesktopRuntimeStatus> {
    if (this.runtime) {
      const runtime = this.runtime;
      this.runtime = null;
      await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
      let cleanupError: unknown;
      try {
        await runtime.cleanup?.();
      } catch (error) {
        cleanupError = error;
      }
      // FNXC:RuntimeStartupWiring 2026-06-24-10:30:
      // Release the backend connection pool / embedded PG cluster if the store
      // was booted via the startup factory. store.close() already closes the
      // AsyncDataLayer pool; this adds embedded-cluster teardown. Best-effort.
      /*
      FNXC:DesktopClosePolicy 2026-07-18-05:00:
      keepEmbeddedPostgres is the operator's Windows quit-prompt answer: close
      the pools and the Fusion runtime but leave the embedded postmaster
      running for other Fusion processes. Default (false) preserves the full
      teardown for programmatic restarts and every non-prompted path.
      */
      const storeWithBackend = runtime.store as TaskStoreLike & {
        __backendShutdown?: () => Promise<void>;
        __backendDetach?: () => Promise<void>;
      };
      if (options.keepEmbeddedPostgres && storeWithBackend.__backendDetach) {
        /*
        FNXC:DesktopClosePolicy 2026-07-18-06:00:
        Review finding: skipping the backend shutdown alone left the embedded
        lifecycle's process shutdown hook armed, so Electron exit stopped the
        postmaster despite the operator's "leave it running" answer. Detach
        closes pools and DISARMS that hook without stopping the server.
        */
        await storeWithBackend.__backendDetach().catch(() => undefined);
      } else if (storeWithBackend.__backendShutdown) {
        await storeWithBackend.__backendShutdown().catch(() => undefined);
      } else {
        runtime.store.close();
      }
      if (cleanupError) throw cleanupError;
      this.status = { source: "none", state: "stopped" };
      return this.status;
    }

    if (this.getStatus().source === "external-cli") {
      return this.status;
    }

    this.status = { source: "none", state: "stopped" };
    return this.status;
  }
}
