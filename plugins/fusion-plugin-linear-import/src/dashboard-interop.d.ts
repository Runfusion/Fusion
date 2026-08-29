declare module "@fusion/dashboard/app/plugins/types" {
  import type { ReactNode } from "react";

  export interface PluginDashboardViewContext {
    projectId?: string;
    tasks?: unknown[];
    workflowSteps?: unknown[];
    openTaskDetail?: (...args: unknown[]) => void;
    openFile?: (...args: unknown[]) => void;
    renderTaskCard?: (...args: unknown[]) => ReactNode;
    addToast?: (message: string, type?: "success" | "error" | "warning" | "info") => void;
  }
}
