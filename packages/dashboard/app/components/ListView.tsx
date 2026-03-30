import { useState, useCallback, useMemo, Fragment } from "react";
import { LayoutGrid, List as ListIcon, ArrowUpDown, ArrowUp, ArrowDown, Search, Link } from "lucide-react";
import type { Task, TaskDetail, Column, TaskStep } from "@kb/core";
import { COLUMN_LABELS, COLUMNS } from "@kb/core";
import { fetchTaskDetail } from "../api";
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
}: ListViewProps) {
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [filter, setFilter] = useState("");
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<Column | null>(null);

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  }, [sortField]);

  const groupedTasks = useMemo(() => {
    const filtered = filter
      ? tasks.filter(
          (t) =>
            t.id.toLowerCase().includes(filter.toLowerCase()) ||
            (t.title && t.title.toLowerCase().includes(filter.toLowerCase())) ||
            t.description.toLowerCase().includes(filter.toLowerCase())
        )
      : tasks;

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
  }, [tasks, filter, sortField, sortDirection]);

  // Calculate total filtered count from groups
  const filteredCount = useMemo(() => {
    return Object.values(groupedTasks).reduce((sum, group) => sum + group.length, 0);
  }, [groupedTasks]);
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
        <div className="list-stats">
          {filteredCount} of {tasks.length} tasks
        </div>
        {onNewTask && (
          <button className="btn btn-primary btn-sm" onClick={onNewTask}>
            + New Task
          </button>
        )}
      </div>

      <div className="list-drop-zones">
        {COLUMNS.map((column) => (
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
              {tasks.filter((t) => t.column === column).length}
            </span>
          </div>
        ))}
      </div>

      <div className="list-table-container">
        {filteredCount === 0 ? (
          <div className="list-empty">
            {filter ? "No tasks match your filter" : "No tasks yet"}
          </div>
        ) : (
          <table className="list-table">
            <thead>
              <tr>
                <th className="list-header-cell" onClick={() => handleSort("id")}>
                  ID {getSortIcon("id")}
                </th>
                <th className="list-header-cell" onClick={() => handleSort("title")}>
                  Title {getSortIcon("title")}
                </th>
                <th className="list-header-cell" onClick={() => handleSort("status")}>
                  Status {getSortIcon("status")}
                </th>
                <th className="list-header-cell" onClick={() => handleSort("column")}>
                  Column {getSortIcon("column")}
                </th>
                <th className="list-header-cell" onClick={() => handleSort("createdAt")}>
                  Created {getSortIcon("createdAt")}
                </th>
                <th className="list-header-cell" onClick={() => handleSort("updatedAt")}>
                  Updated {getSortIcon("updatedAt")}
                </th>
                <th className="list-header-cell">Dependencies</th>
                <th className="list-header-cell">Progress</th>
              </tr>
            </thead>
            <tbody>
              {COLUMNS.map((column) => {
                const columnTasks = groupedTasks[column];
                const isEmpty = columnTasks.length === 0;

                // When filtering, hide empty sections entirely
                if (filter && isEmpty) return null;

                return (
                  <Fragment key={column}>
                    {/* Section Header */}
                    <tr className="list-section-header">
                      <th colSpan={8} className="list-section-cell">
                        <span className={`list-section-dot dot-${column}`} />
                        <span className="list-section-title">{COLUMN_LABELS[column]}</span>
                        <span className="list-section-count">{columnTasks.length}</span>
                      </th>
                    </tr>

                    {/* Task Rows */}
                    {isEmpty ? (
                      <tr className="list-section-empty">
                        <td colSpan={8} className="list-empty-cell">
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
                            <td className="list-cell list-cell-id">{task.id}</td>
                            <td className="list-cell list-cell-title">
                              {task.title || task.description.slice(0, 60) + (task.description.length > 60 ? "…" : "")}
                            </td>
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
                            <td className="list-cell list-cell-date">{formatDate(task.createdAt)}</td>
                            <td className="list-cell list-cell-date">{formatDate(task.updatedAt)}</td>
                            <td className="list-cell list-cell-deps">
                              {task.dependencies && task.dependencies.length > 0 ? (
                                <span className="list-dep-badge" title={task.dependencies.join(", ")}>
                                  <Link size={12} /> {task.dependencies.length}
                                </span>
                              ) : (
                                "-"
                              )}
                            </td>
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
