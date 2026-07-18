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
import { subscribeSse } from "../sse-bus";
import { recordResumeEvent } from "../utils/resumeInstrumentation";

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
  /*
   * FNXC:SessionBanner 2026-07-16-20:55:
   * FN-8229 removes the redundant footer AI pill, so this retained session model
   * must feed the notification banner and Planning badge for every non-terminal
   * status, including errors. Legacy counts remain scoped to their meanings.
   */
  return (
    session.status === "generating" ||
    session.status === "awaiting_input" ||
    session.status === "waiting_on_input" ||
    session.status === "needs_attention" ||
    session.status === "error"
  );
}

function isTerminalStatus(
  status: AiSessionSummary["status"],
): status is Extract<AiSessionSummary["status"], "complete"> {
  return status === "complete";
}

export function useBackgroundSessions(projectId?: string): UseBackgroundSessionsResult {
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const sessionTimestampsRef = useRef<Map<string, number>>(new Map());
  const dismissedSessionTimestampsRef = useRef<Map<string, number>>(new Map());
  const lastAuthoritativeRefreshAtRef = useRef(0);

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

        /*
         * FNXC:SessionSync 2026-07-11-19:08:
         * Planning must never advertise a cached cross-tab session that the
         * server's current project-scoped list does not contain. A late sync
         * response is only a latency aid, so suppress updates older than this
         * successful authoritative refresh; newer updates may still represent
         * a session created immediately after the list request.
         */
        lastAuthoritativeRefreshAtRef.current = Date.now();
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

        if (!nextById.has(syncState.sessionId) && incomingTimestamp <= lastAuthoritativeRefreshAtRef.current) {
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
          updatedAt: syncState.updatedAt ?? existing?.updatedAt ?? new Date(incomingTimestamp).toISOString(),
        };

        const previous = nextById.get(syncState.sessionId);
        const hasChanged =
          !previous ||
          previous.status !== nextSession.status ||
          previous.title !== nextSession.title ||
          previous.type !== nextSession.type ||
          previous.projectId !== nextSession.projectId ||
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
          updatedAt: updated.updatedAt,
          timestamp: eventTimestamp,
        });

        if (updated.status === "complete") {
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
        const deletionTimestamp = Date.now();

        // Record a tombstone so the merge effect cannot re-materialize this
        // session from syncedSessions after deletion. Without this, the sync
        // store still holds the session with its last non-terminal status and
        // the merge effect (which reads knownTimestamp=0 after the delete below)
        // would re-add the session on the next render, causing the stale badge.
        dismissedSessionTimestampsRef.current.set(id, deletionTimestamp);
        sessionTimestampsRef.current.set(
          id,
          Math.max(sessionTimestampsRef.current.get(id) ?? 0, deletionTimestamp),
        );

        // Mark the session as terminal in the cross-tab sync store so that
        // other consumers and sibling tabs also see it as completed.
        broadcastCompleted({ sessionId: id, status: "complete", timestamp: deletionTimestamp });

        setSessions((prev) => prev.filter((s) => s.id !== id));
      } catch {
        // ignore malformed payload
      }
    };

    const sseChannel = `/api/events${params}`;

    const unsubscribe = subscribeSse(sseChannel, {
      events: {
        "ai_session:updated": handleUpdated,
        "ai_session:deleted": handleDeleted,
      },
      // When the SSE channel reconnects after a drop, pull the authoritative
      // list. Without this, terminal events (deleted/completed) emitted while
      // the channel was down stay invisible to this hook and the retained
      // session model gets stuck on stale entries.
      onReconnect: () => {
        recordResumeEvent({
          view: "useBackgroundSessions",
          trigger: "sse-reconnect",
          projectId,
          replayAttempted: false,
          sseChannel,
        });
        refresh();
      },
    });
    recordResumeEvent({
      view: "useBackgroundSessions",
      trigger: "sse-open",
      projectId,
      replayAttempted: false,
      sseChannel,
    });

    return unsubscribe;
  }, [broadcastCompleted, broadcastUpdate, projectId, refresh]);

  const dismissSession = useCallback(async (id: string) => {
    // Find the session to determine its type
    const session = sessions.find((s) => s.id === id);
    const sessionType = session?.type;

    // Cancel the session based on its type to ensure proper cleanup. Cancellation
    // is best-effort: a failure still proceeds to the DELETE below because the
    // user explicitly chose to dismiss. The dismissal tombstone recorded below
    // prevents stale sync/SSE updates from resurrecting it.
    let cancelFailed = false;

    if (sessionType === "planning") {
      // FNXC:PlanningMultiTab 2026-07-14-00:00: planning routes are lock-free; no tabId needed.
      try {
        await cancelPlanning(id, projectId);
      } catch {
        cancelFailed = true;
      }
    } else if (sessionType === "subtask") {
      try {
        await cancelSubtaskBreakdown(id, projectId);
      } catch {
        cancelFailed = true;
      }
    } else if (sessionType === "mission_interview") {
      try {
        await cancelMissionInterview(id, projectId);
      } catch {
        cancelFailed = true;
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
    needsInput: active.filter(
      (session) => session.status === "awaiting_input" || session.status === "waiting_on_input",
    ).length,
    planningSessions,
    dismissSession,
    refresh,
  };
}
