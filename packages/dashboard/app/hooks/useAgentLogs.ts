import { useState, useEffect, useRef, useCallback } from "react";
import type { AgentLogEntry } from "@fusion/core";
import { fetchAgentLogs } from "../api";

export const MAX_LOG_ENTRIES = 500;

/**
 * Cap the total number of log entries to `MAX_LOG_ENTRIES`.
 *
 * This is a **whole-list cap** — it limits how many entries are kept
 * in memory, not the content of any individual entry.  Per-entry `text`
 * and `detail` fields are never truncated anywhere in the pipeline
 * (persistence → API → SSE → hook → rendering).
 */
function capLogEntries(entries: AgentLogEntry[]): AgentLogEntry[] {
  return entries.length > MAX_LOG_ENTRIES
    ? entries.slice(-MAX_LOG_ENTRIES)
    : entries;
}

/**
 * Hook that manages agent log fetching and live SSE streaming for a task.
 *
 * Features project-context isolation to prevent cross-project log bleed:
 * - Treats `{projectId, taskId}` as a context key
 * - Clears entries immediately on context change (project or task switch)
 * - Rejects late fetch responses from previous contexts
 * - Rejects stale SSE events from previous EventSource instances
 *
 * When `enabled` is true:
 * 1. Fetches recent historical logs via GET /api/tasks/:id/logs?limit=500
 * 2. Opens an EventSource to /api/tasks/:id/logs/stream for live updates
 * 3. Merges historical + live entries in order
 *
 * When `enabled` becomes false or the component unmounts, the EventSource
 * is closed to avoid unnecessary SSE connections.
 */
export function useAgentLogs(taskId: string | null, enabled: boolean, projectId?: string) {
  const [entries, setEntries] = useState<AgentLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // Refs for state that needs to survive re-renders
  const eventSourceRef = useRef<EventSource | null>(null);
  const cancelledRef = useRef(false);

  // Track the project context version to detect stale SSE events after project switches.
  // Incremented whenever projectId changes, invalidating any in-flight SSE handlers.
  const projectContextVersionRef = useRef(0);

  // Track previous values to detect context changes
  const previousTaskIdRef = useRef<string | null>(taskId);
  const previousProjectIdRef = useRef<string | undefined>(projectId);
  const previousEnabledRef = useRef(enabled);

  // Track request version to reject stale fetch completions
  const requestVersionRef = useRef(0);

  // Detect context changes and clear state immediately
  const contextChanged =
    previousTaskIdRef.current !== taskId ||
    previousProjectIdRef.current !== projectId ||
    previousEnabledRef.current !== enabled;

  if (contextChanged) {
    previousTaskIdRef.current = taskId;
    previousProjectIdRef.current = projectId;
    previousEnabledRef.current = enabled;
    projectContextVersionRef.current++;
    cancelledRef.current = true;

    // Clear entries immediately on context change to prevent stale data visibility
    setEntries([]);
    setLoading(false);

    // Close existing EventSource
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }

  useEffect(() => {
    if (!taskId || !enabled) {
      // Close any existing connection when disabled
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    // Capture context version at effect start - stale SSE events will be rejected
    const contextVersionAtStart = projectContextVersionRef.current;
    const requestVersion = ++requestVersionRef.current;
    cancelledRef.current = false;

    // Capture taskId and projectId at effect start for comparison
    const currentTaskId = taskId;
    const currentProjectId = projectId;

    async function init() {
      if (!currentTaskId) return;

      setLoading(true);
      try {
        const historical = await fetchAgentLogs(currentTaskId, currentProjectId, { limit: MAX_LOG_ENTRIES });

        // Reject stale response: check context version and request version
        if (cancelledRef.current ||
            projectContextVersionRef.current !== contextVersionAtStart ||
            requestVersionRef.current !== requestVersion) {
          return;
        }
        setEntries(capLogEntries(historical));
      } catch {
        // Reject stale error: check context version and request version
        if (cancelledRef.current ||
            projectContextVersionRef.current !== contextVersionAtStart ||
            requestVersionRef.current !== requestVersion) {
          return;
        }
        setEntries([]);
      } finally {
        // Only update loading state if not cancelled and not stale
        if (!cancelledRef.current &&
            projectContextVersionRef.current === contextVersionAtStart &&
            requestVersionRef.current === requestVersion) {
          setLoading(false);
        }
      }

      // Open SSE connection for live updates
      const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
      const es = new EventSource(`/api/tasks/${currentTaskId}/logs/stream${query}`);
      eventSourceRef.current = es;

      es.addEventListener("agent:log", (e) => {
        // Reject events from stale contexts (project/task switch)
        if (cancelledRef.current ||
            projectContextVersionRef.current !== contextVersionAtStart) {
          return;
        }
        try {
          const entry: AgentLogEntry = JSON.parse(e.data);
          setEntries((prev) => capLogEntries([...prev, entry]));
        } catch {
          // skip malformed events
        }
      });
    }

    void init();

    return () => {
      cancelledRef.current = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [taskId, enabled, projectId]);

  const clear = useCallback(() => setEntries([]), []);

  return { entries, loading, clear };
}
