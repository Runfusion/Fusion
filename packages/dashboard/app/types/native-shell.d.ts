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
    /*
    FNXC:DesktopHostAuth 2026-08-09-03:04:
    Bearer token for the embedded desktop API. The desktop host used to serve `/api/*` — terminal
    WebSocket included — with no token on ALL interfaces; it now binds loopback and mounts the real
    gate, so the renderer must receive this token and replay it as `?token=` when it navigates to
    the runtime origin (DesktopLaunchGate, and the "Switch server" -> Local redirect in
    appLifecycle.ts). Absent for `source: "external-cli"` — that server is another process.
    */
    authToken?: string;
    error?: string;
    /*
    FNXC:MigrationHoldingPage 2026-07-17-13:30:
    Live SQLite→PostgreSQL migration progress published by the desktop
    LocalRuntimeManager while state is "starting" (packages/desktop/src/
    local-runtime.ts). DesktopLaunchGate renders it and suspends its startup
    timeout while progress advances.
    */
    migration?: {
      active: boolean;
      phase?: string;
      label?: string;
    };
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
