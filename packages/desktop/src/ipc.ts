import { app, type BrowserWindow, ipcMain, type Tray } from "electron";
import { setupAutoUpdater, showExportSettingsDialog, showImportSettingsDialog } from "./native.js";
import { type EngineStatus, updateTrayStatus } from "./tray.js";

export function registerIpcHandlers(mainWindow: BrowserWindow, tray: Tray): void {
  ipcMain.handle("window:minimize", () => {
    mainWindow.minimize();
  });

  ipcMain.handle("window:maximize", () => {
    const isCurrentlyMaximized = mainWindow.isMaximized();
    if (isCurrentlyMaximized) {
      mainWindow.unmaximize();
      return false;
    }

    mainWindow.maximize();
    return true;
  });

  ipcMain.handle("window:close", () => {
    mainWindow.close();
  });

  ipcMain.handle("window:isMaximized", () => mainWindow.isMaximized());

  ipcMain.handle("app:getSystemInfo", () => ({
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    appVersion: app.getVersion(),
  }));

  ipcMain.handle("app:checkForUpdates", () => {
    try {
      setupAutoUpdater(mainWindow);
      return { status: "checking" as const };
    } catch (error) {
      return {
        status: "error" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("tray:updateStatus", (_event, status: EngineStatus) => {
    updateTrayStatus(tray, status);
  });

  ipcMain.handle("native:showExportDialog", () => showExportSettingsDialog(mainWindow));
  ipcMain.handle("native:showImportDialog", () => showImportSettingsDialog(mainWindow));
}
