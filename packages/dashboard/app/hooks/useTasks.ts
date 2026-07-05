import { useState, useEffect, useCallback, useRef } from "react";
import type { Task, Column, ColumnId, TaskCreateInput, MergeResult, GithubIssueAction, AgentLogEntry } from "@fusion/core";
import { normalizeColumn } from "@fusion/core";
import * as api from "../api";
import { subscribeSse } from "../sse-bus";
import { clearCache, readCache, SWR_CACHE_KEYS, SWR_TASKS_MAX_AGE_MS, writeCache } from "../utils/swrCache";
import { pushTrace } from "../utils/dashboardTraceBuffer";
import { recordResumeEvent } from "../utils/resumeInstrumentation";

const loggedTaskCacheHitProjects = new Set<string>();
const TASK_VIEW_REENTRY_FRESHNESS_MS = SWR_TASKS_MAX_AGE_MS;

function normalizeTask(task: Task): Task {
  return {
    ...task,
    column: normalizeColumn((task as Task & { column?: unknown }).column),
    dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
    steps: Array.isArray(task.steps) ? task.steps : [],
    log: Array.isArray((task as Task & { log?: unknown }).log)
      ? (task as Task & { log?: Task["log"] }).log!
      : [],
  };
}

function isSoftDeleted(task: Task): boolean {
  return Boolean(task.deletedAt);
}

function filterActiveTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => !isSoftDeleted(task));
}

type AgentLogActivityEvent = Pick<AgentLogEntry, "taskId" | "timestamp" | "type" | "agent">;

function clearInReviewStallForFreshAgentLog(task: Task, entry: AgentLogActivityEvent): Task {
  if (task.id !== entry.taskId || task.column !== "in-review") return task;
  const logTimestampMs = Date.parse(entry.timestamp);
  const taskUpdatedAtMs = Date.parse(task.updatedAt);
  if (
    Number.isFinite(logTimestampMs) &&
    Number.isFinite(taskUpdatedAtMs) &&
    logTimestampMs <= taskUpdatedAtMs
  ) {
    return task;
  }
  if (!task.inReviewStall && !task.inReviewStalled && !task.stalledReview) return task;

  /*
  FNXC:DashboardStallBadges 2026-07-01-23:44:
  Board cards must not show Stalled/Merge stalled while an in-review agent is actively writing logs. The task row can remain unchanged during merger/reviewer work, so fresh agent-log metadata clears only derived stall badge fields until the next authoritative task refresh.
  */
  return {
    ...task,
    inReviewStall: undefined,
    inReviewStalled: undefined,
    stalledReview: undefined,
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

function mergeSameColumnTask(current: Task, incoming: Task): Task {
  return {
    ...incoming,
    // Preserve stable execution metadata when a same-column live update arrives
    // without the full task payload (common during status/log-only SSE updates).
    columnMovedAt: current.columnMovedAt ?? incoming.columnMovedAt,
    executionStartedAt: current.executionStartedAt ?? incoming.executionStartedAt,
    executionCompletedAt: current.executionCompletedAt ?? incoming.executionCompletedAt,
    firstExecutionAt: current.firstExecutionAt ?? incoming.firstExecutionAt,
    cumulativeActiveMs: incoming.cumulativeActiveMs ?? current.cumulativeActiveMs,
    worktree: incoming.worktree ?? current.worktree,
    modifiedFiles: incoming.modifiedFiles ?? current.modifiedFiles,
    timedExecutionMs: incoming.timedExecutionMs ?? current.timedExecutionMs,
    workflowStepResults: incoming.workflowStepResults ?? current.workflowStepResults,
    tokenUsage: incoming.tokenUsage ?? current.tokenUsage,
    mergeDetails: incoming.mergeDetails ?? current.mergeDetails,
  };
}

function mergeIncomingTask(current: Task, incoming: Task): Task {
  const updatedAtCompare = compareTimestamps(incoming.updatedAt, current.updatedAt);
  if (updatedAtCompare < 0) {
    return current;
  }

  if (current.column === incoming.column) {
    return mergeSameColumnTask(current, incoming);
  }

  const columnTimestampCompare = compareTimestamps(current.columnMovedAt, incoming.columnMovedAt);
  if (current.columnMovedAt && !incoming.columnMovedAt) {
    return { ...incoming, column: current.column, columnMovedAt: current.columnMovedAt };
  }

  if (columnTimestampCompare >= 0) {
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
  const [tasks, setTasks] = useState<Task[]>(() => {
    if (!projectId) {
      return [];
    }
    const cachedTasks = readCache<Task[]>(`${SWR_CACHE_KEYS.TASKS_PREFIX}${projectId}`, { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
    if (Array.isArray(cachedTasks) && cachedTasks.length > 0 && !loggedTaskCacheHitProjects.has(projectId)) {
      loggedTaskCacheHitProjects.add(projectId);
      console.info("[swr-cache] hit tasks=", cachedTasks.length, "projectId=", projectId);
    }
    return Array.isArray(cachedTasks) ? filterActiveTasks(cachedTasks.map(normalizeTask)) : [];
  });
  const [isStale, setIsStale] = useState(true);
  const [lastRefreshErrorAt, setLastRefreshErrorAt] = useState<number | null>(null);
  // Once the user expands the archived column, we keep including archived tasks
  // in subsequent refreshes for the lifetime of this hook instance.
  const [includeArchived, setIncludeArchived] = useState(false);
  const includeArchivedRef = useRef(includeArchived);
  includeArchivedRef.current = includeArchived;
  const tasksRef = useRef(tasks);
  const fetchVersionRef = useRef(0);
  // Tracks the project context version to detect stale SSE events after project switches.
  // Incremented whenever projectId changes, invalidating any in-flight SSE handlers.
  const projectContextVersionRef = useRef(0);
  const lastVisibilityRefreshRef = useRef<number>(0);
  const contextVersionAtLastVisibilityRef = useRef(projectContextVersionRef.current);
  const droppedStaleEventsRef = useRef(0);
  const searchQueryRef = useRef(searchQuery);
  const refreshTasksRef = useRef<typeof refreshTasks>(null!);
  const prevSseEnabledRef = useRef(sseEnabled);
  // Tracks when task data was last confirmed fresh by the server.
  // Used to prevent false positives in stuck detection when tab has been in background.
  const lastFetchTimeMs = useRef<number | undefined>(undefined);
  const lastConfirmedProjectIdRef = useRef<string | undefined>(undefined);
  const lastConfirmedSearchQueryRef = useRef<string | undefined>(undefined);
  const lastConfirmedIncludeArchivedRef = useRef(false);
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
      const normalizedFetchedTasks = filterActiveTasks(fetchedTasks.map(normalizeTask));
      setTasks(normalizedFetchedTasks);
      if (requestProjectId) {
        const cachedPayload = fetchedTasks.length > 500 ? fetchedTasks.slice(0, 500) : fetchedTasks;
        writeCache(`${SWR_CACHE_KEYS.TASKS_PREFIX}${requestProjectId}`, cachedPayload, { maxBytes: 500_000 });
      }
      setIsStale(false);
      setLastRefreshErrorAt(null);
      // Record when we received fresh server data for stuck detection
      lastFetchTimeMs.current = Date.now();
      lastConfirmedProjectIdRef.current = requestProjectId;
      lastConfirmedSearchQueryRef.current = query;
      lastConfirmedIncludeArchivedRef.current = wantArchived;
    } catch {
      // Reject if project changed or version is stale
      if (fetchVersionRef.current !== requestVersion || projectId !== requestProjectId) {
        return;
      }
      setLastRefreshErrorAt(Date.now());
      if (requestProjectId) {
        clearCache(`${SWR_CACHE_KEYS.TASKS_PREFIX}${requestProjectId}`);
      }
      if (options?.clearOnError) {
        setTasks([]);
        return;
      }
    }
  }, [projectId]);
  refreshTasksRef.current = refreshTasks;

  const shouldRefreshOnTaskViewReentry = useCallback(() => {
    if (lastRefreshErrorAt !== null) return true;
    if (searchQueryRef.current) return true;
    if (includeArchivedRef.current) return true;
    if (lastConfirmedProjectIdRef.current !== projectId) return true;
    if (lastConfirmedSearchQueryRef.current !== searchQueryRef.current) return true;
    if (lastConfirmedIncludeArchivedRef.current !== includeArchivedRef.current) return true;

    const lastFetchAt = lastFetchTimeMs.current;
    if (lastFetchAt === undefined) return true;

    return Date.now() - lastFetchAt > TASK_VIEW_REENTRY_FRESHNESS_MS;
  }, [lastRefreshErrorAt, projectId]);

  /*
  FNXC:DashboardTaskCache 2026-06-29-22:35:
  Brief Board/List returns should reuse fresh in-memory task state instead of issuing another all-task fetch, so the existing task array renders immediately without an empty/loading shell. Stale, missing, failed, project/search, or archived snapshots still perform one catch-up because task SSE is disabled off task-list views and missed events need server confirmation.

  FNXC:DashboardTaskCache 2026-06-29-23:12:
  The freshness shortcut is scoped only to in-app task-view re-entry. Initial mount, tab visibility recovery, SSE reconnect resync, search refreshes, and delete fetch-version invalidation remain independent safety paths because each represents either a new browser/server gap or a changed query context.
  */
  useEffect(() => {
    const previous = prevSseEnabledRef.current;
    prevSseEnabledRef.current = sseEnabled;

    if (previous === false && sseEnabled === true && shouldRefreshOnTaskViewReentry()) {
      void refreshTasksRef.current();
    }
  }, [shouldRefreshOnTaskViewReentry, sseEnabled]);

  /** Lazy-load archived tasks. Called by the Board when the archived column is first expanded. */
  const loadArchivedTasks = useCallback(async () => {
    if (includeArchivedRef.current) return;
    setIncludeArchived(true);
    includeArchivedRef.current = true;
    await refreshTasksRef.current({ includeArchivedOverride: true });
  }, []);

  // Debounced search effect - separate from refreshTasks to avoid dependency cycle
  const prevSearchQueryRef = useRef<string | undefined>(searchQuery);
  useEffect(() => {
    // Skip only the initial mount when query has never been set; the visibility
    // effect handles the first fetch. Going from a defined value back to
    // undefined/"" must still trigger a refetch so the filter is cleared.
    if (searchQuery === undefined && prevSearchQueryRef.current === undefined) return;
    prevSearchQueryRef.current = searchQuery;
    const timer = setTimeout(() => {
      void refreshTasks({ searchQueryOverride: searchQuery });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]); // intentionally NOT including refreshTasks in deps

  useEffect(() => {
    if (!projectId) {
      return;
    }

    const cachedTasks = readCache<Task[]>(`${SWR_CACHE_KEYS.TASKS_PREFIX}${projectId}`, { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
    if (Array.isArray(cachedTasks)) {
      if (cachedTasks.length > 0 && !loggedTaskCacheHitProjects.has(projectId)) {
        loggedTaskCacheHitProjects.add(projectId);
        console.info("[swr-cache] hit tasks=", cachedTasks.length, "projectId=", projectId);
      }
      setTasks(filterActiveTasks(cachedTasks.map(normalizeTask)));
    }
    setIsStale(true);
  }, [projectId]);

  // Fetch initial tasks and recover when the tab becomes visible again.
  useEffect(() => {
    setIsStale(true);
    void refreshTasks({ clearOnError: true });

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        contextVersionAtLastVisibilityRef.current = projectContextVersionRef.current;
        return;
      }

      const previousContextVersion = contextVersionAtLastVisibilityRef.current;
      const contextChangedWhileHidden = previousContextVersion !== projectContextVersionRef.current;
      contextVersionAtLastVisibilityRef.current = projectContextVersionRef.current;

      if (contextChangedWhileHidden) {
        lastVisibilityRefreshRef.current = Date.now();
        pushTrace("useTasks", "visibility-context-version-changed", {
          projectId,
          previousContextVersion,
          currentContextVersion: projectContextVersionRef.current,
        });
        recordResumeEvent({
          view: "useTasks",
          trigger: "visibility",
          projectId,
          replayAttempted: false,
          reason: "context-version-changed",
        });
        void refreshTasks();
        return;
      }

      const now = Date.now();
      const timeSinceLastRefresh = now - lastVisibilityRefreshRef.current;
      if (timeSinceLastRefresh < VISIBILITY_REFRESH_DEBOUNCE_MS) {
        return;
      }

      lastVisibilityRefreshRef.current = now;
      recordResumeEvent({
        view: "useTasks",
        trigger: "visibility",
        projectId,
        replayAttempted: false,
        reason: "debounced-refresh",
      });
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

    let contextVersionAtStart = projectContextVersionRef.current;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const isStale = () => projectContextVersionRef.current !== contextVersionAtStart;
    const traceDroppedStaleEvent = () => {
      droppedStaleEventsRef.current += 1;
      pushTrace("useTasks", "dropped-stale-event", {
        count: droppedStaleEventsRef.current,
        contextVersionAtStart,
        currentContextVersion: projectContextVersionRef.current,
        projectId,
      });
    };
    // Guards against reconnect callbacks firing after the effect has cleaned up
    // (e.g., sseEnabled flipped to false during a pending reconnect timer in sse-bus).
    let active = true;

    // Guard against stale callbacks: when sseEnabled flips false or the
    // effect unmounts, these handlers must not fire refreshTasks into a
    // missions-only view where the SSE should be inactive.
    const handleCreated = (e: MessageEvent) => {
      if (isStale()) {
        traceDroppedStaleEvent();
        return;
      }
      const task = normalizeTask(JSON.parse(e.data) as Task);
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      if (isSoftDeleted(task)) {
        setTasks((prev) => prev.filter((candidate) => candidate.id !== task.id));
        pushTrace("useTasks", "soft-deleted-task-suppressed", { event: "task:created", id: task.id });
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
      if (isStale()) {
        traceDroppedStaleEvent();
        return;
      }
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      // #1403: the move event carries `ColumnId` (custom column ids admitted).
      const { task, to }: { task: Task; from: ColumnId; to: ColumnId } = JSON.parse(e.data);
      const normalizedTask = normalizeTask(task);
      if (isSoftDeleted(normalizedTask)) {
        setTasks((prev) => prev.filter((candidate) => candidate.id !== normalizedTask.id));
        pushTrace("useTasks", "soft-deleted-task-suppressed", { event: "task:moved", id: normalizedTask.id });
        return;
      }
      // Preserve a custom (non-legacy) target id verbatim; only coerce empty/garbage
      // back to the task's current column. normalizeColumn alone would drop custom ids.
      const nextColumn: ColumnId = typeof to === "string" && to ? to : normalizedTask.column;
      const movedTask = { ...normalizedTask, column: nextColumn };
      setTasks((prev) => {
        const existingIndex = prev.findIndex((t) => t.id === movedTask.id);
        if (existingIndex === -1) {
          // SSE created event was missed (e.g., reconnect gap); upsert so the
          // task becomes visible instead of being silently dropped.
          return [...prev, movedTask];
        }
        const next = [...prev];
        next[existingIndex] = movedTask;
        return next;
      });
      lastFetchTimeMs.current = Date.now();
    };

    const handleUpdated = (e: MessageEvent) => {
      if (isStale()) {
        traceDroppedStaleEvent();
        return;
      }
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      const incoming = normalizeTask(JSON.parse(e.data) as Task);
      if (isSoftDeleted(incoming)) {
        // FN-5135: treat deletedAt-bearing task:updated payloads as delete-equivalent.
        setTasks((prev) => prev.filter((candidate) => candidate.id !== incoming.id));
        pushTrace("useTasks", "soft-deleted-task-suppressed", { event: "task:updated", id: incoming.id });
        return;
      }
      setTasks((prev) => {
        const existingIndex = prev.findIndex((t) => t.id === incoming.id);
        if (existingIndex === -1) {
          return [...prev, incoming];
        }
        const current = prev[existingIndex]!;
        const merged = mergeIncomingTask(current, incoming);
        if (merged === current) return prev;
        const next = [...prev];
        next[existingIndex] = merged;
        return next;
      });
      lastFetchTimeMs.current = Date.now();
    };

    const handleDeleted = (e: MessageEvent) => {
      if (isStale()) {
        traceDroppedStaleEvent();
        return;
      }
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      const task = normalizeTask(JSON.parse(e.data) as Task);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
    };

    const handleMerged = (e: MessageEvent) => {
      if (isStale()) {
        traceDroppedStaleEvent();
        return;
      }
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      const { task }: { task: Task } = JSON.parse(e.data);
      const normalizedTask = normalizeTask(task);
      if (isSoftDeleted(normalizedTask)) {
        setTasks((prev) => prev.filter((candidate) => candidate.id !== normalizedTask.id));
        pushTrace("useTasks", "soft-deleted-task-suppressed", { event: "task:merged", id: normalizedTask.id });
        return;
      }
      const mergedTask = { ...normalizedTask, column: "done" as Column };
      setTasks((prev) => {
        const existingIndex = prev.findIndex((t) => t.id === mergedTask.id);
        if (existingIndex === -1) {
          return [...prev, mergedTask];
        }
        const next = [...prev];
        next[existingIndex] = mergedTask;
        return next;
      });
    };

    const handleAgentLog = (e: MessageEvent) => {
      if (isStale()) {
        traceDroppedStaleEvent();
        return;
      }
      if (searchQueryRef.current) {
        return;
      }
      const entry = JSON.parse(e.data) as AgentLogActivityEvent;
      if (!entry.taskId || !entry.timestamp) return;
      setTasks((prev) => {
        let changed = false;
        const next = prev.map((task) => {
          const cleared = clearInReviewStallForFreshAgentLog(task, entry);
          if (cleared !== task) changed = true;
          return cleared;
        });
        return changed ? next : prev;
      });
    };

    const unsubscribe = subscribeSse(`/api/events${query}`, {
      events: {
        "task:created": handleCreated,
        "task:moved": handleMoved,
        "task:updated": handleUpdated,
        "task:deleted": handleDeleted,
        "task:merged": handleMerged,
        "agent:log": handleAgentLog,
      },
      // Guard onReconnect against stale SSE callbacks: do not call refreshTasks
      // if the SSE was disabled or the effect unmounted while reconnect was pending.
      onReconnect: () => {
        contextVersionAtStart = projectContextVersionRef.current;
        if (!active) return;
        if (isStale()) {
          traceDroppedStaleEvent();
          return;
        }
        recordResumeEvent({
          view: "useTasks",
          trigger: "sse-reconnect",
          projectId,
          replayAttempted: false,
        });
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

  const moveTask = useCallback(async (
    id: string,
    column: ColumnId,
    optionsOrPosition?: { preserveProgress?: boolean } | number,
  ): Promise<Task> => {
    return normalizeTask(await api.moveTask(id, column, projectId, optionsOrPosition));
  }, [projectId]);

  const pauseTask = useCallback(async (id: string): Promise<Task> => {
    return normalizeTask(await api.pauseTask(id, projectId));
  }, [projectId]);

  const unpauseTask = useCallback(async (id: string): Promise<Task> => {
    return normalizeTask(await api.unpauseTask(id, projectId));
  }, [projectId]);

  const deleteTask = useCallback(async (
    id: string,
    options?: {
      removeDependencyReferences?: boolean;
      removeLineageReferences?: boolean;
      githubIssueAction?: GithubIssueAction;
      allowResurrection?: boolean;
    },
  ): Promise<Task> => {
    const deletedTask = normalizeTask(await api.deleteTask(id, projectId, options));
    /*
    FNXC:TaskDeletion 2026-06-29-18:52:
    Local deletes must update the shared useTasks array immediately because the Board and right-dock Tasks list both render from this state and should not wait for SSE or a refetch after the API confirms deletion.

    FNXC:TaskDeletionCache 2026-06-29-20:11:
    Project-scoped SWR hydration must remove the deleted task after the API confirms deletion, otherwise an immediate remount can hydrate a stale row before the next fetch. Only the active project's task cache key is touched; if the cached envelope has an unexpected shape, clear that key instead of writing possibly stale data.

    FNXC:TaskDeletionCache 2026-06-29-21:04:
    Delete success must also invalidate refreshes that began before the API call completed; otherwise a late pre-delete snapshot can rehydrate the removed card in Board and the right-dock Tasks list until the next live update.
    */
    // Invalidate refreshes that started before the delete succeeded so an older
    // server snapshot cannot overwrite the locally removed row after this point.
    fetchVersionRef.current++;

    if (projectId) {
      const cacheKey = `${SWR_CACHE_KEYS.TASKS_PREFIX}${projectId}`;
      const cachedTasks = readCache<unknown>(cacheKey, { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
      if (Array.isArray(cachedTasks)) {
        const nextCachedTasks = cachedTasks.filter((task): task is Task => {
          return Boolean(task && typeof task === "object" && (task as Task).id !== id);
        });
        writeCache(cacheKey, nextCachedTasks, { maxBytes: 500_000 });
      } else if (cachedTasks === null) {
        const nextCurrentTasks = tasksRef.current.filter((task) => task.id !== id);
        writeCache(cacheKey, nextCurrentTasks.length > 500 ? nextCurrentTasks.slice(0, 500) : nextCurrentTasks, { maxBytes: 500_000 });
      } else {
        clearCache(cacheKey);
      }
    }
    setTasks((prev) => prev.filter((task) => task.id !== id));
    return deletedTask;
  }, [projectId]);

  const mergeTask = useCallback(async (id: string): Promise<MergeResult> => {
    return api.mergeTask(id, projectId);
  }, [projectId]);

  const retryTask = useCallback(async (id: string): Promise<Task> => {
    const retriedTask = normalizeTask(await api.retryTask(id, projectId));
    /*
    FNXC:DashboardTaskRetry 2026-06-30-12:57:
    Manual retry success is a user-visible state boundary. Replace matching rows in shared hook state and the project SWR cache as soon as the retry API returns so Board/List/detail/right-dock retry affordances do not depend on later SSE, polling, remount, or route re-entry to clear stale failed/stuck state.

    FNXC:DashboardTaskRetry 2026-06-30-12:58:
    Retry success also invalidates refreshes that began before the API returned; a late pre-retry fetch snapshot must not rehydrate the failed card after the operator has already received server confirmation for the retry.
    */
    fetchVersionRef.current++;

    const projectUpdatedTasks = (currentTasks: Task[]) => currentTasks.map((task) => (task.id === id ? retriedTask : task));

    if (projectId) {
      const cacheKey = `${SWR_CACHE_KEYS.TASKS_PREFIX}${projectId}`;
      const cachedTasks = readCache<unknown>(cacheKey, { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
      if (Array.isArray(cachedTasks)) {
        const cacheContainsOnlyTaskRows = cachedTasks.every((task) => Boolean(task && typeof task === "object" && typeof (task as Task).id === "string"));
        if (cacheContainsOnlyTaskRows) {
          const nextCachedTasks = cachedTasks.map((task) => ((task as Task).id === id ? retriedTask : normalizeTask(task as Task)));
          writeCache(cacheKey, nextCachedTasks.length > 500 ? nextCachedTasks.slice(0, 500) : nextCachedTasks, { maxBytes: 500_000 });
        } else {
          clearCache(cacheKey);
        }
      } else if (cachedTasks === null) {
        const nextCurrentTasks = projectUpdatedTasks(tasksRef.current);
        writeCache(cacheKey, nextCurrentTasks.length > 500 ? nextCurrentTasks.slice(0, 500) : nextCurrentTasks, { maxBytes: 500_000 });
      } else {
        clearCache(cacheKey);
      }
    }

    setTasks((prev) => {
      const next = projectUpdatedTasks(prev);
      tasksRef.current = next;
      return next;
    });
    return retriedTask;
  }, [projectId]);

  const resetTask = useCallback(async (id: string): Promise<Task> => {
    return normalizeTask(await api.resetTask(id, projectId));
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
    updates: { title?: string; description?: string; dependencies?: string[]; dismissNearDuplicate?: boolean; githubTracking?: { enabled?: boolean } }
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

  const archiveTask = useCallback(async (
    id: string,
    options?: { removeLineageReferences?: boolean },
  ): Promise<Task> => {
    const task = normalizeTask(await api.archiveTask(id, projectId, options));
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

  /*
  FNXC:TaskRevert 2026-07-05-00:00 (FN-7525):
  Client-side `revertTask` op. Deliberately does NOT patch the source task's
  column/status in local state — the git/AI-undo route never moves the
  source task backward (see the `FNXC:TaskRevert` route contract). On success
  (either a clean git revert producing a new commit, or an AI-undo task being
  created) we re-fetch via `refreshTasksRef` so the board picks up the new
  AI-undo task / any lineage changes without us guessing at the shape of the
  update ourselves.
  */
  const revertTask = useCallback(async (
    id: string,
    body?: api.RevertTaskOptions,
  ): Promise<api.RevertTaskResult> => {
    const result = await api.revertTask(id, projectId, body);
    void refreshTasksRef.current?.();
    return result;
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

    const normalizedTasks = filterActiveTasks(incomingTasks.map(normalizeTask));
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

  return { tasks, isStale, lastRefreshErrorAt, createTask, moveTask, pauseTask, unpauseTask, deleteTask, mergeTask, retryTask, resetTask, duplicateTask, updateTask, archiveTask, unarchiveTask, revertTask, archiveAllDone, loadArchivedTasks, includeArchived, refreshTasks, ingestCreatedTasks, lastFetchTimeMs: lastFetchTimeMs.current };
}
