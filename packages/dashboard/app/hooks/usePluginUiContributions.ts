import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchPluginUiContributions } from "../api";
import type { PluginUiContributionEntry } from "../api";

const uiContributionsCache = new Map<string, { contributions: PluginUiContributionEntry[]; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

interface UsePluginUiContributionsResult {
  contributions: PluginUiContributionEntry[];
  getContributionsForSurface: (surface: string) => PluginUiContributionEntry[];
  loading: boolean;
  error: string | null;
}

export function __test_clearContributionsCache(): void {
  uiContributionsCache.clear();
}

export function usePluginUiContributions(projectId?: string): UsePluginUiContributionsResult {
  const [contributions, setContributions] = useState<PluginUiContributionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const initialLoadCompleteRef = useRef(false);
  const cancelledRef = useRef(false);

  const getContributionsForSurface = useCallback(
    (surface: string): PluginUiContributionEntry[] => contributions.filter((entry) => entry.contribution.surface === surface),
    [contributions],
  );

  useEffect(() => {
    const cacheKey = projectId ?? "default";
    let cancelled = false;

    async function load(): Promise<void> {
      const cached = uiContributionsCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        if (cancelled || cancelledRef.current) return;
        setContributions(cached.contributions);
        setLoading(false);
        return;
      }

      if (!initialLoadCompleteRef.current) {
        setLoading(true);
      }
      setError(null);

      try {
        const data = await fetchPluginUiContributions(projectId);
        if (cancelled || cancelledRef.current) return;

        uiContributionsCache.set(cacheKey, {
          contributions: data,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });

        setContributions(data);
        initialLoadCompleteRef.current = true;
      } catch (err) {
        if (cancelled || cancelledRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to fetch UI contributions");
        initialLoadCompleteRef.current = true;
      } finally {
        if (!cancelled && !cancelledRef.current) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    initialLoadCompleteRef.current = false;
    cancelledRef.current = false;
  }, [projectId]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  return useMemo(
    () => ({
      contributions,
      getContributionsForSurface,
      loading,
      error,
    }),
    [contributions, getContributionsForSurface, loading, error],
  );
}
