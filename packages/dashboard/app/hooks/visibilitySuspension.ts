import { useCallback, useEffect, useMemo, useRef } from "react";

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
