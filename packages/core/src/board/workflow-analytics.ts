import { sql } from "drizzle-orm";
import type { Database } from "../db/db.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { BUILTIN_WORKFLOWS, getBuiltinWorkflow, isBuiltinWorkflowId } from "../workflows/builtin-workflows.js";
import { costFor, type CostResult, type ModelPricingOverrides } from "../ai/model-pricing.js";
import type { TokenTotals } from "./token-analytics.js";

export interface WorkflowAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
  /** Epoch ms "now" used only for pricing-staleness. */
  now?: number;
  /** User-managed pricing overrides that take precedence over the built-in baseline. */
  pricingOverrides?: ModelPricingOverrides;
  /** Workflow id used for tasks without an explicit task_workflow_selection row. */
  defaultWorkflowId?: string;
}

export interface WorkflowMetricTotals {
  tokens: TokenTotals;
  cost: CostResult;
  filesChanged: number;
  tasksCompleted: number;
  tasksInProgress: number;
  tasksInReview: number;
}

export interface WorkflowSummary extends WorkflowMetricTotals {
  workflowId: string;
  workflowName: string;
  workflowIcon?: string;
  isBuiltin: boolean;
}

export interface WorkflowAnalytics {
  from: string | null;
  to: string | null;
  totals: WorkflowMetricTotals;
  workflows: WorkflowSummary[];
}

interface WorkflowNameRow {
  id: string;
  name: string | null;
  icon: string | null;
}

interface TaskTokenRow {
  workflowId: string;
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

interface CountByWorkflowRow {
  workflowId: string;
  count: number;
}

interface ModifiedFilesRow {
  workflowId: string;
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
       * Workflow cost analytics must mirror token analytics by pricing the actually-used token-usage model snapshot before legacy task model columns. FN-7757's static catalog rows could not help rows whose legacy model columns are NULL, so this fixes the durable resolution path without guessing prices for unknown models.
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

function emptyMetricTotals(): WorkflowMetricTotals {
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

function addRangeClauses(column: string, clauses: string[], params: string[], query: WorkflowAnalyticsQuery): void {
  if (query.from !== undefined) {
    clauses.push(`${column} >= ?`);
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push(`${column} <= ?`);
    params.push(query.to);
  }
}

/** Resolve a workflow's display name + builtin flag from a name lookup. */
type WorkflowNameResolver = (workflowId: string) => { workflowName: string; workflowIcon?: string; isBuiltin: boolean };

function resolveWorkflowNameSync(db: Database, workflowId: string): { workflowName: string; workflowIcon?: string; isBuiltin: boolean } {
  const builtin = getBuiltinWorkflow(workflowId) ?? BUILTIN_WORKFLOWS.find((workflow) => workflow.id === workflowId);
  if (builtin) return { workflowName: builtin.name, isBuiltin: true };
  const row = db.prepare("SELECT id, name, icon FROM workflows WHERE id = ?").get(workflowId) as WorkflowNameRow | undefined;
  return {
    workflowName: row?.name && row.name.length > 0 ? row.name : workflowId,
    ...(row?.icon && row.icon.length > 0 ? { workflowIcon: row.icon } : {}),
    isBuiltin: isBuiltinWorkflowId(workflowId),
  };
}

/**
 * FNXC:PostgresCommandCenterAnalytics 2026-06-28-09:30:
 * Async (PostgreSQL) name resolver. Workflow names are prefetched once from
 * project.workflows into a Map (the async connection cannot issue per-id sync
 * prepared reads), so per-workflow name resolution is an in-memory lookup that
 * mirrors resolveWorkflowNameSync's builtin-first / NULLIF-empty fallback.
 */
function resolveWorkflowNameFromMap(
  names: Map<string, string>,
  workflowId: string,
): { workflowName: string; isBuiltin: boolean } {
  const builtin = getBuiltinWorkflow(workflowId) ?? BUILTIN_WORKFLOWS.find((workflow) => workflow.id === workflowId);
  if (builtin) return { workflowName: builtin.name, isBuiltin: true };
  const name = names.get(workflowId);
  return {
    workflowName: name && name.length > 0 ? name : workflowId,
    isBuiltin: isBuiltinWorkflowId(workflowId),
  };
}

function makeSummary(resolveName: WorkflowNameResolver, workflowId: string): WorkflowSummary {
  return {
    workflowId,
    ...resolveName(workflowId),
    ...emptyMetricTotals(),
  };
}

/** Pre-fetched per-workflow row sets shared by the sync + async aggregation. */
interface WorkflowAnalyticsRows {
  tokenRows: TaskTokenRow[];
  completedRows: CountByWorkflowRow[];
  currentRows: Array<CountByWorkflowRow & { columnName: string }>;
  fileRows: ModifiedFilesRow[];
}

/**
 * FNXC:PostgresCommandCenterAnalytics 2026-06-28-09:30:
 * Pure per-workflow aggregation shared by the sync (SQLite) and async
 * (PostgreSQL) fetch paths. No I/O — takes already-fetched row sets and a name
 * resolver, so both backends produce byte-identical totals/sorting/cost
 * semantics.
 */
function buildWorkflowAnalytics(
  rows: WorkflowAnalyticsRows,
  query: WorkflowAnalyticsQuery,
  resolveName: WorkflowNameResolver,
): WorkflowAnalytics {
  const summaries = new Map<string, WorkflowSummary>();
  const costAccumulators = new Map<string, CostAccumulator>();
  const totalTokens = emptyTokenTotals();
  const totalCost = emptyCostAccumulator();
  const pricingOverrides = query.pricingOverrides;

  const ensureSummary = (workflowId: string): WorkflowSummary => {
    const existing = summaries.get(workflowId);
    if (existing) return existing;
    const created = makeSummary(resolveName, workflowId);
    summaries.set(workflowId, created);
    costAccumulators.set(workflowId, emptyCostAccumulator());
    return created;
  };

  for (const row of rows.tokenRows) {
    const summary = ensureSummary(row.workflowId);
    const workflowCost = costAccumulators.get(row.workflowId) ?? emptyCostAccumulator();
    costAccumulators.set(row.workflowId, workflowCost);
    addTokenRow(summary.tokens, row);
    addTokenRow(totalTokens, row);
    addRowCost(workflowCost, row, query.now, pricingOverrides);
    addRowCost(totalCost, row, query.now, pricingOverrides);
  }

  for (const row of rows.completedRows) {
    ensureSummary(row.workflowId).tasksCompleted = row.count;
  }

  for (const row of rows.currentRows) {
    const summary = ensureSummary(row.workflowId);
    if (row.columnName === "in-progress") summary.tasksInProgress = row.count;
    if (row.columnName === "in-review") summary.tasksInReview = row.count;
  }

  for (const row of rows.fileRows) {
    ensureSummary(row.workflowId).filesChanged += countModifiedFiles(row.modifiedFiles);
  }

  for (const [workflowId, summary] of summaries) {
    summary.cost = finalizeCost(costAccumulators.get(workflowId) ?? emptyCostAccumulator());
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

  const sortedWorkflows = [...summaries.values()].sort((a, b) => {
    const tokenCmp = b.tokens.totalTokens - a.tokens.totalTokens;
    if (tokenCmp !== 0) return tokenCmp;
    return a.workflowId.localeCompare(b.workflowId);
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
    workflows: sortedWorkflows,
  };
}

/**
 * Aggregate store-derived per-workflow Command Center metrics over a date range.
 *
 * FNXC:CommandCenter 2026-06-27-12:00:
 * Per-workflow analytics derive from tasks ⨝ task_workflow_selection, with the project default workflow backfilling unselected tasks. The HTTP layer passes an already project-scoped Database handle, so this pure read-only aggregator adds observability for custom workflows without introducing schema or cross-project reads.
 *
 * FNXC:PostgresCommandCenterAnalytics 2026-06-28-09:30:
 * Now accepts a `Database | AsyncDataLayer` and is async. In backend (PostgreSQL)
 * mode it branches on `"ping" in dbOrLayer` and runs schema-qualified `project.*`
 * snake_case queries via the async layer; the sync SQLite branch is unchanged.
 */
export async function aggregateWorkflowAnalytics(
  dbOrLayer: Database | AsyncDataLayer,
  query: WorkflowAnalyticsQuery = {},
): Promise<WorkflowAnalytics> {
  const defaultWorkflowId = query.defaultWorkflowId ?? "builtin:coding";
  if ("ping" in dbOrLayer) {
    return aggregateWorkflowAnalyticsAsync(dbOrLayer, query, defaultWorkflowId);
  }
  const db = dbOrLayer as Database;

  const workflowExpr = "COALESCE(NULLIF(s.workflowId, ''), ?)";

  const tokenClauses = ["t.tokenUsageLastUsedAt IS NOT NULL"];
  const tokenParams: string[] = [defaultWorkflowId];
  addRangeClauses("t.tokenUsageLastUsedAt", tokenClauses, tokenParams, query);
  const tokenRows = db
    .prepare(
      `SELECT
         ${workflowExpr} AS workflowId,
         t.tokenUsageInputTokens AS inputTokens,
         t.tokenUsageOutputTokens AS outputTokens,
         t.tokenUsageCachedTokens AS cachedTokens,
         t.tokenUsageCacheWriteTokens AS cacheWriteTokens,
         t.tokenUsageTotalTokens AS totalTokens,
         t.modelProvider,
         t.modelId,
         t.tokenUsageModelProvider,
         t.tokenUsageModelId
       FROM tasks t
       LEFT JOIN task_workflow_selection s ON s.taskId = t.id
       WHERE ${tokenClauses.join(" AND ")}`,
    )
    .all(...tokenParams) as TaskTokenRow[];

  const completedClauses = [`t."column" = 'done'`, "t.columnMovedAt IS NOT NULL"];
  const completedParams: string[] = [defaultWorkflowId];
  addRangeClauses("t.columnMovedAt", completedClauses, completedParams, query);
  const completedRows = db
    .prepare(
      `SELECT ${workflowExpr} AS workflowId, COUNT(*) AS count
       FROM tasks t
       LEFT JOIN task_workflow_selection s ON s.taskId = t.id
       WHERE ${completedClauses.join(" AND ")}
       GROUP BY workflowId`,
    )
    .all(...completedParams) as CountByWorkflowRow[];

  const currentClauses = [`t."column" IN ('in-progress', 'in-review')`];
  const currentParams: string[] = [defaultWorkflowId];
  /*
   * FNXC:CommandCenter 2026-06-27-17:45:
   * The Workflows tab describes all task counts as range-scoped analytics. Count active workflow tasks only when their current column transition (or updatedAt fallback for legacy rows) falls inside the selected range so stale in-progress/review tasks do not suppress the empty state for unrelated windows.
   */
  addRangeClauses("COALESCE(t.columnMovedAt, t.updatedAt)", currentClauses, currentParams, query);
  const currentRows = db
    .prepare(
      `SELECT ${workflowExpr} AS workflowId, t."column" AS columnName, COUNT(*) AS count
       FROM tasks t
       LEFT JOIN task_workflow_selection s ON s.taskId = t.id
       WHERE ${currentClauses.join(" AND ")}
       GROUP BY workflowId, t."column"`,
    )
    .all(...currentParams) as Array<CountByWorkflowRow & { columnName: string }>;

  const filesClauses = ["t.modifiedFiles IS NOT NULL", "t.modifiedFiles NOT IN ('', '[]')"];
  const filesParams: string[] = [defaultWorkflowId];
  addRangeClauses("t.updatedAt", filesClauses, filesParams, query);
  const fileRows = db
    .prepare(
      `SELECT ${workflowExpr} AS workflowId, t.modifiedFiles
       FROM tasks t
       LEFT JOIN task_workflow_selection s ON s.taskId = t.id
       WHERE ${filesClauses.join(" AND ")}`,
    )
    .all(...filesParams) as ModifiedFilesRow[];

  return buildWorkflowAnalytics(
    { tokenRows, completedRows, currentRows, fileRows },
    query,
    (workflowId) => resolveWorkflowNameSync(db, workflowId),
  );
}

/**
 * FNXC:PostgresCommandCenterAnalytics 2026-06-28-09:30:
 * PostgreSQL fetch path for {@link aggregateWorkflowAnalytics}. Every table is
 * schema-qualified (`project.*`) with snake_case columns because the async
 * connection has no `project` on the search_path. The `COALESCE(NULLIF(...))`
 * default-workflow backfill, range columns, GROUP BY shape, and integer
 * coercion mirror the sync branch exactly. `modified_files` is jsonb (postgres-js
 * returns it parsed) so it is re-stringified to feed the shared
 * countModifiedFiles helper unchanged.
 */
async function aggregateWorkflowAnalyticsAsync(
  layer: AsyncDataLayer,
  query: WorkflowAnalyticsQuery,
  defaultWorkflowId: string,
): Promise<WorkflowAnalytics> {
  const wfExpr = sql`COALESCE(NULLIF(s.workflow_id, ''), ${defaultWorkflowId})`;

  const tokFrom = query.from !== undefined ? sql`AND t.token_usage_last_used_at >= ${query.from}` : sql``;
  const tokTo = query.to !== undefined ? sql`AND t.token_usage_last_used_at <= ${query.to}` : sql``;
  const tokenRowsRaw = (await layer.db.execute(
    sql`SELECT
          ${wfExpr}                            AS "workflowId",
          t.token_usage_input_tokens           AS "inputTokens",
          t.token_usage_output_tokens          AS "outputTokens",
          t.token_usage_cached_tokens          AS "cachedTokens",
          t.token_usage_cache_write_tokens     AS "cacheWriteTokens",
          t.token_usage_total_tokens           AS "totalTokens",
          t.model_provider                     AS "modelProvider",
          t.model_id                           AS "modelId",
          t.token_usage_model_provider         AS "tokenUsageModelProvider",
          t.token_usage_model_id               AS "tokenUsageModelId"
        FROM project.tasks t
        LEFT JOIN project.task_workflow_selection s ON s.task_id = t.id
        WHERE t.token_usage_last_used_at IS NOT NULL ${tokFrom} ${tokTo}`,
  )) as Array<Record<string, unknown>>;
  const tokenRows: TaskTokenRow[] = tokenRowsRaw.map((r) => ({
    workflowId: String(r.workflowId),
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

  const compFrom = query.from !== undefined ? sql`AND t.column_moved_at >= ${query.from}` : sql``;
  const compTo = query.to !== undefined ? sql`AND t.column_moved_at <= ${query.to}` : sql``;
  const completedRowsRaw = (await layer.db.execute(
    sql`SELECT ${wfExpr} AS "workflowId", count(*)::int AS count
        FROM project.tasks t
        LEFT JOIN project.task_workflow_selection s ON s.task_id = t.id
        WHERE t."column" = 'done' AND t.column_moved_at IS NOT NULL ${compFrom} ${compTo}
        GROUP BY 1`,
  )) as Array<{ workflowId: string; count: number }>;
  const completedRows: CountByWorkflowRow[] = completedRowsRaw.map((r) => ({
    workflowId: String(r.workflowId),
    count: Number(r.count),
  }));

  const curFrom = query.from !== undefined ? sql`AND COALESCE(t.column_moved_at, t.updated_at) >= ${query.from}` : sql``;
  const curTo = query.to !== undefined ? sql`AND COALESCE(t.column_moved_at, t.updated_at) <= ${query.to}` : sql``;
  const currentRowsRaw = (await layer.db.execute(
    sql`SELECT ${wfExpr} AS "workflowId", t."column" AS "columnName", count(*)::int AS count
        FROM project.tasks t
        LEFT JOIN project.task_workflow_selection s ON s.task_id = t.id
        WHERE t."column" IN ('in-progress', 'in-review') ${curFrom} ${curTo}
        GROUP BY 1, t."column"`,
  )) as Array<{ workflowId: string; columnName: string; count: number }>;
  const currentRows: Array<CountByWorkflowRow & { columnName: string }> = currentRowsRaw.map((r) => ({
    workflowId: String(r.workflowId),
    columnName: String(r.columnName),
    count: Number(r.count),
  }));

  const filesFrom = query.from !== undefined ? sql`AND t.updated_at >= ${query.from}` : sql``;
  const filesTo = query.to !== undefined ? sql`AND t.updated_at <= ${query.to}` : sql``;
  const fileRowsRaw = (await layer.db.execute(
    sql`SELECT ${wfExpr} AS "workflowId", t.modified_files AS "modifiedFiles"
        FROM project.tasks t
        LEFT JOIN project.task_workflow_selection s ON s.task_id = t.id
        WHERE t.modified_files IS NOT NULL
          AND jsonb_typeof(t.modified_files) = 'array'
          AND jsonb_array_length(t.modified_files) > 0
          ${filesFrom} ${filesTo}`,
  )) as Array<{ workflowId: string; modifiedFiles: unknown }>;
  const fileRows: ModifiedFilesRow[] = fileRowsRaw.map((r) => ({
    workflowId: String(r.workflowId),
    modifiedFiles: r.modifiedFiles == null ? null : JSON.stringify(r.modifiedFiles),
  }));

  // Prefetch all custom workflow names once; builtins resolve in-memory.
  const workflowNameRows = (await layer.db.execute(
    sql`SELECT id, name FROM project.workflows`,
  )) as Array<{ id: string; name: string | null }>;
  const names = new Map<string, string>();
  for (const row of workflowNameRows) {
    if (row.name) names.set(String(row.id), row.name);
  }

  return buildWorkflowAnalytics(
    { tokenRows, completedRows, currentRows, fileRows },
    query,
    (workflowId) => resolveWorkflowNameFromMap(names, workflowId),
  );
}
