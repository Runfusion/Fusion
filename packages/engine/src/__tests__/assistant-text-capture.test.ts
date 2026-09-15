import { describe, expect, it } from "vitest";
import { createAssistantStreamCapture } from "../execution/assistant-text-capture.js";
import {
  createAssistantStreamProducer,
  queueReproStream,
  REPRO_PREFIX,
  REPRO_RESPONSE,
  REPRO_SUFFIX,
} from "./fixtures/assistant-stream-events.js";

function capture() {
  const text: string[] = []; const thinking: string[] = []; const boundaries: number[] = [];
  return { text, thinking, boundaries, seam: createAssistantStreamCapture({ onText: (value) => text.push(value), onThinking: (value) => thinking.push(value), onTextBlockBoundary: () => boundaries.push(1) }) };
}
function update(assistantMessageEvent: Record<string, unknown>) { return { type: "message_update", assistantMessageEvent }; }

describe("createAssistantStreamCapture", () => {
  it("captures delta, start, terminal, and message-end text exactly once", () => {
    const result = capture(); const partial = { content: [{ type: "text", text: "Hello" }] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(update({ type: "text_delta", partial, contentIndex: 0, delta: "Hello" }));
    result.seam.handleAgentEvent(update({ type: "text_end", partial, contentIndex: 0, content: "Hello world" }));
    result.seam.handleAgentEvent({ type: "message_end", message: partial });
    expect(result.text.join("")).toBe("Hello world");
  });
  it("flushes populated starts, partial terminal remainders, and message-end-only blocks", () => {
    const result = capture(); const partial = { content: [{ type: "text", text: "Opening sentence." }] };
    result.seam.handleAgentEvent(update({ type: "text_start", partial, contentIndex: 0 }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial, contentIndex: 0, delta: "Next" }));
    expect(result.text).toEqual(["Opening sentence.", " Next"]);
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Message-end text" }] } });
    expect(result.text.at(-1)).toBe("Message-end text");
  });
  it("resets message identity, preserves mock deltas, and ignores malformed blocks", () => {
    const result = capture();
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: "mock", contentIndex: 0, delta: "GPT-5." }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: "mock", contentIndex: 0, delta: "6" }));
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: { content: [{ type: "text", text: "REPRO MARKER B" }] }, contentIndex: 0, delta: "REPRO MARKER B" }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: undefined, contentIndex: Number.NaN, delta: "ignored" }));
    expect(result.text.join("")).toBe("GPT-5.6REPRO MARKER B");
  });
  it("orders message-end text blocks and signals only text boundaries", () => {
    const result = capture(); const message = { role: "assistant", content: [{ type: "text", text: "A" }, { type: "thinking", thinking: "T" }, { type: "toolCall" }, { type: "text", text: "B" }] };
    result.seam.handleAgentEvent({ type: "message_end", message });
    expect(result.text).toEqual(["A", "B"]); expect(result.thinking).toEqual(["T"]); expect(result.boundaries).toEqual([1]);
  });
  it("does not repair first deltas of a new block or message", () => {
    const result = capture(); const first = { content: [{ type: "text", text: "Before." }] }; const second = { content: [{ type: "text", text: "REPRO MARKER B" }] };
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: first, contentIndex: 0, delta: "Before." }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: first, contentIndex: 1, delta: "REPRO MARKER B" }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: second, contentIndex: 0, delta: "REPRO MARKER B" }));
    expect(result.text.slice(-2)).toEqual(["REPRO MARKER B", "REPRO MARKER B"]);
  });
  describe("FN-431 shared mutable snapshots", () => {
    it("emits the response once when the start snapshot already carries the first delta", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      const index = queueReproStream(producer);
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_PREFIX);
      producer.delta("text", index, REPRO_SUFFIX);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_RESPONSE);
      expect(result.text.join("")).not.toBe(REPRO_PREFIX + REPRO_RESPONSE);
    });

    it("emits the same text when every event is consumed immediately", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      producer.drain(result.seam.handleAgentEvent);
      const index = producer.startBlock("text");
      producer.drain(result.seam.handleAgentEvent);
      producer.delta("text", index, REPRO_PREFIX);
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_PREFIX);
      producer.delta("text", index, REPRO_SUFFIX);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_RESPONSE);
    });

    it("emits each burst delta once when the snapshot is several deltas ahead", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      const index = producer.startBlock("text");
      producer.delta("text", index, "alpha ");
      producer.delta("text", index, "beta ");
      producer.delta("text", index, "gamma");
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe("alpha beta gamma");
      producer.delta("text", index, " delta");
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe("alpha beta gamma delta");
    });

    it("produces identical text for copied snapshots without inventing paragraph boundaries", () => {
      const result = capture();
      const producer = createAssistantStreamProducer({ snapshot: "copied" });
      const index = queueReproStream(producer);
      producer.delta("text", index, REPRO_SUFFIX);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_RESPONSE);
      expect(result.boundaries).toEqual([]);
    });

    it("keeps thinking, tools, and a following block separate", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      const thinkingIndex = producer.startBlock("thinking");
      producer.delta("thinking", thinkingIndex, "Considering.");
      const first = producer.startBlock("text");
      producer.delta("text", first, REPRO_PREFIX);
      producer.drain(result.seam.handleAgentEvent);
      producer.delta("text", first, REPRO_SUFFIX);
      producer.endBlock("text", first);
      const second = producer.startBlock("text");
      producer.delta("text", second, "Second block.");
      producer.endBlock("text", second);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.thinking.join("")).toBe("Considering.");
      expect(result.text.join("")).toBe(`${REPRO_RESPONSE}Second block.`);
      expect(result.boundaries).toEqual([1]);
    });

    it("keeps intentional repetition and distinct identical messages", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      const index = producer.startBlock("text");
      producer.delta("text", index, REPRO_PREFIX);
      producer.delta("text", index, REPRO_PREFIX);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_PREFIX + REPRO_PREFIX);

      const next = createAssistantStreamProducer();
      const nextIndex = queueReproStream(next);
      next.endBlock("text", nextIndex);
      next.messageEnd();
      next.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_PREFIX + REPRO_PREFIX + REPRO_PREFIX);
    });

    it("preserves markdown, links, spacing, and surrogate pairs split across deltas", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      const index = producer.startBlock("text");
      const chunks = ["See [docs](https://example.com/a_b?x=1&y=2)", "\n\n- item\n- item\n", "emoji \u{1F680}".slice(0, 7), "\u{1F680}".slice(1), " done"];
      for (const chunk of chunks) producer.delta("text", index, chunk);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(chunks.join(""));
    });

    it("does not reuse cursors from a previous capture instance", () => {
      const first = capture();
      const firstProducer = createAssistantStreamProducer();
      const firstIndex = queueReproStream(firstProducer);
      firstProducer.endBlock("text", firstIndex);
      firstProducer.messageEnd();
      firstProducer.drain(first.seam.handleAgentEvent);
      expect(first.text.join("")).toBe(REPRO_PREFIX);

      const second = capture();
      const secondProducer = createAssistantStreamProducer();
      const secondIndex = queueReproStream(secondProducer);
      secondProducer.endBlock("text", secondIndex);
      secondProducer.messageEnd();
      secondProducer.drain(second.seam.handleAgentEvent);
      expect(second.text.join("")).toBe(REPRO_PREFIX);
    });

    it("restores a block that never receives a delta and ignores replayed terminals", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      const index = producer.startBlock("text");
      producer.message.content[index]!.text = REPRO_RESPONSE;
      producer.endBlock("text", index);
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_RESPONSE);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_RESPONSE);
    });
  });

  it("does not flush tool-result text from production-shaped terminal events", () => {
    const result = capture();
    result.seam.handleAgentEvent({
      type: "message_end",
      message: { role: "toolResult", content: [{ type: "text", text: "tool output must stay out of assistant text" }] },
    });
    expect(result.text).toEqual([]);
    expect(result.thinking).toEqual([]);
  });
});
