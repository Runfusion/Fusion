import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";

/*
FNXC:DesktopHostAuth 2026-08-09-03:04:
Regression suite for the desktop host's unauthenticated LAN-exposed API.

Original symptom: BOTH desktop server entrypoints called `createServer(store, {...})` with no
`daemon` token and no `noAuth`, then `app.listen(0)` with NO host argument. `listen(0)` without a
host binds 0.0.0.0/::, so the entire `/api/*` surface — including the shell-capable terminal
WebSocket at `/api/terminal/ws` — was reachable from the LAN by anyone, with no credential.

The invariant, asserted across BOTH surfaces (local-runtime.ts's embedded runtime AND the legacy
local-server.ts manager) rather than only the one that ships today:
  1. createServer receives `daemon.token` in the daemon token format (`fn_<32 hex>`).
  2. listen is called with the ephemeral port AND the loopback host "127.0.0.1".
  3. `noAuth` is never set — the desktop host must not opt out of the gate.
Plus the load-bearing propagation half: the embedded runtime publishes that same token on its
status (`localRuntime.authToken`), which is the channel DesktopLaunchGate reads to append `?token=`
when it navigates the renderer to the runtime origin. Without it the desktop app authenticates
against nothing and is unusable.
*/

const DAEMON_TOKEN_SHAPE = /^fn_[0-9a-f]{32}$/;

const mocks = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  class SimpleEmitter {
    private listeners = new Map<string, Handler[]>();
    on(event: string, handler: Handler) {
      const current = this.listeners.get(event) ?? [];
      current.push(handler);
      this.listeners.set(event, current);
      return this;
    }
    once(event: string, handler: Handler) {
      const wrapped: Handler = (...args) => {
        this.removeListener(event, wrapped);
        handler(...args);
      };
      return this.on(event, wrapped);
    }
    removeListener(event: string, handler: Handler) {
      const current = this.listeners.get(event) ?? [];
      this.listeners.set(event, current.filter((item) => item !== handler));
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.listeners.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  const pluginStoreInstance = { init: vi.fn(async () => undefined) };
  const pluginLoaderInstance = {
    loadAllPlugins: vi.fn(async () => ({ loaded: 0, errors: 0 })),
    getPluginSchemaInitHooks: vi.fn(() => []),
  };
  const PluginLoader = vi.fn(function () {
    return pluginLoaderInstance;
  });

  const store = {
    init: vi.fn(async () => undefined),
    watch: vi.fn(async () => undefined),
    close: vi.fn(),
    getPluginStore: vi.fn(() => pluginStoreInstance),
    runPluginSchemaInits: vi.fn(async () => undefined),
    getAsyncLayer: vi.fn(() => ({ projectId: "project-1" } as never)),
  };

  class TaskStore {
    constructor(_rootDir: string) {}
    init = store.init;
    watch = store.watch;
    close = store.close;
    getPluginStore = store.getPluginStore;
    getAsyncLayer = store.getAsyncLayer;
  }

  const centralCore = {
    init: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    getProjectByPath: vi.fn(async () => ({ id: "project-1", name: "Repo", path: "/repo", status: "active" })),
    listProjects: vi.fn(async () => [{ id: "project-1", name: "Repo", path: "/repo", status: "active" }]),
    registerProject: vi.fn(async ({ path, name }: { path: string; name: string }) => ({ id: "project-1", name, path, status: "initializing" })),
    updateProject: vi.fn(async (id: string) => ({ id, name: "Repo", path: "/repo", status: "active" })),
  };
  const engine = { id: "engine-1" };
  const engineManager = {
    startAll: vi.fn(async () => undefined),
    startReconciliation: vi.fn(),
    stopAll: vi.fn(async () => undefined),
    getAllEngines: vi.fn(() => new Map([["project-1", engine]])),
    ensureEngine: vi.fn(async () => engine),
    onProjectAccessed: vi.fn(),
  };
  const CentralCore = vi.fn(function () {
    return centralCore;
  });
  const ProjectEngineManager = vi.fn(function () {
    return engineManager;
  });

  const server = Object.assign(new SimpleEmitter(), {
    address: vi.fn(() => ({ port: 4545 })),
    close: vi.fn((cb: () => void) => cb()),
  });
  /*
  `setTimeout(..., 0)` rather than a microtask: the embedded runtime resolves createDashboardServer
  (an async boundary) BEFORE it subscribes to "listening", so a microtask-emitted event fires into
  no listener and the start hangs.
  */
  const listen = vi.fn((..._args: unknown[]) => {
    setTimeout(() => server.emit("listening"), 0);
    return server as unknown as Server;
  });
  const createServer = vi.fn(() => ({ listen }));

  const seedDashboardProviders = vi.fn(async ({ authStorage }: { authStorage: unknown }) => ({
    authStorage: { ...(authStorage as object), __wrapped: true },
    dispose: vi.fn(),
  }));

  return {
    TaskStore,
    createTaskStoreForBackend: vi.fn(async () => ({ taskStore: store, shutdown: vi.fn(async () => store.close()) })),
    CentralCore,
    PluginLoader,
    ProjectEngineManager,
    createServer,
    listen,
    store,
    centralCore,
    engineManager,
    seedDashboardProviders,
    ensureBundledPluginInstalled: vi.fn(async () => "installed" as const),
    isBundledPluginId: vi.fn((id: string) => id.startsWith("fusion-plugin-")),
    resolveDesktopBundlePluginDirs: vi.fn(() => ["/desktop/bundled"]),
  };
});

vi.mock("@fusion/core", () => ({
  /* The desktop token reuses the daemon token prefix; a whole-module mock must declare it. */
  DAEMON_TOKEN_PREFIX: "fn_",
  TaskStore: mocks.TaskStore,
  createTaskStoreForBackend: mocks.createTaskStoreForBackend,
  formatMigrationProgress: (event: { phase: string }) => `migration ${event.phase}`,
  CentralCore: mocks.CentralCore,
  PluginLoader: mocks.PluginLoader,
  ensureBundledPluginInstalled: mocks.ensureBundledPluginInstalled,
  isBundledPluginId: mocks.isBundledPluginId,
}));
vi.mock("../bundled-plugin-dirs.js", () => ({ resolveDesktopBundlePluginDirs: mocks.resolveDesktopBundlePluginDirs }));
vi.mock("@fusion/dashboard", () => ({ createServer: mocks.createServer }));
vi.mock("@fusion/engine", () => ({
  ProjectEngineManager: mocks.ProjectEngineManager,
  createFusionAuthStorage: () => ({ reload: () => undefined, getOAuthProviders: () => [], hasAuth: () => false }),
  createFusionModelRegistry: () => ({ listModels: () => [], refresh: () => undefined }),
  seedDashboardProviders: mocks.seedDashboardProviders,
}));

function lastCreateServerOptions(): Record<string, unknown> {
  const calls = mocks.createServer.mock.calls;
  const call = calls[calls.length - 1];
  expect(call, "createServer was never called").toBeDefined();
  return (call as unknown as [unknown, Record<string, unknown>])[1];
}

describe("desktop host authentication and binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("embedded runtime (local-runtime.ts)", () => {
    it("gates /api/* with a daemon-format bearer token and binds loopback only", async () => {
      const { LocalRuntimeManager } = await import("../local-runtime.ts");
      const manager = new LocalRuntimeManager({
        rootDir: "/repo",
        createStore: async () => mocks.store as never,
        // No createDashboardServer override: exercises the real createDashboardServerDefault.
      });

      await manager.startLocal();

      const options = lastCreateServerOptions();
      expect(options.daemon).toEqual({ token: expect.stringMatching(DAEMON_TOKEN_SHAPE) });
      expect(options.noAuth).toBeUndefined();
      expect(mocks.listen).toHaveBeenCalledWith(0, "127.0.0.1");

      await manager.stopLocal();
    });

    it("publishes the same token on the runtime status so the renderer can authenticate", async () => {
      const { LocalRuntimeManager } = await import("../local-runtime.ts");
      const manager = new LocalRuntimeManager({
        rootDir: "/repo",
        createStore: async () => mocks.store as never,
      });

      const status = await manager.startLocal();
      const serverToken = (lastCreateServerOptions().daemon as { token: string }).token;

      expect(status.authToken).toBe(serverToken);
      expect(manager.getStatus().authToken).toBe(serverToken);

      await manager.stopLocal();
    });

    it("does not advertise this process's token for an external-cli runtime", async () => {
      const { LocalRuntimeManager } = await import("../local-runtime.ts");
      const manager = new LocalRuntimeManager({
        rootDir: "/repo",
        getExternalPort: () => 4321,
        createStore: async () => mocks.store as never,
      });

      const status = await manager.startLocal();

      expect(status.source).toBe("external-cli");
      // A separate process owns that server; its token is unknown here and must not be faked.
      expect(status.authToken).toBeUndefined();
      expect(mocks.createServer).not.toHaveBeenCalled();
    });
  });

  describe("legacy manager (local-server.ts)", () => {
    it("gates /api/* with a daemon-format bearer token and binds loopback only", async () => {
      const { DesktopLocalServerManager } = await import("../local-server.ts");
      const manager = new DesktopLocalServerManager("/repo");

      await manager.start();

      const options = lastCreateServerOptions();
      expect(options.daemon).toEqual({ token: expect.stringMatching(DAEMON_TOKEN_SHAPE) });
      expect(options.noAuth).toBeUndefined();
      expect(mocks.listen).toHaveBeenCalledWith(0, "127.0.0.1");

      await manager.stop();
    });

    it("exposes the running server's token and drops it once stopped", async () => {
      const { DesktopLocalServerManager } = await import("../local-server.ts");
      const manager = new DesktopLocalServerManager("/repo");

      expect(manager.getAuthToken()).toBeUndefined();

      await manager.start();
      const serverToken = (lastCreateServerOptions().daemon as { token: string }).token;
      expect(manager.getAuthToken()).toBe(serverToken);

      await manager.stop();
      expect(manager.getAuthToken()).toBeUndefined();
    });
  });

  it("uses one stable token per process across both entrypoints", async () => {
    const { getDesktopApiToken } = await import("../api-token.ts");
    const first = getDesktopApiToken();

    expect(first).toMatch(DAEMON_TOKEN_SHAPE);
    expect(getDesktopApiToken()).toBe(first);
  });
});
