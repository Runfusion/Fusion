import { describe, expect, it } from "vitest";
import { getVisibleOverflowViewEntries, STATIC_OVERFLOW_VIEW_ENTRIES } from "../overflowViewRegistry";
import type { PluginDashboardViewEntry } from "../../api";

describe("overflowViewRegistry", () => {
  it("exposes the static right-dock tool destinations in order", () => {
    // devserver/todos are gated by their isVisible flags; enable them to see the full static set.
    const entries = getVisibleOverflowViewEntries({
      experimentalFeatures: { devServerView: true },
      todosEnabled: true,
    });
    const keys = entries.map((entry) => entry.key);

    expect(keys).toEqual([
      "files",
      "chat",
      "activity-log",
      "git-manager",
      "devserver",
      "secrets",
      "todos",
      "pull-requests",
    ]);
    expect(entries.map((entry) => entry.label)).toEqual([
      "Files",
      "Chat",
      "Activity Log",
      "Git Manager",
      "Dev Server",
      "Secrets",
      "Todos",
      "Pull Requests",
    ]);
    // Every static dock destination renders inline; none use onActivate launcher actions anymore.
    expect(entries.filter((entry) => entry.render).map((entry) => entry.key)).toEqual(keys);
    expect(entries.filter((entry) => entry.onActivate)).toEqual([]);
  });

  it("hides flag-gated dock tools when their flags are off", () => {
    const keys = getVisibleOverflowViewEntries().map((entry) => entry.key);

    // devserver requires experimentalFeatures.devServerView; todos requires todosEnabled.
    expect(keys).toEqual(["files", "chat", "activity-log", "git-manager", "secrets", "pull-requests"]);
    expect(keys).not.toContain("devserver");
    expect(keys).not.toContain("todos");
    // Usage moved back to the top header; it is no longer a right-dock key.
    expect(keys).not.toContain("usage");
  });

  it("does not expose left-sidebar content views or removed dock tools in the registry", () => {
    // github-import and automation were moved off the dock into left-sidebar / main views.
    const removedKeys = [
      "documents",
      "research",
      "insights",
      "skills",
      "memory",
      "stash-recovery",
      "evals",
      "goalsView",
      "github-import",
      "automation",
      // Usage moved back to the top header; it is no longer exposed as a dock key.
      "usage",
    ];
    const keys = getVisibleOverflowViewEntries({
      experimentalFeatures: {
        insights: true,
        memoryView: true,
        devServerView: true,
        researchView: true,
        evalsView: true,
        goalsView: true,
      },
      showSkillsTab: true,
      todosEnabled: true,
    }).map((entry) => entry.key);

    expect(keys).toEqual(STATIC_OVERFLOW_VIEW_ENTRIES.map((entry) => entry.key));
    for (const removedKey of removedKeys) {
      expect(keys).not.toContain(removedKey);
    }
    // secrets, todos, pull-requests, devserver are now PRESENT dock tools.
    for (const presentKey of ["secrets", "todos", "pull-requests", "devserver"]) {
      expect(keys).toContain(presentKey);
    }
  });

  it("adds only non-primary plugin views after static tool entries", () => {
    const pluginDashboardViews: PluginDashboardViewEntry[] = [
      {
        pluginId: "plugin-a",
        view: { viewId: "primary", label: "Primary", placement: "primary" },
      },
      {
        pluginId: "plugin-a",
        view: { viewId: "tools", label: "Tools", placement: "overflow", order: 2 },
      },
      {
        pluginId: "plugin-b",
        view: { viewId: "audit", label: "Audit", placement: "secondary", order: 1 },
      },
    ];

    const entries = getVisibleOverflowViewEntries({
      experimentalFeatures: { devServerView: true },
      todosEnabled: true,
      pluginDashboardViews,
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      "files",
      "chat",
      "activity-log",
      "git-manager",
      "devserver",
      "secrets",
      "todos",
      "pull-requests",
      "plugin:plugin-b:audit",
      "plugin:plugin-a:tools",
    ]);
    expect(entries.some((entry) => entry.key === "plugin:plugin-a:primary")).toBe(false);
  });

  it("excludes the dependency-graph plugin from the right dock", () => {
    const pluginDashboardViews: PluginDashboardViewEntry[] = [
      {
        pluginId: "fusion-plugin-dependency-graph",
        view: { viewId: "graph", label: "Dependency Graph", placement: "overflow", order: 1 },
      },
      {
        pluginId: "plugin-c",
        view: { viewId: "report", label: "Report", placement: "overflow", order: 2 },
      },
    ];

    const keys = getVisibleOverflowViewEntries({ pluginDashboardViews }).map((entry) => entry.key);

    expect(keys).not.toContain("plugin:fusion-plugin-dependency-graph:graph");
    expect(keys).toContain("plugin:plugin-c:report");
  });
});
