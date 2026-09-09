import { describe, expect, it } from "vitest";
import { createAssistantStreamCapture } from "../execution/assistant-text-capture.js";

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
