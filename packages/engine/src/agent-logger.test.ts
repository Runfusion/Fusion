import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentLogger, summarizeToolArgs } from "./agent-logger.js";
import type { TaskStore } from "@hai/core";

// ── summarizeToolArgs tests ──────────────────────────────────────────

describe("summarizeToolArgs", () => {
  it("returns bash command", () => {
    expect(summarizeToolArgs("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(summarizeToolArgs("bash", { command: "echo hello" })).toBe("echo hello");
  });

  it("truncates long bash commands at 80 chars", () => {
    const longCmd = "a".repeat(100);
    const result = summarizeToolArgs("Bash", { command: longCmd });
    expect(result).toBe("a".repeat(80) + "…");
  });

  it("returns file path for Read/Edit/Write", () => {
    expect(summarizeToolArgs("Read", { path: "src/types.ts" })).toBe("src/types.ts");
    expect(summarizeToolArgs("edit", { path: "src/store.ts" })).toBe("src/store.ts");
    expect(summarizeToolArgs("Write", { path: "out.txt", content: "data" })).toBe("out.txt");
  });

  it("falls back to first short string arg for unknown tools", () => {
    expect(summarizeToolArgs("task_update", { step: 1, status: "done" })).toBe("done");
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
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers text and flushes on size threshold", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "HAI-001",
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
    expect(store.appendAgentLog).toHaveBeenCalledWith("HAI-001", "helloworldextra", "text");
  });

  it("flushes on timer when under size threshold", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "HAI-002",
      flushSizeBytes: 1024,
      flushIntervalMs: 500,
    });

    logger.onText("small");
    expect(store.appendAgentLog).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(store.appendAgentLog).toHaveBeenCalledWith("HAI-002", "small", "text");
  });

  it("flushes text before logging tool start", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "HAI-003",
      flushSizeBytes: 1024,
    });

    logger.onText("pending text");
    logger.onToolStart("Bash", { command: "ls" });

    await vi.advanceTimersByTimeAsync(0);

    const calls = (store.appendAgentLog as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    // Text flushed first
    expect(calls[0]).toEqual(["HAI-003", "pending text", "text"]);
    // Tool logged second with detail
    expect(calls[1]).toEqual(["HAI-003", "Bash", "tool", "ls"]);
  });

  it("logs tool detail using summarizeToolArgs", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({ store, taskId: "HAI-004" });

    logger.onToolStart("Read", { path: "src/index.ts" });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.appendAgentLog).toHaveBeenCalledWith("HAI-004", "Read", "tool", "src/index.ts");
  });

  it("logs tool with undefined detail for unknown args", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({ store, taskId: "HAI-005" });

    logger.onToolStart("task_done", { count: 42 });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.appendAgentLog).toHaveBeenCalledWith("HAI-005", "task_done", "tool", undefined);
  });

  it("flush() clears timer and writes remaining text", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "HAI-006",
      flushSizeBytes: 1024,
      flushIntervalMs: 500,
    });

    logger.onText("remaining");
    await logger.flush();

    expect(store.appendAgentLog).toHaveBeenCalledWith("HAI-006", "remaining", "text");
  });

  it("flush() is safe to call when buffer is empty", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({ store, taskId: "HAI-007" });

    await logger.flush();
    expect(store.appendAgentLog).not.toHaveBeenCalled();
  });

  it("invokes external callbacks alongside logging", async () => {
    const store = createMockStore();
    const onAgentText = vi.fn();
    const onAgentTool = vi.fn();
    const logger = new AgentLogger({
      store,
      taskId: "HAI-008",
      onAgentText,
      onAgentTool,
    });

    logger.onText("delta");
    expect(onAgentText).toHaveBeenCalledWith("HAI-008", "delta");

    logger.onToolStart("Bash", { command: "echo hi" });
    expect(onAgentTool).toHaveBeenCalledWith("HAI-008", "Bash");
  });

  it("does not schedule multiple timers for consecutive small writes", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "HAI-009",
      flushSizeBytes: 1024,
      flushIntervalMs: 500,
    });

    logger.onText("a");
    logger.onText("b");
    logger.onText("c");

    await vi.advanceTimersByTimeAsync(500);

    // All text should be flushed in a single call
    expect(store.appendAgentLog).toHaveBeenCalledTimes(1);
    expect(store.appendAgentLog).toHaveBeenCalledWith("HAI-009", "abc", "text");
  });
});
