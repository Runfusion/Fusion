import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const browserWindowInstance = {
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    on: vi.fn(),
    isVisible: vi.fn(() => true),
    show: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
  };

  const BrowserWindow = vi.fn(() => browserWindowInstance) as unknown as {
    (...args: unknown[]): typeof browserWindowInstance;
    getAllWindows: () => unknown[];
  };
  BrowserWindow.getAllWindows = vi.fn(() => []);

  const app = {
    whenReady: vi.fn(() => Promise.resolve()),
    getVersion: vi.fn(() => "0.1.0"),
    quit: vi.fn(),
    on: vi.fn(),
  };

  const ipcMain = {
    handle: vi.fn(),
    on: vi.fn(),
  };

  const trayInstance = {
    setImage: vi.fn(),
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn(),
  };

  const Tray = vi.fn(() => trayInstance);
  const Menu = {
    buildFromTemplate: vi.fn(() => ({ id: "mock-menu" })),
    setApplicationMenu: vi.fn(),
  };
  const nativeImage = {
    createEmpty: vi.fn(() => ({ id: "mock-image" })),
    createFromPath: vi.fn(() => ({
      resize: vi.fn(() => ({ id: "resized-image" })),
    })),
  };

  const shell = {
    openExternal: vi.fn(() => Promise.resolve()),
  };

  const isDevelopmentMode = vi.fn(() => false);
  const getRendererUrl = vi.fn(() => "file:///path/to/dist/client/index.html");
  const getRendererFilePath = vi.fn(() => "/path/to/dist/client/index.html");
  const isUrlRenderer = vi.fn(() => false);

  return {
    app,
    BrowserWindow,
    ipcMain,
    trayInstance,
    Tray,
    Menu,
    nativeImage,
    shell,
    browserWindowInstance,
    isDevelopmentMode,
    getRendererUrl,
    getRendererFilePath,
    isUrlRenderer,
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  ipcMain: mocks.ipcMain,
  Tray: mocks.Tray,
  Menu: mocks.Menu,
  nativeImage: mocks.nativeImage,
  shell: mocks.shell,
}));

// Mock renderer module
vi.mock("../renderer.js", () => ({
  isDevelopmentMode: mocks.isDevelopmentMode,
  getRendererUrl: mocks.getRendererUrl,
  getRendererFilePath: mocks.getRendererFilePath,
  isUrlRenderer: mocks.isUrlRenderer,
  IS_DEVELOPMENT: false,
  DASHBOARD_URL: mocks.getRendererUrl,
}));

async function importMainModule() {
  return import("../main.ts");
}

describe("main process", () => {
  const originalDashboardUrl = process.env.FUSION_DASHBOARD_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    if (originalDashboardUrl === undefined) {
      delete process.env.FUSION_DASHBOARD_URL;
    } else {
      process.env.FUSION_DASHBOARD_URL = originalDashboardUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    // Ensure we're in production mode for these tests
    mocks.isDevelopmentMode.mockReturnValue(false);
    mocks.getRendererUrl.mockReturnValue("file:///path/to/dist/client/index.html");
    mocks.getRendererFilePath.mockReturnValue("/path/to/dist/client/index.html");
    mocks.isUrlRenderer.mockReturnValue(false);
  });

  it("DASHBOARD_URL defaults to local file URL in production mode", async () => {
    delete process.env.FUSION_DASHBOARD_URL;

    const { DASHBOARD_URL } = await importMainModule();

    expect(DASHBOARD_URL()).toMatch(/^file:\/\//);
    expect(DASHBOARD_URL()).toContain("/client/index.html");
  });

  it("DASHBOARD_URL uses env override in development mode", async () => {
    process.env.FUSION_DASHBOARD_URL = "http://localhost:5050";
    // Mock development mode to use the env var
    mocks.isDevelopmentMode.mockReturnValue(true);
    mocks.getRendererUrl.mockReturnValue("http://localhost:5050");
    mocks.getRendererFilePath.mockReturnValue("");
    mocks.isUrlRenderer.mockReturnValue(true);

    const { DASHBOARD_URL } = await importMainModule();

    expect(DASHBOARD_URL()).toBe("http://localhost:5050");
  });

  it("createMainWindow creates BrowserWindow with secure preferences", async () => {
    const { createMainWindow } = await importMainModule();

    createMainWindow();

    expect(mocks.BrowserWindow).toHaveBeenCalledTimes(1);
    const [options] = mocks.BrowserWindow.mock.calls[0] as [
      {
        webPreferences: {
          contextIsolation: boolean;
          nodeIntegration: boolean;
          preload: string;
        };
      },
    ];

    expect(options.webPreferences.contextIsolation).toBe(true);
    expect(options.webPreferences.nodeIntegration).toBe(false);
    expect(options.webPreferences.preload).toContain("preload.js");
  });

  it("createMainWindow loads the renderer URL in URL mode", async () => {
    mocks.isUrlRenderer.mockReturnValue(true);
    mocks.getRendererUrl.mockReturnValue("http://localhost:3000/index.html");
    mocks.getRendererFilePath.mockReturnValue("");

    const { createMainWindow } = await importMainModule();

    createMainWindow();

    expect(mocks.browserWindowInstance.loadURL).toHaveBeenCalledWith("http://localhost:3000/index.html");
    expect(mocks.browserWindowInstance.loadFile).not.toHaveBeenCalled();
  });

  it("createMainWindow loads the renderer file in file mode (production)", async () => {
    mocks.isUrlRenderer.mockReturnValue(false);
    mocks.getRendererUrl.mockReturnValue("file:///path/to/dist/client/index.html");
    mocks.getRendererFilePath.mockReturnValue("/path/to/dist/client/index.html");

    const { createMainWindow } = await importMainModule();

    createMainWindow();

    expect(mocks.browserWindowInstance.loadFile).toHaveBeenCalledWith("/path/to/dist/client/index.html");
    expect(mocks.browserWindowInstance.loadURL).not.toHaveBeenCalled();
  });

  it("exports initializeApp for lifecycle orchestration", async () => {
    const mainModule = await importMainModule();

    expect(typeof mainModule.initializeApp).toBe("function");
  });

  it("createMainWindow registers close and closed handlers", async () => {
    const { createMainWindow } = await importMainModule();

    createMainWindow();

    expect(mocks.browserWindowInstance.on).toHaveBeenCalledWith("close", expect.any(Function));
    expect(mocks.browserWindowInstance.on).toHaveBeenCalledWith("closed", expect.any(Function));
  });

  it("importing main does not auto-start", async () => {
    await importMainModule();

    expect(mocks.app.whenReady).not.toHaveBeenCalled();
  });

  it("exports run for app entrypoint wiring", async () => {
    const mainModule = await importMainModule();

    expect(typeof mainModule.run).toBe("function");
  });
});
