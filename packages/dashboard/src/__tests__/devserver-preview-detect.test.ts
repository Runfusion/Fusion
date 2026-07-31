// @vitest-environment node

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevServerManager, destroyAllDevServerManagers } from "../devserver-manager.js";
import { createDevServerId, type DevServerConfig } from "../devserver-types.js";

const { spawnMock, createConnectionMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  createConnectionMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  /*
  FNXC:DashboardTestMocks 2026-08-03-04:20 (whole-file red on main — same class as the `createLogger` pair):
  `execFile` is stubbed because a `vi.mock("node:child_process", …)` factory REPLACES the module: something in
  this import graph now calls `execFile`, and an omitted export throws `No "execFile" export is defined`, failing
  the WHOLE file rather than one case.

  Stubbed as a no-op that invokes its callback with empty output, which is what every consumer in this graph
  needs to proceed; a test that actually depends on an execFile result should assert on this mock rather than
  rely on the default.
  */
  execFile: (
    _file: string,
    ..._rest: unknown[]
  ) => {
    const callback = _rest.find((argument) => typeof argument === "function") as
      | ((error: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    callback?.(null, "", "");
    return { kill: () => undefined } as never;
  },
  spawn: spawnMock,
}));

vi.mock("node:net", () => ({
  createConnection: createConnectionMock,
}));

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
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

function makeConfig(id = "preview-test"): DevServerConfig {
  return {
    id: createDevServerId(id),
    name: id,
    command: "npm run dev",
    cwd: "/repo",
  };
}

describe("devserver-preview-detect", () => {
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

  it("detects URL from stdout with localhost:3000", async () => {
    const config = makeConfig();
    await manager.startServer(config);
    children[0].stdout.emit("data", "Server ready at http://localhost:3000");

    expect(manager.getSession(config.id)?.previewUrl).toBe("http://localhost:3000");
  });

  it("detects URL from stdout with 127.0.0.1:5173", async () => {
    const config = makeConfig();
    await manager.startServer(config);
    children[0].stdout.emit("data", "Vite ready: http://127.0.0.1:5173");

    expect(manager.getSession(config.id)?.previewUrl).toBe("http://127.0.0.1:5173");
  });

  it("detects URL from stderr output", async () => {
    const config = makeConfig();
    await manager.startServer(config);
    children[0].stderr.emit("data", "Listening on http://localhost:4000");

    expect(manager.getSession(config.id)?.previewUrl).toBe("http://localhost:4000");
  });

  it("first URL wins when multiple URLs are present", async () => {
    const config = makeConfig();
    await manager.startServer(config);
    children[0].stdout.emit(
      "data",
      "Ready at http://localhost:3000 then proxy at http://localhost:3001",
    );

    // First URL should win
    expect(manager.getSession(config.id)?.previewUrl).toBe("http://localhost:3000");
  });

  it("setPreviewUrl updates the preview URL manually", async () => {
    const config = makeConfig();
    await manager.startServer(config);

    // Set manual URL
    manager.setPreviewUrl(config.id, "http://custom:9999");

    expect(manager.getSession(config.id)?.previewUrl).toBe("http://custom:9999");
  });

  it("port probing fallback sets URL when no URL is detected", async () => {
    vi.useFakeTimers();

    createConnectionMock.mockReset();
    createConnectionMock.mockImplementation((options: { port: number }) => {
      const socket = createMockSocket();
      queueMicrotask(() => {
        if (options.port === 3000) {
          socket.emit("connect");
        } else {
          socket.emit("error", new Error("closed"));
        }
      });
      return socket;
    });

    const config = makeConfig();
    await manager.startServer(config);
    // No URL output, just some generic output
    children[0].stdout.emit("data", "started");

    // Advance timers past the probe delay (10s)
    await vi.advanceTimersByTimeAsync(10_001);

    expect(manager.getSession(config.id)?.previewUrl).toBe("http://localhost:3000");
  });

  it("URL stays null when port probing finds nothing", async () => {
    vi.useFakeTimers();

    createConnectionMock.mockReset();
    // All connection attempts fail
    createConnectionMock.mockImplementation(() => {
      const socket = createMockSocket();
      queueMicrotask(() => {
        socket.emit("error", new Error("closed"));
      });
      return socket;
    });

    const config = makeConfig();
    await manager.startServer(config);
    // No URL output
    children[0].stdout.emit("data", "started");

    // Advance timers past the probe delay
    await vi.advanceTimersByTimeAsync(10_001);

    expect(manager.getSession(config.id)?.previewUrl).toBeUndefined();
  });

  it("clearing manual override reveals auto-detected URL", async () => {
    const config = makeConfig();
    await manager.startServer(config);

    // Set manual override
    manager.setPreviewUrl(config.id, "http://custom:9999");

    // Then clear it
    manager.setPreviewUrl(config.id, null);

    // Should be undefined now (since no auto-detection happened)
    expect(manager.getSession(config.id)?.previewUrl).toBeUndefined();

    // Now emit auto-detection
    children[0].stdout.emit("data", "Server at http://localhost:3000");

    expect(manager.getSession(config.id)?.previewUrl).toBe("http://localhost:3000");
  });

  it("emits preview event on URL detection", async () => {
    const config = makeConfig();
    const onPreview = vi.fn();
    manager.on("preview", onPreview);

    await manager.startServer(config);
    children[0].stdout.emit("data", "Ready at http://localhost:3000");

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith(config.id, "http://localhost:3000");
  });

  it("emits preview event on manual override", async () => {
    const config = makeConfig();
    const onPreview = vi.fn();
    manager.on("preview", onPreview);

    await manager.startServer(config);
    manager.setPreviewUrl(config.id, "http://manual:8888");

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith(config.id, "http://manual:8888");
  });

  it("handles URL in the middle of log line", async () => {
    const config = makeConfig();
    await manager.startServer(config);
    children[0].stdout.emit(
      "data",
      "[INFO] Application started on http://localhost:5173 and ready for connections",
    );

    expect(manager.getSession(config.id)?.previewUrl).toBe("http://localhost:5173");
  });

  it("detects URL with explicit port", async () => {
    const config = makeConfig();
    await manager.startServer(config);
    children[0].stdout.emit("data", "Running at http://localhost:3000");

    expect(manager.getSession(config.id)?.previewUrl).toBe("http://localhost:3000");
  });
});
