// @vitest-environment node

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, createConnectionMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  createConnectionMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("node:net", () => ({
  createConnection: createConnectionMock,
}));

import {
  DevServerManager,
  destroyAllDevServerManagers,
} from "../devserver-manager.js";
import { MAX_LOG_ENTRIES, createDevServerId, type DevServerConfig } from "../devserver-types.js";

interface MockSocket extends EventEmitter {
  setTimeout: (ms: number) => void;
  destroy: () => void;
  end: () => void;
}

interface MockChildProcess extends EventEmitter {
  pid: number;
  killed: boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function createMockSocket(): MockSocket {
  const socket = new EventEmitter() as MockSocket;
  socket.setTimeout = vi.fn();
  socket.destroy = vi.fn();
  socket.end = vi.fn();
  return socket;
}

function createMockChildProcess(pid: number): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.pid = pid;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal?: string) => {
    child.killed = true;
    if (signal === "SIGTERM") {
      setImmediate(() => {
        child.emit("close", 0);
      });
    }
    return true;
  });
  return child;
}

function makeConfig(id = "dev-1", command = "npm run dev"): DevServerConfig {
  return {
    id: createDevServerId(id),
    name: id,
    command,
    cwd: "/repo",
  };
}

describe("devserver-manager", () => {
  let manager: DevServerManager;
  let nextPid: number;
  let children: MockChildProcess[];

  beforeEach(() => {
    nextPid = 1000;
    children = [];
    spawnMock.mockReset();
    createConnectionMock.mockReset();

    spawnMock.mockImplementation(() => {
      const child = createMockChildProcess(nextPid++);
      children.push(child);
      return child;
    });

    createConnectionMock.mockImplementation(() => {
      const socket = createMockSocket();
      queueMicrotask(() => {
        socket.emit("error", new Error("closed"));
      });
      return socket;
    });

    manager = new DevServerManager("/project");
  });

  afterEach(() => {
    manager.destroy();
    destroyAllDevServerManagers();
    vi.useRealTimers();
  });

  it("startServer spawns child process and transitions starting to running on output", async () => {
    const config = makeConfig();

    const session = await manager.startServer(config);
    expect(session.status).toBe("starting");

    const child = children[0];
    child.stdout.emit("data", "ready");

    const updated = manager.getSession(config.id);
    expect(updated?.status).toBe("running");
    expect(updated?.runtime?.pid).toBe(1000);
    expect(Number.isNaN(Date.parse(updated?.runtime?.startedAt ?? ""))).toBe(false);
  });

  it("captures stdout and stderr as log entries", async () => {
    const config = makeConfig();
    await manager.startServer(config);

    const child = children[0];
    child.stdout.emit("data", "line out");
    child.stderr.emit("data", "line err");

    const logs = manager.getLogs(config.id);
    expect(logs).toHaveLength(2);
    expect(logs[0]?.stream).toBe("stdout");
    expect(logs[0]?.text).toBe("line out");
    expect(logs[1]?.stream).toBe("stderr");
    expect(logs[1]?.text).toBe("line err");
    expect(Number.isNaN(Date.parse(logs[0]?.timestamp ?? ""))).toBe(false);
  });

  it("bounds log history to MAX_LOG_ENTRIES", async () => {
    const config = makeConfig();
    await manager.startServer(config);

    const child = children[0];
    for (let index = 0; index < 600; index += 1) {
      child.stdout.emit("data", `line-${index}`);
    }

    const logs = manager.getLogs(config.id);
    expect(logs).toHaveLength(MAX_LOG_ENTRIES);
    expect(logs[0]?.text).toBe("line-100");
    expect(logs[MAX_LOG_ENTRIES - 1]?.text).toBe("line-599");
  });

  it("emits log events", async () => {
    const config = makeConfig();
    const onLog = vi.fn();
    manager.on("log", onLog);

    await manager.startServer(config);
    children[0].stdout.emit("data", "event line");

    expect(onLog.mock.calls.length).toBe(1);
    expect(onLog.mock.calls[0]?.[0]).toBe(config.id);
    expect(onLog.mock.calls[0]?.[1]?.text).toBe("event line");
  });

  it("auto-detects preview URL from stdout", async () => {
    const config = makeConfig();
    const onPreview = vi.fn();
    manager.on("preview", onPreview);

    await manager.startServer(config);
    children[0].stdout.emit("data", "Server running at http://localhost:3000");

    expect(manager.getSession(config.id)?.previewUrl).toBe("http://localhost:3000");
    expect(onPreview.mock.calls.length).toBe(1);
    expect(onPreview.mock.calls[0]?.[1]).toBe("http://localhost:3000");
  });

  it("auto-detects preview URL from stderr", async () => {
    const config = makeConfig();

    await manager.startServer(config);
    children[0].stderr.emit("data", "Listening on http://127.0.0.1:5173");

    expect(manager.getSession(config.id)?.previewUrl).toBe("http://127.0.0.1:5173");
  });

  it("stopServer sends SIGTERM and transitions to stopped", async () => {
    const config = makeConfig();
    await manager.startServer(config);
    children[0].stdout.emit("data", "ready");

    await manager.stopServer(config.id);

    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.getSession(config.id)?.status).toBe("stopped");
  });

  it("stopServer escalates to SIGKILL after timeout", async () => {
    vi.useFakeTimers();

    spawnMock.mockReset();
    children = [];
    spawnMock.mockImplementation(() => {
      const child = createMockChildProcess(nextPid++);
      child.kill = vi.fn((signal?: string) => {
        if (signal === "SIGKILL") {
          setImmediate(() => {
            child.emit("close", 0);
          });
        }
        return true;
      });
      children.push(child);
      return child;
    });

    const config = makeConfig();
    await manager.startServer(config);
    children[0].stdout.emit("data", "ready");

    const stopPromise = manager.stopServer(config.id);
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(5001);
    expect(children[0].kill).toHaveBeenCalledWith("SIGKILL");

    await vi.runAllTimersAsync();
    await stopPromise;
  });

  it("marks session failed on non-zero exit", async () => {
    const config = makeConfig();
    await manager.startServer(config);

    children[0].emit("close", 1);

    const session = manager.getSession(config.id);
    expect(session?.status).toBe("failed");
    expect(session?.runtime?.exitCode).toBe(1);
  });

  it("restartServer stops then starts with same config", async () => {
    const config = makeConfig("app", "node dev.js --flag");
    await manager.startServer(config);
    children[0].stdout.emit("data", "ready");

    const restarted = await manager.restartServer(config.id);

    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnMock.mock.calls.length).toBe(2);
    expect(restarted.config.command).toBe("node dev.js --flag");
    expect(restarted.config.id).toBe(config.id);
  });

  it("setPreviewUrl updates session and emits preview event", async () => {
    const config = makeConfig();
    const onPreview = vi.fn();
    manager.on("preview", onPreview);

    await manager.startServer(config);
    manager.setPreviewUrl(config.id, "http://localhost:8080");

    expect(manager.getSession(config.id)?.previewUrl).toBe("http://localhost:8080");
    expect(onPreview.mock.calls[0]?.[1]).toBe("http://localhost:8080");
  });

  it("setPreviewUrl(null) clears preview URL", async () => {
    const config = makeConfig();
    await manager.startServer(config);

    manager.setPreviewUrl(config.id, "http://localhost:8080");
    manager.setPreviewUrl(config.id, null);

    expect(manager.getSession(config.id)?.previewUrl).toBeUndefined();
  });

  it("getLogs returns full history by default", async () => {
    const config = makeConfig();
    await manager.startServer(config);

    children[0].stdout.emit("data", "line-1");
    children[0].stderr.emit("data", "line-2");

    const logs = manager.getLogs(config.id);
    expect(logs).toHaveLength(2);
  });

  it("getLogs tail returns last N entries", async () => {
    const config = makeConfig();
    await manager.startServer(config);

    for (let index = 0; index < 10; index += 1) {
      children[0].stdout.emit("data", `line-${index}`);
    }

    const logs = manager.getLogs(config.id, { tail: 3 });
    expect(logs).toHaveLength(3);
    expect(logs[0]?.text).toBe("line-7");
    expect(logs[2]?.text).toBe("line-9");
  });

  it("destroy stops all running processes", async () => {
    const first = makeConfig("first");
    const second = makeConfig("second");

    await manager.startServer(first);
    await manager.startServer(second);

    manager.destroy();

    expect(children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[1]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("port probe runs after 10s and sets preview URL from first open port", async () => {
    vi.useFakeTimers();

    createConnectionMock.mockReset();
    createConnectionMock.mockImplementation((options: { port: number }) => {
      const socket = createMockSocket();
      queueMicrotask(() => {
        if (options.port === 4173) {
          socket.emit("connect");
        } else {
          socket.emit("error", new Error("closed"));
        }
      });
      return socket;
    });

    const config = makeConfig();
    await manager.startServer(config);
    children[0].stdout.emit("data", "started");

    await vi.advanceTimersByTimeAsync(10_001);

    expect(createConnectionMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(manager.getSession(config.id)?.previewUrl).toBe("http://localhost:4173");
  });

  it("port probe is skipped when URL is already detected", async () => {
    vi.useFakeTimers();

    const config = makeConfig();
    await manager.startServer(config);
    children[0].stdout.emit("data", "running on http://localhost:3000");

    await vi.advanceTimersByTimeAsync(10_001);

    expect(createConnectionMock.mock.calls.length).toBe(0);
  });
});
