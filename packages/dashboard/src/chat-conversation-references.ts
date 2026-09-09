import type { ChatMessage, ChatSession, ChatStore } from "@fusion/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/*
FNXC:ChatConversationReferences 2026-09-04-09:58:
Cross-conversation context is intentionally bounded: at most three references, five 300-character preview messages, 100 paged read messages, 25 search matches from the latest 400 messages, and 12,000 characters per tool response. `getChatSession` in `packages/core/src/async-stores/async-chat-store.ts` has no project predicate in its SQL builder, so every context and tool entry point must compare the loaded session's `projectId` strictly with the current Direct chat project before exposing any metadata.
*/
export const MAX_REFERENCED_CONVERSATIONS = 3;
export const CONVERSATION_PREVIEW_MESSAGE_COUNT = 5;
export const CONVERSATION_PREVIEW_MESSAGE_CHARS = 300;
export const CONVERSATION_READ_DEFAULT_LIMIT = 30;
export const CONVERSATION_READ_MAX_LIMIT = 100;
export const CONVERSATION_SEARCH_DEFAULT_LIMIT = 10;
export const CONVERSATION_SEARCH_MAX_MATCHES = 25;
export const CONVERSATION_SEARCH_SCAN_LIMIT = 400;
export const CONVERSATION_SEARCH_EXCERPT_CHARS = 200;
export const CONVERSATION_MESSAGE_MAX_CHARS = 1_500;
export const CONVERSATION_TOOL_RESPONSE_MAX_CHARS = 12_000;

const UNAVAILABLE_CONTEXT_MESSAGE = "Unavailable: no conversation with this ID exists in this project.";
const UNAVAILABLE_TOOL_MESSAGE = "ERROR: no conversation with this ID exists in this project.";
const TOOL_READ_ERROR_MESSAGE = "ERROR: conversation messages could not be read.";
const READ_GLOBAL_TRUNCATION_HINT = "[Output truncated. Retry with a smaller limit or a larger offset.]";
const SEARCH_GLOBAL_TRUNCATION_HINT = "[Output truncated. Retry with a smaller limit or a narrower query.]";
const MESSAGE_TRUNCATION_HINT = "[Some messages were truncated. Retry with a smaller limit or a different offset.]";

export interface BuildConversationReferenceContextInput {
  chatStore: ChatStore;
  content: string;
  currentSessionId: string;
  currentProjectId: string | null;
}

export interface ChatConversationToolOptions {
  currentSessionId: string;
  projectId: string | null;
}

interface ConversationReadParams {
  conversation_id?: unknown;
  limit?: unknown;
  offset?: unknown;
  order?: unknown;
}

interface ConversationSearchParams {
  conversation_id?: unknown;
  query?: unknown;
  limit?: unknown;
}

interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
}

function textResult(text: string, details: Record<string, unknown> = {}): ToolTextResult {
  return { content: [{ type: "text", text }], details };
}

function errorResult(text = UNAVAILABLE_TOOL_MESSAGE): ToolTextResult {
  return { content: [{ type: "text", text }], isError: true, details: {} };
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function truncateText(value: string, maximum: number): { text: string; truncated: boolean } {
  if (value.length <= maximum) return { text: value, truncated: false };
  if (maximum <= 1) return { text: "…".slice(0, maximum), truncated: true };
  return { text: `${value.slice(0, maximum - 1)}…`, truncated: true };
}

function boundToolResponse(value: string, hint: string): string {
  if (value.length <= CONVERSATION_TOOL_RESPONSE_MAX_CHARS) return value;
  const prefixLength = CONVERSATION_TOOL_RESPONSE_MAX_CHARS - hint.length - 2;
  return `${value.slice(0, prefixLength)}\n\n${hint}`;
}

function wrapReferenceBlock(id: string, body: string): string {
  return `[Referenced Conversation: ${id}]\n${body}\n[/Referenced Conversation: ${id}]`;
}

function formatModel(session: ChatSession): string {
  if (session.modelProvider && session.modelId) return `${session.modelProvider}/${session.modelId}`;
  return session.modelId ?? session.modelProvider ?? "default";
}

function formatSessionHeader(session: ChatSession, currentSessionId: string): string {
  return [
    `Conversation: ${session.id}${session.id === currentSessionId ? " (current conversation)" : ""}`,
    `Title: ${session.title ?? "Untitled"}`,
    `Status: ${session.status}`,
    `Agent: ${session.agentId}`,
    `Model: ${formatModel(session)}`,
    `Created: ${session.createdAt}`,
    `Updated: ${session.updatedAt}`,
  ].join("\n");
}

function formatMessage(message: ChatMessage, maximum: number): { text: string; truncated: boolean } {
  const content = truncateText(message.content, maximum);
  return {
    text: `[${message.role} @ ${message.createdAt}] ${content.text}`,
    truncated: content.truncated,
  };
}

async function resolveProjectSession(
  chatStore: ChatStore,
  conversationId: string,
  projectId: string | null,
): Promise<ChatSession | undefined> {
  try {
    const session = await chatStore.getSession(conversationId);
    return session?.projectId === projectId ? session : undefined;
  } catch {
    return undefined;
  }
}

/** Extract bounded `#chat-xxxxxxxx` references while preserving first-seen order. */
export function parseConversationReferences(content: string): string[] {
  const references: string[] = [];
  const seen = new Set<string>();
  const pattern = /(?:^|[\s,.;:!?"'()[\]{}])#(chat-[a-zA-Z0-9]{8})(?![./a-zA-Z0-9-])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    references.push(id);
    if (references.length >= MAX_REFERENCED_CONVERSATIONS) break;
  }
  return references;
}

/** Build a small prompt card for each referenced conversation without exposing cross-project rows. */
export async function buildConversationReferenceContext(
  input: BuildConversationReferenceContextInput,
): Promise<string> {
  const references = parseConversationReferences(input.content);
  if (references.length === 0) return "";

  const blocks = await Promise.all(references.map(async (id) => {
    try {
      const session = await input.chatStore.getSession(id);
      if (!session || session.projectId !== input.currentProjectId) {
        return wrapReferenceBlock(id, UNAVAILABLE_CONTEXT_MESSAGE);
      }
      if (session.id === input.currentSessionId) {
        return wrapReferenceBlock(
          id,
          "Current conversation: this ID refers to the current conversation; no preview was added.",
        );
      }

      const messages = await input.chatStore.getMessages(id, {
        limit: CONVERSATION_PREVIEW_MESSAGE_COUNT,
        order: "desc",
      });
      const preview = messages.length > 0
        ? messages.map((message) => formatMessage(message, CONVERSATION_PREVIEW_MESSAGE_CHARS).text).join("\n")
        : "(no messages)";
      return wrapReferenceBlock(
        id,
        [
          formatSessionHeader(session, input.currentSessionId),
          "Recent messages (newest first):",
          preview,
          "Use fn_chat_conversation_read or fn_chat_conversation_search for more detail.",
        ].join("\n"),
      );
    } catch {
      return wrapReferenceBlock(id, UNAVAILABLE_CONTEXT_MESSAGE);
    }
  }));

  return blocks.join("\n\n");
}

function createConversationReadTool(
  chatStore: ChatStore,
  options: ChatConversationToolOptions,
): ToolDefinition {
  return {
    name: "fn_chat_conversation_read",
    label: "Read Chat Conversation",
    description: "Read a bounded page of messages from a conversation in the current Direct chat project. Requires an explicit conversation_id.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        limit: { type: "number", minimum: 1 },
        offset: { type: "number", minimum: 0 },
        order: { type: "string", enum: ["asc", "desc"] },
      },
      required: ["conversation_id"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, raw: ConversationReadParams) => {
      const conversationId = typeof raw.conversation_id === "string" ? raw.conversation_id.trim() : "";
      if (!conversationId) return errorResult();
      const session = await resolveProjectSession(chatStore, conversationId, options.projectId);
      if (!session) return errorResult();

      const limit = clampInteger(raw.limit, CONVERSATION_READ_DEFAULT_LIMIT, 1, CONVERSATION_READ_MAX_LIMIT);
      const offset = clampInteger(raw.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const order = raw.order === "asc" ? "asc" : "desc";
      try {
        const messages = await chatStore.getMessages(conversationId, { limit, offset, order });
        let messageTruncated = false;
        const rows = messages.map((message) => {
          const formatted = formatMessage(message, CONVERSATION_MESSAGE_MAX_CHARS);
          messageTruncated ||= formatted.truncated;
          return formatted.text;
        });
        const body = [
          formatSessionHeader(session, options.currentSessionId),
          `Messages (${order}, limit ${limit}, offset ${offset}):`,
          rows.length > 0 ? rows.join("\n") : "(no messages)",
          ...(messageTruncated ? [MESSAGE_TRUNCATION_HINT] : []),
        ].join("\n");
        return textResult(boundToolResponse(body, READ_GLOBAL_TRUNCATION_HINT), {
          conversationId,
          count: messages.length,
          limit,
          offset,
          order,
        });
      } catch {
        return errorResult(TOOL_READ_ERROR_MESSAGE);
      }
    },
  } as unknown as ToolDefinition;
}

function createSearchExcerpt(content: string, matchIndex: number, queryLength: number): string {
  if (content.length <= CONVERSATION_SEARCH_EXCERPT_CHARS) return content;
  const bodyLength = CONVERSATION_SEARCH_EXCERPT_CHARS - 2;
  const contextBudget = Math.max(0, bodyLength - Math.min(queryLength, bodyLength));
  let start = Math.max(0, matchIndex - Math.floor(contextBudget / 2));
  start = Math.min(start, content.length - bodyLength);
  const end = Math.min(content.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

function createConversationSearchTool(
  chatStore: ChatStore,
  options: ChatConversationToolOptions,
): ToolDefinition {
  return {
    name: "fn_chat_conversation_search",
    label: "Search Chat Conversation",
    description: "Search recent messages in one conversation in the current Direct chat project using a literal case-insensitive query.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        query: { type: "string", minLength: 1 },
        limit: { type: "number", minimum: 1 },
      },
      required: ["conversation_id", "query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, raw: ConversationSearchParams) => {
      const conversationId = typeof raw.conversation_id === "string" ? raw.conversation_id.trim() : "";
      const query = typeof raw.query === "string" ? raw.query.trim() : "";
      if (!conversationId) return errorResult();
      if (!query) return errorResult("ERROR: query must be a non-empty string.");
      const session = await resolveProjectSession(chatStore, conversationId, options.projectId);
      if (!session) return errorResult();

      const limit = clampInteger(raw.limit, CONVERSATION_SEARCH_DEFAULT_LIMIT, 1, CONVERSATION_SEARCH_MAX_MATCHES);
      try {
        const messages = await chatStore.getMessages(conversationId, {
          limit: CONVERSATION_SEARCH_SCAN_LIMIT,
          order: "desc",
        });
        const normalizedQuery = query.toLocaleLowerCase();
        const matches: string[] = [];
        for (const message of messages) {
          const matchIndex = message.content.toLocaleLowerCase().indexOf(normalizedQuery);
          if (matchIndex < 0) continue;
          matches.push(
            `[${message.role} @ ${message.createdAt}] ${createSearchExcerpt(message.content, matchIndex, query.length)}`,
          );
          if (matches.length >= limit) break;
        }
        const saturated = messages.length >= CONVERSATION_SEARCH_SCAN_LIMIT;
        const body = [
          formatSessionHeader(session, options.currentSessionId),
          `Search query: ${query}`,
          matches.length > 0 ? matches.join("\n") : "(no matches)",
          ...(saturated
            ? [`[Search window saturated at the ${CONVERSATION_SEARCH_SCAN_LIMIT} most recent messages; older matches may exist.]`]
            : []),
        ].join("\n");
        return textResult(boundToolResponse(body, SEARCH_GLOBAL_TRUNCATION_HINT), {
          conversationId,
          matchCount: matches.length,
          limit,
          scannedCount: messages.length,
          saturated,
        });
      } catch {
        return errorResult(TOOL_READ_ERROR_MESSAGE);
      }
    },
  } as unknown as ToolDefinition;
}

/** Create the two project-scoped read-only conversation tools for Direct chat. */
export function createChatConversationTools(
  chatStore: ChatStore,
  options: ChatConversationToolOptions,
): ToolDefinition[] {
  return [
    createConversationReadTool(chatStore, options),
    createConversationSearchTool(chatStore, options),
  ];
}
