import type { TaskStore, AgentLogEntry, AgentRole } from "@fusion/core";
import { categorizeToolName } from "@fusion/core";
import { createLogger } from "./logger.js";

/**
 * Session-context fields that let the logger emit normalized `usage_events`
 * telemetry (KTD3/U1) alongside its agent-log writes. Populated by the
 * executor/session layer where `model`/`provider`/`nodeId` are resolved; when
 * absent, no usage events are emitted (the agent-log behavior is unchanged).
 */
export interface AgentLoggerUsageContext {
  /** Resolved model id for the running session, when known. */
  model?: string | null;
  /** Resolved provider for the running session, when known. */
  provider?: string | null;
  /** Workflow/session node the session is routed to, when known. */
  nodeId?: string | null;
  /** The agent id producing the activity, when known. */
  agentId?: string | null;
}

/** Default byte threshold before an automatic flush. */
const FLUSH_SIZE_BYTES = 1024;
/** Default timer interval (ms) for periodic flush of small writes. */
const FLUSH_INTERVAL_MS = 500;
const ENTRY_BATCH_SIZE = 50;

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
 *
 * Two sink modes are supported:
 * 1. **Task-store mode** (original): provide `store` + `taskId`. Writes go to
 *    `store.appendAgentLog(taskId, ...)`.
 * 2. **Callback mode**: provide `appendLog`. Writes go to the callback instead.
 *    When both are provided, both sinks receive every entry.
 */
export interface AgentLoggerOptions {
  /** When false, omit `detail` payloads for tool entries while preserving the rows. */
  persistAgentToolOutput?: boolean;
  /** When true, persist `thinking` rows. Default: false (skip thinking persistence). */
  persistAgentThinkingLog?: boolean;
  /** The task store used to persist agent log entries (task-store mode). */
  store?: TaskStore;
  /** The task ID this logger is associated with (task-store mode). */
  taskId?: string;
  /**
   * Optional alternative sink callback. When provided, every flushed entry is
   * forwarded here in addition to (or instead of) `store.appendAgentLog`.
   * Use this for run-scoped logging where there is no task.
   */
  appendLog?: (entry: AgentLogEntry) => Promise<void>;
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
  /**
   * When provided (with `store` + `taskId`), tool start/end callbacks also emit
   * normalized `usage_events` telemetry carrying the session's model/provider/
   * node context. Omit to leave agent-log behavior unchanged.
   */
  usageContext?: AgentLoggerUsageContext;
}

/**
 * Buffers agent text output and flushes it to the task store periodically
 * or when a size threshold is reached. Also handles tool-start logging with
 * detailed argument summaries via {@link summarizeToolArgs}.
 *
 * Produces `onText` and `onToolStart` callbacks compatible with
 * `createFnAgent`'s `AgentOptions` interface.
 *
 * @example
 * ```ts
 * const logger = new AgentLogger({ store, taskId, onAgentText, onAgentTool });
 * const { session } = await createFnAgent({
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
  private entryFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEntries: AgentLogEntry[] = [];
  private readonly flushSizeBytes: number;
  private readonly flushIntervalMs: number;
  private readonly store?: TaskStore;
  private readonly taskId: string;
  private readonly appendLogCb?: (entry: AgentLogEntry) => Promise<void>;
  private readonly agent?: AgentRole;
  private readonly externalTextCb?: (taskId: string, delta: string) => void;
  private readonly externalToolCb?: (taskId: string, toolName: string) => void;
  private readonly log = createLogger("agent-logger");
  private readonly persistAgentToolOutput: boolean;
  private readonly persistAgentThinkingLog: boolean;
  private usageContext?: AgentLoggerUsageContext;
  /** Tracks tool start times so tool_result/tool_error can record a duration. */
  private readonly toolStartedAt = new Map<string, number>();

  constructor(options: AgentLoggerOptions) {
    this.store = options.store;
    this.taskId = options.taskId ?? "";
    this.appendLogCb = options.appendLog;
    this.agent = options.agent;
    this.externalTextCb = options.onAgentText;
    this.externalToolCb = options.onAgentTool;
    this.flushSizeBytes = options.flushSizeBytes ?? FLUSH_SIZE_BYTES;
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.persistAgentToolOutput = options.persistAgentToolOutput !== false;
    this.persistAgentThinkingLog = options.persistAgentThinkingLog === true;
    this.usageContext = options.usageContext;

    // Bind callbacks so they can be passed directly as function references
    this.onText = this.onText.bind(this);
    this.onToolStart = this.onToolStart.bind(this);
    this.onThinking = this.onThinking.bind(this);
    this.onToolEnd = this.onToolEnd.bind(this);
  }

  /**
   * Set (or update) the session context used to emit `usage_events` telemetry.
   * The executor resolves `model`/`provider`/`nodeId` after the logger is
   * constructed, so it calls this once those are known.
   */
  setUsageContext(context: AgentLoggerUsageContext | undefined): void {
    this.usageContext = context;
  }

  /**
   * Emit a normalized tool `usage_events` row through the task store, if a store,
   * taskId, and usage context are all available.
   *
   * FNXC:Telemetry 2026-06-16-05:47:
   * Usage-event emission is fail-soft: telemetry is a side effect of tool logging and must never break it.
   * `store.emitUsageEvent` is wrapped in try/catch so a throwing (or rejecting) store leaves
   * `onToolStart`/`onToolEnd` non-throwing and lets agent-log writes proceed. Failures are warned, not propagated.
   */
  private emitToolUsageEvent(
    kind: "tool_call" | "tool_result" | "tool_error",
    toolName: string,
    meta?: Record<string, unknown>,
  ): void {
    const ctx = this.usageContext;
    if (!ctx || !this.store || !this.taskId) return;
    try {
      const maybePromise = this.store.emitUsageEvent({
        kind,
        taskId: this.taskId,
        agentId: ctx.agentId ?? null,
        nodeId: ctx.nodeId ?? null,
        model: ctx.model ?? null,
        provider: ctx.provider ?? null,
        toolName,
        category: categorizeToolName(toolName),
        ...(meta !== undefined && { meta }),
      });
      // Swallow async rejections too so a Promise-returning store stays fail-soft.
      void Promise.resolve(maybePromise).catch((err) => {
        this.log.warn(`Failed to emit usage event (${kind}) for "${toolName}" on ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      this.log.warn(`Failed to emit usage event (${kind}) for "${toolName}" on ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    if (!this.persistAgentThinkingLog) {
      return;
    }
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
    this.writeEntry(name, "tool", detail, `Failed to log tool start "${name}" for ${this.taskId}`);
    // agent-log type "tool" maps to usage_events kind "tool_call". meta carries
    // only non-sensitive descriptors (category) — never the tool arguments.
    this.toolStartedAt.set(name, Date.now());
    this.emitToolUsageEvent("tool_call", name);
  }

  /**
   * Callback for tool execution completion. Logs as `type: "tool_result"` on success
   * or `type: "tool_error"` on failure.
   *
   * @param name - The tool name
   * @param isError - Whether the tool execution resulted in an error
   * @param result - Optional result value. Downstream storage may clip very
   * large tool payloads to keep dashboard log views responsive.
   */
  onToolEnd(name: string, isError: boolean, result?: unknown): void {
    const type = isError ? "tool_error" : "tool_result";
    let detail: string | undefined;
    if (result !== undefined && result !== null) {
      detail = typeof result === "string" ? result : JSON.stringify(result);
    }
    this.writeEntry(name, type, detail, `Failed to log tool end "${name}" (${type}) for ${this.taskId}`);
    // Record completion as tool_result/tool_error with a duration descriptor.
    // meta NEVER includes the tool result payload — only non-sensitive metrics.
    const startedAt = this.toolStartedAt.get(name);
    if (startedAt !== undefined) this.toolStartedAt.delete(name);
    const meta: Record<string, unknown> = {};
    if (startedAt !== undefined) meta.durationMs = Date.now() - startedAt;
    if (isError) meta.isError = true;
    this.emitToolUsageEvent(
      isError ? "tool_error" : "tool_result",
      name,
      Object.keys(meta).length > 0 ? meta : undefined,
    );
  }

  /**
   * Flush any remaining buffered text/thinking and clear timers.
   * Call this in a `finally` block before disposing the agent session.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.thinkingFlushTimer) { clearTimeout(this.thinkingFlushTimer); this.thinkingFlushTimer = null; }
    if (this.entryFlushTimer) { clearTimeout(this.entryFlushTimer); this.entryFlushTimer = null; }
    await this.flushTextBuffer();
    await this.flushThinkingBuffer();
    await this.flushPendingEntries();
  }

  // ── Internal helpers ───────────────────────────────────────────────

  /**
   * Write a single structured entry through whichever sink(s) are configured.
   * When both `store`+`taskId` and `appendLogCb` are set, both receive the entry.
   * When only `appendLogCb` is set (no store/taskId), only the callback is used.
   * @param storeWarnMsg - Warning message prefix used when the task-store write fails.
   */
  private writeEntry(text: string, type: AgentLogEntry["type"], detail: string | undefined, _storeWarnMsg: string, immediate = false): void {
    const isToolEntry = type === "tool" || type === "tool_result" || type === "tool_error";
    const includeDetail = !isToolEntry || this.persistAgentToolOutput;
    const entry: AgentLogEntry = {
      timestamp: new Date().toISOString(),
      taskId: this.taskId,
      text,
      type,
      ...(detail !== undefined && includeDetail && { detail }),
      ...(this.agent !== undefined && { agent: this.agent }),
    };

    this.pendingEntries.push(entry);
    if (immediate || (type !== "text" && type !== "thinking")) {
      if (this.entryFlushTimer) {
        clearTimeout(this.entryFlushTimer);
        this.entryFlushTimer = null;
      }
      void this.flushPendingEntries();
      return;
    }

    if (this.pendingEntries.length >= ENTRY_BATCH_SIZE) {
      if (this.entryFlushTimer) {
        clearTimeout(this.entryFlushTimer);
        this.entryFlushTimer = null;
      }
      void this.flushPendingEntries();
      return;
    }

    this.scheduleEntryFlush();
  }

  private flushTextBuffer(): Promise<void> {
    if (this.textBuffer.length === 0) return Promise.resolve();
    const chunk = this.textBuffer;
    this.textBuffer = "";
    this.writeEntry(chunk, "text", undefined, `Failed to flush text buffer for ${this.taskId}`, true);
    return this.flushPendingEntries();
  }

  private flushThinkingBuffer(): Promise<void> {
    if (this.thinkingBuffer.length === 0) return Promise.resolve();
    const chunk = this.thinkingBuffer;
    this.thinkingBuffer = "";
    if (!this.persistAgentThinkingLog) {
      return Promise.resolve();
    }
    this.writeEntry(chunk, "thinking", undefined, `Failed to flush thinking buffer for ${this.taskId}`, true);
    return this.flushPendingEntries();
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

  private scheduleEntryFlush(): void {
    if (this.entryFlushTimer) return;
    this.entryFlushTimer = setTimeout(() => {
      this.entryFlushTimer = null;
      void this.flushPendingEntries();
    }, this.flushIntervalMs);
  }

  private async flushPendingEntries(): Promise<void> {
    if (this.pendingEntries.length === 0) {
      return;
    }

    const entries = this.pendingEntries;
    this.pendingEntries = [];

    if (this.store && this.taskId) {
      if (typeof (this.store as TaskStore & { appendAgentLogBatch?: unknown }).appendAgentLogBatch === "function") {
        await this.store
          .appendAgentLogBatch(
            entries.map((entry) => ({
              taskId: entry.taskId,
              text: entry.text,
              type: entry.type,
              detail: entry.detail,
              agent: entry.agent,
            })),
          )
          .catch((err) => {
            this.log.warn(`Failed to flush agent log batch for ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`);
          });
      } else {
        await Promise.all(
          entries.map((entry) =>
            this.store!.appendAgentLog(entry.taskId, entry.text, entry.type, entry.detail, entry.agent).catch((err) => {
              this.log.warn(`Failed to flush agent log entry for ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`);
            }),
          ),
        );
      }
    }

    if (this.appendLogCb) {
      await Promise.all(
        entries.map((entry) =>
          this.appendLogCb!(entry).catch((err) => {
            this.log.warn(`appendLog callback failed for entry (${entry.type}): ${err instanceof Error ? err.message : String(err)}`);
          }),
        ),
      );
    }
  }
}
