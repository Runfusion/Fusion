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

function getExposed<T = unknown>(name: string): T | undefined {
  return mocks.contextBridge.exposeInMainWorld.mock.calls.find(([key]) => key === name)?.[1] as T | undefined;
}

describe("preload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("exposes electronAPI and fusionShell", async () => {
    await importPreloadModule();

    expect(getExposed("electronAPI")).toBeTruthy();
    expect(getExposed("fusionAPI")).toBeTruthy();
    expect(getExposed("fusionShell")).toBeTruthy();
  });

  it("electronAPI delegates getServerPort to IPC", async () => {
    await importPreloadModule();
    const api = getExposed<{ getServerPort: () => Promise<number | undefined> }>("electronAPI");

    await api?.getServerPort();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("app:getServerPort");
  });

  it("electronAPI launch mode methods delegate to IPC", async () => {
    await importPreloadModule();
    const api = getExposed<{
      getDesktopLaunchMode: () => Promise<string>;
      getDesktopLaunchContext: () => Promise<unknown>;
      setDesktopLaunchMode: (mode: "choose" | "local" | "remote") => Promise<string>;
      openConnectionManager: () => Promise<void>;
    }>("electronAPI");

    await api?.getDesktopLaunchMode();
    await api?.getDesktopLaunchContext();
    await api?.setDesktopLaunchMode("local");
    await api?.openConnectionManager();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("desktopLaunchMode:getMode");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("desktopLaunchMode:getContext");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("desktopLaunchMode:setMode", "local");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("shell:openConnectionManager");
  });

  it("bridges the shell:open-connection-manager IPC into a window DOM event", async () => {
    // Regression: main sends `shell:open-connection-manager` via webContents.send when the header
    // "Switch server" button is clicked; the renderer's ShellContext listens via
    // window.addEventListener. Without the preload forwarding it, clicking did nothing.
    await importPreloadModule();

    const bridge = mocks.ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === "shell:open-connection-manager",
    )?.[1] as (() => void) | undefined;
    expect(bridge).toBeTruthy();

    const dispatched: string[] = [];
    const priorWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      dispatchEvent: (event: Event) => {
        dispatched.push(event.type);
        return true;
      },
    };
    try {
      bridge?.();
    } finally {
      (globalThis as { window?: unknown }).window = priorWindow;
    }

    expect(dispatched).toContain("shell:open-connection-manager");
  });

  it("electronAPI exposes update-not-available and update-error listeners", async () => {
    await importPreloadModule();
    const api = getExposed<{
      onUpdateNotAvailable: (listener: (info: { version?: string }) => void) => () => void;
      onUpdateError: (listener: (info: { message: string }) => void) => () => void;
    }>("electronAPI");

    const onNotAvailable = vi.fn();
    const onError = vi.fn();

    const unsubscribeNotAvailable = api?.onUpdateNotAvailable(onNotAvailable);
    const unsubscribeError = api?.onUpdateError(onError);

    const notAvailableHandler = mocks.ipcRenderer.on.mock.calls.find(([channel]) => channel === "update-not-available")?.[1] as
      | ((event: unknown, info: { version?: string }) => void)
      | undefined;
    const errorHandler = mocks.ipcRenderer.on.mock.calls.find(([channel]) => channel === "update-error")?.[1] as
      | ((event: unknown, info: { message: string }) => void)
      | undefined;

    notAvailableHandler?.({} as never, { version: "1.2.3" });
    errorHandler?.({} as never, { message: "network" });

    expect(onNotAvailable).toHaveBeenCalledWith({ version: "1.2.3" });
    expect(onError).toHaveBeenCalledWith({ message: "network" });

    unsubscribeNotAvailable?.();
    unsubscribeError?.();

    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith("update-not-available", expect.any(Function));
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith("update-error", expect.any(Function));
  });

  it("fusionShell delegates connection-management methods to IPC", async () => {    await importPreloadModule();
    const shell = getExposed<{
      getState: () => Promise<unknown>;
      listProfiles: () => Promise<unknown>;
      saveProfile: (profile: { name: string; serverUrl: string; authToken?: string | null }) => Promise<unknown>;
      deleteProfile: (profileId: string) => Promise<void>;
      setActiveProfile: (profileId: string | null) => Promise<unknown>;
      getDesktopModeState: () => Promise<unknown>;
      setDesktopMode: (mode: "local" | "remote") => Promise<unknown>;
      startQrScan: () => Promise<unknown>;
      openConnectionManager: () => Promise<void>;
      subscribe: (listener: (state: unknown) => void) => () => void;
    }>("fusionShell");

    await shell?.getState();
    await shell?.listProfiles();
    await shell?.saveProfile({ name: "Prod", serverUrl: "https://fusion.example.com", authToken: "token" });
    await shell?.deleteProfile("p1");
    await shell?.setActiveProfile("p1");
    await shell?.getDesktopModeState();
    await shell?.setDesktopMode("local");
    await shell?.startQrScan();
    await shell?.openConnectionManager();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("shell:getState");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("shell:listProfiles");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("shell:saveProfile", {
      name: "Prod",
      serverUrl: "https://fusion.example.com",
      authToken: "token",
    });
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("shell:deleteProfile", "p1");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("shell:setActiveProfile", "p1");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("shell:getDesktopModeState");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("shell:setDesktopMode", "local");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("shell:startQrScan");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("shell:openConnectionManager");

    const unsubscribe = shell?.subscribe(() => undefined);
    expect(mocks.ipcRenderer.on).toHaveBeenCalledWith("shell:state", expect.any(Function));

    unsubscribe?.();

    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith("shell:state", expect.any(Function));
  });
});
