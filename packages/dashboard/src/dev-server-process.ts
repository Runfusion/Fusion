import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
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
      // Detached POSIX children become their own process group leaders, so
      // signaling the negative PID tears down the shell wrapper and its child.
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

    const child = spawn(safeCommand, [], {
      cwd: safeCwd,
      detached: process.platform !== "win32",
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

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
      if (!trimmed) {
        return;
      }

      await this.store.appendLog(trimmed);
      const payload = { line: trimmed, stream, timestamp: new Date().toISOString() };
      this.emit("output", payload);
      void this.handleDetectionFromLine(trimmed);
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
      void this.runFallbackProbe();
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
        void onLine(line, source);
      }
    });

    const flushPending = () => {
      if (pending.length > 0) {
        const line = pending;
        pending = "";
        void onLine(line, source);
      }
    };

    stream.on("end", flushPending);
    stream.on("close", flushPending);
  }

  private async handleDetectionFromLine(line: string): Promise<void> {
    if (this.hasDetectedUrl) {
      return;
    }

    const detected = detectPortFromLogLine(line);
    if (!detected) {
      return;
    }

    await this.persistDetection(detected);
  }

  private async runFallbackProbe(): Promise<void> {
    this.portProbeTimer = null;

    if (this.hasDetectedUrl || !this.isRunning()) {
      return;
    }

    const detected = await probeFallbackPorts(DEFAULT_PROBE_HOST, this.probeTimeoutMs);
    if (!detected || this.hasDetectedUrl || !this.isRunning()) {
      return;
    }

    await this.persistDetection(detected);
  }

  private async persistDetection(detected: PortDetectionResult): Promise<void> {
    if (this.hasDetectedUrl) {
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
