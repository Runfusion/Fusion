import { useCallback, useMemo, useState } from "react";
import type { GithubIssueAction, Task, TaskDetail } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { TaskCard } from "./TaskCard";
import "./DockTaskList.css";

export interface DockTaskListProps {
  tasks: Array<Task | TaskDetail>;
  projectId?: string;
  onOpenTask?: (task: Task | TaskDetail) => void;
  onDeleteTask?: (id: string, options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; githubIssueAction?: GithubIssueAction; allowResurrection?: boolean }) => Promise<Task>;
  addToast?: (message: string, type?: ToastType) => void;
  prAuthAvailable?: boolean;
  autoMergeEnabled?: boolean;
}

/*
FNXC:RightDockTasks 2026-06-28-16:50:
The Tasks tab empty state is a real compact task list, not a blank placeholder. TaskCard's own open callback is routed directly to `onOpenTask` so clicking the card opens the dock Tasks detail with the back button; no wrapper click handler competes with TaskCard or the full-panel detail modal.

FNXC:RightDockTasks 2026-06-28-18:25:
The compact right-dock Tasks list is an active-work queue by default. It hides completed work until the local Show Done toggle is enabled and never renders archived tasks, including in the expanded dock modal that reuses this component.
*/
export function DockTaskList({
  tasks,
  projectId,
  onOpenTask,
  onDeleteTask,
  addToast = () => {},
  prAuthAvailable = false,
  autoMergeEnabled = false,
}: DockTaskListProps) {
  const [showDone, setShowDone] = useState(false);

  const handleOpenTask = useCallback((task: Task | TaskDetail) => {
    onOpenTask?.(task);
  }, [onOpenTask]);

  const doneTasks = useMemo(() => tasks.filter((task) => task.column === "done"), [tasks]);
  const visibleTasks = useMemo(() => tasks.filter((task) => {
    if (task.column === "archived") return false;
    if (task.column === "done") return showDone;
    return true;
  }), [showDone, tasks]);
  const hasDoneTasks = doneTasks.length > 0;
  const isEmpty = visibleTasks.length === 0;
  const emptyTitle = tasks.length === 0 ? "No tasks yet" : "No active tasks";
  const emptyCopy = tasks.length === 0
    ? "Tasks you create or import will appear here for quick right-sidebar review."
    : hasDoneTasks
      ? "Completed tasks are hidden until you choose Show Done. Archived tasks stay out of this compact sidebar."
      : "Archived tasks stay out of this compact sidebar. Active tasks will appear here when work is available.";
  const toggleLabel = showDone ? "Hide Done" : "Show Done";

  return (
    <div className={`dock-task-list${isEmpty ? " dock-task-list--empty" : ""}`} data-testid="dock-task-list">
      {hasDoneTasks ? (
        <div className="dock-task-list__controls">
          <button
            type="button"
            className="btn dock-task-list__toggle-done"
            aria-pressed={showDone}
            onClick={() => setShowDone((current) => !current)}
          >
            {toggleLabel}
          </button>
        </div>
      ) : null}
      {isEmpty ? (
        <div className="dock-task-list__empty" data-testid="dock-task-list-empty">
          <p className="dock-task-list__empty-title">{emptyTitle}</p>
          <p className="dock-task-list__empty-copy">{emptyCopy}</p>
        </div>
      ) : visibleTasks.map((task, index) => (
        <div key={`${task.id}-${index}`} className="dock-task-list__row" data-testid={`dock-task-list-row-${task.id}`}>
          <TaskCard
            task={task as Task}
            projectId={projectId}
            onOpenDetail={handleOpenTask}
            /*
            FNXC:TaskDeletion 2026-07-12-18:04:
            Every task Delete affordance must reach the shared confirm→delete flow. The right-dock Tasks list is a TaskCard host, so it must pass onDeleteTask instead of rendering cards that silently lack/delete-disable the destructive path.
            */
            onDeleteTask={onDeleteTask}
            addToast={addToast}
            disableDrag={true}
            prAuthAvailable={prAuthAvailable}
            autoMergeEnabled={autoMergeEnabled}
          />
        </div>
      ))}
    </div>
  );
}
