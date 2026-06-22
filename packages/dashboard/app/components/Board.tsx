import type { Task, TaskDetail, Column as ColumnType, TaskCreateInput, GithubIssueAction } from "@fusion/core";
import { COLUMNS, DEFAULT_COLUMN, isColumn } from "@fusion/core";
import { sortTasksForDisplayColumn } from "./taskSorting";
import { Column } from "./Column";
import "./Lane.css";
import "./Board.css";
import type { ToastType } from "../hooks/useToast";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { fetchWorkflowSteps, promoteTask, type ModelInfo, type BoardWorkflowsPayload } from "../api";
import { useBlockerFanout } from "../hooks/useBlockerFanout";
import { MOBILE_MEDIA_QUERY } from "../hooks/useViewportMode";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import { getBoardCanDropTaskRejection } from "./boardCanDropTask";
import { WorkflowSwitcher } from "./WorkflowSwitcher";
import { computeWorkflowStatusCounts } from "./workflowStatusCounts";
import { writeBoardWorkflowsCache } from "../utils/boardWorkflowsCache";
import { useBoardWorkflows } from "../hooks/useBoardWorkflows";

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
  onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
  /**
   * Called when the user clicks the "Subtask" button in the inline create card.
   */
  onSubtaskBreakdown?: (description: string, workflowId?: string | null) => void;
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
  /** Already-resolved app setting for whether workflow lanes should be used. */
  workflowColumnsEnabled?: boolean;
  /** Whether app settings have loaded; false gates the legacy board until the workflow flag is known. */
  settingsLoaded?: boolean;
  /** Relocates workflow controls into the Header portal slot when sidebar navigation owns the inline chrome. */
  workflowControlsInHeader?: boolean;
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

function BoardWorkflowSkeleton({ empty = false }: { empty?: boolean }) {
  return (
    <main className="board board-workflows-skeleton" id="board" aria-busy={!empty} aria-label={empty ? "No workflow lanes available" : "Loading workflow lanes"} data-testid={empty ? "board-workflows-empty" : "board-workflows-skeleton"}>
      {[0, 1, 2].map((index) => (
        <section className="board-workflows-skeleton__column card" key={index} aria-hidden="true">
          <div className="board-workflows-skeleton__header" />
          <div className="board-workflows-skeleton__card" />
          <div className="board-workflows-skeleton__card board-workflows-skeleton__card--short" />
        </section>
      ))}
    </main>
  );
}

export function Board({ tasks, projectId, maxConcurrent, onMoveTask, onPauseTask, onOpenDetail, onOpenGroupModal, addToast, onQuickCreate, onNewTask, autoMerge, onToggleAutoMerge, globalPaused, onUpdateTask, onRetryTask, onArchiveTask, onUnarchiveTask, onDeleteTask, onArchiveAllDone, onLoadArchivedTasks, searchQuery = "", availableModels, onPlanningMode, onSubtaskBreakdown, onOpenDetailWithTab, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, taskStuckTimeoutMs, onOpenMission, staleHighFanoutBlockerAgeThresholdMs, lastFetchTimeMs, prAuthAvailable, onOpenWorkflowEditor, onCreateWorkflow, workflowColumnsEnabled, settingsLoaded, workflowControlsInHeader = false }: BoardProps) {
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);
  const archivedLoadedRef = useRef(false);
  const [workflowStepNameLookup, setWorkflowStepNameLookup] = useState<ReadonlyMap<string, string>>(EMPTY_WORKFLOW_STEP_NAME_LOOKUP);
  const boardRef = useRef<HTMLElement | null>(null);
  const [headerWorkflowSlot, setHeaderWorkflowSlot] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    return document.getElementById("header-workflow-slot");
  });
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
    if (!workflowControlsInHeader || typeof document === "undefined") {
      setHeaderWorkflowSlot(null);
      return;
    }
    setHeaderWorkflowSlot(document.getElementById("header-workflow-slot"));
  }, [workflowControlsInHeader]);

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
  /*
  FNXC:BoardWorkflows 2026-06-20-08:58:
  Workflow-columns-enabled users must never see the legacy single-lane board while board-workflows metadata is still loading. Hydrate metadata from the project-scoped session cache, reset it on project switches, and show a neutral skeleton while settings or uncached workflow metadata are unknown.

  FNXC:Workflows 2026-06-22-17:00:
  The board-workflows fetch/cache/SSE/selection loop now lives in `useBoardWorkflows`, shared verbatim with the Planning header slot. Board gates cache hydration on `workflowColumnsEnabled === true || settingsLoaded === false` so workflow-columns users never flash the legacy board, and consumes the exposed raw state setter for optimistic task→workflow assignment. When the flag is OFF the server returns `{ flagEnabled: false }` and we render the legacy single-lane board below.
  */
  const shouldHydrateBoardWorkflowsCache = workflowColumnsEnabled === true || settingsLoaded === false;
  const {
    boardWorkflows,
    workflowMode,
    workflowOptions,
    selectedWorkflow,
    setSelectedWorkflowId,
    refreshBoardWorkflows,
    setBoardWorkflowsState,
  } = useBoardWorkflows({ projectId, shouldHydrateCache: shouldHydrateBoardWorkflowsCache });
  const draggingTaskIdRef = useRef<string | null>(null);

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

  const workflowStatusCounts = useMemo(
    () => computeWorkflowStatusCounts(tasks, boardWorkflows),
    [boardWorkflows, tasks],
  );

  const selectedWorkflowTasks = useMemo(() => {
    if (!workflowMode || !boardWorkflows || !selectedWorkflow) return [];
    return tasks.filter((task) => {
      const workflowId = boardWorkflows.taskWorkflowIds[task.id] ?? boardWorkflows.defaultWorkflowId;
      return workflowId === selectedWorkflow.id;
    });
  }, [boardWorkflows, selectedWorkflow, tasks, workflowMode]);

  const applyOptimisticTaskWorkflow = useCallback((taskId: string, workflowId: string) => {
    setBoardWorkflowsState((previous) => {
      if (!previous || previous.projectId !== projectId) return previous;
      if (previous.payload.taskWorkflowIds[taskId]) return previous;

      const payload: BoardWorkflowsPayload = {
        ...previous.payload,
        taskWorkflowIds: {
          ...previous.payload.taskWorkflowIds,
          [taskId]: workflowId,
        },
      };
      writeBoardWorkflowsCache(projectId, payload);
      return { projectId, payload };
    });
  }, [projectId]);

  /**
   * FNXC:WorkflowBoard 2026-06-21-21:34:
   * A task created on a selected non-default workflow lane must render in that lane immediately. The task list updates before board-workflows taskWorkflowIds, so without this optimistic project-scoped assignment the filter falls back to the default workflow and hides the new card until the next metadata refetch (FN-6903).
   */
  const handleWorkflowQuickCreate = useCallback(async (input: TaskCreateInput) => {
    if (!onQuickCreate || !selectedWorkflow) return undefined;
    const created = await onQuickCreate(input);
    if (created?.id) {
      const createdWorkflowId = (created as Task & { workflowId?: string }).workflowId ?? selectedWorkflow.id;
      applyOptimisticTaskWorkflow(created.id, createdWorkflowId);
      refreshBoardWorkflows();
    }
    return created;
  }, [applyOptimisticTaskWorkflow, onQuickCreate, refreshBoardWorkflows, selectedWorkflow]);

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

  const shouldGateLegacyBoard = boardWorkflows === null
    ? (workflowColumnsEnabled === true || settingsLoaded === false)
    : boardWorkflows.flagEnabled === true && boardWorkflows.workflows.length === 0;

  if (shouldGateLegacyBoard) {
    return <BoardWorkflowSkeleton empty={boardWorkflows?.flagEnabled === true} />;
  }

  if (workflowMode && selectedWorkflow) {
    const shouldRenderWorkflowControls = workflowOptions.length > 1 || Boolean(onCreateWorkflow || onOpenWorkflowEditor);
    const workflowToolbar = shouldRenderWorkflowControls && workflowOptions.length > 0 ? (
      <div className="board-workflow-toolbar">
        <div className="board-workflow-selector">
          <WorkflowSwitcher
            workflows={workflowOptions}
            value={selectedWorkflow.id}
            onChange={setSelectedWorkflowId}
            counts={workflowStatusCounts}
            onOpen={refreshBoardWorkflows}
            onEditWorkflow={onOpenWorkflowEditor}
            onCreateWorkflow={onCreateWorkflow}
          />
        </div>
      </div>
    ) : null;
    /*
    FNXC:WorkflowControls 2026-06-20-00:00:
    Board owns workflow selection state, so the existing selector/edit/create toolbar is portaled to Header only when the left sidebar is the active tablet/desktop navigation surface. If the Header slot is not mounted yet, render inline as the safe fallback so controls are never lost.

    FNXC:WorkflowControls 2026-06-20-15:42:
    Standalone workflow edit/create icon buttons were removed because those actions now live inside WorkflowSwitcher; keep this wrapper only when it contains the switcher to avoid empty toolbar shells.
    */
    const relocatedWorkflowToolbar = workflowControlsInHeader && headerWorkflowSlot && workflowToolbar
      ? createPortal(workflowToolbar, headerWorkflowSlot)
      : null;

    return (
      <div className="board-workflow-view">
        {workflowControlsInHeader && headerWorkflowSlot ? relocatedWorkflowToolbar : workflowToolbar}
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
                {...(isCreateColumn ? { onQuickCreate: handleWorkflowQuickCreate, onNewTask, onPlanningMode, onSubtaskBreakdown } : {})}
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
