import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const app = {
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn(),
  };

  const browserWindow = {
    loadURL: vi.fn(),
    on: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    maximize: vi.fn(),
  };

  return {
    app,
    BrowserWindow: vi.fn(() => browserWindow),
    Tray: vi.fn(() => ({
      destroy: vi.fn(),
      setImage: vi.fn(),
      setContextMenu: vi.fn(),
      setToolTip: vi.fn(),
      on: vi.fn(),
    })),
    nativeImage: {
      createEmpty: vi.fn(() => ({ id: "empty-image" })),
    },
    browserWindow,
    buildAppMenu: vi.fn(),
    setupTray: vi.fn(),
    registerIpcHandlers: vi.fn(),
    registerDeepLinkProtocol: vi.fn(),
    setupDeepLinkHandler: vi.fn(),
    loadWindowState: vi.fn(async () => null),
    saveWindowState: vi.fn(),
    setupAutoUpdater: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  Tray: mocks.Tray,
  nativeImage: mocks.nativeImage,
}));

vi.mock("../menu.js", () => ({
  buildAppMenu: mocks.buildAppMenu,
}));

vi.mock("../tray.js", () => ({
  setupTray: mocks.setupTray,
}));

vi.mock("../ipc.js", () => ({
  registerIpcHandlers: mocks.registerIpcHandlers,
}));

vi.mock("../deep-link.js", () => ({
  registerDeepLinkProtocol: mocks.registerDeepLinkProtocol,
  setupDeepLinkHandler: mocks.setupDeepLinkHandler,
}));

vi.mock("../native.js", () => ({
  DEFAULT_WINDOW_STATE: {
    width: 1280,
    height: 900,
    isMaximized: false,
  },
  loadWindowState: mocks.loadWindowState,
  saveWindowState: mocks.saveWindowState,
  setupAutoUpdater: mocks.setupAutoUpdater,
}));

describe("main module integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("imports main module exports with a mocked electron runtime", async () => {
    const mainModule = await import("../main.ts");

    expect(mainModule.run).toBeTypeOf("function");
    expect(mainModule.initializeApp).toBeTypeOf("function");
    expect(mainModule.createMainWindow).toBeTypeOf("function");
  });

  it("initializes app lifecycle wiring without throwing", async () => {
    const { initializeApp } = await import("../main.ts");

    await expect(initializeApp()).resolves.toBeUndefined();
    expect(mocks.BrowserWindow).toHaveBeenCalledTimes(1);
    expect(mocks.registerIpcHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupTray).toHaveBeenCalledTimes(1);
  });
});
