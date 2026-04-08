import { app, BrowserWindow, nativeImage, Tray } from "electron";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setupDeepLinkHandler, registerDeepLinkProtocol } from "./deep-link.js";
import { registerIpcHandlers } from "./ipc.js";
import { buildAppMenu } from "./menu.js";
import {
  DEFAULT_WINDOW_STATE,
  loadWindowState,
  saveWindowState,
  setupAutoUpdater,
  type WindowState,
} from "./native.js";
import { setupTray } from "./tray.js";

interface AppWithQuitFlag {
  isQuitting?: boolean;
}

const DEFAULT_DEV_DASHBOARD_URL = "http://localhost:5173";

function isDevelopmentMode(): boolean {
  return process.env.NODE_ENV === "development" || process.argv.includes("--dev");
}

const PRODUCTION_DASHBOARD_URL = pathToFileURL(
  join(import.meta.dirname, "client", "index.html"),
).toString();

export const IS_DEVELOPMENT = isDevelopmentMode();
export const DASHBOARD_URL = process.env.FUSION_DASHBOARD_URL ?? (
  IS_DEVELOPMENT ? DEFAULT_DEV_DASHBOARD_URL : PRODUCTION_DASHBOARD_URL
);

function enableSourceMaps(): void {
  const processWithSourceMaps = process as NodeJS.Process & {
    setSourceMapsEnabled?: (enabled: boolean) => void;
  };
  processWithSourceMaps.setSourceMapsEnabled?.(true);
}

enableSourceMaps();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

function getAppWithQuitFlag(): Electron.App & AppWithQuitFlag {
  return app as Electron.App & AppWithQuitFlag;
}

export function createMainWindow(state?: WindowState): BrowserWindow {
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

  void window.loadURL(DASHBOARD_URL);

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
  const createdWindow = createMainWindow(state ?? undefined);

  buildAppMenu({
    mainWindow: createdWindow,
    appName: "Fusion",
  });

  tray = new Tray(nativeImage.createEmpty());
  setupTray(createdWindow, tray);

  registerIpcHandlers(createdWindow, tray);
  registerDeepLinkProtocol();
  setupDeepLinkHandler(createdWindow);
  setupAutoUpdater(createdWindow);

  if (state?.isMaximized === true) {
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
  });

  app.on("activate", () => {
    if (mainWindow === null) {
      const window = createMainWindow();
      window.show();
    }
  });
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  run();
}
