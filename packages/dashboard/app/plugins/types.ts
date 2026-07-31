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
import type { Task, TaskDetail, TraitFlags, WorkflowStep } from "@fusion/core";

/**
 * Tab identifiers for the task detail modal. Mirrors the dashboard's local enum.
 *
 * FNXC:TaskDetailActivity 2026-06-30-22:15:
 * Plugins should continue passing `chat` to open the renamed Activity tab; the id is stable compatibility surface, while the top-level label is no longer Chat. Legacy `logs` requests remain accepted by the host and route to Activity → Feed because Logs is no longer a visible top-level tab.
 */
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
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-15:30:
  The board's resolved column traits, per task id — so a plugin view that draws its OWN card is not
  forced back onto the legacy ids.

  #3025 fixed the two producers that go through `renderTaskCard`. A plugin that imports `TaskCard`
  directly is a THIRD producer, and it could not be fixed the same way: this context exposed `tasks`
  and nothing about the board's vocabulary, so every role helper inside a plugin-drawn card, and
  every trait predicate a plugin calls, fell back to the literal.

  `Partial<TraitFlags>` rather than the dashboard's `ExecutorColumnFlags`, because this module is
  deliberately importable by external plugin builds and may only reference `@fusion/core` and `react`
  (see the header). The runtime value is the same object either way — the map is built from
  `workflow.columns.find(...).flags`.

  Optional and absent-means-legacy, matching how the host already treats remote rows and off-board
  columns: a consumer degrades to the documented legacy names rather than reading "resolved and
  empty" as "this board has no such lane".
  */
  columnFlagsByTaskId?: ReadonlyMap<string, Partial<TraitFlags>>;
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
