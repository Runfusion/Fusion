import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Tray, ipcMain, nativeImage } from "electron";
import { buildAppMenu } from "./menu.js";
import { setupTray, updateTrayStatus } from "./tray.js";

export const DASHBOARD_URL = process.env.FUSION_DASHBOARD_URL || "http://localhost:4040";

export function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: "Fusion",
    webPreferences: {
      preload: join(import.meta.dirname, "preload.ts"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void mainWindow.loadURL(DASHBOARD_URL);
  return mainWindow;
}

export function registerIpcHandlers(): void {
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.on("app:quit", () => app.quit());
}

export function run(): void {
  let tray: Tray | undefined;

  app.whenReady().then(() => {
    const mainWindow = createMainWindow();
    const trayInstance = tray ?? new Tray(nativeImage.createEmpty());
    tray = setupTray(mainWindow, trayInstance);

    buildAppMenu({
      mainWindow,
      appName: "Fusion",
    });

    registerIpcHandlers();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      // Keep app alive in tray on non-macOS platforms.
      return;
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const mainWindow = createMainWindow();
      const trayInstance = tray ?? new Tray(nativeImage.createEmpty());
      tray = setupTray(mainWindow, trayInstance);

      buildAppMenu({
        mainWindow,
        appName: "Fusion",
      });
    }
  });
}

export { setupTray, updateTrayStatus };

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  run();
}
