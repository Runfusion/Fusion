import type {
  PluginManager,
  ThemeMode,
  ThemeChangeCallback,
} from "./types.js";

interface NativeStatusBarPlugin {
  setStyle: (options: { style: "DARK" | "LIGHT" }) => Promise<void>;
}

interface CapacitorGlobal {
  Capacitor?: {
    Plugins?: Record<string, unknown>;
  };
}

function getNativeStatusBarPlugin(): NativeStatusBarPlugin | null {
  const plugins = (globalThis as CapacitorGlobal).Capacitor?.Plugins;
  const candidate = plugins?.StatusBar as Partial<NativeStatusBarPlugin> | undefined;

  if (!candidate || typeof candidate.setStyle !== "function") {
    return null;
  }

  return candidate as NativeStatusBarPlugin;
}

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
    const statusBarPlugin = getNativeStatusBarPlugin();
    if (!statusBarPlugin) {
      return;
    }

    const isDark = mode === "dark" || (mode === "system" && this.isSystemDark());

    try {
      await statusBarPlugin.setStyle({
        style: isDark ? "DARK" : "LIGHT",
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
