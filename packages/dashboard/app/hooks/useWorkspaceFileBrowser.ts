import { useState, useEffect, useCallback } from "react";
import type { FileNode, FileListResponse } from "../api";
import { fetchWorkspaceFileList } from "../api";

interface UseWorkspaceFileBrowserReturn {
  entries: FileNode[];
  currentPath: string;
  setPath: (path: string) => void;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Hook for browsing files in a selected workspace.
 *
 * @param workspace - The workspace identifier ("project" or task ID)
 * @param enabled - Whether fetching is enabled
 * @param projectId - Optional project ID for multi-project scoping
 */
export function useWorkspaceFileBrowser(
  workspace: string,
  enabled: boolean,
  projectId?: string,
): UseWorkspaceFileBrowserReturn {
  const [entries, setEntries] = useState<FileNode[]>([]);
  const [currentPath, setCurrentPath] = useState<string>(".");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  const setPath = useCallback((path: string) => {
    setCurrentPath(path);
    setError(null);
  }, []);

  useEffect(() => {
    setCurrentPath(".");
    setError(null);
    setEntries([]);
  }, [workspace]);

  useEffect(() => {
    if (!enabled || !workspace) {
      return;
    }

    let cancelled = false;

    async function loadFiles() {
      setLoading(true);
      setError(null);

      try {
        const response: FileListResponse = await fetchWorkspaceFileList(
          workspace,
          currentPath === "." ? undefined : currentPath,
          projectId,
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

    void loadFiles();

    return () => {
      cancelled = true;
    };
  }, [workspace, currentPath, enabled, refreshKey, projectId]);

  return {
    entries,
    currentPath,
    setPath,
    loading,
    error,
    refresh,
  };
}
