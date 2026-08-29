import { describe, expect, it } from "vitest";
import manifest from "../../manifest.json";
import plugin from "../index.js";

const expectedKeys = [
  "dailyEnabled",
  "dailyCron",
  "weeklyEnabled",
  "weeklyCron",
  "timezone",
  "generationPromptDaily",
  "generationPromptWeekly",
  "reviewPrompt",
  "reviewPanelAgentIds",
  "reviewMinApprovals",
  "reviewBlockingMode",
  "sectionOrder",
  "enabledSections",
  "includeSystemSummary",
  "includePerAgentSections",
  "brandTitle",
  "brandLogoUrl",
  "themeMode",
  "accentColor",
  "approvalRequired",
  "autoPublishOnApproval",
  "approverAgentIds",
  "publishTargets",
] as const;

describe("reports plugin manifest", () => {
  it("exports expected plugin id", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-reports");
  });

  it("keeps runtime manifest metadata aligned with manifest.json", () => {
    expect(plugin.manifest.id).toBe(manifest.id);
    expect(plugin.manifest.name).toBe(manifest.name);
    expect(plugin.manifest.version).toBe(manifest.version);
    expect(plugin.manifest.description).toBe(manifest.description);
    expect(plugin.manifest.author).toBe(manifest.author);
    expect(plugin.manifest.fusionVersion).toBe(manifest.fusionVersion);
  });

  it("registers dashboard view", () => {
    expect(plugin.dashboardViews).toEqual([
      {
        viewId: "reports",
        label: "Reports",
        componentPath: "./dashboard-view",
        icon: "FileText",
        placement: "primary",
        order: 35,
      },
    ]);
    expect(manifest.dashboardViews).toEqual(plugin.dashboardViews);
  });

  it("includes full settings schema", () => {
    expect(plugin.manifest.settingsSchema).toBeDefined();
    for (const key of expectedKeys) {
      expect(plugin.manifest.settingsSchema).toHaveProperty(key);
    }
  });
});
