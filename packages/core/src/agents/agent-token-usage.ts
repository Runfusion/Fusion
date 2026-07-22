import { sql } from "drizzle-orm";
import type { AgentStore } from "./agent-store.js";
import type { Database } from "../db/db.js";
import type { DrizzleDb } from "../postgres/data-layer.js";
import { PROJECT_SCHEMA } from "../postgres/schema/_shared.js";
import type { TaskStore } from "../store.js";
import type { AgentRole } from "../types.js";

export interface AgentTokenUsageWindowSummary {
  totalInputTokens: number;
  totalCachedTokens: number;
  totalCacheWriteTokens: number;
  totalOutputTokens: number;
  nTasks: number;
  hitRatio: number;
}

export interface AgentTokenUsageSummary {
  agentId: string;
  role: AgentRole;
  last24h: AgentTokenUsageWindowSummary;
  last7d: AgentTokenUsageWindowSummary;
  allTime: AgentTokenUsageWindowSummary;
}

export interface AgentTaskTokenTotals {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  nTasks: number;
}

interface TaskTokenLinkRow {
  taskId: string;
  assignedAgentId: string | null;
  sourceAgentId: string | null;
  checkedOutBy: string | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/**
 * FNXC:PostgresCutover 2026-07-04:
 * Shared accumulation core for task-derived token totals by agent link.
 * Both the sync SQLite path and the async PostgreSQL path funnel the same
 * TaskTokenLinkRow[] through this so the assigned/source/checkout attribution
 * stays identical across backends (every linked agent is credited, no double
 * counting when a task links the same agent via multiple fields).
 */
function accumulateTaskTokenLinkRows(
  rows: TaskTokenLinkRow[],
  totalsByAgentId: Map<string, AgentTaskTokenTotals>,
): void {
  for (const row of rows) {
    const agentIds = new Set([row.assignedAgentId, row.sourceAgentId, row.checkedOutBy].filter((value): value is string => Boolean(value)));
    for (const agentId of agentIds) {
      const existing = totalsByAgentId.get(agentId) ?? createTaskTokenTotals();
      existing.inputTokens += row.inputTokens ?? 0;
      existing.cachedTokens += row.cachedTokens ?? 0;
      existing.cacheWriteTokens += row.cacheWriteTokens ?? 0;
      existing.outputTokens += row.outputTokens ?? 0;
      existing.totalTokens += row.totalTokens ?? (row.inputTokens ?? 0) + (row.cachedTokens ?? 0) + (row.cacheWriteTokens ?? 0) + (row.outputTokens ?? 0);
      existing.nTasks += 1;
      totalsByAgentId.set(agentId, existing);
    }
  }
}

export function aggregateTaskTokenTotalsByAgentLink(db: Database): Map<string, AgentTaskTokenTotals> {
  /*
  FNXC:AgentTokenUsage 2026-06-27-23:06:
  List-row token totals must use the same assigned/source/checkout attribution as Agent Detail so ephemeral task-worker agents do not report zero when they only sourced or checked out a task.
  */
  const rows = db.prepare(`
    SELECT
      id AS taskId,
      assignedAgentId,
      sourceAgentId,
      checkedOutBy,
      tokenUsageInputTokens AS inputTokens,
      tokenUsageCachedTokens AS cachedTokens,
      tokenUsageCacheWriteTokens AS cacheWriteTokens,
      tokenUsageOutputTokens AS outputTokens,
      tokenUsageTotalTokens AS totalTokens
    FROM tasks
    WHERE tokenUsageInputTokens IS NOT NULL
       OR tokenUsageCachedTokens IS NOT NULL
       OR tokenUsageCacheWriteTokens IS NOT NULL
       OR tokenUsageOutputTokens IS NOT NULL
       OR tokenUsageTotalTokens IS NOT NULL
  `).all() as TaskTokenLinkRow[];

  const totalsByAgentId = new Map<string, AgentTaskTokenTotals>();
  accumulateTaskTokenLinkRows(rows, totalsByAgentId);
  return totalsByAgentId;
}

/**
 * FNXC:PostgresCutover 2026-07-04:
 * Async PostgreSQL equivalent of {@link aggregateTaskTokenTotalsByAgentLink}.
 * Reads the same task-link token columns from the schema-qualified
 * project.tasks table (snake_case) and runs them through the shared
 * accumulator so the Agents listing surfaces real task-derived totals in
 * backend (PostgreSQL) mode instead of silently degrading to zero. The route
 * dispatches to this when the scoped store carries an AsyncDataLayer.
 */
export async function aggregateTaskTokenTotalsByAgentLinkAsync(
  db: DrizzleDb,
): Promise<Map<string, AgentTaskTokenTotals>> {
  const rawRows = (await db.execute(
    sql.raw(`
      SELECT
        id AS "taskId",
        assigned_agent_id AS "assignedAgentId",
        source_agent_id AS "sourceAgentId",
        checked_out_by AS "checkedOutBy",
        token_usage_input_tokens AS "inputTokens",
        token_usage_cached_tokens AS "cachedTokens",
        token_usage_cache_write_tokens AS "cacheWriteTokens",
        token_usage_output_tokens AS "outputTokens",
        token_usage_total_tokens AS "totalTokens"
      FROM ${PROJECT_SCHEMA}.tasks
      WHERE token_usage_input_tokens IS NOT NULL
         OR token_usage_cached_tokens IS NOT NULL
         OR token_usage_cache_write_tokens IS NOT NULL
         OR token_usage_output_tokens IS NOT NULL
         OR token_usage_total_tokens IS NOT NULL
    `),
  )) as unknown as TaskTokenLinkRow[];

  const totalsByAgentId = new Map<string, AgentTaskTokenTotals>();
  accumulateTaskTokenLinkRows(rawRows, totalsByAgentId);
  return totalsByAgentId;
}

function createTaskTokenTotals(): AgentTaskTokenTotals {
  return {
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    nTasks: 0,
  };
}

export async function aggregateAgentTokenUsage({
  taskStore,
  agentStore,
  agentId,
  now = new Date(),
}: {
  taskStore: TaskStore;
  agentStore: AgentStore;
  agentId: string;
  now?: Date;
}): Promise<AgentTokenUsageSummary | null> {
  const agent = await agentStore.getAgent(agentId);
  if (!agent) {
    return null;
  }

  /*
  FNXC:AgentTokenUsage 2026-06-27-19:10:
  Ephemeral/task-worker agents must surface task-derived token usage because their cumulative agent token fields are never accumulated by the durable-agent heartbeat path.
  */
  const tasks = await taskStore.listTasks({ slim: true, includeArchived: true });
  const nowMs = now.getTime();
  const last24hMs = nowMs - (24 * 60 * 60 * 1000);
  const last7dMs = nowMs - (7 * 24 * 60 * 60 * 1000);

  const allTime = createWindowSummary();
  const last24h = createWindowSummary();
  const last7d = createWindowSummary();

  for (const task of tasks) {
    if (!task.tokenUsage) continue;
    const matchesAgent = task.assignedAgentId === agentId || task.sourceAgentId === agentId || task.checkedOutBy === agentId;
    if (!matchesAgent) continue;

    const usage = task.tokenUsage;
    applyTaskUsage(allTime, usage.inputTokens ?? 0, usage.cachedTokens ?? 0, usage.outputTokens ?? 0, usage.cacheWriteTokens ?? 0);

    const lastUsedAtMs = Date.parse(usage.lastUsedAt ?? "");
    if (!Number.isFinite(lastUsedAtMs)) continue;

    if (lastUsedAtMs >= last24hMs) {
      applyTaskUsage(last24h, usage.inputTokens ?? 0, usage.cachedTokens ?? 0, usage.outputTokens ?? 0, usage.cacheWriteTokens ?? 0);
    }
    if (lastUsedAtMs >= last7dMs) {
      applyTaskUsage(last7d, usage.inputTokens ?? 0, usage.cachedTokens ?? 0, usage.outputTokens ?? 0, usage.cacheWriteTokens ?? 0);
    }
  }

  return {
    agentId,
    role: agent.role as AgentRole,
    last24h: finalizeWindowSummary(last24h),
    last7d: finalizeWindowSummary(last7d),
    allTime: finalizeWindowSummary(allTime),
  };
}

function createWindowSummary(): AgentTokenUsageWindowSummary {
  return {
    totalInputTokens: 0,
    totalCachedTokens: 0,
    totalCacheWriteTokens: 0,
    totalOutputTokens: 0,
    nTasks: 0,
    hitRatio: 0,
  };
}

function applyTaskUsage(
  summary: AgentTokenUsageWindowSummary,
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
): void {
  summary.totalInputTokens += inputTokens;
  summary.totalCachedTokens += cachedTokens;
  summary.totalCacheWriteTokens += cacheWriteTokens;
  summary.totalOutputTokens += outputTokens;
  summary.nTasks += 1;
}

function finalizeWindowSummary(summary: AgentTokenUsageWindowSummary): AgentTokenUsageWindowSummary {
  const denominator = summary.totalInputTokens + summary.totalCachedTokens;
  return {
    ...summary,
    hitRatio: denominator > 0 ? summary.totalCachedTokens / denominator : 0,
  };
}
