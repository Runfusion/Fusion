import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const browserWindowInstance = {
    loadURL: vi.fn(),
    on: vi.fn(),
    isVisible: vi.fn(() => true),
    show: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
  };

  const BrowserWindow = vi.fn(() => browserWindowInstance) as unknown as {
    (...args: unknown[]): typeof browserWindowInstance;
    getAllWindows: () => unknown[];
  };
  BrowserWindow.getAllWindows = vi.fn(() => []);

  const app = {
    whenReady: vi.fn(() => Promise.resolve()),
    getVersion: vi.fn(() => "0.1.0"),
    quit: vi.fn(),
    on: vi.fn(),
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
  };

  const Tray = vi.fn(() => trayInstance);
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

  return {
    app,
    BrowserWindow,
    ipcMain,
    trayInstance,
    Tray,
    Menu,
    nativeImage,
    shell,
    browserWindowInstance,
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
}));

async function importMainModule() {
  return import("../main.ts");
}

describe("main process", () => {
  const originalDashboardUrl = process.env.FUSION_DASHBOARD_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    if (originalDashboardUrl === undefined) {
      delete process.env.FUSION_DASHBOARD_URL;
    } else {
      process.env.FUSION_DASHBOARD_URL = originalDashboardUrl;
    }
  });

  it("DASHBOARD_URL defaults to localhost:4040", async () => {
    delete process.env.FUSION_DASHBOARD_URL;

    const { DASHBOARD_URL } = await importMainModule();

    expect(DASHBOARD_URL).toBe("http://localhost:4040");
  });

  it("DASHBOARD_URL uses env override", async () => {
    process.env.FUSION_DASHBOARD_URL = "http://localhost:5050";

    const { DASHBOARD_URL } = await importMainModule();

    expect(DASHBOARD_URL).toBe("http://localhost:5050");
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
    expect(options.webPreferences.preload).toContain("preload.ts");
  });

  it("createMainWindow loads the dashboard URL", async () => {
    const { createMainWindow, DASHBOARD_URL } = await importMainModule();

    createMainWindow();

    expect(mocks.browserWindowInstance.loadURL).toHaveBeenCalledWith(DASHBOARD_URL);
  });

  it("registerIpcHandlers registers app:get-version via handle", async () => {
    const { registerIpcHandlers } = await importMainModule();

    registerIpcHandlers();

    expect(mocks.ipcMain.handle).toHaveBeenCalledWith(
      "app:get-version",
      expect.any(Function),
    );
  });

  it("registerIpcHandlers registers app:quit via on", async () => {
    const { registerIpcHandlers } = await importMainModule();

    registerIpcHandlers();

    expect(mocks.ipcMain.on).toHaveBeenCalledWith("app:quit", expect.any(Function));
  });

  it("importing main does not auto-start", async () => {
    await importMainModule();

    expect(mocks.app.whenReady).not.toHaveBeenCalled();
  });

  it("setupTray configures tray interactions with provided tray instance", async () => {
    const { setupTray } = await importMainModule();

    setupTray(mocks.browserWindowInstance as never, mocks.trayInstance as never);

    expect(mocks.nativeImage.createFromPath).toHaveBeenCalledTimes(1);
    expect(mocks.trayInstance.setImage).toHaveBeenCalledTimes(1);
    expect(mocks.trayInstance.setToolTip).toHaveBeenCalledWith("Fusion — Running");
    expect(mocks.Menu.buildFromTemplate).toHaveBeenCalledTimes(1);

    const closeCall = mocks.browserWindowInstance.on.mock.calls.find(
      (call) => call[0] === "close",
    );
    expect(closeCall).toBeDefined();

    const closeHandler = closeCall?.[1] as (event: { preventDefault: () => void }) => void;
    const event = { preventDefault: vi.fn() };

    closeHandler(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.browserWindowInstance.hide).toHaveBeenCalledTimes(1);
  });
});
