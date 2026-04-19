/**
 * Unit tests for IpcWorker — the child-process-side IPC handler that receives
 * commands from a host, dispatches to registered handlers, and sends responses/events.
 *
 * Coverage:
 * - Constructor: process.send validation, listener registration, initial state
 * - PING auto-response (no handler needed)
 * - onCommand / offCommand: handler registration and dispatch
 * - Command execution: OK response, ERROR response (Error and non-Error), NO_HANDLER, UNKNOWN_COMMAND, MALFORMED_MESSAGE
 * - sendEvent / sendErrorEvent: event message construction
 * - sendResponse: response message construction
 * - shutdown: idempotent, suppresses further sends, emits event
 * - disconnect event forwarding
 * - Edge cases: process.send undefined after construction, graceful fallback
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PING, PONG, OK, ERROR, TASK_CREATED, ERROR_EVENT } from "./ipc-protocol.js";
import { ipcLog } from "../logger.js";

// ── Mock logger to suppress console output ──────────────────────────────
vi.mock("../logger.js", () => ({
  ipcLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Process mock utilities ──────────────────────────────────────────────

/**
 * We need to mock process.send and intercept process.on("message") handlers
 * without breaking the real process. Strategy:
 * - Set process.send to a vi.fn() before creating IpcWorker
 * - Track message handlers registered via process.on("message")
 * - Simulate incoming messages by calling those handlers directly
 */

// Store the original process.send to restore after tests
const originalProcessSend = process.send;

// Track registered message/disconnect handlers so we can invoke them
let messageHandlers: Array<(msg: unknown) => void> = [];
let disconnectHandlers: Array<() => void> = [];

// Spies for process.on and process.removeAllListeners
let processOnSpy: ReturnType<typeof vi.fn>;

function setupProcessMocks() {
  // Set up process.send as a mock function
  process.send = vi.fn((_msg: unknown, _handle?: unknown, _options?: unknown, callback?: (err: Error | null) => void) => {
    if (typeof callback === "function") callback(null);
    return true;
  });

  messageHandlers = [];
  disconnectHandlers = [];

  // Intercept process.on to capture message/disconnect handlers
  const originalProcessOn = process.on.bind(process);
  processOnSpy = vi.fn((event: string, handler: (...args: any[]) => void) => {
    if (event === "message") {
      messageHandlers.push(handler);
    } else if (event === "disconnect") {
      disconnectHandlers.push(handler);
    }
    // Don't register signal handlers on real process during tests
    if (event === "SIGTERM" || event === "SIGINT" || event === "uncaughtException" || event === "unhandledRejection") {
      return process;
    }
    return originalProcessOn(event, handler);
  });
  process.on = processOnSpy as any;
}

function teardownProcessMocks() {
  // Restore process.send
  if (originalProcessSend === undefined) {
    delete (process as any).send;
  } else {
    process.send = originalProcessSend;
  }

  // Remove any listeners we added during the test
  for (const handler of messageHandlers) {
    process.removeListener("message", handler);
  }
  for (const handler of disconnectHandlers) {
    process.removeListener("disconnect", handler);
  }
  messageHandlers = [];
  disconnectHandlers = [];
}

/** Simulate an incoming message from the host */
function simulateMessage(msg: unknown) {
  for (const handler of messageHandlers) {
    handler(msg);
  }
}

/** Simulate a disconnect event */
function simulateDisconnect() {
  for (const handler of disconnectHandlers) {
    handler();
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("IpcWorker", () => {
  // We need to dynamically import IpcWorker after mocks are set up
  let IpcWorker: typeof import("./ipc-worker.js").IpcWorker;

  beforeEach(async () => {
    setupProcessMocks();
    // Dynamic import to get fresh module (the mock setup needs to be in place)
    const mod = await import("./ipc-worker.js");
    IpcWorker = mod.IpcWorker;
  });

  afterEach(() => {
    teardownProcessMocks();
  });

  // ── Constructor & initial state ──────────────────────────────────────

  describe("constructor and initial state", () => {
    it("throws when process.send is undefined", async () => {
      teardownProcessMocks(); // Remove mock
      // Ensure process.send is undefined
      delete (process as any).send;

      expect(() => new IpcWorker()).toThrow(
        "IpcWorker can only be instantiated in a forked child process"
      );

      // Re-set up for afterEach
      setupProcessMocks();
      const mod = await import("./ipc-worker.js");
      IpcWorker = mod.IpcWorker;
    });

    it("registers listeners on process for message and disconnect events", () => {
      const worker = new IpcWorker();
      expect(messageHandlers.length).toBeGreaterThanOrEqual(1);
      expect(disconnectHandlers.length).toBeGreaterThanOrEqual(1);
      worker.removeAllListeners();
    });

    it("getHandlerCount() returns 0 initially", () => {
      const worker = new IpcWorker();
      expect(worker.getHandlerCount()).toBe(0);
      worker.removeAllListeners();
    });

    it("isShuttingDown() returns false initially", () => {
      const worker = new IpcWorker();
      expect(worker.isShuttingDown()).toBe(false);
      worker.removeAllListeners();
    });
  });

  /**
   * Helper: creates a worker and returns it along with its dedicated message handler.
   * Also clears the process.send mock so each test starts fresh.
   */
  function createWorker() {
    const msgCountBefore = messageHandlers.length;
    const discCountBefore = disconnectHandlers.length;
    const worker = new IpcWorker();
    const sendFn = process.send as ReturnType<typeof vi.fn>;
    sendFn.mockClear();

    // The worker's handlers are the ones added after the counts
    const workerMsgHandler = messageHandlers[messageHandlers.length - 1];
    const workerDiscHandler = disconnectHandlers[disconnectHandlers.length - 1];

    /** Send a message to this worker's handler */
    const sendMessage = (msg: unknown) => workerMsgHandler(msg);

    /** Simulate disconnect for this specific worker */
    const triggerDisconnect = () => workerDiscHandler?.();

    /** Get all messages sent to parent via process.send since last clear */
    const getSentMessages = () => sendFn.mock.calls.map((call: any[]) => call[0]);

    /** Find the first sent message matching a type */
    const findSent = (type: string) =>
      sendFn.mock.calls.find((call: any[]) => call[0]?.type === type)?.[0];

    return { worker, sendMessage, triggerDisconnect, sendFn, getSentMessages, findSent };
  }

  // ── PING auto-response ──────────────────────────────────────────────

  describe("PING handling", () => {
    it("incoming PING message automatically responds with PONG containing a timestamp", async () => {
      const { worker, sendMessage, findSent } = createWorker();

      sendMessage({ type: PING, id: "ping-1", payload: {} });

      // handleMessage is async, give it a tick
      await vi.waitFor(() => {
        expect(findSent(PONG)).toBeDefined();
      });

      const response = findSent(PONG);
      expect(response.type).toBe(PONG);
      expect(response.id).toBe("ping-1");
      expect(typeof response.payload.timestamp).toBe("string");
      worker.removeAllListeners();
    });
  });

  // ── Command handling ────────────────────────────────────────────────

  describe("command handling", () => {
    it("onCommand() registers a handler: getHandlerCount() increments", () => {
      const { worker } = createWorker();
      expect(worker.getHandlerCount()).toBe(0);

      worker.onCommand("START_RUNTIME", async () => ({ success: true }));
      expect(worker.getHandlerCount()).toBe(1);

      worker.onCommand("STOP_RUNTIME", async () => {});
      expect(worker.getHandlerCount()).toBe(2);
      worker.removeAllListeners();
    });

    it("offCommand() removes a handler: getHandlerCount() decrements", () => {
      const { worker } = createWorker();
      worker.onCommand("START_RUNTIME", async () => {});
      expect(worker.getHandlerCount()).toBe(1);

      worker.offCommand("START_RUNTIME");
      expect(worker.getHandlerCount()).toBe(0);
      worker.removeAllListeners();
    });

    it("receiving a registered command invokes the handler with the message payload", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      const { worker, sendMessage } = createWorker();
      worker.onCommand("GET_STATUS", handler);

      const payload = { detail: "test" };
      sendMessage({ type: "GET_STATUS", id: "cmd-1", payload });

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith(payload);
      });
      worker.removeAllListeners();
    });

    it("handler returning a value sends OK response with { data: returnValue }", async () => {
      const { worker, sendMessage, findSent } = createWorker();
      worker.onCommand("GET_METRICS", async () => ({ tasks: 10 }));

      sendMessage({ type: "GET_METRICS", id: "cmd-2", payload: {} });

      await vi.waitFor(() => {
        expect(findSent(OK)).toBeDefined();
      });

      const response = findSent(OK);
      expect(response.type).toBe(OK);
      expect(response.id).toBe("cmd-2");
      expect(response.payload).toEqual({ data: { tasks: 10 } });
      worker.removeAllListeners();
    });

    it("handler throwing an error sends ERROR response with { message, code: 'HANDLER_ERROR' }", async () => {
      const { worker, sendMessage, findSent } = createWorker();
      worker.onCommand("GET_STATUS", async () => {
        throw new Error("Something broke");
      });

      sendMessage({ type: "GET_STATUS", id: "cmd-3", payload: {} });

      await vi.waitFor(() => {
        expect(findSent(ERROR)).toBeDefined();
      });

      const response = findSent(ERROR);
      expect(response.type).toBe(ERROR);
      expect(response.id).toBe("cmd-3");
      expect(response.payload.message).toBe("Something broke");
      expect(response.payload.code).toBe("HANDLER_ERROR");
      worker.removeAllListeners();
    });

    it("handler throwing a non-Error value still sends ERROR response with stringified message", async () => {
      const { worker, sendMessage, findSent } = createWorker();
      worker.onCommand("GET_STATUS", async () => {
        throw "string error";  
      });

      sendMessage({ type: "GET_STATUS", id: "cmd-4", payload: {} });

      await vi.waitFor(() => {
        expect(findSent(ERROR)).toBeDefined();
      });

      const response = findSent(ERROR);
      expect(response.type).toBe(ERROR);
      expect(response.id).toBe("cmd-4");
      expect(response.payload.message).toBe("string error");
      worker.removeAllListeners();
    });

    it("receiving a command with no registered handler sends ERROR with code: 'NO_HANDLER'", async () => {
      const { worker, sendMessage, findSent } = createWorker();
      // Don't register any handler for START_RUNTIME
      sendMessage({ type: "START_RUNTIME", id: "cmd-5", payload: {} });

      await vi.waitFor(() => {
        expect(findSent(ERROR)).toBeDefined();
      });

      const response = findSent(ERROR);
      expect(response.payload.code).toBe("NO_HANDLER");
      expect(response.id).toBe("cmd-5");
      worker.removeAllListeners();
    });

    it("receiving a non-command (unknown type) sends ERROR with code: 'UNKNOWN_COMMAND'", async () => {
      const { worker, sendMessage, findSent } = createWorker();
      sendMessage({ type: "TOTALLY_UNKNOWN", id: "cmd-6", payload: {} });

      await vi.waitFor(() => {
        expect(findSent(ERROR)).toBeDefined();
      });

      const response = findSent(ERROR);
      expect(response.payload.code).toBe("UNKNOWN_COMMAND");
      expect(response.id).toBe("cmd-6");
      worker.removeAllListeners();
    });

    it("receiving a malformed message (not a valid IpcMessage) sends ERROR with code: 'MALFORMED_MESSAGE'", async () => {
      const { worker, sendMessage, findSent } = createWorker();
      sendMessage({ noType: true }); // Missing type, id, payload

      await vi.waitFor(() => {
        expect(findSent(ERROR)).toBeDefined();
      });

      const response = findSent(ERROR);
      expect(response.payload.code).toBe("MALFORMED_MESSAGE");
      worker.removeAllListeners();
    });
  });

  // ── sendEvent / sendErrorEvent ──────────────────────────────────────

  describe("sendEvent and sendErrorEvent", () => {
    it("sendEvent() sends an IpcMessage with the given event type, a generated correlation ID, and payload", () => {
      const { worker, sendFn } = createWorker();

      worker.sendEvent(TASK_CREATED, { task: { id: "KB-001" } });

      expect(sendFn).toHaveBeenCalledTimes(1);
      const msg = sendFn.mock.calls[0][0];
      expect(msg.type).toBe(TASK_CREATED);
      expect(typeof msg.id).toBe("string");
      expect(msg.id.length).toBeGreaterThan(0);
      expect(msg.payload).toEqual({ task: { id: "KB-001" } });
      worker.removeAllListeners();
    });

    it("sendErrorEvent() sends an ERROR_EVENT typed message with error message and code", () => {
      const { worker, sendFn } = createWorker();

      const err = new Error("Runtime crashed");
      (err as any).code = "RUNTIME_ERROR";
      worker.sendErrorEvent(err);

      expect(sendFn).toHaveBeenCalledTimes(1);
      const msg = sendFn.mock.calls[0][0];
      expect(msg.type).toBe(ERROR_EVENT);
      expect(msg.payload).toEqual({
        message: "Runtime crashed",
        code: "RUNTIME_ERROR",
      });
      worker.removeAllListeners();
    });
  });

  // ── Shutdown ────────────────────────────────────────────────────────

  describe("shutdown", () => {
    it("sets isShuttingDown() to true", () => {
      const { worker } = createWorker();
      expect(worker.isShuttingDown()).toBe(false);
      worker.shutdown();
      expect(worker.isShuttingDown()).toBe(true);
      worker.removeAllListeners();
    });

    it("sends a SHUTDOWN message to parent via process.send", () => {
      const { worker, sendFn } = createWorker();
      worker.shutdown();

      expect(sendFn).toHaveBeenCalledTimes(1);
      const msg = sendFn.mock.calls[0][0];
      expect(msg.type).toBe("SHUTDOWN");
      expect(typeof msg.id).toBe("string");
      expect(msg.payload).toEqual({});
      worker.removeAllListeners();
    });

    it("logs warning when process.send throws during shutdown", () => {
      const { worker, sendFn } = createWorker();
      vi.mocked(ipcLog.warn).mockClear();

      sendFn.mockImplementation(() => {
        throw new Error("channel closed");
      });

      worker.shutdown();

      expect(vi.mocked(ipcLog.warn)).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send SHUTDOWN message to parent: channel closed"),
      );
      expect(worker.isShuttingDown()).toBe(true);
      worker.removeAllListeners();
    });

    it('emits "shutdown" event on the IpcWorker instance', () => {
      const { worker } = createWorker();
      const handler = vi.fn();
      worker.on("shutdown", handler);
      worker.shutdown();
      expect(handler).toHaveBeenCalledTimes(1);
      worker.removeAllListeners();
    });

    it("is idempotent (calling twice only sends one SHUTDOWN message)", () => {
      const { worker, sendFn } = createWorker();
      worker.shutdown();
      worker.shutdown();

      // Only one SHUTDOWN message should be sent
      expect(sendFn).toHaveBeenCalledTimes(1);
      worker.removeAllListeners();
    });

    it("after shutdown(), sendEvent() and sendResponse() are no-ops", () => {
      const { worker, sendFn } = createWorker();
      worker.shutdown();
      sendFn.mockClear();

      worker.sendEvent(TASK_CREATED, { task: {} });
      worker.sendResponse(OK, "some-id", { data: null });

      expect(sendFn).not.toHaveBeenCalled();
      worker.removeAllListeners();
    });
  });

  // ── Disconnect ──────────────────────────────────────────────────────

  describe("disconnect", () => {
    it('process disconnect event emits "disconnect" on IpcWorker', () => {
      const { worker, triggerDisconnect } = createWorker();
      const handler = vi.fn();
      worker.on("disconnect", handler);

      triggerDisconnect();

      expect(handler).toHaveBeenCalledTimes(1);
      worker.removeAllListeners();
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("sendEvent() when process.send is undefined does not throw (graceful fallback)", () => {
      const { worker } = createWorker();

      // Remove process.send after construction
      const savedSend = process.send;
      delete (process as any).send;

      expect(() => {
        worker.sendEvent(TASK_CREATED, { task: {} });
      }).not.toThrow();

      // Restore
      process.send = savedSend;
      worker.removeAllListeners();
    });

    it("sendResponse() sends correctly structured IpcMessage with type, id, and payload", () => {
      const { worker, sendFn } = createWorker();

      worker.sendResponse(OK, "resp-id-1", { data: { status: "active" } });

      expect(sendFn).toHaveBeenCalledTimes(1);
      const msg = sendFn.mock.calls[0][0];
      expect(msg).toEqual({
        type: OK,
        id: "resp-id-1",
        payload: { data: { status: "active" } },
      });
      worker.removeAllListeners();
    });
  });
});
