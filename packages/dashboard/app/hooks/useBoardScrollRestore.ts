/*
FNXC:BoardNavigation 2026-06-24-00:00:
Preserves horizontal board scroll and per-column vertical scroll across a board → task-detail → back-to-board round trip. capture() snapshots before opening detail; requestRestore() schedules a restore that fires (double requestAnimationFrame, after the board remounts) once the view returns to "board". Extracted from AppInner.

FNXC:BoardNavigation 2026-06-29-20:45:
Mobile Back-to-board must restore the clicked-card board position after the full-panel detail unmounts. Retry the restore for a bounded sequence of animation frames because mobile board layout stabilization and workflow-board hydration can temporarily leave #board unavailable or reset its offsets after the first post-return frame.

FNXC:BoardNavigation 2026-07-26-10:20:
Mobile browsers discard a backgrounded dashboard tab (iOS Safari tab, iOS installed PWA, Chrome Android alike) and reload it from scratch when the user returns — the "white splash reload". That is an involuntary, OS-driven event, so the app must be able to put the user back where they were rather than at the top of the board.
Two additions carry the snapshot across that reload:
  1. Persist on hide. `pagehide` / `visibilitychange:hidden` is the LAST moment we are guaranteed to run before a discard, and the common case is a user who was sitting on the board and never opened task detail — so the existing capture-on-open-detail path alone would have nothing to restore. Snapshot-on-hide is cheap (a handful of scrollTop reads plus one sessionStorage write) and does no background work while hidden, so it does not itself make the tab a discard candidate.
  2. Replay on mount. A reloaded board has no rows until its first fetch resolves, so the restore is retried on a bounded timer (not a busy rAF chain — a discarded-tab restore can take far longer than a remount, and the timer stays cheap) until the board actually has columns, then stops. Any real user scroll/keyboard input aborts the replay immediately; never fight the user for control of the scroll position.
The mount replay defers to the in-memory back-navigation path: it only seeds the ref when nothing is captured and no restore is pending, and it re-checks that pending flag on every attempt, so the two paths can never race for the same board.
*/

import { useCallback, useEffect, useRef } from "react";
import {
  captureBoardScrollSnapshot,
  persistBoardScrollSnapshot,
  readPersistedBoardScrollSnapshot,
  restoreBoardScrollSnapshot,
  type BoardScrollSnapshot,
} from "../utils/boardScrollSnapshot";
import type { TaskView } from "./useViewState";

const MAX_RESTORE_ATTEMPTS = 6;

/*
Bounded reload-replay budget: ~4s of 100ms polls. Long enough to outlast a cold board fetch on a
mobile connection, short enough that a board which never renders stops costing anything.
*/
const RELOAD_RESTORE_INTERVAL_MS = 100;
const RELOAD_RESTORE_MAX_ATTEMPTS = 40;

export interface UseBoardScrollRestoreResult {
  capture: () => void;
  requestRestore: () => void;
}

export function useBoardScrollRestore(taskView: TaskView): UseBoardScrollRestoreResult {
  const boardScrollSnapshotRef = useRef<BoardScrollSnapshot | null>(null);
  const pendingBoardScrollRestoreRef = useRef(false);
  const taskViewRef = useRef(taskView);

  useEffect(() => {
    taskViewRef.current = taskView;
  }, [taskView]);

  const capture = useCallback(() => {
    const snapshot = captureBoardScrollSnapshot();
    boardScrollSnapshotRef.current = snapshot;
    // Mirror to sessionStorage so a discard/reload between now and the return still restores.
    persistBoardScrollSnapshot(snapshot);
  }, []);

  const requestRestore = useCallback(() => {
    pendingBoardScrollRestoreRef.current = true;
  }, []);

  // Snapshot-on-hide: the last guaranteed callback before an OS tab discard.
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const persistNow = () => {
      if (taskViewRef.current !== "board") return;
      const snapshot = captureBoardScrollSnapshot();
      if (!snapshot) return;
      boardScrollSnapshotRef.current = snapshot;
      persistBoardScrollSnapshot(snapshot);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") persistNow();
    };

    window.addEventListener("pagehide", persistNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", persistNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Reload/discard replay: restore the persisted snapshot once the board actually has content.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // An in-flight in-memory restore owns the board; do not seed a competing one.
    if (boardScrollSnapshotRef.current || pendingBoardScrollRestoreRef.current) return;

    const persisted = readPersistedBoardScrollSnapshot();
    if (!persisted) return;
    boardScrollSnapshotRef.current = persisted;

    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const cancel = () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      window.removeEventListener("wheel", cancel);
      window.removeEventListener("touchstart", cancel);
      window.removeEventListener("keydown", cancel);
    };

    const attempt = () => {
      timer = null;
      if (cancelled) return;
      attempts += 1;
      // Only replay while the board is the visible surface, and never on top of a pending
      // back-navigation restore — that path has a fresher snapshot.
      if (taskViewRef.current === "board" && !pendingBoardScrollRestoreRef.current) {
        if (restoreBoardScrollSnapshot(boardScrollSnapshotRef.current)) {
          cancel();
          return;
        }
      }
      if (attempts >= RELOAD_RESTORE_MAX_ATTEMPTS) {
        cancel();
        return;
      }
      timer = setTimeout(attempt, RELOAD_RESTORE_INTERVAL_MS);
    };

    window.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("keydown", cancel);
    timer = setTimeout(attempt, 0);

    return cancel;
  }, []);

  useEffect(() => {
    if (taskView !== "board" || !pendingBoardScrollRestoreRef.current) return;
    const scheduleFrame = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : ((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
    const cancelFrame = typeof window.cancelAnimationFrame === "function"
      ? window.cancelAnimationFrame.bind(window)
      : window.clearTimeout.bind(window);
    const frameIds: number[] = [];
    let attempts = 0;
    let cancelled = false;

    const schedule = (callback: FrameRequestCallback) => {
      const id = scheduleFrame(callback);
      frameIds.push(id);
    };

    const attemptRestore = () => {
      if (cancelled || !pendingBoardScrollRestoreRef.current) return;
      attempts += 1;
      const restored = restoreBoardScrollSnapshot(boardScrollSnapshotRef.current);
      if (restored) {
        pendingBoardScrollRestoreRef.current = false;
        return;
      }
      if (attempts < MAX_RESTORE_ATTEMPTS) {
        schedule(attemptRestore);
      }
    };

    schedule(() => {
      schedule(attemptRestore);
    });
    return () => {
      cancelled = true;
      frameIds.forEach(cancelFrame);
    };
  }, [taskView]);

  return { capture, requestRestore };
}
