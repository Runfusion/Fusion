import "./ListView.css";
import { useState, useCallback, useMemo, Fragment, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowUpDown, ArrowUp, ArrowDown, Link, Columns3, EyeOff, Eye, ChevronRight, Zap, Trash2, Pause, Play, Archive } from "lucide-react";
import type { Task, TaskDetail, Column, ColumnId, TaskCreateInput, MergeResult, GithubIssueAction } from "@fusion/core";
import { COLUMNS, DEFAULT_COLUMN, getErrorMessage, isColumn } from "@fusion/core";
import { useColumnLabel } from "../i18n/labels";
import { sortTasksForDisplayColumn } from "./taskSorting";
import { batchUpdateTaskModels, fetchNodes, fetchTaskDetail } from "../api";
import { TaskDetailContent } from "./TaskDetailModal";
import type { BoardWorkflowColumn, BoardWorkflowsPayload, ModelInfo, NodeInfo } from "../api";
import { QuickEntryBox } from "./QuickEntryBox";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { NodeHealthDot } from "./NodeHealthDot";
import { isTaskStuck } from "../utils/taskStuck";
import type { ToastType } from "../hooks/useToast";
import { useViewportMode } from "../hooks/useViewportMode";
import { getScopedItem, removeScopedItem, setScopedItem } from "../utils/projectStorage";
import { getUnifiedTaskProgress } from "../utils/taskProgress";
import { useConfirm } from "../hooks/useConfirm";
import { extractDependencyDeleteConflict, extractLineageDeleteConflict } from "../utils/taskDelete";
import { WorkflowSwitcher } from "./WorkflowSwitcher";
import { computeWorkflowStatusCounts } from "./workflowStatusCounts";
import { writeBoardWorkflowsCache } from "../utils/boardWorkflowsCache";
import { useBoardWorkflows } from "../hooks/useBoardWorkflows";

const COLUMN_COLOR_MAP: Record<Column, string> = {
  triage: "var(--triage)",
  todo: "var(--todo)",
  "in-progress": "var(--in-progress)",
  "in-review": "var(--in-review)",
  done: "var(--done)",
  archived: "var(--text-dim)",
};

/** #1403: resolve a column color by id; workflow-defined custom columns that
 *  have no legacy color fall back to the neutral accent rather than `undefined`. */
function columnColor(column: ColumnId): string {
  return (COLUMN_COLOR_MAP as Record<string, string>)[column] ?? "var(--accent)";
}

const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "merging-fix"]);

type SortField = "title" | "status" | "column" | "retries";

function getTaskStatusLabel(status: string, t: TFunction<"app">): string {
  if (status === "merging-fix") return t("listView.statusMergingFix", "Merging fixes…");
  return status;
}
type SortDirection = "asc" | "desc";

// Column visibility types
const ALL_LIST_COLUMNS = ["title", "status", "column", "retries", "dependencies", "progress"] as const;
/*
FNXC:ListView 2026-06-17-01:10:
First-run list view users should see only the Title column by default for a cleaner table. Other columns remain opt-in through the Columns view-options dropdown, and any saved kb-dashboard-list-columns preference continues to override this default.
*/
const DEFAULT_LIST_COLUMNS = ["title"] as const;
type ListColumn = typeof ALL_LIST_COLUMNS[number];

function getNodeStatusLabel(status: NodeInfo["status"], t: TFunction<"app">): string {
  if (status === "online") return t("listView.nodeStatusOnline", "Online");
  if (status === "connecting") return t("listView.nodeStatusConnecting", "Connecting");
  if (status === "error") return t("listView.nodeStatusError", "Error");
  return t("listView.nodeStatusOffline", "Offline");
}

function getNodeStatusSymbol(status: NodeInfo["status"]): string {
  if (status === "online") return "●";
  if (status === "connecting") return "◐";
  if (status === "error") return "✕";
  return "○";
}

function readVisibleColumns(projectId?: string): Set<ListColumn> {
  try {
    const saved = getScopedItem("kb-dashboard-list-columns", projectId);
    if (saved) {
      const parsed = JSON.parse(saved) as ListColumn[];
      const validColumns = parsed.filter((col): col is ListColumn =>
        ALL_LIST_COLUMNS.includes(col as ListColumn)
      );
      if (validColumns.length > 0) {
        return new Set(validColumns);
      }
    }
  } catch {
    // Invalid localStorage data - fall through to default
  }

  return new Set(DEFAULT_LIST_COLUMNS);
}

function readHideDoneTasks(projectId?: string): boolean {
  try {
    const saved = getScopedItem("kb-dashboard-hide-done", projectId);
    if (saved !== null) {
      return saved === "true";
    }
  } catch {
    // Invalid localStorage data - fall through to default
  }

  return false;
}

function readStaleOnlyFilter(projectId?: string): boolean {
  try {
    const saved = getScopedItem("kb-dashboard-stale-only-filter", projectId);
    if (saved !== null) {
      return saved === "true";
    }
  } catch {
    // Invalid localStorage data - fall through to default
  }

  return false;
}

function readCollapsedSections(projectId?: string): Set<ColumnId> {
  try {
    const saved = getScopedItem("kb-dashboard-list-collapsed", projectId);
    if (saved) {
      const parsed = JSON.parse(saved) as unknown[];
      const validColumns = parsed.filter((col): col is ColumnId => typeof col === "string");
      if (validColumns.length > 0) {
        return new Set(validColumns);
      }
    }
  } catch {
    // Invalid localStorage data - fall through to default
  }

  return new Set<ColumnId>();
}

function readSelectedTaskIds(projectId?: string): Set<string> {
  try {
    const saved = getScopedItem("kb-dashboard-selected-tasks", projectId);
    if (saved) {
      const parsed = JSON.parse(saved) as string[];
      return new Set(parsed);
    }
  } catch {
    // Invalid localStorage data - fall through to default
  }

  return new Set<string>();
}

function readSelectedTaskId(projectId?: string): string | null {
  try {
    const saved = getScopedItem("kb-dashboard-list-selected-task", projectId);
    if (typeof saved === "string" && saved.trim().length > 0) {
      return saved;
    }
  } catch {
    // Invalid localStorage data - fall through to default
  }

  return null;
}

function readSidebarWidth(projectId?: string): number {
  const fallbackWidth = 400;
  try {
    const saved = getScopedItem("kb-dashboard-list-sidebar-width", projectId);
    if (!saved) return fallbackWidth;
    const parsed = Number(saved);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  } catch {
    // Invalid localStorage data - fall through to default
  }

  return fallbackWidth;
}

const LIST_SIDEBAR_MIN_WIDTH = 64; // FNXC:ListView 2026-06-22-00:00: The desktop task-list split sidebar minimum is 64 (was 120) so users can shrink the left panel much further; task titles wrap to two lines (.list-split-sidebar .list-cell-title) so they stay legible at narrow widths. Resize, keyboard, and ARIA paths share one clamp value.
const LIST_SIDEBAR_MAX_RATIO = 0.65;
const LIST_SIDEBAR_KEYBOARD_STEP = 16;

function getSidebarMaxWidth(containerWidth: number): number {
  return Math.max(LIST_SIDEBAR_MIN_WIDTH, containerWidth * LIST_SIDEBAR_MAX_RATIO);
}

function clampSidebarWidth(width: number, containerWidth: number): number {
  const maxWidth = getSidebarMaxWidth(containerWidth);
  return Math.min(Math.max(width, LIST_SIDEBAR_MIN_WIDTH), maxWidth);
}

interface ListViewProps {
  tasks: Task[];
  onMoveTask: (id: string, column: ColumnId, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onDeleteTask: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
  }) => Promise<Task>;
  onPauseTask?: (id: string) => Promise<Task>;
  onUnpauseTask?: (id: string) => Promise<Task>;
  onArchiveTask?: (id: string, options?: { removeLineageReferences?: boolean }) => Promise<Task>;
  onMergeTask: (id: string) => Promise<MergeResult>;
  onResetTask?: (id: string) => Promise<Task>;
  onDuplicateTask?: (id: string) => Promise<Task>;
  onOpenDetail: (task: Task | TaskDetail, options?: { origin?: "list-mobile" }) => void;
  /*
  FNXC:FloatingWindow 2026-06-22-20:45:
  onPopOut pops the split-pane task detail into a movable, resizable, non-blocking FloatingWindow managed at App level. Wired to the Maximize2 "Pop out" button in TaskDetailContent's header.
  */
  onPopOut?: (task: Task | TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
  globalPaused?: boolean;
  onNewTask?: () => void;
  onQuickCreate?: (input: TaskCreateInput) => Promise<Task | void>;
  availableModels?: ModelInfo[];
  favoriteProviders?: string[];
  favoriteModels?: string[];
  onToggleFavorite?: (provider: string) => void;
  onToggleModelFavorite?: (modelId: string) => void;
  /**
   * Called when the user clicks the "Plan" button in the quick entry box.
   */
  onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
  /**
   * Called when the user clicks the "Subtask" button in the quick entry box.
   */
  onSubtaskBreakdown?: (description: string, workflowId?: string | null) => void;
  /**
   * Called when tasks are updated (e.g., after bulk model update).
   * Allows parent to refresh task list or handle optimistically.
   */
  onTasksUpdated?: (updatedTasks: Task[]) => void;
  /** Project ID for multi-project context (optional) */
  projectId?: string;
  /** Project name for display (optional) */
  projectName?: string;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
  /** External search query from header search (defaults to "") */
  searchQuery?: string;
  /** Timestamp (ms) when task data was last confirmed fresh from the server. Used for freshness-aware stuck detection. */
  lastFetchTimeMs?: number;
  prAuthAvailable?: boolean;
  autoMerge?: boolean;
  onOpenWorkflowEditor?: (workflowId?: string) => void;
  onCreateWorkflow?: () => void;
  workflowColumnsEnabled?: boolean;
  settingsLoaded?: boolean;
  /** Relocates workflow controls into the Header portal slot when sidebar navigation owns the inline chrome. */
  workflowControlsInHeader?: boolean;
}

const LEGACY_LIST_COLUMNS: BoardWorkflowColumn[] = COLUMNS.map((column) => ({
  id: column,
  name: column,
  flags: {
    intake: column === "triage",
    countsTowardWip: column === "in-progress",
    mergeBlocker: column === "in-review",
    complete: column === "done",
    archived: column === "archived",
    hold: column === "todo",
  },
}));

function shouldShowTaskProgress(task: Task): boolean {
  return task.status === "executing" || task.column === "in-progress";
}

function getTaskProgress(task: Task): { label: string; percent: number; hasProgress: boolean } {
  const progress = getUnifiedTaskProgress(task);
  if (progress.total === 0 || !shouldShowTaskProgress(task)) {
    return { label: "-", percent: 0, hasProgress: false };
  }

  return {
    label: `${progress.completed}/${progress.total}`,
    percent: (progress.completed / progress.total) * 100,
    hasProgress: true,
  };
}

export function ListView({
  tasks,
  onMoveTask,
  onRetryTask,
  onDeleteTask,
  onPauseTask,
  onUnpauseTask,
  onArchiveTask,
  onMergeTask,
  onResetTask,
  onDuplicateTask,
  onPopOut,
  onOpenDetail,
  addToast,
  globalPaused,
  onNewTask,
  onQuickCreate,
  availableModels,
  favoriteProviders = [],
  favoriteModels = [],
  onToggleFavorite,
  onToggleModelFavorite,
  onPlanningMode,
  onSubtaskBreakdown,
  onTasksUpdated,
  projectId,
  projectName: _projectName,
  taskStuckTimeoutMs,
  searchQuery = "",
  lastFetchTimeMs,
  prAuthAvailable,
  autoMerge,
  onOpenWorkflowEditor,
  onCreateWorkflow,
  workflowColumnsEnabled,
  settingsLoaded,
  workflowControlsInHeader = false,
}: ListViewProps) {
  const { t } = useTranslation("app");
  const columnLabel = useColumnLabel();
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<ColumnId | null>(null);
  const [selectedColumn, setSelectedColumn] = useState<ColumnId | null>(null);
  /*
  FNXC:BoardWorkflows 2026-06-20-09:07:
  ListView shares the board-workflows first-paint invariant with Board: hydrate per-project workflow metadata from sessionStorage and gate legacy list columns while workflowColumns settings or uncached lane metadata are still unknown.

  FNXC:BoardWorkflowSelection 2026-06-29-12:35:
  ListView must use the same project-scoped durable workflow selection invariant as Board/Header/Graph so task refreshes, respecification route returns, and remounts do not reset operators from a custom workflow back to the default workflow. Keep this separate from list task-selection storage keys.
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
  const [headerWorkflowSlot, setHeaderWorkflowSlot] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    return document.getElementById("header-workflow-slot");
  });
  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";
  const { confirm, confirmWithChoice } = useConfirm();

  useEffect(() => {
    if (!workflowControlsInHeader || typeof document === "undefined") {
      setHeaderWorkflowSlot(null);
      return;
    }
    setHeaderWorkflowSlot(document.getElementById("header-workflow-slot"));
  }, [workflowControlsInHeader, viewportMode]);

  // Column visibility state - initialize from localStorage or reduced default columns
  const [visibleColumns, setVisibleColumns] = useState<Set<ListColumn>>(() => readVisibleColumns(projectId));

  // Hide done tasks state - initialize from localStorage
  const [hideDoneTasks, setHideDoneTasks] = useState<boolean>(() => readHideDoneTasks(projectId));
  const [staleOnlyFilter, setStaleOnlyFilter] = useState<boolean>(() => readStaleOnlyFilter(projectId));
  const [stalePausedReviewOnlyFilter, setStalePausedReviewOnlyFilter] = useState<boolean>(false);

  // Collapsed sections state - initialize from localStorage
  const [collapsedSections, setCollapsedSections] = useState<Set<ColumnId>>(() =>
    readCollapsedSections(projectId),
  );

  // Persist column visibility changes to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      setScopedItem("kb-dashboard-list-columns", JSON.stringify([...visibleColumns]), projectId);
    }
  }, [projectId, visibleColumns]);

  // Persist hide done tasks state to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      setScopedItem("kb-dashboard-hide-done", hideDoneTasks.toString(), projectId);
    }
  }, [hideDoneTasks, projectId]);

  // Persist stale-only filter state to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      setScopedItem("kb-dashboard-stale-only-filter", staleOnlyFilter.toString(), projectId);
    }
  }, [projectId, staleOnlyFilter]);

  // Persist collapsed sections state to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      setScopedItem("kb-dashboard-list-collapsed", JSON.stringify([...collapsedSections]), projectId);
    }
  }, [collapsedSections, projectId]);

  const [viewOptionsOpen, setViewOptionsOpen] = useState(false);

  // Selection state - initialize from localStorage
  const [bulkEditEnabled, setBulkEditEnabled] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => readSelectedTaskIds(projectId));
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => readSelectedTaskId(projectId));
  const [selectedTaskSnapshot, setSelectedTaskSnapshot] = useState<Task | TaskDetail | null>(() => {
    const persistedSelection = readSelectedTaskId(projectId);
    return persistedSelection ? tasks.find((task) => task.id === persistedSelection) ?? null : null;
  });
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readSidebarWidth(projectId));
  const splitLayoutRef = useRef<HTMLDivElement>(null);
  const splitSidebarRef = useRef<HTMLDivElement>(null);
  // FNXC:ListView 2026-06-22-18:00: Holds the active pointer-drag teardown so move/up/cancel/unmount all detach the same listeners — prevents the "window mousemove with no cleanup" leak called out by the frontend-races review.
  const splitResizeTeardownRef = useRef<(() => void) | null>(null);
  const previousStorageProjectIdRef = useRef(projectId);

  useEffect(() => {
    if (previousStorageProjectIdRef.current === projectId) return;
    previousStorageProjectIdRef.current = projectId;
    setVisibleColumns(readVisibleColumns(projectId));
    setHideDoneTasks(readHideDoneTasks(projectId));
    setStaleOnlyFilter(readStaleOnlyFilter(projectId));
    setStalePausedReviewOnlyFilter(false);
    setCollapsedSections(readCollapsedSections(projectId));
    setSelectedTaskIds(readSelectedTaskIds(projectId));
    const persistedSelection = readSelectedTaskId(projectId);
    setSelectedTaskId(persistedSelection);
    setSelectedTaskSnapshot(
      persistedSelection ? tasks.find((task) => task.id === persistedSelection) ?? null : null,
    );
    setSidebarWidth(readSidebarWidth(projectId));
  }, [projectId, tasks]);

  // Persist selection to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      setScopedItem("kb-dashboard-selected-tasks", JSON.stringify([...selectedTaskIds]), projectId);
    }
  }, [projectId, selectedTaskIds]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (selectedTaskId) {
      setScopedItem("kb-dashboard-list-selected-task", selectedTaskId, projectId);
      return;
    }

    removeScopedItem("kb-dashboard-list-selected-task", projectId);
  }, [projectId, selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId) {
      setSelectedTaskSnapshot(null);
      return;
    }

    const liveTask = tasks.find((task) => task.id === selectedTaskId);
    if (!liveTask) return;

    setSelectedTaskSnapshot((previous) => {
      if (!previous || previous.id !== selectedTaskId) {
        return liveTask;
      }
      if (previous === liveTask) return previous;
      return { ...previous, ...liveTask };
    });
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    if (isMobile || typeof ResizeObserver === "undefined") return;
    const container = splitLayoutRef.current;
    if (!container) return;

    const applyClamp = () => {
      /*
      FNXC:ListView 2026-06-22-18:00:
      A zero/unmeasurable container width must NOT clamp the persisted sidebar width down to the 64px
      min — that collapse made the resize handle appear broken (drag snapped the pane to the minimum
      and refused to widen). Only re-clamp when the container reports a real width.
      */
      const containerWidth = container.clientWidth;
      if (containerWidth <= 0) return;
      // Keep width valid when viewport/container size changes.
      const clamped = clampSidebarWidth(sidebarWidth, containerWidth);
      if (clamped !== sidebarWidth) {
        setSidebarWidth(clamped);
      }
    };

    applyClamp();
    const observer = new ResizeObserver(applyClamp);
    observer.observe(container);
    return () => observer.disconnect();
  }, [isMobile, sidebarWidth]);

  useEffect(() => {
    if (isMobile || typeof ResizeObserver === "undefined") return;
    const sidebar = splitSidebarRef.current;
    const container = splitLayoutRef.current;
    if (!sidebar || !container) return;

    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSavedWidth = sidebar.offsetWidth;

    const observer = new ResizeObserver(() => {
      const nextWidth = clampSidebarWidth(sidebar.offsetWidth, container.clientWidth);
      if (nextWidth === lastSavedWidth) return;
      lastSavedWidth = nextWidth;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try {
          setScopedItem("kb-dashboard-list-sidebar-width", String(nextWidth), projectId);
        } catch {
          // localStorage persistence is best-effort.
        }
      }, 200);
    });

    observer.observe(sidebar);
    return () => {
      observer.disconnect();
      if (saveTimer) clearTimeout(saveTimer);
    };
  }, [isMobile, projectId]);

  const toggleBulkEdit = useCallback(() => {
    setBulkEditEnabled((prev) => {
      if (prev) {
        setSelectedTaskIds(new Set());
      }
      return !prev;
    });
  }, []);

  // Toggle task selection
  const toggleTaskSelection = useCallback((taskId: string) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }, []);

  // Clear selection
  const clearSelection = useCallback(() => {
    setSelectedTaskIds(new Set());
  }, []);

  // Toggle a column's visibility
  const toggleColumn = useCallback((column: ListColumn) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(column)) {
        // Prevent hiding the last visible column
        if (next.size > 1) {
          next.delete(column);
        }
      } else {
        next.add(column);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setSelectedColumn(null);
  }, [selectedWorkflowId]);

  const listColumns = useMemo<BoardWorkflowColumn[]>(() => {
    if (!workflowMode || !selectedWorkflow) return LEGACY_LIST_COLUMNS;
    return selectedWorkflow.columns.filter((column) => !column.flags.hiddenFromBoard);
  }, [selectedWorkflow, workflowMode]);

  const columnNameById = useMemo(() => {
    const map = new Map<ColumnId, string>();
    for (const column of listColumns) {
      map.set(column.id, workflowMode ? column.name : columnLabel(column.id));
    }
    return map;
  }, [columnLabel, listColumns, workflowMode]);

  const columnFlagsById = useMemo(() => {
    const map = new Map<ColumnId, BoardWorkflowColumn["flags"]>();
    for (const column of listColumns) {
      map.set(column.id, column.flags);
    }
    return map;
  }, [listColumns]);

  const getListColumnLabel = useCallback((column: ColumnId): string => {
    return columnNameById.get(column) ?? columnLabel(column);
  }, [columnLabel, columnNameById]);

  const isArchivedColumn = useCallback((column: ColumnId): boolean => {
    return workflowMode ? Boolean(columnFlagsById.get(column)?.archived) : column === "archived";
  }, [columnFlagsById, workflowMode]);

  const isCompleteColumn = useCallback((column: ColumnId): boolean => {
    return workflowMode ? Boolean(columnFlagsById.get(column)?.complete) : column === "done";
  }, [columnFlagsById, workflowMode]);

  const selectedWorkflowTaskIds = useMemo(() => {
    if (!workflowMode || !boardWorkflows || !selectedWorkflow) return null;
    const ids = new Set<string>();
    for (const task of tasks) {
      const workflowId = boardWorkflows.taskWorkflowIds[task.id] ?? boardWorkflows.defaultWorkflowId;
      if (workflowId === selectedWorkflow.id) ids.add(task.id);
    }
    return ids;
  }, [boardWorkflows, selectedWorkflow, tasks, workflowMode]);

  const workflowStatusCounts = useMemo(
    () => computeWorkflowStatusCounts(tasks, boardWorkflows),
    [boardWorkflows, tasks],
  );

  const createTargetColumn = useMemo(() => {
    const target = listColumns.find((column) => column.flags.intake && !column.flags.archived)
      ?? listColumns.find((column) => !column.flags.archived);
    return target?.id;
  }, [listColumns]);

  /**
   * FNXC:WorkflowList 2026-06-21-21:37:
   * List quick-create shares Board's workflow filtering invariant: when taskWorkflowIds lags task creation, optimistically recording the selected workflow keeps the newly-created row visible in the active workflow lane until the authoritative refetch reconciles it (FN-6903).
   */
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

  const handleListQuickCreate = useCallback(async (input: TaskCreateInput) => {
    const create = onQuickCreate ?? (async () => addToast(t("listView.taskCreationUnavailable", "Task creation not available"), "error"));
    if (workflowMode && selectedWorkflow && createTargetColumn) {
      const workflowId = input.workflowId ?? selectedWorkflow.id;
      const created = await create({
        ...input,
        column: input.column ?? createTargetColumn,
        workflowId,
      });
      if (created?.id) {
        const createdWorkflowId = (created as Task & { workflowId?: string }).workflowId ?? workflowId;
        applyOptimisticTaskWorkflow(created.id, createdWorkflowId);
        refreshBoardWorkflows();
      }
      return created;
    }
    return create(input);
  }, [addToast, applyOptimisticTaskWorkflow, createTargetColumn, onQuickCreate, refreshBoardWorkflows, selectedWorkflow, t, workflowMode]);

  /*
  FNXC:ListWorkflowSelection 2026-06-29-00:00:
  List quick-add Plan/Subtask handoffs must inherit the same active workflow as direct quick-create. Passing null only while workflow mode has no selected workflow preserves stale-id fallback behavior without reverting to the project default lane.
  */
  const listQuickEntryWorkflowId = workflowMode ? selectedWorkflow?.id ?? null : undefined;

  // Column display labels
  const COLUMN_LABELS_MAP: Record<ListColumn, string> = {
    title: t("listView.colTitle", "Title"),
    status: t("listView.colStatus", "Status"),
    column: t("listView.colColumn", "Column"),
    dependencies: t("listView.colDependencies", "Dependencies"),
    progress: t("listView.colProgress", "Progress"),
    retries: t("listView.colRetries", "Retries"),
  };

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }

    setSortField(field);
    setSortDirection("asc");
  }, [sortField]);

  const handleColumnFilter = useCallback((column: ColumnId) => {
    setSelectedColumn((prev) => (prev === column ? null : column));
  }, []);

  const toggleSection = useCallback((column: ColumnId) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(column)) {
        next.delete(column);
      } else {
        next.add(column);
      }
      return next;
    });
  }, []);

  const clearColumnFilter = useCallback(() => {
    setSelectedColumn(null);
  }, []);

  const groupedTasks = useMemo(() => {
    // First apply text filter
    let filtered = searchQuery
      ? tasks.filter(
          (t) =>
            t.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (t.title && t.title.toLowerCase().includes(searchQuery.toLowerCase())) ||
            t.description.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : [...tasks];

    if (selectedWorkflowTaskIds) {
      filtered = filtered.filter((task) => selectedWorkflowTaskIds.has(task.id));
    }

    const hiddenCompletedColumns = new Set(
      listColumns
        .filter((column) => column.flags.complete || column.flags.archived)
        .map((column) => column.id),
    );

    // Then filter out done and archived tasks if hideDoneTasks is enabled
    // BUT only when no specific column is selected (strict hide semantics)
    if (hideDoneTasks && !selectedColumn) {
      filtered = filtered.filter((t) => !hiddenCompletedColumns.has(t.column));
    }

    // Then apply stale-only filter if selected
    if (staleOnlyFilter) {
      filtered = filtered.filter((t) => t.ageStaleness != null);
    }
    if (stalePausedReviewOnlyFilter) {
      filtered = filtered.filter((t) => t.stalePausedReview != null);
    }

    // Then apply column filter if selected
    const columnFiltered = selectedColumn
      ? filtered.filter((t) => t.column === selectedColumn)
      : filtered;

    const groups: Record<string, Task[]> = {};
    for (const column of listColumns) groups[column.id] = [];

    columnFiltered.forEach((task) => {
      const column = workflowMode ? task.column : (isColumn(task.column) ? task.column : DEFAULT_COLUMN);
      if (groups[column]) groups[column].push(task);
    });

    for (const column of listColumns) {
      const columnId = column.id;
      if (!sortField) {
        groups[columnId] = sortTasksForDisplayColumn(groups[columnId], columnId as Column);
        continue;
      }

      groups[columnId] = [...groups[columnId]].sort((a, b) => {
        let comparison = 0;
        switch (sortField) {
          case "title":
            comparison = (a.title || a.description).localeCompare(b.title || b.description);
            break;
          case "status":
            comparison = (a.status || "").localeCompare(b.status || "");
            break;
          case "column":
            comparison = a.column.localeCompare(b.column);
            break;
          case "retries":
            comparison = (a.retrySummary?.total ?? 0) - (b.retrySummary?.total ?? 0);
            break;
        }
        return sortDirection === "asc" ? comparison : -comparison;
      });
    }
    return groups;
  }, [tasks, searchQuery, selectedWorkflowTaskIds, listColumns, workflowMode, hideDoneTasks, selectedColumn, staleOnlyFilter, stalePausedReviewOnlyFilter, sortField, sortDirection]);

  // Calculate total filtered count from groups
  const filteredCount = useMemo(() => {
    return Object.values(groupedTasks).reduce((sum, group) => sum + group.length, 0);
  }, [groupedTasks]);

  // Selection logic that depends on groupedTasks (must be after groupedTasks definition)
  // Toggle all visible tasks
  const toggleSelectAll = useCallback(() => {
    const visibleTaskIds = Object.values(groupedTasks)
      .flat()
      .filter((t) => !isArchivedColumn(t.column)) // Can't bulk edit archived
      .map((t) => t.id);

    setSelectedTaskIds((prev) => {
      const allSelected = visibleTaskIds.every((id) => prev.has(id));
      if (allSelected) {
        // Deselect all visible
        const next = new Set(prev);
        visibleTaskIds.forEach((id) => next.delete(id));
        return next;
      } else {
        // Select all visible
        return new Set([...prev, ...visibleTaskIds]);
      }
    });
  }, [groupedTasks, isArchivedColumn]);

  // Check if all visible tasks are selected
  const isSelectAll = useMemo(() => {
    const visibleTaskIds = Object.values(groupedTasks)
      .flat()
      .filter((t) => !isArchivedColumn(t.column));
    if (visibleTaskIds.length === 0) return false;
    return visibleTaskIds.every((t) => selectedTaskIds.has(t.id));
  }, [groupedTasks, isArchivedColumn, selectedTaskIds]);

  // Check if some (but not all) visible tasks are selected
  const isSelectIndeterminate = useMemo(() => {
    const visibleTaskIds = Object.values(groupedTasks)
      .flat()
      .filter((t) => !isArchivedColumn(t.column));
    if (visibleTaskIds.length === 0) return false;
    const selectedCount = visibleTaskIds.filter((t) => selectedTaskIds.has(t.id)).length;
    return selectedCount > 0 && selectedCount < visibleTaskIds.length;
  }, [groupedTasks, isArchivedColumn, selectedTaskIds]);

  // Bulk edit state and handlers (must be after groupedTasks and clearSelection definition)
  const [executorModel, setExecutorModel] = useState<string>("__no_change__");
  const [validatorModel, setValidatorModel] = useState<string>("__no_change__");
  const [nodeOverride, setNodeOverride] = useState<string>("__no_change__");
  const [availableNodes, setAvailableNodes] = useState<NodeInfo[]>([]);
  const [isLoadingNodes, setIsLoadingNodes] = useState(false);
  const selectedOverrideNode = useMemo(
    () => (nodeOverride && nodeOverride !== "__no_change__" ? availableNodes.find((node) => node.id === nodeOverride) : undefined),
    [availableNodes, nodeOverride],
  );
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    if (selectedTaskIds.size === 0) return;
    let isCancelled = false;

    const loadNodes = async () => {
      setIsLoadingNodes(true);
      try {
        const nodes = await fetchNodes();
        if (!isCancelled) {
          setAvailableNodes(nodes);
        }
      } catch (err) {
        console.error("Failed to fetch nodes for bulk edit", err);
        if (!isCancelled) {
          setAvailableNodes([]);
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingNodes(false);
        }
      }
    };

    void loadNodes();

    return () => {
      isCancelled = true;
    };
  }, [selectedTaskIds.size]);

  // Handle apply bulk model update
  const handleBulkDelete = useCallback(async () => {
    if (selectedTaskIds.size === 0) return;

    const selectedTasks = Array.from(selectedTaskIds)
      .map((id) => tasks.find((task) => task.id === id))
      .filter((task): task is Task => Boolean(task));
    const archivedTasks = selectedTasks.filter((task) => isArchivedColumn(task.column));
    const deletableTasks = selectedTasks.filter((task) => !isArchivedColumn(task.column));

    if (deletableTasks.length === 0) {
      addToast(t("listView.bulkDeleteNoTasks", "No selected tasks can be deleted (archived tasks are excluded)"), "error");
      return;
    }

    const doneTasks = deletableTasks.filter((task) => isCompleteColumn(task.column));
    const otherTasks = deletableTasks.filter((task) => !isCompleteColumn(task.column));

    let shouldDeleteAll = false;
    let shouldArchiveDoneInstead = false;

    if (doneTasks.length > 0 && onArchiveTask) {
      const choice = await confirmWithChoice({
        title: t("listView.bulkDeleteTitle", "Delete Selected Tasks"),
        message: t("listView.bulkDeleteWithDoneMessage", "Delete {{deletable}} task(s), or archive the {{done}} done task(s) and delete the rest?", { deletable: deletableTasks.length, done: doneTasks.length }),
        confirmLabel: t("listView.bulkDeleteAll", "Delete All"),
        cancelLabel: t("common.cancel", "Cancel"),
        tertiaryLabel: t("listView.bulkArchiveDone", "Archive {{count}} Done", { count: doneTasks.length }),
        danger: true,
      });
      if (choice === "cancel") return;
      shouldDeleteAll = choice === "primary";
      shouldArchiveDoneInstead = choice === "tertiary";
    } else {
      const confirmed = await confirm({
        title: t("listView.bulkDeleteTitle", "Delete Selected Tasks"),
        message: t("listView.bulkDeleteMessage", "Delete {{count}} selected task(s)?", { count: deletableTasks.length }),
        confirmLabel: t("common.delete", "Delete"),
        cancelLabel: t("common.cancel", "Cancel"),
        danger: true,
      });

      if (!confirmed) return;
      shouldDeleteAll = true;
    }

    setIsApplying(true);
    const deletedIds: string[] = [];
    const archivedIds: string[] = [];
    const failedIds: string[] = [];
    const skippedIds = archivedTasks.map((task) => task.id);

    try {
      const tasksToDelete = shouldDeleteAll ? deletableTasks : otherTasks;

      if (shouldArchiveDoneInstead && onArchiveTask) {
        for (const task of doneTasks) {
          try {
            await onArchiveTask(task.id);
            archivedIds.push(task.id);
          } catch (err) {
            const lineageConflict = extractLineageDeleteConflict(err);
            if (!lineageConflict || lineageConflict.lineageChildIds.length === 0) {
              failedIds.push(task.id);
              continue;
            }

            const confirmedArchive = await confirm({
              title: t("listView.forceDeleteTitle", "Force Delete Task"),
              message:
                t("listView.lineageArchiveMessage", "{{taskId}} has lineage children ({{children}}) that reference it as a source parent.\n\nArchive anyway by unlinking these references first?", { taskId: task.id, children: lineageConflict.lineageChildIds.join(", ") }),
              confirmLabel: t("common.archive", "Archive"),
              cancelLabel: t("common.skip", "Skip"),
              danger: true,
            });

            if (!confirmedArchive) {
              failedIds.push(task.id);
              continue;
            }

            try {
              await onArchiveTask(task.id, { removeLineageReferences: true });
              archivedIds.push(task.id);
            } catch {
              failedIds.push(task.id);
            }
          }
        }
      }

      for (const task of tasksToDelete) {
        try {
          await onDeleteTask(task.id);
          deletedIds.push(task.id);
        } catch (err) {
          const dependencyConflict = extractDependencyDeleteConflict(err);
          if (dependencyConflict) {
            const forceDelete = await confirm({
              title: t("listView.forceDeleteTitle", "Force Delete Task"),
              message: t("listView.dependentsDeleteMessage", "Task {{taskId}} has dependents: {{dependents}}. Remove dependency references and force delete?", { taskId: task.id, dependents: dependencyConflict.dependentIds.join(", ") }),
              confirmLabel: t("listView.forceDelete", "Force Delete"),
              cancelLabel: t("common.skip", "Skip"),
              danger: true,
            });

            if (!forceDelete) {
              failedIds.push(task.id);
              continue;
            }

            try {
              await onDeleteTask(task.id, {
                removeDependencyReferences: true,
                removeLineageReferences: true,
              });
              deletedIds.push(task.id);
            } catch (retryErr) {
              const lineageConflict = extractLineageDeleteConflict(retryErr);
              if (!lineageConflict || lineageConflict.lineageChildIds.length === 0) {
                failedIds.push(task.id);
                continue;
              }

              const forceLineageDelete = await confirm({
                title: t("listView.forceDeleteTitle", "Force Delete Task"),
                message:
                  t("listView.lineageDeleteMessage", "{{taskId}} has lineage children ({{children}}) that reference it as a source parent.\n\nDelete anyway by unlinking these references first?", { taskId: task.id, children: lineageConflict.lineageChildIds.join(", ") }),
                confirmLabel: t("listView.forceDelete", "Force Delete"),
                cancelLabel: t("common.skip", "Skip"),
                danger: true,
              });

              if (!forceLineageDelete) {
                failedIds.push(task.id);
                continue;
              }

              try {
                await onDeleteTask(task.id, {
                  removeDependencyReferences: true,
                  removeLineageReferences: true,
                });
                deletedIds.push(task.id);
              } catch {
                failedIds.push(task.id);
              }
            }
            continue;
          }

          const lineageConflict = extractLineageDeleteConflict(err);
          if (!lineageConflict || lineageConflict.lineageChildIds.length === 0) {
            failedIds.push(task.id);
            continue;
          }

          const forceDelete = await confirm({
            title: t("listView.forceDeleteTitle", "Force Delete Task"),
            message:
              t("listView.lineageDeleteMessage", "{{taskId}} has lineage children ({{children}}) that reference it as a source parent.\n\nDelete anyway by unlinking these references first?", { taskId: task.id, children: lineageConflict.lineageChildIds.join(", ") }),
            confirmLabel: t("listView.forceDelete", "Force Delete"),
            cancelLabel: t("common.skip", "Skip"),
            danger: true,
          });

          if (!forceDelete) {
            failedIds.push(task.id);
            continue;
          }

          try {
            await onDeleteTask(task.id, {
              removeDependencyReferences: true,
              removeLineageReferences: true,
            });
            deletedIds.push(task.id);
          } catch {
            failedIds.push(task.id);
          }
        }
      }
    } finally {
      setIsApplying(false);
    }

    if (deletedIds.length > 0 || archivedIds.length > 0) {
      setSelectedTaskIds((previous) => {
        const next = new Set(previous);
        for (const id of deletedIds) {
          next.delete(id);
        }
        for (const id of archivedIds) {
          next.delete(id);
        }
        return next;
      });
    }

    const summaryMessage = shouldArchiveDoneInstead
      ? t("listView.bulkDeleteArchiveSummary", "Archived {{archived}}, deleted {{deleted}}, failed {{failed}}", { archived: archivedIds.length, deleted: deletedIds.length, failed: failedIds.length })
      : t("listView.bulkDeleteSummary", { count: deletedIds.length, skipped: skippedIds.length, failed: failedIds.length, defaultValue_one: "Deleted {{count}} task · {{skipped}} archived skipped · {{failed}} failed", defaultValue_other: "Deleted {{count}} tasks · {{skipped}} archived skipped · {{failed}} failed" });

    addToast(summaryMessage, failedIds.length > 0 ? "error" : "success");
  }, [addToast, confirm, confirmWithChoice, isArchivedColumn, isCompleteColumn, onArchiveTask, onDeleteTask, selectedTaskIds, tasks]);

  const handleBulkPause = useCallback(async () => {
    if (selectedTaskIds.size === 0) return;
    if (!onPauseTask) {
      addToast(t("listView.pauseUnavailable", "Pause action is unavailable"), "error");
      return;
    }

    const selectedTasks = Array.from(selectedTaskIds)
      .map((id) => tasks.find((task) => task.id === id))
      .filter((task): task is Task => Boolean(task));
    const actionableTasks = selectedTasks.filter((task) => !isArchivedColumn(task.column) && task.paused !== true);
    const skippedCount = selectedTasks.length - actionableTasks.length;

    if (actionableTasks.length === 0) {
      addToast(t("listView.bulkPauseNoTasks", "No selected tasks can be paused"), "error");
      return;
    }

    setIsApplying(true);
    const pausedIds: string[] = [];
    const failedIds: string[] = [];

    try {
      for (const task of actionableTasks) {
        try {
          await onPauseTask(task.id);
          pausedIds.push(task.id);
        } catch {
          failedIds.push(task.id);
        }
      }
    } finally {
      setIsApplying(false);
    }

    if (pausedIds.length > 0) {
      setSelectedTaskIds((previous) => {
        const next = new Set(previous);
        for (const id of pausedIds) {
          next.delete(id);
        }
        return next;
      });
    }

    addToast(
      t("listView.bulkPauseSummary", "Paused {{paused}} · {{skipped}} skipped · {{failed}} failed", { paused: pausedIds.length, skipped: skippedCount, failed: failedIds.length }),
      failedIds.length > 0 ? "error" : "success",
    );
  }, [addToast, isArchivedColumn, onPauseTask, selectedTaskIds, tasks]);

  const handleBulkUnpause = useCallback(async () => {
    if (selectedTaskIds.size === 0) return;
    if (!onUnpauseTask) {
      addToast(t("listView.unpauseUnavailable", "Unpause action is unavailable"), "error");
      return;
    }

    const selectedTasks = Array.from(selectedTaskIds)
      .map((id) => tasks.find((task) => task.id === id))
      .filter((task): task is Task => Boolean(task));
    const actionableTasks = selectedTasks.filter((task) => !isArchivedColumn(task.column) && task.paused === true);
    const skippedCount = selectedTasks.length - actionableTasks.length;

    if (actionableTasks.length === 0) {
      addToast(t("listView.bulkUnpauseNoTasks", "No selected tasks can be unpaused"), "error");
      return;
    }

    setIsApplying(true);
    const unpausedIds: string[] = [];
    const failedIds: string[] = [];

    try {
      for (const task of actionableTasks) {
        try {
          await onUnpauseTask(task.id);
          unpausedIds.push(task.id);
        } catch {
          failedIds.push(task.id);
        }
      }
    } finally {
      setIsApplying(false);
    }

    if (unpausedIds.length > 0) {
      setSelectedTaskIds((previous) => {
        const next = new Set(previous);
        for (const id of unpausedIds) {
          next.delete(id);
        }
        return next;
      });
    }

    addToast(
      t("listView.bulkUnpauseSummary", "Unpaused {{unpaused}} · {{skipped}} skipped · {{failed}} failed", { unpaused: unpausedIds.length, skipped: skippedCount, failed: failedIds.length }),
      failedIds.length > 0 ? "error" : "success",
    );
  }, [addToast, isArchivedColumn, onUnpauseTask, selectedTaskIds, tasks]);

  const handleBulkArchive = useCallback(async () => {
    if (selectedTaskIds.size === 0) return;
    if (!onArchiveTask) {
      addToast(t("listView.archiveUnavailable", "Archive action is unavailable"), "error");
      return;
    }

    const selectedTasks = Array.from(selectedTaskIds)
      .map((id) => tasks.find((task) => task.id === id))
      .filter((task): task is Task => Boolean(task));
    const actionableTasks = selectedTasks.filter((task) => isCompleteColumn(task.column));
    const skippedCount = selectedTasks.length - actionableTasks.length;

    if (actionableTasks.length === 0) {
      addToast(t("listView.bulkArchiveNoTasks", "No selected tasks can be archived (only done tasks)"), "error");
      return;
    }

    const confirmed = await confirm({
      title: t("listView.bulkArchiveTitle", "Archive Selected Tasks"),
      message: t("listView.bulkArchiveMessage", "Archive {{count}} selected task(s)?", { count: actionableTasks.length }),
      confirmLabel: t("common.archive", "Archive"),
      cancelLabel: t("common.cancel", "Cancel"),
      danger: false,
    });

    if (!confirmed) return;

    setIsApplying(true);
    const archivedIds: string[] = [];
    const failedIds: string[] = [];

    try {
      for (const task of actionableTasks) {
        try {
          await onArchiveTask(task.id);
          archivedIds.push(task.id);
        } catch (err) {
          const lineageConflict = extractLineageDeleteConflict(err);
          if (!lineageConflict || lineageConflict.lineageChildIds.length === 0) {
            failedIds.push(task.id);
            continue;
          }

          const confirmedArchive = await confirm({
            title: t("listView.forceDeleteTitle", "Force Delete Task"),
            message:
              t("listView.lineageArchiveMessage", "{{taskId}} has lineage children ({{children}}) that reference it as a source parent.\n\nArchive anyway by unlinking these references first?", { taskId: task.id, children: lineageConflict.lineageChildIds.join(", ") }),
            confirmLabel: t("common.archive", "Archive"),
            cancelLabel: t("common.skip", "Skip"),
            danger: true,
          });

          if (!confirmedArchive) {
            failedIds.push(task.id);
            continue;
          }

          try {
            await onArchiveTask(task.id, { removeLineageReferences: true });
            archivedIds.push(task.id);
          } catch {
            failedIds.push(task.id);
          }
        }
      }
    } finally {
      setIsApplying(false);
    }

    if (archivedIds.length > 0) {
      setSelectedTaskIds((previous) => {
        const next = new Set(previous);
        for (const id of archivedIds) {
          next.delete(id);
        }
        return next;
      });
    }

    addToast(
      t("listView.bulkArchiveSummary", "Archived {{archived}} · {{skipped}} skipped · {{failed}} failed", { archived: archivedIds.length, skipped: skippedCount, failed: failedIds.length }),
      failedIds.length > 0 ? "error" : "success",
    );
  }, [addToast, confirm, isCompleteColumn, onArchiveTask, selectedTaskIds, tasks]);

  const handleApplyBulkUpdate = useCallback(async () => {
    if (selectedTaskIds.size === 0) return;

    const taskIds = Array.from(selectedTaskIds).filter((id) => {
      const task = tasks.find((t) => t.id === id);
      return task && !isArchivedColumn(task.column);
    });

    if (taskIds.length === 0) {
      addToast(t("listView.bulkUpdateNoTasks", "No valid tasks to update (archived tasks cannot be modified)"), "error");
      return;
    }

    // Build payload - only include fields that changed from "__no_change__"
    const payload: {
      taskIds: string[];
      modelProvider?: string | null;
      modelId?: string | null;
      validatorModelProvider?: string | null;
      validatorModelId?: string | null;
      nodeId?: string | null;
    } = { taskIds };

    if (executorModel !== "__no_change__") {
      if (executorModel === "") {
        // "Use default" - clear override
        payload.modelProvider = null;
        payload.modelId = null;
      } else {
        const slashIdx = executorModel.indexOf("/");
        if (slashIdx !== -1) {
          payload.modelProvider = executorModel.slice(0, slashIdx);
          payload.modelId = executorModel.slice(slashIdx + 1);
        }
      }
    }

    if (validatorModel !== "__no_change__") {
      if (validatorModel === "") {
        // "Use default" - clear override
        payload.validatorModelProvider = null;
        payload.validatorModelId = null;
      } else {
        const slashIdx = validatorModel.indexOf("/");
        if (slashIdx !== -1) {
          payload.validatorModelProvider = validatorModel.slice(0, slashIdx);
          payload.validatorModelId = validatorModel.slice(slashIdx + 1);
        }
      }
    }

    if (nodeOverride !== "__no_change__") {
      if (nodeOverride === "") {
        payload.nodeId = null;
      } else {
        payload.nodeId = nodeOverride;
      }
    }

    // Check if any changes were made
    if (Object.keys(payload).length === 1) {
      addToast(t("listView.bulkNoChanges", "No changes to apply"), "info");
      return;
    }

    setIsApplying(true);
    try {
      const result = await batchUpdateTaskModels(
        payload.taskIds,
        payload.modelProvider,
        payload.modelId,
        payload.validatorModelProvider,
        payload.validatorModelId,
        undefined,
        undefined,
        payload.nodeId,
        projectId,
      );

      if (onTasksUpdated) {
        onTasksUpdated(result.updated);
      }

      addToast(t("listView.bulkUpdateSuccess", "Updated {{count}} task(s)", { count: taskIds.length }), "success");

      // Reset state
      clearSelection();
      setExecutorModel("__no_change__");
      setValidatorModel("__no_change__");
      setNodeOverride("__no_change__");
    } catch (err) {
      addToast(getErrorMessage(err) || t("listView.bulkUpdateFailed", "Failed to update models"), "error");
    } finally {
      setIsApplying(false);
    }
  }, [selectedTaskIds, tasks, executorModel, validatorModel, nodeOverride, projectId, addToast, clearSelection, isArchivedColumn, onTasksUpdated]);

  const handleRowClick = useCallback(
    (task: Task) => {
      if (isMobile) {
        onOpenDetail(task, { origin: "list-mobile" });
        return;
      }

      setSelectedTaskId(task.id);
      setSelectedTaskSnapshot(task);
    },
    [isMobile, onOpenDetail]
  );

  // Debounce detail fetches so rapid keyboard/mouse navigation through a
  // long task list doesn't issue a heavy /tasks/:id request (with log +
  // comments) per row. Only the task the user lands on triggers a fetch.
  const detailFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailFetchTargetRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (detailFetchTimerRef.current) {
        clearTimeout(detailFetchTimerRef.current);
      }
    };
  }, []);

  const handleEmbeddedOpenDetail = useCallback((nextTask: Task | TaskDetail) => {
    setSelectedTaskId(nextTask.id);
    setSelectedTaskSnapshot(nextTask);

    if ("prompt" in nextTask) {
      detailFetchTargetRef.current = null;
      if (detailFetchTimerRef.current) {
        clearTimeout(detailFetchTimerRef.current);
        detailFetchTimerRef.current = null;
      }
      return;
    }

    detailFetchTargetRef.current = nextTask.id;
    if (detailFetchTimerRef.current) {
      clearTimeout(detailFetchTimerRef.current);
    }
    detailFetchTimerRef.current = setTimeout(() => {
      detailFetchTimerRef.current = null;
      const targetId = detailFetchTargetRef.current;
      if (targetId !== nextTask.id) {
        return;
      }
      fetchTaskDetail(nextTask.id, projectId)
        .then((detail) => {
          if (detailFetchTargetRef.current !== detail.id) {
            return;
          }
          setSelectedTaskSnapshot((previous) => {
            if (!previous || previous.id !== detail.id) {
              return previous;
            }
            return { ...previous, ...detail };
          });
        })
        .catch(() => {
          // Keep optimistic inline selection when detail fetch fails.
        });
    }, 200);
  }, [projectId]);

  const handleDragStart = useCallback(
    (e: React.DragEvent, task: Task) => {
      if (task.paused) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData("text/plain", task.id);
      e.dataTransfer.effectAllowed = "move";
      setDraggingTaskId(task.id);
    },
    []
  );

  const handleDragEnd = useCallback(() => {
    setDraggingTaskId(null);
    setDragOverColumn(null);
  }, []);

  /*
  FNXC:ListView 2026-06-22-18:00:
  Pointer-based split resize. setPointerCapture keeps move/up events flowing to the handle even when
  the cursor leaves it, and a single teardown ref (cleared on pointerup/pointercancel/unmount) detaches
  every listener exactly once. Width is measured from a live rect per move (re-reading rect.left/width
  each frame) and clamped between LIST_SIDEBAR_MIN_WIDTH (64) and 65% of the container so the inline
  style={{ width }} — which wins over the grid `auto` track — updates live and persists.
  */
  const handleSplitResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    const container = splitLayoutRef.current;
    if (!container) return;
    event.preventDefault();

    // Detach any prior drag (defensive against a missed pointerup).
    splitResizeTeardownRef.current?.();

    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // setPointerCapture is best-effort (e.g. synthetic events in tests).
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      // Guard against an unmeasurable container so a drag never collapses the pane to the min.
      const containerWidth = rect.width > 0 ? rect.width : container.clientWidth;
      if (containerWidth <= 0) return;
      const proposedWidth = moveEvent.clientX - rect.left;
      setSidebarWidth(clampSidebarWidth(proposedWidth, containerWidth));
    };

    const teardown = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", teardown);
      window.removeEventListener("pointercancel", teardown);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Capture may already be released.
      }
      splitResizeTeardownRef.current = null;
    };

    splitResizeTeardownRef.current = teardown;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", teardown);
    window.addEventListener("pointercancel", teardown);
  }, [isMobile]);

  // FNXC:ListView 2026-06-22-18:00: Tear down any in-flight resize drag on unmount so window pointer listeners never leak.
  useEffect(() => () => splitResizeTeardownRef.current?.(), []);

  const handleSplitResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isMobile) return;
    const measuredWidth = splitLayoutRef.current?.clientWidth ?? 0;
    const fallbackWidth = sidebarWidth / LIST_SIDEBAR_MAX_RATIO + LIST_SIDEBAR_KEYBOARD_STEP;
    const containerWidth = Math.max(measuredWidth, fallbackWidth);

    const maxWidth = getSidebarMaxWidth(containerWidth);

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -LIST_SIDEBAR_KEYBOARD_STEP : LIST_SIDEBAR_KEYBOARD_STEP;
      setSidebarWidth((current) => clampSidebarWidth(current + delta, containerWidth));
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(LIST_SIDEBAR_MIN_WIDTH);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(maxWidth);
    }
  }, [isMobile, sidebarWidth]);

  const handleColumnDragOver = useCallback(
    (e: React.DragEvent, column: ColumnId) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverColumn(column);
    },
    []
  );

  const handleColumnDragLeave = useCallback(() => {
    setDragOverColumn(null);
  }, []);

  const handleColumnDrop = useCallback(
    async (e: React.DragEvent, column: ColumnId) => {
      e.preventDefault();
      setDragOverColumn(null);
      const taskId = e.dataTransfer.getData("text/plain");
      if (!taskId) return;

      // Prevent dropping into archived column
      if (isArchivedColumn(column)) {
        addToast(t("listView.archiveViaButton", "Tasks can only be archived via the archive button"), "error");
        return;
      }

      try {
        const task = tasks.find((candidate) => candidate.id === taskId);
        const hasStepProgress = task?.steps.some((step) => step.status !== "pending") ?? false;
        const targetFlags = columnFlagsById.get(column);
        const shouldPrompt = hasStepProgress && (
          column === "todo" || column === "triage" || Boolean(targetFlags?.intake || targetFlags?.hold)
        );

        let moveOptions: { preserveProgress?: boolean } | undefined;
        if (shouldPrompt) {
          const keepProgress = await confirm({
            title: t("listView.preserveProgressTitle", "Preserve Progress?"),
            message: t("listView.preserveProgressMessage", "This task has completed steps. Keep progress before moving?"),
            confirmLabel: t("listView.keepProgress", "Keep Progress"),
            cancelLabel: t("listView.resetProgress", "Reset Progress"),
          });

          if (keepProgress) {
            moveOptions = { preserveProgress: true };
          } else {
            const resetProgress = await confirm({
              title: t("listView.resetProgressTitle", "Reset Progress?"),
              message: t("listView.resetProgressMessage", "Reset all step progress before moving this task?"),
              confirmLabel: t("listView.resetProgress", "Reset Progress"),
              cancelLabel: t("listView.cancelMove", "Cancel Move"),
              danger: true,
            });
            if (!resetProgress) {
              return;
            }
          }
        }

        await onMoveTask(taskId, column, moveOptions);
      } catch (err) {
        addToast(getErrorMessage(err), "error");
      }
    },
    [addToast, columnFlagsById, confirm, isArchivedColumn, onMoveTask, tasks, t]
  );

  const getSortIcon = (field: SortField) => {
    if (!sortField || sortField !== field) return <ArrowUpDown size={14} className="sort-icon" />;
    return sortDirection === "asc" ? (
      <ArrowUp size={14} className="sort-icon active" />
    ) : (
      <ArrowDown size={14} className="sort-icon active" />
    );
  };

  const renderWorkflowSelector = () => {
    if (!workflowMode || !selectedWorkflow) return null;
    const shouldRenderWorkflowControls = workflowOptions.length > 1 || Boolean(onCreateWorkflow || onOpenWorkflowEditor);
    if (!shouldRenderWorkflowControls || workflowOptions.length === 0) return null;
    const workflowControl = (
      <div className="list-workflow-control">
        <WorkflowSwitcher
          workflows={workflowOptions}
          value={selectedWorkflow.id}
          onChange={setSelectedWorkflowId}
          counts={workflowStatusCounts}
          onOpen={refreshBoardWorkflows}
          label={t("listView.workflowLabel", "Workflow")}
          onEditWorkflow={onOpenWorkflowEditor}
          onCreateWorkflow={onCreateWorkflow}
        />
      </div>
    );
    /*
    FNXC:WorkflowControls 2026-06-20-00:00:
    ListView keeps its own workflow selection state and only portals its workflow controls into Header when the sidebar header slot exists.

    FNXC:WorkflowControls 2026-06-20-15:43:
    ListView now has edit parity through WorkflowSwitcher row actions and no longer renders a standalone create icon, preventing empty button shells across desktop and mobile header placements.
    */
    return workflowControlsInHeader && headerWorkflowSlot
      ? createPortal(workflowControl, headerWorkflowSlot)
      : workflowControl;
  };

  const renderViewOptionsPanel = (panelId: string) => (
    <div id={panelId} className="list-view-options-panel">
      <div className="list-view-options-columns">
        {ALL_LIST_COLUMNS.map((column) => {
          const isVisible = visibleColumns.has(column);
          const isLastVisible = isVisible && visibleColumns.size === 1;
          return (
            <label
              key={column}
              className={`list-column-dropdown-item${isLastVisible ? " disabled" : ""}`}
              title={isLastVisible ? t("listView.lastColumnWarning", "At least one column must be visible") : ""}
            >
              <input
                type="checkbox"
                checked={isVisible}
                onChange={() => toggleColumn(column)}
                disabled={isLastVisible}
              />
              <span>{COLUMN_LABELS_MAP[column]}</span>
            </label>
          );
        })}
      </div>
      <button
        className="btn btn-sm list-hide-done-toggle"
        onClick={() => setHideDoneTasks((prev) => !prev)}
        aria-pressed={hideDoneTasks}
        title={hideDoneTasks ? t("listView.showDoneTitle", "Show done tasks") : t("listView.hideDoneTitle", "Hide done tasks")}
      >
        {hideDoneTasks ? <Eye size={14} /> : <EyeOff size={14} />}
        {hideDoneTasks ? t("listView.showDone", "Show Done") : t("listView.hideDone", "Hide Done")}
      </button>
      <button
        className="btn btn-sm list-hide-done-toggle"
        onClick={() => setStaleOnlyFilter((prev) => !prev)}
        aria-pressed={staleOnlyFilter}
        title={staleOnlyFilter ? t("listView.showAllTitle", "Show all tasks") : t("listView.staleOnlyTitle", "Show stale tasks only")}
      >
        {staleOnlyFilter ? t("listView.showAll", "Show all") : t("listView.staleOnly", "Stale only")}
      </button>
      <button
        className="btn btn-sm list-hide-done-toggle"
        onClick={() => setStalePausedReviewOnlyFilter((prev) => !prev)}
        aria-pressed={stalePausedReviewOnlyFilter}
        title={stalePausedReviewOnlyFilter ? t("listView.showAllTitle", "Show all tasks") : t("listView.stalePausedReviewTitle", "Show stale paused review tasks only")}
      >
        {stalePausedReviewOnlyFilter ? t("listView.showAll", "Show all") : t("listView.stalePausedReview", "Stale paused review")}
      </button>
      <div className="list-drop-zones list-drop-zones--sidebar">
        {listColumns.map((columnDef) => {
          const column = columnDef.id;
          const totalCount = selectedWorkflowTaskIds
            ? tasks.filter((task) => task.column === column && selectedWorkflowTaskIds.has(task.id)).length
            : tasks.filter((task) => task.column === column).length;
          const isCompletedColumn = Boolean(columnDef.flags.complete || columnDef.flags.archived);
          const visibleCount = hideDoneTasks && isCompletedColumn ? 0 : totalCount;
          const showPartial = hideDoneTasks && isCompletedColumn && totalCount > 0;

          return (
            <div
              key={column}
              className={`list-drop-zone${dragOverColumn === column ? " drag-over" : ""}${selectedColumn === column ? " active" : ""}`}
              onClick={() => handleColumnFilter(column)}
              onDragOver={(e) => handleColumnDragOver(e, column)}
              onDragLeave={handleColumnDragLeave}
              onDrop={(e) => handleColumnDrop(e, column)}
              data-column={column}
            >
              <span className={`list-section-dot dot-${column}`} style={{ backgroundColor: columnColor(column) }} />
              <span className="drop-zone-label">{getListColumnLabel(column)}</span>
              <span className="drop-zone-count">
                {showPartial ? `${visibleCount} of ${totalCount}` : totalCount}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderListWorkflowSkeleton = (empty = false) => (
    <div className="list-view list-view--workflow-skeleton" aria-busy={!empty} aria-label={empty ? t("listView.noWorkflowLanes", "No workflow lanes available") : t("listView.loadingWorkflowLanes", "Loading workflow lanes")} data-testid={empty ? "list-workflows-empty" : "list-workflows-skeleton"}>
      <div className="list-view-header">
        <div>
          <h2>{t("listView.title", "List View")}</h2>
          <p className="list-subtitle">{empty ? t("listView.noWorkflowLanes", "No workflow lanes available") : t("listView.loadingWorkflowLanes", "Loading workflow lanes")}</p>
        </div>
      </div>
      <div className="list-workflow-skeleton card" aria-hidden="true">
        <div className="list-workflow-skeleton__row list-workflow-skeleton__row--header" />
        <div className="list-workflow-skeleton__row" />
        <div className="list-workflow-skeleton__row list-workflow-skeleton__row--short" />
      </div>
    </div>
  );

  const renderPrimaryActionCluster = () => (
    <div className="list-action-cluster" data-testid="list-primary-action-cluster">
      <button className="btn btn-sm" onClick={toggleBulkEdit} aria-pressed={bulkEditEnabled}>
        {bulkEditEnabled ? t("listView.doneEditing", "Done Editing") : t("listView.bulkEdit", "Bulk Edit")}
      </button>
      <button
        className="btn btn-sm list-view-options-toggle"
        onClick={() => setViewOptionsOpen((prev) => !prev)}
        aria-expanded={viewOptionsOpen}
        aria-controls={isMobile ? "list-view-options-panel-mobile" : "list-view-options-panel"}
      >
        <Columns3 size={14} />
        {t("listView.viewOptions", "View")}
      </button>
      {onNewTask ? (
        <button className="btn btn-task-create btn-sm list-new-task-action" onClick={onNewTask}>
          {t("listView.newTask", "+ New Task")}
        </button>
      ) : null}
    </div>
  );

  const renderBulkEditToolbars = () => (
    <>
      <div className="bulk-edit-toolbar">
        <button className="btn btn-sm" onClick={handleBulkPause} disabled={isApplying} title={t("listView.pauseSelectedTitle", "Pause all selected tasks that are not already paused")}>
          <Pause size={14} />
          {t("listView.pauseSelected", "Pause selected")}
        </button>
        <button className="btn btn-sm" onClick={handleBulkUnpause} disabled={isApplying} title={t("listView.unpauseSelectedTitle", "Unpause selected tasks that are currently paused")}>
          <Play size={14} />
          {t("listView.unpauseSelected", "Unpause selected")}
        </button>
        <button className="btn btn-sm" onClick={handleBulkArchive} disabled={isApplying} title={t("listView.archiveSelectedTitle", "Archive selected tasks that are in Done")}>
          <Archive size={14} />
          {t("listView.archiveSelected", "Archive selected")}
        </button>
        <button className="btn btn-danger btn-sm" onClick={handleBulkDelete} disabled={isApplying} title={t("listView.deleteSelectedTitle", "Delete selected tasks")}>
          <Trash2 size={14} />
          {t("listView.deleteSelected", "Delete selected")}
        </button>
      </div>
      {availableModels && availableModels.length > 0 ? (
        <div className="bulk-edit-toolbar">
          <span className="bulk-edit-label">{t("listView.bulkEditModelsLabel", "Bulk Edit Models & Node:")}</span>
          <div className="bulk-edit-dropdown">
            <CustomModelDropdown
              models={availableModels}
              value={executorModel}
              onChange={setExecutorModel}
              label={t("listView.executorModel", "Executor Model")}
              noChangeValue="__no_change__"
              noChangeLabel={t("listView.noChange", "No change")}
              favoriteProviders={favoriteProviders}
              onToggleFavorite={onToggleFavorite}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={onToggleModelFavorite}
            />
          </div>
          <div className="bulk-edit-dropdown">
            <CustomModelDropdown
              models={availableModels}
              value={validatorModel}
              onChange={setValidatorModel}
              label={t("listView.reviewerModel", "Reviewer Model")}
              noChangeValue="__no_change__"
              noChangeLabel={t("listView.noChange", "No change")}
              favoriteProviders={favoriteProviders}
              onToggleFavorite={onToggleFavorite}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={onToggleModelFavorite}
            />
          </div>
          <div className="bulk-edit-dropdown bulk-edit-node-wrap">
            <select
              className="select bulk-node-select"
              value={nodeOverride}
              onChange={(e) => setNodeOverride(e.target.value)}
              aria-label={t("listView.nodeOverrideLabel", "Node Override")}
              disabled={isLoadingNodes}
            >
              <option value="__no_change__">{t("listView.noChange", "No change")}</option>
              <option value="">{t("listView.useProjectDefault", "Use project default")}</option>
              {availableNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {`${getNodeStatusSymbol(node.status)} ${node.name || node.id} (${getNodeStatusLabel(node.status, t)})`}
                </option>
              ))}
            </select>
            {selectedOverrideNode ? <NodeHealthDot status={selectedOverrideNode.status} showLabel /> : null}
          </div>
          <button
            className="btn btn-primary btn-sm bulk-edit-apply-btn"
            onClick={handleApplyBulkUpdate}
            disabled={isApplying || (executorModel === "__no_change__" && validatorModel === "__no_change__" && nodeOverride === "__no_change__")}
          >
            {isApplying ? t("listView.applying", "Applying...") : t("listView.apply", "Apply")}
          </button>
        </div>
      ) : null}
    </>
  );

  const shouldGateLegacyList = boardWorkflows === null
    ? (workflowColumnsEnabled === true || settingsLoaded === false)
    : boardWorkflows.flagEnabled === true && boardWorkflows.workflows.length === 0;

  if (shouldGateLegacyList) {
    return renderListWorkflowSkeleton(boardWorkflows?.flagEnabled === true);
  }

  return (
    <div className="list-view">
      {isMobile && (
        <>
          <div className="list-toolbar">
            {renderWorkflowSelector()}
            {renderPrimaryActionCluster()}
          </div>
          {viewOptionsOpen ? (
            <div className="list-toolbar-mobile-options">{renderViewOptionsPanel("list-view-options-panel-mobile")}</div>
          ) : null}
          {bulkEditEnabled ? (
            selectedTaskIds.size > 0 ? (
              <div className="list-mobile-bulk-actions-wrapper">{renderBulkEditToolbars()}</div>
            ) : (
              <div className="list-mobile-bulk-actions">
                <span className="list-mobile-bulk-actions__count">{t("listView.selectedCount", "{{count}} selected", { count: selectedTaskIds.size })}</span>
                <button className="btn btn-sm" onClick={clearSelection}>
                  {t("listView.clear", "Clear")}
                </button>
              </div>
            )
          ) : null}
        </>
      )}

      <div className="list-table-container">
        <div className={isMobile ? "" : "list-split-layout"} data-testid={isMobile ? undefined : "list-split-layout"} ref={splitLayoutRef}>
          <div
            className={isMobile ? "" : "list-split-sidebar"}
            data-testid={isMobile ? undefined : "list-split-sidebar"}
            ref={splitSidebarRef}
            style={isMobile ? undefined : { width: `${sidebarWidth}px` }}
          >
            {!isMobile && (
              <aside className="list-sidebar-controls" aria-label={t("listView.listControlsLabel", "List controls")}>
                {/*
                FNXC:ListView 2026-06-23-23:42:
                The List view top controls should not show the aggregate task count. Keep only action groups and state chips near quick-add; section/drop-zone counts remain lower in the list where they are contextual.
                */}
                <div className="list-sidebar-controls__header">
                  {renderWorkflowSelector()}
                  <div className="list-sidebar-controls__toolbar">
                    {renderPrimaryActionCluster()}
                  </div>
                  <div className="list-sidebar-summary-chips">
                    {selectedColumn ? (
                      <button className="btn btn-sm" onClick={clearColumnFilter} aria-label={t("listView.clearColumnFilter", "Clear column filter")}>
                        {t("listView.filterChip", "Filter: {{column}}", { column: getListColumnLabel(selectedColumn) })}
                      </button>
                    ) : null}
                    {hideDoneTasks ? <span className="list-sidebar-chip">{t("listView.doneHiddenChip", "Done hidden")}</span> : null}
                    {staleOnlyFilter ? <span className="list-sidebar-chip">{t("listView.staleOnly", "Stale only")}</span> : null}
                    {stalePausedReviewOnlyFilter ? <span className="list-sidebar-chip">{t("listView.stalePausedReview", "Stale paused review")}</span> : null}
                    {bulkEditEnabled ? (
                      <span className="list-sidebar-chip">{t("listView.bulkEdit", "Bulk edit")}</span>
                    ) : null}
                    {bulkEditEnabled && selectedTaskIds.size > 0 ? (
                      <button className="btn btn-sm" onClick={clearSelection}>
                        {t("listView.selectedCount", "{{count}} selected", { count: selectedTaskIds.size })}
                      </button>
                    ) : null}
                  </div>
                </div>
                {viewOptionsOpen && renderViewOptionsPanel("list-view-options-panel")}
                {bulkEditEnabled && selectedTaskIds.size > 0 ? renderBulkEditToolbars() : null}
              </aside>
            )}
            <div className="list-quick-entry-above-table">
              <QuickEntryBox 
                onCreate={handleListQuickCreate}
                addToast={addToast}
                tasks={tasks}
                availableModels={availableModels}
                onPlanningMode={onPlanningMode}
                onSubtaskBreakdown={onSubtaskBreakdown}
                workflowId={listQuickEntryWorkflowId}
                projectId={projectId}
                autoExpand={false}
                defaultExpanded={false}
                singleLine /* FNXC:QuickEntry 2026-06-22-19:25: List view uses the compact single-line quick-add so the box stays one line tall. */
                favoriteProviders={favoriteProviders}
                favoriteModels={favoriteModels}
                onToggleFavorite={onToggleFavorite}
                onToggleModelFavorite={onToggleModelFavorite}
                onOpenTask={(taskId) => {
                  const matchingTask = tasks.find((candidate) => candidate.id === taskId);
                  if (matchingTask) {
                    onOpenDetail(matchingTask);
                    return;
                  }
                  if (typeof window !== "undefined") {
                    window.location.hash = `#/tasks/${taskId}`;
                  }
                }}
              />
            </div>
        {filteredCount === 0 ? (
          <div className="list-empty">
            {searchQuery ? t("listView.noTasksMatch", "No tasks match your filter") : t("listView.noTasksYet", "No tasks yet")}
          </div>
        ) : isMobile ? (
          <div className="list-cards">
            {listColumns.map((columnDef) => {
              const column = columnDef.id;
              if (selectedColumn && column !== selectedColumn) return null;
              if (hideDoneTasks && (columnDef.flags.complete || columnDef.flags.archived) && !selectedColumn) return null;

              const columnTasks = groupedTasks[column];
              const isEmpty = columnTasks.length === 0;
              if (searchQuery && isEmpty) return null;

              const isCollapsed = collapsedSections.has(column);

              return (
                <Fragment key={column}>
                  <div
                    className={`list-card-section-header${isCollapsed ? " list-section-header--collapsed" : ""}`}
                    onClick={() => toggleSection(column)}
                    aria-expanded={!isCollapsed}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleSection(column);
                      }
                    }}
                  >
                    <ChevronRight
                      size={14}
                      className={`list-section-chevron${!isCollapsed ? " list-section-chevron--expanded" : ""}`}
                    />
                    <span className={`list-section-dot dot-${column}`} style={{ backgroundColor: columnColor(column) }} />
                    <span className="list-section-title">{getListColumnLabel(column)}</span>
                    <span className="list-section-count">{columnTasks.length}</span>
                  </div>

                  {!isCollapsed && (
                    <>
                      {isEmpty ? (
                        <div className="list-empty-cell list-card-empty">{t("listView.noTasks", "No tasks")}</div>
                      ) : (
                        columnTasks.map((task) => {
                          const isDoneColumn = isCompleteColumn(task.column);
                          const visualStatus = isDoneColumn ? "done" : task.status;
                          const isFailed = !isDoneColumn && task.status === "failed";
                          const isPaused = !isDoneColumn && task.paused === true;
                          const isStuckState = isTaskStuck(task, taskStuckTimeoutMs, lastFetchTimeMs);
                          const isAgentActive =
                            !globalPaused &&
                            !isFailed &&
                            !isPaused &&
                            !isStuckState &&
                            (task.column === "in-progress" || ACTIVE_STATUSES.has(visualStatus as string));
                          const hasStatus = typeof visualStatus === "string" && visualStatus.trim().length > 0;
                          const hasDependencies = Boolean(task.dependencies && task.dependencies.length > 0);
                          const taskProgress = getTaskProgress(task);
                          const hasProgress = taskProgress.hasProgress;
                          const isSelectionMode = bulkEditEnabled;

                          return (
                            <div
                              key={task.id}
                              className={`list-card${isAgentActive ? " agent-active" : ""}${isSelectionMode ? " list-card--selectable" : ""}`}
                              onClick={() => handleRowClick(task)}
                              data-id={task.id}
                            >
                              {isSelectionMode && (
                                <label className="list-card-checkbox" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={selectedTaskIds.has(task.id)}
                                    onChange={(e) => {
                                      e.stopPropagation();
                                      toggleTaskSelection(task.id);
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    disabled={isArchivedColumn(task.column)}
                                    aria-label={t("listView.selectTask", "Select {{taskId}}", { taskId: task.id })}
                                  />
                                </label>
                              )}

                              <div className="list-card-row">
                                <span className="list-card-id">{task.id}</span>
                                {task.executionMode === "fast" && (
                                  <span
                                    className="list-execution-mode-badge list-execution-mode-badge--fast"
                                    title={t("listView.fastMode", "Fast mode")}
                                    aria-label={t("listView.fastMode", "Fast mode")}
                                  >
                                    <Zap aria-hidden="true" />
                                    <span className="visually-hidden">{t("listView.fastMode", "Fast mode")}</span>
                                  </span>
                                )}
                                <span className="list-card-spacer" />
                                {isPaused && task.pausedByAgentId ? (
                                  <span className="list-status-badge paused">{t("listView.pausedByAgent", "paused by agent")}</span>
                                ) : isStuckState ? (
                                  <span className="list-status-badge stuck">{t("listView.stuck", "Stuck")}</span>
                                ) : hasStatus ? (
                                  <span className={`list-status-badge list-status-badge--${task.column}${isFailed ? " failed" : ""}${isAgentActive ? " pulsing" : ""}`}>
                                    {getTaskStatusLabel(visualStatus ?? "", t)}
                                  </span>
                                ) : null}
                              </div>

                              <div className="list-card-row">
                                <div className="list-card-title">{task.title || task.description}</div>
                              </div>

                              {(hasDependencies || hasProgress) && (
                                <div className="list-card-row list-card-meta">
                                  {hasDependencies && (
                                    <span className="list-dep-badge" title={task.dependencies.join(", ")}>
                                      <Link size={12} /> {task.dependencies.length}
                                    </span>
                                  )}
                                  {hasProgress && (
                                    <div className="list-progress">
                                      <div className="list-progress-bar">
                                        <div
                                          className="list-progress-fill"
                                          style={{
                                            width: `${taskProgress.percent}%`,
                                            backgroundColor: columnColor(task.column),
                                          }}
                                        />
                                      </div>
                                      <span className="list-progress-label">{taskProgress.label}</span>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </>
                  )}
                </Fragment>
              );
            })}
          </div>
        ) : (
          <table className="list-table">
            <thead>
              <tr>
                {bulkEditEnabled && (
                  <th className="list-header-cell list-header-checkbox">
                    <input
                      type="checkbox"
                      checked={isSelectAll}
                      ref={(el) => {
                        if (el) el.indeterminate = isSelectIndeterminate;
                      }}
                      onChange={toggleSelectAll}
                      aria-label={t("listView.selectAll", "Select all visible tasks")}
                    />
                  </th>
                )}
                {visibleColumns.has("title") && (
                  <th className="list-header-cell" onClick={() => handleSort("title")}>
                    {t("listView.colTitle", "Title")} {getSortIcon("title")}
                  </th>
                )}
                {visibleColumns.has("status") && (
                  <th className="list-header-cell" onClick={() => handleSort("status")}>
                    {t("listView.colStatus", "Status")} {getSortIcon("status")}
                  </th>
                )}
                {visibleColumns.has("column") && (
                  <th className="list-header-cell" onClick={() => handleSort("column")}>
                    {t("listView.colColumn", "Column")} {getSortIcon("column")}
                  </th>
                )}
                {visibleColumns.has("retries") && (
                  <th className="list-header-cell" onClick={() => handleSort("retries")}>
                    {t("listView.colRetries", "Retries")} {getSortIcon("retries")}
                  </th>
                )}
                {visibleColumns.has("dependencies") && (
                  <th className="list-header-cell">{t("listView.colDependencies", "Dependencies")}</th>
                )}
                {visibleColumns.has("progress") && (
                  <th className="list-header-cell">{t("listView.colProgress", "Progress")}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {listColumns.map((columnDef) => {
                const column = columnDef.id;
                // When column filter is active, only show the selected column
                if (selectedColumn && column !== selectedColumn) return null;
                
                // Skip done and archived column sections when hideDoneTasks is enabled (unless it's the selected column)
                if (hideDoneTasks && (columnDef.flags.complete || columnDef.flags.archived) && !selectedColumn) return null;

                const columnTasks = groupedTasks[column];
                const isEmpty = columnTasks.length === 0;

                // When text filtering, hide empty sections entirely
                if (searchQuery && isEmpty) return null;

                const isCollapsed = collapsedSections.has(column);

                return (
                  <Fragment key={column}>
                    {/* Section Header */}
                    <tr
                      className={`list-section-header${isCollapsed ? " list-section-header--collapsed" : ""}`}
                      onClick={() => toggleSection(column)}
                      aria-expanded={!isCollapsed}
                    >
                      <th colSpan={visibleColumns.size + (bulkEditEnabled ? 1 : 0)} className="list-section-cell">
                        <ChevronRight
                          size={14}
                          className={`list-section-chevron${!isCollapsed ? " list-section-chevron--expanded" : ""}`}
                        />
                        <span className={`list-section-dot dot-${column}`} style={{ backgroundColor: columnColor(column) }} />
                        <span className="list-section-title">{getListColumnLabel(column)}</span>
                        <span className="list-section-count">{columnTasks.length}</span>
                      </th>
                    </tr>

                    {/* Task Rows - only render when not collapsed */}
                    {!isCollapsed && (
                      <>
                        {isEmpty ? (
                          <tr className="list-section-empty">
                            <td colSpan={visibleColumns.size + (bulkEditEnabled ? 1 : 0)} className="list-empty-cell">
                              {t("listView.noTasks", "No tasks")}
                            </td>
                          </tr>
                        ) : (
                          columnTasks.map((task) => {
                            const isDoneColumn = isCompleteColumn(task.column);
                            const visualStatus = isDoneColumn ? "done" : task.status;
                            const isFailed = !isDoneColumn && task.status === "failed";
                            const isPaused = !isDoneColumn && task.paused === true;
                            const isStuckState = isTaskStuck(task, taskStuckTimeoutMs, lastFetchTimeMs);
                            const isAgentActive =
                              !globalPaused &&
                              !isFailed &&
                              !isPaused &&
                              !isStuckState &&
                              (task.column === "in-progress" || ACTIVE_STATUSES.has(visualStatus as string));
                            const isDragging = draggingTaskId === task.id;

                            return (
                              <tr
                                key={task.id}
                                className={`list-row${isFailed ? " failed" : ""}${isPaused ? " paused" : ""}${
                                  isStuckState ? " stuck" : ""
                                }${isAgentActive ? " agent-active" : ""}${
                                  isDragging ? " dragging" : ""
                                }${selectedTaskId === task.id ? " list-row--selected" : ""}`}
                                onClick={() => handleRowClick(task)}
                                draggable={!isPaused}
                                onDragStart={(e) => handleDragStart(e, task)}
                                onDragEnd={handleDragEnd}
                                data-id={task.id}
                              >
                                {bulkEditEnabled && (
                                  <td className="list-cell list-cell-checkbox">
                                    <input
                                      type="checkbox"
                                      checked={selectedTaskIds.has(task.id)}
                                      onChange={(e) => {
                                        e.stopPropagation();
                                        toggleTaskSelection(task.id);
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                      disabled={isArchivedColumn(task.column)}
                                      aria-label={t("listView.selectTask", "Select {{taskId}}", { taskId: task.id })}
                                    />
                                  </td>
                                )}
                                {visibleColumns.has("title") && (
                                  <td className="list-cell list-cell-title">
                                    <div className="list-title-content">
                                      <span className="list-title-id">{task.id}</span>
                                      <div className="list-title-row">
                                        {task.executionMode === "fast" && (
                                          <span
                                            className="list-execution-mode-badge list-execution-mode-badge--fast"
                                            title={t("listView.fastMode", "Fast mode")}
                                            aria-label={t("listView.fastMode", "Fast mode")}
                                          >
                                            <Zap aria-hidden="true" />
                                            <span className="visually-hidden">{t("listView.fastMode", "Fast mode")}</span>
                                          </span>
                                        )}
                                        <span className="list-title-text">{task.title || task.description}</span>
                                      </div>
                                    </div>
                                  </td>
                                )}
                                {visibleColumns.has("status") && (
                                  <td className="list-cell">
                                    {isPaused && task.pausedByAgentId ? (
                                      <span className="list-status-badge paused">{t("listView.pausedByAgent", "paused by agent")}</span>
                                    ) : isStuckState ? (
                                      <span className="list-status-badge stuck">
                                        {t("listView.stuck", "Stuck")}
                                      </span>
                                    ) : visualStatus ? (
                                      <span
                                        className={`list-status-badge list-status-badge--${task.column}${isFailed ? " failed" : ""}${
                                          isAgentActive ? " pulsing" : ""
                                        }`}
                                      >
                                        {getTaskStatusLabel(visualStatus ?? "", t)}
                                      </span>
                                    ) : (
                                      <span className="list-status-badge">-</span>
                                    )}
                                  </td>
                                )}
                                {visibleColumns.has("column") && (
                                  <td className="list-cell">
                                    <span
                                      className="list-column-badge"
                                      style={{
                                        background: `color-mix(in srgb, ${columnColor(task.column)} 12%, transparent)`,
                                        color: columnColor(task.column),
                                      }}
                                    >
                                      {getListColumnLabel(task.column)}
                                    </span>
                                  </td>
                                )}
                                {visibleColumns.has("retries") && (
                                  <td className="list-cell">{(task.retrySummary?.total ?? 0) > 0 ? (task.retrySummary?.total ?? 0) : "—"}</td>
                                )}
                                {visibleColumns.has("dependencies") && (
                                  <td className="list-cell list-cell-deps">
                                    {task.dependencies && task.dependencies.length > 0 ? (
                                      <span className="list-dep-badge" title={task.dependencies.join(", ")}>
                                        <Link size={12} /> {task.dependencies.length}
                                      </span>
                                    ) : (
                                      "-"
                                    )}
                                  </td>
                                )}
                                {visibleColumns.has("progress") && (
                                  <td className="list-cell list-cell-progress">
                                    {(() => {
                                      const taskProgress = getTaskProgress(task);
                                      if (!taskProgress.hasProgress) return "-";
                                      return (
                                        <div className="list-progress">
                                          <div className="list-progress-bar">
                                            <div
                                              className="list-progress-fill"
                                              style={{
                                                width: `${taskProgress.percent}%`,
                                                backgroundColor: columnColor(task.column),
                                              }}
                                            />
                                          </div>
                                          <span className="list-progress-label">{taskProgress.label}</span>
                                        </div>
                                      );
                                    })()}
                                  </td>
                                )}
                              </tr>
                            );
                          })
                        )}
                      </>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
          </div>
          {!isMobile && (
            <>
              <div
                className="list-split-resize-handle"
                data-testid="list-split-resize-handle"
                onPointerDown={handleSplitResizeStart}
                onKeyDown={handleSplitResizeKeyDown}
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label={t("listView.resizeSidebar", "Resize task list sidebar")}
                aria-valuemin={LIST_SIDEBAR_MIN_WIDTH}
                aria-valuemax={Math.round(
                  getSidebarMaxWidth(
                    splitLayoutRef.current?.clientWidth ??
                      (sidebarWidth / LIST_SIDEBAR_MAX_RATIO + LIST_SIDEBAR_KEYBOARD_STEP)
                  )
                )}
                aria-valuenow={Math.round(sidebarWidth)}
              />
              <div className="list-split-detail" data-testid="list-split-detail">
                {!selectedTaskSnapshot ? (
                  <div className="list-split-detail-empty">
                    <p>{t("listView.selectTaskPrompt", "Select a task to view details")}</p>
                  </div>
                ) : (
                  <div className="list-split-detail-content" data-testid="list-split-detail-content">
                    <TaskDetailContent
                      task={selectedTaskSnapshot}
                      projectId={projectId}
                      tasks={tasks}
                      embedded
                      onOpenDetail={handleEmbeddedOpenDetail}
                      onMoveTask={onMoveTask}
                      onDeleteTask={onDeleteTask}
                      onMergeTask={onMergeTask}
                      onRetryTask={onRetryTask}
                      onResetTask={onResetTask}
                      onDuplicateTask={onDuplicateTask}
                      onPopOut={onPopOut ? () => onPopOut(selectedTaskSnapshot) : undefined}
                      onTaskUpdated={(updatedTask) => {
                        setSelectedTaskSnapshot((previous) => {
                          if (!previous || previous.id !== updatedTask.id) return previous;
                          return { ...previous, ...updatedTask };
                        });
                      }}
                      addToast={addToast}
                      prAuthAvailable={prAuthAvailable}
                      autoMergeEnabled={autoMerge}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
