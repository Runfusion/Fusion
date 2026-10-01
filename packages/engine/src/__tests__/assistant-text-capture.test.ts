import { describe, expect, it } from "vitest";
import { createAssistantStreamCapture } from "../execution/assistant-text-capture.js";

function capture() {
  const text: string[] = []; const thinking: string[] = []; const boundaries: number[] = [];
  return {
    text,
    thinking,
    boundaries,
    seam: createAssistantStreamCapture({
      onText: (value) => text.push(value),
      onThinking: (value) => thinking.push(value),
      onTextBlockBoundary: () => boundaries.push(1),
    }),
  };
}
function update(assistantMessageEvent: Record<string, unknown>) { return { type: "message_update", assistantMessageEvent }; }

function replayTextBlock(
  result: ReturnType<typeof capture>,
  output: { role: "assistant"; content: Array<Record<string, unknown>> },
  deltas: string[],
  aheadAtStart: number,
) {
  const block = { type: "text", text: "" };
  output.content.push(block);
  block.text = deltas.slice(0, aheadAtStart).join("");
  result.seam.handleAgentEvent(update({ type: "text_start", partial: output, contentIndex: output.content.length - 1 }));
  block.text = deltas.join("");
  for (const delta of deltas) {
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: output, contentIndex: output.content.length - 1, delta }));
  }
  result.seam.handleAgentEvent(update({ type: "text_end", partial: output, contentIndex: output.content.length - 1, content: block.text }));
}

describe("createAssistantStreamCapture", () => {
  it("emits a lock-step text block exactly once", () => {
    const result = capture();
    const output = { role: "assistant" as const, content: [{ type: "thinking", thinking: "x" }] as Array<Record<string, unknown>> };
    const deltas = ["Let", " me", " ground", " this", " in", " the", " tree", " before", " answering."];
    result.seam.handleAgentEvent({ type: "message_start", message: output });
    replayTextBlock(result, output, deltas, 0);
    result.seam.handleAgentEvent({ type: "message_end", message: output });
    expect(result.text.join("")).toBe("Let me ground this in the tree before answering.");
  });

  it("does not replay an ahead mutable partial when queued deltas drain", () => {
    const result = capture();
    const output = { role: "assistant" as const, content: [{ type: "thinking", thinking: "x" }] as Array<Record<string, unknown>> };
    const deltas = ["Let", " me", " ground", " this", " in", " the", " t", "ree", " before", " answering."];
    result.seam.handleAgentEvent({ type: "message_start", message: output });
    replayTextBlock(result, output, deltas, 7);
    result.seam.handleAgentEvent({ type: "message_end", message: output });
    expect(result.text.join("")).toBe("Let me ground this in the tree before answering.");
  });

  it("keeps lagging identifier continuations verbatim", () => {
    const result = capture();
    const output = { role: "assistant" as const, content: [] as Array<Record<string, unknown>> };
    result.seam.handleAgentEvent({ type: "message_start", message: output });
    replayTextBlock(result, output, ["the Input/", "Output", " cards; model_v1/v2 and acmeCloud."], 1);
    result.seam.handleAgentEvent({ type: "message_end", message: output });
    expect(result.text.join("")).toBe("the Input/Output cards; model_v1/v2 and acmeCloud.");
  });

  it("preserves thinking and multiple text block boundaries", () => {
    const result = capture();
    const output = {
      role: "assistant" as const,
      content: [
        { type: "thinking", thinking: "Reason." },
        { type: "text", text: "First." },
        { type: "text", text: "Second." },
      ],
    };
    result.seam.handleAgentEvent({ type: "message_start", message: output });
    result.seam.handleAgentEvent(update({ type: "thinking_delta", partial: output, contentIndex: 0, delta: "Reason." }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: output, contentIndex: 1, delta: "First." }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: output, contentIndex: 2, delta: "Second." }));
    result.seam.handleAgentEvent({ type: "message_end", message: output });
    expect(result.thinking).toEqual(["Reason."]);
    expect(result.text).toEqual(["First.", "Second."]);
    expect(result.boundaries).toEqual([1]);
  });

  it("flushes terminal-only and partial-delta remainders exactly once", () => {
    const result = capture();
    const partial = { role: "assistant", content: [{ type: "text", text: "Hello world" }, { type: "thinking", thinking: "Think" }] };
    result.seam.handleAgentEvent({ type: "message_start", message: partial });
    result.seam.handleAgentEvent(update({ type: "text_start", partial, contentIndex: 0 }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial, contentIndex: 0, delta: "Hello" }));
    result.seam.handleAgentEvent(update({ type: "text_end", partial, contentIndex: 0, content: "Hello world" }));
    result.seam.handleAgentEvent({ type: "message_end", message: partial });
    expect(result.text.join("")).toBe("Hello world");
    expect(result.thinking.join("")).toBe("Think");
  });

  it("resets messages and ignores malformed or tool-result terminal events", () => {
    const result = capture();
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: "mock", contentIndex: 0, delta: "GPT-5." }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: "mock", contentIndex: 0, delta: "6" }));
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: undefined, contentIndex: Number.NaN, delta: "ignored" }));
    result.seam.handleAgentEvent({
      type: "message_end",
      message: { role: "toolResult", content: [{ type: "text", text: "tool output must stay out of assistant text" }] },
    });
    expect(result.text.join("")).toBe("GPT-5.6");
    expect(result.thinking).toEqual([]);
  });
});
