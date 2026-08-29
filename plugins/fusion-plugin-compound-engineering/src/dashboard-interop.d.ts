// Ambient declaration for the dashboard host's plugin-view context, so this
// bundled plugin can consume the type WITHOUT a runtime dependency on
// `@fusion/dashboard` (a host package). Depending on the host would create a
// dashboard -> plugin -> dashboard cycle and violate the workspace-acyclicity /
// "bundled plugins must not depend on host packages" invariants. The host
// passes the real object at runtime; this minimal structural shape is enough to
// type-check the fields this plugin actually reads. Mirrors the interop pattern
// used by fusion-plugin-dependency-graph.
declare module "@fusion/dashboard/app/plugins/types" {
  import type { ReactNode } from "react";
  import type { Task, TaskDetail, WorkflowStep } from "@fusion/core";

  export type DetailTaskTab =
    | "definition" | "logs" | "changes" | "comments" | "model" | "workflow" | "pr" | "retries";
  export type PluginToastType = "success" | "error" | "warning" | "info";

  export interface PluginCustomEvent {
    event: string;
    payload: unknown;
  }

  export interface PluginDashboardViewContext {
    projectId?: string;
    tasks: Task[];
    workflowSteps: WorkflowStep[];
    openTaskDetail: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
    openFile: (path: string, options?: { workspace?: string; line?: number; col?: number }) => void;
    renderTaskCard?: (task: Task | TaskDetail) => ReactNode;
    addToast?: (message: string, type?: PluginToastType) => void;
    subscribePluginEvents?: (
      pluginId: string,
      onEvent: (event: PluginCustomEvent) => void,
    ) => () => void;
  }
}

// FNXC:CompoundEngineeringUI 2026-06-22-09:40:
// Ambient shape for the dashboard's shared main-content header so the CE view
// renders an icon + title header consistent with native Fusion views WITHOUT a
// runtime dependency on `@fusion/dashboard` (host package). The host resolves
// the real `ViewHeader.tsx` at runtime (and the test alias maps `@fusion/dashboard`
// to the package dir); this minimal structural declaration is enough for tsc.
declare module "@fusion/dashboard/app/components/ViewHeader" {
  import type { ComponentType, ReactNode } from "react";
  import type { LucideProps } from "lucide-react";

  export interface ViewHeaderProps {
    icon: ComponentType<LucideProps>;
    title: string;
    actions?: ReactNode;
    titleId?: string;
  }

  export function ViewHeader(props: ViewHeaderProps): ReactNode;
}
