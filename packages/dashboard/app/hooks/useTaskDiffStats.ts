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
  /**
   * Done-task merge enrichment signature (e.g. landedFiles length + filesChanged).
   * For done cards this invalidates cache/refetches when mergeDetails enrichment lands,
   * analogous to stepVersion invalidation for active columns.
   */
  mergeSignature?: number | string;
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

function getCacheKey(taskId: string, projectId?: string, worktree?: string, stepVersion?: string, mode?: "done" | "active"): string {
  return `${taskId}:${projectId ?? ""}:${worktree ?? ""}:${stepVersion ?? ""}:${mode ?? ""}`;
}

function getCachedStats(taskId: string, projectId?: string, worktree?: string, stepVersion?: string, mode?: "done" | "active"): DiffStats | null {
  const key = getCacheKey(taskId, projectId, worktree, stepVersion, mode);
  const entry = diffStatsCache.get(key);

  if (!entry) return null;

  // Check expiration
  if (Date.now() > entry.expiresAt) {
    diffStatsCache.delete(key);
    return null;
  }

  return entry.stats;
}

function setCachedStats(taskId: string, projectId: string | undefined, worktree: string | undefined, stepVersion: string | undefined, mode: "done" | "active", stats: DiffStats): void {
  const key = getCacheKey(taskId, projectId, worktree, stepVersion, mode);
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
 * the Changes tab. For done tasks, this hook's `stats.filesChanged` is the
 * authoritative lineage-union total from `/api/tasks/:id/diff`, not the final
 * merge commit's shortstat.
 * Per FN-4527/FN-4647, consumers must not fall back to
 * `task.mergeDetails.filesChanged` once `loading` is false and `stats` is null:
 * stored mergeDetails counts can be stale after post-merge rebase-and-push
 * flows (see FN-4526).
 *
 * @param taskId - Task identifier
 * @param column - Current task column
 * @param commitSha - Merge commit SHA (undefined = no merge yet)
 * @param projectId - Optional project identifier
 * @param options.enabled - When false, no fetch is made and returns empty/stable state
 * @param options.mergeSignature - Done-mode invalidation signal derived from mergeDetails enrichment
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
  const mergeSignature = options.mergeSignature;
  const [stats, setStats] = useState<DiffStats | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Disabled state: return stable empty state without fetching
    if (!enabled) {
      setStats(null);
      setLoading(false);
      return;
    }

    /*
    FNXC:TaskDiffStats 2026-07-30-05:20 DELIBERATE-LITERAL: sized, not convertible in place.
    These pick the FETCH MODE, and the distinction is a real role question — a complete column
    reads the merge diff, a wip/review column reads the worktree diff. But this hook receives a
    bare `column: string` and holds no flags map, so converting means adding a `columnFlags`
    parameter and threading it from every caller.

    Adding an OPTIONAL one instead would compile, read as converted, and drop the census by three
    while changing nothing, because no caller would pass it — the inert half-conversion this
    program keeps re-finding. On a renamed board the visible cost is precise and worth stating:
    diff stats silently stop loading, because neither branch matches and the early return fires.

    Cheapest real route: the callers rendering this already sit under TaskCard/TaskDetailModal,
    both of which resolve per-task flags — pass the resolved role in rather than re-resolving here.
    */
    const shouldFetchDoneTask = column === "done";
    const shouldFetchActiveTask = column === "in-progress" || column === "in-review";

    if (!taskId || (!shouldFetchDoneTask && !shouldFetchActiveTask)) {
      setStats(null);
      setLoading(false);
      return;
    }

    const activeWorktree = shouldFetchActiveTask ? worktree : undefined;
    const stepVersionStr = stepVersion !== undefined ? String(stepVersion) : undefined;
    const mergeSignatureStr = mergeSignature !== undefined ? String(mergeSignature) : undefined;
    const mode: "done" | "active" = shouldFetchDoneTask ? "done" : "active";
    let cancelled = false;

    async function load(forceRefresh = false) {
      // Check cache first - return immediately without loading flicker (unless force refresh)
      if (!forceRefresh) {
        const cacheVersion = mode === "done" ? mergeSignatureStr : stepVersionStr;
        const cached = getCachedStats(taskId, projectId, activeWorktree, cacheVersion, mode);
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
          const cacheVersion = mode === "done" ? mergeSignatureStr : stepVersionStr;
          setCachedStats(taskId, projectId, activeWorktree, cacheVersion, mode, data.stats);
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
  }, [taskId, column, commitSha, projectId, enabled, worktree, stepVersion, mergeSignature, pollIntervalMs]);

  return { stats, loading };
}
