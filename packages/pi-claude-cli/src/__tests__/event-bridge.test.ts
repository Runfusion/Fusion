import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @mariozechner/pi-ai before importing event-bridge
vi.mock("@mariozechner/pi-ai", () => ({
  calculateCost: vi.fn(),
}));

import { createEventBridge } from "../event-bridge";
import { calculateCost } from "@mariozechner/pi-ai";

// Helper: create a mock stream that captures pushed events
function createMockStream() {
  const events: unknown[] = [];
  return {
    push: vi.fn((event: unknown) => events.push(event)),
    end: vi.fn(),
    events,
  };
}

// Helper: create a minimal mock model
function createMockModel() {
  return {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    api: "pi-claude-cli",
    provider: "anthropic",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

describe("createEventBridge", () => {
  let stream: ReturnType<typeof createMockStream>;
  let model: ReturnType<typeof createMockModel>;

  beforeEach(() => {
    stream = createMockStream();
    model = createMockModel();
    vi.clearAllMocks();
  });

  // Helper: create bridge and trigger the initial "start" event so tests
  // don't need to account for it in their push call counts.
  function createBridgeWithStart() {
    const bridge = createEventBridge(stream as any, model as any);
    // Trigger start event via message_start
    bridge.handleEvent({ type: "message_start", message: { usage: {} } });
    stream.push.mockClear();
    stream.events.length = 0;
    return bridge;
  }

  it("pushes start event on first handleEvent call", () => {
    const bridge = createEventBridge(stream as any, model as any);
    bridge.handleEvent({ type: "message_start", message: { usage: {} } });

    expect(stream.push).toHaveBeenCalledWith(
      expect.objectContaining({ type: "start" }),
    );
  });

  describe("text content block streaming", () => {
    it("pushes text_start on content_block_start with text type", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("text_start");
      expect(event.contentIndex).toBe(0);
    });

    it("pushes text_delta on content_block_delta with text_delta type", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      });

      expect(stream.push).toHaveBeenCalledTimes(2);
      const event = stream.events[1] as any;
      expect(event.type).toBe("text_delta");
      expect(event.contentIndex).toBe(0);
      expect(event.delta).toBe("Hello");
    });

    it("pushes text_end on content_block_stop with accumulated text", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      expect(stream.push).toHaveBeenCalledTimes(4);
      const event = stream.events[3] as any;
      expect(event.type).toBe("text_end");
      expect(event.contentIndex).toBe(0);
      expect(event.content).toBe("Hello world");
    });
  });

  describe("multiple text blocks", () => {
    it("tracks multiple text blocks independently", () => {
      const bridge = createBridgeWithStart();

      // Block 0
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "First" },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      // Block 1
      bridge.handleEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Second" },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 1,
      });

      // Verify block 0
      const textEnd0 = stream.events[2] as any;
      expect(textEnd0.type).toBe("text_end");
      expect(textEnd0.contentIndex).toBe(0);
      expect(textEnd0.content).toBe("First");

      // Verify block 1
      const textStart1 = stream.events[3] as any;
      expect(textStart1.type).toBe("text_start");
      expect(textStart1.contentIndex).toBe(1);

      const textEnd1 = stream.events[5] as any;
      expect(textEnd1.type).toBe("text_end");
      expect(textEnd1.contentIndex).toBe(1);
      expect(textEnd1.content).toBe("Second");
    });
  });

  describe("message_start usage tracking", () => {
    it("captures initial usage from message_start", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 25,
          },
        },
      });

      const output = bridge.getOutput();
      expect(output.usage.input).toBe(100);
      expect(output.usage.output).toBe(0);
      expect(output.usage.cacheRead).toBe(50);
      expect(output.usage.cacheWrite).toBe(25);
      expect(output.usage.totalTokens).toBe(175);
      expect(calculateCost).toHaveBeenCalled();
    });

    it("defaults missing usage fields to 0", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 50,
            // output_tokens, cache_read_input_tokens, cache_creation_input_tokens all missing
          },
        },
      });

      const output = bridge.getOutput();
      expect(output.usage.input).toBe(50);
      expect(output.usage.output).toBe(0);
      expect(output.usage.cacheRead).toBe(0);
      expect(output.usage.cacheWrite).toBe(0);
      expect(output.usage.totalTokens).toBe(50);
    });
  });

  describe("message_delta handling", () => {
    it("captures stop_reason from message_delta", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 42 },
      });

      const output = bridge.getOutput();
      expect(output.stopReason).toBe("stop");
    });

    it("updates usage from message_delta", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 0,
          },
        },
      });
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 42 },
      });

      const output = bridge.getOutput();
      expect(output.usage.output).toBe(42);
      expect(output.usage.totalTokens).toBe(142);
    });
  });

  describe("message_stop (no-op, done pushed by provider)", () => {
    it("does not push done (provider pushes it after readline closes)", () => {
      const bridge = createEventBridge(stream as any, model as any);

      bridge.handleEvent({
        type: "message_start",
        message: { usage: { input_tokens: 100, output_tokens: 0 } },
      });
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello world" },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      });
      bridge.handleEvent({
        type: "message_stop",
      });

      // No done event from event bridge (provider handles it after readline closes)
      const doneEvent = stream.events.find((e: any) => e.type === "done");
      expect(doneEvent).toBeUndefined();
      expect(stream.end).not.toHaveBeenCalled();

      // Output state is correct for provider to use
      const output = bridge.getOutput();
      expect(output.content).toHaveLength(1);
      expect((output.content[0] as any).text).toBe("Hello world");
      expect(output.stopReason).toBe("stop");
    });
  });

  describe("stop reason mapping", () => {
    it("maps end_turn to stop", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      });
      expect(bridge.getOutput().stopReason).toBe("stop");
    });

    it("maps max_tokens to length", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
      });
      expect(bridge.getOutput().stopReason).toBe("length");
    });

    it("maps tool_use to toolUse", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      });
      expect(bridge.getOutput().stopReason).toBe("toolUse");
    });

    it("maps unknown stop reasons to stop", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "something_else" },
      });
      expect(bridge.getOutput().stopReason).toBe("stop");
    });
  });

  describe("tool_use content block streaming", () => {
    it("pushes toolcall_start with mapped pi name on content_block_start", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_01ABC", name: "Read" },
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_start");
      expect(event.contentIndex).toBe(0);
      // Tool name should be mapped from Claude "Read" to pi "read"
      expect(event.partial.content[0].name).toBe("read");
    });

    it("pushes toolcall_delta with raw JSON fragment on input_json_delta", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_01ABC", name: "Read" },
      });
      stream.push.mockClear();
      stream.events.length = 0;

      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_' },
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_delta");
      expect(event.delta).toBe('{"file_');
      expect(event.contentIndex).toBe(0);
    });

    it("accumulates partial JSON across multiple deltas", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_01ABC", name: "Read" },
      });

      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_' },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'path": "/foo.ts"}' },
      });

      // After full JSON is accumulated, the output content should have parsed args
      const output = bridge.getOutput();
      const toolCall = output.content[0] as any;
      expect(toolCall.type).toBe("toolCall");
      // Arguments should be updated as JSON becomes parseable
      expect(toolCall.arguments).toEqual({ file_path: "/foo.ts" });
    });

    it("pushes toolcall_end with fully parsed and argument-mapped ToolCall on block_stop", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_01ABC", name: "Read" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"file_path": "/foo.ts"}',
        },
      });
      stream.push.mockClear();
      stream.events.length = 0;

      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_end");
      expect(event.contentIndex).toBe(0);
      expect(event.toolCall.type).toBe("toolCall");
      expect(event.toolCall.id).toBe("toolu_01ABC");
      expect(event.toolCall.name).toBe("read");
      // Claude's "file_path" should be mapped to pi's "path"
      expect(event.toolCall.arguments).toEqual({ path: "/foo.ts" });
    });

    it("emits {} for parameterless MCP tool calls (no input_json_delta)", () => {
      // Parameterless MCP tools (e.g. fn_review_spec, schema
      // {type:"object", properties:{}}) emit ZERO input_json_delta events.
      // Without the empty-partialJson guard, finalArgs would fall through to
      // the raw-string fallback ("") and pi's TypeBox validator would reject
      // the call with "Validation failed for tool ...: root: must be object".
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_01XYZ",
          name: "mcp__custom-tools__fn_review_spec",
        },
      });
      // No content_block_delta with input_json_delta — Claude emits none for
      // parameterless tools.
      stream.push.mockClear();
      stream.events.length = 0;

      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_end");
      expect(event.toolCall.arguments).toEqual({});
      // The MCP prefix should be stripped: pi sees the bare tool name.
      expect(event.toolCall.name).toBe("fn_review_spec");
    });

    it("tracks multiple tool_use blocks independently by Claude event.index", () => {
      const bridge = createBridgeWithStart();

      // Tool block at index 0
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_01", name: "Read" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"file_path": "/a.ts"}',
        },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      // Tool block at index 1
      bridge.handleEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_02", name: "Write" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"file_path": "/b.ts", "content": "hello"}',
        },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 1,
      });

      // Find toolcall_end events
      const endEvents = stream.events.filter(
        (e: any) => e.type === "toolcall_end",
      ) as any[];
      expect(endEvents).toHaveLength(2);
      expect(endEvents[0].toolCall.id).toBe("toolu_01");
      expect(endEvents[0].toolCall.name).toBe("read");
      expect(endEvents[0].toolCall.arguments).toEqual({ path: "/a.ts" });
      expect(endEvents[1].toolCall.id).toBe("toolu_02");
      expect(endEvents[1].toolCall.name).toBe("write");
      expect(endEvents[1].toolCall.arguments).toEqual({
        path: "/b.ts",
        content: "hello",
      });
    });

    it("tracks tool_use block interleaved with text block correctly", () => {
      const bridge = createBridgeWithStart();

      // Text block at index 0
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Let me read that file." },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      // Tool block at index 1
      bridge.handleEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_01", name: "Read" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"file_path": "/foo.ts"}',
        },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 1,
      });

      const output = bridge.getOutput();
      expect(output.content).toHaveLength(2);
      expect((output.content[0] as any).type).toBe("text");
      expect((output.content[0] as any).text).toBe("Let me read that file.");
      expect((output.content[1] as any).type).toBe("toolCall");
      expect((output.content[1] as any).name).toBe("read");

      // Verify contentIndex values
      const textStart = stream.events.find(
        (e: any) => e.type === "text_start",
      ) as any;
      expect(textStart.contentIndex).toBe(0);
      const toolStart = stream.events.find(
        (e: any) => e.type === "toolcall_start",
      ) as any;
      expect(toolStart.contentIndex).toBe(1);
    });

    it("handles partial JSON parse failure during delta gracefully (no crash)", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_01", name: "Bash" },
      });

      // Partial JSON that cannot be parsed yet
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command": "ls' },
      });

      // Should not crash -- arguments should still be empty object (previous value)
      const output = bridge.getOutput();
      const toolCall = output.content[0] as any;
      expect(toolCall.arguments).toEqual({});

      // Complete the JSON
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ' -la"}' },
      });

      // Now should be parsed
      expect(toolCall.arguments).toEqual({ command: "ls -la" });
    });

    it("emits toolcall_end with raw string arguments when final JSON parse fails", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_01", name: "Read" },
      });

      // Send invalid JSON that will never parse
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: "not valid json at all",
        },
      });
      stream.push.mockClear();
      stream.events.length = 0;

      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_end");
      // Arguments should be the raw string since JSON parse failed
      expect(event.toolCall.arguments).toBe("not valid json at all");
    });

    it("getOutput().stopReason is toolUse when stop_reason is tool_use", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_01", name: "Read" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"file_path": "/foo"}',
        },
      });
      bridge.handleEvent({ type: "content_block_stop", index: 0 });

      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 10 },
      });
      bridge.handleEvent({ type: "message_stop" });

      // Done is now pushed by provider, not event bridge. Check output state.
      expect(bridge.getOutput().stopReason).toBe("toolUse");
    });

    it("output.content includes ToolCall objects alongside TextContent", () => {
      const bridge = createBridgeWithStart();

      // Text block
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Reading file..." },
      });
      bridge.handleEvent({ type: "content_block_stop", index: 0 });

      // Tool block
      bridge.handleEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_01", name: "Read" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"file_path": "/test.ts"}',
        },
      });
      bridge.handleEvent({ type: "content_block_stop", index: 1 });

      const output = bridge.getOutput();
      expect(output.content).toHaveLength(2);
      expect(output.content[0]).toEqual({
        type: "text",
        text: "Reading file...",
      });
      expect(output.content[1]).toEqual({
        type: "toolCall",
        id: "toolu_01",
        name: "read",
        arguments: { path: "/test.ts" },
      });
    });
  });

  describe("thinking and other content block types", () => {
    it("emits thinking_start for thinking blocks", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });

      expect(stream.push).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thinking_start",
          contentIndex: 0,
        }),
      );
    });

    it("emits thinking_delta for thinking content", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      stream.push.mockClear();

      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think..." },
      });

      expect(stream.push).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thinking_delta",
          contentIndex: 0,
          delta: "Let me think...",
        }),
      );
    });

    it("accumulates thinking text across multiple deltas", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "First thought. " },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Second thought." },
      });

      const output = bridge.getOutput();
      const thinkingBlock = output.content[0] as any;
      expect(thinkingBlock.thinking).toBe("First thought. Second thought.");
    });

    it("emits thinking_end for thinking block stop", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "reasoning here" },
      });
      stream.push.mockClear();

      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      expect(stream.push).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thinking_end",
          contentIndex: 0,
          content: "reasoning here",
        }),
      );
    });

    it("accumulates signature_delta on thinking block thinkingSignature", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "some reasoning" },
      });

      // Signature arrives in multiple chunks
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig_part1" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig_part2" },
      });

      const output = bridge.getOutput();
      const thinkingBlock = output.content[0] as any;
      expect(thinkingBlock.thinkingSignature).toBe("sig_part1sig_part2");
    });

    it("tracks thinking block interleaved with text block correctly", () => {
      const bridge = createBridgeWithStart();

      // Thinking block at index 0
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "deep thought" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig123" },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      // Text block at index 1
      bridge.handleEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "The answer is 42." },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 1,
      });

      const output = bridge.getOutput();
      expect(output.content).toHaveLength(2);

      const thinking = output.content[0] as any;
      expect(thinking.type).toBe("thinking");
      expect(thinking.thinking).toBe("deep thought");
      expect(thinking.thinkingSignature).toBe("sig123");

      const text = output.content[1] as any;
      expect(text.type).toBe("text");
      expect(text.text).toBe("The answer is 42.");

      // Verify correct contentIndex values
      const thinkingStart = stream.events.find(
        (e: any) => e.type === "thinking_start",
      ) as any;
      expect(thinkingStart.contentIndex).toBe(0);
      const textStart = stream.events.find(
        (e: any) => e.type === "text_start",
      ) as any;
      expect(textStart.contentIndex).toBe(1);
    });
  });

  describe("MCP prefix stripping via mapClaudeToolNameToPi", () => {
    it("strips mcp__custom-tools__ prefix from tool_use name in toolcall_start", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_mcp01",
          name: "mcp__custom-tools__foo",
        },
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_start");
      // Tool name should be stripped from "mcp__custom-tools__foo" to "foo"
      expect(event.partial.content[0].name).toBe("foo");
    });

    it("strips mcp__custom-tools__ prefix in toolcall_end", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_mcp01",
          name: "mcp__custom-tools__foo",
        },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"target": "prod"}' },
      });
      stream.push.mockClear();
      stream.events.length = 0;

      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_end");
      expect(event.toolCall.name).toBe("foo");
      // Custom tool args pass through unchanged (no argument renames for MCP tools)
      expect(event.toolCall.arguments).toEqual({ target: "prod" });
    });
  });

  describe("internal Claude Code tools are filtered", () => {
    it("skips ToolSearch tool_use blocks (not a pi-known tool)", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_ts01",
          name: "ToolSearch",
        },
      });

      // No toolcall_start should be emitted
      expect(stream.push).not.toHaveBeenCalled();
      // No content added to output
      expect(bridge.getOutput().content).toHaveLength(0);
    });

    it("skips Task, Agent, and other internal tools", () => {
      const bridge = createBridgeWithStart();
      for (const internalTool of [
        "Task",
        "TaskOutput",
        "Agent",
        "WebSearch",
        "WebFetch",
        "NotebookEdit",
      ]) {
        bridge.handleEvent({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: `toolu_${internalTool}`,
            name: internalTool,
          },
        });
      }
      expect(stream.push).not.toHaveBeenCalled();
    });

    it("allows built-in tools (Read, Write, etc.)", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_read01", name: "Read" },
      });
      expect(stream.push).toHaveBeenCalledTimes(1);
      expect((stream.events[0] as any).type).toBe("toolcall_start");
    });

    it("silently drops deltas and stop events for filtered tools", () => {
      const bridge = createBridgeWithStart();
      // ToolSearch start (filtered)
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_ts01",
          name: "ToolSearch",
        },
      });
      // Delta for filtered tool (should be ignored)
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"test"}' },
      });
      // Stop for filtered tool (should be ignored)
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });
      // Nothing emitted
      expect(stream.push).not.toHaveBeenCalled();
    });
  });

  describe("unknown event types", () => {
    it("silently ignores unknown event types (after start)", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "some_unknown_event" as any,
      });
      expect(stream.push).not.toHaveBeenCalled();
    });
  });

  describe("complete text streaming sequence", () => {
    it("produces correct pi event sequence for a full conversation turn", () => {
      const bridge = createEventBridge(stream as any, model as any);

      // 1. message_start
      bridge.handleEvent({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 150,
            output_tokens: 0,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 10,
          },
        },
      });

      // 2. content_block_start
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });

      // 3. content_block_delta x2
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      });

      // 4. content_block_stop
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      // 5. message_delta
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      });

      // 6. message_stop
      bridge.handleEvent({
        type: "message_stop",
      });

      // Verify event sequence: start, text_start, text_delta x2, text_end (no done — provider pushes it)
      expect(stream.events).toHaveLength(5);
      expect((stream.events[0] as any).type).toBe("start");
      expect((stream.events[1] as any).type).toBe("text_start");
      expect((stream.events[2] as any).type).toBe("text_delta");
      expect((stream.events[2] as any).delta).toBe("Hello");
      expect((stream.events[3] as any).type).toBe("text_delta");
      expect((stream.events[3] as any).delta).toBe(" world");
      expect((stream.events[4] as any).content).toBe("Hello world");

      // Output fully populated for provider to read via getOutput()
      const output = bridge.getOutput();
      expect(output.role).toBe("assistant");
      expect(output.content).toEqual([{ type: "text", text: "Hello world" }]);
      expect(output.usage.input).toBe(150);
      expect(output.usage.output).toBe(5);
      expect(output.stopReason).toBe("stop");

      expect(stream.end).not.toHaveBeenCalled();

      expect(calculateCost).toHaveBeenCalled();
    });
  });

  describe("output initialization", () => {
    it("initializes output with correct defaults", () => {
      const bridge = createEventBridge(stream as any, model as any);
      const output = bridge.getOutput();

      expect(output.role).toBe("assistant");
      expect(output.content).toEqual([]);
      expect(output.api).toBe("pi-claude-cli");
      expect(output.provider).toBe("anthropic");
      expect(output.model).toBe("claude-sonnet-4-5-20250929");
      expect(output.stopReason).toBe("stop");
      expect(output.usage.input).toBe(0);
      expect(output.usage.output).toBe(0);
      expect(output.usage.cacheRead).toBe(0);
      expect(output.usage.cacheWrite).toBe(0);
      expect(output.usage.totalTokens).toBe(0);
      expect(output.usage.cost.total).toBe(0);
      expect(typeof output.timestamp).toBe("number");
    });
  });

  describe("stopReason mapping (provider reads via getOutput)", () => {
    it("stopReason is toolUse for tool_use", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      });
      bridge.handleEvent({ type: "message_stop" });

      expect(bridge.getOutput().stopReason).toBe("toolUse");
    });

    it("stopReason is length for max_tokens", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
      });
      bridge.handleEvent({ type: "message_stop" });

      expect(bridge.getOutput().stopReason).toBe("length");
    });
  });

  describe("delta without matching block", () => {
    it("handles text_delta arriving with no matching block (index mismatch)", () => {
      const bridge = createBridgeWithStart();
      // Send a delta for index 5 without any block_start
      expect(() => {
        bridge.handleEvent({
          type: "content_block_delta",
          index: 5,
          delta: { type: "text_delta", text: "orphan text" },
        });
      }).not.toThrow();
      // No event should be pushed for the orphan delta
      expect(stream.push).not.toHaveBeenCalled();
    });

    it("handles input_json_delta arriving with no matching block", () => {
      const bridge = createBridgeWithStart();
      expect(() => {
        bridge.handleEvent({
          type: "content_block_delta",
          index: 99,
          delta: { type: "input_json_delta", partial_json: '{"key":"val"}' },
        });
      }).not.toThrow();
      expect(stream.push).not.toHaveBeenCalled();
    });

    it("handles thinking_delta arriving with no matching block", () => {
      const bridge = createBridgeWithStart();
      expect(() => {
        bridge.handleEvent({
          type: "content_block_delta",
          index: 42,
          delta: { type: "thinking_delta", thinking: "orphan thought" },
        });
      }).not.toThrow();
      expect(stream.push).not.toHaveBeenCalled();
    });

    it("handles signature_delta arriving with no matching block", () => {
      const bridge = createBridgeWithStart();
      expect(() => {
        bridge.handleEvent({
          type: "content_block_delta",
          index: 7,
          delta: { type: "signature_delta", signature: "sig_orphan" },
        });
      }).not.toThrow();
      expect(stream.push).not.toHaveBeenCalled();
    });

    it("handles content_block_stop arriving with no matching block", () => {
      const bridge = createBridgeWithStart();
      expect(() => {
        bridge.handleEvent({
          type: "content_block_stop",
          index: 10,
        });
      }).not.toThrow();
      expect(stream.push).not.toHaveBeenCalled();
    });
  });

  describe("unknown content block type in content_block_start", () => {
    it("silently ignores unknown content block types", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "some_new_type" as any },
      });
      // No event pushed and no crash
      expect(stream.push).not.toHaveBeenCalled();
      expect(bridge.getOutput().content).toHaveLength(0);
    });
  });

  describe("message_delta without usage", () => {
    it("handles message_delta with stop_reason but no usage", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      });
      expect(bridge.getOutput().stopReason).toBe("stop");
      // Usage should remain at defaults
      expect(bridge.getOutput().usage.output).toBe(0);
    });
  });
});
