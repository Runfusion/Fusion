import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function mockPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

const mocks = vi.hoisted(() => {
  const appHandlers = new Map<string, (...args: unknown[]) => void>();
  const app = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appHandlers.set(event, handler);
      return app;
    }),
    quit: vi.fn(),
  };

  const menu = {
    buildFromTemplate: vi.fn((template) => ({ template })),
  };

  const nativeImage = {
    createFromPath: vi.fn(() => ({
      resize: vi.fn(() => ({ id: "resized-image" })),
    })),
  };

  return {
    app,
    appHandlers,
    menu,
    nativeImage,
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  Menu: mocks.menu,
  nativeImage: mocks.nativeImage,
  BrowserWindow: vi.fn(),
  Tray: vi.fn(),
}));

function createMainWindowMock(isVisible = true) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let visible = isVisible;

  return {
    isVisible: vi.fn(() => visible),
    show: vi.fn(() => {
      visible = true;
    }),
    focus: vi.fn(),
    hide: vi.fn(() => {
      visible = false;
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
      return undefined;
    }),
    getListener(event: string) {
      return listeners.get(event);
    },
  };
}

function createTrayMock() {
  const listeners = new Map<string, (...args: unknown[]) => void>();

  return {
    setImage: vi.fn(),
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
      return undefined;
    }),
    getListener(event: string) {
      return listeners.get(event);
    },
  };
}

describe("tray module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.appHandlers.clear();
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  it("getTrayTooltip returns running label", async () => {
    const { getTrayTooltip } = await import("../tray.ts");
    expect(getTrayTooltip("running")).toBe("Fusion — Running");
  });

  it("getTrayTooltip returns paused label", async () => {
    const { getTrayTooltip } = await import("../tray.ts");
    expect(getTrayTooltip("paused")).toBe("Fusion — Paused");
  });

  it("getTrayTooltip returns stopped label", async () => {
    const { getTrayTooltip } = await import("../tray.ts");
    expect(getTrayTooltip("stopped")).toBe("Fusion — Stopped");
  });

  it("buildTrayContextMenu toggles show/hide label based on visibility", async () => {
    const { buildTrayContextMenu } = await import("../tray.ts");

    const hiddenMenu = buildTrayContextMenu({
      isWindowVisible: false,
      engineStatus: "running",
    });
    const visibleMenu = buildTrayContextMenu({
      isWindowVisible: true,
      engineStatus: "running",
    });

    expect(hiddenMenu[0]).toMatchObject({ label: "Show Window" });
    expect(visibleMenu[0]).toMatchObject({ label: "Hide Window" });
  });

  it("buildTrayContextMenu shows Pause/Resume labels and enables toggles for running/paused", async () => {
    const { buildTrayContextMenu } = await import("../tray.ts");

    const runningMenu = buildTrayContextMenu({
      isWindowVisible: true,
      engineStatus: "running",
    });
    const pausedMenu = buildTrayContextMenu({
      isWindowVisible: true,
      engineStatus: "paused",
    });

    expect(runningMenu[2]).toMatchObject({ label: "Pause Engine", enabled: true });
    expect(pausedMenu[2]).toMatchObject({ label: "Resume Engine", enabled: true });
  });

  it("buildTrayContextMenu disables engine toggle when stopped and includes separators and quit", async () => {
    const { buildTrayContextMenu } = await import("../tray.ts");

    const stoppedMenu = buildTrayContextMenu({
      isWindowVisible: true,
      engineStatus: "stopped",
    });

    const separatorCount = stoppedMenu.filter((item) => item.type === "separator").length;

    expect(stoppedMenu[2]).toMatchObject({ enabled: false });
    expect(separatorCount).toBe(2);
    expect(stoppedMenu[4]).toMatchObject({ label: "Quit Fusion" });
  });

  it("setupTray sets tooltip and context menu", async () => {
    const { setupTray } = await import("../tray.ts");
    const mainWindow = createMainWindowMock(true);
    const tray = createTrayMock();

    setupTray(mainWindow as never, tray as never);

    expect(tray.setImage).toHaveBeenCalledTimes(1);
    expect(tray.setToolTip).toHaveBeenCalledWith("Fusion — Running");
    expect(mocks.menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(tray.setContextMenu).toHaveBeenCalledTimes(1);
  });

  it("tray Show/Hide Window explicitly toggles visibility on every platform", async () => {
    mockPlatform("win32");
    const { setupTray } = await import("../tray.ts");
    const mainWindow = createMainWindowMock(true);
    const tray = createTrayMock();

    setupTray(mainWindow as never, tray as never);
    const visibleTemplate = mocks.menu.buildFromTemplate.mock.calls.at(-1)?.[0] as Array<{ label?: string; click?: () => void }>;
    visibleTemplate[0]?.click?.();
    mainWindow.getListener("hide")?.();
    expect(mainWindow.hide).toHaveBeenCalledTimes(1);

    const hiddenTemplate = mocks.menu.buildFromTemplate.mock.calls.at(-1)?.[0] as Array<{ label?: string; click?: () => void }>;
    expect(hiddenTemplate[0]).toMatchObject({ label: "Show Window" });
    hiddenTemplate[0]?.click?.();
    expect(mainWindow.show).toHaveBeenCalledTimes(1);
    expect(mainWindow.focus).toHaveBeenCalledTimes(1);
  });

  it("tray Quit Fusion sets quitting state and allows later close events", async () => {
    mockPlatform("darwin");
    const { setupTray } = await import("../tray.ts");
    const mainWindow = createMainWindowMock(true);
    const tray = createTrayMock();

    setupTray(mainWindow as never, tray as never);
    const template = mocks.menu.buildFromTemplate.mock.calls.at(-1)?.[0] as Array<{ label?: string; click?: () => void }>;
    template.find((item) => item.label === "Quit Fusion")?.click?.();

    const closeHandler = mainWindow.getListener("close") as ((event: { preventDefault: () => void }) => void) | undefined;
    const event = { preventDefault: vi.fn() };
    closeHandler?.(event);

    expect(mocks.app.quit).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mainWindow.hide).not.toHaveBeenCalled();
  });

  it("windows close events are not converted into tray hides by setupTray", async () => {
    mockPlatform("win32");
    const { setupTray } = await import("../tray.ts");
    const mainWindow = createMainWindowMock(true);
    const tray = createTrayMock();

    setupTray(mainWindow as never, tray as never);
    const closeHandler = mainWindow.getListener("close") as ((event: { preventDefault: () => void }) => void) | undefined;
    const event = { preventDefault: vi.fn() };

    closeHandler?.(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mainWindow.hide).not.toHaveBeenCalled();
  });

  it("macOS close events still hide to tray when quit is not in progress", async () => {
    mockPlatform("darwin");
    const { setupTray } = await import("../tray.ts");
    const mainWindow = createMainWindowMock(true);
    const tray = createTrayMock();

    setupTray(mainWindow as never, tray as never);
    const closeHandler = mainWindow.getListener("close") as ((event: { preventDefault: () => void }) => void) | undefined;
    const event = { preventDefault: vi.fn() };

    closeHandler?.(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mainWindow.hide).toHaveBeenCalledTimes(1);
  });

  it("updateTrayStatus updates tooltip and menu", async () => {
    const { setupTray, updateTrayStatus } = await import("../tray.ts");
    const mainWindow = createMainWindowMock(true);
    const tray = createTrayMock();

    setupTray(mainWindow as never, tray as never);
    updateTrayStatus(tray as never, "paused");

    expect(tray.setToolTip).toHaveBeenLastCalledWith("Fusion — Paused");
    expect(mocks.menu.buildFromTemplate).toHaveBeenCalledTimes(2);
  });

  it("updateTrayStatus still updates tooltip when tray was not initialized", async () => {
    const { updateTrayStatus } = await import("../tray.ts");
    const tray = createTrayMock();

    updateTrayStatus(tray as never, "stopped");

    expect(tray.setToolTip).toHaveBeenCalledWith("Fusion — Stopped");
    expect(tray.setContextMenu).toHaveBeenCalledTimes(1);
  });
});
