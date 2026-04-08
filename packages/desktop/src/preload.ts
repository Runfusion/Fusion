import { contextBridge, ipcRenderer } from "electron";
import type { DeepLinkResult, FusionAPI, SystemInfo, UpdateCheckResult } from "./types";

export type FusionDesktopAPI = FusionAPI;

contextBridge.exposeInMainWorld("fusionAPI", {
  // Window control
  minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  maximize: (): Promise<boolean> => ipcRenderer.invoke("window:maximize"),
  close: (): Promise<void> => ipcRenderer.invoke("window:close"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),

  // App info
  getSystemInfo: (): Promise<SystemInfo> => ipcRenderer.invoke("app:getSystemInfo"),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke("app:checkForUpdates"),

  // Tray status
  updateTrayStatus: (status: string): Promise<void> => ipcRenderer.invoke("tray:updateStatus", status),

  // Native dialogs
  showExportDialog: (): Promise<string | null> => ipcRenderer.invoke("native:showExportDialog"),
  showImportDialog: (): Promise<string | null> => ipcRenderer.invoke("native:showImportDialog"),

  // Deep link events (main → renderer)
  onDeepLink: (callback: (result: DeepLinkResult) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: DeepLinkResult) => callback(result);
    ipcRenderer.on("deep-link", handler);
    return () => ipcRenderer.removeListener("deep-link", handler);
  },

  // Auto-updater events (main → renderer)
  onUpdateAvailable: (callback: (info: { version: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { version: string }) => callback(info);
    ipcRenderer.on("update-available", handler);
    return () => ipcRenderer.removeListener("update-available", handler);
  },
  onUpdateDownloaded: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on("update-downloaded", handler);
    return () => ipcRenderer.removeListener("update-downloaded", handler);
  },
});
