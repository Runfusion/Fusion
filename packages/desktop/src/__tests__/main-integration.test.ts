import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const callLog: string[] = [];
  const appEvents = new Map<string, (...args: unknown[]) => void>();
  const windowInstances: Array<{
    instance: ReturnType<typeof createWindowMock>;
    options: Record<string, unknown>;
  }> = [];
  const trayInstances: Array<ReturnType<typeof createTrayMock>> = [];

  function createWindowMock() {
    const listeners = new Map<string, (...args: unknown[]) => void>();

    return {
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners.set(event, handler);
      }),
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners.set(event, handler);
      }),
      hide: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      maximize: vi.fn(),
      isDestroyed: vi.fn(() => false),
      getBounds: vi.fn(() => ({ x: 50, y: 80, width: 1280, height: 900 })),
      isMaximized: vi.fn(() => false),
      getListener: (event: string) => listeners.get(event),
    };
  }

  function createTrayMock() {
    return {
      destroy: vi.fn(),
      setImage: vi.fn(),
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn(),
    };
  }

  const app = {
    whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn((name: string) => (name === "home" ? "/mock/home" : "/mock/other")),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appEvents.set(event, handler);
    }),
    quit: vi.fn(),
    isQuitting: false,
  };

  const BrowserWindow = vi.fn(function (options: Record<string, unknown>) {
    callLog.push("createMainWindow");
    const instance = createWindowMock();
    windowInstances.push({ instance, options });
    return instance;
  });

  const Tray = vi.fn(function () {
    const tray = createTrayMock();
    trayInstances.push(tray);
    return tray;
  });

  const nativeImage = {
    createEmpty: vi.fn(() => ({ id: "empty" })),
  };

  const screen = {
    getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
  };

  const buildAppMenu = vi.fn(() => {
    callLog.push("buildAppMenu");
  });

  const setupTray = vi.fn(() => {
    callLog.push("setupTray");
  });

  const registerIpcHandlers = vi.fn(() => {
    callLog.push("registerIpcHandlers");
  });

  const registerDeepLinkProtocol = vi.fn(() => {
    callLog.push("registerDeepLinkProtocol");
  });

  const setupDeepLinkHandler = vi.fn(() => {
    callLog.push("setupDeepLinkHandler");
  });

  const setupAutoUpdater = vi.fn(() => {
    callLog.push("setupAutoUpdater");
  });
  const stopUpdateCheckInterval = vi.fn();
  const startUpdateCheckInterval = vi.fn(() => {
    callLog.push("startUpdateCheckInterval");
    return stopUpdateCheckInterval;
  });

  const loadWindowState = vi.fn(async () => {
    callLog.push("loadWindowState");
    return null;
  });

  const loadDesktopLaunchMode = vi.fn(async () => {
    callLog.push("loadDesktopLaunchMode");
    return "choose";
  });

  const saveDesktopLaunchMode = vi.fn(async () => undefined);
  const startLocal = vi.fn(async () => ({ source: "embedded-local", state: "running", port: 4545 }));
  const stopLocal = vi.fn(async () => ({ source: "none", state: "stopped" }));
  const getStatus = vi.fn(() => ({ source: "none", state: "stopped" }));

  const saveWindowState = vi.fn();
  const LocalRuntimeManager = vi.fn(function () {
    return {
      startLocal,
      stopLocal,
      getStatus,
      getServerPort: vi.fn(() => 0),
    };
  });

  const DEFAULT_WINDOW_STATE = {
    width: 1280,
    height: 900,
    isMaximized: false,
  };

  return {
    callLog,
    appEvents,
    windowInstances,
    trayInstances,
    app,
    BrowserWindow,
    Tray,
    nativeImage,
    screen,
    buildAppMenu,
    setupTray,
    registerIpcHandlers,
    registerDeepLinkProtocol,
    setupDeepLinkHandler,
    setupAutoUpdater,
    startUpdateCheckInterval,
    stopUpdateCheckInterval,
    loadWindowState,
    loadDesktopLaunchMode,
    saveDesktopLaunchMode,
    saveWindowState,
    startLocal,
    stopLocal,
    getStatus,
    LocalRuntimeManager,
    DEFAULT_WINDOW_STATE,
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  Tray: mocks.Tray,
  nativeImage: mocks.nativeImage,
  screen: mocks.screen,
}));

vi.mock("../menu.js", () => ({
  buildAppMenu: mocks.buildAppMenu,
}));

vi.mock("../tray.js", () => ({
  setupTray: mocks.setupTray,
}));

vi.mock("../ipc.js", () => ({
  registerIpcHandlers: mocks.registerIpcHandlers,
}));

vi.mock("../deep-link.js", () => ({
  registerDeepLinkProtocol: mocks.registerDeepLinkProtocol,
  setupDeepLinkHandler: mocks.setupDeepLinkHandler,
}));

vi.mock("../native.js", () => ({
  loadWindowState: mocks.loadWindowState,
  loadDesktopLaunchMode: mocks.loadDesktopLaunchMode,
  saveDesktopLaunchMode: mocks.saveDesktopLaunchMode,
  saveWindowState: mocks.saveWindowState,
  setupAutoUpdater: mocks.setupAutoUpdater,
  startUpdateCheckInterval: mocks.startUpdateCheckInterval,
  DEFAULT_WINDOW_STATE: mocks.DEFAULT_WINDOW_STATE,
  normalizeDesktopRemoteLaunch: vi.fn((settings) => {
    const active = settings.profiles.find((profile: { id: string }) => profile.id === settings.activeProfileId);
    return active ? { mode: "remote", profileId: active.id, serverBaseUrl: active.serverUrl.replace(/\/$/, ""), serverLabel: active.name, authToken: active.authToken ?? undefined } : null;
  }),
  buildRemoteShellHandoffUrl: vi.fn((launch) => `https://remote.example.com?shellMode=remote&profileId=${launch.profileId}`),
  clampWindowStateToVisibleDisplay: vi.fn((state) => state),
}));

vi.mock("../local-runtime.js", () => ({
  LocalRuntimeManager: mocks.LocalRuntimeManager,
}));

// Mock renderer module
vi.mock("../shell-settings.js", () => ({
  readShellSettings: vi.fn(async () => ({
    desktopMode: "remote",
    activeProfileId: "profile_1",
    profiles: [{ id: "profile_1", name: "Remote", serverUrl: "https://remote.example.com", authToken: "token" }],
  })),
}));

vi.mock("../renderer.js", () => ({
  isDevelopmentMode: vi.fn(() => false),
  getRendererUrl: vi.fn(() => "file:///path/to/dist/client/index.html"),
  getRendererFilePath: vi.fn(() => "/path/to/dist/client/index.html"),
  isUrlRenderer: vi.fn(() => false),
  IS_DEVELOPMENT: false,
  DASHBOARD_URL: vi.fn(() => "file:///path/to/dist/client/index.html"),
}));

async function importMainModule() {
  return import("../main.ts");
}

async function flushPromises() {
  // Drain ALL pending microtasks via a macrotask boundary rather than counting a
  // fixed number of ticks. initializeApp()'s async chain length is an implementation
  // detail (e.g. the launch-mode/shell split-brain reconciliation adds a readShellSettings
  // await); a hardcoded tick count silently under-flushes when that chain grows and the
  // run()-based tests then observe a half-initialized app. setTimeout(0) waits for the
  // whole microtask queue to settle, so these tests assert on a fully-initialized app.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("main integration", () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.callLog.length = 0;
    mocks.appEvents.clear();
    mocks.windowInstances.length = 0;
    mocks.trayInstances.length = 0;
    mocks.app.isQuitting = false;
    mocks.loadWindowState.mockImplementation(async () => {
      mocks.callLog.push("loadWindowState");
      return null;
    });
    mocks.loadDesktopLaunchMode.mockImplementation(async () => {
      mocks.callLog.push("loadDesktopLaunchMode");
      return "choose";
    });
  });

  it("initializeApp calls modules in the expected order", async () => {
    const { initializeApp } = await importMainModule();

    await initializeApp();

    expect(mocks.callLog).toEqual([
      "loadWindowState",
      "loadDesktopLaunchMode",
      "createMainWindow",
      "buildAppMenu",
      "setupTray",
      "registerIpcHandlers",
      "registerDeepLinkProtocol",
      "setupDeepLinkHandler",
      "setupAutoUpdater",
      "startUpdateCheckInterval",
    ]);
    expect(mocks.LocalRuntimeManager).toHaveBeenCalledWith({ rootDir: "/mock/home" });
    expect(mocks.app.getPath).toHaveBeenCalledWith("home");
  });

  it("createMainWindow uses restored window state", async () => {
    mocks.loadWindowState.mockImplementationOnce(async () => ({
      x: 100,
      y: 200,
      width: 1024,
      height: 768,
      isMaximized: false,
    }));

    const { initializeApp } = await importMainModule();
    await initializeApp();

    const [{ options }] = mocks.windowInstances;
    expect(options).toMatchObject({
      x: 100,
      y: 200,
      width: 1024,
      height: 768,
    });
  });

  it("createMainWindow falls back to DEFAULT_WINDOW_STATE when no saved state exists", async () => {
    mocks.loadWindowState.mockImplementationOnce(async () => null);

    const { initializeApp } = await importMainModule();
    await initializeApp();

    const [{ options }] = mocks.windowInstances;
    expect(options).toMatchObject({
      width: mocks.DEFAULT_WINDOW_STATE.width,
      height: mocks.DEFAULT_WINDOW_STATE.height,
    });
  });

  it("initializeApp maximizes the window when restored state is maximized", async () => {
    mocks.loadWindowState.mockImplementationOnce(async () => ({
      width: 1280,
      height: 900,
      isMaximized: true,
    }));

    const { initializeApp } = await importMainModule();
    await initializeApp();

    const [{ instance }] = mocks.windowInstances;
    expect(instance.maximize).toHaveBeenCalledTimes(1);
  });

  it("buildAppMenu is called with mainWindow and Fusion app name", async () => {
    const { initializeApp } = await importMainModule();
    await initializeApp();

    const [{ instance }] = mocks.windowInstances;
    expect(mocks.buildAppMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        mainWindow: instance,
        appName: "Fusion",
        onChangeLaunchMode: expect.any(Function),
        onCheckForUpdates: expect.any(Function),
      }),
    );
  });

  it("setupTray is called with mainWindow and tray instance", async () => {
    const { initializeApp } = await importMainModule();
    await initializeApp();

    const [{ instance }] = mocks.windowInstances;
    const [trayInstance] = mocks.trayInstances;
    expect(mocks.setupTray).toHaveBeenCalledWith(instance, trayInstance);
  });

  it("registerIpcHandlers is called with mainWindow and tray", async () => {
    const { initializeApp } = await importMainModule();
    await initializeApp();

    const [{ instance }] = mocks.windowInstances;
    const [trayInstance] = mocks.trayInstances;
    expect(mocks.registerIpcHandlers).toHaveBeenCalledWith(instance, trayInstance, expect.any(Object));
  });

  it("window close hides to tray when app is not quitting", async () => {
    const { initializeApp } = await importMainModule();
    await initializeApp();

    const [{ instance }] = mocks.windowInstances;
    const closeHandler = instance.getListener("close") as ((event: { preventDefault: () => void }) => void) | undefined;
    const event = { preventDefault: vi.fn() };

    closeHandler?.(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(instance.hide).toHaveBeenCalledTimes(1);
  });

  it("window close saves window state before hiding", async () => {
    const { initializeApp } = await importMainModule();
    await initializeApp();

    const [{ instance }] = mocks.windowInstances;
    const closeHandler = instance.getListener("close") as ((event: { preventDefault: () => void }) => void) | undefined;

    closeHandler?.({ preventDefault: vi.fn() });

    expect(mocks.saveWindowState).toHaveBeenCalledWith(instance);
  });

  it("before-quit disposes update interval, destroys tray and marks app as quitting", async () => {
    const { run } = await importMainModule();

    run();
    await flushPromises();

    const beforeQuitHandler = mocks.appEvents.get("before-quit");
    beforeQuitHandler?.();

    const [trayInstance] = mocks.trayInstances;
    expect(mocks.app.isQuitting).toBe(true);
    expect(mocks.stopUpdateCheckInterval).toHaveBeenCalledTimes(1);
    expect(trayInstance.destroy).toHaveBeenCalledTimes(1);
  });

  it("window-all-closed does not quit on macOS", async () => {
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "darwin",
      });
    }

    const { run } = await importMainModule();
    run();

    const windowAllClosedHandler = mocks.appEvents.get("window-all-closed");
    windowAllClosedHandler?.();

    expect(mocks.app.quit).not.toHaveBeenCalled();

    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  it("loads remote handoff URL when remembered mode is remote", async () => {
    mocks.loadDesktopLaunchMode.mockResolvedValueOnce("remote");
    const { initializeApp } = await importMainModule();

    await initializeApp();

    const [{ instance }] = mocks.windowInstances;
    expect(instance.loadURL).toHaveBeenCalledWith(expect.stringContaining("shellMode=remote"));
    expect(mocks.startLocal).not.toHaveBeenCalled();
  });

  it("starts local runtime when remembered mode is local", async () => {
    mocks.loadDesktopLaunchMode.mockResolvedValueOnce("local");
    const { initializeApp } = await importMainModule();

    await initializeApp();

    expect(mocks.startLocal).toHaveBeenCalledTimes(1);
  });

  it("falls back to choose and persists fallback when local restore fails", async () => {
    mocks.loadDesktopLaunchMode.mockResolvedValueOnce("local");
    mocks.startLocal.mockRejectedValueOnce(new Error("start failed"));
    const { initializeApp, getCurrentDesktopLaunchMode } = await importMainModule();

    await initializeApp();

    expect(mocks.saveDesktopLaunchMode).toHaveBeenCalledWith("choose");
    expect(getCurrentDesktopLaunchMode()).toBe("choose");
    expect(mocks.stopLocal).toHaveBeenCalledTimes(1);
  });

  it("importing main module does not auto-start app lifecycle", async () => {
    await importMainModule();

    expect(mocks.app.whenReady).not.toHaveBeenCalled();
  });
});
