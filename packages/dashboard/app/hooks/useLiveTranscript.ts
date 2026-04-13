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

export function useLiveTranscript(taskId: string | undefined, projectId?: string) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!taskId) {
      setEntries([]);
      setIsConnected(false);
      return;
    }

    // Build stream URL with optional projectId for multi-project support
    let url = `/api/tasks/${encodeURIComponent(taskId)}/logs/stream`;
    if (projectId) {
      url += `?projectId=${encodeURIComponent(projectId)}`;
    }

    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("agent:log", (event) => {
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

    es.addEventListener("open", () => setIsConnected(true));
    es.addEventListener("error", () => setIsConnected(false));

    return () => {
      es.close();
      esRef.current = null;
      setIsConnected(false);
    };
  }, [taskId, projectId]);

  return { entries, isConnected };
}
