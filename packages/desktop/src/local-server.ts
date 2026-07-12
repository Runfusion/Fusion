import type { AddressInfo } from "node:net";
import { once } from "node:events";
import type { Server } from "node:http";

import { resolveDesktopRuntimePrimaryProject } from "./engine-runtime.js";
import { resolveDesktopBundlePluginDirs } from "./bundled-plugin-dirs.js";
import { resolveDesktopSystemControl } from "./local-runtime.js";

/*
 * FNXC:DesktopRuntime 2026-07-07-12:00:
 * FN-7623: this legacy desktop local server path had the same missing plugin-subsystem wiring as
 * local-runtime.ts — createServer() never received pluginStore/pluginLoader, so Settings -> Plugins
 * Browse registry ("Plugin \"registry\" not found") and plugin install ("Plugin install mode is not
 * supported: plugin loader not available") were both dead in this path too. Keep both desktop server
 * paths consistent (see local-runtime.ts's matching comment).
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
      const { CentralCore, PluginLoader, ensureBundledPluginInstalled, isBundledPluginId } = await import("@fusion/core");
      const { createServer } = await import("@fusion/dashboard");
      const { ProjectEngineManager, createFusionAuthStorage, createFusionModelRegistry, seedDashboardProviders } = await import("@fusion/engine");
      store = new TaskStore(this.rootDir) as TaskStoreLike;
      await store.init();
      await store.watch();
      /*
       * FNXC:DesktopRuntime 2026-06-20-23:39:
       * This legacy desktop local server path still needs to launch project engines so every embedded desktop server follows the same executable-by-default contract.
       */
      const centralCore = new CentralCore();
      const engineManager = new ProjectEngineManager(centralCore);
      const providerSeeding: { dispose?: () => void } = {};
      cleanup = async () => {
        providerSeeding.dispose?.();
        await engineManager.stopAll();
        await centralCore.close?.();
      };
      await centralCore.init();
      // FNXC:DesktopRuntime 2026-07-03-03:30: never auto-register the runtime root as a project (see engine-runtime.ts).
      await engineManager.startAll();
      engineManager.startReconciliation();
      const rootProject = await resolveDesktopRuntimePrimaryProject(centralCore);
      const primaryEngine = rootProject ? await engineManager.ensureEngine(rootProject.id) : undefined;
      /*
       * FNXC:DesktopRuntime 2026-07-07-00:00:
       * FN-7622: this legacy path had the same truncated-provider-list gap as local-runtime.ts — wire
       * auth storage AND run it through the shared seedDashboardProviders() sequence (built-in Zai/
       * API-key seeding, wrapAuthStorageWithApiKeyProviders, registerCustomProviders) so this path
       * surfaces the same provider catalog as the CLI and the embedded runtime path. Pass the WRAPPED
       * authStorage to createServer, not the raw one.
       */
      const authStorage = createFusionAuthStorage();
      const modelRegistry = createFusionModelRegistry(authStorage);
      const { authStorage: wrappedAuthStorage, dispose } = await seedDashboardProviders({
        store: store as never,
        authStorage,
        modelRegistry,
      });
      providerSeeding.dispose = dispose;

      /*
       * FNXC:DesktopRuntime 2026-07-07-12:00:
       * FN-7623: mirror the CLI dashboard command's plugin wiring — construct the store's PluginStore,
       * build a PluginLoader, load enabled plugins, and run schema-init hooks — so this legacy path's
       * registry sub-router mounts and install works too. Fail soft: a broken plugin subsystem must not
       * prevent the embedded dashboard from booting.
       *
       * FNXC:DesktopRuntime 2026-07-07-12:30:
       * FN-7637: mirror local-runtime.ts's bundled-plugin auto-install wiring so BOTH desktop startup
       * paths auto-install bundled runtime plugins (Dependency Graph, Hermes, OpenClaw, Paperclip, …)
       * identically — same shared @fusion/core helper, same resolveDesktopBundlePluginDirs resolver, same
       * lazy-install callback exposed to PUT /api/plugins/:id/settings. See local-runtime.ts's matching
       * comment for the full rationale.
       */
      let pluginStore: PluginStoreLike | undefined;
      let pluginLoader: InstanceType<typeof PluginLoader> | undefined;
      let ensureBundledPluginInstalledCallback: ((pluginId: string) => Promise<boolean>) | undefined;
      try {
        pluginStore = store.getPluginStore();
        await pluginStore.init();
        pluginLoader = new PluginLoader({ pluginStore: pluginStore as never, taskStore: store as never });

        const boundPluginStore = pluginStore;
        const boundPluginLoader = pluginLoader;

        try {
          await ensureBundledPluginInstalled(
            boundPluginStore as never,
            boundPluginLoader,
            "fusion-plugin-dependency-graph",
            resolveDesktopBundlePluginDirs,
          );
        } catch {
          // Bundled dependency-graph auto-install failure must not block startup (FN-7637, mirrors FN-7623 fail-soft).
        }

        await pluginLoader.loadAllPlugins();
        const schemaHooks = pluginLoader.getPluginSchemaInitHooks();
        if (schemaHooks.length > 0) {
          await store.getDatabase().runPluginSchemaInits(schemaHooks);
        }

        ensureBundledPluginInstalledCallback = async (pluginId: string): Promise<boolean> => {
          if (!isBundledPluginId(pluginId)) {
            return false;
          }
          const status = await ensureBundledPluginInstalled(boundPluginStore as never, boundPluginLoader, pluginId, resolveDesktopBundlePluginDirs);
          return status !== "missing-bundle";
        };
      } catch {
        // Plugin subsystem failures must not block embedded dashboard startup (FN-7623).
        pluginStore = undefined;
        pluginLoader = undefined;
        ensureBundledPluginInstalledCallback = undefined;
      }

      const app = createServer(store as never, {
        ...(primaryEngine ? { engine: primaryEngine } : {}),
        engineManager,
        centralCore,
        authStorage: wrappedAuthStorage,
        modelRegistry,
        ...(pluginStore && pluginLoader ? { pluginStore: pluginStore as never, pluginLoader, pluginRunner: pluginLoader } : {}),
        ...(ensureBundledPluginInstalledCallback ? { ensureBundledPluginInstalled: ensureBundledPluginInstalledCallback } : {}),
        onProjectFirstAccessed: (projectId: string) => engineManager.onProjectAccessed(projectId),
        // FNXC:SystemPanel 2026-07-12-14:20: System panel restart via Electron
        // app.relaunch(); see resolveDesktopSystemControl in local-runtime.ts.
        ...(await resolveDesktopSystemControl()),
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
