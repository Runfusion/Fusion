export type DesktopPlatform = "darwin" | "win32" | "linux";

export type WindowControlAction = "minimize" | "maximize" | "close" | "isMaximized";

export interface ElectronApiRequestPayload {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  port?: number;
}

export interface ElectronApiResponsePayload {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  data?: unknown;
  error?: string;
}

export interface ElectronAPI {
  invoke?: (channel: string, payload?: unknown) => Promise<unknown>;
  apiRequest?: (method: string, path: string, body?: unknown) => Promise<ElectronApiResponsePayload>;
  getServerPort?: () => Promise<number>;
  windowControl?: (action: WindowControlAction) => Promise<boolean | void>;
  onUpdateAvailable?: (callback: (info: Record<string, unknown>) => void) => (() => void) | void;
  installUpdate?: () => Promise<void>;
  onDeepLink?: (callback: (url: string) => void) => (() => void) | void;
  getPlatform?: () => Promise<DesktopPlatform>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
