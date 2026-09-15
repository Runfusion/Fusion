/*
FNXC:AssistantTextCapture 2026-09-15-20:31:
FN-431 reproduces the "I'll researchI'll research" duplicated prefix without calling a provider.
pi's EventStream queues events without cloning them and Anthropic-shaped producers (pi-ai's
anthropic-messages bridge, packages/pi-claude-cli/src/event-bridge.ts) push the SAME mutable
assistant message object as every event's `partial`. A consumer that drains the queue late
therefore reads a start snapshot that already contains the first delta.
This fixture is transport only: it must never dedupe, clone defensively, or model the fix.
*/

export type StreamBlock = { type: string; text?: string; thinking?: string };
export type PartialAssistantMessage = { role?: string; content: StreamBlock[] };

/** Canonical reproduction strings from the FN-431 report. */
export const REPRO_PREFIX = "I'll research";
export const REPRO_SUFFIX = " the codebase before writing the spec.";
export const REPRO_RESPONSE = REPRO_PREFIX + REPRO_SUFFIX;

export type AssistantStreamProducer = {
  /** The live assistant message. Anthropic-shaped producers share and mutate this object. */
  message: PartialAssistantMessage;
  /** Events already pushed to the stream but not yet consumed. */
  queue: unknown[];
  messageStart(): void;
  startBlock(kind: "text" | "thinking"): number;
  delta(kind: "text" | "thinking", index: number, delta: string): void;
  endBlock(kind: "text" | "thinking", index: number): void;
  messageEnd(): void;
  /** Drains every queued event, in order, into the consumer. */
  drain(handle: (event: unknown) => void): void;
};

function blockValue(block: StreamBlock | undefined, kind: "text" | "thinking"): string {
  if (!block) return "";
  const value = kind === "text" ? block.text : block.thinking;
  return typeof value === "string" ? value : "";
}

function cloneMessage(message: PartialAssistantMessage): PartialAssistantMessage {
  return { role: message.role, content: message.content.map((block) => ({ ...block })) };
}

/**
 * Builds a pi-shaped producer.
 *
 * @param options.snapshot `"shared"` mirrors Anthropic/Claude (one mutable object reused by every
 * event); `"copied"` mirrors providers that emit a fresh snapshot per event. Both are real shapes,
 * so the capture must produce identical text for each.
 */
export function createAssistantStreamProducer(options?: {
  snapshot?: "shared" | "copied";
  role?: string;
}): AssistantStreamProducer {
  const shared = (options?.snapshot ?? "shared") === "shared";
  const message: PartialAssistantMessage = { role: options?.role ?? "assistant", content: [] };
  const queue: unknown[] = [];
  const partialFor = (): PartialAssistantMessage => (shared ? message : cloneMessage(message));
  const push = (assistantMessageEvent: Record<string, unknown>): void => {
    queue.push({ type: "message_update", assistantMessageEvent });
  };
  return {
    message,
    queue,
    messageStart() {
      queue.push({ type: "message_start" });
    },
    startBlock(kind) {
      message.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
      const index = message.content.length - 1;
      push({ type: `${kind}_start`, contentIndex: index, partial: partialFor() });
      return index;
    },
    delta(kind, index, delta) {
      const block = message.content[index];
      if (block) {
        if (kind === "text") block.text = blockValue(block, kind) + delta;
        else block.thinking = blockValue(block, kind) + delta;
      }
      push({ type: `${kind}_delta`, contentIndex: index, delta, partial: partialFor() });
    },
    endBlock(kind, index) {
      push({
        type: `${kind}_end`,
        contentIndex: index,
        content: blockValue(message.content[index], kind),
        partial: partialFor(),
      });
    },
    messageEnd() {
      queue.push({ type: "message_end", message: shared ? message : cloneMessage(message) });
    },
    drain(handle) {
      while (queue.length > 0) handle(queue.shift());
    },
  };
}

/**
 * The exact FN-431 ordering: the text block starts empty, the producer mutates it with the first
 * delta and queues that delta BEFORE the consumer has drained the start event.
 */
export function queueReproStream(producer: AssistantStreamProducer): number {
  producer.messageStart();
  const index = producer.startBlock("text");
  producer.delta("text", index, REPRO_PREFIX);
  return index;
}
