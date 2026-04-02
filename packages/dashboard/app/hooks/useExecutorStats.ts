import { useState, useEffect, useCallback, useRef } from "react";
import type { Task } from "@fusion/core";
import { useTasks } from "./useTasks";
import { fetchExecutorStats } from "../api";
import type { ExecutorStats, ExecutorState } from "../api";

const POLL_INTERVAL_MS = 5000; // 5 seconds - different from useProjectHealth's 10s
const STUCK_TASK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export interface UseExecutorStatsResult {
  /** Aggregated executor statistics */
  stats: ExecutorStats;
  /** Whether the stats are currently loading */
  loading: boolean;
  /** Error message if the last fetch failed */
  error: string | null;
  /** Manually refresh stats */
  refresh: () => Promise<void>;
}

/**
 * Derive the executor state from globalPause, enginePaused, and runningTaskCount.
 * 
 * - "idle": globalPause is true OR (enginePaused is true AND runningTaskCount is 0)
 * - "paused": enginePaused is true AND runningTaskCount > 0
 * - "running": globalPause is false AND enginePaused is false AND runningTaskCount > 0
 */
function deriveExecutorState(
  globalPause: boolean,
  enginePaused: boolean,
  runningTaskCount: number
): ExecutorState {
  if (globalPause) {
    return "idle";
  }
  if (enginePaused && runningTaskCount === 0) {
    return "idle";
  }
  if (enginePaused && runningTaskCount > 0) {
    return "paused";
  }
  // globalPause is false and enginePaused is false
  if (runningTaskCount > 0) {
    return "running";
  }
  return "idle";
}

/**
 * Check if a task is stuck (no activity for > 10 minutes).
 */
function isTaskStuck(task: Task): boolean {
  if (task.column !== "in-progress") {
    return false;
  }
  const updatedAt = new Date(task.updatedAt).getTime();
  const now = Date.now();
  return now - updatedAt > STUCK_TASK_THRESHOLD_MS;
}

/**
 * Derive statistics from the task list.
 */
function deriveStatsFromTasks(tasks: Task[]): Pick<
  ExecutorStats,
  "runningTaskCount" | "blockedTaskCount" | "stuckTaskCount" | "queuedTaskCount" | "inReviewCount"
> {
  let runningTaskCount = 0;
  let blockedTaskCount = 0;
  let stuckTaskCount = 0;
  let queuedTaskCount = 0;
  let inReviewCount = 0;

  for (const task of tasks) {
    switch (task.column) {
      case "in-progress":
        runningTaskCount++;
        if (isTaskStuck(task)) {
          stuckTaskCount++;
        }
        break;
      case "todo":
        queuedTaskCount++;
        break;
      case "in-review":
        inReviewCount++;
        break;
    }

    // Count tasks with blockedBy set
    if (task.blockedBy && task.blockedBy.length > 0) {
      blockedTaskCount++;
    }
  }

  return {
    runningTaskCount,
    blockedTaskCount,
    stuckTaskCount,
    queuedTaskCount,
    inReviewCount,
  };
}

/**
 * Hook for aggregating executor statistics for the status bar.
 * 
 * - Uses `useTasks` to get task list for column-based counts
 * - Polls `/api/executor/stats` every 5 seconds for executor state
 * - Derives blockedTaskCount from tasks with blockedBy field set
 * - Derives stuckTaskCount by checking if any "in-progress" task has updatedAt > 10 minutes ago
 * - Derives executorState from globalPause and enginePaused flags
 * - Returns ExecutorStats object with reactive updates
 */
export function useExecutorStats(projectId?: string): UseExecutorStatsResult {
  const { tasks } = useTasks(projectId ? { projectId } : undefined);

  const [apiData, setApiData] = useState<{
    globalPause: boolean;
    enginePaused: boolean;
    maxConcurrent: number;
    lastActivityAt?: string;
  }>({
    globalPause: false,
    enginePaused: false,
    maxConcurrent: 2,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    // Cancel any in-flight requests
    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    try {
      setLoading(true);
      setError(null);
      const data = await fetchExecutorStats();
      setApiData(data);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // Ignore abort errors
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to fetch executor stats");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    refresh();

    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [refresh]);

  // Polling - refresh every 5 seconds
  useEffect(() => {
    // Clear any existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    // Start new polling interval
    intervalRef.current = setInterval(() => {
      refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [refresh]);

  // Derive stats from tasks and API data
  const taskStats = deriveStatsFromTasks(tasks);
  const executorState = deriveExecutorState(
    apiData.globalPause,
    apiData.enginePaused,
    taskStats.runningTaskCount
  );

  const stats: ExecutorStats = {
    ...taskStats,
    executorState,
    maxConcurrent: apiData.maxConcurrent,
    lastActivityAt: apiData.lastActivityAt,
  };

  return {
    stats,
    loading,
    error,
    refresh,
  };
}
