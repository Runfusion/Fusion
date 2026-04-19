import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { SessionEventBuffer, type SessionBufferedEvent } from "./sse-buffer.js";
import { DevServerProcessManager } from "./dev-server-process.js";
import {
  loadDevServerStore,
  resetDevServerStore,
  type DevServerState,
  type DevServerStatus,
  type DevServerStore,
} from "./dev-server-store.js";

const DEFAULT_SERVER_KEY = "default";
const DEFAULT_LOG_LIMIT = 200;
const DEFAULT_BUFFER_CAPACITY = 400;

// Reserved dashboard port 4040 must never be suggested as a fallback dev-server port.
export const FALLBACK_PORTS = [3000, 4173, 5173, 6006, 8080, 8888, 4000, 4200] as const;

type LegacyDevServerStatus = DevServerStatus | "idle";
type DevServerLogSource = "stdout" | "stderr" | "system";

export interface DevServerPersistedLogEntry {
  serverKey: string;
  source: DevServerLogSource;
  message: string;
  timestamp: string;
}

export interface DevServerPersistedState {
  serverKey: string;
  status: LegacyDevServerStatus;
  command: string | null;
  scriptName: string | null;
  cwd: string | null;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string;
  previewUrl: string | null;
  previewProtocol: string | null;
  previewHost: string | null;
  previewPort: number | null;
  previewPath: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  exitedAt: string | null;
  failureReason: string | null;
}

export interface DevServerStartOptions {
  command: string;
  cwd?: string;
  scriptName?: string | null;
}

export interface DevServerSnapshot {
  state: DevServerPersistedState;
  logs: DevServerPersistedLogEntry[];
}

export interface DevServerManagerEvent {
  type: "state" | "log";
  data: DevServerPersistedState | DevServerPersistedLogEntry;
}

type DevServerSubscriber = (event: DevServerManagerEvent, eventId: number) => void;

export class DevServerManager extends EventEmitter {
  private readonly subscribers = new Set<DevServerSubscriber>();
  private readonly eventBuffer = new SessionEventBuffer(DEFAULT_BUFFER_CAPACITY);
  private readonly logLimit: number;
  private readonly processManager: DevServerProcessManager;

  private state: DevServerPersistedState = createDefaultState();
  private logs: DevServerPersistedLogEntry[] = [];
  private initialized = false;

  constructor(
    private readonly rootDir: string,
    private readonly store: DevServerStore,
    options?: { logLimit?: number },
  ) {
    super();
    this.logLimit = options?.logLimit ?? DEFAULT_LOG_LIMIT;
    this.processManager = new DevServerProcessManager(store);
    this.bindProcessEvents();
  }

  private bindProcessEvents(): void {
    this.processManager.on("started", (state: DevServerState) => {
      this.applyDevServerState(state);
    });

    this.processManager.on("output", (payload: { line: string; timestamp: string }) => {
      this.appendLog({
        serverKey: this.state.serverKey,
        source: "stdout",
        message: payload.line,
        timestamp: payload.timestamp,
      });
    });

    this.processManager.on("stopped", (state: DevServerState) => {
      this.applyDevServerState(state);
    });

    this.processManager.on("failed", (payload: { error: string }) => {
      this.state = {
        ...this.state,
        status: "failed",
        failureReason: payload.error,
        updatedAt: new Date().toISOString(),
      };
      this.broadcast({ type: "state", data: this.state });
      this.appendLog({
        serverKey: this.state.serverKey,
        source: "system",
        message: payload.error,
        timestamp: new Date().toISOString(),
      });
    });

    this.processManager.on("url-detected", () => {
      this.applyDevServerState(this.store.getState());
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.store.load();
    this.applyDevServerState(this.store.getState());

    if (
      (this.state.status === "running" || this.state.status === "starting")
      && this.state.pid
      && !isProcessAlive(this.state.pid)
    ) {
      await this.store.updateState({
        status: "stopped",
        pid: undefined,
        exitCode: 1,
        stoppedAt: new Date().toISOString(),
      });
      await this.store.appendLog("Recovered stale persisted PID and marked server as stopped");
      this.applyDevServerState(this.store.getState());
    }

    this.initialized = true;
  }

  getState(): DevServerPersistedState {
    return { ...this.state };
  }

  getRecentLogs(limit = this.logLimit): DevServerPersistedLogEntry[] {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }

    return this.logs.slice(-Math.floor(limit)).map((entry) => ({ ...entry }));
  }

  getSnapshot(limit = this.logLimit): DevServerSnapshot {
    return {
      state: this.getState(),
      logs: this.getRecentLogs(limit),
    };
  }

  getBufferedEvents(sinceId: number): SessionBufferedEvent[] {
    return this.eventBuffer.getEventsSince(sinceId);
  }

  subscribe(callback: DevServerSubscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async start(options: DevServerStartOptions): Promise<DevServerPersistedState> {
    await this.ensureInitialized();

    const command = options.command.trim();
    if (!command) {
      throw new Error("command is required");
    }

    const cwd = options.cwd ? resolve(options.cwd) : this.rootDir;
    const state = await this.processManager.start(command, cwd, {
      scriptId: options.scriptName ?? undefined,
    });

    this.applyDevServerState(state);
    return this.getState();
  }

  async stop(_reason = "Stopped by user"): Promise<DevServerPersistedState> {
    await this.ensureInitialized();
    const state = await this.processManager.stop();
    this.applyDevServerState(state);
    return this.getState();
  }

  async restart(options?: DevServerStartOptions): Promise<DevServerPersistedState> {
    await this.ensureInitialized();

    if (options?.command || options?.cwd || options?.scriptName !== undefined) {
      const current = this.store.getState();
      await this.store.updateState({
        command: options.command?.trim() || current.command,
        cwd: options.cwd ? resolve(options.cwd) : current.cwd,
        scriptId: options.scriptName ?? current.scriptId,
      });
    }

    const state = await this.processManager.restart();
    this.applyDevServerState(state);
    return this.getState();
  }

  async shutdown(): Promise<void> {
    if (this.processManager.isRunning()) {
      await this.processManager.stop();
    }
    this.processManager.cleanup();
  }

  resetForTests(): void {
    this.processManager.cleanup();
    this.subscribers.clear();
    this.eventBuffer.clear();
    this.logs = [];
    this.state = createDefaultState();
    this.initialized = false;
  }

  private applyDevServerState(state: DevServerState): void {
    this.state = toPersistedState(state);

    this.logs = state.logHistory.slice(-this.logLimit).map((message) => ({
      serverKey: this.state.serverKey,
      source: "system" as const,
      message,
      timestamp: new Date().toISOString(),
    }));

    this.broadcast({ type: "state", data: this.state });
  }

  private appendLog(entry: DevServerPersistedLogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > this.logLimit) {
      this.logs.splice(0, this.logs.length - this.logLimit);
    }

    this.broadcast({ type: "log", data: entry });
  }

  private broadcast(event: DevServerManagerEvent): number {
    const payload = JSON.stringify(event.data);
    const eventId = this.eventBuffer.push(event.type, payload);

    for (const subscriber of this.subscribers) {
      try {
        subscriber(event, eventId);
      } catch {
        // Ignore per-subscriber failures.
      }
    }

    this.emit("event", event, eventId);
    return eventId;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

function createDefaultState(): DevServerPersistedState {
  return {
    serverKey: DEFAULT_SERVER_KEY,
    status: "idle",
    command: null,
    scriptName: null,
    cwd: null,
    pid: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    previewUrl: null,
    previewProtocol: null,
    previewHost: null,
    previewPort: null,
    previewPath: null,
    exitCode: null,
    exitSignal: null,
    exitedAt: null,
    failureReason: null,
  };
}

function toPersistedState(state: DevServerState): DevServerPersistedState {
  const previewUrl = state.manualUrl ?? state.detectedUrl ?? null;

  let previewProtocol: string | null = null;
  let previewHost: string | null = null;
  let previewPort: number | null = state.detectedPort ?? null;
  let previewPath: string | null = null;

  if (previewUrl) {
    try {
      const parsed = new URL(previewUrl);
      previewProtocol = parsed.protocol.replace(/:$/, "");
      previewHost = parsed.hostname;
      previewPort = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : previewPort;
      previewPath = parsed.pathname || "/";
    } catch {
      // Ignore invalid URLs.
    }
  }

  return {
    serverKey: state.name || DEFAULT_SERVER_KEY,
    status: state.status,
    command: state.command || null,
    scriptName: state.scriptId ?? null,
    cwd: state.cwd || null,
    pid: state.pid ?? null,
    startedAt: state.startedAt ?? null,
    updatedAt: new Date().toISOString(),
    previewUrl,
    previewProtocol,
    previewHost,
    previewPort,
    previewPath,
    exitCode: state.exitCode ?? null,
    exitSignal: null,
    exitedAt: state.stoppedAt ?? null,
    failureReason: state.status === "failed" ? "Process failed" : null,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const managerInstances = new Map<string, DevServerManager>();

export async function loadDevServerManager(rootDir: string): Promise<DevServerManager> {
  const key = resolve(rootDir);
  let manager = managerInstances.get(key);

  if (!manager) {
    const store = await loadDevServerStore(rootDir);
    manager = new DevServerManager(key, store);
    managerInstances.set(key, manager);
    await manager.initialize();
  }

  return manager;
}

export async function shutdownAllDevServerManagers(): Promise<void> {
  for (const manager of managerInstances.values()) {
    await manager.shutdown();
  }
}

export function resetDevServerManager(): void {
  for (const manager of managerInstances.values()) {
    manager.resetForTests();
  }
  managerInstances.clear();
  resetDevServerStore();
}
