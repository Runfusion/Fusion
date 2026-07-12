import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DashboardLogSink, formatConsoleArgs } from "../log-sink.js";
import { DashboardTUI } from "../controller.js";
import type { LogRingBuffer } from "../log-ring-buffer.js";
import { createLogger } from "@fusion/engine";

// ── DashboardLogSink Tests ─────────────────────────────────────────────────

describe("DashboardLogSink", () => {
  it("logs to console in non-TTY mode", () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sink = new DashboardLogSink();

    sink.log("test message");

    expect(consoleLogSpy).toHaveBeenCalledWith("test message");
    consoleLogSpy.mockRestore();
  });

  it("includes prefix in non-TTY mode", () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sink = new DashboardLogSink();

    sink.log("test message", "dashboard");

    expect(consoleLogSpy).toHaveBeenCalledWith("[dashboard] test message");
    consoleLogSpy.mockRestore();
  });

  it("warns to console.warn in non-TTY mode", () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink = new DashboardLogSink();

    sink.warn("warning message");

    expect(consoleWarnSpy).toHaveBeenCalledWith("warning message");
    consoleWarnSpy.mockRestore();
  });

  it("errors to console.error in non-TTY mode", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = new DashboardLogSink();

    sink.error("error message");

    expect(consoleErrorSpy).toHaveBeenCalledWith("error message");
    consoleErrorSpy.mockRestore();
  });

  it("handles empty message", () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sink = new DashboardLogSink();

    sink.log("");

    expect(consoleLogSpy).toHaveBeenCalledWith("");
    consoleLogSpy.mockRestore();
  });
});

// ── DashboardLogSink.captureConsole ─────────────────────────────────────────

describe("DashboardLogSink.captureConsole", () => {
  let originalLog: typeof console.log;
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;

  beforeEach(() => {
    originalLog = console.log;
    originalWarn = console.warn;
    originalError = console.error;
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  it("routes console.log to sink.log, splitting a [prefix] tag", () => {
    const tui = new DashboardTUI();
    const sink = new DashboardLogSink();
    sink.setTUI(tui);
    sink.captureConsole();

    console.log("[executor] task moved to in-progress");

    const entries = (tui as unknown as {
      logBuffer: LogRingBuffer;
    }).logBuffer.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("info");
    expect(entries[0].prefix).toBe("executor");
    expect(entries[0].message).toBe("task moved to in-progress");

    sink.releaseConsole();
  });

  it("routes console.warn to sink.warn and preserves level", () => {
    const tui = new DashboardTUI();
    const sink = new DashboardLogSink();
    sink.setTUI(tui);
    sink.captureConsole();

    console.warn("[merger] retry 2/3");

    const entries = (tui as unknown as {
      logBuffer: LogRingBuffer;
    }).logBuffer.getAll();
    expect(entries[0].level).toBe("warn");
    expect(entries[0].prefix).toBe("merger");

    sink.releaseConsole();
  });

  it("keeps raw console.error lines as error", () => {
    const tui = new DashboardTUI();
    const sink = new DashboardLogSink();
    sink.setTUI(tui);
    sink.captureConsole();

    console.error("[scheduler] could not claim lease");

    const entries = (tui as unknown as {
      logBuffer: LogRingBuffer;
    }).logBuffer.getAll();
    expect(entries[0].level).toBe("error");
    expect(entries[0].prefix).toBe("scheduler");
    expect(entries[0].message).toBe("could not claim lease");

    sink.releaseConsole();
  });

  it("treats structured logger.log routed via console.error as info", () => {
    const tui = new DashboardTUI();
    const sink = new DashboardLogSink();
    sink.setTUI(tui);
    sink.captureConsole();

    const logger = createLogger("executor");
    logger.log("task moved to in-progress");

    const entries = (tui as unknown as {
      logBuffer: LogRingBuffer;
    }).logBuffer.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("info");
    expect(entries[0].prefix).toBe("executor");
    expect(entries[0].message).toBe("task moved to in-progress");

    sink.releaseConsole();
  });

  it("keeps structured logger.error as error", () => {
    const tui = new DashboardTUI();
    const sink = new DashboardLogSink();
    sink.setTUI(tui);
    sink.captureConsole();

    const logger = createLogger("executor");
    logger.error("task failed");

    const entries = (tui as unknown as {
      logBuffer: LogRingBuffer;
    }).logBuffer.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("error");
    expect(entries[0].prefix).toBe("executor");
    expect(entries[0].message).toBe("task failed");

    sink.releaseConsole();
  });

  it("handles untagged messages without a prefix", () => {
    const tui = new DashboardTUI();
    const sink = new DashboardLogSink();
    sink.setTUI(tui);
    sink.captureConsole();

    console.log("a raw line with no bracket tag");

    const entries = (tui as unknown as {
      logBuffer: LogRingBuffer;
    }).logBuffer.getAll();
    expect(entries[0].prefix).toBeUndefined();
    expect(entries[0].message).toBe("a raw line with no bracket tag");

    sink.releaseConsole();
  });

  it("releaseConsole restores the original console functions", () => {
    const sink = new DashboardLogSink();
    sink.captureConsole();
    expect(console.log).not.toBe(originalLog);
    expect(console.warn).not.toBe(originalWarn);
    expect(console.error).not.toBe(originalError);

    sink.releaseConsole();
    expect(console.log).toBe(originalLog);
    expect(console.warn).toBe(originalWarn);
    expect(console.error).toBe(originalError);
  });

  it("captureConsole is idempotent (calling twice does not double-wrap)", () => {
    const sink = new DashboardLogSink();
    sink.captureConsole();
    const firstPatched = console.log;
    sink.captureConsole();
    expect(console.log).toBe(firstPatched);
    sink.releaseConsole();
  });
});

// ── DashboardLogSink.silence ────────────────────────────────────────────────
//
// FNXC:DashboardShutdown — regression guard for "TUI keeps rendering after q".
// On quit, dispose() silences the sink before tui.stop() restores the shell;
// every later teardown log (sink methods AND direct console.*) must be dropped
// so nothing paints over the recovered prompt. Asserted across surfaces: the
// three sink methods, raw console.*, and the structured logger that routes
// through the captured console.

describe("DashboardLogSink.silence", () => {
  let originalLog: typeof console.log;
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;

  beforeEach(() => {
    originalLog = console.log;
    originalWarn = console.warn;
    originalError = console.error;
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  it("drops sink.log/warn/error after silence (non-TTY would otherwise hit console)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = new DashboardLogSink();

    sink.silence();
    sink.log("late teardown line");
    sink.warn("late teardown warn");
    sink.error("late teardown error");

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("repoints captured console.* to no-ops so engine teardown logs never reach the shell", () => {
    const tui = new DashboardTUI();
    const sink = new DashboardLogSink();
    sink.setTUI(tui);
    sink.captureConsole();

    sink.silence();
    // Both a raw console.* call and a structured logger (routed via console).
    console.log("[executor] tearing down");
    console.error("[merger] closing");
    createLogger("scheduler").log("releasing lease");

    const entries = (tui as unknown as { logBuffer: LogRingBuffer }).logBuffer.getAll();
    expect(entries).toHaveLength(0);
  });
});

// ── formatConsoleArgs ─────────────────────────────────────────────────────────

describe("formatConsoleArgs", () => {
  it("joins multiple args with a space", () => {
    const { message, prefix, level } = formatConsoleArgs(["hello", "world"]);
    expect(prefix).toBeUndefined();
    expect(level).toBe("info");
    expect(message).toBe("hello world");
  });

  it("extracts a leading [prefix] tag", () => {
    const { message, prefix, level } = formatConsoleArgs(["[executor] starting task FN-123"], "warn");
    expect(prefix).toBe("executor");
    expect(level).toBe("warn");
    expect(message).toBe("starting task FN-123");
  });

  it("strips the internal severity marker and returns explicit level", () => {
    const { message, prefix, level } = formatConsoleArgs([" fnlvl=error [executor] task failed"], "info");
    expect(prefix).toBe("executor");
    expect(level).toBe("error");
    expect(message).toBe("task failed");
  });

  it("stringifies objects via JSON", () => {
    const { message } = formatConsoleArgs(["result:", { ok: true, count: 3 }]);
    expect(message).toBe('result: {"ok":true,"count":3}');
  });

  it("uses error.stack when given an Error", () => {
    const err = new Error("boom");
    const { message } = formatConsoleArgs([err]);
    expect(message).toContain("boom");
  });

  it("falls back to String() for circular objects", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { message } = formatConsoleArgs([circular]);
    expect(typeof message).toBe("string");
  });
});

/*
FNXC:SystemPanel 2026-07-12-12:10:
The sink's history + listener surface powers the dashboard System panel's
"View logs" tail; every log/warn/error must be recorded (with level and
prefix) in both TTY and headless modes, and unsubscribing must stop delivery.
*/
describe("DashboardLogSink system-log history", () => {
  it("records entries with level and prefix and serves bounded recents", () => {
    const sink = new DashboardLogSink();
    sink.log("hello", "dashboard");
    sink.warn("careful");
    sink.error("boom", "engine");

    const entries = sink.getRecentEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ level: "info", message: "hello", prefix: "dashboard" });
    expect(entries[1]).toMatchObject({ level: "warn", message: "careful" });
    expect(entries[2]).toMatchObject({ level: "error", message: "boom", prefix: "engine" });

    expect(sink.getRecentEntries(1)).toHaveLength(1);
    expect(sink.getRecentEntries(1)[0].message).toBe("boom");
  });

  it("notifies subscribers live and stops after unsubscribe", () => {
    const sink = new DashboardLogSink();
    const seen: string[] = [];
    const unsubscribe = sink.subscribeEntries((entry) => seen.push(entry.message));

    sink.log("first");
    unsubscribe();
    sink.log("second");

    expect(seen).toEqual(["first"]);
  });

  // FNXC:SystemPanel 2026-07-12-14:40: The history is served over /system/logs
  // and fed into diagnostics/bug reports, so secrets must be redacted before an
  // entry enters the ring buffer or reaches a live subscriber.
  it("redacts secrets before storing and before notifying subscribers", () => {
    const sink = new DashboardLogSink();
    const seen: string[] = [];
    sink.subscribeEntries((entry) => seen.push(entry.message));

    sink.log("auth failed Authorization: Bearer sk-abcdef0123456789abcdef");

    const stored = sink.getRecentEntries()[0].message;
    expect(stored).toContain("[REDACTED]");
    expect(stored).not.toContain("sk-abcdef0123456789abcdef");
    expect(seen[0]).toBe(stored);
  });
});
