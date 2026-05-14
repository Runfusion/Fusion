import type { AgentStore } from "./agent-store.js";
import type { TaskStore } from "./store.js";
import { isEphemeralAgent, type AgentRole } from "./types.js";

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
  if (!agent || isEphemeralAgent(agent)) {
    return null;
  }

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
