import { describe, it, expect } from "vitest";
import {
  START_RUNTIME,
  STOP_RUNTIME,
  GET_STATUS,
  GET_METRICS,
  GET_TASK_STORE,
  GET_SCHEDULER,
  PING,
  OK,
  ERROR,
  PONG,
  TASK_CREATED,
  TASK_MOVED,
  TASK_UPDATED,
  ERROR_EVENT,
  HEALTH_CHANGED,
  isIpcCommand,
  isIpcResponse,
  isIpcEvent,
  createCommand,
  createResponse,
  createEvent,
  generateCorrelationId,
} from "./ipc-protocol.js";

describe("IPC Protocol", () => {
  describe("constants", () => {
    it("should export all command types", () => {
      expect(START_RUNTIME).toBe("START_RUNTIME");
      expect(STOP_RUNTIME).toBe("STOP_RUNTIME");
      expect(GET_STATUS).toBe("GET_STATUS");
      expect(GET_METRICS).toBe("GET_METRICS");
      expect(GET_TASK_STORE).toBe("GET_TASK_STORE");
      expect(GET_SCHEDULER).toBe("GET_SCHEDULER");
      expect(PING).toBe("PING");
    });

    it("should export all response types", () => {
      expect(OK).toBe("OK");
      expect(ERROR).toBe("ERROR");
      expect(PONG).toBe("PONG");
    });

    it("should export all event types", () => {
      expect(TASK_CREATED).toBe("TASK_CREATED");
      expect(TASK_MOVED).toBe("TASK_MOVED");
      expect(TASK_UPDATED).toBe("TASK_UPDATED");
      expect(ERROR_EVENT).toBe("ERROR_EVENT");
      expect(HEALTH_CHANGED).toBe("HEALTH_CHANGED");
    });

    it("should have distinct ERROR and ERROR_EVENT values", () => {
      expect(ERROR).toBe("ERROR");
      expect(ERROR_EVENT).toBe("ERROR_EVENT");
      expect(ERROR).not.toBe(ERROR_EVENT);
    });
  });

  describe("isIpcCommand", () => {
    it("should return true for command types", () => {
      expect(isIpcCommand({ type: START_RUNTIME, id: "1", payload: {} })).toBe(true);
      expect(isIpcCommand({ type: STOP_RUNTIME, id: "1", payload: {} })).toBe(true);
      expect(isIpcCommand({ type: GET_STATUS, id: "1", payload: {} })).toBe(true);
      expect(isIpcCommand({ type: PING, id: "1", payload: {} })).toBe(true);
    });

    it("should return false for response types", () => {
      expect(isIpcCommand({ type: OK, id: "1", payload: {} })).toBe(false);
      expect(isIpcCommand({ type: ERROR, id: "1", payload: {} })).toBe(false);
      expect(isIpcCommand({ type: PONG, id: "1", payload: {} })).toBe(false);
    });

    it("should return false for event types", () => {
      expect(isIpcCommand({ type: TASK_CREATED, id: "1", payload: {} })).toBe(false);
      expect(isIpcCommand({ type: HEALTH_CHANGED, id: "1", payload: {} })).toBe(false);
    });
  });

  describe("isIpcResponse", () => {
    it("should return true for response types", () => {
      expect(isIpcResponse({ type: OK, id: "1", payload: {} })).toBe(true);
      expect(isIpcResponse({ type: ERROR, id: "1", payload: {} })).toBe(true);
      expect(isIpcResponse({ type: PONG, id: "1", payload: {} })).toBe(true);
    });

    it("should return false for command types", () => {
      expect(isIpcResponse({ type: START_RUNTIME, id: "1", payload: {} })).toBe(false);
      expect(isIpcResponse({ type: PING, id: "1", payload: {} })).toBe(false);
    });

    it("should return false for event types", () => {
      expect(isIpcResponse({ type: TASK_CREATED, id: "1", payload: {} })).toBe(false);
    });
  });

  describe("isIpcEvent", () => {
    it("should return true for event types", () => {
      expect(isIpcEvent({ type: TASK_CREATED, id: "1", payload: {} })).toBe(true);
      expect(isIpcEvent({ type: TASK_MOVED, id: "1", payload: {} })).toBe(true);
      expect(isIpcEvent({ type: TASK_UPDATED, id: "1", payload: {} })).toBe(true);
      expect(isIpcEvent({ type: ERROR_EVENT, id: "1", payload: {} })).toBe(true);
      expect(isIpcEvent({ type: HEALTH_CHANGED, id: "1", payload: {} })).toBe(true);
    });

    it("should return false for command types", () => {
      expect(isIpcEvent({ type: START_RUNTIME, id: "1", payload: {} })).toBe(false);
      expect(isIpcEvent({ type: PING, id: "1", payload: {} })).toBe(false);
    });

    it("should return false for response types", () => {
      expect(isIpcEvent({ type: OK, id: "1", payload: {} })).toBe(false);
      expect(isIpcEvent({ type: ERROR, id: "1", payload: {} })).toBe(false);
    });
  });

  describe("createCommand", () => {
    it("should create a command message", () => {
      const payload = { config: { projectId: "test" } };
      const message = createCommand(START_RUNTIME, "cmd-1", payload);

      expect(message).toEqual({
        type: START_RUNTIME,
        id: "cmd-1",
        payload,
      });
    });
  });

  describe("createResponse", () => {
    it("should create a response message", () => {
      const payload = { data: { status: "active" } };
      const message = createResponse(OK, "cmd-1", payload);

      expect(message).toEqual({
        type: OK,
        id: "cmd-1",
        payload,
      });
    });
  });

  describe("createEvent", () => {
    it("should create an event message", () => {
      const payload = { task: { id: "KB-001" } };
      const message = createEvent(TASK_CREATED, "evt-1", payload);

      expect(message).toEqual({
        type: TASK_CREATED,
        id: "evt-1",
        payload,
      });
    });
  });

  describe("generateCorrelationId", () => {
    it("should generate unique IDs", () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();

      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
    });

    it("should generate string IDs with timestamp and random parts", () => {
      const id = generateCorrelationId();
      const parts = id.split("-");

      expect(parts.length).toBeGreaterThanOrEqual(2);
      // First part should be a timestamp (number)
      expect(Number.parseInt(parts[0], 10)).not.toBeNaN();
    });
  });
});
