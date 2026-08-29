import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { definePlugin } from "@fusion/plugin-sdk";
import { validatePluginManifest } from "@fusion/core";
import plugin from "../index";
import { DependencyGraphDashboardView } from "../dashboard-view";
import { getPluginViewId } from "../../../../packages/dashboard/app/plugins/pluginViewRegistry";

vi.mock("@fusion/dashboard/app/components/TaskCard", () => ({
  TaskCard: ({ task, onOpenDetail }: { task: { id: string }; onOpenDetail: (task: { id: string }) => void }) =>
    createElement("button", { "data-testid": `task-${task.id}`, onClick: () => onOpenDetail(task) }, task.id),
}));

afterEach(() => {
  cleanup();
});

describe("dependency graph plugin host integration contract", () => {
  it("declares dashboard view manifest shape", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-dependency-graph");
    expect(plugin.dashboardViews).toEqual([
      expect.objectContaining({
        viewId: "graph",
        label: "Graph",
        componentPath: "./dashboard-view",
        placement: "more",
      }),
    ]);
  });

  it("is valid for definePlugin + manifest validation", () => {
    const defined = definePlugin(plugin);
    const validation = validatePluginManifest(defined.manifest);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("produces loader-compatible pluginId/view entries", () => {
    const entries = (plugin.dashboardViews ?? []).map((view) => ({ pluginId: plugin.manifest.id, view }));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        pluginId: "fusion-plugin-dependency-graph",
        view: expect.objectContaining({ viewId: "graph" }),
      }),
    );
  });

  it("matches host registry lookup key format plugin:{pluginId}:{viewId}", () => {
    const view = plugin.dashboardViews?.[0];
    if (!view) throw new Error("missing dashboard view");

    expect(getPluginViewId(plugin.manifest.id, view.viewId)).toBe("plugin:fusion-plugin-dependency-graph:graph");
  });

  it("uses host openTaskDetail context when rendered through dashboard view entrypoint", () => {
    const openTaskDetail = vi.fn();
    render(
      createElement(DependencyGraphDashboardView, {
        context: {
          tasks: [{ id: "FN-HOST", description: "FN-HOST", column: "todo", dependencies: [], steps: [], currentStep: 0, log: [] }],
          openTaskDetail,
        } as never,
      }),
    );

    fireEvent.doubleClick(screen.getByTestId("graph-task-node-FN-HOST"));
    expect(openTaskDetail).toHaveBeenCalledTimes(1);
    expect(openTaskDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-HOST" }));
  });
});
