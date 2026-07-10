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
 */
import { useEffect, useState } from "react";
import { fetchTaskRuntimeFallback, type TaskRuntimeFallbackResponse } from "../api/legacy";

const POLL_INTERVAL_MS = 30_000;

// Toast dedupe must be shared across ALL hook instances in the process, not
// scoped per-instance: the same task/event can be observed simultaneously by
// multiple mounted badges (e.g. ActiveAgentsPanel + AgentsView board/list +
// TaskCard all rendering the same in-progress task at once), each running
// its own useRuntimeFallbackStatus() call. A per-instance ref only dedupes
// within one component instance's own poll history, so the same eventId
// would independently look "newly observed" to every instance and fire one
// toast each. Module-level state is shared across every call site because
// there is exactly one copy of this module per process/bundle.
//
// Keyed by `${taskId}:${eventId}` (not eventId alone) so ids are unambiguous
// even if two different tasks' audit logs ever produced colliding event ids.
// Bounded via a simple FIFO eviction (insertion order === Map iteration
// order) so a long-lived dashboard session touching many tasks over many
// hours cannot grow this unboundedly; runtime-fallback events are rare
// (at most one per agent session), so a few hundred entries comfortably
// covers realistic session lengths without needing TTL bookkeeping.
const MAX_TOASTED_EVENTS = 500;
const toastedEventKeys = new Map<string, true>();

function toastKey(taskId: string, eventId: string): string {
  return `${taskId}:${eventId}`;
}

/**
 * Returns true and records the key the first time it is seen; returns false
 * on every subsequent call for the same key, regardless of which hook
 * instance/component asks. This is the single shared gate all simultaneously
 * mounted badge instances for the same task funnel through.
 */
function claimToastOnce(taskId: string, eventId: string): boolean {
  const key = toastKey(taskId, eventId);
  if (toastedEventKeys.has(key)) {
    return false;
  }
  toastedEventKeys.set(key, true);
  if (toastedEventKeys.size > MAX_TOASTED_EVENTS) {
    const oldestKey = toastedEventKeys.keys().next().value;
    if (oldestKey !== undefined) {
      toastedEventKeys.delete(oldestKey);
    }
  }
  return true;
}

/**
 * Test-only escape hatch: clears the shared module-level dedupe store between
 * test cases so one test's "already toasted" state cannot leak into the next.
 * Guarded to a no-op outside the test build (import.meta.env.MODE) so it can
 * never affect production code paths.
 */
export function __resetRuntimeFallbackToastDedupeStoreForTests(): void {
  if (import.meta.env.MODE !== "test") return;
  toastedEventKeys.clear();
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
  /** True exactly once, on the render where a newly-observed fallback session should fire a toast. */
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

      // Dedupe against the shared module-level store (not a per-instance ref)
      // so a fallback event toasts exactly once across every simultaneously
      // mounted badge instance for this task, not once per instance.
      const isNewlyObserved = data.eventId !== null && taskId !== undefined && claimToastOnce(taskId, data.eventId);

      setStatus({
        showBadge: true,
        runtimeHint: data.runtimeHint,
        reason: data.reason,
        message: formatRuntimeFallbackMessage(data.runtimeHint),
        shouldToastNow: isNewlyObserved,
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
