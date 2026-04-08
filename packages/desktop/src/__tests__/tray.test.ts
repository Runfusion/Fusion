import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const app = {
    on: vi.fn(),
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

  return {
    isVisible: vi.fn(() => isVisible),
    show: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
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
