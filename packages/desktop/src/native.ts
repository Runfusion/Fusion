import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Notification,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import { autoUpdater } from "electron-updater";

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1280,
  height: 900,
  isMaximized: false,
};

interface DesktopNotificationOptions {
  silent?: boolean;
  onClick?: () => void;
}

function generateSettingsExportFilename(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");

  return `fusion-settings-${year}-${month}-${day}-${hours}${minutes}${seconds}.json`;
}

function getWindowStatePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

function isValidWindowState(value: unknown): value is WindowState {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<WindowState>;
  const hasValidPosition =
    (candidate.x === undefined || typeof candidate.x === "number") &&
    (candidate.y === undefined || typeof candidate.y === "number");

  return (
    hasValidPosition &&
    typeof candidate.width === "number" &&
    Number.isFinite(candidate.width) &&
    typeof candidate.height === "number" &&
    Number.isFinite(candidate.height) &&
    typeof candidate.isMaximized === "boolean"
  );
}

export async function showExportSettingsDialog(parentWindow?: BrowserWindow): Promise<string | null> {
  const filename = generateSettingsExportFilename();
  const defaultPath = join(app.getPath("documents"), filename);
  const dialogOptions: SaveDialogOptions = {
    title: "Export Fusion Settings",
    defaultPath,
    filters: [{ name: "JSON Files", extensions: ["json"] }],
  };

  const result = parentWindow
    ? await dialog.showSaveDialog(parentWindow, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);

  if (result.canceled || !result.filePath) {
    return null;
  }

  return result.filePath;
}

export async function showImportSettingsDialog(parentWindow?: BrowserWindow): Promise<string | null> {
  const dialogOptions: OpenDialogOptions = {
    title: "Import Fusion Settings",
    properties: ["openFile"],
    filters: [{ name: "JSON Files", extensions: ["json"] }],
  };

  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0] ?? null;
}

export function showDesktopNotification(
  title: string,
  body: string,
  options: DesktopNotificationOptions = {},
): void {
  if (!Notification.isSupported()) {
    console.warn("[desktop/native] Notifications are not supported in this environment");
    return;
  }

  try {
    const notification = new Notification({
      title,
      body,
      silent: options.silent,
    });

    if (options.onClick) {
      notification.on("click", options.onClick);
    }

    notification.show();
  } catch (error) {
    console.error("[desktop/native] Failed to display desktop notification", error);
  }
}

export function setupAutoUpdater(mainWindow?: BrowserWindow): void {
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      showDesktopNotification("Fusion Update Available", "Update available — downloading in background", {
        silent: true,
      });
      mainWindow?.webContents.send("update-available", info);
    });

    autoUpdater.on("update-downloaded", (info) => {
      showDesktopNotification("Fusion Update Ready", "Update ready — will install on quit", {
        silent: true,
      });
      mainWindow?.webContents.send("update-downloaded", info);
    });

    autoUpdater.on("error", (error) => {
      console.error("[desktop/native] Auto-updater error", error);
    });

    void autoUpdater.checkForUpdates().catch((error) => {
      console.error("[desktop/native] Auto-updater check failed", error);
    });
  } catch (error) {
    console.error("[desktop/native] Auto-updater unavailable", error);
  }
}

export async function loadWindowState(): Promise<WindowState | null> {
  const statePath = getWindowStatePath();

  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (!isValidWindowState(parsed)) {
      return null;
    }

    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    return null;
  }
}

export function saveWindowState(mainWindow: BrowserWindow): void {
  if (mainWindow.isDestroyed()) {
    return;
  }

  const bounds = mainWindow.getBounds();
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: mainWindow.isMaximized(),
  };

  const statePath = getWindowStatePath();
  const tempPath = `${statePath}.tmp`;

  void writeFile(tempPath, JSON.stringify(state, null, 2), "utf-8")
    .then(() => rename(tempPath, statePath))
    .catch((error) => {
      console.error("[desktop/native] Failed to save window state", error);
    });
}
