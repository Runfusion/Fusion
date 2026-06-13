import type { PluginContext } from "@fusion/core";
import { getCeSessionStore } from "./session-store.js";

const DEFAULT_RECOVERY_SCAN_TTL_MS = 120_000;

const lastRecoveryScanAt = new WeakMap<object, number>();

interface RecoverStaleSessionsOptions {
  reason: "load" | "route";
  force?: boolean;
  emitEvent?: boolean;
  now?: number;
  ttlMs?: number;
}

/**
 * Best-effort stale-session recovery for persisted CE sessions that outlived
 * their in-memory agent handle. Route callers use a TTL because the individual
 * session endpoint is also the dashboard polling fallback.
 */
export function recoverStaleSessionsForContext(
  ctx: PluginContext,
  options: RecoverStaleSessionsOptions,
): string[] {
  const key = ctx.taskStore as object;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_RECOVERY_SCAN_TTL_MS;
  if (!options.force) {
    const last = lastRecoveryScanAt.get(key) ?? 0;
    if (now - last < ttlMs) return [];
  }
  lastRecoveryScanAt.set(key, now);

  try {
    const recovered = getCeSessionStore(ctx).recoverStaleSessions(now);
    if (recovered.length > 0) {
      ctx.logger.info(`Compound Engineering recovered stale session(s) during ${options.reason}: ${recovered.join(", ")}`);
      if (options.emitEvent) {
        ctx.emitEvent("compound-engineering:sessions-recovered", { sessionIds: recovered, reason: options.reason });
      }
    }
    return recovered;
  } catch (err) {
    ctx.logger.warn(
      `Compound Engineering stale-session recovery skipped during ${options.reason}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
