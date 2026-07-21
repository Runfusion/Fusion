import { describe, expect, it, beforeEach, vi } from "vitest";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { PluginDashboardViewHost, getPluginViewComponent, isPluginViewRegistered, __test_clearPluginViewRegistry } from "../pluginViewRegistry";
import {
  __test_resetBundledPluginViewRegistration,
  registerBundledPluginViews,
} from "../registerBundledPluginViews";

const MockDependencyGraphDashboardView = () => createElement("div", { "data-testid": "dep-graph-view" });
const MockCompoundEngineeringDashboardView = () => createElement("div", { "data-testid": "ce-view" });
const MockCliPrintingPressWizardView = () => createElement("div", { "data-testid": "cli-printing-press-view" });
const MockCliPrintingPressManageView = () => createElement("div", { "data-testid": "cli-printing-press-manage-view" });
const MockLinearImportView = () => createElement("div", { "data-testid": "linear-import-view" });
const MockRoadmapDashboardView = () => createElement("div", { "data-testid": "roadmaps-view" });

vi.mock("@fusion-plugin-examples/dependency-graph/dashboard-view", () => ({
  DependencyGraphDashboardView: (...args: unknown[]) => MockDependencyGraphDashboardView(...args),
}));

vi.mock("@fusion-plugin-examples/compound-engineering/dashboard-view", () => ({
  CompoundEngineeringDashboardView: (...args: unknown[]) => MockCompoundEngineeringDashboardView(...args),
}));

vi.mock("@fusion-plugin-examples/cli-printing-press/dashboard-view", () => ({
  CliPrintingPressWizardView: (...args: unknown[]) => MockCliPrintingPressWizardView(...args),
}));

vi.mock("@fusion-plugin-examples/cli-printing-press/manage-view", () => ({
  CliPrintingPressManageView: (...args: unknown[]) => MockCliPrintingPressManageView(...args),
}));

vi.mock("@fusion-plugin-examples/linear-import/dashboard-view", () => ({
  LinearImportDashboardView: (...args: unknown[]) => MockLinearImportView(...args),
}));

vi.mock("@fusion-plugin-examples/roadmap/dashboard-view", () => ({
  RoadmapDashboardView: (...args: unknown[]) => MockRoadmapDashboardView(...args),
}));

// The dashboard statically registers bundled views client-side, so these views can
// render even when engine-side PluginLoader startup failed and the persisted
// installation row is in an error state.
describe("registerBundledPluginViews", () => {
  beforeEach(() => {
    __test_clearPluginViewRegistry();
    __test_resetBundledPluginViewRegistration();
  });

  it("registers dependency graph, compound engineering, cli printing press, Linear, and roadmaps bundled views", () => {
    registerBundledPluginViews();

    // This registration is independent of engine-side plugin load success; the
    // dashboard can still render the Graph view while the plugin install row is errored.
    expect(isPluginViewRegistered("fusion-plugin-dependency-graph", "graph")).toBe(true);
    expect(getPluginViewComponent("fusion-plugin-dependency-graph", "graph")).toBeTruthy();
    expect(isPluginViewRegistered("fusion-plugin-compound-engineering", "compound-engineering")).toBe(true);
    expect(getPluginViewComponent("fusion-plugin-compound-engineering", "compound-engineering")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-roadmap", "roadmaps")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-cli-printing-press", "wizard")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-cli-printing-press", "manage")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-linear-import", "linear-import")).toBeTruthy();
  });

  it("hosts the bundled roadmaps view instead of the unavailable fallback", async () => {
    registerBundledPluginViews();

    render(<>{PluginDashboardViewHost({ viewId: "plugin:fusion-plugin-roadmap:roadmaps" })}</>);

    expect(await screen.findByTestId("roadmaps-view")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-view-unavailable")).toBeNull();
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
    expect(isPluginViewRegistered("fusion-plugin-compound-engineering", "compound-engineering")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-roadmap", "roadmaps")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-cli-printing-press", "wizard")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-cli-printing-press", "manage")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-linear-import", "linear-import")).toBe(true);
    // Unknown plugin/view should not be registered
    expect(isPluginViewRegistered("unknown-plugin", "unknown")).toBe(false);
  });
});
