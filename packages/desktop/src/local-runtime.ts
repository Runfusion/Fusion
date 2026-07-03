import { once } from "node:events";
import { appendFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { resolveDesktopRuntimePrimaryProject } from "./engine-runtime.js";

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

type TaskStoreLike = {
  init(): Promise<void>;
  watch(): Promise<void>;
  close(): void;
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
}

async function createStoreDefault(rootDir: string): Promise<TaskStoreLike> {
  const { TaskStore } = await import("@fusion/core");
  return new TaskStore(rootDir) as TaskStoreLike;
}

async function createDashboardServerDefault(store: TaskStoreLike, rootDir: string): Promise<{ server: Server; cleanup: RuntimeCleanup }> {
  const { CentralCore } = await import("@fusion/core");
  const { createServer } = await import("@fusion/dashboard");
  const { ProjectEngineManager, createFusionAuthStorage, createFusionModelRegistry } = await import("@fusion/engine");

  /*
   * FNXC:DesktopRuntime 2026-06-20-23:39:
   * Embedded desktop local mode should be an executable Fusion node, not a dashboard-only shell. Start all registered project engines and pass the manager to the API server so project-scoped routes can start newly accessed engines.
   */
  const centralCore = new CentralCore();
  const engineManager = new ProjectEngineManager(centralCore);
  const cleanup = async () => {
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
     * FNXC:DesktopRuntime 2026-07-03-06:20:
     * Wire an auth storage into the embedded server. Without it, GET /api/auth/status throws 500
     * "Authentication is not configured", the dashboard's first-run onboarding hook (useAuthOnboarding
     * -> fetchAuthStatus) hits its silent catch and NEVER opens the AI/GitHub onboarding wizard, and
     * providers can't be authenticated at all. The CLI wires the same storage (createFusionAuthStorage);
     * the desktop must too so operators can set up AI accounts. (API-key provider wrapping remains
     * CLI-only for now; OAuth + CLI providers are available here.)
     */
    const authStorage = createFusionAuthStorage();
    // FNXC:DesktopRuntime 2026-07-03-07:00: a ModelRegistry is required for the /api/models endpoint;
    // without it the onboarding model picker shows "no models" even with a provider connected.
    const modelRegistry = createFusionModelRegistry(authStorage);
    strace("createDashboardServer: createServer");
    const app = createServer(store as never, {
      ...(primaryEngine ? { engine: primaryEngine } : {}),
      engineManager,
      centralCore,
      authStorage,
      modelRegistry,
      onProjectFirstAccessed: (projectId: string) => engineManager.onProjectAccessed(projectId),
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

  constructor(private readonly options: LocalRuntimeManagerOptions) {
    this.getExternalPort = options.getExternalPort ?? (() => parsePort(process.env.FUSION_SERVER_PORT));
    this.createStore = options.createStore ?? createStoreDefault;
    this.createDashboardServer = options.createDashboardServer ?? createDashboardServerDefault;
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

  private async startEmbedded(): Promise<DesktopRuntimeStatus> {
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
      this.status = {
        source: "embedded-local",
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      };
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
