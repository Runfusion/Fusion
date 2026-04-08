import { SplashScreenManager } from "./splash-screen.js";
import { StatusBarManager } from "./status-bar.js";
import { NetworkManager } from "./network.js";
import type { PluginInitOptions, PluginInitResult } from "./types.js";

// Types
export type {
  NetworkStatus,
  ThemeMode,
  StatusBarStyle,
  PluginInitOptions,
  NetworkStatusCallback,
  ThemeChangeCallback,
  PluginManager,
  PluginInitResult,
} from "./types.js";

// Plugin managers
export { SplashScreenManager } from "./splash-screen.js";
export type { SplashScreenOptions } from "./splash-screen.js";

export { StatusBarManager } from "./status-bar.js";
export type { StatusBarOptions } from "./status-bar.js";

export { NetworkManager } from "./network.js";

/**
 * Initialize all mobile plugin managers.
 *
 * Creates manager instances, initializes them in order (splash → status bar → network),
 * and returns them along with the initialization results.
 *
 * Errors in individual managers are caught and reported in the result
 * without preventing other managers from initializing.
 */
export async function initializePlugins(
  options: PluginInitOptions = {},
): Promise<{
  splashScreen: SplashScreenManager;
  statusBar: StatusBarManager;
  network: NetworkManager;
  result: PluginInitResult;
}> {
  const splashScreen = new SplashScreenManager({
    autoHide: options.splashAutoHide,
    hideDelay: options.splashHideDelay,
  });

  const statusBar = new StatusBarManager({
    themeMode: options.themeMode,
  });

  const network = new NetworkManager();

  const result: PluginInitResult = {
    splashScreen: false,
    statusBar: false,
    network: false,
    errors: [],
  };

  // Initialize splash screen first (so it hides after UI loads)
  try {
    await splashScreen.initialize();
    result.splashScreen = true;
  } catch (error) {
    result.errors.push({
      plugin: "splashScreen",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  // Initialize status bar
  try {
    await statusBar.initialize();
    result.statusBar = true;
  } catch (error) {
    result.errors.push({
      plugin: "statusBar",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  // Initialize network monitoring
  try {
    await network.initialize();
    if (options.startNetworkMonitoring === false) {
      await network.stopMonitoring();
    }
    result.network = true;
  } catch (error) {
    result.errors.push({
      plugin: "network",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  return { splashScreen, statusBar, network, result };
}
