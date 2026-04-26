import { useState, useEffect, useCallback, useRef } from "react";
import { fetchMemoryBackendStatus, type MemoryBackendStatus } from "../api";

interface UseMemoryBackendStatusOptions {
  /** Project ID for multi-project contexts */
  projectId?: string;
  /** Auto-refresh interval in ms (default: 60 seconds) */
  pollInterval?: number;
  /** Whether to auto-refresh (default: false) */
  autoRefresh?: boolean;
}

/**
 * Hook for fetching memory backend status and capabilities.
 *
 * Features:
 * - Fetches backend status on mount
 * - Optional auto-refresh polling
 * - Manual refresh capability
 * - Loading and error states
 * - Guards against stale async updates on unmount/re-render
 * - Respects project context via optional projectId
 */
export function useMemoryBackendStatus(options: UseMemoryBackendStatusOptions = {}) {
  const { projectId, pollInterval = 60_000, autoRefresh = false } = options;

  const [status, setStatus] = useState<MemoryBackendStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track if the component is still mounted to prevent stale updates
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    // Cancel any in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    // Always reset to unresolved while a new request is in flight so stale
    // capabilities are never treated as authoritative.
    setLoading(true);
    setError(null);
    setStatus(null);

    try {
      const data = await fetchMemoryBackendStatus(projectId);

      // Guard against stale updates when component unmounts or project changes
      if (!mountedRef.current) {
        return;
      }

      setStatus(data);
      setError(null);
      setLastUpdated(new Date());
      setLoading(false);
    } catch (err: unknown) {
      // Don't update state if the request was aborted
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }

      // Guard against stale updates
      if (!mountedRef.current) {
        return;
      }

      const message = err instanceof Error ? err.message : "Failed to fetch memory backend status";
      setError(message);
      setLoading(false);
    }
  }, [projectId]);

  // Initial fetch
  useEffect(() => {
    mountedRef.current = true;
    fetchStatus();

    return () => {
      mountedRef.current = false;
    };
  }, [fetchStatus]);

  // Auto-refresh polling
  useEffect(() => {
    if (!autoRefresh) return;

    pollRef.current = setInterval(() => {
      fetchStatus();
    }, pollInterval);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [autoRefresh, pollInterval, fetchStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (abortRef.current) {
        abortRef.current.abort();
      }
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  const refresh = useCallback(() => {
    return fetchStatus();
  }, [fetchStatus]);

  // Derived convenience getters
  // Hide stale status while loading to preserve unknown/loading semantics.
  const resolvedStatus = loading ? null : status;
  const currentBackend = resolvedStatus?.currentBackend ?? null;
  const capabilities = resolvedStatus?.capabilities ?? null;
  const availableBackends = resolvedStatus?.availableBackends ?? [];

  const isReadable = capabilities?.readable ?? false;
  const isWritable = capabilities?.writable ?? false;
  const supportsAtomicWrite = capabilities?.supportsAtomicWrite ?? false;

  return {
    // Raw status
    status: resolvedStatus,
    // Convenience getters
    currentBackend,
    capabilities,
    availableBackends,
    isReadable,
    isWritable,
    supportsAtomicWrite,
    // State
    loading,
    error,
    lastUpdated,
    // Actions
    refresh,
  };
}
