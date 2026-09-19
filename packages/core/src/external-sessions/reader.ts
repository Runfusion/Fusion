import { and, asc, eq, gt } from "drizzle-orm";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { externalSessionHosts, externalSessions } from "../postgres/schema/project.js";
import { externalSessionFreshness, externalSessionIdentifier, externalSessionHostConnected } from "./contract.js";
import { externalSessionCursorAfter, externalSessionListQuerySchema, externalSessionPageCursor,
  externalSessionReadId, type ExternalSessionListQuery, type ExternalSessionPage, type ExternalSessionView } from "./read-contract.js";

type SessionRow = typeof externalSessions.$inferSelect;
function view(row: SessionRow, heartbeatAt: string | null, now: number): ExternalSessionView {
  return { id: row.id, hostId: row.hostId, provider: row.provider, nativeSessionId: row.nativeSessionId,
    revision: row.revision, observation: row.observation, receivedAt: row.receivedAt,
    lastHeartbeatAt: heartbeatAt, ...externalSessionFreshness(row.observation, heartbeatAt, now) };
}

/** FNXC:RemoteAgents 2026-09-17-23:19: Explicit project predicates remain mandatory under owner connections that bypass RLS. Collector principals cannot authorize dashboard reads. */
export class ExternalSessionReader {
  constructor(private readonly layer: AsyncDataLayer, private readonly projectId: string) {
    externalSessionIdentifier.parse(projectId);
    if (layer.projectId !== projectId) throw new Error("External session reads require a matching project-bound data layer");
  }

  async hosts(now = Date.now()) {
    const rows = await this.layer.db.select().from(externalSessionHosts).where(eq(externalSessionHosts.projectId, this.projectId)).limit(128);
    return rows.map(h => ({ hostId: h.hostId, lastHeartbeatAt: h.lastHeartbeatAt,
      collectorConnected: externalSessionHostConnected(h.lastHeartbeatAt, now) }));
  }

  async list(value: ExternalSessionListQuery = {}, now = Date.now()): Promise<ExternalSessionPage> {
    const query = externalSessionListQuerySchema.parse(value);
    const afterId = externalSessionCursorAfter(this.projectId, query);
    const rows = await this.layer.db.select({ session: externalSessions, heartbeatAt: externalSessionHosts.lastHeartbeatAt })
      .from(externalSessions).leftJoin(externalSessionHosts, and(
        eq(externalSessionHosts.projectId, this.projectId),
        eq(externalSessionHosts.hostId, externalSessions.hostId)))
      .where(and(eq(externalSessions.projectId, this.projectId),
        query.hostId === undefined ? undefined : eq(externalSessions.hostId, query.hostId),
        query.provider === undefined ? undefined : eq(externalSessions.provider, query.provider),
        afterId === undefined ? undefined : gt(externalSessions.id, afterId)))
      .orderBy(asc(externalSessions.id)).limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return { schemaVersion: 1, sessions: page.map(row => view(row.session, row.heartbeatAt, now)),
      nextCursor: rows.length > query.limit
        ? externalSessionPageCursor(this.projectId, query, page[page.length - 1].session.id) : null };
  }

  async get(id: string, now = Date.now()): Promise<ExternalSessionView | null> {
    externalSessionReadId.parse(id);
    const [row] = await this.layer.db.select({ session: externalSessions, heartbeatAt: externalSessionHosts.lastHeartbeatAt })
      .from(externalSessions).leftJoin(externalSessionHosts, and(
        eq(externalSessionHosts.projectId, this.projectId), eq(externalSessionHosts.hostId, externalSessions.hostId)))
      .where(and(eq(externalSessions.projectId, this.projectId), eq(externalSessions.id, id))).limit(1);
    return row ? view(row.session, row.heartbeatAt, now) : null;
  }
}
