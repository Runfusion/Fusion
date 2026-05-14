import type { AgentRole, TaskStore } from "@fusion/core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
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

interface SessionStatsLike {
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
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
    const tokenUsage = {
      inputTokens: newInput,
      outputTokens: newOutput,
      cachedTokens: newCached,
      cacheWriteTokens: newCacheWrite,
      totalTokens: newInput + newOutput + newCached + newCacheWrite,
      firstUsedAt: task.tokenUsage?.firstUsedAt ?? now,
      lastUsedAt: now,
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
