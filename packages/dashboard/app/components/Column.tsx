import { memo, useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useFlashOnIncrease } from "../hooks/useFlashOnIncrease";
import type { Task, TaskDetail, Column as ColumnType, TaskCreateInput } from "@fusion/core";
import { COLUMN_LABELS, COLUMN_DESCRIPTIONS, getErrorMessage } from "@fusion/core";
import { TaskCard } from "./TaskCard";
import { WorktreeGroup } from "./WorktreeGroup";
import { QuickEntryBox } from "./QuickEntryBox";
import { PluginSlot } from "./PluginSlot";
import { groupByWorktree } from "../utils/worktreeGrouping";
import type { ToastType } from "../hooks/useToast";
import { ChevronDown, ChevronUp, Archive, MoreVertical } from "lucide-react";
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
  onPauseTask?: (id: string) => Promise<Task>;
  onOpenDetail: (task: Task | TaskDetail) => void;
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
  onDeleteTask?: (id: string) => Promise<Task>;
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
  onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes") => void;
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
  /** Timestamp (ms) when task data was last confirmed fresh from the server. Used for freshness-aware stuck detection. */
  lastFetchTimeMs?: number;
  /** Lookup of workflow step IDs to display names, fetched once at board level. */
  workflowStepNameLookup?: ReadonlyMap<string, string>;
}

function ColumnComponent({ column, tasks, projectId, maxConcurrent, onMoveTask, onPauseTask, onOpenDetail, addToast, onQuickCreate, onNewTask, autoMerge, onToggleAutoMerge, globalPaused, onUpdateTask, onArchiveTask, onUnarchiveTask, onDeleteTask, onArchiveAllDone, collapsed, onToggleCollapse, allTasks, availableModels, onPlanningMode, onSubtaskBreakdown, onOpenDetailWithTab, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, isSearchActive, taskStuckTimeoutMs, onOpenMission, lastFetchTimeMs, workflowStepNameLookup }: ColumnProps) {
  const [dragOver, setDragOver] = useState(false);
  const [visibleTaskCount, setVisibleTaskCount] = useState(VISIBLE_TASKS_INITIAL);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isReplanning, setIsReplanning] = useState(false);
  const [isPausingAll, setIsPausingAll] = useState(false);
  const [isMovingAllToTodo, setIsMovingAllToTodo] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const countFlashing = useFlashOnIncrease(tasks.length);

  // Close the column dropdown menu when the user clicks anywhere else.
  useEffect(() => {
    if (!isMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIsMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [isMenuOpen]);

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
    } catch (err) {
      addToast(getErrorMessage(err), "error");
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

  const handleReplanAll = useCallback(async () => {
    setIsMenuOpen(false);
    if (tasks.length === 0) return;

    const confirmed = window.confirm(
      `Move all ${tasks.length} todo task${tasks.length === 1 ? "" : "s"} back to planning to be replanned?`,
    );
    if (!confirmed) return;

    setIsReplanning(true);
    try {
      // Issue moves in parallel — onMoveTask is per-task, no bulk endpoint.
      const results = await Promise.allSettled(
        tasks.map((task) => onMoveTask(task.id, "triage" as ColumnType)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const moved = results.length - failed;
      if (failed === 0) {
        addToast(`Moved ${moved} task${moved === 1 ? "" : "s"} to planning for replanning`, "success");
      } else {
        addToast(`Moved ${moved} of ${results.length} tasks; ${failed} failed`, "error");
      }
    } finally {
      setIsReplanning(false);
    }
  }, [tasks, onMoveTask, addToast]);

  const pauseEligibleTasks = useMemo(() => tasks.filter((task) => !task.paused), [tasks]);
  const pauseEligibleCount = pauseEligibleTasks.length;
  const hasColumnBulkActions = column === "todo" || column === "in-progress" || column === "in-review";
  const isMenuBusy = isReplanning || isPausingAll || isMovingAllToTodo;

  const handlePauseAll = useCallback(async () => {
    if (!onPauseTask) return;

    setIsMenuOpen(false);
    if (pauseEligibleCount === 0) return;

    const confirmed = window.confirm(
      `Stop all ${pauseEligibleCount} ${COLUMN_LABELS[column].toLowerCase()} task${pauseEligibleCount === 1 ? "" : "s"}?`,
    );
    if (!confirmed) return;

    setIsPausingAll(true);
    try {
      const results = await Promise.allSettled(
        pauseEligibleTasks.map((task) => onPauseTask(task.id)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const paused = results.length - failed;
      if (failed === 0) {
        addToast(`Stopped ${paused} task${paused === 1 ? "" : "s"}`, "success");
      } else {
        addToast(`Stopped ${paused} of ${results.length} tasks; ${failed} failed`, "error");
      }
    } finally {
      setIsPausingAll(false);
    }
  }, [onPauseTask, pauseEligibleCount, column, pauseEligibleTasks, addToast]);

  const handleMoveAllToTodo = useCallback(async () => {
    setIsMenuOpen(false);
    if (tasks.length === 0) return;

    const confirmed = window.confirm(
      `Move all ${tasks.length} ${COLUMN_LABELS[column].toLowerCase()} task${tasks.length === 1 ? "" : "s"} to Todo?`,
    );
    if (!confirmed) return;

    setIsMovingAllToTodo(true);
    try {
      const results = await Promise.allSettled(
        tasks.map((task) => onMoveTask(task.id, "todo")),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const moved = results.length - failed;
      if (failed === 0) {
        addToast(`Moved ${moved} task${moved === 1 ? "" : "s"} to Todo`, "success");
      } else {
        addToast(`Moved ${moved} of ${results.length} tasks to Todo; ${failed} failed`, "error");
      }
    } finally {
      setIsMovingAllToTodo(false);
    }
  }, [tasks, column, onMoveTask, addToast]);

  const handleArchiveAll = useCallback(async () => {
    if (!onArchiveAllDone) return;
    if (tasks.length === 0) return;

    const confirmed = window.confirm(`Archive all ${tasks.length} done tasks?`);
    if (!confirmed) return;

    try {
      const archived = await onArchiveAllDone();
      addToast(`Archived ${archived.length} tasks`, "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to archive tasks", "error");
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
        {hasColumnBulkActions && (
          <div className="column-menu" ref={menuRef}>
            <button
              type="button"
              className="btn btn-icon btn-sm"
              onClick={() => setIsMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              aria-label={`${COLUMN_LABELS[column]} column actions`}
              title="Column actions"
              disabled={isMenuBusy}
            >
              <MoreVertical size={16} />
            </button>
            {isMenuOpen && (
              <div className="column-menu-popover" role="menu">
                {column === "todo" && (
                  <button
                    type="button"
                    role="menuitem"
                    className="column-menu-item"
                    onClick={() => void handleReplanAll()}
                    disabled={tasks.length === 0 || isReplanning}
                  >
                    Replan All
                    <span className="column-menu-item-hint">
                      Move {tasks.length} task{tasks.length === 1 ? "" : "s"} to Planning
                    </span>
                  </button>
                )}
                {(column === "in-progress" || column === "in-review") && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="column-menu-item"
                      onClick={() => void handlePauseAll()}
                      disabled={pauseEligibleCount === 0 || isPausingAll || !onPauseTask}
                    >
                      Stop All
                      <span className="column-menu-item-hint">
                        {tasks.length === 0
                          ? "No tasks in this column"
                          : pauseEligibleCount === 0
                            ? "All tasks are already paused"
                            : `Pause ${pauseEligibleCount} active task${pauseEligibleCount === 1 ? "" : "s"}`}
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="column-menu-item"
                      onClick={() => void handleMoveAllToTodo()}
                      disabled={tasks.length === 0 || isMovingAllToTodo}
                    >
                      Move All to Todo
                      <span className="column-menu-item-hint">
                        Move {tasks.length} task{tasks.length === 1 ? "" : "s"} to Todo
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
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
                  lastFetchTimeMs={lastFetchTimeMs}
                  workflowStepNameLookup={workflowStepNameLookup}
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
                  onDeleteTask={onDeleteTask}
                  onOpenDetailWithTab={onOpenDetailWithTab}
                  taskStuckTimeoutMs={taskStuckTimeoutMs}
                  onOpenMission={onOpenMission}
                  onMoveTask={onMoveTask}
                  lastFetchTimeMs={lastFetchTimeMs}
                  workflowStepNameLookup={workflowStepNameLookup}
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
          <PluginSlot slotId="board-column-footer" projectId={projectId} />
        </div>
      )}
    </div>
  );
}

export const Column = memo(ColumnComponent);
Column.displayName = "Column";
