import { useEffect, useMemo, useState } from "react";
import { listArtifacts } from "./api.js";
import type { DiscoveryResult } from "../../artifacts/discovery.js";

/**
 * Short-TTL discovery cache keyed by `projectId` (the discovery scan has no
 * per-row id, so the project is the cache unit). Mirrors the dashboard
 * performance kit (docs/performance/dashboard-load.md): a 30s TTL balances
 * freshness against repeated viewport-driven refetches.
 */
const CACHE_TTL_MS = 30_000;
const discoveryCache = new Map<string, { value: DiscoveryResult; expiresAt: number }>();

function cacheKey(projectId?: string): string {
  return `discovery:${projectId ?? "__default__"}`;
}

/** Exposed for tests. */
export function __test_clearArtifactsCache(): void {
  discoveryCache.clear();
}

export interface UseArtifactsResult {
  result?: DiscoveryResult;
  loading: boolean;
  error?: string;
}

/**
 * Discover CE artifacts for the active project. The fetch is viewport-gated via
 * the `enabled` flag — when the CE view is offscreen/disabled it returns stable
 * empty state and triggers no network request (performance kit). Results are
 * served from a short-TTL cache to collapse repeated mounts.
 */
export function useArtifacts({
  projectId,
  enabled = true,
}: {
  projectId?: string;
  enabled?: boolean;
}): UseArtifactsResult {
  const [result, setResult] = useState<DiscoveryResult | undefined>(() => {
    const cached = discoveryCache.get(cacheKey(projectId));
    return cached && cached.expiresAt > Date.now() ? cached.value : undefined;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!enabled) return;

    const key = cacheKey(projectId);
    const cached = discoveryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      setResult(cached.value);
      setError(undefined);
      return;
    }

    setResult(undefined);
    setError(undefined);

    const controller = new AbortController();
    setLoading(true);
    listArtifacts(projectId)
      .then((value) => {
        if (controller.signal.aborted) return;
        discoveryCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        setResult(value);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load artifacts");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, enabled]);

  return useMemo(() => ({ result, loading, error }), [result, loading, error]);
}
