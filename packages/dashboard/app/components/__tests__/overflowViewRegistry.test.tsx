import { describe, expect, it } from "vitest";
import { getVisibleOverflowViewEntries, STATIC_OVERFLOW_VIEW_ENTRIES } from "../overflowViewRegistry";
import type { PluginDashboardViewEntry } from "../../api";

describe("overflowViewRegistry", () => {
  it("keeps Files as the default first entry and Documents visible without a viewport gate", () => {
    const entries = getVisibleOverflowViewEntries();
    expect(entries[0]?.key).toBe("files");
    expect(entries.some((entry) => entry.key === "documents")).toBe(true);
  });

  it("matches Header feature gates for flag-controlled overflow destinations", () => {
    const disabled = getVisibleOverflowViewEntries({
      experimentalFeatures: {
        insights: false,
        memoryView: false,
        devServerView: false,
        researchView: false,
        evalsView: false,
        goalsView: false,
      },
      showSkillsTab: false,
      todosEnabled: false,
    }).map((entry) => entry.key);

    expect(disabled).toEqual(["files", "documents", "secrets", "stash-recovery"]);

    const enabled = getVisibleOverflowViewEntries({
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

    expect(enabled).toEqual(STATIC_OVERFLOW_VIEW_ENTRIES.map((entry) => entry.key));
  });

  it("adds only non-primary plugin views after static entries", () => {
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

    const entries = getVisibleOverflowViewEntries({ pluginDashboardViews });
    expect(entries.slice(-2).map((entry) => entry.key)).toEqual([
      "plugin:plugin-b:audit",
      "plugin:plugin-a:tools",
    ]);
    expect(entries.some((entry) => entry.key === "plugin:plugin-a:primary")).toBe(false);
  });
});
