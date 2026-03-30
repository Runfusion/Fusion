import { useState, useEffect, useCallback, useRef } from "react";
import { fetchUsageData, type ProviderUsage } from "../api";

interface UsageDataState {
  providers: ProviderUsage[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
}

interface UseUsageDataOptions {
  /** Auto-refresh interval in ms (default: 30 seconds) */
  pollInterval?: number;
  /** Whether to auto-refresh (default: true) */
  autoRefresh?: boolean;
}

/**
 * Hook for fetching and polling provider usage data.
 * 
 * Features:
 * - Initial fetch on mount
 * - Auto-refresh every 30 seconds when enabled
 * - Manual refresh capability
 * - Loading and error states
 * - Cleanup on unmount
 */
export function useUsageData(options: UseUsageDataOptions = {}) {
  const { pollInterval = 30_000, autoRefresh = true } = options;

  const [state, setState] = useState<UsageDataState>({
    providers: [],
    loading: true,
    error: null,
    lastUpdated: null,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (isManual = false) => {
    // Cancel any in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    if (isManual) {
      setState((prev) => ({ ...prev, loading: true, error: null }));
    }

    try {
      const { providers } = await fetchUsageData();
      setState({
        providers,
        loading: false,
        error: null,
        lastUpdated: new Date(),
      });
    } catch (err: any) {
      // Don't update state if the request was aborted
      if (err.name === "AbortError") return;

      setState((prev) => ({
        ...prev,
        loading: false,
        error: err.message || "Failed to fetch usage data",
      }));
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;

    pollRef.current = setInterval(() => {
      fetchData(false);
    }, pollInterval);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [autoRefresh, pollInterval, fetchData]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, []);

  const refresh = useCallback(() => {
    return fetchData(true);
  }, [fetchData]);

  return {
    providers: state.providers,
    loading: state.loading,
    error: state.error,
    lastUpdated: state.lastUpdated,
    refresh,
  };
}
