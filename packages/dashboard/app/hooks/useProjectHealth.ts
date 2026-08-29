import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { ProjectHealth } from "../api";
import { fetchProjectHealth } from "../api";
import { isVisibilityResumeError, useTabVisibilitySuspension, useVisibilityAwarePoll } from "./visibilitySuspension";

export interface UseMultiProjectHealthResult {
  /** Map of project ID to health data */
  healthMap: Record<string, ProjectHealth | null>;
  /** Loading state - true only for initial load, false during background polling */
  loading: boolean;
  /** Error if any */
  error: string | null;
  /** Manually refresh all health data */
  refresh: () => Promise<void>;
  /** Refresh a specific project's health */
  refreshProject: (projectId: string) => Promise<void>;
}

const POLL_INTERVAL_MS = 10000; // 10 seconds
const BATCH_SIZE = 5; // Number of concurrent health fetches

/**
 * Hook for fetching health metrics for multiple projects.
 *
 * Automatically polls every 10 seconds when the ProjectOverview is visible.
 * Stops polling when component unmounts.
 * Fetches health in batches to avoid overwhelming the server.
 *
 * Loading behavior: `loading` is true only during the initial fetch.
 * Background polling updates do NOT set `loading` to true, so the UI
 * keeps previously loaded data visible during refreshes. This prevents
 * skeleton flicker and scroll position resets during periodic updates.
 */
export function useProjectHealth(projectIds: string[]): UseMultiProjectHealthResult {
  // The caller can provide duplicate IDs from overlapping node sources; fetch and publish each logical project once.
  const projectIdsKey = projectIds.join("\u0000");
  const uniqueProjectIds = useMemo(() => [...new Set(projectIds)], [projectIdsKey]);
  const [healthMap, setHealthMap] = useState<Record<string, ProjectHealth | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestVersionRef = useRef(0);
  const healthMapRef = useRef(healthMap);
  const visibilitySuspension = useTabVisibilitySuspension();
  const initialLoadCompleteRef = useRef(false);

  useEffect(() => {
    healthMapRef.current = healthMap;
  }, [healthMap]);

  const shouldSuppressVisibilityResumeError = useCallback((errorMessage: string): boolean => {
    return Object.keys(healthMapRef.current).length > 0 && isVisibilityResumeError(errorMessage, visibilitySuspension.wasRecentlyHidden());
  }, [visibilitySuspension]);

  const refresh = useCallback(async () => {
    if (uniqueProjectIds.length === 0) {
      abortRef.current?.abort();
      requestVersionRef.current += 1;
      setHealthMap({});
      initialLoadCompleteRef.current = true;
      setLoading(false);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestVersion = ++requestVersionRef.current;
    const isInitial = !initialLoadCompleteRef.current;

    if (isInitial) {
      setLoading(true);
    }
    setError(null);

    try {
      for (let index = 0; index < uniqueProjectIds.length; index += BATCH_SIZE) {
        const batch = uniqueProjectIds.slice(index, index + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(async (id) => {
            try {
              return await fetchProjectHealth(id);
            } catch {
              return null;
            }
          }),
        );

        if (controller.signal.aborted || requestVersion !== requestVersionRef.current) {
          return;
        }

        const completedBatch = Object.fromEntries(batch.map((id, batchIndex) => {
          const result = batchResults[batchIndex];
          return [id, result.status === "fulfilled" ? result.value : null];
        }));

        /*
        FNXC:ProjectHealthProgress 2026-08-01-15:40:
        Health metrics are independent, optional telemetry. Publish each completed bounded batch immediately
        so ProjectOverview hydrates visible cards and aggregate values progressively; a slower later batch must
        not hold completed project data behind the initial-load gate.
        */
        setHealthMap((previous) => ({ ...previous, ...completedBatch }));
      }

      if (requestVersion === requestVersionRef.current && !controller.signal.aborted) {
        initialLoadCompleteRef.current = true;
      }
    } catch (err) {
      if (controller.signal.aborted || requestVersion !== requestVersionRef.current || (err instanceof Error && err.name === "AbortError")) {
        return;
      }

      const errorMessage = err instanceof Error ? err.message : "Failed to fetch health data";
      if (!shouldSuppressVisibilityResumeError(errorMessage)) {
        setError(errorMessage);
      }
      initialLoadCompleteRef.current = true;
    } finally {
      if (requestVersion === requestVersionRef.current && !controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [shouldSuppressVisibilityResumeError, uniqueProjectIds]);

  const refreshProject = useCallback(async (projectId: string) => {
    const requestVersion = requestVersionRef.current;
    try {
      const health = await fetchProjectHealth(projectId);
      if (requestVersion !== requestVersionRef.current) return;

      setHealthMap((previous) => ({
        ...previous,
        [projectId]: health,
      }));
    } catch (err) {
      console.error(`Failed to fetch health for project ${projectId}:`, err);
    }
  }, []);

  useEffect(() => {
    initialLoadCompleteRef.current = false;
    setHealthMap({});
    void refresh();

    return () => {
      abortRef.current?.abort();
    };
  }, [refresh]);

  /*
  FNXC:MobileTabRetention 2026-07-26-10:30:
  Per-project health polling is suspended while the document is hidden. Background network work keeps the
  page from ever going idle, which is what makes mobile browsers reclaim the tab and force a cold reload on
  return; one refresh fires on the hidden -> visible edge so health badges are not stale when seen.
  */
  useVisibilityAwarePoll(refresh, POLL_INTERVAL_MS, { enabled: uniqueProjectIds.length > 0 });

  return {
    healthMap,
    loading,
    error,
    refresh,
    refreshProject,
  };
}
