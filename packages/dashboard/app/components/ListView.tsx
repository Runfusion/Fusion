import { useState, useCallback, useMemo, Fragment, useEffect, useRef } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown, Link, Columns3, EyeOff, Eye, ChevronRight } from "lucide-react";
import type { Task, TaskDetail, Column, TaskCreateInput } from "@fusion/core";
import { COLUMN_LABELS, COLUMNS, getErrorMessage } from "@fusion/core";
import { batchUpdateTaskModels } from "../api";
import type { ModelInfo } from "../api";
import { QuickEntryBox } from "./QuickEntryBox";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { isTaskStuck } from "../utils/taskStuck";
import type { ToastType } from "../hooks/useToast";
import { useViewportMode } from "../hooks/useViewportMode";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";
import { getUnifiedTaskProgress } from "../utils/taskProgress";

const COLUMN_COLOR_MAP: Record<Column, string> = {
  triage: "var(--triage)",
  todo: "var(--todo)",
  "in-progress": "var(--in-progress)",
  "in-review": "var(--in-review)",
  done: "var(--done)",
  archived: "var(--text-secondary)",
};

const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "specifying"]);

type SortField = "id" | "title" | "status" | "column";
type SortDirection = "asc" | "desc";

// Column visibility types
const ALL_LIST_COLUMNS = ["id", "title", "status", "column", "dependencies", "progress"] as const;
type ListColumn = typeof ALL_LIST_COLUMNS[number];

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

  return new Set(ALL_LIST_COLUMNS);
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

interface ListViewProps {
  tasks: Task[];
  onMoveTask: (id: string, column: Column) => Promise<Task>;
  onOpenDetail: (task: Task | TaskDetail) => void;
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
}: ListViewProps) {
  const [sortField, setSortField] = useState<SortField>("id");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<Column | null>(null);
  const [selectedColumn, setSelectedColumn] = useState<Column | null>(null);
  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";

  // Column visibility state - initialize from localStorage or default to all columns
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

  // Column dropdown state
  const [columnDropdownOpen, setColumnDropdownOpen] = useState(false);
  const columnDropdownRef = useRef<HTMLDivElement>(null);

  // Selection state - initialize from localStorage
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => readSelectedTaskIds(projectId));

  useEffect(() => {
    setVisibleColumns(readVisibleColumns(projectId));
    setHideDoneTasks(readHideDoneTasks(projectId));
    setCollapsedSections(readCollapsedSections(projectId));
    setSelectedTaskIds(readSelectedTaskIds(projectId));
  }, [projectId]);

  // Persist selection to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      setScopedItem("kb-dashboard-selected-tasks", JSON.stringify([...selectedTaskIds]), projectId);
    }
  }, [projectId, selectedTaskIds]);

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

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!columnDropdownOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (columnDropdownRef.current && !columnDropdownRef.current.contains(e.target as Node)) {
        setColumnDropdownOpen(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setColumnDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [columnDropdownOpen]);

  // Column display labels
  const COLUMN_LABELS_MAP: Record<ListColumn, string> = {
    id: "ID",
    title: "Title",
    status: "Status",
    column: "Column",
    dependencies: "Dependencies",
    progress: "Progress",
  };

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
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

    const sorted = [...columnFiltered].sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case "id":
          comparison = a.id.localeCompare(b.id);
          break;
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

    // Group by column while preserving sort order within each group
    const groups: Record<Column, Task[]> = {
      triage: [],
      todo: [],
      "in-progress": [],
      "in-review": [],
      done: [],
      archived: []
    };
    sorted.forEach(task => groups[task.column].push(task));
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
  const [isApplying, setIsApplying] = useState(false);

  // Handle apply bulk model update
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
        projectId,
      );

      // Optimistically update parent with returned tasks
      if (onTasksUpdated && result.updated.length > 0) {
        onTasksUpdated(result.updated);
      }

      addToast(`Updated ${result.count} task${result.count === 1 ? "" : "s"}`, "success");

      // Reset state
      clearSelection();
      setExecutorModel("__no_change__");
      setValidatorModel("__no_change__");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to update models", "error");
    } finally {
      setIsApplying(false);
    }
  }, [selectedTaskIds, tasks, executorModel, validatorModel, projectId, addToast, clearSelection, onTasksUpdated]);

  const handleRowClick = useCallback(
    (task: Task) => {
      onOpenDetail(task);
    },
    [onOpenDetail]
  );

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
        await onMoveTask(taskId, column);
      } catch (err) {
        addToast(getErrorMessage(err), "error");
      }
    },
    [onMoveTask, addToast]
  );

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return <ArrowUpDown size={14} className="sort-icon" />;
    return sortDirection === "asc" ? (
      <ArrowUp size={14} className="sort-icon active" />
    ) : (
      <ArrowDown size={14} className="sort-icon active" />
    );
  };

  return (
    <div className="list-view">
      <div className="list-toolbar">
        <div className="list-column-toggle" ref={columnDropdownRef}>
          <button
            className="btn btn-sm"
            onClick={() => setColumnDropdownOpen((prev) => !prev)}
            aria-expanded={columnDropdownOpen}
            aria-haspopup="menu"
          >
            <Columns3 size={14} />
            Columns
          </button>
          {columnDropdownOpen && (
            <div className="list-column-dropdown" role="menu">
              {ALL_LIST_COLUMNS.map((column) => {
                const isVisible = visibleColumns.has(column);
                const isLastVisible = isVisible && visibleColumns.size === 1;
                return (
                  <label
                    key={column}
                    className={`list-column-dropdown-item${isLastVisible ? " disabled" : ""}`}
                    role="menuitem"
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
          )}
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
        <div className="list-stats">
          {selectedColumn
            ? `${filteredCount} of ${tasks.length} tasks in ${COLUMN_LABELS[selectedColumn]}`
            : `${filteredCount} of ${tasks.length} tasks`}
          {hiddenCompletedCount > 0 && !selectedColumn && (
            <span className="list-stats-hidden"> ({hiddenCompletedCount} hidden)</span>
          )}
          {selectedColumn && (
            <button
              className="btn btn-sm"
              onClick={clearColumnFilter}
              aria-label="Clear column filter"
              style={{ marginLeft: "8px" }}
            >
              Clear
            </button>
          )}
        </div>
        {selectedTaskIds.size > 0 && (
          <div className="list-selection-stats">
            <span className="selection-count">{selectedTaskIds.size} selected</span>
            <button className="btn btn-sm btn-link" onClick={clearSelection}>
              Clear
            </button>
          </div>
        )}
        {/* Bulk Edit Toolbar */}
        {selectedTaskIds.size > 0 && availableModels && availableModels.length > 0 && (
          <div className="bulk-edit-toolbar">
            <span className="bulk-edit-label">Bulk Edit Models:</span>
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
                label="Validator Model"
                noChangeValue="__no_change__"
                noChangeLabel="No change"
                favoriteProviders={favoriteProviders}
                onToggleFavorite={onToggleFavorite}
                favoriteModels={favoriteModels}
                onToggleModelFavorite={onToggleModelFavorite}
              />
            </div>
            <button
              className="btn btn-primary btn-sm bulk-edit-apply-btn"
              onClick={handleApplyBulkUpdate}
              disabled={isApplying || (executorModel === "__no_change__" && validatorModel === "__no_change__")}
            >
              {isApplying ? "Applying..." : "Apply"}
            </button>
          </div>
        )}
        {onNewTask ? (
          <button className="btn btn-task-create btn-sm" onClick={onNewTask}>
            + New Task
          </button>
        ) : null}
      </div>

      <div className="list-drop-zones">
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
              <span className="drop-zone-dot" style={{ background: COLUMN_COLOR_MAP[column] }} />
              <span className="drop-zone-label">{COLUMN_LABELS[column]}</span>
              <span className="drop-zone-count">
                {showPartial ? `${visibleCount} of ${totalCount}` : totalCount}
              </span>
            </div>
          );
        })}
      </div>

      <div className="list-table-container">
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
                          const isSelectionMode = selectedTaskIds.size > 0;

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
                                <span className="list-card-spacer" />
                                {isStuckState ? (
                                  <span className="list-status-badge stuck">Stuck</span>
                                ) : hasStatus ? (
                                  <span className={`list-status-badge list-status-badge--${task.column}${isFailed ? " failed" : ""}${isAgentActive ? " pulsing" : ""}`}>
                                    {task.status}
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
                {visibleColumns.has("id") && (
                  <th className="list-header-cell" onClick={() => handleSort("id")}>
                    ID {getSortIcon("id")}
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
                      <th colSpan={visibleColumns.size + 1} className="list-section-cell">
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
                            <td colSpan={visibleColumns.size + 1} className="list-empty-cell">
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
                                }`}
                                onClick={() => handleRowClick(task)}
                                draggable={!isPaused}
                                onDragStart={(e) => handleDragStart(e, task)}
                                onDragEnd={handleDragEnd}
                                data-id={task.id}
                              >
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
                                {visibleColumns.has("id") && (
                                  <td className="list-cell list-cell-id">{task.id}</td>
                                )}
                                {visibleColumns.has("title") && (
                                  <td className="list-cell list-cell-title">
                                    {task.title || task.description}
                                  </td>
                                )}
                                {visibleColumns.has("status") && (
                                  <td className="list-cell">
                                    {isStuckState ? (
                                      <span className="list-status-badge stuck">
                                        Stuck
                                      </span>
                                    ) : task.status ? (
                                      <span
                                        className={`list-status-badge list-status-badge--${task.column}${isFailed ? " failed" : ""}${
                                          isAgentActive ? " pulsing" : ""
                                        }`}
                                      >
                                        {task.status}
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
    </div>
  );
}
