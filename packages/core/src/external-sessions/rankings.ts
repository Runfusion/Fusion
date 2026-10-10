import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AsyncDataLayer } from "../postgres/data-layer.js";

/*
FNXC:ExternalSessionRankings 2026-09-24-00:04:
Candidates for "what was expensive". Pricing lives in the dashboard, so this reader deliberately returns raw
usage rather than money: there must be exactly one place that turns tokens into dollars.

The scan is bounded and reports whether it was truncated. A ranking computed over a silently cut scan claims
"the most expensive work" while having looked at part of it, which is worse than saying the range is too wide.
*/
const rankingQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  hostId: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(256).optional(),
  /** Hard bound on rows examined, so a wide range cannot walk the whole table. */
  scanLimit: z.number().int().min(1).max(5000).default(2000),
}).strict();

export type ExternalSessionRankingQuery = z.input<typeof rankingQuerySchema>;

export interface RankingSessionCandidate {
  sessionId: string; hostId: string; provider: string; title: string | null;
  observedAt: string | null; usage: unknown[]; usageComplete: boolean;
  /* FNXC:ExternalSessionAttribution 2026-09-24-08:12 (F4 = 1): carried so an aggregate over this scan can say
     which sessions ARE Fusion task runs without a second query per session. */
  nativeSessionId: string | null;
}

export interface RankingTurnCandidate {
  sessionId: string; hostId: string; provider: string; title: string | null;
  nativeTurnId: string; ordinal: number; at: string | null;
  usage: unknown[]; usageComplete: boolean; pricing: unknown;
}

export interface RankingScan<T> {
  candidates: T[];
  /** Rows examined. */
  scanned: number;
  /** True when the bound was reached, so the ranking covers only part of the range. */
  truncated: boolean;
  /** Rows in range that reported no usage at all; they can never be ranked. */
  withoutUsage: number;
}

export class ExternalSessionRankings {
  constructor(private readonly layer: AsyncDataLayer, private readonly projectId: string) {
    if (layer.projectId !== projectId) throw new Error("External session rankings require matching project storage");
  }

  private filters(query: z.infer<typeof rankingQuerySchema>, at: ReturnType<typeof sql>) {
    return [
      query.from === undefined ? sql`` : sql` AND ${at} >= ${query.from}`,
      query.to === undefined ? sql`` : sql` AND ${at} <= ${query.to}`,
      query.hostId === undefined ? sql`` : sql` AND s.host_id = ${query.hostId}`,
    ];
  }

  async sessions(value: ExternalSessionRankingQuery = {}): Promise<RankingScan<RankingSessionCandidate>> {
    const query = rankingQuerySchema.parse(value);
    const at = sql`s.observation->>'observedAt'`;
    const [from, to, host] = this.filters(query, at);
    // The model filter matches the usage records themselves, so a session counts only when that model was used.
    const model = query.model === undefined ? sql``
      : sql` AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(s.observation->'usage', '[]'::jsonb)) u WHERE u->>'model' = ${query.model})`;
    const rows = (await this.layer.db.execute(sql`
      SELECT s.id AS "sessionId", s.host_id AS "hostId", s.provider AS provider, s.observation->>'title' AS title,
             s.native_session_id AS "nativeSessionId",
             ${at} AS "observedAt", coalesce(s.observation->'usage', '[]'::jsonb) AS usage,
             coalesce((s.observation->>'usageComplete')::boolean, false) AS "usageComplete"
      FROM project.external_sessions s
      WHERE s.project_id = ${this.projectId}${from}${to}${host}${model}
      ORDER BY ${at} DESC NULLS LAST
      LIMIT ${query.scanLimit + 1}
    `)) as unknown as RankingSessionCandidate[];
    return this.scan(rows, query.scanLimit);
  }

  async turns(value: ExternalSessionRankingQuery = {}): Promise<RankingScan<RankingTurnCandidate>> {
    const query = rankingQuerySchema.parse(value);
    const at = sql`coalesce(t.turn->>'endedAt', t.turn->>'startedAt')`;
    const [from, to, host] = this.filters(query, at);
    const model = query.model === undefined ? sql``
      : sql` AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(t.turn->'usage', '[]'::jsonb)) u WHERE u->>'model' = ${query.model})`;
    const rows = (await this.layer.db.execute(sql`
      SELECT t.session_id AS "sessionId", s.host_id AS "hostId", s.provider AS provider, s.observation->>'title' AS title,
             t.native_turn_id AS "nativeTurnId", t.ordinal AS ordinal, ${at} AS at,
             coalesce(t.turn->'usage', '[]'::jsonb) AS usage,
             coalesce((t.turn->>'usageComplete')::boolean, true) AS "usageComplete",
             t.turn->'pricing' AS pricing
      FROM project.external_session_turns t
      JOIN project.external_sessions s ON s.project_id = t.project_id AND s.id = t.session_id
      WHERE t.project_id = ${this.projectId}${from}${to}${host}${model}
      ORDER BY ${at} DESC NULLS LAST
      LIMIT ${query.scanLimit + 1}
    `)) as unknown as RankingTurnCandidate[];
    return this.scan(rows, query.scanLimit);
  }

  private scan<T extends { usage: unknown[]; ordinal?: number }>(rows: T[], limit: number): RankingScan<T> {
    const truncated = rows.length > limit;
    const candidates = (truncated ? rows.slice(0, limit) : rows)
      .map(row => ({ ...row, ...(row.ordinal === undefined ? {} : { ordinal: Number(row.ordinal) }) }));
    const withoutUsage = candidates.filter(row => !Array.isArray(row.usage) || row.usage.length === 0).length;
    return { candidates, scanned: candidates.length, truncated, withoutUsage };
  }
}
