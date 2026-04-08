import { contextBridge, ipcRenderer } from "electron";
import type { ElectronAPI, ElectronApiResponsePayload, WindowControlAction } from "./renderer/types";

export interface FusionDesktopAPI {
  getAppVersion(): Promise<string>;
  quit(): void;
  onDashboardReady(callback: () => void): () => void;
}

const fusionDesktop: FusionDesktopAPI = {
  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke("app:get-version");
  },
  quit(): void {
    ipcRenderer.send("app:quit");
  },
  onDashboardReady(callback: () => void): () => void {
    const listener = () => callback();
    ipcRenderer.on("dashboard:ready", listener);
    return () => {
      ipcRenderer.removeListener("dashboard:ready", listener);
    };
  },
};

const electronAPI: ElectronAPI = {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    return ipcRenderer.invoke(channel, payload);
  },
  apiRequest(method: string, path: string, body?: unknown): Promise<ElectronApiResponsePayload> {
    return ipcRenderer.invoke("api-request", { method, path, body });
  },
  getServerPort(): Promise<number> {
    return ipcRenderer.invoke("server:get-port");
  },
  windowControl(action: WindowControlAction): Promise<boolean | void> {
    return ipcRenderer.invoke("window:control", action);
  },
  onUpdateAvailable(callback: (info: Record<string, unknown>) => void): () => void {
    const listener = (_event: unknown, info: Record<string, unknown>) => {
      callback(info);
    };
    ipcRenderer.on("update:available", listener);
    return () => {
      ipcRenderer.removeListener("update:available", listener);
    };
  },
  installUpdate(): Promise<void> {
    return ipcRenderer.invoke("update:install");
  },
  onDeepLink(callback: (url: string) => void): () => void {
    const listener = (_event: unknown, url: string) => {
      callback(url);
    };
    ipcRenderer.on("deep-link", listener);
    return () => {
      ipcRenderer.removeListener("deep-link", listener);
    };
  },
  getPlatform() {
    return ipcRenderer.invoke("system:get-platform");
  },
};

contextBridge.exposeInMainWorld("fusionDesktop", fusionDesktop);
contextBridge.exposeInMainWorld("electronAPI", electronAPI);
