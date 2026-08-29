export interface PluginEventMap {
  [event: string]: unknown;
}

export interface MobilePluginManager {
  start(): Promise<void>;
  destroy(): void | Promise<void>;
}

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

export type ShellHost = "web" | "mobile-shell" | "desktop-shell";

export interface ShellConnectionState {
  host: ShellHost;
  desktopMode?: "local" | "remote";
  activeProfileId: string | null;
  profiles: ShellConnectionProfile[];
  localServer?: {
    status: "idle" | "starting" | "ready" | "error";
    port?: number;
    error?: string | null;
  };
}

export interface MobileRemoteShellLaunch {
  shellKind: "mobile";
  shellMode: "remote";
  profileId: string;
  serverBaseUrl: string;
  serverLabel?: string;
  token?: string;
}

export type MobileShellHandoffResult =
  | { kind: "remote-launch"; url: string; launch: MobileRemoteShellLaunch }
  | { kind: "fallback"; reason: "no-active-profile" | "missing-profile" | "invalid-server-url" };

export interface FusionShellApi {
  getState(): Promise<ShellConnectionState>;
  listProfiles(): Promise<ShellConnectionProfile[]>;
  saveProfile(profile: ShellConnectionProfileInput): Promise<ShellConnectionProfile>;
  deleteProfile(profileId: string): Promise<void>;
  setActiveProfile(profileId: string | null): Promise<ShellConnectionState>;
  setDesktopMode(mode: "local" | "remote"): Promise<ShellConnectionState>;
  startQrScan(): Promise<{ serverUrl: string; authToken?: string | null }>;
  openConnectionManager(): Promise<void>;
  subscribe(listener: (state: ShellConnectionState) => void): () => void;
}

export interface MobileShellDashboardBridge {
  getState?: () => Promise<ShellConnectionState>;
  openConnectionManager?: () => Promise<void>;
}
