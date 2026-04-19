import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
  state: DevServerState;
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

export class DevServerStore {
  private readonly filePath: string;
  private state: DevServerState = DEV_SERVER_DEFAULT_STATE();

  constructor(projectDir: string) {
    this.filePath = devServerFilePath(projectDir);
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as Partial<DevServerStoreFile>;
      this.state = normalizeState(parsed?.state);
    } catch {
      this.state = DEV_SERVER_DEFAULT_STATE();
    }
  }

  async save(): Promise<void> {
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }

    const payload: DevServerStoreFile = { state: this.state };
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
