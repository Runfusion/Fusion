/*
FNXC:FloatingWindow 2026-07-15-14:55:
Popped-out task-detail windows are movable, resizable, non-blocking FloatingWindows. Each entry is a task snapshot; several can be open at once. Reopening the same task from the same origin refreshes its snapshot without collapsing an independently opened popup in another view. Extracted from AppInner.
*/

import { useCallback, useMemo, useState } from "react";
import type { Task, TaskDetail } from "@fusion/core";
import type { TaskView } from "./useViewState";

export interface PoppedOutTaskEntry {
  task: Task | TaskDetail;
  originTaskView?: TaskView;
}

export interface UsePoppedOutTasksResult {
  entries: PoppedOutTaskEntry[];
  tasks: Array<Task | TaskDetail>;
  popOut: (task: Task | TaskDetail, originTaskView?: TaskView) => void;
  close: (taskId: string, originTaskView?: TaskView) => void;
}

export function usePoppedOutTasks(): UsePoppedOutTasksResult {
  const [entries, setEntries] = useState<PoppedOutTaskEntry[]>([]);

  const popOut = useCallback((task: Task | TaskDetail, originTaskView?: TaskView) => {
    setEntries((current) => {
      const existingIndex = current.findIndex((entry) => entry.task.id === task.id && entry.originTaskView === originTaskView);
      if (existingIndex === -1) return [...current, { task, originTaskView }];

      const upgraded = [...current];
      upgraded[existingIndex] = { task, originTaskView };
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
