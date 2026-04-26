import { useState, useEffect, useRef, useCallback } from "react";
import type { AgentLogEntry } from "@fusion/core";
import { fetchAgentLogsWithMeta } from "../api";
import { subscribeSse } from "../sse-bus";

export const MAX_LOG_ENTRIES = 500;
const INITIAL_LOAD_LIMIT = 100;

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
 * Features:
 * - **Pagination**: Initial load fetches 100 entries. Use `loadMore()` to fetch older entries.
 * - **Project-context isolation**: Prevents cross-project log bleed via context versioning.
 * - **Live streaming**: SSE events append new entries to the end of the list.
 *
 * **Pagination semantics**:
 * - Entries are returned in chronological order (oldest first) from the API
 * - Entries are stored in chronological order
 * - The UI displays entries in chronological order (oldest first)
 * - `loadMore()` fetches the next 100 older entries and prepends them
 *
 * When `enabled` is true:
 * 1. Fetches recent historical logs via GET /api/tasks/:id/logs?limit=100
 * 2. Opens an EventSource to /api/tasks/:id/logs/stream for live updates
 * 3. Merges historical + live entries in order
 *
 * When `enabled` becomes false or the component unmounts, the EventSource
 * is closed to avoid unnecessary SSE connections.
 *
 * @returns Object with entries, loading, clear, loadMore, hasMore, total
 */
export function useAgentLogs(taskId: string | null, enabled: boolean, projectId?: string) {
  const [entries, setEntries] = useState<AgentLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Refs for state that needs to survive re-renders
  const unsubscribeRef = useRef<(() => void) | null>(null);
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
    setHasMore(false);
    setTotal(null);
    setLoadingMore(false);

    // Drop existing SSE subscription
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  }

  useEffect(() => {
    if (!taskId || !enabled) {
      // Drop any existing subscription when disabled
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
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
      setLoadingMore(false);
      try {
        const result = await fetchAgentLogsWithMeta(currentTaskId, currentProjectId, { limit: INITIAL_LOAD_LIMIT });

        // Reject stale response: check context version and request version
        if (cancelledRef.current ||
            projectContextVersionRef.current !== contextVersionAtStart ||
            requestVersionRef.current !== requestVersion) {
          return;
        }
        setEntries(capLogEntries(result.entries));
        setHasMore(result.hasMore);
        setTotal(result.total);
      } catch {
        // Reject stale error: check context version and request version
        if (cancelledRef.current ||
            projectContextVersionRef.current !== contextVersionAtStart ||
            requestVersionRef.current !== requestVersion) {
          return;
        }
        setEntries([]);
        setHasMore(false);
        setTotal(null);
      } finally {
        // Only update loading state if not cancelled and not stale
        if (!cancelledRef.current &&
            projectContextVersionRef.current === contextVersionAtStart &&
            requestVersionRef.current === requestVersion) {
          setLoading(false);
        }
      }

      // Subscribe to the shared per-task log stream
      const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
      unsubscribeRef.current = subscribeSse(
        `/api/tasks/${currentTaskId}/logs/stream${query}`,
        {
          events: {
            "agent:log": (e) => {
              if (cancelledRef.current ||
                  projectContextVersionRef.current !== contextVersionAtStart) {
                return;
              }
              try {
                const entry: AgentLogEntry = JSON.parse(e.data);
                setEntries((prev) => capLogEntries([...prev, entry]));
                setTotal((prev) => (prev !== null ? prev + 1 : null));
              } catch {
                // skip malformed events
              }
            },
          },
        },
      );
    }

    void init();

    return () => {
      cancelledRef.current = true;
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [taskId, enabled, projectId]);

  /**
   * Load more older entries.
   * Fetches the next 100 older entries and prepends them to the existing list.
   */
  const loadMore = useCallback(async () => {
    if (!taskId || loadingMore) return;

    const contextVersionAtStart = projectContextVersionRef.current;
    const currentEntriesCount = entries.length;
    const currentTaskId = taskId;

    setLoadingMore(true);
    try {
      const result = await fetchAgentLogsWithMeta(currentTaskId, projectId, {
        limit: INITIAL_LOAD_LIMIT,
        offset: currentEntriesCount,
      });

      // Reject stale response
      if (cancelledRef.current ||
          projectContextVersionRef.current !== contextVersionAtStart) {
        return;
      }

      // Prepend older entries to the existing list
      setEntries((prev) => {
        const combined = [...result.entries, ...prev];
        return capLogEntries(combined);
      });
      setHasMore(result.hasMore);
      setTotal(result.total);
    } catch {
      // Silently fail on load more errors
    } finally {
      setLoadingMore(false);
    }
  }, [taskId, projectId, entries.length, loadingMore]);

  const clear = useCallback(() => setEntries([]), []);

  return { entries, loading, clear, loadMore, hasMore, total, loadingMore };
}
