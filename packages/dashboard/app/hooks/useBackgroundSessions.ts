import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  fetchAiSessions,
  deleteAiSession,
  cancelPlanning,
  cancelSubtaskBreakdown,
  cancelMissionInterview,
  type AiSessionSummary,
} from "../api";
import { useAiSessionSync } from "./useAiSessionSync";
import { getSessionTabId } from "../utils/getSessionTabId";

interface UseBackgroundSessionsResult {
  sessions: AiSessionSummary[];
  generating: number;
  needsInput: number;
  /** Active sessions filtered to type === "planning" only */
  planningSessions: AiSessionSummary[];
  dismissSession: (id: string) => void;
  refresh: () => void;
}

function parseTimestamp(updatedAt: string | undefined): number {
  if (!updatedAt) return 0;
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldIncludeSession(session: AiSessionSummary): boolean {
  return (
    session.status === "generating" ||
    session.status === "awaiting_input" ||
    session.status === "complete" ||
    session.status === "error"
  );
}

export function useBackgroundSessions(projectId?: string): UseBackgroundSessionsResult {
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionTimestampsRef = useRef<Map<string, number>>(new Map());

  const {
    sessions: syncedSessions,
    broadcastUpdate,
    broadcastCompleted,
    requestSync,
  } = useAiSessionSync();

  const refresh = useCallback(() => {
    fetchAiSessions(projectId)
      .then((fetched) => {
        const nextTimestampMap = new Map<string, number>();
        for (const session of fetched) {
          nextTimestampMap.set(session.id, parseTimestamp(session.updatedAt));
        }
        sessionTimestampsRef.current = nextTimestampMap;
        setSessions(fetched);
      })
      .catch(() => {});
  }, [projectId]);

  // Initial load: request state from sibling tabs first, then fetch authoritative API state.
  useEffect(() => {
    requestSync();
    refresh();
  }, [refresh, requestSync]);

  // Merge cross-tab state updates as a low-latency supplement to SSE/API.
  useEffect(() => {
    setSessions((prev) => {
      if (syncedSessions.size === 0) {
        return prev;
      }

      let changed = false;
      const nextById = new Map(prev.map((session) => [session.id, session]));

      for (const syncState of syncedSessions.values()) {
        if (projectId && syncState.projectId && syncState.projectId !== projectId) {
          continue;
        }

        const incomingTimestamp = syncState.lastEventTimestamp;
        const knownTimestamp = sessionTimestampsRef.current.get(syncState.sessionId) ?? 0;
        if (incomingTimestamp < knownTimestamp) {
          continue;
        }

        const existing = nextById.get(syncState.sessionId);
        const type = syncState.type ?? existing?.type;
        const title = syncState.title ?? existing?.title;

        // Without type/title metadata we cannot safely materialize a new list item yet.
        if (!existing && (!type || !title)) {
          continue;
        }

        const nextSession: AiSessionSummary = {
          id: syncState.sessionId,
          type: type ?? "planning",
          status: syncState.status,
          title: title ?? "AI Session",
          projectId: syncState.projectId ?? existing?.projectId ?? projectId ?? null,
          lockedByTab: syncState.owningTabId ?? existing?.lockedByTab ?? null,
          updatedAt: syncState.updatedAt ?? existing?.updatedAt ?? new Date(incomingTimestamp).toISOString(),
        };

        const previous = nextById.get(syncState.sessionId);
        const hasChanged =
          !previous ||
          previous.status !== nextSession.status ||
          previous.title !== nextSession.title ||
          previous.type !== nextSession.type ||
          previous.projectId !== nextSession.projectId ||
          previous.lockedByTab !== nextSession.lockedByTab ||
          previous.updatedAt !== nextSession.updatedAt;

        if (hasChanged) {
          nextById.set(syncState.sessionId, nextSession);
          sessionTimestampsRef.current.set(syncState.sessionId, incomingTimestamp);
          changed = true;
        }
      }

      if (!changed) {
        return prev;
      }

      return [...nextById.values()].sort(
        (a, b) => parseTimestamp(b.updatedAt) - parseTimestamp(a.updatedAt),
      );
    });
  }, [projectId, syncedSessions]);

  // Listen for server-side SSE events (authoritative source of truth).
  useEffect(() => {
    const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const es = new EventSource(`/api/events${params}`);
    eventSourceRef.current = es;

    const handleUpdated = (e: MessageEvent) => {
      try {
        const updated = JSON.parse(e.data) as AiSessionSummary;
        const eventTimestamp = parseTimestamp(updated.updatedAt) || Date.now();

        setSessions((prev) => {
          const knownTimestamp = sessionTimestampsRef.current.get(updated.id) ?? 0;
          if (eventTimestamp < knownTimestamp) {
            return prev;
          }

          sessionTimestampsRef.current.set(updated.id, eventTimestamp);

          const idx = prev.findIndex((s) => s.id === updated.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = updated;
            return next;
          }

          if (shouldIncludeSession(updated)) {
            return [updated, ...prev];
          }

          return prev;
        });

        broadcastUpdate({
          sessionId: updated.id,
          status: updated.status,
          needsInput: updated.status === "awaiting_input",
          type: updated.type,
          title: updated.title,
          projectId: updated.projectId,
          owningTabId: updated.lockedByTab,
          updatedAt: updated.updatedAt,
          timestamp: eventTimestamp,
        });

        if (updated.status === "complete" || updated.status === "error") {
          broadcastCompleted({
            sessionId: updated.id,
            status: updated.status,
            timestamp: eventTimestamp,
          });
        }
      } catch {
        // ignore malformed payload
      }
    };

    const handleDeleted = (e: MessageEvent) => {
      try {
        const id = JSON.parse(e.data) as string;
        setSessions((prev) => prev.filter((s) => s.id !== id));
        sessionTimestampsRef.current.delete(id);
      } catch {
        // ignore malformed payload
      }
    };

    es.addEventListener("ai_session:updated", handleUpdated);
    es.addEventListener("ai_session:deleted", handleDeleted);

    return () => {
      es.removeEventListener("ai_session:updated", handleUpdated);
      es.removeEventListener("ai_session:deleted", handleDeleted);
      es.close();
    };
  }, [broadcastCompleted, broadcastUpdate, projectId]);

  const dismissSession = useCallback(async (id: string) => {
    // Find the session to determine its type
    const session = sessions.find((s) => s.id === id);
    const sessionType = session?.type;
    const sessionTabId = getSessionTabId();

    // Cancel the session based on its type to ensure proper cleanup
    // Pass tabId for lock-aware cancellation - if locked by another tab, the API returns 409
    let cancelFailed = false;
    let lockConflict = false;

    if (sessionType === "planning") {
      try {
        await cancelPlanning(id, projectId, sessionTabId);
      } catch (err: unknown) {
        cancelFailed = true;
        // Check if this was a lock conflict (409)
        if (err instanceof Error && err.message.includes("locked")) {
          lockConflict = true;
          console.warn(`[useBackgroundSessions] Cannot dismiss planning session ${id}: locked by another tab`);
        }
      }
    } else if (sessionType === "subtask") {
      try {
        await cancelSubtaskBreakdown(id, projectId, sessionTabId);
      } catch (err: unknown) {
        cancelFailed = true;
        if (err instanceof Error && err.message.includes("locked")) {
          lockConflict = true;
          console.warn(`[useBackgroundSessions] Cannot dismiss subtask session ${id}: locked by another tab`);
        }
      }
    } else if (sessionType === "mission_interview") {
      try {
        await cancelMissionInterview(id, projectId, sessionTabId);
      } catch (err: unknown) {
        cancelFailed = true;
        if (err instanceof Error && err.message.includes("locked")) {
          lockConflict = true;
          console.warn(`[useBackgroundSessions] Cannot dismiss mission interview session ${id}: locked by another tab`);
        }
      }
    }

    // Only proceed with deletion if cancellation succeeded or wasn't needed
    if (cancelFailed && !lockConflict) {
      // Non-lock cancellation failure: still try to delete
      console.warn(`[useBackgroundSessions] Cancellation failed for session ${id}, attempting delete anyway`);
    }

    // Delete the session and update local state
    try {
      await deleteAiSession(id);
    } catch {
      // Best-effort: deletion failures should not block local state update
    }

    setSessions((prev) => prev.filter((s) => s.id !== id));
    sessionTimestampsRef.current.delete(id);
  }, [projectId, sessions]);

  const active = useMemo(
    () => sessions.filter((session) => shouldIncludeSession(session)),
    [sessions],
  );

  const planningSessions = useMemo(
    () => active.filter((session) => session.type === "planning"),
    [active],
  );

  return {
    sessions: active,
    generating: active.filter((session) => session.status === "generating").length,
    needsInput: active.filter((session) => session.status === "awaiting_input").length,
    planningSessions,
    dismissSession,
    refresh,
  };
}
