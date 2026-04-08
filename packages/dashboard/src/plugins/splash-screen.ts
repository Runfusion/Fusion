import { SplashScreen } from "@capacitor/splash-screen";
import type { PluginManager } from "./types.js";

export interface SplashScreenOptions {
  autoHide?: boolean;
  hideDelay?: number;
}

export class SplashScreenManager implements PluginManager {
  private options: Required<SplashScreenOptions>;
  private initialized = false;

  constructor(options: SplashScreenOptions = {}) {
    this.options = {
      autoHide: options.autoHide ?? true,
      hideDelay: options.hideDelay ?? 500,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.options.autoHide) {
      setTimeout(() => {
        this.hide().catch(() => {
          // Splash screen may already be hidden or not available (e.g., in browser)
        });
      }, this.options.hideDelay);
    }

    this.initialized = true;
  }

  async hide(): Promise<void> {
    try {
      await SplashScreen.hide({ fadeOutDuration: 300 });
    } catch {
      // Ignore errors — splash screen may not be available in browser/web context
    }
  }

  async show(): Promise<void> {
    try {
      await SplashScreen.show({ autoHide: false });
    } catch {
      // Ignore errors — splash screen may not be available in browser/web context
    }
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  async destroy(): Promise<void> {
    this.initialized = false;
  }
}
