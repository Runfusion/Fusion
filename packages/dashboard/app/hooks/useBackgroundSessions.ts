import { useState, useEffect, useCallback, useRef } from "react";
import { fetchAiSessions, deleteAiSession, type AiSessionSummary } from "../api";

interface UseBackgroundSessionsResult {
  sessions: AiSessionSummary[];
  generating: number;
  needsInput: number;
  /** Active sessions filtered to type === "planning" only */
  planningSessions: AiSessionSummary[];
  dismissSession: (id: string) => void;
  refresh: () => void;
}

export function useBackgroundSessions(projectId?: string): UseBackgroundSessionsResult {
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  const refresh = useCallback(() => {
    fetchAiSessions(projectId).then(setSessions).catch(() => {});
  }, [projectId]);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Listen for SSE events
  useEffect(() => {
    const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const es = new EventSource(`/api/events${params}`);
    eventSourceRef.current = es;

    const handleUpdated = (e: MessageEvent) => {
      try {
        const updated = JSON.parse(e.data) as AiSessionSummary;
        setSessions((prev) => {
          const idx = prev.findIndex((s) => s.id === updated.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = updated;
            return next;
          }
          // New session — only add if active
          if (
            updated.status === "generating" ||
            updated.status === "awaiting_input" ||
            updated.status === "complete"
          ) {
            return [updated, ...prev];
          }
          return prev;
        });
      } catch { /* ignore */ }
    };

    const handleDeleted = (e: MessageEvent) => {
      try {
        const id = JSON.parse(e.data);
        setSessions((prev) => prev.filter((s) => s.id !== id));
      } catch { /* ignore */ }
    };

    es.addEventListener("ai_session:updated", handleUpdated);
    es.addEventListener("ai_session:deleted", handleDeleted);

    return () => {
      es.removeEventListener("ai_session:updated", handleUpdated);
      es.removeEventListener("ai_session:deleted", handleDeleted);
      es.close();
    };
  }, [projectId]);

  const dismissSession = useCallback((id: string) => {
    deleteAiSession(id).catch(() => {});
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  // Filter to only active sessions
  const active = sessions.filter(
    (s) => s.status === "generating" || s.status === "awaiting_input" || s.status === "complete"
  );

  const planningSessions = active.filter((s) => s.type === "planning");

  return {
    sessions: active,
    generating: active.filter((s) => s.status === "generating").length,
    needsInput: active.filter((s) => s.status === "awaiting_input").length,
    planningSessions,
    dismissSession,
    refresh,
  };
}
