import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const showSaveDialog = vi.fn();
  const showOpenDialog = vi.fn();

  const app = {
    getPath: vi.fn((name: string) => {
      if (name === "documents") return "/mock/documents";
      if (name === "userData") return "/mock/user-data";
      return "/mock/other";
    }),
  };

  const dialog = {
    showSaveDialog,
    showOpenDialog,
  };

  const notificationInstances: Array<{
    show: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    emit: (event: string) => void;
    options: Record<string, unknown>;
  }> = [];

  const Notification = vi.fn().mockImplementation((options: Record<string, unknown>) => {
    const listeners = new Map<string, () => void>();
    const instance = {
      show: vi.fn(),
      on: vi.fn((event: string, callback: () => void) => {
        listeners.set(event, callback);
      }),
      emit: (event: string) => {
        listeners.get(event)?.();
      },
      options,
    };

    notificationInstances.push(instance);
    return instance;
  });

  Object.assign(Notification, {
    isSupported: vi.fn(() => true),
  });

  const browserWindow = {
    webContents: {
      send: vi.fn(),
    },
    isDestroyed: vi.fn(() => false),
    getBounds: vi.fn(() => ({
      x: 40,
      y: 60,
      width: 1280,
      height: 900,
    })),
    isMaximized: vi.fn(() => false),
  };

  const updaterHandlers = new Map<string, (...args: unknown[]) => void>();
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      updaterHandlers.set(event, handler);
      return autoUpdater;
    }),
    checkForUpdates: vi.fn(() => Promise.resolve()),
  };

  const readFile = vi.fn();
  const writeFile = vi.fn(() => Promise.resolve());
  const rename = vi.fn(() => Promise.resolve());

  return {
    app,
    dialog,
    Notification,
    browserWindow,
    autoUpdater,
    updaterHandlers,
    notificationInstances,
    readFile,
    writeFile,
    rename,
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  dialog: mocks.dialog,
  Notification: mocks.Notification,
  BrowserWindow: vi.fn(() => mocks.browserWindow),
}));

vi.mock("electron-updater", () => ({
  autoUpdater: mocks.autoUpdater,
}));

vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  rename: mocks.rename,
}));

async function importNativeModule() {
  return import("../native.ts");
}

describe("native integrations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    vi.clearAllMocks();
    vi.resetModules();
    mocks.notificationInstances.length = 0;
    mocks.updaterHandlers.clear();
    mocks.autoUpdater.autoDownload = false;
    mocks.autoUpdater.autoInstallOnAppQuit = false;

    mocks.dialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: "/tmp/export.json",
    });

    mocks.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/import.json"],
    });

    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        x: 10,
        y: 20,
        width: 1400,
        height: 900,
        isMaximized: true,
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("showExportSettingsDialog", () => {
    it("calls showSaveDialog with JSON filter and generated filename", async () => {
      const { showExportSettingsDialog } = await importNativeModule();

      await showExportSettingsDialog();

      expect(mocks.dialog.showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: [{ name: "JSON Files", extensions: ["json"] }],
          defaultPath: "/mock/documents/fusion-settings-2026-01-01-000000.json",
        }),
      );
    });

    it("returns selected path when user picks a file", async () => {
      const { showExportSettingsDialog } = await importNativeModule();

      await expect(showExportSettingsDialog()).resolves.toBe("/tmp/export.json");
    });

    it("returns null when dialog is cancelled", async () => {
      const { showExportSettingsDialog } = await importNativeModule();
      mocks.dialog.showSaveDialog.mockResolvedValueOnce({
        canceled: true,
        filePath: undefined,
      });

      await expect(showExportSettingsDialog()).resolves.toBeNull();
    });

    it("returns null when filePath is missing", async () => {
      const { showExportSettingsDialog } = await importNativeModule();
      mocks.dialog.showSaveDialog.mockResolvedValueOnce({
        canceled: false,
        filePath: undefined,
      });

      await expect(showExportSettingsDialog()).resolves.toBeNull();
    });

    it("passes parent window to showSaveDialog", async () => {
      const { showExportSettingsDialog } = await importNativeModule();

      await showExportSettingsDialog(mocks.browserWindow as never);

      expect(mocks.dialog.showSaveDialog).toHaveBeenCalledWith(
        mocks.browserWindow,
        expect.any(Object),
      );
    });
  });

  describe("showImportSettingsDialog", () => {
    it("calls showOpenDialog with JSON filter and openFile property", async () => {
      const { showImportSettingsDialog } = await importNativeModule();

      await showImportSettingsDialog();

      expect(mocks.dialog.showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: ["openFile"],
          filters: [{ name: "JSON Files", extensions: ["json"] }],
        }),
      );
    });

    it("returns first selected path", async () => {
      const { showImportSettingsDialog } = await importNativeModule();

      await expect(showImportSettingsDialog()).resolves.toBe("/tmp/import.json");
    });

    it("returns null when dialog is cancelled", async () => {
      const { showImportSettingsDialog } = await importNativeModule();
      mocks.dialog.showOpenDialog.mockResolvedValueOnce({
        canceled: true,
        filePaths: [],
      });

      await expect(showImportSettingsDialog()).resolves.toBeNull();
    });

    it("returns null when no file paths are returned", async () => {
      const { showImportSettingsDialog } = await importNativeModule();
      mocks.dialog.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: [],
      });

      await expect(showImportSettingsDialog()).resolves.toBeNull();
    });
  });

  describe("showDesktopNotification", () => {
    it("creates a notification and shows it", async () => {
      const { showDesktopNotification } = await importNativeModule();

      showDesktopNotification("Title", "Body");

      expect(mocks.Notification).toHaveBeenCalledWith({
        title: "Title",
        body: "Body",
        silent: undefined,
      });
      expect(mocks.notificationInstances[0]?.show).toHaveBeenCalledTimes(1);
    });

    it("passes silent option to Notification", async () => {
      const { showDesktopNotification } = await importNativeModule();

      showDesktopNotification("Title", "Body", { silent: true });

      expect(mocks.Notification).toHaveBeenCalledWith({
        title: "Title",
        body: "Body",
        silent: true,
      });
    });

    it("guards unsupported environments", async () => {
      const { showDesktopNotification } = await importNativeModule();
      (mocks.Notification.isSupported as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

      expect(() => showDesktopNotification("Title", "Body")).not.toThrow();
      expect(mocks.Notification).not.toHaveBeenCalled();
    });

    it("wires click callback", async () => {
      const { showDesktopNotification } = await importNativeModule();
      const onClick = vi.fn();

      showDesktopNotification("Title", "Body", { onClick });
      mocks.notificationInstances[0]?.emit("click");

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("swallows constructor errors and does not throw", async () => {
      const { showDesktopNotification } = await importNativeModule();
      const original = mocks.Notification.getMockImplementation();
      mocks.Notification.mockImplementationOnce(() => {
        throw new Error("boom");
      });

      expect(() => showDesktopNotification("Title", "Body")).not.toThrow();

      mocks.Notification.mockImplementation(original ?? (() => ({})));
    });
  });

  describe("setupAutoUpdater", () => {
    it("sets updater download and install flags", async () => {
      const { setupAutoUpdater } = await importNativeModule();

      setupAutoUpdater(mocks.browserWindow as never);

      expect(mocks.autoUpdater.autoDownload).toBe(true);
      expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
    });

    it("registers updater listeners and checks for updates", async () => {
      const { setupAutoUpdater } = await importNativeModule();

      setupAutoUpdater(mocks.browserWindow as never);

      expect(mocks.autoUpdater.on).toHaveBeenCalledWith("update-available", expect.any(Function));
      expect(mocks.autoUpdater.on).toHaveBeenCalledWith("update-downloaded", expect.any(Function));
      expect(mocks.autoUpdater.on).toHaveBeenCalledWith("error", expect.any(Function));
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("update-available triggers notification and renderer IPC", async () => {
      const { setupAutoUpdater } = await importNativeModule();

      setupAutoUpdater(mocks.browserWindow as never);
      mocks.updaterHandlers.get("update-available")?.({ version: "1.2.0" });

      const latestNotification = mocks.notificationInstances.at(-1);
      expect(latestNotification?.options).toMatchObject({
        title: "Fusion Update Available",
      });
      expect(mocks.browserWindow.webContents.send).toHaveBeenCalledWith(
        "update-available",
        expect.objectContaining({ version: "1.2.0" }),
      );
    });

    it("update-downloaded triggers notification and renderer IPC", async () => {
      const { setupAutoUpdater } = await importNativeModule();

      setupAutoUpdater(mocks.browserWindow as never);
      mocks.updaterHandlers.get("update-downloaded")?.({ version: "1.2.0" });

      const latestNotification = mocks.notificationInstances.at(-1);
      expect(latestNotification?.options).toMatchObject({
        title: "Fusion Update Ready",
      });
      expect(mocks.browserWindow.webContents.send).toHaveBeenCalledWith(
        "update-downloaded",
        expect.objectContaining({ version: "1.2.0" }),
      );
    });

    it("error handler does not crash", async () => {
      const { setupAutoUpdater } = await importNativeModule();

      setupAutoUpdater(mocks.browserWindow as never);

      expect(() => mocks.updaterHandlers.get("error")?.(new Error("network"))).not.toThrow();
    });

    it("catches checkForUpdates rejection", async () => {
      const { setupAutoUpdater } = await importNativeModule();
      mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error("dev mode"));

      expect(() => setupAutoUpdater(mocks.browserWindow as never)).not.toThrow();
      await Promise.resolve();
    });

    it("wraps setup in try/catch when updater throws during registration", async () => {
      const { setupAutoUpdater } = await importNativeModule();
      mocks.autoUpdater.on.mockImplementationOnce(() => {
        throw new Error("not supported in dev");
      });

      expect(() => setupAutoUpdater(mocks.browserWindow as never)).not.toThrow();
    });
  });

  describe("window state", () => {
    it("loadWindowState returns parsed state", async () => {
      const { loadWindowState } = await importNativeModule();

      await expect(loadWindowState()).resolves.toEqual({
        x: 10,
        y: 20,
        width: 1400,
        height: 900,
        isMaximized: true,
      });
    });

    it("loadWindowState returns null when file does not exist", async () => {
      const { loadWindowState } = await importNativeModule();
      mocks.readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      await expect(loadWindowState()).resolves.toBeNull();
    });

    it("loadWindowState returns null for invalid JSON", async () => {
      const { loadWindowState } = await importNativeModule();
      mocks.readFile.mockResolvedValueOnce("not-json");

      await expect(loadWindowState()).resolves.toBeNull();
    });

    it("loadWindowState returns null for invalid schema", async () => {
      const { loadWindowState } = await importNativeModule();
      mocks.readFile.mockResolvedValueOnce(JSON.stringify({ width: "bad" }));

      await expect(loadWindowState()).resolves.toBeNull();
    });

    it("uses userData path for window-state.json", async () => {
      const { loadWindowState } = await importNativeModule();

      await loadWindowState();

      expect(mocks.readFile).toHaveBeenCalledWith("/mock/user-data/window-state.json", "utf-8");
    });

    it("saveWindowState writes temp file and renames atomically", async () => {
      const { saveWindowState } = await importNativeModule();

      saveWindowState(mocks.browserWindow as never);
      await Promise.resolve();

      expect(mocks.writeFile).toHaveBeenCalledWith(
        "/mock/user-data/window-state.json.tmp",
        expect.any(String),
        "utf-8",
      );
      expect(mocks.rename).toHaveBeenCalledWith(
        "/mock/user-data/window-state.json.tmp",
        "/mock/user-data/window-state.json",
      );
    });

    it("saveWindowState captures bounds and maximized state", async () => {
      const { saveWindowState } = await importNativeModule();
      mocks.browserWindow.isMaximized.mockReturnValueOnce(true);

      saveWindowState(mocks.browserWindow as never);
      await Promise.resolve();

      const payload = mocks.writeFile.mock.calls[0]?.[1] as string;
      expect(JSON.parse(payload)).toEqual({
        x: 40,
        y: 60,
        width: 1280,
        height: 900,
        isMaximized: true,
      });
    });

    it("saveWindowState skips destroyed windows", async () => {
      const { saveWindowState } = await importNativeModule();
      mocks.browserWindow.isDestroyed.mockReturnValueOnce(true);

      saveWindowState(mocks.browserWindow as never);

      expect(mocks.writeFile).not.toHaveBeenCalled();
      expect(mocks.rename).not.toHaveBeenCalled();
    });

    it("DEFAULT_WINDOW_STATE has expected fallback dimensions", async () => {
      const { DEFAULT_WINDOW_STATE } = await importNativeModule();

      expect(DEFAULT_WINDOW_STATE).toEqual({
        width: 1280,
        height: 900,
        isMaximized: false,
      });
    });
  });
});
