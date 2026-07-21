import { useState, useEffect, useRef, useCallback } from "react";
import type { TaskDocumentWithTask } from "@fusion/core";
import { fetchAllDocuments, fetchProjectMarkdownFiles, type MarkdownFileEntry } from "../api";
import { readCache, SWR_CACHE_KEYS, SWR_DEFAULT_MAX_AGE_MS, writeCache } from "../utils/swrCache";
import { useProjectContextGuard } from "./useProjectContextGuard";

export interface UseDocumentsResult {
  /** List of all documents across tasks */
  documents: TaskDocumentWithTask[];
  /** List of markdown files discovered in the project workspace */
  projectFiles: MarkdownFileEntry[];
  /** Loading state - true only for initial fetch, false during refresh/search */
  loading: boolean;
  /** Error message if task document fetch failed */
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
  /** Whether to include project markdown files in the response (defaults to true) */
  includeProjectFiles?: boolean;
}): UseDocumentsResult {
  const { projectId, searchQuery, includeProjectFiles = true } = options ?? {};
  const cacheKey = projectId ? `${SWR_CACHE_KEYS.DOCUMENTS_PREFIX}${projectId}` : null;
  const [documents, setDocuments] = useState<TaskDocumentWithTask[]>(() => {
    if (!cacheKey) {
      return [];
    }
    const cached = readCache<TaskDocumentWithTask[]>(cacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    return Array.isArray(cached) ? cached : [];
  });
  const [projectFiles, setProjectFiles] = useState<MarkdownFileEntry[]>([]);
  const [loading, setLoading] = useState(() => documents.length === 0);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Track if we've completed the initial load
  const initialLoadCompleteRef = useRef(documents.length > 0);
  // Debounce timer for search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /*
  FNXC:ProjectScoping 2026-07-15-20:10:
  Documents and workspace-file responses must match the project captured when
  the request started; the shared guard rejects a late old-project payload.
  */
  const { capture } = useProjectContextGuard(projectId, "useDocuments");

  /**
   * Fetch documents from the server.
   * Background updates (refresh, search) do NOT set loading=true.
   */
  const refresh = useCallback(async () => {
    const context = capture();
    // Cancel any in-flight requests
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const requestController = new AbortController();
    abortRef.current = requestController;

    // Only set loading on initial load when we have no cached docs.
    const isInitial = !initialLoadCompleteRef.current;
    if (isInitial) {
      setLoading(true);
    }
    setError(null);

    const documentFetchPromise = fetchAllDocuments(
      searchQuery ? { q: searchQuery } : undefined,
      projectId,
    );

    const projectFileFetchPromise = includeProjectFiles
      ? fetchProjectMarkdownFiles(projectId)
      : Promise.resolve({ files: [] as MarkdownFileEntry[] });

    const [documentResult, projectFileResult] = await Promise.allSettled([
      documentFetchPromise,
      projectFileFetchPromise,
    ]);

    if (requestController.signal.aborted || context.isStale()) {
      return;
    }

    let documentError: string | null = null;

    if (documentResult.status === "fulfilled") {
      setDocuments(documentResult.value);
      if (cacheKey) {
        const cachedPayload = documentResult.value.length > 500 ? documentResult.value.slice(0, 500) : documentResult.value;
        writeCache(cacheKey, cachedPayload, { maxBytes: 500_000 });
      }
      initialLoadCompleteRef.current = true;
    } else {
      documentError = documentResult.reason instanceof Error
        ? documentResult.reason.message
        : String(documentResult.reason);
    }

    if (projectFileResult.status === "fulfilled") {
      const fetchedFiles = projectFileResult.value.files;
      const normalizedSearch = searchQuery?.trim().toLowerCase();
      const filteredFiles = normalizedSearch
        ? fetchedFiles.filter((file) =>
          file.name.toLowerCase().includes(normalizedSearch) ||
          file.path.toLowerCase().includes(normalizedSearch))
        : fetchedFiles;
      setProjectFiles(filteredFiles);
    }

    setError(documentError);

    if (isInitial) {
      setLoading(false);
    }
  }, [cacheKey, capture, includeProjectFiles, projectId, searchQuery]);

  useEffect(() => {
    /*
    FNXC:ProjectScoping 2026-07-16-00:00:
    Workspace markdown files are project-scoped alongside task documents. Clear
    them during a switch so project A paths cannot render while B loads.
    */
    setProjectFiles([]);
    if (!cacheKey) {
      initialLoadCompleteRef.current = false;
      setDocuments([]);
      setLoading(true);
      return;
    }

    const cached = readCache<TaskDocumentWithTask[]>(cacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    if (Array.isArray(cached)) {
      setDocuments(cached);
      initialLoadCompleteRef.current = true;
      setLoading(false);
    } else {
      initialLoadCompleteRef.current = false;
      setDocuments([]);
      setLoading(true);
    }
  }, [cacheKey]);

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
  }, []);

  return {
    documents,
    projectFiles,
    loading,
    error,
    refresh,
  };
}
