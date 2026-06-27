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
export type DetailTaskTab = "summary" | "chat" | "definition" | "logs" | "changes" | "comments" | "model" | "workflow" | "pr" | "retries";

export type PluginToastType = "success" | "error" | "warning" | "info";

/** A custom event a plugin pushed via `ctx.emitEvent`, delivered over SSE. */
export interface PluginCustomEvent {
  /** The event name the plugin emitted (e.g. "myplugin:thing-happened"). */
  event: string;
  /** The event payload the plugin emitted. */
  payload: unknown;
}

/** Runtime context passed to a plugin dashboard view component. */
export interface PluginDashboardViewContext {
  projectId?: string;
  tasks: Task[];
  workflowSteps: WorkflowStep[];
  openTaskDetail: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
  /** Open a project-relative file in the dashboard's built-in file viewer. */
  openFile: (path: string, options?: { workspace?: string; line?: number; col?: number }) => void;
  renderTaskCard?: (task: Task | TaskDetail) => ReactNode;
  addToast?: (message: string, type?: PluginToastType) => void;
  /**
   * Subscribe to this plugin's custom SSE events (the host forwards
   * `plugin:custom` events a plugin pushed via `ctx.emitEvent`, scoped to the
   * current project). Returns an unsubscribe function. Absent when the host
   * doesn't provide a realtime stream; consumers should fall back to polling.
   */
  subscribePluginEvents?: (
    pluginId: string,
    onEvent: (event: PluginCustomEvent) => void,
  ) => () => void;
}

/** Composite view ID format: `plugin:{pluginId}:{viewId}`. */
export type PluginTaskView = `plugin:${string}:${string}`;
