export interface SystemInfo {
  platform: string;
  arch: string;
  electronVersion: string;
  nodeVersion: string;
  appVersion: string;
}

export interface UpdateCheckResult {
  status: "checking" | "error";
  error?: string;
}

export interface DeepLinkResult {
  type: "task" | "project" | "unknown";
  id: string;
  raw: string;
}

export interface FusionAPI {
  // Window control
  minimize(): Promise<void>;
  maximize(): Promise<boolean>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;

  // App info
  getSystemInfo(): Promise<SystemInfo>;
  checkForUpdates(): Promise<UpdateCheckResult>;

  // Tray status
  updateTrayStatus(status: string): Promise<void>;

  // Native dialogs
  showExportDialog(): Promise<string | null>;
  showImportDialog(): Promise<string | null>;

  // Deep link events
  onDeepLink(callback: (result: DeepLinkResult) => void): () => void;

  // Auto-updater events
  onUpdateAvailable(callback: (info: { version: string }) => void): () => void;
  onUpdateDownloaded(callback: () => void): () => void;
}

declare global {
  interface Window {
    fusionAPI: FusionAPI;
  }
}
