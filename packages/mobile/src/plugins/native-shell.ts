import { Capacitor } from "@capacitor/core";
import type {
  FusionShellApi,
  ShellConnectionProfile,
  ShellConnectionProfileInput,
  ShellConnectionState,
} from "../types.js";
import {
  deleteShellProfile,
  listShellProfiles,
  loadShellProfiles,
  saveShellProfile,
  setActiveShellProfile,
} from "./connection-profiles.js";
import { QrScanner, type QrScanResult } from "./qr-scanner.js";

type Listener = (state: ShellConnectionState) => void;
type AppModule = typeof import("@capacitor/app");
type AppBackButtonListenerEvent = { canGoBack: boolean };
type AppListenerHandle = { remove: () => Promise<void> };

export const FUSION_NATIVE_BACK_EVENT = "fusion:native-back";

export class AndroidBackButtonManager {
  private initialized = false;
  private listenerHandle?: AppListenerHandle;
  private appPlugin: AppModule["App"] | null = null;

  /*
  FNXC:TaskDetailAndroidBack 2026-06-29-20:40:
  Native Android Back must first offer the dashboard's shared navigation-history stack a cancelable browser event so every task-detail surface dismisses through the same invariant as swipe/browser popstate. If the dashboard does not prevent the event, preserve Capacitor's native fallback by going back in ordinary browser history or exiting the app.
  */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.initialized = true;

    if (!Capacitor.isNativePlatform()) {
      return;
    }

    const app = await this.loadAppPlugin();
    if (!app) {
      return;
    }

    this.listenerHandle = await app.addListener("backButton", (event) => {
      this.handleBackButton(event);
    });
  }

  async destroy(): Promise<void> {
    if (this.listenerHandle) {
      try {
        await this.listenerHandle.remove();
      } catch (error) {
        console.warn("Failed to remove backButton listener", error);
      }
      this.listenerHandle = undefined;
    }

    this.initialized = false;
  }

  private handleBackButton(event: AppBackButtonListenerEvent): void {
    if (this.dispatchNativeBackEvent()) {
      return;
    }

    const win = globalThis.window;
    if (event.canGoBack && win?.history && typeof win.history.back === "function") {
      win.history.back();
      return;
    }

    void this.appPlugin?.exitApp();
  }

  private dispatchNativeBackEvent(): boolean {
    const win = globalThis.window;
    if (!win || typeof win.dispatchEvent !== "function") {
      return false;
    }

    const event = new CustomEvent(FUSION_NATIVE_BACK_EVENT, {
      cancelable: true,
      detail: { source: "android-back" },
    });
    win.dispatchEvent(event);
    return event.defaultPrevented;
  }

  private async loadAppPlugin(): Promise<AppModule["App"] | null> {
    try {
      if (!this.appPlugin) {
        this.appPlugin = (await import("@capacitor/app")).App;
      }
      return this.appPlugin;
    } catch (error) {
      console.warn("Failed to load Capacitor App plugin for Android Back", error);
      return null;
    }
  }
}

export class MobileNativeShellBridge implements FusionShellApi {
  private listeners = new Set<Listener>();

  constructor(
    private readonly qrScanner: QrScanner = new QrScanner(),
    private readonly androidBackButtonManager: AndroidBackButtonManager = new AndroidBackButtonManager(),
  ) {}

  initializeNativeBackButton(): Promise<void> {
    return this.androidBackButtonManager.initialize();
  }

  destroy(): Promise<void> {
    return this.androidBackButtonManager.destroy();
  }

  private async buildState(): Promise<ShellConnectionState> {
    const persisted = await loadShellProfiles();
    return {
      host: "mobile-shell",
      activeProfileId: persisted.activeProfileId,
      profiles: persisted.profiles,
    };
  }

  private async emitState(): Promise<ShellConnectionState> {
    const state = await this.buildState();
    for (const listener of this.listeners) {
      listener(state);
    }
    return state;
  }

  getState(): Promise<ShellConnectionState> {
    return this.buildState();
  }

  listProfiles(): Promise<ShellConnectionProfile[]> {
    return listShellProfiles();
  }

  async saveProfile(profile: ShellConnectionProfileInput): Promise<ShellConnectionProfile> {
    const saved = await saveShellProfile(profile);
    await this.emitState();
    return saved;
  }

  async deleteProfile(profileId: string): Promise<void> {
    await deleteShellProfile(profileId);
    await this.emitState();
  }

  setActiveProfile(profileId: string | null): Promise<ShellConnectionState> {
    return setActiveShellProfile(profileId).then(() => this.emitState());
  }

  setDesktopMode(): Promise<ShellConnectionState> {
    return Promise.reject(new Error("Desktop mode is not supported in mobile shell"));
  }

  startQrScan(): Promise<QrScanResult> {
    return this.qrScanner.scanConnection();
  }

  async openConnectionManager(): Promise<void> {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("shell:open-connection-manager"));
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    void this.getState().then(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
