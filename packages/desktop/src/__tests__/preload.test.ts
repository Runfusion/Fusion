import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const contextBridge = {
    exposeInMainWorld: vi.fn(),
  };

  const ipcRenderer = {
    invoke: vi.fn(),
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

function getFusionApi() {
  const call = mocks.contextBridge.exposeInMainWorld.mock.calls.find(
    ([name]) => name === "fusionAPI",
  ) as [string, {
    minimize: () => Promise<void>;
    maximize: () => Promise<boolean>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    getSystemInfo: () => Promise<unknown>;
    checkForUpdates: () => Promise<unknown>;
    updateTrayStatus: (status: string) => Promise<void>;
    showExportDialog: () => Promise<string | null>;
    showImportDialog: () => Promise<string | null>;
    onDeepLink: (callback: (result: unknown) => void) => () => void;
    onUpdateAvailable: (callback: (info: { version: string }) => void) => () => void;
    onUpdateDownloaded: (callback: () => void) => () => void;
  }] | undefined;

  return call?.[1];
}

describe("preload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("contextBridge.exposeInMainWorld is called with fusionAPI", async () => {
    await importPreloadModule();

    expect(mocks.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      "fusionAPI",
      expect.any(Object),
    );
  });

  it("minimize invokes window:minimize", async () => {
    await importPreloadModule();

    const api = getFusionApi();
    await api?.minimize();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("window:minimize");
  });

  it("maximize invokes window:maximize", async () => {
    await importPreloadModule();

    const api = getFusionApi();
    await api?.maximize();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("window:maximize");
  });

  it("close invokes window:close", async () => {
    await importPreloadModule();

    const api = getFusionApi();
    await api?.close();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("window:close");
  });

  it("isMaximized invokes window:isMaximized", async () => {
    await importPreloadModule();

    const api = getFusionApi();
    await api?.isMaximized();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("window:isMaximized");
  });

  it("getSystemInfo invokes app:getSystemInfo", async () => {
    await importPreloadModule();

    const api = getFusionApi();
    await api?.getSystemInfo();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("app:getSystemInfo");
  });

  it("checkForUpdates invokes app:checkForUpdates", async () => {
    await importPreloadModule();

    const api = getFusionApi();
    await api?.checkForUpdates();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("app:checkForUpdates");
  });

  it("updateTrayStatus invokes tray:updateStatus with status argument", async () => {
    await importPreloadModule();

    const api = getFusionApi();
    await api?.updateTrayStatus("paused");

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("tray:updateStatus", "paused");
  });

  it("showExportDialog invokes native:showExportDialog", async () => {
    await importPreloadModule();

    const api = getFusionApi();
    await api?.showExportDialog();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("native:showExportDialog");
  });

  it("showImportDialog invokes native:showImportDialog", async () => {
    await importPreloadModule();

    const api = getFusionApi();
    await api?.showImportDialog();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("native:showImportDialog");
  });

  it("onDeepLink subscribes to deep-link and returns unsubscribe", async () => {
    await importPreloadModule();

    const api = getFusionApi();
    const callback = vi.fn();
    const unsubscribe = api?.onDeepLink(callback);

    expect(mocks.ipcRenderer.on).toHaveBeenCalledWith("deep-link", expect.any(Function));

    unsubscribe?.();

    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith(
      "deep-link",
      expect.any(Function),
    );
  });

  it("onUpdateAvailable subscribes to update-available and returns unsubscribe", async () => {
    await importPreloadModule();

    const api = getFusionApi();
    const callback = vi.fn();
    const unsubscribe = api?.onUpdateAvailable(callback);

    expect(mocks.ipcRenderer.on).toHaveBeenCalledWith("update-available", expect.any(Function));

    unsubscribe?.();

    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith(
      "update-available",
      expect.any(Function),
    );
  });

  it("onUpdateDownloaded subscribes to update-downloaded and returns unsubscribe", async () => {
    await importPreloadModule();

    const api = getFusionApi();
    const callback = vi.fn();
    const unsubscribe = api?.onUpdateDownloaded(callback);

    expect(mocks.ipcRenderer.on).toHaveBeenCalledWith("update-downloaded", expect.any(Function));

    unsubscribe?.();

    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith(
      "update-downloaded",
      expect.any(Function),
    );
  });
});
