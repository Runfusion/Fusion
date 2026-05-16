/**
 * ChatStore - Data layer for the agent chat system.
 *
 * Manages CRUD operations for chat sessions and messages.
 * Provides event emission for dashboard reactivity.
 *
 * Follows the same patterns as MissionStore:
 * - EventEmitter for change notifications
 * - SQLite for structured data storage
 * - JSON columns for nested data
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { fromJson, toJsonNullable } from "./db.js";
import type {
  ChatSession,
  ChatSessionStatus,
  ChatMessage,
  ChatMessageRole,
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
}

// ── Row Interfaces ───────────────────────────────────────────────────

/** Database row shape for chat_sessions. */
interface ChatSessionRow {
  id: string;
  agentId: string;
  title: string | null;
  status: string;
  projectId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
  cliSessionFile: string | null;
  inFlightGeneration: string | null;
}

/** Database row shape for chat_messages. */
interface ChatMessageRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  thinkingOutput: string | null;
  metadata: string | null;
  attachments: string | null;
  createdAt: string;
}

interface ChatRoomRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  projectId: string | null;
  createdBy: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatRoomMemberRow {
  roomId: string;
  agentId: string;
  role: string;
  addedAt: string;
}

interface ChatRoomMessageRow {
  id: string;
  roomId: string;
  role: string;
  content: string;
  thinkingOutput: string | null;
  metadata: string | null;
  attachments: string | null;
  senderAgentId: string | null;
  mentions: string | null;
  createdAt: string;
}

// ── ChatStore Class ─────────────────────────────────────────────────

export class ChatStore extends EventEmitter<ChatStoreEvents> {
  constructor(
    private fusionDir: string,
    private db: Database,
  ) {
    super();
    this.setMaxListeners(100);
  }

  // ── Row-to-Object Converters ───────────────────────────────────────

  /**
   * Convert a database row to a ChatSession object.
   */
  private rowToSession(row: ChatSessionRow): ChatSession {
    return {
      id: row.id,
      agentId: row.agentId,
      title: row.title ?? null,
      status: row.status as ChatSessionStatus,
      projectId: row.projectId ?? null,
      modelProvider: row.modelProvider ?? null,
      modelId: row.modelId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      cliSessionFile: row.cliSessionFile ?? null,
      inFlightGeneration: fromJson<ChatInFlightGenerationState>(row.inFlightGeneration) ?? null,
    };
  }

  /**
   * Convert a database row to a ChatMessage object.
   */
  private rowToMessage(row: ChatMessageRow): ChatMessage {
    return {
      id: row.id,
      sessionId: row.sessionId,
      role: row.role as ChatMessageRole,
      content: row.content,
      thinkingOutput: row.thinkingOutput ?? null,
      metadata: fromJson<Record<string, unknown>>(row.metadata) ?? null,
      attachments: fromJson<ChatAttachment[]>(row.attachments) ?? undefined,
      createdAt: row.createdAt,
    };
  }

  private rowToRoom(row: ChatRoomRow): ChatRoom {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description ?? null,
      projectId: row.projectId ?? null,
      createdBy: row.createdBy ?? null,
      status: row.status as ChatRoomStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToRoomMember(row: ChatRoomMemberRow): ChatRoomMember {
    return {
      roomId: row.roomId,
      agentId: row.agentId,
      role: row.role as RoomMemberRole,
      addedAt: row.addedAt,
    };
  }

  private rowToRoomMessage(row: ChatRoomMessageRow): ChatRoomMessage {
    return {
      id: row.id,
      roomId: row.roomId,
      role: row.role as ChatMessageRole,
      content: row.content,
      thinkingOutput: row.thinkingOutput ?? null,
      metadata: fromJson<Record<string, unknown>>(row.metadata) ?? null,
      attachments: fromJson<ChatAttachment[]>(row.attachments) ?? undefined,
      senderAgentId: row.senderAgentId ?? null,
      mentions: fromJson<string[]>(row.mentions) ?? [],
      createdAt: row.createdAt,
    };
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
  createSession(input: ChatSessionCreateInput): ChatSession {
    const now = new Date().toISOString();
    const id = `chat-${randomUUID().slice(0, 8)}`;

    const session: ChatSession = {
      id,
      agentId: input.agentId,
      title: input.title ?? null,
      status: "active",
      projectId: input.projectId ?? null,
      modelProvider: input.modelProvider ?? null,
      modelId: input.modelId ?? null,
      createdAt: now,
      updatedAt: now,
      cliSessionFile: null,
      inFlightGeneration: null,
    };

    this.db.prepare(`
      INSERT INTO chat_sessions (id, agentId, title, status, projectId, modelProvider, modelId, createdAt, updatedAt, inFlightGeneration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.agentId,
      session.title,
      session.status,
      session.projectId,
      session.modelProvider,
      session.modelId,
      session.createdAt,
      session.updatedAt,
      null,
    );

    this.db.bumpLastModified();
    this.emit("chat:session:created", session);
    return session;
  }

  /**
   * Get a chat session by ID.
   *
   * @param id - Session ID
   * @returns The session, or undefined if not found
   */
  getSession(id: string): ChatSession | undefined {
    const row = this.db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as unknown as ChatSessionRow | undefined;
    if (!row) return undefined;
    return this.rowToSession(row);
  }

  /**
   * List chat sessions with optional filtering.
   *
   * @param options - Optional filter options
   * @returns Array of sessions ordered by updatedAt DESC
   */
  listSessions(options?: {
    projectId?: string;
    agentId?: string;
    status?: ChatSessionStatus;
  }): ChatSession[] {
    const whereClauses: string[] = [];
    const params: string[] = [];

    if (options?.projectId) {
      whereClauses.push("projectId = ?");
      params.push(options.projectId);
    }
    if (options?.agentId) {
      whereClauses.push("agentId = ?");
      params.push(options.agentId);
    }
    if (options?.status) {
      whereClauses.push("status = ?");
      params.push(options.status);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const rows = this.db.prepare(`
      SELECT * FROM chat_sessions ${whereSql} ORDER BY updatedAt DESC
    `).all(...params);

    return (rows as unknown as ChatSessionRow[]).map((row) => this.rowToSession(row));
  }

  /**
   * Find the newest active session for a specific quick-chat target.
   *
   * Matching semantics:
   * - model target (`modelProvider` + `modelId`): exact agent+model match
   * - agent target (no model): prefer model-less sessions, then newest agent session fallback
   */
  findLatestActiveSessionForTarget(options: {
    agentId: string;
    projectId?: string;
    modelProvider?: string;
    modelId?: string;
  }): ChatSession | undefined {
    const normalizedAgentId = options.agentId.trim();
    if (!normalizedAgentId) {
      return undefined;
    }

    const normalizedProvider = options.modelProvider?.trim();
    const normalizedModelId = options.modelId?.trim();

    if ((normalizedProvider && !normalizedModelId) || (!normalizedProvider && normalizedModelId)) {
      throw new Error("modelProvider and modelId must both be provided together, or neither");
    }

    const whereClauses: string[] = ["status = ?", "agentId = ?"];
    const baseParams: string[] = ["active", normalizedAgentId];

    if (options.projectId && options.projectId.trim()) {
      whereClauses.push("projectId = ?");
      baseParams.push(options.projectId.trim());
    }

    const baseWhereSql = whereClauses.join(" AND ");

    if (normalizedProvider && normalizedModelId) {
      const row = this.db.prepare(`
        SELECT * FROM chat_sessions
        WHERE ${baseWhereSql} AND modelProvider = ? AND modelId = ?
        ORDER BY updatedAt DESC
        LIMIT 1
      `).get(...baseParams, normalizedProvider, normalizedModelId) as ChatSessionRow | undefined;
      return row ? this.rowToSession(row) : undefined;
    }

    const modelLessRow = this.db.prepare(`
      SELECT * FROM chat_sessions
      WHERE ${baseWhereSql}
        AND COALESCE(TRIM(modelProvider), '') = ''
        AND COALESCE(TRIM(modelId), '') = ''
      ORDER BY updatedAt DESC
      LIMIT 1
    `).get(...baseParams) as ChatSessionRow | undefined;

    if (modelLessRow) {
      return this.rowToSession(modelLessRow);
    }

    const fallbackRow = this.db.prepare(`
      SELECT * FROM chat_sessions
      WHERE ${baseWhereSql}
      ORDER BY updatedAt DESC
      LIMIT 1
    `).get(...baseParams) as ChatSessionRow | undefined;

    return fallbackRow ? this.rowToSession(fallbackRow) : undefined;
  }

  /**
   * Update a chat session.
   *
   * @param id - Session ID
   * @param input - Partial session updates
   * @returns The updated session, or undefined if not found
   */
  updateSession(id: string, input: ChatSessionUpdateInput): ChatSession | undefined {
    const existing = this.getSession(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const setClauses: string[] = ["updatedAt = ?"];
    const params: (string | null)[] = [now];

    if (input.title !== undefined) {
      setClauses.push("title = ?");
      params.push(input.title);
    }
    if (input.status !== undefined) {
      setClauses.push("status = ?");
      params.push(input.status);
    }
    if (input.modelProvider !== undefined) {
      setClauses.push("modelProvider = ?");
      params.push(input.modelProvider);
    }
    if (input.modelId !== undefined) {
      setClauses.push("modelId = ?");
      params.push(input.modelId);
    }

    params.push(id);

    this.db.prepare(`
      UPDATE chat_sessions SET ${setClauses.join(", ")} WHERE id = ?
    `).run(...params);

    const updated = this.getSession(id)!;
    this.db.bumpLastModified();
    this.emit("chat:session:updated", updated);
    return updated;
  }

  /**
   * Archive a chat session.
   * Convenience method that sets status to "archived".
   *
   * @param id - Session ID
   * @returns The archived session, or undefined if not found
   */
  archiveSession(id: string): ChatSession | undefined {
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
  setCliSessionFile(id: string, cliSessionFile: string | null): void {
    this.db
      .prepare("UPDATE chat_sessions SET cliSessionFile = ? WHERE id = ?")
      .run(cliSessionFile, id);
    this.db.bumpLastModified();
  }

  setInFlightGeneration(id: string, inFlightGeneration: ChatInFlightGenerationState | null): ChatSession | undefined {
    const existing = this.getSession(id);
    if (!existing) return undefined;

    this.db
      .prepare("UPDATE chat_sessions SET inFlightGeneration = ? WHERE id = ?")
      .run(toJsonNullable(inFlightGeneration), id);

    const updated = this.getSession(id)!;
    this.db.bumpLastModified();
    this.emit("chat:session:updated", updated);
    return updated;
  }

  /**
   * Delete a chat session and all its messages.
   * Messages are cascade-deleted via foreign key constraint.
   *
   * @param id - Session ID
   * @returns true if deleted, false if not found
   */
  deleteSession(id: string): boolean {
    const existing = this.getSession(id);
    if (!existing) return false;

    this.db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
    this.db.bumpLastModified();
    this.emit("chat:session:deleted", id);
    return true;
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
  addMessage(sessionId: string, input: ChatMessageCreateInput): ChatMessage {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Chat session ${sessionId} not found`);
    }

    const now = new Date().toISOString();
    const id = `msg-${randomUUID().slice(0, 8)}`;

    const message: ChatMessage = {
      id,
      sessionId,
      role: input.role,
      content: input.content,
      thinkingOutput: input.thinkingOutput ?? null,
      metadata: input.metadata ?? null,
      attachments: input.attachments,
      createdAt: now,
    };

    this.db.prepare(`
      INSERT INTO chat_messages (id, sessionId, role, content, thinkingOutput, metadata, attachments, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.sessionId,
      message.role,
      message.content,
      message.thinkingOutput,
      toJsonNullable(message.metadata),
      toJsonNullable(message.attachments),
      message.createdAt,
    );

    // Update session's updatedAt timestamp
    this.db.prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(now, sessionId);

    this.db.bumpLastModified();
    this.emit("chat:message:added", message);
    return message;
  }

  /**
   * Append a file attachment metadata record to an existing message.
   */
  addMessageAttachment(sessionId: string, messageId: string, attachment: ChatAttachment): ChatMessage {
    const message = this.getMessage(messageId);
    if (!message || message.sessionId !== sessionId) {
      throw new Error(`Message ${messageId} not found in session ${sessionId}`);
    }

    const updatedAttachments = [...(message.attachments ?? []), attachment];
    this.db.prepare(`
      UPDATE chat_messages
      SET attachments = ?
      WHERE id = ?
    `).run(toJsonNullable(updatedAttachments), messageId);

    const updated = this.getMessage(messageId);
    if (!updated) {
      throw new Error(`Failed to update message ${messageId}`);
    }

    this.db.bumpLastModified();
    this.emit("chat:message:updated", updated);
    return updated;
  }

  /**
   * Get messages for a chat session with optional filtering.
   *
   * @param sessionId - Session ID
   * @param filter - Optional filter (limit, offset, before cursor)
   * @returns Array of messages ordered by createdAt ASC
   */
  getMessages(sessionId: string, filter?: ChatMessagesFilter): ChatMessage[] {
    const whereClauses: string[] = ["sessionId = ?"];
    const params: (string | number)[] = [sessionId];

    // Cursor-based pagination: only return messages created before the cursor
    if (filter?.before) {
      whereClauses.push("createdAt < ?");
      params.push(filter.before);
    }

    const whereSql = whereClauses.join(" AND ");
    const limit = filter?.limit ?? 100;
    const offset = filter?.offset ?? 0;

    const rows = this.db.prepare(`
      SELECT * FROM chat_messages
      WHERE ${whereSql}
      ORDER BY createdAt ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return (rows as unknown as ChatMessageRow[]).map((row) => this.rowToMessage(row));
  }

  /**
   * Get a message by ID.
   *
   * @param id - Message ID
   * @returns The message, or undefined if not found
   */
  getMessage(id: string): ChatMessage | undefined {
    const row = this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as unknown as ChatMessageRow | undefined;
    if (!row) return undefined;
    return this.rowToMessage(row);
  }

  /**
   * Get the latest message for each session in the provided list.
   * Uses a single SQL query with GROUP BY and MAX to efficiently fetch last messages.
   *
   * @param sessionIds - Array of session IDs to fetch last messages for
   * @returns Map of sessionId -> latest ChatMessage for that session
   */
  getLastMessageForSessions(sessionIds: string[]): Map<string, ChatMessage> {
    if (!sessionIds || sessionIds.length === 0) {
      return new Map();
    }

    // Create placeholders for the IN clause
    const placeholders = sessionIds.map(() => "?").join(", ");

    // Use a subquery to get the latest message per session using MAX(createdAt)
    // Then join back to get the full message row
    const rows = this.db.prepare(`
      SELECT cm.* FROM chat_messages cm
      INNER JOIN (
        SELECT sessionId, MAX(createdAt) as maxCreatedAt
        FROM chat_messages
        WHERE sessionId IN (${placeholders})
        GROUP BY sessionId
      ) latest ON cm.sessionId = latest.sessionId AND cm.createdAt = latest.maxCreatedAt
    `).all(...sessionIds);

    const result = new Map<string, ChatMessage>();
    for (const row of rows as unknown as ChatMessageRow[]) {
      const message = this.rowToMessage(row);
      result.set(message.sessionId, message);
    }
    return result;
  }

  /**
   * Delete a message by ID.
   *
   * @param id - Message ID
   * @returns true if deleted, false if not found
   */
  deleteMessage(id: string): boolean {
    const existing = this.getMessage(id);
    if (!existing) return false;

    const sessionId = existing.sessionId;
    const now = new Date().toISOString();

    this.db.prepare("DELETE FROM chat_messages WHERE id = ?").run(id);

    // Update the parent session's updatedAt timestamp
    this.db.prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(now, sessionId);

    this.db.bumpLastModified();
    this.emit("chat:message:deleted", id);

    // Emit session:updated for the parent session
    const updatedSession = this.getSession(sessionId);
    if (updatedSession) {
      this.emit("chat:session:updated", updatedSession);
    }

    return true;
  }

  createRoom(input: ChatRoomCreateInput & { memberAgentIds?: string[] }): ChatRoom {
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
      createdAt: now,
      updatedAt: now,
    };

    const existingSlug = this.db.prepare(
      "SELECT id FROM chat_rooms WHERE projectId IS ? AND slug = ?",
    ).get(room.projectId, room.slug) as { id: string } | undefined;
    if (existingSlug) {
      throw new Error(`Room slug ${room.slug} already exists in this project`);
    }

    const memberIds = new Set((input.memberAgentIds ?? []).map((id) => id.trim()).filter(Boolean));

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO chat_rooms (id, name, slug, description, projectId, createdBy, status, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        room.id,
        room.name,
        room.slug,
        room.description,
        room.projectId,
        room.createdBy,
        room.status,
        room.createdAt,
        room.updatedAt,
      );

      const insertMember = this.db.prepare(`
        INSERT INTO chat_room_members (roomId, agentId, role, addedAt)
        VALUES (?, ?, ?, ?)
      `);
      for (const agentId of memberIds) {
        const role: RoomMemberRole = room.createdBy !== null && agentId === room.createdBy ? "owner" : "member";
        insertMember.run(room.id, agentId, role, now);
      }
    });

    const insertedMembers = this.listRoomMembers(room.id);
    this.db.bumpLastModified();
    this.emit("chat:room:created", room);
    for (const member of insertedMembers) {
      this.emit("chat:room:member:added", member);
    }
    return room;
  }

  getRoom(id: string): ChatRoom | undefined {
    const row = this.db.prepare("SELECT * FROM chat_rooms WHERE id = ?").get(id) as ChatRoomRow | undefined;
    return row ? this.rowToRoom(row) : undefined;
  }

  getRoomBySlug(projectId: string | null, slug: string): ChatRoom | undefined {
    const row = this.db.prepare("SELECT * FROM chat_rooms WHERE projectId IS ? AND slug = ?").get(projectId, slug) as ChatRoomRow | undefined;
    return row ? this.rowToRoom(row) : undefined;
  }

  listRooms(options?: { projectId?: string; status?: ChatRoomStatus }): ChatRoom[] {
    const whereClauses: string[] = [];
    const params: string[] = [];
    if (options?.projectId) {
      whereClauses.push("projectId = ?");
      params.push(options.projectId);
    }
    if (options?.status) {
      whereClauses.push("status = ?");
      params.push(options.status);
    }
    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM chat_rooms ${whereSql} ORDER BY updatedAt DESC`).all(...params) as ChatRoomRow[];
    return rows.map((row) => this.rowToRoom(row));
  }

  updateRoom(id: string, input: ChatRoomUpdateInput): ChatRoom | undefined {
    const existing = this.getRoom(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const setClauses: string[] = ["updatedAt = ?"];
    const params: Array<string | null> = [now];

    if (input.name !== undefined) {
      const normalizedName = this.normalizeRoomName(input.name);
      if (!normalizedName) throw new Error("Room name cannot be empty");
      const slug = this.buildRoomSlug(normalizedName);
      if (!slug) throw new Error("Room name must include letters or numbers");

      const existingSlug = this.db.prepare(
        "SELECT id FROM chat_rooms WHERE projectId IS ? AND slug = ? AND id != ?",
      ).get(existing.projectId, slug, id) as { id: string } | undefined;
      if (existingSlug) {
        throw new Error(`Room slug ${slug} already exists in this project`);
      }

      setClauses.push("name = ?", "slug = ?");
      params.push(normalizedName, slug);
    }
    if (input.description !== undefined) {
      setClauses.push("description = ?");
      params.push(input.description);
    }
    if (input.status !== undefined) {
      setClauses.push("status = ?");
      params.push(input.status);
    }

    params.push(id);
    this.db.prepare(`UPDATE chat_rooms SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

    const updated = this.getRoom(id)!;
    this.db.bumpLastModified();
    this.emit("chat:room:updated", updated);
    return updated;
  }

  deleteRoom(id: string): boolean {
    const existing = this.getRoom(id);
    if (!existing) return false;

    this.db.prepare("DELETE FROM chat_rooms WHERE id = ?").run(id);
    this.db.bumpLastModified();
    this.emit("chat:room:deleted", id);
    return true;
  }

  cleanupOldChats(maxAgeMs: number): { sessionsDeleted: number; roomsDeleted: number } {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      return { sessionsDeleted: 0, roomsDeleted: 0 };
    }

    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const result = this.db.transaction(() => {
      const staleSessionRows = this.db.prepare("SELECT id FROM chat_sessions WHERE updatedAt < ?").all(cutoff) as Array<{ id: string }>;
      const staleRoomRows = this.db.prepare("SELECT id FROM chat_rooms WHERE updatedAt < ?").all(cutoff) as Array<{ id: string }>;

      if (staleSessionRows.length > 0) {
        this.db.prepare("DELETE FROM chat_sessions WHERE updatedAt < ?").run(cutoff);
      }
      if (staleRoomRows.length > 0) {
        this.db.prepare("DELETE FROM chat_rooms WHERE updatedAt < ?").run(cutoff);
      }

      return {
        staleSessionIds: staleSessionRows.map((row) => row.id),
        staleRoomIds: staleRoomRows.map((row) => row.id),
      };
    });

    if (result.staleSessionIds.length === 0 && result.staleRoomIds.length === 0) {
      return { sessionsDeleted: 0, roomsDeleted: 0 };
    }

    this.db.bumpLastModified();
    for (const sessionId of result.staleSessionIds) {
      this.emit("chat:session:deleted", sessionId);
    }
    for (const roomId of result.staleRoomIds) {
      this.emit("chat:room:deleted", roomId);
    }

    return {
      sessionsDeleted: result.staleSessionIds.length,
      roomsDeleted: result.staleRoomIds.length,
    };
  }

  addRoomMember(roomId: string, agentId: string, role: RoomMemberRole = "member"): ChatRoomMember {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO chat_room_members (roomId, agentId, role, addedAt)
      VALUES (?, ?, ?, ?)
    `).run(roomId, agentId, role, now);

    const member = this.db.prepare("SELECT * FROM chat_room_members WHERE roomId = ? AND agentId = ?").get(roomId, agentId) as ChatRoomMemberRow | undefined;
    if (!member) throw new Error(`Failed to load room member ${agentId}`);
    const mapped = this.rowToRoomMember(member);

    if (result.changes > 0) {
      this.db.bumpLastModified();
      this.emit("chat:room:member:added", mapped);
    }
    return mapped;
  }

  removeRoomMember(roomId: string, agentId: string): boolean {
    const result = this.db.prepare("DELETE FROM chat_room_members WHERE roomId = ? AND agentId = ?").run(roomId, agentId);
    const removed = result.changes > 0;
    if (removed) {
      this.db.bumpLastModified();
      this.emit("chat:room:member:removed", { roomId, agentId });
    }
    return removed;
  }

  listRoomMembers(roomId: string): ChatRoomMember[] {
    const rows = this.db.prepare("SELECT * FROM chat_room_members WHERE roomId = ? ORDER BY addedAt ASC").all(roomId) as ChatRoomMemberRow[];
    return rows.map((row) => this.rowToRoomMember(row));
  }

  listRoomsForAgent(agentId: string, options?: { projectId?: string; status?: ChatRoomStatus }): ChatRoom[] {
    const whereClauses: string[] = ["m.agentId = ?"];
    const params: string[] = [agentId];
    if (options?.projectId) {
      whereClauses.push("r.projectId = ?");
      params.push(options.projectId);
    }
    if (options?.status) {
      whereClauses.push("r.status = ?");
      params.push(options.status);
    }
    const rows = this.db.prepare(`
      SELECT r.* FROM chat_rooms r
      INNER JOIN chat_room_members m ON m.roomId = r.id
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY r.updatedAt DESC
    `).all(...params) as ChatRoomRow[];
    return rows.map((row) => this.rowToRoom(row));
  }

  addRoomMessage(roomId: string, input: ChatRoomMessageCreateInput): ChatRoomMessage {
    const room = this.getRoom(roomId);
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

    this.db.prepare(`
      INSERT INTO chat_room_messages (id, roomId, role, content, thinkingOutput, metadata, attachments, senderAgentId, mentions, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.roomId,
      message.role,
      message.content,
      message.thinkingOutput,
      toJsonNullable(message.metadata),
      toJsonNullable(message.attachments),
      message.senderAgentId,
      toJsonNullable(message.mentions),
      message.createdAt,
    );

    this.db.prepare("UPDATE chat_rooms SET updatedAt = ? WHERE id = ?").run(now, roomId);
    this.db.bumpLastModified();
    this.emit("chat:room:message:added", message);
    return message;
  }

  getRoomMessages(roomId: string, filter?: ChatRoomMessagesFilter): ChatRoomMessage[] {
    const whereClauses: string[] = ["roomId = ?"];
    const params: Array<string | number> = [roomId];
    if (filter?.before) {
      whereClauses.push("createdAt < ?");
      params.push(filter.before);
    }

    const order = filter?.order === "desc" ? "DESC" : "ASC";
    const rows = this.db.prepare(`
      SELECT * FROM chat_room_messages
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY createdAt ${order}
      LIMIT ? OFFSET ?
    `).all(...params, filter?.limit ?? 100, filter?.offset ?? 0) as ChatRoomMessageRow[];

    const normalizedRows = filter?.order === "desc" ? [...rows].reverse() : rows;
    return normalizedRows.map((row) => this.rowToRoomMessage(row));
  }

  listRoomMessagesSince(
    roomId: string,
    sinceIso: string,
    options?: { excludeSenderAgentId?: string; limit?: number },
  ): ChatRoomMessage[] {
    const whereClauses: string[] = ["roomId = ?", "createdAt > ?"];
    const params: Array<string | number | null> = [roomId, sinceIso];

    if (options?.excludeSenderAgentId) {
      whereClauses.push("(senderAgentId IS NULL OR senderAgentId != ?)");
      params.push(options.excludeSenderAgentId);
    }

    const rows = this.db.prepare(`
      SELECT * FROM chat_room_messages
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY createdAt ASC
      LIMIT ?
    `).all(...params, options?.limit ?? 50) as ChatRoomMessageRow[];

    return rows.map((row) => this.rowToRoomMessage(row));
  }

  getRoomMessage(id: string): ChatRoomMessage | undefined {
    const row = this.db.prepare("SELECT * FROM chat_room_messages WHERE id = ?").get(id) as ChatRoomMessageRow | undefined;
    return row ? this.rowToRoomMessage(row) : undefined;
  }

  deleteRoomMessage(id: string): boolean {
    const message = this.getRoomMessage(id);
    if (!message) return false;

    const now = new Date().toISOString();
    this.db.prepare("DELETE FROM chat_room_messages WHERE id = ?").run(id);
    this.db.prepare("UPDATE chat_rooms SET updatedAt = ? WHERE id = ?").run(now, message.roomId);

    this.db.bumpLastModified();
    this.emit("chat:room:message:deleted", id);

    const updatedRoom = this.getRoom(message.roomId);
    if (updatedRoom) {
      this.emit("chat:room:updated", updatedRoom);
    }

    return true;
  }

  addRoomMessageAttachment(roomId: string, messageId: string, attachment: ChatAttachment): ChatRoomMessage {
    const message = this.getRoomMessage(messageId);
    if (!message || message.roomId !== roomId) {
      throw new Error(`Message ${messageId} not found in room ${roomId}`);
    }

    const updatedAttachments = [...(message.attachments ?? []), attachment];
    this.db.prepare("UPDATE chat_room_messages SET attachments = ? WHERE id = ?").run(
      toJsonNullable(updatedAttachments),
      messageId,
    );

    const now = new Date().toISOString();
    this.db.prepare("UPDATE chat_rooms SET updatedAt = ? WHERE id = ?").run(now, roomId);

    const updated = this.getRoomMessage(messageId);
    if (!updated) {
      throw new Error(`Failed to update room message ${messageId}`);
    }

    this.db.bumpLastModified();
    this.emit("chat:room:message:updated", updated);
    return updated;
  }
}
