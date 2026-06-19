import type { Task, TaskDetail, Column as ColumnType, TaskCreateInput, GithubIssueAction } from "@fusion/core";
import { COLUMNS, DEFAULT_COLUMN, isColumn } from "@fusion/core";
import { sortTasksForDisplayColumn } from "./taskSorting";
import { Column } from "./Column";
import "./Lane.css";
import type { ToastType } from "../hooks/useToast";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { Pencil, Plus } from "lucide-react";
import { fetchWorkflowSteps, fetchBoardWorkflows, promoteTask, type ModelInfo, type BoardWorkflowDefinition, type BoardWorkflowsPayload } from "../api";
import { useBlockerFanout } from "../hooks/useBlockerFanout";
import { MOBILE_MEDIA_QUERY } from "../hooks/useViewportMode";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import { subscribeSse } from "../sse-bus";
import { getBoardCanDropTaskRejection } from "./boardCanDropTask";

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
  onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => void;
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
  /** Opens the workflow editor modal, optionally focused on a workflow id. */
  onOpenWorkflowEditor?: (workflowId?: string) => void;
  /** Opens the workflow editor to create a new workflow. */
  onCreateWorkflow?: () => void;
}


function areTaskArraysEqual(previous: Task[], next: Task[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((task, index) => task === next[index]);
}

const EMPTY_WORKFLOW_STEP_NAME_LOOKUP: ReadonlyMap<string, string> = new Map();
let boardWasPreviouslyInactive = false;

// Real mobile browsers can pan the document horizontally while focusing/clicking
// an offscreen in-review auto-merge control. Keep that scroll container pinned;
// the board itself remains the only horizontal scroller.
function resetDocumentHorizontalScroll() {
  const scrollingElement = document.scrollingElement as HTMLElement | null;
  if (window.scrollX !== 0) {
    window.scrollTo(0, window.scrollY);
  }
  if (scrollingElement) {
    scrollingElement.scrollLeft = 0;
  }
  document.documentElement.scrollLeft = 0;
  if (document.body) {
    document.body.scrollLeft = 0;
  }
}

function scheduleDocumentHorizontalScrollReset() {
  const run = () => {
    resetDocumentHorizontalScroll();
    setTimeout(resetDocumentHorizontalScroll, 0);
  };

  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(run);
    return;
  }

  setTimeout(run, 0);
}

function areWorkflowNameLookupsEqual(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): boolean {
  if (previous.size !== next.size) return false;
  for (const [key, value] of previous) {
    if (next.get(key) !== value) return false;
  }
  return true;
}

export function Board({ tasks, projectId, maxConcurrent, onMoveTask, onPauseTask, onOpenDetail, onOpenGroupModal, addToast, onQuickCreate, onNewTask, autoMerge, onToggleAutoMerge, globalPaused, onUpdateTask, onRetryTask, onArchiveTask, onUnarchiveTask, onDeleteTask, onArchiveAllDone, onLoadArchivedTasks, searchQuery = "", availableModels, onPlanningMode, onSubtaskBreakdown, onOpenDetailWithTab, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, taskStuckTimeoutMs, onOpenMission, staleHighFanoutBlockerAgeThresholdMs, lastFetchTimeMs, prAuthAvailable, onOpenWorkflowEditor, onCreateWorkflow }: BoardProps) {
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
    const mobileQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
    let rafId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const runStabilization = () => {
      const boardEl = boardRef.current;
      if (!boardEl) return;
      void boardEl.offsetWidth;
      if (mobileQuery.matches) {
        resetDocumentHorizontalScroll();
        boardEl.scrollLeft = 0;
      }
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

    const addChangeListener = (query: MediaQueryList, listener: () => void) => {
      if (typeof query.addEventListener === "function") {
        query.addEventListener("change", listener);
        return;
      }
      if (typeof query.addListener === "function") {
        query.addListener(listener);
      }
    };

    const removeChangeListener = (query: MediaQueryList, listener: () => void) => {
      if (typeof query.removeEventListener === "function") {
        query.removeEventListener("change", listener);
        return;
      }
      if (typeof query.removeListener === "function") {
        query.removeListener(listener);
      }
    };

    scheduleStabilization();
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("resize", handleViewportResize);
    addChangeListener(mobileQuery, handleViewportResize);
    if (typeof visualViewport?.addEventListener === "function") {
      visualViewport.addEventListener("resize", handleViewportResize);
    }

    return () => {
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("resize", handleViewportResize);
      removeChangeListener(mobileQuery, handleViewportResize);
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
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const draggingTaskIdRef = useRef<string | null>(null);

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

  const handlePromote = useCallback(async (taskId: string) => {
    await promoteTask(taskId, projectId);
  }, [projectId]);

  const handleToggleAutoMerge = useCallback(() => {
    onToggleAutoMerge();
    if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) {
      scheduleDocumentHorizontalScrollReset();
    }
  }, [onToggleAutoMerge]);

  const getDraggingTaskId = useCallback(() => draggingTaskIdRef.current, []);

  const flagOn = boardWorkflows?.flagEnabled === true;

  const workflowMode = flagOn && Boolean(boardWorkflows?.workflows.length);
  const workflowOptions = useMemo<BoardWorkflowDefinition[]>(() => {
    if (!workflowMode || !boardWorkflows) return [];
    return [...boardWorkflows.workflows].sort((a, b) => {
      if (a.id === boardWorkflows.defaultWorkflowId) return -1;
      if (b.id === boardWorkflows.defaultWorkflowId) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [boardWorkflows, workflowMode]);

  const selectedWorkflow = useMemo<BoardWorkflowDefinition | null>(() => {
    if (!workflowMode) return null;
    return workflowOptions.find((workflow) => workflow.id === selectedWorkflowId)
      ?? workflowOptions.find((workflow) => workflow.id === boardWorkflows?.defaultWorkflowId)
      ?? workflowOptions[0]
      ?? null;
  }, [boardWorkflows?.defaultWorkflowId, selectedWorkflowId, workflowMode, workflowOptions]);

  useEffect(() => {
    if (!workflowMode) {
      setSelectedWorkflowId(null);
      return;
    }
    if (selectedWorkflow && selectedWorkflow.id !== selectedWorkflowId) {
      setSelectedWorkflowId(selectedWorkflow.id);
    }
  }, [selectedWorkflow, selectedWorkflowId, workflowMode]);

  const selectedWorkflowTasks = useMemo(() => {
    if (!workflowMode || !boardWorkflows || !selectedWorkflow) return [];
    return tasks.filter((task) => {
      const workflowId = boardWorkflows.taskWorkflowIds[task.id] ?? boardWorkflows.defaultWorkflowId;
      return workflowId === selectedWorkflow.id;
    });
  }, [boardWorkflows, selectedWorkflow, tasks, workflowMode]);

  const selectedWorkflowArchivedColumn = useMemo(() => {
    if (!selectedWorkflow) return null;
    return selectedWorkflow.columns.find((column) => column.flags.archived) ?? null;
  }, [selectedWorkflow]);

  const selectedWorkflowColumns = useMemo(() => {
    if (!selectedWorkflow) return [];
    return selectedWorkflow.columns.filter((column) => !column.flags.archived && !column.flags.hiddenFromBoard);
  }, [selectedWorkflow]);

  const selectedWorkflowCreateColumnId = useMemo(() => {
    return selectedWorkflowColumns.find((column) => column.flags.intake && !column.flags.archived)?.id
      ?? selectedWorkflowColumns.find((column) => !column.flags.archived)?.id;
  }, [selectedWorkflowColumns]);

  const selectedWorkflowTasksByColumn = useMemo(() => {
    const grouped: Record<string, Task[]> = {};
    if (!selectedWorkflow) return grouped;
    for (const column of selectedWorkflow.columns) grouped[column.id] = [];
    for (const task of selectedWorkflowTasks) {
      (grouped[task.column] ??= []).push(task);
    }
    for (const column of selectedWorkflow.columns) {
      grouped[column.id] = sortTasksForDisplayColumn(grouped[column.id] ?? [], column.id as ColumnType);
    }
    return grouped;
  }, [selectedWorkflow, selectedWorkflowTasks]);

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
  const canDropTask = useCallback((taskId: string, targetColumnId: string, laneWorkflowId: string): string | null => (
    getBoardCanDropTaskRejection({
      boardWorkflows,
      tasks,
      maxConcurrent,
      taskId,
      targetColumnId,
      laneWorkflowId,
    })
  ), [boardWorkflows, tasks, maxConcurrent]);

  // FN-4380: GitHub badge state comes from persisted task fields (`task.prInfo`,
  // `task.issueInfo`, `task.githubTracking.issue`) and live WebSocket `badge:updated`
  // messages. We do NOT eagerly call `/api/github/batch-status` on board load.

  if (workflowMode && selectedWorkflow) {
    return (
      <div className="board-workflow-view">
        {(workflowOptions.length > 1 || onCreateWorkflow || onOpenWorkflowEditor) && (
          <div className="board-workflow-toolbar">
            {workflowOptions.length > 1 && (
              <label className="list-workflow-selector board-workflow-selector">
                <span>Workflow</span>
                <select
                  className="select list-workflow-select"
                  value={selectedWorkflow.id}
                  onChange={(event) => setSelectedWorkflowId(event.target.value)}
                  aria-label="Select workflow"
                >
                  {workflowOptions.map((workflow) => (
                    <option key={workflow.id} value={workflow.id}>
                      {workflow.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {onOpenWorkflowEditor && (
              <button
                type="button"
                className="btn btn-icon btn-sm board-workflow-edit-btn"
                onClick={() => onOpenWorkflowEditor(selectedWorkflow.id)}
                title="Edit workflows"
                aria-label="Edit workflows"
              >
                <Pencil size={15} />
              </button>
            )}
            {onCreateWorkflow && (
              <button
                type="button"
                className="btn btn-icon btn-sm board-workflow-create-btn"
                onClick={onCreateWorkflow}
                title="New workflow"
                aria-label="New workflow"
              >
                <Plus size={15} />
              </button>
            )}
          </div>
        )}
        <main
          className="board board-workflow-columns"
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
          {selectedWorkflowColumns.map((columnDef) => {
            const isCreateColumn = columnDef.id === selectedWorkflowCreateColumnId;
            return (
              <Column
                key={columnDef.id}
                column={columnDef.id as ColumnType}
                workflowMode
                workflowId={selectedWorkflow.id}
                columnDisplayName={columnDef.name}
                columnFlags={columnDef.flags}
                tasks={selectedWorkflowTasksByColumn[columnDef.id] ?? []}
                allTasks={selectedWorkflowTasks}
                projectId={projectId}
                maxConcurrent={maxConcurrent}
                onMoveTask={onMoveTask}
                onPromote={handlePromote}
                canDropTask={(taskId) => canDropTask(taskId, columnDef.id, selectedWorkflow.id)}
                getDraggingTaskId={getDraggingTaskId}
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
                {...(isCreateColumn ? { onQuickCreate, onNewTask, onPlanningMode, onSubtaskBreakdown } : {})}
                {...(columnDef.flags.mergeBlocker || columnDef.flags.humanReview ? { onToggleAutoMerge: handleToggleAutoMerge } : {})}
                {...(columnDef.id === "done" ? { onArchiveAllDone } : {})}
              />
            );
          })}
          {selectedWorkflowArchivedColumn && (
            <Column
              key={selectedWorkflowArchivedColumn.id}
              column={selectedWorkflowArchivedColumn.id as ColumnType}
              workflowMode
              workflowId={selectedWorkflow.id}
              columnDisplayName={selectedWorkflowArchivedColumn.name}
              columnFlags={selectedWorkflowArchivedColumn.flags}
              tasks={selectedWorkflowTasksByColumn[selectedWorkflowArchivedColumn.id] ?? []}
              allTasks={selectedWorkflowTasks}
              projectId={projectId}
              maxConcurrent={maxConcurrent}
              onMoveTask={onMoveTask}
              onPromote={handlePromote}
              canDropTask={(taskId) => canDropTask(taskId, selectedWorkflowArchivedColumn.id, selectedWorkflow.id)}
              getDraggingTaskId={getDraggingTaskId}
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
              collapsed={archivedCollapsed}
              onToggleCollapse={handleToggleArchivedCollapse}
            />
          )}
        </main>
      </div>
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
            {...(col === "in-review" ? { onToggleAutoMerge: handleToggleAutoMerge } : {})}
            {...(col === "done" ? { onArchiveAllDone } : {})}
            {...(col === "archived" ? { collapsed: archivedCollapsed, onToggleCollapse: handleToggleArchivedCollapse } : {})}
          />
        ))}
      </main>
    </>
  );
}
