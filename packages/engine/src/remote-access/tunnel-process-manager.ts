import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { remoteTunnelLog } from "../logger.js";
import {
  getTunnelProviderAdapter,
  redactTunnelText,
} from "./provider-adapters.js";
import type {
  ManagedTunnelProcess,
  TunnelErrorCode,
  TunnelLogEntry,
  TunnelLogLevel,
  TunnelLogListener,
  TunnelManager,
  TunnelOutputStream,
  TunnelProvider,
  TunnelProviderConfig,
  TunnelStatusListener,
  TunnelStatusSnapshot,
} from "./types.js";

export interface TunnelProcessManagerOptions {
  maxLogEntries?: number;
  stopTimeoutMs?: number;
  spawnImpl?: typeof spawn;
}

const DEFAULT_MAX_LOG_ENTRIES = 400;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

class LineBuffer {
  private pending = "";

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    return lines.map((line) => line.trim()).filter(Boolean);
  }

  flush(): string[] {
    const tail = this.pending.trim();
    this.pending = "";
    return tail ? [tail] : [];
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeError(input: unknown): Error {
  if (input instanceof Error) {
    return input;
  }
  return new Error(String(input));
}

function maskSensitive(message: string, processHandle: ManagedTunnelProcess | null): string {
  if (!processHandle) {
    return message;
  }
  return redactTunnelText(message, processHandle.command.sensitiveValues);
}

function killManagedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (typeof child.pid !== "number") {
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to direct pid.
    }
  }

  try {
    process.kill(child.pid, signal);
  } catch {
    // Process may already be gone.
  }
}

function toStateError(code: TunnelErrorCode, err: unknown): { code: TunnelErrorCode; message: string; at: string } {
  const normalized = normalizeError(err);
  return {
    code,
    message: normalized.message,
    at: nowIso(),
  };
}

export class TunnelProcessManager extends EventEmitter implements TunnelManager {
  private readonly maxLogEntries: number;
  private readonly defaultStopTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;

  private status: TunnelStatusSnapshot = {
    provider: null,
    state: "stopped",
    pid: null,
    startedAt: null,
    stoppedAt: null,
    url: null,
    lastError: null,
  };

  private logs: TunnelLogEntry[] = [];
  private readonly statusListeners = new Set<TunnelStatusListener>();
  private readonly logListeners = new Set<TunnelLogListener>();
  private processHandle: ManagedTunnelProcess | null = null;
  private readinessTimer: NodeJS.Timeout | null = null;
  private stopTimer: NodeJS.Timeout | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private expectedStop = false;
  private activeStopPromise: Promise<void> | null = null;

  constructor(options: TunnelProcessManagerOptions = {}) {
    super();
    this.maxLogEntries = options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES;
    this.defaultStopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  getStatus(): TunnelStatusSnapshot {
    return { ...this.status, lastError: this.status.lastError ? { ...this.status.lastError } : null };
  }

  subscribeStatus(listener: TunnelStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  subscribeLogs(listener: TunnelLogListener): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  async start(provider: TunnelProvider, config: TunnelProviderConfig): Promise<void> {
    return this.runExclusive(async () => {
      if (this.processHandle || this.status.state === "starting" || this.status.state === "running") {
        throw new Error("already_running:tunnel process is already active");
      }
      await this.startInternal(provider, config);
    });
  }

  async stop(): Promise<void> {
    return this.runExclusive(async () => {
      await this.stopInternal();
    });
  }

  async switchProvider(target: TunnelProvider, config: TunnelProviderConfig): Promise<void> {
    return this.runExclusive(async () => {
      const previousProvider = this.status.provider;
      if (this.processHandle) {
        await this.stopInternal();
      }

      try {
        await this.startInternal(target, config);
      } catch (error) {
        const stateError = toStateError("switch_failed", error);
        const redactedMessage = this.redactForProviderConfig(target, config, stateError.message);
        this.updateStatus({
          provider: target,
          state: "failed",
          pid: null,
          startedAt: null,
          stoppedAt: nowIso(),
          url: null,
          lastError: {
            ...stateError,
            message: redactedMessage,
          },
        });
        this.emitLog("error", "manager", `Provider switch failed (${previousProvider ?? "none"} -> ${target}): ${redactedMessage}`);
        throw error;
      }
    });
  }

  private redactForProviderConfig(provider: TunnelProvider, config: TunnelProviderConfig, message: string): string {
    try {
      const adapter = getTunnelProviderAdapter(provider);
      const command = adapter.buildCommand(config);
      return redactTunnelText(message, command.sensitiveValues);
    } catch {
      return message;
    }
  }

  private async runExclusive(operation: () => Promise<void>): Promise<void> {
    const next = this.operationChain.then(operation);
    this.operationChain = next.catch(() => undefined);
    return next;
  }

  private async startInternal(provider: TunnelProvider, config: TunnelProviderConfig): Promise<void> {
    const adapter = getTunnelProviderAdapter(provider);

    if (config.provider !== provider) {
      throw new Error(`invalid_config:provider mismatch (${config.provider} vs ${provider})`);
    }

    try {
      adapter.validateConfig(config);
    } catch (error) {
      const stateError = toStateError("invalid_config", error);
      this.updateStatus({
        provider,
        state: "failed",
        pid: null,
        startedAt: null,
        stoppedAt: nowIso(),
        url: null,
        lastError: stateError,
      });
      this.emitLog("error", "manager", `Configuration validation failed for ${provider}: ${stateError.message}`);
      throw error;
    }

    const command = adapter.buildCommand(config);

    this.updateStatus({
      provider,
      state: "starting",
      pid: null,
      startedAt: nowIso(),
      stoppedAt: null,
      url: null,
      lastError: null,
    });

    this.emitLog("info", "manager", `Starting ${provider} tunnel: ${command.redactedPreview}`);

    const child = this.spawnImpl(command.command, command.args, {
      cwd: command.cwd,
      env: command.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.processHandle = {
      provider,
      child,
      command,
    };
    this.expectedStop = false;

    this.updateStatus({ pid: child.pid ?? null });

    const stdoutBuffer = new LineBuffer();
    const stderrBuffer = new LineBuffer();

    const attachStream = (stream: Readable | null, source: TunnelOutputStream, buffer: LineBuffer) => {
      stream?.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        for (const line of buffer.push(text)) {
          this.handleOutputLine(source, line);
        }
      });
    };

    attachStream(child.stdout, "stdout", stdoutBuffer);
    attachStream(child.stderr, "stderr", stderrBuffer);

    child.once("error", (error) => {
      const maskedMessage = maskSensitive(normalizeError(error).message, this.processHandle);
      this.emitLog("error", "manager", `Spawn failure for ${provider}: ${maskedMessage}`);
      this.handleUnexpectedExit("start_failed", `Spawn failure: ${maskedMessage}`);
    });

    child.once("close", (code, signal) => {
      for (const line of stdoutBuffer.flush()) {
        this.handleOutputLine("stdout", line);
      }
      for (const line of stderrBuffer.flush()) {
        this.handleOutputLine("stderr", line);
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
      if (this.expectedStop) {
        this.emitLog("info", "manager", `Tunnel process stopped (${reason})`);
        this.finalizeStoppedState();
        return;
      }

      this.emitLog("error", "manager", `Tunnel process exited unexpectedly (${reason})`);
      this.handleUnexpectedExit("process_exit", `Process exited unexpectedly (${reason})`);
    });

    this.readinessTimer = setTimeout(() => {
      if (this.status.state === "starting" && this.processHandle?.provider === provider) {
        this.emitLog("error", "manager", `Readiness timed out after ${command.readinessTimeoutMs}ms`);
        this.handleUnexpectedExit("readiness_timeout", `Tunnel readiness timeout after ${command.readinessTimeoutMs}ms`);
      }
    }, command.readinessTimeoutMs);
    this.readinessTimer.unref?.();
  }

  private async stopInternal(): Promise<void> {
    if (!this.processHandle) {
      this.updateStatus({
        provider: null,
        state: "stopped",
        pid: null,
        stoppedAt: nowIso(),
        url: null,
      });
      return;
    }

    if (this.activeStopPromise) {
      await this.activeStopPromise;
      return;
    }

    const currentHandle = this.processHandle;
    const stopTimeoutMs = currentHandle.command.stopTimeoutMs || this.defaultStopTimeoutMs;

    this.expectedStop = true;
    this.updateStatus({
      state: "stopping",
      provider: currentHandle.provider,
      pid: currentHandle.child.pid ?? null,
      lastError: null,
    });

    this.emitLog("info", "manager", `Stopping ${currentHandle.provider} tunnel (pid=${currentHandle.child.pid ?? "n/a"})`);

    this.activeStopPromise = new Promise<void>((resolve) => {
      const onClose = () => {
        currentHandle.child.removeListener("close", onClose);
        resolve();
      };

      currentHandle.child.once("close", onClose);
      killManagedProcess(currentHandle.child, "SIGTERM");

      this.stopTimer = setTimeout(() => {
        if (this.processHandle === currentHandle) {
          this.emitLog("warn", "manager", `Graceful stop timed out after ${stopTimeoutMs}ms, sending SIGKILL`);
          killManagedProcess(currentHandle.child, "SIGKILL");
        }
      }, stopTimeoutMs);
      this.stopTimer.unref?.();
    }).finally(() => {
      this.activeStopPromise = null;
      if (this.stopTimer) {
        clearTimeout(this.stopTimer);
        this.stopTimer = null;
      }
    });

    await this.activeStopPromise;
  }

  private handleOutputLine(source: TunnelOutputStream, rawLine: string): void {
    const processHandle = this.processHandle;
    const maskedLine = maskSensitive(rawLine, processHandle);
    this.emitLog("info", source, maskedLine);

    if (!processHandle || this.status.state !== "starting") {
      return;
    }

    const adapter = getTunnelProviderAdapter(processHandle.provider);
    const readiness = adapter.parseReadiness(maskedLine, source);
    if (!readiness?.ready) {
      return;
    }

    this.clearReadinessTimer();
    this.updateStatus({
      state: "running",
      provider: processHandle.provider,
      pid: processHandle.child.pid ?? null,
      url: readiness.url ?? this.status.url,
      startedAt: this.status.startedAt ?? nowIso(),
      lastError: null,
    });
    this.emitLog("info", "manager", `${processHandle.provider} tunnel is running`);
  }

  private handleUnexpectedExit(code: TunnelErrorCode, message: string): void {
    this.clearReadinessTimer();
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    this.expectedStop = false;
    const provider = this.processHandle?.provider ?? this.status.provider;
    this.processHandle = null;

    this.updateStatus({
      provider,
      state: "failed",
      pid: null,
      stoppedAt: nowIso(),
      url: null,
      lastError: {
        code,
        message,
        at: nowIso(),
      },
    });
  }

  private finalizeStoppedState(): void {
    this.clearReadinessTimer();
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    this.expectedStop = false;
    this.processHandle = null;

    this.updateStatus({
      provider: null,
      state: "stopped",
      pid: null,
      stoppedAt: nowIso(),
      url: null,
      lastError: null,
    });
  }

  private clearReadinessTimer(): void {
    if (this.readinessTimer) {
      clearTimeout(this.readinessTimer);
      this.readinessTimer = null;
    }
  }

  private updateStatus(patch: Partial<TunnelStatusSnapshot>): void {
    this.status = {
      ...this.status,
      ...patch,
      lastError: patch.lastError === undefined ? this.status.lastError : patch.lastError,
    };

    const snapshot = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(snapshot);
    }

    this.emit("status", snapshot);
  }

  private emitLog(level: TunnelLogLevel, source: TunnelLogEntry["source"], message: string): void {
    const safeMessage = maskSensitive(message, this.processHandle);
    const entry: TunnelLogEntry = {
      timestamp: nowIso(),
      provider: this.status.provider,
      level,
      source,
      message: safeMessage,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogEntries) {
      this.logs.splice(0, this.logs.length - this.maxLogEntries);
    }

    const logMethod = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    remoteTunnelLog[logMethod](safeMessage);

    for (const listener of this.logListeners) {
      listener(entry);
    }

    this.emit("log", entry);
  }
}
