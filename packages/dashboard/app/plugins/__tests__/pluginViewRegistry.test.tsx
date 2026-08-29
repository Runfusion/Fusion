import { describe, expect, it, beforeEach } from "vitest";
import { lazy } from "react";
import { render, screen } from "@testing-library/react";
import {
  __test_clearPluginViewRegistry,
  getPluginViewComponent,
  getPluginViewId,
  isPluginViewId,
  parsePluginViewId,
  PluginDashboardViewHost,
  registerPluginView,
} from "../pluginViewRegistry";

describe("pluginViewRegistry", () => {
  beforeEach(() => {
    __test_clearPluginViewRegistry();
  });

  it("builds plugin IDs", () => {
    expect(getPluginViewId("plugin-a", "main")).toBe("plugin:plugin-a:main");
    expect(getPluginViewId("fusion-plugin-roadmap", "roadmaps")).toBe("plugin:fusion-plugin-roadmap:roadmaps");
  });

  it("parses and validates plugin IDs", () => {
    expect(parsePluginViewId("plugin:plugin-a:main")).toEqual({ pluginId: "plugin-a", viewId: "main" });
    expect(parsePluginViewId("board")).toBeNull();
    expect(isPluginViewId("plugin:plugin-a:main")).toBe(true);
    expect(isPluginViewId("plugin:only-one-segment")).toBe(false);
  });

  it("registers and resolves view components", () => {
    const View = lazy(async () => ({ default: () => <div>Plugin View</div> }));
    registerPluginView("plugin-a", "main", View);
    expect(getPluginViewComponent("plugin-a", "main")).toBe(View);
    expect(getPluginViewComponent("plugin-b", "missing")).toBeNull();
  });

  it("resolves cli printing press wizard and manage entries", () => {
    const WizardView = lazy(async () => ({ default: () => <div>Wizard</div> }));
    const ManageView = lazy(async () => ({ default: () => <div>Manage</div> }));
    registerPluginView("fusion-plugin-cli-printing-press", "wizard", WizardView);
    registerPluginView("fusion-plugin-cli-printing-press", "manage", ManageView);
    expect(getPluginViewComponent("fusion-plugin-cli-printing-press", "wizard")).toBe(WizardView);
    expect(getPluginViewComponent("fusion-plugin-cli-printing-press", "manage")).toBe(ManageView);
  });

  it("keeps all registered plugin views discoverable by key iteration", () => {
    const ViewA = lazy(async () => ({ default: () => <div>A</div> }));
    const ViewB = lazy(async () => ({ default: () => <div>B</div> }));
    registerPluginView("plugin-a", "main", ViewA);
    registerPluginView("plugin-b", "graph", ViewB);

    const knownIds = [getPluginViewId("plugin-a", "main"), getPluginViewId("plugin-b", "graph")];
    const resolved = knownIds.map((id) => {
      const parsed = parsePluginViewId(id);
      if (!parsed) return null;
      return getPluginViewComponent(parsed.pluginId, parsed.viewId);
    });

    expect(resolved).toEqual([ViewA, ViewB]);
  });

  it("renders registered components", async () => {
    const View = lazy(async () => ({ default: () => <div>Rendered Plugin View</div> }));
    registerPluginView("plugin-a", "main", View);
    render(<>{PluginDashboardViewHost({ viewId: "plugin:plugin-a:main" })}</>);
    expect(await screen.findByText("Rendered Plugin View")).toBeInTheDocument();
  });

  it("forwards host context to registered components", async () => {
    const View = lazy(async () => ({
      default: ({ context }: { context?: { projectId?: string } }) => <div>{context?.projectId ?? "none"}</div>,
    }));
    registerPluginView("plugin-a", "main", View);

    render(<>{PluginDashboardViewHost({ viewId: "plugin:plugin-a:main", context: { projectId: "proj-1", tasks: [], workflowSteps: [], openTaskDetail: () => {} } })}</>);

    expect(await screen.findByText("proj-1")).toBeInTheDocument();
  });

  it("resolves fusion-plugin-roadmap registry entry and avoids unavailable fallback", async () => {
    const RoadmapsView = lazy(async () => ({ default: () => <div>Roadmaps Plugin View</div> }));
    registerPluginView("fusion-plugin-roadmap", "roadmaps", RoadmapsView);

    render(<>{PluginDashboardViewHost({ viewId: "plugin:fusion-plugin-roadmap:roadmaps" })}</>);

    expect(await screen.findByText("Roadmaps Plugin View")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-view-unavailable")).toBeNull();
  });

  it("renders unavailable fallback for unregistered views", () => {
    render(<>{PluginDashboardViewHost({ viewId: "plugin:plugin-a:missing" })}</>);
    expect(screen.getByTestId("plugin-view-unavailable")).toBeInTheDocument();
  });
});
