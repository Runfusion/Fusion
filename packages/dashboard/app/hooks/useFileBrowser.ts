import { useState, useEffect, useCallback } from "react";
import type { FileNode, FileListResponse } from "../api";
import { fetchFileList } from "../api";

interface UseFileBrowserReturn {
  entries: FileNode[];
  currentPath: string;
  setPath: (path: string) => void;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Hook for browsing files in a task directory.
 *
 * @param taskId - The task ID to browse
 * @param enabled - Whether to enable fetching (e.g., when tab is active)
 * @param projectId - Optional project ID for scoped store resolution
 * @returns File browser state and controls
 */
export function useFileBrowser(taskId: string, enabled: boolean, projectId?: string): UseFileBrowserReturn {
  const [entries, setEntries] = useState<FileNode[]>([]);
  const [currentPath, setCurrentPath] = useState<string>(".");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const setPath = useCallback((path: string) => {
    setCurrentPath(path);
    setError(null);
  }, []);

  useEffect(() => {
    if (!enabled || !taskId) {
      return;
    }

    let cancelled = false;

    async function loadFiles() {
      setLoading(true);
      setError(null);

      try {
        const response: FileListResponse = await fetchFileList(
          taskId,
          currentPath === "." ? undefined : currentPath,
          projectId
        );

        if (!cancelled) {
          setEntries(response.entries);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || "Failed to load files");
          setEntries([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadFiles();

    return () => {
      cancelled = true;
    };
  }, [taskId, currentPath, enabled, refreshKey, projectId]);

  return {
    entries,
    currentPath,
    setPath,
    loading,
    error,
    refresh,
  };
}
