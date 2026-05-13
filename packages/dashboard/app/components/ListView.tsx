import "./ListView.css";
import { useState, useCallback, useMemo, Fragment, useEffect, useRef } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown, Link, Columns3, EyeOff, Eye, ChevronRight, Zap, Trash2 } from "lucide-react";
import type { Task, TaskDetail, Column, TaskCreateInput, MergeResult } from "@fusion/core";
import { COLUMN_LABELS, COLUMNS, DEFAULT_COLUMN, getErrorMessage, isColumn } from "@fusion/core";
import { sortTasksForDisplayColumn } from "./taskSorting";
import { batchUpdateTaskModels, fetchNodes, fetchTaskDetail } from "../api";
import { TaskDetailContent } from "./TaskDetailModal";
import type { ModelInfo, NodeInfo } from "../api";
import { QuickEntryBox } from "./QuickEntryBox";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { NodeHealthDot } from "./NodeHealthDot";
import { isTaskStuck } from "../utils/taskStuck";
import type { ToastType } from "../hooks/useToast";
import { useViewportMode } from "../hooks/useViewportMode";
import { getScopedItem, removeScopedItem, setScopedItem } from "../utils/projectStorage";
import { getUnifiedTaskProgress } from "../utils/taskProgress";
import { useConfirm } from "../hooks/useConfirm";
import { extractDependencyDeleteConflict } from "../utils/taskDelete";

const COLUMN_COLOR_MAP: Record<Column, string> = {
  triage: "var(--triage)",
  todo: "var(--todo)",
  "in-progress": "var(--in-progress)",
  "in-review": "var(--in-review)",
  done: "var(--done)",
  archived: "var(--text-dim)",
};

const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "merging-fix"]);

type SortField = "title" | "status" | "column";

function getTaskStatusLabel(status: string): string {
  if (status === "merging-fix") return "Merging fixes…";
  return status;
}
type SortDirection = "asc" | "desc";

// Column visibility types
const ALL_LIST_COLUMNS = ["title", "status", "column", "dependencies", "progress"] as const;
const DEFAULT_LIST_COLUMNS = ["title", "status", "column"] as const;
type ListColumn = typeof ALL_LIST_COLUMNS[number];

function getNodeStatusLabel(status: NodeInfo["status"]): string {
  if (status === "online") return "Online";
  if (status === "connecting") return "Connecting";
  if (status === "error") return "Error";
  return "Offline";
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

function readCollapsedSections(projectId?: string): Set<Column> {
  try {
    const saved = getScopedItem("kb-dashboard-list-collapsed", projectId);
    if (saved) {
      const parsed = JSON.parse(saved) as Column[];
      const validColumns = parsed.filter((col): col is Column =>
        COLUMNS.includes(col as Column)
      );
      if (validColumns.length > 0) {
        return new Set(validColumns);
      }
    }
  } catch {
    // Invalid localStorage data - fall through to default
  }

  return new Set<Column>();
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

const LIST_SIDEBAR_MIN_WIDTH = 280;
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
  onMoveTask: (id: string, column: Column, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onDeleteTask: (id: string, options?: { removeDependencyReferences?: boolean }) => Promise<Task>;
  onMergeTask: (id: string) => Promise<MergeResult>;
  onResetTask?: (id: string) => Promise<Task>;
  onDuplicateTask?: (id: string) => Promise<Task>;
  onOpenDetail: (task: Task | TaskDetail, options?: { origin?: "list-mobile" }) => void;
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
  onPlanningMode?: (initialPlan: string) => void;
  /**
   * Called when the user clicks the "Subtask" button in the quick entry box.
   */
  onSubtaskBreakdown?: (description: string) => void;
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
}

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
  onMergeTask,
  onResetTask,
  onDuplicateTask,
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
}: ListViewProps) {
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<Column | null>(null);
  const [selectedColumn, setSelectedColumn] = useState<Column | null>(null);
  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";
  const { confirm } = useConfirm();

  // Column visibility state - initialize from localStorage or reduced default columns
  const [visibleColumns, setVisibleColumns] = useState<Set<ListColumn>>(() => readVisibleColumns(projectId));

  // Hide done tasks state - initialize from localStorage
  const [hideDoneTasks, setHideDoneTasks] = useState<boolean>(() => readHideDoneTasks(projectId));

  // Collapsed sections state - initialize from localStorage
  const [collapsedSections, setCollapsedSections] = useState<Set<Column>>(() =>
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
  const [selectedTaskSnapshot, setSelectedTaskSnapshot] = useState<Task | TaskDetail | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readSidebarWidth(projectId));
  const splitLayoutRef = useRef<HTMLDivElement>(null);
  const splitSidebarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVisibleColumns(readVisibleColumns(projectId));
    setHideDoneTasks(readHideDoneTasks(projectId));
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
      return { ...previous, ...liveTask };
    });
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    if (isMobile || typeof ResizeObserver === "undefined") return;
    const container = splitLayoutRef.current;
    if (!container) return;

    const applyClamp = () => {
      // Keep width valid when viewport/container size changes.
      const clamped = clampSidebarWidth(sidebarWidth, container.clientWidth);
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


  // Column display labels
  const COLUMN_LABELS_MAP: Record<ListColumn, string> = {
    title: "Title",
    status: "Status",
    column: "Column",
    dependencies: "Dependencies",
    progress: "Progress",
  };

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }

    setSortField(field);
    setSortDirection("asc");
  }, [sortField]);

  const handleColumnFilter = useCallback((column: Column) => {
    setSelectedColumn((prev) => (prev === column ? null : column));
  }, []);

  const toggleSection = useCallback((column: Column) => {
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

    // Then filter out done and archived tasks if hideDoneTasks is enabled
    // BUT only when no specific column is selected (strict hide semantics)
    if (hideDoneTasks && !selectedColumn) {
      filtered = filtered.filter((t) => t.column !== "done" && t.column !== "archived");
    }

    // Then apply column filter if selected
    const columnFiltered = selectedColumn
      ? filtered.filter((t) => t.column === selectedColumn)
      : filtered;

    const groups: Record<Column, Task[]> = {
      triage: [],
      todo: [],
      "in-progress": [],
      "in-review": [],
      done: [],
      archived: [],
    };

    columnFiltered.forEach((task) => {
      const column = isColumn(task.column) ? task.column : DEFAULT_COLUMN;
      groups[column].push(task);
    });

    for (const column of COLUMNS) {
      if (!sortField) {
        groups[column] = sortTasksForDisplayColumn(groups[column], column);
        continue;
      }

      groups[column] = [...groups[column]].sort((a, b) => {
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
        }
        return sortDirection === "asc" ? comparison : -comparison;
      });
    }
    return groups;
  }, [tasks, searchQuery, sortField, sortDirection, hideDoneTasks, selectedColumn]);

  // Calculate total filtered count from groups
  const filteredCount = useMemo(() => {
    return Object.values(groupedTasks).reduce((sum, group) => sum + group.length, 0);
  }, [groupedTasks]);

  // Calculate done and archived task counts for stats display
  const completedTaskCount = useMemo(() => {
    return tasks.filter((t) => t.column === "done" || t.column === "archived").length;
  }, [tasks]);

  // Calculate hidden done+archived tasks count
  const hiddenCompletedCount = useMemo(() => {
    if (!hideDoneTasks) return 0;
    return completedTaskCount;
  }, [hideDoneTasks, completedTaskCount]);

  // Selection logic that depends on groupedTasks (must be after groupedTasks definition)
  // Toggle all visible tasks
  const toggleSelectAll = useCallback(() => {
    const visibleTaskIds = Object.values(groupedTasks)
      .flat()
      .filter((t) => t.column !== "archived") // Can't bulk edit archived
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
  }, [groupedTasks]);

  // Check if all visible tasks are selected
  const isSelectAll = useMemo(() => {
    const visibleTaskIds = Object.values(groupedTasks)
      .flat()
      .filter((t) => t.column !== "archived");
    if (visibleTaskIds.length === 0) return false;
    return visibleTaskIds.every((t) => selectedTaskIds.has(t.id));
  }, [groupedTasks, selectedTaskIds]);

  // Check if some (but not all) visible tasks are selected
  const isSelectIndeterminate = useMemo(() => {
    const visibleTaskIds = Object.values(groupedTasks)
      .flat()
      .filter((t) => t.column !== "archived");
    if (visibleTaskIds.length === 0) return false;
    const selectedCount = visibleTaskIds.filter((t) => selectedTaskIds.has(t.id)).length;
    return selectedCount > 0 && selectedCount < visibleTaskIds.length;
  }, [groupedTasks, selectedTaskIds]);

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
    const archivedTasks = selectedTasks.filter((task) => task.column === "archived");
    const deletableTasks = selectedTasks.filter((task) => task.column !== "archived");

    if (deletableTasks.length === 0) {
      addToast("No selected tasks can be deleted (archived tasks are excluded)", "error");
      return;
    }

    const confirmed = await confirm({
      title: "Delete Selected Tasks",
      message: `Delete ${deletableTasks.length} selected task${deletableTasks.length === 1 ? "" : "s"}?`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      danger: true,
    });

    if (!confirmed) return;

    setIsApplying(true);
    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    const skippedIds = archivedTasks.map((task) => task.id);

    try {
      for (const task of deletableTasks) {
        try {
          await onDeleteTask(task.id);
          deletedIds.push(task.id);
        } catch (err) {
          const conflict = extractDependencyDeleteConflict(err);
          if (!conflict) {
            failedIds.push(task.id);
            continue;
          }

          const forceDelete = await confirm({
            title: "Force Delete Task",
            message: `Task ${task.id} has dependents: ${conflict.dependentIds.join(", ")}. Remove dependency references and force delete?`,
            confirmLabel: "Force Delete",
            cancelLabel: "Skip",
            danger: true,
          });

          if (!forceDelete) {
            failedIds.push(task.id);
            continue;
          }

          try {
            await onDeleteTask(task.id, { removeDependencyReferences: true });
            deletedIds.push(task.id);
          } catch {
            failedIds.push(task.id);
          }
        }
      }
    } finally {
      setIsApplying(false);
    }

    if (deletedIds.length > 0) {
      setSelectedTaskIds((previous) => {
        const next = new Set(previous);
        for (const id of deletedIds) {
          next.delete(id);
        }
        return next;
      });
    }

    addToast(
      `Deleted ${deletedIds.length} task${deletedIds.length === 1 ? "" : "s"} · ${skippedIds.length} archived skipped · ${failedIds.length} failed`,
      failedIds.length > 0 ? "error" : "success",
    );
  }, [addToast, confirm, onDeleteTask, selectedTaskIds, tasks]);

  const handleApplyBulkUpdate = useCallback(async () => {
    if (selectedTaskIds.size === 0) return;

    const taskIds = Array.from(selectedTaskIds).filter((id) => {
      const task = tasks.find((t) => t.id === id);
      return task && task.column !== "archived";
    });

    if (taskIds.length === 0) {
      addToast("No valid tasks to update (archived tasks cannot be modified)", "error");
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
      addToast("No changes to apply", "info");
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

      addToast(`Updated ${taskIds.length} task${taskIds.length === 1 ? "" : "s"}`, "success");

      // Reset state
      clearSelection();
      setExecutorModel("__no_change__");
      setValidatorModel("__no_change__");
      setNodeOverride("__no_change__");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to update models", "error");
    } finally {
      setIsApplying(false);
    }
  }, [selectedTaskIds, tasks, executorModel, validatorModel, nodeOverride, projectId, addToast, clearSelection, onTasksUpdated]);

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

  const handleSplitResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (isMobile) return;
    event.preventDefault();
    const container = splitLayoutRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const onMouseMove = (moveEvent: MouseEvent) => {
      const proposedWidth = moveEvent.clientX - rect.left;
      setSidebarWidth(clampSidebarWidth(proposedWidth, rect.width));
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [isMobile]);

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
    (e: React.DragEvent, column: Column) => {
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
    async (e: React.DragEvent, column: Column) => {
      e.preventDefault();
      setDragOverColumn(null);
      const taskId = e.dataTransfer.getData("text/plain");
      if (!taskId) return;

      // Prevent dropping into archived column
      if (column === "archived") {
        addToast("Tasks can only be archived via the archive button", "error");
        return;
      }

      try {
        const task = tasks.find((candidate) => candidate.id === taskId);
        const hasStepProgress = task?.steps.some((step) => step.status !== "pending") ?? false;
        const shouldPrompt = (column === "todo" || column === "triage") && hasStepProgress;

        let moveOptions: { preserveProgress?: boolean } | undefined;
        if (shouldPrompt) {
          const keepProgress = await confirm({
            title: "Preserve Progress?",
            message: "This task has completed steps. Keep progress before moving?",
            confirmLabel: "Keep Progress",
            cancelLabel: "Reset Progress",
          });

          if (keepProgress) {
            moveOptions = { preserveProgress: true };
          } else {
            const resetProgress = await confirm({
              title: "Reset Progress?",
              message: "Reset all step progress before moving this task?",
              confirmLabel: "Reset Progress",
              cancelLabel: "Cancel Move",
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
    [onMoveTask, addToast, tasks, confirm]
  );

  const getSortIcon = (field: SortField) => {
    if (!sortField || sortField !== field) return <ArrowUpDown size={14} className="sort-icon" />;
    return sortDirection === "asc" ? (
      <ArrowUp size={14} className="sort-icon active" />
    ) : (
      <ArrowDown size={14} className="sort-icon active" />
    );
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
              title={isLastVisible ? "At least one column must be visible" : ""}
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
        title={hideDoneTasks ? "Show done tasks" : "Hide done tasks"}
      >
        {hideDoneTasks ? <Eye size={14} /> : <EyeOff size={14} />}
        {hideDoneTasks ? "Show Done" : "Hide Done"}
      </button>
      <div className="list-drop-zones list-drop-zones--sidebar">
        {COLUMNS.map((column) => {
          const totalCount = tasks.filter((t) => t.column === column).length;
          const isCompletedColumn = column === "done" || column === "archived";
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
              <span className={`list-section-dot dot-${column}`} />
              <span className="drop-zone-label">{COLUMN_LABELS[column]}</span>
              <span className="drop-zone-count">
                {showPartial ? `${visibleCount} of ${totalCount}` : totalCount}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="list-view">
      {isMobile && (
        <>
          <div className="list-toolbar">
            <button className="btn btn-sm" onClick={toggleBulkEdit} aria-pressed={bulkEditEnabled}>
              {bulkEditEnabled ? "Done Editing" : "Bulk Edit"}
            </button>
            <button
              className="btn btn-sm list-view-options-toggle"
              onClick={() => setViewOptionsOpen((prev) => !prev)}
              aria-expanded={viewOptionsOpen}
              aria-controls="list-view-options-panel-mobile"
            >
              <Columns3 size={14} />
              View options
            </button>
            {onNewTask ? (
              <button className="btn btn-task-create btn-sm list-new-task-action" onClick={onNewTask}>
                + New Task
              </button>
            ) : null}
            <div className="list-stats">
              {selectedColumn
                ? `${filteredCount} of ${tasks.length} tasks in ${COLUMN_LABELS[selectedColumn]}`
                : `${filteredCount} of ${tasks.length} tasks`}
            </div>
          </div>
          {viewOptionsOpen ? (
            <div className="list-toolbar-mobile-options">{renderViewOptionsPanel("list-view-options-panel-mobile")}</div>
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
              <aside className="list-sidebar-controls" aria-label="List controls">
                <div className="list-sidebar-controls__header">
                  <p className="list-stats">
                    {selectedColumn
                      ? `${filteredCount} of ${tasks.length} tasks in ${COLUMN_LABELS[selectedColumn]}`
                      : `${filteredCount} of ${tasks.length} tasks`}
                    {hiddenCompletedCount > 0 && !selectedColumn && (
                      <span className="list-stats-hidden"> ({hiddenCompletedCount} hidden)</span>
                    )}
                  </p>
                  <div className="list-sidebar-controls__actions">
                    <button className="btn btn-sm" onClick={toggleBulkEdit} aria-pressed={bulkEditEnabled}>
                      {bulkEditEnabled ? "Done Editing" : "Bulk Edit"}
                    </button>
                    {onNewTask ? (
                      <button className="btn btn-task-create btn-sm list-new-task-action" onClick={onNewTask}>
                        + New Task
                      </button>
                    ) : null}
                  </div>
                  <div className="list-sidebar-summary-chips">
                    {selectedColumn ? (
                      <button className="btn btn-sm" onClick={clearColumnFilter} aria-label="Clear column filter">
                        {`Filter: ${COLUMN_LABELS[selectedColumn]}`}
                      </button>
                    ) : null}
                    {hideDoneTasks ? <span className="list-sidebar-chip">Done hidden</span> : null}
                    {bulkEditEnabled ? (
                      <span className="list-sidebar-chip">Bulk edit</span>
                    ) : null}
                    {bulkEditEnabled && selectedTaskIds.size > 0 ? (
                      <button className="btn btn-sm" onClick={clearSelection}>
                        {`${selectedTaskIds.size} selected`}
                      </button>
                    ) : null}
                  </div>
                </div>
                <button
                  className="btn btn-sm list-view-options-toggle"
                  onClick={() => setViewOptionsOpen((prev) => !prev)}
                  aria-expanded={viewOptionsOpen}
                  aria-controls="list-view-options-panel"
                >
                  <Columns3 size={14} />
                  View options
                </button>
                {viewOptionsOpen && renderViewOptionsPanel("list-view-options-panel")}
                {bulkEditEnabled && selectedTaskIds.size > 0 ? (
                  <>
                    <div className="bulk-edit-toolbar">
                      <button className="btn btn-danger btn-sm" onClick={handleBulkDelete} disabled={isApplying}>
                        <Trash2 size={14} />
                        Delete selected
                      </button>
                    </div>
                    {availableModels && availableModels.length > 0 ? (
                      <div className="bulk-edit-toolbar">
                        <span className="bulk-edit-label">Bulk Edit Models &amp; Node:</span>
                        <div className="bulk-edit-dropdown">
                          <CustomModelDropdown
                            models={availableModels}
                            value={executorModel}
                            onChange={setExecutorModel}
                            label="Executor Model"
                            noChangeValue="__no_change__"
                            noChangeLabel="No change"
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
                            label="Reviewer Model"
                            noChangeValue="__no_change__"
                            noChangeLabel="No change"
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
                            aria-label="Node Override"
                            disabled={isLoadingNodes}
                          >
                            <option value="__no_change__">No change</option>
                            <option value="">Use project default</option>
                            {availableNodes.map((node) => (
                              <option key={node.id} value={node.id}>
                                {`${getNodeStatusSymbol(node.status)} ${node.name || node.id} (${getNodeStatusLabel(node.status)})`}
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
                          {isApplying ? "Applying..." : "Apply"}
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </aside>
            )}
            <div className="list-quick-entry-above-table">
              <QuickEntryBox 
                onCreate={onQuickCreate ?? (async () => addToast("Task creation not available", "error"))} 
                addToast={addToast}
                tasks={tasks}
                availableModels={availableModels}
                onPlanningMode={onPlanningMode}
                onSubtaskBreakdown={onSubtaskBreakdown}
                projectId={projectId}
                autoExpand={false}
                favoriteProviders={favoriteProviders}
                favoriteModels={favoriteModels}
                onToggleFavorite={onToggleFavorite}
                onToggleModelFavorite={onToggleModelFavorite}
              />
            </div>
        {filteredCount === 0 ? (
          <div className="list-empty">
            {searchQuery ? "No tasks match your filter" : "No tasks yet"}
          </div>
        ) : isMobile ? (
          <div className="list-cards">
            {COLUMNS.map((column) => {
              if (selectedColumn && column !== selectedColumn) return null;
              if (hideDoneTasks && (column === "done" || column === "archived") && !selectedColumn) return null;

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
                    <span className={`list-section-dot dot-${column}`} />
                    <span className="list-section-title">{COLUMN_LABELS[column]}</span>
                    <span className="list-section-count">{columnTasks.length}</span>
                  </div>

                  {!isCollapsed && (
                    <>
                      {isEmpty ? (
                        <div className="list-empty-cell list-card-empty">No tasks</div>
                      ) : (
                        columnTasks.map((task) => {
                          const isFailed = task.status === "failed";
                          const isPaused = task.paused === true;
                          const isStuckState = isTaskStuck(task, taskStuckTimeoutMs, lastFetchTimeMs);
                          const isAgentActive =
                            !globalPaused &&
                            !isFailed &&
                            !isPaused &&
                            !isStuckState &&
                            (task.column === "in-progress" || ACTIVE_STATUSES.has(task.status as string));
                          const hasStatus = typeof task.status === "string" && task.status.trim().length > 0;
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
                                    disabled={task.column === "archived"}
                                    aria-label={`Select ${task.id}`}
                                  />
                                </label>
                              )}

                              <div className="list-card-row">
                                <span className="list-card-id">{task.id}</span>
                                {task.executionMode === "fast" && (
                                  <span
                                    className="list-execution-mode-badge list-execution-mode-badge--fast"
                                    title="Fast mode"
                                    aria-label="Fast mode"
                                  >
                                    <Zap aria-hidden="true" />
                                    <span className="visually-hidden">Fast mode</span>
                                  </span>
                                )}
                                <span className="list-card-spacer" />
                                {isPaused && task.pausedByAgentId ? (
                                  <span className="list-status-badge paused">paused by agent</span>
                                ) : isStuckState ? (
                                  <span className="list-status-badge stuck">Stuck</span>
                                ) : hasStatus ? (
                                  <span className={`list-status-badge list-status-badge--${task.column}${isFailed ? " failed" : ""}${isAgentActive ? " pulsing" : ""}`}>
                                    {getTaskStatusLabel(task.status ?? "")}
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
                                            backgroundColor: COLUMN_COLOR_MAP[task.column],
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
                      aria-label="Select all visible tasks"
                    />
                  </th>
                )}
                {visibleColumns.has("title") && (
                  <th className="list-header-cell" onClick={() => handleSort("title")}>
                    Title {getSortIcon("title")}
                  </th>
                )}
                {visibleColumns.has("status") && (
                  <th className="list-header-cell" onClick={() => handleSort("status")}>
                    Status {getSortIcon("status")}
                  </th>
                )}
                {visibleColumns.has("column") && (
                  <th className="list-header-cell" onClick={() => handleSort("column")}>
                    Column {getSortIcon("column")}
                  </th>
                )}
                {visibleColumns.has("dependencies") && (
                  <th className="list-header-cell">Dependencies</th>
                )}
                {visibleColumns.has("progress") && (
                  <th className="list-header-cell">Progress</th>
                )}
              </tr>
            </thead>
            <tbody>
              {COLUMNS.map((column) => {
                // When column filter is active, only show the selected column
                if (selectedColumn && column !== selectedColumn) return null;
                
                // Skip done and archived column sections when hideDoneTasks is enabled (unless it's the selected column)
                if (hideDoneTasks && (column === "done" || column === "archived") && !selectedColumn) return null;

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
                        <span className={`list-section-dot dot-${column}`} />
                        <span className="list-section-title">{COLUMN_LABELS[column]}</span>
                        <span className="list-section-count">{columnTasks.length}</span>
                      </th>
                    </tr>

                    {/* Task Rows - only render when not collapsed */}
                    {!isCollapsed && (
                      <>
                        {isEmpty ? (
                          <tr className="list-section-empty">
                            <td colSpan={visibleColumns.size + (bulkEditEnabled ? 1 : 0)} className="list-empty-cell">
                              No tasks
                            </td>
                          </tr>
                        ) : (
                          columnTasks.map((task) => {
                            const isFailed = task.status === "failed";
                            const isPaused = task.paused === true;
                            const isStuckState = isTaskStuck(task, taskStuckTimeoutMs, lastFetchTimeMs);
                            const isAgentActive =
                              !globalPaused &&
                              !isFailed &&
                              !isPaused &&
                              !isStuckState &&
                              (task.column === "in-progress" || ACTIVE_STATUSES.has(task.status as string));
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
                                      disabled={task.column === "archived"}
                                      aria-label={`Select ${task.id}`}
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
                                            title="Fast mode"
                                            aria-label="Fast mode"
                                          >
                                            <Zap aria-hidden="true" />
                                            <span className="visually-hidden">Fast mode</span>
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
                                      <span className="list-status-badge paused">paused by agent</span>
                                    ) : isStuckState ? (
                                      <span className="list-status-badge stuck">
                                        Stuck
                                      </span>
                                    ) : task.status ? (
                                      <span
                                        className={`list-status-badge list-status-badge--${task.column}${isFailed ? " failed" : ""}${
                                          isAgentActive ? " pulsing" : ""
                                        }`}
                                      >
                                        {getTaskStatusLabel(task.status ?? "")}
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
                                        background: `${COLUMN_COLOR_MAP[task.column]}20`,
                                        color: COLUMN_COLOR_MAP[task.column],
                                      }}
                                    >
                                      {COLUMN_LABELS[task.column]}
                                    </span>
                                  </td>
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
                                                backgroundColor: COLUMN_COLOR_MAP[task.column],
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
                onMouseDown={handleSplitResizeStart}
                onKeyDown={handleSplitResizeKeyDown}
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label="Resize task list sidebar"
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
                    <p>Select a task to view details</p>
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
                      onTaskUpdated={(updatedTask) => {
                        setSelectedTaskSnapshot((previous) => {
                          if (!previous || previous.id !== updatedTask.id) return previous;
                          return { ...previous, ...updatedTask };
                        });
                      }}
                      addToast={addToast}
                      prAuthAvailable={prAuthAvailable}
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
