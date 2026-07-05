export interface ShellConnectionProfile {
  id: string;
  name: string;
  serverUrl: string;
  authToken?: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

export interface ShellConnectionProfileInput {
  id?: string;
  name: string;
  serverUrl: string;
  authToken?: string | null;
}

export interface ShellConnectionState {
  host: "web" | "mobile-shell" | "desktop-shell";
  desktopMode?: "local" | "remote";
  desktopModeState?: {
    isFirstRun: boolean;
    desktopMode: "local" | "remote" | null;
  };
  activeProfileId: string | null;
  profiles: ShellConnectionProfile[];
  /*
   * FNXC:DesktopSwitchServer 2026-07-04-13:20:
   * `localRuntime` is the only field the desktop preload/IPC ever populates for the embedded local server
   * (see packages/desktop/src/ipc.ts). A previous `localServer` field here was never emitted by the shell and
   * was removed after it caused the in-dashboard "Switch server" -> Local Server redirect to silently no-op
   * (FN-7527); resolveDesktopShellRedirectTarget in appLifecycle.ts is the sole consumer of localRuntime for
   * renderer-side navigation decisions.
   */
  localRuntime?: {
    source: "embedded-local" | "external-cli" | "none";
    state: "stopped" | "starting" | "running" | "error";
    port?: number;
    baseUrl?: string;
    error?: string;
  };
}

export interface FusionShellApi {
  getState(): Promise<ShellConnectionState>;
  listProfiles(): Promise<ShellConnectionProfile[]>;
  saveProfile(profile: ShellConnectionProfileInput): Promise<ShellConnectionProfile>;
  deleteProfile(profileId: string): Promise<void>;
  setActiveProfile(profileId: string | null): Promise<ShellConnectionState>;
  setDesktopMode(mode: "local" | "remote"): Promise<ShellConnectionState>;
  resetDesktopMode?(): Promise<ShellConnectionState>;
  onResetDesktopModeRequest?(callback: () => void): () => void;
  startQrScan(): Promise<{ serverUrl: string; authToken?: string | null }>;
  openConnectionManager(): Promise<void>;
  subscribe(listener: (state: ShellConnectionState) => void): () => void;
}

declare global {
  interface Window {
    fusionShell?: FusionShellApi;
  }
}
