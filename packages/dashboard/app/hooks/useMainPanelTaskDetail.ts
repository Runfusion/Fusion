/*
FNXC:TaskDetail 2026-06-24-00:00:
Snapshot of the task whose detail is shown in the main panel (Board card click → full-panel detail), plus its initial tab. Kept as a snapshot so the view survives a tasks revalidation. Exposes the setters so App can compose open/close with view navigation, and so the embedded detail can patch the snapshot on task updates (setTask accepts the updater form). Extracted from AppInner.
*/

import { useState, type Dispatch, type SetStateAction } from "react";
import type { Task, TaskDetail } from "@fusion/core";
import type { DetailTaskTab } from "./useModalManager";

export interface UseMainPanelTaskDetailResult {
  task: Task | TaskDetail | null;
  initialTab: DetailTaskTab;
  setTask: Dispatch<SetStateAction<Task | TaskDetail | null>>;
  setInitialTab: (tab: DetailTaskTab) => void;
}

export function useMainPanelTaskDetail(): UseMainPanelTaskDetailResult {
  const [task, setTask] = useState<Task | TaskDetail | null>(null);
  const [initialTab, setInitialTab] = useState<DetailTaskTab>("chat");

  return { task, initialTab, setTask, setInitialTab };
}
