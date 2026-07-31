declare module "@fusion/dashboard/app/utils/taskStuck" {
  import type { Task, TraitFlags } from "@fusion/core";

  /* FNXC:WorkflowLifecycleColumns 2026-07-31-15:30: the 4th parameter existed upstream and this shim
     did not declare it, so the plugin could not pass resolved traits even once it had them — and
     `isWipColumnRole` fell back to the literal, meaning NO card in the graph was ever shown stuck on a
     renamed board while the same card showed stuck correctly on the main board. */
  export function isTaskStuck(
    task: Task,
    /* FNXC:PluginInteropDrift 2026-07-31-07:50: positionally REQUIRED in the real signature
       (`number | undefined`), not optional — a mirror that is merely approximate is the drift this
       file already caused once. Found by check-plugin-interop-drift. */
    taskStuckTimeoutMs: number | undefined,
    lastFetchTimeMs?: number,
    columnFlags?: Partial<TraitFlags>,
  ): boolean;
}

declare module "@fusion/dashboard/app/plugins/types" {
  import type { ReactNode } from "react";
  import type { Task, TaskDetail, TraitFlags, WorkflowStep } from "@fusion/core";

  export type DetailTaskTab = "definition" | "logs" | "changes" | "comments" | "model" | "workflow" | "pr" | "retries";

  export type PluginToastType = "success" | "error" | "warning" | "info";

  export interface PluginDashboardViewContext {
    projectId?: string;
    tasks: Task[];
    workflowSteps: WorkflowStep[];
    openTaskDetail: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
    /* FNXC:WorkflowLifecycleColumns 2026-07-31-15:30: mirrors the host's `PluginDashboardViewContext`. */
    columnFlagsByTaskId?: ReadonlyMap<string, Partial<TraitFlags>>;
    renderTaskCard?: (task: Task | TaskDetail) => ReactNode;
    addToast?: (message: string, type?: PluginToastType) => void;
  }

  export type PluginTaskView = `plugin:${string}:${string}`;
}

declare module "@fusion/dashboard/app/components/TaskCard" {
  import type { Column, Task, TaskDetail, TraitFlags } from "@fusion/core";
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
    /* FNXC:WorkflowLifecycleColumns 2026-07-31-15:30: the prop the host card already accepts; without it
       declared here a plugin-drawn card could not be given the board's traits at all. */
    taskColumnFlags?: Partial<TraitFlags>;
    disableDrag?: boolean;
  }

  export function TaskCard(props: TaskCardProps): ReactElement;
}

declare module "@fusion/dashboard/app/utils/projectStorage" {
  export function getScopedItem(baseKey: string, projectId?: string): string | null;
  export function setScopedItem(baseKey: string, value: string, projectId?: string): void;
  export function removeScopedItem(baseKey: string, projectId?: string): void;
}
