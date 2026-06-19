import type { Database } from "./db.js";
import { costFor, type CostResult } from "./model-pricing.js";
import type { TokenTotals } from "./token-analytics.js";

export interface TeamAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
  /** Epoch ms "now" used only for pricing-staleness. */
  now?: number;
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

function addRowCost(acc: CostAccumulator, row: TaskTokenRow, now?: number): void {
  const result = costFor(
    {
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cachedTokens: row.cachedTokens ?? 0,
      cacheWriteTokens: row.cacheWriteTokens ?? 0,
    },
    { provider: row.modelProvider, model: row.modelId },
    now,
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
export function aggregateTeamAnalytics(
  db: Database,
  query: TeamAnalyticsQuery = {},
): TeamAnalytics {
  const summaries = new Map<string, TeamAgentSummary>();
  const costAccumulators = new Map<string, CostAccumulator>();
  const totalTokens = emptyTokenTotals();
  const totalCost = emptyCostAccumulator();

  const agents = db
    .prepare(`SELECT id, name, role, state FROM agents ORDER BY id`)
    .all() as AgentRow[];
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
         modelId
       FROM tasks
       WHERE ${tokenClauses.join(" AND ")}`,
    )
    .all(...tokenParams) as TaskTokenRow[];

  for (const row of tokenRows) {
    const summary = ensureSummary(row.agentId);
    const agentCost = costAccumulators.get(row.agentId) ?? emptyCostAccumulator();
    costAccumulators.set(row.agentId, agentCost);
    addTokenRow(summary.tokens, row);
    addTokenRow(totalTokens, row);
    addRowCost(agentCost, row, query.now);
    addRowCost(totalCost, row, query.now);
  }

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
  for (const row of completedRows) {
    ensureSummary(row.agentId).tasksCompleted = row.count;
  }

  const currentRows = db
    .prepare(
      `SELECT assignedAgentId AS agentId, "column" AS columnName, COUNT(*) AS count
       FROM tasks
       WHERE assignedAgentId IS NOT NULL AND "column" IN ('in-progress', 'in-review')
       GROUP BY assignedAgentId, "column"`,
    )
    .all() as Array<CountByAgentRow & { columnName: string }>;
  for (const row of currentRows) {
    const summary = ensureSummary(row.agentId);
    if (row.columnName === "in-progress") summary.tasksInProgress = row.count;
    if (row.columnName === "in-review") summary.tasksInReview = row.count;
  }

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
