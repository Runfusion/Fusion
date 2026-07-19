import { app, type BrowserWindow, ipcMain, shell, type Tray } from "electron";
import {
  showExportSettingsDialog,
  showImportSettingsDialog,
  triggerUpdateCheck,
  type NormalizedDesktopRemoteLaunch,
} from "./native.js";
import { type EngineStatus, updateTrayStatus } from "./tray.js";
import {
  applyDeleteProfile,
  applySetActiveProfile,
  buildSavedProfile,
  getDesktopShellModeState,
  readShellSettings,
  writeShellSettings,
  type DesktopShellMode,
  type ShellConnectionProfile,
} from "./shell-settings.js";
import type { DesktopRuntimeStatus } from "./local-runtime.js";

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
  localRuntime?: DesktopRuntimeStatus;
}

type DesktopLaunchMode = "choose" | "local" | "remote";

interface RegisterIpcOptions {
  onDesktopModeChange?: (mode: DesktopShellMode) => Promise<void>;
  onDesktopLaunchModeChange?: (mode: DesktopLaunchMode) => Promise<void>;
  getRuntimeStatus?: () => DesktopRuntimeStatus;
  startLocalRuntime?: () => Promise<DesktopRuntimeStatus>;
  stopLocalRuntime?: () => Promise<DesktopRuntimeStatus>;
  getServerPort?: () => number | undefined;
  getDesktopLaunchMode?: () => DesktopLaunchMode;
  getDesktopLaunchContext?: () => NormalizedDesktopRemoteLaunch | null;
}

function isDesktopLaunchMode(value: unknown): value is DesktopLaunchMode {
  return value === "choose" || value === "local" || value === "remote";
}

function toShellState(
  settings: Awaited<ReturnType<typeof readShellSettings>>,
  runtimeStatus?: DesktopRuntimeStatus,
): ShellConnectionState {
  return {
    host: "desktop-shell",
    desktopModeState: getDesktopShellModeState(settings),
    desktopMode: settings.desktopMode ?? undefined,
    activeProfileId: settings.activeProfileId,
    profiles: settings.profiles,
    localRuntime: runtimeStatus ?? { source: "none", state: "stopped" },
  };
}

async function emitShellState(
  mainWindow: BrowserWindow,
  getRuntimeStatus?: () => DesktopRuntimeStatus,
): Promise<ShellConnectionState> {
  const state = toShellState(await readShellSettings(), getRuntimeStatus?.());
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

  ipcMain.handle("app:checkForUpdates", async () => {
    try {
      return await triggerUpdateCheck(mainWindow);
    } catch (error) {
      return { status: "error" as const, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("tray:updateStatus", (_event, status: EngineStatus) => updateTrayStatus(tray, status));
  /*
  FNXC:DesktopOAuth 2026-07-18-04:00:
  OAuth flows call window.open AFTER awaiting POST /auth/login; when the round
  trip outlives Chromium's transient user activation (~5s — observed with the
  OpenAI Codex flow: method-select round-trip + localhost callback server +
  auth-lock retries), the popup is silently blocked and setWindowOpenHandler
  never fires, so the system browser never opens. This explicit IPC needs no
  user activation. http/https only — reject everything else.
  */
  ipcMain.handle("shell:openExternal", async (_event, url: unknown) => {
    if (typeof url !== "string") return false;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle("native:showExportDialog", () => showExportSettingsDialog(mainWindow));
  ipcMain.handle("native:showImportDialog", () => showImportSettingsDialog(mainWindow));
  ipcMain.handle("app:getServerPort", () => options.getServerPort?.());

  ipcMain.handle("desktopRuntime:getStatus", async () => options.getRuntimeStatus?.() ?? { source: "none", state: "stopped" });
  ipcMain.handle("desktopRuntime:startLocal", async () => options.startLocalRuntime?.() ?? { source: "none", state: "stopped" });
  ipcMain.handle("desktopRuntime:stopLocal", async () => options.stopLocalRuntime?.() ?? { source: "none", state: "stopped" });
  ipcMain.handle("desktopLaunchMode:getMode", async () => options.getDesktopLaunchMode?.() ?? "choose");
  ipcMain.handle("desktopLaunchMode:getContext", async () => options.getDesktopLaunchContext?.() ?? null);
  ipcMain.handle("desktopLaunchMode:setMode", async (_event, mode: unknown) => {
    if (!isDesktopLaunchMode(mode)) {
      throw new Error("Invalid desktop launch mode");
    }

    if (options.onDesktopLaunchModeChange) {
      await options.onDesktopLaunchModeChange(mode);
      return options.getDesktopLaunchMode?.() ?? mode;
    }

    if ((mode === "local" || mode === "remote") && options.onDesktopModeChange) {
      await options.onDesktopModeChange(mode);
      return options.getDesktopLaunchMode?.() ?? mode;
    }

    return options.getDesktopLaunchMode?.() ?? mode;
  });

  ipcMain.handle("shell:getState", () => readShellSettings().then((settings) => toShellState(settings, options.getRuntimeStatus?.())));
  ipcMain.handle("shell:listProfiles", async () => (await readShellSettings()).profiles);

  ipcMain.handle("shell:saveProfile", async (_event, profile: ShellConnectionProfileInput) => {
    const settings = await readShellSettings();
    const nextProfile = buildSavedProfile(settings, profile);
    const existing = settings.profiles.find((item) => item.id === nextProfile.id);

    settings.profiles = existing
      ? settings.profiles.map((item) => (item.id === existing.id ? nextProfile : item))
      : [...settings.profiles, nextProfile];
    await writeShellSettings(settings);
    await emitShellState(mainWindow, options.getRuntimeStatus);
    return nextProfile;
  });

  ipcMain.handle("shell:deleteProfile", async (_event, profileId: string) => {
    const settings = applyDeleteProfile(await readShellSettings(), profileId);
    await writeShellSettings(settings);
    await emitShellState(mainWindow, options.getRuntimeStatus);
  });

  ipcMain.handle("shell:setActiveProfile", async (_event, profileId: string | null) => {
    const settings = applySetActiveProfile(await readShellSettings(), profileId);
    await writeShellSettings(settings);
    return emitShellState(mainWindow, options.getRuntimeStatus);
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
    return emitShellState(mainWindow, options.getRuntimeStatus);
  });

  ipcMain.handle("shell:resetDesktopMode", async () => {
    const settings = await readShellSettings();
    settings.desktopMode = null;
    settings.hasCompletedModeSelection = false;
    await writeShellSettings(settings);
    // Stop the embedded runtime so a subsequent local choice spins up fresh.
    await options.stopLocalRuntime?.().catch(() => undefined);
    return emitShellState(mainWindow, options.getRuntimeStatus);
  });

  ipcMain.handle("shell:startQrScan", async () => {
    throw new Error("QR scanning is not available in desktop shell");
  });

  ipcMain.handle("shell:openConnectionManager", () => {
    mainWindow.webContents.send("shell:open-connection-manager");
  });
}
