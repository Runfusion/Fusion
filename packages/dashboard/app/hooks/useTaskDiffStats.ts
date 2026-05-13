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

interface UseTaskDiffStatsOptions {
  /** Enable fetching when true (default). Suppresses fetches for offscreen cards. */
  enabled?: boolean;
  /** Worktree path for active task columns. */
  worktree?: string;
  /** Version identifier that changes when steps update. Forces cache invalidation when changed. */
  stepVersion?: number | string;
  /** Poll interval in ms for active columns (in-progress, in-review). Forces re-fetch bypassing cache. */
  pollIntervalMs?: number;
}

/**
 * Cache for diff stats to avoid repeated fetches during rerenders.
 * Key format: "taskId:projectId"
 * Entries expire after the TTL to ensure freshness.
 */
const diffStatsCache = new Map<string, { stats: DiffStats; expiresAt: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

function getCacheKey(taskId: string, projectId?: string, worktree?: string, stepVersion?: string): string {
  return `${taskId}:${projectId ?? ""}:${worktree ?? ""}:${stepVersion ?? ""}`;
}

function getCachedStats(taskId: string, projectId?: string, worktree?: string, stepVersion?: string): DiffStats | null {
  const key = getCacheKey(taskId, projectId, worktree, stepVersion);
  const entry = diffStatsCache.get(key);

  if (!entry) return null;

  // Check expiration
  if (Date.now() > entry.expiresAt) {
    diffStatsCache.delete(key);
    return null;
  }

  return entry.stats;
}

function setCachedStats(taskId: string, projectId: string | undefined, worktree: string | undefined, stepVersion: string | undefined, stats: DiffStats): void {
  const key = getCacheKey(taskId, projectId, worktree, stepVersion);
  diffStatsCache.set(key, {
    stats,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Clears all entries from the diff stats cache.
 * Exported for testing purposes.
 */
export function __test_clearDiffStatsCache(): void {
  diffStatsCache.clear();
}

/**
 * Fetches diff stats for a task's Changes tab.
 *
 * For active worktree-backed tasks, this keeps the TaskCard count aligned with
 * the Changes tab. For done tasks, it always uses `/api/tasks/:id/diff`, whose
 * server-side aggregation is the canonical source (including multi-commit
 * lineage unions), instead of trusting `mergeDetails.filesChanged`.
 *
 * @param taskId - Task identifier
 * @param column - Current task column
 * @param commitSha - Merge commit SHA (undefined = no merge yet)
 * @param projectId - Optional project identifier
 * @param options.enabled - When false, no fetch is made and returns empty/stable state
 */
export function useTaskDiffStats(
  taskId: string,
  column: string,
  commitSha: string | undefined,
  projectId?: string,
  options: UseTaskDiffStatsOptions = {},
): UseTaskDiffStatsResult {
  const enabled = options.enabled ?? true;
  const worktree = options.worktree;
  const stepVersion = options.stepVersion;
  const pollIntervalMs = options.pollIntervalMs;
  const [stats, setStats] = useState<DiffStats | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Disabled state: return stable empty state without fetching
    if (!enabled) {
      setStats(null);
      setLoading(false);
      return;
    }

    const shouldFetchDoneTask = column === "done" && Boolean(commitSha);
    const shouldFetchActiveTask = (column === "in-progress" || column === "in-review") && Boolean(worktree);

    if (!taskId || (!shouldFetchDoneTask && !shouldFetchActiveTask)) {
      setStats(null);
      setLoading(false);
      return;
    }

    const activeWorktree = shouldFetchActiveTask ? worktree : undefined;
    const stepVersionStr = stepVersion !== undefined ? String(stepVersion) : undefined;
    let cancelled = false;

    async function load(forceRefresh = false) {
      // Check cache first - return immediately without loading flicker (unless force refresh)
      if (!forceRefresh) {
        const cached = getCachedStats(taskId, projectId, activeWorktree, stepVersionStr);
        if (cached) {
          if (!cancelled) {
            setStats(cached);
            setLoading(false);
          }
          return;
        }
      }

      setLoading(true);
      try {
        const data = await fetchTaskDiff(taskId, activeWorktree, projectId);
        if (!cancelled) {
          setStats(data.stats);
          // Store in cache
          setCachedStats(taskId, projectId, activeWorktree, stepVersionStr, data.stats);
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

    // Initial fetch
    void load();

    // Set up polling for active columns
    let timer: ReturnType<typeof setInterval> | undefined;
    if (pollIntervalMs && shouldFetchActiveTask) {
      timer = setInterval(() => {
        // Force refresh on poll - bypass cache
        void load(true);
      }, pollIntervalMs);
    }

    return () => {
      cancelled = true;
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [taskId, column, commitSha, projectId, enabled, worktree, stepVersion, pollIntervalMs]);

  return { stats, loading };
}
