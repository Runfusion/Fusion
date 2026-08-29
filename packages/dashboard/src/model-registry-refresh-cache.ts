import {
  DEFAULT_MODEL_REGISTRY_REFRESH_TIMEOUT_MS,
  boundExistingModelRegistryRefresh,
  startFusionModelRegistryRefresh,
  type RefreshableModelRegistry,
} from "@fusion/engine";

/*
FNXC:ModelCatalog 2026-08-12-01:00:
FN-8902 measured a ModelRegistry.refresh() stall of about 300 seconds. `/api/models` therefore
uses a per-registry WeakMap single flight: timing out a request never releases the underlying,
uncancellable refresh slot or permits concurrent provider reloads. The engine seam keeps that
promise observable while preserving its runtime-aware timeout implementation.

Success freshness (settled success) and failure retry (attempt start) deliberately use different
fields and anchors. A failed catalog reload must never claim the live getAvailable() catalog is
fresh, and a settle-anchored retry interval cannot bound an operation that may hang for minutes.
Credential changes bump a generation rather than deleting an entry, preserving in-flight tracking.
A mutation during an uncancellable old-generation refresh temporarily serves live but stale rows;
once it settles, the next request starts a current-generation refresh without an extra window wait.
*/

export const MODEL_REGISTRY_REQUEST_REFRESH_TIMEOUT_MS = DEFAULT_MODEL_REGISTRY_REFRESH_TIMEOUT_MS;
export const MODEL_REGISTRY_REFRESH_SUCCESS_TTL_MS = 60_000;
export const MODEL_REGISTRY_REFRESH_FAILURE_RETRY_MS = 60_000;

export type ModelRegistryRequestRefreshOutcome =
  | "completed"
  | "cached"
  | "negative_cached"
  | "stale_in_flight"
  | "timed_out"
  | "failed";

type RefreshCacheEntry = {
  generation: number;
  freshAsOfGeneration?: number;
  succeededAt?: number;
  lastAttemptStartedAt?: number;
  lastAttemptGeneration?: number;
  lastOutcome?: "completed" | "timed_out" | "failed";
  lastOutcomeAt?: number;
  inFlight?: { promise: Promise<unknown>; generation: number; startedAt: number };
};

let entries = new WeakMap<object, RefreshCacheEntry>();

export type RefreshModelRegistryForRequestOptions = {
  /** Injectable clock and windows are test seams; production uses the exported defaults. */
  now?: () => number;
  timeoutMs?: number;
  successTtlMs?: number;
  failureRetryMs?: number;
};

function entryFor(registry: object): RefreshCacheEntry {
  let entry = entries.get(registry);
  if (!entry) {
    entry = { generation: 0 };
    entries.set(registry, entry);
  }
  return entry;
}

/** Bump only this registry's generation without ever dropping an in-flight refresh. */
export function invalidateModelRegistryRefreshCache(registry: object): void {
  const entry = entryFor(registry);
  entry.generation += 1;
  entry.freshAsOfGeneration = undefined;
  entry.succeededAt = undefined;
  entry.lastAttemptStartedAt = undefined;
  entry.lastAttemptGeneration = undefined;
  entry.lastOutcome = undefined;
  entry.lastOutcomeAt = undefined;
}

/** Test-only full reset, including any tracked underlying refresh promises. */
export function __resetModelRegistryRefreshCacheForTests(): void {
  entries = new WeakMap<object, RefreshCacheEntry>();
}

/**
 * Bound and single-flight a live registry refresh. This never throws: callers
 * always retain `getAvailable()` as their model-row source of truth.
 */
export async function refreshModelRegistryForRequest(
  registry: RefreshableModelRegistry,
  options: RefreshModelRegistryForRequestOptions = {},
): Promise<ModelRegistryRequestRefreshOutcome> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? MODEL_REGISTRY_REQUEST_REFRESH_TIMEOUT_MS;
  const successTtlMs = options.successTtlMs ?? MODEL_REGISTRY_REFRESH_SUCCESS_TTL_MS;
  const failureRetryMs = options.failureRetryMs ?? MODEL_REGISTRY_REFRESH_FAILURE_RETRY_MS;
  const entry = entryFor(registry);
  const nowMs = now();

  if (entry.inFlight) {
    if (entry.inFlight.generation !== entry.generation) return "stale_in_flight";
    const elapsed = nowMs - entry.inFlight.startedAt;
    if (elapsed >= timeoutMs) return "timed_out";
    return boundExistingModelRegistryRefresh(entry.inFlight.promise, { timeoutMs: timeoutMs - elapsed });
  }

  if (
    entry.freshAsOfGeneration === entry.generation
    && entry.succeededAt !== undefined
    && nowMs - entry.succeededAt < successTtlMs
  ) return "cached";

  if (
    entry.lastAttemptGeneration === entry.generation
    && (entry.lastOutcome === "timed_out" || entry.lastOutcome === "failed")
    && entry.lastAttemptStartedAt !== undefined
    && nowMs - entry.lastAttemptStartedAt < failureRetryMs
  ) return "negative_cached";

  entry.lastAttemptStartedAt = nowMs;
  entry.lastAttemptGeneration = entry.generation;
  entry.lastOutcome = undefined;
  entry.lastOutcomeAt = undefined;

  try {
    const started = startFusionModelRegistryRefresh(registry, { timeoutMs });
    const inFlight = { promise: started.underlying, generation: entry.generation, startedAt: nowMs };
    entry.inFlight = inFlight;
    // The underlying promise is intentionally retained after a request timeout.
    void inFlight.promise.then(
      () => {
        if (entry.inFlight?.promise === inFlight.promise) entry.inFlight = undefined;
        if (inFlight.generation !== entry.generation) return;
        entry.lastOutcome = "completed";
        entry.lastOutcomeAt = now();
        entry.freshAsOfGeneration = entry.generation;
        entry.succeededAt = now();
      },
      () => {
        if (entry.inFlight?.promise === inFlight.promise) entry.inFlight = undefined;
        if (inFlight.generation !== entry.generation) return;
        entry.lastOutcome = "failed";
        entry.lastOutcomeAt = now();
      },
    ).catch(() => {});
    // Guarding here makes a late underlying rejection harmless even if callers
    // only observe the bounded outcome.
    void inFlight.promise.catch(() => {});
    return await started.bounded;
  } catch {
    // start is designed not to throw, but this route cache must remain fail-soft.
    entry.lastOutcome = "failed";
    entry.lastOutcomeAt = now();
    return "failed";
  }
}
