import { useEffect, useState, useCallback } from "react";
import { fetchTaskFileDiffs, fetchCommitDiff, type TaskFileDiff } from "../api";
import { parsePatch } from "../components/CommitDiffTab";

const ACTIVE_COLUMNS = new Set(["in-progress", "in-review"]);

interface UseChangedFilesResult {
  files: TaskFileDiff[];
  loading: boolean;
  error: string | null;
  selectedFile: TaskFileDiff | null;
  setSelectedFile: (file: TaskFileDiff) => void;
  resetSelection: () => void;
}

export function useChangedFiles(
  taskId: string,
  worktree: string | undefined,
  column: string,
  projectId?: string,
  commitSha?: string,
): UseChangedFilesResult {
  const [files, setFiles] = useState<TaskFileDiff[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<TaskFileDiff | null>(null);

  const isDone = column === "done";

  useEffect(() => {
    // For active tasks: need worktree
    // For done tasks: need commitSha
    if (!taskId || (!isDone && (!worktree || !ACTIVE_COLUMNS.has(column))) || (isDone && !commitSha)) {
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
        let result: TaskFileDiff[];
        if (isDone && commitSha) {
          // Done task: fetch from commit history
          const data = await fetchCommitDiff(commitSha);
          const parsed = parsePatch(data.patch || "");
          result = parsed.map((f) => ({
            path: f.path,
            status: f.status === "unknown" ? "modified" as const : f.status,
            diff: f.patch,
            oldPath: undefined,
          }));
        } else {
          // Active task: fetch from worktree
          result = await fetchTaskFileDiffs(taskId, projectId);
        }
        if (cancelled) return;
        setFiles(result);
        setSelectedFile((current) => {
          if (result.length === 0) return null;
          if (current) {
            const match = result.find(
              (file) => file.path === current.path && file.oldPath === current.oldPath,
            );
            if (match) return match;
          }
          return null;
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
  }, [taskId, worktree, column, projectId, commitSha, isDone]);

  const resetSelection = useCallback(() => {
    setSelectedFile(null);
  }, []);

  return { files, loading, error, selectedFile, setSelectedFile, resetSelection };
}
