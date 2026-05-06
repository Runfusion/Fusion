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

export class MobileNativeShellBridge implements FusionShellApi {
  private listeners = new Set<Listener>();

  constructor(private readonly qrScanner: QrScanner = new QrScanner()) {}

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
