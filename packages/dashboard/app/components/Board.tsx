import type { Task, TaskDetail, TaskCreateInput, Column as ColumnType } from "@kb/core";
import { COLUMNS } from "@kb/core";
import { Column } from "./Column";
import type { ToastType } from "../hooks/useToast";
import { useState } from "react";

interface BoardProps {
  tasks: Task[];
  maxConcurrent: number;
  onMoveTask: (id: string, column: ColumnType) => Promise<Task>;
  onOpenDetail: (task: TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
  isCreating: boolean;
  onCancelCreate: () => void;
  onCreateTask: (input: TaskCreateInput) => Promise<Task>;
  onNewTask: () => void;
  autoMerge: boolean;
  onToggleAutoMerge: () => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[] }
  ) => Promise<Task>;
  onArchiveTask?: (id: string) => Promise<Task>;
  onUnarchiveTask?: (id: string) => Promise<Task>;
}

export function Board({ tasks, maxConcurrent, onMoveTask, onOpenDetail, addToast, isCreating, onCancelCreate, onCreateTask, onNewTask, autoMerge, onToggleAutoMerge, globalPaused, onUpdateTask, onArchiveTask, onUnarchiveTask }: BoardProps) {
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);

  return (
    <main className="board" id="board">
      {COLUMNS.map((col) => (
        <Column
          key={col}
          column={col}
          tasks={tasks
            .filter((t) => t.column === col)
            .sort((a, b) => {
              // Tasks with columnMovedAt sort descending (most recent first)
              // Tasks without it (legacy) fall to the bottom, sorted by createdAt ascending
              if (a.columnMovedAt && b.columnMovedAt) {
                return b.columnMovedAt.localeCompare(a.columnMovedAt);
              }
              if (a.columnMovedAt && !b.columnMovedAt) return -1;
              if (!a.columnMovedAt && b.columnMovedAt) return 1;
              return a.createdAt.localeCompare(b.createdAt);
            })}
          allTasks={tasks}
          maxConcurrent={maxConcurrent}
          onMoveTask={onMoveTask}
          onOpenDetail={onOpenDetail}
          addToast={addToast}
          globalPaused={globalPaused}
          onUpdateTask={onUpdateTask}
          onArchiveTask={onArchiveTask}
          onUnarchiveTask={onUnarchiveTask}
          {...(col === "triage" ? { isCreating, onCancelCreate, onCreateTask, onNewTask } : {})}
          {...(col === "in-review" ? { autoMerge, onToggleAutoMerge } : {})}
          {...(col === "archived" ? { collapsed: archivedCollapsed, onToggleCollapse: () => setArchivedCollapsed(!archivedCollapsed) } : {})}
        />
      ))}
    </main>
  );
}
