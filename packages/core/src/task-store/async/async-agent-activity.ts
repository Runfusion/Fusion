import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import type { AgentActivityEvent, AgentActivityEventInput, AgentActivityQuery } from "../../types/agents/agents.js";
import { makeAgentActivityEventId, verifyAgentActivityAttribution, formatAgentActivitySummary, sanitizeAgentActivityMetadata } from "../agent-activity-outbox.js";
type AgentActivityRow = { seq: bigint; eventId: string; projectId: string; agentId: string; agentAttribution: string; taskId: string | null; type: string; fromAgentId: string | null; toAgentId: string | null; summary: string; occurredAt: string; metadata: unknown };
const map = (r: AgentActivityRow): AgentActivityEvent => ({ seq: String(r.seq), eventId: r.eventId, projectId: r.projectId, agentId: r.agentId, agentAttribution: r.agentAttribution as AgentActivityEvent["agentAttribution"], taskId: r.taskId, type: r.type as AgentActivityEvent["type"], fromAgentId: r.fromAgentId, toAgentId: r.toAgentId, summary: r.summary, occurredAt: r.occurredAt, metadata: r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata) ? r.metadata as Record<string, unknown> : null });
export async function appendAgentActivityEvent(layer: AsyncDataLayer, input: AgentActivityEventInput): Promise<AgentActivityEvent | null> {
  if (!layer.projectId) throw new Error("Agent activity requires AsyncDataLayer.projectId");
  const main = await verifyAgentActivityAttribution(layer, input.attributionClaim);
  const from = input.fromAgentIdClaim ? await verifyAgentActivityAttribution(layer, input.fromAgentIdClaim) : null;
  const to = input.toAgentIdClaim ? await verifyAgentActivityAttribution(layer, input.toAgentIdClaim) : null;
  const eventId = makeAgentActivityEventId(layer.projectId, input.type, main.agentId, input.taskId, input.discriminator);
  return layer.transactionImmediate(async (tx) => {
    /*
    FNXC:AgentActivityStream 2026-08-09-10:04:
    Lock the counter before checking idempotency so concurrent retries serialize. Allocating before
    a duplicate check creates cursor gaps for rows that never exist, which makes a seq tail's
    high-water mark less useful during recovery.
    */
    await tx.execute(sql`INSERT INTO project.agent_activity_event_seq (project_id,last_seq) VALUES (${layer.projectId},0) ON CONFLICT (project_id) DO NOTHING`);
    await tx.execute(sql`SELECT last_seq FROM project.agent_activity_event_seq WHERE project_id=${layer.projectId} FOR UPDATE`);
    const existing = await tx.execute(sql`SELECT 1 FROM project.agent_activity_events WHERE project_id=${layer.projectId} AND event_id=${eventId} LIMIT 1`);
    if ((existing as unknown as unknown[]).length > 0) return null;
    const counter = await tx.execute(sql`UPDATE project.agent_activity_event_seq SET last_seq=last_seq+1 WHERE project_id=${layer.projectId} RETURNING last_seq`) as unknown as Array<{ last_seq: string | number }>;
    const seq = String(counter[0]!.last_seq);
    const summary = formatAgentActivitySummary({ type: input.type, agentId: main.agentId, taskId: input.taskId ?? null });
    const metadata = sanitizeAgentActivityMetadata(input.type, input.metadata);
    const rows = await tx.insert(schema.project.agentActivityEvents).values({ projectId: layer.projectId!, seq: BigInt(seq), eventId, agentId: main.agentId, agentAttribution: main.agentAttribution, taskId: input.taskId ?? null, type: input.type, fromAgentId: from?.agentAttribution === "agent" ? from.agentId : null, toAgentId: to?.agentAttribution === "agent" ? to.agentId : null, summary, occurredAt: input.occurredAt, createdAt: input.occurredAt, metadata }).onConflictDoNothing().returning();
    return rows[0] ? map(rows[0]) : null;
  });
}
export async function queryAgentActivityEvents(layer: AsyncDataLayer, query: AgentActivityQuery & { order?: "asc" | "desc" } = {}): Promise<{ events: AgentActivityEvent[]; nextCursor: string | null }> {
  if (!layer.projectId) throw new Error("Agent activity requires AsyncDataLayer.projectId");
  // FNXC:AgentActivityStream 2026-08-09-12:59: Programmatic callers can supply NaN, so validate before Math.trunc rather than passing NaN through to Drizzle LIMIT.
  const requestedLimit = query.limit;
  const limit = typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
    ? Math.min(Math.max(0, Math.trunc(requestedLimit)), 1000)
    : 100;
  const t=schema.project.agentActivityEvents;
  const beforeClause = query.before ? lt(t.seq, BigInt(query.before)) : undefined;
  const sinceClause = query.since ? gt(t.seq, BigInt(query.since)) : undefined;
  const agentClause = query.agentId ? eq(t.agentId, query.agentId) : undefined;
  const taskClause = query.taskId ? eq(t.taskId, query.taskId) : undefined;
  const typeClause = query.type ? eq(t.type, query.type) : undefined;
  // FNXC:AgentActivityStream 2026-08-09-10:04: Fetch one extra descending row so an exactly-full final page does not advertise a dead cursor.
  const rows = await layer.db.select().from(t).where(and(eq(t.projectId, layer.projectId), beforeClause, sinceClause, agentClause, taskClause, typeClause)).orderBy(query.order === "asc" ? asc(t.seq) : desc(t.seq)).limit(limit + 1);
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).map(map);
  return { events, nextCursor: query.order === "asc" || !hasMore || !events.length ? null : events.at(-1)!.seq };
}
export async function getMaxAgentActivitySeq(layer: AsyncDataLayer): Promise<string> { if (!layer.projectId) throw new Error("Agent activity requires AsyncDataLayer.projectId"); const rows = await layer.db.execute(sql`SELECT COALESCE(MAX(seq),0) AS seq FROM project.agent_activity_events WHERE project_id=${layer.projectId}`) as unknown as Array<{seq:string|number}>; return String(rows[0]?.seq ?? 0); }
export const AGENT_ACTIVITY_RETENTION_MS = 30 * 86_400_000;
export const AGENT_ACTIVITY_RETENTION_ROW_CAP = 50_000;

export async function pruneAgentActivityEvents(layer: AsyncDataLayer): Promise<void> {
  if (!layer.projectId) return;
  const cutoff = new Date(Date.now() - AGENT_ACTIVITY_RETENTION_MS).toISOString();
  await layer.db.execute(sql`DELETE FROM project.agent_activity_events WHERE project_id=${layer.projectId} AND occurred_at < ${cutoff}`);
  // FNXC:AgentActivityStream 2026-08-09-10:04: Keep retention well beyond retry windows;
  // pruning is deferred housekeeping so monitoring cannot resurrect a retry during a transition.
  await layer.db.execute(sql`
    DELETE FROM project.agent_activity_events
    WHERE project_id=${layer.projectId} AND seq IN (
      SELECT seq FROM project.agent_activity_events
      WHERE project_id=${layer.projectId}
      ORDER BY seq DESC
      OFFSET ${AGENT_ACTIVITY_RETENTION_ROW_CAP}
    )
  `);
}
