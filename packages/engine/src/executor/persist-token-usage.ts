/**
 * FNXC:CodeOrganization 2026-08-03-09:20:
 * Token-usage persist helpers peeled from TaskExecutor (U4).
 *
 * FNXC:TokenBudget 2026-07-16-00:00:
 * Step-session token usage bypasses the shared session helper, so all executor
 * writes use this seam to retain the required persist-time budget enforcement.
 *
 * FNXC:TokenAnalytics 2026-07-17-14:00:
 * `persistTokenUsage` is the sole writer for a central executor session. Prompt paths call this same delta seam rather than `accumulateSessionTokenUsage`, preventing independently-baselined helper and finalization writes from crediting the same cumulative tokens twice.
 *
 * FNXC:EngineDiagnostics 2026-08-01-18:11:
 * Executor token-cache metrics mirror session-token-usage: debug-only telemetry
 * (FUSION_DEBUG=token-cache-metrics), not default TUI noise.
 */
import type { TaskStore, TaskTokenUsage } from "@fusion/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../logger.js";
import { enforceTaskTokenBudgetForPersist } from "../concurrency/token-budget-enforcer.js";
import type { EngineRunContext } from "../util/run-audit.js";
import {
  accumulateTokenUsage,
  extractSessionTokenUsage,
  tokenUsageWithModelSnapshot,
} from "./token-usage-pure.js";

const tokenCacheMetricsLog = createLogger("token-cache-metrics");

export type TokenUsageBaseline = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

export type PersistTokenUsageDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  tokenUsageBaselines: Map<string, TokenUsageBaseline>;
  /** Optional session from activeSessions when caller omits an explicit session. */
  getActiveSession: (taskId: string) => AgentSession | undefined;
};

export async function persistTaskTokenUsage(
  deps: Pick<PersistTokenUsageDeps, "store" | "getRunContextFor">,
  taskId: string,
  tokenUsage: TaskTokenUsage,
): Promise<void> {
  const runContext = deps.getRunContextFor(taskId);
  await deps.store.updateTask(taskId, { tokenUsage }, runContext);
  await enforceTaskTokenBudgetForPersist(deps.store, taskId, runContext);
}

export async function captureExecutorTokenUsageBaseline(
  deps: Pick<PersistTokenUsageDeps, "tokenUsageBaselines">,
  taskId: string,
  session: AgentSession,
): Promise<void> {
  deps.tokenUsageBaselines.set(taskId, (await extractSessionTokenUsage(session)) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  });
}

export async function persistTokenUsage(
  deps: PersistTokenUsageDeps,
  taskId: string,
  session?: AgentSession,
): Promise<void> {
  const activeSession = session ?? deps.getActiveSession(taskId);
  const currentUsage = await extractSessionTokenUsage(activeSession);
  if (!currentUsage) return;

  const baseline = deps.tokenUsageBaselines.get(taskId);
  deps.tokenUsageBaselines.set(taskId, currentUsage);

  const delta = baseline
    ? {
        inputTokens: Math.max(0, currentUsage.inputTokens - baseline.inputTokens),
        outputTokens: Math.max(0, currentUsage.outputTokens - baseline.outputTokens),
        cachedTokens: Math.max(0, currentUsage.cachedTokens - baseline.cachedTokens),
        cacheWriteTokens: Math.max(0, currentUsage.cacheWriteTokens - baseline.cacheWriteTokens),
        totalTokens: Math.max(0, currentUsage.totalTokens - baseline.totalTokens),
      }
    : currentUsage;

  if (
    delta.inputTokens === 0
    && delta.outputTokens === 0
    && delta.cachedTokens === 0
    && delta.cacheWriteTokens === 0
    && delta.totalTokens === 0
  ) {
    return;
  }

  const task = await deps.store.getTask(taskId);
  const merged = accumulateTokenUsage(task.tokenUsage, delta);
  if (!merged) return;
  const tokenUsage = tokenUsageWithModelSnapshot(merged, activeSession, task.tokenUsage, delta);

  tokenCacheMetricsLog.debug(JSON.stringify({
    taskId,
    agentId: task.assignedAgentId ?? undefined,
    role: "executor",
    inputTokens: tokenUsage.inputTokens,
    cachedTokens: tokenUsage.cachedTokens,
    cacheWriteTokens: tokenUsage.cacheWriteTokens,
    hitRatio: tokenUsage.inputTokens + tokenUsage.cachedTokens > 0 ? tokenUsage.cachedTokens / (tokenUsage.inputTokens + tokenUsage.cachedTokens) : 0,
  }));

  await persistTaskTokenUsage(deps, taskId, tokenUsage);
}
