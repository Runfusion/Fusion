import { useEffect, useState } from "react";
import { fetchTaskFileDiffs, type TaskFileDiff } from "../api";

const ACTIVE_COLUMNS = new Set(["in-progress", "in-review"]);

interface UseChangedFilesResult {
  files: TaskFileDiff[];
  loading: boolean;
  error: string | null;
  selectedFile: TaskFileDiff | null;
  setSelectedFile: (file: TaskFileDiff) => void;
}

export function useChangedFiles(taskId: string, worktree: string | undefined, column: string): UseChangedFilesResult {
  const [files, setFiles] = useState<TaskFileDiff[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<TaskFileDiff | null>(null);

  useEffect(() => {
    if (!taskId || !worktree || !ACTIVE_COLUMNS.has(column)) {
      setFiles([]);
      setLoading(false);
      setError(null);
      setSelectedFile(null);
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchTaskFileDiffs(taskId);
        if (cancelled) return;
        setFiles(result);
        setSelectedFile((current) => {
          if (result.length === 0) return null;
          if (current) {
            const match = result.find((file) => file.path === current.path && file.oldPath === current.oldPath);
            if (match) return match;
          }
          return result[0] ?? null;
        });
      } catch (err) {
        if (cancelled) return;
        setFiles([]);
        setSelectedFile(null);
        setError(err instanceof Error ? err.message : "Failed to load changed files");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [taskId, worktree, column]);

  return { files, loading, error, selectedFile, setSelectedFile };
}
