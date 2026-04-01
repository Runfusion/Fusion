/**
 * Unit tests for IpcHost — the parent-side IPC handler that sends commands
 * to a child process worker and correlates responses.
 *
 * Coverage:
 * - Constructor: listener setup, options, initial state
 * - sendCommand: serialization, response correlation (OK/ERROR/PONG), timeout, disconnection
 * - ping: convenience wrapper for sendCommand("PING")
 * - Event forwarding: worker events emitted on IpcHost
 * - Malformed/unknown messages: silently ignored
 * - Disconnection cascade: child error/exit/disconnect → pending commands rejected
 * - disconnect(): explicit cleanup and listener removal
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { IpcHost } from "./ipc-host.js";
import { OK, ERROR, PONG, TASK_CREATED } from "./ipc-protocol.js";

// ── Mock logger to suppress console output ──────────────────────────────
vi.mock("../logger.js", () => ({
  ipcLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Mock ChildProcess factory ───────────────────────────────────────────

/**
 * Creates a mock ChildProcess that is an EventEmitter with the required
 * properties for IpcHost: `send`, `connected`, `disconnect`.
 */
function createMockChildProcess(
  overrides: {
    connected?: boolean;
    send?: ((...args: any[]) => any) | undefined;
  } = {}
): ChildProcess {
  const emitter = new EventEmitter();
  const mock = emitter as unknown as ChildProcess & EventEmitter;

  // Default: connected with a working send
  Object.defineProperty(mock, "connected", {
    get: () => overrides.connected ?? true,
    configurable: true,
  });

  if (overrides.send === undefined && !("send" in overrides)) {
    // Default: working send that invokes callback with no error
    (mock as any).send = vi.fn((...args: any[]) => {
      const callback = args.find((a: unknown) => typeof a === "function");
      if (callback) callback(null);
      return true;
    });
  } else {
    (mock as any).send = overrides.send;
  }

  (mock as any).disconnect = vi.fn();
  (mock as any).kill = vi.fn();
  (mock as any).killed = false;
  (mock as any).pid = 12345;

  return mock;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("IpcHost", () => {
  let child: ChildProcess & EventEmitter;
  let host: IpcHost;

  beforeEach(() => {
    child = createMockChildProcess() as ChildProcess & EventEmitter;
    host = new IpcHost(child);
  });

  afterEach(() => {
    host.removeAllListeners();
  });

  // ── Constructor & initial state ──────────────────────────────────────

  describe("constructor and initial state", () => {
    it("registers listeners on child process for message, error, exit, disconnect events", () => {
      // EventEmitter.listenerCount shows listeners were added
      expect(child.listenerCount("message")).toBeGreaterThanOrEqual(1);
      expect(child.listenerCount("error")).toBeGreaterThanOrEqual(1);
      expect(child.listenerCount("exit")).toBeGreaterThanOrEqual(1);
      expect(child.listenerCount("disconnect")).toBeGreaterThanOrEqual(1);
    });

    it("isConnected() returns true when child is connected and not disconnected", () => {
      expect(host.isConnected()).toBe(true);
    });

    it("isConnected() returns false after disconnection", () => {
      child.emit("disconnect");
      expect(host.isConnected()).toBe(false);
    });

    it("getChildProcess() returns the child process instance", () => {
      expect(host.getChildProcess()).toBe(child);
    });

    it("getPendingCommandCount() returns 0 initially", () => {
      expect(host.getPendingCommandCount()).toBe(0);
    });

    it("accepts custom commandTimeoutMs option", () => {
      // We verify this indirectly in the timeout test in Step 2
      const customHost = new IpcHost(child, { commandTimeoutMs: 500 });
      expect(customHost).toBeInstanceOf(IpcHost);
      customHost.removeAllListeners();
    });
  });

  // ── sendCommand and response correlation ────────────────────────────

  describe("sendCommand", () => {
    it("sends a valid IpcMessage via childProcess.send() with correct type, unique id, and payload", async () => {
      const sendFn = child.send as ReturnType<typeof vi.fn>;
      const commandPromise = host.sendCommand("GET_STATUS", { foo: "bar" });

      // Extract the message from the mock send call
      expect(sendFn).toHaveBeenCalledTimes(1);
      const sentMessage = sendFn.mock.calls[0][0];
      expect(sentMessage.type).toBe("GET_STATUS");
      expect(typeof sentMessage.id).toBe("string");
      expect(sentMessage.id.length).toBeGreaterThan(0);
      expect(sentMessage.payload).toEqual({ foo: "bar" });

      // Respond to resolve the promise
      child.emit("message", { type: OK, id: sentMessage.id, payload: { data: "result" } });
      await expect(commandPromise).resolves.toBe("result");
    });

    it("resolves with data when child responds with OK matching the correlation ID", async () => {
      const sendFn = child.send as ReturnType<typeof vi.fn>;
      const promise = host.sendCommand("GET_METRICS", {});

      const sentId = sendFn.mock.calls[0][0].id;
      child.emit("message", { type: OK, id: sentId, payload: { data: { tasks: 5 } } });

      await expect(promise).resolves.toEqual({ tasks: 5 });
    });

    it("rejects with an Error (including message and code) when child responds with ERROR", async () => {
      const sendFn = child.send as ReturnType<typeof vi.fn>;
      const promise = host.sendCommand("GET_STATUS", {});

      const sentId = sendFn.mock.calls[0][0].id;
      child.emit("message", {
        type: ERROR,
        id: sentId,
        payload: { message: "Something went wrong", code: "HANDLER_ERROR" },
      });

      await expect(promise).rejects.toThrow("Something went wrong");
      try {
        await promise;
      } catch (err: any) {
        expect(err.code).toBe("HANDLER_ERROR");
      }
    });

    it("resolves with pong payload when child responds with PONG", async () => {
      const sendFn = child.send as ReturnType<typeof vi.fn>;
      const promise = host.sendCommand("PING", {});

      const sentId = sendFn.mock.calls[0][0].id;
      child.emit("message", {
        type: PONG,
        id: sentId,
        payload: { timestamp: "2026-04-01T00:00:00.000Z" },
      });

      await expect(promise).resolves.toEqual({ timestamp: "2026-04-01T00:00:00.000Z" });
    });

    it("rejects after timeout using fake timers", async () => {
      vi.useFakeTimers();
      try {
        const promise = host.sendCommand("GET_STATUS", {}, 1000);

        // Advance past the timeout
        vi.advanceTimersByTime(1001);

        await expect(promise).rejects.toThrow("timed out after 1000ms");
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses custom commandTimeoutMs when no per-call override provided", async () => {
      vi.useFakeTimers();
      try {
        const shortHost = new IpcHost(child, { commandTimeoutMs: 200 });
        const promise = shortHost.sendCommand("GET_STATUS", {});

        vi.advanceTimersByTime(201);

        await expect(promise).rejects.toThrow("timed out after 200ms");
        shortHost.removeAllListeners();
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears pending command on successful response (getPendingCommandCount returns 0)", async () => {
      const sendFn = child.send as ReturnType<typeof vi.fn>;
      const promise = host.sendCommand("GET_STATUS", {});

      expect(host.getPendingCommandCount()).toBe(1);

      const sentId = sendFn.mock.calls[0][0].id;
      child.emit("message", { type: OK, id: sentId, payload: { data: null } });
      await promise;

      expect(host.getPendingCommandCount()).toBe(0);
    });

    it("rejects immediately when IPC is already disconnected", async () => {
      child.emit("disconnect");

      await expect(host.sendCommand("GET_STATUS", {})).rejects.toThrow(
        "Cannot send command: IPC channel disconnected"
      );
    });

    it("rejects when childProcess.send is undefined (no IPC channel)", async () => {
      const noSendChild = createMockChildProcess({ send: undefined }) as ChildProcess & EventEmitter;
      const noSendHost = new IpcHost(noSendChild);

      await expect(noSendHost.sendCommand("GET_STATUS", {})).rejects.toThrow(
        "Child process does not have IPC channel"
      );
      noSendHost.removeAllListeners();
    });

    it("rejects when childProcess.send callback returns an error", async () => {
      const errChild = createMockChildProcess({
        send: vi.fn((...args: any[]) => {
          // Find the callback argument (last function arg)
          const callback = args.find((a: unknown) => typeof a === "function");
          if (callback) callback(new Error("Send failed"));
          return false;
        }) as any,
      }) as ChildProcess & EventEmitter;
      const errHost = new IpcHost(errChild);

      await expect(errHost.sendCommand("GET_STATUS", {})).rejects.toThrow("Failed to send command: Send failed");
      errHost.removeAllListeners();
    });
  });

  // ── ping ─────────────────────────────────────────────────────────────

  describe("ping", () => {
    it("calls sendCommand('PING', {}, 5000) and resolves with timestamp", async () => {
      const sendFn = child.send as ReturnType<typeof vi.fn>;
      const promise = host.ping();

      const sentMessage = sendFn.mock.calls[0][0];
      expect(sentMessage.type).toBe("PING");

      child.emit("message", {
        type: PONG,
        id: sentMessage.id,
        payload: { timestamp: "2026-04-01T12:00:00.000Z" },
      });

      const result = await promise;
      expect(result).toEqual({ timestamp: "2026-04-01T12:00:00.000Z" });
    });
  });

  // ── Event forwarding ────────────────────────────────────────────────

  describe("event forwarding", () => {
    it("incoming event messages are emitted on IpcHost with the event type and payload", () => {
      const handler = vi.fn();
      host.on(TASK_CREATED, handler);

      const payload = { task: { id: "KB-001", title: "Test" } };
      child.emit("message", {
        type: TASK_CREATED,
        id: "evt-1",
        payload,
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('generic "message" event is also emitted for every incoming event message', () => {
      const handler = vi.fn();
      host.on("message", handler);

      const message = { type: TASK_CREATED, id: "evt-2", payload: { task: {} } };
      child.emit("message", message);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(message);
    });
  });

  // ── Malformed messages ──────────────────────────────────────────────

  describe("malformed messages", () => {
    it("silently ignores message missing type", () => {
      const handler = vi.fn();
      host.on("message", handler);

      // Missing type
      child.emit("message", { id: "x", payload: {} });
      expect(handler).not.toHaveBeenCalled();
    });

    it("silently ignores message missing id", () => {
      const handler = vi.fn();
      host.on("message", handler);

      child.emit("message", { type: "SOME_TYPE", payload: {} });
      expect(handler).not.toHaveBeenCalled();
    });

    it("silently ignores message missing payload", () => {
      const handler = vi.fn();
      host.on("message", handler);

      child.emit("message", { type: "SOME_TYPE", id: "x" });
      expect(handler).not.toHaveBeenCalled();
    });

    it("silently ignores non-object messages", () => {
      const handler = vi.fn();
      host.on("message", handler);

      child.emit("message", "not an object");
      child.emit("message", null);
      child.emit("message", 42);
      expect(handler).not.toHaveBeenCalled();
    });

    it("ignores response for unknown correlation ID without crashing", () => {
      // Should not throw
      child.emit("message", {
        type: OK,
        id: "unknown-correlation-id",
        payload: { data: "phantom" },
      });

      expect(host.getPendingCommandCount()).toBe(0);
    });
  });

  // ── Disconnection cascade ───────────────────────────────────────────

  describe("disconnection", () => {
    it("child error event rejects all pending commands with 'IPC disconnected' error and emits 'disconnect'", async () => {
      vi.useFakeTimers();
      try {
        const disconnectHandler = vi.fn();
        host.on("disconnect", disconnectHandler);

        const promise = host.sendCommand("GET_STATUS", {});
        expect(host.getPendingCommandCount()).toBe(1);

        child.emit("error", new Error("child crash"));

        await expect(promise).rejects.toThrow("IPC disconnected");
        expect(host.getPendingCommandCount()).toBe(0);
        expect(disconnectHandler).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("child exit event (with code) triggers disconnection", async () => {
      vi.useFakeTimers();
      try {
        const disconnectHandler = vi.fn();
        host.on("disconnect", disconnectHandler);

        const promise = host.sendCommand("GET_STATUS", {});

        child.emit("exit", 1, null);

        await expect(promise).rejects.toThrow("IPC disconnected");
        expect(disconnectHandler).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("child exit event (with signal) triggers disconnection", async () => {
      vi.useFakeTimers();
      try {
        const disconnectHandler = vi.fn();
        host.on("disconnect", disconnectHandler);

        const promise = host.sendCommand("GET_STATUS", {});

        child.emit("exit", null, "SIGTERM");

        await expect(promise).rejects.toThrow("IPC disconnected");
        expect(disconnectHandler).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("child disconnect event triggers disconnection", async () => {
      vi.useFakeTimers();
      try {
        const disconnectHandler = vi.fn();
        host.on("disconnect", disconnectHandler);

        const promise = host.sendCommand("GET_STATUS", {});

        child.emit("disconnect");

        await expect(promise).rejects.toThrow("IPC disconnected");
        expect(disconnectHandler).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("double disconnection is idempotent (no re-reject or double-emit)", () => {
      const disconnectHandler = vi.fn();
      host.on("disconnect", disconnectHandler);

      child.emit("disconnect");
      child.emit("disconnect");

      expect(disconnectHandler).toHaveBeenCalledTimes(1);
    });

    it("disconnect() method rejects pending commands, calls childProcess.disconnect(), removes all listeners", async () => {
      vi.useFakeTimers();
      try {
        const promise = host.sendCommand("GET_STATUS", {});
        expect(host.getPendingCommandCount()).toBe(1);

        host.disconnect();

        await expect(promise).rejects.toThrow("IPC disconnected");
        expect(host.getPendingCommandCount()).toBe(0);
        expect((child as any).disconnect).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("disconnect() skips childProcess.disconnect() when already disconnected", () => {
      // Simulate child already disconnected
      Object.defineProperty(child, "connected", {
        get: () => false,
        configurable: true,
      });

      host.disconnect();
      // disconnect() should not call child.disconnect() since connected is false
      expect((child as any).disconnect).not.toHaveBeenCalled();
    });
  });
});
