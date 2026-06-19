import type { Database } from "./db.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "./builtin-coding-workflow-ir.js";
import type { WorkflowIrColumn } from "./workflow-ir-types.js";

/**
 * Activity analytics: distinct active nodes/agents per day, sessions, messages,
 * and stickiness (DAU/MAU) over an arbitrary date range.
 *
 * Sessions come from `cli_sessions` (by `createdAt`); messages and node/agent
 * activity come from `usage_events`. Inclusivity: `from`/`to` are inclusive,
 * matching `usage-events.ts`.
 *
 * **MTTR (U13).** Mean-time-to-resolve is computed over the `incidents` table
 * introduced by U13: MTTR = mean(resolvedAt − openedAt) across incidents whose
 * `resolvedAt` falls within the range. Unresolved incidents contribute to
 * "open incidents", not to MTTR. Deployment frequency comes from the
 * `deployments` table. See {@link MttrSummary} and {@link MonitorMetrics}.
 */

export interface ActivityAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
}

/** Distinct active nodes/agents, messages, and agent-run count for a single UTC day. */
export interface DailyActivity {
  /** UTC date, `YYYY-MM-DD`. */
  day: string;
  activeNodes: number;
  activeAgents: number;
  messages: number;
  /** Agent heartbeat runs started on this UTC day. */
  agentRuns: number;
}

/** Agent heartbeat-run counts over an activity range, grouped by canonical status. */
export interface AgentRunSummary {
  total: number;
  active: number;
  completed: number;
  failed: number;
}

/**
 * MTTR summary. `value` is the mean minutes to resolve across incidents whose
 * `resolvedAt` falls in the range. When no incident has been resolved in range
 * MTTR cannot be computed: `value` is `null` and `unavailable` is `true`, never
 * `0`. The `sampleCount` is the number of resolved incidents the mean is over.
 */
export interface MttrSummary {
  /** Mean minutes to resolve; null when no resolved incident exists in range. */
  value: number | null;
  /** True when MTTR cannot be computed (no resolved incidents in range). */
  unavailable: boolean;
  /** Number of resolved incidents the mean is computed over. */
  sampleCount: number;
}

/**
 * Monitor-stage metrics (U13): MTTR plus deployment / incident counts that feed
 * the Command Center's External Signals area and the Monitor surface. All counts
 * are over the same date range as the parent activity query.
 */
export interface MonitorMetrics {
  /** Mean-time-to-resolve over incidents resolved in range. */
  mttr: MttrSummary;
  /** Incidents opened (by `openedAt`) within the range. */
  incidentsOpened: number;
  /** Incidents resolved (by `resolvedAt`) within the range. */
  incidentsResolved: number;
  /** Incidents currently in the `open` state (point-in-time, not range-bound). */
  openIncidents: number;
  /** Deployments recorded (by `deployedAt`) within the range — deploy frequency. */
  deployments: number;
}

export interface ActivityAnalytics {
  from: string | null;
  to: string | null;
  /** Total `session_start` events from `cli_sessions` in range. */
  sessions: number;
  /** Total `user_message` events in range. */
  messages: number;
  /** Distinct nodes with any usage_event in range. */
  activeNodes: number;
  /** Distinct agents with any usage_event in range. */
  activeAgents: number;
  /** Agent heartbeat runs started in range, grouped by status. */
  agentRuns: AgentRunSummary;
  /** Per-day breakdown, ascending by day. */
  daily: DailyActivity[];
  /**
   * Stickiness = DAU/MAU. DAU = mean distinct-active-agents-per-day over the
   * range; MAU = distinct active agents over the whole range. 0 when MAU is 0.
   */
  stickiness: number;
  /** MTTR over incidents resolved in range (U13). */
  mttr: MttrSummary;
  /** Full monitor-stage metrics (MTTR + deploy/incident counts) (U13). */
  monitor: MonitorMetrics;
  /** SDLC funnel + throughput over the same range (U7). */
  funnel: SdlcFunnel;
}

interface CountRow {
  count: number;
}

interface DistinctRow {
  count: number;
}

interface DayAggRow {
  day: string;
  activeNodes: number;
  activeAgents: number;
  messages: number;
}

interface AgentRunStatusRow {
  status: string;
  count: number;
}

interface AgentRunDayRow {
  day: string;
  count: number;
}

function rangeClauses(
  column: string,
  query: ActivityAnalyticsQuery,
): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (query.from !== undefined) {
    clauses.push(`${column} >= ?`);
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push(`${column} <= ?`);
    params.push(query.to);
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

/**
 * Aggregate activity (sessions, messages, active nodes/agents, daily breakdown,
 * stickiness) over a date range. Empty range yields zeroed structures and an
 * empty `daily` array — never nulls. `mttr` is the U13 unavailable seam.
 */
export function aggregateActivityAnalytics(
  db: Database,
  query: ActivityAnalyticsQuery = {},
): ActivityAnalytics {
  // Sessions from cli_sessions (by createdAt).
  const sessionRange = rangeClauses("createdAt", query);
  const sessions = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM cli_sessions ${sessionRange.where}`)
      .get(...sessionRange.params) as CountRow
  ).count;

  // Messages from usage_events (kind = user_message).
  const eventRange = rangeClauses("ts", query);
  const eventWhereWith = (extra: string): string =>
    eventRange.where
      ? `${eventRange.where} AND ${extra}`
      : `WHERE ${extra}`;

  const messages = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM usage_events ${eventWhereWith("kind = 'user_message'")}`,
      )
      .get(...eventRange.params) as CountRow
  ).count;

  // Distinct active nodes/agents over the whole range.
  const activeNodes = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT nodeId) AS count FROM usage_events ${eventWhereWith("nodeId IS NOT NULL")}`,
      )
      .get(...eventRange.params) as DistinctRow
  ).count;
  const activeAgents = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT agentId) AS count FROM usage_events ${eventWhereWith("agentId IS NOT NULL")}`,
      )
      .get(...eventRange.params) as DistinctRow
  ).count;

  // Per-day distinct nodes/agents + message count. substr(ts,1,10) is the UTC
  // day key (ISO-8601 timestamps).
  const dailyRows = db
    .prepare(
      `SELECT
         substr(ts, 1, 10) AS day,
         COUNT(DISTINCT nodeId) AS activeNodes,
         COUNT(DISTINCT agentId) AS activeAgents,
         SUM(CASE WHEN kind = 'user_message' THEN 1 ELSE 0 END) AS messages
       FROM usage_events ${eventRange.where}
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(...eventRange.params) as DayAggRow[];
  /**
   * FNXC:CommandCenter 2026-06-18-00:00:
   * Command Center activity analytics must surface agent heartbeat-run volume as stat cards by status and as a per-day trend without requiring a schema migration or new endpoint. Count by agentRuns.startedAt in the selected range, and degrade to zeros when older databases do not have the table.
   */
  const agentRunMetrics = aggregateAgentRunMetrics(db, query);
  const dailyByDay = new Map<string, DailyActivity>();
  for (const r of dailyRows) {
    dailyByDay.set(r.day, {
      day: r.day,
      activeNodes: r.activeNodes,
      activeAgents: r.activeAgents,
      messages: r.messages ?? 0,
      agentRuns: 0,
    });
  }
  for (const r of agentRunMetrics.daily) {
    const existing = dailyByDay.get(r.day);
    if (existing) {
      existing.agentRuns = r.count;
    } else {
      dailyByDay.set(r.day, {
        day: r.day,
        activeNodes: 0,
        activeAgents: 0,
        messages: 0,
        agentRuns: r.count,
      });
    }
  }
  const daily: DailyActivity[] = [...dailyByDay.values()].sort((a, b) => a.day.localeCompare(b.day));

  // Stickiness = DAU/MAU. DAU = mean distinct-active-agents-per-day; MAU =
  // distinct active agents over the range.
  const dau =
    daily.length > 0
      ? daily.reduce((sum, d) => sum + d.activeAgents, 0) / daily.length
      : 0;
  const mau = activeAgents;
  const stickiness = mau > 0 ? dau / mau : 0;

  // U13: real monitor metrics over the incidents/deployments tables.
  const monitor = aggregateMonitorMetrics(db, query);

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    sessions,
    messages,
    activeNodes,
    activeAgents,
    agentRuns: agentRunMetrics.summary,
    daily,
    stickiness,
    mttr: monitor.mttr,
    monitor,
    // U7 seam: SDLC funnel/throughput over the same range, mapped by workflow
    // trait. Uses the built-in workflow's column→trait mapping by default;
    // callers with a custom workflow IR should call aggregateSdlcFunnel directly
    // with that workflow's columns so custom column ids map correctly.
    funnel: aggregateSdlcFunnel(db, query),
  };
}

function zeroAgentRunSummary(): AgentRunSummary {
  return { total: 0, active: 0, completed: 0, failed: 0 };
}

function aggregateAgentRunMetrics(
  db: Database,
  query: ActivityAnalyticsQuery,
): { summary: AgentRunSummary; daily: AgentRunDayRow[] } {
  if (!tableExists(db, "agentRuns")) {
    return { summary: zeroAgentRunSummary(), daily: [] };
  }

  const range = rangeClauses("startedAt", query);
  const statusRows = db
    .prepare(
      `SELECT status, COUNT(*) AS count
       FROM agentRuns ${range.where}
       GROUP BY status`,
    )
    .all(...range.params) as AgentRunStatusRow[];

  const summary = zeroAgentRunSummary();
  for (const row of statusRows) {
    summary.total += row.count;
    if (row.status === "active") summary.active = row.count;
    if (row.status === "completed") summary.completed = row.count;
    if (row.status === "failed") summary.failed = row.count;
  }

  const daily = db
    .prepare(
      `SELECT substr(startedAt, 1, 10) AS day, COUNT(*) AS count
       FROM agentRuns ${range.where}
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(...range.params) as AgentRunDayRow[];

  return { summary, daily };
}

/* ------------------------------------------------------------------------- */
/* U7 — SDLC funnel + throughput                                             */
/* ------------------------------------------------------------------------- */

/**
 * The canonical SDLC funnel stages, in flow order. Workflow columns map onto
 * these by **trait**, never by column id/name, so custom workflows whose columns
 * carry the standard traits are placed correctly; anything unrecognized folds
 * into {@link OTHER_STAGE}.
 */
export const SDLC_STAGES = [
  "triage",
  "todo",
  "in-progress",
  "in-review",
  "done",
] as const;
export type SdlcStage = (typeof SDLC_STAGES)[number];

/** Bucket for columns whose traits don't map to a known SDLC stage. */
export const OTHER_STAGE = "other" as const;
export type SdlcStageKey = SdlcStage | typeof OTHER_STAGE;

/**
 * Trait → stage mapping. A column is placed at the first stage any of its traits
 * matches, scanning in {@link SDLC_STAGES} order so e.g. an `in-review` column
 * carrying both `human-review` and `merge` resolves deterministically. Keep this
 * additive: new workflow traits that imply a stage are added here, not matched by
 * column name.
 */
const TRAIT_TO_STAGE: Record<string, SdlcStage> = {
  // triage
  intake: "triage",
  triage: "triage",
  // todo
  "reset-on-entry": "todo",
  // in-progress
  wip: "in-progress",
  timing: "in-progress",
  "abort-on-exit": "in-progress",
  // in-review
  "human-review": "in-review",
  "merge-blocker": "in-review",
  merge: "in-review",
  "stall-detection": "in-review",
  // done
  complete: "done",
};

/** Resolve a column's traits to an SDLC stage, or OTHER if none map. */
export function stageForTraits(traits: readonly string[]): SdlcStageKey {
  // Prefer the earliest stage in flow order among matching traits so a column is
  // anchored to its most representative stage deterministically.
  let best: SdlcStage | undefined;
  let bestIdx = Number.POSITIVE_INFINITY;
  for (const t of traits) {
    const stage = TRAIT_TO_STAGE[t];
    if (stage === undefined) continue;
    const idx = SDLC_STAGES.indexOf(stage);
    if (idx < bestIdx) {
      bestIdx = idx;
      best = stage;
    }
  }
  return best ?? OTHER_STAGE;
}

/** Minimal column shape needed to map columns to stages by trait. */
export interface FunnelColumnTraitSource {
  id: string;
  traits: { trait: string }[];
}

/**
 * Build a `columnId → stage` map from a workflow's columns, mapping each column
 * by its traits (not its id/name). The `todo` builtin column carries `hold`
 * (a generic gate trait shared by other columns) so we special-case the
 * presence of `reset-on-entry` for todo above; columns with no recognized trait
 * fold to OTHER.
 */
export function buildColumnStageMap(
  columns: readonly FunnelColumnTraitSource[],
): Map<string, SdlcStageKey> {
  const map = new Map<string, SdlcStageKey>();
  for (const col of columns) {
    map.set(
      col.id,
      stageForTraits(col.traits.map((t) => t.trait)),
    );
  }
  return map;
}

export interface SdlcFunnelQuery extends ActivityAnalyticsQuery {
  /**
   * Workflow columns to map by trait. Defaults to the built-in coding workflow's
   * columns. Pass a custom workflow's columns so its column ids resolve; any
   * column id seen in the activity log but absent here folds into OTHER.
   */
  columns?: readonly FunnelColumnTraitSource[];
}

/** Per-stage funnel datum. */
export interface SdlcFunnelStage {
  stage: SdlcStageKey;
  /** Distinct tasks that entered this stage within the range. */
  entered: number;
  /**
   * Conversion from the previous SDLC stage (entered / prevEntered) as a 0..1
   * ratio. `null` for the first stage and when the previous stage had zero
   * entrants (no divide-by-zero). `other` is excluded from conversion chaining.
   */
  conversionFromPrev: number | null;
}

export interface SdlcFunnel {
  from: string | null;
  to: string | null;
  stages: SdlcFunnelStage[];
  /** Distinct tasks that entered the first (triage) stage's pipeline in range. */
  enteredInRange: number;
  /** Distinct tasks that reached `done` in range. */
  doneInRange: number;
  /**
   * Cohort completion rate for tasks that entered triage in range: count of
   * those entrants that also reached `done`, divided by `enteredInRange`.
   * Bounded to the 0..1 conversion ratio by set intersection; `null` when the
   * denominator is zero (documented zero-denominator case), never NaN/∞.
   */
  completionRate: number | null;
  /** Number of whole UTC days in the range (>= 1), used for throughput. */
  rangeDays: number;
  /** Tasks reaching `done` per day = doneInRange / rangeDays. */
  throughputPerDay: number;
}

interface MoveRow {
  taskId: string | null;
  to: string | null;
  ts: string;
}

function defaultColumns(): FunnelColumnTraitSource[] {
  const ir = BUILTIN_CODING_WORKFLOW_IR;
  if (ir.version === "v2") {
    return (ir.columns as WorkflowIrColumn[]).map((c) => ({
      id: c.id,
      traits: c.traits.map((t) => ({ trait: t.trait })),
    }));
  }
  return [];
}

function countWholeDays(from?: string, to?: string): number {
  if (from === undefined || to === undefined) return 1;
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (!Number.isFinite(f) || !Number.isFinite(t) || t < f) return 1;
  const ms = t - f;
  const days = Math.ceil(ms / 86_400_000);
  return Math.max(1, days);
}

/**
 * Aggregate the SDLC funnel over a date range from `activityLog` transitions.
 *
 * **Entry into a stage** = a `task:moved` whose `metadata.to` column maps to that
 * stage, OR a `task:created` whose initial column maps to it. Counts are distinct
 * tasks per stage (a task that re-enters a stage is counted once). Columns map to
 * stages **by trait** via {@link buildColumnStageMap}; unknown columns fold to
 * OTHER. Completion rate divides done-in-range by entered-in-range with the
 * zero-denominator case returning `null`.
 */
export function aggregateSdlcFunnel(
  db: Database,
  query: SdlcFunnelQuery = {},
): SdlcFunnel {
  const columns = query.columns ?? defaultColumns();
  const stageMap = buildColumnStageMap(columns);
  const stageOf = (columnId: string | null): SdlcStageKey => {
    if (columnId === null) return OTHER_STAGE;
    return stageMap.get(columnId) ?? OTHER_STAGE;
  };

  const range = rangeClauses("timestamp", query);
  const where = range.where
    ? `${range.where} AND type = 'task:moved'`
    : `WHERE type = 'task:moved'`;

  // task:moved carries metadata.to (the destination column id). The funnel is
  // driven entirely by transitions — a task entering a stage is a move whose
  // destination column maps to that stage. (task:created carries no column in
  // metadata, so it is intentionally excluded; the first move records entry.)
  const rows = db
    .prepare(
      `SELECT taskId,
              json_extract(metadata, '$.to') AS "to",
              timestamp AS ts
       FROM activityLog ${where}`,
    )
    .all(...range.params) as MoveRow[];

  // Distinct tasks per stage.
  const perStage = new Map<SdlcStageKey, Set<string>>();
  const ensure = (s: SdlcStageKey): Set<string> => {
    let set = perStage.get(s);
    if (!set) {
      set = new Set();
      perStage.set(s, set);
    }
    return set;
  };

  for (const row of rows) {
    if (row.taskId === null) continue;
    const stage = stageOf(row.to);
    ensure(stage).add(row.taskId);
  }

  const stages: SdlcFunnelStage[] = [];
  let prevEntered: number | null = null;
  for (const stage of SDLC_STAGES) {
    const entered = perStage.get(stage)?.size ?? 0;
    const conversionFromPrev =
      prevEntered === null || prevEntered === 0 ? null : entered / prevEntered;
    stages.push({ stage, entered, conversionFromPrev });
    prevEntered = entered;
  }
  // Append OTHER as a trailing, non-chained bucket if anything landed there.
  const otherCount = perStage.get(OTHER_STAGE)?.size ?? 0;
  if (otherCount > 0) {
    stages.push({ stage: OTHER_STAGE, entered: otherCount, conversionFromPrev: null });
  }

  // Entered-in-range = distinct tasks that entered the FIRST funnel stage
  // (triage) in range. doneInRange remains every task that reached done in range.
  const triageEntrants = perStage.get("triage") ?? new Set<string>();
  const doneEntrants = perStage.get("done") ?? new Set<string>();
  const enteredInRange = triageEntrants.size;
  const doneInRange = doneEntrants.size;
  /*
  FNXC:CommandCenter 2026-06-18-00:00:
  Completion rate must be a cohort conversion, not done-in-range divided by triage-in-range. Tasks can finish inside a date range after entering triage before the range (or never entering triage), so intersecting the in-range triage cohort with done tasks keeps the dashboard and OTEL metric trustable at 0..1 or null.
  */
  const completedTriageEntrants = Array.from(triageEntrants).filter((taskId) =>
    doneEntrants.has(taskId),
  ).length;
  const completionRate =
    enteredInRange === 0 ? null : completedTriageEntrants / enteredInRange;

  const rangeDays = countWholeDays(query.from, query.to);
  const throughputPerDay = doneInRange / rangeDays;

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    stages,
    enteredInRange,
    doneInRange,
    completionRate,
    rangeDays,
    throughputPerDay,
  };
}

/* ------------------------------------------------------------------------- */
/* U13 — Monitor stage: MTTR + deploy/incident metrics                       */
/* ------------------------------------------------------------------------- */

interface ResolvedIncidentRow {
  openedAt: string;
  resolvedAt: string;
}

/**
 * Aggregate monitor-stage metrics over a date range from the `incidents` and
 * `deployments` tables (U13).
 *
 * - **MTTR** = mean(resolvedAt − openedAt), in minutes, over incidents whose
 *   `resolvedAt` is within `[from, to]`. An incident with no `resolvedAt`
 *   (still open) is excluded — it contributes to {@link MonitorMetrics.openIncidents},
 *   never to MTTR. When no incident is resolved in range, MTTR is the documented
 *   unavailable sentinel (`value: null`, `unavailable: true`), never `0`.
 * - **incidentsOpened** counts incidents by `openedAt` in range.
 * - **incidentsResolved** counts incidents by `resolvedAt` in range.
 * - **openIncidents** is the current count of `status = 'open'` incidents
 *   (point-in-time, deliberately not range-bound — "how many are open now").
 * - **deployments** counts deploys by `deployedAt` in range (deploy frequency).
 *
 * Tables are queried defensively: if `incidents`/`deployments` are absent (a DB
 * predating migration 120), every metric degrades to its empty value rather than
 * throwing, so the aggregator is safe to call on any schema.
 */
export function aggregateMonitorMetrics(
  db: Database,
  query: ActivityAnalyticsQuery = {},
): MonitorMetrics {
  if (!tableExists(db, "incidents")) {
    return {
      mttr: { value: null, unavailable: true, sampleCount: 0 },
      incidentsOpened: 0,
      incidentsResolved: 0,
      openIncidents: 0,
      deployments: tableExists(db, "deployments")
        ? countDeployments(db, query)
        : 0,
    };
  }

  const openedRange = rangeClauses("openedAt", query);
  const incidentsOpened = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM incidents ${openedRange.where}`)
      .get(...openedRange.params) as CountRow
  ).count;

  // Resolved-in-range: resolvedAt within [from,to]. Build clauses on resolvedAt
  // plus a NOT NULL guard so unresolved incidents are excluded from MTTR.
  const resolvedRange = rangeClauses("resolvedAt", query);
  const resolvedWhere = resolvedRange.where
    ? `${resolvedRange.where} AND resolvedAt IS NOT NULL`
    : `WHERE resolvedAt IS NOT NULL`;

  const incidentsResolved = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM incidents ${resolvedWhere}`)
      .get(...resolvedRange.params) as CountRow
  ).count;

  const openIncidents = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM incidents WHERE status = 'open'`)
      .get() as CountRow
  ).count;

  const resolvedRows = db
    .prepare(
      `SELECT openedAt, resolvedAt FROM incidents ${resolvedWhere}`,
    )
    .all(...resolvedRange.params) as ResolvedIncidentRow[];

  let totalMs = 0;
  let sampleCount = 0;
  for (const row of resolvedRows) {
    const opened = Date.parse(row.openedAt);
    const resolved = Date.parse(row.resolvedAt);
    if (!Number.isFinite(opened) || !Number.isFinite(resolved)) continue;
    const delta = resolved - opened;
    if (delta < 0) continue; // guard against clock skew / bad data
    totalMs += delta;
    sampleCount += 1;
  }

  const mttr: MttrSummary =
    sampleCount === 0
      ? { value: null, unavailable: true, sampleCount: 0 }
      : { value: totalMs / sampleCount / 60_000, unavailable: false, sampleCount };

  return {
    mttr,
    incidentsOpened,
    incidentsResolved,
    openIncidents,
    deployments: tableExists(db, "deployments")
      ? countDeployments(db, query)
      : 0,
  };
}

function countDeployments(db: Database, query: ActivityAnalyticsQuery): number {
  const range = rangeClauses("deployedAt", query);
  return (
    db
      .prepare(`SELECT COUNT(*) AS count FROM deployments ${range.where}`)
      .get(...range.params) as CountRow
  ).count;
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}
