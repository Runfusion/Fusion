import { createStreamingDeltaNormalizer } from "./streaming-delta.js";

type Kind = "text" | "thinking";
type CaptureSinks = {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onTextBlockBoundary?: () => void;
};

type EventRecord = Record<string, unknown>;

function record(value: unknown): EventRecord | undefined {
  return value !== null && typeof value === "object" ? value as EventRecord : undefined;
}

function indexOf(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Captures every pi assistant block shape while retaining exact-once offsets. */
export function createAssistantStreamCapture(sinks: CaptureSinks): { handleAgentEvent(event: unknown): void } {
  const normalizer = createStreamingDeltaNormalizer();
  const emitted: Record<Kind, Map<number, number>> = { text: new Map(), thinking: new Map() };
  const seen: Record<Kind, Map<number, number>> = { text: new Map(), thinking: new Map() };
  let lastPartial: object | undefined;
  let lastTextPartial: unknown;
  let lastTextIndex: number | undefined;
  let sawText = false;
  const reset = () => {
    emitted.text.clear(); emitted.thinking.clear();
    seen.text.clear(); seen.thinking.clear();
    normalizer.noteBoundary("text"); normalizer.noteBoundary("thinking");
    lastPartial = undefined;
  };
  const emit = (kind: Kind, text: string, partial: unknown, index: number | undefined, verbatim = false) => {
    if (!text) return;
    if (kind === "text") {
      if (sawText && (partial !== lastTextPartial || index !== lastTextIndex)) sinks.onTextBlockBoundary?.();
      sinks.onText?.(text);
      sawText = true; lastTextPartial = partial; lastTextIndex = index;
    } else sinks.onThinking?.(text);
    if (verbatim) normalizer.noteEmitted(kind, text, partial, index);
  };
  const flush = (kind: Kind, text: string, partial: unknown, index: number | undefined) => {
    if (index === undefined || !text) return;
    const prior = emitted[kind].get(index) ?? 0;
    const remainder = text.slice(prior);
    if (remainder) emit(kind, remainder, partial, index, true);
    emitted[kind].set(index, text.length);
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
        const partialObject = partial !== null && typeof partial === "object" ? partial as object : undefined;
        if (partialObject && lastPartial && partialObject !== lastPartial) reset();
        if (partialObject) lastPartial = partialObject;
        const index = indexOf(update.contentIndex);
        const type = update.type;
        const kind: Kind | undefined = typeof type === "string" && type.startsWith("text_") ? "text" : typeof type === "string" && type.startsWith("thinking_") ? "thinking" : undefined;
        if (!kind) return;
        if (type === `${kind}_delta`) {
          if (typeof update.delta !== "string" || index === undefined) return;
          /*
           * FNXC:AssistantTextCapture 2026-09-22-02:30:
           * Provider queues can retain a mutable partial long after a delta was produced. Advance
           * source cursors only from queued deltas so a later-mutated block cannot replay its prefix.
           */
          const seenBefore = seen[kind].get(index) ?? 0;
          const seenAfter = seenBefore + update.delta.length;
          const emittedBefore = emitted[kind].get(index) ?? 0;
          const sourceSegment = update.delta.slice(Math.max(0, emittedBefore - seenBefore));
          if (sourceSegment) {
            const delta = normalizer.normalize(partial as { content?: Array<{ type?: string; text?: string; thinking?: string }> } | undefined, index, sourceSegment, kind);
            emit(kind, delta, partial, index);
          }
          seen[kind].set(index, seenAfter);
          emitted[kind].set(index, Math.max(emittedBefore, seenAfter));
        } else if (type === `${kind}_start`) {
          // A mutable partial is not an event-time snapshot; terminal events recover missing deltas.
        } else if (type === `${kind}_end`) {
          flush(kind, typeof update.content === "string" ? update.content : "", partial, index);
        }
      } catch { /* Malformed provider events must not break the subscriber. */ }
    },
  };
}
