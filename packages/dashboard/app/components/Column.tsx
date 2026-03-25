import { useState, useCallback } from "react";
import type { Task, TaskDetail, TaskCreateInput, Column as ColumnType } from "@hai/core";
import { COLUMN_LABELS, COLUMN_DESCRIPTIONS } from "@hai/core";
import { TaskCard } from "./TaskCard";
import { WorktreeGroup } from "./WorktreeGroup";
import { InlineCreateCard } from "./InlineCreateCard";
import { groupByWorktree } from "../utils/worktreeGrouping";
import type { ToastType } from "../hooks/useToast";

interface ColumnProps {
  column: ColumnType;
  tasks: Task[];
  allTasks: Task[];
  maxConcurrent: number;
  onMoveTask: (id: string, column: ColumnType) => Promise<Task>;
  onOpenDetail: (task: TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
  isCreating?: boolean;
  onCancelCreate?: () => void;
  onCreateTask?: (input: TaskCreateInput) => Promise<Task>;
}

export function Column({ column, tasks, allTasks, maxConcurrent, onMoveTask, onOpenDetail, addToast, isCreating, onCancelCreate, onCreateTask }: ColumnProps) {
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  }, []);

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

    try {
      await onMoveTask(taskId, column);
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [column, onMoveTask, addToast]);

  return (
    <div
      className={`column${dragOver ? " drag-over" : ""}`}
      data-column={column}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="column-header">
        <div className={`column-dot dot-${column}`} />
        <h2>{COLUMN_LABELS[column]}</h2>
        <span className="column-count">{tasks.length}</span>
      </div>
      <p className="column-desc">{COLUMN_DESCRIPTIONS[column]}</p>
      <div className="column-body">
        {column === "todo" && isCreating && onCancelCreate && onCreateTask && (
          <InlineCreateCard
            tasks={allTasks}
            onSubmit={onCreateTask}
            onCancel={onCancelCreate}
            addToast={addToast}
          />
        )}
        {column === "in-progress" ? (
          (() => {
            const groups = groupByWorktree(tasks, allTasks, maxConcurrent);
            return groups.length === 0 ? (
              <div className="empty-column">No tasks</div>
            ) : (
              groups.map((group) => (
                <WorktreeGroup
                  key={group.label}
                  label={group.label}
                  activeTasks={group.activeTasks}
                  queuedTasks={group.queuedTasks}
                  onOpenDetail={onOpenDetail}
                  addToast={addToast}
                />
              ))
            );
          })()
        ) : tasks.length === 0 ? (
          <div className="empty-column">No tasks</div>
        ) : (
          tasks.map((task) => (
            <TaskCard key={task.id} task={task} onOpenDetail={onOpenDetail} addToast={addToast} />
          ))
        )}
      </div>
    </div>
  );
}
