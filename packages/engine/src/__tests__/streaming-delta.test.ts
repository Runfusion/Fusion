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

  /*
  FNXC:ChatStreaming 2026-08-19-13:52:
  Reconstruct the reported source response through the production normalizer seam. A digit-period-digit split is a token continuation in both labels and URL paths, while a sentence followed by a numeric list still receives its missing space.
  */
  it("preserves numeric dotted versions and URL paths across reported source chunks", () => {
    const chunks = [
      "Sources officielles :\\n\\n[GPT‑5.",
      "6 Luna](https://developers.openai.com/api/docs/models/gpt-5.",
      "6-luna)\\n[GPT‑5.",
      "6 Sol](https://developers.openai.com/api/docs/models/gpt-5.",
      "6-sol)\\n[GPT‑5.",
      "6 Terra](https://developers.openai.com/api/docs/models/gpt-5.",
      "6-terra)",
    ];
    let accumulated = "";
    for (const chunk of chunks) {
      const delta = normalizeStreamingDelta(accumulated, chunk);
      accumulated += delta;
    }

    expect(accumulated).toContain("GPT‑5.6 Luna");
    expect(accumulated).not.toContain("5. 6");
    expect(accumulated).toContain("/gpt-5.6-luna");
    expect(accumulated).toContain("/gpt-5.6-sol");
    expect(accumulated).toContain("/gpt-5.6-terra");
    expect(normalizeStreamingDelta("Done.", "2 more items")).toBe(" 2 more items");
    expect(normalizeStreamingDelta("Version 1.", "2.3 and 192.")).toBe("2.3 and 192.");
    expect(normalizeStreamingDelta("192.", "168.0.1")).toBe("168.0.1");
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

const multiSectionThinkingFixture = "Preamble remains visible.\n\n**Ensuring Docker build includes dev dependencies for tests**\n\nFirst build rationale.\n\nSecond build rationale.\n\n**Planning deployment commit structure**\n\nFirst deployment rationale.\n\nSecond deployment rationale.\n\n**Editing README content**\n\nFirst documentation rationale.\n\nSecond documentation rationale.";

describe("createStreamingDeltaNormalizer", () => {
  it("preserves multi-section thinking byte-for-byte across streamed deltas", () => {
    const normalizer = createStreamingDeltaNormalizer();
    const chunks = [multiSectionThinkingFixture.slice(0, 73), multiSectionThinkingFixture.slice(73, 169), multiSectionThinkingFixture.slice(169)];
    let accumulated = "";
    const output = chunks.map((delta) => {
      accumulated += delta;
      return normalizer.normalize({ content: [{ type: "thinking", thinking: accumulated }] }, 0, delta, "thinking");
    }).join("");
    expect(output).toBe(multiSectionThinkingFixture);
  });

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

  it("preserves numeric dotted tokens through the partial-free fallback tail", () => {
    const normalizer = createStreamingDeltaNormalizer();
    expect(normalizer.normalize(undefined, 0, "GPT-5.", "text")).toBe("GPT-5.");
    expect(normalizer.normalize(undefined, 0, "6", "text")).toBe("6");
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
