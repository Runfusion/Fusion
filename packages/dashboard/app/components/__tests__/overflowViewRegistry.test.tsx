import { describe, expect, it } from "vitest";
import { getVisibleOverflowViewEntries, STATIC_OVERFLOW_VIEW_ENTRIES } from "../overflowViewRegistry";
import type { PluginDashboardViewEntry } from "../../api";

describe("overflowViewRegistry", () => {
  it("exposes static right-dock tools in order", () => {
    const entries = getVisibleOverflowViewEntries({ experimentalFeatures: { devServerView: true } });
    const keys = entries.map((entry) => entry.key);

    expect(keys).toEqual([
      "tasks", "files", "chat", "activity-log", "git-manager", "devserver", "secrets", "pull-requests",
    ]);
    expect(entries.filter((entry) => entry.render).map((entry) => entry.key)).toEqual(keys);
    expect(entries.filter((entry) => entry.onActivate)).toEqual([]);
  });

  it("hides flag-gated static dock tools", () => {
    const keys = getVisibleOverflowViewEntries().map((entry) => entry.key);
    expect(keys).toEqual(["tasks", "files", "chat", "activity-log", "git-manager", "secrets", "pull-requests"]);
    expect(keys).not.toContain("devserver");
    expect(keys).not.toContain("todos");
    expect(keys).not.toContain("usage");
  });

  it("does not expose left-sidebar content views or removed dock tools in the registry", () => {
    const removedKeys = ["documents", "research", "insights", "skills", "memory", "stash-recovery", "evals", "goalsView", "github-import", "automation", "usage", "todos"];
    const keys = getVisibleOverflowViewEntries({
      experimentalFeatures: { insights: true, memoryView: true, devServerView: true, researchView: true, evalsView: true, goalsView: true },
      showSkillsTab: true,
    }).map((entry) => entry.key);

    expect(keys).toEqual(STATIC_OVERFLOW_VIEW_ENTRIES.map((entry) => entry.key));
    for (const key of removedKeys) expect(keys).not.toContain(key);
    for (const key of ["secrets", "pull-requests", "devserver"]) expect(keys).toContain(key);
  });

  it("adds enabled non-primary plugin views after static tool entries", () => {
    const pluginDashboardViews: PluginDashboardViewEntry[] = [
      { pluginId: "fusion-plugin-todos", view: { viewId: "todos", label: "Todos", placement: "overflow", order: 70 } },
      { pluginId: "plugin-a", view: { viewId: "primary", label: "Primary", placement: "primary" } },
      { pluginId: "plugin-a", view: { viewId: "tools", label: "Tools", placement: "overflow", order: 2 } },
      { pluginId: "plugin-b", view: { viewId: "audit", label: "Audit", placement: "secondary", order: 1 } },
    ];

    const entries = getVisibleOverflowViewEntries({ experimentalFeatures: { devServerView: true }, pluginDashboardViews });
    expect(entries.map((entry) => entry.key)).toEqual([
      "tasks", "files", "chat", "activity-log", "git-manager", "devserver", "secrets", "pull-requests",
      "plugin:plugin-b:audit", "plugin:plugin-a:tools", "plugin:fusion-plugin-todos:todos",
    ]);
    expect(entries.some((entry) => entry.key === "plugin:plugin-a:primary")).toBe(false);
  });

  it("excludes the dependency-graph plugin from the right dock", () => {
    const pluginDashboardViews: PluginDashboardViewEntry[] = [
      { pluginId: "fusion-plugin-dependency-graph", view: { viewId: "graph", label: "Dependency Graph", placement: "overflow", order: 1 } },
      { pluginId: "plugin-c", view: { viewId: "report", label: "Report", placement: "overflow", order: 2 } },
    ];

    const keys = getVisibleOverflowViewEntries({ pluginDashboardViews }).map((entry) => entry.key);
    expect(keys).not.toContain("plugin:fusion-plugin-dependency-graph:graph");
    expect(keys).toContain("plugin:plugin-c:report");
  });
});
