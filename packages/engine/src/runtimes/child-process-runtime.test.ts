import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CentralCore, Task } from "@fusion/core";
import { ChildProcessRuntime } from "./child-process-runtime.js";
import type {
  ProjectRuntimeConfig,
  RuntimeMetrics,
  RuntimeStatus,
} from "../project-runtime.js";
import { runtimeLog } from "../logger.js";
import {
  START_RUNTIME,
  STOP_RUNTIME,
  GET_METRICS,
  TASK_CREATED,
  TASK_MOVED,
  TASK_UPDATED,
  ERROR_EVENT,
  HEALTH_CHANGED,
  OK,
  ERROR,
  PONG,
} from "../ipc/ipc-protocol.js";

type Listener = (...args: any[]) => void;

type CommandMessage = {
  type: string;
  id: string;
  payload: unknown;
};

type MockChildOptions = {
  pingResults?: boolean[];
  metricsResponse?: RuntimeMetrics;
  sendCallbackErrors?: Partial<Record<string, Error>>;
  markKilledOnSigterm?: boolean;
  emitExitOnKill?: boolean;
};

type MockChildProcess = {
  on: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
  connected: boolean;
  killed: boolean;
  sentMessages: CommandMessage[];
};

const forkedChildren: MockChildProcess[] = [];
const queuedForkOptions: MockChildOptions[] = [];

function createMockChildProcess(options: MockChildOptions = {}): MockChildProcess {
  const listeners = new Map<string, Listener[]>();
  const pingResults = [...(options.pingResults ?? [])];

  const child: MockChildProcess = {
    on: vi.fn((event: string, handler: Listener) => {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
      return child;
    }),
    send: vi.fn((message: CommandMessage, callback?: (error: Error | null) => void) => {
      child.sentMessages.push(message);

      const sendError = options.sendCallbackErrors?.[message.type];
      if (sendError) {
        callback?.(sendError);
        return false;
      }

      callback?.(null);

      const respond = (type: string, payload: unknown) => {
        Promise.resolve().then(() => {
          child.emit("message", {
            type,
            id: message.id,
            payload,
          });
        });
      };

      if (message.type === START_RUNTIME) {
        respond(OK, { data: { status: "active" } });
      } else if (message.type === STOP_RUNTIME) {
        respond(OK, { data: { stopped: true } });
      } else if (message.type === GET_METRICS) {
        respond(OK, {
          data:
            options.metricsResponse ??
            {
              inFlightTasks: 4,
              activeAgents: 2,
              lastActivityAt: "2026-04-08T00:00:00.000Z",
            },
        });
      } else if (message.type === "PING") {
        const pingOk = pingResults.shift() ?? true;
        if (pingOk) {
          respond(PONG, { timestamp: "2026-04-08T00:00:00.000Z" });
        } else {
          respond(ERROR, { message: "Ping failed", code: "PING_FAILED" });
        }
      }

      return true;
    }),
    kill: vi.fn((signal?: string | number) => {
      if (signal === "SIGKILL" || (signal === "SIGTERM" && options.markKilledOnSigterm !== false)) {
        child.killed = true;
      }

      if (options.emitExitOnKill) {
        child.emit("exit", signal === "SIGKILL" ? 137 : 0, typeof signal === "string" ? signal : null);
      }

      return true;
    }),
    disconnect: vi.fn(() => {
      child.connected = false;
      child.emit("disconnect");
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of listeners.get(event) ?? []) {
        handler(...(args as any[]));
      }
    },
    connected: true,
    killed: false,
    sentMessages: [],
  };

  return child;
}

const mockFork = vi.fn(() => {
  const options = queuedForkOptions.shift() ?? {};
  const child = createMockChildProcess(options);
  forkedChildren.push(child);
  return child;
});

vi.mock("node:child_process", () => ({
  fork: (...args: unknown[]) => (mockFork as (...mockArgs: unknown[]) => unknown)(...args),
}));

function queueChild(options: MockChildOptions = {}): void {
  queuedForkOptions.push(options);
}

function getLatestChild(): MockChildProcess {
  const child = forkedChildren.at(-1);
  if (!child) {
    throw new Error("Expected a forked child process");
  }
  return child;
}

function getMessages(child: MockChildProcess, type: string): CommandMessage[] {
  return child.sentMessages.filter((message) => message.type === type);
}

function createMockTask(id: string): Task {
  return {
    id,
    title: `${id} title`,
    description: `${id} description`,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
    size: "M",
    reviewLevel: 1,
    log: [],
    attachments: [],
  } as Task;
}

describe("ChildProcessRuntime", () => {
  let runtime: ChildProcessRuntime;
  let runtimeAny: any;

  const testConfig: ProjectRuntimeConfig = {
    projectId: "proj_test123",
    workingDirectory: "/tmp/test-project",
    isolationMode: "child-process",
    maxConcurrent: 2,
    maxWorktrees: 4,
  };

  beforeEach(() => {
    mockFork.mockClear();
    forkedChildren.length = 0;
    queuedForkOptions.length = 0;

    const mockCentralCore = {
      getGlobalConcurrencyState: vi.fn().mockResolvedValue({
        globalMaxConcurrent: 4,
        currentlyActive: 0,
        queuedCount: 0,
        projectsActive: {},
      }),
    } as unknown as CentralCore;

    runtime = new ChildProcessRuntime(testConfig, mockCentralCore);
    runtimeAny = runtime as any;
  });

  afterEach(async () => {
    try {
      await runtime.stop();
    } catch {
      // Ignore cleanup failures
    }

    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("startup sequence", () => {
    it("transitions stopped → starting → active, forks worker path, and sends START_RUNTIME config", async () => {
      queueChild();

      const transitions: RuntimeStatus[] = [];
      runtime.on("health-changed", (data) => transitions.push(data.status));

      await runtime.start();

      const child = getLatestChild();

      expect(transitions).toEqual(["starting", "active"]);
      expect(runtime.getStatus()).toBe("active");
      expect(mockFork).toHaveBeenCalledWith(
        expect.stringMatching(/child-process-worker\.(ts|js)$/),
        [],
        expect.objectContaining({
          silent: true,
          execArgv: [],
        })
      );

      const startMessages = getMessages(child, START_RUNTIME);
      expect(startMessages).toHaveLength(1);
      expect(startMessages[0]?.payload).toEqual({ config: testConfig });
    });

    it("sets status to errored and emits error when startup fails", async () => {
      queueChild({
        sendCallbackErrors: {
          [START_RUNTIME]: new Error("start send failed"),
        },
      });

      const errorSpy = vi.fn();
      runtime.on("error", errorSpy);

      await expect(runtime.start()).rejects.toThrow("Failed to send command: start send failed");
      expect(runtime.getStatus()).toBe("errored");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    });

    it("throws when start() is called in non-stopped states", async () => {
      const blockedStates: RuntimeStatus[] = ["starting", "active", "stopping"];

      for (const status of blockedStates) {
        runtimeAny.status = status;
        await expect(runtime.start()).rejects.toThrow(`Cannot start runtime: current status is ${status}`);
      }
    });
  });

  describe("shutdown sequence", () => {
    it("transitions active → stopping → stopped and sends STOP_RUNTIME with timeout", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      const transitions: RuntimeStatus[] = [];
      runtime.on("health-changed", (data) => transitions.push(data.status));

      await runtime.stop();

      expect(transitions).toEqual(["stopping", "stopped"]);
      expect(runtime.getStatus()).toBe("stopped");
      expect(getMessages(child, STOP_RUNTIME)).toHaveLength(1);
      expect(getMessages(child, STOP_RUNTIME)[0]?.payload).toEqual({ timeoutMs: 30000 });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("is idempotent and does not send duplicate STOP_RUNTIME commands", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      await runtime.stop();
      await runtime.stop();

      expect(getMessages(child, STOP_RUNTIME)).toHaveLength(1);
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it("returns without error when stop() is called while already stopped", async () => {
      await expect(runtime.stop()).resolves.toBeUndefined();
      expect(runtime.getStatus()).toBe("stopped");
    });

    it("handles stop() gracefully when IPC is already disconnected", async () => {
      queueChild();
      runtime.on("error", () => {
        // swallow asynchronous error events from disconnection path
      });

      await runtime.start();
      const child = getLatestChild();

      child.connected = false;
      child.emit("disconnect");

      await expect(runtime.stop()).resolves.toBeUndefined();
      expect(runtime.getStatus()).toBe("stopped");
    });

    it("force-kills with SIGKILL after 5s timeout when child remains alive", async () => {
      vi.useFakeTimers();
      queueChild({ markKilledOnSigterm: false });

      await runtime.start();
      const child = getLatestChild();

      await runtime.stop();

      // Keep a live child reference so the delayed SIGKILL callback can execute the force-kill path.
      runtimeAny.child = child;
      child.killed = false;

      await vi.advanceTimersByTimeAsync(5000);

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });
  });

  describe("health monitoring and restart", () => {
    it("starts health monitoring after start() and performs periodic pings", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: [true, true] });

      await runtime.start();
      const child = getLatestChild();

      expect(getMessages(child, "PING")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(getMessages(child, "PING")).toHaveLength(1);
    });

    it("resets missed heartbeat count to 0 after a successful ping", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: [false, true] });
      runtime.on("error", () => {
        // swallow
      });

      await runtime.start();

      await vi.advanceTimersByTimeAsync(5000);
      expect(runtimeAny.healthMonitor.getMissedHeartbeats()).toBe(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(runtimeAny.healthMonitor.getMissedHeartbeats()).toBe(0);
    });

    it("triggers handleUnhealthy after three missed heartbeats", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: [false, false, false] });

      const unhealthySpy = vi.spyOn(runtimeAny, "handleUnhealthy").mockImplementation(() => {});

      await runtime.start();
      await vi.advanceTimersByTimeAsync(15000);

      expect(unhealthySpy).toHaveBeenCalledTimes(1);
    });

    it("uses exponential restart delays: 1000ms, 5000ms, 15000ms", () => {
      vi.useFakeTimers();
      runtimeAny.status = "active";

      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

      runtimeAny.handleUnhealthy();
      runtimeAny.handleUnhealthy();
      runtimeAny.handleUnhealthy();

      const delays = timeoutSpy.mock.calls.map((call) => Number(call[1]));
      expect(delays.slice(0, 3)).toEqual([1000, 5000, 15000]);
    });

    it("transitions to errored and emits error after max restart attempts", () => {
      runtimeAny.status = "active";

      const errorSpy = vi.fn();
      runtime.on("error", errorSpy);

      runtimeAny.handleUnhealthy();
      runtimeAny.handleUnhealthy();
      runtimeAny.handleUnhealthy();
      runtimeAny.handleUnhealthy();

      expect(runtime.getStatus()).toBe("errored");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect((errorSpy.mock.calls[0]?.[0] as Error).message).toContain("max restart attempts");
    });

    it("resets restart attempt counter after a successful health check", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: [true] });

      await runtime.start();

      runtimeAny.healthMonitor.incrementRestartAttempts();
      runtimeAny.healthMonitor.incrementRestartAttempts();
      expect(runtimeAny.healthMonitor.getRestartAttempts()).toBe(2);

      await vi.advanceTimersByTimeAsync(5000);

      expect(runtimeAny.healthMonitor.getRestartAttempts()).toBe(0);
    });

    it("stops health checks after stop()", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: [true, true, true] });

      await runtime.start();
      const child = getLatestChild();

      await vi.advanceTimersByTimeAsync(5000);
      const pingCountBeforeStop = getMessages(child, "PING").length;

      await runtime.stop();
      await vi.advanceTimersByTimeAsync(20000);

      expect(getMessages(child, "PING").length).toBe(pingCountBeforeStop);
    });
  });

  describe("child process exit and disconnect", () => {
    it("unexpected child exit while active triggers restart handling", async () => {
      queueChild();
      await runtime.start();

      const child = getLatestChild();
      const unhealthySpy = vi.spyOn(runtimeAny, "handleUnhealthy").mockImplementation(() => {});

      child.emit("exit", 1, null);

      expect(unhealthySpy).toHaveBeenCalled();
    });

    it("child exit while stopping does not trigger restart", async () => {
      queueChild();
      await runtime.start();

      const child = getLatestChild();
      const unhealthySpy = vi.spyOn(runtimeAny, "handleUnhealthy").mockImplementation(() => {});
      runtimeAny.status = "stopping";

      child.emit("exit", 1, null);

      expect(unhealthySpy).not.toHaveBeenCalled();
    });

    it("child exit while stopped does not trigger restart", async () => {
      queueChild();
      await runtime.start();

      const child = getLatestChild();
      const unhealthySpy = vi.spyOn(runtimeAny, "handleUnhealthy").mockImplementation(() => {});
      runtimeAny.status = "stopped";

      child.emit("exit", 1, null);

      expect(unhealthySpy).not.toHaveBeenCalled();
    });

    it("IPC disconnect while active triggers restart handling", async () => {
      queueChild();
      await runtime.start();

      const child = getLatestChild();
      const unhealthySpy = vi.spyOn(runtimeAny, "handleUnhealthy").mockImplementation(() => {});

      child.emit("disconnect");

      expect(unhealthySpy).toHaveBeenCalled();
    });

    it("IPC disconnect while stopping does not trigger restart", async () => {
      queueChild();
      await runtime.start();

      const child = getLatestChild();
      const unhealthySpy = vi.spyOn(runtimeAny, "handleUnhealthy").mockImplementation(() => {});
      runtimeAny.status = "stopping";

      child.emit("disconnect");

      expect(unhealthySpy).not.toHaveBeenCalled();
    });
  });

  describe("event forwarding", () => {
    it("forwards TASK_CREATED as task:created", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      const task = createMockTask("FN-1279-A");
      const createdSpy = vi.fn();
      runtime.on("task:created", createdSpy);

      child.emit("message", {
        type: TASK_CREATED,
        id: "evt-created",
        payload: { task },
      });

      expect(createdSpy).toHaveBeenCalledWith(task);
    });

    it("forwards TASK_MOVED as task:moved with { task, from, to } shape", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      const task = createMockTask("FN-1279-B");
      const movedSpy = vi.fn();
      runtime.on("task:moved", movedSpy);

      child.emit("message", {
        type: TASK_MOVED,
        id: "evt-moved",
        payload: { task, from: "todo", to: "in-progress" },
      });

      expect(movedSpy).toHaveBeenCalledWith({ task, from: "todo", to: "in-progress" });
    });

    it("forwards TASK_UPDATED as task:updated", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      const task = createMockTask("FN-1279-C");
      const updatedSpy = vi.fn();
      runtime.on("task:updated", updatedSpy);

      child.emit("message", {
        type: TASK_UPDATED,
        id: "evt-updated",
        payload: { task },
      });

      expect(updatedSpy).toHaveBeenCalledWith(task);
    });

    it("forwards ERROR_EVENT as Error instance and preserves error code", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      const errorSpy = vi.fn();
      runtime.on("error", errorSpy);

      child.emit("message", {
        type: ERROR_EVENT,
        id: "evt-error",
        payload: { message: "worker failed", code: "WORKER_FAILURE" },
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const forwardedError = errorSpy.mock.calls[0]?.[0] as Error & { code?: string };
      expect(forwardedError).toBeInstanceOf(Error);
      expect(forwardedError.message).toBe("worker failed");
      expect(forwardedError.code).toBe("WORKER_FAILURE");
    });

    it("applies HEALTH_CHANGED payload to status and emits health-changed", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      const healthSpy = vi.fn();
      runtime.on("health-changed", healthSpy);
      healthSpy.mockClear();

      child.emit("message", {
        type: HEALTH_CHANGED,
        id: "evt-health",
        payload: { status: "paused", previous: "active" },
      });

      expect(runtime.getStatus()).toBe("paused");
      expect(healthSpy).toHaveBeenCalledWith({ status: "paused", previous: "active" });
    });
  });

  describe("metrics and inaccessible accessors", () => {
    it("returns cached metrics when IPC is disconnected", () => {
      runtimeAny.lastMetrics = {
        inFlightTasks: 9,
        activeAgents: 3,
        lastActivityAt: "2026-04-08T01:00:00.000Z",
      };

      const metrics = runtime.getMetrics();

      expect(metrics.inFlightTasks).toBe(9);
      expect(metrics.activeAgents).toBe(3);
      expect(typeof metrics.lastActivityAt).toBe("string");
    });

    it("updates cached metrics when GET_METRICS response is received", async () => {
      queueChild({
        metricsResponse: {
          inFlightTasks: 12,
          activeAgents: 5,
          lastActivityAt: "2026-04-08T02:00:00.000Z",
        },
      });
      await runtime.start();

      runtime.getMetrics();

      await vi.waitFor(() => {
        expect(runtimeAny.lastMetrics).toEqual({
          inFlightTasks: 12,
          activeAgents: 5,
          lastActivityAt: "2026-04-08T02:00:00.000Z",
        });
      });
    });

    it("ignores GET_METRICS IPC errors and returns the last known metrics", async () => {
      queueChild({
        sendCallbackErrors: {
          [GET_METRICS]: new Error("metrics unavailable"),
        },
      });
      await runtime.start();

      runtimeAny.lastMetrics = {
        inFlightTasks: 21,
        activeAgents: 8,
        lastActivityAt: "2026-04-08T03:00:00.000Z",
      };

      const metrics = runtime.getMetrics();

      expect(metrics.inFlightTasks).toBe(21);
      expect(metrics.activeAgents).toBe(8);

      await Promise.resolve();
      expect(runtimeAny.lastMetrics).toEqual({
        inFlightTasks: 21,
        activeAgents: 8,
        lastActivityAt: "2026-04-08T03:00:00.000Z",
      });
    });

    it("logs warning when GET_METRICS IPC query fails", async () => {
      const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => {});

      queueChild({
        sendCallbackErrors: {
          [GET_METRICS]: new Error("metrics unavailable"),
        },
      });
      await runtime.start();

      runtimeAny.lastMetrics = {
        inFlightTasks: 1,
        activeAgents: 0,
        lastActivityAt: "2026-04-08T04:00:00.000Z",
      };

      const metrics = runtime.getMetrics();
      expect(metrics.inFlightTasks).toBe(1);
      expect(metrics.activeAgents).toBe(0);

      await vi.waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("GET_METRICS IPC query failed, using cached value"),
        );
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("metrics unavailable"));

      warnSpy.mockRestore();
    });

    it("getTaskStore() always throws not accessible error", () => {
      expect(() => runtime.getTaskStore()).toThrow("not accessible in ChildProcessRuntime");
    });

    it("getScheduler() always throws not accessible error", () => {
      expect(() => runtime.getScheduler()).toThrow("not accessible in ChildProcessRuntime");
    });
  });
});
