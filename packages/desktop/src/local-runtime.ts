import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { ensureDesktopRuntimeProject } from "./engine-runtime.js";

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
  // FNXC:BackendFlip 2026-06-26-14:40:
  // Consult the startup factory to boot a PostgreSQL-backed TaskStore. Post
  // default-flip: the factory boots embedded PG by default when DATABASE_URL
  // is unset, external PG when DATABASE_URL is set, and returns null only
  // when the operator opted out via FUSION_NO_EMBEDDED_PG=1 (legacy SQLite
  // path). The backend shutdown handle is stashed on the returned object so
  // the runtime manager's stop path can release the pool / stop an embedded
  // cluster.
  const { TaskStore, createTaskStoreForBackend } = await import("@fusion/core");
  const backendBoot = await createTaskStoreForBackend({ rootDir });
  if (backendBoot) {
    const store = backendBoot.taskStore as unknown as TaskStoreLike;
    // Attach the backend shutdown so LocalRuntimeManager can invoke it on stop.
    (store as TaskStoreLike & { __backendShutdown?: () => Promise<void> }).__backendShutdown =
      backendBoot.shutdown;
    return store;
  }
  return new TaskStore(rootDir) as TaskStoreLike;
}

async function createDashboardServerDefault(store: TaskStoreLike, rootDir: string): Promise<{ server: Server; cleanup: RuntimeCleanup }> {
  const { CentralCore } = await import("@fusion/core");
  const { createServer } = await import("@fusion/dashboard");
  const { ProjectEngineManager } = await import("@fusion/engine");

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
    await centralCore.init();
    const rootProject = await ensureDesktopRuntimeProject(centralCore, rootDir);
    await engineManager.startAll();
    engineManager.startReconciliation();
    const primaryEngine = await engineManager.ensureEngine(rootProject.id);
    const app = createServer(store as never, {
      engine: primaryEngine,
      engineManager,
      centralCore,
      onProjectFirstAccessed: (projectId: string) => engineManager.onProjectAccessed(projectId),
    });

    return {
      server: app.listen(0),
      cleanup,
    };
  } catch (error) {
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
    const externalPort = this.getExternalPort();
    if (externalPort) {
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
      store = await this.createStore(this.options.rootDir);
      await store.init();
      await store.watch();

      const dashboardServer = await this.createDashboardServer(store, this.options.rootDir);
      cleanup = "server" in dashboardServer ? dashboardServer.cleanup : undefined;
      server = "server" in dashboardServer ? dashboardServer.server : dashboardServer;
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
      // FNXC:RuntimeStartupWiring 2026-06-24-10:30:
      // Release the backend connection pool / embedded PG cluster if the store
      // was booted via the startup factory. store.close() already closes the
      // AsyncDataLayer pool; this adds embedded-cluster teardown. Best-effort.
      const backendShutdown = (runtime.store as TaskStoreLike & { __backendShutdown?: () => Promise<void> }).__backendShutdown;
      if (backendShutdown) {
        await backendShutdown().catch(() => undefined);
      }
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
