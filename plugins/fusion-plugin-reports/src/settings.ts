import type { PluginSettingSchema } from "@fusion/plugin-sdk";

export const DEFAULT_DAILY_ENABLED = true;
export const DEFAULT_DAILY_CRON = "0 8 * * *";
export const DEFAULT_WEEKLY_ENABLED = true;
export const DEFAULT_WEEKLY_CRON = "0 8 * * 1";
export const DEFAULT_TIMEZONE = "UTC";
export const DEFAULT_GENERATION_PROMPT_DAILY = "Summarize today's system activity with clear wins, highlights, lowlights, and proposals.";
export const DEFAULT_GENERATION_PROMPT_WEEKLY = "Summarize this week's system activity trends, major outcomes, and actionable proposals.";
export const DEFAULT_REVIEW_PROMPT = "Review this report for factual accuracy, clarity, and actionability. Provide concrete revision suggestions.";
export const DEFAULT_REVIEW_MIN_APPROVALS = 1;
export const DEFAULT_REVIEW_BLOCKING_MODE = "advisory";
export const DEFAULT_SECTION_ORDER = ["wins", "highlights", "lowlights", "proposals", "deep-dives", "per-agent"];
export const DEFAULT_ENABLED_SECTIONS = [...DEFAULT_SECTION_ORDER];
export const DEFAULT_INCLUDE_SYSTEM_SUMMARY = true;
export const DEFAULT_INCLUDE_PER_AGENT_SECTIONS = true;
export const DEFAULT_BRAND_TITLE = "Fusion Activity Report";
export const DEFAULT_THEME_MODE = "auto";
export const DEFAULT_ACCENT_COLOR = "#5B8DEF";
export const DEFAULT_APPROVAL_REQUIRED = false;
export const DEFAULT_AUTO_PUBLISH_ON_APPROVAL = true;
export const DEFAULT_PUBLISH_TARGETS: string[] = [];

export const settingsSchema: Record<string, PluginSettingSchema> = {
  dailyEnabled: { type: "boolean", label: "Enable Daily Reports", description: "Generate daily reports on schedule.", group: "Schedules", defaultValue: DEFAULT_DAILY_ENABLED },
  dailyCron: { type: "string", label: "Daily Schedule (cron)", description: "Cron expression for daily report generation.", group: "Schedules", required: true, defaultValue: DEFAULT_DAILY_CRON },
  weeklyEnabled: { type: "boolean", label: "Enable Weekly Reports", description: "Generate weekly reports on schedule.", group: "Schedules", defaultValue: DEFAULT_WEEKLY_ENABLED },
  weeklyCron: { type: "string", label: "Weekly Schedule (cron)", description: "Cron expression for weekly report generation.", group: "Schedules", required: true, defaultValue: DEFAULT_WEEKLY_CRON },
  timezone: { type: "string", label: "Timezone", description: "IANA timezone used for schedule evaluation.", group: "Schedules", required: true, defaultValue: DEFAULT_TIMEZONE },

  generationPromptDaily: { type: "string", multiline: true, label: "Daily Generation Prompt", description: "Prompt template used to generate daily reports.", group: "Prompts", required: true, defaultValue: DEFAULT_GENERATION_PROMPT_DAILY },
  generationPromptWeekly: { type: "string", multiline: true, label: "Weekly Generation Prompt", description: "Prompt template used to generate weekly reports.", group: "Prompts", required: true, defaultValue: DEFAULT_GENERATION_PROMPT_WEEKLY },
  reviewPrompt: { type: "string", multiline: true, label: "Review Prompt", description: "Prompt template used by reviewer agents.", group: "Prompts", required: true, defaultValue: DEFAULT_REVIEW_PROMPT },

  reviewPanelAgentIds: { type: "array", itemType: "string", label: "Reviewer Agent IDs", description: "Agent IDs allowed to review generated reports.", group: "Review Panel", defaultValue: [] },
  reviewMinApprovals: { type: "number", label: "Minimum Approvals", description: "How many approvals are required from the review panel.", group: "Review Panel", defaultValue: DEFAULT_REVIEW_MIN_APPROVALS },
  reviewBlockingMode: { type: "enum", enumValues: ["block", "advisory"], label: "Review Blocking Mode", description: "Choose whether failed review blocks publication.", group: "Review Panel", defaultValue: DEFAULT_REVIEW_BLOCKING_MODE },

  sectionOrder: { type: "array", itemType: "string", label: "Section Order", description: "Ordered section IDs for report rendering.", group: "Sections", defaultValue: DEFAULT_SECTION_ORDER },
  enabledSections: { type: "array", itemType: "string", label: "Enabled Sections", description: "Section IDs enabled for output.", group: "Sections", defaultValue: DEFAULT_ENABLED_SECTIONS },
  includeSystemSummary: { type: "boolean", label: "Include System Summary", description: "Include top-level system summary in report output.", group: "Sections", defaultValue: DEFAULT_INCLUDE_SYSTEM_SUMMARY },
  includePerAgentSections: { type: "boolean", label: "Include Per-Agent Sections", description: "Include per-agent detail sections.", group: "Sections", defaultValue: DEFAULT_INCLUDE_PER_AGENT_SECTIONS },

  brandTitle: { type: "string", label: "Report Title", description: "Primary report title for branding.", group: "Branding", required: true, defaultValue: DEFAULT_BRAND_TITLE },
  brandLogoUrl: { type: "string", label: "Logo URL", description: "Optional URL to a brand logo image.", group: "Branding" },
  themeMode: { type: "enum", enumValues: ["light", "dark", "auto"], label: "Theme Mode", description: "Theme style for generated reports.", group: "Branding", defaultValue: DEFAULT_THEME_MODE },
  accentColor: { type: "string", label: "Accent Color", description: "Accent color used in report styling.", group: "Branding", defaultValue: DEFAULT_ACCENT_COLOR },

  approvalRequired: { type: "boolean", label: "Require Approval", description: "Require explicit approval before publishing.", group: "Approval Flow", defaultValue: DEFAULT_APPROVAL_REQUIRED },
  autoPublishOnApproval: { type: "boolean", label: "Auto Publish on Approval", description: "Publish automatically after approval threshold is met.", group: "Approval Flow", defaultValue: DEFAULT_AUTO_PUBLISH_ON_APPROVAL },
  approverAgentIds: { type: "array", itemType: "string", label: "Approver Agent IDs", description: "Agent IDs permitted to approve final publish.", group: "Approval Flow", defaultValue: [] },
  publishTargets: { type: "array", itemType: "string", label: "Publish Targets", description: "Destinations to publish reports to (for example dashboard, html-export).", group: "Approval Flow", defaultValue: DEFAULT_PUBLISH_TARGETS },
};

function asString(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(settings: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(settings: Record<string, unknown>, key: string, fallback: number): number {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(settings: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = settings[key];
  if (!Array.isArray(value)) return [...fallback];
  const normalized = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : [...fallback];
}

export function getDailyEnabled(settings: Record<string, unknown>): boolean { return asBoolean(settings, "dailyEnabled", DEFAULT_DAILY_ENABLED); }
export function getDailyCron(settings: Record<string, unknown>): string { return asString(settings, "dailyCron") ?? DEFAULT_DAILY_CRON; }
export function getWeeklyEnabled(settings: Record<string, unknown>): boolean { return asBoolean(settings, "weeklyEnabled", DEFAULT_WEEKLY_ENABLED); }
export function getWeeklyCron(settings: Record<string, unknown>): string { return asString(settings, "weeklyCron") ?? DEFAULT_WEEKLY_CRON; }
export function getTimezone(settings: Record<string, unknown>): string { return asString(settings, "timezone") ?? DEFAULT_TIMEZONE; }
export function getGenerationPromptDaily(settings: Record<string, unknown>): string { return asString(settings, "generationPromptDaily") ?? DEFAULT_GENERATION_PROMPT_DAILY; }
export function getGenerationPromptWeekly(settings: Record<string, unknown>): string { return asString(settings, "generationPromptWeekly") ?? DEFAULT_GENERATION_PROMPT_WEEKLY; }
export function getReviewPrompt(settings: Record<string, unknown>): string { return asString(settings, "reviewPrompt") ?? DEFAULT_REVIEW_PROMPT; }
export function getReviewPanelAgentIds(settings: Record<string, unknown>): string[] { return asStringArray(settings, "reviewPanelAgentIds", []); }
export function getReviewMinApprovals(settings: Record<string, unknown>): number { return Math.max(1, Math.floor(asNumber(settings, "reviewMinApprovals", DEFAULT_REVIEW_MIN_APPROVALS))); }
export function getReviewBlockingMode(settings: Record<string, unknown>): "block" | "advisory" {
  const value = asString(settings, "reviewBlockingMode");
  return value === "block" ? "block" : "advisory";
}
export function getSectionOrder(settings: Record<string, unknown>): string[] { return asStringArray(settings, "sectionOrder", DEFAULT_SECTION_ORDER); }
export function getEnabledSections(settings: Record<string, unknown>): string[] { return asStringArray(settings, "enabledSections", DEFAULT_ENABLED_SECTIONS); }
export function getIncludeSystemSummary(settings: Record<string, unknown>): boolean { return asBoolean(settings, "includeSystemSummary", DEFAULT_INCLUDE_SYSTEM_SUMMARY); }
export function getIncludePerAgentSections(settings: Record<string, unknown>): boolean { return asBoolean(settings, "includePerAgentSections", DEFAULT_INCLUDE_PER_AGENT_SECTIONS); }
export function getBrandTitle(settings: Record<string, unknown>): string { return asString(settings, "brandTitle") ?? DEFAULT_BRAND_TITLE; }
export function getBrandLogoUrl(settings: Record<string, unknown>): string | undefined { return asString(settings, "brandLogoUrl"); }
export function getThemeMode(settings: Record<string, unknown>): "light" | "dark" | "auto" {
  const value = asString(settings, "themeMode");
  return value === "light" || value === "dark" ? value : "auto";
}
export function getAccentColor(settings: Record<string, unknown>): string { return asString(settings, "accentColor") ?? DEFAULT_ACCENT_COLOR; }
export function getApprovalRequired(settings: Record<string, unknown>): boolean { return asBoolean(settings, "approvalRequired", DEFAULT_APPROVAL_REQUIRED); }
export function getAutoPublishOnApproval(settings: Record<string, unknown>): boolean { return asBoolean(settings, "autoPublishOnApproval", DEFAULT_AUTO_PUBLISH_ON_APPROVAL); }
export function getApproverAgentIds(settings: Record<string, unknown>): string[] { return asStringArray(settings, "approverAgentIds", []); }
export function getPublishTargets(settings: Record<string, unknown>): string[] { return asStringArray(settings, "publishTargets", DEFAULT_PUBLISH_TARGETS); }
