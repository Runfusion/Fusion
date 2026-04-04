import { useState, useEffect, useCallback, useRef } from "react";
import type { Task } from "@fusion/core";
import { fetchExecutorStats } from "../api";
import type { ExecutorStats, ExecutorState } from "../api";
import { isTaskStuck } from "../utils/taskStuck";

const POLL_INTERVAL_MS = 5000; // 5 seconds - different from useProjectHealth's 10s

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
 * Derive statistics from the task list.
 */
function deriveStatsFromTasks(tasks: Task[], taskStuckTimeoutMs?: number): Pick<
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
        if (isTaskStuck(task, taskStuckTimeoutMs)) {
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
 * - Receives the shared task list directly (same instance used by the board)
 *   so footer counts always match the board state
 * - Polls `/api/executor/stats` every 5 seconds for executor state
 * - Derives blockedTaskCount from tasks with blockedBy field set
 * - Derives stuckTaskCount using the project's `taskStuckTimeoutMs` setting;
 *   returns 0 when the setting is undefined/disabled
 * - Derives executorState from globalPause and enginePaused flags
 * - Returns ExecutorStats object with reactive updates
 */
export function useExecutorStats(tasks: Task[], projectId?: string, taskStuckTimeoutMs?: number): UseExecutorStatsResult {

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
      const data = await fetchExecutorStats(projectId);
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
  }, [projectId]);

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
  const taskStats = deriveStatsFromTasks(tasks, taskStuckTimeoutMs);
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
