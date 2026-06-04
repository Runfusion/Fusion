// Event bridge: translate ACP `session/update` notifications into Fusion's
// `AgentRuntime` callbacks (onText / onThinking / onToolStart / onToolEnd) so an
// ACP agent renders identically to existing runtimes.
//
// Scope (U4): mapping only. Output BYTE bounds + string sanitization are U6 — no
// caps are applied here. Permission requests are U5.
//
// Design notes:
// - Tolerant: every field except the `sessionUpdate` discriminator and
//   `toolCallId` is optional/partial. The handler NEVER throws on a malformed or
//   partial update; unknown/forward-compat tags are ignored silently.
// - Tool start/end correlation: a `tool_call` records `{ title, kind }` keyed by
//   `toolCallId`; a later `tool_call_update` carries that metadata forward when
//   the update omits it, then fires `onToolEnd` once the status reaches a
//   terminal value (`completed` / `failed`).
// - Plans are FULL REPLACEMENTS: each `plan` (or `plan_update`) update replaces
//   the prior snapshot wholesale; we never accumulate across updates.

import type {
  SessionUpdate,
  ContentBlock,
  ToolKind,
  PlanEntry,
} from "@agentclientprotocol/sdk";
import type { AcpCallbacks } from "./types.js";
import { toolDisplayName, normalizeToolArgs } from "./tool-mapping.js";
import { stripControlSequences, boundString, boundIdentifier } from "./sanitize.js";

// --- U6 untrusted-input bounds (Risk S5) -----------------------------------
//
// The agent is untrusted input. The high inactivity ceiling (KTD4) does NOT
// bound an *actively* flooding agent, so the bridge caps what it forwards.

/**
 * Per-turn cumulative cap (chars) on forwarded text+thinking. Once exceeded, the
 * bridge stops forwarding further text/thinking and emits ONE truncation flag.
 * Cleared by `reset()` at the start of each prompt turn. ~5M chars ≈ 5 MB.
 */
export const PER_TURN_OUTPUT_CAP_CHARS = 5_000_000;

/** Per-chunk cap (chars) applied to a single content chunk before forwarding. */
export const PER_CHUNK_CAP_CHARS = 64_000;

/**
 * Max number of distinct `toolCallId`s tracked in the correlation map. A flooding
 * agent supplying unbounded unique ids must not grow the map without limit —
 * oldest entries are evicted once the cap is exceeded (bounded memory).
 */
export const TOOL_CALL_MAP_CAP = 1000;

/**
 * Max plan entries formatted into the plan log line. Entry size is bounded in
 * formatPlan; this bounds the COUNT so one plan event cannot bypass the
 * per-turn output budget with thousands of 64KB entries (Risk S5).
 */
export const MAX_PLAN_ENTRIES = 100;

/** Tracked metadata for an in-flight tool call, keyed by `toolCallId`. */
interface TrackedToolCall {
  title?: string | null;
  kind?: ToolKind | null;
  /** Whether onToolEnd has already fired (terminal status seen). */
  ended: boolean;
}

export interface EventBridge {
  /** Process one `session/update` payload (`params.update`). Never throws. */
  handleSessionUpdate(update: SessionUpdate): void;
  /** Clear per-turn correlation state (tool calls, plan snapshot, last text). */
  reset(): void;
}

/** Extract plain text from a `ContentBlock`, or `undefined` for non-text blocks. */
function extractText(content: ContentBlock | undefined): string | undefined {
  if (content && content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  return undefined;
}

/**
 * Repair the specific "sentence punctuation + capitalized next sentence" case
 * where an agent splits adjacent sentences across chunks without the separating
 * space. Mirrors the droid runtime's `normalizeStreamingDelta` — conservative so
 * code, domains, and lowercase continuations are left untouched.
 */
function normalizeStreamingDelta(previousText: string, nextDelta: string): string {
  if (!previousText || !nextDelta) return nextDelta;
  const previousChar = previousText.slice(-1);
  const nextChar = nextDelta[0] ?? "";
  if (/\s/.test(previousChar) || /\s/.test(nextChar)) return nextDelta;
  if (/[.!?]/.test(previousChar) && /[A-Z0-9"'([]/.test(nextChar)) {
    return ` ${nextDelta}`;
  }
  return nextDelta;
}

/** Format a plan snapshot into a single thinking/log line. */
function formatPlan(entries: PlanEntry[]): string {
  const lines = entries.map((entry) => {
    const status = typeof entry.status === "string" ? entry.status : "pending";
    // Plan text is agent-supplied — sanitize control/ANSI before it reaches a
    // log/UI line (Risk S7) and bound its length (Risk S5).
    const rawText = typeof entry.content === "string" ? entry.content : "";
    const text = boundString(stripControlSequences(rawText), PER_CHUNK_CAP_CHARS);
    return `- [${stripControlSequences(status)}] ${text}`;
  });
  return `Plan:\n${lines.join("\n")}`;
}

export function createEventBridge(callbacks: AcpCallbacks): EventBridge {
  // Start/end correlation across `tool_call` → `tool_call_update`. Insertion
  // order is preserved by Map, so the oldest key is the first iterator entry —
  // used for FIFO eviction once TOOL_CALL_MAP_CAP is exceeded (Risk S5).
  const toolCalls = new Map<string, TrackedToolCall>();
  // Running text/thinking accumulators for delta-space repair across chunks.
  let textSoFar = "";
  let thinkingSoFar = "";
  // Cumulative chars forwarded (text+thinking) this turn (Risk S5).
  let cumulativeOutputChars = 0;
  // Whether the per-turn cap was hit and the single flag line already emitted.
  let outputCapFlagged = false;

  function reset(): void {
    toolCalls.clear();
    textSoFar = "";
    thinkingSoFar = "";
    cumulativeOutputChars = 0;
    outputCapFlagged = false;
  }

  /**
   * Track a bounded toolCallId for use as a Map key, evicting the oldest entry
   * when the cap is exceeded so a flood of unique ids cannot grow memory without
   * limit. Returns the normalized id, or `undefined` when the id is empty.
   */
  function setTracked(rawId: string, tracked: TrackedToolCall): string | undefined {
    const id = boundIdentifier(rawId);
    if (id === "") return undefined;
    // Re-insert moves an existing key to the tail (refresh recency); for a new
    // key, evict the oldest first so size stays bounded.
    if (!toolCalls.has(id) && toolCalls.size >= TOOL_CALL_MAP_CAP) {
      const oldest = toolCalls.keys().next().value;
      if (oldest !== undefined) toolCalls.delete(oldest);
    }
    toolCalls.set(id, tracked);
    return id;
  }

  /**
   * Forward one sanitized + bounded delta through `emit`, honoring the per-turn
   * cumulative cap. Once the cap is exceeded, forwarding stops and a single
   * truncation flag line is emitted via `onThinking`.
   */
  function forwardBounded(
    raw: string,
    prior: string,
    emit: (delta: string) => void,
  ): string {
    if (outputCapFlagged) return prior;
    if (cumulativeOutputChars >= PER_TURN_OUTPUT_CAP_CHARS) {
      outputCapFlagged = true;
      callbacks.onThinking?.(
        "[output truncated: per-turn limit reached — further agent output suppressed]",
      );
      return prior;
    }
    // Sanitize control/ANSI (Risk S7) and bound the single chunk (Risk S5).
    const sanitized = boundString(stripControlSequences(raw), PER_CHUNK_CAP_CHARS);
    if (sanitized === "") return prior;
    const delta = normalizeStreamingDelta(prior, sanitized);
    cumulativeOutputChars += delta.length;
    emit(delta);
    return prior + delta;
  }

  function emitText(content: ContentBlock | undefined): void {
    const raw = extractText(content);
    if (raw === undefined || raw === "") return;
    textSoFar = forwardBounded(raw, textSoFar, (delta) => callbacks.onText?.(delta));
  }

  function emitThinking(content: ContentBlock | undefined): void {
    const raw = extractText(content);
    if (raw === undefined || raw === "") return;
    thinkingSoFar = forwardBounded(raw, thinkingSoFar, (delta) =>
      callbacks.onThinking?.(delta),
    );
  }

  /** Sanitize an agent-supplied tool title before it reaches a callback/log (S7). */
  function safeTitle(title: string | null | undefined): string | null | undefined {
    if (typeof title !== "string") return title;
    return boundString(stripControlSequences(title), PER_CHUNK_CAP_CHARS);
  }

  function handleToolCall(update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>): void {
    if (typeof update.toolCallId !== "string") return;
    const title = safeTitle(update.title);
    const id = setTracked(update.toolCallId, { title, kind: update.kind, ended: false });
    if (id === undefined) return;
    const name = toolDisplayName({ title, kind: update.kind });
    callbacks.onToolStart?.(name, normalizeToolArgs(update.rawInput));
  }

  function handleToolCallUpdate(
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
  ): void {
    if (typeof update.toolCallId !== "string") return;
    const id = boundIdentifier(update.toolCallId);
    if (id === "") return;
    const tracked = toolCalls.get(id) ?? { ended: false };
    // Carry forward title/kind from the prior `tool_call` when this update omits
    // them (a partial update may only set status/output).
    if (update.title != null) tracked.title = safeTitle(update.title);
    if (update.kind != null) tracked.kind = update.kind;
    // `id` is already bounded above; setTracked re-keys with the same value.
    setTracked(id, tracked);

    const status = update.status;
    if (status !== "completed" && status !== "failed") {
      // Intermediate (pending/in_progress) — tracking updated, no callback.
      return;
    }
    if (tracked.ended) return; // already fired a terminal callback
    tracked.ended = true;
    const name = toolDisplayName({ title: tracked.title, kind: tracked.kind });
    callbacks.onToolEnd?.(name, status === "failed", update.rawOutput);
  }

  function handlePlan(entries: PlanEntry[] | undefined): void {
    // FULL REPLACEMENT: drop any prior snapshot, surface the new one once.
    // Plan output is charged against the same per-turn budget as text/thinking
    // (Risk S5): entry SIZE is bounded in formatPlan, but entry COUNT is
    // agent-controlled — without the cap below, one plan event with thousands
    // of entries bypasses the per-turn ceiling entirely.
    if (outputCapFlagged) return;
    // Enforce the ceiling on the plan path too: without this check a plan-ONLY
    // stream (no text/thinking ever entering forwardBounded) would keep
    // emitting forever after crossing the budget.
    if (cumulativeOutputChars >= PER_TURN_OUTPUT_CAP_CHARS) {
      outputCapFlagged = true;
      callbacks.onThinking?.(
        "[output truncated: per-turn limit reached — further agent output suppressed]",
      );
      return;
    }
    const list = Array.isArray(entries) ? entries : [];
    const capped = list.slice(0, MAX_PLAN_ENTRIES);
    let line = formatPlan(capped);
    if (list.length > capped.length) {
      line += `\n- … ${list.length - capped.length} more entries truncated`;
    }
    line = boundString(line, PER_CHUNK_CAP_CHARS);
    cumulativeOutputChars += line.length;
    callbacks.onThinking?.(line);
  }

  function handleSessionUpdate(update: SessionUpdate): void {
    if (!update || typeof update !== "object") return;
    try {
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          emitText(update.content);
          break;
        case "agent_thought_chunk":
          emitThinking(update.content);
          break;
        case "user_message_chunk":
          // Echo of user input — ignored in v1.
          break;
        case "tool_call":
          handleToolCall(update);
          break;
        case "tool_call_update":
          handleToolCallUpdate(update);
          break;
        case "plan":
          handlePlan(update.entries);
          break;
        case "plan_update":
          // The (experimental) `PlanUpdate` variant carries a `plan` field, NOT a
          // top-level `entries` array — so there is nothing here to map to our
          // entries-based snapshot. v1 treats it as a NO-OP rather than wiping the
          // prior plan: the full `plan` event remains the source of truth.
          break;
        case "plan_removed":
          // Clearing the plan: surface nothing.
          break;
        case "available_commands_update":
        case "current_mode_update":
        case "config_option_update":
        case "session_info_update":
        case "usage_update":
          // Stored/ignored in v1 — no callback surface.
          break;
        default:
          // Unknown/forward-compat tag — ignore without throwing.
          break;
      }
    } catch {
      // Tolerant: a malformed/partial update must never break the stream.
    }
  }

  return { handleSessionUpdate, reset };
}
