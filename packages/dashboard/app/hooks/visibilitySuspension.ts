import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * FNXC:MobileTabRetention 2026-07-26-10:05:
 * Mobile browsers (iOS Safari tabs, iOS installed PWAs, Chrome Android) discard a backgrounded page
 * when it keeps doing work — a page whose timers keep issuing network requests never registers as idle
 * and is a prime reclaim candidate, which is why returning to Fusion after a few minutes produced a
 * full white-splash reload. `useVisibilityAwarePoll` is the ONE shared gate every dashboard polling loop
 * must use: the interval is torn down entirely while `document.visibilityState === "hidden"` (not merely
 * skipped, so the page holds no armed timer at all), and on the hidden -> visible transition it fires
 * exactly one immediate refresh before re-arming, so the operator still sees fresh data on return.
 *
 * Do not add a second visibility pattern — AGENTS.md requires reusing this helper. If a hook already owns
 * its own `visibilitychange` refresh listener, pass `refreshOnVisible: false` so the refresh is not doubled.
 */

/*
FNXC:MobileTabRetention 2026-07-26-14:20:
Visible-edge stampede control. The first cut of this helper fired `refreshOnVisible` SYNCHRONOUSLY in every
subscriber on the single `visibilitychange` event, and re-armed every interval at the same instant. On a board
with ~25 in-viewport cards that is ~35 simultaneous requests (one runtime-fallback fetch per card plus the
singleton pollers) against a browser cap of 6 concurrent HTTP/1.1 connections per origin, queued behind a
waking mobile radio — and `sse-bus.reopenVisibleChannels()` is competing for a connection on that same edge
(`app/api/event-source.ts` documents per-origin exhaustion as a real failure mode here). Before the mobile
work each poller owned an independently drifted interval, so no synchronized burst existed; the fix
reintroduced a thundering herd on exactly the restore path it was optimizing.

Resolution: a DETERMINISTIC stagger derived from subscription order (no randomness, so it is testable).
- Subscribers registered as `priority: "background"` (the default) take a slot from a module-level
  insertion-ordered registry; slot N resumes at `(N % SLOTS) * STEP_MS`, so at most ceil(total/SLOTS)
  subscribers hit the network in any one step and slot 0 stays synchronous (a lone poller is unchanged).
- `priority: "critical"` opts out of the registry entirely and resumes synchronously, for data the operator
  is directly looking at. It is opt-in rather than default so the safe behavior is the default.
- The INTERVAL is armed inside the staggered resume, not on the edge, so the offsets persist and the pollers
  stay drifted apart instead of re-synchronizing and re-bursting one interval later.
- The pending stagger timer is cleared by `stop()`, so a tab that is backgrounded again mid-window issues no
  request — the "hidden page does no work" invariant is preserved, not weakened.

The `dedupe()` helper in `app/api/dedupe.ts` deliberately does NOT cover this: it collapses concurrent calls
sharing one cache key, whereas the 25 badge requests carry 25 distinct task ids, so there is nothing to
collapse. Modulo wrap keeps the spread bounded by VISIBLE_EDGE_STAGGER_WINDOW_MS regardless of subscriber
count; user-visible staleness on return is therefore capped at ~3s for ancillary data only.

Board task data is NOT affected: `useTasks` owns its own `visibilitychange` refresh listener and never routes
through this helper, so the operator's primary data is still refreshed immediately on return.
*/
/*
FNXC:MobileTabRetention 2026-07-26-16:05:
The stagger geometry is EXPORTED because the visible edge has more than one fan-out on it: the poll path here
and the SSE bus's channel reopen (`app/api/sse-bus.ts`) both burst on the same `visibilitychange`, against the
same 6-connection-per-origin cap. A second hand-rolled stagger would spread each fan-out independently while
leaving their union unbounded, so both paths must derive delays from this one slot function.
`visibleEdgeStaggerDelayMs` is pure (index -> delay) and owns no registry, so a caller with its own ordering
(SSE channels) and a caller with the module registry below (pollers) can share it without sharing state.
*/
export const VISIBLE_EDGE_STAGGER_STEP_MS = 150;
export const VISIBLE_EDGE_STAGGER_WINDOW_MS = 3_000;
export const VISIBLE_EDGE_STAGGER_SLOTS = Math.max(
  1,
  Math.round(VISIBLE_EDGE_STAGGER_WINDOW_MS / VISIBLE_EDGE_STAGGER_STEP_MS),
);

/**
 * Deterministic (no randomness, therefore testable) delay for the Nth participant in a visible-edge fan-out.
 * Modulo wrap keeps the spread bounded by {@link VISIBLE_EDGE_STAGGER_WINDOW_MS} regardless of participant
 * count; index 0 is always synchronous so a lone participant is unchanged.
 */
export function visibleEdgeStaggerDelayMs(index: number): number {
  const normalized = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return (normalized % VISIBLE_EDGE_STAGGER_SLOTS) * VISIBLE_EDGE_STAGGER_STEP_MS;
}

/** Insertion-ordered registry of background subscribers; membership position is the stagger slot. */
const staggeredVisibleEdgeSubscribers = new Set<object>();

/** Slot index is recomputed at each visible edge so unmounted subscribers never leave holes in the schedule. */
function visibleEdgeDelayMs(token: object): number {
  let index = 0;
  for (const registered of staggeredVisibleEdgeSubscribers) {
    if (registered === token) {
      break;
    }
    index += 1;
  }
  return visibleEdgeStaggerDelayMs(index);
}

/**
 * Test-only escape hatch: clears the module-level stagger registry so one test's mounted subscribers cannot
 * shift another test's slot assignments. No-op outside the test build.
 */
export function __resetVisibleEdgeStaggerRegistryForTests(): void {
  if (import.meta.env.MODE !== "test") return;
  staggeredVisibleEdgeSubscribers.clear();
}

/*
FNXC:MobileTabRetention 2026-07-26-16:05:
`createVisibilityGatedTimer` is the ONE implementation of "tear the timer down when hidden; fire once and
re-arm when visible". It exists because `useLiveTimeTicker` could not call `useVisibilityAwarePoll` — the
ticker is a module singleton with its own subscriber set, not a per-consumer hook — and so had independently
reimplemented the same start/stop/resume-on-visible shape, contradicting this module's own "do not add a
second visibility pattern" rule. Factoring the bookkeeping into a plain (non-hook) function lets both call
sites share it while keeping their different ownership models.

Contract:
- `disarm()` runs on the hidden edge AND cancels any pending staggered resume, so a page that is re-hidden
  mid-stagger issues no work at all — "a hidden page does no work" is preserved, not merely approximated.
- The visible edge is a no-op when something is already armed or a resume is already pending, so a duplicate
  `visibilitychange` cannot produce a second refresh.
- `arm()` is invoked FROM the staggered instant (not from the edge), so participants stay drifted apart
  instead of re-synchronizing one interval later.
*/
export interface VisibilityGatedTimer {
  /** Attach as the `visibilitychange` handler. */
  handleVisibilityChange: () => void;
  /** Cancel a pending staggered resume and disarm. Safe to call from teardown. */
  stop: () => void;
}

export function createVisibilityGatedTimer(spec: {
  /** Arm the underlying timer. Must be idempotent. */
  arm: () => void;
  /** Tear the underlying timer down. Must be idempotent. */
  disarm: () => void;
  /** Whether the underlying timer is currently armed. */
  isArmed: () => boolean;
  /** Fired once on the hidden -> visible edge, before `arm()`. */
  onResume?: () => void;
  /** Delay applied to the resume, from the shared stagger geometry. Defaults to 0 (synchronous). */
  resumeDelayMs?: () => number;
}): VisibilityGatedTimer {
  let pendingResume: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    if (pendingResume !== null) {
      clearTimeout(pendingResume);
      pendingResume = null;
    }
    spec.disarm();
  };

  const resume = () => {
    pendingResume = null;
    spec.onResume?.();
    spec.arm();
  };

  const handleVisibilityChange = () => {
    // Non-DOM environments are treated as visible, matching every other visibility check in this module.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      stop();
      return;
    }
    if (spec.isArmed() || pendingResume !== null) {
      return;
    }
    const delayMs = spec.resumeDelayMs?.() ?? 0;
    if (delayMs === 0) {
      resume();
      return;
    }
    pendingResume = setTimeout(resume, delayMs);
  };

  return { handleVisibilityChange, stop };
}

export type VisibilityPollPriority = "critical" | "background";

export function useVisibilityAwarePoll(
  callback: () => void,
  intervalMs: number,
  options: { enabled?: boolean; refreshOnVisible?: boolean; priority?: VisibilityPollPriority } = {},
): void {
  const { enabled = true, refreshOnVisible = true, priority = "background" } = options;
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const tick = () => callbackRef.current();

    // Non-DOM environments (SSR/unit harnesses without `document`) keep the plain interval.
    if (typeof document === "undefined") {
      const id = setInterval(tick, intervalMs);
      return () => clearInterval(id);
    }

    // Stagger identity for this subscriber. Critical subscribers stay out of the registry so they never
    // take a slot and always resume synchronously.
    const staggerToken = {};
    if (priority !== "critical") {
      staggeredVisibleEdgeSubscribers.add(staggerToken);
    }

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) {
        timer = setInterval(tick, intervalMs);
      }
    };

    // Bookkeeping (stop-on-hidden, refresh-once-then-re-arm-on-visible, duplicate-edge guard, cancel a
    // pending stagger when re-hidden) lives in the shared gate so `useLiveTimeTicker` runs the same logic.
    const gate = createVisibilityGatedTimer({
      arm: start,
      disarm: () => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      },
      isArmed: () => timer !== null,
      onResume: () => {
        if (refreshOnVisible) {
          tick();
        }
      },
      resumeDelayMs: () => (priority === "critical" ? 0 : visibleEdgeDelayMs(staggerToken)),
    });

    if (document.visibilityState !== "hidden") {
      start();
    }
    document.addEventListener("visibilitychange", gate.handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", gate.handleVisibilityChange);
      gate.stop();
      staggeredVisibleEdgeSubscribers.delete(staggerToken);
    };
  }, [enabled, intervalMs, refreshOnVisible, priority]);
}

let lastHiddenAt: number | null = null;
let lastVisibleAt: number | null = null;

const SUSPENSION_ERROR_PATTERNS = [
  "load failed",
  "failed to fetch",
  "networkerror when attempting to fetch resource.",
  "connection aborted",
  "connection closed unexpectedly",
  "network error",
];

export function isLikelyTabSuspensionError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return SUSPENSION_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function isVisibilityResumeError(errorMessage: string, wasRecentlyHiddenResult: boolean): boolean {
  return wasRecentlyHiddenResult && isLikelyTabSuspensionError(errorMessage);
}

export function lastVisibilityTransition(): { hiddenAt: number | null; visibleAt: number | null } {
  return {
    hiddenAt: lastHiddenAt,
    visibleAt: lastVisibleAt,
  };
}

/**
 * Tracks tab visibility transitions and suspension-recovery signals.
 * - `onBecameVisible` subscriptions fire only when transitioning hidden -> visible.
 * - `lastVisibilityTransition` exposes last hidden/visible timestamps for testing and reconnect logic.
 */
export function useTabVisibilitySuspension() {
  const lastHiddenAtRef = useRef<number | null>(lastHiddenAt);
  const lastVisibleAtRef = useRef<number | null>(lastVisibleAt);
  const visibilityHandlersRef = useRef(new Set<() => void>());

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    let previousVisibilityState = document.visibilityState;

    const handleVisibilityChange = () => {
      const now = Date.now();
      const currentVisibilityState = document.visibilityState;
      if (currentVisibilityState === "hidden") {
        lastHiddenAtRef.current = now;
        lastHiddenAt = now;
      }
      if (currentVisibilityState === "visible") {
        lastVisibleAtRef.current = now;
        lastVisibleAt = now;
        if (previousVisibilityState === "hidden") {
          for (const handler of visibilityHandlersRef.current) {
            handler();
          }
        }
      }
      previousVisibilityState = currentVisibilityState;
    };

    handleVisibilityChange();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const isHiddenNow = useCallback(() => typeof document !== "undefined" && document.visibilityState === "hidden", []);

  const wasRecentlyHidden = useCallback((windowMs = 5000): boolean => {
    const hiddenAt = lastHiddenAtRef.current;
    if (hiddenAt === null) {
      return false;
    }
    const now = Date.now();
    if (isHiddenNow()) {
      return now - hiddenAt <= windowMs;
    }

    const visibleAt = lastVisibleAtRef.current;
    if (visibleAt === null || visibleAt < hiddenAt) {
      return false;
    }
    return now - visibleAt <= windowMs;
  }, [isHiddenNow]);

  const onBecameVisible = useCallback((handler: () => void) => {
    visibilityHandlersRef.current.add(handler);
    return () => {
      visibilityHandlersRef.current.delete(handler);
    };
  }, []);

  return useMemo(() => ({
    isHiddenNow,
    wasRecentlyHidden,
    onBecameVisible,
  }), [isHiddenNow, onBecameVisible, wasRecentlyHidden]);
}
