import { memo, useMemo, useState, useCallback, useEffect } from "react";
import { useFlashOnIncrease } from "../hooks/useFlashOnIncrease";
import type { Task, TaskDetail, Column as ColumnType, TaskCreateInput } from "@fusion/core";
import { COLUMN_LABELS, COLUMN_DESCRIPTIONS } from "@fusion/core";
import { TaskCard } from "./TaskCard";
import { WorktreeGroup } from "./WorktreeGroup";
import { QuickEntryBox } from "./QuickEntryBox";
import { groupByWorktree } from "../utils/worktreeGrouping";
import type { ToastType } from "../hooks/useToast";
import { ChevronDown, ChevronUp, Archive } from "lucide-react";
import type { ModelInfo } from "../api";

const PAGINATED_COLUMN_THRESHOLD = 100;
const VISIBLE_TASKS_INITIAL = 50;
const VISIBLE_TASKS_INCREMENT = 25;

interface ColumnProps {
  column: ColumnType;
  tasks: Task[];
  projectId?: string;
  maxConcurrent: number;
  onMoveTask: (id: string, column: ColumnType) => Promise<Task>;
  onOpenDetail: (task: TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
  onQuickCreate?: (input: TaskCreateInput) => Promise<Task | void>;
  onNewTask?: () => void;
  autoMerge?: boolean;
  onToggleAutoMerge?: () => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[] }
  ) => Promise<Task>;
  onArchiveTask?: (id: string) => Promise<Task>;
  onUnarchiveTask?: (id: string) => Promise<Task>;
  onArchiveAllDone?: () => Promise<Task[]>;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  allTasks?: Task[];
  availableModels?: ModelInfo[];
  /**
   * Called when the user clicks the "Plan" button in the inline create card.
   */
  onPlanningMode?: (initialPlan: string) => void;
  /**
   * Called when the user clicks the "Subtask" button in the inline create card.
   */
  onSubtaskBreakdown?: (description: string) => void;
  onOpenDetailWithTab?: (task: TaskDetail, initialTab: "changes") => void;
  favoriteProviders?: string[];
  favoriteModels?: string[];
  onToggleFavorite?: (provider: string) => void;
  onToggleModelFavorite?: (modelId: string) => void;
  /** When true, search is active — bypass pagination so all matching tasks are visible. */
  isSearchActive?: boolean;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
  /** Called when user clicks a mission badge on a task card */
  onOpenMission?: (missionId: string) => void;
}

function ColumnComponent({ column, tasks, projectId, maxConcurrent, onMoveTask, onOpenDetail, addToast, onQuickCreate, onNewTask, autoMerge, onToggleAutoMerge, globalPaused, onUpdateTask, onArchiveTask, onUnarchiveTask, onArchiveAllDone, collapsed, onToggleCollapse, allTasks, availableModels, onPlanningMode, onSubtaskBreakdown, onOpenDetailWithTab, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, isSearchActive, taskStuckTimeoutMs, onOpenMission }: ColumnProps) {
  const [dragOver, setDragOver] = useState(false);
  const [visibleTaskCount, setVisibleTaskCount] = useState(VISIBLE_TASKS_INITIAL);
  const countFlashing = useFlashOnIncrease(tasks.length);

  // Archived column is collapsed by default - don't show drag state when collapsed
  const isArchived = column === "archived";
  const isCollapsed = isArchived && collapsed;
  // When search is active, skip pagination so all matching tasks are visible
  const shouldPaginate = !isArchived && !isSearchActive && column !== "in-progress" && tasks.length > PAGINATED_COLUMN_THRESHOLD;

  useEffect(() => {
    setVisibleTaskCount((current) => {
      if (column === "in-progress" || isArchived || tasks.length <= PAGINATED_COLUMN_THRESHOLD) {
        return VISIBLE_TASKS_INITIAL;
      }

      return Math.min(Math.max(current, VISIBLE_TASKS_INITIAL), tasks.length);
    });
  }, [column, isArchived, tasks.length]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Don't allow dropping into archived column via drag-drop
    if (isArchived) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  }, [isArchived]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (!el.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const taskId = e.dataTransfer.getData("text/plain");
    if (!taskId) return;

    // Check if task is already in this column - if so, skip the API call
    const task = tasks.find(t => t.id === taskId);
    if (task && task.column === column) {
      return; // No-op: task is already in this column
    }

    try {
      await onMoveTask(taskId, column);
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [column, onMoveTask, addToast, tasks]);

  const worktreeGroups = useMemo(() => {
    if (column !== "in-progress") return [];
    return groupByWorktree(tasks, tasks, maxConcurrent);
  }, [column, tasks, maxConcurrent]);

  const visibleTasks = useMemo(() => {
    if (!shouldPaginate) return tasks;
    return tasks.slice(0, visibleTaskCount);
  }, [shouldPaginate, tasks, visibleTaskCount]);

  const hiddenTaskCount = Math.max(0, tasks.length - visibleTasks.length);

  const handleLoadMore = useCallback(() => {
    setVisibleTaskCount((current) => Math.min(current + VISIBLE_TASKS_INCREMENT, tasks.length));
  }, [tasks.length]);

  const handleArchiveAll = useCallback(async () => {
    if (!onArchiveAllDone) return;
    if (tasks.length === 0) return;

    const confirmed = window.confirm(`Archive all ${tasks.length} done tasks?`);
    if (!confirmed) return;

    try {
      const archived = await onArchiveAllDone();
      addToast(`Archived ${archived.length} tasks`, "success");
    } catch (err: any) {
      addToast(err.message || "Failed to archive tasks", "error");
    }
  }, [onArchiveAllDone, tasks.length, addToast]);

  return (
    <div
      className={`column${dragOver ? " drag-over" : ""}${isArchived ? " column-archived" : ""}${isCollapsed ? " column-collapsed" : ""}`}
      data-column={column}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="column-header">
        <div className={`column-dot dot-${column}`} />
        <h2>{COLUMN_LABELS[column]}</h2>
        <span className={`column-count${countFlashing ? " count-flash" : ""}`}>{tasks.length}</span>
        {column === "in-review" && onToggleAutoMerge && (
          <label className="auto-merge-toggle" title={autoMerge ? "Auto-merge enabled" : "Auto-merge disabled"}>
            <input
              type="checkbox"
              checked={!!autoMerge}
              onChange={onToggleAutoMerge}
            />
            <span className="toggle-slider" />
            <span className="toggle-label">Auto-merge</span>
          </label>
        )}
        {onNewTask && (
          <button className="btn btn-task-create btn-sm" onClick={onNewTask}>
            + New Task
          </button>
        )}
        {column === "done" && onArchiveAllDone && (
          <button
            className="btn btn-icon btn-sm"
            onClick={handleArchiveAll}
            disabled={tasks.length === 0}
            title="Archive all done tasks"
            aria-label="Archive all done tasks"
          >
            <Archive size={16} />
          </button>
        )}
        {isArchived && onToggleCollapse && (
          <button
            className="btn btn-icon btn-sm"
            onClick={onToggleCollapse}
            title={collapsed ? "Expand archived tasks" : "Collapse archived tasks"}
            aria-label={collapsed ? "Expand archived tasks" : "Collapse archived tasks"}
          >
            {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
        )}
      </div>
      {!isCollapsed && <p className="column-desc">{COLUMN_DESCRIPTIONS[column]}</p>}
      {!isCollapsed && (
        <div className="column-body">
          {column === "triage" && onQuickCreate && (
            <QuickEntryBox 
              onCreate={onQuickCreate} 
              addToast={addToast} 
              tasks={allTasks ?? []}
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
          )}
          {column === "in-progress" ? (
            worktreeGroups.length === 0 ? (
              <div className="empty-column">No tasks</div>
            ) : (
              worktreeGroups.map((group) => (
                <WorktreeGroup
                  key={group.label}
                  label={group.label}
                  activeTasks={group.activeTasks}
                  queuedTasks={group.queuedTasks}
                  projectId={projectId}
                  onOpenDetail={onOpenDetail}
                  addToast={addToast}
                  globalPaused={globalPaused}
                  onUpdateTask={onUpdateTask}
                  onOpenDetailWithTab={onOpenDetailWithTab}
                  taskStuckTimeoutMs={taskStuckTimeoutMs}
                  onOpenMission={onOpenMission}
                />
              ))
            )
          ) : tasks.length === 0 ? (
            <div className="empty-column">No tasks</div>
          ) : (
            <>
              {visibleTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  projectId={projectId}
                  onOpenDetail={onOpenDetail}
                  addToast={addToast}
                  globalPaused={globalPaused}
                  onUpdateTask={onUpdateTask}
                  onArchiveTask={onArchiveTask}
                  onUnarchiveTask={onUnarchiveTask}
                  onOpenDetailWithTab={onOpenDetailWithTab}
                  taskStuckTimeoutMs={taskStuckTimeoutMs}
                  onOpenMission={onOpenMission}
                />
              ))}
              {shouldPaginate && hiddenTaskCount > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleLoadMore}
                >
                  Load {Math.min(VISIBLE_TASKS_INCREMENT, hiddenTaskCount)} more ({hiddenTaskCount} remaining)
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export const Column = memo(ColumnComponent);
Column.displayName = "Column";
