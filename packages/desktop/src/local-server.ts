import type { AddressInfo } from "node:net";
import { once } from "node:events";
import type { Server } from "node:http";

import { ensureDesktopRuntimeProject } from "./engine-runtime.js";

type TaskStoreLike = {
  init(): Promise<void>;
  watch(): Promise<void>;
  close(): void;
};

type RuntimeCleanup = () => Promise<void> | void;

export interface DesktopLocalRuntime {
  store: TaskStoreLike;
  server: Server;
  port: number;
  cleanup?: RuntimeCleanup;
}

export interface DesktopLocalServerState {
  status: "idle" | "starting" | "ready" | "error";
  port?: number;
  error?: string | null;
}

export class DesktopLocalServerManager {
  private runtime: DesktopLocalRuntime | null = null;
  private state: DesktopLocalServerState = { status: "idle", error: null };

  constructor(private readonly rootDir: string) {}

  getState(): DesktopLocalServerState {
    return this.state;
  }

  getPort(): number | undefined {
    return this.runtime?.port;
  }

  async start(): Promise<DesktopLocalRuntime> {
    if (this.runtime) {
      this.state = { status: "ready", port: this.runtime.port, error: null };
      return this.runtime;
    }

    this.state = { status: "starting", error: null };

    let store: TaskStoreLike | null = null;
    let server: Server | null = null;
    let cleanup: RuntimeCleanup | undefined;

    try {
      const { TaskStore, createTaskStoreForBackend } = await import("@fusion/core");
      const { CentralCore } = await import("@fusion/core");
      const { createServer } = await import("@fusion/dashboard");
      const { ProjectEngineManager } = await import("@fusion/engine");
      // FNXC:BackendFlip 2026-06-26-14:40:
      // Consult the startup factory to boot a PostgreSQL-backed TaskStore.
      // Post default-flip: the factory boots embedded PG by default when
      // DATABASE_URL is unset, external PG when DATABASE_URL is set, and
      // returns null only when the operator opted out via
      // FUSION_NO_EMBEDDED_PG=1 (legacy SQLite path).
      const backendBoot = await createTaskStoreForBackend({ rootDir: this.rootDir });
      if (backendBoot) {
        store = backendBoot.taskStore as unknown as TaskStoreLike;
        (store as TaskStoreLike & { __backendShutdown?: () => Promise<void> }).__backendShutdown =
          backendBoot.shutdown;
      } else {
        store = new TaskStore(this.rootDir) as TaskStoreLike;
      }
      await store.init();
      await store.watch();
      /*
       * FNXC:DesktopRuntime 2026-06-20-23:39:
       * This legacy desktop local server path still needs to launch project engines so every embedded desktop server follows the same executable-by-default contract.
       */
      const centralCore = new CentralCore();
      const engineManager = new ProjectEngineManager(centralCore);
      cleanup = async () => {
        await engineManager.stopAll();
        await centralCore.close?.();
      };
      await centralCore.init();
      const rootProject = await ensureDesktopRuntimeProject(centralCore, this.rootDir);
      await engineManager.startAll();
      engineManager.startReconciliation();
      const primaryEngine = await engineManager.ensureEngine(rootProject.id);
      const app = createServer(store as never, {
        engine: primaryEngine,
        engineManager,
        centralCore,
        onProjectFirstAccessed: (projectId: string) => engineManager.onProjectAccessed(projectId),
      });
      server = app.listen(0);

      await Promise.race([
        once(server, "listening"),
        once(server, "error").then(([error]) => {
          throw error;
        }),
      ]);

      const address = server.address() as AddressInfo | null;
      if (!address?.port) {
        throw new Error("Failed to resolve local server port");
      }

      this.runtime = { store, server, port: address.port, cleanup };
      this.state = { status: "ready", port: address.port, error: null };
      return this.runtime;
    } catch (error) {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await cleanup?.();
      store?.close();
      this.state = {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.runtime) {
      this.state = { status: "idle", error: null };
      return;
    }

    const runtime = this.runtime;
    this.runtime = null;

    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    await runtime.cleanup?.();
    runtime.store.close();
    // FNXC:RuntimeStartupWiring 2026-06-24-10:35:
    // Release the backend connection pool / embedded PG cluster if the store
    // was booted via the startup factory. store.close() already closes the
    // AsyncDataLayer pool; this adds embedded-cluster teardown. Best-effort.
    const backendShutdown = (runtime.store as TaskStoreLike & { __backendShutdown?: () => Promise<void> }).__backendShutdown;
    if (backendShutdown) {
      await backendShutdown().catch(() => undefined);
    }
    this.state = { status: "idle", error: null };
  }
}
