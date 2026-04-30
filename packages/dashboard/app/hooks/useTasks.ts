import { useState, useEffect, useCallback, useRef } from "react";
import type { Task, Column, TaskCreateInput, MergeResult } from "@fusion/core";
import * as api from "../api";
import { subscribeSse } from "../sse-bus";

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

function mergeIncomingTask(current: Task, incoming: Task): Task {
  const updatedAtCompare = compareTimestamps(incoming.updatedAt, current.updatedAt);
  if (updatedAtCompare < 0) {
    return current;
  }

  if (current.column === incoming.column) {
    return incoming;
  }

  const columnTimestampCompare = compareTimestamps(current.columnMovedAt, incoming.columnMovedAt);
  if (current.columnMovedAt && !incoming.columnMovedAt) {
    return { ...incoming, column: current.column, columnMovedAt: current.columnMovedAt };
  }

  if (columnTimestampCompare > 0) {
    return { ...incoming, column: current.column, columnMovedAt: current.columnMovedAt };
  }

  return incoming;
}

export interface UseTasksOptions {
  /** 
   * When provided, fetches tasks only for this project.
   * SSE events from other project contexts are ignored.
   */
  projectId?: string;
  /**
   * When provided, fetches tasks matching this search query.
   * Server-side full-text search across title, ID, description, and comments.
   */
  searchQuery?: string;
  /**
   * When false, disables SSE live-update subscription to free browser
   * HTTP/1.1 connection slots for other operations (e.g., mission detail fetches).
   * Initial fetch and visibility-change refresh remain active regardless.
   * Defaults to true.
   */
  sseEnabled?: boolean;
}

export function useTasks(options?: UseTasksOptions) {
  const projectId = options?.projectId;
  const searchQuery = options?.searchQuery;
  const sseEnabled = options?.sseEnabled ?? true;
  const [tasks, setTasks] = useState<Task[]>([]);
  // Once the user expands the archived column, we keep including archived tasks
  // in subsequent refreshes for the lifetime of this hook instance.
  const [includeArchived, setIncludeArchived] = useState(false);
  const includeArchivedRef = useRef(includeArchived);
  includeArchivedRef.current = includeArchived;
  const tasksRef = useRef(tasks);
  const fetchVersionRef = useRef(0);
  const lastVisibilityRefreshRef = useRef<number>(0);
  const searchQueryRef = useRef(searchQuery);
  const refreshTasksRef = useRef<typeof refreshTasks>(null!);
  // Tracks when task data was last confirmed fresh by the server.
  // Used to prevent false positives in stuck detection when tab has been in background.
  const lastFetchTimeMs = useRef<number | undefined>(undefined);
  // Tracks the project context version to detect stale SSE events after project switches.
  // Incremented whenever projectId changes, invalidating any in-flight SSE handlers.
  const projectContextVersionRef = useRef(0);
  // Track previous projectId to detect changes
  const previousProjectIdRef = useRef<string | undefined>(projectId);
  tasksRef.current = tasks;
  searchQueryRef.current = searchQuery;

  // Detect project changes and invalidate SSE context.
  // Keep previous tasks visible while the new project's fetch is in flight
  // (stale-while-revalidate) to avoid a blank flash and a full empty→populated
  // re-reconcile of the board. The refreshTasks fetch guard (requestProjectId)
  // rejects late responses from the previous project, and SSE handlers check
  // projectContextVersionRef before applying events.
  if (previousProjectIdRef.current !== projectId) {
    previousProjectIdRef.current = projectId;
    projectContextVersionRef.current++;
  }

  const VISIBILITY_REFRESH_DEBOUNCE_MS = 1000;

  const refreshTasks = useCallback(async (options?: { clearOnError?: boolean; searchQueryOverride?: string; includeArchivedOverride?: boolean }) => {
    const requestVersion = ++fetchVersionRef.current;
    const requestProjectId = projectId; // Capture the projectId for this request
    const query = options?.searchQueryOverride ?? searchQueryRef.current;
    const wantArchived = options?.includeArchivedOverride ?? includeArchivedRef.current;

    try {
      const fetchedTasks = await api.fetchTasks(undefined, undefined, requestProjectId, query, wantArchived);
      // Reject if project changed (compare against the projectId at request time) or version is stale
      if (fetchVersionRef.current !== requestVersion || projectId !== requestProjectId) {
        return;
      }
      setTasks(fetchedTasks.map(normalizeTask));
      // Record when we received fresh server data for stuck detection
      lastFetchTimeMs.current = Date.now();
    } catch {
      // Reject if project changed or version is stale
      if (fetchVersionRef.current !== requestVersion || projectId !== requestProjectId) {
        return;
      }
      if (options?.clearOnError) {
        setTasks([]);
        return;
      }
      setTasks((current) => current);
    }
  }, [projectId]);
  refreshTasksRef.current = refreshTasks;

  /** Lazy-load archived tasks. Called by the Board when the archived column is first expanded. */
  const loadArchivedTasks = useCallback(async () => {
    if (includeArchivedRef.current) return;
    setIncludeArchived(true);
    includeArchivedRef.current = true;
    await refreshTasksRef.current({ includeArchivedOverride: true });
  }, []);

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
  // Note: SSE events from stale project contexts are ignored via projectContextVersionRef.
  // This prevents tasks from the previous project from appearing during project switches.
  // Connection lifecycle (reconnect + heartbeat) is owned by sse-bus so all
  // /api/events consumers share one underlying EventSource.
  // When sseEnabled is false, the subscription is skipped to free browser connection slots.
  useEffect(() => {
    if (sseEnabled === false) return;

    const contextVersionAtStart = projectContextVersionRef.current;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const isStale = () => projectContextVersionRef.current !== contextVersionAtStart;
    // Guards against reconnect callbacks firing after the effect has cleaned up
    // (e.g., sseEnabled flipped to false during a pending reconnect timer in sse-bus).
    let active = true;

    // Guard against stale callbacks: when sseEnabled flips false or the
    // effect unmounts, these handlers must not fire refreshTasks into a
    // missions-only view where the SSE should be inactive.
    const handleCreated = (e: MessageEvent) => {
      if (isStale()) return;
      const task = normalizeTask(JSON.parse(e.data) as Task);
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      setTasks((prev) => {
        const existingIndex = prev.findIndex((candidate) => candidate.id === task.id);
        if (existingIndex === -1) {
          return [...prev, task];
        }

        const current = prev[existingIndex]!;
        const merged = mergeIncomingTask(current, task);
        if (merged === current) {
          return prev;
        }

        const next = [...prev];
        next[existingIndex] = merged;
        return next;
      });
      lastFetchTimeMs.current = Date.now();
    };

    const handleMoved = (e: MessageEvent) => {
      if (isStale()) return;
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      const { task, to }: { task: Task; from: Column; to: Column } = JSON.parse(e.data);
      const normalizedTask = normalizeTask(task);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === normalizedTask.id ? { ...normalizedTask, column: to } : t
        )
      );
      lastFetchTimeMs.current = Date.now();
    };

    const handleUpdated = (e: MessageEvent) => {
      if (isStale()) return;
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      const incoming = normalizeTask(JSON.parse(e.data) as Task);
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== incoming.id) return t;
          return mergeIncomingTask(t, incoming);
        })
      );
      lastFetchTimeMs.current = Date.now();
    };

    const handleDeleted = (e: MessageEvent) => {
      if (isStale()) return;
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      const task = normalizeTask(JSON.parse(e.data) as Task);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
    };

    const handleMerged = (e: MessageEvent) => {
      if (isStale()) return;
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
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

    const unsubscribe = subscribeSse(`/api/events${query}`, {
      events: {
        "task:created": handleCreated,
        "task:moved": handleMoved,
        "task:updated": handleUpdated,
        "task:deleted": handleDeleted,
        "task:merged": handleMerged,
      },
      // Guard onReconnect against stale SSE callbacks: do not call refreshTasks
      // if the SSE was disabled or the effect unmounted while reconnect was pending.
      onReconnect: () => {
        if (!active) return;
        if (isStale()) return;
        void refreshTasksRef.current();
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [projectId, sseEnabled]);

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

  const pauseTask = useCallback(async (id: string): Promise<Task> => {
    return normalizeTask(await api.pauseTask(id, projectId));
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

  const ingestCreatedTasks = useCallback((incomingTasks: Task[]): void => {
    if (incomingTasks.length === 0) {
      return;
    }

    if (searchQueryRef.current) {
      void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
      return;
    }

    const normalizedTasks = incomingTasks.map(normalizeTask);
    setTasks((prev) => {
      let next = prev;

      for (const task of normalizedTasks) {
        const existingIndex = next.findIndex((candidate) => candidate.id === task.id);
        if (existingIndex === -1) {
          if (next === prev) {
            next = [...prev];
          }
          next.push(task);
          continue;
        }

        const current = next[existingIndex]!;
        const merged = mergeIncomingTask(current, task);
        if (merged === current) {
          continue;
        }

        if (next === prev) {
          next = [...prev];
        }
        next[existingIndex] = merged;
      }

      return next;
    });
    lastFetchTimeMs.current = Date.now();
  }, []);

  return { tasks, createTask, moveTask, pauseTask, deleteTask, mergeTask, retryTask, duplicateTask, updateTask, archiveTask, unarchiveTask, archiveAllDone, loadArchivedTasks, includeArchived, ingestCreatedTasks, lastFetchTimeMs: lastFetchTimeMs.current };
}
