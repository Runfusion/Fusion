import { useState, useEffect, useCallback } from "react";
import type { FileNode, FileListResponse } from "../api";
import { fetchWorkspaceFileList } from "../api";

interface UseProjectFileBrowserReturn {
  entries: FileNode[];
  currentPath: string;
  setPath: (path: string) => void;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Hook for browsing files in the project root directory.
 *
 * @param rootPath - The project root directory path (from config/store)
 * @param enabled - Whether to enable fetching (e.g., when modal is open)
 * @returns File browser state and controls
 */
export function useProjectFileBrowser(rootPath: string, enabled: boolean): UseProjectFileBrowserReturn {
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
    if (!enabled) {
      return;
    }

    let cancelled = false;

    async function loadFiles() {
      setLoading(true);
      setError(null);

      try {
        const response: FileListResponse = await fetchWorkspaceFileList(
          "project",
          currentPath === "." ? undefined : currentPath
        );

        if (!cancelled) {
          setEntries(response.entries);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message || "Failed to load files");
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
  }, [currentPath, enabled, refreshKey]);

  return {
    entries,
    currentPath,
    setPath,
    loading,
    error,
    refresh,
  };
}
