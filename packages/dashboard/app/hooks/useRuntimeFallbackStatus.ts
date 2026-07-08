/**
 * useRuntimeFallbackStatus — polls the lightweight `/api/tasks/:id/runtime-fallback`
 * endpoint (FUX-022) and derives whether the runtime-fallback badge should be
 * shown for a task, plus a one-shot toast trigger the first time a new
 * fallback session is observed.
 *
 * ## Why polling instead of the existing badge WebSocket (useBadgeWebSocket)?
 * `useBadgeWebSocket` is a GitHub/GitLab-specific protocol (`badge:updated`
 * messages carrying `prInfo`/`issueInfo`). Runtime-fallback state changes at
 * most once per agent session (session:runtime-resolved is written once per
 * createResolvedAgentSession call), so a low-frequency poll is simpler and
 * sufficient — extending the badge WS message protocol for a single new field
 * would add cross-cutting server/socket surface for no material latency win.
 * This hook only polls while `enabled` is true (callers should pass
 * `isInViewport` so off-screen cards do not generate background traffic).
 *
 * ## Cross-instance toast dedupe (FUX-039)
 * The same task can be rendered by multiple simultaneously-mounted card
 * surfaces (e.g. the board card AND the list card both poll the same taskId
 * when a caller toggles view modes, or a task appears in both
 * ActiveAgentsPanel and AgentsView at once). Each surface owns its own
 * `useRuntimeFallbackStatus` hook instance, so a dedupe key stored only in a
 * per-instance `useRef` cannot see what a sibling instance has already
 * toasted — every newly-mounted instance would fire its own toast for the
 * same underlying fallback session, spamming the user. `claimToastOnce`
 * below is a module-level (i.e. shared across every hook instance in the
 * process) claim store: only the first instance to observe a given eventId
 * gets `shouldToastNow: true`.
 */
import { useEffect, useRef, useState } from "react";
import { fetchTaskRuntimeFallback, type TaskRuntimeFallbackResponse } from "../api/legacy";

const POLL_INTERVAL_MS = 30_000;

/**
 * Upper bound on how many distinct fallback-session eventIds we remember
 * having toasted. Without a cap, a long-lived dashboard session polling many
 * tasks over hours/days would grow this set unboundedly. Eviction is
 * insertion-order (oldest-claimed-first), which is sufficient here: once an
 * eventId has been evicted it is exceedingly unlikely to be re-observed
 * (each event corresponds to a single agent session's one-time
 * `session:runtime-resolved` audit write), so an accidental duplicate toast
 * after eviction is a harmless, extremely rare edge case rather than a
 * regression risk.
 */
const MAX_CLAIMED_EVENT_IDS = 500;

/** Module-level (process-wide) set of fallback-session eventIds already claimed for a toast. */
let claimedEventIds = new Set<string>();

/**
 * Atomically claim `eventId` for a toast. Returns true the first time a given
 * eventId is claimed (the caller should fire the toast); returns false on
 * every subsequent claim attempt for the same eventId, including from other
 * hook instances mounted elsewhere in the tree. Safe to call from multiple
 * components polling the same task concurrently.
 */
function claimToastOnce(eventId: string): boolean {
  if (claimedEventIds.has(eventId)) {
    return false;
  }
  claimedEventIds.add(eventId);
  if (claimedEventIds.size > MAX_CLAIMED_EVENT_IDS) {
    const oldest = claimedEventIds.values().next().value;
    if (oldest !== undefined) {
      claimedEventIds.delete(oldest);
    }
  }
  return true;
}

/**
 * Test-only: reset the shared claim store between test cases so assertions in
 * one test don't leak dedupe state into the next. Not used by production code.
 */
export function __resetRuntimeFallbackToastClaimsForTests(): void {
  claimedEventIds = new Set<string>();
}

export interface RuntimeFallbackStatus {
  /** True only when the latest resolution has wasConfigured=false and a non-empty runtimeHint. */
  showBadge: boolean;
  /** The configured runtime hint that could not be resolved, when showBadge is true. */
  runtimeHint: string | null;
  /** FallbackReason ("not_found" | "factory_error" | "init_error") when available. */
  reason: string | null;
  /** Human-readable badge/toast message, or null when there is nothing to show. */
  message: string | null;
  /** True exactly once (process-wide, across every hook instance) for a newly-observed fallback session. */
  shouldToastNow: boolean;
}

const IDLE_STATUS: RuntimeFallbackStatus = {
  showBadge: false,
  runtimeHint: null,
  reason: null,
  message: null,
  shouldToastNow: false,
};

export function formatRuntimeFallbackMessage(runtimeHint: string): string {
  return `Runtime fallback: configured runtime '${runtimeHint}' unavailable, using default pi`;
}

/**
 * @param taskId - Task to poll fallback status for. Pass undefined/empty to disable.
 * @param enabled - Gate polling (e.g. isInViewport) to avoid background traffic for off-screen cards.
 * @param projectId - Optional project scope for multi-project dashboards.
 */
export function useRuntimeFallbackStatus(
  taskId: string | undefined,
  enabled: boolean,
  projectId?: string,
): RuntimeFallbackStatus {
  const [status, setStatus] = useState<RuntimeFallbackStatus>(IDLE_STATUS);
  // Per-instance de-flicker guard only: once THIS hook instance has already
  // rendered the badge for a given eventId, subsequent polls for the same
  // eventId should not re-flip shouldToastNow even if the shared claim was
  // won by this instance on an earlier poll cycle (claimToastOnce is
  // one-shot per eventId process-wide, so this ref is redundant for
  // correctness but documents the intent locally and avoids re-touching the
  // shared store on every poll for an already-seen eventId).
  const lastSeenEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !taskId) {
      setStatus(IDLE_STATUS);
      return;
    }

    let cancelled = false;

    const poll = async () => {
      let data: TaskRuntimeFallbackResponse;
      try {
        data = await fetchTaskRuntimeFallback(taskId, projectId);
      } catch {
        // Network hiccups shouldn't flip a shown badge back off; just skip this cycle.
        return;
      }
      if (cancelled) return;

      if (!data.showFallbackBadge || !data.runtimeHint) {
        setStatus(IDLE_STATUS);
        return;
      }

      const isNewEventForThisInstance = data.eventId !== null && data.eventId !== lastSeenEventIdRef.current;
      let shouldToastNow = false;
      if (isNewEventForThisInstance && data.eventId) {
        lastSeenEventIdRef.current = data.eventId;
        // Cross-instance dedupe: only the first instance (across the whole
        // process — any mounted card/panel polling this or any other task)
        // to observe this eventId wins the toast.
        shouldToastNow = claimToastOnce(data.eventId);
      }

      setStatus({
        showBadge: true,
        runtimeHint: data.runtimeHint,
        reason: data.reason,
        message: formatRuntimeFallbackMessage(data.runtimeHint),
        shouldToastNow,
      });
    };

    void poll();
    const interval = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [taskId, enabled, projectId]);

  return status;
}
