import { describe, expect, it } from "vitest";

import {
  filterSettingsSectionsForSearch,
  normalizeSettingsSearchText,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "../SettingsModal";

const searchTranslations: Record<string, string> = {
  "settings.projectModels.chatHeading": "Chat",
  "settings.projectModels.chatDescription": "Choose the default target for new Direct chats and whether New Chat should prompt or immediately use that default.",
  "settings.projectModels.chatNewSessionMode": "New Chat behavior",
  "settings.projectModels.chatNewSessionModePrompt": "Prompt for model each time",
  "settings.projectModels.chatNewSessionModeAlwaysDefault": "Always use configured default",
  "settings.projectModels.chatDefaultKind": "Chat default target",
  "settings.projectModels.chatDefaultModel": "Chat Default Model",
  "settings.projectModels.chatDefaultAgent": "Chat Default Agent",
  "settings.projectModels.aITitleAndGitCommitMessageSummarization": "AI Title and Git Commit Message Summarization",
  "settings.projectModels.autoSummarizeLongDescriptionsAsTitles": "Auto-summarize long descriptions as titles",
  "settings.projectModels.whenEnabledTasksCreatedWithoutATitleBut": "When enabled, tasks created without a title but with descriptions over 200 characters will automatically get an AI-generated title",
  "settings.projectModels.aIMergeCommitSummaries": "AI merge commit summaries",
  "settings.projectModels.whenEnabledMergeCommitMessagesIncludeAnAI": "When enabled, merge commit messages include an AI-generated subject plus body summary",
};

function searchSettingsSectionIds(query: string): string[] {
  return filterSettingsSectionsForSearch(
    SETTINGS_SECTIONS,
    normalizeSettingsSearchText(query),
    (section: SettingsSection) => section.label,
    (key: string) => searchTranslations[key] ?? key,
  ).map((section) => section.id);
}

describe("SettingsModal Settings search index", () => {
  it.each(["chat", "new chat", "chat model", "chat default agent"])(
    "surfaces Project Models for the chat-default query %s",
    (query) => {
      expect(searchSettingsSectionIds(query)).toContain("project-models");
    },
  );

  /*
  FNXC:SettingsNavigation 2026-07-14-20:15:
  Operators search Settings for title auto-summarization with plain phrases ("summarize", "auto summarize titles") that previously missed Project Models. Assert the search index surfaces that section for those queries.
  */
  it.each([
    "summarize",
    "auto summarize",
    "auto-summarize titles",
    "title summarization",
    "autoSummarizeTitles",
    "AI title",
  ])("surfaces Project Models for the title-summarization query %s", (query) => {
    expect(searchSettingsSectionIds(query)).toContain("project-models");
  });

  it("does not surface Project Models for unrelated Remote Access terms", () => {
    expect(searchSettingsSectionIds("cloudflared")).not.toContain("project-models");
  });
});
