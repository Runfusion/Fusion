import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type PropsWithChildren,
} from "react";

/**
 * A navigation entry on the back-navigation stack.
 *
 * - `modal` entries wrap a close callback for dismissing a modal.
 * - `view` entries wrap a revert callback for restoring a previous view.
 *
 * All callbacks MUST be idempotent — safe to call multiple times even if the
 * underlying state has already changed (e.g., calling `setDetailTask(null)`
 * when `detailTask` is already `null`). This handles edge cases where an
 * auto-close side effect fires before a `popstate` event.
 */
export type NavEntry =
  | { type: "modal"; close: () => void }
  | { type: "view"; revert: () => void };

export interface UseNavigationHistoryOptions {
  /** Only active on mobile. When false, pushNav/replaceCurrent are no-ops. */
  enabled: boolean;
}

export interface UseNavigationHistoryResult {
  /** Push a navigation entry onto the stack and call history.pushState. */
  pushNav: (entry: NavEntry) => void;
  /** Replace the top-of-stack entry and call history.replaceState. */
  replaceCurrent: (entry: NavEntry) => void;
  /**
   * Remove a programmatically-dismissed entry and call history.back so the
   * browser history entry created by pushNav is consumed as well.
   */
  removeNav: (closeOrRevert: () => void) => void;
}

const SELF_POP_FALLBACK_CLEAR_MS = 1_000;
const FUSION_NATIVE_BACK_EVENT = "fusion:native-back";

export const NavigationHistoryContext = createContext<UseNavigationHistoryResult | null>(null);

export function NavigationHistoryProvider({
  value,
  children,
}: PropsWithChildren<{ value: UseNavigationHistoryResult }>) {
  return createElement(NavigationHistoryContext.Provider, { value }, children);
}

export function useNavigationHistoryContext(): UseNavigationHistoryResult {
  const context = useContext(NavigationHistoryContext);
  if (!context) {
    throw new Error("useNavigationHistoryContext must be used within a NavigationHistoryProvider");
  }
  return context;
}

/**
 * Centralized back-navigation hook that integrates the browser History API
 * (`pushState`/`popstate`) with modal and view state machines.
 *
 * Every modal open and view change pushes a history entry so that the
 * browser back button dismisses the top modal or reverts to the previous
 * view. Works on both desktop and mobile.
 *
 * When `enabled` is false, all operations are no-ops and no `popstate`
 * listener is registered.
 */
export function useNavigationHistory(
  options: UseNavigationHistoryOptions,
): UseNavigationHistoryResult {
  const { enabled } = options;

  // Internal navigation stack. Each entry corresponds to one history entry.
  const stackRef = useRef<NavEntry[]>([]);

  // Guard flag: when popstate fires and calls a close/revert callback, the
  // resulting state change (e.g. `setDetailTask(null)`) must NOT re-push a
  // history entry. pushNav checks this flag and skips if true.
  const isPoppingRef = useRef(false);

  // Guard flag: removeNav calls history.back() to consume the matching browser
  // history entry after the UI has already closed. The resulting popstate must
  // be ignored so callbacks are not invoked twice.
  const selfPopRef = useRef(false);
  const selfPopClearTimerRef = useRef<number | null>(null);

  // Keep enabled in a ref so the popstate handler can read the current value
  // without needing to be re-registered on every change.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const pushNav = useCallback(
    (entry: NavEntry) => {
      if (!enabledRef.current) return;

      // Prevent re-push during pop handling
      if (isPoppingRef.current) return;

      // Guard against duplicate consecutive pushes (rapid taps)
      const top = stackRef.current[stackRef.current.length - 1];
      if (top) {
        const topCallback = top.type === "modal" ? top.close : top.revert;
        const newCallback = entry.type === "modal" ? entry.close : entry.revert;
        if (topCallback === newCallback) return;
      }

      stackRef.current.push(entry);

      // Preserve existing history.state properties (e.g. from useDeepLink)
      // while adding our navIndex.
      const navIndex = stackRef.current.length;
      const existingState =
        typeof window !== "undefined" && window.history.state
          ? window.history.state
          : {};
      window.history.pushState({ ...existingState, navIndex }, "");
    },
    [], // stable — reads from refs
  );

  const replaceCurrent = useCallback(
    (entry: NavEntry) => {
      if (!enabledRef.current) return;
      if (stackRef.current.length === 0) return;

      stackRef.current[stackRef.current.length - 1] = entry;

      // Preserve existing history.state properties while updating navIndex
      const navIndex = stackRef.current.length;
      const existingState =
        typeof window !== "undefined" && window.history.state
          ? window.history.state
          : {};
      window.history.replaceState({ ...existingState, navIndex }, "");
    },
    [], // stable — reads from refs
  );

  const removeNav = useCallback(
    (closeOrRevert: () => void) => {
      if (!enabledRef.current) return;

      for (let i = stackRef.current.length - 1; i >= 0; i -= 1) {
        const entry = stackRef.current[i];
        const callback = entry.type === "modal" ? entry.close : entry.revert;
        if (callback !== closeOrRevert) continue;

        stackRef.current.splice(i, 1);
        selfPopRef.current = true;

        if (selfPopClearTimerRef.current !== null) {
          window.clearTimeout(selfPopClearTimerRef.current);
        }
        selfPopClearTimerRef.current = window.setTimeout(() => {
          selfPopRef.current = false;
          selfPopClearTimerRef.current = null;
        }, SELF_POP_FALLBACK_CLEAR_MS);

        window.history.back();
        return;
      }
    },
    [], // stable — reads from refs
  );

  // Register popstate listener. Always registers in browser environments but
  // the handler checks enabledRef.current to skip when disabled (desktop).
  useEffect(() => {
    if (typeof window === "undefined") return;

    /*
    FNXC:TaskDetailAndroidBack 2026-06-29-20:40:
    The mobile shell dispatches a cancelable native Back event before applying its fallback. Prevent it only when Fusion owns at least one nav entry, then route through history.back() so modal, nested, snapshot-only, hydrated, and main-panel task-detail dismissals reuse the same popstate stack semantics as browser Back and swipe-back.
    */
    const handleNativeBack = (event: Event) => {
      if (!enabledRef.current) return;
      if (stackRef.current.length === 0) return;

      event.preventDefault();
      window.history.back();
    };

    const handlePopState = (event: PopStateEvent) => {
      if (!enabledRef.current) return;

      if (selfPopRef.current) {
        selfPopRef.current = false;
        if (selfPopClearTimerRef.current !== null) {
          window.clearTimeout(selfPopClearTimerRef.current);
          selfPopClearTimerRef.current = null;
        }
        return;
      }

      const targetIndex = event.state?.navIndex ?? 0;
      const currentLength = stackRef.current.length;

      if (targetIndex >= currentLength) return;

      // Calculate how many entries were popped
      const poppedCount = currentLength - targetIndex;

      if (poppedCount <= 0) return;

      isPoppingRef.current = true;

      try {
        // Pop entries in reverse order (top of stack first)
        for (let i = 0; i < poppedCount; i++) {
          const entry = stackRef.current.pop();
          if (entry) {
            if (entry.type === "modal") {
              entry.close();
            } else {
              entry.revert();
            }
          }
        }
      } finally {
        isPoppingRef.current = false;
      }
    };

    window.addEventListener(FUSION_NATIVE_BACK_EVENT, handleNativeBack);
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener(FUSION_NATIVE_BACK_EVENT, handleNativeBack);
      window.removeEventListener("popstate", handlePopState);
      if (selfPopClearTimerRef.current !== null) {
        window.clearTimeout(selfPopClearTimerRef.current);
        selfPopClearTimerRef.current = null;
      }
    };
  }, []);

  return { pushNav, replaceCurrent, removeNav };
}
