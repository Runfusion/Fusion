import type { ClaudeApiEvent, TrackedContentBlock } from "./types";
import { calculateCost } from "@mariozechner/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import {
  mapClaudeToolNameToPi,
  translateClaudeArgsToPi,
  isPiKnownClaudeTool,
} from "./tool-mapping.js";

/**
 * Extended tracking for tool_use content blocks during streaming.
 * Stores the Claude tool name for argument translation at block_stop.
 */
interface TrackedToolBlock {
  type: "tool_use";
  index: number;
  id: string;
  name: string; // Already mapped to pi name
  claudeName: string; // Original Claude name for arg translation
  arguments: Record<string, unknown>;
  partialJson: string;
}

/** Union of tracked block types for the blocks array. */
type TrackedBlock = TrackedContentBlock | TrackedToolBlock;

/**
 * The event bridge interface returned by createEventBridge.
 * handleEvent processes each Claude API streaming event and pushes
 * the appropriate pi events to the stream.
 * getOutput returns the accumulated AssistantMessage.
 */
export interface EventBridge {
  handleEvent(event: ClaudeApiEvent): void;
  getOutput(): AssistantMessage;
}

/**
 * Map Claude API stop reasons to pi's stop reason format.
 */
function mapStopReason(
  reason: string | undefined,
): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    case "end_turn":
    default:
      return "stop";
  }
}

/**
 * Create an event bridge that translates Claude API streaming events
 * into pi's AssistantMessageEventStream events.
 *
 * The bridge maintains internal state to track content blocks and
 * accumulate the final AssistantMessage. It handles:
 * - text content blocks (start/delta/stop -> text_start/text_delta/text_end)
 * - message lifecycle (message_start for usage, message_delta for stop reason, message_stop for done)
 * - unsupported block types (tool_use, thinking) with warnings
 */
export function createEventBridge(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
): EventBridge {
  // Tracked content blocks indexed by Claude's content_block index
  const blocks: TrackedBlock[] = [];

  // The accumulated output message
  const output: AssistantMessage = {
    role: "assistant" as const,
    content: [] as (TextContent | ThinkingContent | ToolCall)[],
    api: "pi-claude-cli",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  let started = false;

  function handleEvent(event: ClaudeApiEvent): void {
    // Emit start event on first message — tells pi to begin incremental rendering
    if (!started) {
      stream.push({ type: "start", partial: output });
      started = true;
    }

    switch (event.type) {
      case "message_start":
        handleMessageStart(event);
        break;
      case "content_block_start":
        handleContentBlockStart(event);
        break;
      case "content_block_delta":
        handleContentBlockDelta(event);
        break;
      case "content_block_stop":
        handleContentBlockStop(event);
        break;
      case "message_delta":
        handleMessageDelta(event);
        break;
      case "message_stop":
        handleMessageStop();
        break;
      // Unknown event types are silently ignored
    }
  }

  function handleMessageStart(event: ClaudeApiEvent): void {
    const usage = event.message?.usage;
    if (usage) {
      output.usage.input = usage.input_tokens ?? 0;
      output.usage.output = usage.output_tokens ?? 0;
      output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
      output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
      output.usage.totalTokens =
        output.usage.input +
        output.usage.output +
        output.usage.cacheRead +
        output.usage.cacheWrite;
      calculateCost(model, output.usage);
    }
  }

  function handleContentBlockStart(event: ClaudeApiEvent): void {
    const blockType = event.content_block?.type;

    if (blockType === "text") {
      const block: TrackedContentBlock = {
        type: "text",
        text: "",
        index: event.index ?? 0,
      };
      blocks.push(block);
      output.content.push({ type: "text" as const, text: "" });

      stream.push({
        type: "text_start",
        contentIndex: output.content.length - 1,
        partial: output,
      });
    } else if (blockType === "thinking") {
      const block: TrackedContentBlock = {
        type: "thinking",
        text: "",
        index: event.index ?? 0,
      };
      blocks.push(block);
      output.content.push({
        type: "thinking" as const,
        thinking: "",
        thinkingSignature: "",
      });

      stream.push({
        type: "thinking_start",
        contentIndex: output.content.length - 1,
        partial: output,
      });
    } else if (blockType === "tool_use") {
      const claudeName = event.content_block!.name!;

      // Skip internal Claude Code tools (ToolSearch, Task, Agent, etc.)
      // that pi cannot execute — only emit pi-known tools
      if (!isPiKnownClaudeTool(claudeName)) {
        return;
      }

      const piName = mapClaudeToolNameToPi(claudeName);
      const id = event.content_block!.id!;

      const block: TrackedToolBlock = {
        type: "tool_use",
        index: event.index ?? 0,
        id,
        name: piName,
        claudeName,
        arguments: {},
        partialJson: "",
      };
      blocks.push(block);
      output.content.push({
        type: "toolCall" as const,
        id,
        name: piName,
        arguments: {},
      } as ToolCall);

      stream.push({
        type: "toolcall_start",
        contentIndex: output.content.length - 1,
        partial: output,
      });
    }
    // Unknown block types silently ignored
  }

  function handleContentBlockDelta(event: ClaudeApiEvent): void {
    const deltaType = event.delta?.type;

    if (deltaType === "text_delta" && event.delta!.text != null) {
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.type === "text") {
        block.text += event.delta!.text;
        const contentBlock = output.content[idx] as TextContent;
        contentBlock.text = block.text;

        stream.push({
          type: "text_delta",
          contentIndex: idx,
          delta: event.delta!.text,
          partial: output,
        });
      }
    } else if (
      deltaType === "thinking_delta" &&
      event.delta!.thinking != null
    ) {
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.type === "thinking") {
        block.text += event.delta!.thinking;
        const contentBlock = output.content[idx] as ThinkingContent;
        contentBlock.thinking = block.text;

        stream.push({
          type: "thinking_delta",
          contentIndex: idx,
          delta: event.delta!.thinking,
          partial: output,
        });
      }
    } else if (
      deltaType === "input_json_delta" &&
      event.delta!.partial_json != null
    ) {
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.type === "tool_use") {
        block.partialJson += event.delta!.partial_json;

        // Try to parse accumulated JSON -- on success update args, on failure keep previous
        try {
          block.arguments = JSON.parse(block.partialJson);
          (output.content[idx] as ToolCall).arguments = block.arguments as Record<string, unknown>;
        } catch {
          // Partial JSON not yet parseable -- keep previous arguments
        }

        stream.push({
          type: "toolcall_delta",
          contentIndex: idx,
          delta: event.delta!.partial_json,
          partial: output,
        });
      }
    } else if (
      deltaType === "signature_delta" &&
      event.delta!.signature != null
    ) {
      // Accumulate signature on the thinking block
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.type === "thinking") {
        const contentBlock = output.content[idx] as ThinkingContent;
        contentBlock.thinkingSignature =
          (contentBlock.thinkingSignature || "") + event.delta!.signature;
      }
    }
  }

  function handleContentBlockStop(event: ClaudeApiEvent): void {
    const idx = blocks.findIndex((b) => b.index === event.index);
    if (idx === -1) return;

    const block = blocks[idx];
    // Clean up the tracking index from the block (no longer needed)
    delete (block as unknown as Record<string, unknown>).index;

    if (block.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: idx,
        content: block.text,
        partial: output,
      });
    } else if (block.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: idx,
        content: block.text,
        partial: output,
      });
    } else if (block.type === "tool_use") {
      // Final JSON parse with fallback to raw string.
      // Special case: parameterless MCP tools (e.g. fn_review_spec, schema
      // `{type:"object", properties:{}}`) emit ZERO input_json_delta events,
      // so `partialJson` stays "". Without this guard we'd JSON.parse("")
      // → throw → fall through to `finalArgs = ""` (raw string), and pi's
      // TypeBox validator then rejects with "root: must be object" because
      // an empty string is not an object. Default to `{}` so the call lands.
      let finalArgs: Record<string, unknown> | string;
      const trimmedJson = block.partialJson.trim();
      if (trimmedJson === "") {
        finalArgs = {};
      } else {
        try {
          const parsed = JSON.parse(trimmedJson);
          finalArgs = translateClaudeArgsToPi(block.claudeName, parsed);
        } catch {
          finalArgs = block.partialJson;
        }
      }

      // Update output.content with final arguments
      const contentBlock = output.content[idx] as ToolCall;
      // ToolCall.arguments is typed as Record<string, any> in pi-ai, but we
      // intentionally emit a raw string when JSON parse fails completely.
      // Pi handles string arguments gracefully at runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- finalArgs may be a raw string when JSON parse fails; pi-ai handles it at runtime
      (contentBlock as any).arguments = finalArgs;
      const toolCall = {
        type: "toolCall" as const,
        id: block.id,
        name: block.name,
        arguments: finalArgs,
      } as ToolCall;

      stream.push({
        type: "toolcall_end",
        contentIndex: idx,
        toolCall,
        partial: output,
      });
    }
  }

  function handleMessageDelta(event: ClaudeApiEvent): void {
    if (event.delta?.stop_reason) {
      output.stopReason = mapStopReason(event.delta.stop_reason);
    }

    const usage = event.usage;
    if (usage) {
      if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
      if (usage.output_tokens != null)
        output.usage.output = usage.output_tokens;
      output.usage.totalTokens =
        output.usage.input +
        output.usage.output +
        output.usage.cacheRead +
        output.usage.cacheWrite;
      calculateCost(model, output.usage);
    }
  }

  function handleMessageStop(): void {
    // No-op: done event is pushed by the provider after readline closes.
    // Pushing done here (synchronously) prevents pi from executing tools.
  }

  return {
    handleEvent,
    getOutput: () => output,
  };
}
