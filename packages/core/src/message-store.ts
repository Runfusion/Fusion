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
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { fromJson, toJsonNullable } from "./db.js";
import { createLogger } from "./logger.js";
import { DASHBOARD_USER_ID, normalizeMessageParticipant, validateMessageMetadata, type Message, type MessageCreateInput, type MessageFilter, type MessageType, type Mailbox, type ParticipantType } from "./types.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";
import * as asyncMessageStore from "./async-message-store.js";

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
  /** Emitted when proposal metadata changes without creating a new message. */
  "message:updated": [message: Message];
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
  /**
   * Optional hook invoked when a message is addressed to an agent.
   * FNXC:PostgresBackend 2026-06-28-10:20: widened to allow an async hook so the
   * agent wake-on-message delivery (agent-heartbeat.handleMessageToAgent) can read
   * the AgentStore via its async PG-capable path. The hook is awaited inside a
   * try/catch — a rejected wake hook is logged and degraded, never failing the send.
   */
  onMessageToAgent?: (message: Message) => void | Promise<void>;
}

// ── MessageStore Class ───────────────────────────────────────────────

/**
 * MessageStore manages messages between agents, users, and the system.
 * Uses SQLite for persistent storage with efficient indexed queries.
 *
 * FNXC:MessageStore 2026-06-24-12:30:
 * Backend dual-path: when an `AsyncDataLayer` is provided (PostgreSQL backend
 * active), every method delegates to the async-message-store helpers against
 * PostgreSQL. When absent, the legacy sync SQLite path runs byte-identically.
 */
export class MessageStore extends EventEmitter<MessageStoreEvents> {
  private onMessageToAgent?: (message: Message) => void | Promise<void>;
  private readonly asyncLayer: AsyncDataLayer | null;

  // Prepared statements for frequently-run queries (SQLite path only)
  private stmtInsert!: ReturnType<Database["prepare"]>;
  private stmtInsertOnce!: ReturnType<Database["prepare"]>;
  private stmtGetById!: ReturnType<Database["prepare"]>;
  private stmtUpdateRead!: ReturnType<Database["prepare"]>;
  private stmtDelete!: ReturnType<Database["prepare"]>;

  constructor(
    private db: Database | null,
    options?: MessageStoreOptions & { asyncLayer?: AsyncDataLayer | null },
  ) {
    super();
    this.setMaxListeners(100);
    this.onMessageToAgent = options?.onMessageToAgent;
    this.asyncLayer = options?.asyncLayer ?? null;

    if (this.asyncLayer) {
      // Backend mode: no prepared statements needed; data access is async.
      return;
    }

    // Prepare frequently-run statements (SQLite path)
    const sqliteDb = this.db!;
    this.stmtInsert = sqliteDb.prepare(`
      INSERT INTO messages (id, fromId, fromType, toId, toType, content, type, read, metadata, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtInsertOnce = sqliteDb.prepare(`
      INSERT OR IGNORE INTO messages (id, fromId, fromType, toId, toType, content, type, read, metadata, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetById = sqliteDb.prepare(`
      SELECT * FROM messages WHERE id = ?
    `);

    this.stmtUpdateRead = sqliteDb.prepare(`
      UPDATE messages SET read = 1, updatedAt = ? WHERE id = ?
    `);

    this.stmtDelete = sqliteDb.prepare(`
      DELETE FROM messages WHERE id = ?
    `);
  }

  /** True when the store is backed by PostgreSQL (AsyncDataLayer present). */
  isBackendMode(): boolean {
    return this.asyncLayer !== null;
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
  async sendMessage(input: MessageCreateInput): Promise<Message> {
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

    if (this.asyncLayer) {
      const layer = this.asyncLayer;
      await asyncMessageStore.sendMessage(layer.db, {
        id: message.id,
        fromId: message.fromId,
        fromType: message.fromType,
        toId: message.toId,
        toType: message.toType,
        content: message.content,
        type: message.type,
        read: message.read,
        metadata: message.metadata ?? null,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      });
    } else {
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
      this.db!.bumpLastModified();
    }

    messageStoreLog.log(`MessageStore emitting message:sent id=${message.id} type=${message.type} fromId=${message.fromId} toId=${message.toId}`);
    this.emit("message:sent", message);
    this.emit("message:received", message);

    if (message.toType === "agent" && this.onMessageToAgent) {
      // FNXC:PostgresBackend 2026-06-28-10:20:
      // The agent-delivery hook (agent-heartbeat.handleMessageToAgent) is now async
      // and PG-capable: it reads the AgentStore via its async getAgent path, so
      // wake-on-message works in PG backend mode. The message is already persisted
      // at this point, so a wake-hook failure (sync throw OR rejected promise) must
      // NOT fail the send — await inside try/catch, then log and degrade rather
      // than 500.
      try {
        await this.onMessageToAgent(message);
      } catch (err) {
        messageStoreLog.warn(
          `MessageStore onMessageToAgent hook failed for id=${message.id} (send still succeeded): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return message;
  }

  /**
   * Atomically send one message for a globally scoped idempotency key.
   *
   * FNXC:PostgresMigrationInbox 2026-07-14-12:10:
   * Once-only system notices use a deterministic message primary key and each backend's conflict-ignore insert. This closes the check-then-send race between concurrent engine starts while preserving normal MessageStore events only for the winning insert.
   */
  async sendMessageOnce(
    input: MessageCreateInput,
    idempotencyKey: string,
  ): Promise<{ message: Message; inserted: boolean }> {
    validateMessageMetadata(input.metadata);
    const now = new Date().toISOString();
    const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24);
    const from = normalizeMessageParticipant(input.fromId ?? "system", input.fromType ?? "system");
    const to = normalizeMessageParticipant(input.toId, input.toType);
    const message: Message = {
      id: `msg-once-${digest}`,
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

    let inserted: boolean;
    if (this.asyncLayer) {
      inserted = await asyncMessageStore.sendMessageOnce(this.asyncLayer.db, {
        ...message,
        metadata: message.metadata ?? null,
      });
    } else {
      const result = this.stmtInsertOnce.run(
        message.id,
        message.fromId,
        message.fromType,
        message.toId,
        message.toType,
        message.content,
        message.type,
        0,
        toJsonNullable(message.metadata),
        message.createdAt,
        message.updatedAt,
      );
      inserted = result.changes === 1;
      if (inserted) this.db!.bumpLastModified();
    }

    if (!inserted) return { message, inserted: false };

    this.emit("message:sent", message);
    this.emit("message:received", message);
    if (message.toType === "agent" && this.onMessageToAgent) {
      try {
        await this.onMessageToAgent(message);
      } catch (err) {
        messageStoreLog.warn(
          `MessageStore onMessageToAgent hook failed for once-only id=${message.id} (send still succeeded): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { message, inserted: true };
  }

  /**
   * Get a single message by ID.
   * @param id - The message ID
   * @returns The message, or null if not found
   */
  async getMessage(id: string): Promise<Message | null> {
    if (this.asyncLayer) {
      return asyncMessageStore.getMessage(this.asyncLayer.db, id);
    }
    const row = this.stmtGetById.get(id) as unknown as MessageRow | undefined;
    if (!row) return null;
    return this.rowToMessage(row);
  }

  /** Atomically acquire a pending proposal's transient creation lease. */
  async claimProposalForCreation(messageId: string): Promise<{ claimed: boolean; idempotencyKey?: string; claimOwnerToken?: string }> {
    if (this.asyncLayer) {
      const result = await asyncMessageStore.claimProposalForCreation(this.asyncLayer.db, messageId);
      if (result.message) this.emit("message:updated", result.message);
      return result;
    }
    const owner = randomUUID();
    const now = new Date().toISOString();
    // FNXC:EphemeralAgentTaskCreation 2026-07-30-16:00: SQLite-compatible stores persist the lease start with its owner, allowing a later operator request to recover a dead creator without changing the stable idempotency key.
    const changed = this.db!.prepare(`UPDATE messages SET metadata = json_set(metadata, '$.proposalStatus', 'creating', '$.claimOwnerToken', ?, '$.claimStartedAt', ?), updatedAt = ? WHERE id = ? AND json_extract(metadata, '$.kind') = 'task-proposal' AND json_extract(metadata, '$.proposalStatus') = 'pending'`).run(owner, now, now, messageId).changes;
    if (!changed) return { claimed: false };
    this.db!.bumpLastModified();
    const message = await this.getMessage(messageId);
    if (message) this.emit("message:updated", message);
    return { claimed: true, idempotencyKey: message?.metadata?.proposalIdempotencyKey as string | undefined, claimOwnerToken: owner };
  }

  async finalizeProposalCreation(messageId: string, claimOwnerToken: string, createdTaskId: string): Promise<Message | null> {
    if (this.asyncLayer) {
      const message = await asyncMessageStore.finalizeProposalCreation(this.asyncLayer.db, messageId, claimOwnerToken, createdTaskId);
      if (message) this.emit("message:updated", message);
      return message;
    }
    const existing = await this.getMessage(messageId);
    if (existing?.metadata?.proposalStatus === "created" && existing.metadata.createdTaskId === createdTaskId) return existing;
    const changed = this.db!.prepare(`UPDATE messages SET metadata = json_set(metadata, '$.proposalStatus', 'created', '$.createdTaskId', ?, '$.claimOwnerToken', null, '$.claimStartedAt', null), updatedAt = ? WHERE id = ? AND json_extract(metadata, '$.proposalStatus') = 'creating' AND json_extract(metadata, '$.claimOwnerToken') = ?`).run(createdTaskId, new Date().toISOString(), messageId, claimOwnerToken).changes;
    if (!changed) return null;
    this.db!.bumpLastModified(); const message = await this.getMessage(messageId); if (message) this.emit("message:updated", message); return message;
  }

  async releaseProposalClaim(messageId: string, claimOwnerToken: string): Promise<Message | null> {
    if (this.asyncLayer) { const message = await asyncMessageStore.releaseProposalClaim(this.asyncLayer.db, messageId, claimOwnerToken); if (message) this.emit("message:updated", message); return message; }
    const changed = this.db!.prepare(`UPDATE messages SET metadata = json_set(metadata, '$.proposalStatus', 'pending', '$.claimOwnerToken', null, '$.claimStartedAt', null), updatedAt = ? WHERE id = ? AND json_extract(metadata, '$.proposalStatus') = 'creating' AND json_extract(metadata, '$.claimOwnerToken') = ?`).run(new Date().toISOString(), messageId, claimOwnerToken).changes;
    if (!changed) return null; this.db!.bumpLastModified(); const message = await this.getMessage(messageId); if (message) this.emit("message:updated", message); return message;
  }

  async reconcileProposalCreation(messageId: string, resolvedTaskId: string | undefined): Promise<Message | null> {
    const message = await this.getMessage(messageId);
    if (!message || message.metadata?.proposalStatus !== "creating") return message;
    if (resolvedTaskId) return this.finalizeProposalCreation(messageId, message.metadata.claimOwnerToken ?? "", resolvedTaskId);
    return this.releaseProposalClaim(messageId, message.metadata.claimOwnerToken ?? "");
  }

  /**
   * Get inbox messages for a participant (messages where they are the recipient).
   * @param ownerId - The participant ID
   * @param ownerType - The participant type
   * @param filter - Optional filter criteria
   * @returns Array of messages (newest first)
   */
  async getInbox(
    ownerId: string,
    ownerType: ParticipantType,
    filter?: MessageFilter,
  ): Promise<Message[]> {
    if (this.asyncLayer) {
      return asyncMessageStore.queryMessagesByParticipant(this.asyncLayer.db, "to", ownerId, ownerType, filter);
    }
    return this.queryMessagesByParticipant("to", ownerId, ownerType, filter);
  }

  /**
   * Get outbox messages for a participant (messages they sent).
   * @param ownerId - The participant ID
   * @param ownerType - The participant type
   * @param filter - Optional filter criteria
   * @returns Array of messages (newest first)
   */
  async getOutbox(
    ownerId: string,
    ownerType: ParticipantType,
    filter?: MessageFilter,
  ): Promise<Message[]> {
    if (this.asyncLayer) {
      return asyncMessageStore.queryMessagesByParticipant(this.asyncLayer.db, "from", ownerId, ownerType, filter);
    }
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

    const rows = this.db!.prepare(`
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
  async markAsRead(messageId: string): Promise<Message> {
    if (this.asyncLayer) {
      const updated = await asyncMessageStore.markMessageAsRead(this.asyncLayer.db, messageId);
      if (!updated) throw new Error(`Message ${messageId} not found`);
      this.emit("message:read", updated);
      return updated;
    }
    // First check if the message exists
    const existing = await this.getMessage(messageId);
    if (!existing) {
      throw new Error(`Message ${messageId} not found`);
    }

    if (existing.read) return existing;

    const now = new Date().toISOString();
    this.stmtUpdateRead.run(now, messageId);
    this.db!.bumpLastModified();

    const updated = await this.getMessage(messageId);
    this.emit("message:read", updated!);
    return updated!;
  }

  /**
   * Mark all inbox messages as read for a participant.
   * @param ownerId - The participant ID
   * @param ownerType - The participant type
   * @returns Number of messages marked as read
   */
  async markAllAsRead(
    ownerId: string,
    ownerType: ParticipantType,
  ): Promise<number> {
    if (this.asyncLayer) {
      return asyncMessageStore.markAllMessagesAsRead(this.asyncLayer.db, ownerId, ownerType);
    }
    const now = new Date().toISOString();
    const participantIds = this.getParticipantIdsForLookup(ownerId, ownerType);
    const toIdPredicate = participantIds.length === 1
      ? "toId = ?"
      : `toId IN (${participantIds.map(() => "?").join(", ")})`;

    // Get count of unread messages before updating
    const unreadRow = this.db!.prepare(`
      SELECT COUNT(*) as count FROM messages WHERE ${toIdPredicate} AND toType = ? AND read = 0
    `).get(...participantIds, ownerType) as { count: number } | undefined;
    const count = unreadRow?.count ?? 0;

    // Mark all as read
    this.db!.prepare(`
      UPDATE messages SET read = 1, updatedAt = ? WHERE ${toIdPredicate} AND toType = ? AND read = 0
    `).run(now, ...participantIds, ownerType);

    this.db!.bumpLastModified();
    return count;
  }

  /**
   * Delete a message by ID.
   * @param id - The message ID
   * @throws Error if message not found
   */
  async deleteMessage(id: string): Promise<void> {
    if (this.asyncLayer) {
      const existing = await this.getMessage(id);
      if (!existing) {
        throw new Error(`Message ${id} not found`);
      }
      await asyncMessageStore.deleteMessage(this.asyncLayer.db, id);
      this.emit("message:deleted", id);
      return;
    }
    // First check if the message exists
    const existing = await this.getMessage(id);
    if (!existing) {
      throw new Error(`Message ${id} not found`);
    }

    this.stmtDelete.run(id);
    this.db!.bumpLastModified();
    this.emit("message:deleted", id);
  }

  /**
   * Delete messages older than a max inactivity threshold (by updatedAt).
   * @param maxAgeMs - Inactivity threshold in milliseconds
   * @returns Number of deleted messages
   */
  async cleanupOldMessages(maxAgeMs: number): Promise<{ messagesDeleted: number }> {
    if (this.asyncLayer) {
      const layer = this.asyncLayer;
      const deletedIds = await asyncMessageStore.cleanupOldMessages(layer, maxAgeMs);
      for (const id of deletedIds) {
        this.emit("message:deleted", id);
      }
      messageStoreLog.log(`cleanupOldMessages deleted=${deletedIds.length}`);
      return { messagesDeleted: deletedIds.length };
    }
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      return { messagesDeleted: 0 };
    }

    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const deletedIds = this.db!.transaction(() => {
      const rows = this.db!.prepare(`
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

    this.db!.bumpLastModified();
    messageStoreLog.log(`cleanupOldMessages deleted=${deletedIds.length} cutoff=${cutoff}`);
    return { messagesDeleted: deletedIds.length };
  }

  /**
   * Get messages between two participants (conversation view).
   *
   * FNXC:MessageStorePerf 2026-07-11 (PR #1793 review):
   * Capped to the most recent `options.limit` messages (default 200) — the
   * unbounded read fed the CLI chat's AI context with the FULL history on
   * every exchange. Results stay oldest-first.
   *
   * @param participantA - First participant
   * @param participantB - Second participant
   * @param options - Optional `limit` override for the most-recent-N cap
   * @returns Array of messages (oldest first for conversation ordering)
   */
  async getConversation(
    participantA: { id: string; type: ParticipantType },
    participantB: { id: string; type: ParticipantType },
    options?: { limit?: number },
  ): Promise<Message[]> {
    if (this.asyncLayer) {
      return asyncMessageStore.getConversation(this.asyncLayer.db, participantA, participantB, options);
    }
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
    const rows = this.db!.prepare(`
      SELECT * FROM messages
      WHERE (
        (${participantAFromPredicate} AND fromType = ? AND ${participantBToPredicate} AND toType = ?)
        OR
        (${participantBFromPredicate} AND fromType = ? AND ${participantAToPredicate} AND toType = ?)
      )
      ORDER BY createdAt DESC
      LIMIT ?
    `).all(
      ...participantAIds,
      participantA.type,
      ...participantBIds,
      participantB.type,
      ...participantBIds,
      participantB.type,
      ...participantAIds,
      participantA.type,
      Math.max(1, options?.limit ?? asyncMessageStore.DEFAULT_CONVERSATION_LIMIT),
    );

    return (rows as unknown as MessageRow[]).reverse().map((row) => this.rowToMessage(row));
  }

  /**
   * Get mailbox summary for a participant.
   * @param ownerId - The participant ID
   * @param ownerType - The participant type
   * @returns Mailbox summary with unread count and last message
   */
  async getMailbox(
    ownerId: string,
    ownerType: ParticipantType,
  ): Promise<Mailbox> {
    if (this.asyncLayer) {
      const summary = await asyncMessageStore.getMailbox(this.asyncLayer.db, ownerId, ownerType);
      return {
        ownerId: summary.ownerId,
        ownerType: summary.ownerType,
        unreadCount: summary.unreadCount,
        lastMessage: summary.lastMessage,
      };
    }
    const participantIds = this.getParticipantIdsForLookup(ownerId, ownerType);
    const toIdPredicate = participantIds.length === 1
      ? "toId = ?"
      : `toId IN (${participantIds.map(() => "?").join(", ")})`;

    const unreadRow = this.db!.prepare(`
      SELECT COUNT(*) as count FROM messages WHERE ${toIdPredicate} AND toType = ? AND read = 0
    `).get(...participantIds, ownerType) as { count: number } | undefined;
    const unreadCount = unreadRow?.count ?? 0;

    const lastRow = this.db!.prepare(`
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
  async getAllAgentToAgentMessages(): Promise<Message[]> {
    if (this.asyncLayer) {
      return asyncMessageStore.getAllAgentToAgentMessages(this.asyncLayer.db);
    }
    const rows = this.db!.prepare(`
      SELECT * FROM messages
      WHERE type = ?
      ORDER BY createdAt DESC, rowid DESC
    `).all("agent-to-agent");

    return (rows as unknown as MessageRow[]).map((row) => this.rowToMessage(row));
  }

  /**
   * Get unread count across all agent-to-agent messages.
   */
  async getUnreadAgentToAgentCount(): Promise<number> {
    if (this.asyncLayer) {
      return asyncMessageStore.getUnreadAgentToAgentCount(this.asyncLayer.db);
    }
    const row = this.db!.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE type = ? AND read = 0
    `).get("agent-to-agent") as { count: number } | undefined;

    return row?.count ?? 0;
  }

  /**
   * Set or update the hook used when messages are sent to agents.
   */
  setMessageToAgentHook(hook: (message: Message) => void | Promise<void>): void {
    this.onMessageToAgent = hook;
  }
}
