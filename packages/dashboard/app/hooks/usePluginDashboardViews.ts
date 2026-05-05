import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchPluginDashboardViews } from "../api";
import type { PluginDashboardViewEntry } from "../api";

const dashboardViewsCache = new Map<string, { views: PluginDashboardViewEntry[]; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

/** Clear module cache for deterministic hook tests. */
export function __test_clearDashboardViewsCache(): void {
  dashboardViewsCache.clear();
}

/**
 * Fetch plugin dashboard views with a 60s project-scoped cache.
 * Loading is only true for the first fetch of each hook lifecycle.
 */
export function usePluginDashboardViews(projectId?: string): {
  views: PluginDashboardViewEntry[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const [views, setViews] = useState<PluginDashboardViewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const initialLoadCompleteRef = useRef(false);

  const refetch = useCallback(() => {
    const cacheKey = projectId ?? "default";
    dashboardViewsCache.delete(cacheKey);
    setReloadKey((key) => key + 1);
  }, [projectId]);

  useEffect(() => {
    const cacheKey = projectId ?? "default";
    let cancelled = false;

    async function load(): Promise<void> {
      const cached = dashboardViewsCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        if (cancelled) return;
        setViews(cached.views);
        setLoading(false);
        return;
      }

      if (!initialLoadCompleteRef.current) {
        setLoading(true);
      }
      setError(null);

      try {
        const data = await fetchPluginDashboardViews(projectId);
        if (cancelled) return;
        dashboardViewsCache.set(cacheKey, { views: data, expiresAt: Date.now() + CACHE_TTL_MS });
        setViews(data);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to fetch plugin dashboard views");
      } finally {
        if (!cancelled) {
          setLoading(false);
          initialLoadCompleteRef.current = true;
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  return useMemo(() => ({ views, loading, error, refetch }), [views, loading, error, refetch]);
}
