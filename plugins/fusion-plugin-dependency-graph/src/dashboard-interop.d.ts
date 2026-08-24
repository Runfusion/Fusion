/*
FNXC:StuckTagRemoval 2026-08-17-22:30:
The taskStuck shim was deleted with the dashboard's stuck-task tagging; the host module no longer exists.
*/
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
    onOpenMission?: (missionId: string) => void;
    onMoveTask?: (id: string, column: Column, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
    lastFetchTimeMs?: number;
    /* FNXC:WorkflowLifecycleColumns 2026-07-31-15:30: the prop the host card already accepts; without it
       declared here a plugin-drawn card could not be given the board's traits at all. */
    taskColumnFlags?: Partial<TraitFlags>;
    /*
    FNXC:PluginInteropDrift 2026-08-20-21:01:
    FN-051 removed TaskCard's `disableDrag` prop (native task dragging is gone entirely),
    but this mirror kept declaring it — check:plugin-interop-drift flags the phantom member,
    and the plugin's own tsc build rejected the pass-through at GraphTaskNode. Drag state
    is now unconditionally off inside TaskCard, so the prop is deleted here and at the call site.
    */
  }

  export function TaskCard(props: TaskCardProps): ReactElement;
}

declare module "@fusion/dashboard/app/utils/projectStorage" {
  export function getScopedItem(baseKey: string, projectId?: string): string | null;
  /*
  FNXC:PluginInteropDrift 2026-08-20-21:01:
  FN-9160 (#3477) added the optional `options.maxBytes` cap and made setScopedItem report
  write success; the mirror kept the old 3-param/void shape, so check:plugin-interop-drift
  failed the Lint gate on every PR. Mirrors the real signature exactly.
  */
  export function setScopedItem(baseKey: string, value: string, projectId?: string, options?: { maxBytes?: number }): boolean;
  export function removeScopedItem(baseKey: string, projectId?: string): void;
}
