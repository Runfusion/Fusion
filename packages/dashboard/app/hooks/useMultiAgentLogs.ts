import { useState, useEffect, useRef, useCallback } from "react";
import type { AgentLogEntry } from "@fusion/core";
import { fetchAgentLogsWithMeta } from "../api";
import { subscribeSse } from "../sse-bus";
import {
  appendLiveEntry,
  appendWithoutDuplicates,
  capLogEntries,
  countLeadingGapMarkers,
  isLogGapMarker,
  reconcileReconnectedEntries,
} from "./logStreamReconcile";

/*
FNXC:AgentLogResync 2026-07-26-16:35:
Buffer bounding, gap marking, and reconnect reconciliation are imported from ./logStreamReconcile,
the single implementation shared with useAgentLogs. Both hooks tail the same live-only
`/api/tasks/:id/logs/stream`; a hand-copied reconcile is exactly how the silent suspend-gap defect
survived a second round, so this hook must never grow a private variant.
Re-exported because existing call sites and tests import MAX_LOG_ENTRIES from this module.
*/
export { MAX_LOG_ENTRIES } from "./logStreamReconcile";

const INITIAL_LOAD_LIMIT = 100;

export interface TaskLogState {
  entries: AgentLogEntry[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  total: number | null;
  clear: () => void;
  loadMore: () => Promise<void>;
}

export type LogStateMap = Record<string, TaskLogState>;

interface InitState {
  entries: AgentLogEntry[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  total: number | null;
}

/**
 * Hook that manages agent log fetching and live SSE streaming for multiple tasks.
 *
 * Features:
 * - **Pagination**: Initial load fetches 100 entries per task. Use `loadMore()` to fetch older entries per task.
 * - **Project-context isolation**: Prevents cross-project log bleed via context versioning.
 * - **Live streaming**: SSE events append new entries to the end of each task's list.
 *
 * For each task ID in the provided array:
 * 1. Fetches recent historical logs via GET /api/tasks/:id/logs?limit=100
 * 2. Opens an EventSource to /api/tasks/:id/logs/stream for live updates
 * 3. Merges historical + live entries in order
 *
 * When task IDs are added or removed, connections are opened/closed accordingly.
 * When the component unmounts, all EventSources are closed to prevent memory leaks.
 *
 * **Reconnect semantics**: the stream replays nothing on open, so every reconnect (SSE error,
 * heartbeat timeout, or the hidden-tab suspend/resume) refetches that task's authoritative newest
 * page and reconciles it with the buffer. Where reconciliation cannot be proven, a gap marker is
 * rendered (`isLogGapMarker`) rather than implying continuity.
 */
export function useMultiAgentLogs(taskIds: string[], projectId?: string): LogStateMap {
  // Store state per task
  const [stateMap, setStateMap] = useState<Record<string, InitState>>({});

  // Refs for state that needs to survive re-renders
  const unsubscribesRef = useRef<Record<string, () => void>>({});
  const initializingRef = useRef<Set<string>>(new Set());
  const cancelledRef = useRef<Record<string, boolean>>({});
  const pendingLiveEntriesRef = useRef<Record<string, AgentLogEntry[]>>({});
  const loadingMoreRef = useRef<Record<string, boolean>>({});
  /*
  FNXC:AgentLogResync 2026-07-26-16:40:
  Reconnect bookkeeping, per task. `resyncInFlightRef` collapses a burst of reconnects into one
  refetch; `resyncPendingRef` parks live events that race that refetch so the merge sees a stable
  buffer snapshot and cannot duplicate (event present in both the page and the stream) or swallow
  (event applied to a buffer the merge then overwrites) a line.
  */
  const resyncInFlightRef = useRef<Record<string, boolean>>({});
  const resyncPendingRef = useRef<Record<string, AgentLogEntry[]>>({});
  /*
  FNXC:AgentLogPaging 2026-07-26-16:44:
  "The live tail dropped older entries" flag, per task. It forces `hasMore` on so the reader always
  has a way back to the truncated history, and is sticky ONLY until an authoritative fetch reports
  `hasMore:false` — that response proves the buffer reaches entry 0, so a permanently-true flag would
  leave a "load older" control that fetches past the end and never changes anything.
  */
  const trimmedLiveTailRef = useRef<Record<string, boolean>>({});

  // Track project context version to detect stale events after project switches.
  // Incremented whenever projectId changes, invalidating any in-flight SSE handlers.
  const projectContextVersionRef = useRef(0);

  // Track previous projectId to detect project switches
  const previousProjectIdRef = useRef<string | undefined>(projectId);

  // Detect project switch and clear all state immediately
  const projectSwitched = previousProjectIdRef.current !== projectId;
  if (projectSwitched) {
    previousProjectIdRef.current = projectId;
    projectContextVersionRef.current++;

    // Drop all existing SSE subscriptions and reset state
    for (const [taskId, unsub] of Object.entries(unsubscribesRef.current)) {
      cancelledRef.current[taskId] = true;
      unsub();
    }
    unsubscribesRef.current = {};
    initializingRef.current.clear();
    cancelledRef.current = {};
    pendingLiveEntriesRef.current = {};
    loadingMoreRef.current = {};
    resyncInFlightRef.current = {};
    resyncPendingRef.current = {};
    trimmedLiveTailRef.current = {};

    // Clear all state immediately to prevent stale data visibility
    setStateMap({});
  }

  // Create clear function for a specific task
  const createClearFn = useCallback((taskId: string) => {
    return () => {
      setStateMap((prev) => {
        const current = prev[taskId];
        if (!current) return prev;
        pendingLiveEntriesRef.current[taskId] = [];
        resyncPendingRef.current[taskId] = [];
        trimmedLiveTailRef.current[taskId] = false;
        return {
          ...prev,
          [taskId]: { ...current, entries: [] },
        };
      });
    };
  }, []);

  // Create loadMore function for a specific task
  const createLoadMoreFn = useCallback((taskId: string, currentEntries: AgentLogEntry[]) => {
    return async () => {
      if (loadingMoreRef.current[taskId]) return;

      const contextVersionAtStart = projectContextVersionRef.current;
      loadingMoreRef.current[taskId] = true;

      /*
      FNXC:AgentLogPaging 2026-07-26-16:50:
      The server offset counts back from the newest entry, so it must be the number of REAL entries
      held. A synthetic gap marker is client-only and would shift the whole page by one, re-fetching
      an entry the reader already has and leaving a one-entry hole below it.
      */
      const offset = currentEntries.length - countLeadingGapMarkers(currentEntries);

      // Update loading state
      setStateMap((prev) => {
        const current = prev[taskId];
        if (!current) return prev;
        return { ...prev, [taskId]: { ...current, loadingMore: true } };
      });

      try {
        const result = await fetchAgentLogsWithMeta(taskId, projectId, {
          limit: INITIAL_LOAD_LIMIT,
          offset,
        });

        // Reject stale response
        if (cancelledRef.current[taskId] ||
            projectContextVersionRef.current !== contextVersionAtStart) {
          return;
        }

        /*
        FNXC:AgentLogPaging 2026-07-26-16:52:
        Older entries are PREPENDED — they belong below what the reader already holds, and the
        previous append-to-the-end version rendered them as if the agent had just emitted them.
        The result is deliberately NOT re-capped: capLogEntries keeps the NEWEST N, so capping here
        would discard the very page the reader just asked for. Paging is an explicit expansion of the
        buffer; the ring ceiling only governs unattended live growth.
        A gap marker at the head is retired once real data closes the hole (page returned entries) or
        the server proves nothing older exists (`hasMore:false`).
        */
        const retireGapMarker = result.entries.length > 0 || !result.hasMore;
        if (!result.hasMore) trimmedLiveTailRef.current[taskId] = false;
        setStateMap((prev) => {
          const current = prev[taskId];
          if (!current) return prev;
          const base = retireGapMarker
            ? current.entries.filter((entry) => !isLogGapMarker(entry))
            : current.entries;
          return {
            ...prev,
            [taskId]: {
              ...current,
              entries: [...result.entries, ...base],
              hasMore: result.hasMore,
              total: result.total,
              loadingMore: false,
            },
          };
        });
      } catch {
        // Silently fail on load more errors
        setStateMap((prev) => {
          const current = prev[taskId];
          if (!current) return prev;
          return { ...prev, [taskId]: { ...current, loadingMore: false } };
        });
      } finally {
        loadingMoreRef.current[taskId] = false;
      }
    };
  }, [projectId]);

  // Stable comparison of task IDs and projectId to prevent effect re-runs on every render
  const taskIdsKey = taskIds.join(",");
  const stableKey = [taskIdsKey, projectId ?? ""].join("|");

  // Main effect to manage connections
  useEffect(() => {
    const currentIds = new Set(taskIds);
    const subs = unsubscribesRef.current;
    const initializing = initializingRef.current;
    const cancelled = cancelledRef.current;

    // Capture context version at effect start - stale events will be rejected
    const contextVersionAtStart = projectContextVersionRef.current;

    // Track which task IDs need state initialization (not already in stateMap)
    const newTaskIds: string[] = [];
    for (const taskId of taskIds) {
      if (!stateMap[taskId]) {
        newTaskIds.push(taskId);
      }
    }

    // Only initialize state for new tasks that aren't already in stateMap
    if (newTaskIds.length > 0) {
      setStateMap((prev) => {
        const updates: Record<string, InitState> = {};
        for (const taskId of newTaskIds) {
          if (!prev[taskId]) {
            updates[taskId] = { entries: [], loading: true, loadingMore: false, hasMore: false, total: null };
          }
        }
        if (Object.keys(updates).length === 0) return prev;
        return { ...prev, ...updates };
      });
    }

    // Drop subscriptions for tasks no longer in the list
    const removedTaskIds: string[] = [];
    for (const [taskId, unsub] of Object.entries(subs)) {
      if (!currentIds.has(taskId)) {
        cancelled[taskId] = true;
        unsub();
        delete subs[taskId];
        initializing.delete(taskId);
        delete cancelled[taskId];
        delete pendingLiveEntriesRef.current[taskId];
        delete loadingMoreRef.current[taskId];
        delete resyncInFlightRef.current[taskId];
        delete resyncPendingRef.current[taskId];
        delete trimmedLiveTailRef.current[taskId];
        removedTaskIds.push(taskId);
      }
    }

    // Only remove state for disconnected tasks if there are any
    if (removedTaskIds.length > 0) {
      setStateMap((prev) => {
        let hasChanges = false;
        for (const taskId of removedTaskIds) {
          if (taskId in prev) {
            hasChanges = true;
            break;
          }
        }
        if (!hasChanges) return prev;
        const newState: Record<string, InitState> = {};
        for (const [id, state] of Object.entries(prev)) {
          if (!removedTaskIds.includes(id)) {
            newState[id] = state;
          }
        }
        return newState;
      });
    }

    // Mark removed pending initializations as cancelled even if EventSource not created yet
    for (const taskId of Object.keys(cancelled)) {
      if (!currentIds.has(taskId)) {
        cancelled[taskId] = true;
        initializing.delete(taskId);
        delete pendingLiveEntriesRef.current[taskId];
        delete loadingMoreRef.current[taskId];
        delete resyncInFlightRef.current[taskId];
        delete resyncPendingRef.current[taskId];
        delete trimmedLiveTailRef.current[taskId];
      }
    }

    // Initialize connections for current tasks
    for (const taskId of taskIds) {
      // Skip if already connected or currently initializing
      if (subs[taskId] || initializing.has(taskId)) continue;

      initializing.add(taskId);
      cancelled[taskId] = false;
      pendingLiveEntriesRef.current[taskId] = [];
      resyncPendingRef.current[taskId] = [];
      resyncInFlightRef.current[taskId] = false;
      trimmedLiveTailRef.current[taskId] = false;

      // Build SSE URL with optional projectId for multi-project support
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

      const isStale = () =>
        cancelled[taskId] || projectContextVersionRef.current !== contextVersionAtStart;

      /*
      FNXC:AgentLogResync 2026-07-26-16:58:
      Missed-event recovery. The per-task log stream replays nothing on connect, so any SSE gap (error
      reconnect, or the mobile hidden-tab suspend) drops every entry emitted while the socket was down
      and used to leave a silent hole in a transcript that still rendered as contiguous.

      On reopen, refetch the authoritative newest page and RECONCILE it with the buffer instead of
      replacing the buffer outright: replacing threw away paged-back history and could still hide a
      gap larger than one page behind a seamless-looking list. reconcileReconnectedEntries splices
      when the two windows provably overlap and otherwise resyncs behind a VISIBLE gap marker, so the
      UI never implies continuity it cannot guarantee.
      A trim during the merge means older entries are still server-side, which forces `hasMore` on.
      If the refetch itself fails the buffer is left alone and the parked live events are flushed — a
      degraded live tail beats dropping lines on the floor.
      */
      const resyncTaskLogs = () => {
        if (isStale() || resyncInFlightRef.current[taskId]) return;
        resyncInFlightRef.current[taskId] = true;
        resyncPendingRef.current[taskId] = [];
        let reconciled = false;
        void fetchAgentLogsWithMeta(taskId, projectId, { limit: INITIAL_LOAD_LIMIT })
          .then((result) => {
            if (isStale()) return;
            const pending = resyncPendingRef.current[taskId] ?? [];
            resyncPendingRef.current[taskId] = [];
            reconciled = true;
            setStateMap((prev) => {
              const current = prev[taskId];
              if (!current) return prev;
              const outcome = reconcileReconnectedEntries(current.entries, result.entries, pending, taskId);
              // Idempotent ref write: React may double-invoke this updater in StrictMode.
              if (outcome.trimmed) trimmedLiveTailRef.current[taskId] = true;
              return {
                ...prev,
                [taskId]: {
                  ...current,
                  entries: outcome.entries,
                  hasMore: result.hasMore,
                  total: result.total,
                },
              };
            });
            // An offset-0 page reporting hasMore:false means the whole log fits in the page just
            // merged, so nothing older is left behind.
            if (!result.hasMore) trimmedLiveTailRef.current[taskId] = false;
          })
          .catch(() => {
            // Keep the current entries on failure; the next reopen retries.
          })
          .finally(() => {
            resyncInFlightRef.current[taskId] = false;
            if (!reconciled && !isStale()) {
              const pending = resyncPendingRef.current[taskId] ?? [];
              resyncPendingRef.current[taskId] = [];
              if (pending.length > 0) {
                setStateMap((prev) => {
                  const current = prev[taskId];
                  if (!current) return prev;
                  return {
                    ...prev,
                    [taskId]: { ...current, entries: appendWithoutDuplicates(current.entries, pending) },
                  };
                });
              }
            }
          });
      };

      subs[taskId] = subscribeSse(
        `/api/tasks/${taskId}/logs/stream${query}`,
        {
          onReconnect: resyncTaskLogs,
          events: {
            "agent:log": (e) => {
              if (isStale()) return;
              try {
                const entry: AgentLogEntry = JSON.parse(e.data);
                /*
                FNXC:AgentLogResync 2026-07-26-17:02:
                While a reconnect refetch is in flight the buffer must not move: park the event and
                let the reconciliation append it after the authoritative page (deduped). `total` is
                left alone here because the resync sets the authoritative count.
                */
                if (resyncInFlightRef.current[taskId]) {
                  resyncPendingRef.current[taskId] = capLogEntries([
                    ...(resyncPendingRef.current[taskId] ?? []),
                    entry,
                  ]);
                  return;
                }

                pendingLiveEntriesRef.current[taskId] = capLogEntries([
                  ...(pendingLiveEntriesRef.current[taskId] ?? []),
                  entry,
                ]);

                setStateMap((prev) => {
                  const current = prev[taskId];
                  if (!current) return prev;
                  const appended = appendLiveEntry(current.entries, entry);
                  // Idempotent ref write: React may double-invoke this updater in StrictMode.
                  if (appended.trimmed) trimmedLiveTailRef.current[taskId] = true;
                  return {
                    ...prev,
                    [taskId]: {
                      ...current,
                      entries: appended.entries,
                      total: current.total !== null ? current.total + 1 : null,
                    },
                  };
                });
              } catch {
                // skip malformed events
              }
            },
          },
        },
      );

      // Fetch historical logs with projectId using pagination
      void fetchAgentLogsWithMeta(taskId, projectId, { limit: INITIAL_LOAD_LIMIT })
        .then((result) => {
          // Reject stale response from previous context
          if (isStale()) return;

          const pendingLive = pendingLiveEntriesRef.current[taskId] ?? [];
          if (!result.hasMore) trimmedLiveTailRef.current[taskId] = false;
          setStateMap((prev) => ({
            ...prev,
            [taskId]: {
              ...prev[taskId],
              entries: capLogEntries([...result.entries, ...pendingLive]),
              loading: false,
              hasMore: result.hasMore,
              total: result.total,
            },
          }));
        })
        .catch(() => {
          // Reject stale error from previous context
          if (isStale()) return;

          const pendingLive = pendingLiveEntriesRef.current[taskId] ?? [];
          setStateMap((prev) => ({
            ...prev,
            [taskId]: {
              ...prev[taskId],
              entries: capLogEntries(pendingLive),
              loading: false,
              hasMore: false,
              total: null,
            },
          }));
        })
        .finally(() => {
          pendingLiveEntriesRef.current[taskId] = [];
          initializingRef.current.delete(taskId);
        });
    }

    // Update previous task IDs ref for cleanup comparison
    const initialTaskIds = [...taskIds];

    // Cleanup on effect re-run or unmount
    return () => {
      // Only drop subscriptions for tasks that were removed (not-in current taskIds)
      for (const taskId of initialTaskIds) {
        if (!currentIds.has(taskId)) {
          cancelledRef.current[taskId] = true;

          const unsub = unsubscribesRef.current[taskId];
          if (unsub) {
            unsub();
            delete unsubscribesRef.current[taskId];
          }

          initializingRef.current.delete(taskId);
        }
      }
    };
  }, [stableKey]); // Use stable key including projectId

  // Drop all subscriptions on unmount
  useEffect(() => {
    return () => {
      for (const taskId of Object.keys(cancelledRef.current)) {
        cancelledRef.current[taskId] = true;
      }

      for (const unsub of Object.values(unsubscribesRef.current)) {
        unsub();
      }

      unsubscribesRef.current = {};
      initializingRef.current.clear();
      cancelledRef.current = {};
      pendingLiveEntriesRef.current = {};
      loadingMoreRef.current = {};
      resyncInFlightRef.current = {};
      resyncPendingRef.current = {};
      trimmedLiveTailRef.current = {};
    };
  }, []);

  // Build result map
  const result: LogStateMap = {};
  for (const taskId of taskIds) {
    const state = stateMap[taskId];
    const entries = state?.entries ?? [];
    result[taskId] = {
      entries,
      loading: state?.loading ?? true,
      loadingMore: state?.loadingMore ?? false,
      /*
      FNXC:AgentLogPaging 2026-07-26-17:08:
      A trimmed live tail, or a reconnect gap marker at the head, means older entries are still on
      the server, so the "load older" affordance must stay reachable even when the last fetch said
      otherwise. Both signals are retired by the response that proves the buffer reaches entry 0, so
      `hasMore` is true iff older entries actually remain.
      */
      hasMore:
        (state?.hasMore ?? false)
        || Boolean(trimmedLiveTailRef.current[taskId])
        || countLeadingGapMarkers(entries) > 0,
      total: state?.total ?? null,
      clear: createClearFn(taskId),
      loadMore: createLoadMoreFn(taskId, entries),
    };
  }

  return result;
}
