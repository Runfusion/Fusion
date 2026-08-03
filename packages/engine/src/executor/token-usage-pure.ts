/**
 * FNXC:CodeOrganization 2026-08-03-13:35:
 * Pure token-usage merge/snapshot helpers peeled from TaskExecutor (U4).
 * Re-exported from executor.ts; no instance state.
 */
import type { TaskTokenUsage } from "@fusion/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { mergeTokenUsagePerModel } from "../execution/session-token-usage.js";
import { executorLog } from "../logger.js";

export function accumulateTokenUsage(
  existing: TaskTokenUsage | undefined,
  delta: Pick<TaskTokenUsage, "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens" | "totalTokens"> | undefined,
  timestamp = new Date().toISOString(),
): TaskTokenUsage | undefined {
  if (!delta) return existing;

  const merged: TaskTokenUsage = {
    inputTokens: (existing?.inputTokens ?? 0) + delta.inputTokens,
    outputTokens: (existing?.outputTokens ?? 0) + delta.outputTokens,
    cachedTokens: (existing?.cachedTokens ?? 0) + delta.cachedTokens,
    cacheWriteTokens: (existing?.cacheWriteTokens ?? 0) + delta.cacheWriteTokens,
    totalTokens: (existing?.totalTokens ?? 0) + delta.totalTokens,
    firstUsedAt: existing?.firstUsedAt ?? timestamp,
    lastUsedAt: timestamp,
    perModel: existing?.perModel,
  };

  return merged;
}

export function tokenUsageWithModelSnapshot(
  tokenUsage: TaskTokenUsage,
  session: AgentSession | undefined,
  existing: TaskTokenUsage | undefined,
  delta?: Pick<TaskTokenUsage, "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens" | "totalTokens">,
  timestamp = tokenUsage.lastUsedAt,
  modelOverride?: { provider?: string; id?: string },
): TaskTokenUsage {
  const model = modelOverride ?? (session as { model?: { provider?: string; id?: string } } | undefined)?.model;
  return {
    ...tokenUsage,
    /*
     * FNXC:TokenAnalytics 2026-06-18-16:23:
     * Persist the actually-used session model as an analytics snapshot while leaving task.modelProvider/task.modelId untouched so normal model-resolution hierarchy is not pinned by usage bookkeeping.
     *
     * FNXC:TokenAnalytics 2026-06-19-15:53:
     * Per-model buckets must merge only the just-produced delta. The sum of buckets stays equal to the task aggregate, while analytics grand totals and nTasks remain based on the task row rather than expanded buckets.
     */
    modelProvider: model?.provider ?? existing?.modelProvider,
    modelId: model?.id ?? existing?.modelId,
    perModel: delta ? mergeTokenUsagePerModel(existing?.perModel, delta, model, timestamp) : tokenUsage.perModel,
  };
}

export async function extractSessionTokenUsage(
  session: AgentSession | undefined,
): Promise<Pick<TaskTokenUsage, "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens" | "totalTokens"> | undefined> {
  if (!session) return undefined;

  try {
    const statsResult = (session as AgentSession & {
      getSessionStats?: () =>
        | {
            tokens?: {
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              total?: number;
            };
          }
        | Promise<{
            tokens?: {
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              total?: number;
            };
          }>;
    }).getSessionStats?.();
    const stats = await Promise.resolve(statsResult);
    const tokens = stats?.tokens;
    if (!tokens) return undefined;

    const inputTokens = tokens.input ?? 0;
    const outputTokens = tokens.output ?? 0;
    const cachedTokens = tokens.cacheRead ?? 0;
    const cacheWriteTokens = tokens.cacheWrite ?? 0;
    const totalTokens = tokens.total ?? (inputTokens + outputTokens + cachedTokens + cacheWriteTokens);

    return {
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens,
      totalTokens,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    executorLog.warn(`Failed to read session stats for token usage: ${message}`);
    return undefined;
  }
}
