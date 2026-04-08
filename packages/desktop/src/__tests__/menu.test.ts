import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

const mocks = vi.hoisted(() => {
  const menuInstance = { id: "app-menu" };

  return {
    Menu: {
      buildFromTemplate: vi.fn(() => menuInstance),
      setApplicationMenu: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(() => Promise.resolve()),
    },
    menuInstance,
  };
});

vi.mock("electron", () => ({
  Menu: mocks.Menu,
  shell: mocks.shell,
}));

function createMainWindowMock() {
  return {
    webContents: {
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      toggleDevTools: vi.fn(),
      getZoomLevel: vi.fn(() => 1),
      setZoomLevel: vi.fn(),
    },
  };
}

function findMenuItem(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions | undefined {
  for (const item of template) {
    if (item.label === label) {
      return item;
    }

    if (Array.isArray(item.submenu)) {
      const nested = findMenuItem(item.submenu, label);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function collectAccelerators(template: MenuItemConstructorOptions[]): string[] {
  const accelerators: string[] = [];

  for (const item of template) {
    if (typeof item.accelerator === "string") {
      accelerators.push(item.accelerator);
    }

    if (Array.isArray(item.submenu)) {
      accelerators.push(...collectAccelerators(item.submenu));
    }
  }

  return accelerators;
}

describe("application menu", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("macOS template includes App menu with About, Preferences and Quit", async () => {
    const { buildMenuTemplate } = await import("../menu.ts");
    const template = buildMenuTemplate({
      mainWindow: createMainWindowMock() as never,
      appName: "Fusion",
    });

    expect(template[0]?.label).toBe("Fusion");

    const appMenu = template[0]?.submenu as MenuItemConstructorOptions[];
    expect(appMenu.some((item) => item.label === "About Fusion")).toBe(true);
    expect(appMenu.some((item) => item.label === "Preferences")).toBe(true);

    const preferences = appMenu.find((item) => item.label === "Preferences");
    const quit = appMenu.find((item) => item.label === "Quit Fusion");

    expect(preferences?.accelerator).toBe("CmdOrCtrl+,");
    expect(quit?.accelerator).toBe("CmdOrCtrl+Q");
  });

  it("Edit menu includes standard editing shortcuts", async () => {
    const { buildMenuTemplate } = await import("../menu.ts");
    const template = buildMenuTemplate({
      mainWindow: createMainWindowMock() as never,
      appName: "Fusion",
    });

    const editMenu = findMenuItem(template, "Edit");
    const editItems = (editMenu?.submenu ?? []) as MenuItemConstructorOptions[];

    expect(editItems.some((item) => item.label === "Undo" && item.accelerator === "CmdOrCtrl+Z")).toBe(
      true,
    );
    expect(editItems.some((item) => item.label === "Cut" && item.accelerator === "CmdOrCtrl+X")).toBe(true);
    expect(editItems.some((item) => item.label === "Copy" && item.accelerator === "CmdOrCtrl+C")).toBe(true);
    expect(editItems.some((item) => item.label === "Paste" && item.accelerator === "CmdOrCtrl+V")).toBe(
      true,
    );
    expect(
      editItems.some((item) => item.label === "Select All" && item.accelerator === "CmdOrCtrl+A"),
    ).toBe(true);
  });

  it("View menu includes zoom controls and dev tools shortcut", async () => {
    const { buildMenuTemplate } = await import("../menu.ts");
    const template = buildMenuTemplate({
      mainWindow: createMainWindowMock() as never,
      appName: "Fusion",
    });

    const viewMenu = findMenuItem(template, "View");
    const viewItems = (viewMenu?.submenu ?? []) as MenuItemConstructorOptions[];

    expect(
      viewItems.some((item) => item.label === "Zoom In" && item.accelerator === "CmdOrCtrl+Plus"),
    ).toBe(true);
    expect(viewItems.some((item) => item.label === "Zoom Out" && item.accelerator === "CmdOrCtrl+-")).toBe(
      true,
    );
    expect(viewItems.some((item) => item.label === "Reset Zoom" && item.accelerator === "CmdOrCtrl+0")).toBe(
      true,
    );
    expect(
      viewItems.some(
        (item) => item.label === "Toggle Dev Tools" && item.accelerator === "Alt+CmdOrCtrl+I",
      ),
    ).toBe(true);
  });

  it("Window menu includes Minimize and Close shortcuts", async () => {
    const { buildMenuTemplate } = await import("../menu.ts");
    const template = buildMenuTemplate({
      mainWindow: createMainWindowMock() as never,
      appName: "Fusion",
    });

    const windowMenu = findMenuItem(template, "Window");
    const windowItems = (windowMenu?.submenu ?? []) as MenuItemConstructorOptions[];

    expect(
      windowItems.some((item) => item.label === "Minimize" && item.accelerator === "CmdOrCtrl+M"),
    ).toBe(true);
    expect(windowItems.some((item) => item.label === "Close" && item.accelerator === "CmdOrCtrl+W")).toBe(
      true,
    );
  });

  it("non-macOS template omits App menu and app-specific labels", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    const { buildMenuTemplate } = await import("../menu.ts");
    const template = buildMenuTemplate({
      mainWindow: createMainWindowMock() as never,
      appName: "Fusion",
    });

    expect(template[0]?.label).toBe("Edit");
    expect(findMenuItem(template, "About Fusion")).toBeUndefined();
    expect(findMenuItem(template, "Hide Fusion")).toBeUndefined();
  });

  it("Help menu contains Fusion Documentation link", async () => {
    const { buildMenuTemplate } = await import("../menu.ts");
    const template = buildMenuTemplate({
      mainWindow: createMainWindowMock() as never,
      appName: "Fusion",
    });

    const docsItem = findMenuItem(template, "Fusion Documentation");

    expect(docsItem).toBeDefined();
    docsItem?.click?.({} as never, {} as never, {} as never);
    expect(mocks.shell.openExternal).toHaveBeenCalledWith(
      "https://github.com/eclipxe/fusion#readme",
    );
  });

  it("all keyboard shortcuts use CmdOrCtrl prefix convention", async () => {
    const { buildMenuTemplate } = await import("../menu.ts");
    const template = buildMenuTemplate({
      mainWindow: createMainWindowMock() as never,
      appName: "Fusion",
    });

    const accelerators = collectAccelerators(template);

    for (const accelerator of accelerators) {
      expect(accelerator).not.toMatch(/(^|[+])Cmd\+/);
      expect(accelerator).not.toMatch(/(^|[+])Ctrl\+/);
    }
  });

  it("buildAppMenu builds and sets the application menu", async () => {
    const { buildAppMenu } = await import("../menu.ts");

    const menu = buildAppMenu({
      mainWindow: createMainWindowMock() as never,
      appName: "Fusion",
    });

    expect(mocks.Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(mocks.Menu.setApplicationMenu).toHaveBeenCalledWith(mocks.menuInstance);
    expect(menu).toBe(mocks.menuInstance);
  });
});
