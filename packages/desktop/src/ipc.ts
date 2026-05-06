import { app, type BrowserWindow, ipcMain, type Tray } from "electron";
import { setupAutoUpdater, showExportSettingsDialog, showImportSettingsDialog } from "./native.js";
import { type EngineStatus, updateTrayStatus } from "./tray.js";
import {
  getDesktopShellModeState,
  readShellSettings,
  writeShellSettings,
  type DesktopShellMode,
  type ShellConnectionProfile,
} from "./shell-settings.js";
import type { DesktopLocalServerState } from "./local-server.js";

interface ShellConnectionProfileInput {
  id?: string;
  name: string;
  serverUrl: string;
  authToken?: string | null;
}

interface ShellConnectionState {
  host: "desktop-shell";
  desktopModeState: {
    isFirstRun: boolean;
    desktopMode: DesktopShellMode | null;
  };
  desktopMode?: DesktopShellMode;
  activeProfileId: string | null;
  profiles: ShellConnectionProfile[];
  localServer?: DesktopLocalServerState;
}

interface RegisterIpcOptions {
  onDesktopModeChange?: (mode: DesktopShellMode) => Promise<void>;
  getLocalServerState?: () => DesktopLocalServerState;
  getServerPort?: () => number | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createProfileId(): string {
  return `profile_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeServerUrl(serverUrl: string): string {
  const normalized = serverUrl.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Server URL must be a valid absolute URL");
  }
  if (!parsed.protocol || !/^https?:$/.test(parsed.protocol)) {
    throw new Error("Server URL must use http or https");
  }
  return normalized;
}

function toShellState(
  settings: Awaited<ReturnType<typeof readShellSettings>>,
  localServerState?: DesktopLocalServerState,
): ShellConnectionState {
  return {
    host: "desktop-shell",
    desktopModeState: getDesktopShellModeState(settings),
    desktopMode: settings.desktopMode ?? undefined,
    activeProfileId: settings.activeProfileId,
    profiles: settings.profiles,
    localServer: localServerState ?? { status: "idle", error: null },
  };
}

async function emitShellState(
  mainWindow: BrowserWindow,
  getLocalServerState?: () => DesktopLocalServerState,
): Promise<ShellConnectionState> {
  const state = toShellState(await readShellSettings(), getLocalServerState?.());
  mainWindow.webContents.send("shell:state", state);
  return state;
}

export function registerIpcHandlers(mainWindow: BrowserWindow, tray: Tray, options: RegisterIpcOptions = {}): void {
  ipcMain.handle("window:minimize", () => mainWindow.minimize());
  ipcMain.handle("window:maximize", () => {
    const isCurrentlyMaximized = mainWindow.isMaximized();
    if (isCurrentlyMaximized) {
      mainWindow.unmaximize();
      return false;
    }
    mainWindow.maximize();
    return true;
  });
  ipcMain.handle("window:close", () => mainWindow.close());
  ipcMain.handle("window:isMaximized", () => mainWindow.isMaximized());
  ipcMain.handle("platform:get", () => process.platform);

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
      return { status: "error" as const, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("tray:updateStatus", (_event, status: EngineStatus) => updateTrayStatus(tray, status));
  ipcMain.handle("native:showExportDialog", () => showExportSettingsDialog(mainWindow));
  ipcMain.handle("native:showImportDialog", () => showImportSettingsDialog(mainWindow));
  ipcMain.handle("app:getServerPort", () => options.getServerPort?.());

  ipcMain.handle("shell:getState", () => readShellSettings().then((settings) => toShellState(settings, options.getLocalServerState?.())));
  ipcMain.handle("shell:listProfiles", async () => (await readShellSettings()).profiles);

  ipcMain.handle("shell:saveProfile", async (_event, profile: ShellConnectionProfileInput) => {
    const settings = await readShellSettings();
    const existing = profile.id ? settings.profiles.find((item) => item.id === profile.id) : undefined;
    const timestamp = nowIso();
    const nextProfile: ShellConnectionProfile = {
      id: existing?.id ?? profile.id ?? createProfileId(),
      name: profile.name.trim(),
      serverUrl: normalizeServerUrl(profile.serverUrl),
      authToken: profile.authToken ?? null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastUsedAt: existing?.lastUsedAt ?? null,
    };

    settings.profiles = existing ? settings.profiles.map((item) => (item.id === existing.id ? nextProfile : item)) : [...settings.profiles, nextProfile];
    await writeShellSettings(settings);
    await emitShellState(mainWindow, options.getLocalServerState);
    return nextProfile;
  });

  ipcMain.handle("shell:deleteProfile", async (_event, profileId: string) => {
    const settings = await readShellSettings();
    settings.profiles = settings.profiles.filter((item) => item.id !== profileId);
    if (settings.activeProfileId === profileId) settings.activeProfileId = null;
    await writeShellSettings(settings);
    await emitShellState(mainWindow, options.getLocalServerState);
  });

  ipcMain.handle("shell:setActiveProfile", async (_event, profileId: string | null) => {
    const settings = await readShellSettings();
    settings.activeProfileId = profileId && settings.profiles.some((item) => item.id === profileId) ? profileId : null;
    settings.profiles = settings.profiles.map((item) =>
      item.id === settings.activeProfileId ? { ...item, lastUsedAt: nowIso(), updatedAt: nowIso() } : item,
    );
    await writeShellSettings(settings);
    return emitShellState(mainWindow, options.getLocalServerState);
  });

  ipcMain.handle("shell:getDesktopModeState", async () => {
    const settings = await readShellSettings();
    return getDesktopShellModeState(settings);
  });

  ipcMain.handle("shell:setDesktopMode", async (_event, mode: DesktopShellMode) => {
    const settings = await readShellSettings();
    settings.desktopMode = mode;
    settings.hasCompletedModeSelection = true;
    await writeShellSettings(settings);
    await options.onDesktopModeChange?.(mode);
    return emitShellState(mainWindow, options.getLocalServerState);
  });

  ipcMain.handle("shell:startQrScan", async () => {
    throw new Error("QR scanning is not available in desktop shell");
  });

  ipcMain.handle("shell:openConnectionManager", () => {
    mainWindow.webContents.send("shell:open-connection-manager");
  });
}
