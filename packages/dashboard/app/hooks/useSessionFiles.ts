import { useEffect, useState } from "react";
import { fetchSessionFiles } from "../api";

const ACTIVE_COLUMNS = new Set(["in-progress", "in-review", "done"]);

interface UseSessionFilesResult {
  files: string[];
  loading: boolean;
}

export function useSessionFiles(taskId: string, worktree: string | undefined, column: string, projectId?: string): UseSessionFilesResult {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!taskId || !worktree || !ACTIVE_COLUMNS.has(column)) {
      setFiles([]);
      setLoading(false);
      return;
    }

    let cancelled = false;

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
  }, [taskId, worktree, column, projectId]);

  return { files, loading };
}
