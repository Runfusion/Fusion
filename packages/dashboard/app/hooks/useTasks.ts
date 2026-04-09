import { useState, useEffect, useCallback, useRef } from "react";
import type { Task, Column, TaskCreateInput, MergeResult } from "@fusion/core";
import * as api from "../api";

const RECONNECT_DELAY_MS = 3000;
/** If no SSE message (including heartbeat events) arrives within this window, force reconnect. */
const HEARTBEAT_TIMEOUT_MS = 45_000;

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
  /**
   * When provided, fetches tasks matching this search query.
   * Server-side full-text search across title, ID, description, and comments.
   */
  searchQuery?: string;
}

export function useTasks(options?: UseTasksOptions) {
  const projectId = options?.projectId;
  const searchQuery = options?.searchQuery;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [connectionNonce, setConnectionNonce] = useState(0);
  const tasksRef = useRef(tasks);
  const fetchVersionRef = useRef(0);
  const lastVisibilityRefreshRef = useRef<number>(0);
  tasksRef.current = tasks;

  const VISIBILITY_REFRESH_DEBOUNCE_MS = 1000;

  const refreshTasks = useCallback(async (options?: { clearOnError?: boolean; searchQueryOverride?: string }) => {
    const requestVersion = ++fetchVersionRef.current;
    const query = options?.searchQueryOverride ?? searchQuery;

    try {
      const fetchedTasks = await api.fetchTasks(undefined, undefined, projectId, query);
      if (fetchVersionRef.current !== requestVersion) {
        return;
      }
      setTasks(fetchedTasks.map(normalizeTask));
    } catch {
      if (fetchVersionRef.current !== requestVersion) {
        return;
      }
      if (options?.clearOnError) {
        setTasks([]);
        return;
      }
      setTasks((current) => current);
    }
  }, [projectId, searchQuery]);

  // Debounced search effect - separate from refreshTasks to avoid dependency cycle
  useEffect(() => {
    if (searchQuery === undefined) return;
    const timer = setTimeout(() => {
      void refreshTasks({ searchQueryOverride: searchQuery });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]); // intentionally NOT including refreshTasks in deps

  // Fetch initial tasks and recover when the tab becomes visible again.
  useEffect(() => {
    void refreshTasks({ clearOnError: true });

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      const now = Date.now();
      const timeSinceLastRefresh = now - lastVisibilityRefreshRef.current;
      if (timeSinceLastRefresh < VISIBILITY_REFRESH_DEBOUNCE_MS) {
        return;
      }

      lastVisibilityRefreshRef.current = now;
      void refreshTasks();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshTasks]);

  // SSE live updates
  // Note: In multi-project mode, SSE receives all task events.
  // Tasks are filtered by ID match, so cross-project updates won't affect
  // the local state since task IDs are unique and we only fetch from one project.
  useEffect(() => {
    let closedByCleanup = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    if (connectionNonce > 0) {
      void refreshTasks();
    }
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const es = new EventSource(`/api/events${query}`);

    /** Reset the heartbeat watchdog. Called on every incoming SSE message. */
    const resetHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        // No message received within the timeout — connection is likely dead.
        if (!closedByCleanup) {
          handleError();
        }
      }, HEARTBEAT_TIMEOUT_MS);
    };

    // Start the watchdog immediately — if the connection never opens we still want to time out.
    resetHeartbeat();

    const handleCreated = (e: MessageEvent) => {
      resetHeartbeat();
      const task = normalizeTask(JSON.parse(e.data) as Task);
      // When search is active, re-fetch to get server-filtered results
      if (searchQuery) {
        void refreshTasks({ searchQueryOverride: searchQuery });
        return;
      }
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
      resetHeartbeat();
      // When search is active, re-fetch to get server-filtered results
      if (searchQuery) {
        void refreshTasks({ searchQueryOverride: searchQuery });
        return;
      }
      const { task, to }: { task: Task; from: Column; to: Column } = JSON.parse(e.data);
      const normalizedTask = normalizeTask(task);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === normalizedTask.id ? { ...normalizedTask, column: to } : t
        )
      );
    };

    const handleUpdated = (e: MessageEvent) => {
      resetHeartbeat();
      // When search is active, re-fetch to get server-filtered results
      if (searchQuery) {
        void refreshTasks({ searchQueryOverride: searchQuery });
        return;
      }
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
      resetHeartbeat();
      // When search is active, re-fetch to get server-filtered results
      if (searchQuery) {
        void refreshTasks({ searchQueryOverride: searchQuery });
        return;
      }
      const task = normalizeTask(JSON.parse(e.data) as Task);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
    };

    const handleMerged = (e: MessageEvent) => {
      resetHeartbeat();
      // When search is active, re-fetch to get server-filtered results
      if (searchQuery) {
        void refreshTasks({ searchQueryOverride: searchQuery });
        return;
      }
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
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }

      es.removeEventListener("heartbeat", handleHeartbeat);
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
      }, RECONNECT_DELAY_MS);
    };

    /** Server heartbeat (named event, not comment) — just resets the watchdog. */
    const handleHeartbeat = () => { resetHeartbeat(); };

    es.addEventListener("open", () => resetHeartbeat());
    es.addEventListener("heartbeat", handleHeartbeat);
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
  }, [connectionNonce, projectId, searchQuery, refreshTasks]);

  const createTask = useCallback(async (input: TaskCreateInput): Promise<Task> => {
    const task = normalizeTask(await api.createTask(input, projectId));
    setTasks((prev) => {
      if (prev.some((t) => t.id === task.id)) return prev;
      return [...prev, task];
    });
    return task;
  }, [projectId]);

  const moveTask = useCallback(async (id: string, column: Column): Promise<Task> => {
    return normalizeTask(await api.moveTask(id, column, projectId));
  }, [projectId]);

  const deleteTask = useCallback(async (id: string): Promise<Task> => {
    return normalizeTask(await api.deleteTask(id, projectId));
  }, [projectId]);

  const mergeTask = useCallback(async (id: string): Promise<MergeResult> => {
    return api.mergeTask(id, projectId);
  }, [projectId]);

  const retryTask = useCallback(async (id: string): Promise<Task> => {
    return normalizeTask(await api.retryTask(id, projectId));
  }, [projectId]);

  const duplicateTask = useCallback(async (id: string): Promise<Task> => {
    const task = normalizeTask(await api.duplicateTask(id, projectId));
    setTasks((prev) => {
      if (prev.some((t) => t.id === task.id)) return prev;
      return [...prev, task];
    });
    return task;
  }, [projectId]);

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
      const updatedTask = normalizeTask(await api.updateTask(id, updates, projectId));
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
  }, [projectId]);

  const archiveTask = useCallback(async (id: string): Promise<Task> => {
    const task = normalizeTask(await api.archiveTask(id, projectId));
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? task : t))
    );
    return task;
  }, [projectId]);

  const unarchiveTask = useCallback(async (id: string): Promise<Task> => {
    const task = normalizeTask(await api.unarchiveTask(id, projectId));
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? task : t))
    );
    return task;
  }, [projectId]);

  const archiveAllDone = useCallback(async (): Promise<Task[]> => {
    const archived = await api.archiveAllDone(projectId);
    const normalized = archived.map(normalizeTask);
    setTasks((prev) =>
      prev.map((t) => {
        const updated = normalized.find((archived) => archived.id === t.id);
        return updated || t;
      })
    );
    return normalized;
  }, [projectId]);

  return { tasks, createTask, moveTask, deleteTask, mergeTask, retryTask, duplicateTask, updateTask, archiveTask, unarchiveTask, archiveAllDone };
}
