import { describe, expect, it, beforeEach, vi } from "vitest";
import { createElement } from "react";
import { getPluginViewComponent, isPluginViewRegistered, __test_clearPluginViewRegistry } from "../pluginViewRegistry";
import {
  __test_resetBundledPluginViewRegistration,
  registerBundledPluginViews,
} from "../registerBundledPluginViews";

const MockDependencyGraphDashboardView = () => createElement("div", { "data-testid": "dep-graph-view" });
const MockRoadmapDashboardView = () => createElement("div", { "data-testid": "roadmap-view" });
const MockCliPrintingPressWizardView = () => createElement("div", { "data-testid": "cli-printing-press-view" });
const MockCliPrintingPressManageView = () => createElement("div", { "data-testid": "cli-printing-press-manage-view" });

vi.mock("@fusion-plugin-examples/dependency-graph/dashboard-view", () => ({
  DependencyGraphDashboardView: (...args: unknown[]) => MockDependencyGraphDashboardView(...args),
}));

vi.mock("@fusion-plugin-examples/fusion-plugin-roadmap/dashboard-view", () => ({
  RoadmapDashboardView: (...args: unknown[]) => MockRoadmapDashboardView(...args),
}));

vi.mock("@fusion-plugin-examples/cli-printing-press/dashboard-view", () => ({
  CliPrintingPressWizardView: (...args: unknown[]) => MockCliPrintingPressWizardView(...args),
}));

vi.mock("@fusion-plugin-examples/cli-printing-press/manage-view", () => ({
  CliPrintingPressManageView: (...args: unknown[]) => MockCliPrintingPressManageView(...args),
}));

// The dashboard statically registers bundled views client-side, so these views can
// render even when engine-side PluginLoader startup failed and the persisted
// installation row is in an error state.
describe("registerBundledPluginViews", () => {
  beforeEach(() => {
    __test_clearPluginViewRegistry();
    __test_resetBundledPluginViewRegistration();
  });

  it("registers dependency graph, roadmap, and cli printing press bundled views", () => {
    registerBundledPluginViews();

    // This registration is independent of engine-side plugin load success; the
    // dashboard can still render the Graph view while the plugin install row is errored.
    expect(isPluginViewRegistered("fusion-plugin-dependency-graph", "graph")).toBe(true);
    expect(getPluginViewComponent("fusion-plugin-dependency-graph", "graph")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-roadmap", "roadmaps")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-cli-printing-press", "wizard")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-cli-printing-press", "manage")).toBeTruthy();
  });

  it("is idempotent when called more than once", () => {
    registerBundledPluginViews();
    const firstGraph = getPluginViewComponent("fusion-plugin-dependency-graph", "graph");

    expect(() => registerBundledPluginViews()).not.toThrow();
    expect(getPluginViewComponent("fusion-plugin-dependency-graph", "graph")).toBe(firstGraph);
  });

  // FN-3916 regression: verifies the registry reports the graph view as registered
  // so App.tsx can fall back to bundled static registration when API has no views.
  it("reports dependency graph as registered via isPluginViewRegistered", () => {
    registerBundledPluginViews();

    expect(isPluginViewRegistered("fusion-plugin-dependency-graph", "graph")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-roadmap", "roadmaps")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-cli-printing-press", "wizard")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-cli-printing-press", "manage")).toBe(true);
    // Unknown plugin/view should not be registered
    expect(isPluginViewRegistered("unknown-plugin", "unknown")).toBe(false);
  });
});
