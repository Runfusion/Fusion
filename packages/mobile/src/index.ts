import {
  PushNotificationManager,
  type PushNotificationManagerOptions,
} from "./plugins/push-notifications.js";

export { PushNotificationManager } from "./plugins/push-notifications.js";
export type {
  PushNotificationEventMap,
  PushNotificationManagerOptions,
} from "./plugins/push-notifications.js";
export type { MobilePluginManager, PluginEventMap } from "./types.js";

export interface InitializePluginsOptions {
  pushNotifications?:
    | boolean
    | PushNotificationManager
    | PushNotificationManagerOptions;
}

export interface InitializePluginsResult {
  pushNotifications?: PushNotificationManager;
}

export async function initializePlugins(
  options: InitializePluginsOptions = {},
): Promise<InitializePluginsResult> {
  const result: InitializePluginsResult = {};
  const pushOptions = options.pushNotifications;

  if (!pushOptions) {
    return result;
  }

  const pushNotifications =
    pushOptions instanceof PushNotificationManager
      ? pushOptions
      : new PushNotificationManager(
          typeof pushOptions === "object" ? pushOptions : undefined,
        );

  await pushNotifications.start();
  result.pushNotifications = pushNotifications;
  return result;
}
