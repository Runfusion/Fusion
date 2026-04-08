import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const contextBridge = {
    exposeInMainWorld: vi.fn(),
  };

  const ipcRenderer = {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };

  return { contextBridge, ipcRenderer };
});

vi.mock("electron", () => ({
  contextBridge: mocks.contextBridge,
  ipcRenderer: mocks.ipcRenderer,
}));

async function importPreloadModule() {
  await import("../preload.ts");
}

function getExposedFusionDesktopApi() {
  const call = mocks.contextBridge.exposeInMainWorld.mock.calls.find(
    (entry) => entry[0] === "fusionDesktop",
  ) as [string, {
    getAppVersion: () => Promise<string>;
    quit: () => void;
    onDashboardReady: (callback: () => void) => () => void;
  }] | undefined;

  return call?.[1];
}

function getExposedElectronApi() {
  const call = mocks.contextBridge.exposeInMainWorld.mock.calls.find(
    (entry) => entry[0] === "electronAPI",
  ) as [string, {
    invoke: (channel: string, payload?: unknown) => Promise<unknown>;
    apiRequest: (method: string, path: string, body?: unknown) => Promise<unknown>;
    getServerPort: () => Promise<number>;
    windowControl: (action: string) => Promise<boolean | void>;
    onUpdateAvailable: (callback: (info: Record<string, unknown>) => void) => () => void;
    installUpdate: () => Promise<void>;
    onDeepLink: (callback: (url: string) => void) => () => void;
    getPlatform: () => Promise<string>;
  }] | undefined;

  return call?.[1];
}

describe("preload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("exposes fusionDesktop and electronAPI", async () => {
    await importPreloadModule();

    expect(mocks.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      "fusionDesktop",
      expect.any(Object),
    );
    expect(mocks.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      "electronAPI",
      expect.any(Object),
    );
  });

  it("fusionDesktop.getAppVersion calls ipcRenderer.invoke", async () => {
    mocks.ipcRenderer.invoke.mockResolvedValue("0.1.0");
    await importPreloadModule();

    const api = getExposedFusionDesktopApi();
    const version = await api?.getAppVersion();

    expect(version).toBe("0.1.0");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("app:get-version");
  });

  it("fusionDesktop.quit calls ipcRenderer.send", async () => {
    await importPreloadModule();

    const api = getExposedFusionDesktopApi();
    api?.quit();

    expect(mocks.ipcRenderer.send).toHaveBeenCalledWith("app:quit");
  });

  it("fusionDesktop.onDashboardReady returns unsubscribe function", async () => {
    await importPreloadModule();

    const api = getExposedFusionDesktopApi();
    const callback = vi.fn();
    const unsubscribe = api?.onDashboardReady(callback);

    expect(mocks.ipcRenderer.on).toHaveBeenCalledWith(
      "dashboard:ready",
      expect.any(Function),
    );
    expect(typeof unsubscribe).toBe("function");

    unsubscribe?.();

    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith(
      "dashboard:ready",
      expect.any(Function),
    );
  });

  it("electronAPI methods invoke expected IPC channels", async () => {
    await importPreloadModule();

    const api = getExposedElectronApi();
    await api?.invoke("api-request", { method: "GET", path: "/tasks" });
    await api?.apiRequest("POST", "/tasks", { title: "Task" });
    await api?.getServerPort();
    await api?.windowControl("maximize");
    await api?.installUpdate();
    await api?.getPlatform();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("api-request", { method: "GET", path: "/tasks" });
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("api-request", { method: "POST", path: "/tasks", body: { title: "Task" } });
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("server:get-port");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("window:control", "maximize");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("update:install");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("system:get-platform");
  });

  it("electronAPI event subscriptions provide unsubscribe functions", async () => {
    await importPreloadModule();

    const api = getExposedElectronApi();
    const onUpdate = vi.fn();
    const onDeepLink = vi.fn();

    const unsubscribeUpdate = api?.onUpdateAvailable(onUpdate);
    const unsubscribeDeepLink = api?.onDeepLink(onDeepLink);

    expect(mocks.ipcRenderer.on).toHaveBeenCalledWith("update:available", expect.any(Function));
    expect(mocks.ipcRenderer.on).toHaveBeenCalledWith("deep-link", expect.any(Function));

    unsubscribeUpdate?.();
    unsubscribeDeepLink?.();

    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith("update:available", expect.any(Function));
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith("deep-link", expect.any(Function));
  });
});
