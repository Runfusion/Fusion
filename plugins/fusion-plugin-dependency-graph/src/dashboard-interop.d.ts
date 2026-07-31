/*
FNXC:WorkflowResolvedColumns 2026-07-31-06:10:
THIS FILE IS A HAND-MAINTAINED MIRROR of the dashboard surfaces this plugin uses, wired in via
tsconfig `paths`. It drifts silently: the real `isTaskStuck` grew a fourth `columnFlags` parameter
during the lane conversion and this declaration kept the three-argument shape, so the plugin could
not have supplied the argument even if someone tried — the compiler said it did not exist.

That drift is what made this look like a build-plumbing problem from outside. Any future dashboard
surface added here needs the same update, and there is no check that notices.
*/
declare module "@fusion/dashboard/app/utils/taskStuck" {
  import type { Task } from "@fusion/core";

  export function isTaskStuck(
    task: Task,
    taskStuckTimeoutMs?: number,
    lastFetchTimeMs?: number,
    columnFlags?: {
    readonly intake?: boolean;
    readonly hold?: boolean;
    readonly countsTowardWip?: boolean;
    readonly mergeBlocker?: boolean;
    readonly humanReview?: boolean;
    readonly complete?: boolean;
    readonly archived?: boolean;
  },
  ): boolean;
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
    /** Per-task lane traits; absent means fall back to the legacy ids. */
    columnFlagsByTaskId?: ReadonlyMap<string, {
    readonly intake?: boolean;
    readonly hold?: boolean;
    readonly countsTowardWip?: boolean;
    readonly mergeBlocker?: boolean;
    readonly humanReview?: boolean;
    readonly complete?: boolean;
    readonly archived?: boolean;
  }>;
    renderTaskCard?: (task: Task | TaskDetail) => ReactNode;
    addToast?: (message: string, type?: PluginToastType) => void;
  }

  export type PluginTaskView = `plugin:${string}:${string}`;
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
    taskColumnFlags?: {
    readonly intake?: boolean;
    readonly hold?: boolean;
    readonly countsTowardWip?: boolean;
    readonly mergeBlocker?: boolean;
    readonly humanReview?: boolean;
    readonly complete?: boolean;
    readonly archived?: boolean;
  };
  }

  export function TaskCard(props: TaskCardProps): ReactElement;
}

declare module "@fusion/dashboard/app/utils/projectStorage" {
  export function getScopedItem(baseKey: string, projectId?: string): string | null;
  export function setScopedItem(baseKey: string, value: string, projectId?: string): void;
  export function removeScopedItem(baseKey: string, projectId?: string): void;
}
