import { once } from "node:events";
import { appendFileSync } from "node:fs";
import type { Server } from "node:http";
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
function strace(msg: string): void {
  if (!STARTUP_TRACE_FILE) return;
  try {
    appendFileSync(STARTUP_TRACE_FILE, `[+${((Date.now() - __traceStart) / 1000).toFixed(2)}s] ${msg}\n`);
  } catch {
    // best-effort
  }
}

export type RuntimeSource = "embedded-local" | "external-cli" | "none";
export type RuntimeState = "stopped" | "starting" | "running" | "error";

export interface DesktopRuntimeStatus {
  source: RuntimeSource;
  state: RuntimeState;
  port?: number;
  baseUrl?: string;
  error?: string;
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
type PluginDatabaseLike = { runPluginSchemaInits(hooks: Array<{ pluginId: string; hook: unknown }>): Promise<void> };

type TaskStoreLike = {
  init(): Promise<void>;
  watch(): Promise<void>;
  close(): void;
  getPluginStore(): PluginStoreLike;
  getDatabase(): PluginDatabaseLike;
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
  createStore?: (rootDir: string) => Promise<TaskStoreLike>;
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

async function createStoreDefault(rootDir: string): Promise<TaskStoreLike> {
  const { TaskStore } = await import("@fusion/core");
  return new TaskStore(rootDir) as TaskStoreLike;
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
        requestRestart: (_reason: string) => {
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
  const centralCore = new CentralCore();
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
    strace(`createDashboardServer: primaryProject=${rootProject?.id ?? "none"}`);
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
    const modelRegistry = createFusionModelRegistry(authStorage);
    strace("createDashboardServer: seedDashboardProviders");
    const { authStorage: wrappedAuthStorage, dispose } = await seedDashboardProviders({
      store: store as never,
      authStorage,
      modelRegistry,
      log: (scope, message) => strace(`[${scope}] ${message}`),
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
        strace(`createDashboardServer: bundled dependency-graph auto-install status=${installStatus}`);
      } catch (error) {
        strace(
          `createDashboardServer: bundled dependency-graph auto-install FAILED (non-fatal) — ${error instanceof Error ? error.stack : String(error)}`,
        );
      }

      strace("createDashboardServer: pluginLoader.loadAllPlugins");
      const { loaded, errors } = await pluginLoader.loadAllPlugins();
      strace(`createDashboardServer: plugins loaded=${loaded} errors=${errors}`);
      const schemaHooks = pluginLoader.getPluginSchemaInitHooks();
      if (schemaHooks.length > 0) {
        await store.getDatabase().runPluginSchemaInits(schemaHooks);
      }

      ensureBundledPluginInstalledCallback = async (pluginId: string): Promise<boolean> => {
        if (!isBundledPluginId(pluginId)) {
          strace(`ensureBundledPluginInstalled: unknown bundled plugin id "${pluginId}"`);
          return false;
        }
        try {
          const status = await ensureBundledPluginInstalled(boundPluginStore as never, boundPluginLoader, pluginId, resolveDesktopBundlePluginDirs);
          if (status === "missing-bundle") {
            strace(`ensureBundledPluginInstalled: bundled plugin "${pluginId}" not found in this build`);
            return false;
          }
          strace(`ensureBundledPluginInstalled: bundled plugin "${pluginId}" status=${status}`);
          return true;
        } catch (error) {
          strace(
            `ensureBundledPluginInstalled: failed to auto-install "${pluginId}" — ${error instanceof Error ? error.stack : String(error)}`,
          );
          throw error;
        }
      };
    } catch (error) {
      strace(
        `createDashboardServer: plugin subsystem init FAILED (non-fatal, dashboard still boots) — ${error instanceof Error ? error.stack : String(error)}`,
      );
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
    strace(`createDashboardServer: THREW ${error instanceof Error ? error.stack : String(error)}`);
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
  private readonly createStore: (rootDir: string) => Promise<TaskStoreLike>;
  private readonly createDashboardServer: (store: TaskStoreLike, rootDir: string) => Promise<Server | { server: Server; cleanup?: RuntimeCleanup }>;
  private readonly startupRetries: number;
  private readonly startupRetryDelayMs: number;

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
      strace(`startLocal: external-cli branch (FUSION_SERVER_PORT=${externalPort}) — NOT starting embedded`);
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
        return await this.startEmbeddedAttempt();
      } catch (error) {
        lastError = error;
        strace(
          `startEmbedded: attempt ${attempt}/${this.startupRetries} FAILED — ${error instanceof Error ? error.message : String(error)}`,
        );
        if (attempt < this.startupRetries) {
          // Keep reporting "starting" while a retry is still pending — the operator/gate
          // must not see "error" for a transient attempt that self-heals.
          this.status = { source: "embedded-local", state: "starting" };
          if (this.startupRetryDelayMs > 0) {
            await delay(this.startupRetryDelayMs);
          }
        }
      }
    }

    this.runtime = null;
    this.status = {
      source: "embedded-local",
      state: "error",
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
    strace(`startEmbedded: all ${this.startupRetries} attempts failed — surfacing final error`);
    throw lastError;
  }

  private async startEmbeddedAttempt(): Promise<DesktopRuntimeStatus> {
    let store: TaskStoreLike | null = null;
    let server: Server | null = null;
    let cleanup: RuntimeCleanup | undefined;

    try {
      strace(`startEmbedded: BEGIN rootDir=${this.options.rootDir}`);
      store = await this.createStore(this.options.rootDir);
      strace("startEmbedded: store.init");
      await store.init();
      strace("startEmbedded: store.watch");
      await store.watch();
      strace("startEmbedded: createDashboardServer()");

      const dashboardServer = await this.createDashboardServer(store, this.options.rootDir);
      cleanup = "server" in dashboardServer ? dashboardServer.cleanup : undefined;
      server = "server" in dashboardServer ? dashboardServer.server : dashboardServer;
      strace("startEmbedded: awaiting server 'listening' | 'error'");
      await Promise.race([
        once(server, "listening"),
        once(server, "error").then(([error]) => {
          throw error;
        }),
      ]);

      const port = getAddressPort(server);
      const baseUrl = `http://127.0.0.1:${port}`;
      this.runtime = { store, server, port, baseUrl, cleanup };
      this.status = { source: "embedded-local", state: "running", port, baseUrl };
      strace(`startEmbedded: RUNNING port=${port}`);
      return this.status;
    } catch (error) {
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
      }
      await cleanup?.();
      if (store) {
        store.close();
      }
      this.runtime = null;
      strace(`startEmbedded: CATCH/ERROR ${error instanceof Error ? error.stack : String(error)}`);
      throw error;
    }
  }

  async stopLocal(): Promise<DesktopRuntimeStatus> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopInternal();
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async stopInternal(): Promise<DesktopRuntimeStatus> {
    if (this.runtime) {
      const runtime = this.runtime;
      this.runtime = null;
      await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
      await runtime.cleanup?.();
      runtime.store.close();
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
