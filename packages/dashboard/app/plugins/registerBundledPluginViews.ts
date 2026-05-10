import { createElement, lazy, type ReactElement } from "react";
import type { ComponentType } from "react";
import type { PluginDashboardViewContext } from "./types";
import { registerPluginView } from "./pluginViewRegistry";

let registered = false;

type PluginViewComponent = ({ context }: { context?: PluginDashboardViewContext }) => ReactElement;

function createMissingPluginView(moduleId: string, exportName: string): PluginViewComponent {
  return function MissingPluginView() {
    return createElement("span", null, `Bundled plugin view unavailable: ${moduleId}#${exportName}`);
  };
}

async function loadDependencyGraphView(): Promise<{ default: PluginViewComponent }> {
  const moduleId = "@fusion-plugin-examples/dependency-graph/dashboard-view";
  const exportName = "DependencyGraphDashboardView";
  const mod = await import("@fusion-plugin-examples/dependency-graph/dashboard-view") as unknown as Record<string, ComponentType<{ context?: PluginDashboardViewContext }>>;
  const component = mod[exportName];
  if (!component) {
    console.warn(`[plugin-views] Missing export ${exportName} from ${moduleId}`);
    return { default: createMissingPluginView(moduleId, exportName) };
  }
  return { default: component as PluginViewComponent };
}

async function loadRoadmapView(): Promise<{ default: PluginViewComponent }> {
  const moduleId = "@fusion-plugin-examples/roadmap/dashboard-view";
  const exportName = "RoadmapDashboardView";
  const mod = await import("@fusion-plugin-examples/roadmap/dashboard-view") as unknown as Record<string, ComponentType<{ context?: PluginDashboardViewContext }>>;
  const component = mod[exportName];
  if (!component) {
    console.warn(`[plugin-views] Missing export ${exportName} from ${moduleId}`);
    return { default: createMissingPluginView(moduleId, exportName) };
  }
  return { default: component as PluginViewComponent };
}

async function loadCliPrintingPressWizardView(): Promise<{ default: PluginViewComponent }> {
  const moduleId = "@fusion-plugin-examples/cli-printing-press/dashboard-view";
  const exportName = "CliPrintingPressWizardView";
  try {
    const mod = await import(/* @vite-ignore */ moduleId) as unknown as Record<string, ComponentType<{ context?: PluginDashboardViewContext }>>;
    const component = mod[exportName];
    if (!component) {
      console.warn(`[plugin-views] Missing export ${exportName} from ${moduleId}`);
      return { default: createMissingPluginView(moduleId, exportName) };
    }
    return { default: component as PluginViewComponent };
  } catch {
    return { default: createMissingPluginView(moduleId, exportName) };
  }
}

async function loadCliPrintingPressManageView(): Promise<{ default: PluginViewComponent }> {
  const moduleId = "@fusion-plugin-examples/cli-printing-press/manage-view";
  const exportName = "CliPrintingPressManageView";
  try {
    const mod = await import(/* @vite-ignore */ moduleId) as unknown as Record<string, ComponentType<{ context?: PluginDashboardViewContext }>>;
    const component = mod[exportName];
    if (!component) {
      console.warn(`[plugin-views] Missing export ${exportName} from ${moduleId}`);
      return { default: createMissingPluginView(moduleId, exportName) };
    }
    return { default: component as PluginViewComponent };
  } catch {
    return { default: createMissingPluginView(moduleId, exportName) };
  }
}

export function registerBundledPluginViews(): void {
  if (registered) return;
  registered = true;

  registerPluginView(
    "fusion-plugin-dependency-graph",
    "graph",
    lazy(loadDependencyGraphView),
  );

  registerPluginView(
    "roadmap-planner",
    "roadmaps",
    lazy(loadRoadmapView),
  );

  registerPluginView(
    "fusion-plugin-cli-printing-press",
    "wizard",
    lazy(loadCliPrintingPressWizardView),
  );

  registerPluginView(
    "fusion-plugin-cli-printing-press",
    "manage",
    lazy(loadCliPrintingPressManageView),
  );
}

export function __test_resetBundledPluginViewRegistration(): void {
  registered = false;
}
