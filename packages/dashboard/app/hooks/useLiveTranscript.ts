import { useState, useEffect, useRef } from "react";
import type { AgentLogEntry } from "@fusion/core";
import { fetchAgentLogsWithMeta } from "../api";
import { subscribeSse } from "../sse-bus";
import { appendWithoutDuplicates } from "./logStreamReconcile";
import { createResyncRetryRunner } from "./resyncRetry";

// Render shows only the first 20 entries; keep a small buffer above that for
// hot-reconnect/scrollback but never let the array grow unbounded — long-lived
// active agents would otherwise leak hundreds of MB into React state.
const MAX_TRANSCRIPT_ENTRIES = 200;

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

/** A live/persisted log row in the shared oldest-first reconcile shape, keeping the legacy field. */
type ReconcilableEntry = AgentLogEntry & { content?: string };

/** Oldest-first reconcile shape -> rendered newest-first, bounded transcript. */
function toTranscriptEntries(entries: ReconcilableEntry[]): TranscriptEntry[] {
  return entries
    .slice(-MAX_TRANSCRIPT_ENTRIES)
    .reverse()
    .map((raw) => ({
      type: raw.type ?? "text",
      text: raw.text ?? "",
      timestamp: raw.timestamp || undefined,
      ...(raw.content !== undefined ? { content: raw.content } : {}),
    }));
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
 *
 * **Reconnect semantics**: the stream replays nothing on open, so every reconnect refetches the
 * persisted tail and merges it with events that raced the fetch (see resyncTranscript).
 */
export function useLiveTranscript(taskId: string | undefined, projectId?: string) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  // Refs for state that needs to survive re-renders
  const unsubscribeRef = useRef<(() => void) | null>(null);
  /*
  FNXC:TaskTranscript 2026-07-26-18:40:
  A reconnect refetch is in flight; live `agent:log` events are parked here instead of being
  prepended. Ported from useAgentLogs: the refetched page is a snapshot from BEFORE those events, so
  writing it over a buffer that moved meanwhile deleted the newest lines with no replay path (the
  stream never resends). Parked entries are merged after the page, deduped by content, so an entry
  present in both is rendered once.
  */
  const resyncInFlightRef = useRef(false);
  const pendingLiveRef = useRef<ReconcilableEntry[]>([]);

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

    // Drop existing subscription
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }

    // Reset state immediately to prevent stale data visibility
    resyncInFlightRef.current = false;
    pendingLiveRef.current = [];
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

    /*
    FNXC:TaskTranscript 2026-07-26-14:50:
    Missed-event recovery. `/api/tasks/:id/logs/stream` replays nothing on connect — it only forwards
    entries emitted while the socket is live — so every SSE gap (error reconnect, or the mobile
    hidden-tab suspend) punched a permanent hole in the transcript, silently mixing entries from
    before and after the gap with no marker. On reopen, converge on the persisted tail from
    GET /tasks/:id/logs, which is the same data the stream would have delivered, merged with
    anything that streamed in during the fetch. The API returns oldest-first; this hook renders
    newest-first.
    */
    const isStale = () => projectContextVersionRef.current !== contextVersionAtStart;

    /*
    FNXC:TaskTranscript 2026-07-26-18:44:
    CORRECTION to the previous resync, which called setEntries(server page) unconditionally: entries
    that arrived while the fetch was in flight were older than the state write and were DELETED, and
    this stream replays nothing, so they were unrecoverable. The fetch window is now a parking window
    (pendingLiveRef) and the parked entries are merged onto the page with the shared
    `appendWithoutDuplicates`, the same de-dup useAgentLogs uses, so a line that is in both the page
    and the live stream renders exactly once.
    The old catch comment ("the next reopen retries") was ALSO wrong — a healthy connection may not
    reopen again for hours. Failures go through the shared bounded ladder, and parked entries are
    flushed rather than dropped when the page cannot be fetched.
    */
    const resyncTranscript = async () => {
      if (resyncInFlightRef.current || isStale()) return;
      resyncInFlightRef.current = true;
      pendingLiveRef.current = [];
      let reconciled = false;
      try {
        const result = await fetchAgentLogsWithMeta(taskId, projectId, { limit: MAX_TRANSCRIPT_ENTRIES });
        if (isStale()) return;
        const pending = pendingLiveRef.current;
        pendingLiveRef.current = [];
        reconciled = true;
        setEntries(toTranscriptEntries(appendWithoutDuplicates(result.entries, pending) as ReconcilableEntry[]));
      } finally {
        resyncInFlightRef.current = false;
        if (!reconciled && !isStale()) {
          const pending = pendingLiveRef.current;
          pendingLiveRef.current = [];
          if (pending.length > 0) {
            // Failed/stale refetch: a degraded live tail still beats silently dropping lines.
            setEntries((prev) => [...toTranscriptEntries(pending), ...prev].slice(0, MAX_TRANSCRIPT_ENTRIES));
          }
        }
      }
    };

    const transcriptResync = createResyncRetryRunner({ run: resyncTranscript });

    const unsubscribe = subscribeSse(url, {
      onReconnect: () => transcriptResync.trigger(),
      events: {
        "agent:log": (event) => {
          if (isStale()) return;
          try {
            const raw = JSON.parse(event.data) as Partial<TranscriptEntry>;
            // Normalize: canonical `text` field, with legacy `content` fallback
            const entry: ReconcilableEntry = {
              type: (raw.type ?? "text") as AgentLogEntry["type"],
              text: raw.text ?? raw.content ?? "",
              timestamp: raw.timestamp ?? "",
              taskId,
              ...(raw.content !== undefined ? { content: raw.content } : {}),
            };
            if (resyncInFlightRef.current) {
              pendingLiveRef.current.push(entry);
              return;
            }
            setEntries(prev => {
              const next = [...toTranscriptEntries([entry]), ...prev];
              return next.length > MAX_TRANSCRIPT_ENTRIES
                ? next.slice(0, MAX_TRANSCRIPT_ENTRIES)
                : next;
            });
          } catch { /* skip malformed events */ }
        },
      },
      onOpen: () => {
        if (projectContextVersionRef.current === contextVersionAtStart) {
          setIsConnected(true);
        }
      },
      onError: () => {
        if (projectContextVersionRef.current === contextVersionAtStart) {
          setIsConnected(false);
        }
      },
    });
    unsubscribeRef.current = unsubscribe;

    return () => {
      transcriptResync.dispose();
      unsubscribe();
      unsubscribeRef.current = null;
      if (projectContextVersionRef.current === contextVersionAtStart) {
        setIsConnected(false);
      }
    };
  }, [taskId, projectId]);

  return { entries, isConnected };
}
