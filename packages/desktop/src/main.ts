import { app, BrowserWindow, nativeImage, screen, Tray } from "electron";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setupDeepLinkHandler, registerDeepLinkProtocol } from "./deep-link.js";
import { registerIpcHandlers } from "./ipc.js";
import { buildAppMenu } from "./menu.js";
import {
  DEFAULT_WINDOW_STATE,
  loadDesktopLaunchMode,
  loadWindowState,
  saveDesktopLaunchMode,
  saveWindowState,
  setupAutoUpdater,
  triggerUpdateCheck,
  startUpdateCheckInterval,
  normalizeDesktopRemoteLaunch,
  buildRemoteShellHandoffUrl,
  clampWindowStateToVisibleDisplay,
  type DesktopLaunchMode,
  type NormalizedDesktopRemoteLaunch,
  type WindowState,
} from "./native.js";
import { setupTray } from "./tray.js";
import { getRendererUrl, getRendererFilePath, isUrlRenderer } from "./renderer.js";
import { LocalRuntimeManager } from "./local-runtime.js";
import { readShellSettings, writeShellSettings } from "./shell-settings.js";

// Re-export for backward compatibility
export { IS_DEVELOPMENT } from "./renderer.js";
export { DASHBOARD_URL } from "./renderer.js";

interface AppWithQuitFlag {
  isQuitting?: boolean;
}

function enableSourceMaps(): void {
  const processWithSourceMaps = process as NodeJS.Process & {
    setSourceMapsEnabled?: (enabled: boolean) => void;
  };
  processWithSourceMaps.setSourceMapsEnabled?.(true);
}

enableSourceMaps();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let localRuntimeManager: LocalRuntimeManager | null = null;
let currentDesktopLaunchMode: DesktopLaunchMode = "choose";
let currentRemoteLaunch: NormalizedDesktopRemoteLaunch | null = null;
let localRuntimeStartupAttempted = false;
let stopUpdateCheckInterval: (() => void) | null = null;

function getAppWithQuitFlag(): Electron.App & AppWithQuitFlag {
  return app as Electron.App & AppWithQuitFlag;
}

async function startLocalRuntimeOnce(): Promise<void> {
  if (!localRuntimeManager || localRuntimeStartupAttempted) {
    return;
  }

  const status = localRuntimeManager.getStatus();
  if (status.source === "embedded-local" && status.state === "running") {
    localRuntimeStartupAttempted = true;
    return;
  }

  localRuntimeStartupAttempted = true;
  await localRuntimeManager.startLocal();
}

export function getCurrentDesktopLaunchMode(): DesktopLaunchMode {
  return currentDesktopLaunchMode;
}

async function resetLaunchModeAndReload(window: BrowserWindow): Promise<void> {
  try {
    const settings = await readShellSettings();
    settings.desktopMode = null;
    settings.hasCompletedModeSelection = false;
    await writeShellSettings(settings);
    await saveDesktopLaunchMode("choose");
  } catch (error) {
    console.error("[desktop/main] Failed to reset shell settings", error);
  }
  if (localRuntimeManager) {
    try {
      await localRuntimeManager.stopLocal();
    } catch (error) {
      console.error("[desktop/main] Failed to stop local runtime during reset", error);
    }
  }
  currentDesktopLaunchMode = "choose";
  currentRemoteLaunch = null;
  localRuntimeStartupAttempted = false;

  // Force a clean reload to the renderer entrypoint without any cached
  // serverBaseUrl / shellMode query params so the gate re-prompts.
  try {
    if (isUrlRenderer()) {
      await window.loadURL(getRendererUrl());
    } else {
      await window.loadFile(getRendererFilePath());
    }
  } catch (error) {
    console.error("[desktop/main] reload failed", error);
  }
}

export function createMainWindow(state?: WindowState, launchTargetUrl?: string): BrowserWindow {
  const hasValidPosition = typeof state?.x === "number" && typeof state?.y === "number";

  const window = new BrowserWindow({
    width: state?.width ?? DEFAULT_WINDOW_STATE.width,
    height: state?.height ?? DEFAULT_WINDOW_STATE.height,
    ...(hasValidPosition ? { x: state.x, y: state.y } : {}),
    title: "Fusion",
    webPreferences: {
      preload: join(import.meta.dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (launchTargetUrl) {
    void window.loadURL(launchTargetUrl);
  } else if (isUrlRenderer()) {
    void window.loadURL(getRendererUrl());
  } else {
    void window.loadFile(getRendererFilePath());
  }

  const showFallbackTimer = setTimeout(() => {
    window.show();
    window.focus();
  }, 2000);

  window.once("ready-to-show", () => {
    clearTimeout(showFallbackTimer);
    window.show();
    window.focus();
  });

  window.on("close", (event) => {
    saveWindowState(window);

    if (getAppWithQuitFlag().isQuitting) {
      return;
    }

    event.preventDefault();
    window.hide();
  });

  window.on("closed", () => {
    mainWindow = null;
  });

  mainWindow = window;
  return window;
}

/**
 * Resolve the project root for the embedded local runtime.
 *
 * Must NOT be `process.cwd()`: when a packaged build is launched from a desktop
 * launcher or file manager (notably the Linux AppImage), cwd is `/` or the
 * read-only squashfs mount point, so creating `<cwd>/.fusion/fusion.db` fails
 * with EACCES/EROFS and the local runtime never starts ("Couldn't start local
 * Fusion"). Anchor to a stable, writable per-user location instead — the home
 * directory, so data lives in `~/.fusion` (consistent with the CLI). Honor
 * `FUSION_HOME` for power users who want their data elsewhere.
 */
export function resolveLocalRuntimeRoot(): string {
  const override = process.env.FUSION_HOME?.trim();
  if (override) {
    return resolve(override);
  }
  return app.getPath("home");
}

export async function initializeApp(): Promise<void> {
  const state = await loadWindowState();
  const rememberedLaunchMode = await loadDesktopLaunchMode();

  localRuntimeManager = new LocalRuntimeManager({ rootDir: resolveLocalRuntimeRoot() });
  currentDesktopLaunchMode = rememberedLaunchMode;
  currentRemoteLaunch = null;
  localRuntimeStartupAttempted = false;

  if (rememberedLaunchMode === "remote") {
    const shellSettings = await readShellSettings();
    const normalizedRemoteLaunch = normalizeDesktopRemoteLaunch(shellSettings);
    if (normalizedRemoteLaunch) {
      currentRemoteLaunch = normalizedRemoteLaunch;
    } else {
      currentDesktopLaunchMode = "choose";
      await saveDesktopLaunchMode("choose");
    }
  }

  if (rememberedLaunchMode === "local") {
    try {
      await startLocalRuntimeOnce();
    } catch (error) {
      await localRuntimeManager.stopLocal();
      currentDesktopLaunchMode = "choose";
      localRuntimeStartupAttempted = false;
      await saveDesktopLaunchMode("choose");
      console.error("[desktop/main] Failed to restore local mode; falling back to chooser", error);
    }
  }

  if (currentDesktopLaunchMode === "choose" && process.env.FUSION_DESKTOP_MODE === "local") {
    await startLocalRuntimeOnce();
    currentDesktopLaunchMode = "local";
  }

  const windowState = state
    ? clampWindowStateToVisibleDisplay(
        state,
        typeof screen?.getAllDisplays === "function"
          ? screen.getAllDisplays().map((display) => ({ workArea: display.workArea }))
          : [],
      )
    : undefined;

  const createdWindow = createMainWindow(
    windowState,
    currentDesktopLaunchMode === "remote" && currentRemoteLaunch
      ? buildRemoteShellHandoffUrl(currentRemoteLaunch)
      : undefined,
  );

  buildAppMenu({
    mainWindow: createdWindow,
    appName: "Fusion",
    onChangeLaunchMode: async () => {
      await resetLaunchModeAndReload(createdWindow);
    },
    /*
     * FNXC:DesktopRuntimeMode 2026-06-21-02:04:
     * Menu-driven local/remote switching must only persist local mode after the embedded runtime starts successfully; shutdown stops the local server without rewriting the launch-mode preference.
     */
    onStartLocalRuntime: async () => {
      if (!localRuntimeManager) return;
      localRuntimeStartupAttempted = false;
      await startLocalRuntimeOnce();
      currentRemoteLaunch = null;
      currentDesktopLaunchMode = "local";
      await saveDesktopLaunchMode("local");
      createdWindow.webContents.reload();
    },
    onStopLocalRuntime: async () => {
      await localRuntimeManager?.stopLocal();
    },
    onConnectRemoteServer: async () => {
      await resetLaunchModeAndReload(createdWindow);
    },
    onCheckForUpdates: async () => {
      await triggerUpdateCheck(createdWindow);
    },
  });

  tray = new Tray(nativeImage.createEmpty());
  setupTray(createdWindow, tray);

  registerIpcHandlers(createdWindow, tray, {
    onDesktopModeChange: async (mode) => {
      if (!localRuntimeManager) {
        return;
      }
      currentDesktopLaunchMode = mode;
      if (mode === "local") {
        currentRemoteLaunch = null;
        localRuntimeStartupAttempted = false;
        await startLocalRuntimeOnce();
      } else {
        localRuntimeStartupAttempted = false;
        await localRuntimeManager.stopLocal();
        const shellSettings = await readShellSettings();
        currentRemoteLaunch = normalizeDesktopRemoteLaunch({ ...shellSettings, desktopMode: "remote" });
      }
      await saveDesktopLaunchMode(mode);
    },
    onDesktopLaunchModeChange: async (mode) => {
      if (!localRuntimeManager) {
        return;
      }
      currentDesktopLaunchMode = mode;
      localRuntimeStartupAttempted = false;
      if (mode === "local") {
        currentRemoteLaunch = null;
        await startLocalRuntimeOnce();
      } else {
        await localRuntimeManager.stopLocal();
        const shellSettings = await readShellSettings();
        currentRemoteLaunch = normalizeDesktopRemoteLaunch({ ...shellSettings, desktopMode: "remote" });
      }
      await saveDesktopLaunchMode(mode);
    },
    getRuntimeStatus: () => localRuntimeManager?.getStatus() ?? { source: "none", state: "stopped" },
    startLocalRuntime: () => localRuntimeManager?.startLocal() ?? Promise.resolve({ source: "none", state: "stopped" }),
    stopLocalRuntime: () => localRuntimeManager?.stopLocal() ?? Promise.resolve({ source: "none", state: "stopped" }),
    getServerPort: () => localRuntimeManager?.getServerPort(),
    getDesktopLaunchMode: () => currentDesktopLaunchMode,
    getDesktopLaunchContext: () => currentRemoteLaunch,
  });
  registerDeepLinkProtocol();
  setupDeepLinkHandler(createdWindow);
  setupAutoUpdater(createdWindow);
  stopUpdateCheckInterval = startUpdateCheckInterval(createdWindow);

  if (windowState?.isMaximized === true) {
    createdWindow.maximize();
  }
}

export function run(): void {
  const appWithQuitFlag = getAppWithQuitFlag();
  appWithQuitFlag.isQuitting = false;

  void app.whenReady().then(() => initializeApp());

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    appWithQuitFlag.isQuitting = true;

    if (stopUpdateCheckInterval) {
      stopUpdateCheckInterval();
      stopUpdateCheckInterval = null;
    }

    if (tray) {
      tray.destroy();
      tray = null;
    }

    if (localRuntimeManager) {
      void localRuntimeManager.stopLocal();
    }
  });

  app.on("activate", () => {
    if (mainWindow === null) {
      const window = createMainWindow();
      window.show();
      return;
    }
    // The close handler hides the window instead of destroying it, so a
    // subsequent dock/Finder activate must explicitly show + focus it —
    // otherwise the app appears to do nothing when relaunched.
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
  });
}

const modulePath = fileURLToPath(import.meta.url);
const isElectronMain =
  (process as NodeJS.Process & { type?: string }).type === "browser";
const isDirectInvocation =
  !!process.argv[1] && resolve(process.argv[1]) === modulePath;
if (isElectronMain || isDirectInvocation) {
  run();
}
