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

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface DisplayWorkAreaLike {
  workArea: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

const MIN_VISIBLE_OVERLAP_PX = 64;

export function clampWindowStateToVisibleDisplay(
  state: WindowState,
  displays: DisplayWorkAreaLike[],
): WindowState {
  if (state.x === undefined || state.y === undefined) {
    return state;
  }

  const windowLeft = state.x;
  const windowTop = state.y;
  const windowRight = state.x + state.width;
  const windowBottom = state.y + state.height;

  const hasSufficientOverlap = displays.some(({ workArea }) => {
    const displayLeft = workArea.x;
    const displayTop = workArea.y;
    const displayRight = workArea.x + workArea.width;
    const displayBottom = workArea.y + workArea.height;

    const overlapWidth = Math.max(0, Math.min(windowRight, displayRight) - Math.max(windowLeft, displayLeft));
    const overlapHeight = Math.max(0, Math.min(windowBottom, displayBottom) - Math.max(windowTop, displayTop));

    return overlapWidth >= MIN_VISIBLE_OVERLAP_PX && overlapHeight >= MIN_VISIBLE_OVERLAP_PX;
  });

  if (hasSufficientOverlap) {
    return state;
  }

  return {
    width: state.width,
    height: state.height,
    isMaximized: state.isMaximized,
  };
}

export type DesktopLaunchMode = "choose" | "local" | "remote";

export interface DesktopRemoteProfileLike {
  id: string;
  name: string;
  serverUrl: string;
  authToken?: string | null;
}

export interface DesktopShellSettingsLike {
  desktopMode: "local" | "remote" | null;
  activeProfileId: string | null;
  profiles: DesktopRemoteProfileLike[];
}

export interface NormalizedDesktopRemoteLaunch {
  mode: "remote";
  profileId: string;
  serverBaseUrl: string;
  serverLabel?: string;
  authToken?: string;
}

export const SHELL_HANDOFF_QUERY = {
  shellKind: "shellKind",
  shellMode: "shellMode",
  profileId: "profileId",
  serverBaseUrl: "serverBaseUrl",
  serverLabel: "serverLabel",
  token: "token",
  canOpenConnectionManager: "shellCanOpenConnectionManager",
} as const;

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

function getDesktopLaunchModePath(): string {
  return join(app.getPath("userData"), "desktop-launch-mode.json");
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

type AutoUpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel?: string | null;
  allowPrerelease?: boolean;
  on: (event: string, handler: (...args: unknown[]) => void) => unknown;
  checkForUpdates: () => Promise<unknown>;
};

let cachedAutoUpdater: AutoUpdaterLike | null = null;
let autoUpdaterLoadPromise: Promise<AutoUpdaterLike | null> | null = null;
let listenersBound = false;
let hasRunInitialUpdateCheck = false;
let autoUpdaterWindow: BrowserWindow | undefined;
let updateIntervalTimer: ReturnType<typeof setInterval> | null = null;
let updateIntervalDisposer: (() => void) | null = null;
let updateIntervalWindow: BrowserWindow | null = null;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

async function resolveAutoUpdater(): Promise<AutoUpdaterLike | null> {
  if (cachedAutoUpdater) {
    return cachedAutoUpdater;
  }

  if (!autoUpdaterLoadPromise) {
    autoUpdaterLoadPromise = (async () => {
      try {
        const mod = (await import("electron-updater")) as {
          default?: { autoUpdater?: unknown };
          autoUpdater?: unknown;
        };
        const namedAutoUpdater = "autoUpdater" in mod ? (mod as { autoUpdater?: unknown }).autoUpdater : undefined;
        const autoUpdater = (mod.default?.autoUpdater ?? namedAutoUpdater) as AutoUpdaterLike | undefined;

        if (!autoUpdater) {
          console.warn("[desktop/native] Auto-updater module loaded without autoUpdater export");
          return null;
        }

        cachedAutoUpdater = autoUpdater;
        return autoUpdater;
      } catch (error) {
        console.warn("[desktop/native] Auto-updater unavailable", error);
        return null;
      }
    })();
  }

  return autoUpdaterLoadPromise;
}

function bindAutoUpdaterListeners(autoUpdater: AutoUpdaterLike): void {
  if (listenersBound) {
    return;
  }

  listenersBound = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    showDesktopNotification("Fusion Update Available", "Update available — downloading in background", {
      silent: true,
    });
    autoUpdaterWindow?.webContents.send("update-available", info);
  });

  autoUpdater.on("update-downloaded", (info) => {
    showDesktopNotification("Fusion Update Ready", "Update ready — will install on quit", {
      silent: true,
    });
    autoUpdaterWindow?.webContents.send("update-downloaded", info);
  });

  autoUpdater.on("update-not-available", (info) => {
    showDesktopNotification("Fusion is up to date", "You're on the latest version", {
      silent: true,
    });
    autoUpdaterWindow?.webContents.send("update-not-available", info);
  });

  autoUpdater.on("error", (error) => {
    const message = getErrorMessage(error);
    console.error("[desktop/native] Auto-updater error", error);
    autoUpdaterWindow?.webContents.send("update-error", { message });
  });
}

/*
FNXC:UpdateChannels 2026-07-19-13:15:
The desktop updater honors the shared `updateChannel` global setting. On the
beta channel we set electron-updater's `channel` to "beta" (so it reads the
`beta*.yml` manifests published by beta desktop builds) and `allowPrerelease`
(so GitHub prereleases are considered). Stable leaves electron-updater at its
defaults: the GitHub "latest" non-prerelease release only. Failures fall back
to stable — the updater must never break because settings are unreadable.
*/
async function applyConfiguredUpdateChannel(autoUpdater: AutoUpdaterLike): Promise<void> {
  let channel: "stable" | "beta" = "stable";
  try {
    const { GlobalSettingsStore } = await import("@fusion/core");
    const store = new GlobalSettingsStore();
    await store.init();
    const settings = await store.getSettings();
    channel = settings.updateChannel === "beta" ? "beta" : "stable";
  } catch (error) {
    console.warn("[desktop/native] Could not read update channel setting; defaulting to stable", error);
  }

  if (channel === "beta") {
    autoUpdater.channel = "beta";
    autoUpdater.allowPrerelease = true;
  } else {
    autoUpdater.channel = null;
    autoUpdater.allowPrerelease = false;
  }
}

export function setupAutoUpdater(mainWindow?: BrowserWindow): void {
  if (mainWindow) {
    autoUpdaterWindow = mainWindow;
  }

  void (async () => {
    try {
      const autoUpdater = await resolveAutoUpdater();
      if (!autoUpdater) {
        return;
      }

      bindAutoUpdaterListeners(autoUpdater);
      await applyConfiguredUpdateChannel(autoUpdater);

      if (hasRunInitialUpdateCheck) {
        return;
      }

      hasRunInitialUpdateCheck = true;
      await autoUpdater.checkForUpdates().catch((error: unknown) => {
        console.error("[desktop/native] Auto-updater check failed", error);
      });
    } catch (error) {
      console.warn("[desktop/native] Auto-updater setup failed", error);
    }
  })();
}

export async function triggerUpdateCheck(
  mainWindow?: BrowserWindow,
): Promise<{ status: "checking" } | { status: "unavailable"; reason: string } | { status: "error"; error: string }> {
  setupAutoUpdater(mainWindow);

  const autoUpdater = await resolveAutoUpdater();
  if (!autoUpdater) {
    return { status: "unavailable", reason: "updater_unavailable" };
  }

  try {
    // Re-read the channel on every manual check so a settings change takes
    // effect without an app restart.
    await applyConfiguredUpdateChannel(autoUpdater);
    await autoUpdater.checkForUpdates();
    return { status: "checking" };
  } catch (error) {
    return { status: "error", error: getErrorMessage(error) };
  }
}

export function startUpdateCheckInterval(mainWindow: BrowserWindow, intervalMs = 4 * 60 * 60 * 1000): () => void {
  autoUpdaterWindow = mainWindow;

  if (updateIntervalDisposer && updateIntervalWindow === mainWindow) {
    return updateIntervalDisposer;
  }

  if (updateIntervalTimer) {
    clearInterval(updateIntervalTimer);
    updateIntervalTimer = null;
  }

  updateIntervalWindow = mainWindow;
  updateIntervalTimer = setInterval(() => {
    void triggerUpdateCheck(mainWindow);
  }, intervalMs);

  updateIntervalDisposer = () => {
    if (updateIntervalTimer) {
      clearInterval(updateIntervalTimer);
      updateIntervalTimer = null;
    }
    updateIntervalDisposer = null;
    updateIntervalWindow = null;
  };

  return updateIntervalDisposer;
}

function normalizeServerBaseUrl(serverUrl: string): string | null {
  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function normalizeDesktopRemoteLaunch(settings: DesktopShellSettingsLike): NormalizedDesktopRemoteLaunch | null {
  if (settings.desktopMode !== "remote" || !settings.activeProfileId) {
    return null;
  }

  const activeProfile = settings.profiles.find((profile) => profile.id === settings.activeProfileId);
  if (!activeProfile) {
    return null;
  }

  const serverBaseUrl = normalizeServerBaseUrl(activeProfile.serverUrl);
  if (!serverBaseUrl) {
    return null;
  }

  return {
    mode: "remote",
    profileId: activeProfile.id,
    serverBaseUrl,
    ...(activeProfile.name ? { serverLabel: activeProfile.name } : {}),
    ...(activeProfile.authToken ? { authToken: activeProfile.authToken } : {}),
  };
}

export function buildRemoteShellHandoffUrl(launch: NormalizedDesktopRemoteLaunch): string {
  const url = new URL(launch.serverBaseUrl);
  url.searchParams.set(SHELL_HANDOFF_QUERY.shellKind, "desktop");
  url.searchParams.set(SHELL_HANDOFF_QUERY.shellMode, "remote");
  url.searchParams.set(SHELL_HANDOFF_QUERY.profileId, launch.profileId);
  url.searchParams.set(SHELL_HANDOFF_QUERY.serverBaseUrl, launch.serverBaseUrl);
  if (launch.serverLabel) {
    url.searchParams.set(SHELL_HANDOFF_QUERY.serverLabel, launch.serverLabel);
  }
  if (launch.authToken) {
    url.searchParams.set(SHELL_HANDOFF_QUERY.token, launch.authToken);
  }
  url.searchParams.set(SHELL_HANDOFF_QUERY.canOpenConnectionManager, "1");
  return url.toString();
}

function isValidDesktopLaunchMode(value: unknown): value is DesktopLaunchMode {
  return value === "choose" || value === "local" || value === "remote";
}

export async function loadDesktopLaunchMode(): Promise<DesktopLaunchMode> {
  const launchModePath = getDesktopLaunchModePath();

  try {
    const raw = await readFile(launchModePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (parsed && typeof parsed === "object" && "mode" in parsed) {
      const mode = (parsed as { mode?: unknown }).mode;
      if (isValidDesktopLaunchMode(mode)) {
        return mode;
      }
    }

    return "choose";
  } catch {
    return "choose";
  }
}

export async function saveDesktopLaunchMode(mode: DesktopLaunchMode): Promise<void> {
  const launchModePath = getDesktopLaunchModePath();
  const tempPath = `${launchModePath}.tmp`;

  await writeFile(tempPath, JSON.stringify({ mode }, null, 2), "utf-8");
  await rename(tempPath, launchModePath);
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
