import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSessionDiagnostics,
  setDiagnosticsSink,
  resetDiagnosticsSink,
  getDiagnosticsSink,
  nonfatal,
  nonfatalAsync,
} from "../ai-session-diagnostics.js";
import type { DiagnosticsSink, LogEntry, DiagnosticsLevel } from "../ai-session-diagnostics.js";

describe("ai-session-diagnostics", () => {
  // Track captured log entries in memory
  let logged: LogEntry[];

  // Helper to create a capture sink
  function createCaptureSink(): DiagnosticsSink {
    return (level: DiagnosticsLevel, scope: string, message: string, context) => {
      logged.push({
        level,
        scope,
        message,
        context,
        timestamp: new Date(),
      });
    };
  }

  beforeEach(() => {
    logged = [];
    setDiagnosticsSink(createCaptureSink());
  });

  afterEach(() => {
    resetDiagnosticsSink();
  });

  describe("createSessionDiagnostics", () => {
    it("creates diagnostics with the correct scope", () => {
      const diagnostics = createSessionDiagnostics("planning");
      expect(diagnostics.scope).toBe("planning");
    });

    it("logs info level with scope prefix", () => {
      const diagnostics = createSessionDiagnostics("planning");
      diagnostics.info("Session created", { sessionId: "abc-123" });

      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        level: "info",
        scope: "planning",
        message: "Session created",
      });
    });

    it("logs warn level with scope prefix", () => {
      const diagnostics = createSessionDiagnostics("planning");
      diagnostics.warn("Rate limit approaching", { ip: "1.2.3.4", count: 4 });

      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        level: "warn",
        scope: "planning",
        message: "Rate limit approaching",
      });
    });

    it("logs error level with scope prefix", () => {
      const diagnostics = createSessionDiagnostics("planning");
      diagnostics.error("Agent initialization failed", { sessionId: "abc" });

      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        level: "error",
        scope: "planning",
        message: "Agent initialization failed",
      });
    });

    it("forwards structured context to the sink", () => {
      const diagnostics = createSessionDiagnostics("planning");
      diagnostics.info("Cleanup complete", {
        sessionId: "abc-123",
        ip: "192.168.1.1",
        operation: "dispose",
        customField: "value",
      });

      expect(logged[0].context).toMatchObject({
        sessionId: "abc-123",
        ip: "192.168.1.1",
        operation: "dispose",
        customField: "value",
      });
    });

    it("adds _emittedAt timestamp to context", () => {
      const diagnostics = createSessionDiagnostics("planning");
      diagnostics.info("Test message");

      expect(logged[0].context._emittedAt).toBeDefined();
      expect(typeof logged[0].context._emittedAt).toBe("string");
      // Should be a valid ISO timestamp
      expect(new Date(logged[0].context._emittedAt as string)).not.toBeNaN();
    });

    it("adds _diagnosticsId to context for traceability", () => {
      const diagnostics = createSessionDiagnostics("planning");
      diagnostics.info("Test message");

      expect(logged[0].context._diagnosticsId).toBeDefined();
      expect(typeof logged[0].context._diagnosticsId).toBe("string");
    });

    it("each log entry gets a unique _diagnosticsId", () => {
      const diagnostics = createSessionDiagnostics("planning");
      diagnostics.info("First");
      diagnostics.info("Second");
      diagnostics.info("Third");

      const ids = logged.map((entry) => entry.context._diagnosticsId);
      expect(new Set(ids).size).toBe(3);
    });

    it("allows different scopes to be used independently", () => {
      const planningDiag = createSessionDiagnostics("planning");
      const missionDiag = createSessionDiagnostics("mission-interview");

      planningDiag.info("Planning message");
      missionDiag.info("Mission message");

      expect(logged).toHaveLength(2);
      expect(logged[0].scope).toBe("planning");
      expect(logged[1].scope).toBe("mission-interview");
    });

    it("handles empty context gracefully", () => {
      const diagnostics = createSessionDiagnostics("planning");
      diagnostics.info("Test message");

      expect(logged[0].context).toBeDefined();
      expect(logged[0].context.sessionId).toBeUndefined();
    });

    it("handles undefined context argument", () => {
      const diagnostics = createSessionDiagnostics("planning");
      // @ts-expect-error - intentionally passing undefined to test behavior
      diagnostics.info("Test message", undefined);

      expect(logged[0].context).toBeDefined();
    });

    it("handles null context fields gracefully", () => {
      const diagnostics = createSessionDiagnostics("planning");
      diagnostics.info("Test message", {
        sessionId: null,
        ip: null,
        customField: null,
      });

      expect(logged[0].context.sessionId).toBeNull();
      expect(logged[0].context.ip).toBeNull();
    });

    it("does not throw when sink throws", () => {
      setDiagnosticsSink(() => {
        throw new Error("Sink error");
      });
      const diagnostics = createSessionDiagnostics("planning");

      expect(() => {
        diagnostics.info("Test");
        diagnostics.warn("Test");
        diagnostics.error("Test");
      }).not.toThrow();
    });
  });

  describe("errorFromException", () => {
    it("serializes Error objects correctly", () => {
      const diagnostics = createSessionDiagnostics("planning");
      const error = new Error("Something went wrong");

      diagnostics.errorFromException("Operation failed", error);

      expect(logged[0].context.error).toMatchObject({
        message: "Something went wrong",
        stack: expect.stringContaining("Error: Something went wrong"),
      });
    });

    it("serializes string errors", () => {
      const diagnostics = createSessionDiagnostics("planning");

      diagnostics.errorFromException("Operation failed", "Simple error string");

      expect(logged[0].context.error).toBe("Simple error string");
    });

    it("serializes objects without message property", () => {
      const diagnostics = createSessionDiagnostics("planning");
      const error = { code: "ERR_FAILED", details: { foo: "bar" } };

      diagnostics.errorFromException("Operation failed", error);

      expect(logged[0].context.error).toMatchObject({
        message: expect.any(String),
        stack: undefined,
      });
    });

    it("merges additional context with error context", () => {
      const diagnostics = createSessionDiagnostics("planning");
      const error = new Error("Cleanup failed");

      diagnostics.errorFromException(
        "Error disposing agent",
        error,
        { sessionId: "abc", operation: "dispose" }
      );

      expect(logged[0].context).toMatchObject({
        error: expect.objectContaining({ message: "Cleanup failed" }),
        sessionId: "abc",
        operation: "dispose",
      });
    });

    it("captures stack trace for Error objects", () => {
      const diagnostics = createSessionDiagnostics("planning");
      const error = new Error("Test error");
      const originalStack = error.stack;

      diagnostics.errorFromException("Test", error);

      expect(logged[0].context.error).toHaveProperty("stack");
      expect((logged[0].context.error as { stack?: string }).stack).toBe(originalStack);
    });

    it("handles primitive values as errors", () => {
      const diagnostics = createSessionDiagnostics("planning");

      // Primitives are serialized to strings via serializeError
      diagnostics.errorFromException("Test", 42);
      expect(logged[0].context.error).toBe("42");

      diagnostics.errorFromException("Test", true);
      expect(logged[1].context.error).toBe("true");
    });
  });

  describe("setDiagnosticsSink / resetDiagnosticsSink", () => {
    it("captures logs through injected sink", () => {
      const captured: LogEntry[] = [];
      setDiagnosticsSink((level, scope, message, context) => {
        captured.push({ level, scope, message, context, timestamp: new Date() });
      });

      const diagnostics = createSessionDiagnostics("test");
      diagnostics.info("Hello");

      expect(captured).toHaveLength(1);
      expect(captured[0].message).toBe("Hello");
    });

    it("resetDiagnosticsSink restores default console behavior", () => {
      const captured: LogEntry[] = [];
      setDiagnosticsSink((level, scope, message, context) => {
        captured.push({ level, scope, message, context, timestamp: new Date() });
      });

      const diagnostics = createSessionDiagnostics("test");
      diagnostics.info("Captured");

      resetDiagnosticsSink();

      // After reset, logs should go to console (captured should not grow)
      diagnostics.info("Should go to console");
      expect(captured).toHaveLength(1); // Only the first log
    });

    it("resetting to null sets the default sink", () => {
      // Set a custom sink first
      const captured: LogEntry[] = [];
      setDiagnosticsSink((level, scope, message, context) => {
        captured.push({ level, scope, message, context, timestamp: new Date() });
      });

      // Reset to null - should restore default console behavior
      setDiagnosticsSink(null);

      /* After reset to null, logs go to the console again — on `console.error`, because the default sink now
         emits through core's `createLogger` and everything but `warn` is stderr (see the note below on the
         severity marker). Spying on `console.log` asserted the pre-logger channel. */
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const diagnostics = createSessionDiagnostics("test");
      diagnostics.info("Test after reset");

      // The captured array should be unchanged (default sink is used)
      expect(captured).toHaveLength(0);
      // Console should have been called with the default sink
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it("resetting to undefined sets the default sink", () => {
      setDiagnosticsSink(undefined);

      const diagnostics = createSessionDiagnostics("test");
      expect(() => diagnostics.info("Test")).not.toThrow();
    });

    it("getDiagnosticsSink returns current sink", () => {
      const customSink = vi.fn();
      setDiagnosticsSink(customSink);

      expect(getDiagnosticsSink()).toBe(customSink);
    });
  });

  describe("nonfatal", () => {
    it("returns operation result on success", () => {
      const diagnostics = createSessionDiagnostics("planning");
      const result = nonfatal(
        () => ({ value: 42 }),
        diagnostics,
        "Should not log",
        {}
      );

      expect(result).toEqual({ value: 42 });
    });

    it("returns undefined and logs error on failure", () => {
      const diagnostics = createSessionDiagnostics("planning");
      const error = new Error("Cleanup failed");

      const result = nonfatal(
        () => { throw error; },
        diagnostics,
        "Cleanup failed",
        { sessionId: "abc" }
      );

      expect(result).toBeUndefined();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        level: "error",
        scope: "planning",
        message: "Cleanup failed",
        context: expect.objectContaining({
          sessionId: "abc",
          error: expect.objectContaining({ message: "Cleanup failed" }),
        }),
      });
    });

    it("does not throw when operation throws", () => {
      const diagnostics = createSessionDiagnostics("planning");

      expect(() => {
        nonfatal(
          () => { throw new Error("Test error"); },
          diagnostics,
          "Test",
          {}
        );
      }).not.toThrow();
    });

    it("logs error with serialized exception context", () => {
      const diagnostics = createSessionDiagnostics("planning");
      const error = new Error("Broadcast failed");

      nonfatal(
        () => { throw error; },
        diagnostics,
        "Error broadcasting",
        { operation: "broadcast", sessionId: "xyz" }
      );

      expect(logged[0].context.error).toMatchObject({
        message: "Broadcast failed",
      });
      expect(logged[0].context.operation).toBe("broadcast");
      expect(logged[0].context.sessionId).toBe("xyz");
    });

    it("returns undefined for sync void functions", () => {
      const diagnostics = createSessionDiagnostics("planning");

      const result = nonfatal(
        () => {
          // void function
        },
        diagnostics,
        "Should not log",
        {}
      );

      expect(result).toBeUndefined();
      expect(logged).toHaveLength(0);
    });

    it("does not log for successful operations", () => {
      const diagnostics = createSessionDiagnostics("planning");

      nonfatal(() => 42, diagnostics, "Should not appear", {});

      expect(logged).toHaveLength(0);
    });

    it("handles non-Error throws", () => {
      const diagnostics = createSessionDiagnostics("planning");

      const result = nonfatal(
        () => { throw "string error"; },
        diagnostics,
        "String thrown",
        {}
      );

      expect(result).toBeUndefined();
      expect(logged[0].context.error).toBe("string error");
    });

    it("handles object throws", () => {
      const diagnostics = createSessionDiagnostics("planning");
      const errorObj = { code: "ERR_CODE", info: "details" };

      const result = nonfatal(
        () => { throw errorObj; },
        diagnostics,
        "Object thrown",
        {}
      );

      expect(result).toBeUndefined();
      // Objects without message property get serialized with key-value summary
      expect(logged[0].context.error).toMatchObject({
        message: expect.stringContaining("code: \"ERR_CODE\""),
      });
    });
  });

  describe("nonfatalAsync", () => {
    it("returns operation result on success", async () => {
      const diagnostics = createSessionDiagnostics("planning");
      const result = await nonfatalAsync(
        async () => ({ value: 42 }),
        diagnostics,
        "Should not log",
        {}
      );

      expect(result).toEqual({ value: 42 });
    });

    it("returns undefined and logs error on rejection", async () => {
      const diagnostics = createSessionDiagnostics("planning");
      const error = new Error("Async failed");

      const result = await nonfatalAsync(
        async () => { throw error; },
        diagnostics,
        "Async operation failed",
        { operation: "fetch" }
      );

      expect(result).toBeUndefined();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        level: "error",
        scope: "planning",
        message: "Async operation failed",
        context: expect.objectContaining({
          operation: "fetch",
          error: expect.objectContaining({ message: "Async failed" }),
        }),
      });
    });

    it("does not throw when operation rejects", async () => {
      const diagnostics = createSessionDiagnostics("planning");

      await expect(
        nonfatalAsync(
          async () => { throw new Error("Test error"); },
          diagnostics,
          "Test",
          {}
        )
      ).resolves.toBeUndefined(); // Should not throw, returns undefined
    });

    it("does not log for successful operations", async () => {
      const diagnostics = createSessionDiagnostics("planning");

      await nonfatalAsync(async () => 42, diagnostics, "Should not appear", {});

      expect(logged).toHaveLength(0);
    });

    it("handles rejected promises with non-Error values", async () => {
      const diagnostics = createSessionDiagnostics("planning");

      const result = await nonfatalAsync(
        async () => { throw "rejected string"; },
        diagnostics,
        "Promise rejected",
        {}
      );

      expect(result).toBeUndefined();
      expect(logged[0].context.error).toBe("rejected string");
    });
  });

  describe("default sink behavior", () => {
    it("logs info to console.log with prefix", () => {
    /*
    FNXC:DashboardTestMocks 2026-08-03-04:40 (red on main — the sink moved to createLogger, the test did not):
    `defaultSink` now emits through core's `createLogger(scope)` rather than calling `console.log/warn/error`
    directly, and that logger has TWO deliberate differences these cases predate:

      1. it prefixes a SEVERITY MARKER (`\u0000fnlvl=<level>\u0000`) so the TUI and the log panes can classify a
         line without parsing it;
      2. `log()` goes to `console.error`, not `console.log` — everything but `warn` is stderr, which is what keeps
         stdio-transport surfaces (MCP) from having their protocol stream polluted by diagnostics.

    So asserting `console.log` with a bare `"[planning]"` prefix describes a shape that no longer ships. Asserting
    the CHANNEL and the marker-prefixed message keeps these cases pinned to the contract that matters — a
    classifiable line on the right stream — instead of to the pre-logger call site.
    */
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      resetDiagnosticsSink(); // Ensure default sink is active

      const diagnostics = createSessionDiagnostics("planning");
      diagnostics.info("Test message");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[planning] Test message"),
        expect.objectContaining({ _emittedAt: expect.any(String) })
      );
      expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("fnlvl=info");

      consoleErrorSpy.mockRestore();
    });

    it("logs warn to console.warn with a severity-marked prefix", () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      resetDiagnosticsSink();

      const diagnostics = createSessionDiagnostics("planning");
      diagnostics.warn("Warning message");

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[planning] Warning message"),
        expect.objectContaining({ _emittedAt: expect.any(String) })
      );
      expect(consoleWarnSpy.mock.calls[0]?.[0]).toContain("fnlvl=warn");

      consoleWarnSpy.mockRestore();
    });

    it("logs error to console.error with a severity-marked prefix", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      resetDiagnosticsSink();

      const diagnostics = createSessionDiagnostics("planning");
      diagnostics.error("Error message");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[planning] Error message"),
        expect.objectContaining({ _emittedAt: expect.any(String) })
      );
      expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("fnlvl=error");

      consoleErrorSpy.mockRestore();
    });

    it("default sink does not throw even if console methods throw", () => {
      vi.spyOn(console, "log").mockImplementation(() => {
        throw new Error("Console mocked error");
      });
      resetDiagnosticsSink();

      const diagnostics = createSessionDiagnostics("planning");
      expect(() => diagnostics.info("Test")).not.toThrow();

      vi.mocked(console.log).mockRestore();
    });
  });

  describe("integration patterns", () => {
    it("captures cleanup pattern correctly", () => {
      const diagnostics = createSessionDiagnostics("planning");
      const session = { id: "session-123", agent: { dispose: () => {} } };

      nonfatal(
        () => session.agent.dispose(),
        diagnostics,
        "Error disposing agent",
        { sessionId: session.id }
      );

      expect(logged).toHaveLength(0); // Success path
    });

    it("captures cleanup failure correctly", () => {
      const diagnostics = createSessionDiagnostics("planning");
      const session = { id: "session-123", agent: { dispose: () => { throw new Error("Already disposed"); } } };

      nonfatal(
        () => session.agent.dispose(),
        diagnostics,
        "Error disposing agent",
        { sessionId: session.id }
      );

      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        level: "error",
        message: "Error disposing agent",
        context: expect.objectContaining({
          sessionId: "session-123",
          error: expect.objectContaining({ message: "Already disposed" }),
        }),
      });
    });

    it("captures rehydration pattern correctly", async () => {
      const diagnostics = createSessionDiagnostics("planning");

      const result = await nonfatalAsync(
        async () => {
          // Simulate async rehydration
          return { rehydrated: 5 };
        },
        diagnostics,
        "Rehydration failed",
        { operation: "rehydrate" }
      );

      expect(result).toEqual({ rehydrated: 5 });
      expect(logged).toHaveLength(0);
    });

    it("captures rehydration failure correctly", async () => {
      const diagnostics = createSessionDiagnostics("planning");

      const result = await nonfatalAsync(
        async () => {
          throw new Error("Database unavailable");
        },
        diagnostics,
        "Rehydration failed",
        { operation: "rehydrate", sessionId: "xyz" }
      );

      expect(result).toBeUndefined();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        level: "error",
        message: "Rehydration failed",
        context: expect.objectContaining({
          operation: "rehydrate",
          sessionId: "xyz",
        }),
      });
    });

    it("handles multiple scopes in same test", () => {
      const planning = createSessionDiagnostics("planning");
      const mission = createSessionDiagnostics("mission-interview");
      const subtask = createSessionDiagnostics("subtask-breakdown");

      planning.info("Planning event", { sessionId: "p1" });
      mission.info("Mission event", { sessionId: "m1" });
      subtask.info("Subtask event", { sessionId: "s1" });

      expect(logged).toHaveLength(3);
      expect(logged[0].scope).toBe("planning");
      expect(logged[1].scope).toBe("mission-interview");
      expect(logged[2].scope).toBe("subtask-breakdown");
    });

    it("isolates diagnostics between test hooks", () => {
      // Create first capture array and sink
      const firstLogged: LogEntry[] = [];
      function firstSink(level: any, scope: any, message: any, context: any) {
        firstLogged.push({ level, scope, message, context, timestamp: new Date() });
      }

      setDiagnosticsSink(firstSink);

      const diag1 = createSessionDiagnostics("scope1");
      diag1.info("First scope");

      expect(firstLogged).toHaveLength(1);
      expect(firstLogged[0].scope).toBe("scope1");

      // Reset and create new sink
      resetDiagnosticsSink();
      const secondLogged: LogEntry[] = [];
      function secondSink(level: any, scope: any, message: any, context: any) {
        secondLogged.push({ level, scope, message, context, timestamp: new Date() });
      }
      setDiagnosticsSink(secondSink);

      const diag2 = createSessionDiagnostics("scope2");
      diag2.info("Second scope");

      // firstLogged should not capture second scope events
      expect(firstLogged).toHaveLength(1); // Only first scope
      expect(secondLogged).toHaveLength(1); // Only second scope
      expect(secondLogged[0].scope).toBe("scope2");
    });
  });

  describe("type safety", () => {
    it("accepts partial context without required fields", () => {
      const diagnostics = createSessionDiagnostics("planning");

      // Only provide optional fields
      diagnostics.info("Test", { customField: "value" });
      diagnostics.warn("Test", { ip: "1.2.3.4" });
      diagnostics.error("Test", { sessionId: "abc" });

      expect(logged).toHaveLength(3);
    });

    it("does not require context argument", () => {
      const diagnostics = createSessionDiagnostics("planning");

      // No context provided
      diagnostics.info("Simple message");
      diagnostics.warn("Warning message");
      diagnostics.error("Error message");

      expect(logged).toHaveLength(3);
      expect(logged[0].message).toBe("Simple message");
      expect(logged[1].message).toBe("Warning message");
      expect(logged[2].message).toBe("Error message");
    });
  });
});
