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
import { useEffect, useRef, useState } from "react";
import { fetchTaskRuntimeFallback, type TaskRuntimeFallbackResponse } from "../api/legacy";

const POLL_INTERVAL_MS = 30_000;

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
  // Dedupe key for toasts: last audit event ID we already toasted for. Persists across
  // polls/re-renders for the lifetime of the component so the toast fires exactly once
  // per newly-observed fallback session, not on every poll.
  const lastToastedEventIdRef = useRef<string | null>(null);

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

      const isNewlyObserved = data.eventId !== null && data.eventId !== lastToastedEventIdRef.current;
      if (isNewlyObserved && data.eventId) {
        lastToastedEventIdRef.current = data.eventId;
      }

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
