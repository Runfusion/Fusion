import type { AgentRole, TaskStore, TaskTokenUsage, TaskTokenUsagePerModel } from "@fusion/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createLogger } from "./logger.js";

const log = createLogger("session-token-usage");
const cacheMetricsLog = createLogger("token-cache-metrics");

interface SessionBaseline {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
}

// Per-session cumulative-token baselines so repeated calls only persist deltas.
// The session object is keyed weakly so disposed sessions get garbage-collected.
const sessionBaselines = new WeakMap<AgentSession, SessionBaseline>();

type TokenUsageDelta = Pick<TaskTokenUsage, "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens" | "totalTokens">;

type TokenUsageModelSnapshot = { provider?: string; id?: string } | undefined;

interface SessionStatsLike {
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export function mergeTokenUsagePerModel(
  existing: TaskTokenUsagePerModel[] | undefined,
  delta: TokenUsageDelta,
  model: TokenUsageModelSnapshot,
  timestamp: string,
): TaskTokenUsagePerModel[] {
  const perModel = [...(existing ?? [])];
  const modelProvider = model?.provider;
  const modelId = model?.id;
  const matchesBucket = (bucket: TaskTokenUsagePerModel): boolean =>
    (bucket.modelProvider ?? null) === (modelProvider ?? null)
    && (bucket.modelId ?? null) === (modelId ?? null);
  const bucketIndex = perModel.findIndex(matchesBucket);
  const previous = bucketIndex >= 0 ? perModel[bucketIndex] : undefined;
  const next: TaskTokenUsagePerModel = {
    modelProvider,
    modelId,
    inputTokens: (previous?.inputTokens ?? 0) + delta.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + delta.outputTokens,
    cachedTokens: (previous?.cachedTokens ?? 0) + delta.cachedTokens,
    cacheWriteTokens: (previous?.cacheWriteTokens ?? 0) + delta.cacheWriteTokens,
    totalTokens: (previous?.totalTokens ?? 0) + delta.totalTokens,
    firstUsedAt: previous?.firstUsedAt ?? timestamp,
    lastUsedAt: timestamp,
  };
  if (bucketIndex >= 0) {
    perModel[bucketIndex] = next;
  } else {
    perModel.push(next);
  }
  return perModel;
}

function readSessionStats(session: AgentSession): SessionStatsLike | undefined {
  const accessor = (session as unknown as { getSessionStats?: () => SessionStatsLike }).getSessionStats;
  if (typeof accessor !== "function") return undefined;
  try {
    return accessor.call(session);
  } catch {
    return undefined;
  }
}

/**
 * Capture the session's cumulative token usage and accumulate any *new* deltas
 * onto `task.tokenUsage`. Safe to call repeatedly on the same session — each
 * call only persists what's been added since the previous call (per-session
 * baseline tracking). Failures are logged and swallowed so token bookkeeping
 * never blocks the task pipeline.
 */
export async function accumulateSessionTokenUsage(
  store: TaskStore,
  taskId: string,
  session: AgentSession,
  options?: { agentId?: string; role?: AgentRole },
): Promise<void> {
  try {
    const stats = readSessionStats(session);
    const tokens = stats?.tokens;
    if (!tokens) return;

    const currentInput = tokens.input ?? 0;
    const currentOutput = tokens.output ?? 0;
    const currentCached = tokens.cacheRead ?? 0;
    const currentCacheWrite = tokens.cacheWrite ?? 0;

    const baseline = sessionBaselines.get(session) ?? { input: 0, output: 0, cached: 0, cacheWrite: 0 };
    const inputDelta = Math.max(0, currentInput - baseline.input);
    const outputDelta = Math.max(0, currentOutput - baseline.output);
    const cachedDelta = Math.max(0, currentCached - baseline.cached);
    const cacheWriteDelta = Math.max(0, currentCacheWrite - baseline.cacheWrite);

    sessionBaselines.set(session, {
      input: currentInput,
      output: currentOutput,
      cached: currentCached,
      cacheWrite: currentCacheWrite,
    });

    if (inputDelta === 0 && outputDelta === 0 && cachedDelta === 0 && cacheWriteDelta === 0) return;

    const task = await store.getTask(taskId);
    const now = new Date().toISOString();
    const newInput = (task.tokenUsage?.inputTokens ?? 0) + inputDelta;
    const newOutput = (task.tokenUsage?.outputTokens ?? 0) + outputDelta;
    const newCached = (task.tokenUsage?.cachedTokens ?? 0) + cachedDelta;
    const newCacheWrite = (task.tokenUsage?.cacheWriteTokens ?? 0) + cacheWriteDelta;

    const role = options?.role ?? "executor";
    const model = (session as { model?: { provider?: string; id?: string } }).model;
    const tokenUsage = {
      inputTokens: newInput,
      outputTokens: newOutput,
      cachedTokens: newCached,
      cacheWriteTokens: newCacheWrite,
      totalTokens: newInput + newOutput + newCached + newCacheWrite,
      firstUsedAt: task.tokenUsage?.firstUsedAt ?? now,
      lastUsedAt: now,
      /*
       * FNXC:TokenAnalytics 2026-06-18-16:23:
       * Token accumulation must snapshot the actually-used session model for by-model analytics without touching task.modelProvider/task.modelId, which would pin future model resolution.
       */
      modelProvider: model?.provider ?? task.tokenUsage?.modelProvider,
      modelId: model?.id ?? task.tokenUsage?.modelId,
      /*
       * FNXC:TokenAnalytics 2026-06-19-15:52:
       * Per-model buckets must add only the newly observed session delta so the bucket sum equals the task aggregate while Command Center grand nTasks continues to count this task once.
       */
      perModel: mergeTokenUsagePerModel(task.tokenUsage?.perModel, {
        inputTokens: inputDelta,
        outputTokens: outputDelta,
        cachedTokens: cachedDelta,
        cacheWriteTokens: cacheWriteDelta,
        totalTokens: inputDelta + outputDelta + cachedDelta + cacheWriteDelta,
      }, model, now),
    };

    cacheMetricsLog.log(JSON.stringify({
      taskId,
      agentId: options?.agentId,
      role,
      inputTokens: tokenUsage.inputTokens,
      cachedTokens: tokenUsage.cachedTokens,
      cacheWriteTokens: tokenUsage.cacheWriteTokens,
      hitRatio: computeCacheHitRatio(tokenUsage.inputTokens, tokenUsage.cachedTokens),
    }));

    await store.updateTask(taskId, { tokenUsage });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`${taskId}: session token usage accumulate failed: ${message}`);
  }
}

/**
 * Compute the cache hit ratio: `cachedTokens / (inputTokens + cachedTokens)`.
 * Returns a number in [0, 1], or 0 when both arguments are 0.
 *
 * Compatible with canonical stored `task.tokenUsage` fields: pass raw
 * `inputTokens` and cache-read `cachedTokens`.
 */
export function computeCacheHitRatio(
  inputTokens: number,
  cachedTokens: number,
): number {
  const total = inputTokens + cachedTokens;
  if (total === 0) return 0;
  return cachedTokens / total;
}
