import type { Task, TaskDetail, Column as ColumnType, ColumnId, TaskCreateInput, GithubIssueAction, MergeResult } from "@fusion/core";
import { COLUMNS, DEFAULT_COLUMN, isColumn } from "@fusion/core";
import { sortTasksForDisplayColumn, type DoneColumnSortMode } from "./taskSorting";
import { Column } from "./Column";
import "./Lane.css";
import "./Board.css";
import type { ToastType } from "../hooks/useToast";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { promoteTask, type ModelInfo, type BoardWorkflowsPayload, type BoardWorkflowColumn, type RevertTaskOptions, type RevertTaskResult } from "../api";
import { useBlockerFanout } from "../hooks/useBlockerFanout";
import { MOBILE_MEDIA_QUERY, useViewportMode } from "../hooks/useViewportMode";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import { getBoardCanDropTaskRejection } from "./boardCanDropTask";
import { WorkflowSwitcher } from "./WorkflowSwitcher";
import { computeWorkflowStatusCounts } from "./workflowStatusCounts";
import { writeBoardWorkflowsCache } from "../utils/boardWorkflowsCache";
import { useBoardWorkflows } from "../hooks/useBoardWorkflows";
import {
  ALL_WORKFLOWS_BOARD_VIEW_ID,
  readBoardWorkflowViewSelection,
  removeBoardWorkflowSelection,
  writeBoardWorkflowSelection,
} from "../utils/boardWorkflowSelection";
import type { TaskContextMenuColumnMetadata } from "./TaskContextMenu";

interface BoardProps {
  tasks: Task[];
  projectId?: string;
  maxConcurrent: number;
  showWorktreeGrouping: boolean;
  onMoveTask: (id: string, column: ColumnId) => Promise<Task>;
  onPauseTask?: (id: string) => Promise<Task>;
  onUnpauseTask?: (id: string) => Promise<Task>;
  onResetTask?: (id: string) => Promise<Task>;
  onDuplicateTask?: (id: string) => Promise<Task>;
  onMergeTask?: (id: string) => Promise<MergeResult>;
  onOpenDetail: (task: Task | TaskDetail) => void;
  onOpenRefine?: (task: Task | TaskDetail) => void;
  onOpenGroupModal?: (groupId: string) => void;
  addToast: (message: string, type?: ToastType) => void;
  onQuickCreate?: (input: TaskCreateInput) => Promise<Task | void>;
  onNewTask: () => void;
  autoMerge: boolean;
  /** Project merge strategy passed to Board-owned card context menus. */
  mergeStrategy?: string;
  onToggleAutoMerge: () => void;
  planAutoApproveEnabled: boolean;
  onTogglePlanAutoApprove: () => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[] }
  ) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onArchiveTask?: (id: string, options?: { removeLineageReferences?: boolean }) => Promise<Task>;
  onUnarchiveTask?: (id: string) => Promise<Task>;
  /* FNXC:TaskRevert 2026-07-05-00:00 (FN-7525): threaded alongside onArchiveTask/onUnarchiveTask. */
  onRevertTask?: (id: string, body?: RevertTaskOptions) => Promise<RevertTaskResult>;
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

export { ALL_WORKFLOWS_BOARD_VIEW_ID } from "../utils/boardWorkflowSelection";

type AggregateBoardColumn = BoardWorkflowColumn & { sourceWorkflowIds: string[] };
type AggregateQuickCreateTarget = { columnId: string; workflowId: string };

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

export function Board({ tasks, projectId, maxConcurrent, showWorktreeGrouping, onMoveTask, onPauseTask, onUnpauseTask, onResetTask, onDuplicateTask, onMergeTask, onOpenDetail, onOpenRefine, onOpenGroupModal, addToast, onQuickCreate, onNewTask, autoMerge, mergeStrategy = "direct", onToggleAutoMerge, planAutoApproveEnabled, onTogglePlanAutoApprove, globalPaused, onUpdateTask, onRetryTask, onArchiveTask, onUnarchiveTask, onRevertTask, onDeleteTask, onArchiveAllDone, onLoadArchivedTasks, searchQuery = "", availableModels, onPlanningMode, onSubtaskBreakdown, onOpenDetailWithTab, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, taskStuckTimeoutMs, onOpenMission, staleHighFanoutBlockerAgeThresholdMs, lastFetchTimeMs, prAuthAvailable, onOpenWorkflowEditor, onCreateWorkflow, workflowColumnsEnabled, settingsLoaded, workflowControlsInHeader = false }: BoardProps) {
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);
  /*
  FNXC:DoneColumnSorting 2026-06-29-16:57:
  Board owns one Done sort mode so legacy and built-in workflow Done surfaces stay in sync; the default remains completion-date descending to preserve existing first-load ordering.
  */
  const [doneSortMode, setDoneSortMode] = useState<DoneColumnSortMode>("completion-date-desc");
  const [isAllWorkflowsViewSelected, setIsAllWorkflowsViewSelected] = useState(
    () => readBoardWorkflowViewSelection(projectId) === ALL_WORKFLOWS_BOARD_VIEW_ID,
  );
  const archivedLoadedRef = useRef(false);
  const boardRef = useRef<HTMLElement | null>(null);
  const [headerWorkflowSlot, setHeaderWorkflowSlot] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    return document.getElementById("header-workflow-slot");
  });
  const viewportMode = useViewportMode();
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
  }, [workflowControlsInHeader, viewportMode]);

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
      const sortedTasks = column === "done"
        ? sortTasksForDisplayColumn(nextGrouped[column], column, doneSortMode)
        : sortTasksForDisplayColumn(nextGrouped[column], column);
      stableGrouped[column] = areTaskArraysEqual(previousGrouped[column], sortedTasks)
        ? previousGrouped[column]
        : sortedTasks;
    }

    tasksByColumnCacheRef.current = stableGrouped;
    return stableGrouped;
  }, [tasks, doneSortMode]);

  /*
  FNXC:BoardNavigation 2026-06-30-17:42:
  Periodic task/workflow refreshes, rerenders, window resize, and visualViewport resize must not override intentional board-column scroll while the Board is already visible. Keep FN-001/FN-4574 stabilization focused on page-level horizontal drift and layout reflow; #board is the user's horizontal scroller, so it must not be forced back to triage.
  */
  // FN-4574 + FN-001 diagnosis: on iOS Safari, the mobile board can occasionally
  // snap against stale layout/visualViewport metrics before flex columns resolve,
  // both on initial mount and on pageshow/bfcache restore after backgrounding.
  // We keep the FN-001 baseline (`scroll-snap-type: x proximity` +
  // `overflow-anchor: none`) and only stabilize via reflow + document scroll
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
    selectedWorkflowId,
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

  const workflowStatusCounts = useMemo(() => {
    /*
    FNXC:WorkflowSwitcher 2026-07-01-23:04:
    computeWorkflowStatusCounts already owns the dashboard-only All workflows aggregate sentinel. Board must pass the helper result through directly instead of re-summing every map entry, because the map includes the sentinel and summing it again doubles the dropdown aggregate row.
    */
    return computeWorkflowStatusCounts(tasks, boardWorkflows);
  }, [boardWorkflows, tasks]);

  useEffect(() => {
    setIsAllWorkflowsViewSelected(readBoardWorkflowViewSelection(projectId) === ALL_WORKFLOWS_BOARD_VIEW_ID);
  }, [projectId]);

  const handleWorkflowSwitcherChange = useCallback((workflowId: string) => {
    /*
    FNXC:WorkflowBoard 2026-06-30-00:00:
    "All workflows" is a Board-only aggregate filter sentinel. It is now persisted in the same project-scoped Board view preference as real workflow ids so refresh/remount restores whichever Board view the operator last selected, while `useBoardWorkflows` filters the sentinel away from shared real-workflow consumers and backend-bound APIs.
    */
    if (workflowId === ALL_WORKFLOWS_BOARD_VIEW_ID) {
      setIsAllWorkflowsViewSelected(true);
      writeBoardWorkflowSelection(projectId, ALL_WORKFLOWS_BOARD_VIEW_ID);
      return;
    }
    setIsAllWorkflowsViewSelected(false);
    setSelectedWorkflowId(workflowId);
  }, [projectId, setSelectedWorkflowId]);

  useEffect(() => {
    if (boardWorkflows && !workflowMode) {
      setIsAllWorkflowsViewSelected(false);
      if (readBoardWorkflowViewSelection(projectId) === ALL_WORKFLOWS_BOARD_VIEW_ID) {
        removeBoardWorkflowSelection(projectId);
      }
    }
  }, [boardWorkflows, projectId, workflowMode]);

  const knownWorkflowIds = useMemo(() => new Set(boardWorkflows?.workflows.map((workflow) => workflow.id) ?? []), [boardWorkflows]);

  const workflowColumnsByWorkflowId = useMemo(() => {
    const byWorkflow = new Map<string, Map<string, BoardWorkflowColumn>>();
    for (const workflow of boardWorkflows?.workflows ?? []) {
      byWorkflow.set(workflow.id, new Map(workflow.columns.map((column) => [column.id, column])));
    }
    return byWorkflow;
  }, [boardWorkflows]);

  const getEffectiveTaskWorkflowId = useCallback((task: Task) => {
    if (!boardWorkflows) return null;
    const assignedWorkflowId = boardWorkflows.taskWorkflowIds[task.id];
    return assignedWorkflowId && knownWorkflowIds.has(assignedWorkflowId)
      ? assignedWorkflowId
      : boardWorkflows.defaultWorkflowId;
  }, [boardWorkflows, knownWorkflowIds]);

  /*
  FNXC:WorkflowBoard 2026-07-05-14:20:
  Invariant: every rendered task must resolve to its REAL workflow, or the board silently drops it.
  A task created into a workflow whose intake column differs from the default (e.g. Coding (Ideas) → "ideas", per FN-7591) disappears until the next mount/focus/workflow-CRUD refetch. Cause: the task list (SSE) updates before the board-workflows `taskWorkflowIds` map, so getEffectiveTaskWorkflowId falls back to `defaultWorkflowId` (plain Coding), whose columns do not declare the intake column; the aggregate grouping then `continue`-skips the card and the single-workflow grouping files it into a never-rendered phantom bucket. The board's own quick-create handlers dodge this via applyOptimisticTaskWorkflow, but the shared create surfaces (QuickEntryBox / NewTaskModal / InlineCreateCard→TodoView / insight→task) route through useTaskHandlers and never seed the map. Fix at the invariant, not the create surface: whenever a rendered task is absent from taskWorkflowIds, force ONE board-workflows refetch so its persisted workflow selection (and intake column) resolves. Signature-guarded on the sorted unmapped-id set so we never spin an infinite refetch loop, and only run in workflow mode once the payload has loaded.

  The refetch is deferred by one macrotask and re-checked against the latest state at fire time: the board's own quick-create commits the new task one microtask before applyOptimisticTaskWorkflow seeds it, so a synchronous refetch here would double-fire alongside the optimistic path. Deferring lets the seed land first — an already-mapped task is then skipped — so this only fetches for tasks that truly arrived without a workflow mapping.
  */
  const boardWorkflowsRef = useRef(boardWorkflows);
  boardWorkflowsRef.current = boardWorkflows;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const lastUnmappedTaskSignatureRef = useRef<string | null>(null);
  const unmappedRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!boardWorkflows || !workflowMode) return;
    const unmapped = tasks
      .filter((task) => boardWorkflows.taskWorkflowIds[task.id] === undefined)
      .map((task) => task.id)
      .sort();
    if (unmapped.length === 0) {
      lastUnmappedTaskSignatureRef.current = null;
      return;
    }
    const signature = unmapped.join(",");
    if (signature === lastUnmappedTaskSignatureRef.current) return;
    lastUnmappedTaskSignatureRef.current = signature;
    if (unmappedRefetchTimerRef.current) clearTimeout(unmappedRefetchTimerRef.current);
    unmappedRefetchTimerRef.current = setTimeout(() => {
      unmappedRefetchTimerRef.current = null;
      const latestWorkflows = boardWorkflowsRef.current;
      if (!latestWorkflows) return;
      const stillUnmapped = tasksRef.current.some((task) => latestWorkflows.taskWorkflowIds[task.id] === undefined);
      if (stillUnmapped) refreshBoardWorkflows({ forceFresh: true });
    }, 0);
  }, [boardWorkflows, refreshBoardWorkflows, tasks, workflowMode]);

  useEffect(() => () => {
    if (unmappedRefetchTimerRef.current) clearTimeout(unmappedRefetchTimerRef.current);
  }, []);

  const resolveWorkflowQuickCreateTarget = useCallback((targetWorkflowId: string, preferredColumnId?: string | null): ColumnId | undefined => {
    if (targetWorkflowId === ALL_WORKFLOWS_BOARD_VIEW_ID) return undefined;
    const workflow = boardWorkflows?.workflows.find((candidate) => candidate.id === targetWorkflowId);
    if (!workflow) return undefined;
    const visibleColumns = workflow.columns.filter((column) => !column.flags.archived && !column.flags.hiddenFromBoard);
    const preferredColumn = preferredColumnId ? visibleColumns.find((column) => column.id === preferredColumnId) : undefined;
    const column = preferredColumn
      ?? visibleColumns.find((candidate) => candidate.flags.intake)
      ?? visibleColumns[0];
    return column?.id as ColumnId | undefined;
  }, [boardWorkflows]);

  const selectedWorkflowTasks = useMemo(() => {
    if (!workflowMode || !boardWorkflows || !selectedWorkflow) return [];
    return tasks.filter((task) => getEffectiveTaskWorkflowId(task) === selectedWorkflow.id);
  }, [boardWorkflows, getEffectiveTaskWorkflowId, selectedWorkflow, tasks, workflowMode]);

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
    const targetWorkflowId = typeof input.workflowId === "string" && input.workflowId !== ALL_WORKFLOWS_BOARD_VIEW_ID
      ? input.workflowId
      : selectedWorkflow.id;
    const targetColumn = resolveWorkflowQuickCreateTarget(targetWorkflowId, input.column);
    const created = await onQuickCreate({
      ...input,
      ...(targetColumn ? { column: targetColumn } : {}),
      workflowId: targetWorkflowId,
    });
    if (created?.id) {
      const createdWorkflowId = (created as Task & { workflowId?: string }).workflowId ?? targetWorkflowId;
      applyOptimisticTaskWorkflow(created.id, createdWorkflowId);
      refreshBoardWorkflows();
    }
    return created;
  }, [applyOptimisticTaskWorkflow, onQuickCreate, refreshBoardWorkflows, resolveWorkflowQuickCreateTarget, selectedWorkflow]);

  /**
   * FNXC:WorkflowBoard 2026-06-29-23:58:
   * The aggregate All workflows board is a read-side union, not a real workflow. Quick create must attach to one real workflow intake/default column so custom-default projects never submit synthetic `triage` or an empty workflow id to the backend.
   */
  const handleAggregateWorkflowQuickCreate = useCallback(async (input: TaskCreateInput) => {
    if (!onQuickCreate) return undefined;
    const targetWorkflowId = typeof input.workflowId === "string" && input.workflowId !== ALL_WORKFLOWS_BOARD_VIEW_ID
      ? input.workflowId
      : (boardWorkflows?.workflows.find((workflow) => workflow.id === boardWorkflows.defaultWorkflowId)?.id ?? boardWorkflows?.workflows[0]?.id);
    const targetColumn = targetWorkflowId ? resolveWorkflowQuickCreateTarget(targetWorkflowId, input.column) : undefined;
    const created = await onQuickCreate({
      ...input,
      ...(targetColumn ? { column: targetColumn } : {}),
      ...(targetWorkflowId ? { workflowId: targetWorkflowId } : {}),
    });
    if (created?.id && targetWorkflowId) {
      const createdWorkflowId = (created as Task & { workflowId?: string }).workflowId ?? targetWorkflowId;
      applyOptimisticTaskWorkflow(created.id, createdWorkflowId);
      refreshBoardWorkflows();
    }
    return created;
  }, [applyOptimisticTaskWorkflow, boardWorkflows, onQuickCreate, refreshBoardWorkflows, resolveWorkflowQuickCreateTarget]);

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

  const workflowContextMenuColumnsByWorkflowId = useMemo(() => {
    const map = new Map<string, readonly TaskContextMenuColumnMetadata[]>();
    for (const workflow of boardWorkflows?.workflows ?? []) {
      map.set(workflow.id, workflow.columns
        .filter((column) => !column.flags.hiddenFromBoard)
        .map((column) => ({ id: column.id, label: column.name, flags: column.flags })));
    }
    return map;
  }, [boardWorkflows]);

  const selectedWorkflowContextMenuColumns = useMemo(() => (
    selectedWorkflow ? workflowContextMenuColumnsByWorkflowId.get(selectedWorkflow.id) : undefined
  ), [selectedWorkflow, workflowContextMenuColumnsByWorkflowId]);

  const taskContextMenuColumnsByTaskId = useMemo(() => {
    const map = new Map<string, readonly TaskContextMenuColumnMetadata[]>();
    if (!workflowMode || !boardWorkflows) return map;
    for (const task of tasks) {
      const workflowId = getEffectiveTaskWorkflowId(task);
      const columns = workflowId ? workflowContextMenuColumnsByWorkflowId.get(workflowId) : undefined;
      if (columns) map.set(task.id, columns);
    }
    return map;
  }, [boardWorkflows, getEffectiveTaskWorkflowId, tasks, workflowContextMenuColumnsByWorkflowId, workflowMode]);

  const selectedWorkflowTasksByColumn = useMemo(() => {
    const grouped: Record<string, Task[]> = {};
    if (!selectedWorkflow) return grouped;
    for (const column of selectedWorkflow.columns) grouped[column.id] = [];
    /*
    FNXC:WorkflowBoard 2026-07-05-14:20:
    Safety net (defense in depth for the taskWorkflowIds refetch above): a card that passed the selected-workflow membership filter genuinely belongs on THIS board, so it must always land in a rendered lane. If its stored `column` is not one this workflow declares (a workflow edited to drop a column, or a create/refetch race that lands an intake-column card before its lane is known), re-home it for DISPLAY into the workflow's intake/first visible column instead of a `??=`-created bucket that is never rendered. Display-only — the task's stored column is untouched.
    */
    for (const task of selectedWorkflowTasks) {
      const columnId = grouped[task.column] !== undefined
        ? task.column
        : (selectedWorkflowCreateColumnId ?? task.column);
      (grouped[columnId] ??= []).push(task);
    }
    for (const column of selectedWorkflow.columns) {
      /*
      FNXC:DoneColumnSorting 2026-06-29-20:20:
      Workflow-mode Done sorting follows the workflow trait, not only the built-in `done` id, so custom complete lanes get the same descending completion-date/task-id selector while archived lanes keep their own behavior.
      */
      const isWorkflowDoneLikeColumn = column.flags.complete === true && column.flags.archived !== true;
      grouped[column.id] = isWorkflowDoneLikeColumn
        ? sortTasksForDisplayColumn(grouped[column.id] ?? [], "done", doneSortMode)
        : sortTasksForDisplayColumn(grouped[column.id] ?? [], column.id as ColumnType);
    }
    return grouped;
  }, [doneSortMode, selectedWorkflow, selectedWorkflowCreateColumnId, selectedWorkflowTasks]);

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
    for (const task of tasks) {
      const workflowId = getEffectiveTaskWorkflowId(task);
      const defs = workflowId ? cardDefsByWorkflow.get(workflowId) : undefined;
      if (defs) map.set(task.id, defs);
    }
    return map;
  }, [cardDefsByWorkflow, getEffectiveTaskWorkflowId, tasks, boardWorkflows]);

  const workflowIdentityById = useMemo(() => {
    const map = new Map<string, { workflowName: string; workflowIcon?: string }>();
    if (!boardWorkflows) return map;
    for (const workflow of boardWorkflows.workflows) {
      map.set(workflow.id, { workflowName: workflow.name, workflowIcon: workflow.icon });
    }
    return map;
  }, [boardWorkflows]);

  /*
  FNXC:WorkflowBoard 2026-06-29-00:00:
  All-workflows Board cards need trustworthy workflow-name badges, but per-workflow Board views and other TaskCard callers must not render empty shells. Derive badges only from board-workflows metadata, falling stale or missing task assignments back to the default workflow without persisting the aggregate sentinel.
  */
  const aggregateTaskWorkflowBadges = useMemo(() => {
    const map = new Map<string, { workflowId: string; workflowName: string; workflowIcon?: string }>();
    if (!boardWorkflows) return map;
    for (const task of tasks) {
      const assignedWorkflowId = boardWorkflows.taskWorkflowIds[task.id] ?? boardWorkflows.defaultWorkflowId;
      const workflowId = workflowIdentityById.has(assignedWorkflowId) ? assignedWorkflowId : boardWorkflows.defaultWorkflowId;
      const workflowIdentity = workflowIdentityById.get(workflowId);
      if (workflowIdentity) {
        map.set(task.id, { workflowId, ...workflowIdentity });
      }
    }
    return map;
  }, [boardWorkflows, tasks, workflowIdentityById]);

  /*
  FNXC:WorkflowBoard 2026-06-29-16:00:
  The aggregate Board view must not hide cards from custom workflow columns. Build a non-persisted union of visible workflow column ids and append canonical lifecycle columns so all task columns have a rendered destination without inventing a backend workflow id.

  FNXC:WorkflowBoard 2026-06-29-18:37:
  Shared aggregate column ids must use the default workflow's label and trait flags when that workflow declares them; otherwise preserve the first workflow definition that introduced the id. This keeps "All workflows" deterministic for duplicate column names without OR-merging incompatible workflow traits.

  FNXC:WorkflowBoard 2026-06-29-23:54:
  Aggregate Board rendering separates active columns from archived columns after the deterministic union is built. This preserves the existing collapsed archived-column behavior while the main All workflows lane set stays limited to non-hidden, non-archived destinations.
  */
  const aggregateBoardColumns = useMemo<AggregateBoardColumn[]>(() => {
    const byId = new Map<string, AggregateBoardColumn>();
    if (boardWorkflows) {
      const defaultWorkflow = boardWorkflows.workflows.find((workflow) => workflow.id === boardWorkflows.defaultWorkflowId);
      const orderedWorkflows = [
        ...(defaultWorkflow ? [defaultWorkflow] : []),
        ...boardWorkflows.workflows.filter((workflow) => workflow.id !== boardWorkflows.defaultWorkflowId),
      ];
      for (const workflow of orderedWorkflows) {
        for (const column of workflow.columns) {
          if (column.flags.hiddenFromBoard) continue;
          const existing = byId.get(column.id);
          if (existing) {
            existing.sourceWorkflowIds.push(workflow.id);
            continue;
          }
          byId.set(column.id, { ...column, flags: { ...column.flags }, sourceWorkflowIds: [workflow.id] });
        }
      }
    }
    for (const column of COLUMNS) {
      if (!byId.has(column)) {
        byId.set(column, {
          id: column,
          name: column,
          flags: { archived: column === "archived", complete: column === "done", intake: column === "triage", countsTowardWip: column === "in-progress", mergeBlocker: column === "in-review" },
          sourceWorkflowIds: [],
        });
      }
    }
    const order = new Map(COLUMNS.map((column, index) => [column, index]));
    return [...byId.values()].sort((a, b) => {
      const aOrder = order.get(a.id as ColumnType) ?? (a.flags.archived ? 10_000 : 1_000);
      const bOrder = order.get(b.id as ColumnType) ?? (b.flags.archived ? 10_000 : 1_000);
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.name.localeCompare(b.name);
    });
  }, [boardWorkflows]);

  const aggregateQuickCreateTarget = useMemo<AggregateQuickCreateTarget | null>(() => {
    if (!boardWorkflows) return null;
    const defaultWorkflow = boardWorkflows.workflows.find((workflow) => workflow.id === boardWorkflows.defaultWorkflowId);
    const orderedWorkflows = [
      ...(defaultWorkflow ? [defaultWorkflow] : []),
      ...boardWorkflows.workflows.filter((workflow) => workflow.id !== boardWorkflows.defaultWorkflowId),
    ];
    for (const workflow of orderedWorkflows) {
      const column = workflow.columns.find((candidate) => candidate.flags.intake && !candidate.flags.archived && !candidate.flags.hiddenFromBoard)
        ?? workflow.columns.find((candidate) => !candidate.flags.archived && !candidate.flags.hiddenFromBoard);
      if (column) return { columnId: column.id, workflowId: workflow.id };
    }
    return null;
  }, [boardWorkflows]);

  const aggregateVisibleBoardColumns = useMemo(
    () => aggregateBoardColumns.filter((column) => column.flags.archived !== true),
    [aggregateBoardColumns],
  );

  const aggregateArchivedBoardColumns = useMemo(
    () => aggregateBoardColumns.filter((column) => column.flags.archived === true),
    [aggregateBoardColumns],
  );

  const aggregateRenderedBoardColumns = useMemo(
    () => [...aggregateVisibleBoardColumns, ...aggregateArchivedBoardColumns],
    [aggregateArchivedBoardColumns, aggregateVisibleBoardColumns],
  );

  const aggregateTasksByColumn = useMemo(() => {
    const grouped: Record<string, Task[]> = {};
    for (const column of aggregateBoardColumns) grouped[column.id] = [];
    for (const task of tasks) {
      const workflowId = getEffectiveTaskWorkflowId(task);
      const workflowColumn = workflowId ? workflowColumnsByWorkflowId.get(workflowId)?.get(task.column) : null;
      /*
      FNXC:WorkflowBoard 2026-06-29-23:59:
      Aggregate Board grouping must resolve the task's effective workflow before using a shared column id. If one workflow hides `qa` while another shows it, tasks assigned to the hidden `qa` column stay hidden instead of leaking into the visible aggregate lane.
      */
      if (!workflowColumn || workflowColumn.flags.hiddenFromBoard) continue;
      (grouped[task.column] ??= []).push(task);
    }
    for (const column of aggregateBoardColumns) {
      const isDoneLikeColumn = column.flags.complete === true && column.flags.archived !== true;
      grouped[column.id] = isDoneLikeColumn
        ? sortTasksForDisplayColumn(grouped[column.id] ?? [], "done", doneSortMode)
        : sortTasksForDisplayColumn(grouped[column.id] ?? [], column.id as ColumnType);
    }
    return grouped;
  }, [aggregateBoardColumns, doneSortMode, getEffectiveTaskWorkflowId, tasks, workflowColumnsByWorkflowId]);

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
    const shouldRenderWorkflowControls = workflowOptions.length > 0;
    const workflowSwitcherValue = isAllWorkflowsViewSelected ? ALL_WORKFLOWS_BOARD_VIEW_ID : (selectedWorkflowId ?? selectedWorkflow.id);
    const workflowToolbar = shouldRenderWorkflowControls ? (
      <div className="board-workflow-toolbar">
        <div className="board-workflow-selector">
          <WorkflowSwitcher
            workflows={workflowOptions}
            value={workflowSwitcherValue}
            onChange={handleWorkflowSwitcherChange}
            counts={workflowStatusCounts}
            aggregateOption={{ id: ALL_WORKFLOWS_BOARD_VIEW_ID, name: "All workflows" }}
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
    const renderedWorkflowToolbar = workflowControlsInHeader && headerWorkflowSlot ? relocatedWorkflowToolbar : workflowToolbar;

    if (isAllWorkflowsViewSelected) {
      return (
        <div className="board-workflow-view">
          {renderedWorkflowToolbar}
          <main className="board board-workflow-columns" id="board" ref={boardRef}>
            {aggregateRenderedBoardColumns.map((columnDef) => {
              const isCreateColumn = aggregateQuickCreateTarget?.columnId === columnDef.id;
              const isDoneLikeColumn = columnDef.flags.complete === true && columnDef.flags.archived !== true;
              return (
                <Column
                  key={columnDef.id}
                  column={columnDef.id as ColumnType}
                  workflowMode
                  columnDisplayName={columnDef.name}
                  columnFlags={columnDef.flags}
                  taskContextMenuColumnsByTaskId={taskContextMenuColumnsByTaskId}
                  tasks={aggregateTasksByColumn[columnDef.id] ?? []}
                  projectId={projectId}
                  maxConcurrent={maxConcurrent}
                  showWorktreeGrouping={showWorktreeGrouping}
                  onMoveTask={onMoveTask}
                  onPauseTask={onPauseTask}
                  onUnpauseTask={onUnpauseTask}
                  onResetTask={onResetTask}
                  onDuplicateTask={onDuplicateTask}
                  onMergeTask={onMergeTask}
                  onOpenDetail={onOpenDetail}
                  onOpenRefine={onOpenRefine}
                  onOpenGroupModal={onOpenGroupModal}
                  addToast={addToast}
                  globalPaused={globalPaused}
                  onUpdateTask={onUpdateTask}
                  onRetryTask={onRetryTask}
                  onArchiveTask={onArchiveTask}
                  onUnarchiveTask={onUnarchiveTask}
                  onRevertTask={onRevertTask}
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
                  taskCardFieldDefs={taskCardFieldDefs}
                  taskWorkflowBadges={aggregateTaskWorkflowBadges}
                  blockerFanoutMap={blockerFanoutMap}
                  prAuthAvailable={prAuthAvailable}
                  autoMerge={autoMerge}
                  mergeStrategy={mergeStrategy}
                  {...(((columnDef.flags.intake || columnDef.flags.hold) && !columnDef.flags.archived && !columnDef.flags.complete && !columnDef.flags.countsTowardWip && !columnDef.flags.mergeBlocker && !columnDef.flags.humanReview) ? { planAutoApproveEnabled, onTogglePlanAutoApprove } : {})}
                  {...(isCreateColumn && aggregateQuickCreateTarget ? { workflowId: aggregateQuickCreateTarget.workflowId, workflowOptions, defaultWorkflowId: boardWorkflows?.defaultWorkflowId ?? null, onQuickCreate: handleAggregateWorkflowQuickCreate, onNewTask, onPlanningMode, onSubtaskBreakdown } : {})}
                  {...(columnDef.flags.mergeBlocker || columnDef.flags.humanReview ? { onToggleAutoMerge: handleToggleAutoMerge } : {})}
                  {...(columnDef.id === "done" ? { onArchiveAllDone } : {})}
                  {...(isDoneLikeColumn ? { doneSortMode, onDoneSortModeChange: setDoneSortMode } : {})}
                  {...(columnDef.flags.archived ? { collapsed: archivedCollapsed, onToggleCollapse: handleToggleArchivedCollapse } : {})}
                />
              );
            })}
          </main>
        </div>
      );
    }

    return (
      <div className="board-workflow-view">
        {renderedWorkflowToolbar}
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
            const isWorkflowDoneLikeColumn = columnDef.flags.complete === true && columnDef.flags.archived !== true;
            return (
              <Column
                key={columnDef.id}
                column={columnDef.id as ColumnType}
                workflowMode
                workflowId={selectedWorkflow.id}
                columnDisplayName={columnDef.name}
                columnFlags={columnDef.flags}
                workflowContextMenuColumns={selectedWorkflowContextMenuColumns}
                tasks={selectedWorkflowTasksByColumn[columnDef.id] ?? []}
                allTasks={selectedWorkflowTasks}
                projectId={projectId}
                maxConcurrent={maxConcurrent}
                showWorktreeGrouping={showWorktreeGrouping}
                onMoveTask={onMoveTask}
                onPromote={handlePromote}
                canDropTask={(taskId) => canDropTask(taskId, columnDef.id, selectedWorkflow.id)}
                getDraggingTaskId={getDraggingTaskId}
                onPauseTask={onPauseTask}
                onUnpauseTask={onUnpauseTask}
                onResetTask={onResetTask}
                onDuplicateTask={onDuplicateTask}
                onMergeTask={onMergeTask}
                onOpenDetail={onOpenDetail}
                onOpenRefine={onOpenRefine}
                onOpenGroupModal={onOpenGroupModal}
                addToast={addToast}
                globalPaused={globalPaused}
                onUpdateTask={onUpdateTask}
                onRetryTask={onRetryTask}
                onArchiveTask={onArchiveTask}
                onUnarchiveTask={onUnarchiveTask}
                onRevertTask={onRevertTask}
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
                taskCardFieldDefs={taskCardFieldDefs}
                blockerFanoutMap={blockerFanoutMap}
                prAuthAvailable={prAuthAvailable}
                autoMerge={autoMerge}
                mergeStrategy={mergeStrategy}
                {...(((columnDef.flags.intake || columnDef.flags.hold) && !columnDef.flags.archived && !columnDef.flags.complete && !columnDef.flags.countsTowardWip && !columnDef.flags.mergeBlocker && !columnDef.flags.humanReview) ? { planAutoApproveEnabled, onTogglePlanAutoApprove } : {})}
                {...(isCreateColumn ? { workflowOptions, defaultWorkflowId: selectedWorkflow.id, onQuickCreate: handleWorkflowQuickCreate, onNewTask, onPlanningMode, onSubtaskBreakdown } : {})}
                {...(columnDef.flags.mergeBlocker || columnDef.flags.humanReview ? { onToggleAutoMerge: handleToggleAutoMerge } : {})}
                {...(columnDef.id === "done" ? { onArchiveAllDone } : {})}
                {...(isWorkflowDoneLikeColumn ? { doneSortMode, onDoneSortModeChange: setDoneSortMode } : {})}
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
              workflowContextMenuColumns={selectedWorkflowContextMenuColumns}
              tasks={selectedWorkflowTasksByColumn[selectedWorkflowArchivedColumn.id] ?? []}
              allTasks={selectedWorkflowTasks}
              projectId={projectId}
              maxConcurrent={maxConcurrent}
              showWorktreeGrouping={showWorktreeGrouping}
              onMoveTask={onMoveTask}
              onPromote={handlePromote}
              canDropTask={(taskId) => canDropTask(taskId, selectedWorkflowArchivedColumn.id, selectedWorkflow.id)}
              getDraggingTaskId={getDraggingTaskId}
              onPauseTask={onPauseTask}
              onUnpauseTask={onUnpauseTask}
              onResetTask={onResetTask}
              onDuplicateTask={onDuplicateTask}
              onMergeTask={onMergeTask}
              onOpenDetail={onOpenDetail}
              onOpenRefine={onOpenRefine}
              onOpenGroupModal={onOpenGroupModal}
              addToast={addToast}
              globalPaused={globalPaused}
              onUpdateTask={onUpdateTask}
              onRetryTask={onRetryTask}
              onArchiveTask={onArchiveTask}
              onUnarchiveTask={onUnarchiveTask}
              onRevertTask={onRevertTask}
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
              taskCardFieldDefs={taskCardFieldDefs}
              blockerFanoutMap={blockerFanoutMap}
              prAuthAvailable={prAuthAvailable}
              autoMerge={autoMerge}
              mergeStrategy={mergeStrategy}
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
            showWorktreeGrouping={showWorktreeGrouping}
            onMoveTask={onMoveTask}
            onPauseTask={onPauseTask}
            onUnpauseTask={onUnpauseTask}
            onResetTask={onResetTask}
            onDuplicateTask={onDuplicateTask}
            onMergeTask={onMergeTask}
            onOpenDetail={onOpenDetail}
            onOpenRefine={onOpenRefine}
            onOpenGroupModal={onOpenGroupModal}
            addToast={addToast}
            globalPaused={globalPaused}
            onUpdateTask={onUpdateTask}
            onRetryTask={onRetryTask}
            onArchiveTask={onArchiveTask}
            onUnarchiveTask={onUnarchiveTask}
            onRevertTask={onRevertTask}
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
            taskCardFieldDefs={taskCardFieldDefs}
            blockerFanoutMap={blockerFanoutMap}
            prAuthAvailable={prAuthAvailable}
            autoMerge={autoMerge}
            mergeStrategy={mergeStrategy}
            {...(col === "triage" ? { planAutoApproveEnabled, onTogglePlanAutoApprove } : {})}
            {...(col === "triage" ? { onQuickCreate, onNewTask, onPlanningMode, onSubtaskBreakdown } : {})}
            {...(col === "in-review" ? { onToggleAutoMerge: handleToggleAutoMerge } : {})}
            {...(col === "done" ? { onArchiveAllDone, doneSortMode, onDoneSortModeChange: setDoneSortMode } : {})}
            {...(col === "archived" ? { collapsed: archivedCollapsed, onToggleCollapse: handleToggleArchivedCollapse } : {})}
          />
        ))}
      </main>
    </>
  );
}
