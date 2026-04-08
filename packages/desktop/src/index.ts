export {
  createMainWindow,
  setupTray,
  updateTrayStatus,
  registerIpcHandlers,
  DASHBOARD_URL,
  run,
} from "./main.js";

export { createTrayIcon, buildTrayContextMenu, getTrayTooltip } from "./tray.js";
export { buildMenuTemplate, buildAppMenu } from "./menu.js";

export type { EngineStatus, TrayMenuOptions } from "./tray.js";
export type { AppMenuOptions } from "./menu.js";
export type { FusionDesktopAPI } from "./preload.js";
