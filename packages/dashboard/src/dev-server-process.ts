import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import type { DevServerState, DevServerStore } from "./dev-server-store.js";

export type DevServerEvent =
  | "started"
  | "output"
  | "stopped"
  | "failed"
  | "url-detected";

interface DevServerProcessManagerOptions {
  stopTimeoutMs?: number;
  probeDelayMs?: number;
}

const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_DELAY_MS = 10_000;
const PROBE_PORTS = [3000, 4173, 5173, 6006, 8080, 8888, 4000, 4200] as const;

export class DevServerProcessManager extends EventEmitter {
  private childProcess: ChildProcess | null = null;
  private urlDetectionTimer: NodeJS.Timeout | null = null;
  private portProbeTimer: NodeJS.Timeout | null = null;
  private hasDetectedUrl = false;
  private closePromise: Promise<DevServerState> | null = null;
  private resolveClosePromise: ((state: DevServerState) => void) | null = null;

  private readonly stopTimeoutMs: number;
  private readonly probeDelayMs: number;

  constructor(
    private readonly store: DevServerStore,
    options?: DevServerProcessManagerOptions,
  ) {
    super();
    this.stopTimeoutMs = options?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.probeDelayMs = options?.probeDelayMs ?? DEFAULT_PROBE_DELAY_MS;
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

    const handleLine = async (line: string): Promise<void> => {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed) {
        return;
      }

      await this.store.appendLog(trimmed);
      const payload = { line: trimmed, timestamp: new Date().toISOString() };
      this.emit("output", payload);
      this.parseUrlFromOutput(trimmed);
    };

    this.attachOutput(child.stdout, handleLine);
    this.attachOutput(child.stderr, handleLine);

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

    this.urlDetectionTimer = setTimeout(() => {
      this.urlDetectionTimer = null;
    }, this.probeDelayMs);

    this.portProbeTimer = setTimeout(() => {
      void this.probePorts();
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
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process may already have exited.
      }
    }

    const killTimer = setTimeout(() => {
      if (!child.killed && typeof child.pid === "number") {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Process may already be gone.
        }
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
    return this.childProcess !== null && !this.childProcess.killed;
  }

  cleanup(): void {
    this.clearTimers();

    if (this.childProcess && typeof this.childProcess.pid === "number") {
      try {
        process.kill(this.childProcess.pid, "SIGTERM");
      } catch {
        // Process is already gone.
      }
      this.childProcess.removeAllListeners();
      this.childProcess.stdout?.removeAllListeners();
      this.childProcess.stderr?.removeAllListeners();
      this.childProcess = null;
    }

    this.removeAllListeners();
  }

  private attachOutput(
    stream: Readable | null,
    onLine: (line: string) => Promise<void>,
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
        void onLine(line);
      }
    });

    const flushPending = () => {
      if (pending.length > 0) {
        const line = pending;
        pending = "";
        void onLine(line);
      }
    };

    stream.on("end", flushPending);
    stream.on("close", flushPending);
  }

  private parseUrlFromOutput(line: string): void {
    if (this.hasDetectedUrl) {
      return;
    }

    let url: string | undefined;
    let port: number | undefined;

    const httpMatch = line.match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/i);
    if (httpMatch) {
      port = Number.parseInt(httpMatch[1], 10);
      url = httpMatch[0];
    }

    if (!url) {
      const httpsMatch = line.match(/https:\/\/(?:localhost|127\.0\.0\.1):(\d+)/i);
      if (httpsMatch) {
        port = Number.parseInt(httpsMatch[1], 10);
        url = httpsMatch[0];
      }
    }

    if (!url) {
      const keywordPortMatch = line.match(/\b(?:ready|listening|started|available|compiled)\b[^\d]*?(?:port\s+|:)(\d{2,5})/i);
      if (keywordPortMatch) {
        port = Number.parseInt(keywordPortMatch[1], 10);
        url = `http://localhost:${port}`;
      }
    }

    if (!url || !port || Number.isNaN(port)) {
      return;
    }

    this.hasDetectedUrl = true;
    this.clearProbeTimer();

    void this.store.updateState({ detectedUrl: url, detectedPort: port })
      .then((state) => {
        this.emit("url-detected", { url: state.detectedUrl, port: state.detectedPort });
      })
      .catch(() => {
        this.hasDetectedUrl = false;
      });
  }

  private async probePorts(): Promise<void> {
    if (this.hasDetectedUrl || !this.isRunning()) {
      return;
    }

    let foundPort: number | null = null;
    const activeSockets = new Set<Socket>();

    const probePromises = PROBE_PORTS.map((port) => new Promise<number>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port, timeout: 1000 });
      activeSockets.add(socket);

      const cleanup = () => {
        activeSockets.delete(socket);
        socket.removeAllListeners();
      };

      socket.once("connect", () => {
        cleanup();
        socket.end();
        resolve(port);
      });

      socket.once("timeout", () => {
        cleanup();
        socket.destroy();
        reject(new Error(`timeout:${port}`));
      });

      socket.once("error", (error) => {
        cleanup();
        reject(error);
      });

      socket.once("close", () => {
        cleanup();
      });
    }).then((port) => {
      if (foundPort === null) {
        foundPort = port;
        for (const socket of activeSockets) {
          socket.destroy();
        }
      }
      return port;
    }));

    await Promise.allSettled(probePromises);

    if (foundPort === null || this.hasDetectedUrl) {
      return;
    }

    this.hasDetectedUrl = true;
    const detectedUrl = `http://localhost:${foundPort}`;
    const updated = await this.store.updateState({ detectedUrl, detectedPort: foundPort });
    this.emit("url-detected", { url: updated.detectedUrl, port: updated.detectedPort });
  }

  private async handleClose(code: number): Promise<void> {
    const updated = await this.store.updateState({
      status: "stopped",
      exitCode: code,
      stoppedAt: new Date().toISOString(),
      pid: undefined,
    });

    this.childProcess = null;
    this.clearTimers();
    this.resolveClosePromise?.(updated);
    this.resolveClosePromise = null;
    this.closePromise = null;
    this.emit("stopped", updated);
  }

  private async handleFailure(error: Error): Promise<void> {
    const updated = await this.store.updateState({
      status: "failed",
      stoppedAt: new Date().toISOString(),
      pid: undefined,
    });

    this.childProcess = null;
    this.clearTimers();
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
    if (this.urlDetectionTimer) {
      clearTimeout(this.urlDetectionTimer);
      this.urlDetectionTimer = null;
    }
    this.clearProbeTimer();
  }
}
