/*
FNXC:CommandCenter 2026-06-16-09:40:
The Command Center view (PR #1683) is an App-level lazy-loaded view added to the curated inventory. This
test enforces that the inventory in AGENTS.md stays in sync with App.tsx (and AppModals.tsx).

FNXC:CommandCenter 2026-06-17-09:00:
Merging main reconciled the curated count to 23 (main's 22 lazy views/modals + Command Center).

FNXC:CommandCenter 2026-06-19-00:00:
FN-6702 removes ReliabilityView from the App-level lazy inventory because Reliability now mounts inside the lazy CommandCenter chunk.

FNXC:CommandCenter 2026-06-19-00:00:
FN-6717 removes NodesView from the App-level lazy inventory because Nodes now mounts inside the lazy CommandCenter chunk.

FNXC:GitManager 2026-06-21-00:00:
FN-6881 removes StashRecoveryView from the App-level lazy inventory because Stash Recovery now mounts through the lazy GitManagerModal chunk.

FNXC:DashboardLazyViews 2026-06-22-00:00:
The navigation reshuffle promotes Workflows, Import Tasks, Automations, and Settings as embedded views that reuse existing lazy chunks. Their underscore-prefixed App consts stay out of the curated inventory so the docs count each heavy chunk once.

FNXC:DashboardLazyViews 2026-06-26-00:00:
Curated chunks declared outside App.tsx/AppModals.tsx (Plugins settings section, AgentsView) must be scanned at their real call sites so the inventory cannot drift while this guard stays green.

FNXC:DashboardLazyViews 2026-06-26-00:00:
Session terminals, onboarding internals, and overflow re-imports of already-counted chunks are explicit exclusions because they are not new heavy top-level views or modals for the AGENTS inventory.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_DOCUMENTED_VIEWS = new Set([
  "AgentsView",
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
  "ChatView",
  "SkillsView",
  "MemoryView",
  "SecretsView",
  "CommandCenter",
  "DevServerView",
  "TodoView",
  "GoalsView",
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

const EXPECTED_PLUGINS_SECTION_LAZY_VIEWS = new Set([
  "PluginManager",
  "PiExtensionsManager",
]);

const EXPECTED_AGENTS_VIEW_LAZY_VIEWS = new Set([
  "AgentDetailView",
]);

const EXPECTED_EXCLUDED_LAZY = [
  {
    file: "../App.tsx",
    symbols: ["_WorkflowEditorView", "_ImportTasksView", "_AutomationsView", "_SettingsView"],
    reason: "embedded App presentations reuse already-documented modal/import chunks",
  },
  {
    file: "../components/TaskDetailModal.tsx",
    symbols: ["LazySessionTerminal"],
    reason: "task session terminal, not a top-level heavy view or modal",
  },
  {
    file: "../components/TaskDetailModal.tsx",
    symbols: ["AgentDetailView"],
    reason: "re-import of the same AgentDetailView chunk curated from AgentsView.tsx",
    countedBy: "../components/AgentsView.tsx",
  },
  {
    file: "../components/ModelOnboardingModal.tsx",
    symbols: ["ExperimentalAgentOnboardingModal"],
    reason: "onboarding internal loaded inside the existing model onboarding flow",
  },
  {
    file: "../components/SetupWizardModal.tsx",
    symbols: ["ExperimentalAgentOnboardingModal"],
    reason: "onboarding internal loaded inside the existing setup wizard flow",
  },
  {
    file: "../components/overflowViewRegistry.tsx",
    /*
     * FNXC:DashboardLazyViews 2026-06-27-00:00:
     * The right-dock chat tab re-imports ChatView through the overflow registry, but ChatView remains counted once as the App-level Chat chunk in the curated AGENTS inventory.
     */
    symbols: ["DevServerView", "SecretsView", "TodoView", "PullRequestView", "ChatView"],
    reason: "right-dock overflow re-imports of App-level chunks already counted once",
    countedBy: "../App.tsx",
  },
] as const;

const EXPECTED_CURATED_LAZY_SOURCES = [
  { file: "../App.tsx", symbols: EXPECTED_APP_LEVEL_VIEWS },
  { file: "../components/AppModals.tsx", symbols: EXPECTED_APP_MODALS_LAZY_VIEWS },
  { file: "../components/settings/sections/PluginsSection.tsx", symbols: EXPECTED_PLUGINS_SECTION_LAZY_VIEWS },
  { file: "../components/AgentsView.tsx", symbols: EXPECTED_AGENTS_VIEW_LAZY_VIEWS },
] as const;

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
    .map((name) => (name.startsWith("_") ? null : name))
    .filter((name): name is string => Boolean(name));
  return new Set(normalized);
}

function extractAppModalsLazyViews(appModalsSource: string): Set<string> {
  return new Set(extractConstLazyViews(appModalsSource));
}

function expectDocumentedViews(include: Iterable<string>, section: string): void {
  for (const view of include) {
    expect(EXPECTED_DOCUMENTED_VIEWS.has(view)).toBe(true);
    expect(section).toContain(`\`${view}\``);
  }
}

describe("AGENTS lazy-loaded views inventory", () => {
  it("documents the App-level and AppModals lazy views accurately and keeps the curated 20-view list in sync", () => {
    const agentsDoc = readFileSync(resolve(__dirname, "../../../../AGENTS.md"), "utf-8");
    const appSource = readFileSync(resolve(__dirname, "../App.tsx"), "utf-8");
    const appModalsSource = readFileSync(resolve(__dirname, "../components/AppModals.tsx"), "utf-8");
    const pluginsSectionSource = readFileSync(resolve(__dirname, "../components/settings/sections/PluginsSection.tsx"), "utf-8");
    const agentsViewSource = readFileSync(resolve(__dirname, "../components/AgentsView.tsx"), "utf-8");

    const section = extractLazyLoadedSection(agentsDoc);
    const countMatch = section.match(/These\s+(\d+)\s+views\s+are lazy-loaded/);
    expect(countMatch).toBeTruthy();
    expect(Number(countMatch?.[1])).toBe(20);

    const documentedViews = extractBacktickedNamesFromBullets(section);
    expect(new Set(documentedViews)).toEqual(EXPECTED_DOCUMENTED_VIEWS);
    expect(documentedViews).toHaveLength(20);

    expect(section).toContain("`ResearchView`");
    expect(section).toContain("`TodoView`");
    expect(section).toContain("`SettingsModal`");
    expect(section).toContain("`WorkflowNodeEditor`");
    expect(section).toContain("`_ImportTasksView`");
    expect(section).toContain("`_AutomationsView`");
    expect(documentedViews.filter((view) => view === "AgentDetailView")).toHaveLength(1);

    const appLevelViews = extractAppLazyViews(appSource);
    expect(appLevelViews).toEqual(EXPECTED_APP_LEVEL_VIEWS);

    expectDocumentedViews(appLevelViews, section);

    const appModalsLazyViews = extractAppModalsLazyViews(appModalsSource);
    expect(appModalsLazyViews).toEqual(EXPECTED_APP_MODALS_LAZY_VIEWS);
    expectDocumentedViews(appModalsLazyViews, section);

    /*
     * FNXC:DashboardLazyViews 2026-06-26-00:00:
     * Plugin manager chunks and the agent detail chunk are curated AGENTS entries, but their lazy declarations live in feature-owned source files rather than App.tsx/AppModals.tsx. Scan those real call sites so removing or renaming one of these declarations fails this inventory guard.
     */
    const pluginsSectionLazyViews = new Set(extractConstLazyViews(pluginsSectionSource));
    expect(pluginsSectionLazyViews).toEqual(EXPECTED_PLUGINS_SECTION_LAZY_VIEWS);
    expectDocumentedViews(pluginsSectionLazyViews, section);

    const agentsViewLazyViews = new Set(extractConstLazyViews(agentsViewSource));
    expect(agentsViewLazyViews).toEqual(EXPECTED_AGENTS_VIEW_LAZY_VIEWS);
    expectDocumentedViews(agentsViewLazyViews, section);

    /*
     * FNXC:DashboardLazyViews 2026-06-26-00:00:
     * These lazy consts are intentionally outside the curated 20: task session terminals, onboarding internals, duplicate AgentDetail/overflow imports, and underscore-prefixed embedded views do not create additional top-level heavy inventory entries.
     */
    for (const exclusion of EXPECTED_EXCLUDED_LAZY) {
      const excludedSource = readFileSync(resolve(__dirname, exclusion.file), "utf-8");
      const excludedLazyViews = new Set(extractConstLazyViews(excludedSource));
      for (const symbol of exclusion.symbols) {
        expect(excludedLazyViews.has(symbol), exclusion.reason).toBe(true);
      }
    }

    const curatedSourceKeys = new Set(
      EXPECTED_CURATED_LAZY_SOURCES.flatMap((source) => [...source.symbols].map((symbol) => `${source.file}:${symbol}`)),
    );
    for (const exclusion of EXPECTED_EXCLUDED_LAZY) {
      for (const symbol of exclusion.symbols) {
        expect(curatedSourceKeys.has(`${exclusion.file}:${symbol}`), exclusion.reason).toBe(false);
        if ("countedBy" in exclusion) {
          expect(curatedSourceKeys.has(`${exclusion.countedBy}:${symbol}`), exclusion.reason).toBe(true);
          expect(documentedViews.filter((view) => view === symbol), exclusion.reason).toHaveLength(1);
        } else {
          expect(EXPECTED_DOCUMENTED_VIEWS.has(symbol), exclusion.reason).toBe(false);
        }
      }
    }
  });
});
