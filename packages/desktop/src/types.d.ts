export interface SystemInfo {
  platform: string;
  arch: string;
  electronVersion: string;
  nodeVersion: string;
  appVersion: string;
}

export interface UpdateCheckResult {
  status: "checking" | "unavailable" | "error";
  error?: string;
  reason?: string;
}

export interface DeepLinkResult {
  type: "task" | "project" | "unknown";
  id: string;
  raw: string;
}

export type WindowControlAction = "minimize" | "maximize" | "close" | "isMaximized";

export interface FusionAPI {
  // Window control
  minimize(): Promise<void>;
  maximize(): Promise<boolean>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  windowControl(action: WindowControlAction): Promise<boolean | void>;

  // App info
  getSystemInfo(): Promise<SystemInfo>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  getServerPort(): Promise<number | undefined>;
  getDesktopRuntimeStatus(): Promise<ShellConnectionState["localRuntime"]>;
  startDesktopLocalRuntime(): Promise<ShellConnectionState["localRuntime"]>;
  stopDesktopLocalRuntime(): Promise<ShellConnectionState["localRuntime"]>;
  getDesktopLaunchMode(): Promise<"choose" | "local" | "remote">;
  setDesktopLaunchMode(mode: "choose" | "local" | "remote"): Promise<"choose" | "local" | "remote">;
  getDesktopLaunchContext(): Promise<{ mode: "remote"; profileId: string; serverBaseUrl: string; serverLabel?: string; authToken?: string } | null>;
  openConnectionManager(): Promise<void>;

  // Tray status
  updateTrayStatus(status: string): Promise<void>;

  // Native dialogs
  showExportDialog(): Promise<string | null>;
  showImportDialog(): Promise<string | null>;

  // Deep link events
  onDeepLink(callback: (result: DeepLinkResult) => void): () => void;

  // Auto-updater events
  onUpdateAvailable(callback: (info: { version: string }) => void): () => void;
  onUpdateDownloaded(callback: () => void): () => void;
  onUpdateNotAvailable(callback: (info: { version?: string }) => void): () => void;
  onUpdateError(callback: (info: { message: string }) => void): () => void;

  // Generic IPC invoke bridge
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  apiRequest?(method: string, path: string, body?: unknown): Promise<unknown>;
  getPlatform(): Promise<"darwin" | "win32" | "linux">;
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

export interface ShellConnectionState {
  host: "web" | "mobile-shell" | "desktop-shell";
  desktopModeState?: {
    isFirstRun: boolean;
    desktopMode: "local" | "remote" | null;
  };
  desktopMode?: "local" | "remote";
  activeProfileId: string | null;
  profiles: ShellConnectionProfile[];
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
  getDesktopModeState(): Promise<{ isFirstRun: boolean; desktopMode: "local" | "remote" | null }>;
  setDesktopMode(mode: "local" | "remote"): Promise<ShellConnectionState>;
  startQrScan(): Promise<{ serverUrl: string; authToken?: string | null }>;
  openConnectionManager(): Promise<void>;
  subscribe(listener: (state: ShellConnectionState) => void): () => void;
}

declare global {
  interface Window {
    fusionAPI?: FusionAPI;
    electronAPI?: FusionAPI;
    fusionShell?: FusionShellApi;
  }
}
