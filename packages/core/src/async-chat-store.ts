/**
 * Async Drizzle ChatStore helpers (U6 satellite-db-injected-stores).
 *
 * FNXC:ChatStore 2026-06-24-09:00:
 * Async equivalents of the sync SQLite ChatStore call sites in chat-store.ts.
 * These helpers target the PostgreSQL `project.chat_sessions`,
 * `project.chat_messages`, `project.chat_rooms`, `project.chat_room_members`,
 * and `project.chat_room_messages` tables via Drizzle.
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   The JSON columns (inFlightGeneration, metadata, attachments, mentions)
 *   are jsonb in PostgreSQL, so Drizzle returns them already-parsed.
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   flip. These helpers are the async target the PostgreSQL integration tests
 *   consume.
 */
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lte, ne, or as orFn, sql as drizzleSql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import type {
  ChatAttachment,
  ChatInFlightGenerationState,
  ChatMessage,
  ChatMessageRole,
  ChatRoom,
  ChatRoomMember,
  ChatRoomMessage,
  ChatRoomStatus,
  ChatSession,
  ChatSessionStatus,
  RoomMemberRole,
} from "./chat-types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

// ── Row → Entity converters ──

function rowToSession(row: Record<string, unknown>): ChatSession {
  return {
    id: row.id as string,
    agentId: row.agentId as string,
    title: (row.title as string | null) ?? null,
    status: row.status as ChatSessionStatus,
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: the domain projectId now maps to owner_project_id; project_id is the trigger/GUC-owned RLS partition (migration 0011).
    projectId: (row.ownerProjectId as string | null) ?? null,
    modelProvider: (row.modelProvider as string | null) ?? null,
    modelId: (row.modelId as string | null) ?? null,
    thinkingLevel: (row.thinkingLevel as string | null) ?? null,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
    cliSessionFile: (row.cliSessionFile as string | null) ?? null,
    inFlightGeneration: (row.inFlightGeneration as ChatInFlightGenerationState | null) ?? null,
    cliExecutorAdapterId: (row.cliExecutorAdapterId as string | null) ?? null,
  };
}

function rowToMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row.id as string,
    sessionId: row.sessionId as string,
    role: row.role as ChatMessageRole,
    content: row.content as string,
    thinkingOutput: (row.thinkingOutput as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    attachments: (row.attachments as ChatAttachment[] | null) ?? undefined,
    createdAt: row.createdAt as string,
  };
}

function rowToRoom(row: Record<string, unknown>): ChatRoom {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    description: (row.description as string | null) ?? null,
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain projectId reads from owner_project_id (see rowToSession).
    projectId: (row.ownerProjectId as string | null) ?? null,
    createdBy: (row.createdBy as string | null) ?? null,
    status: row.status as ChatRoomStatus,
    // FNXC:Chat-ThinkingLevel 2026-07-13 (merge port): room-level reasoning-effort default.
    thinkingLevel: (row.thinkingLevel as ChatRoom["thinkingLevel"] | null) ?? null,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function rowToRoomMember(row: Record<string, unknown>): ChatRoomMember {
  return {
    roomId: row.roomId as string,
    agentId: row.agentId as string,
    role: row.role as RoomMemberRole,
    addedAt: row.addedAt as string,
  };
}

function rowToRoomMessage(row: Record<string, unknown>): ChatRoomMessage {
  return {
    id: row.id as string,
    roomId: row.roomId as string,
    role: row.role as ChatMessageRole,
    content: row.content as string,
    thinkingOutput: (row.thinkingOutput as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    attachments: (row.attachments as ChatAttachment[] | null) ?? undefined,
    senderAgentId: (row.senderAgentId as string | null) ?? null,
    mentions: (row.mentions as string[]) ?? [],
    createdAt: row.createdAt as string,
  };
}

// ── Session CRUD ──

/**
 * Create a chat session.
 */
export async function createChatSession(handle: QueryHandle, session: ChatSession): Promise<ChatSession> {
  await handle.insert(schema.project.chatSessions).values({
    id: session.id,
    agentId: session.agentId,
    title: session.title,
    status: session.status,
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: write the caller's domain project to owner_project_id and never project_id — the trigger/GUC owns the partition.
    ownerProjectId: session.projectId,
    modelProvider: session.modelProvider,
    modelId: session.modelId,
    thinkingLevel: session.thinkingLevel ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cliSessionFile: session.cliSessionFile,
    inFlightGeneration: session.inFlightGeneration,
    cliExecutorAdapterId: session.cliExecutorAdapterId,
  });
  return session;
}

/**
 * Get a chat session by id.
 */
export async function getChatSession(handle: QueryHandle, id: string): Promise<ChatSession | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.chatSessions)
    .where(eq(schema.project.chatSessions.id, id));
  return rows[0] ? rowToSession(rows[0]) : undefined;
}

/**
 * FNXC:ChatStore 2026-06-24-09:05:
 * List chat sessions with optional filtering, ordered by updatedAt DESC.
 */
export async function listChatSessions(
  handle: QueryHandle,
  options?: { projectId?: string; agentId?: string; status?: ChatSessionStatus },
): Promise<ChatSession[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options?.projectId) conditions.push(eq(schema.project.chatSessions.ownerProjectId, options.projectId));
  if (options?.agentId) conditions.push(eq(schema.project.chatSessions.agentId, options.agentId));
  if (options?.status) conditions.push(eq(schema.project.chatSessions.status, options.status));
  const query = handle
    .select()
    .from(schema.project.chatSessions)
    .orderBy(desc(schema.project.chatSessions.updatedAt));
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return rows.map(rowToSession);
}

/**
 * Delete a chat session by id. Returns true if a row was deleted.
 */
export async function deleteChatSession(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.chatSessions)
    .where(eq(schema.project.chatSessions.id, id))
    .returning({ id: schema.project.chatSessions.id });
  return result.length > 0;
}

// ── Message CRUD ──

/**
 * FNXC:ChatStore 2026-06-24-09:10:
 * Add a message to a chat session and bump the session's updatedAt.
 */
export async function addChatMessage(
  handle: QueryHandle,
  message: ChatMessage,
): Promise<ChatMessage> {
  await handle.insert(schema.project.chatMessages).values({
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    thinkingOutput: message.thinkingOutput,
    metadata: message.metadata,
    attachments: message.attachments ?? null,
    createdAt: message.createdAt,
  });
  await handle
    .update(schema.project.chatSessions)
    .set({ updatedAt: message.createdAt })
    .where(eq(schema.project.chatSessions.id, message.sessionId));
  return message;
}

/**
 * Get a chat message by id.
 */
export async function getChatMessage(handle: QueryHandle, id: string): Promise<ChatMessage | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.chatMessages)
    .where(eq(schema.project.chatMessages.id, id));
  return rows[0] ? rowToMessage(rows[0]) : undefined;
}

/**
 * Get messages for a chat session with optional filtering.
 */
export async function getChatMessages(
  handle: QueryHandle,
  sessionId: string,
  filter?: { limit?: number; offset?: number; before?: string; order?: "asc" | "desc" },
): Promise<ChatMessage[]> {
  const conditions: ReturnType<typeof eq>[] = [eq(schema.project.chatMessages.sessionId, sessionId)];
  if (filter?.before) {
    conditions.push(lte(schema.project.chatMessages.createdAt, filter.before));
  }
  const limit = filter?.limit ?? 100;
  const offset = filter?.offset ?? 0;
  const orderCol = schema.project.chatMessages.createdAt;
  const rows = await handle
    .select()
    .from(schema.project.chatMessages)
    .where(and(...conditions))
    .orderBy(filter?.order === "desc" ? desc(orderCol) : asc(orderCol))
    .limit(limit)
    .offset(offset);
  return rows.map(rowToMessage);
}

/**
 * FNXC:ChatStore 2026-06-24-09:15:
 * Get the latest message for each session in the provided list.
 */
export async function getLastMessageForSessions(
  handle: QueryHandle,
  sessionIds: string[],
): Promise<Map<string, ChatMessage>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await handle
    .select()
    .from(schema.project.chatMessages)
    .where(inArray(schema.project.chatMessages.sessionId, sessionIds))
    .orderBy(
      desc(schema.project.chatMessages.createdAt),
      desc(schema.project.chatMessages.id),
    );
  const result = new Map<string, ChatMessage>();
  for (const row of rows) {
    const msg = rowToMessage(row);
    if (!result.has(msg.sessionId)) {
      result.set(msg.sessionId, msg);
    }
  }
  return result;
}

// ── Room CRUD ──

/**
 * FNXC:ChatStore 2026-06-24-09:20:
 * Create a chat room + initial members atomically inside a transaction.
 */
export async function createChatRoom(
  layer: AsyncDataLayer,
  room: ChatRoom,
  memberAgentIds: string[],
): Promise<{ room: ChatRoom; members: ChatRoomMember[] }> {
  const now = room.createdAt;
  await layer.transactionImmediate(async (tx) => {
    await tx.insert(schema.project.chatRooms).values({
      id: room.id,
      name: room.name,
      slug: room.slug,
      description: room.description,
      ownerProjectId: room.projectId,
      createdBy: room.createdBy,
      status: room.status,
      thinkingLevel: room.thinkingLevel ?? null,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    });
    for (const agentId of memberAgentIds) {
      const role: RoomMemberRole = room.createdBy !== null && agentId === room.createdBy ? "owner" : "member";
      await tx.insert(schema.project.chatRoomMembers).values({
        roomId: room.id,
        agentId,
        role,
        addedAt: now,
      });
    }
  });
  const members = await listChatRoomMembers(layer.db, room.id);
  return { room, members };
}

/**
 * Get a chat room by id.
 */
export async function getChatRoom(handle: QueryHandle, id: string): Promise<ChatRoom | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.chatRooms)
    .where(eq(schema.project.chatRooms.id, id));
  return rows[0] ? rowToRoom(rows[0]) : undefined;
}

/**
 * Get a chat room by (projectId, slug).
 */
export async function getChatRoomBySlug(
  handle: QueryHandle,
  projectId: string | null,
  slug: string,
): Promise<ChatRoom | undefined> {
  const conditions = [eq(schema.project.chatRooms.slug, slug)];
  if (projectId !== null) {
    conditions.push(eq(schema.project.chatRooms.ownerProjectId, projectId));
  } else {
    conditions.push(isNull(schema.project.chatRooms.ownerProjectId));
  }
  const rows = await handle
    .select()
    .from(schema.project.chatRooms)
    .where(and(...conditions));
  return rows[0] ? rowToRoom(rows[0]) : undefined;
}

/**
 * List chat rooms with optional filtering, ordered by updatedAt DESC.
 */
export async function listChatRooms(
  handle: QueryHandle,
  options?: { projectId?: string; status?: ChatRoomStatus },
): Promise<ChatRoom[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options?.projectId) conditions.push(eq(schema.project.chatRooms.ownerProjectId, options.projectId));
  if (options?.status) conditions.push(eq(schema.project.chatRooms.status, options.status));
  const query = handle
    .select()
    .from(schema.project.chatRooms)
    .orderBy(desc(schema.project.chatRooms.updatedAt));
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return rows.map(rowToRoom);
}

/**
 * Delete a chat room by id. Returns true if a row was deleted.
 */
export async function deleteChatRoom(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.chatRooms)
    .where(eq(schema.project.chatRooms.id, id))
    .returning({ id: schema.project.chatRooms.id });
  return result.length > 0;
}

// ── Room Member CRUD ──

/**
 * FNXC:ChatStore 2026-06-24-09:25:
 * Add a room member. Uses ON CONFLICT DO NOTHING to match the sync
 * INSERT OR IGNORE behavior.
 */
export async function addChatRoomMember(
  handle: QueryHandle,
  roomId: string,
  agentId: string,
  role: RoomMemberRole,
  addedAt: string,
): Promise<void> {
  await handle
    .insert(schema.project.chatRoomMembers)
    .values({ roomId, agentId, role, addedAt })
    .onConflictDoNothing();
}

/**
 * Remove a room member. Returns true if a row was deleted.
 */
export async function removeChatRoomMember(
  handle: QueryHandle,
  roomId: string,
  agentId: string,
): Promise<boolean> {
  const result = await handle
    .delete(schema.project.chatRoomMembers)
    .where(
      and(
        eq(schema.project.chatRoomMembers.roomId, roomId),
        eq(schema.project.chatRoomMembers.agentId, agentId),
      ),
    )
    .returning({ roomId: schema.project.chatRoomMembers.roomId });
  return result.length > 0;
}

/**
 * List room members ordered by addedAt ASC.
 */
export async function listChatRoomMembers(handle: QueryHandle, roomId: string): Promise<ChatRoomMember[]> {
  const rows = await handle
    .select()
    .from(schema.project.chatRoomMembers)
    .where(eq(schema.project.chatRoomMembers.roomId, roomId))
    .orderBy(asc(schema.project.chatRoomMembers.addedAt));
  return rows.map(rowToRoomMember);
}

// ── Room Message CRUD ──

/**
 * FNXC:ChatStore 2026-06-24-09:30:
 * Add a room message and bump the room's updatedAt.
 */
export async function addChatRoomMessage(
  handle: QueryHandle,
  message: ChatRoomMessage,
): Promise<ChatRoomMessage> {
  await handle.insert(schema.project.chatRoomMessages).values({
    id: message.id,
    roomId: message.roomId,
    role: message.role,
    content: message.content,
    thinkingOutput: message.thinkingOutput,
    metadata: message.metadata,
    attachments: message.attachments ?? null,
    senderAgentId: message.senderAgentId,
    mentions: message.mentions,
    createdAt: message.createdAt,
  });
  await handle
    .update(schema.project.chatRooms)
    .set({ updatedAt: message.createdAt })
    .where(eq(schema.project.chatRooms.id, message.roomId));
  return message;
}

/**
 * Get a room message by id.
 */
export async function getChatRoomMessage(handle: QueryHandle, id: string): Promise<ChatRoomMessage | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.chatRoomMessages)
    .where(eq(schema.project.chatRoomMessages.id, id));
  return rows[0] ? rowToRoomMessage(rows[0]) : undefined;
}

/**
 * Get room messages with optional filtering.
 */
export async function getChatRoomMessages(
  handle: QueryHandle,
  roomId: string,
  filter?: { limit?: number; offset?: number; before?: string; order?: "asc" | "desc" },
): Promise<ChatRoomMessage[]> {
  const conditions: ReturnType<typeof eq>[] = [eq(schema.project.chatRoomMessages.roomId, roomId)];
  if (filter?.before) {
    conditions.push(lte(schema.project.chatRoomMessages.createdAt, filter.before));
  }
  const limit = filter?.limit ?? 100;
  const offset = filter?.offset ?? 0;
  const orderCol = schema.project.chatRoomMessages.createdAt;
  const rows = await handle
    .select()
    .from(schema.project.chatRoomMessages)
    .where(and(...conditions))
    .orderBy(filter?.order === "desc" ? desc(orderCol) : asc(orderCol))
    .limit(limit)
    .offset(offset);
  return rows.map(rowToRoomMessage);
}

/**
 * FNXC:ChatStore 2026-06-24-09:35:
 * Clear all room messages. Returns the count of deleted messages.
 */
export async function clearChatRoomMessages(handle: QueryHandle, roomId: string): Promise<number> {
  const result = await handle
    .delete(schema.project.chatRoomMessages)
    .where(eq(schema.project.chatRoomMessages.roomId, roomId))
    .returning({ id: schema.project.chatRoomMessages.id });
  return result.length;
}

// ── FNXC:RuntimeSatelliteCompletion 2026-06-24-22:00:
// The following helpers complete the async ChatStore surface so every method
// that previously threw in backend mode now delegates to PostgreSQL via Drizzle.
// These mirror the sync SQLite semantics in chat-store.ts exactly. The matching
// backend-mode branches in chat-store.ts call these helpers instead of throwing.

/**
 * FNXC:ChatStore 2026-06-24-22:05:
 * Update a chat session's mutable fields (title, status, modelProvider,
 * modelId) and bump updatedAt. Returns the updated session, or undefined if
 * not found. Mirrors sync ChatStore.updateSession.
 */
export async function updateChatSession(
  handle: QueryHandle,
  id: string,
  input: {
    title?: string | null;
    status?: ChatSessionStatus;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
  },
): Promise<ChatSession | undefined> {
  const existing = await getChatSession(handle, id);
  if (!existing) return undefined;

  const now = new Date().toISOString();
  const setValues: Record<string, unknown> = { updatedAt: now };
  if (input.title !== undefined) setValues.title = input.title;
  if (input.status !== undefined) setValues.status = input.status;
  if (input.modelProvider !== undefined) setValues.modelProvider = input.modelProvider;
  if (input.modelId !== undefined) setValues.modelId = input.modelId;
  if (input.thinkingLevel !== undefined) setValues.thinkingLevel = input.thinkingLevel;

  await handle
    .update(schema.project.chatSessions)
    .set(setValues)
    .where(eq(schema.project.chatSessions.id, id));

  return getChatSession(handle, id);
}

/**
 * FNXC:ChatStore 2026-06-24-22:05:
 * Archive a chat session (sets status to "archived"). Returns the archived
 * session, or undefined if not found. Mirrors sync ChatStore.archiveSession.
 */
export async function archiveChatSession(
  handle: QueryHandle,
  id: string,
): Promise<ChatSession | undefined> {
  return updateChatSession(handle, id, { status: "archived" });
}

/**
 * FNXC:ChatStore 2026-06-24-22:10:
 * Set the CLI session file path for a chat session. Internal plumbing — does
 * not bump updatedAt or emit events. Mirrors sync ChatStore.setCliSessionFile.
 */
export async function setCliSessionFile(
  handle: QueryHandle,
  id: string,
  cliSessionFile: string | null,
): Promise<void> {
  await handle
    .update(schema.project.chatSessions)
    .set({ cliSessionFile })
    .where(eq(schema.project.chatSessions.id, id));
}

/**
 * FNXC:ChatStore 2026-06-24-22:10:
 * Set or clear the cli-agent adapter id for a chat session. Bumps updatedAt
 * and returns the updated session. Mirrors sync ChatStore.setCliExecutorAdapterId.
 */
export async function setCliExecutorAdapterId(
  handle: QueryHandle,
  id: string,
  adapterId: string | null,
): Promise<ChatSession | undefined> {
  const existing = await getChatSession(handle, id);
  if (!existing) return undefined;
  await handle
    .update(schema.project.chatSessions)
    .set({ cliExecutorAdapterId: adapterId, updatedAt: new Date().toISOString() })
    .where(eq(schema.project.chatSessions.id, id));
  return getChatSession(handle, id);
}

/**
 * FNXC:ChatStore 2026-06-24-22:15:
 * Set or clear the in-flight generation state for a chat session. Does not
 * bump updatedAt (the snapshot is transient UI state). Returns the updated
 * session. Mirrors sync ChatStore.setInFlightGeneration.
 */
export async function setInFlightGeneration(
  handle: QueryHandle,
  id: string,
  inFlightGeneration: ChatInFlightGenerationState | null,
): Promise<ChatSession | undefined> {
  const existing = await getChatSession(handle, id);
  if (!existing) return undefined;
  await handle
    .update(schema.project.chatSessions)
    .set({ inFlightGeneration })
    .where(eq(schema.project.chatSessions.id, id));
  return getChatSession(handle, id);
}

/**
 * FNXC:ChatStore 2026-06-24-22:20:
 * Append a file attachment metadata record to an existing message's
 * attachments jsonb array. Returns the updated message. Throws if the message
 * does not exist in the given session. Mirrors sync ChatStore.addMessageAttachment.
 */
export async function addChatMessageAttachment(
  handle: QueryHandle,
  sessionId: string,
  messageId: string,
  attachment: ChatAttachment,
): Promise<ChatMessage> {
  const message = await getChatMessage(handle, messageId);
  if (!message || message.sessionId !== sessionId) {
    throw new Error(`Message ${messageId} not found in session ${sessionId}`);
  }
  const updatedAttachments = [...(message.attachments ?? []), attachment];
  await handle
    .update(schema.project.chatMessages)
    .set({ attachments: updatedAttachments })
    .where(eq(schema.project.chatMessages.id, messageId));
  const updated = await getChatMessage(handle, messageId);
  if (!updated) throw new Error(`Failed to update message ${messageId}`);
  return updated;
}

/**
 * FNXC:ChatStore 2026-06-24-22:20:
 * Delete a chat message by id and bump the parent session's updatedAt.
 * Returns true if deleted, false if not found. Mirrors sync ChatStore.deleteMessage.
 */
export async function deleteChatMessage(
  handle: QueryHandle,
  id: string,
): Promise<boolean> {
  const existing = await getChatMessage(handle, id);
  if (!existing) return false;
  await handle.delete(schema.project.chatMessages).where(eq(schema.project.chatMessages.id, id));
  await handle
    .update(schema.project.chatSessions)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(schema.project.chatSessions.id, existing.sessionId));
  return true;
}

/**
 * FNXC:ChatSearch 2026-07-07-00:00:
 * Postgres counterpart of the sync ChatStore.searchSessionsByMessageContent (FN-7631 Chat
 * sidebar content search). Parameterized ILIKE with `%`/`_`/`\` escaped so literal wildcards
 * in the user's search text match literally (SQLite LIKE is ASCII case-insensitive, so ILIKE
 * preserves those semantics). One row per session: the most recent matching message wins,
 * tiebroken by id since Postgres has no rowid; preview truncated to ~100 chars.
 */
export async function searchChatSessionsByMessageContent(
  handle: QueryHandle,
  query: string,
  sessionIds: string[],
): Promise<Map<string, string>> {
  const trimmed = query.trim();
  if (!trimmed || sessionIds.length === 0) return new Map();
  const escaped = trimmed.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const rows = await handle
    .select()
    .from(schema.project.chatMessages)
    .where(and(
      inArray(schema.project.chatMessages.sessionId, sessionIds),
      ilike(schema.project.chatMessages.content, `%${escaped}%`),
    ))
    .orderBy(
      desc(schema.project.chatMessages.createdAt),
      desc(schema.project.chatMessages.id),
    );
  const result = new Map<string, string>();
  for (const row of rows) {
    const message = rowToMessage(row);
    if (result.has(message.sessionId)) continue;
    const content = message.content || "";
    result.set(message.sessionId, content.length > 100 ? content.slice(0, 100) + "…" : content);
  }
  return result;
}

/**
 * FNXC:ChatMessageEdit 2026-07-07-09:00:
 * Truncate a chat session from (and including) a target message onward — the Postgres
 * counterpart of the sync ChatStore.deleteMessagesFrom (FN-7628 edit/rewind). Postgres has
 * no rowid insertion-order tiebreaker, so ordering is (createdAt ASC, id ASC) — deterministic
 * and consistent with getLastMessageForSessions' (createdAt DESC, id DESC).
 * Returns deletedIds (ASC order) and retained pre-edit messages (ASC order).
 */
export async function deleteChatMessagesFrom(
  handle: QueryHandle,
  sessionId: string,
  fromMessageId: string,
): Promise<{ deletedIds: string[]; retained: ChatMessage[] }> {
  const orderedRows = await handle
    .select()
    .from(schema.project.chatMessages)
    .where(eq(schema.project.chatMessages.sessionId, sessionId))
    .orderBy(
      asc(schema.project.chatMessages.createdAt),
      asc(schema.project.chatMessages.id),
    );
  const ordered = orderedRows.map(rowToMessage);

  const target = await getChatMessage(handle, fromMessageId);
  if (!target || target.sessionId !== sessionId) {
    return { deletedIds: [], retained: ordered };
  }

  const targetIndex = ordered.findIndex((message) => message.id === fromMessageId);
  if (targetIndex === -1) {
    return { deletedIds: [], retained: ordered };
  }

  const retained = ordered.slice(0, targetIndex);
  const deletedIds = ordered.slice(targetIndex).map((message) => message.id);
  if (deletedIds.length === 0) {
    return { deletedIds: [], retained };
  }

  await handle
    .delete(schema.project.chatMessages)
    .where(inArray(schema.project.chatMessages.id, deletedIds));
  await handle
    .update(schema.project.chatSessions)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(schema.project.chatSessions.id, sessionId));

  return { deletedIds, retained };
}

/**
 * FNXC:ChatMessageEdit 2026-07-07-09:00:
 * Merge (default) or replace a persisted message's metadata — Postgres counterpart of the
 * sync ChatStore.updateMessageMetadata (FN-7628). Records e.g. `metadata.piParentLeafId`
 * on a user message so a later edit can rewind the pi session losslessly.
 */
export async function updateChatMessageMetadata(
  handle: QueryHandle,
  messageId: string,
  metadata: Record<string, unknown> | null,
  options?: { merge?: boolean },
): Promise<ChatMessage> {
  const existing = await getChatMessage(handle, messageId);
  if (!existing) {
    throw new Error(`Message ${messageId} not found`);
  }

  const merge = options?.merge !== false;
  const nextMetadata = metadata === null
    ? (merge ? existing.metadata : null)
    : (merge ? { ...(existing.metadata ?? {}), ...metadata } : metadata);

  await handle
    .update(schema.project.chatMessages)
    .set({ metadata: nextMetadata ?? null })
    .where(eq(schema.project.chatMessages.id, messageId));

  const updated = await getChatMessage(handle, messageId);
  if (!updated) {
    throw new Error(`Failed to update message ${messageId}`);
  }
  return updated;
}

/**
 * FNXC:ChatStore 2026-06-24-22:25:
 * Update a chat room's mutable fields (name, slug, description, status) and
 * bump updatedAt. Returns the updated room, or undefined if not found.
 * Mirrors sync ChatStore.updateRoom.
 */
export async function updateChatRoom(
  handle: QueryHandle,
  id: string,
  input: {
    name?: string;
    slug?: string;
    description?: string | null;
    status?: ChatRoomStatus;
    thinkingLevel?: ChatRoom["thinkingLevel"] | null;
  },
): Promise<ChatRoom | undefined> {
  const existing = await getChatRoom(handle, id);
  if (!existing) return undefined;

  const setValues: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) setValues.name = input.name;
  if (input.slug !== undefined) setValues.slug = input.slug;
  if (input.description !== undefined) setValues.description = input.description;
  if (input.status !== undefined) setValues.status = input.status;
  if (input.thinkingLevel !== undefined) setValues.thinkingLevel = input.thinkingLevel;

  await handle
    .update(schema.project.chatRooms)
    .set(setValues)
    .where(eq(schema.project.chatRooms.id, id));

  return getChatRoom(handle, id);
}

/**
 * FNXC:ChatStore 2026-06-24-22:30:
 * Delete stale chat sessions and rooms older than the cutoff timestamp.
 * Returns the count of deleted sessions and rooms. Mirrors sync
 * ChatStore.cleanupOldChats.
 */
export async function cleanupOldChats(
  handle: QueryHandle,
  maxAgeMs: number,
): Promise<{ sessionsDeleted: number; roomsDeleted: number; deletedSessionIds: string[]; deletedRoomIds: string[] }> {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return { sessionsDeleted: 0, roomsDeleted: 0, deletedSessionIds: [], deletedRoomIds: [] };
  }
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  const staleSessions = await handle
    .delete(schema.project.chatSessions)
    .where(lte(schema.project.chatSessions.updatedAt, cutoff))
    .returning({ id: schema.project.chatSessions.id });

  const staleRooms = await handle
    .delete(schema.project.chatRooms)
    .where(lte(schema.project.chatRooms.updatedAt, cutoff))
    .returning({ id: schema.project.chatRooms.id });

  return {
    sessionsDeleted: staleSessions.length,
    roomsDeleted: staleRooms.length,
    deletedSessionIds: staleSessions.map((r) => r.id),
    deletedRoomIds: staleRooms.map((r) => r.id),
  };
}

/**
 * FNXC:ChatStore 2026-06-24-22:30:
 * List rooms that a given agent is a member of, with optional project/status
 * filtering, ordered by room updatedAt DESC. Mirrors sync
 * ChatStore.listRoomsForAgent.
 */
export async function listChatRoomsForAgent(
  handle: QueryHandle,
  agentId: string,
  options?: { projectId?: string; status?: ChatRoomStatus },
): Promise<ChatRoom[]> {
  // Use a subquery to find room IDs where the agent is a member, then select
  // those rooms. This avoids the Drizzle join result-shape complexity.
  const memberRoomIds = handle
    .select({ roomId: schema.project.chatRoomMembers.roomId })
    .from(schema.project.chatRoomMembers)
    .where(eq(schema.project.chatRoomMembers.agentId, agentId));

  const conditions: ReturnType<typeof eq>[] = [inArray(schema.project.chatRooms.id, memberRoomIds)];
  if (options?.status) conditions.push(eq(schema.project.chatRooms.status, options.status));
  if (options?.projectId) conditions.push(eq(schema.project.chatRooms.ownerProjectId, options.projectId));

  const rows = await handle
    .select()
    .from(schema.project.chatRooms)
    .where(and(...conditions))
    .orderBy(desc(schema.project.chatRooms.updatedAt));
  return rows.map(rowToRoom);
}

/**
 * FNXC:ChatStore 2026-06-24-22:35:
 * List room messages created after a given timestamp, optionally excluding
 * messages from a specific sender. Ordered by createdAt ASC. Mirrors sync
 * ChatStore.listRoomMessagesSince.
 */
export async function listChatRoomMessagesSince(
  handle: QueryHandle,
  roomId: string,
  sinceIso: string,
  options?: { excludeSenderAgentId?: string; limit?: number },
): Promise<ChatRoomMessage[]> {
  const conditions: ReturnType<typeof eq>[] = [
    eq(schema.project.chatRoomMessages.roomId, roomId),
    gt(schema.project.chatRoomMessages.createdAt, sinceIso),
  ];
  if (options?.excludeSenderAgentId) {
    // (senderAgentId IS NULL OR senderAgentId != ?)
    conditions.push(
      orFn(
        isNull(schema.project.chatRoomMessages.senderAgentId),
        ne(schema.project.chatRoomMessages.senderAgentId, options.excludeSenderAgentId),
      )!,
    );
  }
  const rows = await handle
    .select()
    .from(schema.project.chatRoomMessages)
    .where(and(...conditions))
    .orderBy(asc(schema.project.chatRoomMessages.createdAt))
    .limit(options?.limit ?? 50);
  return rows.map(rowToRoomMessage);
}

/**
 * FNXC:ChatStore 2026-06-24-22:35:
 * Delete a room message by id and bump the parent room's updatedAt.
 * Returns true if deleted, false if not found. Mirrors sync
 * ChatStore.deleteRoomMessage.
 */
export async function deleteChatRoomMessage(
  handle: QueryHandle,
  id: string,
): Promise<boolean> {
  const existing = await getChatRoomMessage(handle, id);
  if (!existing) return false;
  await handle.delete(schema.project.chatRoomMessages).where(eq(schema.project.chatRoomMessages.id, id));
  await handle
    .update(schema.project.chatRooms)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(schema.project.chatRooms.id, existing.roomId));
  return true;
}

/**
 * FNXC:ChatStore 2026-06-24-22:40:
 * Append a file attachment to an existing room message's attachments jsonb
 * array. Bumps the room's updatedAt. Returns the updated message. Throws if
 * the message does not exist in the given room. Mirrors sync
 * ChatStore.addRoomMessageAttachment.
 */
export async function addChatRoomMessageAttachment(
  handle: QueryHandle,
  roomId: string,
  messageId: string,
  attachment: ChatAttachment,
): Promise<ChatRoomMessage> {
  const message = await getChatRoomMessage(handle, messageId);
  if (!message || message.roomId !== roomId) {
    throw new Error(`Message ${messageId} not found in room ${roomId}`);
  }
  const updatedAttachments = [...(message.attachments ?? []), attachment];
  await handle
    .update(schema.project.chatRoomMessages)
    .set({ attachments: updatedAttachments })
    .where(eq(schema.project.chatRoomMessages.id, messageId));
  await handle
    .update(schema.project.chatRooms)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(schema.project.chatRooms.id, roomId));
  const updated = await getChatRoomMessage(handle, messageId);
  if (!updated) throw new Error(`Failed to update room message ${messageId}`);
  return updated;
}

/**
 * FNXC:ChatStore 2026-06-24-22:45:
 * Find the newest active session for a specific quick-chat target.
 * Matching semantics mirror the sync path:
 *   - model target (modelProvider + modelId): exact agent+model match
 *   - agent target (no model): prefer model-less sessions, then newest agent
 *     session fallback.
 * Returns undefined if no match or the agentId is empty.
 * Mirrors sync ChatStore.findLatestActiveSessionForTarget.
 */
export async function findLatestActiveChatSessionForTarget(
  handle: QueryHandle,
  options: {
    agentId: string;
    projectId?: string;
    modelProvider?: string;
    modelId?: string;
  },
): Promise<ChatSession | undefined> {
  const normalizedAgentId = options.agentId.trim();
  if (!normalizedAgentId) return undefined;

  const normalizedProvider = options.modelProvider?.trim();
  const normalizedModelId = options.modelId?.trim();

  if ((normalizedProvider && !normalizedModelId) || (!normalizedProvider && normalizedModelId)) {
    throw new Error("modelProvider and modelId must both be provided together, or neither");
  }

  const baseConditions: ReturnType<typeof eq>[] = [
    eq(schema.project.chatSessions.status, "active"),
    eq(schema.project.chatSessions.agentId, normalizedAgentId),
  ];
  if (options.projectId && options.projectId.trim()) {
    baseConditions.push(eq(schema.project.chatSessions.ownerProjectId, options.projectId.trim()));
  }

  // Model-targeted: exact provider+model match.
  if (normalizedProvider && normalizedModelId) {
    const rows = await handle
      .select()
      .from(schema.project.chatSessions)
      .where(
        and(
          ...baseConditions,
          eq(schema.project.chatSessions.modelProvider, normalizedProvider),
          eq(schema.project.chatSessions.modelId, normalizedModelId),
        ),
      )
      .orderBy(desc(schema.project.chatSessions.updatedAt))
      .limit(1);
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  // Agent target: prefer model-less sessions first.
  const modelLessRows = await handle
    .select()
    .from(schema.project.chatSessions)
    .where(
      and(
        ...baseConditions,
        drizzleSql`COALESCE(TRIM(${schema.project.chatSessions.modelProvider}), '') = ''`,
        drizzleSql`COALESCE(TRIM(${schema.project.chatSessions.modelId}), '') = ''`,
      ),
    )
    .orderBy(desc(schema.project.chatSessions.updatedAt))
    .limit(1);
  if (modelLessRows[0]) return rowToSession(modelLessRows[0]);

  // Fallback: any active session for this agent.
  const fallbackRows = await handle
    .select()
    .from(schema.project.chatSessions)
    .where(and(...baseConditions))
    .orderBy(desc(schema.project.chatSessions.updatedAt))
    .limit(1);
  return fallbackRows[0] ? rowToSession(fallbackRows[0]) : undefined;
}
