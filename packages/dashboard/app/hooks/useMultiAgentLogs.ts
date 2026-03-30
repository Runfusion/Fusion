import { useState, useEffect, useRef, useCallback } from "react";
import type { AgentLogEntry } from "@kb/core";
import { fetchAgentLogs } from "../api";

export const MAX_LOG_ENTRIES = 500;

function capLogEntries(entries: AgentLogEntry[]): AgentLogEntry[] {
  return entries.length > MAX_LOG_ENTRIES
    ? entries.slice(-MAX_LOG_ENTRIES)
    : entries;
}

export interface TaskLogState {
  entries: AgentLogEntry[];
  loading: boolean;
  clear: () => void;
}

export type LogStateMap = Record<string, TaskLogState>;

interface InitState {
  entries: AgentLogEntry[];
  loading: boolean;
}

/**
 * Hook that manages agent log fetching and live SSE streaming for multiple tasks.
 *
 * For each task ID in the provided array:
 * 1. Fetches historical logs via GET /api/tasks/:id/logs
 * 2. Opens an EventSource to /api/tasks/:id/logs/stream for live updates
 * 3. Merges historical + live entries in order
 *
 * When task IDs are added or removed, connections are opened/closed accordingly.
 * When the component unmounts, all EventSources are closed to prevent memory leaks.
 */
export function useMultiAgentLogs(taskIds: string[]): LogStateMap {
  // Store state per task
  const [stateMap, setStateMap] = useState<Record<string, InitState>>({});

  // Ref to track active EventSources
  const sourcesRef = useRef<Record<string, EventSource>>({});
  const initializingRef = useRef<Set<string>>(new Set());
  const cancelledRef = useRef<Record<string, boolean>>({});
  const pendingLiveEntriesRef = useRef<Record<string, AgentLogEntry[]>>({});

  // Create clear function for a specific task
  const createClearFn = useCallback((taskId: string) => {
    return () => {
      setStateMap((prev) => {
        const current = prev[taskId];
        if (!current) return prev;
        pendingLiveEntriesRef.current[taskId] = [];
        return {
          ...prev,
          [taskId]: { ...current, entries: [] },
        };
      });
    };
  }, []);

  // Main effect to manage connections
  useEffect(() => {
    const currentIds = new Set(taskIds);
    const sources = sourcesRef.current;
    const initializing = initializingRef.current;
    const cancelled = cancelledRef.current;

    // Close connections for tasks no longer in the list
    for (const [taskId, es] of Object.entries(sources)) {
      if (!currentIds.has(taskId)) {
        cancelled[taskId] = true;
        es.close();
        delete sources[taskId];
        initializing.delete(taskId);
        delete cancelled[taskId];
        delete pendingLiveEntriesRef.current[taskId];

        // Remove state for disconnected task
        setStateMap((prev) => {
          const { [taskId]: _, ...rest } = prev;
          return rest;
        });
      }
    }

    // Mark removed pending initializations as cancelled even if EventSource not created yet
    for (const taskId of Object.keys(cancelled)) {
      if (!currentIds.has(taskId)) {
        cancelled[taskId] = true;
        initializing.delete(taskId);
        delete pendingLiveEntriesRef.current[taskId];
      }
    }

    // Initialize state and connections for current tasks
    for (const taskId of taskIds) {
      // Initialize state if not present
      setStateMap((prev) => {
        if (prev[taskId]) return prev;
        return { ...prev, [taskId]: { entries: [], loading: true } };
      });

      // Skip if already connected or currently initializing
      if (sources[taskId] || initializing.has(taskId)) continue;

      initializing.add(taskId);
      cancelled[taskId] = false;
      pendingLiveEntriesRef.current[taskId] = [];

      // Open SSE connection immediately so rerenders cannot race a second setup
      const es = new EventSource(`/api/tasks/${taskId}/logs/stream`);
      sources[taskId] = es;

      const handleAgentLog = (e: MessageEvent) => {
        if (cancelled[taskId]) return;

        try {
          const entry: AgentLogEntry = JSON.parse(e.data);
          pendingLiveEntriesRef.current[taskId] = capLogEntries([
            ...(pendingLiveEntriesRef.current[taskId] ?? []),
            entry,
          ]);

          setStateMap((prev) => {
            const current = prev[taskId];
            if (!current) return prev;
            return {
              ...prev,
              [taskId]: { ...current, entries: capLogEntries([...current.entries, entry]) },
            };
          });
        } catch {
          // skip malformed events
        }
      };

      const handleError = () => {
        es.removeEventListener("agent:log", handleAgentLog);
        es.removeEventListener("error", handleError);

        if (sourcesRef.current[taskId] === es) {
          es.close();
          delete sourcesRef.current[taskId];
        }

        initializingRef.current.delete(taskId);
      };

      es.addEventListener("agent:log", handleAgentLog);
      es.addEventListener("error", handleError);

      // Fetch historical logs
      void fetchAgentLogs(taskId)
        .then((historical) => {
          if (cancelled[taskId]) return;

          const pendingLive = pendingLiveEntriesRef.current[taskId] ?? [];
          setStateMap((prev) => ({
            ...prev,
            [taskId]: {
              ...prev[taskId],
              entries: capLogEntries([...historical, ...pendingLive]),
              loading: false,
            },
          }));
        })
        .catch(() => {
          if (cancelled[taskId]) return;

          const pendingLive = pendingLiveEntriesRef.current[taskId] ?? [];
          setStateMap((prev) => ({
            ...prev,
            [taskId]: { ...prev[taskId], entries: capLogEntries(pendingLive), loading: false },
          }));
        })
        .finally(() => {
          pendingLiveEntriesRef.current[taskId] = [];
          initializingRef.current.delete(taskId);
        });
    }

    // Cleanup on effect re-run or unmount
    return () => {
      for (const taskId of taskIds) {
        cancelledRef.current[taskId] = true;

        const es = sourcesRef.current[taskId];
        if (es) {
          es.close();
          delete sourcesRef.current[taskId];
        }

        initializingRef.current.delete(taskId);
      }
    };
  }, [taskIds]);

  // Close all connections on unmount
  useEffect(() => {
    return () => {
      for (const taskId of Object.keys(cancelledRef.current)) {
        cancelledRef.current[taskId] = true;
      }

      for (const es of Object.values(sourcesRef.current)) {
        es.close();
      }

      sourcesRef.current = {};
      initializingRef.current.clear();
      cancelledRef.current = {};
      pendingLiveEntriesRef.current = {};
    };
  }, []);

  // Build result map
  const result: LogStateMap = {};
  for (const taskId of taskIds) {
    const state = stateMap[taskId];
    result[taskId] = {
      entries: state?.entries ?? [],
      loading: state?.loading ?? true,
      clear: createClearFn(taskId),
    };
  }

  return result;
}
