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
  | { type: "modal"; id?: string; close: () => void | boolean | Promise<void | boolean> }
  | { type: "view"; id?: string; revert: () => void | boolean | Promise<void | boolean> };

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
   * Remove a programmatically-dismissed entry. By default history.back()
   * consumes its browser-history entry; `preserveHistoryPosition` instead
   * replaces the current state for a close-then-navigate transition.
   */
  removeNav: (
    identity: string | (() => unknown),
    options?: { preserveHistoryPosition?: boolean },
  ) => void;
  /** Promote a stable entry to the top without increasing browser-history depth. */
  promoteNav: (id: string) => void;
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
function getEntryCallback(entry: NavEntry): () => void | boolean | Promise<void | boolean> {
  return entry.type === "modal" ? entry.close : entry.revert;
}

function entryMatches(entry: NavEntry, identity: string | (() => unknown)): boolean {
  return typeof identity === "string" ? entry.id === identity : getEntryCallback(entry) === identity;
}

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

  const readExistingState = useCallback(() => {
    if (typeof window === "undefined") return {};
    return window.history.state && typeof window.history.state === "object"
      ? window.history.state
      : {};
  }, []);

  const writeHistoryState = useCallback(
    (mode: "push" | "replace", navIndex: number) => {
      const nextState = {
        ...readExistingState(),
        navIndex,
      };

      if (mode === "push") {
        window.history.pushState(nextState, "");
        return;
      }

      window.history.replaceState(nextState, "");
    },
    [readExistingState],
  );

  const pushNav = useCallback(
    (entry: NavEntry) => {
      if (!enabledRef.current) return;

      // Prevent re-push during pop handling
      if (isPoppingRef.current) return;

      // Guard against duplicate consecutive pushes (rapid taps). If a stale
      // top entry still uses the same callback, reconcile it in place instead
      // of silently dropping the reopen and leaving history/stack out of sync.
      const top = stackRef.current[stackRef.current.length - 1];
      if (top && ((entry.id && top.id === entry.id) || getEntryCallback(top) === getEntryCallback(entry))) {
        stackRef.current[stackRef.current.length - 1] = entry;
        writeHistoryState("replace", stackRef.current.length);
        return;
      }

      stackRef.current.push(entry);
      writeHistoryState("push", stackRef.current.length);
    },
    [writeHistoryState],
  );

  const replaceCurrent = useCallback(
    (entry: NavEntry) => {
      if (!enabledRef.current) return;
      if (stackRef.current.length === 0) return;

      stackRef.current[stackRef.current.length - 1] = entry;
      writeHistoryState("replace", stackRef.current.length);
    },
    [writeHistoryState],
  );

  const removeNav = useCallback(
    (identity: string | (() => unknown), options?: { preserveHistoryPosition?: boolean }) => {
      if (!enabledRef.current) return;

      for (let i = stackRef.current.length - 1; i >= 0; i -= 1) {
        const entry = stackRef.current[i];
        if (!entryMatches(entry, identity)) continue;

        stackRef.current.splice(i, 1);

        /*
        FNXC:GitHubImportSwipeBack 2026-07-20-23:12:
        A More-sheet action closes one history surface and immediately opens
        another. Going back asynchronously after removing More can pop that
        newly pushed Import/detail entry instead. Keep the browser at its
        current position and rewrite its nav depth for this atomic transition.
        */
        if (options?.preserveHistoryPosition) {
          writeHistoryState("replace", stackRef.current.length);
          return;
        }

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
    [writeHistoryState],
  );

  const promoteNav = useCallback((id: string) => {
    if (!enabledRef.current) return;
    const index = stackRef.current.findIndex((entry) => entry.id === id);
    if (index < 0 || index === stackRef.current.length - 1) return;
    const [entry] = stackRef.current.splice(index, 1);
    stackRef.current.push(entry);
    writeHistoryState("replace", stackRef.current.length);
  }, [writeHistoryState]);

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

      const targetIndex = typeof event.state?.navIndex === "number" ? event.state.navIndex : null;
      const currentLength = stackRef.current.length;

      if (currentLength === 0) return;

      const staleOrDesyncedIndex =
        targetIndex === null ||
        targetIndex < 0 ||
        targetIndex >= currentLength;

      /*
      FNXC:TaskDetailSwipeBack 2026-06-30-09:40:
      Mobile swipe-back must deterministically dismiss the top Fusion surface
      even when browser history carries a stale navIndex from a close→reopen
      race, remount, or interleaved non-Fusion pushState. Falling back to one
      top-entry pop keeps the live stack authoritative instead of silently
      no-oping on `targetIndex >= currentLength`.
      */
      const poppedCount = staleOrDesyncedIndex ? 1 : currentLength - targetIndex;

      if (poppedCount <= 0) return;

      isPoppingRef.current = true;

      /*
      FNXC:AlphaDesktopWindows 2026-09-11-19:35:
      A guarded floating view must remain on the stack until its asynchronous close verdict accepts. Browser Back therefore evaluates entries serially and restores the current depth when a guard cancels, while existing synchronous callbacks retain the same ordering.
      */
      const finish = () => { isPoppingRef.current = false; };
      const processEntry = (index: number): void => {
        if (index >= poppedCount) { finish(); return; }
        const entry = stackRef.current.at(-1);
        if (!entry) { finish(); return; }
        const verdict = getEntryCallback(entry)();
        const accept = (accepted: void | boolean) => {
          if (accepted === false) {
            writeHistoryState("replace", stackRef.current.length);
            finish();
            return;
          }
          if (stackRef.current.at(-1) === entry) stackRef.current.pop();
          processEntry(index + 1);
        };
        if (verdict && typeof (verdict as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(verdict).then(accept, () => accept(false));
        } else {
          accept(verdict as void | boolean);
        }
      };
      processEntry(0);
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

  return { pushNav, replaceCurrent, removeNav, promoteNav };
}
