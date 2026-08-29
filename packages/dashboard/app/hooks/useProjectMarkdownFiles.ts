import { useState, useEffect, useRef, useCallback } from "react";
import { fetchProjectMarkdownFiles, type MarkdownFileEntry } from "../api";

export interface ProjectMarkdownFilesVisibilityOptions {
  showHidden?: boolean;
}

export interface UseProjectMarkdownFilesResult {
  files: MarkdownFileEntry[];
  loading: boolean;
  error: string | null;
  refresh: (options?: ProjectMarkdownFilesVisibilityOptions) => Promise<void>;
}

/**
 * Hook for fetching markdown files from the project workspace.
 *
 * Loading behavior matches useDocuments: loading is true only for the initial
 * fetch, not for subsequent refreshes, to avoid content flicker.
 */
export function useProjectMarkdownFiles(
  projectId?: string,
  options?: ProjectMarkdownFilesVisibilityOptions,
): UseProjectMarkdownFilesResult {
  const [files, setFiles] = useState<MarkdownFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const initialLoadCompleteRef = useRef(false);

  const showHidden = options?.showHidden ?? false;

  const refresh = useCallback(async (refreshOptions?: ProjectMarkdownFilesVisibilityOptions) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const requestController = new AbortController();
    abortRef.current = requestController;

    const isInitial = !initialLoadCompleteRef.current;
    if (isInitial) {
      setLoading(true);
    }

    setError(null);

    try {
      const response = await fetchProjectMarkdownFiles(projectId, {
        showHidden: refreshOptions?.showHidden ?? showHidden,
      });

      if (requestController.signal.aborted) {
        return;
      }

      setFiles(response.files);
      initialLoadCompleteRef.current = true;
    } catch (err: unknown) {
      if (requestController.signal.aborted) {
        return;
      }

      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!requestController.signal.aborted && isInitial) {
        setLoading(false);
      }
    }
  }, [projectId, showHidden]);

  useEffect(() => {
    initialLoadCompleteRef.current = false;
    void refresh({ showHidden });

    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [refresh, showHidden]);

  return {
    files,
    loading,
    error,
    refresh,
  };
}
