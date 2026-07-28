import { useState, useEffect, useCallback, useRef } from "react";
import { getErrorMessage } from "@fusion/core";
import { fetchUsageData, type ProviderUsage } from "../api";
import { isVisibilityResumeError, useTabVisibilitySuspension, useVisibilityAwarePoll } from "./visibilitySuspension";

interface UsageDataState {
  providers: ProviderUsage[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  hasFetched: boolean;
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
    hasFetched: false,
  });

  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  const visibilitySuspension = useTabVisibilitySuspension();

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const shouldSuppressVisibilityResumeError = useCallback((errorMessage: string): boolean => {
    return stateRef.current.hasFetched && isVisibilityResumeError(errorMessage, visibilitySuspension.wasRecentlyHidden());
  }, [visibilitySuspension]);

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
        hasFetched: true,
      });
    } catch (err) {
      // Don't update state if the request was aborted
      if (err instanceof Error && err.name === "AbortError") return;

      const errorMessage = getErrorMessage(err) || "Failed to fetch usage data";
      if (shouldSuppressVisibilityResumeError(errorMessage)) {
        setState((prev) => ({
          ...prev,
          loading: false,
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        loading: false,
        error: errorMessage,
        hasFetched: true,
      }));
    }
  }, [shouldSuppressVisibilityResumeError]);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /*
  FNXC:MobileTabRetention 2026-07-26-11:00:
  Usage auto-refresh is suspended while the document is hidden. Provider usage is a display-only number, and
  a backgrounded page that keeps polling it is treated by iOS Safari/PWA and Chrome Android as a live page
  worth reclaiming — the discard is what produced the full white-splash reload on return. The hidden ->
  visible edge refreshes once so the returning operator sees current usage.
  */
  const pollUsage = useCallback(() => {
    void fetchData(false);
  }, [fetchData]);
  useVisibilityAwarePoll(pollUsage, pollInterval, { enabled: autoRefresh });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
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
    hasFetched: state.hasFetched,
    refresh,
  };
}
