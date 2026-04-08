import type { ElectronAPI } from "./renderer/types";

export interface FusionDesktopAPI {
  getAppVersion(): Promise<string>;
  quit(): void;
  onDashboardReady(callback: () => void): () => void;
}

declare global {
  interface Window {
    fusionDesktop: FusionDesktopAPI;
    electronAPI?: ElectronAPI;
  }
}
