import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
  calculateCost: vi.fn(),
}));

import { createEventBridge } from "../event-bridge.js";

function createMockStream() {
  const events: unknown[] = [];
  return {
    push: vi.fn((event: unknown) => events.push(event)),
    end: vi.fn(),
    events,
  };
}

function createMockModel() {
  return {
    id: "droid-pro",
    name: "Droid Pro",
    api: "droid-cli",
    provider: "droid-cli",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

describe("droid event bridge streaming delta normalization", () => {
  let stream: ReturnType<typeof createMockStream>;
  let model: ReturnType<typeof createMockModel>;

  beforeEach(() => {
    stream = createMockStream();
    model = createMockModel();
    vi.clearAllMocks();
  });

  function createBridgeWithStart() {
    const bridge = createEventBridge(stream as any, model as any);
    bridge.handleEvent({ type: "message_start", message: { usage: {} } } as any);
    stream.push.mockClear();
    stream.events.length = 0;
    return bridge;
  }

  it("repairs a missing sentence boundary across text deltas", () => {
    const bridge = createBridgeWithStart();

    bridge.handleEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "compare them." } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Good overview." } } as any);

    const output = bridge.getOutput();
    expect((output.content[0] as any).text).toBe("compare them. Good overview.");
    expect(stream.events[2]).toEqual(expect.objectContaining({ type: "text_delta", delta: " Good overview." }));
  });

  /*
  FNXC:ChatStreaming 2026-08-19-13:52:
  Classify numeric period boundaries before the Droid bridge appends or emits deltas so source labels and URL paths stay valid in Chat.
  */
  it("preserves the reported dotted model links across text deltas", () => {
    const bridge = createBridgeWithStart();
    bridge.handleEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any);
    for (const text of [
      "[GPT‑5.",
      "6 Luna](https://developers.openai.com/api/docs/models/gpt-5.",
      "6-luna) [GPT‑5.",
      "6 Sol](https://developers.openai.com/api/docs/models/gpt-5.",
      "6-sol) [GPT‑5.",
      "6 Terra](https://developers.openai.com/api/docs/models/gpt-5.",
      "6-terra)",
    ]) {
      bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as any);
    }

    const output = bridge.getOutput();
    const text = (output.content[0] as any).text as string;
    expect(text).toContain("GPT‑5.6 Luna");
    expect(text).not.toContain("5. 6");
    expect(text).toContain("/gpt-5.6-luna");
    expect(text).toContain("/gpt-5.6-sol");
    expect(text).toContain("/gpt-5.6-terra");
  });

  it("repairs a missing sentence boundary between consecutive text blocks", () => {
    const bridge = createBridgeWithStart();

    bridge.handleEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "compare them." } } as any);
    bridge.handleEvent({ type: "content_block_stop", index: 0 } as any);
    bridge.handleEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Good overview." } } as any);

    const output = bridge.getOutput();
    const combinedText = output.content
      .filter((content): content is any => content.type === "text")
      .map((content: any) => content.text)
      .join("");

    expect(combinedText).toBe("compare them. Good overview.");
    expect(stream.events[4]).toEqual(expect.objectContaining({ type: "text_delta", contentIndex: 1, delta: " Good overview." }));
  });

  it("repairs a missing sentence boundary between thinking deltas", () => {
    const bridge = createBridgeWithStart();

    bridge.handleEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "task." } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let us continue." } } as any);

    const output = bridge.getOutput();
    expect((output.content[0] as any).thinking).toBe("task. Let us continue.");
    expect(stream.events[2]).toEqual(expect.objectContaining({ type: "thinking_delta", delta: " Let us continue." }));
  });

  it("does not insert spaces into lowercase continuations or property access", () => {
    const bridge = createBridgeWithStart();

    bridge.handleEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "obj" } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ".prop" } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " foo." } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "bar" } } as any);

    const output = bridge.getOutput();
    expect((output.content[0] as any).text).toBe("obj.prop foo.bar");
    expect(stream.events[2]).toEqual(expect.objectContaining({ type: "text_delta", delta: ".prop" }));
    expect(stream.events[4]).toEqual(expect.objectContaining({ type: "text_delta", delta: "bar" }));
  });

  it("does not double-insert when space already exists at boundary", () => {
    const bridge = createBridgeWithStart();

    bridge.handleEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "render." } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " Done" } } as any);
    bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " Next." } } as any);

    const output = bridge.getOutput();
    expect((output.content[0] as any).text).toBe("render. Done Next.");
    expect(stream.events[2]).toEqual(expect.objectContaining({ type: "text_delta", delta: " Done" }));
  });
});
