import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: any[]) => void;

interface MockEmitter {
  on(event: string, listener: Listener): MockEmitter;
  once(event: string, listener: Listener): MockEmitter;
  off(event: string, listener: Listener): MockEmitter;
  emit(event: string, ...args: any[]): boolean;
}

interface MockChild extends MockEmitter {
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
}

const mocks = vi.hoisted(() => {
  function createEmitter(): MockEmitter {
    const listeners = new Map<string, Set<Listener>>();

    const add = (event: string, listener: Listener) => {
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    };

    const remove = (event: string, listener: Listener) => {
      const eventListeners = listeners.get(event);
      if (!eventListeners) return;
      eventListeners.delete(listener);
      if (eventListeners.size === 0) {
        listeners.delete(event);
      }
    };

    return {
      on(event: string, listener: Listener) {
        add(event, listener);
        return this;
      },
      once(event: string, listener: Listener) {
        const wrapped: Listener = (...args: any[]) => {
          remove(event, wrapped);
          listener(...args);
        };
        add(event, wrapped);
        return this;
      },
      off(event: string, listener: Listener) {
        remove(event, listener);
        return this;
      },
      emit(event: string, ...args: any[]) {
        const eventListeners = listeners.get(event);
        if (!eventListeners || eventListeners.size === 0) {
          return false;
        }

        for (const listener of [...eventListeners]) {
          listener(...args);
        }

        return true;
      },
    };
  }

  function createMockChild(): MockChild {
    const emitter = createEmitter();
    const child = emitter as MockChild;
    child.killed = false;
    child.kill = vi.fn((() => {
      child.killed = true;
      return true;
    }) as unknown as MockChild["kill"]);
    return child;
  }

  const state = {
    buildChild: createMockChild(),
    electronChild: createMockChild(),
  };

  const store = {
    init: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
  const project = { id: "project-1", name: "Repo", path: "/repo", status: "active" };
  const centralCore = {
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const engine = { id: "engine-1" };
  const engineMap = new Map([[project.id, engine]]);
  const engineManager = {
    startAll: vi.fn().mockResolvedValue(undefined),
    startReconciliation: vi.fn(),
    ensureEngine: vi.fn().mockResolvedValue(engine),
    onProjectAccessed: vi.fn(),
    stopAll: vi.fn().mockResolvedValue(undefined),
    getAllEngines: vi.fn(() => engineMap),
  };

  const server = Object.assign(createEmitter(), {
    address: vi.fn(() => ({ port: 4545 })),
    close: vi.fn((callback?: () => void) => {
      callback?.();
    }),
  });

  const app = {
    listen: vi.fn(() => {
      queueMicrotask(() => {
        server.emit("listening");
      });
      return server;
    }),
  };

  const spawn = vi.fn((command: string) => {
    if (command === "pnpm") {
      queueMicrotask(() => {
        state.buildChild.emit("exit", 0);
      });
      return state.buildChild;
    }

    return state.electronChild;
  });

  return {
    state,
    createMockChild,
    store,
    server,
    app,
    spawn,
    taskStoreCtor: vi.fn(function () {
      return store;
    }),
    centralCoreCtor: vi.fn(function () {
      return centralCore;
    }),
    project,
    centralCore,
    engine,
    engineManager,
    projectEngineManagerCtor: vi.fn(function () {
      return engineManager;
    }),
    ensureCwdProjectRegistered: vi.fn().mockResolvedValue(project),
    createServer: vi.fn(() => app),
  };
});

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("@fusion/core", () => ({
  TaskStore: mocks.taskStoreCtor,
  CentralCore: mocks.centralCoreCtor,
}));

vi.mock("@fusion/engine", () => ({
  ProjectEngineManager: mocks.projectEngineManagerCtor,
}));

vi.mock("../ensure-project-registered.js", () => ({
  ensureCwdProjectRegistered: mocks.ensureCwdProjectRegistered,
}));

vi.mock("@fusion/dashboard", () => ({
  createServer: mocks.createServer,
  loadTlsCredentialsFromEnv: vi.fn().mockReturnValue(undefined),
}));

import { runDesktop } from "../desktop.js";

describe("runDesktop", () => {
  const originalCwd = process.cwd;
  const originalExit = process.exit;
  const originalElectronBinary = process.env.FUSION_ELECTRON_BINARY;
  const originalDashboardUrl = process.env.FUSION_DASHBOARD_URL;

  beforeEach(() => {
    vi.clearAllMocks();

    process.env.FUSION_ELECTRON_BINARY = "electron-bin";
    delete process.env.FUSION_DASHBOARD_URL;

    mocks.state.buildChild = mocks.createMockChild();
    mocks.state.electronChild = mocks.createMockChild();

    mocks.server.address.mockReturnValue({ port: 4545 });
    mocks.app.listen.mockImplementation(() => {
      queueMicrotask(() => {
        mocks.server.emit("listening");
      });
      return mocks.server;
    });
    mocks.server.close.mockImplementation((callback?: () => void) => {
      callback?.();
    });

    vi.spyOn(process, "cwd").mockReturnValue("/repo");
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.cwd = originalCwd;
    process.exit = originalExit;
    if (originalElectronBinary === undefined) {
      delete process.env.FUSION_ELECTRON_BINARY;
    } else {
      process.env.FUSION_ELECTRON_BINARY = originalElectronBinary;
    }
    if (originalDashboardUrl === undefined) {
      delete process.env.FUSION_DASHBOARD_URL;
    } else {
      process.env.FUSION_DASHBOARD_URL = originalDashboardUrl;
    }
  });

  it("builds desktop app, starts dashboard on random port, and launches Electron", async () => {
    await runDesktop({ paused: true });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "pnpm",
      ["--filter", "@fusion/desktop", "build"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(mocks.taskStoreCtor).toHaveBeenCalledWith("/repo");
    expect(mocks.store.updateSettings).toHaveBeenCalledWith({ enginePaused: true });
    expect(mocks.ensureCwdProjectRegistered).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo", central: mocks.centralCore, autoRegister: true }),
    );
    expect(mocks.projectEngineManagerCtor).toHaveBeenCalledWith(mocks.centralCore);
    expect(mocks.engineManager.startAll).toHaveBeenCalled();
    expect(mocks.engineManager.ensureEngine).toHaveBeenCalledWith("project-1");
    expect(mocks.createServer).toHaveBeenCalledWith(
      mocks.store,
      expect.objectContaining({
        engine: mocks.engine,
        engineManager: mocks.engineManager,
        centralCore: mocks.centralCore,
      }),
    );
    expect(mocks.app.listen).toHaveBeenCalledWith(0);

    // In production mode (not dev), renderer uses embedded assets, so no FUSION_DASHBOARD_URL
    expect(mocks.spawn).toHaveBeenCalledWith(
      "electron-bin",
      ["--enable-source-maps", "/repo/packages/desktop/dist/main.js"],
      expect.objectContaining({
        cwd: "/repo",
        env: expect.objectContaining({
          // No FUSION_DASHBOARD_URL in production
          FUSION_SERVER_PORT: "4545",
        }),
      }),
    );

    mocks.state.electronChild.emit("exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("supports --dev mode by skipping build and pointing at Vite URL", async () => {
    process.env.FUSION_DASHBOARD_URL = "http://localhost:5173";

    await runDesktop({ dev: true });

    const buildCalls = mocks.spawn.mock.calls.filter(([command]) => command === "pnpm");
    expect(buildCalls).toHaveLength(0);

    expect(mocks.spawn).toHaveBeenCalledWith(
      "electron-bin",
      ["--enable-source-maps", "/repo/packages/desktop/dist/main.js", "--dev"],
      expect.objectContaining({
        env: expect.objectContaining({
          NODE_ENV: "development",
          FUSION_DASHBOARD_URL: "http://localhost:5173",
        }),
      }),
    );

    mocks.state.electronChild.emit("exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("cleans up dashboard runtime when Electron exits", async () => {
    await runDesktop();

    mocks.state.electronChild.emit("exit", 7);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.server.close).toHaveBeenCalledTimes(1);
    expect(mocks.engineManager.stopAll).toHaveBeenCalledTimes(1);
    expect(mocks.store.close).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(7);
  });

  it("handles SIGINT by terminating Electron and shutting down services", async () => {
    await runDesktop();

    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.state.electronChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mocks.server.close).toHaveBeenCalledTimes(1);
    expect(mocks.engineManager.stopAll).toHaveBeenCalledTimes(1);
    expect(mocks.store.close).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
