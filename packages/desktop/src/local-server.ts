import type { AddressInfo } from "node:net";
import { once } from "node:events";
import type { Server } from "node:http";

import { resolveDesktopRuntimePrimaryProject } from "./engine-runtime.js";

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
      const { TaskStore } = await import("@fusion/core");
      const { CentralCore } = await import("@fusion/core");
      const { createServer } = await import("@fusion/dashboard");
      const { ProjectEngineManager, createFusionAuthStorage, createFusionModelRegistry } = await import("@fusion/engine");
      store = new TaskStore(this.rootDir) as TaskStoreLike;
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
      // FNXC:DesktopRuntime 2026-07-03-03:30: never auto-register the runtime root as a project (see engine-runtime.ts).
      await engineManager.startAll();
      engineManager.startReconciliation();
      const rootProject = await resolveDesktopRuntimePrimaryProject(centralCore);
      const primaryEngine = rootProject ? await engineManager.ensureEngine(rootProject.id) : undefined;
      // FNXC:DesktopRuntime 2026-07-03-06:20: wire auth storage so /api/auth/status works and first-run onboarding can open (see local-runtime.ts).
      const authStorage = createFusionAuthStorage();
      const modelRegistry = createFusionModelRegistry(authStorage);
      const app = createServer(store as never, {
        ...(primaryEngine ? { engine: primaryEngine } : {}),
        engineManager,
        centralCore,
        authStorage,
        modelRegistry,
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
    this.state = { status: "idle", error: null };
  }
}
