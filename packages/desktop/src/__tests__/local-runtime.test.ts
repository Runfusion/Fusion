import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Server } from "node:http";

class FakeServer {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(private readonly port: number) {}

  on(event: string, handler: (...args: unknown[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    current.push(handler);
    this.listeners.set(event, current);
    return this;
  }

  once(event: string, handler: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]) => {
      this.removeListener(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  removeListener(event: string, handler: (...args: unknown[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    this.listeners.set(event, current.filter((item) => item !== handler));
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(...args);
    }
  }

  address() {
    return { port: this.port };
  }

  close(callback: () => void): void {
    callback();
  }
}

/*
 * FN-7622 symptom-verification mocks for createDashboardServerDefault (the real default
 * createDashboardServer implementation, exercised only when a test does NOT override
 * `createDashboardServer` in LocalRuntimeManagerOptions). Mirrors local-server.test.ts's pattern.
 */
const engineMocks = vi.hoisted(() => {
  // FN-7623: pluginStore/pluginLoader mocks proving createDashboardServerDefault wires the plugin
  // subsystem into createServer (fixes desktop's "Plugin install mode is not supported" and Browse
  // registry "Plugin \"registry\" not found" symptoms).
  const pluginStoreInstance = { init: vi.fn(async () => undefined) };
  const pluginLoaderInstance = {
    loadAllPlugins: vi.fn(async () => ({ loaded: 2, errors: 0 })),
    getPluginSchemaInitHooks: vi.fn(() => []),
  };
  const runPluginSchemaInits = vi.fn(async () => undefined);
  const PluginLoader = vi.fn(function () {
    return pluginLoaderInstance;
  });

  const centralCore = {
    init: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    listProjects: vi.fn(async () => [] as Array<{ id: string; name: string; path: string; status: string }>),
  };
  const engineManager = {
    startAll: vi.fn(async () => undefined),
    startReconciliation: vi.fn(),
    stopAll: vi.fn(async () => undefined),
    ensureEngine: vi.fn(async () => ({ id: "engine-1" })),
    onProjectAccessed: vi.fn(),
  };
  const CentralCore = vi.fn(function () {
    return centralCore;
  });
  const ProjectEngineManager = vi.fn(function () {
    return engineManager;
  });
  const seedDashboardProvidersDispose = vi.fn();
  const seedDashboardProviders = vi.fn(async ({ authStorage }: { authStorage: unknown }) => ({
    authStorage: { ...(authStorage as object), __wrapped: true },
    dispose: seedDashboardProvidersDispose,
  }));
  const createServer = vi.fn(() => ({ listen: vi.fn() }));

  // FN-7637: bundled-plugin auto-install mocks proving createDashboardServerDefault wires
  // ensureBundledPluginInstalled/isBundledPluginId from @fusion/core into both the startup
  // auto-install pass (Dependency Graph before loadAllPlugins) and the createServer(...)
  // callback option consumed by PUT /api/plugins/:id/settings.
  const ensureBundledPluginInstalled = vi.fn(async () => "installed" as const);
  const isBundledPluginId = vi.fn((id: string) => id.startsWith("fusion-plugin-"));
  const resolveDesktopBundlePluginDirs = vi.fn((pluginId: string) => [`/desktop/node_modules/@fusion-plugin-examples/${pluginId.replace(/^fusion-plugin-/, "")}`]);

  return {
    centralCore,
    engineManager,
    CentralCore,
    PluginLoader,
    ProjectEngineManager,
    seedDashboardProviders,
    seedDashboardProvidersDispose,
    createServer,
    pluginStoreInstance,
    pluginLoaderInstance,
    runPluginSchemaInits,
    ensureBundledPluginInstalled,
    isBundledPluginId,
    resolveDesktopBundlePluginDirs,
  };
});

vi.mock("@fusion/core", () => ({
  CentralCore: engineMocks.CentralCore,
  PluginLoader: engineMocks.PluginLoader,
  ensureBundledPluginInstalled: engineMocks.ensureBundledPluginInstalled,
  isBundledPluginId: engineMocks.isBundledPluginId,
}));
vi.mock("../bundled-plugin-dirs.js", () => ({ resolveDesktopBundlePluginDirs: engineMocks.resolveDesktopBundlePluginDirs }));
vi.mock("@fusion/dashboard", () => ({ createServer: engineMocks.createServer }));
vi.mock("@fusion/engine", () => ({
  ProjectEngineManager: engineMocks.ProjectEngineManager,
  createFusionAuthStorage: () => ({ reload: () => undefined, getOAuthProviders: () => [], hasAuth: () => false }),
  createFusionModelRegistry: () => ({ listModels: () => [], refresh: () => undefined }),
  seedDashboardProviders: engineMocks.seedDashboardProviders,
}));

describe("LocalRuntimeManager", () => {
  const store = {
    init: vi.fn(async () => undefined),
    watch: vi.fn(async () => undefined),
    close: vi.fn(),
    getPluginStore: vi.fn(() => engineMocks.pluginStoreInstance),
    runPluginSchemaInits: engineMocks.runPluginSchemaInits,
    getAsyncLayer: vi.fn(() => ({ projectId: "project-1" } as never)),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts embedded local runtime and reports status", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      },
    });

    const status = await manager.startLocal();

    expect(store.init).toHaveBeenCalledTimes(1);
    expect(store.watch).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      source: "embedded-local",
      state: "running",
      port: 4545,
      baseUrl: "http://127.0.0.1:4545",
    });
    expect(manager.getServerPort()).toBe(4545);
  });

  it("returns external-cli status without starting embedded runtime", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      getExternalPort: () => 7777,
      createStore: async () => store,
      createDashboardServer: async () => new FakeServer(4545) as unknown as Server,
    });

    const status = await manager.startLocal();

    expect(status).toMatchObject({
      source: "external-cli",
      state: "running",
      port: 7777,
      baseUrl: "http://127.0.0.1:7777",
    });
    expect(store.init).not.toHaveBeenCalled();
  });

  it("rolls back and exposes error status when startup fails (single attempt, no retry)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    store.init.mockRejectedValueOnce(new Error("init failed"));
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      // Pin to a single attempt — this test asserts pre-retry single-attempt rollback
      // semantics; the multi-attempt self-heal/persistent-failure behavior is covered below.
      startupRetries: 1,
    });

    await expect(manager.startLocal()).rejects.toThrow("init failed");
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toMatchObject({
      source: "embedded-local",
      state: "error",
      error: "init failed",
    });
  });

  it("surfaces dashboard import failures instead of replacing them with a generic timeout", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const importError = new TypeError("ERR_IMPORT_ATTRIBUTE_MISSING: registry-manifest.json requires an import attribute");
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        throw importError;
      },
      // Isolate the message-preservation assertion from retry mechanics (covered separately below).
      startupRetries: 1,
      startupRetryDelayMs: 0,
    });

    await expect(manager.startLocal()).rejects.toThrow("ERR_IMPORT_ATTRIBUTE_MISSING");
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toMatchObject({
      source: "embedded-local",
      state: "error",
      error: "ERR_IMPORT_ATTRIBUTE_MISSING: registry-manifest.json requires an import attribute",
    });
  });

  it("self-heals a transient store.init failure on attempt 1 (createStore path)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    store.init.mockRejectedValueOnce(new Error("transient windows init failure"));
    const server = new FakeServer(4545);
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      },
      startupRetries: 3,
      startupRetryDelayMs: 0,
    });

    const status = await manager.startLocal();

    expect(status).toMatchObject({ source: "embedded-local", state: "running", port: 4545 });
    expect(manager.getStatus().state).toBe("running");
    expect(store.init).toHaveBeenCalledTimes(2);
  });

  it("self-heals a transient createDashboardServer failure on attempt 1", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    let calls = 0;
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("transient dashboard server boot failure");
        }
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      },
      startupRetries: 3,
      startupRetryDelayMs: 0,
    });

    const status = await manager.startLocal();

    expect(status).toMatchObject({ source: "embedded-local", state: "running", port: 4545 });
    expect(calls).toBe(2);
  });

  it("exhausts retries and surfaces the final real error when every attempt fails", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const errors = [new Error("attempt 1 failed"), new Error("attempt 2 failed"), new Error("attempt 3 failed — real cause")];
    let calls = 0;
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        const error = errors[calls];
        calls += 1;
        throw error;
      },
      startupRetries: 3,
      startupRetryDelayMs: 0,
    });

    await expect(manager.startLocal()).rejects.toThrow("attempt 3 failed — real cause");
    expect(calls).toBe(3);
    expect(manager.getStatus()).toMatchObject({
      source: "embedded-local",
      state: "error",
      error: "attempt 3 failed — real cause",
    });
  });

  it("fully cleans up store/server/cleanup between a failed attempt and the retry that follows", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const cleanupFns: Array<ReturnType<typeof vi.fn>> = [];
    const servers: FakeServer[] = [];
    let calls = 0;
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        calls += 1;
        const cleanup = vi.fn(async () => undefined);
        cleanupFns.push(cleanup);
        if (calls === 1) {
          const failingServer = new FakeServer(0);
          servers.push(failingServer);
          setTimeout(() => failingServer.emit("error", new Error("transient listen error")), 0);
          return { server: failingServer as unknown as Server, cleanup };
        }
        const server = new FakeServer(4545);
        servers.push(server);
        setTimeout(() => server.emit("listening"), 0);
        return { server: server as unknown as Server, cleanup };
      },
      startupRetries: 3,
      startupRetryDelayMs: 0,
    });

    const closeSpies = servers.map(() => vi.fn());

    const status = await manager.startLocal();

    expect(status.state).toBe("running");
    expect(cleanupFns[0]).toHaveBeenCalledTimes(1);
    expect(cleanupFns[1]).toHaveBeenCalledTimes(0);
    expect(store.close).toHaveBeenCalledTimes(1); // only the failed attempt's store was closed
    void closeSpies;
  });

  it("does not retry the external-cli branch", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const createStore = vi.fn(async () => store);
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      getExternalPort: () => 7777,
      createStore,
      createDashboardServer: async () => new FakeServer(4545) as unknown as Server,
      startupRetries: 3,
      startupRetryDelayMs: 0,
    });

    const status = await manager.startLocal();

    expect(status).toMatchObject({ source: "external-cli", state: "running", port: 7777 });
    expect(createStore).not.toHaveBeenCalled();
  });

  it("does not retry the already-running branch", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    const createStore = vi.fn(async () => store);
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore,
      createDashboardServer: async () => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      },
      startupRetries: 3,
      startupRetryDelayMs: 0,
    });

    await manager.startLocal();
    const secondStatus = await manager.startLocal();

    expect(secondStatus).toMatchObject({ source: "embedded-local", state: "running", port: 4545 });
    expect(createStore).toHaveBeenCalledTimes(1);
  });

  it("stopLocal is idempotent and no-op when inactive", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    const closeSpy = vi.spyOn(server, "close");
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      },
    });

    await manager.startLocal();
    await manager.stopLocal();
    await manager.stopLocal();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toEqual({ source: "none", state: "stopped" });
  });

  it("runs embedded runtime cleanup on stop", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    const cleanup = vi.fn(async () => undefined);
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        setTimeout(() => server.emit("listening"), 0);
        return { server: server as unknown as Server, cleanup };
      },
    });

    await manager.startLocal();
    await manager.stopLocal();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("startLocal while already running returns current status", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      },
    });

    const first = await manager.startLocal();
    const second = await manager.startLocal();

    expect(first).toEqual(second);
    expect(store.init).toHaveBeenCalledTimes(1);
  });

  /*
   * FN-7622 symptom verification: before this fix, createDashboardServerDefault (the embedded
   * in-process server path) constructed a RAW authStorage/modelRegistry and passed the raw
   * authStorage straight to createServer, never running the built-in/API-key/custom-provider
   * registration sequence the CLI serve/dashboard/daemon commands run — so desktop's
   * /api/providers and /api/models exposed a truncated catalog vs. the identical web-build config.
   * This test exercises the REAL default createDashboardServer (no createDashboardServer override)
   * and asserts it now routes through seedDashboardProviders and hands createServer the WRAPPED
   * auth storage, matching the CLI-equivalent catalog seedDashboardProviders produces (see
   * packages/engine/src/__tests__/provider-registration.test.ts for the underlying catalog
   * assertions across customProviders undefined/[]/one/multiple).
   */
  it("createDashboardServerDefault seeds providers and passes the WRAPPED auth storage to createServer (FN-7622)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    engineMocks.createServer.mockReturnValueOnce({
      listen: vi.fn(() => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      }),
    });

    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      // No createDashboardServer override: exercises the real createDashboardServerDefault.
    });

    await manager.startLocal();

    expect(engineMocks.CentralCore).toHaveBeenCalledWith(undefined, { asyncLayer: store.getAsyncLayer() });

    expect(engineMocks.seedDashboardProviders).toHaveBeenCalledWith(
      expect.objectContaining({ authStorage: expect.anything(), modelRegistry: expect.anything() }),
    );
    expect(engineMocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authStorage: expect.objectContaining({ __wrapped: true }) }),
    );

    await manager.stopLocal();
    expect(engineMocks.seedDashboardProvidersDispose).toHaveBeenCalledTimes(1);
  });

  /*
   * FN-7623 symptom verification: before this fix, createDashboardServerDefault called createServer
   * WITHOUT pluginStore/pluginLoader, so desktop's Browse-registry sub-router never mounted ("Plugin
   * \"registry\" not found") and plugin install threw "Plugin install mode is not supported: plugin
   * loader not available". Assert the fix in the engine-less (zero-projects) startup state — the
   * plugin subsystem must wire in regardless of whether a primary engine resolved.
   */
  it("wires PluginStore + PluginLoader into createServer when engine-less (zero projects) (FN-7623)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    engineMocks.createServer.mockReturnValueOnce({
      listen: vi.fn(() => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      }),
    });
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
    });

    await manager.startLocal();

    expect(store.getPluginStore).toHaveBeenCalledTimes(1);
    expect(engineMocks.pluginStoreInstance.init).toHaveBeenCalledTimes(1);
    expect(engineMocks.PluginLoader).toHaveBeenCalledWith(
      expect.objectContaining({ pluginStore: engineMocks.pluginStoreInstance, taskStore: expect.anything() }),
    );
    expect(engineMocks.pluginLoaderInstance.loadAllPlugins).toHaveBeenCalledTimes(1);
    /* FNXC:DesktopPluginSchema 2026-07-14-23:31: The host verifies single schema ownership by leaving execution to PluginLoader instead of replaying collected contracts. */
    expect(engineMocks.runPluginSchemaInits).not.toHaveBeenCalled();
    expect(engineMocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pluginStore: engineMocks.pluginStoreInstance,
        pluginLoader: engineMocks.pluginLoaderInstance,
        pluginRunner: engineMocks.pluginLoaderInstance,
      }),
    );

    await manager.stopLocal();
  });

  it("wires PluginStore + PluginLoader into createServer when a project engine resolved (projects-present) (FN-7623)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    engineMocks.centralCore.listProjects.mockResolvedValueOnce([
      { id: "project-1", name: "Repo", path: "/repo", status: "active" },
    ]);
    const server = new FakeServer(4545);
    engineMocks.createServer.mockReturnValueOnce({
      listen: vi.fn(() => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      }),
    });

    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
    });

    await manager.startLocal();

    expect(engineMocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        engine: expect.anything(),
        pluginStore: engineMocks.pluginStoreInstance,
        pluginLoader: engineMocks.pluginLoaderInstance,
        pluginRunner: engineMocks.pluginLoaderInstance,
      }),
    );

    await manager.stopLocal();
  });

  it("boots the dashboard without plugin wiring when the plugin subsystem fails to init (fail-soft) (FN-7623)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    engineMocks.pluginStoreInstance.init.mockRejectedValueOnce(new Error("plugin db locked"));
    const server = new FakeServer(4545);
    engineMocks.createServer.mockReturnValueOnce({
      listen: vi.fn(() => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      }),
    });

    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
    });

    const status = await manager.startLocal();

    expect(status).toMatchObject({ source: "embedded-local", state: "running", port: 4545 });
    expect(engineMocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ pluginStore: expect.anything() }),
    );

    await manager.stopLocal();
  });

  /*
   * FN-7637 symptom verification: before this fix, createDashboardServerDefault never invoked
   * ensureBundledPluginInstalled and never passed an ensureBundledPluginInstalled callback into
   * createServer(...), so bundled runtime plugins (Dependency Graph, Hermes, OpenClaw, Paperclip, …)
   * were never auto-installed on desktop the way the CLI dashboard command auto-installs them.
   * Assert the fix holds in BOTH the engine-less (zero-projects) and projects-present startup
   * states, since auto-install must run independent of whether a primary engine resolved.
   */
  it("auto-installs the bundled Dependency Graph plugin and wires ensureBundledPluginInstalled into createServer when engine-less (zero projects) (FN-7637)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    engineMocks.createServer.mockReturnValueOnce({
      listen: vi.fn(() => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      }),
    });

    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
    });

    await manager.startLocal();

    expect(engineMocks.ensureBundledPluginInstalled).toHaveBeenCalledWith(
      engineMocks.pluginStoreInstance,
      engineMocks.pluginLoaderInstance,
      "fusion-plugin-dependency-graph",
      engineMocks.resolveDesktopBundlePluginDirs,
    );
    expect(engineMocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ensureBundledPluginInstalled: expect.any(Function) }),
    );

    await manager.stopLocal();
  });

  it("auto-installs the bundled Dependency Graph plugin and wires ensureBundledPluginInstalled into createServer when a project engine resolved (projects-present) (FN-7637)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    engineMocks.centralCore.listProjects.mockResolvedValueOnce([
      { id: "project-1", name: "Repo", path: "/repo", status: "active" },
    ]);
    const server = new FakeServer(4545);
    engineMocks.createServer.mockReturnValueOnce({
      listen: vi.fn(() => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      }),
    });

    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
    });

    await manager.startLocal();

    expect(engineMocks.ensureBundledPluginInstalled).toHaveBeenCalledWith(
      engineMocks.pluginStoreInstance,
      engineMocks.pluginLoaderInstance,
      "fusion-plugin-dependency-graph",
      engineMocks.resolveDesktopBundlePluginDirs,
    );
    expect(engineMocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        engine: expect.anything(),
        ensureBundledPluginInstalled: expect.any(Function),
      }),
    );

    await manager.stopLocal();
  });

  it("the wired ensureBundledPluginInstalled callback delegates to the shared helper for a lazy-install id (FN-7637)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    engineMocks.createServer.mockReturnValueOnce({
      listen: vi.fn(() => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      }),
    });

    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
    });

    await manager.startLocal();

    const callOptions = engineMocks.createServer.mock.calls[0]?.[1] as { ensureBundledPluginInstalled: (id: string) => Promise<boolean> };
    engineMocks.ensureBundledPluginInstalled.mockClear();
    engineMocks.ensureBundledPluginInstalled.mockResolvedValueOnce("installed");

    const result = await callOptions.ensureBundledPluginInstalled("fusion-plugin-hermes-runtime");

    expect(result).toBe(true);
    expect(engineMocks.ensureBundledPluginInstalled).toHaveBeenCalledWith(
      engineMocks.pluginStoreInstance,
      engineMocks.pluginLoaderInstance,
      "fusion-plugin-hermes-runtime",
      engineMocks.resolveDesktopBundlePluginDirs,
    );

    await manager.stopLocal();
  });

  it("the wired ensureBundledPluginInstalled callback returns false for a missing bundle (FN-7637)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    engineMocks.createServer.mockReturnValueOnce({
      listen: vi.fn(() => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      }),
    });

    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
    });

    await manager.startLocal();

    const callOptions = engineMocks.createServer.mock.calls[0]?.[1] as { ensureBundledPluginInstalled: (id: string) => Promise<boolean> };
    engineMocks.ensureBundledPluginInstalled.mockResolvedValueOnce("missing-bundle");

    const result = await callOptions.ensureBundledPluginInstalled("fusion-plugin-reports");

    expect(result).toBe(false);

    await manager.stopLocal();
  });

  it("does not wire ensureBundledPluginInstalled into createServer when the plugin subsystem fails to init (fail-soft) (FN-7637)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    engineMocks.pluginStoreInstance.init.mockRejectedValueOnce(new Error("plugin db locked"));
    const server = new FakeServer(4545);
    engineMocks.createServer.mockReturnValueOnce({
      listen: vi.fn(() => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      }),
    });

    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
    });

    const status = await manager.startLocal();

    expect(status).toMatchObject({ source: "embedded-local", state: "running", port: 4545 });
    expect(engineMocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ ensureBundledPluginInstalled: expect.anything() }),
    );

    await manager.stopLocal();
  });
});
