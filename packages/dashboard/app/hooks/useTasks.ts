import { useState, useEffect, useCallback, useRef } from "react";
import type { Task, Column, TaskCreateInput, MergeResult } from "@kb/core";
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

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [connectionNonce, setConnectionNonce] = useState(0);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  // Fetch initial tasks
  useEffect(() => {
    api.fetchTasks().then((tasks) => setTasks(tasks.map(normalizeTask))).catch(() => setTasks([]));
  }, []);

  // SSE live updates
  useEffect(() => {
    let closedByCleanup = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource("/api/events");

    const handleCreated = (e: MessageEvent) => {
      const task = normalizeTask(JSON.parse(e.data) as Task);
      setTasks((prev) => [...prev, task]);
    };

    const handleMoved = (e: MessageEvent) => {
      // Payload: { task, from, to } - task object includes server-set columnMovedAt
      // We use 'to' as the authoritative column and trust the server's columnMovedAt
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

          // Race condition prevention: If the incoming update has stale column data,
          // preserve the current column. A task:moved event always carries the
          // authoritative column in the 'to' field and updates columnMovedAt.
          // If current state has a newer columnMovedAt, reject the column change.
          const columnTimestampCompare = compareTimestamps(t.columnMovedAt, incoming.columnMovedAt);
          if (columnTimestampCompare > 0 && t.column !== incoming.column) {
            // Current state is newer - preserve column, merge other fields
            return { ...incoming, column: t.column, columnMovedAt: t.columnMovedAt };
          }

          // Edge case: current has columnMovedAt but incoming doesn't (legacy data)
          // Preserve the column information we have
          if (t.columnMovedAt && !incoming.columnMovedAt && t.column !== incoming.column) {
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
      // Payload: { task, branch, merged, worktreeRemoved, branchDeleted, ... }
      // The task object has already been moved to 'done' by the server
      const { task }: { task: Task } = JSON.parse(e.data);
      const normalizedTask = normalizeTask(task);
      setTasks((prev) =>
        prev.map((t) =>
          // Ensure column is 'done' since that's where merged tasks always go
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
    // Optimistic update: apply changes immediately
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
      // Replace with server response
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? updatedTask : t))
      );
      return updatedTask;
    } catch (err) {
      // Rollback on error: restore previous state
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

  return { tasks, createTask, moveTask, deleteTask, mergeTask, retryTask, duplicateTask, updateTask, archiveTask, unarchiveTask };
}
