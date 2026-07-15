/**
 * Async Drizzle goal-citation / usage-event / plugin-activation helpers (U14).
 *
 * FNXC:TaskStoreEvents 2026-06-24-10:10:
 * Async equivalents of the sync SQLite goal-citation, usage-event, and
 * plugin-activation call sites in store.ts and usage-events.ts. These helpers
 * target the PostgreSQL `project.goal_citations`, `project.usage_events`, and
 * `project.plugin_activations` tables via Drizzle.
 *
 * Goal citations:
 *   The dedup unique index `(goalId, surface, sourceRef)` makes inserts
 *   idempotent. `INSERT ... ON CONFLICT DO NOTHING` mirrors the sync
 *   `INSERT OR IGNORE` behavior.
 *
 * Usage events:
 *   Fail-soft: a malformed event or DB error is swallowed (it must never abort
 *   the hot path). The `meta` column is jsonb (Drizzle serializes the JS value).
 *
 * Plugin activations:
 *   Each activation is a new row (no dedup) — the `id` is an identity column.
 *
 * Transition context (see library/taskstore-persistence-notes.md):
 *   `getDatabase()` still returns the sync `Database` until U15 flips it. The
 *   TaskStore facade keeps its sync event path (the gate depends on it).
 *   These helpers are the async target the migrating store and the PostgreSQL
 *   integration tests consume.
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import type {
  GoalCitation,
  GoalCitationFilter,
  GoalCitationInput,
  GoalCitationSurface,
} from "../types.js";
import type { GoalCitationRow } from "./row-types.js";
import type { UsageEventInput, UsageEventKind, UsageEventRangeQuery, UsageEvent } from "../usage-events.js";

const USAGE_EVENT_META_MAX_BYTES = 16 * 1024;

/**
 * Validate and serialize a `meta` payload. Returns the serialized value, or
 * throws if it exceeds the byte cap. Mirrors the sync `serializeMeta`.
 */
function serializeMeta(
  meta: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (meta === undefined || meta === null) return null;
  const serialized = JSON.stringify(meta);
  if (serialized === undefined) return null;
  if (Buffer.byteLength(serialized, "utf8") > USAGE_EVENT_META_MAX_BYTES) {
    throw new Error(
      `usage_events meta payload exceeds ${USAGE_EVENT_META_MAX_BYTES} bytes (got ${Buffer.byteLength(serialized, "utf8")})`,
    );
  }
  // Return the original JS value so Drizzle binds it as jsonb.
  return meta;
}

// ── Goal citations ───────────────────────────────────────────────────

/**
 * Convert a raw `goal_citations` row into the public `GoalCitation` shape.
 */
function rowToGoalCitation(row: GoalCitationRow): GoalCitation {
  return {
    id: row.id,
    goalId: row.goalId,
    agentId: row.agentId,
    taskId: row.taskId ?? undefined,
    surface: row.surface,
    sourceRef: row.sourceRef,
    snippet: row.snippet,
    timestamp: row.timestamp,
  };
}

/**
 * FNXC:TaskStoreEvents 2026-06-24-10:15:
 * Record goal citations with dedup. The unique index
 * `(goalId, surface, sourceRef)` makes the insert idempotent — a re-record of
 * the same (goal, surface, sourceRef) triple is a no-op. This is the async
 * equivalent of `recordGoalCitations`.
 *
 * @param db The Drizzle instance.
 * @param inputs The citation inputs to record.
 * @returns The citations that were actually inserted (deduped ones are absent).
 */
export async function recordGoalCitations(
  db: AsyncDataLayer["db"] | DbTransaction,
  inputs: GoalCitationInput[],
): Promise<GoalCitation[]> {
  if (inputs.length === 0) return [];

  const now = new Date().toISOString();
  const inserted: GoalCitation[] = [];

  for (const input of inputs) {
    const result = await db
      .insert(schema.project.goalCitations)
      .values({
        goalId: input.goalId,
        agentId: input.agentId,
        taskId: input.taskId ?? null,
        surface: input.surface,
        sourceRef: input.sourceRef,
        snippet: input.snippet,
        timestamp: input.timestamp ?? now,
      })
      .onConflictDoNothing({
        target: [
          schema.project.goalCitations.projectId,
          schema.project.goalCitations.goalId,
          schema.project.goalCitations.surface,
          schema.project.goalCitations.sourceRef,
        ],
      })
      .returning();

    const row = result[0] as GoalCitationRow | undefined;
    if (row) {
      inserted.push(rowToGoalCitation(row));
    }
  }

  return inserted;
}

/**
 * List goal citations with optional filtering. Ordered by timestamp DESC, id DESC.
 * This is the async equivalent of `listGoalCitations`.
 */
export async function listGoalCitations(
  db: AsyncDataLayer["db"] | DbTransaction,
  filter: GoalCitationFilter = {},
): Promise<GoalCitation[]> {
  const conditions = [];
  if (filter.goalId) {
    conditions.push(eq(schema.project.goalCitations.goalId, filter.goalId));
  }
  if (filter.agentId) {
    conditions.push(eq(schema.project.goalCitations.agentId, filter.agentId));
  }
  if (filter.taskId) {
    conditions.push(eq(schema.project.goalCitations.taskId, filter.taskId));
  }
  if (filter.surface) {
    conditions.push(eq(schema.project.goalCitations.surface, filter.surface));
  }
  if (filter.startTime) {
    conditions.push(gte(schema.project.goalCitations.timestamp, filter.startTime));
  }
  if (filter.endTime) {
    conditions.push(lte(schema.project.goalCitations.timestamp, filter.endTime));
  }

  const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
  const query = db
    .select()
    .from(schema.project.goalCitations)
    .orderBy(desc(schema.project.goalCitations.timestamp), desc(schema.project.goalCitations.id))
    .limit(limit);
  const rows = (conditions.length > 0 ? await query.where(and(...conditions)) : await query) as GoalCitationRow[];
  return rows.map((row) => rowToGoalCitation(row));
}

// ── Usage events ─────────────────────────────────────────────────────

/**
 * The set of valid usage-event kinds. Mirrors `USAGE_EVENT_KINDS`.
 */
const USAGE_EVENT_KINDS: ReadonlySet<string> = new Set([
  "agent_run_started",
  "agent_run_completed",
  "token_usage",
  "tool_call",
  "task_created",
  "task_updated",
  "task_moved",
  "task_completed",
]);

/**
 * Convert a raw `usage_events` row into the public `UsageEvent` shape.
 * The `meta` column is jsonb (already-parsed on read).
 */
function rowToUsageEvent(row: Record<string, unknown>): UsageEvent {
  let meta: Record<string, unknown> | null = null;
  const rawMeta = row.meta as string | Record<string, unknown> | null;
  if (rawMeta) {
    if (typeof rawMeta === "string") {
      try {
        meta = JSON.parse(rawMeta) as Record<string, unknown>;
      } catch {
        meta = null;
      }
    } else {
      meta = rawMeta;
    }
  }
  return {
    id: row.id as number,
    ts: row.ts as string,
    kind: row.kind as UsageEventKind,
    taskId: (row.taskId as string | null) ?? null,
    agentId: (row.agentId as string | null) ?? null,
    nodeId: (row.nodeId as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    toolName: (row.toolName as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    meta,
  };
}

/**
 * FNXC:TaskStoreEvents 2026-06-24-10:20:
 * Append a single usage event. **Fail-soft**: a malformed event (unknown kind),
 * an oversized `meta`, or any DB error is swallowed — it must never throw, so
 * it cannot abort the underlying agent-log write or the hot path. This is the
 * async equivalent of `emitUsageEvent`.
 *
 * @param db The Drizzle instance.
 * @param event The usage event input.
 * @returns `true` if the row was inserted, `false` if the event was skipped.
 */
export async function emitUsageEvent(
  db: AsyncDataLayer["db"] | DbTransaction,
  projectId: string,
  event: UsageEventInput,
): Promise<boolean> {
  try {
    if (!event || !USAGE_EVENT_KINDS.has(event.kind)) {
      return false;
    }
    const ts = event.ts ?? new Date().toISOString();
    const meta = serializeMeta(event.meta);
    await db.insert(schema.project.usageEvents).values({
      projectId,
      ts,
      kind: event.kind,
      taskId: event.taskId ?? null,
      agentId: event.agentId ?? null,
      nodeId: event.nodeId ?? null,
      model: event.model ?? null,
      provider: event.provider ?? null,
      toolName: event.toolName ?? null,
      category: event.category ?? null,
      meta,
    });
    return true;
  } catch (err) {
    console.warn("[fusion] emitUsageEvent skipped a malformed/failed event:", err);
    return false;
  }
}

/**
 * Query usage events by time range and optional kind/task/agent filters.
 * This is the async equivalent of `queryUsageEvents`.
 */
export async function queryUsageEvents(
  db: AsyncDataLayer["db"] | DbTransaction,
  projectId: string,
  query: UsageEventRangeQuery = {},
): Promise<UsageEvent[]> {
  const conditions = [eq(schema.project.usageEvents.projectId, projectId)];
  if (query.from) {
    conditions.push(gte(schema.project.usageEvents.ts, query.from));
  }
  if (query.to) {
    conditions.push(lte(schema.project.usageEvents.ts, query.to));
  }
  if (query.kind) {
    conditions.push(eq(schema.project.usageEvents.kind, query.kind));
  }
  if (query.taskId) {
    conditions.push(eq(schema.project.usageEvents.taskId, query.taskId));
  }
  if (query.agentId) {
    conditions.push(eq(schema.project.usageEvents.agentId, query.agentId));
  }

  const q = db
    .select()
    .from(schema.project.usageEvents)
    .orderBy(desc(schema.project.usageEvents.ts));
  const rows = (conditions.length > 0 ? await q.where(and(...conditions)) : await q) as Record<string, unknown>[];
  return rows.map((row) => rowToUsageEvent(row));
}

// ── Plugin activations ───────────────────────────────────────────────

/** A plugin-activation record. */
export interface PluginActivation {
  id: number;
  pluginId: string;
  source: string;
  pluginVersion: string | null;
  activatedAt: string;
}

/** Input for recording a plugin activation. */
export interface PluginActivationInput {
  pluginId: string;
  source: string;
  pluginVersion?: string | null;
  activatedAt?: string;
}

/**
 * FNXC:TaskStoreEvents 2026-06-24-10:25:
 * Record a plugin activation. Each activation is a new row (no dedup) — the
 * `id` is an identity column. This is the async equivalent of
 * `recordPluginActivation`.
 */
export async function recordPluginActivation(
  db: AsyncDataLayer["db"] | DbTransaction,
  input: PluginActivationInput,
): Promise<PluginActivation> {
  const activatedAt = input.activatedAt ?? new Date().toISOString();
  const result = await db
    .insert(schema.project.pluginActivations)
    .values({
      pluginId: input.pluginId,
      source: input.source,
      pluginVersion: input.pluginVersion ?? null,
      activatedAt,
    })
    .returning({ id: schema.project.pluginActivations.id });

  const row = result[0];
  if (!row) {
    throw new Error("Failed to record plugin activation");
  }

  return {
    id: row.id,
    pluginId: input.pluginId,
    source: input.source,
    pluginVersion: input.pluginVersion ?? null,
    activatedAt,
  };
}

// Re-export the surface type for convenience.
export type { GoalCitationSurface };
