declare module "@fusion/dashboard/app/utils/taskStuck" {
  import type { Task } from "@fusion/core";

  export function isTaskStuck(task: Task, taskStuckTimeoutMs?: number, lastFetchTimeMs?: number): boolean;
}

declare module "@fusion/dashboard/app/plugins/types" {
  import type { Task, TaskDetail, WorkflowStep } from "@fusion/core";

  export interface PluginDashboardViewContext {
    tasks: Task[];
    projectId?: string;
    workflowSteps?: WorkflowStep[];
    openTaskDetail?: (task: Task | TaskDetail) => void;
  }
}

declare module "@fusion/dashboard/app/components/TaskCard" {
  import type { Column, Task, TaskDetail } from "@fusion/core";
  import type { ReactElement } from "react";

  interface TaskCardProps {
    task: Task;
    projectId?: string;
    onOpenDetail: (task: Task | TaskDetail) => void;
    addToast: (message: string, type?: "success" | "error" | "info" | "warning") => void;
    globalPaused?: boolean;
    onUpdateTask?: (
      id: string,
      updates: { title?: string; description?: string; dependencies?: string[] }
    ) => Promise<Task>;
    onArchiveTask?: (id: string) => Promise<Task>;
    onUnarchiveTask?: (id: string) => Promise<Task>;
    onDeleteTask?: (id: string, options?: { removeDependencyReferences?: boolean }) => Promise<Task>;
    onRetryTask?: (id: string) => Promise<Task>;
    onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes") => void;
    taskStuckTimeoutMs?: number;
    onOpenMission?: (missionId: string) => void;
    onMoveTask?: (id: string, column: Column, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
    lastFetchTimeMs?: number;
    workflowStepNameLookup?: ReadonlyMap<string, string>;
    disableDrag?: boolean;
  }

  export function TaskCard(props: TaskCardProps): ReactElement;
}

declare module "@fusion/dashboard/app/utils/projectStorage" {
  export function getScopedItem(baseKey: string, projectId?: string): string | null;
  export function setScopedItem(baseKey: string, value: string, projectId?: string): void;
  export function removeScopedItem(baseKey: string, projectId?: string): void;
}
