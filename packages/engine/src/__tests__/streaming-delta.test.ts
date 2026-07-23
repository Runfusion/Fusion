import { describe, expect, it } from "vitest";
import {
  createStreamingDeltaNormalizer,
  normalizeStreamingDelta,
  normalizeStreamingDeltaFromEvent,
} from "../execution/streaming-delta.js";

describe("normalizeStreamingDelta", () => {
  it("repairs period + uppercase sentence boundaries across deltas", () => {
    expect(normalizeStreamingDelta("Let's compare them.", "Good overview.")).toBe(" Good overview.");
  });

  it("repairs punctuation boundaries for quoted, bracketed, and numeric starts", () => {
    expect(normalizeStreamingDelta("Done.", "\"Quoted\"")).toBe(" \"Quoted\"");
    expect(normalizeStreamingDelta("Great!", "(Next)")).toBe(" (Next)");
    expect(normalizeStreamingDelta("Ready?", "[Checklist]")).toBe(" [Checklist]");
    expect(normalizeStreamingDelta("Phase complete.", "2 more items")).toBe(" 2 more items");
    expect(normalizeStreamingDelta("Ready.", "'Single quote start'"))
      .toBe(" 'Single quote start'");
  });

  it("does not alter lowercase continuations or property access", () => {
    expect(normalizeStreamingDelta("foo.", "bar")).toBe("bar");
    expect(normalizeStreamingDelta("obj", ".prop")).toBe(".prop");
  });

  it("is idempotent when whitespace already exists", () => {
    expect(normalizeStreamingDelta("...task.", " Foundation")).toBe(" Foundation");
  });
});

describe("normalizeStreamingDeltaFromEvent", () => {
  it("derives previous text from same text block across deltas", () => {
    const partial = {
      content: [
        { type: "text", text: "execution.Foundation" },
      ],
    };

    expect(normalizeStreamingDeltaFromEvent(partial, 0, "Foundation", "text")).toBe(" Foundation");
  });

  it("repairs cross-block text boundaries when current block is empty", () => {
    const partial = {
      content: [
        { type: "text", text: "task." },
        { type: "text", text: "" },
      ],
    };

    expect(normalizeStreamingDeltaFromEvent(partial, 1, "Let us continue.", "text")).toBe(" Let us continue.");
  });

  it("repairs thinking deltas across thinking blocks", () => {
    const partial = {
      content: [
        { type: "thinking", thinking: "render." },
        { type: "thinking", thinking: "" },
      ],
    };

    expect(normalizeStreamingDeltaFromEvent(partial, 1, "Done", "thinking")).toBe(" Done");
  });

  it("returns delta unchanged for defensive edge cases", () => {
    expect(normalizeStreamingDeltaFromEvent(undefined, 0, "Foundation", "text")).toBe("Foundation");

    const outOfRange = { content: [{ type: "text", text: "execution" }] };
    expect(normalizeStreamingDeltaFromEvent(outOfRange, 3, "Foundation", "text")).toBe("Foundation");

    const wrongType = { content: [{ type: "thinking", thinking: "execution." }] };
    expect(normalizeStreamingDeltaFromEvent(wrongType, 0, "Foundation", "text")).toBe("Foundation");
  });

  it("matches wiring payload shape for execution.Foundation event forwarding", () => {
    const msgEvent = {
      contentIndex: 0,
      delta: "Foundation",
      partial: {
        content: [{ type: "text", text: "execution.Foundation" }],
      },
    };

    expect(
      normalizeStreamingDeltaFromEvent(msgEvent.partial, msgEvent.contentIndex, msgEvent.delta, "text"),
    ).toBe(" Foundation");
  });
});

describe("createStreamingDeltaNormalizer", () => {
  it("repairs punctuation boundaries across separate assistant messages", () => {
    const normalizer = createStreamingDeltaNormalizer();

    normalizer.normalize(
      { content: [{ type: "text", text: "create the foundation task." }] },
      0,
      "create the foundation task.",
      "text",
    );
    expect(
      normalizer.normalize({ content: [{ type: "text", text: "Foundation" }] }, 0, "Foundation", "text"),
    ).toBe(" Foundation");

    normalizer.normalize({ content: [{ type: "text", text: "dependent tasks." }] }, 0, "dependent tasks.", "text");
    expect(normalizer.normalize({ content: [{ type: "text", text: "Let me add" }] }, 0, "Let me add", "text"))
      .toBe(" Let me add");

    normalizer.normalize({ content: [{ type: "text", text: "render." }] }, 0, "render.", "text");
    expect(normalizer.normalize({ content: [{ type: "text", text: "Done. Filed 5" }] }, 0, "Done. Filed 5", "text"))
      .toBe(" Done. Filed 5");
  });

  it("preserves same-message behavior and lower-case/property continuations", () => {
    const normalizer = createStreamingDeltaNormalizer();
    expect(
      normalizer.normalize(
        {
          content: [
            { type: "text", text: "task." },
            { type: "text", text: "" },
          ],
        },
        1,
        "Let us continue.",
        "text",
      ),
    ).toBe(" Let us continue.");

    expect(normalizer.normalize({ content: [{ type: "text", text: "obj.prop" }] }, 0, ".prop", "text")).toBe(".prop");
    expect(normalizer.normalize({ content: [{ type: "text", text: "foo.bar" }] }, 0, "bar", "text")).toBe("bar");
  });

  it("is idempotent when incoming deltas already start with whitespace", () => {
    const normalizer = createStreamingDeltaNormalizer();
    normalizer.normalize({ content: [{ type: "text", text: "...task." }] }, 0, "...task.", "text");
    expect(normalizer.normalize({ content: [{ type: "text", text: " Foundation" }] }, 0, " Foundation", "text"))
      .toBe(" Foundation");
  });

  it("does not leak tails across text/thinking kinds", () => {
    const thinkingFirst = createStreamingDeltaNormalizer();
    thinkingFirst.normalize({ content: [{ type: "thinking", thinking: "reason." }] }, 0, "reason.", "thinking");
    expect(thinkingFirst.normalize({ content: [{ type: "text", text: "Foundation" }] }, 0, "Foundation", "text"))
      .toBe("Foundation");

    const textFirst = createStreamingDeltaNormalizer();
    textFirst.normalize({ content: [{ type: "text", text: "task." }] }, 0, "task.", "text");
    expect(textFirst.normalize({ content: [{ type: "thinking", thinking: "Done" }] }, 0, "Done", "thinking"))
      .toBe("Done");
  });

  it("starts fresh per instance", () => {
    const normalizer = createStreamingDeltaNormalizer();
    expect(normalizer.normalize(undefined, 0, "Foundation", "text")).toBe("Foundation");
  });

  it("is defensive for invalid partial/content index and wrong block type", () => {
    const normalizer = createStreamingDeltaNormalizer();
    expect(normalizer.normalize(undefined, 0, "Foundation", "text")).toBe("Foundation");
    expect(normalizer.normalize({ content: [{ type: "text", text: "execution" }] }, 8, "Foundation", "text"))
      .toBe("Foundation");
    expect(normalizer.normalize({ content: [{ type: "thinking", thinking: "execution." }] }, 0, "Foundation", "text"))
      .toBe("Foundation");

    normalizer.normalize({ content: [{ type: "text", text: "task." }] }, 0, "task.", "text");
    expect(normalizer.normalize(undefined, Number.NaN, "Foundation", "text")).toBe(" Foundation");
  });
});
