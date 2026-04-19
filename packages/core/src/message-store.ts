/**
 * MessageStore - SQLite-based persistence for the messaging system.
 *
 * Messages are stored in the `messages` table with indexed lookups
 * for inbox/outbox/conversation queries.
 *
 * Follows the same patterns as ChatStore:
 * - EventEmitter for change notifications
 * - SQLite for structured data storage (synchronous)
 * - JSON columns for optional metadata
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { fromJson, toJsonNullable } from "./db.js";
import type {
  Message,
  MessageCreateInput,
  MessageFilter,
  MessageType,
  Mailbox,
  ParticipantType,
} from "./types.js";

// ── Event Types ─────────────────────────────────────────────────────

/** Events emitted by MessageStore */
export interface MessageStoreEvents {
  /** Emitted when a new message is created and sent */
  "message:sent": [message: Message];
  /** Emitted when a message is received by a participant */
  "message:received": [message: Message];
  /** Emitted when a message is marked as read */
  "message:read": [message: Message];
  /** Emitted when a message is deleted */
  "message:deleted": [messageId: string];
}

// ── Options Types ────────────────────────────────────────────────────

/** Options for MessageStore constructor */
export interface MessageStoreOptions {
  /** Optional hook invoked when a message is addressed to an agent */
  onMessageToAgent?: (message: Message) => void;
}

// ── MessageStore Class ───────────────────────────────────────────────

/**
 * MessageStore manages messages between agents, users, and the system.
 * Uses SQLite for persistent storage with efficient indexed queries.
 */
export class MessageStore extends EventEmitter<MessageStoreEvents> {
  private onMessageToAgent?: (message: Message) => void;

  // Prepared statements for frequently-run queries
  private stmtInsert!: ReturnType<Database["prepare"]>;
  private stmtGetById!: ReturnType<Database["prepare"]>;
  private stmtUpdateRead!: ReturnType<Database["prepare"]>;
  private stmtDelete!: ReturnType<Database["prepare"]>;
  private stmtCountUnread!: ReturnType<Database["prepare"]>;
  private stmtGetLastMessage!: ReturnType<Database["prepare"]>;

  constructor(
    private db: Database,
    options?: MessageStoreOptions,
  ) {
    super();
    this.setMaxListeners(100);
    this.onMessageToAgent = options?.onMessageToAgent;

    // Prepare frequently-run statements
    this.stmtInsert = this.db.prepare(`
      INSERT INTO messages (id, fromId, fromType, toId, toType, content, type, read, metadata, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetById = this.db.prepare(`
      SELECT * FROM messages WHERE id = ?
    `);

    this.stmtUpdateRead = this.db.prepare(`
      UPDATE messages SET read = 1, updatedAt = ? WHERE id = ?
    `);

    this.stmtDelete = this.db.prepare(`
      DELETE FROM messages WHERE id = ?
    `);

    this.stmtCountUnread = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages WHERE toId = ? AND toType = ? AND read = 0
    `);

    this.stmtGetLastMessage = this.db.prepare(`
      SELECT * FROM messages WHERE toId = ? AND toType = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1
    `);
  }

  // ── Row-to-Object Converters ───────────────────────────────────────

  /**
   * Convert a database row to a Message object.
   */
  private rowToMessage(row: any): Message {
    return {
      id: row.id,
      fromId: row.fromId,
      fromType: row.fromType as ParticipantType,
      toId: row.toId,
      toType: row.toType as ParticipantType,
      content: row.content,
      type: row.type as MessageType,
      read: row.read === 1,
      metadata: fromJson<Record<string, unknown>>(row.metadata),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Create and store a new message.
   * @param input - Message creation parameters
   * @returns The created message
   */
  sendMessage(input: MessageCreateInput): Message {
    const now = new Date().toISOString();
    const messageId = `msg-${randomUUID().slice(0, 8)}`;

    const fromId = input.fromId ?? "system";
    const fromType = input.fromType ?? "system";

    const message: Message = {
      id: messageId,
      fromId,
      fromType,
      toId: input.toId,
      toType: input.toType,
      content: input.content,
      type: input.type,
      read: false,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    this.stmtInsert.run(
      message.id,
      message.fromId,
      message.fromType,
      message.toId,
      message.toType,
      message.content,
      message.type,
      message.read ? 1 : 0,
      toJsonNullable(message.metadata),
      message.createdAt,
      message.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("message:sent", message);
    this.emit("message:received", message);

    if (message.toType === "agent" && this.onMessageToAgent) {
      this.onMessageToAgent(message);
    }

    return message;
  }

  /**
   * Get a single message by ID.
   * @param id - The message ID
   * @returns The message, or null if not found
   */
  getMessage(id: string): Message | null {
    const row = this.stmtGetById.get(id);
    if (!row) return null;
    return this.rowToMessage(row);
  }

  /**
   * Get inbox messages for a participant (messages where they are the recipient).
   * @param ownerId - The participant ID
   * @param ownerType - The participant type
   * @param filter - Optional filter criteria
   * @returns Array of messages (newest first)
   */
  getInbox(
    ownerId: string,
    ownerType: ParticipantType,
    filter?: MessageFilter,
  ): Message[] {
    return this.queryMessagesByParticipant("to", ownerId, ownerType, filter);
  }

  /**
   * Get outbox messages for a participant (messages they sent).
   * @param ownerId - The participant ID
   * @param ownerType - The participant type
   * @param filter - Optional filter criteria
   * @returns Array of messages (newest first)
   */
  getOutbox(
    ownerId: string,
    ownerType: ParticipantType,
    filter?: MessageFilter,
  ): Message[] {
    return this.queryMessagesByParticipant("from", ownerId, ownerType, filter);
  }

  private queryMessagesByParticipant(
    direction: "to" | "from",
    ownerId: string,
    ownerType: ParticipantType,
    filter?: MessageFilter,
  ): Message[] {
    const idCol = direction === "to" ? "toId" : "fromId";
    const typeCol = direction === "to" ? "toType" : "fromType";
    const whereClauses: string[] = [`${idCol} = ?`, `${typeCol} = ?`];
    const params: (string | number)[] = [ownerId, ownerType];

    if (filter?.type) {
      whereClauses.push("type = ?");
      params.push(filter.type);
    }

    if (filter?.read !== undefined) {
      whereClauses.push("read = ?");
      params.push(filter.read ? 1 : 0);
    }

    const whereSql = whereClauses.join(" AND ");
    const limit = filter?.limit ?? 100;
    const offset = filter?.offset ?? 0;

    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE ${whereSql}
      ORDER BY createdAt DESC, rowid DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return (rows as any[]).map((row) => this.rowToMessage(row));
  }

  /**
   * Mark a message as read.
   * @param messageId - The message ID
   * @returns The updated message
   * @throws Error if message not found
   */
  markAsRead(messageId: string): Message {
    // First check if the message exists
    const existing = this.getMessage(messageId);
    if (!existing) {
      throw new Error(`Message ${messageId} not found`);
    }

    if (existing.read) return existing;

    const now = new Date().toISOString();
    this.stmtUpdateRead.run(now, messageId);
    this.db.bumpLastModified();

    const updated = this.getMessage(messageId);
    this.emit("message:read", updated!);
    return updated!;
  }

  /**
   * Mark all inbox messages as read for a participant.
   * @param ownerId - The participant ID
   * @param ownerType - The participant type
   * @returns Number of messages marked as read
   */
  markAllAsRead(
    ownerId: string,
    ownerType: ParticipantType,
  ): number {
    const now = new Date().toISOString();
    // Get count of unread messages before updating
    const unreadRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages WHERE toId = ? AND toType = ? AND read = 0
    `).get(ownerId, ownerType) as { count: number } | undefined;
    const count = unreadRow?.count ?? 0;

    // Mark all as read
    this.db.prepare(`
      UPDATE messages SET read = 1, updatedAt = ? WHERE toId = ? AND toType = ? AND read = 0
    `).run(now, ownerId, ownerType);

    this.db.bumpLastModified();
    return count;
  }

  /**
   * Delete a message by ID.
   * @param id - The message ID
   * @throws Error if message not found
   */
  deleteMessage(id: string): void {
    // First check if the message exists
    const existing = this.getMessage(id);
    if (!existing) {
      throw new Error(`Message ${id} not found`);
    }

    this.stmtDelete.run(id);
    this.db.bumpLastModified();
    this.emit("message:deleted", id);
  }

  /**
   * Get all messages between two participants (conversation view).
   * @param participantA - First participant
   * @param participantB - Second participant
   * @returns Array of messages (oldest first for conversation ordering)
   */
  getConversation(
    participantA: { id: string; type: ParticipantType },
    participantB: { id: string; type: ParticipantType },
  ): Message[] {
    // Find messages where either participant is sender or receiver
    // This captures all messages between the two participants
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE (
        (fromId = ? AND fromType = ? AND toId = ? AND toType = ?)
        OR
        (fromId = ? AND fromType = ? AND toId = ? AND toType = ?)
      )
      ORDER BY createdAt ASC
    `).all(
      participantA.id, participantA.type,
      participantB.id, participantB.type,
      participantB.id, participantB.type,
      participantA.id, participantA.type,
    );

    return (rows as any[]).map((row) => this.rowToMessage(row));
  }

  /**
   * Get mailbox summary for a participant.
   * @param ownerId - The participant ID
   * @param ownerType - The participant type
   * @returns Mailbox summary with unread count and last message
   */
  getMailbox(
    ownerId: string,
    ownerType: ParticipantType,
  ): Mailbox {
    const unreadRow = this.stmtCountUnread.get(ownerId, ownerType) as { count: number } | undefined;
    const unreadCount = unreadRow?.count ?? 0;

    const lastRow = this.stmtGetLastMessage.get(ownerId, ownerType);
    const lastMessage = lastRow ? this.rowToMessage(lastRow) : undefined;

    return {
      ownerId,
      ownerType,
      unreadCount,
      lastMessage,
    };
  }

  /**
   * Set or update the hook used when messages are sent to agents.
   */
  setMessageToAgentHook(hook: (message: Message) => void): void {
    this.onMessageToAgent = hook;
  }
}
