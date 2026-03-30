import { useState, useEffect, useRef, useCallback } from "react";
import type { AgentLogEntry } from "@kb/core";
import { fetchAgentLogs } from "../api";

export interface TaskLogState {
  entries: AgentLogEntry[];
  loading: boolean;
  clear: () => void;
}

export type LogStateMap = Record<string, TaskLogState>;

interface InitState {
  entries: AgentLogEntry[];
  loading: boolean;
  es?: EventSource;
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

  // Create clear function for a specific task
  const createClearFn = useCallback((taskId: string) => {
    return () => {
      setStateMap((prev) => {
        const current = prev[taskId];
        if (!current) return prev;
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

    // Close connections for tasks no longer in the list
    for (const [taskId, es] of Object.entries(sources)) {
      if (!currentIds.has(taskId)) {
        es.close();
        delete sources[taskId];
        // Remove state for disconnected task
        setStateMap((prev) => {
          const { [taskId]: _, ...rest } = prev;
          return rest;
        });
      }
    }

    // Initialize state and connections for current tasks
    for (const taskId of taskIds) {
      // Initialize state if not present
      setStateMap((prev) => {
        if (prev[taskId]) return prev;
        return { ...prev, [taskId]: { entries: [], loading: true } };
      });

      // Skip if already connected
      if (sources[taskId]) continue;

      let cancelled = false;

      // Fetch historical logs and open SSE
      const init = async () => {
        try {
          const historical = await fetchAgentLogs(taskId);
          if (cancelled) return;
          
          setStateMap((prev) => ({
            ...prev,
            [taskId]: { ...prev[taskId], entries: historical, loading: false },
          }));
        } catch {
          if (cancelled) return;
          setStateMap((prev) => ({
            ...prev,
            [taskId]: { ...prev[taskId], entries: [], loading: false },
          }));
        }

        // Open SSE connection
        const es = new EventSource(`/api/tasks/${taskId}/logs/stream`);
        sources[taskId] = es;

        es.addEventListener("agent:log", (e) => {
          try {
            const entry: AgentLogEntry = JSON.parse(e.data);
            setStateMap((prev) => {
              const current = prev[taskId];
              if (!current) return prev;
              return {
                ...prev,
                [taskId]: { ...current, entries: [...current.entries, entry] },
              };
            });
          } catch {
            // skip malformed events
          }
        });
      };

      init();
    }

    // Cleanup on effect re-run or unmount
    return () => {
      // In Strict Mode, React runs effects twice.
      // We only want to close connections on actual unmount, not on every cleanup.
      // The actual closing of connections for removed tasks is handled above.
    };
  }, [taskIds]);

  // Close all connections on unmount
  useEffect(() => {
    return () => {
      for (const es of Object.values(sourcesRef.current)) {
        es.close();
      }
      sourcesRef.current = {};
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
