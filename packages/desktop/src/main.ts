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
import { readShellSettings } from "./shell-settings.js";

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

export async function initializeApp(): Promise<void> {
  const state = await loadWindowState();
  const rememberedLaunchMode = await loadDesktopLaunchMode();

  localRuntimeManager = new LocalRuntimeManager({ rootDir: process.cwd() });
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
    }
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
