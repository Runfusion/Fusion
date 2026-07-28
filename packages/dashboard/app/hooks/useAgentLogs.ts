import { useState, useEffect, useRef, useCallback } from "react";
import type { AgentLogEntry } from "@fusion/core";
import { fetchAgentLogsWithMeta } from "../api";
import { subscribeSse } from "../sse-bus";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import {
  MAX_LOG_ENTRIES,
  appendLiveEntries,
  appendLiveEntry,
  countNewestContiguousEntries,
  hasLogGapMarker,
  mergeOlderPage,
  reconcileReconnectedEntries,
} from "./logStreamReconcile";

const INITIAL_LOAD_LIMIT = 100;

/*
FNXC:AgentLogResync 2026-07-26-18:42:
Ceiling on live events parked while a reconnect refetch is in flight. `fetchAgentLogsWithMeta`
accepts no AbortSignal (it lives in ../api, and widening that signature is out of this change's
scope), so a resync on a waking radio can stay outstanding for a long time while a verbose agent
streams. Parked events sit OUTSIDE the ring buffer, so without this bound they are exactly the
unbounded array MAX_LOG_ENTRIES was introduced to eliminate.

On overflow the parking is ABANDONED rather than the events dropped: the in-flight resync's result is
discarded by generation, the parked batch is flushed into the ring (bounded, newest-wins, `hasMore`
signals the trim), live events resume streaming straight into the buffer, and a fresh resync is
re-run once the abandoned fetch settles. Nothing is silently lost that the ring itself would not have
dropped anyway.

RESYNC_TIMEOUT_MS bounds the resync STATE, not the HTTP request: with no signal to pass, the timeout
races the promise so the hook stops parking events and re-runs, while the underlying fetch is left to
settle on its own and is then discarded by generation. Do not describe this as request cancellation.
*/
const MAX_PENDING_LIVE_ENTRIES = MAX_LOG_ENTRIES;
const RESYNC_TIMEOUT_MS = 15_000;

/*
FNXC:AgentLogResync 2026-07-26-16:20:
Buffer bounding, gap marking, and reconnect reconciliation now live in ./logStreamReconcile so this
hook and useMultiAgentLogs share ONE implementation. Both tail the same live-only
`/api/tasks/:id/logs/stream`, and a hand-copied reconcile is how the silent-suspend-gap defect
survived into a third round. Re-exported here because existing call sites (AgentDetailView,
SystemControlsArea, TaskChatTab, tests) import these names from this module.
*/
export {
  MAX_LOG_ENTRIES,
  capLogEntries,
  isLogGapMarker,
  findLogWindowOverlap,
  reconcileReconnectedEntries,
  LOG_GAP_MARKER_TEXT,
} from "./logStreamReconcile";
export type { AgentLogGapMarker } from "./logStreamReconcile";

function getActiveContextKey(taskId: string | null, enabled: boolean, projectId?: string): string | null {
  if (!taskId || !enabled) return null;
  return `${projectId ?? ""}\u0000${taskId}`;
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
 * **Reconnect semantics**: the stream replays nothing on open, so every reconnect (SSE error,
 * heartbeat timeout, or the hidden-tab suspend/resume) refetches the authoritative newest page and
 * reconciles it with the buffer. Where reconciliation cannot be proven, a gap marker is rendered
 * (`isLogGapMarker`) rather than implying continuity.
 *
 * @returns Object with entries, loading, clear, loadMore, hasMore, total
 */
export function useAgentLogs(taskId: string | null, enabled: boolean, projectId?: string) {
  const [entries, setEntries] = useState<AgentLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadedContextKey, setLoadedContextKey] = useState<string | null>(null);

  // Refs for state that needs to survive re-renders
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const cancelledRef = useRef(false);
  /*
  FNXC:AgentLogPaging 2026-07-26-14:20:
  "The live tail dropped older entries" flag; see the SSE handler below. It is sticky ONLY until
  paging proves otherwise — a previous version cleared it only on clear()/context switch, so once the
  tail had trimmed, `hasMore` stayed true even after the reader paged all the way back to entry 0.
  The "load older" control then rendered forever and every further click fetched past the end and
  changed nothing, leaving the reader unable to tell "this is the beginning" from "this is broken".
  Any authoritative fetch that reports `hasMore:false` proves the buffer now reaches entry 0
  (server-side `hasMore = total > offset + returned`), so that response clears the flag.
  */
  const trimmedLiveTailRef = useRef(false);
  // A reconnect refetch is in flight; live events are parked in pendingLiveRef so the merge sees a
  // stable `prev` snapshot and cannot duplicate or drop lines that race the fetch.
  const resyncInFlightRef = useRef(false);
  const pendingLiveRef = useRef<AgentLogEntry[]>([]);
  /*
  FNXC:AgentLogResync 2026-07-26-18:48:
  `resyncInFlightRef` single-flights resyncs, which used to mean a reconnect arriving DURING a resync
  was silently discarded. forceReconnect fires onReconnect at teardown and again ~RECONNECT_DELAY_MS
  later when the socket reopens; if the first refetch outlived that delay, the second reconnect hit
  the early return, the lines emitted between the first fetch's snapshot and the socket reopening were
  never fetched and never streamed, and the merge produced a buffer with NO gap marker — a real hole
  rendered as contiguous output. A superseded reconnect now sets `resyncRerunRef` and the resync
  re-runs exactly once after the in-flight one settles.

  `resyncGenerationRef` is the discard token: an abandoned resync (pending-buffer overflow or the
  settle timeout) bumps it, so the late result cannot be merged into a buffer that has moved on and
  cannot clear the in-flight flag of the resync that replaced it.
  */
  const resyncRerunRef = useRef(false);
  const resyncGenerationRef = useRef(0);
  /*
  FNXC:AgentLogPaging 2026-07-26-18:52:
  `loadMore` captures its offset from the rendered buffer and fetches at that offset. A resync that
  lands while that fetch is in flight REPLACES the buffer, after which prepending the offset page
  produces `[entries 500-600][newest 100]` — a hole with no marker, and every later offset wrong.
  Every buffer replacement bumps this version; a loadMore whose base version changed discards its
  page instead of splicing it. Bumped by: context change, clear, a resync merge, a parked-event flush,
  and a live append that TRIMS (a front trim removes exactly the entries the in-flight page would be
  spliced against). A non-trimming live append deliberately does NOT bump it: it shifts the server
  offset, but `mergeOlderPage` de-duplicates that shift, so invalidating on every streamed line would
  make "load older" unusable on a busy stream for no correctness gain.
  */
  const bufferVersionRef = useRef(0);

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
  const activeContextKey = getActiveContextKey(taskId, enabled, projectId);
  const contextChanged =
    previousTaskIdRef.current !== taskId ||
    previousProjectIdRef.current !== projectId ||
    previousEnabledRef.current !== enabled;

  if (contextChanged) {
    previousTaskIdRef.current = taskId;
    previousProjectIdRef.current = projectId;
    previousEnabledRef.current = enabled;
    projectContextVersionRef.current++;
    recordResumeEvent({
      view: "useAgentLogs",
      trigger: "project-context-change",
      projectId,
      replayAttempted: false,
      reason: "context-version-bumped",
      detail: { taskId },
    });
    cancelledRef.current = true;

    // Clear entries immediately on context change to prevent stale data visibility
    trimmedLiveTailRef.current = false;
    resyncInFlightRef.current = false;
    resyncRerunRef.current = false;
    resyncGenerationRef.current++;
    pendingLiveRef.current = [];
    bufferVersionRef.current++;
    setEntries([]);
    setLoading(false);
    setHasMore(false);
    setTotal(null);
    setLoadingMore(false);
    setLoadedContextKey(null);

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
    const requestContextKey = getActiveContextKey(currentTaskId, true, currentProjectId);

    const isStale = () =>
      cancelledRef.current || projectContextVersionRef.current !== contextVersionAtStart;

    /*
    FNXC:AgentLogResync 2026-07-26-14:26:
    Reconnect handler. The log stream replays nothing, so recovery has to come from the REST path.
    Refetch the newest page at offset 0 and reconcile it with what the reader already holds; a single
    resync at a time (a burst of reconnects must not stack refetches). Live events that land while
    the fetch is in flight are parked, then appended after the merge, so the reconnect window cannot
    duplicate or swallow them. If the refetch itself fails the buffer is left alone and the parked
    events are flushed — a degraded live tail is still better than dropping lines on the floor.
    */
    /*
    FNXC:AgentLogResync 2026-07-26-18:58:
    Abandon the in-flight resync: discard its result by generation, stop parking live events, and
    flush what is already parked into the ring. Used by the pending-buffer overflow and the settle
    timeout. It does NOT itself re-run — the abandoned fetch's `finally` does, once it settles, so a
    hung request cannot fan out into concurrent refetches.
    */
    function abandonResync(): AgentLogEntry[] {
      resyncGenerationRef.current++;
      resyncInFlightRef.current = false;
      resyncRerunRef.current = true;
      const parked = pendingLiveRef.current;
      pendingLiveRef.current = [];
      return parked;
    }

    function flushParkedEntries(parked: AgentLogEntry[]) {
      if (parked.length === 0) return;
      bufferVersionRef.current++;
      setEntries((prev) => {
        const appended = appendLiveEntries(prev, parked);
        if (appended.trimmed) trimmedLiveTailRef.current = true;
        return appended.entries;
      });
    }

    async function resyncFromServer() {
      if (!currentTaskId || isStale()) return;
      if (resyncInFlightRef.current) {
        // Superseded reconnect: remember it so the missed window is fetched once this one settles.
        resyncRerunRef.current = true;
        return;
      }
      const resyncTaskId: string = currentTaskId;
      const generation = ++resyncGenerationRef.current;
      resyncInFlightRef.current = true;
      pendingLiveRef.current = [];
      let reconciled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          fetchAgentLogsWithMeta(resyncTaskId, currentProjectId, { limit: INITIAL_LOAD_LIMIT }),
          new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => {
              flushParkedEntries(abandonResync());
              reject(new Error("agent-log resync timed out"));
            }, RESYNC_TIMEOUT_MS);
          }),
        ]);
        // A superseded/abandoned resync must not merge a snapshot the buffer has moved past.
        if (isStale() || resyncGenerationRef.current !== generation) return;

        const pending = pendingLiveRef.current;
        pendingLiveRef.current = [];
        reconciled = true;
        bufferVersionRef.current++;
        setEntries((prev) => {
          const outcome = reconcileReconnectedEntries(prev, result.entries, pending, resyncTaskId, {
            preservePagedHistory: true,
          });
          if (outcome.trimmed) trimmedLiveTailRef.current = true;
          return outcome.entries;
        });
        setTotal(result.total);
        setHasMore(result.hasMore);
        // An offset-0 page reporting hasMore:false means the whole log fits in the page we just
        // merged, so nothing older is left behind — see the trimmedLiveTailRef note above.
        if (!result.hasMore) trimmedLiveTailRef.current = false;
      } catch {
        // Fall through: the live tail keeps running and the resync is retried below/on next reconnect.
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        const current = resyncGenerationRef.current === generation;
        if (current) {
          resyncInFlightRef.current = false;
          if (!reconciled && !isStale()) flushParkedEntries(pendingLiveRef.current.splice(0));
        }
        if (resyncRerunRef.current && !isStale()) {
          resyncRerunRef.current = false;
          void resyncFromServer();
        }
      }
    }

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
        setEntries(result.entries);
        setHasMore(result.hasMore);
        setTotal(result.total);
        setLoadedContextKey(requestContextKey);
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
        setLoadedContextKey(requestContextKey);
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
          onOpen: () => {
            recordResumeEvent({
              view: "useAgentLogs",
              trigger: "sse-open",
              projectId: currentProjectId,
              replayAttempted: false,
              sseChannel: `/api/tasks/${currentTaskId}/logs/stream`,
              detail: { taskId: currentTaskId },
            });
          },
          onReconnect: () => {
            recordResumeEvent({
              view: "useAgentLogs",
              trigger: "sse-reconnect",
              projectId: currentProjectId,
              replayAttempted: true,
              reason: "refetch-authoritative-log-page",
              sseChannel: `/api/tasks/${currentTaskId}/logs/stream`,
              detail: { taskId: currentTaskId },
            });
            void resyncFromServer();
          },
          events: {
            "agent:log": (e) => {
              if (cancelledRef.current ||
                  projectContextVersionRef.current !== contextVersionAtStart) {
                return;
              }
              try {
                const entry: AgentLogEntry = JSON.parse(e.data);
                /*
                FNXC:AgentLogResync 2026-07-26-14:32:
                While a reconnect refetch is in flight the buffer must not move: park the event and
                let the reconciliation append it after the authoritative page (deduped), otherwise a
                line that is in both the page and the live stream would render twice — or, if the
                merge ran against a moved buffer, be lost. `total` is left alone here because the
                resync sets the authoritative count.
                */
                if (resyncInFlightRef.current) {
                  if (pendingLiveRef.current.length < MAX_PENDING_LIVE_ENTRIES) {
                    pendingLiveRef.current.push(entry);
                    return;
                  }
                  /*
                  FNXC:AgentLogResync 2026-07-26-19:04:
                  Parking is bounded (MAX_PENDING_LIVE_ENTRIES). At the ceiling the resync is
                  abandoned instead of the buffer growing without limit: the parked batch is flushed
                  into the ring, this event falls through to the normal live append, and a fresh
                  resync runs once the abandoned fetch settles. Dropping the parked events instead
                  would put an unmarked hole in the middle of the rendered log.
                  */
                  flushParkedEntries(abandonResync());
                }
                /*
                FNXC:MobileTabRetention 2026-07-26-10:24:
                The live tail is bounded so a long-running agent cannot grow this buffer without
                limit (see MAX_LOG_ENTRIES). The ceiling is `max(MAX_LOG_ENTRIES, prev.length)`:
                streaming holds the buffer at whatever size it has (dropping one oldest entry per
                new line) instead of collapsing a transcript the user deliberately expanded with
                loadMore() straight back down to the cap.
                A trim sets `trimmedLiveTailRef`, which forces `hasMore` on: older entries still
                exist server-side and the viewer's "load older" affordance is the truncation signal,
                so the reader is never shown a silently-clipped tail that looks complete. The flag is
                a ref because the trim decision is only known inside the state updater, and it is
                idempotent so React's double-invoked updaters cannot corrupt it.
                */
                setEntries((prev) => {
                  const appended = appendLiveEntry(prev, entry);
                  if (appended.trimmed) {
                    trimmedLiveTailRef.current = true;
                    /*
                    FNXC:AgentLogPaging 2026-07-26-20:44:
                    A trimming append drops entries off the FRONT, which is exactly where an in-flight
                    loadMore page is about to be spliced: prepending it after the trim leaves the
                    trimmed entries missing between the page and the buffer, unmarked. So a trim — and
                    only a trim — invalidates the buffer version. A plain append does not: it shifts
                    the server offset, but mergeOlderPage de-duplicates that shift, and invalidating
                    every streamed line would make "load older" unusable on a busy stream.
                    */
                    bufferVersionRef.current++;
                  }
                  return appended.entries;
                });
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

  /*
  FNXC:AgentLogPaging 2026-07-26-19:10:
  CORRECTION to the note that stood here: it asserted the gap marker "always sits at index 0". That
  is no longer true and the code that relied on it is gone — a history-preserving resync leaves the
  marker BETWEEN the retained history and the refetched page. Two derived values replace the single
  leading-marker count:
    - `newestContiguousCount` is the only sound `loadMore` offset (entries below the last marker);
      counting through a marker would page past the gap and splice the wrong window in at the top.
    - `gapPresent` scans the whole buffer, because a gap anywhere means older output is still
      fetchable and the "load older" affordance must stay reachable to fill it.
  */
  const newestContiguousCount = countNewestContiguousEntries(entries);
  const gapPresent = hasLogGapMarker(entries);

  /**
   * Load more older entries.
   * Fetches the next 100 older entries and prepends them to the existing list.
   */
  const loadMore = useCallback(async () => {
    if (!taskId || loadingMore) return;

    const contextVersionAtStart = projectContextVersionRef.current;
    const baseBufferVersion = bufferVersionRef.current;
    /*
    FNXC:AgentLogPaging 2026-07-26-19:14:
    The server offset counts back from the newest entry, so it must be the number of REAL entries in
    the newest CONTIGUOUS run. A synthetic gap marker is client-only, and entries retained above a
    marker are not adjacent to the newest run, so counting either of them would fetch the wrong
    window.
    */
    const currentEntriesCount = newestContiguousCount;
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

      /*
      FNXC:AgentLogPaging 2026-07-26-19:16:
      A reconnect resync that landed while this page was in flight replaced the buffer, so this page
      was fetched at an offset that no longer describes it. Splicing it anyway produced
      `[entries 500-600][newest 100]` — an unmarked hole plus permanently wrong offsets. Discard it
      instead: the resync already set authoritative `hasMore`/`total`, `hasMore` stays true, and the
      reader's next "load older" pages from the corrected offset. A discarded page renders nothing
      new; it never renders something wrong.
      */
      if (bufferVersionRef.current !== baseBufferVersion) return;

      /*
      FNXC:AgentLogPaging 2026-07-26-19:18:
      Merge through the shared `mergeOlderPage`, which de-duplicates the seam (the server resolves
      `offset` against its CURRENT total, so entries persisted since the offset was read shift the
      window), fills a gap from below, and retires the marker only on proof — page overlap with the
      retained history, or the page reaching entry 0. The previous inline prepend retired the marker
      on ANY non-empty page, which claimed a multi-page gap was closed after fetching 100 entries of
      it.
      */
      setEntries((prev) => mergeOlderPage(prev, result.entries, { serverHasMore: result.hasMore }));
      bufferVersionRef.current++;
      setHasMore(result.hasMore);
      setTotal(result.total);
      // Paging reached entry 0: the buffer is contiguous back to the beginning, so the live-tail
      // trim no longer implies anything older remains.
      if (!result.hasMore) trimmedLiveTailRef.current = false;
    } catch {
      // Silently fail on load more errors
    } finally {
      setLoadingMore(false);
    }
  }, [taskId, projectId, newestContiguousCount, loadingMore]);

  const clear = useCallback(() => {
    trimmedLiveTailRef.current = false;
    pendingLiveRef.current = [];
    bufferVersionRef.current++;
    setEntries([]);
  }, []);
  const initialContextLoading = Boolean(activeContextKey && loadedContextKey !== activeContextKey);

  return {
    entries,
    loading: loading || initialContextLoading,
    clear,
    loadMore,
    /*
    FNXC:AgentLogPaging 2026-07-26-19:24:
    A trimmed live tail, or a reconnect gap marker ANYWHERE in the buffer, means older entries are
    still on the server, so the "load older" affordance must stay reachable even when the last fetch
    said otherwise. Both signals are retired by proof: the trim flag by a response reaching entry 0,
    the marker by `mergeOlderPage` splicing the gap closed. `hasMore` is true iff output the reader
    cannot currently see is still fetchable.
    */
    hasMore: hasMore || trimmedLiveTailRef.current || gapPresent,
    total,
    loadingMore,
  };
}
