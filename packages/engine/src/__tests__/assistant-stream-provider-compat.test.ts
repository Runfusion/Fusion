import { describe, expect, it } from "vitest";
import { createEventBridge } from "@fusion/pi-claude-cli/src/event-bridge.js";
import { createAssistantStreamCapture } from "../execution/assistant-text-capture.js";
import { REPRO_PREFIX, REPRO_RESPONSE, REPRO_SUFFIX } from "./fixtures/assistant-stream-events.js";

/*
FNXC:AssistantTextCapture 2026-09-15-20:52:
FN-431: the duplicated prefix only reproduces against a REAL provider bridge, because the bridge is
what pushes one shared mutable `partial` object into pi's non-cloning event queue. These cases drive
packages/pi-claude-cli/src/event-bridge.ts (the Anthropic-shaped producer, cloned verbatim by the
Droid runtime bridge) with scripted Claude API events — no CLI, no network, no provider credentials.
*/

/** A queue that behaves like pi's EventStream: events are stored, NOT cloned, and drained later. */
function createLateStream() {
  const queued: unknown[] = [];
  return {
    stream: { push: (event: unknown) => { queued.push(event); }, end: () => {} },
    /** Forwards queued events exactly as the pi agent loop does: wrapped, unchanged. */
    drain(handle: (event: unknown) => void) {
      while (queued.length > 0) handle({ type: "message_update", assistantMessageEvent: queued.shift() });
    },
  };
}

const model = {
  id: "claude-sonnet-4-5-20250929",
  name: "Claude Sonnet 4.5",
  api: "pi-claude-cli",
  provider: "anthropic",
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 8192,
};

function harness() {
  const text: string[] = [];
  const thinking: string[] = [];
  const late = createLateStream();
  const capture = createAssistantStreamCapture({
    onText: (delta) => text.push(delta),
    onThinking: (delta) => thinking.push(delta),
  });
  const bridge = createEventBridge(late.stream as never, model as never);
  bridge.handleEvent({ type: "message_start", message: { usage: {} } } as never);
  return { text, thinking, bridge, drain: () => late.drain(capture.handleAgentEvent) };
}

const textBlockStart = (index: number) => ({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
const textDelta = (index: number, text: string) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const blockStop = (index: number) => ({ type: "content_block_stop", index });

describe("assistant stream capture against real provider bridges", () => {
  it("captures a Claude response once when the start event is drained late", () => {
    const h = harness();
    h.bridge.handleEvent(textBlockStart(0) as never);
    h.bridge.handleEvent(textDelta(0, REPRO_PREFIX) as never);
    h.drain();
    expect(h.text.join("")).toBe(REPRO_PREFIX);

    h.bridge.handleEvent(textDelta(0, REPRO_SUFFIX) as never);
    h.bridge.handleEvent(blockStop(0) as never);
    h.bridge.handleEvent({ type: "message_stop" } as never);
    h.drain();
    expect(h.text.join("")).toBe(REPRO_RESPONSE);
  });

  it("captures the same response when every bridge event is drained immediately", () => {
    const h = harness();
    h.bridge.handleEvent(textBlockStart(0) as never);
    h.drain();
    h.bridge.handleEvent(textDelta(0, REPRO_PREFIX) as never);
    h.drain();
    h.bridge.handleEvent(textDelta(0, REPRO_SUFFIX) as never);
    h.bridge.handleEvent(blockStop(0) as never);
    h.drain();
    expect(h.text.join("")).toBe(REPRO_RESPONSE);
  });

  it("keeps thinking, tool calls, and a second text block distinct", () => {
    const h = harness();
    h.bridge.handleEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } as never);
    h.bridge.handleEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Planning." } } as never);
    h.bridge.handleEvent(blockStop(0) as never);
    h.bridge.handleEvent(textBlockStart(1) as never);
    h.bridge.handleEvent(textDelta(1, REPRO_PREFIX) as never);
    h.drain();
    h.bridge.handleEvent(textDelta(1, REPRO_SUFFIX) as never);
    h.bridge.handleEvent(blockStop(1) as never);
    h.bridge.handleEvent(textBlockStart(2) as never);
    h.bridge.handleEvent(textDelta(2, "Then the follow-up.") as never);
    h.bridge.handleEvent(blockStop(2) as never);
    h.bridge.handleEvent({ type: "message_stop" } as never);
    h.drain();
    expect(h.thinking.join("")).toBe("Planning.");
    // The documented sentence-boundary repair still inserts one space between the two blocks.
    expect(h.text.join("")).toBe(`${REPRO_RESPONSE} Then the follow-up.`);
  });

  it("preserves links, markdown, and intentional repetition from the bridge", () => {
    const h = harness();
    const chunks = ["Check https://example.com/a_b?x=1 ", "and **again**: ", REPRO_PREFIX, REPRO_PREFIX];
    h.bridge.handleEvent(textBlockStart(0) as never);
    for (const chunk of chunks) h.bridge.handleEvent(textDelta(0, chunk) as never);
    h.bridge.handleEvent(blockStop(0) as never);
    h.bridge.handleEvent({ type: "message_stop" } as never);
    h.drain();
    expect(h.text.join("")).toBe(chunks.join(""));
  });

  it("restores a bridge block that produced no delta", () => {
    const h = harness();
    h.bridge.handleEvent(textBlockStart(0) as never);
    h.bridge.handleEvent(blockStop(0) as never);
    h.bridge.handleEvent(textBlockStart(1) as never);
    h.bridge.handleEvent(textDelta(1, REPRO_RESPONSE) as never);
    h.bridge.handleEvent(blockStop(1) as never);
    h.bridge.handleEvent({ type: "message_stop" } as never);
    h.drain();
    expect(h.text.join("")).toBe(REPRO_RESPONSE);
  });

  it("captures two consecutive Claude responses without leaking the first", () => {
    const text: string[] = [];
    const capture = createAssistantStreamCapture({ onText: (delta) => text.push(delta) });
    for (const response of [REPRO_RESPONSE, REPRO_RESPONSE]) {
      const late = createLateStream();
      const bridge = createEventBridge(late.stream as never, model as never);
      bridge.handleEvent({ type: "message_start", message: { usage: {} } } as never);
      bridge.handleEvent(textBlockStart(0) as never);
      bridge.handleEvent(textDelta(0, response) as never);
      bridge.handleEvent(blockStop(0) as never);
      bridge.handleEvent({ type: "message_stop" } as never);
      late.drain(capture.handleAgentEvent);
    }
    expect(text.join("")).toBe(REPRO_RESPONSE + REPRO_RESPONSE);
  });
});
