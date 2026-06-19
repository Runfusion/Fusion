/*
FNXC:CommandCenter 2026-06-16-09:40:
The Command Center view (PR #1683) is an App-level lazy-loaded view added to the curated inventory. This
test enforces that the inventory in AGENTS.md stays in sync with App.tsx (and AppModals.tsx).

FNXC:CommandCenter 2026-06-17-09:00:
Merging main reconciled the curated count to 23 (main's 22 lazy views/modals + Command Center).

FNXC:CommandCenter 2026-06-19-00:00:
FN-6702 removes ReliabilityView from the App-level lazy inventory because Reliability now mounts inside the lazy CommandCenter chunk.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_DOCUMENTED_VIEWS = new Set([
  "AgentsView",
  "NodesView",
  "ChatView",
  "MemoryView",
  "DevServerView",
  "SecretsView",
  "InsightsView",
  "DocumentsView",
  "SkillsView",
  "ResearchView",
  "CommandCenter",
  "EvalsView",
  "TodoView",
  "GoalsView",
  "StashRecoveryView",
  "PullRequestView",
  "SetupWizardModal",
  "SettingsModal",
  "WorkflowNodeEditor",
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
  "SecretsView",
  "CommandCenter",
  "DevServerView",
  "TodoView",
  "GoalsView",
  "StashRecoveryView",
  "PullRequestView",
]);

/*
 * FNXC:DashboardLazyViews 2026-06-16-17:40:
 * AppModals lazy-loads top-level heavy modals outside App.tsx, so the docs guard must scan that source site too; otherwise SettingsModal and WorkflowNodeEditor can drift out of the canonical inventory while tests stay green.
 */
const EXPECTED_APP_MODALS_LAZY_VIEWS = new Set([
  "SetupWizardModal",
  "SettingsModal",
  "WorkflowNodeEditor",
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

function extractConstLazyViews(source: string): string[] {
  return [...source.matchAll(/const\s+(\w+)\s*=\s*lazy\(/g)].map((m) => m[1]);
}

function extractAppLazyViews(appSource: string): Set<string> {
  const normalized = extractConstLazyViews(appSource)
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

function extractAppModalsLazyViews(appModalsSource: string): Set<string> {
  return new Set(extractConstLazyViews(appModalsSource));
}

describe("AGENTS lazy-loaded views inventory", () => {
  it("documents the App-level and AppModals lazy views accurately and keeps the curated 22-view list in sync", () => {
    const agentsDoc = readFileSync(resolve(__dirname, "../../../../AGENTS.md"), "utf-8");
    const appSource = readFileSync(resolve(__dirname, "../App.tsx"), "utf-8");
    const appModalsSource = readFileSync(resolve(__dirname, "../components/AppModals.tsx"), "utf-8");

    const section = extractLazyLoadedSection(agentsDoc);
    const countMatch = section.match(/These\s+(\d+)\s+views\s+are lazy-loaded/);
    expect(countMatch).toBeTruthy();
    expect(Number(countMatch?.[1])).toBe(22);

    const documentedViews = extractBacktickedNamesFromBullets(section);
    expect(new Set(documentedViews)).toEqual(EXPECTED_DOCUMENTED_VIEWS);
    expect(documentedViews).toHaveLength(22);

    expect(section).toContain("`ResearchView`");
    expect(section).toContain("`TodoView`");
    expect(section).toContain("`SettingsModal`");
    expect(section).toContain("`WorkflowNodeEditor`");
    expect((section.match(/`AgentDetailView`/g) ?? []).length).toBe(1);

    const appLevelViews = extractAppLazyViews(appSource);
    expect(appLevelViews).toEqual(EXPECTED_APP_LEVEL_VIEWS);

    for (const view of appLevelViews) {
      expect(EXPECTED_DOCUMENTED_VIEWS.has(view)).toBe(true);
    }

    const appModalsLazyViews = extractAppModalsLazyViews(appModalsSource);
    expect(appModalsLazyViews).toEqual(EXPECTED_APP_MODALS_LAZY_VIEWS);

    for (const view of appModalsLazyViews) {
      expect(EXPECTED_DOCUMENTED_VIEWS.has(view)).toBe(true);
      expect(section).toContain(`\`${view}\``);
    }
  });
});
