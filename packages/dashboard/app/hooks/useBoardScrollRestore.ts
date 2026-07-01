/*
FNXC:BoardNavigation 2026-06-24-00:00:
Preserves horizontal board scroll and per-column vertical scroll across a board → task-detail → back-to-board round trip. capture() snapshots before opening detail; requestRestore() schedules a restore that fires (double requestAnimationFrame, after the board remounts) once the view returns to "board". Extracted from AppInner.

FNXC:BoardNavigation 2026-06-29-20:45:
Mobile Back-to-board must restore the clicked-card board position after the full-panel detail unmounts. Retry the restore for a bounded sequence of animation frames because mobile board layout stabilization and workflow-board hydration can temporarily leave #board unavailable or reset its offsets after the first post-return frame.
*/

import { useCallback, useEffect, useRef } from "react";
import {
  captureBoardScrollSnapshot,
  restoreBoardScrollSnapshot,
  type BoardScrollSnapshot,
} from "../utils/boardScrollSnapshot";
import type { TaskView } from "./useViewState";

const MAX_RESTORE_ATTEMPTS = 6;

export interface UseBoardScrollRestoreResult {
  capture: () => void;
  requestRestore: () => void;
}

export function useBoardScrollRestore(taskView: TaskView): UseBoardScrollRestoreResult {
  const boardScrollSnapshotRef = useRef<BoardScrollSnapshot | null>(null);
  const pendingBoardScrollRestoreRef = useRef(false);

  const capture = useCallback(() => {
    boardScrollSnapshotRef.current = captureBoardScrollSnapshot();
  }, []);

  const requestRestore = useCallback(() => {
    pendingBoardScrollRestoreRef.current = true;
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
