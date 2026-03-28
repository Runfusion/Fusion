import type { Task, TaskDetail, TaskCreateInput, Column as ColumnType } from "@kb/core";
import { COLUMNS } from "@kb/core";
import { Column } from "./Column";
import type { ToastType } from "../hooks/useToast";

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
  engineStopped?: boolean;
}

export function Board({ tasks, maxConcurrent, onMoveTask, onOpenDetail, addToast, isCreating, onCancelCreate, onCreateTask, onNewTask, autoMerge, onToggleAutoMerge, engineStopped }: BoardProps) {
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
          engineStopped={engineStopped}
          {...(col === "triage" ? { isCreating, onCancelCreate, onCreateTask, onNewTask } : {})}
          {...(col === "in-review" ? { autoMerge, onToggleAutoMerge } : {})}
        />
      ))}
    </main>
  );
}
