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

  it("renders registered components", async () => {
    const View = lazy(async () => ({ default: () => <div>Rendered Plugin View</div> }));
    registerPluginView("plugin-a", "main", View);
    render(<>{PluginDashboardViewHost({ viewId: "plugin:plugin-a:main" })}</>);
    expect(await screen.findByText("Rendered Plugin View")).toBeInTheDocument();
  });

  it("renders unavailable fallback for unregistered views", () => {
    render(<>{PluginDashboardViewHost({ viewId: "plugin:plugin-a:missing" })}</>);
    expect(screen.getByTestId("plugin-view-unavailable")).toBeInTheDocument();
  });
});
