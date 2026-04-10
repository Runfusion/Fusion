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
      hide: vi.fn(),
      show: vi.fn(),
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
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appEvents.set(event, handler);
    }),
    quit: vi.fn(),
    isQuitting: false,
  };

  const BrowserWindow = vi.fn((options: Record<string, unknown>) => {
    callLog.push("createMainWindow");
    const instance = createWindowMock();
    windowInstances.push({ instance, options });
    return instance;
  });

  const Tray = vi.fn(() => {
    const tray = createTrayMock();
    trayInstances.push(tray);
    return tray;
  });

  const nativeImage = {
    createEmpty: vi.fn(() => ({ id: "empty" })),
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

  const loadWindowState = vi.fn(async () => {
    callLog.push("loadWindowState");
    return null;
  });

  const saveWindowState = vi.fn();

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
    buildAppMenu,
    setupTray,
    registerIpcHandlers,
    registerDeepLinkProtocol,
    setupDeepLinkHandler,
    setupAutoUpdater,
    loadWindowState,
    saveWindowState,
    DEFAULT_WINDOW_STATE,
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  Tray: mocks.Tray,
  nativeImage: mocks.nativeImage,
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
  saveWindowState: mocks.saveWindowState,
  setupAutoUpdater: mocks.setupAutoUpdater,
  DEFAULT_WINDOW_STATE: mocks.DEFAULT_WINDOW_STATE,
}));

// Mock renderer module
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
  await Promise.resolve();
  await Promise.resolve();
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
  });

  it("initializeApp calls modules in the expected order", async () => {
    const { initializeApp } = await importMainModule();

    await initializeApp();

    expect(mocks.callLog).toEqual([
      "loadWindowState",
      "createMainWindow",
      "buildAppMenu",
      "setupTray",
      "registerIpcHandlers",
      "registerDeepLinkProtocol",
      "setupDeepLinkHandler",
      "setupAutoUpdater",
    ]);
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
    expect(mocks.buildAppMenu).toHaveBeenCalledWith({
      mainWindow: instance,
      appName: "Fusion",
    });
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
    expect(mocks.registerIpcHandlers).toHaveBeenCalledWith(instance, trayInstance);
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

  it("before-quit destroys tray and marks app as quitting", async () => {
    const { run } = await importMainModule();

    run();
    await flushPromises();

    const beforeQuitHandler = mocks.appEvents.get("before-quit");
    beforeQuitHandler?.();

    const [trayInstance] = mocks.trayInstances;
    expect(mocks.app.isQuitting).toBe(true);
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

  it("importing main module does not auto-start app lifecycle", async () => {
    await importMainModule();

    expect(mocks.app.whenReady).not.toHaveBeenCalled();
  });
});
