/*
FNXC:FloatingWindow 2026-06-24-00:00:
Popped-out task-detail windows — movable, resizable, non-blocking FloatingWindows. Each entry is a task snapshot; several can be open at once. Snapshots survive a tasks revalidation (rendering prefers the live row by id). Pop-out dedupes by task id. Extracted from AppInner.
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
    setEntries((current) => (current.some((entry) => entry.task.id === task.id) ? current : [...current, { task, originTaskView }]));
  }, []);

  const close = useCallback((taskId: string) => {
    setEntries((current) => current.filter((entry) => entry.task.id !== taskId));
  }, []);

  /*
  FNXC:TaskPopupViewGating 2026-07-13-00:00:
  Popups store the TaskView where they were opened so the opt-in view gate can attach each modal to its originating Board/List surface. The snapshot stays in hook state while hidden; callers that only need legacy task snapshots can keep reading `tasks`.
  */
  const tasks = useMemo(() => entries.map((entry) => entry.task), [entries]);

  return { entries, tasks, popOut, close };
}
