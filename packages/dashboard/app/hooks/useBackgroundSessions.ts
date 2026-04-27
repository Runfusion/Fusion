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
import { subscribeSse } from "../sse-bus";

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
  return session.status === "generating" || session.status === "awaiting_input";
}

function isTerminalStatus(
  status: AiSessionSummary["status"],
): status is Extract<AiSessionSummary["status"], "complete" | "error"> {
  return status === "complete" || status === "error";
}

export function useBackgroundSessions(projectId?: string): UseBackgroundSessionsResult {
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const sessionTimestampsRef = useRef<Map<string, number>>(new Map());
  const dismissedSessionTimestampsRef = useRef<Map<string, number>>(new Map());

  const {
    sessions: syncedSessions,
    broadcastUpdate,
    broadcastCompleted,
    requestSync,
  } = useAiSessionSync();

  const refresh = useCallback(() => {
    fetchAiSessions(projectId)
      .then((fetched) => {
        const filtered = fetched.filter((session) => {
          const fetchedTimestamp = parseTimestamp(session.updatedAt);
          const dismissedTimestamp = dismissedSessionTimestampsRef.current.get(session.id);
          if (dismissedTimestamp === undefined) {
            return true;
          }

          // Treat explicit dismissals as terminal tombstones unless the server has
          // emitted a genuinely newer state for the same session id.
          if (fetchedTimestamp <= dismissedTimestamp) {
            return false;
          }

          dismissedSessionTimestampsRef.current.delete(session.id);
          return true;
        });

        const nextTimestampMap = new Map<string, number>();
        for (const session of filtered) {
          nextTimestampMap.set(session.id, parseTimestamp(session.updatedAt));
        }
        sessionTimestampsRef.current = nextTimestampMap;
        setSessions(filtered);
      })
      .catch((err) => {
        console.warn("[useBackgroundSessions] Failed to fetch AI sessions:", err);
      });
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

        const dismissedTimestamp = dismissedSessionTimestampsRef.current.get(syncState.sessionId);
        if (dismissedTimestamp !== undefined && incomingTimestamp <= dismissedTimestamp) {
          continue;
        }

        if (
          dismissedTimestamp !== undefined &&
          incomingTimestamp > dismissedTimestamp &&
          !isTerminalStatus(syncState.status)
        ) {
          dismissedSessionTimestampsRef.current.delete(syncState.sessionId);
        }

        if (isTerminalStatus(syncState.status)) {
          if (nextById.delete(syncState.sessionId)) {
            changed = true;
          }
          sessionTimestampsRef.current.set(syncState.sessionId, incomingTimestamp);
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

    const handleUpdated = (e: MessageEvent) => {
      try {
        const updated = JSON.parse(e.data) as AiSessionSummary;
        const eventTimestamp = parseTimestamp(updated.updatedAt) || Date.now();

        setSessions((prev) => {
          const knownTimestamp = sessionTimestampsRef.current.get(updated.id) ?? 0;
          if (eventTimestamp < knownTimestamp) {
            return prev;
          }

          const dismissedTimestamp = dismissedSessionTimestampsRef.current.get(updated.id);
          if (dismissedTimestamp !== undefined && eventTimestamp <= dismissedTimestamp) {
            return prev;
          }

          if (
            dismissedTimestamp !== undefined &&
            eventTimestamp > dismissedTimestamp &&
            !isTerminalStatus(updated.status)
          ) {
            dismissedSessionTimestampsRef.current.delete(updated.id);
          }

          sessionTimestampsRef.current.set(updated.id, eventTimestamp);

          if (isTerminalStatus(updated.status)) {
            return prev.filter((session) => session.id !== updated.id);
          }

          const idx = prev.findIndex((session) => session.id === updated.id);
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

        if (isTerminalStatus(updated.status)) {
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
        dismissedSessionTimestampsRef.current.delete(id);
      } catch {
        // ignore malformed payload
      }
    };

    return subscribeSse(`/api/events${params}`, {
      events: {
        "ai_session:updated": handleUpdated,
        "ai_session:deleted": handleDeleted,
      },
      // When the SSE channel reconnects after a drop, pull the authoritative
      // list. Without this, terminal events (deleted/completed) emitted while
      // the channel was down stay invisible to this hook and the AI pill
      // count gets stuck on stale sessions.
      onReconnect: () => {
        refresh();
      },
    });
  }, [broadcastCompleted, broadcastUpdate, projectId, refresh]);

  const dismissSession = useCallback(async (id: string) => {
    // Find the session to determine its type
    const session = sessions.find((s) => s.id === id);
    const sessionType = session?.type;
    const sessionTabId = getSessionTabId();

    // Cancel the session based on its type to ensure proper cleanup.
    // Pass tabId for lock-aware cancellation; if locked by another tab the API
    // returns 409 — we still proceed to DELETE below, which has no lock check,
    // because the user explicitly chose to dismiss. The dismissal tombstone
    // recorded below prevents stale sync/SSE updates from resurrecting it.
    let cancelFailed = false;

    if (sessionType === "planning") {
      try {
        await cancelPlanning(id, projectId, sessionTabId);
      } catch (err: unknown) {
        cancelFailed = true;
        if (err instanceof Error && err.message.includes("locked")) {
          console.warn(`[useBackgroundSessions] Forcing dismiss of planning session ${id} despite lock by another tab`);
        }
      }
    } else if (sessionType === "subtask") {
      try {
        await cancelSubtaskBreakdown(id, projectId, sessionTabId);
      } catch (err: unknown) {
        cancelFailed = true;
        if (err instanceof Error && err.message.includes("locked")) {
          console.warn(`[useBackgroundSessions] Forcing dismiss of subtask session ${id} despite lock by another tab`);
        }
      }
    } else if (sessionType === "mission_interview") {
      try {
        await cancelMissionInterview(id, projectId, sessionTabId);
      } catch (err: unknown) {
        cancelFailed = true;
        if (err instanceof Error && err.message.includes("locked")) {
          console.warn(`[useBackgroundSessions] Forcing dismiss of mission interview session ${id} despite lock by another tab`);
        }
      }
    }

    if (cancelFailed) {
      console.warn(`[useBackgroundSessions] Cancellation failed for session ${id}, attempting delete anyway`);
    }

    const dismissalTimestamp = Date.now();

    // Root cause: local removal without dismissal tombstone let stale sync/SSE
    // snapshots resurrect the same session. Record terminal dismissal semantics
    // before async deletion so delayed updates cannot re-materialize it.
    dismissedSessionTimestampsRef.current.set(id, dismissalTimestamp);
    sessionTimestampsRef.current.set(
      id,
      Math.max(sessionTimestampsRef.current.get(id) ?? 0, dismissalTimestamp),
    );
    broadcastCompleted({ sessionId: id, status: "complete", timestamp: dismissalTimestamp });

    // Delete the session and update local state
    try {
      await deleteAiSession(id);
    } catch {
      // Best-effort: deletion failures should not block local state update
    }

    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, [broadcastCompleted, projectId, sessions]);

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
