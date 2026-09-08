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
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, exists, gt, ilike, inArray, isNotNull, isNull, lt, lte, ne, notLike, or as orFn, sql as drizzleSql, type SQL } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { projectScopeFor, type AsyncDataLayer, type DbTransaction } from "../postgres/data-layer.js";
import { sanitizeTextValue, sanitizeJsonbValue } from "../postgres/nul-sanitize.js";
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
  ChatSessionLastMessage,
  ChatSessionCursor,
  ChatSessionPage,
  ChatSessionStatus,
  ChatTag,
  ChatTagCreateInput,
  ChatTagUpdateInput,
  RoomMemberRole,
} from "../chat/chat-types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

// ── Row → Entity converters ──

function rowToTag(row: Record<string, unknown>): ChatTag {
  return { id: row.id as string, projectId: (row.ownerProjectId as string) === "__default__" ? null : row.ownerProjectId as string, name: row.name as string, createdAt: row.createdAt as string, updatedAt: row.updatedAt as string };
}

function rowToSession(row: Record<string, unknown>): ChatSession {
  return {
    id: row.id as string,
    tags: [],
    agentId: row.agentId as string,
    title: (row.title as string | null) ?? null,
    status: row.status as ChatSessionStatus,
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: the domain projectId now maps to owner_project_id; project_id is the trigger/GUC-owned RLS partition (migration 0011).
    projectId: (row.ownerProjectId as string | null) ?? null,
    modelProvider: (row.modelProvider as string | null) ?? null,
    modelId: (row.modelId as string | null) ?? null,
    thinkingLevel: (row.thinkingLevel as string | null) ?? null,
    memoryFocus: (row.memoryFocus as string | null) ?? null,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
    pinnedAt: (row.pinnedAt as string | null) ?? null,
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

/*
FNXC:ChatProjectIsolation 2026-08-12-14:16:
Messages and their parent sessions must resolve within the same bound partition.
A message-only predicate is insufficient when session IDs collide across projects;
unbound handles deliberately keep their existing cross-project behavior.
*/
function chatMessageProjectConditions(handle: QueryHandle, projectId?: string) {
  const messageScope = projectScopeFor(schema.project.chatMessages.projectId, projectId);
  const sessionScope = projectScopeFor(schema.project.chatSessions.projectId, projectId);
  if (!messageScope || !sessionScope) return [];
  return [
    messageScope,
    exists(handle.select({ id: schema.project.chatSessions.id })
      .from(schema.project.chatSessions)
      .where(and(
        eq(schema.project.chatSessions.id, schema.project.chatMessages.sessionId),
        sessionScope,
      ))),
  ];
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
  /*
  FNXC:ChatPersistence 2026-08-05-01:54:
  Chat snapshot fields may include arbitrary model and tool text. PostgreSQL
  rejects U+0000 anywhere in jsonb, so strip it only at this persistence
  boundary and return the same sanitized shape that is stored.
  */
  const sanitized: ChatSession = {
    ...session,
    inFlightGeneration: sanitizeJsonbValue(session.inFlightGeneration),
  };
  await handle.insert(schema.project.chatSessions).values({
    id: sanitized.id,
    agentId: sanitized.agentId,
    title: sanitized.title,
    status: sanitized.status,
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: write the caller's domain project to owner_project_id and never project_id — the trigger/GUC owns the partition.
    ownerProjectId: sanitized.projectId,
    modelProvider: sanitized.modelProvider,
    modelId: sanitized.modelId,
    thinkingLevel: sanitized.thinkingLevel ?? null,
    memoryFocus: sanitized.memoryFocus ?? null,
    createdAt: sanitized.createdAt,
    updatedAt: sanitized.updatedAt,
    pinnedAt: sanitized.pinnedAt,
    cliSessionFile: sanitized.cliSessionFile,
    inFlightGeneration: sanitized.inFlightGeneration,
    cliExecutorAdapterId: sanitized.cliExecutorAdapterId,
  });
  return sanitized;
}

/**
 * Get a chat session by id.
 */
export async function getChatSession(handle: QueryHandle, id: string): Promise<ChatSession | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.chatSessions)
    .where(eq(schema.project.chatSessions.id, id));
  return rows[0] ? attachTags(handle, rowToSession(rows[0])) : undefined;
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
    .orderBy(desc(schema.project.chatSessions.updatedAt), desc(schema.project.chatSessions.id));
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return attachTagsToSessions(handle, rows.map(rowToSession));
}

export function encodeChatSessionCursor(cursor: ChatSessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeChatSessionCursor(value: string): ChatSessionCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Invalid chat session cursor");
  }
  const cursor = parsed as Partial<ChatSessionCursor> | null;
  if (!cursor || (cursor.pinnedAt !== null && typeof cursor.pinnedAt !== "string") || typeof cursor.updatedAt !== "string" || typeof cursor.id !== "string" || !cursor.id || Number.isNaN(Date.parse(cursor.updatedAt)) || (cursor.pinnedAt !== null && Number.isNaN(Date.parse(cursor.pinnedAt)))) {
    throw new TypeError("Invalid chat session cursor");
  }
  return cursor as ChatSessionCursor;
}

/*
FNXC:ChatSessionPagination 2026-09-07-16:03:
Session lists filter before LIMIT, order pins and recency with an ID tie-breaker, and enrich tags only for the returned page. The opaque tuple cursor is exclusive, so equal timestamps and concurrent inserts cannot duplicate or skip the older continuation.
*/
export async function listChatSessionsPage(
  handle: QueryHandle,
  options: { projectId?: string; agentId?: string; status?: ChatSessionStatus; q?: string; tagId?: string; includeTaskPlanner?: boolean; limit?: number; cursor?: string } = {},
): Promise<ChatSessionPage> {
  const sessions = schema.project.chatSessions;
  const messages = schema.project.chatMessages;
  const sessionTags = schema.project.chatSessionTags;
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50) || 50));
  const cursor = options.cursor ? decodeChatSessionCursor(options.cursor) : undefined;
  const conditions: SQL[] = [];
  if (options.projectId) conditions.push(eq(sessions.ownerProjectId, options.projectId));
  if (options.agentId) conditions.push(eq(sessions.agentId, options.agentId));
  if (options.status) conditions.push(eq(sessions.status, options.status));
  if (options.includeTaskPlanner === false) conditions.push(notLike(sessions.agentId, "task-planner:%"));
  else if (options.includeTaskPlanner === true) conditions.push(orFn(
    notLike(sessions.agentId, "task-planner:%"),
    exists(handle.select({ one: drizzleSql`1` }).from(messages).where(and(eq(messages.sessionId, sessions.id), eq(messages.projectId, sessions.projectId)))),
  )!);
  if (options.q?.trim()) {
    const pattern = `%${options.q.trim()}%`;
    conditions.push(orFn(
      ilike(sessions.title, pattern),
      ilike(sessions.agentId, pattern),
      exists(handle.select({ one: drizzleSql`1` }).from(messages).where(and(eq(messages.sessionId, sessions.id), eq(messages.projectId, sessions.projectId), ilike(messages.content, pattern)))),
    )!);
  }
  if (options.tagId) {
    conditions.push(exists(handle.select({ one: drizzleSql`1` }).from(sessionTags).where(and(eq(sessionTags.sessionId, sessions.id), eq(sessionTags.projectId, sessions.projectId), eq(sessionTags.tagId, options.tagId)))));
  }
  if (cursor) {
    const olderUpdatedAt = orFn(
      lt(sessions.updatedAt, cursor.updatedAt),
      and(eq(sessions.updatedAt, cursor.updatedAt), lt(sessions.id, cursor.id)),
    );
    const olderUnpinned = and(isNull(sessions.pinnedAt), olderUpdatedAt)!;
    if (cursor.pinnedAt === null) {
      conditions.push(olderUnpinned);
    } else {
      const olderPinnedAt = orFn(
        lt(sessions.pinnedAt, cursor.pinnedAt),
        and(eq(sessions.pinnedAt, cursor.pinnedAt), olderUpdatedAt),
      );
      conditions.push(orFn(and(isNotNull(sessions.pinnedAt), olderPinnedAt), isNull(sessions.pinnedAt))!);
    }
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const totalConditions = conditions.slice(0, cursor ? -1 : undefined);
  const totalWhere = totalConditions.length > 0 ? and(...totalConditions) : undefined;
  const rowsQuery = handle.select().from(sessions).orderBy(drizzleSql`${sessions.pinnedAt} DESC NULLS LAST`, desc(sessions.updatedAt), desc(sessions.id)).limit(limit + 1);
  const countQuery = handle.select({ count: drizzleSql<number>`count(*)::int` }).from(sessions);
  const [rows, countRows] = await Promise.all([
    where ? rowsQuery.where(where) : rowsQuery,
    totalWhere ? countQuery.where(totalWhere) : countQuery,
  ]);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const pageSessions = await attachTagsToSessions(handle, pageRows.map(rowToSession));
  const last = pageSessions.at(-1);
  return {
    sessions: pageSessions,
    total: countRows[0]?.count ?? 0,
    hasMore,
    nextCursor: hasMore && last ? encodeChatSessionCursor({ pinnedAt: last.pinnedAt, updatedAt: last.updatedAt, id: last.id }) : null,
  };
}

/**
 * Delete a chat session by id. Returns true if a row was deleted.
 */
export async function deleteChatSession(handle: QueryHandle, id: string): Promise<boolean> {
  const [session] = await handle.select({ projectId: schema.project.chatSessions.projectId })
    .from(schema.project.chatSessions).where(eq(schema.project.chatSessions.id, id));
  if (!session) return false;
  const sessionProjectId = session.projectId;
  if (!sessionProjectId) throw new Error("Chat session is missing its required project partition");
  // FNXC:ChatTags 2026-08-05-12:15: cleanup retains the session's RLS partition even for bypass/admin handles; an unqualified ID could delete another project's assignment.
  await handle.delete(schema.project.chatSessionTags).where(and(
    eq(schema.project.chatSessionTags.sessionId, id),
    eq(schema.project.chatSessionTags.projectId, sessionProjectId),
  ));
  const result = await handle
    .delete(schema.project.chatSessions)
    .where(and(eq(schema.project.chatSessions.id, id), eq(schema.project.chatSessions.projectId, sessionProjectId)))
    .returning({ id: schema.project.chatSessions.id });
  return result.length > 0;
}

function tagScope(projectId: string | null | undefined): string { return projectId ?? "__default__"; }
function normalizeTagName(name: string): { name: string; normalizedName: string } {
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > 64) throw new Error("Tag name must be between 1 and 64 characters");
  return { name: cleaned, normalizedName: cleaned.toLocaleLowerCase() };
}

async function attachTags(handle: QueryHandle, session: ChatSession): Promise<ChatSession> {
  const [attached] = await attachTagsToSessions(handle, [session]);
  return attached ?? session;
}

async function attachTagsToSessions(handle: QueryHandle, sessions: ChatSession[]): Promise<ChatSession[]> {
  if (!sessions.length) return sessions;
  const rows = await handle.select({ sessionId: schema.project.chatSessionTags.sessionId, id: schema.project.chatTags.id, ownerProjectId: schema.project.chatTags.ownerProjectId, name: schema.project.chatTags.name, createdAt: schema.project.chatTags.createdAt, updatedAt: schema.project.chatTags.updatedAt })
    .from(schema.project.chatSessionTags).innerJoin(schema.project.chatTags, and(
      eq(schema.project.chatSessionTags.tagId, schema.project.chatTags.id),
      eq(schema.project.chatSessionTags.projectId, schema.project.chatTags.projectId),
    ))
    .innerJoin(schema.project.chatSessions, and(
      eq(schema.project.chatSessionTags.sessionId, schema.project.chatSessions.id),
      eq(schema.project.chatSessionTags.projectId, schema.project.chatSessions.projectId),
    ))
    .where(inArray(schema.project.chatSessionTags.sessionId, sessions.map((session) => session.id))).orderBy(asc(schema.project.chatTags.normalizedName), asc(schema.project.chatTags.id));
  const tagsBySession = new Map<string, ChatTag[]>();
  for (const row of rows) { const tags = tagsBySession.get(row.sessionId) ?? []; tags.push(rowToTag(row)); tagsBySession.set(row.sessionId, tags); }
  return sessions.map((session) => ({ ...session, tags: tagsBySession.get(session.id) ?? [] }));
}

/** FNXC:ChatTags 2026-08-05-10:55: Tags normalize whitespace/case and are always read in deterministic name order. */
export async function listChatTags(handle: QueryHandle, projectId: string | null): Promise<ChatTag[]> {
  const rows = await handle.select().from(schema.project.chatTags).where(eq(schema.project.chatTags.ownerProjectId, tagScope(projectId))).orderBy(asc(schema.project.chatTags.normalizedName), asc(schema.project.chatTags.id));
  return rows.map(rowToTag);
}

export async function createChatTag(layer: AsyncDataLayer, input: ChatTagCreateInput): Promise<ChatTag> {
  const { name, normalizedName } = normalizeTagName(input.name); const projectId = input.projectId ?? null; const now = new Date().toISOString();
  return layer.transactionImmediate(async (tx) => {
    const id = `chat-tag-${randomUUID().slice(0, 8)}`;
    const rows = await tx.insert(schema.project.chatTags).values({ id, ownerProjectId: tagScope(projectId), name, normalizedName, createdAt: now, updatedAt: now }).onConflictDoNothing().returning();
    if (!rows[0]) throw new Error("A tag with that name already exists");
    return rowToTag(rows[0]);
  });
}

export async function renameChatTag(layer: AsyncDataLayer, id: string, projectId: string | null, input: ChatTagUpdateInput): Promise<ChatTag | undefined> {
  const { name, normalizedName } = normalizeTagName(input.name);
  return layer.transactionImmediate(async (tx) => { const rows = await tx.update(schema.project.chatTags).set({ name, normalizedName, updatedAt: new Date().toISOString() }).where(and(eq(schema.project.chatTags.id, id), eq(schema.project.chatTags.ownerProjectId, tagScope(projectId)))).returning(); if (!rows[0]) return undefined; return rowToTag(rows[0]); });
}

export async function deleteChatTag(layer: AsyncDataLayer, id: string, projectId: string | null): Promise<boolean> {
  return layer.transactionImmediate(async (tx) => {
    const [tag] = await tx.select({ projectId: schema.project.chatTags.projectId })
      .from(schema.project.chatTags)
      .where(and(eq(schema.project.chatTags.id, id), eq(schema.project.chatTags.ownerProjectId, tagScope(projectId))));
    if (!tag?.projectId) return false;
    const tagProjectId = tag.projectId;
    // FNXC:ChatTags 2026-08-05-12:15: validate the scoped parent before cleanup; bypass handles must not erase a same-ID tag assignment in another partition.
    await tx.delete(schema.project.chatSessionTags).where(and(
      eq(schema.project.chatSessionTags.tagId, id),
      eq(schema.project.chatSessionTags.projectId, tagProjectId),
    ));
    return (await tx.delete(schema.project.chatTags)
      .where(and(eq(schema.project.chatTags.id, id), eq(schema.project.chatTags.projectId, tagProjectId)))
      .returning({ id: schema.project.chatTags.id })).length > 0;
  });
}

export async function replaceChatSessionTags(layer: AsyncDataLayer, sessionId: string, projectId: string | null, tagIds: string[]): Promise<ChatSession | undefined> {
  return layer.transactionImmediate(async (tx) => {
    const session = await getChatSessionForUpdate(tx, sessionId); if (!session || session.projectId !== projectId) return undefined;
    const ownerProjectCondition = projectId === null
      ? isNull(schema.project.chatSessions.ownerProjectId)
      : eq(schema.project.chatSessions.ownerProjectId, projectId);
    const [sessionPartition] = await tx.select({ projectId: schema.project.chatSessions.projectId }).from(schema.project.chatSessions)
      .where(and(eq(schema.project.chatSessions.id, sessionId), ownerProjectCondition)).for("update");
    if (!sessionPartition?.projectId) return undefined;
    const sessionProjectId = sessionPartition.projectId;
    const uniqueIds = [...new Set(tagIds)];
    const tags = uniqueIds.length ? await tx.select().from(schema.project.chatTags).where(and(
      inArray(schema.project.chatTags.id, uniqueIds),
      eq(schema.project.chatTags.ownerProjectId, tagScope(projectId)),
      eq(schema.project.chatTags.projectId, sessionProjectId),
    )) : [];
    if (tags.length !== uniqueIds.length) throw new Error("One or more tags do not belong to this project");
    // FNXC:ChatTags 2026-08-05-12:15: replacements are scoped by the locked session partition, preserving project isolation when the DB bypass role is active.
    await tx.delete(schema.project.chatSessionTags).where(and(eq(schema.project.chatSessionTags.sessionId, sessionId), eq(schema.project.chatSessionTags.projectId, sessionProjectId)));
    if (uniqueIds.length) await tx.insert(schema.project.chatSessionTags).values(uniqueIds.map((tagId) => ({ projectId: sessionProjectId, sessionId, tagId, assignedAt: new Date().toISOString() }))).onConflictDoNothing();
    return attachTags(tx, session);
  });
}

// ── Message CRUD ──

/**
 * FNXC:ChatStore 2026-06-24-09:10:
 * Add a message to a chat session and bump the session's updatedAt.
 */
export async function addChatMessage(
  handle: QueryHandle,
  message: ChatMessage,
  projectId?: string,
): Promise<ChatMessage> {
  // FNXC:PostgresMigrationNulSanitize 2026-07-20: agent/tool output persisted
  // here can contain a raw NUL byte (e.g. piped-through Windows CLI dumps),
  // which Postgres text/jsonb columns reject outright. Sanitize before
  // insert instead of letting the write throw mid-conversation, and return
  // the sanitized value so the in-memory result matches what was persisted
  // (the original unsanitized `message` object must not be handed back).
  const sanitizedAttachments = message.attachments === undefined
    ? undefined
    : sanitizeJsonbValue(message.attachments);
  const sanitized: ChatMessage = {
    ...message,
    content: sanitizeTextValue(message.content),
    thinkingOutput: sanitizeTextValue(message.thinkingOutput),
    metadata: sanitizeJsonbValue(message.metadata),
    attachments: sanitizedAttachments,
  };
  await handle.insert(schema.project.chatMessages).values({
    id: sanitized.id,
    sessionId: sanitized.sessionId,
    role: sanitized.role,
    content: sanitized.content,
    thinkingOutput: sanitized.thinkingOutput,
    metadata: sanitized.metadata,
    attachments: sanitizedAttachments ?? null,
    createdAt: sanitized.createdAt,
  });
  await handle
    .update(schema.project.chatSessions)
    .set({ updatedAt: sanitized.createdAt })
    .where(and(
      eq(schema.project.chatSessions.id, sanitized.sessionId),
      projectScopeFor(schema.project.chatSessions.projectId, projectId),
    ));
  return sanitized;
}

/**
 * Get a chat message by id.
 */
export async function getChatMessage(
  handle: QueryHandle,
  id: string,
  projectId?: string,
): Promise<ChatMessage | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.chatMessages)
    .where(and(
      eq(schema.project.chatMessages.id, id),
      ...chatMessageProjectConditions(handle, projectId),
    ));
  return rows[0] ? rowToMessage(rows[0]) : undefined;
}

/**
 * Get messages for a chat session with optional filtering.
 */
export async function getChatMessages(
  handle: QueryHandle,
  sessionId: string,
  filter?: { limit?: number; offset?: number; before?: string; beforeId?: string; order?: "asc" | "desc" },
  projectId?: string,
): Promise<ChatMessage[]> {
  const conditions = [
    eq(schema.project.chatMessages.sessionId, sessionId),
    ...chatMessageProjectConditions(handle, projectId),
  ];
  if (filter?.before && filter.beforeId) {
    /*
    FNXC:ChatMessagePagination 2026-09-06-13:40:
    Direct and Planner Chat page newest-to-oldest. Their strict tuple cursor must match the total descending order so a page boundary inside a same-timestamp burst neither repeats nor skips rows; date-only callers retain the historical inclusive predicate.
    */
    conditions.push(orFn(
      lt(schema.project.chatMessages.createdAt, filter.before),
      and(
        eq(schema.project.chatMessages.createdAt, filter.before),
        lt(schema.project.chatMessages.id, filter.beforeId),
      ),
    )!);
  } else if (filter?.before) {
    conditions.push(lte(schema.project.chatMessages.createdAt, filter.before));
  }
  const limit = filter?.limit ?? 100;
  const offset = filter?.offset ?? 0;
  /*
  FNXC:ChatStashBackfillTiePagination 2026-08-21-17:25:
  (RUFU-146 review, PRRT_kwDOSA-8Y86bNP8U, Greptile P1) ORDER BY created_at
  alone is NON-UNIQUE — chat_messages.created_at is a text ISO timestamp and
  bursts (same-millisecond writes, imported/reconstructed history) share
  values. The Stash backfill route pages the full session history with
  limit/offset (register-chat-routes.ts POST /chat/sessions/:id/backfill-stash);
  when equal values straddle a page boundary, PostgreSQL's tie order is
  plan-dependent, so one tied row can be returned on BOTH pages while another
  is omitted entirely — the backfill then reports success with an incomplete
  or duplicated Stash transcript. Adding id (part of the primary key) makes
  the ordering a TOTAL order: every offset page is well-defined and stable
  across repeated reads, in both directions (the before-cursor contract for
  desc readers is unchanged).
  */
  const createdAtCol = schema.project.chatMessages.createdAt;
  const idCol = schema.project.chatMessages.id;
  const rows = await handle
    .select()
    .from(schema.project.chatMessages)
    .where(and(...conditions))
    .orderBy(
      filter?.order === "desc" ? desc(createdAtCol) : asc(createdAtCol),
      filter?.order === "desc" ? desc(idCol) : asc(idCol),
    )
    .limit(limit)
    .offset(offset);
  return rows.map(rowToMessage);
}

/*
FNXC:ChatSidebarPerf 2026-09-08-04:48:
The sidebar is the hottest chat read path and only consumes a ~100-character preview of one row per
session. DISTINCT ON would still scan and sort every listed message without index skip-scan; this
lateral LIMIT 1 query instead takes one descending recency-index lookup per session. Its rows examined
and returned are O(sessions), while preserving the shared created_at/id total-order tie-break.
*/
export function buildLastMessageForSessionsSql(
  handle: QueryHandle,
  sessionIds: string[],
  projectId?: string,
): SQL {
  const scope = chatMessageProjectConditions(handle, projectId);
  const scopePredicate = scope.length > 0 ? drizzleSql` AND ${drizzleSql.join(scope, drizzleSql` AND `)}` : drizzleSql.empty();
  const sessionValues = drizzleSql.join(sessionIds.map((id) => drizzleSql`(${id})`), drizzleSql`, `);
  return drizzleSql`
    SELECT last_msg.id AS "id", last_msg.session_id AS "sessionId", last_msg.role AS "role",
      last_msg.created_at AS "createdAt", left(last_msg.content, 101) AS "content"
    FROM (VALUES ${sessionValues}) AS s(session_id)
    CROSS JOIN LATERAL (
      SELECT id, session_id, role, created_at, content
      FROM project.chat_messages
      WHERE chat_messages.session_id = s.session_id${scopePredicate}
      ORDER BY chat_messages.created_at DESC, chat_messages.id DESC
      LIMIT 1
    ) AS last_msg
  `;
}

export async function getLastMessageForSessions(
  handle: QueryHandle,
  sessionIds: string[],
  projectId?: string,
): Promise<Map<string, ChatSessionLastMessage>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await handle.execute(buildLastMessageForSessionsSql(handle, [...new Set(sessionIds)], projectId)) as unknown as Array<Record<string, unknown>>;
  const result = new Map<string, ChatSessionLastMessage>();
  for (const row of rows) {
    const message: ChatSessionLastMessage = {
      id: row.id as string,
      sessionId: row.sessionId as string,
      role: row.role as ChatMessageRole,
      createdAt: row.createdAt as string,
      content: row.content as string,
    };
    result.set(message.sessionId, message);
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
      projectId: layer.projectId?.trim() ?? "",
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
        projectId: layer.projectId?.trim() ?? "",
        roomId: room.id,
        agentId,
        role,
        addedAt: now,
      });
    }
  });
  const members = await listChatRoomMembers(layer.db, room.id, layer.projectId);
  return { room, members };
}

/**
 * Get a chat room by id.
 */
export async function getChatRoom(handle: QueryHandle, id: string,
  projectId?: string): Promise<ChatRoom | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.chatRooms)
    .where(and(eq(schema.project.chatRooms.id, id), projectScopeFor(schema.project.chatRooms.projectId, projectId)));
  return rows[0] ? rowToRoom(rows[0]) : undefined;
}

/**
 * Get a chat room by (projectId, slug).
 */
export async function getChatRoomBySlug(
  handle: QueryHandle,
  ownerProjectId: string | null,
  slug: string,
  projectId?: string): Promise<ChatRoom | undefined> {
  const conditions = [eq(schema.project.chatRooms.slug, slug), projectScopeFor(schema.project.chatRooms.projectId, projectId)];
  if (ownerProjectId !== null) {
    conditions.push(eq(schema.project.chatRooms.ownerProjectId, ownerProjectId));
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
  projectId?: string,
): Promise<ChatRoom[]> {
  const conditions = [projectScopeFor(schema.project.chatRooms.projectId, projectId)];
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
export async function deleteChatRoom(handle: QueryHandle, id: string,
  projectId?: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.chatRooms)
    .where(and(eq(schema.project.chatRooms.id, id), projectScopeFor(schema.project.chatRooms.projectId, projectId)))
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
  projectId?: string): Promise<void> {
  await handle
    .insert(schema.project.chatRoomMembers)
    .values({ projectId: projectId?.trim() ?? "", roomId, agentId, role, addedAt })
    .onConflictDoNothing();
}

/**
 * Remove a room member. Returns true if a row was deleted.
 */
export async function removeChatRoomMember(
  handle: QueryHandle,
  roomId: string,
  agentId: string,
  projectId?: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.chatRoomMembers)
    .where(
      and(
        eq(schema.project.chatRoomMembers.roomId, roomId),
        eq(schema.project.chatRoomMembers.agentId, agentId),
        projectScopeFor(schema.project.chatRoomMembers.projectId, projectId),
      ),
    )
    .returning({ roomId: schema.project.chatRoomMembers.roomId });
  return result.length > 0;
}

/**
 * List room members ordered by addedAt ASC.
 */
export async function listChatRoomMembers(handle: QueryHandle, roomId: string,
  projectId?: string): Promise<ChatRoomMember[]> {
  const rows = await handle
    .select()
    .from(schema.project.chatRoomMembers)
    .where(and(eq(schema.project.chatRoomMembers.roomId, roomId), projectScopeFor(schema.project.chatRoomMembers.projectId, projectId)))
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
  projectId?: string): Promise<ChatRoomMessage> {
  // FNXC:PostgresMigrationNulSanitize 2026-07-20: same NUL-byte hazard as
  // addChatMessage above — sanitize before insert, and return the sanitized
  // value so the in-memory result matches what was persisted.
  const sanitizedAttachments = message.attachments === undefined
    ? undefined
    : sanitizeJsonbValue(message.attachments);
  const sanitized: ChatRoomMessage = {
    ...message,
    content: sanitizeTextValue(message.content),
    thinkingOutput: sanitizeTextValue(message.thinkingOutput),
    metadata: sanitizeJsonbValue(message.metadata),
    attachments: sanitizedAttachments,
  };
  await handle.insert(schema.project.chatRoomMessages).values({
    projectId: projectId?.trim() ?? "",
    id: sanitized.id,
    roomId: sanitized.roomId,
    role: sanitized.role,
    content: sanitized.content,
    thinkingOutput: sanitized.thinkingOutput,
    metadata: sanitized.metadata,
    attachments: sanitizedAttachments ?? null,
    senderAgentId: sanitized.senderAgentId,
    mentions: sanitized.mentions,
    createdAt: sanitized.createdAt,
  });
  await handle
    .update(schema.project.chatRooms)
    .set({ updatedAt: sanitized.createdAt })
    .where(and(eq(schema.project.chatRooms.id, sanitized.roomId), projectScopeFor(schema.project.chatRooms.projectId, projectId)));
  return sanitized;
}

/**
 * Get a room message by id.
 */
export async function getChatRoomMessage(handle: QueryHandle, id: string,
  projectId?: string): Promise<ChatRoomMessage | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.chatRoomMessages)
    .where(and(eq(schema.project.chatRoomMessages.id, id), projectScopeFor(schema.project.chatRoomMessages.projectId, projectId)));
  return rows[0] ? rowToRoomMessage(rows[0]) : undefined;
}

/**
 * Get room messages with optional filtering.
 */
export async function getChatRoomMessages(
  handle: QueryHandle,
  roomId: string,
  filter?: { limit?: number; offset?: number; before?: string; order?: "asc" | "desc" },
  projectId?: string): Promise<ChatRoomMessage[]> {
  const conditions = [eq(schema.project.chatRoomMessages.roomId, roomId), projectScopeFor(schema.project.chatRoomMessages.projectId, projectId)];
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
export async function clearChatRoomMessages(handle: QueryHandle, roomId: string,
  projectId?: string): Promise<number> {
  const result = await handle
    .delete(schema.project.chatRoomMessages)
    .where(and(eq(schema.project.chatRoomMessages.roomId, roomId), projectScopeFor(schema.project.chatRoomMessages.projectId, projectId)))
    .returning({ id: schema.project.chatRoomMessages.id });
  return result.length;
}

// ── FNXC:RuntimeSatelliteCompletion 2026-06-24-22:00:
// The following helpers complete the async ChatStore surface so every method
// that previously threw in backend mode now delegates to PostgreSQL via Drizzle.
// These mirror the sync SQLite semantics in chat-store.ts exactly. The matching
// backend-mode branches in chat-store.ts call these helpers instead of throwing.

/**
 * Lock a session row before a pin or archive mutation.
 *
 * FNXC:ChatPinned 2026-07-16-12:30: Pinning and archiving must serialize on
 * the same session row. Reading under this lock prevents an archive from
 * clearing a pin before a concurrent pin request writes it back.
 */
export async function getChatSessionForUpdate(
  tx: DbTransaction,
  id: string,
): Promise<ChatSession | undefined> {
  const rows = await tx
    .select()
    .from(schema.project.chatSessions)
    .where(eq(schema.project.chatSessions.id, id))
    .for("update");
  const row = rows[0];
  return row ? rowToSession(row) : undefined;
}

/**
 * FNXC:ChatStore 2026-06-24-22:05:
 * Update a chat session's mutable fields (title, status, modelProvider,
 * modelId) and bump updatedAt. Returns the updated session, or undefined if
 * not found. Mirrors sync ChatStore.updateSession.
 *
 * FNXC:Chat-ModelSwitch 2026-09-01-04:23:
 * FN-7908's mid-conversation retarget was dropped during the FN-7952 PostgreSQL
 * cutover. Persist agentId so both model-to-agent and agent-to-model
 * (__fn_agent__ sentinel) switches update the session target together.
 */
export async function updateChatSession(
  handle: QueryHandle,
  id: string,
  input: {
    title?: string | null;
    status?: ChatSessionStatus;
    modelProvider?: string | null;
    modelId?: string | null;
    agentId?: string;
    thinkingLevel?: string | null;
    memoryFocus?: string | null;
    pinnedAt?: string | null;
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
  if (input.agentId !== undefined) setValues.agentId = input.agentId;
  if (input.thinkingLevel !== undefined) setValues.thinkingLevel = input.thinkingLevel;
  if (input.memoryFocus !== undefined) setValues.memoryFocus = input.memoryFocus;
  if (input.pinnedAt !== undefined) setValues.pinnedAt = input.pinnedAt;
  // FNXC:ChatPinned 2026-07-16-12:00: archiving clears the persisted pin in
  // this same update, including callers that bypass archiveChatSession.
  if (input.status === "archived") setValues.pinnedAt = null;

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
  /*
  FNXC:ChatPersistence 2026-08-05-01:54:
  Every checkpoint reaches this JSONB boundary from live streaming callbacks,
  including tool results. Sanitizing here protects regular chat, QuickChat,
  and future providers without mutating the caller's snapshot.
  */
  const sanitizedInFlightGeneration = sanitizeJsonbValue(inFlightGeneration);
  await handle
    .update(schema.project.chatSessions)
    .set({ inFlightGeneration: sanitizedInFlightGeneration })
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
  projectId?: string,
): Promise<ChatMessage> {
  const message = await getChatMessage(handle, messageId, projectId);
  if (!message || message.sessionId !== sessionId) {
    throw new Error(`Message ${messageId} not found in session ${sessionId}`);
  }
  const updatedAttachments = sanitizeJsonbValue([
    ...(message.attachments ?? []),
    attachment,
  ]);
  await handle
    .update(schema.project.chatMessages)
    .set({ attachments: updatedAttachments })
    .where(and(
      eq(schema.project.chatMessages.id, messageId),
      ...chatMessageProjectConditions(handle, projectId),
    ));
  const updated = await getChatMessage(handle, messageId, projectId);
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
  projectId?: string,
): Promise<boolean> {
  const existing = await getChatMessage(handle, id, projectId);
  if (!existing) return false;
  await handle.delete(schema.project.chatMessages).where(and(
    eq(schema.project.chatMessages.id, id),
    ...chatMessageProjectConditions(handle, projectId),
  ));
  await handle
    .update(schema.project.chatSessions)
    .set({ updatedAt: new Date().toISOString() })
    .where(and(
      eq(schema.project.chatSessions.id, existing.sessionId),
      projectScopeFor(schema.project.chatSessions.projectId, projectId),
    ));
  return true;
}

/*
FNXC:ChatSidebarPerf 2026-09-08-04:48:
Content search shared the full-row transfer defect, so it now returns one projected row per matching
session through the same lateral shape. Wildcard escaping and project scope are unchanged. ILIKE is not
index-assisted: each subquery can walk its session history to the newest match, while returned bytes and
materialized rows remain bounded by scoped sessions.
*/
export function buildSearchChatSessionsByMessageContentSql(
  handle: QueryHandle,
  escapedQuery: string,
  sessionIds: string[],
  projectId?: string,
): SQL {
  const scope = chatMessageProjectConditions(handle, projectId);
  const scopePredicate = scope.length > 0 ? drizzleSql` AND ${drizzleSql.join(scope, drizzleSql` AND `)}` : drizzleSql.empty();
  const sessionValues = drizzleSql.join(sessionIds.map((id) => drizzleSql`(${id})`), drizzleSql`, `);
  return drizzleSql`
    SELECT matching_msg.session_id AS "sessionId", left(matching_msg.content, 101) AS "content"
    FROM (VALUES ${sessionValues}) AS s(session_id)
    CROSS JOIN LATERAL (
      SELECT session_id, content
      FROM project.chat_messages
      WHERE chat_messages.session_id = s.session_id
        AND chat_messages.content ILIKE ${`%${escapedQuery}%`} ESCAPE '\\'${scopePredicate}
      ORDER BY chat_messages.created_at DESC, chat_messages.id DESC
      LIMIT 1
    ) AS matching_msg
  `;
}

export async function searchChatSessionsByMessageContent(
  handle: QueryHandle,
  query: string,
  sessionIds: string[],
  projectId?: string,
): Promise<Map<string, string>> {
  const trimmed = query.trim();
  if (!trimmed || sessionIds.length === 0) return new Map();
  const escaped = trimmed.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const rows = await handle.execute(buildSearchChatSessionsByMessageContentSql(handle, escaped, [...new Set(sessionIds)], projectId)) as unknown as Array<Record<string, unknown>>;
  const result = new Map<string, string>();
  for (const row of rows) {
    const content = (row.content as string) || "";
    result.set(row.sessionId as string, content.length > 100 ? content.slice(0, 100) + "…" : content);
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
  projectId?: string,
): Promise<{ deletedIds: string[]; retained: ChatMessage[] }> {
  const orderedRows = await handle
    .select()
    .from(schema.project.chatMessages)
    .where(and(
      eq(schema.project.chatMessages.sessionId, sessionId),
      ...chatMessageProjectConditions(handle, projectId),
    ))
    .orderBy(
      asc(schema.project.chatMessages.createdAt),
      asc(schema.project.chatMessages.id),
    );
  const ordered = orderedRows.map(rowToMessage);

  const target = await getChatMessage(handle, fromMessageId, projectId);
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
    .where(and(
      inArray(schema.project.chatMessages.id, deletedIds),
      ...chatMessageProjectConditions(handle, projectId),
    ));
  await handle
    .update(schema.project.chatSessions)
    .set({ updatedAt: new Date().toISOString() })
    .where(and(
      eq(schema.project.chatSessions.id, sessionId),
      projectScopeFor(schema.project.chatSessions.projectId, projectId),
    ));

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
  projectId?: string,
): Promise<ChatMessage> {
  const existing = await getChatMessage(handle, messageId, projectId);
  if (!existing) {
    throw new Error(`Message ${messageId} not found`);
  }

  const merge = options?.merge !== false;
  const nextMetadata = metadata === null
    ? (merge ? existing.metadata : null)
    : (merge ? { ...(existing.metadata ?? {}), ...metadata } : metadata);

  await handle
    .update(schema.project.chatMessages)
    .set({ metadata: sanitizeJsonbValue(nextMetadata) ?? null })
    .where(and(
      eq(schema.project.chatMessages.id, messageId),
      ...chatMessageProjectConditions(handle, projectId),
    ));

  const updated = await getChatMessage(handle, messageId, projectId);
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
  projectId?: string): Promise<ChatRoom | undefined> {
  const existing = await getChatRoom(handle, id, projectId);
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
    .where(and(eq(schema.project.chatRooms.id, id), projectScopeFor(schema.project.chatRooms.projectId, projectId)));

  return getChatRoom(handle, id, projectId);
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
  projectId?: string): Promise<{ sessionsDeleted: number; roomsDeleted: number; deletedSessionIds: string[]; deletedRoomIds: string[] }> {
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
    .where(and(lte(schema.project.chatRooms.updatedAt, cutoff), projectScopeFor(schema.project.chatRooms.projectId, projectId)))
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
  projectId?: string,
): Promise<ChatRoom[]> {
  // Use a subquery to find room IDs where the agent is a member, then select
  // those rooms. This avoids the Drizzle join result-shape complexity.
  const memberRoomIds = handle
    .select({ roomId: schema.project.chatRoomMembers.roomId })
    .from(schema.project.chatRoomMembers)
    .where(and(eq(schema.project.chatRoomMembers.agentId, agentId), projectScopeFor(schema.project.chatRoomMembers.projectId, projectId)));

  const conditions = [inArray(schema.project.chatRooms.id, memberRoomIds), projectScopeFor(schema.project.chatRooms.projectId, projectId)];
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
  projectId?: string): Promise<ChatRoomMessage[]> {
  const conditions = [
    eq(schema.project.chatRoomMessages.roomId, roomId),
    projectScopeFor(schema.project.chatRoomMessages.projectId, projectId),
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
  projectId?: string): Promise<boolean> {
  const existing = await getChatRoomMessage(handle, id, projectId);
  if (!existing) return false;
  await handle.delete(schema.project.chatRoomMessages).where(and(eq(schema.project.chatRoomMessages.id, id), projectScopeFor(schema.project.chatRoomMessages.projectId, projectId)));
  await handle
    .update(schema.project.chatRooms)
    .set({ updatedAt: new Date().toISOString() })
    .where(and(eq(schema.project.chatRooms.id, existing.roomId), projectScopeFor(schema.project.chatRooms.projectId, projectId)));
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
  projectId?: string): Promise<ChatRoomMessage> {
  const message = await getChatRoomMessage(handle, messageId, projectId);
  if (!message || message.roomId !== roomId) {
    throw new Error(`Message ${messageId} not found in room ${roomId}`);
  }
  const updatedAttachments = sanitizeJsonbValue([
    ...(message.attachments ?? []),
    attachment,
  ]);
  await handle
    .update(schema.project.chatRoomMessages)
    .set({ attachments: updatedAttachments })
    .where(and(eq(schema.project.chatRoomMessages.id, messageId), projectScopeFor(schema.project.chatRoomMessages.projectId, projectId)));
  await handle
    .update(schema.project.chatRooms)
    .set({ updatedAt: new Date().toISOString() })
    .where(and(eq(schema.project.chatRooms.id, roomId), projectScopeFor(schema.project.chatRooms.projectId, projectId)));
  const updated = await getChatRoomMessage(handle, messageId, projectId);
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
