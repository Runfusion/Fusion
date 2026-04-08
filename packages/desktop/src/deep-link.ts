import { app, BrowserWindow } from "electron";

export interface DeepLinkResult {
  type: "task" | "project" | "unknown";
  id: string;
  raw: string;
}

const DEEP_LINK_EVENT = "deep-link";
const FUSION_SCHEME = "fusion:";

export function registerDeepLinkProtocol(): void {
  try {
    const isRegistered = app.setAsDefaultProtocolClient("fusion");
    if (!isRegistered) {
      console.warn("[desktop/deep-link] Failed to register fusion:// protocol");
      return;
    }

    console.log("[desktop/deep-link] Registered fusion:// protocol handler");
  } catch (error) {
    console.error("[desktop/deep-link] Error while registering fusion:// protocol", error);
  }
}

export function parseDeepLink(rawUrl: string): DeepLinkResult | null {
  if (!rawUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(rawUrl);

    if (parsedUrl.protocol !== FUSION_SCHEME) {
      return null;
    }

    const type = parsedUrl.hostname;
    if (type !== "task" && type !== "project") {
      return null;
    }

    const pathSegments = parsedUrl.pathname
      .split("/")
      .filter((segment) => segment.length > 0);

    const decodedId = pathSegments.length > 0 ? decodeURIComponent(pathSegments[0]) : "";

    return {
      type,
      id: decodedId,
      raw: rawUrl,
    };
  } catch {
    return null;
  }
}

export function handleDeepLink(mainWindow: BrowserWindow, url: string): void {
  const parsed = parseDeepLink(url);

  if (!parsed || parsed.type === "unknown") {
    console.warn(`[desktop/deep-link] Ignoring unsupported deep link: ${url}`);
    return;
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
  mainWindow.webContents.send(DEEP_LINK_EVENT, parsed);
}

export function setupDeepLinkHandler(mainWindow: BrowserWindow): void {
  const hasLock = app.requestSingleInstanceLock();
  if (!hasLock) {
    app.quit();
    return;
  }

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(mainWindow, url);
  });

  app.on("second-instance", (_event, argv) => {
    const deepLink = argv.find((arg) => arg.startsWith("fusion://"));
    if (!deepLink) {
      return;
    }

    handleDeepLink(mainWindow, deepLink);
  });
}
