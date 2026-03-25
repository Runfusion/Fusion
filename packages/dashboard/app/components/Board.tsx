import type { Task, TaskDetail, TaskCreateInput, Column as ColumnType } from "@hai/core";
import { COLUMNS } from "@hai/core";
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
}

export function Board({ tasks, maxConcurrent, onMoveTask, onOpenDetail, addToast, isCreating, onCancelCreate, onCreateTask, onNewTask }: BoardProps) {
  return (
    <main className="board" id="board">
      {COLUMNS.map((col) => (
        <Column
          key={col}
          column={col}
          tasks={tasks.filter((t) => t.column === col)}
          allTasks={tasks}
          maxConcurrent={maxConcurrent}
          onMoveTask={onMoveTask}
          onOpenDetail={onOpenDetail}
          addToast={addToast}
          {...(col === "triage" ? { isCreating, onCancelCreate, onCreateTask, onNewTask } : {})}
        />
      ))}
    </main>
  );
}
