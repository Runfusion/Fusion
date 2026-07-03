import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function mockPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

// Mock renderer module - must be hoisted before importing main
const rendererMocks = vi.hoisted(() => {
  const getRendererUrl = vi.fn(() => "file:///path/to/dist/client/index.html");
  return {
    isDevelopmentMode: vi.fn(() => false),
    getRendererUrl,
    getRendererFilePath: vi.fn(() => "/path/to/dist/client/index.html"),
    isUrlRenderer: vi.fn(() => false),
    IS_DEVELOPMENT: false,
    // DASHBOARD_URL is re-exported as getRendererUrl
    DASHBOARD_URL: getRendererUrl,
  };
});

vi.mock("../renderer.ts", () => rendererMocks);

const mocks = vi.hoisted(() => {
  const browserWindowHandlers = new Map<string, (...args: unknown[]) => void>();
  const browserWindowInstance = {
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      browserWindowHandlers.set(event, handler);
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      browserWindowHandlers.set(event, handler);
    }),
    isVisible: vi.fn(() => true),
    show: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
    maximize: vi.fn(),
    webContents: { reload: vi.fn() },
  };

  const BrowserWindow = vi.fn(function () {
    return browserWindowInstance;
  }) as unknown as {
    (...args: unknown[]): typeof browserWindowInstance;
    getAllWindows: () => unknown[];
  };
  BrowserWindow.getAllWindows = vi.fn(() => []);

  const appHandlers = new Map<string, (...args: unknown[]) => void>();
  const app = {
    isQuitting: false,
    whenReady: vi.fn(() => Promise.resolve()),
    getVersion: vi.fn(() => "0.1.0"),
    getPath: vi.fn(() => "/mock/home"),
    quit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appHandlers.set(event, handler);
      return app;
    }),
  };

  const ipcMain = {
    handle: vi.fn(),
    on: vi.fn(),
  };

  const trayInstance = {
    setImage: vi.fn(),
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(),
  };

  const Tray = vi.fn(function () {
    return trayInstance;
  });
  const Menu = {
    buildFromTemplate: vi.fn(() => ({ id: "mock-menu" })),
    setApplicationMenu: vi.fn(),
  };
  const nativeImage = {
    createEmpty: vi.fn(() => ({ id: "mock-image" })),
    createFromPath: vi.fn(() => ({
      resize: vi.fn(() => ({ id: "resized-image" })),
    })),
  };

  const shell = {
    openExternal: vi.fn(() => Promise.resolve()),
  };

  const isDevelopmentMode = vi.fn(() => false);
  const getRendererUrl = vi.fn(() => "file:///path/to/dist/client/index.html");
  const getRendererFilePath = vi.fn(() => "/path/to/dist/client/index.html");
  const isUrlRenderer = vi.fn(() => false);

  const screen = {
    getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
  };

  return {
    app,
    appHandlers,
    BrowserWindow,
    ipcMain,
    trayInstance,
    Tray,
    Menu,
    nativeImage,
    shell,
    screen,
    browserWindowInstance,
    browserWindowHandlers,
    isDevelopmentMode,
    getRendererUrl,
    getRendererFilePath,
    isUrlRenderer,
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  ipcMain: mocks.ipcMain,
  Tray: mocks.Tray,
  Menu: mocks.Menu,
  nativeImage: mocks.nativeImage,
  shell: mocks.shell,
  screen: mocks.screen,
}));

const mainDeps = vi.hoisted(() => {
  const startLocal = vi.fn(async () => ({ source: "embedded-local", state: "running", port: 4545 }));
  const stopLocal = vi.fn(async () => ({ source: "none", state: "stopped" }));
  const getStatus = vi.fn(() => ({ source: "none", state: "stopped" }));
  const getServerPort = vi.fn(() => 0);
  const loadDesktopLaunchMode = vi.fn(async () => "choose");
  const saveDesktopLaunchMode = vi.fn(async () => undefined);
  return {
    registerIpcHandlers: vi.fn(),
    buildAppMenu: vi.fn(),
    setupTray: vi.fn(),
    registerDeepLinkProtocol: vi.fn(),
    setupDeepLinkHandler: vi.fn(),
    setupAutoUpdater: vi.fn(),
    loadWindowState: vi.fn(async () => null),
    loadDesktopLaunchMode,
    saveDesktopLaunchMode,
    saveWindowState: vi.fn(),
    LocalRuntimeManager: vi.fn(function () {
      return { startLocal, stopLocal, getStatus, getServerPort };
    }),
    startLocal,
    stopLocal,
  };
});

vi.mock("../ipc.js", () => ({ registerIpcHandlers: mainDeps.registerIpcHandlers }));
vi.mock("../menu.js", () => ({ buildAppMenu: mainDeps.buildAppMenu }));
vi.mock("../tray.js", () => ({ setupTray: mainDeps.setupTray }));
vi.mock("../deep-link.js", () => ({
  registerDeepLinkProtocol: mainDeps.registerDeepLinkProtocol,
  setupDeepLinkHandler: mainDeps.setupDeepLinkHandler,
}));
vi.mock("../native.js", () => ({
  DEFAULT_WINDOW_STATE: { width: 1280, height: 900, isMaximized: false },
  loadWindowState: mainDeps.loadWindowState,
  loadDesktopLaunchMode: mainDeps.loadDesktopLaunchMode,
  saveDesktopLaunchMode: mainDeps.saveDesktopLaunchMode,
  saveWindowState: mainDeps.saveWindowState,
  setupAutoUpdater: mainDeps.setupAutoUpdater,
  startUpdateCheckInterval: vi.fn(() => vi.fn()),
  clampWindowStateToVisibleDisplay: vi.fn((state, displays) => {
    if (state.x === undefined || state.y === undefined) {
      return state;
    }
    const minVisible = 64;
    const windowRight = state.x + state.width;
    const windowBottom = state.y + state.height;
    const visible = displays.some((display: { workArea: { x: number; y: number; width: number; height: number } }) => {
      const right = display.workArea.x + display.workArea.width;
      const bottom = display.workArea.y + display.workArea.height;
      const overlapWidth = Math.max(0, Math.min(windowRight, right) - Math.max(state.x, display.workArea.x));
      const overlapHeight = Math.max(0, Math.min(windowBottom, bottom) - Math.max(state.y, display.workArea.y));
      return overlapWidth >= minVisible && overlapHeight >= minVisible;
    });
    if (visible) {
      return state;
    }
    return { width: state.width, height: state.height, isMaximized: state.isMaximized };
  }),
  normalizeDesktopRemoteLaunch: vi.fn((settings) => {
    const active = settings.profiles.find((profile: { id: string }) => profile.id === settings.activeProfileId);
    return active ? { mode: "remote", profileId: active.id, serverBaseUrl: active.serverUrl.replace(/\/$/, ""), serverLabel: active.name, authToken: active.authToken ?? undefined } : null;
  }),
  buildRemoteShellHandoffUrl: vi.fn((launch) => `https://remote.example.com?shellKind=desktop&shellMode=remote&profileId=${launch.profileId}`),
}));
vi.mock("../local-runtime.js", () => ({
  LocalRuntimeManager: mainDeps.LocalRuntimeManager,
}));

vi.mock("../shell-settings.js", () => ({
  readShellSettings: vi.fn(async () => ({
    desktopMode: "remote",
    activeProfileId: "profile_1",
    profiles: [{ id: "profile_1", name: "Remote", serverUrl: "https://remote.example.com", authToken: "token" }],
  })),
}));

async function importMainModule() {
  return import("../main.ts");
}

describe("main process", () => {
  const originalDashboardUrl = process.env.FUSION_DASHBOARD_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.appHandlers.clear();
    mocks.app.isQuitting = false;
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
    delete process.env.FUSION_DESKTOP_MODE;
    delete process.env.FUSION_HOME;
    if (originalDashboardUrl === undefined) {
      delete process.env.FUSION_DASHBOARD_URL;
    } else {
      process.env.FUSION_DASHBOARD_URL = originalDashboardUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    // Ensure we're in production mode for these tests
    rendererMocks.isDevelopmentMode.mockReturnValue(false);
    rendererMocks.getRendererUrl.mockReturnValue("file:///path/to/dist/client/index.html");
    rendererMocks.getRendererFilePath.mockReturnValue("/path/to/dist/client/index.html");
    rendererMocks.isUrlRenderer.mockReturnValue(false);
    mocks.screen.getAllDisplays.mockReturnValue([{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]);
  });

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
    vi.useRealTimers();
  });

  it("DASHBOARD_URL defaults to local file URL in production mode", async () => {
    delete process.env.FUSION_DASHBOARD_URL;

    const { DASHBOARD_URL } = await importMainModule();

    expect(DASHBOARD_URL()).toMatch(/^file:\/\/.*\/client\/index\.html$/);
  });

  it("DASHBOARD_URL uses env override in development mode", async () => {
    process.env.FUSION_DASHBOARD_URL = "http://localhost:5050";
    // Mock development mode to use the env var
    rendererMocks.isDevelopmentMode.mockReturnValue(true);
    rendererMocks.getRendererUrl.mockReturnValue("http://localhost:5050");
    rendererMocks.getRendererFilePath.mockReturnValue("");
    rendererMocks.isUrlRenderer.mockReturnValue(true);

    const { DASHBOARD_URL } = await importMainModule();

    expect(DASHBOARD_URL()).toBe("http://localhost:5050");
  });

  it("createMainWindow creates BrowserWindow with secure preferences", async () => {
    const { createMainWindow } = await importMainModule();

    createMainWindow();

    expect(mocks.BrowserWindow).toHaveBeenCalledTimes(1);
    const [options] = mocks.BrowserWindow.mock.calls[0] as [
      {
        webPreferences: {
          contextIsolation: boolean;
          nodeIntegration: boolean;
          preload: string;
        };
      },
    ];

    expect(options.webPreferences.contextIsolation).toBe(true);
    expect(options.webPreferences.nodeIntegration).toBe(false);
    expect(options.webPreferences.preload).toContain("preload.js");
  });

  it("createMainWindow loads the renderer URL in URL mode", async () => {
    rendererMocks.isUrlRenderer.mockReturnValue(true);
    rendererMocks.getRendererUrl.mockReturnValue("http://localhost:3000/index.html");
    rendererMocks.getRendererFilePath.mockReturnValue("");

    const { createMainWindow } = await importMainModule();

    createMainWindow();

    expect(mocks.browserWindowInstance.loadURL).toHaveBeenCalledWith("http://localhost:3000/index.html");
    expect(mocks.browserWindowInstance.loadFile).not.toHaveBeenCalled();
  });

  it("createMainWindow loads the renderer file in file mode (production)", async () => {
    rendererMocks.isUrlRenderer.mockReturnValue(false);
    rendererMocks.getRendererUrl.mockReturnValue("file:///path/to/dist/client/index.html");
    rendererMocks.getRendererFilePath.mockReturnValue("/path/to/dist/client/index.html");

    const { createMainWindow } = await importMainModule();

    createMainWindow();

    expect(mocks.browserWindowInstance.loadFile).toHaveBeenCalledWith("/path/to/dist/client/index.html");
    expect(mocks.browserWindowInstance.loadURL).not.toHaveBeenCalled();
  });

  it("exports initializeApp for lifecycle orchestration", async () => {
    const mainModule = await importMainModule();

    expect(typeof mainModule.initializeApp).toBe("function");
  });

  it("initializeApp starts local runtime when remembered mode is local", async () => {
    mainDeps.loadDesktopLaunchMode.mockResolvedValueOnce("local");
    const { initializeApp, getCurrentDesktopLaunchMode } = await importMainModule();

    await initializeApp();

    expect(mainDeps.LocalRuntimeManager).toHaveBeenCalledWith({ rootDir: "/mock/home" });
    expect(mainDeps.startLocal).toHaveBeenCalledTimes(1);
    expect(getCurrentDesktopLaunchMode()).toBe("local");
  });

  it("anchors the local runtime root to the home dir, not process.cwd()", async () => {
    const { resolveLocalRuntimeRoot } = await importMainModule();

    // Packaged builds (notably the Linux AppImage launched from a desktop
    // launcher) run with cwd at `/` or a read-only mount point, so the root
    // must come from the home dir to keep `~/.fusion` writable.
    expect(resolveLocalRuntimeRoot()).toBe("/mock/home");
    expect(mocks.app.getPath).toHaveBeenCalledWith("home");
  });

  it("honors FUSION_HOME override for the local runtime root", async () => {
    process.env.FUSION_HOME = "/custom/fusion-home";
    const { resolveLocalRuntimeRoot } = await importMainModule();

    expect(resolveLocalRuntimeRoot()).toBe("/custom/fusion-home");
    // FUSION_HOME must satisfy the root without falling back to getPath("home").
    // (Module load calls getPath("userData") for the profile-relocation guard, so
    // assert the specific "home" lookup is skipped rather than getPath overall.)
    expect(mocks.app.getPath).not.toHaveBeenCalledWith("home");
  });

  it("initializeApp does not start local runtime for remembered choose mode", async () => {
    mainDeps.loadDesktopLaunchMode.mockResolvedValueOnce("choose");
    const { initializeApp } = await importMainModule();

    await initializeApp();

    expect(mainDeps.startLocal).not.toHaveBeenCalled();
  });

  it("initializeApp routes remembered remote mode to remote dashboard handoff URL", async () => {
    mainDeps.loadDesktopLaunchMode.mockResolvedValueOnce("remote");
    const { initializeApp, getCurrentDesktopLaunchMode } = await importMainModule();

    await initializeApp();

    expect(mainDeps.startLocal).not.toHaveBeenCalled();
    expect(mocks.browserWindowInstance.loadURL).toHaveBeenCalledWith(
      expect.stringContaining("shellMode=remote"),
    );
    expect(getCurrentDesktopLaunchMode()).toBe("remote");
  });

  it("initializeApp falls back to choose and persists when remembered local start fails", async () => {
    mainDeps.loadDesktopLaunchMode.mockResolvedValueOnce("local");
    mainDeps.startLocal.mockRejectedValueOnce(new Error("boom"));
    const { initializeApp, getCurrentDesktopLaunchMode } = await importMainModule();

    await initializeApp();

    expect(mainDeps.saveDesktopLaunchMode).toHaveBeenCalledWith("choose");
    expect(getCurrentDesktopLaunchMode()).toBe("choose");
  });

  it("initializeApp avoids duplicate local start when remembered mode and env flag are local", async () => {
    mainDeps.loadDesktopLaunchMode.mockResolvedValueOnce("local");
    process.env.FUSION_DESKTOP_MODE = "local";
    const { initializeApp } = await importMainModule();

    await initializeApp();

    expect(mainDeps.startLocal).toHaveBeenCalledTimes(1);
  });

  it("onDesktopModeChange persists the selected launch mode", async () => {
    const { initializeApp } = await importMainModule();

    await initializeApp();

    const options = mainDeps.registerIpcHandlers.mock.calls[0]?.[2] as
      | { onDesktopModeChange?: (mode: "local" | "remote") => Promise<void> }
      | undefined;
    await options?.onDesktopModeChange?.("remote");

    expect(mainDeps.saveDesktopLaunchMode).toHaveBeenCalledWith("remote");
  });

  it("does not persist local menu mode when local runtime startup fails", async () => {
    mainDeps.startLocal.mockRejectedValueOnce(new Error("boom"));
    const { initializeApp, getCurrentDesktopLaunchMode } = await importMainModule();

    await initializeApp();

    const menuOptions = mainDeps.buildAppMenu.mock.calls[0]?.[0] as
      | { onStartLocalRuntime?: () => Promise<void> }
      | undefined;
    await expect(menuOptions?.onStartLocalRuntime?.()).rejects.toThrow("boom");

    expect(mainDeps.saveDesktopLaunchMode).not.toHaveBeenCalledWith("local");
    expect(getCurrentDesktopLaunchMode()).toBe("choose");
  });

  it("createMainWindow registers close and closed handlers", async () => {
    const { createMainWindow } = await importMainModule();

    createMainWindow();

    expect(mocks.browserWindowInstance.on).toHaveBeenCalledWith("close", expect.any(Function));
    expect(mocks.browserWindowInstance.on).toHaveBeenCalledWith("closed", expect.any(Function));
  });

  it("windows window close saves state and allows quit cleanup instead of hiding", async () => {
    mockPlatform("win32");
    const { initializeApp, run } = await importMainModule();

    await initializeApp();
    run();
    const closeHandler = mocks.browserWindowHandlers.get("close") as
      | ((event: { preventDefault: () => void }) => void)
      | undefined;
    const event = { preventDefault: vi.fn() };

    closeHandler?.(event);
    mocks.appHandlers.get("window-all-closed")?.();
    mocks.appHandlers.get("before-quit")?.();

    expect(mainDeps.saveWindowState).toHaveBeenCalledWith(mocks.browserWindowInstance);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mocks.browserWindowInstance.hide).not.toHaveBeenCalled();
    expect(mocks.app.quit).toHaveBeenCalledTimes(1);
    expect(mainDeps.stopLocal).toHaveBeenCalledTimes(1);
  });

  it("macOS window close hides to tray without quitting", async () => {
    mockPlatform("darwin");
    const { initializeApp, run } = await importMainModule();

    await initializeApp();
    run();
    const closeHandler = mocks.browserWindowHandlers.get("close") as
      | ((event: { preventDefault: () => void }) => void)
      | undefined;
    const event = { preventDefault: vi.fn() };

    closeHandler?.(event);
    mocks.appHandlers.get("window-all-closed")?.();

    expect(mainDeps.saveWindowState).toHaveBeenCalledWith(mocks.browserWindowInstance);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.browserWindowInstance.hide).toHaveBeenCalledTimes(1);
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });

  it("createMainWindow shows and focuses on ready-to-show", async () => {
    const { createMainWindow } = await importMainModule();

    createMainWindow();
    mocks.browserWindowHandlers.get("ready-to-show")?.();

    expect(mocks.browserWindowInstance.show).toHaveBeenCalledTimes(1);
    expect(mocks.browserWindowInstance.focus).toHaveBeenCalledTimes(1);
  });

  it("createMainWindow fallback timer shows and focuses when ready-to-show never fires", async () => {
    vi.useFakeTimers();
    const { createMainWindow } = await importMainModule();

    createMainWindow();
    vi.advanceTimersByTime(2000);

    expect(mocks.browserWindowInstance.show).toHaveBeenCalledTimes(1);
    expect(mocks.browserWindowInstance.focus).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("initializeApp drops off-screen x/y before BrowserWindow construction", async () => {
    mainDeps.loadWindowState.mockResolvedValueOnce({
      x: -9999,
      y: -9999,
      width: 1280,
      height: 900,
      isMaximized: false,
    });
    const { initializeApp } = await importMainModule();

    await initializeApp();

    const [options] = mocks.BrowserWindow.mock.calls[0] as Array<Record<string, unknown>>;
    expect(options).not.toHaveProperty("x");
    expect(options).not.toHaveProperty("y");
  });

  it("initializeApp preserves x/y when state overlaps a visible display", async () => {
    mainDeps.loadWindowState.mockResolvedValueOnce({
      x: 100,
      y: 100,
      width: 1280,
      height: 900,
      isMaximized: false,
    });
    const { initializeApp } = await importMainModule();

    await initializeApp();

    const [options] = mocks.BrowserWindow.mock.calls[0] as Array<Record<string, unknown>>;
    expect(options).toMatchObject({ x: 100, y: 100 });
  });

  it("importing main does not auto-start", async () => {
    await importMainModule();

    expect(mocks.app.whenReady).not.toHaveBeenCalled();
  });

  it("exports run for app entrypoint wiring", async () => {
    const mainModule = await importMainModule();

    expect(typeof mainModule.run).toBe("function");
  });
});
