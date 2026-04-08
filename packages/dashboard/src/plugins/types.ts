import type { PluginListenerHandle } from "@capacitor/core";

/** Network connectivity status */
export interface NetworkStatus {
  connected: boolean;
  connectionType: "wifi" | "cellular" | "none" | "unknown";
}

/** Theme mode for status bar styling */
export type ThemeMode = "light" | "dark" | "system";

/** Status bar style mapping */
export type StatusBarStyle = "light" | "dark";

/** Plugin initialization options */
export interface PluginInitOptions {
  /** Auto-hide splash screen after initialization (default: true) */
  splashAutoHide?: boolean;
  /** Splash screen hide delay in milliseconds (default: 500) */
  splashHideDelay?: number;
  /** Initial theme mode for status bar (default: "system") */
  themeMode?: ThemeMode;
  /** Whether to start network monitoring immediately (default: true) */
  startNetworkMonitoring?: boolean;
}

/** Callback for network status changes */
export type NetworkStatusCallback = (status: NetworkStatus) => void;

/** Callback for theme mode changes */
export type ThemeChangeCallback = (mode: ThemeMode) => void;

/** Generic plugin manager interface */
export interface PluginManager {
  /** Initialize the plugin manager */
  initialize(): Promise<void>;
  /** Clean up listeners and resources */
  destroy(): Promise<void>;
}

/** Shared network listener handle type for manager implementations. */
export type PluginNetworkListenerHandle = PluginListenerHandle;

/** Result of initializing all plugins */
export interface PluginInitResult {
  splashScreen: boolean;
  statusBar: boolean;
  network: boolean;
  errors: Array<{ plugin: string; error: Error }>;
}
