import {
  Menu,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from "electron";

export interface AppMenuOptions {
  mainWindow: BrowserWindow;
  appName: string;
  onChangeLaunchMode?: () => Promise<void> | void;
  onStartLocalRuntime?: () => Promise<void> | void;
  onStopLocalRuntime?: () => Promise<void> | void;
  onConnectRemoteServer?: () => Promise<void> | void;
  onCheckForUpdates?: () => Promise<void> | void;
}

function runMenuAction(label: string, action: (() => Promise<void> | void) | undefined): void {
  if (!action) return;
  void Promise.resolve(action()).catch((error: unknown) => {
    console.error(`[desktop/menu] ${label} failed`, error);
  });
}

function buildConnectionSubmenu(options: AppMenuOptions): MenuItemConstructorOptions {
  /*
   * FNXC:DesktopConnectionMenu 2026-06-21-02:04:
   * Desktop users need menu-level controls to start the embedded local server, shut it down, or connect to a remote server without returning to first-run setup.
   */
  return {
    label: "Connection",
    submenu: [
      {
        label: "Use Local Server",
        click: () => runMenuAction("onStartLocalRuntime", options.onStartLocalRuntime),
      },
      {
        label: "Shut Down Local Server",
        click: () => runMenuAction("onStopLocalRuntime", options.onStopLocalRuntime),
      },
      {
        type: "separator",
      },
      {
        label: "Connect to Remote Server…",
        click: () => runMenuAction("onConnectRemoteServer", options.onConnectRemoteServer ?? options.onChangeLaunchMode),
      },
      {
        label: "Change Launch Mode…",
        click: () => runMenuAction("onChangeLaunchMode", options.onChangeLaunchMode),
      },
    ],
  };
}

function buildAppSubmenu(options: AppMenuOptions): MenuItemConstructorOptions {
  return {
    label: options.appName,
    submenu: [
      {
        label: `About ${options.appName}`,
      },
      {
        label: "Check for Updates…",
        click: () => runMenuAction("onCheckForUpdates", options.onCheckForUpdates),
      },
      {
        type: "separator",
      },
      {
        label: "Preferences",
        accelerator: "CmdOrCtrl+,",
      },
      {
        type: "separator",
      },
      {
        label: `Hide ${options.appName}`,
        role: "hide",
      },
      {
        label: "Hide Others",
        role: "hideOthers",
      },
      {
        label: "Show All",
        role: "unhide",
      },
      {
        type: "separator",
      },
      {
        label: `Quit ${options.appName}`,
        accelerator: "CmdOrCtrl+Q",
        role: "quit",
      },
    ],
  };
}

function buildEditSubmenu(): MenuItemConstructorOptions {
  return {
    label: "Edit",
    submenu: [
      {
        label: "Undo",
        accelerator: "CmdOrCtrl+Z",
        role: "undo",
      },
      {
        label: "Redo",
        accelerator: "Shift+CmdOrCtrl+Z",
        role: "redo",
      },
      {
        type: "separator",
      },
      {
        label: "Cut",
        accelerator: "CmdOrCtrl+X",
        role: "cut",
      },
      {
        label: "Copy",
        accelerator: "CmdOrCtrl+C",
        role: "copy",
      },
      {
        label: "Paste",
        accelerator: "CmdOrCtrl+V",
        role: "paste",
      },
      {
        label: "Select All",
        accelerator: "CmdOrCtrl+A",
        role: "selectAll",
      },
    ],
  };
}

function buildViewSubmenu(options: AppMenuOptions): MenuItemConstructorOptions {
  const { webContents } = options.mainWindow;

  return {
    label: "View",
    submenu: [
      {
        label: "Reload",
        accelerator: "CmdOrCtrl+R",
        click: () => webContents.reload(),
      },
      {
        label: "Force Reload",
        accelerator: "CmdOrCtrl+Shift+R",
        click: () => webContents.reloadIgnoringCache(),
      },
      {
        type: "separator",
      },
      {
        label: "Toggle Dev Tools",
        accelerator: "Alt+CmdOrCtrl+I",
        click: () => webContents.toggleDevTools(),
      },
      {
        type: "separator",
      },
      {
        label: "Zoom In",
        accelerator: "CmdOrCtrl+Plus",
        click: () => {
          const level = webContents.getZoomLevel();
          webContents.setZoomLevel(level + 0.5);
        },
      },
      {
        label: "Zoom Out",
        accelerator: "CmdOrCtrl+-",
        click: () => {
          const level = webContents.getZoomLevel();
          webContents.setZoomLevel(level - 0.5);
        },
      },
      {
        label: "Reset Zoom",
        accelerator: "CmdOrCtrl+0",
        click: () => {
          webContents.setZoomLevel(0);
        },
      },
      {
        type: "separator",
      },
      {
        label: "Toggle Full Screen",
        accelerator: "F11",
        role: "togglefullscreen",
      },
    ],
  };
}

function buildWindowSubmenu(isMac: boolean): MenuItemConstructorOptions {
  const windowItems: MenuItemConstructorOptions[] = [
    {
      label: "Minimize",
      accelerator: "CmdOrCtrl+M",
      role: "minimize",
    },
  ];

  if (isMac) {
    windowItems.push({
      label: "Zoom",
      role: "zoom",
    });
  }

  windowItems.push(
    {
      type: "separator",
    },
    {
      label: "Close",
      accelerator: "CmdOrCtrl+W",
      role: "close",
    },
  );

  if (isMac) {
    windowItems.push(
      {
        type: "separator",
      },
      {
        label: "Bring All to Front",
        role: "front",
      },
    );
  }

  return {
    label: "Window",
    submenu: windowItems,
  };
}

function buildHelpSubmenu(options: AppMenuOptions): MenuItemConstructorOptions {
  return {
    label: "Help",
    submenu: [
      {
        label: "Check for Updates…",
        click: () => runMenuAction("onCheckForUpdates", options.onCheckForUpdates),
      },
      {
        label: "Fusion Documentation",
        click: () => {
          void shell.openExternal("https://github.com/Runfusion/Fusion#readme");
        },
      },
    ],
  };
}

export function buildMenuTemplate(options: AppMenuOptions): MenuItemConstructorOptions[] {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    buildEditSubmenu(),
    buildViewSubmenu(options),
    buildConnectionSubmenu(options),
    buildWindowSubmenu(isMac),
    buildHelpSubmenu(options),
  ];

  if (isMac) {
    template.unshift(buildAppSubmenu(options));
  }

  return template;
}

export function buildAppMenu(options: AppMenuOptions): Menu {
  const menu = Menu.buildFromTemplate(buildMenuTemplate(options));
  Menu.setApplicationMenu(menu);
  return menu;
}
