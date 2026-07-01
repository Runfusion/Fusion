import {
  DeepLinkManager,
  type DeepLinkManagerOptions,
} from "./plugins/deep-links.js";
import {
  PushNotificationManager,
  type PushNotificationManagerOptions,
} from "./plugins/push-notifications.js";
import { ShareManager, type ShareManagerOptions } from "./plugins/share.js";
import { MobileNativeShellBridge } from "./plugins/native-shell.js";

export { DeepLinkManager } from "./plugins/deep-links.js";
export type {
  DeepLinkEventMap,
  DeepLinkManagerOptions,
  DeepLinkPayload,
} from "./plugins/deep-links.js";
export { PushNotificationManager } from "./plugins/push-notifications.js";
export type {
  PushNotificationEventMap,
  PushNotificationManagerOptions,
} from "./plugins/push-notifications.js";
export { ShareManager } from "./plugins/share.js";
export {
  AndroidBackButtonManager,
  FUSION_NATIVE_BACK_EVENT,
  MobileNativeShellBridge,
} from "./plugins/native-shell.js";
export { buildMobileShellHandoff } from "./plugins/shell-handoff.js";
export { QrScanner, parseQrConnectionPayload } from "./plugins/qr-scanner.js";
export {
  loadShellProfiles,
  listShellProfiles,
  saveShellProfile,
  deleteShellProfile,
  setActiveShellProfile,
} from "./plugins/connection-profiles.js";
export type {
  ShareEventMap,
  ShareManagerOptions,
  ShareTaskPayload,
} from "./plugins/share.js";
export type {
  FusionShellApi,
  MobilePluginManager,
  PluginEventMap,
  ShellConnectionProfile,
  ShellConnectionProfileInput,
  ShellConnectionState,
  MobileShellHandoffResult,
  MobileRemoteShellLaunch,
} from "./types.js";

interface LifecycleManager {
  initialize?: () => Promise<void>;
  start?: () => Promise<void>;
}

export interface InitializePluginsOptions {
  pushNotifications?:
    | boolean
    | PushNotificationManager
    | PushNotificationManagerOptions;
  share?: boolean | ShareManager | ShareManagerOptions;
  deepLinks?: boolean | DeepLinkManager | DeepLinkManagerOptions;
}

export interface InitializePluginsResult {
  pushNotifications?: PushNotificationManager;
  share?: ShareManager;
  deepLinks?: DeepLinkManager;
}

async function initializeManager(manager: LifecycleManager): Promise<void> {
  if (typeof manager.initialize === "function") {
    await manager.initialize();
    return;
  }

  if (typeof manager.start === "function") {
    await manager.start();
  }
}

export function installMobileShellBridge(
  target: Window & typeof globalThis = window,
): MobileNativeShellBridge {
  const bridge = new MobileNativeShellBridge();
  (target as Window & { fusionShell?: MobileNativeShellBridge }).fusionShell = bridge;
  void bridge.initializeNativeBackButton();
  return bridge;
}

export async function initializePlugins(
  options: InitializePluginsOptions = {},
): Promise<InitializePluginsResult> {
  const result: InitializePluginsResult = {};

  const pushOptions = options.pushNotifications;
  if (pushOptions) {
    const pushNotifications =
      pushOptions instanceof PushNotificationManager
        ? pushOptions
        : new PushNotificationManager(
            typeof pushOptions === "object" ? pushOptions : undefined,
          );

    await initializeManager(pushNotifications);
    result.pushNotifications = pushNotifications;
  }

  const shareOptions = options.share;
  if (shareOptions) {
    const share =
      shareOptions instanceof ShareManager
        ? shareOptions
        : new ShareManager(typeof shareOptions === "object" ? shareOptions : undefined);

    await initializeManager(share);
    result.share = share;
  }

  const deepLinkOptions = options.deepLinks;
  if (deepLinkOptions) {
    const deepLinks =
      deepLinkOptions instanceof DeepLinkManager
        ? deepLinkOptions
        : new DeepLinkManager(
            typeof deepLinkOptions === "object" ? deepLinkOptions : undefined,
          );

    await initializeManager(deepLinks);
    result.deepLinks = deepLinks;
  }

  return result;
}
