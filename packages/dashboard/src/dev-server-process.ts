import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { superviseSpawn } from "@fusion/core";
import type { DevServerState, DevServerStore } from "./dev-server-store.js";
import {
  detectPortFromLogLine,
  probeFallbackPorts,
  type PortDetectionResult,
} from "./dev-server-port-detect.js";

export type DevServerEvent =
  | "started"
  | "output"
  | "stopped"
  | "failed"
  | "url-detected";

export interface DevServerProcessManagerOptions {
  stopTimeoutMs?: number;
  probeDelayMs?: number;
  probeTimeoutMs?: number;
}

interface UrlDetectedEventPayload {
  url: string;
  port: number;
  source: string;
  detectedAt: string;
}

const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_DELAY_MS = 10_000;
const DEFAULT_PROBE_HOST = "127.0.0.1";
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

function killManagedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (typeof child.pid !== "number") {
    return;
  }

  if (process.platform !== "win32") {
    try {
      // Supervised POSIX children remain process-group leaders, so a negative
      // PID still tears down the shell wrapper and its descendants.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child PID when the group no longer exists.
    }
  }

  try {
    process.kill(child.pid, signal);
  } catch {
    // Process may already have exited.
  }
}

/**
 * Reject dev-server commands whose strings contain command-substitution
 * syntax. Dev-server commands are user-configured project settings (e.g.
 * `npm run dev`, `bun dev`) and are spawned with `shell: true` so users
 * can chain `&&` / `|`, but command substitution (`$(...)`, backticks,
 * process substitution) is never needed for a start command and is the
 * main payload for a settings-file compromise. Legitimate commands don't
 * need to execute a sub-command before launching the dev server.
 */
function assertSafeDevServerCommand(command: string): void {
  if (/\$\(|`|<\(|>\(/.test(command)) {
    throw new Error(
      "Dev-server command contains command substitution ($(...), backticks, or process substitution), which is not permitted",
    );
  }
  if (/[\0\r\n]/.test(command)) {
    throw new Error("Dev-server command contains invalid control characters");
  }
}

export class DevServerProcessManager extends EventEmitter {
  private childProcess: ChildProcess | null = null;
  private portProbeTimer: NodeJS.Timeout | null = null;
  private hasDetectedUrl = false;
  private closePromise: Promise<DevServerState> | null = null;
  private resolveClosePromise: ((state: DevServerState) => void) | null = null;
  private lifecycleId = 0;
  private isDisposed = false;
  private readonly activeLifecycleWork = new Set<Promise<void>>();

  private readonly stopTimeoutMs: number;
  private readonly probeDelayMs: number;
  private readonly probeTimeoutMs: number;

  constructor(
    private readonly store: DevServerStore,
    options?: DevServerProcessManagerOptions,
  ) {
    super();
    this.stopTimeoutMs = options?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.probeDelayMs = options?.probeDelayMs ?? DEFAULT_PROBE_DELAY_MS;
    this.probeTimeoutMs = options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  async start(
    command: string,
    cwd: string,
    options?: { scriptId?: string; packagePath?: string },
  ): Promise<DevServerState> {
    if (this.isRunning()) {
      throw new Error("Dev server is already running");
    }

    const safeCommand = command.trim();
    if (safeCommand.length === 0) {
      throw new Error("command is required");
    }
    assertSafeDevServerCommand(safeCommand);

    const safeCwd = cwd.trim();
    if (safeCwd.length === 0) {
      throw new Error("cwd is required");
    }

    this.lifecycleId += 1;
    this.isDisposed = false;
    const lifecycleId = this.lifecycleId;
    this.hasDetectedUrl = false;
    await this.store.updateState({
      status: "starting",
      command: safeCommand,
      cwd: safeCwd,
      scriptId: options?.scriptId,
      packagePath: options?.packagePath,
      startedAt: new Date().toISOString(),
      pid: undefined,
      exitCode: undefined,
      stoppedAt: undefined,
      detectedUrl: undefined,
      detectedPort: undefined,
    });

    const supervised = superviseSpawn(safeCommand, [], {
      cwd: safeCwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      maxLifetimeMs: 24 * 60 * 60 * 1_000,
    });
    const child = supervised.child;

    this.childProcess = child;
    this.closePromise = new Promise<DevServerState>((resolve) => {
      this.resolveClosePromise = resolve;
    });

    const runningState = await this.store.updateState({
      pid: child.pid,
      status: "running",
    });

    this.emit("started", runningState);

    let lifecycleSettled = false;

    const handleLine = async (line: string, stream: "stdout" | "stderr"): Promise<void> => {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed || !this.isCurrentLifecycle(lifecycleId)) {
        return;
      }

      await this.store.appendLog(trimmed);
      if (!this.isCurrentLifecycle(lifecycleId)) {
        return;
      }
      const payload = { line: trimmed, stream, timestamp: new Date().toISOString() };
      this.emit("output", payload);
      await this.handleDetectionFromLine(trimmed, lifecycleId);
    };

    this.attachOutput(child.stdout, "stdout", handleLine);
    this.attachOutput(child.stderr, "stderr", handleLine);

    child.on("close", (code) => {
      if (lifecycleSettled) {
        return;
      }
      lifecycleSettled = true;
      void this.handleClose(code ?? 0);
    });

    child.on("error", (err) => {
      if (lifecycleSettled) {
        return;
      }
      lifecycleSettled = true;
      void this.handleFailure(err);
    });

    this.portProbeTimer = setTimeout(() => {
      this.trackLifecycleWork(this.runFallbackProbe(lifecycleId));
    }, this.probeDelayMs);

    return runningState;
  }

  async stop(): Promise<DevServerState> {
    if (!this.childProcess) {
      return this.store.getState();
    }

    const child = this.childProcess;
    const closePromise = this.closePromise;
    const pid = child.pid;

    if (typeof pid === "number") {
      killManagedProcess(child, "SIGTERM");
    }

    const killTimer = setTimeout(() => {
      if (this.childProcess === child && this.isRunning()) {
        killManagedProcess(child, "SIGKILL");
      }
    }, this.stopTimeoutMs);

    const finalState = closePromise ? await closePromise : this.store.getState();
    clearTimeout(killTimer);
    this.clearTimers();
    return finalState;
  }

  async restart(): Promise<DevServerState> {
    const state = this.store.getState();
    const command = state.command;
    const cwd = state.cwd;

    if (!command || !cwd) {
      throw new Error("No previous command available to restart");
    }

    await this.stop();
    return this.start(command, cwd, {
      scriptId: state.scriptId,
      packagePath: state.packagePath,
    });
  }

  isRunning(): boolean {
    return this.childProcess !== null
      && this.childProcess.exitCode === null
      && this.childProcess.signalCode === null;
  }

  hasPendingProbeTimer(): boolean {
    return this.portProbeTimer !== null;
  }

  cleanup(): void {
    this.lifecycleId += 1;
    this.isDisposed = true;
    this.clearTimers();

    if (this.childProcess && typeof this.childProcess.pid === "number") {
      killManagedProcess(this.childProcess, "SIGTERM");
      this.childProcess.removeAllListeners();
      this.childProcess.stdout?.removeAllListeners();
      this.childProcess.stderr?.removeAllListeners();
      this.childProcess = null;
    }

    this.removeAllListeners();
  }

  private attachOutput(
    stream: Readable | null,
    source: "stdout" | "stderr",
    onLine: (line: string, source: "stdout" | "stderr") => Promise<void>,
  ): void {
    if (!stream) {
      return;
    }

    let pending = "";
    stream.on("data", (chunk: Buffer | string) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";

      for (const line of lines) {
        this.trackLifecycleWork(onLine(line, source));
      }
    });

    const flushPending = () => {
      if (pending.length > 0) {
        const line = pending;
        pending = "";
        this.trackLifecycleWork(onLine(line, source));
      }
    };

    stream.on("end", flushPending);
    stream.on("close", flushPending);
  }

  private async handleDetectionFromLine(line: string, lifecycleId = this.lifecycleId): Promise<void> {
    if (this.hasDetectedUrl || !this.isCurrentLifecycle(lifecycleId)) {
      return;
    }

    const detected = detectPortFromLogLine(line);
    if (!detected) {
      return;
    }

    await this.persistDetection(detected, lifecycleId);
  }

  private async runFallbackProbe(lifecycleId = this.lifecycleId): Promise<void> {
    if (this.isCurrentLifecycle(lifecycleId)) {
      this.portProbeTimer = null;
    }

    if (this.hasDetectedUrl || !this.isRunning() || !this.isCurrentLifecycle(lifecycleId)) {
      return;
    }

    const detected = await probeFallbackPorts(DEFAULT_PROBE_HOST, this.probeTimeoutMs);
    if (!detected || this.hasDetectedUrl || !this.isRunning() || !this.isCurrentLifecycle(lifecycleId)) {
      return;
    }

    await this.persistDetection(detected, lifecycleId);
  }

  private async persistDetection(detected: PortDetectionResult, lifecycleId = this.lifecycleId): Promise<void> {
    if (this.hasDetectedUrl || !this.isCurrentLifecycle(lifecycleId)) {
      return;
    }

    this.hasDetectedUrl = true;
    this.clearProbeTimer();

    const detectedAt = new Date().toISOString();

    try {
      const updated = await this.store.updateState({
        detectedUrl: detected.url,
        detectedPort: detected.port,
      });
      if (!this.isCurrentLifecycle(lifecycleId)) {
        return;
      }

      const payload: UrlDetectedEventPayload = {
        url: updated.detectedUrl ?? detected.url,
        port: updated.detectedPort ?? detected.port,
        source: detected.source,
        detectedAt,
      };
      this.emit("url-detected", payload);
    } catch {
      this.hasDetectedUrl = false;
    }
  }

  private async handleClose(code: number): Promise<void> {
    this.clearTimers();
    await this.waitForActiveLifecycleWork();

    const updated = await this.store.updateState({
      status: "stopped",
      exitCode: code,
      stoppedAt: new Date().toISOString(),
      pid: undefined,
    });

    this.childProcess = null;
    this.resolveClosePromise?.(updated);
    this.resolveClosePromise = null;
    this.closePromise = null;
    this.emit("stopped", updated);
  }

  private async handleFailure(error: Error): Promise<void> {
    this.clearTimers();
    await this.waitForActiveLifecycleWork();

    const updated = await this.store.updateState({
      status: "failed",
      stoppedAt: new Date().toISOString(),
      pid: undefined,
    });

    this.childProcess = null;
    this.resolveClosePromise?.(updated);
    this.resolveClosePromise = null;
    this.closePromise = null;
    this.emit("failed", { error: error.message });
  }

  private isCurrentLifecycle(lifecycleId: number): boolean {
    return !this.isDisposed && lifecycleId === this.lifecycleId;
  }

  /*
  FNXC:DevServerProcess 2026-06-21-12:35:
  Loaded dashboard API shards can close a child process while stdout parsing, URL persistence, or fallback probing is still settling. Track lifecycle work and invalidate stale callbacks so every stop, close, failure, restart, and cleanup path clears the probe timer without leaving late store writes or process-handle work racing test fixture removal.
  */
  private trackLifecycleWork(promise: Promise<void>): void {
    this.activeLifecycleWork.add(promise);
    void promise.then(
      () => {
        this.activeLifecycleWork.delete(promise);
      },
      () => {
        this.activeLifecycleWork.delete(promise);
      },
    );
  }

  private async waitForActiveLifecycleWork(): Promise<void> {
    while (this.activeLifecycleWork.size > 0) {
      await Promise.allSettled([...this.activeLifecycleWork]);
    }
  }

  private clearProbeTimer(): void {
    if (this.portProbeTimer) {
      clearTimeout(this.portProbeTimer);
      this.portProbeTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearProbeTimer();
  }
}
