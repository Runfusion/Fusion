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
import type { AsyncDataLayer } from "./postgres/data-layer.js";
import { sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import * as asyncChatStore from "./async-chat-store.js";
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
  thinkingLevel: string | null;
  createdAt: string;
  updatedAt: string;
  cliSessionFile: string | null;
  inFlightGeneration: string | null;
  cliExecutorAdapterId: string | null;
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

interface ChatTokenUsageRow {
  id: string;
  sourceKind: string;
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

// ── ChatStore Class ─────────────────────────────────────────────────

export class ChatStore extends EventEmitter<ChatStoreEvents> {
  /**
   * FNXC:ChatStore 2026-06-24-21:30:
   * When non-null, the store is in backend (PostgreSQL) mode and delegates to
   * the async helpers in async-chat-store.ts. The sync db is unused in this
   * mode. This is the dual-path pattern for the chat system.
   */
  private readonly asyncLayer: AsyncDataLayer | null;

  constructor(
    private fusionDir: string,
    private db: Database | null,
    options?: { asyncLayer?: AsyncDataLayer | null },
  ) {
    super();
    this.setMaxListeners(100);
    this.asyncLayer = options?.asyncLayer ?? null;
  }

  /** True when the store is backed by PostgreSQL (AsyncDataLayer present). */
  private get backendMode(): boolean {
    return this.asyncLayer !== null;
  }

  /**
   * FNXC:ChatStore 2026-06-24-21:35:
   * Asserts the sync SQLite database is available. In backend mode this is
   * never called (the async branch returns first).
   */
  private syncDb(): Database {
    if (!this.db) {
      throw new Error("ChatStore: sync Database is null (backend mode requires asyncLayer)");
    }
    return this.db;
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
      thinkingLevel: row.thinkingLevel ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      cliSessionFile: row.cliSessionFile ?? null,
      inFlightGeneration: fromJson<ChatInFlightGenerationState>(row.inFlightGeneration) ?? null,
      cliExecutorAdapterId: row.cliExecutorAdapterId ?? null,
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

  private rowToTokenUsage(row: ChatTokenUsageRow): ChatTokenUsageRecord {
    return {
      id: row.id,
      sourceKind: row.sourceKind as ChatTokenUsageSourceKind,
      chatSessionId: row.chatSessionId ?? null,
      roomId: row.roomId ?? null,
      messageId: row.messageId ?? null,
      projectId: row.projectId ?? null,
      agentId: row.agentId ?? null,
      modelProvider: row.modelProvider ?? null,
      modelId: row.modelId ?? null,
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cachedTokens: row.cachedTokens ?? 0,
      cacheWriteTokens: row.cacheWriteTokens ?? 0,
      totalTokens: row.totalTokens ?? 0,
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
  async createSession(input: ChatSessionCreateInput): Promise<ChatSession> {
    if (this.backendMode) {
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
      const created = await asyncChatStore.createChatSession(this.asyncLayer!.db, session);
      this.emit("chat:session:created", created);
      return created;
    }
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
      thinkingLevel: input.thinkingLevel ?? null,
      createdAt: now,
      updatedAt: now,
      cliSessionFile: null,
      inFlightGeneration: null,
      cliExecutorAdapterId: input.cliExecutorAdapterId ?? null,
    };

    this.syncDb().prepare(`
      INSERT INTO chat_sessions (id, agentId, title, status, projectId, modelProvider, modelId, thinkingLevel, createdAt, updatedAt, inFlightGeneration, cliExecutorAdapterId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.agentId,
      session.title,
      session.status,
      session.projectId,
      session.modelProvider,
      session.modelId,
      session.thinkingLevel,
      session.createdAt,
      session.updatedAt,
      null,
      session.cliExecutorAdapterId,
    );

    this.syncDb().bumpLastModified();
    this.emit("chat:session:created", session);
    return session;
  }

  /**
   * Get a chat session by ID.
   *
   * @param id - Session ID
   * @returns The session, or undefined if not found
   */
  async getSession(id: string): Promise<ChatSession | undefined> {
    if (this.backendMode) {
      return asyncChatStore.getChatSession(this.asyncLayer!.db, id);
    }
    const row = this.syncDb().prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as unknown as ChatSessionRow | undefined;
    if (!row) return undefined;
    return this.rowToSession(row);
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
    if (this.backendMode) {
      return asyncChatStore.listChatSessions(this.asyncLayer!.db, options);
    }
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

    const rows = this.syncDb().prepare(`
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
  async findLatestActiveSessionForTarget(options: {
    agentId: string;
    projectId?: string;
    modelProvider?: string;
    modelId?: string;
  }): Promise<ChatSession | undefined> {
    if (this.backendMode) {
      return asyncChatStore.findLatestActiveChatSessionForTarget(this.asyncLayer!.db, options);
    }
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
      const row = this.syncDb().prepare(`
        SELECT * FROM chat_sessions
        WHERE ${baseWhereSql} AND modelProvider = ? AND modelId = ?
        ORDER BY updatedAt DESC
        LIMIT 1
      `).get(...baseParams, normalizedProvider, normalizedModelId) as ChatSessionRow | undefined;
      return row ? this.rowToSession(row) : undefined;
    }

    const modelLessRow = this.syncDb().prepare(`
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

    const fallbackRow = this.syncDb().prepare(`
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
  async updateSession(id: string, input: ChatSessionUpdateInput): Promise<ChatSession | undefined> {
    if (this.backendMode) {
      const updated = await asyncChatStore.updateChatSession(this.asyncLayer!.db, id, input);
      if (updated) this.emit("chat:session:updated", updated);
      return updated;
    }
    const existing = await this.getSession(id);
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
    if (input.thinkingLevel !== undefined) {
      setClauses.push("thinkingLevel = ?");
      params.push(input.thinkingLevel);
    }

    params.push(id);

    this.syncDb().prepare(`
      UPDATE chat_sessions SET ${setClauses.join(", ")} WHERE id = ?
    `).run(...params);

    const updated = (await this.getSession(id))!;
    this.syncDb().bumpLastModified();
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
    if (this.backendMode) {
      await asyncChatStore.setCliSessionFile(this.asyncLayer!.db, id, cliSessionFile);
      return;
    }
    this.syncDb()
      .prepare("UPDATE chat_sessions SET cliSessionFile = ? WHERE id = ?")
      .run(cliSessionFile, id);
    this.syncDb().bumpLastModified();
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
    if (this.backendMode) {
      const updated = await asyncChatStore.setCliExecutorAdapterId(this.asyncLayer!.db, id, adapterId);
      if (updated) this.emit("chat:session:updated", updated);
      return updated;
    }
    const existing = await this.getSession(id);
    if (!existing) return undefined;
    this.syncDb()
      .prepare("UPDATE chat_sessions SET cliExecutorAdapterId = ?, updatedAt = ? WHERE id = ?")
      .run(adapterId, new Date().toISOString(), id);
    this.syncDb().bumpLastModified();
    const updated = (await this.getSession(id))!;
    this.emit("chat:session:updated", updated);
    return updated;
  }

  async setInFlightGeneration(id: string, inFlightGeneration: ChatInFlightGenerationState | null): Promise<ChatSession | undefined> {
    if (this.backendMode) {
      const updated = await asyncChatStore.setInFlightGeneration(this.asyncLayer!.db, id, inFlightGeneration);
      if (updated) this.emit("chat:session:updated", updated);
      return updated;
    }
    const existing = await this.getSession(id);
    if (!existing) return undefined;

    this.syncDb()
      .prepare("UPDATE chat_sessions SET inFlightGeneration = ? WHERE id = ?")
      .run(toJsonNullable(inFlightGeneration), id);

    const updated = (await this.getSession(id))!;
    this.syncDb().bumpLastModified();
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
  async deleteSession(id: string): Promise<boolean> {
    if (this.backendMode) {
      const deleted = await asyncChatStore.deleteChatSession(this.asyncLayer!.db, id);
      if (deleted) this.emit("chat:session:deleted", id);
      return deleted;
    }
    const existing = await this.getSession(id);
    if (!existing) return false;

    this.syncDb().prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
    this.syncDb().bumpLastModified();
    this.emit("chat:session:deleted", id);
    return true;
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

    if (this.backendMode) {
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
      const created = await asyncChatStore.addChatMessage(this.asyncLayer!.db, message);
      this.emit("chat:message:added", created);
      return created;
    }
    const now2 = new Date().toISOString();
    const id = `msg-${randomUUID().slice(0, 8)}`;

    const message: ChatMessage = {
      id,
      sessionId,
      role: input.role,
      content: input.content,
      thinkingOutput: input.thinkingOutput ?? null,
      metadata: input.metadata ?? null,
      attachments: input.attachments,
      createdAt: now2,
    };

    this.syncDb().prepare(`
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
    this.syncDb().prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(now2, sessionId);

    this.syncDb().bumpLastModified();
    this.emit("chat:message:added", message);
    return message;
  }

  /**
   * Append a file attachment metadata record to an existing message.
   */
  async addMessageAttachment(sessionId: string, messageId: string, attachment: ChatAttachment): Promise<ChatMessage> {
    if (this.backendMode) {
      const updated = await asyncChatStore.addChatMessageAttachment(this.asyncLayer!.db, sessionId, messageId, attachment);
      this.emit("chat:message:updated", updated);
      return updated;
    }
    const message = await this.getMessage(messageId);
    if (!message || message.sessionId !== sessionId) {
      throw new Error(`Message ${messageId} not found in session ${sessionId}`);
    }

    const updatedAttachments = [...(message.attachments ?? []), attachment];
    this.syncDb().prepare(`
      UPDATE chat_messages
      SET attachments = ?
      WHERE id = ?
    `).run(toJsonNullable(updatedAttachments), messageId);

    const updated = await this.getMessage(messageId);
    if (!updated) {
      throw new Error(`Failed to update message ${messageId}`);
    }

    this.syncDb().bumpLastModified();
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
    if (this.backendMode) {
      return asyncChatStore.getChatMessages(this.asyncLayer!.db, sessionId, filter);
    }
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
    const order = filter?.order === "desc" ? "DESC" : "ASC";

    const rows = this.syncDb().prepare(`
      SELECT * FROM chat_messages
      WHERE ${whereSql}
      ORDER BY createdAt ${order}
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
  async getMessage(id: string): Promise<ChatMessage | undefined> {
    if (this.backendMode) {
      return asyncChatStore.getChatMessage(this.asyncLayer!.db, id);
    }
    const row = this.syncDb().prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as unknown as ChatMessageRow | undefined;
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
  async getLastMessageForSessions(sessionIds: string[]): Promise<Map<string, ChatMessage>> {
    if (this.backendMode) {
      return asyncChatStore.getLastMessageForSessions(this.asyncLayer!.db, sessionIds);
    }
    if (!sessionIds || sessionIds.length === 0) {
      return new Map();
    }

    // Create placeholders for the IN clause
    const placeholders = sessionIds.map(() => "?").join(", ");

    // Use a subquery to get the latest message per session using MAX(createdAt)
    // Then join back to get the full message row
    const rows = this.syncDb().prepare(`
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

  hasMessages(sessionId: string): boolean {
    if (this.backendMode) {
      // Async path not available for sync query; callers in backend mode should use getMessages
      return false;
    }
    const row = this.syncDb().prepare("SELECT 1 FROM chat_messages WHERE sessionId = ? LIMIT 1").get(sessionId) as { 1: number } | undefined;
    return Boolean(row);
  }

  /**
   * Escape a raw search term for safe use inside a SQL `LIKE ... ESCAPE '\'` pattern.
   * Escapes the LIKE wildcard characters (`%`, `_`) and the escape character itself (`\`)
   * so a literal user-typed `%`/`_` is matched literally instead of acting as a wildcard.
   */
  private escapeLikePattern(raw: string): string {
    return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
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

    if (this.backendMode) {
      return asyncChatStore.searchChatSessionsByMessageContent(this.asyncLayer!.db, trimmed, sessionIds);
    }

    const escaped = this.escapeLikePattern(trimmed);
    const pattern = `%${escaped}%`;
    const placeholders = sessionIds.map(() => "?").join(", ");

    // Single bounded query: find the most recent matching message per session via a
    // GROUP BY + join-back, avoiding N+1 per-session queries. Ties on createdAt (common in
    // fast test/bulk-insert scenarios where multiple messages share a millisecond timestamp)
    // are broken by SQLite's implicit rowid, which tracks insertion order.
    const rows = this.syncDb().prepare(`
      SELECT cm.* FROM chat_messages cm
      INNER JOIN (
        SELECT sessionId, MAX(rowid) as maxRowid
        FROM chat_messages
        WHERE sessionId IN (${placeholders}) AND content LIKE ? ESCAPE '\\'
        GROUP BY sessionId
      ) matched ON cm.sessionId = matched.sessionId AND cm.rowid = matched.maxRowid
    `).all(...sessionIds, pattern);

    const result = new Map<string, string>();
    for (const row of rows as unknown as ChatMessageRow[]) {
      const message = this.rowToMessage(row);
      if (result.has(message.sessionId)) continue;
      const content = message.content || "";
      result.set(message.sessionId, content.length > 100 ? content.slice(0, 100) + "…" : content);
    }
    return result;
  }

  /**
   * Delete a message by ID.
   *
   * @param id - Message ID
   * @returns true if deleted, false if not found
   */
  async deleteMessage(id: string): Promise<boolean> {
    if (this.backendMode) {
      const existing = await asyncChatStore.getChatMessage(this.asyncLayer!.db, id);
      if (!existing) return false;
      const deleted = await asyncChatStore.deleteChatMessage(this.asyncLayer!.db, id);
      if (deleted) {
        this.emit("chat:message:deleted", id);
        const updatedSession = await this.getSession(existing.sessionId);
        if (updatedSession) this.emit("chat:session:updated", updatedSession);
      }
      return deleted;
    }
    const existing = await this.getMessage(id);
    if (!existing) return false;

    const sessionId = existing.sessionId;
    const now = new Date().toISOString();

    this.syncDb().prepare("DELETE FROM chat_messages WHERE id = ?").run(id);

    // Update the parent session's updatedAt timestamp
    this.syncDb().prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(now, sessionId);

    this.syncDb().bumpLastModified();
    this.emit("chat:message:deleted", id);

    // Emit session:updated for the parent session
    const updatedSession = await this.getSession(sessionId);
    if (updatedSession) {
      this.emit("chat:session:updated", updatedSession);
    }

    return true;
  }

  /**
   * FNXC:ChatMessageEdit 2026-07-07-09:00:
   * Truncate a chat session from (and including) a target message onward. Editing an earlier
   * user turn must "forget" that turn and every turn after it — both from the persisted
   * transcript here AND from the model's resumable pi session context (rewound separately by
   * ChatManager.rewindSessionForEdit) — so future responses are not biased by discarded turns.
   *
   * Ordering is resolved by (createdAt ASC, rowid ASC) rather than createdAt alone, since
   * multiple messages can share an identical createdAt timestamp (same-millisecond inserts);
   * rowid is SQLite's implicit monotonic insertion-order tiebreaker, guaranteeing the edited
   * message and every later message (in true insertion order) are always included, with no
   * sibling straggler surviving the truncation. The Postgres backend has no rowid, so it
   * tiebreaks on (createdAt ASC, id ASC) — deterministic, matching getLastMessageForSessions.
   *
   * @param sessionId - Parent session ID
   * @param fromMessageId - Id of the earliest message to delete (inclusive)
   * @returns deletedIds (in ASC order) and retained messages (pre-edit history, ASC order)
   */
  async deleteMessagesFrom(sessionId: string, fromMessageId: string): Promise<{ deletedIds: string[]; retained: ChatMessage[] }> {
    if (this.backendMode) {
      const result = await asyncChatStore.deleteChatMessagesFrom(this.asyncLayer!.db, sessionId, fromMessageId);
      if (result.deletedIds.length > 0) {
        for (const id of result.deletedIds) {
          this.emit("chat:message:deleted", id);
        }
        const updatedSession = await this.getSession(sessionId);
        if (updatedSession) this.emit("chat:session:updated", updatedSession);
      }
      return result;
    }

    const target = this.syncDb().prepare(
      "SELECT id, sessionId, rowid as rowid_ FROM chat_messages WHERE id = ?",
    ).get(fromMessageId) as { id: string; sessionId: string; rowid_: number } | undefined;

    if (!target || target.sessionId !== sessionId) {
      return { deletedIds: [], retained: await this.getMessages(sessionId) };
    }

    // Ordered id list for the session (createdAt ASC, rowid ASC tiebreak) so we can
    // deterministically split retained-vs-deleted around the target message.
    const orderedRows = this.syncDb().prepare(
      "SELECT id, rowid as rowid_ FROM chat_messages WHERE sessionId = ? ORDER BY createdAt ASC, rowid_ ASC",
    ).all(sessionId) as { id: string; rowid_: number }[];

    const targetIndex = orderedRows.findIndex((row) => row.id === fromMessageId);
    if (targetIndex === -1) {
      return { deletedIds: [], retained: await this.getMessages(sessionId) };
    }

    const retainedIds = orderedRows.slice(0, targetIndex).map((row) => row.id);
    const deletedIds = orderedRows.slice(targetIndex).map((row) => row.id);

    const retained: ChatMessage[] = [];
    for (const id of retainedIds) {
      const message = await this.getMessage(id);
      if (message) retained.push(message);
    }

    if (deletedIds.length === 0) {
      return { deletedIds: [], retained };
    }

    const now = new Date().toISOString();
    const placeholders = deletedIds.map(() => "?").join(", ");
    this.syncDb().prepare(`DELETE FROM chat_messages WHERE id IN (${placeholders})`).run(...deletedIds);
    this.syncDb().prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(now, sessionId);
    this.syncDb().bumpLastModified();

    for (const id of deletedIds) {
      this.emit("chat:message:deleted", id);
    }
    const updatedSession = await this.getSession(sessionId);
    if (updatedSession) {
      this.emit("chat:session:updated", updatedSession);
    }

    return { deletedIds, retained };
  }

  /**
   * FNXC:ChatMessageEdit 2026-07-07-09:00:
   * Merge (default) or replace a persisted message's metadata. Used by the model-loop generation
   * path to record the pi SessionManager parent-leaf id (`metadata.piParentLeafId`) onto the
   * just-created user message, without disturbing other metadata (e.g. `mentions`). This linkage
   * is what lets a later edit rewind losslessly via SessionManager.branch()/resetLeaf().
   */
  async updateMessageMetadata(messageId: string, metadata: Record<string, unknown> | null, options?: { merge?: boolean }): Promise<ChatMessage> {
    if (this.backendMode) {
      const updated = await asyncChatStore.updateChatMessageMetadata(this.asyncLayer!.db, messageId, metadata, options);
      this.emit("chat:message:updated", updated);
      return updated;
    }

    const existing = await this.getMessage(messageId);
    if (!existing) {
      throw new Error(`Message ${messageId} not found`);
    }

    const merge = options?.merge !== false;
    const nextMetadata = metadata === null
      ? (merge ? existing.metadata : null)
      : (merge ? { ...(existing.metadata ?? {}), ...metadata } : metadata);

    this.syncDb().prepare("UPDATE chat_messages SET metadata = ? WHERE id = ?").run(toJsonNullable(nextMetadata), messageId);

    const updated = await this.getMessage(messageId);
    if (!updated) {
      throw new Error(`Failed to update message ${messageId}`);
    }

    this.syncDb().bumpLastModified();
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
      createdAt: now,
      updatedAt: now,
    };

    const memberIds = [...new Set((input.memberAgentIds ?? []).map((id) => id.trim()).filter(Boolean))];

    if (this.backendMode) {
      const result = await asyncChatStore.createChatRoom(this.asyncLayer!, room, memberIds);
      this.emit("chat:room:created", result.room);
      for (const member of result.members) {
        this.emit("chat:room:member:added", member);
      }
      return result.room;
    }

    const existingSlug = this.syncDb().prepare(
      "SELECT id FROM chat_rooms WHERE projectId IS ? AND slug = ?",
    ).get(room.projectId, room.slug) as { id: string } | undefined;
    if (existingSlug) {
      throw new Error(`Room slug ${room.slug} already exists in this project`);
    }

    this.syncDb().transaction(() => {
      this.syncDb().prepare(`
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

      const insertMember = this.syncDb().prepare(`
        INSERT INTO chat_room_members (roomId, agentId, role, addedAt)
        VALUES (?, ?, ?, ?)
      `);
      for (const agentId of memberIds) {
        const role: RoomMemberRole = room.createdBy !== null && agentId === room.createdBy ? "owner" : "member";
        insertMember.run(room.id, agentId, role, now);
      }
    });

    const insertedMembers = await this.listRoomMembers(room.id);
    this.syncDb().bumpLastModified();
    this.emit("chat:room:created", room);
    for (const member of insertedMembers) {
      this.emit("chat:room:member:added", member);
    }
    return room;
  }

  async getRoom(id: string): Promise<ChatRoom | undefined> {
    if (this.backendMode) {
      return asyncChatStore.getChatRoom(this.asyncLayer!.db, id);
    }
    const row = this.syncDb().prepare("SELECT * FROM chat_rooms WHERE id = ?").get(id) as ChatRoomRow | undefined;
    return row ? this.rowToRoom(row) : undefined;
  }

  async getRoomBySlug(projectId: string | null, slug: string): Promise<ChatRoom | undefined> {
    if (this.backendMode) {
      return asyncChatStore.getChatRoomBySlug(this.asyncLayer!.db, projectId, slug);
    }
    const row = this.syncDb().prepare("SELECT * FROM chat_rooms WHERE projectId IS ? AND slug = ?").get(projectId, slug) as ChatRoomRow | undefined;
    return row ? this.rowToRoom(row) : undefined;
  }

  async listRooms(options?: { projectId?: string; status?: ChatRoomStatus }): Promise<ChatRoom[]> {
    if (this.backendMode) {
      return asyncChatStore.listChatRooms(this.asyncLayer!.db, options);
    }
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
    const rows = this.syncDb().prepare(`SELECT * FROM chat_rooms ${whereSql} ORDER BY updatedAt DESC`).all(...params) as ChatRoomRow[];
    return rows.map((row) => this.rowToRoom(row));
  }

  async updateRoom(id: string, input: ChatRoomUpdateInput): Promise<ChatRoom | undefined> {
    if (this.backendMode) {
      // Build slug/name from the input mirroring the sync path.
      let updateInput: Parameters<typeof asyncChatStore.updateChatRoom>[2] = {};
      if (input.name !== undefined) {
        const normalizedName = this.normalizeRoomName(input.name);
        if (!normalizedName) throw new Error("Room name cannot be empty");
        const slug = this.buildRoomSlug(normalizedName);
        if (!slug) throw new Error("Room name must include letters or numbers");
        const existing = await this.getRoom(id);
        if (existing) {
          const slugConflict = await asyncChatStore.getChatRoomBySlug(this.asyncLayer!.db, existing.projectId, slug);
          if (slugConflict && slugConflict.id !== id) {
            throw new Error(`Room slug ${slug} already exists in this project`);
          }
        }
        updateInput = { name: normalizedName, slug };
      }
      if (input.description !== undefined) updateInput.description = input.description;
      if (input.status !== undefined) updateInput.status = input.status;
      const updated = await asyncChatStore.updateChatRoom(this.asyncLayer!.db, id, updateInput);
      if (updated) this.emit("chat:room:updated", updated);
      return updated;
    }
    const existing = await this.getRoom(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const setClauses: string[] = ["updatedAt = ?"];
    const params: Array<string | null> = [now];

    if (input.name !== undefined) {
      const normalizedName = this.normalizeRoomName(input.name);
      if (!normalizedName) throw new Error("Room name cannot be empty");
      const slug = this.buildRoomSlug(normalizedName);
      if (!slug) throw new Error("Room name must include letters or numbers");

      const existingSlug = this.syncDb().prepare(
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
    this.syncDb().prepare(`UPDATE chat_rooms SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

    const updated = (await this.getRoom(id))!;
    this.syncDb().bumpLastModified();
    this.emit("chat:room:updated", updated);
    return updated;
  }

  async deleteRoom(id: string): Promise<boolean> {
    if (this.backendMode) {
      const deleted = await asyncChatStore.deleteChatRoom(this.asyncLayer!.db, id);
      if (deleted) this.emit("chat:room:deleted", id);
      return deleted;
    }
    const existing = await this.getRoom(id);
    if (!existing) return false;

    this.syncDb().prepare("DELETE FROM chat_rooms WHERE id = ?").run(id);
    this.syncDb().bumpLastModified();
    this.emit("chat:room:deleted", id);
    return true;
  }

  async cleanupOldChats(maxAgeMs: number): Promise<{ sessionsDeleted: number; roomsDeleted: number }> {
    if (this.backendMode) {
      const result = await asyncChatStore.cleanupOldChats(this.asyncLayer!.db, maxAgeMs);
      for (const sessionId of result.deletedSessionIds) {
        this.emit("chat:session:deleted", sessionId);
      }
      for (const roomId of result.deletedRoomIds) {
        this.emit("chat:room:deleted", roomId);
      }
      return { sessionsDeleted: result.sessionsDeleted, roomsDeleted: result.roomsDeleted };
    }
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      return { sessionsDeleted: 0, roomsDeleted: 0 };
    }

    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const result = this.syncDb().transaction(() => {
      const staleSessionRows = this.syncDb().prepare("SELECT id FROM chat_sessions WHERE updatedAt < ?").all(cutoff) as Array<{ id: string }>;
      const staleRoomRows = this.syncDb().prepare("SELECT id FROM chat_rooms WHERE updatedAt < ?").all(cutoff) as Array<{ id: string }>;

      if (staleSessionRows.length > 0) {
        this.syncDb().prepare("DELETE FROM chat_sessions WHERE updatedAt < ?").run(cutoff);
      }
      if (staleRoomRows.length > 0) {
        this.syncDb().prepare("DELETE FROM chat_rooms WHERE updatedAt < ?").run(cutoff);
      }

      return {
        staleSessionIds: staleSessionRows.map((row) => row.id),
        staleRoomIds: staleRoomRows.map((row) => row.id),
      };
    });

    if (result.staleSessionIds.length === 0 && result.staleRoomIds.length === 0) {
      return { sessionsDeleted: 0, roomsDeleted: 0 };
    }

    this.syncDb().bumpLastModified();
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

  async addRoomMember(roomId: string, agentId: string, role: RoomMemberRole = "member"): Promise<ChatRoomMember> {
    const now = new Date().toISOString();
    if (this.backendMode) {
      await asyncChatStore.addChatRoomMember(this.asyncLayer!.db, roomId, agentId, role, now);
      const members = await this.listRoomMembers(roomId);
      const member = members.find((m) => m.agentId === agentId);
      if (!member) throw new Error(`Failed to load room member ${agentId}`);
      this.emit("chat:room:member:added", member);
      return member;
    }
    const result = this.syncDb().prepare(`
      INSERT OR IGNORE INTO chat_room_members (roomId, agentId, role, addedAt)
      VALUES (?, ?, ?, ?)
    `).run(roomId, agentId, role, now);

    const member = this.syncDb().prepare("SELECT * FROM chat_room_members WHERE roomId = ? AND agentId = ?").get(roomId, agentId) as ChatRoomMemberRow | undefined;
    if (!member) throw new Error(`Failed to load room member ${agentId}`);
    const mapped = this.rowToRoomMember(member);

    if (result.changes > 0) {
      this.syncDb().bumpLastModified();
      this.emit("chat:room:member:added", mapped);
    }
    return mapped;
  }

  async removeRoomMember(roomId: string, agentId: string): Promise<boolean> {
    if (this.backendMode) {
      const removed = await asyncChatStore.removeChatRoomMember(this.asyncLayer!.db, roomId, agentId);
      if (removed) this.emit("chat:room:member:removed", { roomId, agentId });
      return removed;
    }
    const result = this.syncDb().prepare("DELETE FROM chat_room_members WHERE roomId = ? AND agentId = ?").run(roomId, agentId);
    const removed = result.changes > 0;
    if (removed) {
      this.syncDb().bumpLastModified();
      this.emit("chat:room:member:removed", { roomId, agentId });
    }
    return removed;
  }

  async listRoomMembers(roomId: string): Promise<ChatRoomMember[]> {
    if (this.backendMode) {
      return asyncChatStore.listChatRoomMembers(this.asyncLayer!.db, roomId);
    }
    const rows = this.syncDb().prepare("SELECT * FROM chat_room_members WHERE roomId = ? ORDER BY addedAt ASC").all(roomId) as ChatRoomMemberRow[];
    return rows.map((row) => this.rowToRoomMember(row));
  }

  async listRoomsForAgent(agentId: string, options?: { projectId?: string; status?: ChatRoomStatus }): Promise<ChatRoom[]> {
    if (this.backendMode) {
      return asyncChatStore.listChatRoomsForAgent(this.asyncLayer!.db, agentId, options);
    }
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
    const rows = this.syncDb().prepare(`
      SELECT r.* FROM chat_rooms r
      INNER JOIN chat_room_members m ON m.roomId = r.id
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY r.updatedAt DESC
    `).all(...params) as ChatRoomRow[];
    return rows.map((row) => this.rowToRoom(row));
  }

  async addRoomMessage(roomId: string, input: ChatRoomMessageCreateInput): Promise<ChatRoomMessage> {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error(`Chat room ${roomId} not found`);
    }

    if (this.backendMode) {
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
      const created = await asyncChatStore.addChatRoomMessage(this.asyncLayer!.db, message);
      this.emit("chat:room:message:added", created);
      return created;
    }

    const now2 = new Date().toISOString();
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
      createdAt: now2,
    };

    this.syncDb().prepare(`
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

    this.syncDb().prepare("UPDATE chat_rooms SET updatedAt = ? WHERE id = ?").run(now2, roomId);
    this.syncDb().bumpLastModified();
    this.emit("chat:room:message:added", message);
    return message;
  }

  async getRoomMessages(roomId: string, filter?: ChatRoomMessagesFilter): Promise<ChatRoomMessage[]> {
    if (this.backendMode) {
      return asyncChatStore.getChatRoomMessages(this.asyncLayer!.db, roomId, filter);
    }
    const whereClauses: string[] = ["roomId = ?"];
    const params: Array<string | number> = [roomId];
    if (filter?.before) {
      whereClauses.push("createdAt < ?");
      params.push(filter.before);
    }

    const order = filter?.order === "desc" ? "DESC" : "ASC";
    const rows = this.syncDb().prepare(`
      SELECT * FROM chat_room_messages
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY createdAt ${order}
      LIMIT ? OFFSET ?
    `).all(...params, filter?.limit ?? 100, filter?.offset ?? 0) as ChatRoomMessageRow[];

    const normalizedRows = filter?.order === "desc" ? [...rows].reverse() : rows;
    return normalizedRows.map((row) => this.rowToRoomMessage(row));
  }

  async listRoomMessagesSince(
    roomId: string,
    sinceIso: string,
    options?: { excludeSenderAgentId?: string; limit?: number },
  ): Promise<ChatRoomMessage[]> {
    if (this.backendMode) {
      return asyncChatStore.listChatRoomMessagesSince(this.asyncLayer!.db, roomId, sinceIso, options);
    }
    const whereClauses: string[] = ["roomId = ?", "createdAt > ?"];
    const params: Array<string | number | null> = [roomId, sinceIso];

    if (options?.excludeSenderAgentId) {
      whereClauses.push("(senderAgentId IS NULL OR senderAgentId != ?)");
      params.push(options.excludeSenderAgentId);
    }

    const rows = this.syncDb().prepare(`
      SELECT * FROM chat_room_messages
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY createdAt ASC
      LIMIT ?
    `).all(...params, options?.limit ?? 50) as ChatRoomMessageRow[];

    return rows.map((row) => this.rowToRoomMessage(row));
  }

  async getRoomMessage(id: string): Promise<ChatRoomMessage | undefined> {
    if (this.backendMode) {
      return asyncChatStore.getChatRoomMessage(this.asyncLayer!.db, id);
    }
    const row = this.syncDb().prepare("SELECT * FROM chat_room_messages WHERE id = ?").get(id) as ChatRoomMessageRow | undefined;
    return row ? this.rowToRoomMessage(row) : undefined;
  }

  async deleteRoomMessage(id: string): Promise<boolean> {
    if (this.backendMode) {
      const existing = await asyncChatStore.getChatRoomMessage(this.asyncLayer!.db, id);
      if (!existing) return false;
      const deleted = await asyncChatStore.deleteChatRoomMessage(this.asyncLayer!.db, id);
      if (deleted) {
        this.emit("chat:room:message:deleted", id);
        const updatedRoom = await this.getRoom(existing.roomId);
        if (updatedRoom) this.emit("chat:room:updated", updatedRoom);
      }
      return deleted;
    }
    const message = await this.getRoomMessage(id);
    if (!message) return false;

    const now = new Date().toISOString();
    this.syncDb().prepare("DELETE FROM chat_room_messages WHERE id = ?").run(id);
    this.syncDb().prepare("UPDATE chat_rooms SET updatedAt = ? WHERE id = ?").run(now, message.roomId);

    this.syncDb().bumpLastModified();
    this.emit("chat:room:message:deleted", id);

    const updatedRoom = await this.getRoom(message.roomId);
    if (updatedRoom) {
      this.emit("chat:room:updated", updatedRoom);
    }

    return true;
  }

  async clearRoomMessages(roomId: string): Promise<number> {
    if (this.backendMode) {
      const deleted = await asyncChatStore.clearChatRoomMessages(this.asyncLayer!.db, roomId);
      if (deleted > 0) this.emit("chat:room:messages:cleared", { roomId, deletedCount: deleted });
      return deleted;
    }
    const room = await this.getRoom(roomId);
    if (!room) {
      return 0;
    }

    const deleted = this.syncDb().prepare("DELETE FROM chat_room_messages WHERE roomId = ?").run(roomId);
    const deletedCount = Number(deleted.changes);
    if (deletedCount <= 0) {
      return 0;
    }

    const now = new Date().toISOString();
    this.syncDb().prepare("UPDATE chat_rooms SET updatedAt = ? WHERE id = ?").run(now, roomId);
    this.syncDb().bumpLastModified();
    this.emit("chat:room:messages:cleared", { roomId, deletedCount });

    const updatedRoom = await this.getRoom(roomId);
    if (updatedRoom) {
      this.emit("chat:room:updated", updatedRoom);
    }

    return deletedCount;
  }

  async addRoomMessageAttachment(roomId: string, messageId: string, attachment: ChatAttachment): Promise<ChatRoomMessage> {
    if (this.backendMode) {
      const updated = await asyncChatStore.addChatRoomMessageAttachment(this.asyncLayer!.db, roomId, messageId, attachment);
      this.emit("chat:room:message:updated", updated);
      return updated;
    }
    const message = await this.getRoomMessage(messageId);
    if (!message || message.roomId !== roomId) {
      throw new Error(`Message ${messageId} not found in room ${roomId}`);
    }

    const updatedAttachments = [...(message.attachments ?? []), attachment];
    this.syncDb().prepare("UPDATE chat_room_messages SET attachments = ? WHERE id = ?").run(
      toJsonNullable(updatedAttachments),
      messageId,
    );

    const now = new Date().toISOString();
    this.syncDb().prepare("UPDATE chat_rooms SET updatedAt = ? WHERE id = ?").run(now, roomId);

    const updated = await this.getRoomMessage(messageId);
    if (!updated) {
      throw new Error(`Failed to update room message ${messageId}`);
    }

    this.syncDb().bumpLastModified();
    this.emit("chat:room:message:updated", updated);
    return updated;
  }

  recordTokenUsage(input: ChatTokenUsageCreateInput): ChatTokenUsageRecord | undefined {
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

    /*
     * FNXC:ChatTokenAccounting 2026-07-02-00:00:
     * Chat interactions are first-class token consumers for Command Center totals, but they are stored in a separate append-only table instead of task.tokenUsage so task execution panels stay task-scoped and planner chat cannot double-count executor/reviewer/triage/merger sessions.
     */
    if (this.backendMode) {
      const layer = this.asyncLayer!;
      void layer.db.execute(sql`INSERT INTO project.chat_token_usage (
        id, source_kind, chat_session_id, room_id, message_id, project_id, agent_id,
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
    this.syncDb().prepare(`
      INSERT INTO chat_token_usage (
        id, sourceKind, chatSessionId, roomId, messageId, projectId, agentId,
        modelProvider, modelId, inputTokens, outputTokens, cachedTokens,
        cacheWriteTokens, totalTokens, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.sourceKind,
      record.chatSessionId,
      record.roomId,
      record.messageId,
      record.projectId,
      record.agentId,
      record.modelProvider,
      record.modelId,
      record.inputTokens,
      record.outputTokens,
      record.cachedTokens,
      record.cacheWriteTokens,
      record.totalTokens,
      record.createdAt,
    );
    this.syncDb().bumpLastModified();
    return record;
  }

  listTokenUsage(): ChatTokenUsageRecord[] {
    if (this.backendMode) return [];
    const rows = this.syncDb().prepare("SELECT * FROM chat_token_usage ORDER BY createdAt ASC").all() as ChatTokenUsageRow[];
    return rows.map((row) => this.rowToTokenUsage(row));
  }
}
