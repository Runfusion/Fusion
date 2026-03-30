import { useState, useEffect, useRef, useCallback } from "react";
import type { AgentLogEntry } from "@kb/core";
import { fetchAgentLogs } from "../api";

export const MAX_LOG_ENTRIES = 500;

function capLogEntries(entries: AgentLogEntry[]): AgentLogEntry[] {
  return entries.length > MAX_LOG_ENTRIES
    ? entries.slice(-MAX_LOG_ENTRIES)
    : entries;
}

/**
 * Hook that manages agent log fetching and live SSE streaming for a task.
 *
 * When `enabled` is true:
 * 1. Fetches historical logs via GET /api/tasks/:id/logs
 * 2. Opens an EventSource to /api/tasks/:id/logs/stream for live updates
 * 3. Merges historical + live entries in order
 *
 * When `enabled` becomes false or the component unmounts, the EventSource
 * is closed to avoid unnecessary SSE connections.
 */
export function useAgentLogs(taskId: string | null, enabled: boolean) {
  const [entries, setEntries] = useState<AgentLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!taskId || !enabled) {
      // Close any existing connection when disabled
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    let cancelled = false;

    async function init() {
      setLoading(true);
      try {
        const historical = await fetchAgentLogs(taskId);
        if (cancelled) return;
        setEntries(capLogEntries(historical));
      } catch {
        if (cancelled) return;
        setEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }

      // Open SSE connection for live updates
      const es = new EventSource(`/api/tasks/${taskId}/logs/stream`);
      eventSourceRef.current = es;

      es.addEventListener("agent:log", (e) => {
        if (cancelled) return;
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
      cancelled = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [taskId, enabled]);

  const clear = useCallback(() => setEntries([]), []);

  return { entries, loading, clear };
}
