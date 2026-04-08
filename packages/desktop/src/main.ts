import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Tray, ipcMain, nativeImage } from "electron";
import { buildAppMenu } from "./menu.js";
import { setupTray, updateTrayStatus } from "./tray.js";

export const DASHBOARD_URL = process.env.FUSION_DASHBOARD_URL || "http://localhost:4040";

interface ApiRequestPayload {
  method?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  port?: number;
}

function createDashboardBaseUrl(portOverride?: number): URL {
  const dashboardUrl = new URL(DASHBOARD_URL);
  if (typeof portOverride === "number" && Number.isFinite(portOverride)) {
    dashboardUrl.port = String(portOverride);
  }
  return dashboardUrl;
}

function getDashboardPort(): number {
  const dashboardUrl = createDashboardBaseUrl();
  const port = Number.parseInt(dashboardUrl.port || "", 10);
  if (!Number.isFinite(port) || port <= 0) {
    return dashboardUrl.protocol === "https:" ? 443 : 80;
  }

  return port;
}

function buildApiUrl(path: string, portOverride?: number): string {
  const normalizedPath = path.startsWith("/api")
    ? path
    : `/api${path.startsWith("/") ? path : `/${path}`}`;

  return new URL(normalizedPath, createDashboardBaseUrl(portOverride)).toString();
}

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

  ipcMain.handle("server:get-port", () => getDashboardPort());

  ipcMain.handle("api-request", async (_event, payload: ApiRequestPayload) => {
    const method = (payload.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { ...(payload.headers ?? {}) };

    let requestBody: string | undefined;
    if (payload.body !== undefined && method !== "GET" && method !== "HEAD") {
      if (typeof payload.body === "string") {
        requestBody = payload.body;
      } else {
        requestBody = JSON.stringify(payload.body);
        if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    try {
      const response = await fetch(buildApiUrl(payload.path, payload.port), {
        method,
        headers,
        body: requestBody,
      });

      const responseText = await response.text();
      const responseContentType = response.headers.get("content-type") ?? "";

      let responseData: unknown = responseText;
      if (responseContentType.includes("application/json")) {
        try {
          responseData = responseText ? JSON.parse(responseText) : null;
        } catch {
          responseData = responseText;
        }
      }

      const responseError = response.ok
        ? undefined
        : (typeof responseData === "object" && responseData && "error" in responseData
          ? String((responseData as { error?: string }).error ?? "Request failed")
          : responseText || `Request failed (${response.status})`);

      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data: responseData,
        error: responseError,
      };
    } catch (error) {
      return {
        status: 500,
        statusText: "Internal Error",
        headers: {},
        data: null,
        error: error instanceof Error ? error.message : "Failed to process API request",
      };
    }
  });

  ipcMain.handle("window:control", (event, action: "minimize" | "maximize" | "close" | "isMaximized") => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow) {
      return false;
    }

    switch (action) {
      case "minimize":
        targetWindow.minimize();
        return false;
      case "maximize": {
        const willMaximize = !targetWindow.isMaximized();
        if (willMaximize) {
          targetWindow.maximize();
        } else {
          targetWindow.unmaximize();
        }
        return willMaximize;
      }
      case "close":
        targetWindow.close();
        return false;
      case "isMaximized":
        return targetWindow.isMaximized();
      default:
        return false;
    }
  });

  ipcMain.handle("update:install", async () => {
    // Auto-update wiring is implemented by FN-1071. Keep this as a safe no-op
    // so renderer hooks can call installUpdate() without exploding.
    return;
  });

  ipcMain.handle("system:get-platform", () => process.platform);
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
