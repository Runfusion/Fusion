import { useCallback } from "react";
import type { Task, TaskCreateInput } from "@fusion/core";
import type { ToastType } from "./useToast";

interface UseTaskHandlersOptions {
  createTask: (input: TaskCreateInput) => Promise<Task>;
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
  const {
    createTask,
    onPlanningTaskCreated,
    onPlanningTasksCreated,
    onSubtaskTasksCreated,
    addToast,
  } = options;

  const handleBoardQuickCreate = useCallback(
    async (input: TaskCreateInput): Promise<Task> => {
      return createTask({ ...input, column: "triage" });
    },
    [createTask],
  );

  const handleModalCreate = useCallback(
    async (input: TaskCreateInput): Promise<Task> => {
      const task = await createTask({ ...input, column: "triage" });
      return task;
    },
    [createTask],
  );

  const handlePlanningTaskCreated = useCallback((task: Task) => {
    onPlanningTaskCreated(task, addToast);
  }, [onPlanningTaskCreated, addToast]);

  const handlePlanningTasksCreated = useCallback((tasks: Task[]) => {
    onPlanningTasksCreated(tasks, addToast);
  }, [onPlanningTasksCreated, addToast]);

  const handleSubtaskTasksCreated = useCallback((tasks: Task[]) => {
    onSubtaskTasksCreated(tasks, addToast);
  }, [onSubtaskTasksCreated, addToast]);

  const handleGitHubImport = useCallback((task: Task) => {
    addToast(`Imported ${task.id} from GitHub`, "success");
  }, [addToast]);

  return {
    handleBoardQuickCreate,
    handleModalCreate,
    handlePlanningTaskCreated,
    handlePlanningTasksCreated,
    handleSubtaskTasksCreated,
    handleGitHubImport,
  };
}
