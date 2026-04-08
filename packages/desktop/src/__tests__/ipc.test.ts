import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  };

  const app = {
    getVersion: vi.fn(() => "1.2.3"),
  };

  const updateTrayStatus = vi.fn();
  const showExportSettingsDialog = vi.fn();
  const showImportSettingsDialog = vi.fn();
  const setupAutoUpdater = vi.fn();

  return {
    ipcMain,
    ipcHandlers,
    app,
    updateTrayStatus,
    showExportSettingsDialog,
    showImportSettingsDialog,
    setupAutoUpdater,
  };
});

vi.mock("electron", () => ({
  ipcMain: mocks.ipcMain,
  app: mocks.app,
}));

vi.mock("../tray.js", () => ({
  updateTrayStatus: mocks.updateTrayStatus,
}));

vi.mock("../native.js", () => ({
  showExportSettingsDialog: mocks.showExportSettingsDialog,
  showImportSettingsDialog: mocks.showImportSettingsDialog,
  setupAutoUpdater: mocks.setupAutoUpdater,
}));

function createWindowMock() {
  return {
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(() => false),
  };
}

function createTrayMock() {
  return {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
  };
}

async function registerHandlers() {
  const { registerIpcHandlers } = await import("../ipc.ts");
  const window = createWindowMock();
  const tray = createTrayMock();
  registerIpcHandlers(window as never, tray as never);
  return { window, tray };
}

describe("ipc handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.ipcHandlers.clear();
    mocks.app.getVersion.mockReturnValue("1.2.3");
    mocks.setupAutoUpdater.mockImplementation(() => undefined);
    mocks.showExportSettingsDialog.mockResolvedValue(null);
    mocks.showImportSettingsDialog.mockResolvedValue(null);
  });

  it("registers all expected channels", async () => {
    await registerHandlers();

    const channels = new Set(mocks.ipcMain.handle.mock.calls.map(([channel]) => channel));

    expect(channels).toEqual(new Set([
      "window:minimize",
      "window:maximize",
      "window:close",
      "window:isMaximized",
      "app:getSystemInfo",
      "app:checkForUpdates",
      "tray:updateStatus",
      "native:showExportDialog",
      "native:showImportDialog",
    ]));
  });

  it("window:minimize calls mainWindow.minimize", async () => {
    const { window } = await registerHandlers();

    const handler = mocks.ipcHandlers.get("window:minimize");
    await handler?.({});

    expect(window.minimize).toHaveBeenCalledTimes(1);
  });

  it("window:maximize maximizes when currently unmaximized", async () => {
    const { window } = await registerHandlers();
    window.isMaximized.mockReturnValue(false);

    const handler = mocks.ipcHandlers.get("window:maximize");
    const result = await handler?.({});

    expect(window.maximize).toHaveBeenCalledTimes(1);
    expect(window.unmaximize).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("window:maximize restores when currently maximized", async () => {
    const { window } = await registerHandlers();
    window.isMaximized.mockReturnValue(true);

    const handler = mocks.ipcHandlers.get("window:maximize");
    const result = await handler?.({});

    expect(window.unmaximize).toHaveBeenCalledTimes(1);
    expect(window.maximize).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it("window:close calls mainWindow.close", async () => {
    const { window } = await registerHandlers();

    const handler = mocks.ipcHandlers.get("window:close");
    await handler?.({});

    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it("window:isMaximized returns current maximized state", async () => {
    const { window } = await registerHandlers();
    window.isMaximized.mockReturnValue(true);

    const handler = mocks.ipcHandlers.get("window:isMaximized");
    const result = await handler?.({});

    expect(result).toBe(true);
  });

  it("app:getSystemInfo returns process and app metadata", async () => {
    await registerHandlers();

    const handler = mocks.ipcHandlers.get("app:getSystemInfo");
    const result = await handler?.({});

    expect(result).toEqual({
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      appVersion: "1.2.3",
    });
  });

  it("app:checkForUpdates calls setupAutoUpdater and returns checking", async () => {
    const { window } = await registerHandlers();

    const handler = mocks.ipcHandlers.get("app:checkForUpdates");
    const result = await handler?.({});

    expect(mocks.setupAutoUpdater).toHaveBeenCalledWith(window);
    expect(result).toEqual({ status: "checking" });
  });

  it("app:checkForUpdates returns error when updater throws", async () => {
    await registerHandlers();
    mocks.setupAutoUpdater.mockImplementationOnce(() => {
      throw new Error("updater failed");
    });

    const handler = mocks.ipcHandlers.get("app:checkForUpdates");
    const result = await handler?.({});

    expect(result).toEqual({ status: "error", error: "updater failed" });
  });

  it("native:showExportDialog calls showExportSettingsDialog with mainWindow", async () => {
    const { window } = await registerHandlers();
    mocks.showExportSettingsDialog.mockResolvedValueOnce("/path/to/file.json");

    const handler = mocks.ipcHandlers.get("native:showExportDialog");
    const result = await handler?.({});

    expect(mocks.showExportSettingsDialog).toHaveBeenCalledWith(window);
    expect(result).toBe("/path/to/file.json");
  });

  it("native:showImportDialog calls showImportSettingsDialog with mainWindow", async () => {
    const { window } = await registerHandlers();
    mocks.showImportSettingsDialog.mockResolvedValueOnce(null);

    const handler = mocks.ipcHandlers.get("native:showImportDialog");
    const result = await handler?.({});

    expect(mocks.showImportSettingsDialog).toHaveBeenCalledWith(window);
    expect(result).toBeNull();
  });

  it("tray:updateStatus forwards status and tray instance", async () => {
    const { tray } = await registerHandlers();

    const handler = mocks.ipcHandlers.get("tray:updateStatus");
    await handler?.({}, "paused");

    expect(mocks.updateTrayStatus).toHaveBeenCalledWith(tray, "paused");
  });
});
