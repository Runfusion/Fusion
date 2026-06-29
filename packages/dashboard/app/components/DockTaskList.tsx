import { useCallback } from "react";
import type { Task, TaskDetail } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { TaskCard } from "./TaskCard";
import "./DockTaskList.css";

export interface DockTaskListProps {
  tasks: Array<Task | TaskDetail>;
  projectId?: string;
  onOpenTask?: (task: Task | TaskDetail) => void;
  addToast?: (message: string, type?: ToastType) => void;
  prAuthAvailable?: boolean;
  autoMergeEnabled?: boolean;
}

/*
FNXC:RightDockTasks 2026-06-28-16:50:
The Tasks tab empty state is a real compact task list, not a blank placeholder. TaskCard's own open callback is routed directly to `onOpenTask` so clicking the card opens the dock Tasks detail with the back button; no wrapper click handler competes with TaskCard or the full-panel detail modal.
*/
export function DockTaskList({
  tasks,
  projectId,
  onOpenTask,
  addToast = () => {},
  prAuthAvailable = false,
  autoMergeEnabled = false,
}: DockTaskListProps) {
  const handleOpenTask = useCallback((task: Task | TaskDetail) => {
    onOpenTask?.(task);
  }, [onOpenTask]);

  if (tasks.length === 0) {
    return (
      <div className="dock-task-list dock-task-list--empty" data-testid="dock-task-list">
        <p className="dock-task-list__empty-title">No tasks yet</p>
        <p className="dock-task-list__empty-copy">Tasks you create or import will appear here for quick right-sidebar review.</p>
      </div>
    );
  }

  return (
    <div className="dock-task-list" data-testid="dock-task-list">
      {tasks.map((task) => (
        <div key={task.id} className="dock-task-list__row" data-testid={`dock-task-list-row-${task.id}`}>
          <TaskCard
            task={task as Task}
            projectId={projectId}
            onOpenDetail={handleOpenTask}
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
