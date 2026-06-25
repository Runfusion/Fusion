/*
FNXC:BoardNavigation 2026-06-24-00:00:
Preserves horizontal board scroll and per-column vertical scroll across a board → task-detail → back-to-board round trip. capture() snapshots before opening detail; requestRestore() schedules a restore that fires (double requestAnimationFrame, after the board remounts) once the view returns to "board". Extracted from AppInner.
*/

import { useCallback, useEffect, useRef } from "react";
import {
  captureBoardScrollSnapshot,
  restoreBoardScrollSnapshot,
  type BoardScrollSnapshot,
} from "../utils/boardScrollSnapshot";
import type { TaskView } from "./useViewState";

export interface UseBoardScrollRestoreResult {
  capture: () => void;
  requestRestore: () => void;
}

export function useBoardScrollRestore(taskView: TaskView): UseBoardScrollRestoreResult {
  const boardScrollSnapshotRef = useRef<BoardScrollSnapshot | null>(null);
  const pendingBoardScrollRestoreRef = useRef(false);

  const restore = useCallback(() => {
    if (restoreBoardScrollSnapshot(boardScrollSnapshotRef.current)) {
      pendingBoardScrollRestoreRef.current = false;
    }
  }, []);

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
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = scheduleFrame(() => {
      secondFrame = scheduleFrame(restore);
    });
    return () => {
      cancelFrame(firstFrame);
      cancelFrame(secondFrame);
    };
  }, [restore, taskView]);

  return { capture, requestRestore };
}
