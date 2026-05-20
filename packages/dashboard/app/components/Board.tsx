import type { Task, TaskDetail, Column as ColumnType, TaskCreateInput, GithubIssueAction } from "@fusion/core";
import { COLUMNS, DEFAULT_COLUMN, isColumn } from "@fusion/core";
import { sortTasksForDisplayColumn } from "./taskSorting";
import { Column } from "./Column";
import type { ToastType } from "../hooks/useToast";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { fetchWorkflowSteps, type ModelInfo } from "../api";
import { useBlockerFanout } from "../hooks/useBlockerFanout";

interface BoardProps {
  tasks: Task[];
  projectId?: string;
  maxConcurrent: number;
  onMoveTask: (id: string, column: ColumnType) => Promise<Task>;
  onPauseTask?: (id: string) => Promise<Task>;
  onOpenDetail: (task: Task | TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
  onQuickCreate?: (input: TaskCreateInput) => Promise<Task | void>;
  onNewTask: () => void;
  autoMerge: boolean;
  onToggleAutoMerge: () => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[] }
  ) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onArchiveTask?: (id: string, options?: { removeLineageReferences?: boolean }) => Promise<Task>;
  onUnarchiveTask?: (id: string) => Promise<Task>;
  onDeleteTask?: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
  }) => Promise<Task>;
  onArchiveAllDone?: () => Promise<Task[]>;
  /** Lazy-load archived tasks. Called the first time the user expands the archived column. */
  onLoadArchivedTasks?: () => Promise<void>;
  searchQuery?: string;
  availableModels?: ModelInfo[];
  /**
   * Called when the user clicks the "Plan" button in the inline create card.
   */
  onPlanningMode?: (initialPlan: string) => void;
  /**
   * Called when the user clicks the "Subtask" button in the inline create card.
   */
  onSubtaskBreakdown?: (description: string) => void;
  onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes" | "retries") => void;
  favoriteProviders?: string[];
  favoriteModels?: string[];
  onToggleFavorite?: (provider: string) => void;
  onToggleModelFavorite?: (modelId: string) => void;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
  /** Called when user clicks a mission badge on a task card */
  onOpenMission?: (missionId: string) => void;
  /** Age threshold in milliseconds before high fan-out blockers escalate in dashboard surfaces. */
  staleHighFanoutBlockerAgeThresholdMs?: number;
  /** Timestamp (ms) when task data was last confirmed fresh from the server. Used for freshness-aware stuck detection. */
  lastFetchTimeMs?: number;
  /** Whether GitHub CLI auth is available for creating PRs from task cards. */
  prAuthAvailable?: boolean;
}


function areTaskArraysEqual(previous: Task[], next: Task[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((task, index) => task === next[index]);
}

const EMPTY_WORKFLOW_STEP_NAME_LOOKUP: ReadonlyMap<string, string> = new Map();

function areWorkflowNameLookupsEqual(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): boolean {
  if (previous.size !== next.size) return false;
  for (const [key, value] of previous) {
    if (next.get(key) !== value) return false;
  }
  return true;
}

export function Board({ tasks, projectId, maxConcurrent, onMoveTask, onPauseTask, onOpenDetail, addToast, onQuickCreate, onNewTask, autoMerge, onToggleAutoMerge, globalPaused, onUpdateTask, onRetryTask, onArchiveTask, onUnarchiveTask, onDeleteTask, onArchiveAllDone, onLoadArchivedTasks, searchQuery = "", availableModels, onPlanningMode, onSubtaskBreakdown, onOpenDetailWithTab, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, taskStuckTimeoutMs, onOpenMission, staleHighFanoutBlockerAgeThresholdMs, lastFetchTimeMs, prAuthAvailable }: BoardProps) {
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);
  const archivedLoadedRef = useRef(false);
  const [workflowStepNameLookup, setWorkflowStepNameLookup] = useState<ReadonlyMap<string, string>>(EMPTY_WORKFLOW_STEP_NAME_LOOKUP);
  const boardRef = useRef<HTMLElement | null>(null);
  const blockerFanoutMap = useBlockerFanout(tasks, {
    staleHighFanoutAgeThresholdMs: staleHighFanoutBlockerAgeThresholdMs,
  });
  // Normalized search-active signal: trimmed and non-empty
  const isSearchActive = searchQuery.trim() !== "";
  const tasksByColumnCacheRef = useRef<Record<ColumnType, Task[]>>({
    triage: [],
    todo: [],
    "in-progress": [],
    "in-review": [],
    done: [],
    archived: [],
  });

  const handleToggleArchivedCollapse = useCallback(() => {
    setArchivedCollapsed((current) => {
      const next = !current;
      if (!next && !archivedLoadedRef.current && onLoadArchivedTasks) {
        archivedLoadedRef.current = true;
        void onLoadArchivedTasks();
      }
      return next;
    });
  }, [onLoadArchivedTasks]);

  // Tasks are already server-filtered when searchQuery is active (via useTasks hook).
  // Client-side filtering is removed - tasks prop is used directly.
  // Keep per-column array identities stable for unchanged columns so React.memo(Column)
  // can skip sibling rerenders during unrelated task updates.
  const tasksByColumn = useMemo(() => {
    const nextGrouped: Record<ColumnType, Task[]> = {
      triage: [],
      todo: [],
      "in-progress": [],
      "in-review": [],
      done: [],
      archived: [],
    };

    for (const task of tasks) {
      const column = isColumn(task.column) ? task.column : DEFAULT_COLUMN;
      const bucket = nextGrouped[column] ?? nextGrouped[DEFAULT_COLUMN];
      bucket.push(task);
    }

    const previousGrouped = tasksByColumnCacheRef.current;
    const stableGrouped = {} as Record<ColumnType, Task[]>;

    for (const column of COLUMNS) {
      const sortedTasks = sortTasksForDisplayColumn(nextGrouped[column], column);
      stableGrouped[column] = areTaskArraysEqual(previousGrouped[column], sortedTasks)
        ? previousGrouped[column]
        : sortedTasks;
    }

    tasksByColumnCacheRef.current = stableGrouped;
    return stableGrouped;
  }, [tasks]);

  useEffect(() => {
    let cancelled = false;

    fetchWorkflowSteps(projectId)
      .then((steps) => {
        if (cancelled) return;

        const nextLookup = new Map(steps.map((step) => [step.id, step.name] as const));
        setWorkflowStepNameLookup((previous) => (
          areWorkflowNameLookupsEqual(previous, nextLookup) ? previous : nextLookup
        ));
      })
      .catch(() => {
        if (cancelled) return;
        setWorkflowStepNameLookup((previous) => (previous.size === 0 ? previous : EMPTY_WORKFLOW_STEP_NAME_LOOKUP));
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // FN-4574 + FN-001 diagnosis: on iOS Safari, the mobile board can occasionally
  // snap against stale layout/visualViewport metrics before flex columns resolve,
  // both on initial mount and on pageshow/bfcache restore after backgrounding.
  // We keep the FN-001 baseline (`scroll-snap-type: x proximity` +
  // `overflow-anchor: none`) and only stabilize via reflow + scroll offset
  // normalization; do NOT reintroduce `scroll-snap-type: x mandatory`.
  useEffect(() => {
    if (!window.matchMedia("(max-width: 768px)").matches) {
      return;
    }

    let rafId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const runStabilization = () => {
      const boardEl = boardRef.current;
      if (!boardEl) return;
      void boardEl.offsetWidth;
      boardEl.scrollLeft = 0;
    };

    const scheduleStabilization = () => {
      if (typeof window.requestAnimationFrame === "function") {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
        }
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          runStabilization();
        });
        return;
      }

      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        timeoutId = null;
        runStabilization();
      }, 0);
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      const viewportScale = window.visualViewport?.scale ?? 1;
      if (event.persisted || viewportScale > 1.0001) {
        scheduleStabilization();
      }
    };

    scheduleStabilization();
    window.addEventListener("pageshow", handlePageShow);

    const visualViewport = window.visualViewport;
    let handleViewportResize: (() => void) | null = null;
    if (visualViewport) {
      handleViewportResize = () => {
        scheduleStabilization();
        visualViewport.removeEventListener("resize", handleViewportResize!);
        handleViewportResize = null;
      };
      visualViewport.addEventListener("resize", handleViewportResize);
    }

    return () => {
      window.removeEventListener("pageshow", handlePageShow);
      if (handleViewportResize) {
        visualViewport?.removeEventListener("resize", handleViewportResize);
      }
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  // FN-4380: GitHub badge state comes from persisted task fields (`task.prInfo`,
  // `task.issueInfo`, `task.githubTracking.issue`) and live WebSocket `badge:updated`
  // messages. We do NOT eagerly call `/api/github/batch-status` on board load.

  return (
    <>
      <main className="board" id="board" ref={boardRef}>
        {COLUMNS.map((col) => (
          <Column
            key={col}
            column={col}
            tasks={tasksByColumn[col]}
            projectId={projectId}
            maxConcurrent={maxConcurrent}
            onMoveTask={onMoveTask}
            onPauseTask={onPauseTask}
            onOpenDetail={onOpenDetail}
            addToast={addToast}
            globalPaused={globalPaused}
            onUpdateTask={onUpdateTask}
            onRetryTask={onRetryTask}
            onArchiveTask={onArchiveTask}
            onUnarchiveTask={onUnarchiveTask}
            onDeleteTask={onDeleteTask}
            allTasks={tasks}
            availableModels={availableModels}
            onOpenDetailWithTab={onOpenDetailWithTab}
            favoriteProviders={favoriteProviders}
            favoriteModels={favoriteModels}
            onToggleFavorite={onToggleFavorite}
            onToggleModelFavorite={onToggleModelFavorite}
            isSearchActive={isSearchActive}
            taskStuckTimeoutMs={taskStuckTimeoutMs}
            onOpenMission={onOpenMission}
            lastFetchTimeMs={lastFetchTimeMs}
            workflowStepNameLookup={workflowStepNameLookup}
            blockerFanoutMap={blockerFanoutMap}
            prAuthAvailable={prAuthAvailable}
            autoMerge={autoMerge}
            {...(col === "triage" ? { onQuickCreate, onNewTask, onPlanningMode, onSubtaskBreakdown } : {})}
            {...(col === "in-review" ? { onToggleAutoMerge } : {})}
            {...(col === "done" ? { onArchiveAllDone } : {})}
            {...(col === "archived" ? { collapsed: archivedCollapsed, onToggleCollapse: handleToggleArchivedCollapse } : {})}
          />
        ))}
      </main>
    </>
  );
}
