/**
 * Async Drizzle MessageStore helpers (U6 satellite-db-injected-stores).
 *
 * FNXC:MessageStore 2026-06-24-06:55:
 * Async equivalents of the sync SQLite MessageStore call sites in
 * message-store.ts. These helpers target the PostgreSQL `project.messages`
 * table via Drizzle and preserve the inbox/outbox/conversation/mailbox query
 * semantics.
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   The `metadata` column is jsonb in PostgreSQL, so Drizzle returns it
 *   already-parsed as a JS value. The `read` boolean column is kept as integer
 *   (0/1). The SQLite `rowid DESC` tie-breaker maps to PostgreSQL `ctid`
 *   (physical row order) which is approximated by `createdAt DESC, id DESC`.
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   flip. These helpers are the async target the PostgreSQL integration tests
 *   consume.
 */
import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  DASHBOARD_USER_ID,
  type Message,
  type MessageFilter,
  type MessageType,
  type ParticipantType,
} from "./types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

interface MessageRow {
  id: string;
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
  content: string;
  type: string;
  read: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

type PersistedMessage = Omit<Message, "metadata"> & {
  metadata: NonNullable<Message["metadata"]> | null;
};

const messageColumns = {
  id: schema.project.messages.id,
  fromId: schema.project.messages.fromId,
  fromType: schema.project.messages.fromType,
  toId: schema.project.messages.toId,
  toType: schema.project.messages.toType,
  content: schema.project.messages.content,
  type: schema.project.messages.type,
  read: schema.project.messages.read,
  metadata: schema.project.messages.metadata,
  createdAt: schema.project.messages.createdAt,
  updatedAt: schema.project.messages.updatedAt,
};

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    fromId: row.fromId,
    fromType: row.fromType as ParticipantType,
    toId: row.toId,
    toType: row.toType as ParticipantType,
    content: row.content,
    type: row.type as MessageType,
    read: (row.read ?? 0) === 1,
    metadata: row.metadata ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function participantIdsForLookup(ownerId: string, ownerType: ParticipantType): string[] {
  if (ownerType === "user" && ownerId === DASHBOARD_USER_ID) {
    return [DASHBOARD_USER_ID, "user", "user:dashboard", "User: user:dashboard"];
  }
  return [ownerId];
}

/**
 * FNXC:MessageStore 2026-06-24-07:00:
 * Create (send) a message. Non-destructive INSERT.
 */
export async function sendMessage(
  handle: QueryHandle,
  message: PersistedMessage,
): Promise<Message> {
  await handle.insert(schema.project.messages).values({
    id: message.id,
    fromId: message.fromId,
    fromType: message.fromType,
    toId: message.toId,
    toType: message.toType,
    content: message.content,
    type: message.type,
    read: message.read ? 1 : 0,
    metadata: message.metadata,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  });
  return rowToMessage({
    ...message,
    read: message.read ? 1 : 0,
  });
}

/*
FNXC:PostgresMigrationInbox 2026-07-14-12:10:
Database conflict handling, rather than an inbox read followed by an insert, arbitrates once-only system messages. The caller supplies a deterministic primary-key id so concurrent project starts cannot both create the same logical notice.
*/
export async function sendMessageOnce(
  handle: QueryHandle,
  message: PersistedMessage,
): Promise<boolean> {
  const inserted = await handle
    .insert(schema.project.messages)
    .values({
      id: message.id,
      fromId: message.fromId,
      fromType: message.fromType,
      toId: message.toId,
      toType: message.toType,
      content: message.content,
      type: message.type,
      read: message.read ? 1 : 0,
      metadata: message.metadata,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })
    .onConflictDoNothing({ target: [schema.project.messages.projectId, schema.project.messages.id] })
    .returning({ id: schema.project.messages.id });
  return inserted.length === 1;
}

/**
 * Get a single message by id.
 */
export async function getMessage(handle: QueryHandle, id: string): Promise<Message | null> {
  const rows = await handle
    .select(messageColumns)
    .from(schema.project.messages)
    .where(eq(schema.project.messages.id, id));
  return rows[0] ? rowToMessage(rows[0] as MessageRow) : null;
}

export async function claimProposalForCreation(handle: QueryHandle, messageId: string): Promise<{ claimed: boolean; idempotencyKey?: string; claimOwnerToken?: string; message?: Message }> {
  const existing = await getMessage(handle, messageId);
  if (existing?.metadata?.kind !== "task-proposal" || existing.metadata.proposalStatus !== "pending" || !existing.metadata.proposalIdempotencyKey) return { claimed: false };
  const owner = randomUUID();
  const claimStartedAt = new Date().toISOString();
  // FNXC:EphemeralAgentTaskCreation 2026-07-30-16:00: Persist a lease timestamp with the transient owner so a post-crash click can safely reclaim only stale creating proposals without rotating the stable key.
  const metadata = { ...existing.metadata, proposalStatus: "creating" as const, claimOwnerToken: owner, claimStartedAt };
  const updated = await handle.update(schema.project.messages).set({ metadata, updatedAt: claimStartedAt }).where(and(eq(schema.project.messages.id, messageId), sql`${schema.project.messages.metadata}->>'proposalStatus' = 'pending'`)).returning(messageColumns);
  if (!updated[0]) return { claimed: false };
  const message = rowToMessage(updated[0] as MessageRow);
  return { claimed: true, idempotencyKey: metadata.proposalIdempotencyKey, claimOwnerToken: owner, message };
}

export async function finalizeProposalCreation(handle: QueryHandle, messageId: string, claimOwnerToken: string, createdTaskId: string): Promise<Message | null> {
  const existing = await getMessage(handle, messageId);
  if (!existing) return null;
  if (existing.metadata?.proposalStatus === "created" && existing.metadata.createdTaskId === createdTaskId) return existing;
  if (existing.metadata?.proposalStatus !== "creating" || existing.metadata.claimOwnerToken !== claimOwnerToken) return null;
  const metadata = { ...existing.metadata, proposalStatus: "created" as const, createdTaskId, claimOwnerToken: undefined, claimStartedAt: undefined };
  const rows = await handle.update(schema.project.messages).set({ metadata, updatedAt: new Date().toISOString() }).where(and(eq(schema.project.messages.id, messageId), sql`${schema.project.messages.metadata}->>'claimOwnerToken' = ${claimOwnerToken}`)).returning(messageColumns);
  return rows[0] ? rowToMessage(rows[0] as MessageRow) : null;
}

export async function releaseProposalClaim(handle: QueryHandle, messageId: string, claimOwnerToken: string): Promise<Message | null> {
  const existing = await getMessage(handle, messageId);
  if (existing?.metadata?.proposalStatus !== "creating" || existing.metadata.claimOwnerToken !== claimOwnerToken) return null;
  // FNXC:EphemeralAgentTaskCreation 2026-07-30-12:00: release only transient ownership; stable idempotency key is retained for an overlapping retry.
  const metadata = { ...existing.metadata, proposalStatus: "pending" as const, claimOwnerToken: undefined, claimStartedAt: undefined };
  const rows = await handle.update(schema.project.messages).set({ metadata, updatedAt: new Date().toISOString() }).where(and(eq(schema.project.messages.id, messageId), sql`${schema.project.messages.metadata}->>'claimOwnerToken' = ${claimOwnerToken}`)).returning(messageColumns);
  return rows[0] ? rowToMessage(rows[0] as MessageRow) : null;
}

export async function reconcileProposalCreation(handle: QueryHandle, messageId: string, resolvedTaskId: string | undefined): Promise<Message | null> {
  const existing = await getMessage(handle, messageId);
  if (!existing || existing.metadata?.proposalStatus !== "creating") return existing;
  return resolvedTaskId ? finalizeProposalCreation(handle, messageId, existing.metadata.claimOwnerToken ?? "", resolvedTaskId) : releaseProposalClaim(handle, messageId, existing.metadata.claimOwnerToken ?? "");
}

/**
 * FNXC:MessageStore 2026-06-24-07:05:
 * Query messages by participant direction (to = inbox, from = outbox).
 * Handles the dashboard-user multi-id lookup and optional filters.
 */
export async function queryMessagesByParticipant(
  handle: QueryHandle,
  direction: "to" | "from",
  ownerId: string,
  ownerType: ParticipantType,
  filter?: MessageFilter,
): Promise<Message[]> {
  const idCol = direction === "to" ? schema.project.messages.toId : schema.project.messages.fromId;
  const typeCol = direction === "to" ? schema.project.messages.toType : schema.project.messages.fromType;
  const participantIds = participantIdsForLookup(ownerId, ownerType);
  const conditions: ReturnType<typeof eq>[] = [
    inArray(idCol, participantIds),
    eq(typeCol, ownerType),
  ];
  if (filter?.type) {
    conditions.push(eq(schema.project.messages.type, filter.type));
  }
  if (filter?.read !== undefined) {
    conditions.push(eq(schema.project.messages.read, filter.read ? 1 : 0));
  }
  const limit = filter?.limit ?? 100;
  const offset = filter?.offset ?? 0;
  const rows = await handle
    .select(messageColumns)
    .from(schema.project.messages)
    .where(and(...conditions))
    .orderBy(desc(schema.project.messages.createdAt), desc(schema.project.messages.id))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => rowToMessage(row as MessageRow));
}

/**
 * Mark a single message as read by id. Does nothing if already read.
 */
export async function markMessageAsRead(
  handle: QueryHandle,
  messageId: string,
): Promise<Message | null> {
  const existing = await getMessage(handle, messageId);
  if (!existing) throw new Error(`Message ${messageId} not found`);
  if (existing.read) return existing;
  const now = new Date().toISOString();
  await handle
    .update(schema.project.messages)
    .set({ read: 1, updatedAt: now })
    .where(eq(schema.project.messages.id, messageId));
  return (await getMessage(handle, messageId))!;
}

/**
 * FNXC:MessageStore 2026-06-24-07:10:
 * Mark all inbox messages as read for a participant. Returns the count of
 * messages that were unread before the update.
 */
export async function markAllMessagesAsRead(
  handle: QueryHandle,
  ownerId: string,
  ownerType: ParticipantType,
): Promise<number> {
  const now = new Date().toISOString();
  const participantIds = participantIdsForLookup(ownerId, ownerType);
  const countRows = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.messages)
    .where(
      and(
        inArray(schema.project.messages.toId, participantIds),
        eq(schema.project.messages.toType, ownerType),
        eq(schema.project.messages.read, 0),
      ),
    );
  const count = countRows[0]?.count ?? 0;
  await handle
    .update(schema.project.messages)
    .set({ read: 1, updatedAt: now })
    .where(
      and(
        inArray(schema.project.messages.toId, participantIds),
        eq(schema.project.messages.toType, ownerType),
        eq(schema.project.messages.read, 0),
      ),
    );
  return count;
}

/**
 * Delete a message by id. Throws if the message does not exist.
 */
export async function deleteMessage(handle: QueryHandle, id: string): Promise<void> {
  await handle.delete(schema.project.messages).where(eq(schema.project.messages.id, id));
}

/**
 * FNXC:MessageStore 2026-06-24-07:15:
 * Delete messages older than a max inactivity threshold (by updatedAt).
 * Returns the ids of deleted messages. Runs inside a transaction so the
 * RETURNING result and the delete are consistent.
 */
export async function cleanupOldMessages(
  layer: AsyncDataLayer,
  maxAgeMs: number,
): Promise<string[]> {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return [];
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const deleted = await layer.transactionImmediate(async (tx) => {
    const rows = await tx
      .delete(schema.project.messages)
      .where(lte(schema.project.messages.updatedAt, cutoff))
      .returning({ id: schema.project.messages.id });
    return rows.map((row) => row.id);
  });
  return deleted;
}

/**
 * FNXC:MessageStore 2026-06-24-07:20:
 * Get messages between two participants (conversation view). Finds
 * messages where either participant is sender or receiver.
 *
 * FNXC:MessageStorePerf 2026-07-11 (PR #1793 review):
 * The unbounded read loaded the FULL conversation history on every exchange —
 * the CLI chat feeds this straight into AI context, so long-lived agent pairs
 * paid an ever-growing query + token cost. The read is now capped to the most
 * recent `limit` messages (default 200) via ORDER BY createdAt DESC + LIMIT in
 * SQL, then re-sorted ascending so callers still receive oldest-first order.
 * Pass a larger `options.limit` explicitly for full-history exports.
 */
export const DEFAULT_CONVERSATION_LIMIT = 200;

export async function getConversation(
  handle: QueryHandle,
  participantA: { id: string; type: ParticipantType },
  participantB: { id: string; type: ParticipantType },
  options?: { limit?: number },
): Promise<Message[]> {
  const limit = Math.max(1, options?.limit ?? DEFAULT_CONVERSATION_LIMIT);
  const aIds = participantIdsForLookup(participantA.id, participantA.type);
  const bIds = participantIdsForLookup(participantB.id, participantB.type);
  const rows = await handle
    .select(messageColumns)
    .from(schema.project.messages)
    .where(
      or(
        and(
          inArray(schema.project.messages.fromId, aIds),
          eq(schema.project.messages.fromType, participantA.type),
          inArray(schema.project.messages.toId, bIds),
          eq(schema.project.messages.toType, participantB.type),
        ),
        and(
          inArray(schema.project.messages.fromId, bIds),
          eq(schema.project.messages.fromType, participantB.type),
          inArray(schema.project.messages.toId, aIds),
          eq(schema.project.messages.toType, participantA.type),
        ),
      ),
    )
    .orderBy(desc(schema.project.messages.createdAt))
    .limit(limit);
  return rows.reverse().map((row) => rowToMessage(row as MessageRow));
}

/**
 * FNXC:MessageStore 2026-06-24-07:25:
 * Get mailbox summary: unread count + last message for a participant.
 */
export async function getMailbox(
  handle: QueryHandle,
  ownerId: string,
  ownerType: ParticipantType,
): Promise<{ ownerId: string; ownerType: ParticipantType; unreadCount: number; lastMessage: Message | undefined }> {
  const participantIds = participantIdsForLookup(ownerId, ownerType);
  const unreadRows = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.messages)
    .where(
      and(
        inArray(schema.project.messages.toId, participantIds),
        eq(schema.project.messages.toType, ownerType),
        eq(schema.project.messages.read, 0),
      ),
    );
  const unreadCount = unreadRows[0]?.count ?? 0;
  const lastRows = await handle
    .select(messageColumns)
    .from(schema.project.messages)
    .where(
      and(
        inArray(schema.project.messages.toId, participantIds),
        eq(schema.project.messages.toType, ownerType),
      ),
    )
    .orderBy(desc(schema.project.messages.createdAt), desc(schema.project.messages.id))
    .limit(1);
  return {
    ownerId,
    ownerType,
    unreadCount,
    lastMessage: lastRows[0] ? rowToMessage(lastRows[0] as MessageRow) : undefined,
  };
}

/**
 * Get all agent-to-agent messages (newest first).
 */
export async function getAllAgentToAgentMessages(handle: QueryHandle): Promise<Message[]> {
  const rows = await handle
    .select(messageColumns)
    .from(schema.project.messages)
    .where(eq(schema.project.messages.type, "agent-to-agent"))
    .orderBy(desc(schema.project.messages.createdAt), desc(schema.project.messages.id));
  return rows.map((row) => rowToMessage(row as MessageRow));
}

/**
 * Count unread agent-to-agent messages.
 */
export async function getUnreadAgentToAgentCount(handle: QueryHandle): Promise<number> {
  const rows = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.messages)
    .where(
      and(
        eq(schema.project.messages.type, "agent-to-agent"),
        eq(schema.project.messages.read, 0),
      ),
    );
  return rows[0]?.count ?? 0;
}
