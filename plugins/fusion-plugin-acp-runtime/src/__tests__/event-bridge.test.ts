import { describe, it, expect, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { createEventBridge, PER_TURN_OUTPUT_CAP_CHARS } from "../event-bridge.js";
import type { AcpCallbacks } from "../types.js";

function makeCallbacks() {
  const onText = vi.fn<(text: string) => void>();
  const onThinking = vi.fn<(text: string) => void>();
  const onToolStart = vi.fn<(name: string, args?: unknown) => void>();
  const onToolEnd = vi.fn<(name: string, isError: boolean, result?: unknown) => void>();
  const callbacks: AcpCallbacks = { onText, onThinking, onToolStart, onToolEnd };
  return { callbacks, onText, onThinking, onToolStart, onToolEnd };
}

describe("event bridge: text/thinking", () => {
  it("agent_message_chunk sequence reconstructs the full message via successive onText", () => {
    const { callbacks, onText, onThinking } = makeCallbacks();
    const bridge = createEventBridge(callbacks);

    bridge.handleSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" },
    } as SessionUpdate);
    bridge.handleSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " world." },
    } as SessionUpdate);

    expect(onText).toHaveBeenCalledTimes(2);
    expect(onText.mock.calls.map((c) => c[0]).join("")).toBe("Hello world.");
    expect(onThinking).not.toHaveBeenCalled();
  });

  it("repairs a dropped inter-chunk space between sentence end and capitalized start", () => {
    const { callbacks, onText } = makeCallbacks();
    const bridge = createEventBridge(callbacks);

    bridge.handleSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Done." },
    } as SessionUpdate);
    bridge.handleSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Next step." },
    } as SessionUpdate);

    expect(onText.mock.calls.map((c) => c[0]).join("")).toBe("Done. Next step.");
  });

  it("agent_thought_chunk routes to onThinking, not onText", () => {
    const { callbacks, onText, onThinking } = makeCallbacks();
    const bridge = createEventBridge(callbacks);

    bridge.handleSessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking..." },
    } as SessionUpdate);

    expect(onThinking).toHaveBeenCalledTimes(1);
    expect(onThinking).toHaveBeenCalledWith("thinking...");
    expect(onText).not.toHaveBeenCalled();
  });

  it("ignores user_message_chunk", () => {
    const { callbacks, onText, onThinking } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    bridge.handleSessionUpdate({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "user echo" },
    } as SessionUpdate);
    expect(onText).not.toHaveBeenCalled();
    expect(onThinking).not.toHaveBeenCalled();
  });

  it("ignores non-text content blocks for text extraction", () => {
    const { callbacks, onText } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    bridge.handleSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "abc", mimeType: "image/png" },
    } as unknown as SessionUpdate);
    expect(onText).not.toHaveBeenCalled();
  });
});

describe("event bridge: tool call lifecycle", () => {
  it("tool_call → onToolStart with mapped name + normalized args", () => {
    const { callbacks, onToolStart } = makeCallbacks();
    const bridge = createEventBridge(callbacks);

    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Run tests",
      kind: "execute",
      rawInput: { command: "pnpm test" },
    } as SessionUpdate);

    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(onToolStart).toHaveBeenCalledWith("Run tests", { command: "pnpm test" });
  });

  it("tool_call_update(status:failed) → onToolEnd(isError=true), correlated by toolCallId", () => {
    const { callbacks, onToolStart, onToolEnd } = makeCallbacks();
    const bridge = createEventBridge(callbacks);

    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Run tests",
      kind: "execute",
    } as SessionUpdate);
    // partial update omits title/kind — bridge must carry them forward
    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "failed",
      rawOutput: { exitCode: 1 },
    } as SessionUpdate);

    expect(onToolStart).toHaveBeenCalledWith("Run tests", {});
    expect(onToolEnd).toHaveBeenCalledTimes(1);
    expect(onToolEnd).toHaveBeenCalledWith("Run tests", true, { exitCode: 1 });
  });

  it("intermediate statuses do not fire onToolEnd; completed fires isError=false", () => {
    const { callbacks, onToolEnd } = makeCallbacks();
    const bridge = createEventBridge(callbacks);

    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read file",
      kind: "read",
    } as SessionUpdate);
    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "in_progress",
    } as SessionUpdate);
    expect(onToolEnd).not.toHaveBeenCalled();

    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: "ok",
    } as SessionUpdate);
    expect(onToolEnd).toHaveBeenCalledTimes(1);
    expect(onToolEnd).toHaveBeenCalledWith("Read file", false, "ok");
  });

  it("does not fire onToolEnd twice for repeated terminal updates", () => {
    const { callbacks, onToolEnd } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "X",
    } as SessionUpdate);
    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    } as SessionUpdate);
    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    } as SessionUpdate);
    expect(onToolEnd).toHaveBeenCalledTimes(1);
  });

  it("tool_call_update for an unknown id still resolves a display name (no prior start)", () => {
    const { callbacks, onToolEnd } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    bridge.handleSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "orphan",
      kind: "edit",
      status: "completed",
    } as SessionUpdate);
    expect(onToolEnd).toHaveBeenCalledWith("Edit", false, undefined);
  });
});

describe("event bridge: plan (full replacement)", () => {
  it("two successive plan updates → second fully replaces (no accumulation)", () => {
    const { callbacks, onThinking } = makeCallbacks();
    const bridge = createEventBridge(callbacks);

    bridge.handleSessionUpdate({
      sessionUpdate: "plan",
      entries: [{ content: "Step A", priority: "high", status: "pending" }],
    } as SessionUpdate);
    bridge.handleSessionUpdate({
      sessionUpdate: "plan",
      entries: [
        { content: "Step B", priority: "high", status: "completed" },
        { content: "Step C", priority: "low", status: "pending" },
      ],
    } as SessionUpdate);

    expect(onThinking).toHaveBeenCalledTimes(2);
    const second = onThinking.mock.calls[1][0];
    // Second snapshot reflects only the new entries — no Step A carried over.
    expect(second).toContain("Step B");
    expect(second).toContain("Step C");
    expect(second).not.toContain("Step A");
  });

  it("plan_update does NOT wipe the prior plan (no-op; full plan stays source of truth) (FIX 2)", () => {
    const { callbacks, onThinking } = makeCallbacks();
    const bridge = createEventBridge(callbacks);

    bridge.handleSessionUpdate({
      sessionUpdate: "plan",
      entries: [{ content: "Step A", priority: "high", status: "pending" }],
    } as SessionUpdate);
    // The PlanUpdate variant carries `plan`, not a top-level `entries` array.
    // The bridge must treat it as a no-op rather than firing an empty-plan
    // onThinking that wipes the displayed plan.
    bridge.handleSessionUpdate({
      sessionUpdate: "plan_update",
      plan: { type: "items", items: [] },
    } as unknown as SessionUpdate);

    // Only the `plan` event fired onThinking; plan_update fired nothing.
    expect(onThinking).toHaveBeenCalledTimes(1);
    expect(onThinking.mock.calls[0][0]).toContain("Step A");
  });
});

describe("event bridge: per-turn reset (FIX 1)", () => {
  it("resetTurn clears the output-cap latch so a later turn is not suppressed", () => {
    const { callbacks, onText, onThinking } = makeCallbacks();
    const bridge = createEventBridge(callbacks);

    // Turn 1: flood past the per-turn cap so the latch trips and the truncation
    // flag fires. One oversized chunk is bounded per-chunk, so send enough chunks
    // to cross the cumulative cap.
    const chunk = "y".repeat(50_000);
    const chunksToTrip = Math.ceil(PER_TURN_OUTPUT_CAP_CHARS / chunk.length) + 1;
    for (let i = 0; i < chunksToTrip; i++) {
      bridge.handleSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      } as SessionUpdate);
    }
    // The cap fired exactly one truncation flag via onThinking.
    expect(
      onThinking.mock.calls.some((c) => /output truncated/i.test(String(c[0]))),
    ).toBe(true);

    // After the latch trips, further text on the SAME turn is suppressed.
    const callsAfterTrip = onText.mock.calls.length;
    bridge.handleSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "suppressed" },
    } as SessionUpdate);
    expect(onText.mock.calls.length).toBe(callsAfterTrip);

    // Turn 2: reset, then ordinary text must flow again (latch cleared).
    bridge.reset();
    bridge.handleSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "turn 2 output" },
    } as SessionUpdate);
    expect(onText).toHaveBeenLastCalledWith("turn 2 output");
  });
});

describe("event bridge: tolerance", () => {
  it("ignores an unknown/forward-compat sessionUpdate tag without throwing", () => {
    const { callbacks, onText, onThinking, onToolStart, onToolEnd } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    expect(() =>
      bridge.handleSessionUpdate({ sessionUpdate: "totally_new_thing" } as unknown as SessionUpdate),
    ).not.toThrow();
    expect(onText).not.toHaveBeenCalled();
    expect(onThinking).not.toHaveBeenCalled();
    expect(onToolStart).not.toHaveBeenCalled();
    expect(onToolEnd).not.toHaveBeenCalled();
  });

  it("ignores store-only update tags", () => {
    const { callbacks, onText, onThinking } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    for (const tag of [
      "available_commands_update",
      "current_mode_update",
      "config_option_update",
      "session_info_update",
      "usage_update",
    ]) {
      expect(() =>
        bridge.handleSessionUpdate({ sessionUpdate: tag } as unknown as SessionUpdate),
      ).not.toThrow();
    }
    expect(onText).not.toHaveBeenCalled();
    expect(onThinking).not.toHaveBeenCalled();
  });

  it("does not throw on a malformed tool_call missing toolCallId", () => {
    const { callbacks, onToolStart } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    expect(() =>
      bridge.handleSessionUpdate({
        sessionUpdate: "tool_call",
        title: "no id",
      } as unknown as SessionUpdate),
    ).not.toThrow();
    expect(onToolStart).not.toHaveBeenCalled();
  });

  it("reset() clears correlation state between turns", () => {
    const { callbacks, onText } = makeCallbacks();
    const bridge = createEventBridge(callbacks);
    bridge.handleSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "End." },
    } as SessionUpdate);
    bridge.reset();
    // After reset, leading-capital repair has no prior text to key off — the
    // next chunk emits unmodified.
    bridge.handleSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Start." },
    } as SessionUpdate);
    expect(onText.mock.calls.map((c) => c[0])).toEqual(["End.", "Start."]);
  });
});
