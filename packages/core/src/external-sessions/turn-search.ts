import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AsyncDataLayer } from "../postgres/data-layer.js";

/*
FNXC:ExternalSessionSearch 2026-09-23-22:51:
Search over collected turn output. The configuration name 'english' is repeated from migration 0089 on
purpose: PostgreSQL only uses the expression index when the query's to_tsvector call matches the indexed
expression exactly, so these two must change together.

websearch_to_tsquery is used rather than to_tsquery because operator input is a search box, not tsquery
syntax; it never raises on punctuation or unbalanced quotes, so a stray character returns no rows instead of
a 500. Empty or stopword-only input is rejected before querying: it matches everything, which reads as
"search is broken" rather than "no results".
*/
const searchQuerySchema = z.object({
  q: z.string().min(1).max(512),
  limit: z.number().int().min(1).max(50).default(20),
  hostId: z.string().min(1).max(256).optional(),
  sessionId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export type ExternalSessionTurnSearchQuery = z.input<typeof searchQuerySchema>;

export interface ExternalSessionTurnSearchHit {
  sessionId: string;
  hostId: string;
  provider: string;
  title: string | null;
  nativeTurnId: string;
  ordinal: number;
  /** Highlighted excerpt around the match; `<mark>` delimited, HTML-escaped by PostgreSQL's ts_headline. */
  snippet: string;
  rank: number;
}

export interface ExternalSessionTurnSearchPage {
  schemaVersion: 1;
  hits: ExternalSessionTurnSearchHit[];
  /** True when more rows matched than the limit returned, so the operator knows the list is cut. */
  more: boolean;
  /** Null when the query carried no searchable term, so callers can say why nothing came back. */
  query: string | null;
}

const EMPTY: ExternalSessionTurnSearchPage = { schemaVersion: 1, hits: [], more: false, query: null };

export class ExternalSessionTurnSearch {
  constructor(private readonly layer: AsyncDataLayer, private readonly projectId: string) {
    if (layer.projectId !== projectId) throw new Error("External turn search requires matching project storage");
  }

  async search(value: ExternalSessionTurnSearchQuery): Promise<ExternalSessionTurnSearchPage> {
    const query = searchQuerySchema.parse(value);
    const term = query.q.trim();
    if (!term) return EMPTY;
    const text = sql`coalesce(t.turn->>'response', '') || ' ' || coalesce(jsonb_path_query_array(t.turn, '$.prompts[*].text')::text, '')`;
    const vector = sql`to_tsvector('english'::regconfig, ${text})`;
    const tsquery = sql`websearch_to_tsquery('english'::regconfig, ${term})`;
    // A stopword-only query ("the and") produces an empty tsquery, which would otherwise match nothing while
    // looking like a failure; report it as "no searchable term" instead.
    const [probe] = (await this.layer.db.execute(sql`SELECT ${tsquery}::text AS parsed`)) as unknown as Array<{ parsed: string | null }>;
    if (!probe?.parsed) return EMPTY;
    const rows = (await this.layer.db.execute(sql`
      SELECT t.session_id AS "sessionId", s.host_id AS "hostId", s.provider AS provider,
             s.observation->>'title' AS title, t.native_turn_id AS "nativeTurnId", t.ordinal AS ordinal,
             ts_headline('english'::regconfig, ${text}, ${tsquery},
               'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,FragmentDelimiter= … ,MaxWords=28,MinWords=8') AS snippet,
             ts_rank(${vector}, ${tsquery}) AS rank
      FROM project.external_session_turns t
      JOIN project.external_sessions s ON s.project_id = t.project_id AND s.id = t.session_id
      WHERE t.project_id = ${this.projectId}
        AND ${vector} @@ ${tsquery}
        ${query.hostId === undefined ? sql`` : sql`AND s.host_id = ${query.hostId}`}
        ${query.sessionId === undefined ? sql`` : sql`AND t.session_id = ${query.sessionId}`}
      ORDER BY rank DESC, t.ordinal DESC, t.native_turn_id
      LIMIT ${query.limit + 1}
    `)) as unknown as Array<ExternalSessionTurnSearchHit>;
    const hits = rows.slice(0, query.limit);
    return { schemaVersion: 1, hits: hits.map(hit => ({ ...hit, ordinal: Number(hit.ordinal), rank: Number(hit.rank) })),
      more: rows.length > query.limit, query: term };
  }
}
