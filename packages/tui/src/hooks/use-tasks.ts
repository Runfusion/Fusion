/**
 * useTasks - React hook for subscribing to TaskStore events and maintaining live task list.
 *
 * This hook bridges the gap between Node.js EventEmitter and React's state model,
 * enabling TUI components to display live task data without polling.
 */

import { useState, useEffect, useCallback } from "react";
import type { Task, Column } from "@fusion/core";
import { useFusion } from "../fusion-context.js";

/**
 * Return type for the useTasks hook.
 */
export interface UseTasksResult {
  /** Current list of tasks */
  tasks: Task[];
  /** Whether initial data fetch is in progress */
  loading: boolean;
  /** Error from initial fetch, or null if successful */
  error: Error | null;
}

/**
 * Hook that subscribes to TaskStore events and maintains a live list of tasks.
 *
 * - On mount, fetches initial task list from `store.listTasks()`
 * - Subscribes to TaskStore events: `task:created`, `task:moved`, `task:updated`, `task:deleted`, `task:merged`
 * - Updates state reactively when events fire, using functional updates to avoid stale closures
 * - Cleans up event listeners on unmount
 *
 * @returns { tasks: Task[], loading: boolean, error: Error | null }
 *
 * @example
 * ```tsx
 * function TaskList() {
 *   const { tasks, loading, error } = useTasks();
 *
 *   if (loading) return <Text>Loading tasks...</Text>;
 *   if (error) return <Text color="red">{error.message}</Text>;
 *
 *   return (
 *     <Box flexDirection="column">
 *       {tasks.map(task => (
 *         <Text key={task.id}>{task.id}: {task.description}</Text>
 *       ))}
 *     </Box>
 *   );
 * }
 * ```
 */
export function useTasks(): UseTasksResult {
  const { store } = useFusion();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Fetch initial task list
    store
      .listTasks()
      .then((initialTasks) => {
        if (cancelled) return;
        setTasks(initialTasks);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setTasks([]);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    // Event handlers for TaskStore events
    const handleTaskCreated = (task: Task) => {
      setTasks((prev) => {
        // Avoid duplicates
        if (prev.some((t) => t.id === task.id)) {
          return prev;
        }
        return [...prev, task];
      });
    };

    const handleTaskMoved = (data: { task: Task; from: Column; to: Column }) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === data.task.id ? { ...t, column: data.to, columnMovedAt: new Date().toISOString() } : t))
      );
    };

    const handleTaskUpdated = (task: Task) => {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
    };

    const handleTaskDeleted = (task: Task) => {
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
    };

    const handleTaskMerged = (result: { task: Task }) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === result.task.id ? { ...t, column: "done" as Column } : t))
      );
    };

    // Subscribe to events
    store.on("task:created", handleTaskCreated);
    store.on("task:moved", handleTaskMoved);
    store.on("task:updated", handleTaskUpdated);
    store.on("task:deleted", handleTaskDeleted);
    store.on("task:merged", handleTaskMerged);

    // Cleanup function
    return () => {
      cancelled = true;
      store.off("task:created", handleTaskCreated);
      store.off("task:moved", handleTaskMoved);
      store.off("task:updated", handleTaskUpdated);
      store.off("task:deleted", handleTaskDeleted);
      store.off("task:merged", handleTaskMerged);
    };
  }, [store]);

  return { tasks, loading, error };
}
