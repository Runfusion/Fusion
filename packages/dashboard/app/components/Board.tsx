import type { Task, TaskDetail, Column as ColumnType } from "@kb/core";
import { COLUMNS } from "@kb/core";
import { Column } from "./Column";
import type { ToastType } from "../hooks/useToast";
import { useState, useMemo, useCallback, useRef } from "react";

interface BoardProps {
  tasks: Task[];
  maxConcurrent: number;
  onMoveTask: (id: string, column: ColumnType) => Promise<Task>;
  onOpenDetail: (task: TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
  onQuickCreate?: (description: string) => Promise<void>;
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
  searchQuery?: string;
}

function sortTasksForColumn(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.columnMovedAt && b.columnMovedAt) {
      return b.columnMovedAt.localeCompare(a.columnMovedAt);
    }
    if (a.columnMovedAt && !b.columnMovedAt) return -1;
    if (!a.columnMovedAt && b.columnMovedAt) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function areTaskArraysEqual(previous: Task[], next: Task[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((task, index) => task === next[index]);
}

export function Board({ tasks, maxConcurrent, onMoveTask, onOpenDetail, addToast, onQuickCreate, onNewTask, autoMerge, onToggleAutoMerge, globalPaused, onUpdateTask, onArchiveTask, onUnarchiveTask, searchQuery = "" }: BoardProps) {
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);
  const tasksByColumnCacheRef = useRef<Record<ColumnType, Task[]>>({
    triage: [],
    todo: [],
    "in-progress": [],
    "in-review": [],
    done: [],
    archived: [],
  });

  const handleToggleArchivedCollapse = useCallback(() => {
    setArchivedCollapsed((current) => !current);
  }, []);

  // Filter tasks based on search query (matches id, title, or description)
  const filteredTasks = useMemo(() => {
    if (!searchQuery.trim()) return tasks;
    const query = searchQuery.toLowerCase();
    return tasks.filter(
      (t) =>
        t.id.toLowerCase().includes(query) ||
        (t.title && t.title.toLowerCase().includes(query)) ||
        t.description.toLowerCase().includes(query)
    );
  }, [tasks, searchQuery]);

  // Keep per-column array identities stable for unchanged columns so React.memo(Column)
  // can skip sibling rerenders during unrelated task updates.
  const tasksByColumn = useMemo(() => {
    const nextGrouped = Object.fromEntries(
      COLUMNS.map((column) => [column, [] as Task[]]),
    ) as Record<ColumnType, Task[]>;

    for (const task of filteredTasks) {
      nextGrouped[task.column].push(task);
    }

    const previousGrouped = tasksByColumnCacheRef.current;
    const stableGrouped = {} as Record<ColumnType, Task[]>;

    for (const column of COLUMNS) {
      const sortedTasks = sortTasksForColumn(nextGrouped[column]);
      stableGrouped[column] = areTaskArraysEqual(previousGrouped[column], sortedTasks)
        ? previousGrouped[column]
        : sortedTasks;
    }

    tasksByColumnCacheRef.current = stableGrouped;
    return stableGrouped;
  }, [filteredTasks]);

  return (
    <main className="board" id="board">
      {COLUMNS.map((col) => (
        <Column
          key={col}
          column={col}
          tasks={tasksByColumn[col]}
          maxConcurrent={maxConcurrent}
          onMoveTask={onMoveTask}
          onOpenDetail={onOpenDetail}
          addToast={addToast}
          globalPaused={globalPaused}
          onUpdateTask={onUpdateTask}
          onArchiveTask={onArchiveTask}
          onUnarchiveTask={onUnarchiveTask}
          {...(col === "triage" ? { onQuickCreate, onNewTask } : {})}
          {...(col === "in-review" ? { autoMerge, onToggleAutoMerge } : {})}
          {...(col === "archived" ? { collapsed: archivedCollapsed, onToggleCollapse: handleToggleArchivedCollapse } : {})}
        />
      ))}
    </main>
  );
}
