import type { Task, TaskDetail, Column as ColumnType, ColumnId, TaskCreateInput, GithubIssueAction, MergeResult } from "@fusion/core";
import { sortTasksForDisplayColumn, type DoneColumnSortMode } from "./taskSorting";
import { Column } from "./Column";
import { TaskCard } from "./TaskCard";
import "./Lane.css";
import "./Board.css";
import type { ToastType } from "../hooks/useToast";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { promoteTask, type ModelInfo, type BoardWorkflowsPayload, type BoardWorkflowColumn, type RevertTaskOptions, type RevertTaskResult } from "../api";
import { useBlockerFanout, type BlockerFanoutColumnFlags } from "../hooks/useBlockerFanout";
import { useColumnScrollSnap } from "../hooks/useColumnScrollSnap";
import { MOBILE_MEDIA_QUERY, useViewportMode } from "../hooks/useViewportMode";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import { getBoardCanDropTaskRejection } from "./boardCanDropTask";
import { WorkflowSwitcher } from "./WorkflowSwitcher";
import { computeWorkflowStatusCounts } from "./workflowStatusCounts";
import { writeBoardWorkflowsCache } from "../utils/boardWorkflowsCache";
import { useBoardWorkflows } from "../hooks/useBoardWorkflows";
import { useUnmappedWorkflowRefetch } from "../hooks/useUnmappedWorkflowRefetch";
import {
  ALL_WORKFLOWS_BOARD_VIEW_ID,
  readBoardWorkflowViewSelection,
  removeBoardWorkflowSelection,
  writeBoardWorkflowSelection,
} from "../utils/boardWorkflowSelection";
import type { TaskContextMenuColumnMetadata } from "./TaskContextMenu";
import { isTaskReverted, partitionRevertedTasks } from "../utils/taskRevert";

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
  onNewTask: (workflowId?: string | null) => void;
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
  /** Opens a New Task draft using a reverted task description. */
  onReviseTask?: (task: Task) => void;
  onDeleteTask?: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
  }) => Promise<Task>;
  onArchiveAllDone?: () => Promise<Task[]>;
  /** Lazy-load archived tasks. Called the first time the user expands the archived column. */
  onLoadArchivedTasks?: () => Promise<void>;
  /** FNXC:ArchivePagination 2026-07-08-00:00: FN-7659 — fetch the next 100-item page of archived tasks (newest-first). Threaded to the Archived column's server-backed "Show more" button. */
  onLoadMoreArchivedTasks?: () => Promise<void>;
  /** Whether another archived page is available beyond what is currently loaded. */
  archivedHasMore?: boolean;
  /** True while a "Show more" archived page fetch is in flight. */
  archivedLoadingMore?: boolean;
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
  /** Relocates workflow controls into the Header portal slot when sidebar navigation owns the inline chrome. */
  workflowControlsInHeader?: boolean;
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

/*
FNXC:WorkflowResolvedColumns 2026-07-30-00:30 (batch-dashboard-app):
Does this column offer "Archive all done"? The COMPLETE trait, matching the sibling spreads that
already resolve `intake` and `mergeBlocker`/`humanReview` from the same `columnDef.flags`. The id
check was the odd one out, so on a renamed board the action vanished from the completed column while
its neighbouring affordances rendered correctly — an inconsistency inside one props spread, which is
how it survived review.

`archived` is excluded: that lane is also complete-ish and must not offer to archive its own
contents. Hoisted to a named predicate because both render sites need it and a JSX attribute
position cannot carry the explanation.
*/
function columnDefOffersArchiveAllDone(columnDef: { flags: { complete?: boolean; archived?: boolean } }): boolean {
  return columnDef.flags.complete === true && columnDef.flags.archived !== true;
}

export function Board({ tasks, projectId, maxConcurrent, showWorktreeGrouping, onMoveTask, onPauseTask, onUnpauseTask, onResetTask, onDuplicateTask, onMergeTask, onOpenDetail, onOpenRefine, onOpenGroupModal, addToast, onQuickCreate, onNewTask, autoMerge, mergeStrategy = "direct", onToggleAutoMerge, planAutoApproveEnabled, onTogglePlanAutoApprove, globalPaused, onUpdateTask, onRetryTask, onArchiveTask, onUnarchiveTask, onRevertTask, onReviseTask, onDeleteTask, onArchiveAllDone, onLoadArchivedTasks, onLoadMoreArchivedTasks, archivedHasMore, archivedLoadingMore, searchQuery = "", availableModels, onPlanningMode, onSubtaskBreakdown, onOpenDetailWithTab, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, taskStuckTimeoutMs, onOpenMission, staleHighFanoutBlockerAgeThresholdMs, lastFetchTimeMs, prAuthAvailable, onOpenWorkflowEditor, onCreateWorkflow, workflowControlsInHeader = false }: BoardProps) {
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
  const [boardElement, setBoardElement] = useState<HTMLElement | null>(null);
  /*
  FNXC:BoardNavigation 2026-07-16-00:00:
  The board can first render a workflow-loading skeleton, so a mutable ref alone would not
  re-run the snap effect after the live board mounts. Mirror the callback ref in state to attach
  user-only mobile snapping to every live Board variant without snapping the skeleton.
  */
  const setBoardRef = useCallback((element: HTMLElement | null) => {
    boardRef.current = element;
    setBoardElement((current) => current === element ? current : element);
  }, []);
  useColumnScrollSnap(boardElement, { mobileOnly: true });
  const [headerWorkflowSlot, setHeaderWorkflowSlot] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    return document.getElementById("header-workflow-slot");
  });
  const viewportMode = useViewportMode();
  // Normalized search-active signal: trimmed and non-empty
  const isSearchActive = searchQuery.trim() !== "";
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

  /*
  FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9, R8):
  `tasksByColumn` and its stable-identity cache ref are DELETED with the legacy
  single-lane board that was their only consumer. Both hardcoded the six legacy
  column ids as object literals, so they could not have bucketed a workflow-defined
  column at all. The workflow board buckets from each lane's own column ids
  (`selectedWorkflowTasks` / `aggregateBoardColumns`) and keeps its own memoization.
  */

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

  // ── U9 multi-lane board ───────────────────────────────────────────────────
  /*
  FNXC:BoardWorkflows 2026-06-20-08:58:
  Operators must never see a partial board while board-workflows metadata is still loading. Hydrate metadata from the project-scoped session cache, reset it on project switches, and show a neutral skeleton while uncached workflow metadata is unknown.

  FNXC:Workflows 2026-06-22-17:00:
  The board-workflows fetch/cache/SSE/selection loop lives in `useBoardWorkflows`, shared verbatim with the Planning header slot, and Board consumes the exposed raw state setter for optimistic task→workflow assignment.

  FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
  The `shouldHydrateCache` gate is DELETED. It read `workflowColumnsEnabled === true || settingsLoaded === false`, and every call site passed `workflowColumnsEnabled` as a literal `true` (`MainContent`), so the expression was unconditionally true — identical to the hook's default. Both props are gone with it; Board no longer needs settings loaded at all to decide what to render.
  */
  const {
    boardWorkflows,
    workflowMode,
    workflowOptions,
    selectedWorkflow,
    selectedWorkflowId,
    setSelectedWorkflowId,
    refreshBoardWorkflows,
    setBoardWorkflowsState,
  } = useBoardWorkflows({ projectId });
  const draggingTaskIdRef = useRef<string | null>(null);

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:15 (the board's fan-out read the LEGACY lanes):
  Resolve each card's traits through its OWN workflow — the construction `App.tsx` already uses for
  the footer index — so the fan-out map classifies against the operator's column names. Without it
  core fell back to `todo`/`in-review`/`done`, and since "active" is defined by exclusion, a finished
  card in a renamed completion lane stayed an active blocker forever.
  */
  const blockerFanoutColumnFlagsByTaskId = useMemo(() => {
    const index = new Map<string, BlockerFanoutColumnFlags>();
    if (!boardWorkflows) return index;
    const workflowsById = new Map(boardWorkflows.workflows.map((workflow) => [workflow.id, workflow]));
    for (const task of tasks) {
      const workflow = workflowsById.get(boardWorkflows.taskWorkflowIds[task.id] ?? boardWorkflows.defaultWorkflowId);
      const flags = workflow?.columns.find((column) => column.id === task.column)?.flags;
      if (flags) index.set(task.id, flags);
    }
    return index;
  }, [boardWorkflows, tasks]);
  const blockerFanoutMap = useBlockerFanout(tasks, {
    staleHighFanoutAgeThresholdMs: staleHighFanoutBlockerAgeThresholdMs,
    columnFlagsByTaskId: blockerFanoutColumnFlagsByTaskId,
  });

  const handlePromote = useCallback(async (taskId: string, options?: { force?: boolean }) => {
    // `force` only ever arrives from Column's confirmed unplanned-for-execution override.
    await promoteTask(taskId, projectId, options);
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
  useUnmappedWorkflowRefetch({ boardWorkflows, tasks, workflowMode, refreshBoardWorkflows, projectId });

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

  const handleSelectedWorkflowNewTask = useCallback(() => {
    onNewTask(selectedWorkflow?.id);
  }, [onNewTask, selectedWorkflow?.id]);

  const workflowContextMenuColumnsByWorkflowId = useMemo(() => {
    const map = new Map<string, readonly TaskContextMenuColumnMetadata[]>();
    for (const workflow of boardWorkflows?.workflows ?? []) {
      map.set(workflow.id, workflow.columns
        .filter((column) => !column.flags.hiddenFromBoard)
        .map((column) => ({ id: column.id, label: column.name, flags: column.flags, ...(column.moveTargets ? { moveTargets: column.moveTargets } : {}) })));
    }
    return map;
  }, [boardWorkflows]);

  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
  The TASK IDS whose own column is a hold lane IN THEIR OWN WORKFLOW.

  Resolved per task rather than as a board-wide set of hold column IDS (PR #2625 review —
  greptile). Column ids are namespaced per workflow, so two workflows can both declare
  `staging` with one marking it `hold` and the other `countsTowardWip`. A unioned id set
  cannot tell those apart, and every executing card in the second workflow would have shown
  up under Up Next as waiting work — a wrong answer presented confidently, which is worse
  than the renamed-board emptiness this change set out to fix.

  Resolving through `getEffectiveTaskWorkflowId` removes the ambiguity instead of narrowing
  it: the question "is this card waiting?" is answered by the card's own workflow, which is
  the only workflow that can answer it.
  */
  const holdTaskIds = useMemo(() => {
    const holdColumnsByWorkflowId = new Map<string, Set<string>>();
    for (const workflow of boardWorkflows?.workflows ?? []) {
      holdColumnsByWorkflowId.set(
        workflow.id,
        new Set(workflow.columns.filter((col) => col.flags.hold === true).map((col) => col.id)),
      );
    }
    const ids = new Set<string>();
    for (const task of tasks) {
      const workflowId = getEffectiveTaskWorkflowId(task);
      if (workflowId && holdColumnsByWorkflowId.get(workflowId)?.has(task.column)) ids.add(task.id);
    }
    return ids;
  }, [boardWorkflows, tasks, getEffectiveTaskWorkflowId]);

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
      if (isTaskReverted(task.sourceMetadata) && selectedWorkflow.columns.find((column) => column.id === task.column)?.flags.complete) continue;
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
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-07:10 (fleet phase):
      No more synthetic "done" column id. This branch forced done-sorting by passing the LITERAL "done"
      as the column argument, so a custom complete lane sorted correctly only because its caller lied
      about its name. `sortTasksForDisplayColumn` now takes the trait directly, so the real column id goes
      through and the sort intent is stated rather than smuggled through a fake id.
      */
      grouped[column.id] = sortTasksForDisplayColumn(
        grouped[column.id] ?? [],
        column.id as ColumnType,
        doneSortMode,
        column.flags.archived === true,
        column.flags.hold === true,
        isWorkflowDoneLikeColumn,
        column.flags.mergeBlocker === true || column.flags.humanReview === true,
      );
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

  FNXC:WorkflowResolvedColumns 2026-07-27-14:35 (U10 / R8):
  The union is now built ONLY from the workflows the payload declares. It previously appended every id of the legacy `COLUMNS` enum with synthesised trait flags, which drew a phantom lane for any lifecycle column no workflow declares — the visible failure a removed column (U11 merging Todo into Planning) would ship. Those injected lanes also carried the raw column id as their label, so a lane named "in-progress" appeared beside properly named workflow lanes.

  Ordering follows the workflows' own declaration order (default workflow first, then the remaining workflows in payload order) instead of the legacy enum's index. For the built-in workflows the two are identical — their IR declares columns in exactly the legacy order — so the default board is unchanged; for a renamed or reordered workflow the lanes now follow the IR rather than collapsing to an alphabetical tie-break.

  Cards resting in a column NO workflow declares are still rendered: `aggregateTasksByColumn` re-homes them for display into the aggregate quick-create intake lane (see its safety net below). Dropping the injected lanes therefore removes phantom lanes without stranding a single card.
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
    return [...byId.values()];
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

  const handleAggregateWorkflowNewTask = useCallback(() => {
    onNewTask(aggregateQuickCreateTarget?.workflowId);
  }, [aggregateQuickCreateTarget?.workflowId, onNewTask]);

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

  /*
  FNXC:TaskRevert 2026-08-01-20:06:
  A successful revert is resolution-required work, not completed work. Aggregate the
  shared, deduplicated partition once so All Workflows keeps those cards discoverable
  after its complete lanes exclude them, including custom complete columns.
  */
  const aggregateRevertedTasks = useMemo(
    () => partitionRevertedTasks(tasks).reverted,
    [tasks],
  );

  const aggregateTasksByColumn = useMemo(() => {
    const grouped: Record<string, Task[]> = {};
    for (const column of aggregateBoardColumns) grouped[column.id] = [];
    // Column ids some workflow explicitly hides from the board. A column-orphaned
    // task resting in one of these must stay hidden even when its (mis-)resolved
    // workflow doesn't declare the column, or the fallback below would surface an
    // explicitly hidden card in a visible lane.
    const hiddenAnywhereColumnIds = new Set<string>();
    for (const workflow of boardWorkflows?.workflows ?? []) {
      for (const column of workflow.columns) {
        if (column.flags.hiddenFromBoard) hiddenAnywhereColumnIds.add(column.id);
      }
    }
    for (const task of tasks) {
      const workflowId = getEffectiveTaskWorkflowId(task);
      const workflowColumn = workflowId ? workflowColumnsByWorkflowId.get(workflowId)?.get(task.column) : null;
      /*
      FNXC:WorkflowBoard 2026-06-29-23:59:
      Aggregate Board grouping must resolve the task's effective workflow before using a shared column id. If one workflow hides `qa` while another shows it, tasks assigned to the hidden `qa` column stay hidden instead of leaking into the visible aggregate lane.
      */
      if (workflowColumn?.flags.hiddenFromBoard) continue;
      if (isTaskReverted(task.sourceMetadata) && workflowColumn?.flags.complete) continue;
      if (!workflowColumn) {
        /*
        FNXC:WorkflowBoard 2026-07-12-23:35:
        Safety net (aggregate twin of the selected-workflow display re-home below/above): a task
        whose resolved workflow does NOT declare its stored column must not be continue-dropped
        into invisibility. This happens when a stale/missing task_workflow_selection resolves the
        task to the default workflow (e.g. an "ideas" card resolving to plain Coding), or when an
        engine rebound parks a card in a legacy column its workflow never declared. Render the card
        in its stored column when the aggregate union declares that lane; otherwise re-home it for
        DISPLAY into the aggregate quick-create intake lane. Display-only — the stored column is
        untouched.

        FNXC:WorkflowBoard 2026-07-13-11:55:
        Two carve-outs keep the safety net honest: a stored column that ANY workflow declares
        hiddenFromBoard stays hidden (the guard above can't see the true workflow's flag when the
        mapping is stale), and when no rendered fallback lane exists (no quick-create target) the
        card is skipped rather than pushed into a `grouped` key the render loop never reads.
        */
        const laneExists = grouped[task.column] !== undefined;
        if (!laneExists && hiddenAnywhereColumnIds.has(task.column)) continue;
        const fallbackColumnId = laneExists ? task.column : aggregateQuickCreateTarget?.columnId;
        if (fallbackColumnId === undefined || grouped[fallbackColumnId] === undefined) continue;
        grouped[fallbackColumnId].push(task);
        continue;
      }
      (grouped[task.column] ??= []).push(task);
    }
    for (const column of aggregateBoardColumns) {
      const isDoneLikeColumn = column.flags.complete === true && column.flags.archived !== true;
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-07:10 (fleet phase):
      No more synthetic "done" column id. This branch forced done-sorting by passing the LITERAL "done"
      as the column argument, so a custom complete lane sorted correctly only because its caller lied
      about its name. `sortTasksForDisplayColumn` now takes the trait directly, so the real column id goes
      through and the sort intent is stated rather than smuggled through a fake id.
      */
      grouped[column.id] = sortTasksForDisplayColumn(
        grouped[column.id] ?? [],
        column.id as ColumnType,
        doneSortMode,
        column.flags.archived === true,
        column.flags.hold === true,
        isDoneLikeColumn,
        column.flags.mergeBlocker === true || column.flags.humanReview === true,
      );
    }
    return grouped;
  }, [aggregateBoardColumns, aggregateQuickCreateTarget, boardWorkflows, doneSortMode, getEffectiveTaskWorkflowId, tasks, workflowColumnsByWorkflowId]);

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

  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (U12 — measured perf fix):
  Bind `canDropTask` per (lane, column) ONCE per dependency change instead of creating
  a new arrow inline in the render. `Column` is `React.memo`, and a fresh function
  identity on any prop defeats that entirely — so before this, ANY Board state change
  (collapsing the archived column, changing Done sort, opening the switcher)
  re-rendered EVERY column and every card beneath it, not just the affected one.

  This was invisible for a long time: the "keeps unaffected columns stable" regression
  test measured the LEGACY single-lane board, whose props were all stable. Deleting
  that board (U12 part 1) repointed the test at the real board, where it failed. I
  instrumented `React.memo`'s comparator to list which props actually change identity
  on a collapse toggle, and the answer was exactly one: `canDropTask`.

  A `useRef` cache invalidated by `useEffect` does NOT work here, which is why my first
  attempt at this failed and was reverted: the effect runs AFTER the render that
  populated the cache, so it wipes the very bindings that render created and the next
  render allocates fresh ones. `useMemo` keyed on the resolver has no such window —
  the map lives exactly as long as the closure it belongs to.
  */
  const canDropTaskBinder = useMemo(() => {
    const bindings = new Map<string, (taskId: string) => string | null>();
    return (columnId: string, laneWorkflowId: string) => {
      const key = `${laneWorkflowId}::${columnId}`;
      let bound = bindings.get(key);
      if (!bound) {
        bound = (taskId: string) => canDropTask(taskId, columnId, laneWorkflowId);
        bindings.set(key, bound);
      }
      return bound;
    };
  }, [canDropTask]);

  // FN-4380: GitHub badge state comes from persisted task fields (`task.prInfo`,
  // `task.issueInfo`, `task.githubTracking.issue`) and live WebSocket `badge:updated`
  // messages. We do NOT eagerly call `/api/github/batch-status` on board load.

  /*
  FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
  Show the skeleton until lanes resolve. Behaviour is unchanged, only the spelling:
  the null arm was `workflowColumnsEnabled === true || settingsLoaded === false`
  (always true — MainContent passed the literal `true`), and the loaded arm's
  `flagEnabled === true` conjunct was a server constant. `empty` distinguishes
  "still loading" (no payload) from "loaded, but this project resolved no lane",
  which is what the former `flagEnabled` read was standing in for.

  Note the retained failure behaviour: a board-workflows fetch that never succeeds
  leaves `boardWorkflows === null` and holds the skeleton. That was already true
  before this deletion — the legacy board below was NOT the fetch-failure fallback.
  */
  if (boardWorkflows === null || boardWorkflows.workflows.length === 0) {
    return <BoardWorkflowSkeleton empty={boardWorkflows !== null} />;
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
          <main className="board board-workflow-columns" id="board" ref={setBoardRef}>
            {aggregateRenderedBoardColumns.map((columnDef) => {
              const isCreateColumn = aggregateQuickCreateTarget?.columnId === columnDef.id;
              const isDoneLikeColumn = columnDef.flags.complete === true && columnDef.flags.archived !== true;
              return (
                <Column
                  key={columnDef.id}
                  column={columnDef.id as ColumnType}
                  workflowMode
                  columnDisplayName={columnDef.name}
                  columnDescription={columnDef.description}
                  columnFlags={columnDef.flags}
                  holdTaskIds={holdTaskIds}
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
                  onPlanningMode={onPlanningMode}
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
                  // FNXC:PlanApproval 2026-07-07-00:00: FN-7653 — the plan auto-approve shortcut belongs only to the intake/planning column, never to hold (Todo-like) columns; the built-in Coding workflow's Todo column carries the hold trait and was wrongly receiving this prop pair.
                  {...((columnDef.flags.intake && !columnDef.flags.archived && !columnDef.flags.complete && !columnDef.flags.countsTowardWip && !columnDef.flags.mergeBlocker && !columnDef.flags.humanReview) ? { planAutoApproveEnabled, onTogglePlanAutoApprove } : {})}
                  {...(isCreateColumn && aggregateQuickCreateTarget ? { workflowId: aggregateQuickCreateTarget.workflowId, workflowOptions, defaultWorkflowId: boardWorkflows?.defaultWorkflowId ?? null, onQuickCreate: handleAggregateWorkflowQuickCreate, onNewTask: handleAggregateWorkflowNewTask, onSubtaskBreakdown } : {})}
                  {...(columnDef.flags.mergeBlocker || columnDef.flags.humanReview ? { onToggleAutoMerge: handleToggleAutoMerge } : {})}
                  {...(columnDefOffersArchiveAllDone(columnDef) ? { onArchiveAllDone } : {})}
                  {...(isDoneLikeColumn ? { doneSortMode, onDoneSortModeChange: setDoneSortMode } : {})}
                  {...(columnDef.flags.archived ? { collapsed: archivedCollapsed, onToggleCollapse: handleToggleArchivedCollapse, archivedHasMore, archivedLoadingMore, onLoadMoreArchived: onLoadMoreArchivedTasks } : {})}
                />
              );
            })}
            {aggregateRevertedTasks.length > 0 && (
              <section className="reverted-tasks-section" aria-label="Reverted Tasks" data-testid="board-reverted-tasks">
                <h2>Reverted Tasks</h2>
                {aggregateRevertedTasks.map((task) => (
                  <TaskCard
                    key={`reverted-${task.id}`}
                    task={task}
                    taskColumnFlags={blockerFanoutColumnFlagsByTaskId.get(task.id)}
                    onOpenDetail={onOpenDetail}
                    onDeleteTask={onDeleteTask}
                    onReviseTask={onReviseTask}
                    addToast={addToast}
                    disableDrag
                  />
                ))}
              </section>
            )}
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
          ref={setBoardRef}
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
                columnDescription={columnDef.description}
                columnFlags={columnDef.flags}
                holdTaskIds={holdTaskIds}
                workflowContextMenuColumns={selectedWorkflowContextMenuColumns}
                tasks={selectedWorkflowTasksByColumn[columnDef.id] ?? []}
                allTasks={selectedWorkflowTasks}
                projectId={projectId}
                maxConcurrent={maxConcurrent}
                showWorktreeGrouping={showWorktreeGrouping}
                onMoveTask={onMoveTask}
                onPromote={handlePromote}
                canDropTask={canDropTaskBinder(columnDef.id, selectedWorkflow.id)}
                getDraggingTaskId={getDraggingTaskId}
                onPauseTask={onPauseTask}
                onUnpauseTask={onUnpauseTask}
                onResetTask={onResetTask}
                onDuplicateTask={onDuplicateTask}
                onMergeTask={onMergeTask}
                onOpenDetail={onOpenDetail}
                onPlanningMode={onPlanningMode}
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
                // FNXC:PlanApproval 2026-07-07-00:00: FN-7653 — the plan auto-approve shortcut belongs only to the intake/planning column, never to hold (Todo-like) columns; the built-in Coding workflow's Todo column carries the hold trait and was wrongly receiving this prop pair.
                {...((columnDef.flags.intake && !columnDef.flags.archived && !columnDef.flags.complete && !columnDef.flags.countsTowardWip && !columnDef.flags.mergeBlocker && !columnDef.flags.humanReview) ? { planAutoApproveEnabled, onTogglePlanAutoApprove } : {})}
                {...(isCreateColumn ? { workflowOptions, defaultWorkflowId: selectedWorkflow.id, onQuickCreate: handleWorkflowQuickCreate, onNewTask: handleSelectedWorkflowNewTask, onSubtaskBreakdown } : {})}
                {...(columnDef.flags.mergeBlocker || columnDef.flags.humanReview ? { onToggleAutoMerge: handleToggleAutoMerge } : {})}
                {...(columnDefOffersArchiveAllDone(columnDef) ? { onArchiveAllDone } : {})}
                {...(isWorkflowDoneLikeColumn ? { doneSortMode, onDoneSortModeChange: setDoneSortMode } : {})}
              />
            );
          })}
          {partitionRevertedTasks(selectedWorkflowTasks).reverted.length > 0 && (
            <section className="reverted-tasks-section" aria-label="Reverted Tasks" data-testid="board-reverted-tasks">
              <h2>Reverted Tasks</h2>
              {partitionRevertedTasks(selectedWorkflowTasks).reverted.map((task) => <TaskCard key={`reverted-${task.id}`} task={task} taskColumnFlags={blockerFanoutColumnFlagsByTaskId.get(task.id)} onOpenDetail={onOpenDetail} onDeleteTask={onDeleteTask} onReviseTask={onReviseTask} addToast={addToast} disableDrag />)}
            </section>
          )}
          {selectedWorkflowArchivedColumn && (
            <Column
              key={selectedWorkflowArchivedColumn.id}
              column={selectedWorkflowArchivedColumn.id as ColumnType}
              workflowMode
              workflowId={selectedWorkflow.id}
              columnDisplayName={selectedWorkflowArchivedColumn.name}
              columnDescription={selectedWorkflowArchivedColumn.description}
              columnFlags={selectedWorkflowArchivedColumn.flags}
              holdTaskIds={holdTaskIds}
              workflowContextMenuColumns={selectedWorkflowContextMenuColumns}
              tasks={selectedWorkflowTasksByColumn[selectedWorkflowArchivedColumn.id] ?? []}
              allTasks={selectedWorkflowTasks}
              projectId={projectId}
              maxConcurrent={maxConcurrent}
              showWorktreeGrouping={showWorktreeGrouping}
              onMoveTask={onMoveTask}
              onPromote={handlePromote}
              canDropTask={canDropTaskBinder(selectedWorkflowArchivedColumn.id, selectedWorkflow.id)}
              getDraggingTaskId={getDraggingTaskId}
              onPauseTask={onPauseTask}
              onUnpauseTask={onUnpauseTask}
              onResetTask={onResetTask}
              onDuplicateTask={onDuplicateTask}
              onMergeTask={onMergeTask}
              onOpenDetail={onOpenDetail}
              onPlanningMode={onPlanningMode}
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
              archivedHasMore={archivedHasMore}
              archivedLoadingMore={archivedLoadingMore}
              onLoadMoreArchived={onLoadMoreArchivedTasks}
            />
          )}
        </main>
      </div>
    );
  }

  /*
  FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9, R8):
  The legacy single-lane board is DELETED. It mapped the hardcoded `COLUMNS` enum
  and was the last board surface deriving its column set from the legacy vocabulary
  rather than from each card's own workflow — an R8 violation that survived U10.

  It was also unreachable. The skeleton gate above returns unless
  `boardWorkflows.workflows.length > 0`, which is exactly what makes `workflowMode`
  true; and `useBoardWorkflows` resolves `selectedWorkflow` to `workflowOptions[0]`
  when neither the stored nor the default selection matches, so it is non-null
  whenever a lane exists. The workflow branch above is therefore always taken.

  This arm remains only to narrow `selectedWorkflow` without a non-null assertion.
  Rendering the skeleton rather than throwing keeps a hypothetical unreachable
  state a blank frame instead of a crashed board.
  */
  return <BoardWorkflowSkeleton empty={false} />;
}
