import { useState, useCallback, useMemo, Fragment, useEffect, useRef } from "react";
import { LayoutGrid, List as ListIcon, ArrowUpDown, ArrowUp, ArrowDown, Search, Link, Columns3, EyeOff, Eye } from "lucide-react";
import type { Task, TaskDetail, Column, TaskStep } from "@kb/core";
import { COLUMN_LABELS, COLUMNS } from "@kb/core";
import { fetchTaskDetail } from "../api";
import { InlineCreateCard } from "./InlineCreateCard";
import type { ToastType } from "../hooks/useToast";

const COLUMN_COLOR_MAP: Record<Column, string> = {
  triage: "var(--triage)",
  todo: "var(--todo)",
  "in-progress": "var(--in-progress)",
  "in-review": "var(--in-review)",
  done: "var(--done)",
};

const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "specifying"]);

type SortField = "id" | "title" | "status" | "column" | "createdAt" | "updatedAt";
type SortDirection = "asc" | "desc";

// Column visibility types
const ALL_LIST_COLUMNS = ["id", "title", "status", "column", "createdAt", "updatedAt", "dependencies", "progress"] as const;
type ListColumn = typeof ALL_LIST_COLUMNS[number];

interface ListViewProps {
  tasks: Task[];
  onMoveTask: (id: string, column: Column) => Promise<Task>;
  onOpenDetail: (task: TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
  globalPaused?: boolean;
  isCreating?: boolean;
  onCancelCreate?: () => void;
  onCreateTask?: (input: { description: string; column: Column; dependencies?: string[] }) => Promise<Task>;
  onNewTask?: () => void;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getStepProgress(steps: TaskStep[]): string {
  if (steps.length === 0) return "-";
  const done = steps.filter((s) => s.status === "done").length;
  return `${done}/${steps.length}`;
}

function getStepProgressPercent(steps: TaskStep[]): number {
  if (steps.length === 0) return 0;
  const done = steps.filter((s) => s.status === "done").length;
  return (done / steps.length) * 100;
}

export function ListView({
  tasks,
  onMoveTask,
  onOpenDetail,
  addToast,
  globalPaused,
  onNewTask,
  isCreating,
  onCancelCreate,
  onCreateTask,
}: ListViewProps) {
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [filter, setFilter] = useState("");
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<Column | null>(null);

  // Column visibility state - initialize from localStorage or default to all columns
  const [visibleColumns, setVisibleColumns] = useState<Set<ListColumn>>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("kb-dashboard-list-columns");
        if (saved) {
          const parsed = JSON.parse(saved) as ListColumn[];
          // Validate that all saved columns are valid ListColumn values
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
    }
    return new Set(ALL_LIST_COLUMNS);
  });

  // Hide done tasks state - initialize from localStorage
  const [hideDoneTasks, setHideDoneTasks] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("kb-dashboard-hide-done");
        if (saved !== null) {
          return saved === "true";
        }
      } catch {
        // Invalid localStorage data - fall through to default
      }
    }
    return false; // Default: show done tasks
  });

  // Persist column visibility changes to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("kb-dashboard-list-columns", JSON.stringify([...visibleColumns]));
    }
  }, [visibleColumns]);

  // Persist hide done tasks state to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("kb-dashboard-hide-done", hideDoneTasks.toString());
    }
  }, [hideDoneTasks]);

  // Column dropdown state
  const [columnDropdownOpen, setColumnDropdownOpen] = useState(false);
  const columnDropdownRef = useRef<HTMLDivElement>(null);

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
    createdAt: "Created",
    updatedAt: "Updated",
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

  const groupedTasks = useMemo(() => {
    // First filter by search filter
    let filtered = filter
      ? tasks.filter(
          (t) =>
            t.id.toLowerCase().includes(filter.toLowerCase()) ||
            (t.title && t.title.toLowerCase().includes(filter.toLowerCase())) ||
            t.description.toLowerCase().includes(filter.toLowerCase())
        )
      : [...tasks];

    // Then filter out done tasks if hideDoneTasks is enabled
    if (hideDoneTasks) {
      filtered = filtered.filter((t) => t.column !== "done");
    }

    const sorted = [...filtered].sort((a, b) => {
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
        case "createdAt":
          comparison = a.createdAt.localeCompare(b.createdAt);
          break;
        case "updatedAt":
          comparison = a.updatedAt.localeCompare(b.updatedAt);
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
      done: []
    };
    sorted.forEach(task => groups[task.column].push(task));
    return groups;
  }, [tasks, filter, sortField, sortDirection, hideDoneTasks]);

  // Calculate total filtered count from groups
  const filteredCount = useMemo(() => {
    return Object.values(groupedTasks).reduce((sum, group) => sum + group.length, 0);
  }, [groupedTasks]);

  // Calculate done task counts for stats display
  const doneTaskCount = useMemo(() => {
    return tasks.filter((t) => t.column === "done").length;
  }, [tasks]);

  // Calculate hidden done tasks count
  const hiddenDoneCount = useMemo(() => {
    if (!hideDoneTasks) return 0;
    return doneTaskCount;
  }, [hideDoneTasks, doneTaskCount]);
  const handleRowClick = useCallback(
    async (task: Task) => {
      try {
        const detail = await fetchTaskDetail(task.id);
        onOpenDetail(detail);
      } catch (err: any) {
        addToast("Failed to load task details", "error");
      }
    },
    [onOpenDetail, addToast]
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

      try {
        await onMoveTask(taskId, column);
      } catch (err: any) {
        addToast(err.message, "error");
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
        <div className="list-filter">
          <Search size={14} className="filter-icon" />
          <input
            type="text"
            placeholder="Filter by ID or title..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="filter-input"
          />
          {filter && (
            <button className="filter-clear" onClick={() => setFilter("")}>
              ×
            </button>
          )}
        </div>
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
          {filteredCount} of {tasks.length} tasks
          {hiddenDoneCount > 0 && (
            <span className="list-stats-hidden"> ({hiddenDoneCount} done hidden)</span>
          )}
        </div>
        {onNewTask && (
          <button className="btn btn-primary btn-sm" onClick={onNewTask}>
            + New Task
          </button>
        )}
      </div>

      <div className="list-drop-zones">
        {COLUMNS.map((column) => {
          const totalCount = tasks.filter((t) => t.column === column).length;
          const visibleCount = hideDoneTasks && column === "done" ? 0 : totalCount;
          const showPartial = hideDoneTasks && column === "done" && totalCount > 0;

          return (
            <div
              key={column}
              className={`list-drop-zone${dragOverColumn === column ? " drag-over" : ""}`}
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
        {filteredCount === 0 && !isCreating ? (
          <div className="list-empty">
            {filter ? "No tasks match your filter" : "No tasks yet"}
          </div>
        ) : (
          <table className="list-table">
            <thead>
              <tr>
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
                {visibleColumns.has("createdAt") && (
                  <th className="list-header-cell" onClick={() => handleSort("createdAt")}>
                    Created {getSortIcon("createdAt")}
                  </th>
                )}
                {visibleColumns.has("updatedAt") && (
                  <th className="list-header-cell" onClick={() => handleSort("updatedAt")}>
                    Updated {getSortIcon("updatedAt")}
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
                // Skip done column section when hideDoneTasks is enabled
                if (hideDoneTasks && column === "done") return null;

                const columnTasks = groupedTasks[column];
                const isEmpty = columnTasks.length === 0;

                // When filtering, hide empty sections entirely (except triage when creating)
                if (filter && isEmpty && !(column === "triage" && isCreating)) return null;

                return (
                  <Fragment key={column}>
                    {/* Section Header */}
                    <tr className="list-section-header">
                      <th colSpan={visibleColumns.size} className="list-section-cell">
                        <span className={`list-section-dot dot-${column}`} />
                        <span className="list-section-title">{COLUMN_LABELS[column]}</span>
                        <span className="list-section-count">{columnTasks.length}</span>
                      </th>
                    </tr>

                    {/* Inline Create Card for Triage column */}
                    {column === "triage" && isCreating && onCancelCreate && onCreateTask && (
                      <tr className="list-inline-create-row">
                        <td colSpan={visibleColumns.size} className="list-inline-create-cell">
                          <InlineCreateCard
                            tasks={tasks}
                            onSubmit={onCreateTask}
                            onCancel={onCancelCreate}
                            addToast={addToast}
                          />
                        </td>
                      </tr>
                    )}

                    {/* Task Rows */}
                    {isEmpty ? (
                      <tr className="list-section-empty">
                        <td colSpan={visibleColumns.size} className="list-empty-cell">
                          No tasks
                        </td>
                      </tr>
                    ) : (
                      columnTasks.map((task) => {
                        const isFailed = task.status === "failed";
                        const isPaused = task.paused === true;
                        const isAgentActive =
                          !globalPaused &&
                          !isFailed &&
                          !isPaused &&
                          (task.column === "in-progress" || ACTIVE_STATUSES.has(task.status as string));
                        const isDragging = draggingTaskId === task.id;

                        return (
                          <tr
                            key={task.id}
                            className={`list-row${isFailed ? " failed" : ""}${isPaused ? " paused" : ""}${
                              isAgentActive ? " agent-active" : ""
                            }${isDragging ? " dragging" : ""}`}
                            onClick={() => handleRowClick(task)}
                            draggable={!isPaused}
                            onDragStart={(e) => handleDragStart(e, task)}
                            onDragEnd={handleDragEnd}
                            data-id={task.id}
                          >
                            {visibleColumns.has("id") && (
                              <td className="list-cell list-cell-id">{task.id}</td>
                            )}
                            {visibleColumns.has("title") && (
                              <td className="list-cell list-cell-title">
                                {task.title || task.description.slice(0, 60) + (task.description.length > 60 ? "…" : "")}
                              </td>
                            )}
                            {visibleColumns.has("status") && (
                              <td className="list-cell">
                                {task.status ? (
                                  <span
                                    className={`list-status-badge${isFailed ? " failed" : ""}${
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
                            {visibleColumns.has("createdAt") && (
                              <td className="list-cell list-cell-date">{formatDate(task.createdAt)}</td>
                            )}
                            {visibleColumns.has("updatedAt") && (
                              <td className="list-cell list-cell-date">{formatDate(task.updatedAt)}</td>
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
                                {task.steps.length > 0 ? (
                                  <div className="list-progress">
                                    <div className="list-progress-bar">
                                      <div
                                        className="list-progress-fill"
                                        style={{
                                          width: `${getStepProgressPercent(task.steps)}%`,
                                          backgroundColor: COLUMN_COLOR_MAP[task.column],
                                        }}
                                      />
                                    </div>
                                    <span className="list-progress-label">{getStepProgress(task.steps)}</span>
                                  </div>
                                ) : (
                                  "-"
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })
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
