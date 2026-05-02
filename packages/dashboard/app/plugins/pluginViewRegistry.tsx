import { AlertTriangle } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type { Task, TaskDetail, WorkflowStep } from "@fusion/core";
import { DependencyGraphView } from "@fusion-plugin-examples/dependency-graph/dashboard-view";
import "./pluginViewRegistry.css";

export type PluginTaskView = `plugin:${string}:${string}`;

export interface PluginDashboardHostContext {
  projectId?: string;
  tasks: Task[];
  workflowSteps: WorkflowStep[];
  openTaskDetail: (task: Task | TaskDetail, initialTab?: "logs" | "changes") => void;
  renderTaskCard: (task: Task) => ReactNode;
}

export interface PluginDashboardViewComponentProps {
  context: PluginDashboardHostContext;
}

export interface PluginDashboardViewRegistration {
  pluginId: string;
  viewId: string;
  component: ComponentType<PluginDashboardViewComponentProps>;
}

const REGISTRY: PluginDashboardViewRegistration[] = [
  {
    pluginId: "fusion-plugin-dependency-graph",
    viewId: "graph",
    component: DependencyGraphView as ComponentType<PluginDashboardViewComponentProps>,
  },
];

export function buildPluginTaskViewId(pluginId: string, viewId: string): PluginTaskView {
  return `plugin:${pluginId}:${viewId}`;
}

export function parsePluginTaskViewId(taskView: string): { pluginId: string; viewId: string } | null {
  if (!taskView.startsWith("plugin:")) return null;
  const [, pluginId, ...viewParts] = taskView.split(":");
  const viewId = viewParts.join(":");
  if (!pluginId || !viewId) return null;
  return { pluginId, viewId };
}

export function resolvePluginDashboardView(pluginId: string, viewId: string): ComponentType<PluginDashboardViewComponentProps> | null {
  const hit = REGISTRY.find((entry) => entry.pluginId === pluginId && entry.viewId === viewId);
  return hit?.component ?? null;
}

export function MissingPluginDashboardView({ pluginId, viewId }: { pluginId: string; viewId: string }): ReactNode {
  return (
    <section className="card plugin-dashboard-view-missing">
      <h2 className="plugin-dashboard-view-missing-title">
        <AlertTriangle />
        Plugin view unavailable
      </h2>
      <p className="plugin-dashboard-view-missing-description">
        The dashboard could not resolve <code>{pluginId}:{viewId}</code> from the host registry.
      </p>
    </section>
  );
}
