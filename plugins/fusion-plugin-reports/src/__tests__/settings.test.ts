import { describe, expect, it } from "vitest";
import type { PluginSettingType } from "@fusion/plugin-sdk";
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_AUTO_PUBLISH_ON_APPROVAL,
  DEFAULT_BRAND_TITLE,
  DEFAULT_DAILY_CRON,
  DEFAULT_DAILY_ENABLED,
  DEFAULT_ENABLED_SECTIONS,
  DEFAULT_GENERATION_PROMPT_DAILY,
  DEFAULT_GENERATION_PROMPT_WEEKLY,
  DEFAULT_INCLUDE_PER_AGENT_SECTIONS,
  DEFAULT_INCLUDE_SYSTEM_SUMMARY,
  DEFAULT_PUBLISH_TARGETS,
  DEFAULT_REVIEW_BLOCKING_MODE,
  DEFAULT_REVIEW_MIN_APPROVALS,
  DEFAULT_REVIEW_PROMPT,
  DEFAULT_SECTION_ORDER,
  DEFAULT_THEME_MODE,
  DEFAULT_TIMEZONE,
  DEFAULT_WEEKLY_CRON,
  DEFAULT_WEEKLY_ENABLED,
  getAccentColor,
  getApprovalRequired,
  getApproverAgentIds,
  getAutoPublishOnApproval,
  getBrandLogoUrl,
  getBrandTitle,
  getDailyCron,
  getDailyEnabled,
  getEnabledSections,
  getGenerationPromptDaily,
  getGenerationPromptWeekly,
  getIncludePerAgentSections,
  getIncludeSystemSummary,
  getPublishTargets,
  getReviewBlockingMode,
  getReviewMinApprovals,
  getReviewPanelAgentIds,
  getReviewPrompt,
  getSectionOrder,
  getThemeMode,
  getTimezone,
  getWeeklyCron,
  getWeeklyEnabled,
  settingsSchema,
} from "../settings.js";

const VALID_TYPES: PluginSettingType[] = ["string", "number", "boolean", "enum", "password", "array"];

describe("reports plugin settings schema", () => {
  it("uses only valid plugin setting types and labels", () => {
    for (const [key, schema] of Object.entries(settingsSchema)) {
      expect(VALID_TYPES).toContain(schema.type);
      expect(typeof schema.label).toBe("string");
      expect(schema.label?.trim().length).toBeGreaterThan(0);

      if (schema.type === "enum") {
        expect(Array.isArray(schema.enumValues)).toBe(true);
        expect(schema.enumValues?.length ?? 0).toBeGreaterThan(0);
      }

      if (schema.type === "array") {
        expect(schema.itemType).toBe("string");
      }

      expect(key.length).toBeGreaterThan(0);
    }
  });

  it("uses documented literal defaults", () => {
    expect(settingsSchema.dailyCron.defaultValue).toBe("0 8 * * *");
    expect(settingsSchema.weeklyCron.defaultValue).toBe("0 8 * * 1");
    expect(settingsSchema.timezone.defaultValue).toBe("UTC");
    expect(settingsSchema.themeMode.defaultValue).toBe("auto");
    expect(settingsSchema.brandTitle.defaultValue).toBe("Fusion Activity Report");
  });

  it("returns defaults for empty settings", () => {
    const empty = {};
    expect(getDailyEnabled(empty)).toBe(DEFAULT_DAILY_ENABLED);
    expect(getDailyCron(empty)).toBe(DEFAULT_DAILY_CRON);
    expect(getWeeklyEnabled(empty)).toBe(DEFAULT_WEEKLY_ENABLED);
    expect(getWeeklyCron(empty)).toBe(DEFAULT_WEEKLY_CRON);
    expect(getTimezone(empty)).toBe(DEFAULT_TIMEZONE);
    expect(getGenerationPromptDaily(empty)).toBe(DEFAULT_GENERATION_PROMPT_DAILY);
    expect(getGenerationPromptWeekly(empty)).toBe(DEFAULT_GENERATION_PROMPT_WEEKLY);
    expect(getReviewPrompt(empty)).toBe(DEFAULT_REVIEW_PROMPT);
    expect(getReviewPanelAgentIds(empty)).toEqual([]);
    expect(getReviewMinApprovals(empty)).toBe(DEFAULT_REVIEW_MIN_APPROVALS);
    expect(getReviewBlockingMode(empty)).toBe(DEFAULT_REVIEW_BLOCKING_MODE);
    expect(getSectionOrder(empty)).toEqual(DEFAULT_SECTION_ORDER);
    expect(getEnabledSections(empty)).toEqual(DEFAULT_ENABLED_SECTIONS);
    expect(getIncludeSystemSummary(empty)).toBe(DEFAULT_INCLUDE_SYSTEM_SUMMARY);
    expect(getIncludePerAgentSections(empty)).toBe(DEFAULT_INCLUDE_PER_AGENT_SECTIONS);
    expect(getBrandTitle(empty)).toBe(DEFAULT_BRAND_TITLE);
    expect(getBrandLogoUrl(empty)).toBeUndefined();
    expect(getThemeMode(empty)).toBe(DEFAULT_THEME_MODE);
    expect(getAccentColor(empty)).toBe(DEFAULT_ACCENT_COLOR);
    expect(getApprovalRequired(empty)).toBe(false);
    expect(getAutoPublishOnApproval(empty)).toBe(DEFAULT_AUTO_PUBLISH_ON_APPROVAL);
    expect(getApproverAgentIds(empty)).toEqual([]);
    expect(getPublishTargets(empty)).toEqual(DEFAULT_PUBLISH_TARGETS);
  });

  it("returns configured values when provided", () => {
    const populated = {
      dailyEnabled: false,
      dailyCron: "5 9 * * *",
      weeklyEnabled: false,
      weeklyCron: "15 7 * * 2",
      timezone: "America/New_York",
      generationPromptDaily: "daily prompt",
      generationPromptWeekly: "weekly prompt",
      reviewPrompt: "review prompt",
      reviewPanelAgentIds: ["agent-a", "agent-b"],
      reviewMinApprovals: 3,
      reviewBlockingMode: "block",
      sectionOrder: ["highlights", "wins"],
      enabledSections: ["wins"],
      includeSystemSummary: false,
      includePerAgentSections: false,
      brandTitle: "Custom Report",
      brandLogoUrl: "https://example.com/logo.png",
      themeMode: "dark",
      accentColor: "#123456",
      approvalRequired: true,
      autoPublishOnApproval: false,
      approverAgentIds: ["approver-a"],
      publishTargets: ["dashboard", "html-export"],
    } satisfies Record<string, unknown>;

    expect(getDailyEnabled(populated)).toBe(false);
    expect(getDailyCron(populated)).toBe("5 9 * * *");
    expect(getWeeklyEnabled(populated)).toBe(false);
    expect(getWeeklyCron(populated)).toBe("15 7 * * 2");
    expect(getTimezone(populated)).toBe("America/New_York");
    expect(getGenerationPromptDaily(populated)).toBe("daily prompt");
    expect(getGenerationPromptWeekly(populated)).toBe("weekly prompt");
    expect(getReviewPrompt(populated)).toBe("review prompt");
    expect(getReviewPanelAgentIds(populated)).toEqual(["agent-a", "agent-b"]);
    expect(getReviewMinApprovals(populated)).toBe(3);
    expect(getReviewBlockingMode(populated)).toBe("block");
    expect(getSectionOrder(populated)).toEqual(["highlights", "wins"]);
    expect(getEnabledSections(populated)).toEqual(["wins"]);
    expect(getIncludeSystemSummary(populated)).toBe(false);
    expect(getIncludePerAgentSections(populated)).toBe(false);
    expect(getBrandTitle(populated)).toBe("Custom Report");
    expect(getBrandLogoUrl(populated)).toBe("https://example.com/logo.png");
    expect(getThemeMode(populated)).toBe("dark");
    expect(getAccentColor(populated)).toBe("#123456");
    expect(getApprovalRequired(populated)).toBe(true);
    expect(getAutoPublishOnApproval(populated)).toBe(false);
    expect(getApproverAgentIds(populated)).toEqual(["approver-a"]);
    expect(getPublishTargets(populated)).toEqual(["dashboard", "html-export"]);
  });
});
