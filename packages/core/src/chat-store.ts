/**
 * ChatStore - Data layer for the agent chat system.
 *
 * Manages CRUD operations for chat sessions and messages.
 * Provides event emission for dashboard reactivity.
 *
 * Uses PostgreSQL through the project AsyncDataLayer and emits change events
 * for dashboard reactivity.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AsyncDataLayer } from "./postgres/data-layer.js";
import { sql } from "drizzle-orm";
import { asc } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import * as asyncChatStore from "./async-chat-store.js";
import type {
  ChatSession,
  ChatSessionStatus,
  ChatMessage,
  ChatAttachment,
  ChatMessageCreateInput,
  ChatSessionCreateInput,
  ChatSessionUpdateInput,
  ChatMessagesFilter,
  ChatRoom,
  ChatInFlightGenerationState,
  ChatRoomCreateInput,
  ChatRoomMember,
  ChatRoomMessage,
  ChatRoomMessageCreateInput,
  ChatRoomMessagesFilter,
  ChatRoomStatus,
  ChatRoomUpdateInput,
  RoomMemberRole,
  ChatTokenUsageCreateInput,
  ChatTokenUsageRecord,
  ChatTokenUsageSourceKind,
} from "./chat-types.js";

// ── Event Types ─────────────────────────────────────────────────────

export interface ChatStoreEvents {
  /** Emitted when a chat session is created */
  "chat:session:created": [session: ChatSession];
  /** Emitted when a chat session is updated */
  "chat:session:updated": [session: ChatSession];
  /** Emitted when a chat session is deleted */
  "chat:session:deleted": [sessionId: string];
  /** Emitted when a message is added to a session */
  "chat:message:added": [message: ChatMessage];
  /** Emitted when a message is deleted from a session */
  "chat:message:deleted": [messageId: string];
  /** Emitted when a message is updated (e.g., attachment appended) */
  "chat:message:updated": [message: ChatMessage];
  /** Emitted when a room is created */
  "chat:room:created": [room: ChatRoom];
  /** Emitted when a room is updated */
  "chat:room:updated": [room: ChatRoom];
  /** Emitted when a room is deleted */
  "chat:room:deleted": [roomId: string];
  /** Emitted when a room member is added */
  "chat:room:member:added": [member: ChatRoomMember];
  /** Emitted when a room member is removed */
  "chat:room:member:removed": [payload: { roomId: string; agentId: string }];
  /** Emitted when a room message is added */
  "chat:room:message:added": [message: ChatRoomMessage];
  /** Emitted when a room message is updated */
  "chat:room:message:updated": [message: ChatRoomMessage];
  /** Emitted when a room message is deleted */
  "chat:room:message:deleted": [messageId: string];
  /** Emitted when all room messages are cleared */
  "chat:room:messages:cleared": [payload: { roomId: string; deletedCount: number }];
}

// ── ChatStore Class ─────────────────────────────────────────────────

export class ChatStore extends EventEmitter<ChatStoreEvents> {
  /**
   * FNXC:PostgresChatStore 2026-07-14-19:15:
   * Chat persistence is PostgreSQL-only after the storage cutover. Requiring
   * AsyncDataLayer at construction prevents a reachable SQLite fallback.
   */
  constructor(private readonly asyncLayer: AsyncDataLayer) {
    super();
    this.setMaxListeners(100);
  }

  private normalizeRoomName(name: string): string {
    return name.trim().replace(/^#+/, "").trim();
  }

  private buildRoomSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  // ── Session CRUD Operations ───────────────────────────────────────

  /**
   * Create a new chat session.
   *
   * @param input - Session creation input
   * @returns The created session
   */
  async createSession(input: ChatSessionCreateInput): Promise<ChatSession> {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: `chat-${randomUUID().slice(0, 8)}`,
      agentId: input.agentId,
      title: input.title ?? null,
      status: "active",
      projectId: input.projectId ?? null,
      modelProvider: input.modelProvider ?? null,
      modelId: input.modelId ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      createdAt: now,
      updatedAt: now,
      cliSessionFile: null,
      inFlightGeneration: null,
      cliExecutorAdapterId: input.cliExecutorAdapterId ?? null,
    };
    const created = await asyncChatStore.createChatSession(this.asyncLayer.db, session);
    this.emit("chat:session:created", created);
    return created;
  }

  /**
   * Get a chat session by ID.
   *
   * @param id - Session ID
   * @returns The session, or undefined if not found
   */
  async getSession(id: string): Promise<ChatSession | undefined> {
    return asyncChatStore.getChatSession(this.asyncLayer.db, id);
  }

  /**
   * List chat sessions with optional filtering.
   *
   * @param options - Optional filter options
   * @returns Array of sessions ordered by updatedAt DESC
   */
  async listSessions(options?: {
    projectId?: string;
    agentId?: string;
    status?: ChatSessionStatus;
  }): Promise<ChatSession[]> {
    return asyncChatStore.listChatSessions(this.asyncLayer.db, options);
  }

  /**
   * Find the newest active session for a specific quick-chat target.
   *
   * Matching semantics:
   * - model target (`modelProvider` + `modelId`): exact agent+model match
   * - agent target (no model): prefer model-less sessions, then newest agent session fallback
   */
  async findLatestActiveSessionForTarget(options: {
    agentId: string;
    projectId?: string;
    modelProvider?: string;
    modelId?: string;
  }): Promise<ChatSession | undefined> {
    return asyncChatStore.findLatestActiveChatSessionForTarget(this.asyncLayer.db, options);
  }

  /**
   * Update a chat session.
   *
   * @param id - Session ID
   * @param input - Partial session updates
   * @returns The updated session, or undefined if not found
   */
  async updateSession(id: string, input: ChatSessionUpdateInput): Promise<ChatSession | undefined> {
    const updated = await asyncChatStore.updateChatSession(this.asyncLayer.db, id, input);
    if (updated) this.emit("chat:session:updated", updated);
    return updated;
  }

  /**
   * Archive a chat session.
   * Convenience method that sets status to "archived".
   *
   * @param id - Session ID
   * @returns The archived session, or undefined if not found
   */
  async archiveSession(id: string): Promise<ChatSession | undefined> {
    return this.updateSession(id, { status: "archived" });
  }

  /**
   * Persist the pi/Claude CLI session file path for a chat. Called once,
   * after the SessionManager for the chat first creates its on-disk file,
   * so subsequent turns can reopen it via SessionManager.open.
   *
   * Does not bump updatedAt or emit events — this is internal plumbing,
   * not a user-visible state change.
   *
   * @param id - Session ID
   * @param cliSessionFile - Absolute path to the session file, or null to clear
   */
  async setCliSessionFile(id: string, cliSessionFile: string | null): Promise<void> {
    await asyncChatStore.setCliSessionFile(this.asyncLayer.db, id, cliSessionFile);
    return;
  }

  /**
   * Set (or clear) the cli-agent adapter that backs this chat session (U12).
   * When set, the chat is CLI-backed: composer sends route through the inject
   * path and adapter transcript events map to chat_messages rows. Emits a
   * session update so the client can switch to the CLI-backed rendering path.
   *
   * @param id - Session ID
   * @param adapterId - cli-agent adapter id, or null to revert to the provider path
   */
  async setCliExecutorAdapterId(id: string, adapterId: string | null): Promise<ChatSession | undefined> {
    const updated = await asyncChatStore.setCliExecutorAdapterId(this.asyncLayer.db, id, adapterId);
    if (updated) this.emit("chat:session:updated", updated);
    return updated;
  }

  async setInFlightGeneration(id: string, inFlightGeneration: ChatInFlightGenerationState | null): Promise<ChatSession | undefined> {
    const updated = await asyncChatStore.setInFlightGeneration(this.asyncLayer.db, id, inFlightGeneration);
    if (updated) this.emit("chat:session:updated", updated);
    return updated;
  }

  /**
   * Delete a chat session and all its messages.
   * Messages are cascade-deleted via foreign key constraint.
   *
   * @param id - Session ID
   * @returns true if deleted, false if not found
   */
  async deleteSession(id: string): Promise<boolean> {
    const deleted = await asyncChatStore.deleteChatSession(this.asyncLayer.db, id);
    if (deleted) this.emit("chat:session:deleted", id);
    return deleted;
  }

  async deleteSessionsForAgentId(agentId: string, options?: { projectId?: string | null }): Promise<number> {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) return 0;
    const projectId = options?.projectId ?? undefined;
    const sessions = await this.listSessions({
      agentId: normalizedAgentId,
      ...(projectId ? { projectId } : {}),
    });
    let deletedCount = 0;
    for (const session of sessions) {
      if (await this.deleteSession(session.id)) {
        deletedCount += 1;
      }
    }
    return deletedCount;
  }

  // ── Message CRUD Operations ───────────────────────────────────────

  /**
   * Add a message to a chat session.
   *
   * @param sessionId - Parent session ID
   * @param input - Message content and metadata
   * @returns The created message
   * @throws Error if session does not exist
   */
  async addMessage(sessionId: string, input: ChatMessageCreateInput): Promise<ChatMessage> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Chat session ${sessionId} not found`);
    }
    const now = new Date().toISOString();
    const message: ChatMessage = {
      id: `msg-${randomUUID().slice(0, 8)}`,
      sessionId,
      role: input.role,
      content: input.content,
      thinkingOutput: input.thinkingOutput ?? null,
      metadata: input.metadata ?? null,
      attachments: input.attachments,
      createdAt: now,
    };
    const created = await asyncChatStore.addChatMessage(this.asyncLayer.db, message);
    this.emit("chat:message:added", created);
    return created;
  }

  /**
   * Append a file attachment metadata record to an existing message.
   */
  async addMessageAttachment(sessionId: string, messageId: string, attachment: ChatAttachment): Promise<ChatMessage> {
    const updated = await asyncChatStore.addChatMessageAttachment(this.asyncLayer.db, sessionId, messageId, attachment);
    this.emit("chat:message:updated", updated);
    return updated;
  }

  /**
   * Get messages for a chat session with optional filtering.
   *
   * @param sessionId - Session ID
   * @param filter - Optional filter (limit, offset, before cursor)
   * @returns Array of messages ordered by createdAt ASC (default) or DESC
   */
  async getMessages(sessionId: string, filter?: ChatMessagesFilter): Promise<ChatMessage[]> {
    return asyncChatStore.getChatMessages(this.asyncLayer.db, sessionId, filter);
  }

  /**
   * Get a message by ID.
   *
   * @param id - Message ID
   * @returns The message, or undefined if not found
   */
  async getMessage(id: string): Promise<ChatMessage | undefined> {
    return asyncChatStore.getChatMessage(this.asyncLayer.db, id);
  }

  /**
   * Get the latest message for each session in the provided list.
   * Uses a single SQL query with GROUP BY and MAX to efficiently fetch last messages.
   *
   * @param sessionIds - Array of session IDs to fetch last messages for
   * @returns Map of sessionId -> latest ChatMessage for that session
   */
  async getLastMessageForSessions(sessionIds: string[]): Promise<Map<string, ChatMessage>> {
    return asyncChatStore.getLastMessageForSessions(this.asyncLayer.db, sessionIds);
  }

  async hasMessages(sessionId: string): Promise<boolean> {
    return (await asyncChatStore.getChatMessages(this.asyncLayer.db, sessionId, { limit: 1 })).length > 0;
  }

  /**
   * Search sessions by message content (not just title/agentId).
   *
   * FNXC:ChatSearch 2026-07-07-00:00:
   * Message content is not fully loaded client-side (only sessions + a last-message preview
   * are), so "find a conversation by something that was said in it" requires a server round
   * trip against chat_messages. There is no FTS table for chat_messages (see db.ts schema), so
   * this uses a parameterized SQL `LIKE ... ESCAPE '\'` query — never string-concatenated —
   * with `%`/`_`/`\` escaped in the search term so a literal `%` or `_` typed by the user is
   * matched literally rather than acting as a wildcard (injection- and wildcard-safety).
   *
   * Scoped to the given session IDs (already filtered by projectId/status/agentId by the
   * caller via listSessions) to keep the query bounded and avoid re-deriving scope filters
   * against chat_sessions here. Deduplicates to one row per session using MAX(createdAt) so a
   * session with multiple matching messages appears once, with a preview of its most recent
   * matching message (truncated to ~100 chars, mirroring getLastMessageForSessions).
   *
   * @param query - Raw user search text (content match)
   * @param sessionIds - Session IDs to search within (already scope-filtered by the caller)
   * @returns Map of sessionId -> truncated preview of the most recent matching message
   */
  async searchSessionsByMessageContent(query: string, sessionIds: string[]): Promise<Map<string, string>> {
    const trimmed = query.trim();
    if (!trimmed || !sessionIds || sessionIds.length === 0) {
      return new Map();
    }
    return asyncChatStore.searchChatSessionsByMessageContent(this.asyncLayer.db, trimmed, sessionIds);
  }

  /**
   * Delete a message by ID.
   *
   * @param id - Message ID
   * @returns true if deleted, false if not found
   */
  async deleteMessage(id: string): Promise<boolean> {
    const existing = await asyncChatStore.getChatMessage(this.asyncLayer.db, id);
    if (!existing) return false;
    const deleted = await asyncChatStore.deleteChatMessage(this.asyncLayer.db, id);
    if (deleted) {
      this.emit("chat:message:deleted", id);
      const updatedSession = await this.getSession(existing.sessionId);
      if (updatedSession) this.emit("chat:session:updated", updatedSession);
    }
    return deleted;
  }

  /**
   * FNXC:ChatMessageEdit 2026-07-07-09:00:
   * Truncate a chat session from (and including) a target message onward. Editing an earlier
   * user turn must "forget" that turn and every turn after it — both from the persisted
   * transcript here AND from the model's resumable pi session context (rewound separately by
   * ChatManager.rewindSessionForEdit) — so future responses are not biased by discarded turns.
   *
   * Ordering uses (createdAt ASC, id ASC), so same-millisecond messages have a
   * deterministic PostgreSQL tiebreaker matching getLastMessageForSessions.
   *
   * @param sessionId - Parent session ID
   * @param fromMessageId - Id of the earliest message to delete (inclusive)
   * @returns deletedIds (in ASC order) and retained messages (pre-edit history, ASC order)
   */
  async deleteMessagesFrom(sessionId: string, fromMessageId: string): Promise<{ deletedIds: string[]; retained: ChatMessage[] }> {
    const result = await asyncChatStore.deleteChatMessagesFrom(this.asyncLayer.db, sessionId, fromMessageId);
    if (result.deletedIds.length > 0) {
      for (const id of result.deletedIds) {
        this.emit("chat:message:deleted", id);
      }
      const updatedSession = await this.getSession(sessionId);
      if (updatedSession) this.emit("chat:session:updated", updatedSession);
    }
    return result;
  }

  /**
   * FNXC:ChatMessageEdit 2026-07-07-09:00:
   * Merge (default) or replace a persisted message's metadata. Used by the model-loop generation
   * path to record the pi SessionManager parent-leaf id (`metadata.piParentLeafId`) onto the
   * just-created user message, without disturbing other metadata (e.g. `mentions`). This linkage
   * is what lets a later edit rewind losslessly via SessionManager.branch()/resetLeaf().
   */
  async updateMessageMetadata(messageId: string, metadata: Record<string, unknown> | null, options?: { merge?: boolean }): Promise<ChatMessage> {
    const updated = await asyncChatStore.updateChatMessageMetadata(this.asyncLayer.db, messageId, metadata, options);
    this.emit("chat:message:updated", updated);
    return updated;
  }

  async createRoom(input: ChatRoomCreateInput & { memberAgentIds?: string[] }): Promise<ChatRoom> {
    const normalizedName = this.normalizeRoomName(input.name);
    if (!normalizedName) throw new Error("Room name cannot be empty");

    const slug = this.buildRoomSlug(normalizedName);
    if (!slug) throw new Error("Room name must include letters or numbers");

    const now = new Date().toISOString();
    const room: ChatRoom = {
      id: `room-${randomUUID().slice(0, 8)}`,
      name: normalizedName,
      slug,
      description: input.description ?? null,
      projectId: input.projectId ?? null,
      createdBy: input.createdBy ?? null,
      status: "active",
      thinkingLevel: input.thinkingLevel ?? null,
      createdAt: now,
      updatedAt: now,
    };

    const memberIds = [...new Set((input.memberAgentIds ?? []).map((id) => id.trim()).filter(Boolean))];
    const result = await asyncChatStore.createChatRoom(this.asyncLayer, room, memberIds);
    this.emit("chat:room:created", result.room);
    for (const member of result.members) {
      this.emit("chat:room:member:added", member);
    }
    return result.room;
  }

  async getRoom(id: string): Promise<ChatRoom | undefined> {
    return asyncChatStore.getChatRoom(this.asyncLayer.db, id);
  }

  async getRoomBySlug(projectId: string | null, slug: string): Promise<ChatRoom | undefined> {
    return asyncChatStore.getChatRoomBySlug(this.asyncLayer.db, projectId, slug);
  }

  async listRooms(options?: { projectId?: string; status?: ChatRoomStatus }): Promise<ChatRoom[]> {
    return asyncChatStore.listChatRooms(this.asyncLayer.db, options);
  }

  async updateRoom(id: string, input: ChatRoomUpdateInput): Promise<ChatRoom | undefined> {
    // Build slug/name from the input mirroring the sync path.
    let updateInput: Parameters<typeof asyncChatStore.updateChatRoom>[2] = {};
    if (input.name !== undefined) {
      const normalizedName = this.normalizeRoomName(input.name);
      if (!normalizedName) throw new Error("Room name cannot be empty");
      const slug = this.buildRoomSlug(normalizedName);
      if (!slug) throw new Error("Room name must include letters or numbers");
      const existing = await this.getRoom(id);
      if (existing) {
        const slugConflict = await asyncChatStore.getChatRoomBySlug(this.asyncLayer.db, existing.projectId, slug);
        if (slugConflict && slugConflict.id !== id) {
          throw new Error(`Room slug ${slug} already exists in this project`);
        }
      }
      updateInput = { name: normalizedName, slug };
    }
    if (input.description !== undefined) updateInput.description = input.description;
    if (input.status !== undefined) updateInput.status = input.status;
    const updated = await asyncChatStore.updateChatRoom(this.asyncLayer.db, id, updateInput);
    if (updated) this.emit("chat:room:updated", updated);
    return updated;
  }

  async deleteRoom(id: string): Promise<boolean> {
    const deleted = await asyncChatStore.deleteChatRoom(this.asyncLayer.db, id);
    if (deleted) this.emit("chat:room:deleted", id);
    return deleted;
  }

  async cleanupOldChats(maxAgeMs: number): Promise<{ sessionsDeleted: number; roomsDeleted: number }> {
    const result = await asyncChatStore.cleanupOldChats(this.asyncLayer.db, maxAgeMs);
    for (const sessionId of result.deletedSessionIds) {
      this.emit("chat:session:deleted", sessionId);
    }
    for (const roomId of result.deletedRoomIds) {
      this.emit("chat:room:deleted", roomId);
    }
    return { sessionsDeleted: result.sessionsDeleted, roomsDeleted: result.roomsDeleted };
  }

  async addRoomMember(roomId: string, agentId: string, role: RoomMemberRole = "member"): Promise<ChatRoomMember> {
    const now = new Date().toISOString();
    await asyncChatStore.addChatRoomMember(this.asyncLayer.db, roomId, agentId, role, now);
    const members = await this.listRoomMembers(roomId);
    const member = members.find((m) => m.agentId === agentId);
    if (!member) throw new Error(`Failed to load room member ${agentId}`);
    this.emit("chat:room:member:added", member);
    return member;
  }

  async removeRoomMember(roomId: string, agentId: string): Promise<boolean> {
    const removed = await asyncChatStore.removeChatRoomMember(this.asyncLayer.db, roomId, agentId);
    if (removed) this.emit("chat:room:member:removed", { roomId, agentId });
    return removed;
  }

  async listRoomMembers(roomId: string): Promise<ChatRoomMember[]> {
    return asyncChatStore.listChatRoomMembers(this.asyncLayer.db, roomId);
  }

  async listRoomsForAgent(agentId: string, options?: { projectId?: string; status?: ChatRoomStatus }): Promise<ChatRoom[]> {
    return asyncChatStore.listChatRoomsForAgent(this.asyncLayer.db, agentId, options);
  }

  async addRoomMessage(roomId: string, input: ChatRoomMessageCreateInput): Promise<ChatRoomMessage> {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error(`Chat room ${roomId} not found`);
    }
    const now = new Date().toISOString();
    const message: ChatRoomMessage = {
      id: `rmsg-${randomUUID().slice(0, 8)}`,
      roomId,
      role: input.role,
      content: input.content,
      thinkingOutput: input.thinkingOutput ?? null,
      metadata: input.metadata ?? null,
      attachments: input.attachments,
      senderAgentId: input.senderAgentId ?? null,
      mentions: input.mentions ?? [],
      createdAt: now,
    };
    const created = await asyncChatStore.addChatRoomMessage(this.asyncLayer.db, message);
    this.emit("chat:room:message:added", created);
    return created;
  }

  async getRoomMessages(roomId: string, filter?: ChatRoomMessagesFilter): Promise<ChatRoomMessage[]> {
    return asyncChatStore.getChatRoomMessages(this.asyncLayer.db, roomId, filter);
  }

  async listRoomMessagesSince(
    roomId: string,
    sinceIso: string,
    options?: { excludeSenderAgentId?: string; limit?: number },
  ): Promise<ChatRoomMessage[]> {
    return asyncChatStore.listChatRoomMessagesSince(this.asyncLayer.db, roomId, sinceIso, options);
  }

  async getRoomMessage(id: string): Promise<ChatRoomMessage | undefined> {
    return asyncChatStore.getChatRoomMessage(this.asyncLayer.db, id);
  }

  async deleteRoomMessage(id: string): Promise<boolean> {
    const existing = await asyncChatStore.getChatRoomMessage(this.asyncLayer.db, id);
    if (!existing) return false;
    const deleted = await asyncChatStore.deleteChatRoomMessage(this.asyncLayer.db, id);
    if (deleted) {
      this.emit("chat:room:message:deleted", id);
      const updatedRoom = await this.getRoom(existing.roomId);
      if (updatedRoom) this.emit("chat:room:updated", updatedRoom);
    }
    return deleted;
  }

  async clearRoomMessages(roomId: string): Promise<number> {
    const deleted = await asyncChatStore.clearChatRoomMessages(this.asyncLayer.db, roomId);
    if (deleted > 0) this.emit("chat:room:messages:cleared", { roomId, deletedCount: deleted });
    return deleted;
  }

  async addRoomMessageAttachment(roomId: string, messageId: string, attachment: ChatAttachment): Promise<ChatRoomMessage> {
    const updated = await asyncChatStore.addChatRoomMessageAttachment(this.asyncLayer.db, roomId, messageId, attachment);
    this.emit("chat:room:message:updated", updated);
    return updated;
  }

  async recordTokenUsage(input: ChatTokenUsageCreateInput): Promise<ChatTokenUsageRecord | undefined> {
    const inputTokens = Math.max(0, Math.trunc(input.inputTokens));
    const outputTokens = Math.max(0, Math.trunc(input.outputTokens));
    const cachedTokens = Math.max(0, Math.trunc(input.cachedTokens));
    const cacheWriteTokens = Math.max(0, Math.trunc(input.cacheWriteTokens));
    const totalTokens = Math.max(0, Math.trunc(input.totalTokens ?? (inputTokens + outputTokens + cachedTokens + cacheWriteTokens)));
    if (inputTokens === 0 && outputTokens === 0 && cachedTokens === 0 && cacheWriteTokens === 0 && totalTokens === 0) {
      return undefined;
    }

    const record: ChatTokenUsageRecord = {
      id: `chat-tokens-${randomUUID().slice(0, 12)}`,
      sourceKind: input.sourceKind,
      chatSessionId: input.chatSessionId ?? null,
      roomId: input.roomId ?? null,
      messageId: input.messageId ?? null,
      projectId: input.projectId ?? null,
      agentId: input.agentId ?? null,
      modelProvider: input.modelProvider ?? null,
      modelId: input.modelId ?? null,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens,
      totalTokens,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    const layer = this.asyncLayer;
    /* FNXC:PostgresChatUsage 2026-07-14-18:49: Token accounting is durable before a chat turn reports completion; callers await the insert so shutdown and immediate analytics cannot lose or race the record. */
    /* FNXC:MultiProjectIsolation 2026-07-15-23:40: the record's domain projectId is written to owner_project_id; project_id (the RLS partition) is omitted so the fusion_assign_project_id trigger/GUC owns it (migration 0011). */
    await layer.db.execute(sql`INSERT INTO project.chat_token_usage (
      id, source_kind, chat_session_id, room_id, message_id, owner_project_id, agent_id,
      model_provider, model_id, input_tokens, output_tokens, cached_tokens,
      cache_write_tokens, total_tokens, created_at
    ) VALUES (
      ${record.id}, ${record.sourceKind}, ${record.chatSessionId}, ${record.roomId},
      ${record.messageId}, ${record.projectId}, ${record.agentId},
      ${record.modelProvider}, ${record.modelId}, ${record.inputTokens}, ${record.outputTokens},
      ${record.cachedTokens}, ${record.cacheWriteTokens}, ${record.totalTokens}, ${record.createdAt}
    )`);
    return record;
  }

  /** Authoritative PostgreSQL token-usage reader. */
  async listTokenUsageAsync(): Promise<ChatTokenUsageRecord[]> {
    /* FNXC:PostgresChatUsage 2026-07-14-18:40: Public chat accounting reads must return durable PostgreSQL records instead of the synchronous compatibility facade's empty value. */
    const rows = await this.asyncLayer.db
      .select()
      .from(schema.project.chatTokenUsage)
      .orderBy(asc(schema.project.chatTokenUsage.createdAt), asc(schema.project.chatTokenUsage.id));
    return rows.map((row) => ({
      id: row.id, sourceKind: row.sourceKind as ChatTokenUsageSourceKind,
      chatSessionId: row.chatSessionId, roomId: row.roomId, messageId: row.messageId,
      projectId: row.ownerProjectId, agentId: row.agentId, modelProvider: row.modelProvider,
      modelId: row.modelId, inputTokens: row.inputTokens, outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens, cacheWriteTokens: row.cacheWriteTokens,
      totalTokens: row.totalTokens, createdAt: row.createdAt,
    }));
  }
}
