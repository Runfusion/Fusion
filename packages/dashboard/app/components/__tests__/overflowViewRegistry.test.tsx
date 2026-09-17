import { describe, expect, it } from "vitest";
import { getVisibleOverflowViewEntries, OPTIONAL_RIGHT_DOCK_TOOL_KEYS, STATIC_OVERFLOW_VIEW_ENTRIES } from "../overflowViewRegistry";
import type { PluginDashboardViewEntry } from "../../api";

/*
 * FN-426: the right dock is optional and default-off, so it may no longer be the OWNER of anything. This registry is
 * now a shortcut list of exactly four tools that each keep a canonical host elsewhere (Files and Chat pages, the List
 * route, the Notes popover). Every tool that used to live only here — Git Manager, Activity Log, Secrets, Pull
 * Requests, Dev Server, and plugin dashboard views — moved to a destination of its own and must be absent.
 */
describe("overflowViewRegistry", () => {
  it("exposes exactly the four optional dock shortcuts in order", () => {
    const entries = getVisibleOverflowViewEntries({ experimentalFeatures: { devServerView: true }, listViewAvailable: true });
    expect(entries.map((entry) => entry.key)).toEqual(["files", "chat", "list", "notes"]);
    expect(entries.map((entry) => entry.key)).toEqual([...OPTIONAL_RIGHT_DOCK_TOOL_KEYS]);
    expect(entries.filter((entry) => entry.render).map((entry) => entry.key)).toEqual(entries.map((entry) => entry.key));
    expect(entries.filter((entry) => entry.onActivate)).toEqual([]);
  });

  it("offers Notes on tablet hosts too, since the dock is now an explicit opt-in", () => {
    expect(getVisibleOverflowViewEntries({ hostMode: "standard" }).map((entry) => entry.key)).toContain("notes");
    expect(getVisibleOverflowViewEntries({ hostMode: "desktop" }).map((entry) => entry.key)).toContain("notes");
  });

  it("hosts no tool that would become unreachable when the dock is disabled", () => {
    const relocated = ["activity-log", "git-manager", "secrets", "pull-requests", "devserver", "dev-server", "usage", "tasks", "documents", "recommendations", "research", "insights", "skills", "memory", "stash-recovery", "evals", "goalsView", "github-import", "automation", "todos"];
    const keys = getVisibleOverflowViewEntries({
      experimentalFeatures: { insights: true, memoryView: true, devServerView: true, researchView: true, evalsView: true, goalsView: true },
      showSkillsTab: true,
      listViewAvailable: true,
    }).map((entry) => entry.key);

    expect(keys).toEqual(STATIC_OVERFLOW_VIEW_ENTRIES.map((entry) => entry.key));
    for (const key of relocated) expect(keys).not.toContain(key);
  });

  /*
   * FN-382 (retained): List is a dock tool only where the host supplies the real List surface — the non-mobile dock.
   * A phone host, or any caller that does not provide the renderer, must not get a tab that could render an empty body.
   */
  it("exposes the List tool only when its host supplies the surface, and never expandable", () => {
    const withoutList = getVisibleOverflowViewEntries({}).map((entry) => entry.key);
    expect(withoutList).not.toContain("list");

    const entries = getVisibleOverflowViewEntries({ listViewAvailable: true });
    const list = entries.find((entry) => entry.key === "list");
    expect(list).toBeDefined();
    expect(list!.testId).toBe("right-dock-tab-list");
    expect(list!.isExpandable?.({})).toBe(false);

    // Without a renderer the entry yields nothing rather than an empty panel.
    expect(list!.render?.({ addToast: () => {}, key: "list" } as never)).toBeNull();
  });

  /*
   * FN-426: plugin dashboard views keep their primary-navigation destinations and are no longer duplicated into the
   * optional dock, where they would have had no owner at all once an operator turns it off.
   */
  it("adds no plugin dashboard views to the optional dock", () => {
    const pluginDashboardViews: PluginDashboardViewEntry[] = [
      { pluginId: "fusion-plugin-todos", view: { viewId: "todos", label: "Todos", placement: "overflow", order: 70 } },
      { pluginId: "plugin-a", view: { viewId: "primary", label: "Primary", placement: "primary" } },
      { pluginId: "plugin-a", view: { viewId: "tools", label: "Tools", placement: "overflow", order: 2 } },
      { pluginId: "fusion-plugin-dependency-graph", view: { viewId: "graph", label: "Dependency Graph", placement: "overflow", order: 1 } },
    ];

    const keys = getVisibleOverflowViewEntries({ experimentalFeatures: { devServerView: true }, listViewAvailable: true, pluginDashboardViews }).map((entry) => entry.key);
    expect(keys).toEqual(["files", "chat", "list", "notes"]);
    expect(keys.some((key) => key.startsWith("plugin:"))).toBe(false);
  });
});
