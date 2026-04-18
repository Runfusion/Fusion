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
  ChatMessageCreateInput,
  ChatSessionCreateInput,
  ChatSessionUpdateInput,
  ChatMessagesFilter,
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
}

// ── ChatStore Class ─────────────────────────────────────────────────

export class ChatStore extends EventEmitter<ChatStoreEvents> {
  constructor(
    private kbDir: string,
    private db: Database,
  ) {
    super();
    this.setMaxListeners(100);
  }

  // ── Row-to-Object Converters ───────────────────────────────────────

  /**
   * Convert a database row to a ChatSession object.
   */
  private rowToSession(row: any): ChatSession {
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
    };
  }

  /**
   * Convert a database row to a ChatMessage object.
   */
  private rowToMessage(row: any): ChatMessage {
    return {
      id: row.id,
      sessionId: row.sessionId,
      role: row.role as ChatMessageRole,
      content: row.content,
      thinkingOutput: row.thinkingOutput ?? null,
      metadata: fromJson<Record<string, unknown>>(row.metadata) ?? null,
      createdAt: row.createdAt,
    };
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
    };

    this.db.prepare(`
      INSERT INTO chat_sessions (id, agentId, title, status, projectId, modelProvider, modelId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const row = this.db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id);
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

    return (rows as any[]).map((row) => this.rowToSession(row));
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
      createdAt: now,
    };

    this.db.prepare(`
      INSERT INTO chat_messages (id, sessionId, role, content, thinkingOutput, metadata, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.sessionId,
      message.role,
      message.content,
      message.thinkingOutput,
      toJsonNullable(message.metadata),
      message.createdAt,
    );

    // Update session's updatedAt timestamp
    this.db.prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(now, sessionId);

    this.db.bumpLastModified();
    this.emit("chat:message:added", message);
    return message;
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

    return (rows as any[]).map((row) => this.rowToMessage(row));
  }

  /**
   * Get a message by ID.
   *
   * @param id - Message ID
   * @returns The message, or undefined if not found
   */
  getMessage(id: string): ChatMessage | undefined {
    const row = this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id);
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
    for (const row of rows as any[]) {
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
}
