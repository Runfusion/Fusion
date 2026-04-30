import { useCallback } from "react";
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
  const {
    createTask,
    ingestCreatedTasks,
    onPlanningTaskCreated,
    onPlanningTasksCreated,
    onSubtaskTasksCreated,
    addToast,
  } = options;

  const handleBoardQuickCreate = useCallback(
    async (input: TaskCreateInput): Promise<Task> => {
      return createTask({ ...input, column: "triage", source: { sourceType: "dashboard_ui" } });
    },
    [createTask],
  );

  const handleModalCreate = useCallback(
    async (input: TaskCreateInput): Promise<Task> => {
      const task = await createTask({ ...input, column: "triage", source: { sourceType: "dashboard_ui" } });
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
