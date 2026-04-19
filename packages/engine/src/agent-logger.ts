import type { TaskStore, AgentRole } from "@fusion/core";
import { createLogger } from "./logger.js";

/** Default byte threshold before an automatic flush. */
const FLUSH_SIZE_BYTES = 1024;
/** Default timer interval (ms) for periodic flush of small writes. */
const FLUSH_INTERVAL_MS = 500;

/**
 * Produce a human-readable summary from tool arguments.
 * Returns the full argument value without truncation.
 * Returns `undefined` for unknown tools or when no meaningful arg is found.
 */
export function summarizeToolArgs(name: string, args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  const lowerName = name.toLowerCase();

  if (lowerName === "bash") {
    const cmd = args.command;
    if (typeof cmd === "string") return cmd;
  }

  if (lowerName === "read" || lowerName === "edit" || lowerName === "write") {
    const p = args.path;
    if (typeof p === "string") return p;
  }

  // Fallback: return first string-valued arg
  for (const val of Object.values(args)) {
    if (typeof val === "string") return val;
  }

  return undefined;
}

/**
 * Options for creating an {@link AgentLogger}.
 */
export interface AgentLoggerOptions {
  /** The task store used to persist agent log entries. */
  store: TaskStore;
  /** The task ID this logger is associated with. */
  taskId: string;
  /** Which agent role is producing log entries (persisted on every entry). */
  agent?: AgentRole;
  /** Optional callback invoked alongside text logging (e.g. for SSE streaming). */
  onAgentText?: (taskId: string, delta: string) => void;
  /** Optional callback invoked alongside tool logging (e.g. for SSE streaming). */
  onAgentTool?: (taskId: string, toolName: string) => void;
  /** Byte threshold for automatic flush. Defaults to 1024. */
  flushSizeBytes?: number;
  /** Timer interval (ms) for periodic flush. Defaults to 500. */
  flushIntervalMs?: number;
}

/**
 * Buffers agent text output and flushes it to the task store periodically
 * or when a size threshold is reached. Also handles tool-start logging with
 * detailed argument summaries via {@link summarizeToolArgs}.
 *
 * Produces `onText` and `onToolStart` callbacks compatible with
 * `createKbAgent`'s `AgentOptions` interface.
 *
 * @example
 * ```ts
 * const logger = new AgentLogger({ store, taskId, onAgentText, onAgentTool });
 * const { session } = await createKbAgent({
 *   cwd: worktreePath,
 *   onText: logger.onText,
 *   onToolStart: logger.onToolStart,
 *   // ...
 * });
 * try {
 *   await session.prompt(prompt);
 * } finally {
 *   await logger.flush();
 *   session.dispose();
 * }
 * ```
 */
export class AgentLogger {
  private textBuffer = "";
  private thinkingBuffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushSizeBytes: number;
  private readonly flushIntervalMs: number;
  private readonly store: TaskStore;
  private readonly taskId: string;
  private readonly agent?: AgentRole;
  private readonly externalTextCb?: (taskId: string, delta: string) => void;
  private readonly externalToolCb?: (taskId: string, toolName: string) => void;
  private readonly log = createLogger("agent-logger");

  constructor(options: AgentLoggerOptions) {
    this.store = options.store;
    this.taskId = options.taskId;
    this.agent = options.agent;
    this.externalTextCb = options.onAgentText;
    this.externalToolCb = options.onAgentTool;
    this.flushSizeBytes = options.flushSizeBytes ?? FLUSH_SIZE_BYTES;
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;

    // Bind callbacks so they can be passed directly as function references
    this.onText = this.onText.bind(this);
    this.onToolStart = this.onToolStart.bind(this);
    this.onThinking = this.onThinking.bind(this);
    this.onToolEnd = this.onToolEnd.bind(this);
  }

  /**
   * Callback for agent text deltas. Buffers text and flushes on size
   * threshold or after a timer interval. Compatible with `AgentOptions.onText`.
   */
  onText(delta: string): void {
    this.externalTextCb?.(this.taskId, delta);
    this.textBuffer += delta;
    if (this.textBuffer.length >= this.flushSizeBytes) {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      this.flushTextBuffer();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Callback for thinking block deltas. Buffers and flushes thinking text
   * as `type: "thinking"` entries, using the same size/timer pattern as `onText`.
   */
  onThinking(delta: string): void {
    this.thinkingBuffer += delta;
    if (this.thinkingBuffer.length >= this.flushSizeBytes) {
      if (this.thinkingFlushTimer) { clearTimeout(this.thinkingFlushTimer); this.thinkingFlushTimer = null; }
      this.flushThinkingBuffer();
    } else {
      this.scheduleThinkingFlush();
    }
  }

  /**
   * Callback for tool invocation starts. Flushes pending text, then logs the
   * tool name with a detail summary. Compatible with `AgentOptions.onToolStart`.
   */
  onToolStart(name: string, args?: Record<string, unknown>): void {
    this.externalToolCb?.(this.taskId, name);
    // Flush any pending text/thinking before recording the tool entry
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flushTextBuffer();
    if (this.thinkingFlushTimer) { clearTimeout(this.thinkingFlushTimer); this.thinkingFlushTimer = null; }
    this.flushThinkingBuffer();
    const detail = summarizeToolArgs(name, args);
    this.store.appendAgentLog(this.taskId, name, "tool", detail, this.agent).catch((err) => {
      this.log.warn(`Failed to log tool start "${name}" for ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Callback for tool execution completion. Logs as `type: "tool_result"` on success
   * or `type: "tool_error"` on failure.
   *
   * @param name - The tool name
   * @param isError - Whether the tool execution resulted in an error
   * @param result - Optional result value (truncated for persistence)
   */
  onToolEnd(name: string, isError: boolean, result?: unknown): void {
    const type = isError ? "tool_error" : "tool_result";
    let detail: string | undefined;
    if (result !== undefined && result !== null) {
      const str = typeof result === "string" ? result : JSON.stringify(result);
      detail = str.length > 500 ? str.slice(0, 500) + "…" : str;
    }
    this.store.appendAgentLog(this.taskId, name, type, detail, this.agent).catch((err) => {
      this.log.warn(`Failed to log tool end "${name}" (${type}) for ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Flush any remaining buffered text/thinking and clear timers.
   * Call this in a `finally` block before disposing the agent session.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.thinkingFlushTimer) { clearTimeout(this.thinkingFlushTimer); this.thinkingFlushTimer = null; }
    await this.flushTextBuffer();
    await this.flushThinkingBuffer();
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private flushTextBuffer(): Promise<void> {
    if (this.textBuffer.length === 0) return Promise.resolve();
    const chunk = this.textBuffer;
    this.textBuffer = "";
    return this.store.appendAgentLog(this.taskId, chunk, "text", undefined, this.agent).catch((err) => {
      this.log.warn(`Failed to flush text buffer for ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private flushThinkingBuffer(): Promise<void> {
    if (this.thinkingBuffer.length === 0) return Promise.resolve();
    const chunk = this.thinkingBuffer;
    this.thinkingBuffer = "";
    return this.store.appendAgentLog(this.taskId, chunk, "thinking", undefined, this.agent).catch((err) => {
      this.log.warn(`Failed to flush thinking buffer for ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushTextBuffer();
    }, this.flushIntervalMs);
  }

  private scheduleThinkingFlush(): void {
    if (this.thinkingFlushTimer) return;
    this.thinkingFlushTimer = setTimeout(() => {
      this.thinkingFlushTimer = null;
      this.flushThinkingBuffer();
    }, this.flushIntervalMs);
  }
}
