import { useState, useEffect, useRef } from "react";

/**
 * Log entry from an agent's execution stream.
 *
 * Note: SSE payloads from `/api/tasks/:id/logs/stream` contain `text` field
 * (matching `AgentLogEntry` from `@fusion/core`). This interface normalizes
 * to `text` for rendering. Legacy payloads with `content` are also supported
 * for backward compatibility.
 */
export interface TranscriptEntry {
  type: string;
  /** Canonical text content — matches `AgentLogEntry.text` */
  text: string;
  timestamp?: string;
  /** Legacy field — normalized to `text` if present */
  content?: string;
}

/**
 * Hook that manages live transcript streaming for a task.
 *
 * Features project-context isolation to prevent cross-project transcript bleed:
 * - Tracks project context version to detect stale events after project switches
 * - Resets entries and connection state immediately on context change
 * - Rejects stale SSE events from previous EventSource instances
 *
 * When `taskId` changes, a new SSE connection is opened for the new task.
 * When `projectId` changes, all state is reset and a new connection is opened.
 */
export function useLiveTranscript(taskId: string | undefined, projectId?: string) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  // Refs for state that needs to survive re-renders
  const esRef = useRef<EventSource | null>(null);

  // Track the project context version to detect stale events after project switches.
  // Incremented whenever projectId changes, invalidating any in-flight SSE handlers.
  const projectContextVersionRef = useRef(0);

  // Track previous values to detect context changes
  const previousTaskIdRef = useRef<string | undefined>(taskId);
  const previousProjectIdRef = useRef<string | undefined>(projectId);

  // Detect context changes and reset state immediately
  const contextChanged =
    previousTaskIdRef.current !== taskId ||
    previousProjectIdRef.current !== projectId;

  if (contextChanged) {
    previousTaskIdRef.current = taskId;
    previousProjectIdRef.current = projectId;
    projectContextVersionRef.current++;

    // Close existing EventSource
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    // Reset state immediately to prevent stale data visibility
    setEntries([]);
    setIsConnected(false);
  }

  useEffect(() => {
    if (!taskId) {
      setEntries([]);
      setIsConnected(false);
      return;
    }

    // Capture context version at effect start - stale events will be rejected
    const contextVersionAtStart = projectContextVersionRef.current;

    // Build stream URL with optional projectId for multi-project support
    let url = `/api/tasks/${encodeURIComponent(taskId)}/logs/stream`;
    if (projectId) {
      url += `?projectId=${encodeURIComponent(projectId)}`;
    }

    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("agent:log", (event) => {
      // Reject events from stale contexts (project/task switch)
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        return;
      }

      try {
        const raw = JSON.parse(event.data) as Partial<TranscriptEntry>;
        // Normalize: canonical `text` field, with legacy `content` fallback
        // This ensures both current SSE payloads and any legacy payloads render correctly
        const entry: TranscriptEntry = {
          type: raw.type ?? "text",
          text: raw.text ?? raw.content ?? "",
          timestamp: raw.timestamp,
          content: raw.content,
        };
        setEntries(prev => [entry, ...prev]);
      } catch { /* skip malformed events */ }
    });

    es.addEventListener("open", () => {
      // Only update connected state if not stale
      if (projectContextVersionRef.current === contextVersionAtStart) {
        setIsConnected(true);
      }
    });

    es.addEventListener("error", () => {
      // Only update connected state if not stale
      if (projectContextVersionRef.current === contextVersionAtStart) {
        setIsConnected(false);
      }
    });

    return () => {
      es.close();
      esRef.current = null;

      // Only reset state if not stale
      if (projectContextVersionRef.current === contextVersionAtStart) {
        setIsConnected(false);
      }
    };
  }, [taskId, projectId]);

  return { entries, isConnected };
}
