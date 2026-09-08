import { describe, expect, it } from "vitest";
import { createStreamingDeltaNormalizer, normalizeStreamingDelta, normalizeStreamingDeltaFromEvent } from "../execution/streaming-delta.js";

describe("streaming delta normalization", () => {
  it("repairs punctuation only within supplied evidence", () => {
    expect(normalizeStreamingDelta("Sentence.", "Next")).toBe(" Next");
    expect(normalizeStreamingDelta("GPT-5.", "6")).toBe("6");
    expect(normalizeStreamingDelta("foo.", "bar")).toBe("bar");
  });
  it("emits sibling blocks verbatim", () => {
    const partial = { content: [{ type: "text", text: "task." }, { type: "text", text: "" }] };
    expect(normalizeStreamingDeltaFromEvent(partial, 1, "Let us continue.", "text")).toBe("Let us continue.");
    const thinking = { content: [{ type: "thinking", thinking: "done." }, { type: "thinking", thinking: "" }] };
    expect(normalizeStreamingDeltaFromEvent(thinking, 1, "Next", "thinking")).toBe("Next");
  });
  it("scopes stateful repair to the same content block", () => {
    const normalizer = createStreamingDeltaNormalizer();
    const first = { content: [{ type: "text", text: "Sentence." }] };
    const second = { content: [{ type: "text", text: "Next" }] };
    normalizer.normalize(first, 0, "Sentence.", "text");
    expect(normalizer.normalize(second, 0, "Next", "text")).toBe("Next");
    expect(normalizer.normalize(second, 1, "Next", "text")).toBe("Next");
    expect(normalizer.normalize({ content: [{ type: "text", text: "execution.Foundation" }] }, 0, "Foundation", "text")).toBe(" Foundation");
  });
  it("retains identity-bound verbatim flush evidence", () => {
    const normalizer = createStreamingDeltaNormalizer(); const partial = { content: [{ type: "text", text: "Opening sentence." }] }; const other = { content: [{ type: "text", text: "Next" }] };
    normalizer.noteEmitted("text", "Opening sentence.", partial, 0);
    expect(normalizer.normalize(partial, 0, "Next", "text")).toBe(" Next");
    expect(normalizer.normalize(other, 0, "Next", "text")).toBe("Next");
    normalizer.noteEmitted("text", "Opening sentence.", partial, 0);
    expect(normalizer.normalize(partial, 1, "Next", "text")).toBe("Next");
  });
  it("keeps partial-free streams and kinds isolated", () => {
    const normalizer = createStreamingDeltaNormalizer();
    expect(normalizer.normalize(undefined, 0, "GPT-5.", "text")).toBe("GPT-5.");
    expect(normalizer.normalize(undefined, 0, "6", "text")).toBe("6");
    normalizer.noteEmitted("text", "Sentence.");
    expect(normalizer.normalize(undefined, 0, "Next", "text")).toBe(" Next");
    normalizer.noteBoundary("text");
    expect(normalizer.normalize(undefined, 0, "Next", "text")).toBe("Next");
    normalizer.noteEmitted("thinking", "Reason.", undefined, 0);
    expect(normalizer.normalize(undefined, 0, "Next", "text")).toBe("Next");
  });
  it("is defensive for invalid payloads", () => {
    const normalizer = createStreamingDeltaNormalizer();
    expect(normalizer.normalize(undefined, Number.NaN, "Foundation", "text")).toBe("Foundation");
    expect(normalizeStreamingDeltaFromEvent({ content: [{ type: "thinking", thinking: "x" }] }, 0, "Foundation", "text")).toBe("Foundation");
  });
});
