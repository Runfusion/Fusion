/*
FNXC:StandardizedPluginViews 2026-09-13-22:40:
Todos adopts the cooperative dashboard plugin header so list creation lives once in the canonical header. Like the
other bundled plugins, the host bridge is declared locally instead of depending on dashboard internals.
*/
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
