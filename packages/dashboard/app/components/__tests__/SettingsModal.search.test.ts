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

  it("does not surface Project Models for unrelated Remote Access terms", () => {
    expect(searchSettingsSectionIds("cloudflared")).not.toContain("project-models");
  });
});
