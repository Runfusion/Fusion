/**
 * Slim types-only module for plugin dashboard view contracts.
 *
 * External plugins (and their `tsc` builds) import `PluginDashboardViewContext`
 * from here so they don't transitively pull in dashboard runtime sources
 * (React components, CSS, lucide-react, etc.) through `pluginViewRegistry.tsx`.
 *
 * Keep imports here limited to type-only references from `@fusion/core`
 * and `react`. Do NOT import dashboard components, hooks, or CSS here.
 */
import type { ReactNode } from "react";
import type { Task, TaskDetail, WorkflowStep } from "@fusion/core";

/** Tab identifiers for the task detail modal. Mirrors the dashboard's local enum. */
export type DetailTaskTab = "definition" | "logs" | "changes" | "comments" | "model" | "workflow" | "retries";

export type PluginToastType = "success" | "error" | "warning" | "info";

/** Runtime context passed to a plugin dashboard view component. */
export interface PluginDashboardViewContext {
  projectId?: string;
  tasks: Task[];
  workflowSteps: WorkflowStep[];
  openTaskDetail: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
  renderTaskCard?: (task: Task | TaskDetail) => ReactNode;
  addToast?: (message: string, type?: PluginToastType) => void;
}

/** Composite view ID format: `plugin:{pluginId}:{viewId}`. */
export type PluginTaskView = `plugin:${string}:${string}`;
