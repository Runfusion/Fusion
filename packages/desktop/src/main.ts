import { app, BrowserWindow, nativeImage, screen, Tray } from "electron";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { migratePreviousUserData } from "./user-data-migration.js";

/*
FNXC:DesktopUserDataIsolation 2026-07-03-14:40:
Isolate Electron desktop user-data/cache/crash artifacts under ~/.fusion/desktop-user-data so the packaged desktop does not share (or collide with) the default per-app Chromium profile across installs and Fusion versions (field report Issue 8). setPath must run before app "ready"; once locked it throws, which is non-fatal here.

FNXC:DesktopUserDataMigration 2026-07-03-15:10:
Migrate the previous default profile into the new location BEFORE `setPath` overrides it, so upgrading operators keep their window geometry/session. `app.getPath("userData")` returns the default `<appData>/<productName>` path until overridden, so capture it first. See user-data-migration.ts for the one-time-copy gating.
*/
const fusionUserDataDir = join(os.homedir(), ".fusion", "desktop-user-data");

const migratedUserData = migratePreviousUserData(app.getPath("userData"), fusionUserDataDir);
if (migratedUserData) {
  console.log(`[desktop/main] Migrated previous desktop profile into ${fusionUserDataDir}`);
}

try {
  app.commandLine.appendSwitch("user-data-dir", fusionUserDataDir);
  app.setPath("userData", fusionUserDataDir);
  app.setPath("cache", join(fusionUserDataDir, "cache"));
  app.setPath("crashDumps", join(fusionUserDataDir, "crashes"));
} catch {
  // Path already locked after app is ready; not a fatal error.
}

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

    /*
    FNXC:DesktopClosePolicy 2026-07-03-15:30:
    Windows Desktop close is a shutdown request, not a tray-minimize request. Let the BrowserWindow close so Electron emits window-all-closed and before-quit, which stops the embedded local Fusion runtime; keep macOS/non-Windows close-to-tray semantics for dock/tray restoration.
    */
    if (process.platform === "win32") {
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
  let rememberedLaunchMode = await loadDesktopLaunchMode();

  /*
   * FNXC:DesktopRuntimeMode 2026-07-02-14:35:
   * Split-brain reconciliation. Desktop startup has TWO persisted sources of truth
   * that must agree: `desktop-launch-mode.json` (loadDesktopLaunchMode) decides whether
   * THIS function STARTS the embedded local runtime, while `shell-connections.json`
   * (readShellSettings().desktopMode) decides whether the renderer launch gate WAITS
   * for it. They desync because shell:setDesktopMode persists shell settings BEFORE the
   * fallible startLocalRuntimeOnce()/saveDesktopLaunchMode() — so a first local selection
   * whose runtime start throws or is interrupted leaves shell=`local` but launch-mode=`choose`.
   * The gate then shows "Starting local Fusion runtime…" and polls forever for a runtime
   * nobody started, timing out after 30s on EVERY launch. Treat a completed shell "local"
   * selection as authoritative and heal the launch-mode file so both halves agree.
   */
  const reconcileShellSettings = await readShellSettings();
  if (
    rememberedLaunchMode !== "local" &&
    reconcileShellSettings.desktopMode === "local" &&
    reconcileShellSettings.hasCompletedModeSelection === true
  ) {
    console.warn(
      `[desktop/main] Healing launch-mode split-brain: shell desktopMode="local" but launch-mode="${rememberedLaunchMode}"; adopting "local"`,
    );
    rememberedLaunchMode = "local";
    await saveDesktopLaunchMode("local");
  }

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

  if (rememberedLaunchMode === "local" && !process.env.FUSION_SERVER_PORT) {
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

  /*
  FNXC:DesktopReuseCliServer 2026-07-03-14:40:
  When `fusion desktop` launches Electron it exports FUSION_SERVER_PORT for the dashboard the CLI already started. In that case the desktop must NOT spin up its own embedded local runtime (which would double-bind ports and conflict on Windows, field report Issue 9): skip startLocalRuntimeOnce() when the port is set, and treat a "choose" mode as already-local so the shell attaches to the external CLI server.
  */
  if (currentDesktopLaunchMode === "choose" && process.env.FUSION_SERVER_PORT) {
    // The CLI already started a dashboard server; use it without spawning an
    // embedded local runtime. The shell state will report external-cli running.
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
        /*
         * FNXC:DesktopRuntimeMode 2026-07-02-14:35:
         * Persist launch-mode BEFORE the fallible startLocalRuntimeOnce(). shell:setDesktopMode
         * already wrote shell-connections.json `desktopMode:"local"` before invoking this callback;
         * if the runtime start throws/is interrupted and we saved launch-mode only afterward, the two
         * files desync (shell=local, launch-mode=choose) and every future launch hangs at "Starting
         * local runtime". Saving first keeps both sources in agreement so a failed start simply retries
         * on next launch instead of deadlocking.
         */
        await saveDesktopLaunchMode(mode);
        await startLocalRuntimeOnce();
        return;
      }
      localRuntimeStartupAttempted = false;
      await localRuntimeManager.stopLocal();
      const shellSettings = await readShellSettings();
      currentRemoteLaunch = normalizeDesktopRemoteLaunch({ ...shellSettings, desktopMode: "remote" });
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
        // FNXC:DesktopRuntimeMode 2026-07-02-14:35: persist before the fallible start (see onDesktopModeChange).
        await saveDesktopLaunchMode(mode);
        await startLocalRuntimeOnce();
        return;
      }
      await localRuntimeManager.stopLocal();
      const shellSettings = await readShellSettings();
      currentRemoteLaunch = normalizeDesktopRemoteLaunch({ ...shellSettings, desktopMode: "remote" });
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
