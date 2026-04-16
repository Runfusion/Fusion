import { useState, useEffect, useRef, useCallback } from "react";
import type { TaskDocumentWithTask } from "@fusion/core";
import { fetchAllDocuments } from "../api";

export interface UseDocumentsResult {
  /** List of all documents across tasks */
  documents: TaskDocumentWithTask[];
  /** Loading state - true only for initial fetch, false during refresh/search */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Refresh documents from the server */
  refresh: () => Promise<void>;
}

/**
 * Hook for fetching all documents across tasks with optional search.
 *
 * Loading behavior: `loading` is true only during the initial fetch.
 * Refresh or search changes do NOT set `loading` to true, keeping
 * previously loaded data visible. This prevents skeleton flicker
 * during search filtering and manual refreshes.
 */
export function useDocuments(options?: {
  /** Project ID for project-scoped fetching */
  projectId?: string;
  /** Search query for filtering documents */
  searchQuery?: string;
}): UseDocumentsResult {
  const { projectId, searchQuery } = options ?? {};
  const [documents, setDocuments] = useState<TaskDocumentWithTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Track if we've completed the initial load
  const initialLoadCompleteRef = useRef(false);
  // Debounce timer for search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Fetch documents from the server.
   * Background updates (refresh, search) do NOT set loading=true.
   */
  const refresh = useCallback(async () => {
    // Cancel any in-flight requests
    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    // Only set loading on initial load
    const isInitial = !initialLoadCompleteRef.current;
    if (isInitial) {
      setLoading(true);
    }
    setError(null);

    try {
      const result = await fetchAllDocuments(
        searchQuery ? { q: searchQuery } : undefined,
        projectId,
      );
      setDocuments(result);
      initialLoadCompleteRef.current = true;
      setLoading(false);
    } catch (err) {
      if (abortRef.current?.signal.aborted) {
        // Request was cancelled - ignore
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      if (isInitial) {
        setLoading(false);
      }
    }
  }, [projectId, searchQuery]);

  // Debounced search effect
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      void refresh();
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [refresh]);

  // Initial fetch - intentionally empty deps, only runs on mount
  useEffect(() => {
    void refresh();

    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
  }, []);

  return {
    documents,
    loading,
    error,
    refresh,
  };
}
