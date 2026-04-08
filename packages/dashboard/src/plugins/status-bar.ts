import { StatusBar, Style } from "@capacitor/status-bar";
import type {
  PluginManager,
  ThemeMode,
  ThemeChangeCallback,
} from "./types.js";

export interface StatusBarOptions {
  themeMode?: ThemeMode;
}

export class StatusBarManager implements PluginManager {
  private currentTheme: ThemeMode;
  private listeners: Array<ThemeChangeCallback> = [];
  private initialized = false;

  constructor(options: StatusBarOptions = {}) {
    this.currentTheme = options.themeMode ?? "system";
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await this.applyTheme(this.currentTheme);
    } catch {
      // StatusBar plugin may not be available in browser context
    }

    this.initialized = true;
  }

  async setTheme(mode: ThemeMode): Promise<void> {
    this.currentTheme = mode;
    await this.applyTheme(mode);
    this.listeners.forEach((callback) => callback(mode));
  }

  getTheme(): ThemeMode {
    return this.currentTheme;
  }

  onThemeChange(callback: ThemeChangeCallback): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  private async applyTheme(mode: ThemeMode): Promise<void> {
    const isDark = mode === "dark" || (mode === "system" && this.isSystemDark());

    try {
      await StatusBar.setStyle({
        style: isDark ? Style.Dark : Style.Light,
      });
    } catch {
      // StatusBar plugin may not be available in browser context
    }
  }

  private isSystemDark(): boolean {
    if (typeof window === "undefined") {
      return false;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  async destroy(): Promise<void> {
    this.listeners = [];
    this.initialized = false;
  }
}
