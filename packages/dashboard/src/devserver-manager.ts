import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import path from "node:path";
import {
  MAX_LOG_ENTRIES,
  type DevServerConfig,
  type DevServerId,
  type DevServerLogEntry,
  type DevServerSession,
  type DevServerSessionMap,
  type DevServerStatus,
} from "./devserver-types.js";

const PORT_PROBE_DELAY_MS = 10_000;
const PORT_PROBE_TIMEOUT_MS = 500;
const PORT_PROBE_DEADLINE_MS = 3_000;
const STOP_TIMEOUT_MS = 5_000;
const COMMON_DEV_PORTS = [3000, 4173, 5173, 6006, 8080, 8888];

export interface DevServerManagerEvents {
  log: [id: DevServerId, entry: DevServerLogEntry];
  status: [id: DevServerId, status: DevServerStatus];
  preview: [id: DevServerId, url: string | null];
  exit: [id: DevServerId, exitCode: number];
}

export class DevServerManager extends EventEmitter<DevServerManagerEvents> {
  private readonly sessions: DevServerSessionMap = new Map();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly portProbes = new Map<string, NodeJS.Timeout>();
  private readonly stopping = new Set<string>();
  private readonly isWindows: boolean;

  constructor(_projectRoot: string) {
    super();
    this.isWindows = process.platform === "win32";
  }

  async startServer(config: DevServerConfig): Promise<DevServerSession> {
    const existing = this.sessions.get(config.id);
    if (existing && (existing.status === "running" || existing.status === "starting")) {
      throw new Error(`Dev server ${config.id} is already ${existing.status}`);
    }

    const session: DevServerSession = {
      config,
      status: "starting",
      logHistory: [],
    };
    this.sessions.set(config.id, session);
    this.emit("status", config.id, "starting");

    const { command, args } = parseCommand(config.command);
    if (!command) {
      session.status = "failed";
      this.emit("status", config.id, "failed");
      throw new Error(`Invalid command for dev server ${config.id}`);
    }

    const child = spawn(command, args, {
      cwd: config.cwd,
      env: {
        ...process.env,
        ...(config.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.processes.set(config.id, child);
    session.runtime = {
      pid: child.pid ?? 0,
      startedAt: new Date().toISOString(),
    };

    const handleChunk = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      const activeSession = this.sessions.get(config.id);
      if (!activeSession) {
        return;
      }

      const text = chunk.toString();
      if (!text) {
        return;
      }

      if (activeSession.status === "starting") {
        activeSession.status = "running";
        this.emit("status", config.id, "running");
      }

      const entry: DevServerLogEntry = {
        timestamp: new Date().toISOString(),
        stream,
        text,
      };
      activeSession.logHistory.push(entry);
      if (activeSession.logHistory.length > MAX_LOG_ENTRIES) {
        activeSession.logHistory.splice(0, activeSession.logHistory.length - MAX_LOG_ENTRIES);
      }

      this.emit("log", config.id, entry);
      this.detectPreviewUrl(config.id, text);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      handleChunk("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      handleChunk("stderr", chunk);
    });

    child.on("error", (error) => {
      const activeSession = this.sessions.get(config.id);
      if (!activeSession) {
        return;
      }

      console.error("[devserver] process error", {
        id: config.id,
        error: error.message,
      });
      activeSession.status = "failed";
      this.emit("status", config.id, "failed");
    });

    child.on("close", (exitCode) => {
      const activeSession = this.sessions.get(config.id);
      if (!activeSession) {
        return;
      }

      const normalizedExitCode = typeof exitCode === "number" ? exitCode : 0;
      const wasStopping = this.stopping.delete(config.id);

      activeSession.status = wasStopping || normalizedExitCode === 0 ? "stopped" : "failed";
      if (activeSession.runtime) {
        activeSession.runtime.exitCode = normalizedExitCode;
      }

      this.emit("status", config.id, activeSession.status);
      this.emit("exit", config.id, normalizedExitCode);
      this.processes.delete(config.id);
      this.clearPortProbe(config.id);

      console.info("[devserver] process closed", {
        id: config.id,
        exitCode: normalizedExitCode,
        status: activeSession.status,
      });
    });

    this.startPortProbe(config.id);
    return session;
  }

  async stopServer(id: DevServerId): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Dev server ${id} is not registered`);
    }

    const child = this.processes.get(id);
    if (!child) {
      throw new Error(`Dev server ${id} is not running`);
    }

    this.stopping.add(id);
    session.status = "stopping";
    this.emit("status", id, "stopping");

    const closePromise = waitForClose(child);
    this.sendTerminate(child);

    const closeResult = await Promise.race([
      closePromise,
      delay<{ timedOut: true }>(STOP_TIMEOUT_MS, { timedOut: true }),
    ]);

    if (closeResult.timedOut) {
      this.sendKill(child);
      await Promise.race([closePromise, delay(1_000, null)]);
    }

    const activeSession = this.sessions.get(id);
    if (activeSession && activeSession.status !== "failed") {
      activeSession.status = "stopped";
      this.emit("status", id, "stopped");
    }

    this.processes.delete(id);
    this.clearPortProbe(id);
  }

  async restartServer(id: DevServerId): Promise<DevServerSession> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Dev server ${id} is not registered`);
    }

    if (this.processes.has(id)) {
      await this.stopServer(id);
    }

    return this.startServer(session.config);
  }

  getSession(id: DevServerId): DevServerSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): DevServerSession[] {
    return Array.from(this.sessions.values());
  }

  getLogs(id: DevServerId, opts?: { tail?: number }): DevServerLogEntry[] {
    const session = this.sessions.get(id);
    if (!session) {
      return [];
    }

    if (opts?.tail === undefined) {
      return [...session.logHistory];
    }

    return session.logHistory.slice(-Math.max(0, opts.tail));
  }

  setPreviewUrl(id: DevServerId, url: string | null): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }

    if (url === null) {
      delete session.previewUrl;
      if (session.runtime) {
        delete session.runtime.previewUrl;
      }
      this.emit("preview", id, null);
      return;
    }

    session.previewUrl = url;
    if (session.runtime) {
      session.runtime.previewUrl = url;
    }
    this.emit("preview", id, url);
  }

  destroy(): void {
    for (const timeout of this.portProbes.values()) {
      clearTimeout(timeout);
    }
    this.portProbes.clear();

    for (const [id, child] of this.processes.entries()) {
      this.stopping.add(id);
      this.sendTerminate(child);
    }

    this.processes.clear();
    this.sessions.clear();
    this.stopping.clear();
    this.removeAllListeners();
  }

  private detectPreviewUrl(id: DevServerId, text: string): void {
    const match = text.match(/https?:\/\/(localhost|127\.0\.0\.1)(?::(\d+))?/);
    if (!match) {
      return;
    }

    const host = match[1];
    const port = match[2] ? `:${match[2]}` : "";
    const url = `http://${host}${port}`;
    this.setPreviewUrl(id, url);
  }

  private startPortProbe(id: DevServerId): void {
    this.clearPortProbe(id);

    const timer = setTimeout(() => {
      void this.runPortProbe(id);
    }, PORT_PROBE_DELAY_MS);

    this.portProbes.set(id, timer);
  }

  private async runPortProbe(id: DevServerId): Promise<void> {
    try {
      const session = this.sessions.get(id);
      if (!session || session.status !== "running" || session.previewUrl) {
        return;
      }

      const probePromise = this.findFirstReachablePort(COMMON_DEV_PORTS);
      const result = await Promise.race([
        probePromise,
        delay<number | null>(PORT_PROBE_DEADLINE_MS, null),
      ]);

      if (result === null) {
        return;
      }

      this.setPreviewUrl(id, `http://localhost:${result}`);
    } finally {
      this.clearPortProbe(id);
    }
  }

  private async findFirstReachablePort(ports: number[]): Promise<number | null> {
    for (const port of ports) {
      const reachable = await probePort(port);
      if (reachable) {
        return port;
      }
    }

    return null;
  }

  private clearPortProbe(id: DevServerId): void {
    const timer = this.portProbes.get(id);
    if (timer) {
      clearTimeout(timer);
      this.portProbes.delete(id);
    }
  }

  private sendTerminate(child: ChildProcess): void {
    try {
      if (this.isWindows) {
        if (typeof child.pid === "number") {
          process.kill(child.pid);
        }
      } else {
        child.kill("SIGTERM");
      }
    } catch (error) {
      console.warn("[devserver] failed to send SIGTERM", { error });
    }
  }

  private sendKill(child: ChildProcess): void {
    try {
      if (this.isWindows) {
        if (typeof child.pid === "number") {
          process.kill(child.pid);
        }
      } else {
        child.kill("SIGKILL");
      }
    } catch (error) {
      console.warn("[devserver] failed to send SIGKILL", { error });
    }
  }
}

async function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: PORT_PROBE_TIMEOUT_MS });

    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function waitForClose(child: ChildProcess): Promise<{ timedOut: false; exitCode: number | null }> {
  return new Promise((resolve) => {
    child.once("close", (exitCode) => {
      resolve({ timedOut: false, exitCode });
    });
  });
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

function parseCommand(rawCommand: string): { command: string; args: string[] } {
  const input = rawCommand.trim();
  if (!input) {
    return { command: "", args: [] };
  }

  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;

    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }

    if (quote !== null && char === quote) {
      quote = null;
      continue;
    }

    if (char === " " && quote === null) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  const [command = "", ...rest] = args;
  return { command, args: rest };
}

const managerInstances = new Map<string, DevServerManager>();

export function getDevServerManager(projectRoot: string): DevServerManager {
  const resolvedRoot = path.resolve(projectRoot);
  const existing = managerInstances.get(resolvedRoot);
  if (existing) {
    return existing;
  }

  const manager = new DevServerManager(resolvedRoot);
  managerInstances.set(resolvedRoot, manager);
  return manager;
}

export function destroyDevServerManager(projectRoot: string): void {
  const resolvedRoot = path.resolve(projectRoot);
  const manager = managerInstances.get(resolvedRoot);
  if (!manager) {
    return;
  }

  manager.destroy();
  managerInstances.delete(resolvedRoot);
}

export function destroyAllDevServerManagers(): void {
  for (const manager of managerInstances.values()) {
    manager.destroy();
  }
  managerInstances.clear();
}
