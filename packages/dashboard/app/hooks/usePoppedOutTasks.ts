/*
FNXC:FloatingWindow 2026-07-15-14:55:
Popped-out task-detail windows are movable, resizable, non-blocking FloatingWindows. Each entry is a task snapshot; several can be open at once. Reopening an id replaces its snapshot and origin so a stale or previously view-gated entry becomes current and visible. Extracted from AppInner.
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
  close: (taskId: string) => void;
}

export function usePoppedOutTasks(): UsePoppedOutTasksResult {
  const [entries, setEntries] = useState<PoppedOutTaskEntry[]>([]);

  const popOut = useCallback((task: Task | TaskDetail, originTaskView?: TaskView) => {
    setEntries((current) => {
      const existingIndex = current.findIndex((entry) => entry.task.id === task.id);
      if (existingIndex === -1) return [...current, { task, originTaskView }];

      const upgraded = [...current];
      upgraded[existingIndex] = { task, originTaskView };
      return upgraded;
    });
  }, []);

  const close = useCallback((taskId: string) => {
    setEntries((current) => current.filter((entry) => entry.task.id !== taskId));
  }, []);

  /*
  FNXC:TaskPopupViewGating 2026-07-15-14:55:
  Popups store their opening view so the opt-in gate can attach Board/List popups to that surface. Reopening a duplicate id updates this origin and its snapshot; callers that only need task snapshots can keep reading `tasks`.
  */
  const tasks = useMemo(() => entries.map((entry) => entry.task), [entries]);

  return { entries, tasks, popOut, close };
}
