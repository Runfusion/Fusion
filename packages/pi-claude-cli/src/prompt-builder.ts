/**
 * Prompt builder for flattening pi conversation history into a labeled text prompt.
 *
 * Follows the reference project's buildPromptBlocks() pattern:
 * - USER: / ASSISTANT: / TOOL RESULT: labels
 * - Content blocks serialized by type
 * - Images in the final user message are translated to Anthropic API format (HIST-02)
 * - Images in non-final messages get placeholder text with console.warn
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Minimal message shape that prompt-builder accepts.
 * Uses a wide `role: string` discriminant so tests can pass plain objects
 * without literal type annotations. Content is typed broadly as
 * `string | unknown[]` since helper functions narrow at runtime.
 */
export interface PiMessage {
  role: string;
  content: string | unknown[];
  toolName?: string;
}
/**
 * Minimal pi-ai Tool shape — the subset we read from `Context.tools` to build
 * the deferred-tools system-prompt addendum.
 */
export interface PiToolLike {
  name: string;
  description?: string;
}

export type PiContext = {
  systemPrompt?: string;
  messages: PiMessage[];
  tools?: ReadonlyArray<PiToolLike>;
};
import {
  mapPiToolNameToClaude,
  translatePiArgsToClaude,
  isCustomToolName,
} from "./tool-mapping.js";

/**
 * Anthropic API content block types for image passthrough.
 * Used when the final user message contains images that need to be
 * translated from pi-ai format to Anthropic format.
 */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

/**
 * Flattens a pi conversation context's messages array into a labeled text prompt
 * suitable for sending to the Claude CLI subprocess.
 *
 * Each message is labeled with its role:
 * - USER: for user messages
 * - ASSISTANT: for assistant messages
 * - TOOL RESULT (historical {toolName}): for tool result messages
 */
/** Module-level counter for placeholder images, reset per buildPrompt call. */
let placeholderImageCount = 0;

/**
 * Translate a pi-ai image block to Anthropic API format.
 * Returns null if the block is missing required data/mimeType fields.
 *
 * pi-ai format:  { type: "image", data: string (base64), mimeType: string }
 * Anthropic format: { type: "image", source: { type: "base64", media_type: string, data: string } }
 */
function translateImageBlock(piBlock: unknown): AnthropicContentBlock | null {
  const block = piBlock as Record<string, unknown>;
  if (typeof block.data === "string" && typeof block.mimeType === "string") {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.mimeType,
        data: block.data,
      },
    };
  }
  return null; // Invalid image block, will fall back to placeholder
}

/**
 * Build content blocks for the final user message, translating images
 * from pi-ai format to Anthropic API format.
 *
 * @returns Array of AnthropicContentBlock with text and translated images
 */
function buildFinalUserContent(
  content: string | unknown[],
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const rawBlock of content) {
    const block = rawBlock as Record<string, unknown>;
    if (block.type === "text") {
      blocks.push({ type: "text", text: typeof block.text === "string" ? block.text : "" });
    } else if (block.type === "image") {
      const translated = translateImageBlock(block);
      if (translated) {
        blocks.push(translated);
      } else {
        // Invalid image block: fall back to placeholder text
        blocks.push({
          type: "text",
          text: "[An image was shared here but could not be included]",
        });
        placeholderImageCount++;
      }
    }
    // Unknown block types silently skipped
  }
  return blocks;
}

/**
 * Check if a message content array contains image blocks.
 */
function contentHasImages(content: string | unknown[]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false;
  return content.some((block) => (block as Record<string, unknown>).type === "image");
}

/**
 * Check if the conversation ends with a custom tool result.
 * If so, build a simplified prompt that presents the result directly
 * instead of replaying the full conversation history with tool labels.
 */
function buildCustomToolResultPrompt(messages: PiMessage[]): string | null {
  if (messages.length < 3) return null;

  const last = messages[messages.length - 1];
  if (last.role !== "toolResult") return null;
  if (!last.toolName || !isCustomToolName(last.toolName)) return null;

  // Find the original user message (scan backwards past assistant + toolResult)
  let userMessage: string | null = null;
  for (let i = messages.length - 3; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      userMessage = userContentToText(msg.content);
      break;
    }
  }
  if (!userMessage) return null;

  const toolResult = toolResultContentToText(last.content);
  return `${userMessage}\n\n[The ${last.toolName} tool was called and returned the following result]\n${toolResult}\n\nRespond to the user using the tool result above.`;
}

/**
 * Build a prompt for a resumed session.
 *
 * When resuming via --resume, the CLI already has the full conversation history.
 * We only need to send the new content since the last turn: the last assistant
 * response's tool results (if any) followed by the latest user message.
 *
 * For tool_use flows: pi sends [user, assistant(toolCall), toolResult, ...]
 * We need to include tool results so the resumed session sees them, plus the
 * final user message.
 *
 * Falls back to full prompt if the message structure is unexpected.
 */
export function buildResumePrompt(context: PiContext): string | AnthropicContentBlock[] {
  const messages = context.messages;
  if (messages.length === 0) return "";

  // Find the last user message
  const finalUserIndex = findFinalUserMessageIndex(messages);
  if (finalUserIndex < 0) return "";

  // Collect new messages: everything from the last assistant turn onwards
  // (tool results from the last assistant + the new user message)
  const newMessages: PiMessage[] = [];

  // Walk backwards from finalUserIndex to find where new content starts.
  // Include trailing toolResult messages that follow the last assistant turn.
  let startIdx = finalUserIndex;
  for (let i = finalUserIndex - 1; i >= 0; i--) {
    if (messages[i].role === "toolResult") {
      startIdx = i;
    } else {
      break;
    }
  }

  for (let i = startIdx; i < messages.length; i++) {
    newMessages.push(messages[i]);
  }

  // If there are only tool results + one user message, build a combined prompt
  const parts: string[] = [];
  for (const msg of newMessages) {
    if (msg.role === "toolResult") {
      if (msg.toolName && isCustomToolName(msg.toolName)) {
        parts.push(`TOOL RESULT (${msg.toolName}):`);
      } else {
        const claudeToolName = msg.toolName
          ? mapPiToolNameToClaude(msg.toolName)
          : "unknown";
        parts.push(`TOOL RESULT (historical ${claudeToolName}):`);
      }
      parts.push(toolResultContentToText(msg.content));
    } else if (msg.role === "user") {
      // Check for images in the final user message
      if (contentHasImages(msg.content)) {
        const textSoFar = parts.join("\n");
        const userContent = buildFinalUserContent(msg.content);
        const result: AnthropicContentBlock[] = [];
        if (textSoFar) {
          result.push({ type: "text", text: textSoFar });
        }
        result.push(...userContent);
        return result;
      }
      parts.push(userContentToText(msg.content));
    }
  }

  return parts.join("\n") || "";
}

export function buildPrompt(context: PiContext): string | AnthropicContentBlock[] {
  // Reset placeholder counter for each call
  placeholderImageCount = 0;

  // Special case: when conversation ends with a custom tool result,
  // present it directly instead of complex history replay
  const customToolPrompt = buildCustomToolResultPrompt(context.messages);
  if (customToolPrompt) {
    // customToolPrompt calls userContentToText which may increment placeholderImageCount
    if (placeholderImageCount > 0) {
      console.warn(
        `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
      );
    }
    return customToolPrompt;
  }

  // Determine if any message has images worth passing through
  const finalUserIndex = findFinalUserMessageIndex(context.messages);
  const finalUserMsg = finalUserIndex >= 0 ? context.messages[finalUserIndex] : undefined;
  const finalUserHasImages =
    finalUserMsg !== undefined &&
    finalUserMsg.role === "user" &&
    contentHasImages(finalUserMsg.content);
  const anyToolResultHasImages = context.messages.some(
    (m) => m.role === "toolResult" && toolResultHasImages(m.content),
  );

  if (finalUserHasImages || anyToolResultHasImages) {
    // Build history as text (all messages except the final user message)
    const historyParts: string[] = [];
    const toolResultImageBlocks: AnthropicContentBlock[] = [];
    for (let i = 0; i < context.messages.length; i++) {
      if (i === finalUserIndex) continue; // Skip final user message -- handled separately
      const message = context.messages[i];
      if (message.role === "user") {
        historyParts.push("USER:");
        historyParts.push(userContentToText(message.content));
      } else if (message.role === "assistant") {
        historyParts.push("ASSISTANT:");
        historyParts.push(contentToText(message.content));
      } else if (message.role === "toolResult") {
        if (message.toolName && isCustomToolName(message.toolName)) {
          historyParts.push(`TOOL RESULT (${message.toolName}):`);
        } else {
          const claudeToolName = message.toolName
            ? mapPiToolNameToClaude(message.toolName)
            : "unknown";
          historyParts.push(`TOOL RESULT (historical ${claudeToolName}):`);
        }
        // Extract text portion of tool result
        historyParts.push(toolResultContentToText(message.content));
        // Collect image blocks from tool results for passthrough
        if (Array.isArray(message.content)) {
          for (const rawBlock of message.content) {
            const block = rawBlock as Record<string, unknown>;
            if (block.type === "image") {
              const translated = translateImageBlock(block);
              if (translated) {
                toolResultImageBlocks.push(translated);
                // Undo the placeholder count from toolResultContentToText since we're passing through
                placeholderImageCount--;
              }
            }
          }
        }
      }
    }

    // Build final user message content blocks
    const finalUserContent =
      finalUserMsg?.role === "user"
        ? buildFinalUserContent(finalUserMsg.content)
        : [];

    // Combine: history text + tool result images + final user content blocks
    const result: AnthropicContentBlock[] = [];
    const historyText = historyParts.join("\n");
    if (historyText) {
      result.push({ type: "text", text: historyText });
    }
    // Insert tool result images after history text (Claude sees them in context)
    result.push(...toolResultImageBlocks);
    result.push(...finalUserContent);

    if (placeholderImageCount > 0) {
      console.warn(
        `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
      );
    }

    return result;
  }

  // No images in final user message: standard text-only path
  const parts: string[] = [];

  for (const message of context.messages) {
    if (message.role === "user") {
      parts.push("USER:");
      parts.push(userContentToText(message.content));
    } else if (message.role === "assistant") {
      parts.push("ASSISTANT:");
      parts.push(contentToText(message.content));
    } else if (message.role === "toolResult") {
      if (message.toolName && isCustomToolName(message.toolName)) {
        // Custom tools: don't reference MCP tool name. Present result plainly.
        parts.push(`TOOL RESULT (${message.toolName}):`);
      } else {
        const claudeToolName = message.toolName
          ? mapPiToolNameToClaude(message.toolName)
          : "unknown";
        parts.push(`TOOL RESULT (historical ${claudeToolName}):`);
      }
      parts.push(toolResultContentToText(message.content));
    }
  }

  if (placeholderImageCount > 0) {
    console.warn(
      `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
    );
  }

  return parts.join("\n") || "";
}

/**
 * Find the index of the last user message in the messages array.
 * Returns -1 if no user message found.
 */
function findFinalUserMessageIndex(messages: PiMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/**
 * Builds the system prompt from the context's systemPrompt field,
 * appending AGENTS.md content if found (walking up from cwd, then global fallback).
 * Sanitizes .pi references to .claude for Claude Code compatibility.
 */
export function buildSystemPrompt(
  context: PiContext,
  cwd: string,
): string {
  const parts: string[] = [];

  if (context.systemPrompt) {
    parts.push(rewriteCustomToolReferences(context.systemPrompt, context.tools));
  }

  // Look for AGENTS.md
  const agentsPath = resolveAgentsMdPath(cwd);
  if (agentsPath) {
    try {
      const content = readFileSync(agentsPath, "utf-8");
      const sanitized = sanitizeAgentsContent(content);
      parts.push(sanitized);
    } catch {
      // If we can't read it, skip silently
    }
  }

  // When conversation history has tool results, instruct Claude to use them
  // instead of trying to re-call tools (which may not be available).
  if (context.messages?.some((m) => m.role === "toolResult")) {
    parts.push(
      "IMPORTANT: The conversation history below contains tool results from previously executed tools. " +
        "Use these results to answer the user's question. Do NOT attempt to re-call tools that already have results.",
    );
  }

  const customToolsAddendum = buildCustomToolsAddendum(context.tools);
  if (customToolsAddendum) {
    parts.push(customToolsAddendum);
  }

  return parts.join("\n\n");
}

/** Pi built-in tool names — these go through pi's wrapped built-ins, not MCP. */
const BUILT_IN_PI_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
]);

/**
 * Rewrite bare references to custom pi tool names (e.g. `fn_review_spec`,
 * `fn_review_spec()`) in the system prompt so they appear as their
 * MCP-prefixed names (`mcp__custom-tools__fn_review_spec`). Engine prompts are
 * written for direct API tool calls; under pi-claude-cli the same tools are
 * reachable only through the MCP shim. Without this rewrite, models like
 * Sonnet 4.6 inconsistently translate the names — sometimes calling MCP
 * variants, sometimes silently skipping the call (observed in triage where
 * `fn_review_spec` was never invoked even though the prompt said "MUST call").
 *
 * Only rewrites whole-word matches anchored to a non-identifier boundary, so
 * substrings inside other identifiers stay intact. Skips already-prefixed
 * occurrences (`mcp__custom-tools__fn_review_spec`) and pi built-ins.
 */
function rewriteCustomToolReferences(
  prompt: string,
  tools: ReadonlyArray<PiToolLike> | undefined,
): string {
  if (!prompt || !tools || tools.length === 0) {
    return prompt;
  }

  let result = prompt;
  let totalRewrites = 0;
  const rewritten: string[] = [];
  for (const tool of tools) {
    if (BUILT_IN_PI_TOOLS.has(tool.name)) continue;
    // \b doesn't treat `_` as a word boundary the way we want here, so anchor
    // the match between either start-of-string/non-identifier-char and either
    // end-of-string/non-identifier-char. Also negative-lookbehind for
    // `mcp__custom-tools__` so we don't double-prefix.
    const escaped = tool.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_])(?<!mcp__custom-tools__)${escaped}(?![A-Za-z0-9_])`,
      "g",
    );
    const before = result;
    result = result.replace(pattern, `mcp__custom-tools__${tool.name}`);
    if (result !== before) {
      const matches = before.match(pattern);
      const count = matches?.length ?? 0;
      totalRewrites += count;
      rewritten.push(`${tool.name}×${count}`);
    }
  }
  if (totalRewrites > 0) {
    console.error(
      `[pi-claude-cli] system prompt: rewrote ${totalRewrites} custom tool ref(s) [${rewritten.join(", ")}]`,
    );
  }
  return result;
}

/**
 * Build a system-prompt addendum that maps each custom pi tool to its
 * MCP-exposed name (`mcp__custom-tools__<name>`) and explains Claude Code's
 * deferred-tool protocol. Without this, the model sees instructions like
 * "call fn_review_spec()" but only finds `mcp__custom-tools__fn_review_spec`
 * via ToolSearch — and may report "tool not found" or skip the call.
 *
 * Returns an empty string when there are no custom tools so the addendum
 * doesn't pollute prompts on plain chat sessions with only built-ins.
 */
function buildCustomToolsAddendum(
  tools: ReadonlyArray<PiToolLike> | undefined,
): string {
  if (!tools || tools.length === 0) return "";
  const customNames = tools
    .map((t) => t.name)
    .filter((name) => !BUILT_IN_PI_TOOLS.has(name));
  if (customNames.length === 0) return "";

  const lines = customNames
    .sort()
    .map((name) => `- \`${name}\` is exposed as \`mcp__custom-tools__${name}\``);

  return [
    "## Custom tool naming (Claude Code deferred-tools protocol)",
    "",
    "The following pi extension tools are available, but Claude Code exposes",
    "them under MCP-prefixed names. When a system prompt or task instruction",
    "asks you to call one of these by its short name, use the MCP-prefixed",
    "name instead. Their schemas are deferred — call `ToolSearch` with",
    '`select:mcp__custom-tools__<name>` first, then call the tool directly.',
    "",
    ...lines,
  ].join("\n");
}

/**
 * Converts user message content to text.
 * Handles string content and array of content blocks.
 * Image blocks are replaced with placeholder text (HIST-02).
 * Increments the module-level placeholderImageCount for each image.
 */
function userContentToText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const rawBlock of content) {
    const block = rawBlock as Record<string, unknown>;
    if (block.type === "text") {
      texts.push(typeof block.text === "string" ? block.text : "");
    } else if (block.type === "image") {
      texts.push("[An image was shared here but could not be included]");
      placeholderImageCount++;
    }
    // Unknown block types silently skipped
  }
  return texts.join("\n");
}

/**
 * Converts assistant message content to text.
 * Handles string content and array of content blocks (text, thinking, toolCall).
 */
function contentToText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((rawBlock) => {
      const block = rawBlock as Record<string, unknown>;
      if (block.type === "text") return typeof block.text === "string" ? block.text : "";
      if (block.type === "thinking") return ""; // Skip thinking — internal reasoning, not conversation
      if (block.type === "toolCall") {
        const name = typeof block.name === "string" ? block.name : "";
        const rawArgs = block.arguments;
        // A toolCall may carry either parsed args (object) or the raw unparsed
        // string that pi produced — preserve the raw string verbatim so callers
        // can see what the model actually sent.
        const argsObject =
          rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : undefined;
        const isCustom = isCustomToolName(name);
        if (isCustom) {
          // Custom tools: don't reference the MCP tool name — Claude might try to re-call it.
          // Just note what was done. The result follows as a TOOL RESULT message.
          const argsStr = argsObject
            ? JSON.stringify(argsObject)
            : typeof rawArgs === "string"
              ? JSON.stringify(rawArgs)
              : "{}";
          return `[Used ${name} tool with args: ${argsStr}]`;
        }
        const claudeName = mapPiToolNameToClaude(name);
        const claudeArgs = argsObject ? translatePiArgsToClaude(name, argsObject) : undefined;
        const argsStr = claudeArgs
          ? JSON.stringify(claudeArgs)
          : typeof rawArgs === "string"
            ? JSON.stringify(rawArgs)
            : "{}";
        return `Historical tool call (non-executable): ${claudeName} args=${argsStr}`;
      }
      // Unknown block types are represented as a placeholder
      return `[${String(block.type)}]`;
    })
    .join("\n");
}

/**
 * Converts tool result content to text.
 * Handles string content and array of content blocks.
 * Image blocks get placeholder text (actual image passthrough handled separately).
 */
function toolResultContentToText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const rawBlock of content) {
    const block = rawBlock as Record<string, unknown>;
    if (block.type === "text") {
      texts.push(typeof block.text === "string" ? block.text : "");
    } else if (block.type === "image") {
      texts.push("[An image was shared here but could not be included]");
      placeholderImageCount++;
    }
  }
  return texts.join("\n");
}

/**
 * Check if a tool result content array contains image blocks.
 */
function toolResultHasImages(content: string | unknown[]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false;
  return content.some((block) => (block as Record<string, unknown>).type === "image");
}

/**
 * Walk up from cwd looking for AGENTS.md, fall back to ~/.pi/agent/AGENTS.md.
 */
function resolveAgentsMdPath(cwd: string): string | undefined {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, "AGENTS.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Fall back to global path
  const globalPath = join(homedir(), ".pi", "agent", "AGENTS.md");
  if (existsSync(globalPath)) return globalPath;

  return undefined;
}

/**
 * Sanitize .pi references to .claude in AGENTS.md content
 * for Claude Code compatibility.
 */
function sanitizeAgentsContent(content: string): string {
  let sanitized = content;
  // ~/.pi -> ~/.claude
  sanitized = sanitized.replace(/~\/\.pi\b/gi, "~/.claude");
  // .pi/ -> .claude/ (at word boundary or after whitespace/quotes)
  sanitized = sanitized.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/");
  // Remaining standalone .pi references
  sanitized = sanitized.replace(/\b\.pi\b/gi, ".claude");
  return sanitized;
}
