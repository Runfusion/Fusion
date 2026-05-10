import type { TaskStore } from "@fusion/core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { createLogger } from "./logger.js";

const log = createLogger("session-token-usage");

interface SessionBaseline {
  input: number;
  output: number;
  cached: number;
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
): Promise<void> {
  try {
    const stats = readSessionStats(session);
    const tokens = stats?.tokens;
    if (!tokens) return;

    // Treat cache-write tokens as input (they're billed as input on first write
    // and read back at a discount on subsequent turns).
    const currentInput = (tokens.input ?? 0) + (tokens.cacheWrite ?? 0);
    const currentOutput = tokens.output ?? 0;
    const currentCached = tokens.cacheRead ?? 0;

    const baseline = sessionBaselines.get(session) ?? { input: 0, output: 0, cached: 0 };
    const inputDelta = Math.max(0, currentInput - baseline.input);
    const outputDelta = Math.max(0, currentOutput - baseline.output);
    const cachedDelta = Math.max(0, currentCached - baseline.cached);

    sessionBaselines.set(session, {
      input: currentInput,
      output: currentOutput,
      cached: currentCached,
    });

    if (inputDelta === 0 && outputDelta === 0 && cachedDelta === 0) return;

    const task = await store.getTask(taskId);
    const now = new Date().toISOString();
    const newInput = (task.tokenUsage?.inputTokens ?? 0) + inputDelta;
    const newOutput = (task.tokenUsage?.outputTokens ?? 0) + outputDelta;
    const newCached = (task.tokenUsage?.cachedTokens ?? 0) + cachedDelta;

    await store.updateTask(taskId, {
      tokenUsage: {
        inputTokens: newInput,
        outputTokens: newOutput,
        cachedTokens: newCached,
        totalTokens: newInput + newOutput + newCached,
        firstUsedAt: task.tokenUsage?.firstUsedAt ?? now,
        lastUsedAt: now,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`${taskId}: session token usage accumulate failed: ${message}`);
  }
}

/**
 * Compute the cache hit ratio: the fraction of effective input tokens served
 * from cache. Returns a number in [0, 1]. Useful for measuring the
 * effectiveness of prompt caching optimizations.
 *
 * @param inputTokens - Non-cached input tokens (NOT including cache-write tokens;
 *   use only `tokens.input` here, not `tokens.input + tokens.cacheWrite`)
 * @param cachedTokens - Tokens read from cache (`tokens.cacheRead`)
 * @returns Cache hit ratio in [0, 1] matching Anthropic console's `cache_read / input` metric,
 *   or 0 if no tokens used
 */
export function computeCacheHitRatio(
  inputTokens: number,
  cachedTokens: number,
): number {
  const total = inputTokens + cachedTokens;
  if (total === 0) return 0;
  return cachedTokens / total;
}
