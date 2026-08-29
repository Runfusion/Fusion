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
    // but its `tool_call` metadata is gone, so the title falls back to the
    // generic "tool" — proving the map did NOT retain the earliest ids.
    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "flood-0",
      status: "completed",
    } as SessionUpdate);
    expect(onToolEnd).toHaveBeenLastCalledWith("tool", false, undefined);

    // The newest ids remain tracked, so their title is carried forward.
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
    // The update uses a DIFFERENT raw id (backslashes) that normalizes to the
    // SAME key as the start's forward-slash id. Raw-key storage would miss the
    // correlation; only normalization makes start↔end line up — proving the
    // bridge keys on the normalized form, not the raw string.
    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "..\\..\\evil\\id",
      status: "completed",
    } as SessionUpdate);
    // Same normalized key correlates start↔end exactly once.
    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(onToolEnd).toHaveBeenCalledTimes(1);
    expect(onToolEnd).toHaveBeenCalledWith("Sneaky", false, undefined);
  });
});

describe("plan output bounds (S5)", () => {
  it("caps plan entry count and charges the per-turn budget", async () => {
    const { createEventBridge, MAX_PLAN_ENTRIES, PER_TURN_OUTPUT_CAP_CHARS } = await import(
      "../event-bridge.js"
    );
    const thinking: string[] = [];
    const bridge = createEventBridge({ onThinking: (t) => thinking.push(t) });
    const entries = Array.from({ length: MAX_PLAN_ENTRIES + 50 }, (_, i) => ({
      content: `step ${i}`,
      priority: "low",
      status: "pending",
    }));
    bridge.handleSessionUpdate({ sessionUpdate: "plan", entries } as never);
    expect(thinking).toHaveLength(1);
    // Truncation marker present; not all entries formatted.
    expect(thinking[0]).toContain("50 more entries truncated");
    expect(thinking[0].length).toBeLessThan(PER_TURN_OUTPUT_CAP_CHARS);
  });

  it("suppresses plan output once the per-turn cap has flagged", async () => {
    const { createEventBridge, PER_CHUNK_CAP_CHARS, PER_TURN_OUTPUT_CAP_CHARS } = await import(
      "../event-bridge.js"
    );
    const thinking: string[] = [];
    const bridge = createEventBridge({ onThinking: (t) => thinking.push(t) });
    // Flood text until the per-turn cap flags.
    const chunk = "x".repeat(PER_CHUNK_CAP_CHARS);
    const chunksNeeded = Math.ceil(PER_TURN_OUTPUT_CAP_CHARS / PER_CHUNK_CAP_CHARS) + 2;
    for (let i = 0; i < chunksNeeded; i += 1) {
      bridge.handleSessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: chunk },
      } as never);
    }
    const before = thinking.length;
    bridge.handleSessionUpdate({
      sessionUpdate: "plan",
      entries: [{ content: "late plan", priority: "low", status: "pending" }],
    } as never);
    // No plan line after the cap flagged.
    expect(thinking.length).toBe(before);
  });
});

  // Generous timeout: this test does CPU-bound string flooding (~25 plan
  // events x 100 entries x 2k chars) and has timed out at the default 5s
  // under loaded CI shards while passing easily in isolation.
  it("a plan-ONLY stream stops emitting once the per-turn cap is crossed", { timeout: 20_000 }, async () => {
    const { createEventBridge, PER_CHUNK_CAP_CHARS, PER_TURN_OUTPUT_CAP_CHARS, MAX_PLAN_ENTRIES } =
      await import("../event-bridge.js");
    const thinking: string[] = [];
    const bridge = createEventBridge({ onThinking: (t) => thinking.push(t) });
    // Each plan line is bounded by PER_CHUNK_CAP_CHARS; flood plan events only.
    const bigEntry = "p".repeat(PER_CHUNK_CAP_CHARS);
    const entries = Array.from({ length: MAX_PLAN_ENTRIES }, () => ({
      content: bigEntry,
      priority: "low",
      status: "pending",
    }));
    const floods = Math.ceil(PER_TURN_OUTPUT_CAP_CHARS / PER_CHUNK_CAP_CHARS) + 3;
    for (let i = 0; i < floods; i += 1) {
      bridge.handleSessionUpdate({ sessionUpdate: "plan", entries } as never);
    }
    // The flag line is emitted exactly once, then nothing further.
    const flagged = thinking.filter((t) => t.includes("output truncated"));
    expect(flagged).toHaveLength(1);
    const after = thinking.length;
    bridge.handleSessionUpdate({ sessionUpdate: "plan", entries } as never);
    expect(thinking.length).toBe(after);
    // And the total emitted is bounded near the cap, not floods * cap.
    expect(thinking.length).toBeLessThan(floods);
  });
