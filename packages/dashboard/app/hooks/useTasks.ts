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
   * SSE events from other project contexts are ignored.
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

  // Detect project changes and invalidate SSE context
  if (previousProjectIdRef.current !== projectId) {
    previousProjectIdRef.current = projectId;
    projectContextVersionRef.current++;
    // Clear tasks immediately on project change so prior-project rows are not rendered
    // during the fetch gap. This is scoped to project-context transitions only.
    setTasks([]);
  }

  const VISIBILITY_REFRESH_DEBOUNCE_MS = 1000;

  const refreshTasks = useCallback(async (options?: { clearOnError?: boolean; searchQueryOverride?: string; includeArchivedOverride?: boolean }) => {
    const requestVersion = ++fetchVersionRef.current;
    const requestProjectId = projectId; // Capture the projectId for this request
    const query = options?.searchQueryOverride ?? searchQuery;
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
  }, [projectId, searchQuery]);
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
  useEffect(() => {
    let closedByCleanup = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    if (connectionNonce > 0) {
      void refreshTasksRef.current();
    }
    // Capture the project context version at effect start.
    // Any event from a stale SSE connection (created before a project switch)
    // will have a different context version and will be ignored.
    const contextVersionAtStart = projectContextVersionRef.current;
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
      // Guard: reject events from stale project contexts
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        return;
      }
      resetHeartbeat();
      const task = normalizeTask(JSON.parse(e.data) as Task);
      // When search is active, re-fetch to get server-filtered results
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      // Add the task if it doesn't already exist
      setTasks((prev) => {
        // Avoid duplicates
        if (prev.some((t) => t.id === task.id)) return prev;
        return [...prev, task];
      });
    };

    const handleMoved = (e: MessageEvent) => {
      // Guard: reject events from stale project contexts
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        return;
      }
      resetHeartbeat();
      // When search is active, re-fetch to get server-filtered results
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
      // Record when we received fresh server data for stuck detection
      lastFetchTimeMs.current = Date.now();
    };

    const handleUpdated = (e: MessageEvent) => {
      // Guard: reject events from stale project contexts
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        return;
      }
      resetHeartbeat();
      // When search is active, re-fetch to get server-filtered results
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
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
      // Record when we received fresh server data for stuck detection
      lastFetchTimeMs.current = Date.now();
    };

    const handleDeleted = (e: MessageEvent) => {
      // Guard: reject events from stale project contexts
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        return;
      }
      resetHeartbeat();
      // When search is active, re-fetch to get server-filtered results
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      const task = normalizeTask(JSON.parse(e.data) as Task);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
    };

    const handleMerged = (e: MessageEvent) => {
      // Guard: reject events from stale project contexts
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        return;
      }
      resetHeartbeat();
      // When search is active, re-fetch to get server-filtered results
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
  // Note: searchQuery and refreshTasks are accessed via refs inside handlers
  // to avoid tearing down/rebuilding the EventSource on search changes.
  // The EventSource URL only depends on projectId.
  }, [connectionNonce, projectId]);

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

  return { tasks, createTask, moveTask, deleteTask, mergeTask, retryTask, duplicateTask, updateTask, archiveTask, unarchiveTask, archiveAllDone, loadArchivedTasks, includeArchived, lastFetchTimeMs: lastFetchTimeMs.current };
}
