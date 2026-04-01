import type { Task, TaskDetail, Column as ColumnType, TaskCreateInput } from "@fusion/core";
import { COLUMNS } from "@fusion/core";
import { Column } from "./Column";
import type { ToastType } from "../hooks/useToast";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useBatchBadgeFetch } from "../hooks/useBatchBadgeFetch";
import type { ModelInfo } from "../api";

interface BoardProps {
  tasks: Task[];
  maxConcurrent: number;
  onMoveTask: (id: string, column: ColumnType) => Promise<Task>;
  onOpenDetail: (task: TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
  onQuickCreate?: (input: TaskCreateInput) => Promise<void>;
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
  onArchiveAllDone?: () => Promise<Task[]>;
  searchQuery?: string;
  availableModels?: ModelInfo[];
  /**
   * Called when the user clicks the "Plan" button in the inline create card.
   */
  onPlanningMode?: (initialPlan: string) => void;
  /**
   * Called when the user clicks the "Subtask" button in the inline create card.
   */
  onSubtaskBreakdown?: (description: string) => void;
  onOpenFilesForTask?: (taskId: string) => void;
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

export function Board({ tasks, maxConcurrent, onMoveTask, onOpenDetail, addToast, onQuickCreate, onNewTask, autoMerge, onToggleAutoMerge, globalPaused, onUpdateTask, onArchiveTask, onUnarchiveTask, onArchiveAllDone, searchQuery = "", availableModels, onPlanningMode, onSubtaskBreakdown, onOpenFilesForTask }: BoardProps) {
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);
  const { fetchBatch } = useBatchBadgeFetch();
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Collect task IDs with GitHub badge info for batch fetching
  const taskIdsWithBadges = useMemo(() => {
    return filteredTasks
      .filter((t) => t.prInfo || t.issueInfo)
      .map((t) => t.id);
  }, [filteredTasks]);

  // Batch fetch badge statuses on mount and when visible tasks change
  useEffect(() => {
    if (taskIdsWithBadges.length === 0) return;

    // Debounce the batch fetch to handle rapid changes
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    debounceTimeoutRef.current = setTimeout(() => {
      // Fetch in chunks of 50 to respect the API limit
      const chunks: string[][] = [];
      for (let i = 0; i < taskIdsWithBadges.length; i += 50) {
        chunks.push(taskIdsWithBadges.slice(i, i + 50));
      }

      // Fire all chunks concurrently - the hook handles deduplication
      chunks.forEach((chunk) => {
        void fetchBatch(chunk);
      });
    }, 500);

    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [taskIdsWithBadges, fetchBatch]);
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
          allTasks={filteredTasks}
          availableModels={availableModels}
          onOpenFilesForTask={onOpenFilesForTask}
          {...(col === "triage" ? { onQuickCreate, onNewTask, onPlanningMode, onSubtaskBreakdown } : {})}
          {...(col === "in-review" ? { autoMerge, onToggleAutoMerge } : {})}
          {...(col === "done" ? { onArchiveAllDone } : {})}
          {...(col === "archived" ? { collapsed: archivedCollapsed, onToggleCollapse: handleToggleArchivedCollapse } : {})}
        />
      ))}
    </main>
  );
}
