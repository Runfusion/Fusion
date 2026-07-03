import { contextBridge, ipcRenderer } from "electron";
import type { DeepLinkResult, FusionAPI, SystemInfo, UpdateCheckResult } from "./types";

interface ShellConnectionProfile {
  id: string;
  name: string;
  serverUrl: string;
  authToken?: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

interface ShellConnectionProfileInput {
  id?: string;
  name: string;
  serverUrl: string;
  authToken?: string | null;
}

interface ShellConnectionState {
  host: "web" | "mobile-shell" | "desktop-shell";
  desktopModeState?: {
    isFirstRun: boolean;
    desktopMode: "local" | "remote" | null;
  };
  desktopMode?: "local" | "remote";
  activeProfileId: string | null;
  profiles: ShellConnectionProfile[];
  localRuntime?: {
    source: "embedded-local" | "external-cli" | "none";
    state: "stopped" | "starting" | "running" | "error";
    port?: number;
    baseUrl?: string;
    error?: string;
  };
}

export type FusionDesktopAPI = FusionAPI;

type WindowControlAction = "minimize" | "maximize" | "close" | "isMaximized";

const electronApi = {
  // Window control
  minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  maximize: (): Promise<boolean> => ipcRenderer.invoke("window:maximize"),
  close: (): Promise<void> => ipcRenderer.invoke("window:close"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),

  // App info
  getSystemInfo: (): Promise<SystemInfo> => ipcRenderer.invoke("app:getSystemInfo"),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke("app:checkForUpdates"),
  getServerPort: (): Promise<number | undefined> => ipcRenderer.invoke("app:getServerPort"),
  getDesktopRuntimeStatus: (): Promise<ShellConnectionState["localRuntime"]> => ipcRenderer.invoke("desktopRuntime:getStatus"),
  startDesktopLocalRuntime: (): Promise<ShellConnectionState["localRuntime"]> => ipcRenderer.invoke("desktopRuntime:startLocal"),
  stopDesktopLocalRuntime: (): Promise<ShellConnectionState["localRuntime"]> => ipcRenderer.invoke("desktopRuntime:stopLocal"),
  getDesktopLaunchMode: (): Promise<"choose" | "local" | "remote"> => ipcRenderer.invoke("desktopLaunchMode:getMode"),
  setDesktopLaunchMode: (mode: "choose" | "local" | "remote"): Promise<"choose" | "local" | "remote"> =>
    ipcRenderer.invoke("desktopLaunchMode:setMode", mode),
  getDesktopLaunchContext: (): Promise<{ mode: "remote"; profileId: string; serverBaseUrl: string; serverLabel?: string; authToken?: string } | null> =>
    ipcRenderer.invoke("desktopLaunchMode:getContext"),
  openConnectionManager: (): Promise<void> => ipcRenderer.invoke("shell:openConnectionManager"),

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

  windowControl: async (action: WindowControlAction): Promise<boolean | void> => {
    switch (action) {
      case "minimize":
        return ipcRenderer.invoke("window:minimize");
      case "maximize":
        return ipcRenderer.invoke("window:maximize");
      case "close":
        return ipcRenderer.invoke("window:close");
      case "isMaximized":
        return ipcRenderer.invoke("window:isMaximized");
    }
  },
  getPlatform: (): Promise<"darwin" | "win32" | "linux"> => ipcRenderer.invoke("platform:get"),
  apiRequest: (method: string, path: string, body?: unknown): Promise<unknown> =>
    ipcRenderer.invoke("api-request", { method, path, body }),

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
  onUpdateNotAvailable: (callback: (info: { version?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { version?: string }) => callback(info);
    ipcRenderer.on("update-not-available", handler);
    return () => ipcRenderer.removeListener("update-not-available", handler);
  },
  onUpdateError: (callback: (info: { message: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { message: string }) => callback(info);
    ipcRenderer.on("update-error", handler);
    return () => ipcRenderer.removeListener("update-error", handler);
  },
  invoke: (channel: string, payload?: unknown): Promise<unknown> => ipcRenderer.invoke(channel, payload),
};

const fusionShell = {
  getState: (): Promise<ShellConnectionState> => ipcRenderer.invoke("shell:getState"),
  listProfiles: (): Promise<ShellConnectionProfile[]> => ipcRenderer.invoke("shell:listProfiles"),
  saveProfile: (profile: ShellConnectionProfileInput): Promise<ShellConnectionProfile> => ipcRenderer.invoke("shell:saveProfile", profile),
  deleteProfile: (profileId: string): Promise<void> => ipcRenderer.invoke("shell:deleteProfile", profileId),
  setActiveProfile: (profileId: string | null): Promise<ShellConnectionState> => ipcRenderer.invoke("shell:setActiveProfile", profileId),
  getDesktopModeState: (): Promise<{ isFirstRun: boolean; desktopMode: "local" | "remote" | null }> =>
    ipcRenderer.invoke("shell:getDesktopModeState"),
  setDesktopMode: (mode: "local" | "remote"): Promise<ShellConnectionState> => ipcRenderer.invoke("shell:setDesktopMode", mode),
  resetDesktopMode: (): Promise<ShellConnectionState> => ipcRenderer.invoke("shell:resetDesktopMode"),
  onResetDesktopModeRequest: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on("shell:reset-desktop-mode-request", handler);
    return () => ipcRenderer.removeListener("shell:reset-desktop-mode-request", handler);
  },
  startQrScan: (): Promise<{ serverUrl: string; authToken?: string | null }> => ipcRenderer.invoke("shell:startQrScan"),
  openConnectionManager: (): Promise<void> => ipcRenderer.invoke("shell:openConnectionManager"),
  subscribe: (listener: (state: ShellConnectionState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ShellConnectionState) => listener(state);
    ipcRenderer.on("shell:state", handler);
    return () => ipcRenderer.removeListener("shell:state", handler);
  },
};

/*
FNXC:DesktopShell 2026-07-03-12:10:
Bridge the main-process "open connection manager" request into a window DOM event. The header
"Switch server" / "Manage connections" button (ShellConnectionStatus) calls
`fusionShell.openConnectionManager()`, which invokes the `shell:openConnectionManager` IPC; main then
round-trips back via `webContents.send("shell:open-connection-manager")` (ipc.ts). The renderer's
ShellContext listens with `window.addEventListener("shell:open-connection-manager")` to raise
`openConnectionManagerSignal` and open NativeShellConnectionManager. Without this forwarder the IPC
event was dropped, so clicking "Switch server" in Desktop local mode did nothing. DOM events dispatched
on the shared window cross the isolated-preload → page-world boundary, so the page listener fires.
Re-registered on every navigation (including the handoff to the http runtime origin) because the
preload re-runs per page load.
*/
ipcRenderer.on("shell:open-connection-manager", () => {
  window.dispatchEvent(new Event("shell:open-connection-manager"));
});

contextBridge.exposeInMainWorld("electronAPI", electronApi);
contextBridge.exposeInMainWorld("fusionAPI", electronApi);
contextBridge.exposeInMainWorld("fusionShell", fusionShell);
