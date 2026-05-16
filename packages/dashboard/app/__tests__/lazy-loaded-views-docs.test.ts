import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_DOCUMENTED_VIEWS = new Set([
  "AgentsView",
  "NodesView",
  "ChatView",
  "MemoryView",
  "DevServerView",
  "InsightsView",
  "DocumentsView",
  "SkillsView",
  "ResearchView",
  "ReliabilityView",
  "EvalsView",
  "TodoView",
  "GoalsView",
  "StashRecoveryView",
  "SetupWizardModal",
  "PluginManager",
  "PiExtensionsManager",
  "AgentDetailView",
]);

const EXPECTED_APP_LEVEL_VIEWS = new Set([
  "AgentsView",
  "DocumentsView",
  "InsightsView",
  "ResearchView",
  "EvalsView",
  "NodesView",
  "ChatView",
  "SkillsView",
  "MemoryView",
  "ReliabilityView",
  "DevServerView",
  "TodoView",
  "StashRecoveryView",
]);

function extractLazyLoadedSection(agentsDoc: string): string {
  const match = agentsDoc.match(/### Lazy-Loaded Heavy Views[\s\S]*?(?=\n### |\n---|$)/);
  if (!match) {
    throw new Error("Lazy-Loaded Heavy Views section not found in AGENTS.md");
  }
  return match[0];
}

function extractBacktickedNamesFromBullets(section: string): string[] {
  return section
    .split("\n")
    .filter((line) => line.trim().startsWith("- "))
    .flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
}

function extractAppLazyViews(appSource: string): Set<string> {
  const matches = [...appSource.matchAll(/const\s+(\w+)\s*=\s*lazy\(/g)].map((m) => m[1]);
  const normalized = matches
    .map((name) => {
      if (name === "_TodoView") {
        return "TodoView";
      }
      if (name.startsWith("_")) {
        return null;
      }
      return name;
    })
    .filter((name): name is string => Boolean(name));
  return new Set(normalized);
}

describe("AGENTS lazy-loaded views inventory", () => {
  it("documents the App-level lazy views accurately and keeps the curated 18-view list in sync", () => {
    const agentsDoc = readFileSync(resolve(__dirname, "../../../../AGENTS.md"), "utf-8");
    const appSource = readFileSync(resolve(__dirname, "../App.tsx"), "utf-8");

    const section = extractLazyLoadedSection(agentsDoc);
    const countMatch = section.match(/These\s+(\d+)\s+views\s+are lazy-loaded/);
    expect(countMatch).toBeTruthy();
    expect(Number(countMatch?.[1])).toBe(18);

    const documentedViews = extractBacktickedNamesFromBullets(section);
    expect(new Set(documentedViews)).toEqual(EXPECTED_DOCUMENTED_VIEWS);
    expect(documentedViews).toHaveLength(18);

    expect(section).toContain("`ResearchView`");
    expect(section).toContain("`TodoView`");
    expect((section.match(/`AgentDetailView`/g) ?? []).length).toBe(1);

    const appLevelViews = extractAppLazyViews(appSource);
    expect(appLevelViews).toEqual(EXPECTED_APP_LEVEL_VIEWS);

    for (const view of appLevelViews) {
      expect(EXPECTED_DOCUMENTED_VIEWS.has(view)).toBe(true);
    }
  });
});
