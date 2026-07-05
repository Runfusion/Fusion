import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskCreateInput } from "@fusion/core";
import type { ToastType } from "./useToast";

interface UseTaskHandlersOptions {
  createTask: (input: TaskCreateInput) => Promise<Task>;
  ingestCreatedTasks: (tasks: Task[]) => void;
  onPlanningTaskCreated: (task: Task, addToast: (msg: string, type?: ToastType) => void) => void;
  onPlanningTasksCreated: (tasks: Task[], addToast: (msg: string, type?: ToastType) => void) => void;
  onSubtaskTasksCreated: (tasks: Task[], addToast: (msg: string, type?: ToastType) => void) => void;
  addToast: (message: string, type?: ToastType) => void;
}

export interface UseTaskHandlersResult {
  handleBoardQuickCreate: (input: TaskCreateInput) => Promise<Task>;
  handleModalCreate: (input: TaskCreateInput) => Promise<Task>;
  handlePlanningTaskCreated: (task: Task) => void;
  handlePlanningTasksCreated: (tasks: Task[]) => void;
  handleSubtaskTasksCreated: (tasks: Task[]) => void;
  handleGitHubImport: (task: Task) => void;
}

export function useTaskHandlers(options: UseTaskHandlersOptions): UseTaskHandlersResult {
  const { t } = useTranslation("app");
  const {
    createTask,
    ingestCreatedTasks,
    onPlanningTaskCreated,
    onPlanningTasksCreated,
    onSubtaskTasksCreated,
    addToast,
  } = options;

  /*
  FNXC:CodingIdeasWorkflow 2026-07-05-00:00:
  These wrappers previously forced `column: "triage"` (handleBoardQuickCreate defaulted to it when the caller omitted column; handleModalCreate hard-coded it unconditionally), which overrode InlineCreateCard/NewTaskModal even after those callers stopped sending an explicit column. Both must now forward the caller's `column` untouched (usually omitted) so the store resolves the landing column from the (selected or default) workflow's intake column — e.g. Coding (Ideas) → "ideas" — instead of always forcing legacy triage.
  */
  const handleBoardQuickCreate = useCallback(
    async (input: TaskCreateInput): Promise<Task> => {
      return createTask({ ...input, source: { sourceType: "dashboard_ui" } });
    },
    [createTask],
  );

  const handleModalCreate = useCallback(
    async (input: TaskCreateInput): Promise<Task> => {
      const task = await createTask({ ...input, source: { sourceType: "dashboard_ui" } });
      return task;
    },
    [createTask],
  );

  const handlePlanningTaskCreated = useCallback((task: Task) => {
    ingestCreatedTasks([task]);
    onPlanningTaskCreated(task, addToast);
  }, [addToast, ingestCreatedTasks, onPlanningTaskCreated]);

  const handlePlanningTasksCreated = useCallback((tasks: Task[]) => {
    ingestCreatedTasks(tasks);
    onPlanningTasksCreated(tasks, addToast);
  }, [addToast, ingestCreatedTasks, onPlanningTasksCreated]);

  const handleSubtaskTasksCreated = useCallback((tasks: Task[]) => {
    ingestCreatedTasks(tasks);
    onSubtaskTasksCreated(tasks, addToast);
  }, [addToast, ingestCreatedTasks, onSubtaskTasksCreated]);

  const handleGitHubImport = useCallback((task: Task) => {
    addToast(t("taskHandlers.githubImported", "Imported {{id}} from GitHub", { id: task.id }), "success");
  }, [addToast, t]);

  return {
    handleBoardQuickCreate,
    handleModalCreate,
    handlePlanningTaskCreated,
    handlePlanningTasksCreated,
    handleSubtaskTasksCreated,
    handleGitHubImport,
  };
}
