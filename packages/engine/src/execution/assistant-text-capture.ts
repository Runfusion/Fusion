import { createStreamingDeltaNormalizer } from "./streaming-delta.js";

type Kind = "text" | "thinking";
type CaptureSinks = {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onTextBlockBoundary?: () => void;
};

type EventRecord = Record<string, unknown>;

/**
 * Raw cursors for one content block.
 * `covered` counts raw characters already emitted from ANY event shape (start snapshot, delta,
 * terminal content). `consumed` counts only the raw characters accounted for by deltas, so a start
 * snapshot that already carries an unconsumed delta never advances the delta stream.
 * Presentation spaces added by the normalizer are deliberately excluded from both.
 */
type BlockCursor = { covered: number; consumed: number };

function record(value: unknown): EventRecord | undefined {
  return value !== null && typeof value === "object" ? value as EventRecord : undefined;
}

function indexOf(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function blockText(partial: unknown, index: number | undefined, kind: Kind): string {
  const content = record(partial)?.content;
  if (!Array.isArray(content) || index === undefined) return "";
  const block = record(content[index]);
  if (block?.type !== kind) return "";
  const value = block[kind === "text" ? "text" : "thinking"];
  return typeof value === "string" ? value : "";
}

/*
FNXC:AssistantTextCapture 2026-09-15-20:34:
FN-431: pi queues assistant events without cloning them and Anthropic-shaped producers reuse ONE
mutable message object as every event's `partial`. A start snapshot drained after the first delta was
queued therefore already contains that delta, so the previous "flush the start snapshot, then append
every delta" reading emitted the opening words twice ("I'll researchI'll research …") in chat and in
task logs.
Requirements encoded below:
- one emission per raw portion of a block: a portion observable in a start, a delta and a terminal
  event must be delivered exactly once;
- recoverable start/terminal content is still restored, at the latest at the block/message end, so
  providers that deliver whole blocks without deltas keep working;
- no lexical deduplication: intentional repetition and two identical responses stay intact, and
  provider messages are never mutated;
- snapshot object identity is NOT message identity — providers that copy the snapshot per event must
  not reset the cursors nor invent paragraph boundaries.
*/
/** Captures every pi assistant block shape while retaining exact-once offsets. */
export function createAssistantStreamCapture(sinks: CaptureSinks): { handleAgentEvent(event: unknown): void } {
  const normalizer = createStreamingDeltaNormalizer();
  const cursors: Record<Kind, Map<number, BlockCursor>> = { text: new Map(), thinking: new Map() };
  let generation = 0;
  let lastTextIndex: number | undefined;
  let lastTextGeneration: number | undefined;
  let sawText = false;
  const cursorFor = (kind: Kind, index: number): BlockCursor => {
    let cursor = cursors[kind].get(index);
    if (!cursor) { cursor = { covered: 0, consumed: 0 }; cursors[kind].set(index, cursor); }
    return cursor;
  };
  const reset = () => {
    cursors.text.clear(); cursors.thinking.clear();
    normalizer.noteBoundary("text"); normalizer.noteBoundary("thinking");
    generation += 1;
  };
  const emit = (kind: Kind, text: string, partial: unknown, index: number | undefined, verbatim = false) => {
    if (!text) return;
    if (kind === "text") {
      if (sawText && (index !== lastTextIndex || generation !== lastTextGeneration)) sinks.onTextBlockBoundary?.();
      sinks.onText?.(text);
      sawText = true; lastTextIndex = index; lastTextGeneration = generation;
    } else sinks.onThinking?.(text);
    if (verbatim) normalizer.noteEmitted(kind, text, partial, index);
  };
  /** Emits only the part of a snapshot/terminal body that has not been delivered yet. */
  const flush = (kind: Kind, text: string, partial: unknown, index: number | undefined) => {
    if (index === undefined || !text) return;
    const cursor = cursorFor(kind, index);
    const remainder = text.slice(cursor.covered);
    if (remainder) emit(kind, remainder, partial, index, true);
    cursor.covered = Math.max(cursor.covered, text.length);
  };
  /** A snapshot shorter than the consumed deltas is a restarted block — a new message reusing the index. */
  const noteSnapshot = (kind: Kind, index: number | undefined, full: string, hasSnapshot: boolean) => {
    if (index === undefined || !hasSnapshot) return;
    const cursor = cursors[kind].get(index);
    if (cursor && full.length < cursor.consumed) { reset(); }
  };
  const handleDelta = (kind: Kind, partial: unknown, index: number, raw: string) => {
    const hasSnapshot = record(partial) !== undefined;
    const full = blockText(partial, index, kind);
    noteSnapshot(kind, index, full, hasSnapshot);
    const cursor = cursorFor(kind, index);
    const normalizeArgs = partial as { content?: Array<{ type?: string; text?: string; thinking?: string }> } | undefined;
    /*
     * The snapshot is authoritative only when it lines up with the delta stream: the delta must sit
     * exactly at [consumed, consumed + delta.length). Otherwise (no snapshot, string `partial` from
     * the mock provider, stale snapshot) the delta is genuinely new text appended after everything
     * already emitted.
     */
    const consistent = full.length >= cursor.consumed + raw.length
      && full.slice(cursor.consumed, cursor.consumed + raw.length) === raw;
    if (!consistent) {
      emit(kind, normalizer.normalize(normalizeArgs, index, raw, kind), partial, index);
      cursor.covered += raw.length;
      cursor.consumed = cursor.covered;
      return;
    }
    const alreadyEmitted = Math.min(raw.length, Math.max(0, cursor.covered - cursor.consumed));
    if (alreadyEmitted === 0) emit(kind, normalizer.normalize(normalizeArgs, index, raw, kind), partial, index);
    else if (alreadyEmitted < raw.length) emit(kind, raw.slice(alreadyEmitted), partial, index, true);
    cursor.consumed += raw.length;
    cursor.covered = Math.max(cursor.covered, cursor.consumed);
  };
  return {
    handleAgentEvent(event) {
      try {
        const outer = record(event);
        if (!outer) return;
        if (outer.type === "message_start") { reset(); return; }
        if (outer.type === "message_end") {
          const message = record(outer.message);
          const content = message?.content;
          /*
           * FNXC:AssistantTextCapture 2026-09-08-14:31:
           * pi also emits terminal message events for tool results, whose text is tool output rather than assistant prose.
           * Flush terminal blocks only for assistant messages so chat, logs, and verdict parsing retain assistant-only text.
           */
          if (message?.role === "assistant" && Array.isArray(content)) content.forEach((item, index) => {
            const block = record(item);
            if (block?.type === "text") flush("text", typeof block.text === "string" ? block.text : "", message, index);
            if (block?.type === "thinking") flush("thinking", typeof block.thinking === "string" ? block.thinking : "", message, index);
          });
          reset(); return;
        }
        if (outer.type !== "message_update") return;
        const update = record(outer.assistantMessageEvent);
        if (!update) return;
        const partial = update.partial;
        const index = indexOf(update.contentIndex);
        const type = update.type;
        const kind: Kind | undefined = typeof type === "string" && type.startsWith("text_") ? "text" : typeof type === "string" && type.startsWith("thinking_") ? "thinking" : undefined;
        if (!kind) return;
        if (type === `${kind}_delta`) {
          if (typeof update.delta !== "string" || update.delta === "" || index === undefined) return;
          handleDelta(kind, partial, index, update.delta);
        } else if (type === `${kind}_start`) {
          const full = blockText(partial, index, kind);
          noteSnapshot(kind, index, full, record(partial) !== undefined);
          flush(kind, full, partial, index);
        } else if (type === `${kind}_end`) {
          flush(kind, typeof update.content === "string" ? update.content : "", partial, index);
        }
      } catch { /* Malformed provider events must not break the subscriber. */ }
    },
  };
}
