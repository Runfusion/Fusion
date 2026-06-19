import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentLogger, summarizeToolArgs } from "../agent-logger.js";
import type { TaskStore } from "@fusion/core";

const loggerWarnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", () => ({
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

function createMockStore(withBatch = false) {
  return {
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    ...(withBatch ? { appendAgentLogBatch: vi.fn().mockResolvedValue(undefined) } : {}),
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

  it("uses appendAgentLogBatch when available", async () => {
    const store = createMockStore(true) as unknown as TaskStore & { appendAgentLogBatch: ReturnType<typeof vi.fn> };
    const logger = new AgentLogger({
      store,
      taskId: "FN-BATCH",
      flushSizeBytes: 4,
      flushIntervalMs: 500,
    });

    logger.onText("hello");
    await vi.advanceTimersByTimeAsync(0);

    expect(store.appendAgentLogBatch).toHaveBeenCalledWith([
      { taskId: "FN-BATCH", text: "hello", type: "text", detail: undefined, agent: undefined },
    ]);
    expect((store.appendAgentLog as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
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

  it("omits tool detail when persistAgentToolOutput is disabled", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-004B",
      persistAgentToolOutput: false,
    });

    logger.onToolStart("Read", { path: "src/index.ts" });
    logger.onToolEnd("Read", false, "ok");
    logger.onToolEnd("Read", true, "err");
    await vi.advanceTimersByTimeAsync(0);

    expect(store.appendAgentLog).toHaveBeenNthCalledWith(1, "FN-004B", "Read", "tool", undefined, undefined);
    expect(store.appendAgentLog).toHaveBeenNthCalledWith(2, "FN-004B", "Read", "tool_result", undefined, undefined);
    expect(store.appendAgentLog).toHaveBeenNthCalledWith(3, "FN-004B", "Read", "tool_error", undefined, undefined);
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

  it("skips thinking entries by default", async () => {
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
    await vi.advanceTimersByTimeAsync(500);

    expect(store.appendAgentLog).not.toHaveBeenCalled();
  });

  it("buffers thinking deltas and flushes on timer when enabled", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-011A",
      agent: "executor",
      persistAgentThinkingLog: true,
      flushSizeBytes: 1024,
      flushIntervalMs: 500,
    });

    logger.onThinking("thought 1 ");
    logger.onThinking("thought 2");
    expect(store.appendAgentLog).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-011A", "thought 1 thought 2", "thinking", undefined, "executor");
  });

  it("flushes thinking on size threshold", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-012",
      agent: "triage",
      persistAgentThinkingLog: true,
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
      persistAgentThinkingLog: true,
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
      persistAgentThinkingLog: true,
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

  it("preserves long tool errors without truncation", async () => {
    const store = createMockStore();
    const logger = new AgentLogger({
      store,
      taskId: "FN-016B",
      agent: "executor",
    });

    const longError = "error:" + "y".repeat(1200);
    logger.onToolEnd("Read", true, longError);
    await vi.advanceTimersByTimeAsync(0);

    const call = (store.appendAgentLog as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[3]).toBe(longError);
  });

  it("preserves long tool results without truncation", async () => {
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
    expect(call[3]).toBe(longResult);
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
        expect.stringContaining("Failed to flush agent log entry for FN-2090-TOOL-START"),
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
        expect.stringContaining("Failed to flush agent log entry for FN-2090-TOOL-END"),
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
        expect.stringContaining("Failed to flush agent log entry for FN-2090-TEXT"),
      );
    });

    it("flushThinkingBuffer warns on persistence failure", async () => {
      const store = {
        appendAgentLog: vi.fn().mockRejectedValue(new Error("ENOSPC: no space left on device")),
      } as unknown as TaskStore;
      const logger = new AgentLogger({
        store,
        taskId: "FN-2090-THINKING",
        persistAgentThinkingLog: true,
        flushSizeBytes: 1,
      });

      logger.onThinking("deep thought");
      await vi.advanceTimersByTimeAsync(0);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to flush agent log entry for FN-2090-THINKING"),
      );
    });
  });

  // ── usage_events emission (U1) ─────────────────────────────────────
  describe("usage_events emission", () => {
    function createUsageStore() {
      return {
        appendAgentLog: vi.fn().mockResolvedValue(undefined),
        emitUsageEvent: vi.fn().mockReturnValue(true),
      } as unknown as TaskStore & { emitUsageEvent: ReturnType<typeof vi.fn> };
    }

    it("emits a tool_call usage event with model/provider/nodeId on tool start", () => {
      const store = createUsageStore();
      const logger = new AgentLogger({ store, taskId: "FN-UE-1", agent: "executor" });
      logger.setUsageContext({
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        nodeId: "node-x",
        agentId: "A-1",
      });

      logger.onToolStart("Read", { path: "secret/credentials.env" });

      expect(store.emitUsageEvent).toHaveBeenCalledTimes(1);
      const event = store.emitUsageEvent.mock.calls[0][0];
      expect(event).toMatchObject({
        kind: "tool_call",
        taskId: "FN-UE-1",
        agentId: "A-1",
        nodeId: "node-x",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        toolName: "Read",
        category: "read",
      });
      // The tool-argument content (the file path) MUST NOT appear in meta.
      const meta = (event.meta ?? {}) as Record<string, unknown>;
      expect(JSON.stringify(meta)).not.toContain("credentials.env");
    });

    it("does not emit usage events when no usage context is set", () => {
      const store = createUsageStore();
      const logger = new AgentLogger({ store, taskId: "FN-UE-2" });
      logger.onToolStart("Bash", { command: "ls" });
      expect(store.emitUsageEvent).not.toHaveBeenCalled();
    });

    it("integration: a session calling 3 tools yields 3 tool_call rows with model/provider/nodeId", () => {
      const store = createUsageStore();
      const logger = new AgentLogger({ store, taskId: "FN-UE-3", agent: "executor" });
      logger.setUsageContext({
        model: "gpt-5",
        provider: "openai",
        nodeId: "local",
        agentId: "A-3",
      });

      logger.onToolStart("Read", { path: "a.ts" });
      logger.onToolStart("Edit", { path: "a.ts" });
      logger.onToolStart("Bash", { command: "pnpm test" });

      const toolCalls = store.emitUsageEvent.mock.calls
        .map((c) => c[0])
        .filter((e) => e.kind === "tool_call");
      expect(toolCalls).toHaveLength(3);
      expect(toolCalls.map((e) => e.toolName)).toEqual(["Read", "Edit", "Bash"]);
      for (const event of toolCalls) {
        expect(event.model).toBe("gpt-5");
        expect(event.provider).toBe("openai");
        expect(event.nodeId).toBe("local");
        expect(event.agentId).toBe("A-3");
      }
    });

    it("emits tool_result with a duration descriptor and no result payload", () => {
      const store = createUsageStore();
      const logger = new AgentLogger({ store, taskId: "FN-UE-4" });
      logger.setUsageContext({ model: "m", provider: "p", nodeId: "n", agentId: "a" });

      logger.onToolStart("Bash", { command: "echo hi" });
      logger.onToolEnd("Bash", false, "super-secret-output");

      const endEvent = store.emitUsageEvent.mock.calls
        .map((c) => c[0])
        .find((e) => e.kind === "tool_result");
      expect(endEvent).toBeDefined();
      expect(endEvent.toolName).toBe("Bash");
      const meta = (endEvent.meta ?? {}) as Record<string, unknown>;
      expect(meta).toHaveProperty("durationMs");
      // The tool result payload MUST NOT leak into meta.
      expect(JSON.stringify(meta)).not.toContain("super-secret-output");
    });

    /*
     * FNXC:Telemetry 2026-06-16-05:47:
     * Prove the fail-soft telemetry contract: a throwing store.emitUsageEvent must never break
     * onToolStart/onToolEnd, and tool logging (appendAgentLog) must still proceed. Covers both a
     * synchronously throwing store and one that returns a rejected Promise.
     */
    it("does not throw and still logs the tool when emitUsageEvent throws synchronously", async () => {
      const store = {
        appendAgentLog: vi.fn().mockResolvedValue(undefined),
        emitUsageEvent: vi.fn().mockImplementation(() => {
          throw new Error("telemetry sink exploded");
        }),
      } as unknown as TaskStore & { emitUsageEvent: ReturnType<typeof vi.fn> };
      const logger = new AgentLogger({ store, taskId: "FN-UE-FAILSOFT", agent: "executor" });
      logger.setUsageContext({ model: "m", provider: "p", nodeId: "n", agentId: "a" });

      expect(() => logger.onToolStart("Bash", { command: "ls" })).not.toThrow();
      expect(() => logger.onToolEnd("Bash", false, "output")).not.toThrow();

      // emitUsageEvent was attempted for both start and end despite throwing.
      expect(store.emitUsageEvent).toHaveBeenCalled();

      // Tool logging still proceeds: tool start + tool_result rows are persisted.
      await vi.advanceTimersByTimeAsync(0);
      const calls = (store.appendAgentLog as ReturnType<typeof vi.fn>).mock.calls;
      const types = calls.map((c) => c[2]);
      expect(types).toContain("tool");
      expect(types).toContain("tool_result");

      // Failure is observed via warn, not propagated.
      expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to emit usage event"));
    });

    it("does not throw when emitUsageEvent returns a rejected promise", async () => {
      const store = {
        appendAgentLog: vi.fn().mockResolvedValue(undefined),
        emitUsageEvent: vi.fn().mockRejectedValue(new Error("async telemetry failure")),
      } as unknown as TaskStore & { emitUsageEvent: ReturnType<typeof vi.fn> };
      const logger = new AgentLogger({ store, taskId: "FN-UE-FAILSOFT-ASYNC" });
      logger.setUsageContext({ model: "m", provider: "p", nodeId: "n", agentId: "a" });

      expect(() => logger.onToolStart("Read", { path: "a.ts" })).not.toThrow();
      expect(() => logger.onToolEnd("Read", true, "boom")).not.toThrow();

      // Let the rejected emit-promise settle; the .catch must absorb it.
      await vi.advanceTimersByTimeAsync(0);
      expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to emit usage event"));
    });
  });
});
