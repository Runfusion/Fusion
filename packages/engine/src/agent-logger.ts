import type { TaskStore } from "@hai/core";

/** Default byte threshold before an automatic flush. */
const FLUSH_SIZE_BYTES = 1024;
/** Default timer interval (ms) for periodic flush of small writes. */
const FLUSH_INTERVAL_MS = 500;

/**
 * Produce a short human-readable summary from tool arguments.
 * Returns `undefined` for unknown tools or when no meaningful arg is found.
 */
export function summarizeToolArgs(name: string, args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  const lowerName = name.toLowerCase();

  if (lowerName === "bash") {
    const cmd = args.command;
    if (typeof cmd === "string") {
      return cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
    }
  }

  if (lowerName === "read" || lowerName === "edit" || lowerName === "write") {
    const p = args.path;
    if (typeof p === "string") return p;
  }

  // Fallback: return first string-valued arg if short enough
  for (const val of Object.values(args)) {
    if (typeof val === "string" && val.length <= 80) return val;
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
 * `createHaiAgent`'s `AgentOptions` interface.
 *
 * @example
 * ```ts
 * const logger = new AgentLogger({ store, taskId, onAgentText, onAgentTool });
 * const { session } = await createHaiAgent({
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
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushSizeBytes: number;
  private readonly flushIntervalMs: number;
  private readonly store: TaskStore;
  private readonly taskId: string;
  private readonly externalTextCb?: (taskId: string, delta: string) => void;
  private readonly externalToolCb?: (taskId: string, toolName: string) => void;

  constructor(options: AgentLoggerOptions) {
    this.store = options.store;
    this.taskId = options.taskId;
    this.externalTextCb = options.onAgentText;
    this.externalToolCb = options.onAgentTool;
    this.flushSizeBytes = options.flushSizeBytes ?? FLUSH_SIZE_BYTES;
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;

    // Bind callbacks so they can be passed directly as function references
    this.onText = this.onText.bind(this);
    this.onToolStart = this.onToolStart.bind(this);
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
   * Callback for tool invocation starts. Flushes pending text, then logs the
   * tool name with a detail summary. Compatible with `AgentOptions.onToolStart`.
   */
  onToolStart(name: string, args?: Record<string, unknown>): void {
    this.externalToolCb?.(this.taskId, name);
    // Flush any pending text before recording the tool entry
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flushTextBuffer();
    const detail = summarizeToolArgs(name, args);
    this.store.appendAgentLog(this.taskId, name, "tool", detail).catch(() => {});
  }

  /**
   * Flush any remaining buffered text and clear the timer.
   * Call this in a `finally` block before disposing the agent session.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    await this.flushTextBuffer();
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private flushTextBuffer(): Promise<void> {
    if (this.textBuffer.length === 0) return Promise.resolve();
    const chunk = this.textBuffer;
    this.textBuffer = "";
    return this.store.appendAgentLog(this.taskId, chunk, "text").catch(() => {
      /* best-effort persistence */
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushTextBuffer();
    }, this.flushIntervalMs);
  }
}
