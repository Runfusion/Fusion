import { useState, useEffect, useCallback } from "react";
import { getErrorMessage } from "@fusion/core";
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

interface UseWorkspaceFileBrowserOptions {
  allowAbsolutePaths?: boolean;
}

function isSlashPrefixedAbsolutePath(path: string): boolean {
  return path.startsWith("/");
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
  options: UseWorkspaceFileBrowserOptions = {},
): UseWorkspaceFileBrowserReturn {
  const [entries, setEntries] = useState<FileNode[]>([]);
  const [currentPath, setCurrentPath] = useState<string>(".");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const allowAbsolutePaths = options.allowAbsolutePaths !== false;

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  const setPath = useCallback((path: string) => {
    if (!allowAbsolutePaths && isSlashPrefixedAbsolutePath(path)) {
      setError("This picker only accepts project-relative paths");
      return;
    }

    setCurrentPath(path);
    setError(null);
  }, [allowAbsolutePaths]);

  /*
  FNXC:FileBrowser 2026-06-29-19:35:
  Workspace file pickers must start each workspace at root so SettingsModal directory/file pickers do not inherit editor selection state. FileBrowserModal restores its selected file path at the modal layer when it needs editor persistence across worktree switches.

  FNXC:FileBrowserAbsolutePaths 2026-06-29-00:00:
  Settings-modal path pickers save project-relative contracts for overlap ignore paths and worktree copy files. Keep absolute browsing opt-in at the top-level file browser by letting callers reject slash-prefixed navigation before it reaches settings form state.
  */
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
      } catch (err) {
        if (!cancelled) {
          setError(getErrorMessage(err) || "Failed to load files");
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
