/*
FNXC:FloatingWindow 2026-06-24-00:00:
Popped-out task-detail windows — movable, resizable, non-blocking FloatingWindows. Each entry is a task snapshot; several can be open at once. Snapshots survive a tasks revalidation (rendering prefers the live row by id). Pop-out dedupes by task id. Extracted from AppInner.
*/

import { useCallback, useState } from "react";
import type { Task, TaskDetail } from "@fusion/core";

export interface UsePoppedOutTasksResult {
  tasks: Array<Task | TaskDetail>;
  popOut: (task: Task | TaskDetail) => void;
  close: (taskId: string) => void;
}

export function usePoppedOutTasks(): UsePoppedOutTasksResult {
  const [tasks, setTasks] = useState<Array<Task | TaskDetail>>([]);

  const popOut = useCallback((task: Task | TaskDetail) => {
    setTasks((current) => (current.some((entry) => entry.id === task.id) ? current : [...current, task]));
  }, []);

  const close = useCallback((taskId: string) => {
    setTasks((current) => current.filter((entry) => entry.id !== taskId));
  }, []);

  return { tasks, popOut, close };
}
