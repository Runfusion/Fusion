declare module "@fusion/dashboard/app/plugins/PluginDashboardViewHeader" {
  import type { ComponentType, ReactNode } from "react";
  import type { LucideProps } from "lucide-react";

  export interface PluginDashboardViewHeaderProps {
    icon?: ComponentType<LucideProps>;
    title: ReactNode;
    actions?: ReactNode;
    titleId?: string;
  }

  export function PluginDashboardViewHeader(props: PluginDashboardViewHeaderProps): ReactNode;
}

declare module "@fusion/dashboard/app/plugins/types" {
  import type { ReactNode } from "react";
  import type { Task, TaskDetail, WorkflowStep } from "@fusion/core";

  export type DetailTaskTab = "definition" | "logs" | "changes" | "comments" | "model" | "workflow" | "pr" | "retries";

  export type PluginToastType = "success" | "error" | "warning" | "info";

  export interface PluginDashboardViewContext {
    projectId?: string;
    tasks: Task[];
    workflowSteps: WorkflowStep[];
    openTaskDetail: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
    renderTaskCard?: (task: Task | TaskDetail) => ReactNode;
    addToast?: (message: string, type?: PluginToastType) => void;
  }

  export type PluginTaskView = `plugin:${string}:${string}`;
}
