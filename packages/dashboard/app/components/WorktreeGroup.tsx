import { memo } from "react";
import type { Task, TaskDetail } from "@fusion/core";
import { ClipboardList, GitBranch } from "lucide-react";
import { TaskCard } from "./TaskCard";
import type { ToastType } from "../hooks/useToast";

interface WorktreeGroupProps {
  label: string;
  activeTasks: Task[];
  queuedTasks: Task[];
  projectId?: string;
  onOpenDetail: (task: TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[] }
  ) => Promise<Task>;
  onOpenDetailWithTab?: (task: TaskDetail, initialTab: "changes") => void;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
  /** Called when user clicks a mission badge on a task card */
  onOpenMission?: (missionId: string) => void;
}

function WorktreeGroupComponent({
  label,
  activeTasks,
  queuedTasks,
  projectId,
  onOpenDetail,
  addToast,
  globalPaused,
  onUpdateTask,
  onOpenDetailWithTab,
  taskStuckTimeoutMs,
  onOpenMission,
}: WorktreeGroupProps) {
  return (
    <div className="worktree-group">
      <div className="worktree-group-header">
        <span className="worktree-icon">
          {label === "Up Next" || label === "Unassigned" ? <ClipboardList size={14} /> : <GitBranch size={14} />}
        </span>
        <span className="worktree-label">{label}</span>
      </div>
      {activeTasks.map((task) => (
        <TaskCard key={task.id} task={task} projectId={projectId} onOpenDetail={onOpenDetail} addToast={addToast} globalPaused={globalPaused} onUpdateTask={onUpdateTask} onOpenDetailWithTab={onOpenDetailWithTab} taskStuckTimeoutMs={taskStuckTimeoutMs} onOpenMission={onOpenMission} />
      ))}
      {queuedTasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          projectId={projectId}
          queued
          onOpenDetail={onOpenDetail}
          addToast={addToast}
          globalPaused={globalPaused}
          onUpdateTask={onUpdateTask}
          onOpenDetailWithTab={onOpenDetailWithTab}
          taskStuckTimeoutMs={taskStuckTimeoutMs}
          onOpenMission={onOpenMission}
        />
      ))}
    </div>
  );
}

export const WorktreeGroup = memo(WorktreeGroupComponent);
WorktreeGroup.displayName = "WorktreeGroup";
