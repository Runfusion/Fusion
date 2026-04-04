import { useState, useEffect, useRef } from "react";

/** Log entry from an agent's execution stream */
export interface TranscriptEntry {
  type: string;
  content: string;
  timestamp?: string;
}

export function useLiveTranscript(taskId: string | undefined) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!taskId) {
      setEntries([]);
      setIsConnected(false);
      return;
    }

    const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/logs/stream`);
    esRef.current = es;

    es.addEventListener("agent:log", (event) => {
      try {
        const entry = JSON.parse(event.data) as TranscriptEntry;
        setEntries(prev => [entry, ...prev]);
      } catch { /* skip */ }
    });

    es.addEventListener("open", () => setIsConnected(true));
    es.addEventListener("error", () => setIsConnected(false));

    return () => {
      es.close();
      esRef.current = null;
      setIsConnected(false);
    };
  }, [taskId]);

  return { entries, isConnected };
}
