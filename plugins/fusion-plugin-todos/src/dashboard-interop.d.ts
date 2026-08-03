declare module "@fusion/dashboard/app/plugins/types" {
  import type { Task, TaskDetail, WorkflowStep } from "@fusion/core";
  export type PluginToastType = "success" | "error" | "warning" | "info";
  export interface PluginDashboardViewContext {
    projectId?: string;
    tasks: Task[];
    workflowSteps: WorkflowStep[];
    addToast?: (message: string, type?: PluginToastType) => void;
    openPlanningMode?: (initialPlan: string) => void;
    onTaskCreated?: (task: Task | TaskDetail) => void;
  }
}
