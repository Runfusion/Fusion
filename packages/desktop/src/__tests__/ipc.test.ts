import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  };

  const app = {
    getVersion: vi.fn(() => "1.2.3"),
  };

  const updateTrayStatus = vi.fn();
  const showExportSettingsDialog = vi.fn();
  const showImportSettingsDialog = vi.fn();
  const setupAutoUpdater = vi.fn();
  const triggerUpdateCheck = vi.fn(async () => ({ status: "checking" as const }));
  const readShellSettings = vi.fn(async () => ({
    desktopMode: "remote",
    hasCompletedModeSelection: true,
    activeProfileId: null,
    profiles: [],
  }));
  const writeShellSettings = vi.fn(async () => undefined);

  return {
    ipcMain,
    ipcHandlers,
    app,
    updateTrayStatus,
    showExportSettingsDialog,
    showImportSettingsDialog,
    setupAutoUpdater,
    triggerUpdateCheck,
    readShellSettings,
    writeShellSettings,
  };
});

vi.mock("electron", () => ({
  ipcMain: mocks.ipcMain,
  app: mocks.app,
}));

vi.mock("../tray.js", () => ({
  updateTrayStatus: mocks.updateTrayStatus,
}));

vi.mock("../native.js", () => ({
  showExportSettingsDialog: mocks.showExportSettingsDialog,
  showImportSettingsDialog: mocks.showImportSettingsDialog,
  setupAutoUpdater: mocks.setupAutoUpdater,
  triggerUpdateCheck: mocks.triggerUpdateCheck,
}));

vi.mock("../shell-settings.js", () => ({
  readShellSettings: mocks.readShellSettings,
  writeShellSettings: mocks.writeShellSettings,
  buildSavedProfile: (settings: { profiles: Array<{ id: string }>; }, profile: { id?: string; name: string; serverUrl: string }) => ({
    id: profile.id ?? "generated-id",
    name: profile.name.trim() || "Remote Server",
    serverUrl: profile.serverUrl,
    createdAt: "",
    updatedAt: "",
    authToken: null,
    lastUsedAt: null,
  }),
  applyDeleteProfile: (settings: { activeProfileId: string | null; profiles: Array<{ id: string }> }, profileId: string) => {
    const profiles = settings.profiles.filter((item) => item.id !== profileId);
    return {
      ...settings,
      profiles,
      activeProfileId: settings.activeProfileId === profileId ? (profiles[0]?.id ?? null) : settings.activeProfileId,
    };
  },
  applySetActiveProfile: (settings: { profiles: Array<{ id: string }> }, profileId: string | null) => ({
    ...settings,
    activeProfileId: profileId && settings.profiles.some((item) => item.id === profileId) ? profileId : null,
  }),
  getDesktopShellModeState: (settings: { hasCompletedModeSelection?: boolean; desktopMode?: "local" | "remote" | null }) => ({
    isFirstRun: !settings.hasCompletedModeSelection || !settings.desktopMode,
    desktopMode: settings.desktopMode ?? null,
  }),
}));

function createWindowMock() {
  return {
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
}

function createTrayMock() {
  return {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
  };
}

async function registerHandlers(options: Record<string, unknown> = {}) {
  const { registerIpcHandlers } = await import("../ipc.ts");
  const window = createWindowMock();
  const tray = createTrayMock();
  registerIpcHandlers(window as never, tray as never, options as never);
  return { window, tray };
}

describe("ipc handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.ipcHandlers.clear();
  });

  it("app:checkForUpdates delegates to triggerUpdateCheck", async () => {
    const { window } = await registerHandlers();
    const handler = mocks.ipcHandlers.get("app:checkForUpdates");
    mocks.triggerUpdateCheck.mockResolvedValueOnce({ status: "checking" });

    await expect(handler?.({})).resolves.toEqual({ status: "checking" });
    expect(mocks.triggerUpdateCheck).toHaveBeenCalledWith(window);
    expect(mocks.setupAutoUpdater).not.toHaveBeenCalled();
  });

  it("window:close delegates to BrowserWindow.close so platform lifecycle policy is inherited", async () => {
    const { window } = await registerHandlers();
    const handler = mocks.ipcHandlers.get("window:close");

    handler?.({});

    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it("registers shell channels", async () => {    await registerHandlers();

    const channels = new Set(mocks.ipcMain.handle.mock.calls.map(([channel]) => channel));
    expect(channels.has("shell:getState")).toBe(true);
    expect(channels.has("shell:saveProfile")).toBe(true);
    expect(channels.has("shell:getDesktopModeState")).toBe(true);
    expect(channels.has("shell:setDesktopMode")).toBe(true);
    expect(channels.has("desktopRuntime:getStatus")).toBe(true);
    expect(channels.has("desktopRuntime:startLocal")).toBe(true);
    expect(channels.has("desktopRuntime:stopLocal")).toBe(true);
    expect(channels.has("desktopLaunchMode:getMode")).toBe(true);
    expect(channels.has("desktopLaunchMode:getContext")).toBe(true);
    expect(channels.has("desktopLaunchMode:setMode")).toBe(true);
    expect(channels.has("platform:get")).toBe(true);
    expect(channels.has("shell:openConnectionManager")).toBe(true);
  });

  it("shell:getState returns desktop shell state", async () => {
    await registerHandlers({ getRuntimeStatus: () => ({ source: "none", state: "stopped" }) });
    const handler = mocks.ipcHandlers.get("shell:getState");
    const result = await handler?.({});

    expect(result).toMatchObject({ host: "desktop-shell", desktopMode: "remote" });
    expect(result).toMatchObject({ desktopModeState: { isFirstRun: false, desktopMode: "remote" } });
    expect(result).toMatchObject({ localRuntime: { source: "none", state: "stopped" } });
  });

  it("shell:setDesktopMode persists mode and emits state", async () => {
    const onDesktopModeChange = vi.fn(async () => undefined);
    const { window } = await registerHandlers({ onDesktopModeChange, getRuntimeStatus: () => ({ source: "none", state: "stopped" }) });
    const handler = mocks.ipcHandlers.get("shell:setDesktopMode");
    await handler?.({}, "local");

    expect(mocks.writeShellSettings).toHaveBeenCalledWith(
      expect.objectContaining({ desktopMode: "local", hasCompletedModeSelection: true }),
    );
    expect(onDesktopModeChange).toHaveBeenCalledWith("local");
    expect(window.webContents.send).toHaveBeenCalledWith("shell:state", expect.any(Object));
  });

  it("shell:setDesktopMode propagates local runtime startup errors", async () => {
    const onDesktopModeChange = vi.fn(async () => {
      throw new Error("dashboard import failed: ERR_IMPORT_ATTRIBUTE_MISSING");
    });
    const { window } = await registerHandlers({ onDesktopModeChange, getRuntimeStatus: () => ({ source: "embedded-local", state: "error", error: "dashboard import failed: ERR_IMPORT_ATTRIBUTE_MISSING" }) });
    const handler = mocks.ipcHandlers.get("shell:setDesktopMode");

    await expect(handler?.({}, "local")).rejects.toThrow("ERR_IMPORT_ATTRIBUTE_MISSING");

    expect(mocks.writeShellSettings).toHaveBeenCalledWith(
      expect.objectContaining({ desktopMode: "local", hasCompletedModeSelection: true }),
    );
    expect(window.webContents.send).not.toHaveBeenCalledWith("shell:state", expect.any(Object));
  });

  it("desktop launch mode handlers return mode/context and validate payload", async () => {
    const getDesktopLaunchContext = vi.fn(() => ({ mode: "remote", profileId: "profile_1", serverBaseUrl: "https://remote.example.com" }));
    const onDesktopLaunchModeChange = vi.fn(async () => undefined);
    const getDesktopLaunchMode = vi.fn(() => "remote");
    await registerHandlers({ onDesktopLaunchModeChange, getDesktopLaunchMode, getDesktopLaunchContext });

    await expect(mocks.ipcHandlers.get("desktopLaunchMode:getMode")?.({})).resolves.toBe("remote");
    await expect(mocks.ipcHandlers.get("desktopLaunchMode:getContext")?.({})).resolves.toEqual({ mode: "remote", profileId: "profile_1", serverBaseUrl: "https://remote.example.com" });
    await expect(mocks.ipcHandlers.get("desktopLaunchMode:setMode")?.({}, "local")).resolves.toBe("remote");
    await expect(mocks.ipcHandlers.get("desktopLaunchMode:setMode")?.({}, "bad")).rejects.toThrow("Invalid desktop launch mode");
    expect(onDesktopLaunchModeChange).toHaveBeenCalledWith("local");
  });

  it("desktopRuntime start/stop/getStatus handlers proxy runtime manager", async () => {
    const getRuntimeStatus = vi.fn(() => ({ source: "none", state: "stopped" }));
    const startLocalRuntime = vi.fn(async () => ({ source: "embedded-local", state: "running", port: 4510 }));
    const stopLocalRuntime = vi.fn(async () => ({ source: "embedded-local", state: "running", port: 9999 }));

    await registerHandlers({ getRuntimeStatus, startLocalRuntime, stopLocalRuntime });

    await expect(mocks.ipcHandlers.get("desktopRuntime:getStatus")?.({})).resolves.toEqual({ source: "none", state: "stopped" });
    await expect(mocks.ipcHandlers.get("desktopRuntime:startLocal")?.({})).resolves.toEqual({ source: "embedded-local", state: "running", port: 4510 });
    await expect(mocks.ipcHandlers.get("desktopRuntime:stopLocal")?.({})).resolves.toEqual({ source: "embedded-local", state: "running", port: 9999 });
  });

  it("shell:openConnectionManager notifies renderer", async () => {
    const { window } = await registerHandlers();
    const result = mocks.ipcHandlers.get("shell:openConnectionManager")?.({});
    expect(result).toBeUndefined();
    expect(window.webContents.send).toHaveBeenCalledWith("shell:open-connection-manager");
  });

  it("shell:saveProfile persists the helper-generated profile", async () => {
    await registerHandlers();
    const handler = mocks.ipcHandlers.get("shell:saveProfile");
    const result = await handler?.({}, { name: " Prod ", serverUrl: "https://fusion.example.com" });

    expect(result).toMatchObject({ id: "generated-id", name: "Prod" });
    expect(mocks.writeShellSettings).toHaveBeenCalledWith(expect.objectContaining({ profiles: [expect.objectContaining({ id: "generated-id" })] }));
  });

  it("shell:deleteProfile falls back to first remaining profile when deleting active", async () => {
    mocks.readShellSettings.mockResolvedValueOnce({
      desktopMode: "remote",
      hasCompletedModeSelection: true,
      activeProfileId: "p2",
      profiles: [{ id: "p1" }, { id: "p2" }],
    });
    await registerHandlers();

    const handler = mocks.ipcHandlers.get("shell:deleteProfile");
    await handler?.({}, "p2");

    expect(mocks.writeShellSettings).toHaveBeenCalledWith(expect.objectContaining({ activeProfileId: "p1" }));
  });
});
