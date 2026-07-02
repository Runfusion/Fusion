import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const appHandlers = new Map<string, (...args: unknown[]) => void>();
  const app = {
    whenReady: vi.fn(async () => undefined),
    getPath: vi.fn((name: string) => (name === "home" ? "/mock/home" : "/mock/other")),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appHandlers.set(event, handler);
      return app;
    }),
    quit: vi.fn(),
  };

  const browserWindow = {
    on: vi.fn(),
    once: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    isDestroyed: vi.fn(() => false),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    isMaximized: vi.fn(() => false),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    maximize: vi.fn(),
    webContents: { send: vi.fn() },
  };

  const BrowserWindow = vi.fn(function () {
    return browserWindow;
  });
  const Tray = vi.fn(function () {
    return { destroy: vi.fn() };
  });

  const localRuntimeManager = {
    startLocal: vi.fn(async () => ({ source: "embedded-local", state: "running", port: 4041 })),
    stopLocal: vi.fn(async () => ({ source: "none", state: "stopped" })),
    getStatus: vi.fn(() => ({ source: "none", state: "stopped" })),
    getServerPort: vi.fn(() => undefined),
  };

  const screen = {
    getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
  };

  const LocalRuntimeManager = vi.fn(function () {
    return localRuntimeManager;
  });

  const DEFAULT_SHELL_SETTINGS = {
    desktopMode: null as "local" | "remote" | null,
    hasCompletedModeSelection: false,
    activeProfileId: null,
    profiles: [],
  };
  const readShellSettings = vi.fn(async () => ({ ...DEFAULT_SHELL_SETTINGS }));
  const writeShellSettings = vi.fn(async () => undefined);

  const loadDesktopLaunchMode = vi.fn(async () => "choose" as "choose" | "local" | "remote");
  const saveDesktopLaunchMode = vi.fn(async () => undefined);

  return { app, appHandlers, BrowserWindow, Tray, browserWindow, localRuntimeManager, LocalRuntimeManager, screen, readShellSettings, writeShellSettings, DEFAULT_SHELL_SETTINGS, loadDesktopLaunchMode, saveDesktopLaunchMode };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  Tray: mocks.Tray,
  nativeImage: { createEmpty: vi.fn(() => ({})) },
  screen: mocks.screen,
}));

vi.mock("../renderer.js", () => ({ isUrlRenderer: vi.fn(() => true), getRendererUrl: vi.fn(() => "http://localhost"), getRendererFilePath: vi.fn(() => "index.html") }));
vi.mock("../menu.js", () => ({ buildAppMenu: vi.fn() }));
vi.mock("../tray.js", () => ({ setupTray: vi.fn() }));
vi.mock("../ipc.js", () => ({ registerIpcHandlers: vi.fn() }));
vi.mock("../native.js", () => ({
  DEFAULT_WINDOW_STATE: { width: 1000, height: 800 },
  loadWindowState: vi.fn(async () => null),
  loadDesktopLaunchMode: mocks.loadDesktopLaunchMode,
  saveDesktopLaunchMode: mocks.saveDesktopLaunchMode,
  saveWindowState: vi.fn(),
  setupAutoUpdater: vi.fn(),
  startUpdateCheckInterval: vi.fn(() => vi.fn()),
  clampWindowStateToVisibleDisplay: vi.fn((state) => state),
}));
vi.mock("../deep-link.js", () => ({ registerDeepLinkProtocol: vi.fn(), setupDeepLinkHandler: vi.fn() }));
vi.mock("../local-runtime.js", () => ({ LocalRuntimeManager: mocks.LocalRuntimeManager }));
vi.mock("../shell-settings.js", () => ({
  readShellSettings: mocks.readShellSettings,
  writeShellSettings: mocks.writeShellSettings,
}));

describe("main local mode", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.appHandlers.clear();
    mocks.readShellSettings.mockResolvedValue({ ...mocks.DEFAULT_SHELL_SETTINGS });
    mocks.loadDesktopLaunchMode.mockResolvedValue("choose");
    delete process.env.FUSION_DESKTOP_MODE;
  });

  it("starts local runtime manager when FUSION_DESKTOP_MODE is local", async () => {
    process.env.FUSION_DESKTOP_MODE = "local";
    const { initializeApp } = await import("../main.ts");
    await initializeApp();

    expect(mocks.LocalRuntimeManager).toHaveBeenCalledWith({ rootDir: "/mock/home" });
    expect(mocks.app.getPath).toHaveBeenCalledWith("home");
    expect(mocks.localRuntimeManager.startLocal).toHaveBeenCalled();
    delete process.env.FUSION_DESKTOP_MODE;
  });

  /*
   * FNXC:DesktopRuntimeMode 2026-07-02-14:35 — regression for the "hangs at Starting
   * local Fusion runtime" bug. Split-brain persisted state: the launch-mode file says
   * "choose" (so main would not start the runtime) while shell-connections.json records a
   * completed "local" selection (so the renderer gate waits for the runtime). Before the
   * fix the runtime was never started and the gate polled until a 30s timeout on EVERY
   * launch. initializeApp must reconcile: treat the completed shell "local" as authoritative,
   * heal the launch-mode file, and start the runtime.
   */
  it("reconciles a launch-mode/shell split-brain and starts the runtime (no FUSION_DESKTOP_MODE)", async () => {
    mocks.loadDesktopLaunchMode.mockResolvedValue("choose");
    mocks.readShellSettings.mockResolvedValue({
      desktopMode: "local",
      hasCompletedModeSelection: true,
      activeProfileId: null,
      profiles: [],
    });

    const { initializeApp } = await import("../main.ts");
    await initializeApp();

    // Runtime is started despite launch-mode being "choose" ...
    expect(mocks.localRuntimeManager.startLocal).toHaveBeenCalled();
    // ... and the launch-mode file is healed to "local" so both sources agree next launch.
    expect(mocks.saveDesktopLaunchMode).toHaveBeenCalledWith("local");
  });

  it("does NOT start the runtime when both sources agree on choose (first run / no selection)", async () => {
    mocks.loadDesktopLaunchMode.mockResolvedValue("choose");
    mocks.readShellSettings.mockResolvedValue({ ...mocks.DEFAULT_SHELL_SETTINGS });

    const { initializeApp } = await import("../main.ts");
    await initializeApp();

    expect(mocks.localRuntimeManager.startLocal).not.toHaveBeenCalled();
  });
});
