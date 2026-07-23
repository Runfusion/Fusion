import { sql } from "drizzle-orm";
import type { Database } from "../db/db.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { costFor, type CostResult, type ModelPricingOverrides } from "../ai/model-pricing.js";
import type { TokenTotals } from "./token-analytics.js";

export interface TeamAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
  /** Epoch ms "now" used only for pricing-staleness. */
  now?: number;
  /** User-managed pricing overrides that take precedence over the built-in baseline. */
  pricingOverrides?: ModelPricingOverrides;
}

export interface TeamMetricTotals {
  tokens: TokenTotals;
  cost: CostResult;
  filesChanged: number;
  tasksCompleted: number;
  tasksInProgress: number;
  tasksInReview: number;
}

export interface TeamAgentSummary extends TeamMetricTotals {
  agentId: string;
  agentName: string | null;
  role: string | null;
  state: string | null;
}

export interface TeamAnalytics {
  from: string | null;
  to: string | null;
  totals: TeamMetricTotals;
  agents: TeamAgentSummary[];
}

interface AgentRow {
  id: string;
  name: string | null;
  role: string | null;
  state: string | null;
}

interface TaskTokenRow {
  agentId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  modelProvider: string | null;
  modelId: string | null;
  tokenUsageModelProvider: string | null;
  tokenUsageModelId: string | null;
}

interface CountByAgentRow {
  agentId: string;
  count: number;
}

interface ModifiedFilesRow {
  agentId: string;
  modifiedFiles: string | null;
}

function emptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    nTasks: 0,
  };
}

interface CostAccumulator {
  usd: number;
  anyPriced: boolean;
  anyUnavailable: boolean;
  anyStale: boolean;
}

function emptyCostAccumulator(): CostAccumulator {
  return { usd: 0, anyPriced: false, anyUnavailable: false, anyStale: false };
}

function finalizeCost(acc: CostAccumulator): CostResult {
  return {
    usd: acc.anyPriced ? acc.usd : null,
    unavailable: acc.anyUnavailable,
    stale: acc.anyStale,
  };
}

function addTokenRow(totals: TokenTotals, row: TaskTokenRow): void {
  totals.inputTokens += row.inputTokens ?? 0;
  totals.outputTokens += row.outputTokens ?? 0;
  totals.cachedTokens += row.cachedTokens ?? 0;
  totals.cacheWriteTokens += row.cacheWriteTokens ?? 0;
  totals.totalTokens +=
    row.totalTokens ??
    (row.inputTokens ?? 0) +
      (row.outputTokens ?? 0) +
      (row.cachedTokens ?? 0) +
      (row.cacheWriteTokens ?? 0);
  totals.nTasks += 1;
}

function addRowCost(
  acc: CostAccumulator,
  row: TaskTokenRow,
  now?: number,
  pricingOverrides?: ModelPricingOverrides,
): void {
  const result = costFor(
    {
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cachedTokens: row.cachedTokens ?? 0,
      cacheWriteTokens: row.cacheWriteTokens ?? 0,
    },
    {
      /*
       * FNXC:CommandCenter 2026-07-10-08:25:
       * Current runtime usage rows persist the actually-used model in tokenUsageModelProvider/tokenUsageModelId while task-level modelProvider/modelId can stay empty. Team cost analytics must price the usage snapshot first so estimated cost survives model-resolution hierarchy and catalog drift instead of reverting to the unavailable sentinel.
       */
      provider: row.tokenUsageModelProvider ?? row.modelProvider,
      model: row.tokenUsageModelId ?? row.modelId,
    },
    now,
    pricingOverrides,
  );
  if (result.stale) acc.anyStale = true;
  if (result.unavailable || result.usd === null) {
    acc.anyUnavailable = true;
  } else {
    acc.usd += result.usd;
    acc.anyPriced = true;
  }
}

function emptyMetricTotals(): TeamMetricTotals {
  return {
    tokens: emptyTokenTotals(),
    cost: { usd: null, unavailable: false, stale: false },
    filesChanged: 0,
    tasksCompleted: 0,
    tasksInProgress: 0,
    tasksInReview: 0,
  };
}

function countModifiedFiles(value: string | null): number {
  if (!value) return 0;
  let files: unknown;
  try {
    files = JSON.parse(value);
  } catch {
    return 0;
  }
  if (!Array.isArray(files)) return 0;
  let count = 0;
  for (const file of files) {
    if (typeof file === "string" && file.length > 0) count += 1;
  }
  return count;
}

function addRangeClauses(column: string, clauses: string[], params: string[], query: TeamAnalyticsQuery): void {
  if (query.from !== undefined) {
    clauses.push(`${column} >= ?`);
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push(`${column} <= ?`);
    params.push(query.to);
  }
}

function makeSummary(agentId: string, agent?: AgentRow): TeamAgentSummary {
  return {
    agentId,
    agentName: agent?.name ?? null,
    role: agent?.role ?? null,
    state: agent?.state ?? null,
    ...emptyMetricTotals(),
  };
}

/**
 * Aggregate store-derived per-agent Command Center metrics over a date range.
 *
 * FNXC:CommandCenter 2026-06-18-16:57:
 * Team analytics derives per-agent tokens/cost, files changed, and tasks completed from the tasks+agents tables only; no new schema, no GitHub-issue data (that is FN-6653). Keep the aggregator pure/read-only and project-scoped by accepting the already-scoped Database handle from the HTTP layer.
 */
export async function aggregateTeamAnalytics(
  dbOrLayer: Database | AsyncDataLayer,
  query: TeamAnalyticsQuery = {},
): Promise<TeamAnalytics> {
  // FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
  // Backend (PostgreSQL) path. Fetch agents + the four task-derived row sets
  // from schema-qualified project.* tables (snake_case columns; the async
  // connection has no `project` on search_path), then run the identical pure
  // per-agent aggregation as the sync branch via buildTeamAnalytics.
  if ("ping" in dbOrLayer) {
    return aggregateTeamAnalyticsAsync(dbOrLayer, query);
  }
  const db = dbOrLayer as Database;

  const agents = db
    .prepare(`SELECT id, name, role, state FROM agents ORDER BY id`)
    .all() as AgentRow[];

  const tokenClauses = ["assignedAgentId IS NOT NULL", "tokenUsageLastUsedAt IS NOT NULL"];
  const tokenParams: string[] = [];
  addRangeClauses("tokenUsageLastUsedAt", tokenClauses, tokenParams, query);
  const tokenRows = db
    .prepare(
      `SELECT
         assignedAgentId AS agentId,
         tokenUsageInputTokens AS inputTokens,
         tokenUsageOutputTokens AS outputTokens,
         tokenUsageCachedTokens AS cachedTokens,
         tokenUsageCacheWriteTokens AS cacheWriteTokens,
         tokenUsageTotalTokens AS totalTokens,
         modelProvider,
         modelId,
         tokenUsageModelProvider,
         tokenUsageModelId
       FROM tasks
       WHERE ${tokenClauses.join(" AND ")}`,
    )
    .all(...tokenParams) as TaskTokenRow[];

  const completedClauses = ["assignedAgentId IS NOT NULL", `"column" = 'done'`, "columnMovedAt IS NOT NULL"];
  const completedParams: string[] = [];
  addRangeClauses("columnMovedAt", completedClauses, completedParams, query);
  const completedRows = db
    .prepare(
      `SELECT assignedAgentId AS agentId, COUNT(*) AS count
       FROM tasks
       WHERE ${completedClauses.join(" AND ")}
       GROUP BY assignedAgentId`,
    )
    .all(...completedParams) as CountByAgentRow[];

  const currentRows = db
    .prepare(
      `SELECT assignedAgentId AS agentId, "column" AS columnName, COUNT(*) AS count
       FROM tasks
       WHERE assignedAgentId IS NOT NULL AND "column" IN ('in-progress', 'in-review')
       GROUP BY assignedAgentId, "column"`,
    )
    .all() as Array<CountByAgentRow & { columnName: string }>;

  const filesClauses = ["assignedAgentId IS NOT NULL", "modifiedFiles IS NOT NULL", "modifiedFiles NOT IN ('', '[]')"];
  const filesParams: string[] = [];
  addRangeClauses("updatedAt", filesClauses, filesParams, query);
  const fileRows = db
    .prepare(
      `SELECT assignedAgentId AS agentId, modifiedFiles
       FROM tasks
       WHERE ${filesClauses.join(" AND ")}`,
    )
    .all(...filesParams) as ModifiedFilesRow[];

  return buildTeamAnalytics(agents, tokenRows, completedRows, currentRows, fileRows, query);
}

/**
 * FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
 * PostgreSQL fetch path for {@link aggregateTeamAnalytics}. Modified-files is
 * jsonb (postgres-js returns it parsed), so countModifiedFiles receives a
 * re-stringified value to keep the legacy JSON.parse path identical.
 */
async function aggregateTeamAnalyticsAsync(
  layer: AsyncDataLayer,
  query: TeamAnalyticsQuery,
): Promise<TeamAnalytics> {
  const agents = (await layer.db.execute(
    sql`SELECT id, name, role, state FROM project.agents ORDER BY id`,
  )) as unknown as AgentRow[];

  const tokFrom = query.from !== undefined ? sql`AND token_usage_last_used_at >= ${query.from}` : sql``;
  const tokTo = query.to !== undefined ? sql`AND token_usage_last_used_at <= ${query.to}` : sql``;
  const tokenRowsRaw = (await layer.db.execute(
    sql`SELECT
          assigned_agent_id               AS "agentId",
          token_usage_input_tokens        AS "inputTokens",
          token_usage_output_tokens       AS "outputTokens",
          token_usage_cached_tokens       AS "cachedTokens",
          token_usage_cache_write_tokens  AS "cacheWriteTokens",
          token_usage_total_tokens        AS "totalTokens",
          model_provider                  AS "modelProvider",
          model_id                        AS "modelId",
          token_usage_model_provider      AS "tokenUsageModelProvider",
          token_usage_model_id            AS "tokenUsageModelId"
        FROM project.tasks
        WHERE assigned_agent_id IS NOT NULL AND token_usage_last_used_at IS NOT NULL ${tokFrom} ${tokTo}`,
  )) as Array<Record<string, unknown>>;
  const tokenRows: TaskTokenRow[] = tokenRowsRaw.map((r) => ({
    agentId: String(r.agentId),
    inputTokens: r.inputTokens == null ? null : Number(r.inputTokens),
    outputTokens: r.outputTokens == null ? null : Number(r.outputTokens),
    cachedTokens: r.cachedTokens == null ? null : Number(r.cachedTokens),
    cacheWriteTokens: r.cacheWriteTokens == null ? null : Number(r.cacheWriteTokens),
    totalTokens: r.totalTokens == null ? null : Number(r.totalTokens),
    modelProvider: (r.modelProvider as string | null) ?? null,
    modelId: (r.modelId as string | null) ?? null,
    tokenUsageModelProvider: (r.tokenUsageModelProvider as string | null) ?? null,
    tokenUsageModelId: (r.tokenUsageModelId as string | null) ?? null,
  }));

  const compFrom = query.from !== undefined ? sql`AND column_moved_at >= ${query.from}` : sql``;
  const compTo = query.to !== undefined ? sql`AND column_moved_at <= ${query.to}` : sql``;
  const completedRows = (await layer.db.execute(
    sql`SELECT assigned_agent_id AS "agentId", count(*)::int AS count
        FROM project.tasks
        WHERE assigned_agent_id IS NOT NULL AND "column" = 'done' AND column_moved_at IS NOT NULL ${compFrom} ${compTo}
        GROUP BY assigned_agent_id`,
  )) as unknown as CountByAgentRow[];

  const currentRows = (await layer.db.execute(
    sql`SELECT assigned_agent_id AS "agentId", "column" AS "columnName", count(*)::int AS count
        FROM project.tasks
        WHERE assigned_agent_id IS NOT NULL AND "column" IN ('in-progress', 'in-review')
        GROUP BY assigned_agent_id, "column"`,
  )) as unknown as Array<CountByAgentRow & { columnName: string }>;

  const filesFrom = query.from !== undefined ? sql`AND updated_at >= ${query.from}` : sql``;
  const filesTo = query.to !== undefined ? sql`AND updated_at <= ${query.to}` : sql``;
  const fileRowsRaw = (await layer.db.execute(
    sql`SELECT assigned_agent_id AS "agentId", modified_files AS "modifiedFiles"
        FROM project.tasks
        WHERE assigned_agent_id IS NOT NULL
          AND modified_files IS NOT NULL
          AND jsonb_typeof(modified_files) = 'array'
          AND jsonb_array_length(modified_files) > 0
          ${filesFrom} ${filesTo}`,
  )) as Array<{ agentId: string; modifiedFiles: unknown }>;
  const fileRows: ModifiedFilesRow[] = fileRowsRaw.map((r) => ({
    agentId: String(r.agentId),
    modifiedFiles: r.modifiedFiles == null ? null : JSON.stringify(r.modifiedFiles),
  }));

  return buildTeamAnalytics(agents, tokenRows, completedRows, currentRows, fileRows, query);
}

/**
 * FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
 * Pure per-agent aggregation shared by the sync (SQLite) and async (PostgreSQL)
 * paths of {@link aggregateTeamAnalytics}. No I/O — takes already-fetched rows.
 */
function buildTeamAnalytics(
  agents: AgentRow[],
  tokenRows: TaskTokenRow[],
  completedRows: CountByAgentRow[],
  currentRows: Array<CountByAgentRow & { columnName: string }>,
  fileRows: ModifiedFilesRow[],
  query: TeamAnalyticsQuery,
): TeamAnalytics {
  const summaries = new Map<string, TeamAgentSummary>();
  const costAccumulators = new Map<string, CostAccumulator>();
  const totalTokens = emptyTokenTotals();
  const totalCost = emptyCostAccumulator();
  const pricingOverrides = query.pricingOverrides;

  for (const agent of agents) {
    summaries.set(agent.id, makeSummary(agent.id, agent));
    costAccumulators.set(agent.id, emptyCostAccumulator());
  }

  const ensureSummary = (agentId: string): TeamAgentSummary => {
    const existing = summaries.get(agentId);
    if (existing) return existing;
    const created = makeSummary(agentId);
    summaries.set(agentId, created);
    costAccumulators.set(agentId, emptyCostAccumulator());
    return created;
  };

  for (const row of tokenRows) {
    const summary = ensureSummary(row.agentId);
    const agentCost = costAccumulators.get(row.agentId) ?? emptyCostAccumulator();
    costAccumulators.set(row.agentId, agentCost);
    addTokenRow(summary.tokens, row);
    addTokenRow(totalTokens, row);
    addRowCost(agentCost, row, query.now, pricingOverrides);
    addRowCost(totalCost, row, query.now, pricingOverrides);
  }

  for (const row of completedRows) {
    ensureSummary(row.agentId).tasksCompleted = row.count;
  }

  for (const row of currentRows) {
    const summary = ensureSummary(row.agentId);
    if (row.columnName === "in-progress") summary.tasksInProgress = row.count;
    if (row.columnName === "in-review") summary.tasksInReview = row.count;
  }

  for (const row of fileRows) {
    ensureSummary(row.agentId).filesChanged += countModifiedFiles(row.modifiedFiles);
  }

  for (const [agentId, summary] of summaries) {
    summary.cost = finalizeCost(costAccumulators.get(agentId) ?? emptyCostAccumulator());
  }

  let filesChanged = 0;
  let tasksCompleted = 0;
  let tasksInProgress = 0;
  let tasksInReview = 0;
  for (const summary of summaries.values()) {
    filesChanged += summary.filesChanged;
    tasksCompleted += summary.tasksCompleted;
    tasksInProgress += summary.tasksInProgress;
    tasksInReview += summary.tasksInReview;
  }

  const sortedAgents = [...summaries.values()].sort((a, b) => {
    const tokenCmp = b.tokens.totalTokens - a.tokens.totalTokens;
    if (tokenCmp !== 0) return tokenCmp;
    return a.agentId.localeCompare(b.agentId);
  });

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    totals: {
      tokens: totalTokens,
      cost: finalizeCost(totalCost),
      filesChanged,
      tasksCompleted,
      tasksInProgress,
      tasksInReview,
    },
    agents: sortedAgents,
  };
}
