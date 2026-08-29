/**
 * CLI-backed chat session runner (CLI Agent Executor, U12).
 *
 * When a chat session selects a cli-agent executor (`ChatSession.cliExecutorAdapterId`),
 * the chat is driven by a long-lived CLI agent process instead of the standard
 * model-provider path. This runner is the server-side bridge between that CLI
 * session and the durable chat transcript:
 *
 *  - It spawns (or resumes) a `CliSessionManager` session with purpose "chat",
 *    cwd = the configured working directory (or the project root), persisting the
 *    native session id back onto the chat session for resume.
 *  - Composer messages route through the inject path (FIFO, serialized by the
 *    manager's write queue). While the session is busy, sends queue; the flush
 *    decision re-fetches authoritative session state from the store rather than
 *    trusting a cached/streamed busy flag (the stale-isGenerating learning,
 *    docs/solutions/logic-errors/queued-chat-message-flush-trusts-stale-isgenerating.md).
 *  - Adapter transcript telemetry events map to `chat_messages` rows at
 *    user/assistant/tool-summary granularity. Fine-grained tool noise
 *    (toolActivity, outputProgress, idle) stays in the terminal and is NOT
 *    persisted — the durable transcript is the readable conversation, not the
 *    raw scrollback.
 *
 * Secret hygiene: the shared `redactSecrets` pass runs on transcript text
 * BEFORE persistence. Durable chat rows must not become a secret store — CLI
 * agents routinely print bearer tokens and env dumps. See the test block in
 * packages/dashboard/src/__tests__/chat-cli-sessions.test.ts for the
 * characterized coverage of what `redactSecrets` catches and its known gaps.
 *
 * This module owns no PTY/adapter internals directly: it depends on narrow
 * interfaces (`ChatStoreLike`, `CliSessionManagerLike`) so it is unit-testable
 * with mocked PTY/adapters per the U12 constraints.
 */

import { redactSecrets } from "@fusion/core";
import type {
  ChatMessage,
  ChatMessageCreateInput,
  ChatSession,
} from "@fusion/core";

// ── Narrow dependency interfaces (testable seams) ──────────────────────────

/** The slice of ChatStore this runner needs. */
export interface ChatStoreLike {
  getSession(id: string): Promise<ChatSession | undefined> | ChatSession | undefined;
  addMessage(sessionId: string, input: ChatMessageCreateInput): Promise<ChatMessage> | ChatMessage;
  setCliExecutorAdapterId(id: string, adapterId: string | null): Promise<ChatSession | undefined> | ChatSession | undefined;
  setCliSessionFile?(id: string, cliSessionFile: string | null): Promise<void> | void;
}

/** A durable cli_sessions record (subset used here). */
export interface CliSessionLike {
  id: string;
  nativeSessionId: string | null;
  agentState: string;
}

/** The slice of CliSessionManager this runner needs. */
export interface CliSessionManagerLike {
  spawn(options: {
    adapterId: string;
    projectId: string;
    purpose: "chat";
    chatSessionId: string;
    worktreePath?: string | null;
    resume?: { sessionId: string; nativeSessionId: string };
  }): Promise<CliSessionLike>;
  inject(sessionId: string, text: string): Promise<void>;
  /** Authoritative, freshly-read session record (used for flush decisions). */
  getSession(sessionId: string): CliSessionLike | undefined;
}

/**
 * Sanitized telemetry event shape (mirrors engine's SanitizedTelemetryEvent,
 * duplicated as a structural type to avoid a dashboard→engine import edge).
 */
export interface ChatTelemetryEvent {
  kind:
    | "sessionStart"
    | "busy"
    | "waitingOnInput"
    | "done"
    | "idle"
    | "toolActivity"
    | "outputProgress"
    | "transcript";
  text?: string;
  nativeSessionId?: string;
  /** Transcript role hint when the adapter distinguishes turns. */
  role?: "user" | "assistant";
  /** A tool-summary line (one human-readable line, not raw tool noise). */
  toolSummary?: string;
}

/** Busy-equivalent states: composer sends must queue, not flush. */
const BUSY_STATES = new Set(["starting", "busy", "waitingOnInput"]);

export interface CliChatSessionRunnerOptions {
  store: ChatStoreLike;
  manager: CliSessionManagerLike;
}

/**
 * Maps one CLI-backed chat session to its durable transcript and brokers
 * composer injection with FIFO queueing.
 */
export class CliChatSessionRunner {
  private readonly store: ChatStoreLike;
  private readonly manager: CliSessionManagerLike;

  /** chatSessionId → live cli session id. */
  private readonly cliSessionByChat = new Map<string, string>();
  /** chatSessionId → FIFO queue of composer texts awaiting a flush. */
  private readonly queue = new Map<string, string[]>();
  /** chatSessionId → assistant text being accumulated across transcript chunks. */
  private readonly assistantBuffer = new Map<string, string>();

  constructor(opts: CliChatSessionRunnerOptions) {
    this.store = opts.store;
    this.manager = opts.manager;
  }

  /**
   * Ensure a live CLI session exists for the chat, spawning (or resuming via a
   * persisted native session id) as needed. Returns the cli session id.
   */
  async ensureSession(
    chatSessionId: string,
    opts: { projectId: string; worktreePath?: string | null },
  ): Promise<string> {
    const existing = this.cliSessionByChat.get(chatSessionId);
    if (existing) return existing;

    const chat = await this.store.getSession(chatSessionId);
    if (!chat) throw new Error(`Unknown chat session: ${chatSessionId}`);
    const adapterId = chat.cliExecutorAdapterId;
    if (!adapterId) {
      throw new Error(`Chat session ${chatSessionId} has no cli-agent executor`);
    }

    // Resume if we previously recorded a native session id (cliSessionFile-style
    // linkage; here the native id lives on the cli_sessions record).
    const resumeNative = chat.cliSessionFile; // native session id persisted on the chat
    const cli = await this.manager.spawn({
      adapterId,
      projectId: opts.projectId,
      purpose: "chat",
      chatSessionId,
      worktreePath: opts.worktreePath ?? null,
      ...(resumeNative
        ? { resume: { sessionId: chatSessionId, nativeSessionId: resumeNative } }
        : {}),
    });

    this.cliSessionByChat.set(chatSessionId, cli.id);
    return cli.id;
  }

  /**
   * Send a composer message. If the underlying CLI session is busy (per a
   * freshly re-fetched store record — never a cached flag), the text is queued
   * with a visible queued state instead of injected. Returns whether the
   * message was injected immediately (`"sent"`) or queued (`"queued"`).
   *
   * The user message is persisted to the transcript immediately in both cases
   * so the conversation reflects intent regardless of timing.
   */
  async send(chatSessionId: string, text: string): Promise<"sent" | "queued"> {
    const cliSessionId = this.cliSessionByChat.get(chatSessionId);
    if (!cliSessionId) throw new Error(`No live CLI session for chat ${chatSessionId}`);

    // Persist the user's message immediately (redacted — users can paste tokens too).
    await this.store.addMessage(chatSessionId, {
      role: "user",
      content: redactSecrets(text),
      metadata: { source: "cli-agent", origin: "composer" },
    });

    if (this.isBusy(cliSessionId)) {
      this.enqueue(chatSessionId, text);
      return "queued";
    }

    await this.manager.inject(cliSessionId, text);
    return "sent";
  }

  /**
   * Authoritative busy check: re-reads the session record from the manager/store
   * so flush decisions never trust a stale SSE/cached `isGenerating` flag.
   */
  private isBusy(cliSessionId: string): boolean {
    const record = this.manager.getSession(cliSessionId);
    if (!record) return false;
    return BUSY_STATES.has(record.agentState);
  }

  private enqueue(chatSessionId: string, text: string): void {
    const q = this.queue.get(chatSessionId) ?? [];
    q.push(text);
    this.queue.set(chatSessionId, q);
  }

  /** Number of composer messages currently queued for a chat (UI indicator). */
  queuedCount(chatSessionId: string): number {
    return this.queue.get(chatSessionId)?.length ?? 0;
  }

  /**
   * Attempt to flush one queued composer message. Called when the session
   * reports `done`. Re-fetches authoritative state before injecting — if the
   * session turned busy again between the SSE event and this call, the flush
   * is skipped and the message stays queued (the stale-isGenerating learning).
   */
  async flushNext(chatSessionId: string): Promise<boolean> {
    const cliSessionId = this.cliSessionByChat.get(chatSessionId);
    if (!cliSessionId) return false;
    const q = this.queue.get(chatSessionId);
    if (!q || q.length === 0) return false;

    // Authoritative re-fetch — do NOT trust a cached/streamed flag here.
    if (this.isBusy(cliSessionId)) return false;

    const text = q.shift()!;
    if (q.length === 0) this.queue.delete(chatSessionId);
    await this.manager.inject(cliSessionId, text);
    return true;
  }

  /**
   * Map a sanitized adapter telemetry event to transcript persistence.
   *
   * Granularity (KTD): only user / assistant / tool-summary land in
   * chat_messages. `toolActivity`, `outputProgress`, and `idle` are terminal
   * noise and are dropped here. `redactSecrets` runs on all persisted text.
   *
   * - `busy`    → starts a new assistant turn (flushes any prior buffer).
   * - `transcript` (role assistant or unspecified) → accumulates assistant text.
   * - `transcript` (role user) → a user-echo turn (rare; adapters that surface it).
   * - `transcript` with `toolSummary` → a single tool-summary row (no raw noise).
   * - `done`    → flushes the accumulated assistant turn, then tries a queue flush.
   *
   * Returns the chat_messages rows it created (for tests / SSE fan-out is the
   * store's responsibility via `chat:message:added`).
   */
  async handleTelemetry(
    chatSessionId: string,
    event: ChatTelemetryEvent,
  ): Promise<ChatMessage[]> {
    const created: ChatMessage[] = [];

    // Persist the native session id for resume the first time we learn it.
    if (event.nativeSessionId) {
      const chat = await this.store.getSession(chatSessionId);
      if (chat && chat.cliSessionFile !== event.nativeSessionId) {
        // Reuse cliSessionFile column as the native-session linkage (KTD:
        // cliSessionFile-style column or session metadata). setCliSessionFile is
        // internal plumbing; we route through the public setter on the runner's
        // store slice when available, else fall through.
        await (this.store as { setCliSessionFile?: (id: string, v: string) => Promise<void> | void }).setCliSessionFile?.(
          chatSessionId,
          event.nativeSessionId,
        );
      }
    }

    switch (event.kind) {
      case "busy": {
        // New assistant turn begins — flush any stale buffer defensively.
        await this.flushAssistantBuffer(chatSessionId, created);
        this.assistantBuffer.set(chatSessionId, "");
        break;
      }
      case "transcript": {
        if (event.toolSummary) {
          // One readable tool-summary row. Raw per-call tool noise never reaches here.
          const row = await this.store.addMessage(chatSessionId, {
            role: "assistant",
            content: redactSecrets(event.toolSummary),
            metadata: { source: "cli-agent", kind: "tool-summary" },
          });
          created.push(row);
          break;
        }
        const text = event.text ?? "";
        if (event.role === "user") {
          // Adapter-surfaced user echo — persist as a user row (deduped by caller).
          const row = await this.store.addMessage(chatSessionId, {
            role: "user",
            content: redactSecrets(text),
            metadata: { source: "cli-agent", origin: "transcript" },
          });
          created.push(row);
          break;
        }
        // Default: assistant transcript text — accumulate across chunks.
        const buf = this.assistantBuffer.get(chatSessionId) ?? "";
        this.assistantBuffer.set(chatSessionId, buf + text);
        break;
      }
      case "done": {
        await this.flushAssistantBuffer(chatSessionId, created);
        // Session idle → attempt to flush one queued composer message.
        await this.flushNext(chatSessionId);
        break;
      }
      // Terminal-only noise — intentionally NOT persisted to the transcript.
      case "toolActivity":
      case "outputProgress":
      case "idle":
      case "sessionStart":
      case "waitingOnInput":
        break;
    }

    return created;
  }

  /** Persist the accumulated assistant turn as one row, if non-empty. */
  private async flushAssistantBuffer(chatSessionId: string, into: ChatMessage[]): Promise<void> {
    const buf = this.assistantBuffer.get(chatSessionId);
    if (buf == null) return;
    this.assistantBuffer.delete(chatSessionId);
    const trimmed = buf.trim();
    if (trimmed.length === 0) return;
    const row = await this.store.addMessage(chatSessionId, {
      role: "assistant",
      content: redactSecrets(trimmed),
      metadata: { source: "cli-agent" },
    });
    into.push(row);
  }
}
