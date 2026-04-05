import { useEffect, useState } from "react";
import { fetchTaskDiff } from "../api";

interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

interface UseTaskDiffStatsResult {
  stats: DiffStats | null;
  loading: boolean;
}

/**
 * Fetches diff stats for a done task that has a merge commit SHA.
 *
 * This ensures the TaskCard shows the same file-changed count as the
 * TaskChangesTab (which fetches from `/api/tasks/:id/diff`). Without this
 * hook the card falls back to `mergeDetails.filesChanged`, which is
 * computed at merge time via `git show --shortstat` and can differ from the
 * diff endpoint's count when the merge includes changes from multiple branches.
 */
export function useTaskDiffStats(
  taskId: string,
  column: string,
  commitSha: string | undefined,
  projectId?: string,
): UseTaskDiffStatsResult {
  const [stats, setStats] = useState<DiffStats | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Only fetch for done tasks with a recorded merge commit
    if (!taskId || column !== "done" || !commitSha) {
      setStats(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const data = await fetchTaskDiff(taskId, undefined, projectId);
        if (!cancelled) {
          setStats(data.stats);
        }
      } catch {
        if (!cancelled) {
          setStats(null);
        }
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
  }, [taskId, column, commitSha, projectId]);

  return { stats, loading };
}
