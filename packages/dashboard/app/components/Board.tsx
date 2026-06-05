import type { Task, TaskDetail, Column as ColumnType, TaskCreateInput, GithubIssueAction } from "@fusion/core";
import { COLUMNS, DEFAULT_COLUMN, isColumn } from "@fusion/core";
import { sortTasksForDisplayColumn } from "./taskSorting";
import { Column } from "./Column";
import { Lane } from "./Lane";
import type { ToastType } from "../hooks/useToast";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { fetchWorkflowSteps, fetchBoardWorkflows, promoteTask, type ModelInfo, type BoardWorkflowsPayload } from "../api";
import { useBlockerFanout } from "../hooks/useBlockerFanout";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import { subscribeSse } from "../sse-bus";

/** localStorage key for persisted lane collapse state (per project). */
const LANE_COLLAPSE_STORAGE_KEY = "kb-dashboard-lane-collapsed";

interface BoardProps {
  tasks: Task[];
  projectId?: string;
  maxConcurrent: number;
  onMoveTask: (id: string, column: ColumnType) => Promise<Task>;
  onPauseTask?: (id: string) => Promise<Task>;
  onOpenDetail: (task: Task | TaskDetail) => void;
  onOpenGroupModal?: (groupId: string) => void;
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
let boardWasPreviouslyInactive = false;

function areWorkflowNameLookupsEqual(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): boolean {
  if (previous.size !== next.size) return false;
  for (const [key, value] of previous) {
    if (next.get(key) !== value) return false;
  }
  return true;
}

export function Board({ tasks, projectId, maxConcurrent, onMoveTask, onPauseTask, onOpenDetail, onOpenGroupModal, addToast, onQuickCreate, onNewTask, autoMerge, onToggleAutoMerge, globalPaused, onUpdateTask, onRetryTask, onArchiveTask, onUnarchiveTask, onDeleteTask, onArchiveAllDone, onLoadArchivedTasks, searchQuery = "", availableModels, onPlanningMode, onSubtaskBreakdown, onOpenDetailWithTab, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, taskStuckTimeoutMs, onOpenMission, staleHighFanoutBlockerAgeThresholdMs, lastFetchTimeMs, prAuthAvailable }: BoardProps) {
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

  useEffect(() => {
    recordResumeEvent({
      view: "Board",
      trigger: boardWasPreviouslyInactive ? "route-active" : "remount",
      projectId,
      replayAttempted: false,
    });
    boardWasPreviouslyInactive = false;

    return () => {
      boardWasPreviouslyInactive = true;
      recordResumeEvent({
        view: "Board",
        trigger: "route-inactive",
        projectId,
        replayAttempted: false,
      });
    };
  }, [projectId]);

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

    const visualViewport = window.visualViewport;
    const handleViewportResize = () => {
      scheduleStabilization();
    };

    scheduleStabilization();
    window.addEventListener("pageshow", handlePageShow);
    if (typeof visualViewport?.addEventListener === "function") {
      visualViewport.addEventListener("resize", handleViewportResize);
    }

    return () => {
      window.removeEventListener("pageshow", handlePageShow);
      if (typeof visualViewport?.removeEventListener === "function") {
        visualViewport.removeEventListener("resize", handleViewportResize);
      }
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  // ── U9 multi-lane board (flag-gated) ──────────────────────────────────────
  // Fetch board-workflows metadata. When the flag is OFF the server returns
  // { flagEnabled: false } and we render the legacy single-lane board below.
  const [boardWorkflows, setBoardWorkflows] = useState<BoardWorkflowsPayload | null>(null);
  const draggingTaskIdRef = useRef<string | null>(null);
  const [collapsedLanes, setCollapsedLanes] = useState<ReadonlySet<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem(LANE_COLLAPSE_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === "string"));
    } catch {
      /* ignore corrupt persisted state */
    }
    return new Set();
  });

  // Fetch board workflow lanes for the project. Deliberately NOT keyed on
  // `tasks` — that refetched on every SSE tick. Instead we refetch on project
  // change and when the tab regains visibility/focus. A stale-response guard
  // (monotonic sequence ref) drops out-of-order responses.
  // A `workflow:updated` (and create/delete) SSE event now drives invalidation
  // when a definition's lanes / column traits change. The visibility/focus
  // refetch below is retained as a stopgap for missed events / reconnects.
  const boardWorkflowsFetchSeqRef = useRef(0);
  useEffect(() => {
    const runFetch = () => {
      const seq = ++boardWorkflowsFetchSeqRef.current;
      fetchBoardWorkflows(projectId)
        .then((payload) => {
          if (seq === boardWorkflowsFetchSeqRef.current) setBoardWorkflows(payload);
        })
        .catch(() => {
          if (seq === boardWorkflowsFetchSeqRef.current) {
            setBoardWorkflows({ flagEnabled: false, defaultWorkflowId: "builtin:coding", workflows: [], taskWorkflowIds: {} });
          }
        });
    };
    runFetch();
    const onVisible = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") runFetch();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    if (typeof window !== "undefined") window.addEventListener("focus", onVisible);
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const unsubscribe = subscribeSse(`/api/events${query}`, {
      events: {
        "workflow:created": runFetch,
        "workflow:updated": runFetch,
        "workflow:deleted": runFetch,
      },
    });
    return () => {
      // Advance the seq so any in-flight response is dropped on cleanup.
      boardWorkflowsFetchSeqRef.current++;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (typeof window !== "undefined") window.removeEventListener("focus", onVisible);
      unsubscribe();
    };
  }, [projectId]);

  const handleToggleLaneCollapse = useCallback((workflowId: string) => {
    setCollapsedLanes((prev) => {
      const next = new Set(prev);
      if (next.has(workflowId)) next.delete(workflowId);
      else next.add(workflowId);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(LANE_COLLAPSE_STORAGE_KEY, JSON.stringify([...next]));
        } catch {
          /* ignore quota / serialization errors */
        }
      }
      return next;
    });
  }, []);

  const handlePromote = useCallback(async (taskId: string) => {
    await promoteTask(taskId, projectId);
  }, [projectId]);

  const getDraggingTaskId = useCallback(() => draggingTaskIdRef.current, []);

  const flagOn = boardWorkflows?.flagEnabled === true;

  // Group visible tasks into lanes by resolved workflow (null → default lane).
  const lanes = useMemo(() => {
    if (!boardWorkflows || !flagOn) return [];
    const { workflows, taskWorkflowIds, defaultWorkflowId } = boardWorkflows;
    const byId = new Map(workflows.map((w) => [w.id, w] as const));
    const tasksByWorkflow = new Map<string, Task[]>();
    for (const task of tasks) {
      // Archived cards are excluded from lanes (archived columns are hidden).
      if (task.column === "archived") continue;
      const workflowId = taskWorkflowIds[task.id] ?? defaultWorkflowId;
      (tasksByWorkflow.get(workflowId) ?? tasksByWorkflow.set(workflowId, []).get(workflowId)!).push(task);
    }
    const result: Array<{ workflow: typeof workflows[number]; tasks: Task[] }> = [];
    for (const [workflowId, laneTasks] of tasksByWorkflow) {
      const workflow = byId.get(workflowId);
      if (!workflow) continue;
      if (laneTasks.length === 0) continue; // zero-card lanes hidden
      result.push({ workflow, tasks: laneTasks });
    }
    // Default lane first; then by workflow name for stable ordering.
    result.sort((a, b) => {
      if (a.workflow.id === defaultWorkflowId) return -1;
      if (b.workflow.id === defaultWorkflowId) return 1;
      return a.workflow.name.localeCompare(b.workflow.name);
    });
    return result;
  }, [boardWorkflows, flagOn, tasks]);

  // Card-placed field defs grouped by workflow id (U13/KTD-14). Only recomputes
  // when the board-workflows payload changes, not on every SSE task tick.
  const cardDefsByWorkflow = useMemo(() => {
    const map = new Map<string, import("../api").WorkflowFieldDefinition[]>();
    if (!boardWorkflows) return map;
    for (const wf of boardWorkflows.workflows) {
      const cardDefs = (wf.fields ?? []).filter((f) => f.render?.placement === "card");
      if (cardDefs.length > 0) map.set(wf.id, cardDefs);
    }
    return map;
  }, [boardWorkflows]);

  // Per-task card field defs (U13/KTD-14). Recomputes on task list changes but
  // reuses the stable cardDefsByWorkflow map so the inner loop is cheap.
  const taskCardFieldDefs = useMemo(() => {
    const map = new Map<string, import("../api").WorkflowFieldDefinition[]>();
    if (cardDefsByWorkflow.size === 0) return map;
    if (!boardWorkflows) return map;
    const { taskWorkflowIds, defaultWorkflowId } = boardWorkflows;
    for (const task of tasks) {
      const workflowId = taskWorkflowIds[task.id] ?? defaultWorkflowId;
      const defs = cardDefsByWorkflow.get(workflowId);
      if (defs) map.set(task.id, defs);
    }
    return map;
  }, [cardDefsByWorkflow, tasks, boardWorkflows]);

  // Drag pre-check (R17): adjacency + capacity from the lane's column metadata.
  // Cross-lane drag → workflow-mismatch. Deterministic rejections return a
  // messageKey (no-move); null = allowed.
  const canDropTask = useCallback((taskId: string, targetColumnId: string, laneWorkflowId: string): string | null => {
    if (!boardWorkflows) return null;
    const sourceTask = tasks.find((t) => t.id === taskId);
    if (!sourceTask) return null;
    const sourceWorkflowId = boardWorkflows.taskWorkflowIds[taskId] ?? boardWorkflows.defaultWorkflowId;
    // Cross-lane drag never switches workflows (R17).
    if (sourceWorkflowId !== laneWorkflowId) {
      return "board.rejection.workflowMismatch";
    }
    const workflow = boardWorkflows.workflows.find((w) => w.id === laneWorkflowId);
    if (!workflow) return null;
    const targetCol = workflow.columns.find((c) => c.id === targetColumnId);
    if (!targetCol) return "board.rejection.unknownColumn";
    // Capacity pre-check: a wip-flagged column that is already full rejects.
    if (targetCol.flags.countsTowardWip) {
      const occupants = tasks.filter(
        (t) => t.column === targetColumnId && (boardWorkflows.taskWorkflowIds[t.id] ?? boardWorkflows.defaultWorkflowId) === laneWorkflowId,
      ).length;
      // The default workflow's in-progress limit is maxConcurrent; custom limits
      // are enforced authoritatively server-side (the 409 fallback still snaps back).
      if (Number.isFinite(maxConcurrent) && maxConcurrent > 0 && sourceTask.column !== targetColumnId && occupants >= maxConcurrent) {
        return "board.rejection.capacityExhausted";
      }
    }
    return null;
  }, [boardWorkflows, tasks, maxConcurrent]);

  // FN-4380: GitHub badge state comes from persisted task fields (`task.prInfo`,
  // `task.issueInfo`, `task.githubTracking.issue`) and live WebSocket `badge:updated`
  // messages. We do NOT eagerly call `/api/github/batch-status` on board load.

  if (flagOn) {
    return (
      <main
        className="board board-lanes"
        id="board"
        ref={boardRef}
        onDragStart={(e) => {
          const id = (e.target as HTMLElement)?.closest?.("[data-id]")?.getAttribute("data-id");
          if (id) draggingTaskIdRef.current = id;
        }}
        onDragEnd={() => {
          draggingTaskIdRef.current = null;
        }}
      >
        {lanes.map(({ workflow, tasks: laneTasks }) => (
          <Lane
            key={workflow.id}
            workflow={workflow}
            tasks={laneTasks}
            collapsed={collapsedLanes.has(workflow.id)}
            onToggleCollapse={handleToggleLaneCollapse}
            projectId={projectId}
            maxConcurrent={maxConcurrent}
            onMoveTask={onMoveTask}
            onPromote={handlePromote}
            canDropTask={canDropTask}
            getDraggingTaskId={getDraggingTaskId}
            onPauseTask={onPauseTask}
            onOpenDetail={onOpenDetail}
            onOpenGroupModal={onOpenGroupModal}
            addToast={addToast}
            onQuickCreate={onQuickCreate}
            onNewTask={onNewTask}
            autoMerge={autoMerge}
            onToggleAutoMerge={onToggleAutoMerge}
            globalPaused={globalPaused}
            onUpdateTask={onUpdateTask}
            onRetryTask={onRetryTask}
            onArchiveTask={onArchiveTask}
            onUnarchiveTask={onUnarchiveTask}
            onDeleteTask={onDeleteTask}
            availableModels={availableModels}
            onPlanningMode={onPlanningMode}
            onSubtaskBreakdown={onSubtaskBreakdown}
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
            taskCardFieldDefs={taskCardFieldDefs}
            blockerFanoutMap={blockerFanoutMap}
            prAuthAvailable={prAuthAvailable}
          />
        ))}
      </main>
    );
  }

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
            onOpenGroupModal={onOpenGroupModal}
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
            taskCardFieldDefs={taskCardFieldDefs}
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
