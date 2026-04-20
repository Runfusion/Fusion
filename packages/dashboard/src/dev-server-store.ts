import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type DevServerStatus = "starting" | "running" | "stopped" | "failed";

export interface DevServerState {
  /** Unique identifier for this server entry */
  id: string;
  /** Display name (for future multi-server support, default "default") */
  name: string;
  /** Current process status */
  status: DevServerStatus;
  /** Command to execute (e.g., "pnpm run dev") */
  command: string;
  /** Working directory for command execution */
  cwd: string;
  /** Package.json script name (e.g., "dev") if started via script */
  scriptId?: string;
  /** Path to the package.json containing the script */
  packagePath?: string;
  /** OS process ID when running */
  pid?: number;
  /** ISO timestamp when the process was started */
  startedAt?: string;
  /** ISO timestamp when the process stopped */
  stoppedAt?: string;
  /** Process exit code */
  exitCode?: number;
  /** URL auto-detected from process output */
  detectedUrl?: string;
  /** Manual preview URL override set by user */
  manualUrl?: string;
  /** Port auto-detected from process output or probing */
  detectedPort?: number;
  /** Ring buffer of recent stdout/stderr lines */
  logHistory: string[];
}

export interface DevServerConfig {
  /** Selected script name (e.g., "dev") */
  selectedScript: string | null;
  /** Source of the selected script ("root" or relative workspace path) */
  selectedSource: string | null;
  /** Full command string for the selected script */
  selectedCommand: string | null;
  /** Manual preview URL override (user-provided) */
  previewUrlOverride: string | null;
  /** Last auto-detected preview URL */
  detectedPreviewUrl: string | null;
  /** ISO timestamp of last selection */
  selectedAt: string | null;
}

export const DEV_SERVER_CONFIG_DEFAULTS: DevServerConfig = {
  selectedScript: null,
  selectedSource: null,
  selectedCommand: null,
  previewUrlOverride: null,
  detectedPreviewUrl: null,
  selectedAt: null,
};

export const DEV_SERVER_LOG_MAX_LINES = 500;

export const DEV_SERVER_DEFAULT_STATE = (): DevServerState => ({
  id: "",
  name: "default",
  status: "stopped",
  command: "",
  cwd: "",
  logHistory: [],
});

interface DevServerStoreFile {
  state?: Partial<DevServerState>;
  config?: Partial<DevServerConfig>;
}

function devServerFilePath(projectDir: string): string {
  return join(resolve(projectDir), ".fusion", "dev-server.json");
}

function normalizeState(candidate: Partial<DevServerState> | null | undefined): DevServerState {
  const defaults = DEV_SERVER_DEFAULT_STATE();
  const state: DevServerState = {
    ...defaults,
    ...(candidate ?? {}),
    logHistory: Array.isArray(candidate?.logHistory)
      ? candidate.logHistory.filter((line): line is string => typeof line === "string")
      : [],
  };

  if (
    state.status !== "starting"
    && state.status !== "running"
    && state.status !== "stopped"
    && state.status !== "failed"
  ) {
    state.status = defaults.status;
  }

  if (state.logHistory.length > DEV_SERVER_LOG_MAX_LINES) {
    state.logHistory = state.logHistory.slice(-DEV_SERVER_LOG_MAX_LINES);
  }

  return state;
}

function normalizeStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeConfig(candidate: Partial<DevServerConfig> | null | undefined): DevServerConfig {
  return {
    selectedScript: normalizeStringOrNull(candidate?.selectedScript),
    selectedSource: normalizeStringOrNull(candidate?.selectedSource),
    selectedCommand: normalizeStringOrNull(candidate?.selectedCommand),
    previewUrlOverride: normalizeStringOrNull(candidate?.previewUrlOverride),
    detectedPreviewUrl: normalizeStringOrNull(candidate?.detectedPreviewUrl),
    selectedAt: normalizeStringOrNull(candidate?.selectedAt),
  };
}

export class DevServerStore {
  private readonly filePath: string;
  private state: DevServerState = DEV_SERVER_DEFAULT_STATE();
  private config: DevServerConfig = { ...DEV_SERVER_CONFIG_DEFAULTS };

  constructor(projectDir: string) {
    this.filePath = devServerFilePath(projectDir);
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as Partial<DevServerStoreFile>;
      this.state = normalizeState(parsed?.state);
      this.config = normalizeConfig(parsed?.config);
    } catch {
      this.state = DEV_SERVER_DEFAULT_STATE();
      this.config = { ...DEV_SERVER_CONFIG_DEFAULTS };
    }
  }

  async save(): Promise<void> {
    const dir = dirname(this.filePath);
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }

    const payload: DevServerStoreFile = {
      state: this.state,
      config: this.config,
    };

    await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf-8");
  }

  getState(): DevServerState {
    return {
      ...this.state,
      logHistory: [...this.state.logHistory],
    };
  }

  async updateState(partial: Partial<DevServerState>): Promise<DevServerState> {
    this.state = normalizeState({
      ...this.state,
      ...partial,
      logHistory: partial.logHistory ?? this.state.logHistory,
    });

    await this.save();
    return this.getState();
  }

  getConfig(): DevServerConfig {
    return { ...this.config };
  }

  async saveConfig(config: DevServerConfig): Promise<DevServerConfig> {
    this.config = normalizeConfig(config);
    await this.save();
    return this.getConfig();
  }

  async updateConfig(partial: Partial<DevServerConfig>): Promise<DevServerConfig> {
    this.config = normalizeConfig({
      ...this.config,
      ...partial,
    });

    await this.save();
    return this.getConfig();
  }

  async appendLog(line: string): Promise<void> {
    this.state.logHistory.push(line);
    if (this.state.logHistory.length > DEV_SERVER_LOG_MAX_LINES) {
      this.state.logHistory.splice(0, this.state.logHistory.length - DEV_SERVER_LOG_MAX_LINES);
    }
    await this.save();
  }

  async clearLogs(): Promise<void> {
    this.state.logHistory = [];
    await this.save();
  }
}

const storeInstances = new Map<string, DevServerStore>();

export async function loadDevServerStore(projectDir: string): Promise<DevServerStore> {
  const storeKey = resolve(projectDir);
  let store = storeInstances.get(storeKey);
  if (!store) {
    store = new DevServerStore(projectDir);
    storeInstances.set(storeKey, store);
    await store.load();
  }

  return store;
}

export function resetDevServerStore(): void {
  storeInstances.clear();
}
