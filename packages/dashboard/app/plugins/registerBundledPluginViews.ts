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

async function loadCompoundEngineeringView(): Promise<{ default: PluginViewComponent }> {
  const moduleId = "@fusion-plugin-examples/compound-engineering/dashboard-view";
  const exportName = "CompoundEngineeringDashboardView";
  const mod = await import("@fusion-plugin-examples/compound-engineering/dashboard-view") as unknown as Record<string, ComponentType<{ context?: PluginDashboardViewContext }>>;
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

async function loadLinearImportView(): Promise<{ default: PluginViewComponent }> {
  const moduleId = "@fusion-plugin-examples/linear-import/dashboard-view";
  const exportName = "LinearImportDashboardView";
  const mod = await import("@fusion-plugin-examples/linear-import/dashboard-view") as unknown as Record<string, ComponentType<{ context?: PluginDashboardViewContext }>>;
  const component = mod[exportName];
  if (!component) {
    console.warn(`[plugin-views] Missing export ${exportName} from ${moduleId}`);
    return { default: createMissingPluginView(moduleId, exportName) };
  }
  return { default: component as PluginViewComponent };
}

/*
FNXC:Quality 2026-07-14-21:50:
Static host registry for Quality hub. Literal import() so Vite can code-split;
do not use @vite-ignore (reports footgun).
*/
/*
FNXC:RoadmapsNavigation 2026-07-19-12:00:
Register the manifest-advertised roadmaps destination with a literal bundled import so
roadmap-item open targets resolve to RoadmapsView instead of the unavailable fallback.
*/
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

async function loadQualityView(): Promise<{ default: PluginViewComponent }> {
  const moduleId = "@fusion-plugin-examples/quality/dashboard-view";
  const exportName = "QualityDashboardView";
  const mod = await import("@fusion-plugin-examples/quality/dashboard-view") as unknown as Record<string, ComponentType<{ context?: PluginDashboardViewContext }>>;
  const component = mod[exportName];
  if (!component) {
    console.warn(`[plugin-views] Missing export ${exportName} from ${moduleId}`);
    return { default: createMissingPluginView(moduleId, exportName) };
  }
  return { default: component as PluginViewComponent };
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
    "fusion-plugin-compound-engineering",
    "compound-engineering",
    lazy(loadCompoundEngineeringView),
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

  registerPluginView(
    "fusion-plugin-linear-import",
    "linear-import",
    lazy(loadLinearImportView),
  );

  registerPluginView(
    "fusion-plugin-quality",
    "quality",
    lazy(loadQualityView),
  );

  registerPluginView(
    "fusion-plugin-roadmap",
    "roadmaps",
    lazy(loadRoadmapView),
  );
}

export function __test_resetBundledPluginViewRegistration(): void {
  registered = false;
}
