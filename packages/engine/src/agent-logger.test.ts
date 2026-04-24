import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentLogger, summarizeToolArgs } from "./agent-logger.js";
import type { TaskStore } from "@fusion/core";

const loggerWarnSpy = vi.hoisted(() => vi.fn());

vi.mock("./logger.js", () => ({
  createLogger: () => ({
    log: vi.fn(),
    warn: loggerWarnSpy,
    error: vi.fn(),
  }),
}));

// ── summarizeToolArgs tests ──────────────────────────────────────────

describe("summarizeToolArgs", () => {
  it("returns bash command", () => {
    expect(summarizeToolArgs("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(summarizeToolArgs("bash", { command: "echo hello" })).toBe("echo hello");
  });

  it("returns long bash commands in full without truncation", () => {
    const longCmd = "a".repeat(200);
    const result = summarizeToolArgs("Bash", { command: longCmd });
    expect(result).toBe(longCmd);
  });

  it("returns long string-valued fallback args without truncation", () => {
    const longVal = "x".repeat(200);
    expect(summarizeToolArgs("unknown_tool", { description: longVal })).toBe(longVal);
  });

  it("returns file path for Read/Edit/Write", () => {
    expect(summarizeToolArgs("Read", { path: "src/types.ts" })).toBe("src/types.ts");
    expect(summarizeToolArgs("edit", { path: "src/store.ts" })).toBe("src/store.ts");
    expect(summarizeToolArgs("Write", { path: "out.txt", content: "data" })).toBe("out.txt");
  });

  it("falls back to first short string arg for unknown tools", () => {
    expect(summarizeToolArgs("fn_task_update", { step: 1, status: "done" })).toBe("done");
  });

  it("returns undefined when no args or empty args", () => {
    expect(summarizeToolArgs("Bash")).toBeUndefined();
    expect(summarizeToolArgs("Bash", {})).toBeUndefined();
  });

  it("returns undefined for non-string values only", () => {
    expect(summarizeToolArgs("unknown", { count: 42, flag: true })).toBeUndefined();
  });
});

// ── AgentLogger tests ────────────────────────────────────────────────

function createMockStore() {
  return {
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

describe("AgentLogger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers text and flushes on size threshold", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-001",
      flushSizeBytes: 10,
      flushIntervalMs: 500,
    });

    // Under threshold — no flush yet
    logger.onText("hello");
    expect(store.appendAgentLog).not.toHaveBeenCalled();

    // Over threshold — triggers flush
    logger.onText("worldextra");
    // Allow async flush
    await vi.advanceTimersByTimeAsync(0);
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-001", "helloworldextra", "text", undefined, undefined);
  });

  it("flushes on timer when under size threshold", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-002",
      flushSizeBytes: 1024,
      flushIntervalMs: 500,
    });

    logger.onText("small");
    expect(store.appendAgentLog).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-002", "small", "text", undefined, undefined);
  });

  it("flushes text before logging tool start", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-003",
      flushSizeBytes: 1024,
    });

    logger.onText("pending text");
    logger.onToolStart("Bash", { command: "ls" });

    await vi.advanceTimersByTimeAsync(0);

    const calls = (store.appendAgentLog as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    // Text flushed first
    expect(calls[0]).toEqual(["FN-003", "pending text", "text", undefined, undefined]);
    // Tool logged second with detail
    expect(calls[1]).toEqual(["FN-003", "Bash", "tool", "ls", undefined]);
  });

  it("logs tool detail using summarizeToolArgs", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({ store, taskId: "FN-004" });

    logger.onToolStart("Read", { path: "src/index.ts" });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-004", "Read", "tool", "src/index.ts", undefined);
  });

  it("logs tool with undefined detail for unknown args", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({ store, taskId: "FN-005" });

    logger.onToolStart("fn_task_done", { count: 42 });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-005", "fn_task_done", "tool", undefined, undefined);
  });

  it("flush() clears timer and writes remaining text", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-006",
      flushSizeBytes: 1024,
      flushIntervalMs: 500,
    });

    logger.onText("remaining");
    await logger.flush();

    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-006", "remaining", "text", undefined, undefined);
  });

  it("flush() is safe to call when buffer is empty", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({ store, taskId: "FN-007" });

    await logger.flush();
    expect(store.appendAgentLog).not.toHaveBeenCalled();
  });

  it("invokes external callbacks alongside logging", async () => {
    const store = createMockStore();
    const onAgentText = vi.fn();
    const onAgentTool = vi.fn();
    const logger = new AgentLogger({
      store,
      taskId: "FN-008",
      onAgentText,
      onAgentTool,
    });

    logger.onText("delta");
    expect(onAgentText).toHaveBeenCalledWith("FN-008", "delta");

    logger.onToolStart("Bash", { command: "echo hi" });
    expect(onAgentTool).toHaveBeenCalledWith("FN-008", "Bash");
  });

  it("does not schedule multiple timers for consecutive small writes", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-009",
      flushSizeBytes: 1024,
      flushIntervalMs: 500,
    });

    logger.onText("a");
    logger.onText("b");
    logger.onText("c");

    await vi.advanceTimersByTimeAsync(500);

    // All text should be flushed in a single call
    expect(store.appendAgentLog).toHaveBeenCalledTimes(1);
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-009", "abc", "text", undefined, undefined);
  });

  // ── Agent field propagation ──────────────────────────────────────

  it("passes agent field through to all appendAgentLog calls", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-010",
      agent: "executor",
      flushSizeBytes: 5,
    });

    // Text flush
    logger.onText("hello world");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-010", "hello world", "text", undefined, "executor");

    // Tool start
    (store.appendAgentLog as ReturnType<typeof vi.fn>).mockClear();
    logger.onToolStart("Bash", { command: "ls" });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-010", "Bash", "tool", "ls", "executor");
  });

  // ── Thinking buffer/flush ────────────────────────────────────────

  it("buffers thinking deltas and flushes on timer", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-011",
      agent: "executor",
      flushSizeBytes: 1024,
      flushIntervalMs: 500,
    });

    logger.onThinking("thought 1 ");
    logger.onThinking("thought 2");
    expect(store.appendAgentLog).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-011", "thought 1 thought 2", "thinking", undefined, "executor");
  });

  it("flushes thinking on size threshold", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-012",
      agent: "triage",
      flushSizeBytes: 10,
    });

    logger.onThinking("short");
    expect(store.appendAgentLog).not.toHaveBeenCalled();

    logger.onThinking("enough to flush");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-012", "shortenough to flush", "thinking", undefined, "triage");
  });

  it("flushes thinking buffer on flush()", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-013",
      agent: "reviewer",
      flushSizeBytes: 1024,
    });

    logger.onThinking("remaining thinking");
    await logger.flush();
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-013", "remaining thinking", "thinking", undefined, "reviewer");
  });

  it("flushes thinking buffer before tool start", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-014",
      agent: "executor",
      flushSizeBytes: 1024,
    });

    logger.onThinking("pre-tool thought");
    logger.onToolStart("Read", { path: "file.ts" });

    await vi.advanceTimersByTimeAsync(0);
    const calls = (store.appendAgentLog as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(["FN-014", "pre-tool thought", "thinking", undefined, "executor"]);
    expect(calls[1]).toEqual(["FN-014", "Read", "tool", "file.ts", "executor"]);
  });

  // ── onToolEnd ────────────────────────────────────────────────────

  it("logs tool_result on successful tool end", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-015",
      agent: "executor",
    });

    logger.onToolEnd("Bash", false, "command output");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-015", "Bash", "tool_result", "command output", "executor");
  });

  it("logs tool_error on failed tool end", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-016",
      agent: "executor",
    });

    logger.onToolEnd("Read", true, "file not found");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-016", "Read", "tool_error", "file not found", "executor");
  });

  it("truncates long tool results to 500 chars", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-017",
      agent: "executor",
    });

    const longResult = "x".repeat(600);
    logger.onToolEnd("Bash", false, longResult);
    await vi.advanceTimersByTimeAsync(0);

    const call = (store.appendAgentLog as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[3]).toBe("x".repeat(500) + "…");
  });

  it("handles undefined result in onToolEnd", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-018",
      agent: "merger",
    });

    logger.onToolEnd("Bash", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-018", "Bash", "tool_result", undefined, "merger");
  });

  describe("persistence failure observability", () => {
    it("onToolStart warns on persistence failure", async () => {
      const store = {
        appendAgentLog: vi.fn().mockRejectedValue(new Error("EACCES: permission denied")),
      } as unknown as TaskStore;
      const logger = new AgentLogger({ store, taskId: "FN-2090-TOOL-START" });

      expect(() => logger.onToolStart("Bash", { command: "ls" })).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to log tool start \"Bash\" for FN-2090-TOOL-START"),
      );
    });

    it("onToolEnd warns on persistence failure", async () => {
      const store = {
        appendAgentLog: vi.fn().mockRejectedValue(new Error("EPERM: operation not permitted")),
      } as unknown as TaskStore;
      const logger = new AgentLogger({ store, taskId: "FN-2090-TOOL-END" });

      expect(() => logger.onToolEnd("Bash", false, "output")).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to log tool end \"Bash\" (tool_result) for FN-2090-TOOL-END"),
      );
    });

    it("flushTextBuffer warns on persistence failure", async () => {
      const store = {
        appendAgentLog: vi.fn().mockRejectedValue(new Error("ENOSPC: no space left on device")),
      } as unknown as TaskStore;
      const logger = new AgentLogger({
        store,
        taskId: "FN-2090-TEXT",
        flushSizeBytes: 1,
      });

      logger.onText("some text");
      await vi.advanceTimersByTimeAsync(0);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to flush text buffer for FN-2090-TEXT"),
      );
    });

    it("flushThinkingBuffer warns on persistence failure", async () => {
      const store = {
        appendAgentLog: vi.fn().mockRejectedValue(new Error("ENOSPC: no space left on device")),
      } as unknown as TaskStore;
      const logger = new AgentLogger({
        store,
        taskId: "FN-2090-THINKING",
        flushSizeBytes: 1,
      });

      logger.onThinking("deep thought");
      await vi.advanceTimersByTimeAsync(0);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to flush thinking buffer for FN-2090-THINKING"),
      );
    });
  });
});
