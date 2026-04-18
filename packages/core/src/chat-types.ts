/**
 * Chat System type definitions.
 *
 * Defines the data model for agent chat sessions and messages,
 * following the same patterns as MissionStore types.
 */

// ── Enums / String Literals ─────────────────────────────────────────────

/** Status of a chat session */
export type ChatSessionStatus = "active" | "archived";

/** Role of a message sender in a chat */
export type ChatMessageRole = "user" | "assistant" | "system";

// ── Core Types ─────────────────────────────────────────────────────────

/**
 * A chat session between a user and an agent.
 * Contains metadata about the conversation and references to the model used.
 */
export interface ChatSession {
  id: string;
  /** ID of the agent participating in this session */
  agentId: string;
  /** Human-readable title for the session (optional, can be auto-generated) */
  title: string | null;
  /** Current status of the session */
  status: ChatSessionStatus;
  /** Project ID this session belongs to (optional, for multi-project context) */
  projectId: string | null;
  /** AI model provider for this session (optional, overrides defaults) */
  modelProvider: string | null;
  /** AI model ID for this session (optional, overrides defaults) */
  modelId: string | null;
  /** When the session was created */
  createdAt: string;
  /** When the session was last updated */
  updatedAt: string;
}

/**
 * Lightweight view of a chat session for list views.
 * Currently identical to ChatSession but exists for future extensibility.
 */
export type ChatSessionSummary = ChatSession;

/**
 * Chat session enriched with last message preview data.
 * The server enriches sessions with lastMessagePreview and lastMessageAt
 * by fetching the most recent message for each session.
 */
export type EnrichedChatSession = ChatSession & {
  /** Preview of the last message in the session (truncated to 100 chars) */
  lastMessagePreview?: string;
  /** Timestamp of the last message in the session */
  lastMessageAt?: string;
};

/** A parsed @ mention of an agent in a chat message */
export interface ChatMention {
  agentId: string;
  agentName: string;
}

/**
 * A single message within a chat session.
 */
export interface ChatMessage {
  id: string;
  /** Parent session ID */
  sessionId: string;
  /** Role of the message sender */
  role: ChatMessageRole;
  /** Message content (text) */
  content: string;
  /** Optional thinking/reasoning output (for models that support it) */
  thinkingOutput: string | null;
  /** Additional metadata about the message (model, tokens, finish reason, etc.) */
  metadata: Record<string, unknown> | null;
  /** When the message was created */
  createdAt: string;
}

// ── Input Types ────────────────────────────────────────────────────────

/**
 * Input for creating a chat message.
 */
export interface ChatMessageCreateInput {
  role: ChatMessageRole;
  content: string;
  /** Optional thinking output from the model */
  thinkingOutput?: string | null;
  /** Optional metadata (e.g., { tokens: 150, finishReason: "stop" }) */
  metadata?: Record<string, unknown> | null;
}

/**
 * Input for creating a chat session.
 */
export interface ChatSessionCreateInput {
  agentId: string;
  /** Optional session title */
  title?: string | null;
  /** Optional project ID for multi-project context */
  projectId?: string | null;
  /** Optional model provider override */
  modelProvider?: string | null;
  /** Optional model ID override */
  modelId?: string | null;
}

/**
 * Input for updating a chat session.
 * All fields are optional; only provided fields are updated.
 */
export interface ChatSessionUpdateInput {
  /** New session title */
  title?: string | null;
  /** New session status */
  status?: ChatSessionStatus;
  /** Model provider override */
  modelProvider?: string | null;
  /** Model ID override */
  modelId?: string | null;
}

/**
 * Filter options for retrieving messages.
 * Supports cursor-based pagination via `before` timestamp.
 */
export interface ChatMessagesFilter {
  /** Maximum number of messages to return */
  limit?: number;
  /** Number of messages to skip (offset pagination) */
  offset?: number;
  /**
   * Cursor for pagination: only return messages created before this timestamp.
   * Used for loading older messages in a conversation.
   */
  before?: string;
}
