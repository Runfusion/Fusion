/*
FNXC:FloatingWindow 2026-07-15-14:55:
Popped-out task-detail windows are movable, resizable, non-blocking FloatingWindows. Each entry is a task snapshot; several can be open at once. Extracted from AppInner.

FNXC:TaskWindowIdentity 2026-09-14-17:46:
FN-392: a task has exactly ONE window per project, identified by its task id alone. The opening view is no longer part
of that identity, because a window scoped to its origin view disappeared as soon as the operator navigated elsewhere
and could silently duplicate the same task across views. Reopening a task from any view refreshes its snapshot and
requested tab in place and advances `focusNonce`, so the existing window is raised rather than remounted.
*/

import { useCallback, useMemo, useState } from "react";
import type { Task, TaskDetail } from "@fusion/core";
import type { DetailTaskTab } from "./useModalManager";

export interface PoppedOutTaskEntry {
  task: Task | TaskDetail;
  initialTab?: DetailTaskTab;
  /** Increments on every open request for an already-open task so its window can reclaim the front. */
  focusNonce: number;
}

export interface UsePoppedOutTasksResult {
  entries: PoppedOutTaskEntry[];
  tasks: Array<Task | TaskDetail>;
  popOut: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
  close: (taskId: string) => void;
  /*
  FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
  Popped-out task windows are task-detail surfaces for the active project. A project swap
  must dismiss them all — they bypass modalManager.detailTask, so closeProjectScopedModals
  alone left the previous project's task popups floating over the new project.
  */
  closeAll: () => void;
}

export function usePoppedOutTasks(): UsePoppedOutTasksResult {
  const [entries, setEntries] = useState<PoppedOutTaskEntry[]>([]);

  /*
  FNXC:TaskPopupDeepTabs 2026-07-21-00:00:
  FN-8478 requires board card deep-tab actions to keep the board visible when Open tasks as popups is enabled. Store the requested tab with the popup snapshot so reopening an existing task refreshes both its data and destination.
  */
  const popOut = useCallback((task: Task | TaskDetail, initialTab?: DetailTaskTab) => {
    setEntries((current) => {
      const existingIndex = current.findIndex((entry) => entry.task.id === task.id);
      if (existingIndex === -1) return [...current, { task, ...(initialTab ? { initialTab } : {}), focusNonce: 1 }];

      const upgraded = [...current];
      const previous = upgraded[existingIndex];
      upgraded[existingIndex] = {
        task,
        ...(initialTab ? { initialTab } : previous.initialTab ? { initialTab: previous.initialTab } : {}),
        focusNonce: previous.focusNonce + 1,
      };
      return upgraded;
    });
  }, []);

  const close = useCallback((taskId: string) => {
    setEntries((current) => current.filter((entry) => entry.task.id !== taskId));
  }, []);

  const closeAll = useCallback(() => {
    setEntries([]);
  }, []);

  const tasks = useMemo(() => entries.map((entry) => entry.task), [entries]);

  return { entries, tasks, popOut, close, closeAll };
}
