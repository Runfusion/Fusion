import { useState, useEffect, useCallback, useRef } from "react";
import type { Task, Column, TaskCreateInput, MergeResult } from "@fusion/core";
import * as api from "../api";

function normalizeTask(task: Task): Task {
  return {
    ...task,
    dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
    steps: Array.isArray(task.steps) ? task.steps : [],
    log: Array.isArray((task as Task & { log?: unknown }).log)
      ? (task as Task & { log?: Task["log"] }).log!
      : [],
  };
}

/**
 * Compare two ISO timestamp strings.
 * Returns positive if a is newer than b, negative if b is newer, 0 if equal.
 */
function compareTimestamps(a: string | undefined, b: string | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -1; // b is newer if a has no timestamp
  if (!b) return 1;  // a is newer if b has no timestamp
  return a.localeCompare(b);
}

export interface UseTasksOptions {
  /** 
   * When provided, fetches tasks only for this project.
   * Note: SSE updates are not filtered by project in current implementation.
   */
  projectId?: string;
}

export function useTasks(options?: UseTasksOptions) {
  const projectId = options?.projectId;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [connectionNonce, setConnectionNonce] = useState(0);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  // Ref to track last visibility fetch time for debouncing (1 second minimum)
  const lastVisibilityFetchRef = useRef<number>(0);
  const VISIBILITY_FETCH_DEBOUNCE_MS = 1000;

  // Determine which fetch function to use
  const fetchTasksFn = useCallback(() => {
    if (projectId) {
      return api.fetchProjectTasks(projectId);
    }
    return api.fetchTasks();
  }, [projectId]);

  // Fetch initial tasks
  useEffect(() => {
    fetchTasksFn()
      .then((tasks) => setTasks(tasks.map(normalizeTask)))
      .catch(() => setTasks([]));
  }, [fetchTasksFn]);

  // Visibility change listener - refresh tasks when tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        const now = Date.now();
        const timeSinceLastFetch = now - lastVisibilityFetchRef.current;

        // Debounce: only fetch if at least 1 second has passed since last visibility fetch
        if (timeSinceLastFetch >= VISIBILITY_FETCH_DEBOUNCE_MS) {
          lastVisibilityFetchRef.current = now;
          fetchTasksFn()
            .then((tasks) => setTasks(tasks.map(normalizeTask)))
            .catch(() => {
              // Silently ignore fetch errors on visibility change
            });
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchTasksFn]);

  // SSE live updates
  // Note: In multi-project mode, SSE receives all task events.
  // Tasks are filtered by ID match, so cross-project updates won't affect
  // the local state since task IDs are unique and we only fetch from one project.
  useEffect(() => {
    let closedByCleanup = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource("/api/events");

    const handleCreated = (e: MessageEvent) => {
      const task = normalizeTask(JSON.parse(e.data) as Task);
      // In project mode, only add if this task belongs to our project
      // Since we can't determine project from event, we add and let subsequent
      // fetches correct the state, or filter by checking if task exists in our set
      setTasks((prev) => {
        // Avoid duplicates
        if (prev.some((t) => t.id === task.id)) return prev;
        return [...prev, task];
      });
    };

    const handleMoved = (e: MessageEvent) => {
      const { task, to }: { task: Task; from: Column; to: Column } = JSON.parse(e.data);
      const normalizedTask = normalizeTask(task);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === normalizedTask.id ? { ...normalizedTask, column: to } : t
        )
      );
    };

    const handleUpdated = (e: MessageEvent) => {
      const incoming = normalizeTask(JSON.parse(e.data) as Task);
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== incoming.id) return t;

          const updatedAtCompare = compareTimestamps(incoming.updatedAt, t.updatedAt);
          if (updatedAtCompare < 0) {
            return t;
          }

          if (t.column === incoming.column) {
            return incoming;
          }

          const columnTimestampCompare = compareTimestamps(t.columnMovedAt, incoming.columnMovedAt);
          if (t.columnMovedAt && !incoming.columnMovedAt) {
            return { ...incoming, column: t.column, columnMovedAt: t.columnMovedAt };
          }

          if (columnTimestampCompare > 0) {
            return { ...incoming, column: t.column, columnMovedAt: t.columnMovedAt };
          }

          return incoming;
        })
      );
    };

    const handleDeleted = (e: MessageEvent) => {
      const task = normalizeTask(JSON.parse(e.data) as Task);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
    };

    const handleMerged = (e: MessageEvent) => {
      const { task }: { task: Task } = JSON.parse(e.data);
      const normalizedTask = normalizeTask(task);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === normalizedTask.id ? { ...normalizedTask, column: "done" as Column } : t
        )
      );
    };

    const cleanup = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      es.removeEventListener("task:created", handleCreated);
      es.removeEventListener("task:moved", handleMoved);
      es.removeEventListener("task:updated", handleUpdated);
      es.removeEventListener("task:deleted", handleDeleted);
      es.removeEventListener("task:merged", handleMerged);
      es.removeEventListener("error", handleError);
      es.close();
    };

    const handleError = () => {
      if (closedByCleanup) return;

      cleanup();
      reconnectTimer = setTimeout(() => {
        setConnectionNonce((current) => current + 1);
      }, 3000);
    };

    es.addEventListener("task:created", handleCreated);
    es.addEventListener("task:moved", handleMoved);
    es.addEventListener("task:updated", handleUpdated);
    es.addEventListener("task:deleted", handleDeleted);
    es.addEventListener("task:merged", handleMerged);
    es.addEventListener("error", handleError);

    return () => {
      closedByCleanup = true;
      cleanup();
    };
  }, [connectionNonce]);

  const createTask = useCallback(async (input: TaskCreateInput): Promise<Task> => {
    return normalizeTask(await api.createTask(input));
  }, []);

  const moveTask = useCallback(async (id: string, column: Column): Promise<Task> => {
    return normalizeTask(await api.moveTask(id, column));
  }, []);

  const deleteTask = useCallback(async (id: string): Promise<Task> => {
    return normalizeTask(await api.deleteTask(id));
  }, []);

  const mergeTask = useCallback(async (id: string): Promise<MergeResult> => {
    return api.mergeTask(id);
  }, []);

  const retryTask = useCallback(async (id: string): Promise<Task> => {
    return normalizeTask(await api.retryTask(id));
  }, []);

  const duplicateTask = useCallback(async (id: string): Promise<Task> => {
    return normalizeTask(await api.duplicateTask(id));
  }, []);

  const updateTask = useCallback(async (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[] }
  ): Promise<Task> => {
    const previousTask = tasksRef.current.find((t) => t.id === id);
    const optimisticTask = previousTask
      ? { ...previousTask, ...updates, updatedAt: new Date().toISOString() }
      : undefined;

    if (optimisticTask) {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? optimisticTask : t))
      );
    }

    try {
      const updatedTask = normalizeTask(await api.updateTask(id, updates));
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? updatedTask : t))
      );
      return updatedTask;
    } catch (err) {
      if (previousTask) {
        setTasks((prev) =>
          prev.map((t) => (t.id === id ? previousTask : t))
        );
      }
      throw err;
    }
  }, []);

  const archiveTask = useCallback(async (id: string): Promise<Task> => {
    const task = normalizeTask(await api.archiveTask(id));
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? task : t))
    );
    return task;
  }, []);

  const unarchiveTask = useCallback(async (id: string): Promise<Task> => {
    const task = normalizeTask(await api.unarchiveTask(id));
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? task : t))
    );
    return task;
  }, []);

  const archiveAllDone = useCallback(async (): Promise<Task[]> => {
    const archived = await api.archiveAllDone();
    const normalized = archived.map(normalizeTask);
    setTasks((prev) =>
      prev.map((t) => {
        const updated = normalized.find((archived) => archived.id === t.id);
        return updated || t;
      })
    );
    return normalized;
  }, []);

  return { tasks, createTask, moveTask, deleteTask, mergeTask, retryTask, duplicateTask, updateTask, archiveTask, unarchiveTask, archiveAllDone };
}
