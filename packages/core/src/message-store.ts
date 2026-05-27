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
import { createLogger } from "./logger.js";
import { DASHBOARD_USER_ID, normalizeMessageParticipant, validateMessageMetadata, type Message, type MessageCreateInput, type MessageFilter, type MessageType, type Mailbox, type ParticipantType } from "./types.js";

const messageStoreLog = createLogger("message-store");

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

// ── Row Interfaces ───────────────────────────────────────────────────

/** Database row shape for the messages table. */
interface MessageRow {
  id: string;
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
  content: string;
  type: string;
  read: number;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
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
  }

  // ── Row-to-Object Converters ───────────────────────────────────────

  /**
   * Convert a database row to a Message object.
   */
  private rowToMessage(row: MessageRow): Message {
    return {
      id: row.id,
      fromId: row.fromId,
      fromType: row.fromType as ParticipantType,
      toId: row.toId,
      toType: row.toType as ParticipantType,
      content: row.content,
      type: row.type as MessageType,
      read: row.read === 1,
      metadata: fromJson<Message["metadata"]>(row.metadata),
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
    validateMessageMetadata(input.metadata);

    const now = new Date().toISOString();
    const messageId = `msg-${randomUUID().slice(0, 8)}`;

    const from = normalizeMessageParticipant(input.fromId ?? "system", input.fromType ?? "system");
    const to = normalizeMessageParticipant(input.toId, input.toType);

    const message: Message = {
      id: messageId,
      fromId: from.id,
      fromType: from.type,
      toId: to.id,
      toType: to.type,
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
    messageStoreLog.log(`MessageStore emitting message:sent id=${message.id} type=${message.type} fromId=${message.fromId} toId=${message.toId}`);
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
    const row = this.stmtGetById.get(id) as unknown as MessageRow | undefined;
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

  private getParticipantIdsForLookup(ownerId: string, ownerType: ParticipantType): string[] {
    if (ownerType === "user" && ownerId === DASHBOARD_USER_ID) {
      return [DASHBOARD_USER_ID, "user", "user:dashboard", "User: user:dashboard"];
    }
    return [ownerId];
  }

  private queryMessagesByParticipant(
    direction: "to" | "from",
    ownerId: string,
    ownerType: ParticipantType,
    filter?: MessageFilter,
  ): Message[] {
    const idCol = direction === "to" ? "toId" : "fromId";
    const typeCol = direction === "to" ? "toType" : "fromType";
    const participantIds = this.getParticipantIdsForLookup(ownerId, ownerType);
    const idPredicate = participantIds.length === 1
      ? `${idCol} = ?`
      : `${idCol} IN (${participantIds.map(() => "?").join(", ")})`;
    const whereClauses: string[] = [idPredicate, `${typeCol} = ?`];
    const params: (string | number)[] = [...participantIds, ownerType];

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

    return (rows as unknown as MessageRow[]).map((row) => this.rowToMessage(row));
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
    const participantIds = this.getParticipantIdsForLookup(ownerId, ownerType);
    const toIdPredicate = participantIds.length === 1
      ? "toId = ?"
      : `toId IN (${participantIds.map(() => "?").join(", ")})`;

    // Get count of unread messages before updating
    const unreadRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages WHERE ${toIdPredicate} AND toType = ? AND read = 0
    `).get(...participantIds, ownerType) as { count: number } | undefined;
    const count = unreadRow?.count ?? 0;

    // Mark all as read
    this.db.prepare(`
      UPDATE messages SET read = 1, updatedAt = ? WHERE ${toIdPredicate} AND toType = ? AND read = 0
    `).run(now, ...participantIds, ownerType);

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
   * Delete messages older than a max inactivity threshold (by updatedAt).
   * @param maxAgeMs - Inactivity threshold in milliseconds
   * @returns Number of deleted messages
   */
  cleanupOldMessages(maxAgeMs: number): { messagesDeleted: number } {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      return { messagesDeleted: 0 };
    }

    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const deletedIds = this.db.transaction(() => {
      const rows = this.db.prepare(`
        DELETE FROM messages
        WHERE updatedAt < ?
        RETURNING id
      `).all(cutoff) as Array<{ id: string }>;
      return rows.map((row) => row.id);
    });

    if (deletedIds.length === 0) {
      messageStoreLog.log(`cleanupOldMessages deleted=0 cutoff=${cutoff}`);
      return { messagesDeleted: 0 };
    }

    for (const id of deletedIds) {
      this.emit("message:deleted", id);
    }

    this.db.bumpLastModified();
    messageStoreLog.log(`cleanupOldMessages deleted=${deletedIds.length} cutoff=${cutoff}`);
    return { messagesDeleted: deletedIds.length };
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
    const participantAIds = this.getParticipantIdsForLookup(participantA.id, participantA.type);
    const participantBIds = this.getParticipantIdsForLookup(participantB.id, participantB.type);
    const participantAFromPredicate = participantAIds.length === 1
      ? "fromId = ?"
      : `fromId IN (${participantAIds.map(() => "?").join(", ")})`;
    const participantAToPredicate = participantAIds.length === 1
      ? "toId = ?"
      : `toId IN (${participantAIds.map(() => "?").join(", ")})`;
    const participantBFromPredicate = participantBIds.length === 1
      ? "fromId = ?"
      : `fromId IN (${participantBIds.map(() => "?").join(", ")})`;
    const participantBToPredicate = participantBIds.length === 1
      ? "toId = ?"
      : `toId IN (${participantBIds.map(() => "?").join(", ")})`;

    // Find messages where either participant is sender or receiver
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE (
        (${participantAFromPredicate} AND fromType = ? AND ${participantBToPredicate} AND toType = ?)
        OR
        (${participantBFromPredicate} AND fromType = ? AND ${participantAToPredicate} AND toType = ?)
      )
      ORDER BY createdAt ASC
    `).all(
      ...participantAIds,
      participantA.type,
      ...participantBIds,
      participantB.type,
      ...participantBIds,
      participantB.type,
      ...participantAIds,
      participantA.type,
    );

    return (rows as unknown as MessageRow[]).map((row) => this.rowToMessage(row));
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
    const participantIds = this.getParticipantIdsForLookup(ownerId, ownerType);
    const toIdPredicate = participantIds.length === 1
      ? "toId = ?"
      : `toId IN (${participantIds.map(() => "?").join(", ")})`;

    const unreadRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages WHERE ${toIdPredicate} AND toType = ? AND read = 0
    `).get(...participantIds, ownerType) as { count: number } | undefined;
    const unreadCount = unreadRow?.count ?? 0;

    const lastRow = this.db.prepare(`
      SELECT * FROM messages WHERE ${toIdPredicate} AND toType = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1
    `).get(...participantIds, ownerType) as unknown as MessageRow | undefined;
    const lastMessage = lastRow ? this.rowToMessage(lastRow) : undefined;

    return {
      ownerId,
      ownerType,
      unreadCount,
      lastMessage,
    };
  }

  /**
   * Get all agent-to-agent messages across all agents.
   * @returns Array of messages (newest first)
   */
  getAllAgentToAgentMessages(): Message[] {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE type = ?
      ORDER BY createdAt DESC, rowid DESC
    `).all("agent-to-agent");

    return (rows as unknown as MessageRow[]).map((row) => this.rowToMessage(row));
  }

  /**
   * Get unread count across all agent-to-agent messages.
   */
  getUnreadAgentToAgentCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE type = ? AND read = 0
    `).get("agent-to-agent") as { count: number } | undefined;

    return row?.count ?? 0;
  }

  /**
   * Set or update the hook used when messages are sent to agents.
   */
  setMessageToAgentHook(hook: (message: Message) => void): void {
    this.onMessageToAgent = hook;
  }
}
