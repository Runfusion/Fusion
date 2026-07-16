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
export interface ChatInFlightToolCall {
  toolName: string;
  args?: Record<string, unknown>;
  isError: boolean;
  result?: unknown;
  status: "running" | "completed";
}

export interface ChatInFlightGenerationState {
  status: "generating";
  streamingText: string;
  streamingThinking: string;
  toolCalls: ChatInFlightToolCall[];
  replayFromEventId: number;
  updatedAt: string;
}

export interface ChatSession {
  id: string;
  /** Session routing kind; legacy sessions default to direct */
  kind?: "direct" | "room";
  /** Room ID when kind is room */
  roomId?: string | null;
  /** Optional room name for prompt context */
  roomName?: string | null;
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
  /** Optional thinking/reasoning-effort override for this session (optional, overrides defaults) */
  thinkingLevel: string | null;
  /** When the session was created */
  createdAt: string;
  /** When the session was last updated */
  updatedAt: string;
  /**
   * FNXC:ChatPinned 2026-07-16-12:00:
   * Null means unpinned. Active Direct sessions may have at most three pins per
   * project scope; null projectId uses the canonical default scope and the store
   * serializes pin changes before counting and writing this timestamp.
   */
  pinnedAt: string | null;
  /**
   * Absolute path to the pi/Claude CLI session file backing this chat, if
   * any. Set on the first assistant turn (when SessionManager.create
   * provisions the file) and reused by SessionManager.open on subsequent
   * turns so the on-disk CLI session is resumed instead of recreated. Null
   * for sessions that have never produced an assistant reply.
   */
  cliSessionFile: string | null;
  /**
   * cli-agent adapter id backing this chat session (CLI Agent Executor, U12).
   * When non-null the chat is CLI-backed: composer sends inject into a live
   * CLI session and adapter transcript events map to chat_messages rows. Null
   * means the chat uses the standard model-provider path.
   */
  cliExecutorAdapterId: string | null;
  /** Durable in-flight assistant snapshot used to recover streaming UI after refresh. */
  inFlightGeneration: ChatInFlightGenerationState | null;
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
  /** Whether a generation is currently in progress for this session */
  isGenerating?: boolean;
  /**
   * FNXC:ChatSearch 2026-07-07-00:00:
   * When a session is included in `GET /chat/sessions` because its message content (not
   * title) matched a server-side content search, this carries a truncated preview of the
   * matching message so the UI can show "why did this match" without a second round trip.
   * Absent when the session was not returned via content search.
   */
  matchedMessagePreview?: string;
};

/** A parsed @ mention of an agent in a chat message */
export interface ChatMention {
  agentId: string;
  agentName: string;
}

/**
 * File attachment metadata associated with a chat message.
 */
export interface ChatAttachment {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
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
  /** Optional file attachments uploaded before sending this message */
  attachments?: ChatAttachment[];
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
  /** Optional attachment metadata uploaded before send */
  attachments?: ChatAttachment[];
}

export type ChatTokenUsageSourceKind = "chat" | "task-planner-chat" | "room-chat" | "cli-chat" | "chat-title";

export interface ChatTokenUsageRecord {
  id: string;
  sourceKind: ChatTokenUsageSourceKind;
  chatSessionId: string | null;
  roomId: string | null;
  messageId: string | null;
  projectId: string | null;
  agentId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  createdAt: string;
}

export interface ChatTokenUsageCreateInput {
  sourceKind: ChatTokenUsageSourceKind;
  chatSessionId?: string | null;
  roomId?: string | null;
  messageId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens?: number;
  createdAt?: string;
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
  /** Optional thinking/reasoning-effort override */
  thinkingLevel?: string | null;
  /** Optional cli-agent adapter id; when set the chat is CLI-backed (U12) */
  cliExecutorAdapterId?: string | null;
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
  /** New agent target — switches the session from a model to an agent */
  agentId?: string;
  /** Thinking/reasoning-effort override */
  thinkingLevel?: string | null;
  /** Pin timestamp, or null to remove a pin. */
  pinnedAt?: string | null;
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
  /** Sort order: 'asc' (oldest first, default) or 'desc' (newest first) */
  order?: "asc" | "desc";
}

// ── Room Chat Types ──────────────────────────────────────────────────

export type ChatRoomStatus = "active" | "archived";

export type RoomMemberRole = "owner" | "member";

export interface ChatRoom {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  projectId: string | null;
  createdBy: string | null;
  status: ChatRoomStatus;
  /** Optional room-level thinking/reasoning-effort default for all responders; NULL means inherit the resolved project/global default. */
  /*
   * FNXC:Chat-ThinkingLevel 2026-07-12-00:00:
   * Chat Rooms model one conversation-level reasoning-effort default shared by every responder. Per-member thinking overrides are intentionally not represented here so room delivery preserves one predictable setting surface.
   */
  thinkingLevel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatRoomMember {
  roomId: string;
  agentId: string;
  role: RoomMemberRole;
  addedAt: string;
}

export interface ChatRoomMessage {
  id: string;
  roomId: string;
  role: ChatMessageRole;
  content: string;
  thinkingOutput: string | null;
  metadata: Record<string, unknown> | null;
  attachments?: ChatAttachment[];
  senderAgentId: string | null;
  mentions: string[];
  createdAt: string;
}

/**
 * Alias retained for callers that explicitly reason about parsed mention payloads.
 */
export type ChatRoomMessageWithMentions = ChatRoomMessage;

export interface ChatRoomCreateInput {
  name: string;
  description?: string | null;
  projectId?: string | null;
  createdBy?: string | null;
  /** Optional room-level thinking/reasoning-effort default; undefined/NULL means inherit the resolved project/global default. */
  thinkingLevel?: string | null;
}

export interface ChatRoomUpdateInput {
  name?: string;
  description?: string | null;
  status?: ChatRoomStatus;
  /** Optional room-level thinking/reasoning-effort default; undefined leaves unchanged, NULL clears to inherit the resolved project/global default. */
  thinkingLevel?: string | null;
}

export interface ChatRoomMessageCreateInput {
  role: ChatMessageRole;
  content: string;
  thinkingOutput?: string | null;
  metadata?: Record<string, unknown> | null;
  attachments?: ChatAttachment[];
  senderAgentId?: string | null;
  mentions?: string[];
}

export interface ChatRoomMessagesFilter {
  limit?: number;
  offset?: number;
  before?: string;
  order?: "asc" | "desc";
}
