import { describe, it, expect, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  createEventBridge,
  PER_TURN_OUTPUT_CAP_CHARS,
  PER_CHUNK_CAP_CHARS,
  TOOL_CALL_MAP_CAP,
} from "../event-bridge.js";
import type { AcpCallbacks } from "../types.js";

function makeCallbacks() {
  const onText = vi.fn<(text: string) => void>();
  const onThinking = vi.fn<(text: string) => void>();
  const onToolStart = vi.fn<(name: string, args?: unknown) => void>();
  const onToolEnd = vi.fn<(name: string, isError: boolean, result?: unknown) => void>();
  const callbacks: AcpCallbacks = { onText, onThinking, onToolStart, onToolEnd };
  return { callbacks, onText, onThinking, onToolStart, onToolEnd };
}

function textChunk(text: string): SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } as SessionUpdate;
}

describe("event bridge bounds: per-turn cumulative cap (Risk S5)", () => {
  it("stops forwarding text once the per-turn cap is exceeded and flags once", () => {
    const { callbacks, onText, onThinking } = makeCallbacks();
    const bridge = createEventBridge(callbacks);

    // Each chunk is itself within the per-chunk cap; many of them exceed the
    // per-turn cap. Total forwarded text must stay bounded.
    const chunk = "x".repeat(PER_CHUNK_CAP_CHARS);
    const chunksNeeded = Math.ceil(PER_TURN_OUTPUT_CAP_CHARS / PER_CHUNK_CAP_CHARS) + 5;
    for (let i = 0; i < chunksNeeded; i++) {
      bridge.handleSessionUpdate(textChunk(chunk));
    }

    const totalForwarded = onText.mock.calls.reduce((sum, c) => sum + c[0].length, 0);
    // Bounded: never far beyond the cap (one chunk of slack at most).
    expect(totalForwarded).toBeLessThanOrEqual(PER_TURN_OUTPUT_CAP_CHARS + PER_CHUNK_CAP_CHARS);
    expect(totalForwarded).toBeGreaterThan(0);

    // Exactly one truncation flag line emitted via onThinking.
    const flagCalls = onThinking.mock.calls.filter((c) =>
      String(c[0]).includes("output truncated"),
    );
    expect(flagCalls.length).toBe(1);
  });

  it("reset() clears the per-turn counter so a new turn forwards fresh", () => {
    const { callbacks, onText, onThinking } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    const chunk = "y".repeat(PER_CHUNK_CAP_CHARS);
    const chunksNeeded = Math.ceil(PER_TURN_OUTPUT_CAP_CHARS / PER_CHUNK_CAP_CHARS) + 2;
    for (let i = 0; i < chunksNeeded; i++) bridge.handleSessionUpdate(textChunk(chunk));
    onText.mockClear();
    onThinking.mockClear();

    bridge.reset();
    bridge.handleSessionUpdate(textChunk("after reset"));
    expect(onText).toHaveBeenCalledWith("after reset");
  });
});

describe("event bridge bounds: per-chunk cap (Risk S5)", () => {
  it("caps an oversized single content chunk", () => {
    const { callbacks, onText } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    bridge.handleSessionUpdate(textChunk("z".repeat(PER_CHUNK_CAP_CHARS * 4)));
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText.mock.calls[0][0].length).toBeLessThanOrEqual(PER_CHUNK_CAP_CHARS);
  });
});

describe("event bridge sanitization: tool title (Risk S7)", () => {
  it("strips ANSI/control escapes from a tool title before the callback", () => {
    const { callbacks, onToolStart } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "\x1b[31mRun\x1b[0m\x07 tests\x00",
      kind: "execute",
    } as SessionUpdate);

    expect(onToolStart).toHaveBeenCalledTimes(1);
    const name = onToolStart.mock.calls[0][0];
    expect(name).toBe("Run tests");
    expect(name).not.toContain("\x1b");
    expect(name).not.toContain("\x00");
  });

  it("strips control escapes from agent text before onText", () => {
    const { callbacks, onText } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    bridge.handleSessionUpdate(textChunk("\x1b]0;evil\x07hello\x1b[2J"));
    expect(onText).toHaveBeenCalledWith("hello");
  });
});

describe("event bridge bounds: toolCall correlation map (Risk S5)", () => {
  it("bounds the map under a flood of unique toolCallIds (evicts oldest)", () => {
    const { callbacks, onToolStart, onToolEnd } = makeCallbacks();
    const bridge = createEventBridge(callbacks);

    const flood = TOOL_CALL_MAP_CAP * 3;
    for (let i = 0; i < flood; i++) {
      bridge.handleSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: `flood-${i}`,
        title: `T${i}`,
        kind: "other",
      } as SessionUpdate);
    }
    // Every start fires (callbacks not gated), but memory (map) is bounded.
    expect(onToolStart).toHaveBeenCalledTimes(flood);

    // A terminal update for an EVICTED early id still resolves (orphan path),
    // proving the map does not retain all ids. The newest ids remain tracked.
    const newest = flood - 1;
    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: `flood-${newest}`,
      status: "completed",
    } as SessionUpdate);
    expect(onToolEnd).toHaveBeenLastCalledWith(`T${newest}`, false, undefined);
  });

  it("normalizes a path-separator toolCallId used as a map key", () => {
    const { callbacks, onToolStart, onToolEnd } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "../../evil/id",
      title: "Sneaky",
      kind: "other",
    } as SessionUpdate);
    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "../../evil/id",
      status: "completed",
    } as SessionUpdate);
    // Same normalized key correlates start↔end exactly once.
    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(onToolEnd).toHaveBeenCalledTimes(1);
    expect(onToolEnd).toHaveBeenCalledWith("Sneaky", false, undefined);
  });
});
