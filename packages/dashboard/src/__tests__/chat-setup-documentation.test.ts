// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../../");
const bannedRetiredPhrases = [
  "New Chat dialog",
  "New Chat picker",
  "Prompt for model each time",
  "Always use configured default",
  "falls back to the dialog",
] as const;

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function getSectionBody(doc: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = doc.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match?.[1]?.trim() ?? "";
}

describe("Direct chat setup documentation", () => {
  const dashboardGuide = readRepoFile("docs/dashboard-guide.md");
  const settingsReference = readRepoFile("docs/settings-reference.md");

  it("keeps documentation coupled to the retired setup UI being absent", () => {
    const chatView = readRepoFile("packages/dashboard/app/components/ChatView.tsx");
    const projectModels = readRepoFile("packages/dashboard/app/components/settings/sections/ProjectModelsSection.tsx");

    expect(chatView).not.toContain("NewChatDialog");
    expect(projectModels).not.toMatch(/chatNewSessionModePrompt|chatNewSessionModeAlwaysDefault/);
  });

  it("removes retired-flow claims from the dashboard guide", () => {
    for (const phrase of bannedRetiredPhrases) {
      expect(dashboardGuide).not.toContain(phrase);
    }
  });

  it("documents immediate creation and Brain-popover retargeting in Chat View", () => {
    const chatViewSection = getSectionBody(dashboardGuide, "Chat View");

    expect(chatViewSection).toMatch(/\*\*Brain\*\* control beside the composer to retarget an existing conversation/i);
    expect(chatViewSection).toMatch(/\*\*New Chat\*\* immediately creates a Direct conversation from the Settings-configured default/i);
  });

  it("marks the retained mode setting inert without retired-flow claims", () => {
    for (const phrase of bannedRetiredPhrases) {
      expect(settingsReference).not.toContain(phrase);
    }

    const modeRow = settingsReference.split("\n").find((line) => line.startsWith("| `chatNewSessionMode`"));
    expect(modeRow).toMatch(/retired|inert|no effect/i);
  });

  it("keeps shipped Settings catalogs and copy free of retired create-time prompt modes", () => {
    const localeDirectory = path.join(repoRoot, "packages/i18n/locales");
    const localeCatalogs = readdirSync(localeDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const retiredModeKeys = [
      "chatNewSessionMode",
      "chatNewSessionModePrompt",
      "chatNewSessionModeAlwaysDefault",
      "chatNewSessionModeHelp",
    ];
    const retiredCopy = ["should prompt", "fall back to prompting", "New Chat behavior", ...bannedRetiredPhrases];

    for (const locale of localeCatalogs) {
      const catalog = JSON.parse(readRepoFile(`packages/i18n/locales/${locale}/app.json`)) as {
        settings?: { projectModels?: Record<string, unknown> };
      };
      const projectModels = catalog.settings?.projectModels ?? {};

      for (const key of retiredModeKeys) {
        expect(projectModels).not.toHaveProperty(key);
      }
    }

    const englishCatalog = JSON.parse(readRepoFile("packages/i18n/locales/en/app.json")) as {
      settings: { projectModels: Record<string, string> };
    };
    const englishProjectModels = englishCatalog.settings.projectModels;
    const projectModelsSource = readRepoFile("packages/dashboard/app/components/settings/sections/ProjectModelsSection.tsx");

    for (const phrase of retiredCopy) {
      expect(englishProjectModels.chatDescription).not.toContain(phrase);
      expect(englishProjectModels.chatDefaultModelHelp).not.toContain(phrase);
      expect(projectModelsSource).not.toContain(phrase);
    }

    expect(englishProjectModels.chatDescription).toContain("New Chat");
    expect(readRepoFile("packages/i18n/src/resources.d.ts")).not.toContain("chatNewSessionMode");
  });
});
