declare module "electron-updater" {
  export interface UpdateInfo {
    version?: string;
    [key: string]: unknown;
  }

  export interface AutoUpdater {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    on(event: "update-available", listener: (info: UpdateInfo) => void): this;
    on(event: "update-downloaded", listener: (info: UpdateInfo) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    checkForUpdates(): Promise<unknown>;
  }

  export const autoUpdater: AutoUpdater;
}
