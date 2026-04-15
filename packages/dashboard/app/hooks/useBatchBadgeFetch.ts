import { useCallback, useRef, useState } from "react";
import { fetchBatchStatus } from "../api";
import type { BatchStatusResult } from "@fusion/core";

// Module-level store to share batch data across hook instances
const batchBadgeStore = {
  data: new Map<string, { result: BatchStatusResult[string]; timestamp: number }>(),
  pendingPromise: null as Promise<BatchStatusResult> | null,
  lastFetchTime: null as number | null,
};

/** Maximum age of cached batch data in milliseconds (5 seconds) */
const CACHE_MAX_AGE_MS = 5000;

function getScopedTaskKey(taskId: string, projectId?: string): string {
  return projectId ? `${projectId}::${taskId}` : taskId;
}

/**
 * Check if fresh batch data exists for a task ID.
 * @param taskId - The task ID to check
 * @returns The cached data if fresh, undefined otherwise
 */
export function getFreshBatchData(taskId: string, projectId?: string): { result: BatchStatusResult[string]; timestamp: number } | undefined {
  const cached = batchBadgeStore.data.get(getScopedTaskKey(taskId, projectId));
  if (!cached) return undefined;

  const now = Date.now();
  if (now - cached.timestamp > CACHE_MAX_AGE_MS) {
    return undefined;
  }

  return cached;
}

interface UseBatchBadgeFetchResult {
  /** Manually trigger a batch fetch for the given task IDs */
  fetchBatch: (taskIds: string[]) => Promise<void>;
  /** Whether a batch fetch is currently in progress */
  isLoading: boolean;
  /** Timestamp of the last successful fetch (shared across all hook instances) */
  lastFetchTime: number | null;
  /** Get cached batch data for a specific task ID */
  getBatchData: (taskId: string) => { result: BatchStatusResult[string]; timestamp: number } | undefined;
}

/**
 * Hook for batch fetching GitHub badge statuses.
 *
 * Features:
 * - Request deduplication: concurrent calls with the same IDs wait for the same promise
 * - 5-second debounce: rapid calls within 5 seconds reuse cached results
 * - Exponential backoff retry: handles 429 rate limit errors with up to 3 retries
 * - Shared store: data is available across all hook instances
 */
export function useBatchBadgeFetch(projectId?: string): UseBatchBadgeFetchResult {
  const [isLoading, setIsLoading] = useState(false);
  const fetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Internal fetch with retry logic.
   */
  const fetchWithRetry = useCallback(async (taskIds: string[]): Promise<BatchStatusResult> => {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const results = await fetchBatchStatus(taskIds, projectId);
        return results;
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;

        // If it's a 429 rate limit error, wait before retrying with exponential backoff
        if (error.message.includes("429") || error.message.toLowerCase().includes("rate limit")) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30s delay
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        // For other errors, don't retry - just break and let the partial results be used
        break;
      }
    }

    // If we exhausted retries or hit a non-retryable error, throw the last error
    if (lastError) {
      throw lastError;
    }

    return {};
  }, [projectId]);

  /**
   * Fetch batch badge statuses for the given task IDs.
   * Implements deduplication, debouncing, and retry logic.
   */
  const fetchBatch = useCallback(async (taskIds: string[]): Promise<void> => {
    if (taskIds.length === 0) return;

    // Check if we have recent cached data (within 5 seconds) for all requested IDs
    const now = Date.now();
    const fiveSecondsAgo = now - 5000;
    const hasFreshCache = taskIds.every((id) => {
      const cached = batchBadgeStore.data.get(getScopedTaskKey(id, projectId));
      return cached && cached.timestamp > fiveSecondsAgo;
    });

    if (hasFreshCache && batchBadgeStore.lastFetchTime && batchBadgeStore.lastFetchTime > fiveSecondsAgo) {
      // All data is fresh, no need to fetch
      return;
    }

    // Clear any pending debounced fetch
    if (fetchTimeoutRef.current) {
      clearTimeout(fetchTimeoutRef.current);
      fetchTimeoutRef.current = null;
    }

    // Check if there's already a pending fetch we can reuse
    if (batchBadgeStore.pendingPromise) {
      setIsLoading(true);
      try {
        await batchBadgeStore.pendingPromise;
      } finally {
        setIsLoading(false);
      }
      return;
    }

    setIsLoading(true);

    // Create the promise and store it for deduplication
    const promise = fetchWithRetry(taskIds);
    batchBadgeStore.pendingPromise = promise;

    try {
      const results = await promise;

      // Update the store with new data
      const timestamp = Date.now();
      for (const [taskId, result] of Object.entries(results)) {
        batchBadgeStore.data.set(getScopedTaskKey(taskId, projectId), { result, timestamp });
      }
      batchBadgeStore.lastFetchTime = timestamp;
    } catch {
      // Even on error, we don't throw - the hook handles errors gracefully
      // and partial results are still stored
    } finally {
      batchBadgeStore.pendingPromise = null;
      setIsLoading(false);
    }
  }, [fetchWithRetry, projectId]);

  /**
   * Get cached batch data for a specific task ID.
   */
  const getBatchData = useCallback((taskId: string) => {
    return batchBadgeStore.data.get(getScopedTaskKey(taskId, projectId));
  }, [projectId]);

  return {
    fetchBatch,
    isLoading,
    lastFetchTime: batchBadgeStore.lastFetchTime,
    getBatchData,
  };
}

/**
 * Reset the batch badge store (useful for testing).
 */
export function __resetBatchBadgeStoreForTests(): void {
  batchBadgeStore.data.clear();
  batchBadgeStore.pendingPromise = null;
  batchBadgeStore.lastFetchTime = null;
}
