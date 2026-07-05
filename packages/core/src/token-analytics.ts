import type { Database } from "./db.js";
import { costFor, type CostResult, type ModelPricingOverrides } from "./model-pricing.js";
import type { TaskTokenUsagePerModel } from "./types.js";

/**
 * Token-consumption analytics over task execution rows plus durable chat-token
 * rows, generalizing the fixed 24h/7d/all-time windows of
 * `agent-token-usage.ts` to an arbitrary `(from, to)` range. Sums task
 * `tokenUsage*` columns filtered by `tokenUsageLastUsedAt` and chat
 * `chat_token_usage` rows filtered by `createdAt`, then groups by model /
 * provider / node / agent.
 *
 * Inclusivity: `from`/`to` bounds are **inclusive** (`>= from AND <= to`),
 * matching `usage-events.ts` and the range-scan house style. A task whose
 * `tokenUsageLastUsedAt` is exactly equal to `from` is therefore included.
 *
 * Pure read-only aggregation: takes a `Database` handle and returns plain data.
 */

/** Dimension to group token totals by. */
export type TokenGroupBy = "model" | "provider" | "node" | "agent" | "task";

/** Bucket size for optional token-usage time-series analytics. */
export type TokenTimeGranularity = "hour" | "day" | "week";

/** Summed token counts for a group (or the grand total). */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Number of tasks that contributed to these totals. */
  nTasks: number;
  /** Number of chat assistant/room messages that contributed to these totals. Legacy callers may omit it in fixtures; analytics always returns a number. */
  nChatMessages?: number;
}

/** One group's token totals, keyed by the grouped dimension value. */
export interface TokenGroupSummary extends TokenTotals {
  /** The group key (model id, provider, nodeId, or agentId); null when unset. */
  key: string | null;
  /**
   * Derived USD cost for this group (U3). Each contributing task is priced at
   * its own model's rates and summed, so the cost is meaningful for any
   * `groupBy`. `usd` is null when none of the group's tasks had a known price;
   * `unavailable` is true when at least one task's model was unpriced.
   */
  cost: CostResult;
}

/** One time bucket in the optional token-usage series. */
export interface TokenTimePoint extends TokenTotals {
  /** UTC bucket key (`YYYY-MM-DDTHH`, `YYYY-MM-DD`, or ISO week `YYYY-Www`). */
  bucket: string;
  /** Derived USD cost for this bucket, summed per contributing task. */
  cost: CostResult;
}

/** Result of {@link aggregateTokenAnalytics}. */
export interface TokenAnalytics {
  from: string | null;
  to: string | null;
  groupBy: TokenGroupBy | null;
  /** Grand total across all matched tasks. */
  totals: TokenTotals;
  /**
   * Derived USD cost across all matched tasks (U3), each priced at its own
   * model's rates. `usd` is null when no task had a known price; `unavailable`
   * is true when at least one task's model had no pricing entry.
   */
  cost: CostResult;
  /** Per-group totals; empty array when no `groupBy` requested. */
  groups: TokenGroupSummary[];
  /** Optional token-usage totals over time, present only when requested. */
  series?: TokenTimePoint[];
}

export interface TokenAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive) on `tokenUsageLastUsedAt`. */
  from?: string;
  /** ISO-8601 upper bound (inclusive) on `tokenUsageLastUsedAt`. */
  to?: string;
  groupBy?: TokenGroupBy;
  /** Optional UTC bucket size for a token-usage time series. */
  granularity?: TokenTimeGranularity;
  /**
   * Epoch ms "now" used only for pricing-staleness (U3). When omitted, derived
   * cost is never marked stale. Pure: the module never reads the clock itself.
   */
  now?: number;
  /** User-managed pricing overrides that take precedence over the built-in baseline. */
  pricingOverrides?: ModelPricingOverrides;
}

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    nTasks: 0,
    nChatMessages: 0,
  };
}

interface TaskTokenRow {
  id: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  modelProvider: string | null;
  modelId: string | null;
  tokenUsageModelProvider: string | null;
  tokenUsageModelId: string | null;
  tokenUsagePerModel: string | null;
  checkoutNodeId: string | null;
  assignedAgentId: string | null;
  tokenUsageLastUsedAt: string;
}

interface ChatTokenRow {
  id: string;
  sourceKind: string;
  chatSessionId: string | null;
  roomId: string | null;
  messageId: string | null;
  projectId: string | null;
  agentId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  modelProvider: string | null;
  modelId: string | null;
  createdAt: string;
}

type TokenContributionRow = (TaskTokenRow & { contributionKind: "task" }) | (ChatTokenRow & { contributionKind: "chat" });

function groupKeyFor(row: TokenContributionRow, groupBy: TokenGroupBy): string | null {
  switch (groupBy) {
    case "model":
      /*
       * FNXC:TokenAnalytics 2026-06-19-16:09:
       * By-model analytics expands durable per-model task buckets before this legacy path runs. Chat rows are already one model snapshot per assistant turn.
       */
      return row.contributionKind === "task" ? row.tokenUsageModelId ?? row.modelId : row.modelId;
    case "provider":
      return row.contributionKind === "task" ? row.tokenUsageModelProvider ?? row.modelProvider : row.modelProvider;
    case "node":
      return row.contributionKind === "task" ? row.checkoutNodeId : null;
    case "agent":
      return row.contributionKind === "task" ? row.assignedAgentId : row.agentId;
    case "task":
      return row.contributionKind === "task" ? row.id : null;
  }
}

/**
 * Running cost tally. Each task is priced at its own model, then summed: `usd`
 * accumulates priced tasks, `anyUnavailable` records whether any task's model
 * was unpriced, `anyStale` whether the pricing map was stale, and `anyPriced`
 * whether at least one task had a known price. {@link finalizeCost} converts
 * this to a {@link CostResult}.
 */
interface CostAccumulator {
  usd: number;
  anyPriced: boolean;
  anyUnavailable: boolean;
  anyStale: boolean;
}

function emptyCostAccumulator(): CostAccumulator {
  return { usd: 0, anyPriced: false, anyUnavailable: false, anyStale: false };
}

function addRowCost(
  acc: CostAccumulator,
  row: TokenContributionRow,
  now?: number,
  pricingOverrides?: ModelPricingOverrides,
): void {
  /*
   * FNXC:CommandCenter 2026-06-18-12:00:
   * Token cost attribution must use the actually-used model snapshot first, then legacy own-model columns, matching groupKeyFor so resolved-via-settings tasks show priced Command Center costs instead of unavailable groups.
   */
  const result = costFor(
    {
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cachedTokens: row.cachedTokens ?? 0,
      cacheWriteTokens: row.cacheWriteTokens ?? 0,
    },
    {
      provider: row.contributionKind === "task" ? row.tokenUsageModelProvider ?? row.modelProvider : row.modelProvider,
      model: row.contributionKind === "task" ? row.tokenUsageModelId ?? row.modelId : row.modelId,
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

function finalizeCost(acc: CostAccumulator): CostResult {
  return {
    usd: acc.anyPriced ? acc.usd : null,
    unavailable: acc.anyUnavailable,
    stale: acc.anyStale,
  };
}

interface ParsedPerModelRows {
  valid: boolean;
  rows: TokenContributionRow[];
}

function parsePerModelRows(row: TaskTokenRow): ParsedPerModelRows {
  if (!row.tokenUsagePerModel) return { valid: false, rows: [] };
  try {
    const parsed = JSON.parse(row.tokenUsagePerModel) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return { valid: false, rows: [] };
    const rows = parsed
      .filter((entry): entry is Partial<TaskTokenUsagePerModel> => entry !== null && typeof entry === "object")
      .map((entry) => {
        const inputTokens = Number.isFinite(entry.inputTokens) ? Number(entry.inputTokens) : 0;
        const outputTokens = Number.isFinite(entry.outputTokens) ? Number(entry.outputTokens) : 0;
        const cachedTokens = Number.isFinite(entry.cachedTokens) ? Number(entry.cachedTokens) : 0;
        const cacheWriteTokens = Number.isFinite(entry.cacheWriteTokens) ? Number(entry.cacheWriteTokens) : 0;
        const totalTokens = Number.isFinite(entry.totalTokens)
          ? Number(entry.totalTokens)
          : inputTokens + outputTokens + cachedTokens + cacheWriteTokens;
        return {
          ...row,
          inputTokens,
          outputTokens,
          cachedTokens,
          cacheWriteTokens,
          totalTokens,
          tokenUsageModelProvider: typeof entry.modelProvider === "string" ? entry.modelProvider : null,
          tokenUsageModelId: typeof entry.modelId === "string" ? entry.modelId : null,
          tokenUsageLastUsedAt: typeof entry.lastUsedAt === "string" ? entry.lastUsedAt : row.tokenUsageLastUsedAt,
          contributionKind: "task" as const,
        };
      });
    return { valid: rows.length > 0, rows };
  } catch {
    return { valid: false, rows: [] };
  }
}

function isWithinRange(isoTimestamp: string, from?: string, to?: string): boolean {
  return (from === undefined || isoTimestamp >= from) && (to === undefined || isoTimestamp <= to);
}

function addRow(totals: TokenTotals, row: TokenContributionRow, ids?: Set<string>): void {
  totals.inputTokens += row.inputTokens ?? 0;
  totals.outputTokens += row.outputTokens ?? 0;
  totals.cachedTokens += row.cachedTokens ?? 0;
  totals.cacheWriteTokens += row.cacheWriteTokens ?? 0;
  // Prefer the persisted total when present; otherwise derive it from the parts
  // so callers always get a coherent `totalTokens` even on older rows.
  const persistedTotal = row.totalTokens;
  totals.totalTokens +=
    persistedTotal ??
    (row.inputTokens ?? 0) +
      (row.outputTokens ?? 0) +
      (row.cachedTokens ?? 0) +
      (row.cacheWriteTokens ?? 0);
  if (!ids || !ids.has(row.id)) {
    if (row.contributionKind === "task") {
      totals.nTasks += 1;
    } else {
      totals.nChatMessages = (totals.nChatMessages ?? 0) + 1;
    }
    ids?.add(row.id);
  }
}

function isoWeekBucket(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (!Number.isFinite(date.getTime())) return isoTimestamp.slice(0, 10);
  const day = date.getUTCDay() || 7;
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 4 - day));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function contributionTimestamp(row: TokenContributionRow): string {
  return row.contributionKind === "task" ? row.tokenUsageLastUsedAt : row.createdAt;
}

function bucketFor(row: TokenContributionRow, granularity: TokenTimeGranularity): string {
  const timestamp = contributionTimestamp(row);
  switch (granularity) {
    case "hour":
      return timestamp.slice(0, 13);
    case "day":
      return timestamp.slice(0, 10);
    case "week":
      return isoWeekBucket(timestamp);
  }
}

/**
 * Aggregate per-task token usage over a date range, optionally grouped.
 *
 * Tasks are matched by `tokenUsageLastUsedAt` within `[from, to]` (inclusive).
 * Tasks with no token usage (`tokenUsageLastUsedAt IS NULL`) are excluded. An
 * empty range yields zeroed `totals` and an empty `groups` array — never nulls.
 *
 * FNXC:CommandCenter 2026-06-18-00:00:
 * The Command Center token view needs a live, scalable, animated token-over-time chart without changing existing CSV/OTel consumers. Keep `series` opt-in via `granularity`, bucket ISO timestamps in UTC (substring for hour/day, ISO-week in JS), and reuse per-task cost accumulation so each bucket prices mixed known/unknown models correctly.
 */
export function aggregateTokenAnalytics(
  db: Database,
  query: TokenAnalyticsQuery = {},
): TokenAnalytics {
  const clauses: string[] = ["tokenUsageLastUsedAt IS NOT NULL"];
  const params: string[] = [];
  const rangeClauses: string[] = [];
  if (query.from !== undefined) {
    rangeClauses.push("tokenUsageLastUsedAt >= ?");
    params.push(query.from);
  }
  if (query.to !== undefined) {
    rangeClauses.push("tokenUsageLastUsedAt <= ?");
    params.push(query.to);
  }
  if (rangeClauses.length > 0) {
    /*
     * FNXC:CommandCenterTokenRanges 2026-07-02-00:00:
     * Last 30 days model analytics must evaluate durable tokenUsagePerModel bucket timestamps, not only the task-level latest usage timestamp. Include candidate multi-model rows for in-memory bucket filtering while legacy rows stay narrowed by task tokenUsageLastUsedAt.
     */
    clauses.push(`((${rangeClauses.join(" AND ")}) OR tokenUsagePerModel IS NOT NULL)`);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const rows = db
    .prepare(
      `SELECT
         id,
         tokenUsageInputTokens   AS inputTokens,
         tokenUsageOutputTokens  AS outputTokens,
         tokenUsageCachedTokens  AS cachedTokens,
         tokenUsageCacheWriteTokens AS cacheWriteTokens,
         tokenUsageTotalTokens   AS totalTokens,
         modelProvider,
         modelId,
         tokenUsageModelProvider,
         tokenUsageModelId,
         tokenUsagePerModel,
         checkoutNodeId,
         assignedAgentId,
         tokenUsageLastUsedAt
       FROM tasks ${where}`,
    )
    .all(...params) as TaskTokenRow[];

  const chatClauses: string[] = [];
  const chatParams: string[] = [];
  if (query.from !== undefined) {
    chatClauses.push("createdAt >= ?");
    chatParams.push(query.from);
  }
  if (query.to !== undefined) {
    chatClauses.push("createdAt <= ?");
    chatParams.push(query.to);
  }
  const chatWhere = chatClauses.length > 0 ? `WHERE ${chatClauses.join(" AND ")}` : "";
  const chatRows = db
    .prepare(
      `SELECT
         id,
         sourceKind,
         chatSessionId,
         roomId,
         messageId,
         projectId,
         agentId,
         inputTokens,
         outputTokens,
         cachedTokens,
         cacheWriteTokens,
         totalTokens,
         modelProvider,
         modelId,
         createdAt
       FROM chat_token_usage ${chatWhere}`,
    )
    .all(...chatParams) as ChatTokenRow[];

  const totals = emptyTotals();
  const totalCost = emptyCostAccumulator();
  const groupMap = new Map<string | null, TokenGroupSummary>();
  const groupCostMap = new Map<string | null, CostAccumulator>();
  const seriesMap = new Map<string, TokenTimePoint>();
  const seriesCostMap = new Map<string, CostAccumulator>();
  const groupBy = query.groupBy;
  const granularity = query.granularity;
  const now = query.now;
  const pricingOverrides = query.pricingOverrides;

  const totalContributionIds = new Set<string>();
  const groupContributionIds = new Map<string | null, Set<string>>();
  const seriesContributionIds = new Map<string, Set<string>>();

  /*
   * FNXC:ChatTokenAccounting 2026-07-02-00:00:
   * Command Center token totals include durable chat turns alongside task execution tokens. `nTasks` remains task-only and `nChatMessages` counts chat assistant/room messages so labels never imply chat turns are tasks.
   */
  for (const row of rows) {
    const taskRow: TokenContributionRow = { ...row, contributionKind: "task" };
    const perModel = parsePerModelRows(row);
    const rowInRange = isWithinRange(row.tokenUsageLastUsedAt, query.from, query.to);
    const contributionRows = perModel.valid
      ? perModel.rows.filter((bucketRow) => isWithinRange(contributionTimestamp(bucketRow), query.from, query.to))
      : rowInRange
        ? [taskRow]
        : [];

    for (const contributionRow of contributionRows) {
      addRow(totals, contributionRow, totalContributionIds);
      addRowCost(totalCost, contributionRow, now, pricingOverrides);
      if (groupBy) {
        const key = groupKeyFor(contributionRow, groupBy);
        let group = groupMap.get(key);
        if (!group) {
          group = { key, ...emptyTotals(), cost: { usd: null, unavailable: false, stale: false } };
          groupMap.set(key, group);
          groupCostMap.set(key, emptyCostAccumulator());
          groupContributionIds.set(key, new Set<string>());
        }
        addRow(group, contributionRow, groupContributionIds.get(key)!);
        addRowCost(groupCostMap.get(key)!, contributionRow, now, pricingOverrides);
      }
      if (granularity) {
        const bucket = bucketFor(contributionRow, granularity);
        let point = seriesMap.get(bucket);
        if (!point) {
          point = { bucket, ...emptyTotals(), cost: { usd: null, unavailable: false, stale: false } };
          seriesMap.set(bucket, point);
          seriesCostMap.set(bucket, emptyCostAccumulator());
          seriesContributionIds.set(bucket, new Set<string>());
        }
        addRow(point, contributionRow, seriesContributionIds.get(bucket)!);
        addRowCost(seriesCostMap.get(bucket)!, contributionRow, now, pricingOverrides);
      }
    }
  }

  for (const row of chatRows) {
    const contributionRow: TokenContributionRow = { ...row, contributionKind: "chat" };
    addRow(totals, contributionRow, totalContributionIds);
    addRowCost(totalCost, contributionRow, now, pricingOverrides);
    if (groupBy) {
      const key = groupKeyFor(contributionRow, groupBy);
      let group = groupMap.get(key);
      if (!group) {
        group = { key, ...emptyTotals(), cost: { usd: null, unavailable: false, stale: false } };
        groupMap.set(key, group);
        groupCostMap.set(key, emptyCostAccumulator());
        groupContributionIds.set(key, new Set<string>());
      }
      addRow(group, contributionRow, groupContributionIds.get(key)!);
      addRowCost(groupCostMap.get(key)!, contributionRow, now, pricingOverrides);
    }
    if (granularity) {
      const bucket = bucketFor(contributionRow, granularity);
      let point = seriesMap.get(bucket);
      if (!point) {
        point = { bucket, ...emptyTotals(), cost: { usd: null, unavailable: false, stale: false } };
        seriesMap.set(bucket, point);
        seriesCostMap.set(bucket, emptyCostAccumulator());
        seriesContributionIds.set(bucket, new Set<string>());
      }
      addRow(point, contributionRow, seriesContributionIds.get(bucket)!);
      addRowCost(seriesCostMap.get(bucket)!, contributionRow, now, pricingOverrides);
    }
  }

  // Finalize per-group cost from each group's accumulator.
  for (const [key, group] of groupMap) {
    group.cost = finalizeCost(groupCostMap.get(key)!);
  }

  const groups = [...groupMap.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens,
  );

  for (const [bucket, point] of seriesMap) {
    point.cost = finalizeCost(seriesCostMap.get(bucket)!);
  }
  const series = granularity
    ? [...seriesMap.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))
    : undefined;

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    groupBy: groupBy ?? null,
    totals,
    cost: finalizeCost(totalCost),
    groups,
    ...(granularity ? { series } : {}),
  };
}
