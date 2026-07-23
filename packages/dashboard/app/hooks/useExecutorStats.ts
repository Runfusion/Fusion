import { useState, useEffect, useCallback, useRef } from "react";
import type { Task, TraitFlags } from "@fusion/core";
import { enrichRunningAgentTaskShapeFromFlags, isRunningAgentTask, isWaitingAgentTask } from "../../../core/src/agents/live-agent-count";
import { fetchExecutorStats } from "../api";
import type { ExecutorStats, ExecutorState } from "../api";
import { isTaskStuck } from "../utils/taskStuck";
import { isLikelyTabSuspensionError, isVisibilityResumeError, useTabVisibilitySuspension } from "./visibilitySuspension";

const POLL_INTERVAL_MS = 5000; // 5 seconds - different from useProjectHealth's 10s
/*
 * FNXC:ExecutorStatusBar 2026-06-27-00:00:
 * Executor stats polling can hit one-off tab-suspension-like fetch errors while the tab remains visible. Keep the last-good footer stats through one transient poll so the bottom bar does not flash "Connecting…"; only sustained consecutive transient failures may surface the connection state.
 */
const TRANSIENT_FAILURE_THRESHOLD = 2;

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
 * - "stopped": globalPause is true
 * - "idle": (enginePaused is true AND runningTaskCount is 0) OR not paused with nothing running
 * - "paused": enginePaused is true AND runningTaskCount > 0
 * - "running": globalPause is false AND enginePaused is false AND runningTaskCount > 0
 *
 * FNXC:EngineControls 2026-06-22-00:00:
 * `globalPause` dominates the footer state matrix so an operator-stopped engine is distinct from idle even if in-progress tasks still exist.
 */
function deriveExecutorState(
  globalPause: boolean,
  enginePaused: boolean,
  runningTaskCount: number
): ExecutorState {
  if (globalPause) {
    return "stopped";
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
 *
 * FNXC:ExecutorStatusBar 2026-07-21-14:30:
 * FN-8453 / #2359 requires footer capacity indicators to share the live top-level
 * agent predicate with admission: Waiting is trait-derived intake/hold membership,
 * Running is unpaused WIP plus live planners/reviewers, and custom columns require
 * task-scoped workflow flags rather than legacy column-id assumptions.
 *
 * FNXC:ExecutorStatusBar 2026-07-21-19:00:
 * Do not require task.sessionFile for Running — it is not on board/listTasks rows.
 */
export type ExecutorColumnFlags = Pick<TraitFlags, "complete" | "archived" | "intake" | "hold" | "countsTowardWip" | "mergeOrchestration" | "mergeBlocker">;

export function deriveStatsFromTasks(tasks: Task[], taskStuckTimeoutMs?: number, lastFetchTimeMs?: number, columnFlagsById?: ReadonlyMap<string, ExecutorColumnFlags>, columnFlagsByTaskId?: ReadonlyMap<string, ExecutorColumnFlags>): Pick<
  ExecutorStats,
  "runningTaskCount" | "blockedTaskCount" | "stuckTaskCount" | "queuedTaskCount" | "inReviewCount"
> {
  let runningTaskCount = 0;
  let blockedTaskCount = 0;
  let stuckTaskCount = 0;
  let queuedTaskCount = 0;
  let inReviewCount = 0;

  for (const task of tasks) {
    // Task-scoped flags preserve custom workflow meaning when aggregate boards reuse column ids.
    const enriched = enrichRunningAgentTaskShapeFromFlags(task, columnFlagsByTaskId?.get(task.id) ?? columnFlagsById?.get(task.column));
    if (isRunningAgentTask(enriched)) {
      runningTaskCount++;
      if (isTaskStuck(task, taskStuckTimeoutMs, lastFetchTimeMs)) stuckTaskCount++;
    }
    if (isWaitingAgentTask(enriched)) queuedTaskCount++;
    // Kept in the API shape for compatibility; the footer no longer renders it.
    if (task.column === "in-review") inReviewCount++;
    if (hasActionableBlockedBy(task.blockedBy)) {
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

function hasActionableBlockedBy(blockedBy: Task["blockedBy"] | string[] | null): boolean {
  if (Array.isArray(blockedBy)) {
    return blockedBy.some((id) => typeof id === "string" && id.trim().length > 0);
  }

  return typeof blockedBy === "string" && blockedBy.trim().length > 0;
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
 * - Derives executorState from globalPause and enginePaused flags, with globalPause mapping to "stopped"
 * - Returns ExecutorStats object with reactive updates
 */
const DEFAULT_API_DATA: Pick<ExecutorStats, "maxConcurrent" | "lastActivityAt"> & {
  globalPause: boolean;
  enginePaused: boolean;
} = {
  globalPause: false,
  enginePaused: false,
  maxConcurrent: 2,
};

export function useExecutorStats(tasks: Task[], projectId?: string, taskStuckTimeoutMs?: number, lastFetchTimeMs?: number, columnFlagsByTaskId?: ReadonlyMap<string, ExecutorColumnFlags>): UseExecutorStatsResult {

  const [apiDataState, setApiDataState] = useState<{
    projectId?: string;
    data: typeof DEFAULT_API_DATA;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState<{ projectId?: string; message: string } | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hasFetchedStatsRef = useRef(false);
  const consecutiveFailuresRef = useRef(0);
  const activeProjectIdRef = useRef(projectId);
  const visibilitySuspension = useTabVisibilitySuspension();

  const shouldSuppressVisibilityResumeError = useCallback((errorMessage: string): boolean => {
    return hasFetchedStatsRef.current && isVisibilityResumeError(errorMessage, visibilitySuspension.wasRecentlyHidden());
  }, [visibilitySuspension]);

  const refresh = useCallback(async () => {
    // Cancel any in-flight requests
    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    try {
      if (activeProjectIdRef.current !== projectId) {
        activeProjectIdRef.current = projectId;
        hasFetchedStatsRef.current = false;
        consecutiveFailuresRef.current = 0;
        setErrorState(null);
      }
      /*
       * FNXC:ExecutorStatusBar 2026-06-27-00:00:
       * Routine 5s heartbeat polls must not re-enter the loading state after the first successful stats fetch. The footer loading branch swaps the root subtree while idle, which unmounts EngineControlMenu, closes an open concurrency popover, and makes the footer blink (FN-7163).
       *
       * FNXC:ExecutorStatusBar 2026-06-27-17:30:
       * Project switches are a new initial load, not a heartbeat. Reset the per-project fetched/failure guard before fetching so project B cannot inherit project A's stats or transient-error debounce state.
       */
      if (!hasFetchedStatsRef.current) {
        setLoading(true);
      }
      const requestProjectId = projectId;
      const data = await fetchExecutorStats(requestProjectId);
      if (activeProjectIdRef.current !== requestProjectId) {
        return;
      }
      consecutiveFailuresRef.current = 0;
      hasFetchedStatsRef.current = true;
      setErrorState(null);
      setApiDataState({ projectId: requestProjectId, data });
    } catch (err) {
      if (activeProjectIdRef.current !== projectId) {
        return;
      }
      if (err instanceof Error && err.name === "AbortError") {
        // Ignore abort errors
        return;
      }
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch executor stats";
      if (shouldSuppressVisibilityResumeError(errorMessage)) {
        return;
      }
      if (hasFetchedStatsRef.current && isLikelyTabSuspensionError(errorMessage)) {
        consecutiveFailuresRef.current += 1;
        if (consecutiveFailuresRef.current >= TRANSIENT_FAILURE_THRESHOLD) {
          setErrorState({ projectId, message: errorMessage });
        }
        return;
      }
      consecutiveFailuresRef.current = 0;
      setErrorState({ projectId, message: errorMessage });
    } finally {
      setLoading(false);
    }
  }, [projectId, shouldSuppressVisibilityResumeError]);

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

  const currentProjectApiDataState = apiDataState && apiDataState.projectId === projectId ? apiDataState : null;
  const apiData = currentProjectApiDataState?.data ?? DEFAULT_API_DATA;
  const error = errorState && errorState.projectId === projectId ? errorState.message : null;
  const effectiveLoading = loading || (!error && !currentProjectApiDataState);

  // Derive stats from tasks and API data
  const taskStats = deriveStatsFromTasks(tasks, taskStuckTimeoutMs, lastFetchTimeMs, undefined, columnFlagsByTaskId);
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
    loading: effectiveLoading,
    error,
    refresh,
  };
}
