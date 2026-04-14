import { useEffect, useState } from "react";
import { fetchSessionFiles } from "../api";

const ACTIVE_COLUMNS = new Set(["in-progress", "in-review", "done"]);

interface UseSessionFilesResult {
  files: string[];
  loading: boolean;
}

interface UseSessionFilesOptions {
  /** Enable fetching when true (default). Suppresses fetches for offscreen cards. */
  enabled?: boolean;
}

/**
 * Fetches session files for tasks with active worktrees.
 *
 * @param taskId - Task identifier
 * @param worktree - Worktree path (undefined = no worktree)
 * @param column - Current task column
 * @param projectId - Optional project identifier
 * @param options.enabled - When false, no fetch is made and returns empty/stable state
 */
export function useSessionFiles(
  taskId: string,
  worktree: string | undefined,
  column: string,
  projectId?: string,
  options: UseSessionFilesOptions = {},
): UseSessionFilesResult {
  const enabled = options.enabled ?? true;
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Disabled state: return stable empty state without fetching
    if (!enabled) {
      setFiles([]);
      setLoading(false);
      return;
    }

    if (!taskId || !worktree || !ACTIVE_COLUMNS.has(column)) {
      setFiles([]);
      setLoading(false);
      return;
    }

    const cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const result = await fetchSessionFiles(taskId, projectId);
        if (!cancelled) {
          setFiles(result);
        }
      } catch {
        if (!cancelled) {
          setFiles([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
  }, [taskId, worktree, column, projectId, enabled]);

  return { files, loading };
}
