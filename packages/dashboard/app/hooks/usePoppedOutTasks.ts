/*
FNXC:FloatingWindow 2026-07-15-14:55:
Popped-out task-detail windows are movable, resizable, non-blocking FloatingWindows. Each entry is a task snapshot; several can be open at once. Reopening the same task from the same origin refreshes its snapshot without collapsing an independently opened popup in another view. Extracted from AppInner.
*/

import { useCallback, useMemo, useState } from "react";
import type { Task, TaskDetail } from "@fusion/core";
import type { TaskView } from "./useViewState";
import type { DetailTaskTab } from "./useModalManager";

export interface PoppedOutTaskEntry {
  task: Task | TaskDetail;
  originTaskView?: TaskView;
  initialTab?: DetailTaskTab;
}

export interface UsePoppedOutTasksResult {
  entries: PoppedOutTaskEntry[];
  tasks: Array<Task | TaskDetail>;
  popOut: (task: Task | TaskDetail, originTaskView?: TaskView, initialTab?: DetailTaskTab) => void;
  close: (taskId: string, originTaskView?: TaskView) => void;
}

export function usePoppedOutTasks(): UsePoppedOutTasksResult {
  const [entries, setEntries] = useState<PoppedOutTaskEntry[]>([]);

  /*
  FNXC:TaskPopupDeepTabs 2026-07-21-00:00:
  FN-8478 requires board card deep-tab actions to keep the board visible when Open tasks as popups is enabled. Store the requested tab with the popup snapshot so reopening an existing task-and-view pair refreshes both its data and destination.
  */
  const popOut = useCallback((task: Task | TaskDetail, originTaskView?: TaskView, initialTab?: DetailTaskTab) => {
    setEntries((current) => {
      const existingIndex = current.findIndex((entry) => entry.task.id === task.id && entry.originTaskView === originTaskView);
      const entry = { task, originTaskView, ...(initialTab ? { initialTab } : {}) };
      if (existingIndex === -1) return [...current, entry];

      const upgraded = [...current];
      upgraded[existingIndex] = entry;
      return upgraded;
    });
  }, []);

  const close = useCallback((taskId: string, originTaskView?: TaskView) => {
    setEntries((current) => current.filter((entry) => entry.task.id !== taskId || entry.originTaskView !== originTaskView));
  }, []);

  /*
  FNXC:TaskPopupViewGating 2026-07-15-15:20:
  FN-8016 scopes popup identity to task id plus opening view. Every new pop-out has an origin; undefined origins are retained only for legacy snapshots and remain globally visible for compatibility. Closing receives the same identity so a task open on two views stays independent.
  */
  const tasks = useMemo(() => entries.map((entry) => entry.task), [entries]);

  return { entries, tasks, popOut, close };
}
