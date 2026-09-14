import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listComponentFiles } from "../../test/cssFixture";
import { readCode, readSource, stripComments } from "./view-layout-test-fixtures";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:31:
FN-379 closes the surface matrix with an explicit destination/producer table. A new full dashboard destination
that renders its own header must be classified here, and no producer may reintroduce a retired local rail width,
a total sidebar collapse, or a duplicated creation action. These are code-construct ratchets; no assertion reads
comments, date stamps, or FNXC prose.
*/

type InventoryRow = {
  destination: string;
  producer: string;
  /*
  FNXC:StandardizedViewLayout 2026-09-13-20:32:
  Every classified destination must have a behavioural home: a suite that mounts the REAL producer. The row is a
  claim, this field is where that claim is exercised, and the guard below refuses a row whose named suite does not
  actually render the component.
  */
  scenario: string;
  /** Canonical chrome constructs the producer must still build. */
  requires: string[];
};

const INVENTORY: InventoryRow[] = [
  { destination: "Planning", producer: "components/PlanningModeModal.tsx", scenario: "components/__tests__/view-layout-planning-missions.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar", "ViewActionButton"] },
  { destination: "Missions", producer: "components/MissionManager.tsx", scenario: "components/__tests__/view-layout-planning-missions.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar", "ViewActionButton"] },
  { destination: "Mission interview", producer: "components/MissionInterviewModal.tsx", scenario: "components/__tests__/MissionInterviewModal.test.tsx", requires: ["ViewLayout", "ViewHeader"] },
  { destination: "Milestone/slice interview", producer: "components/MilestoneSliceInterviewModal.tsx", scenario: "components/__tests__/MilestoneSliceInterviewModal.test.tsx", requires: ["ViewLayout", "ViewHeader"] },
  { destination: "Agents", producer: "components/AgentsView.tsx", scenario: "components/__tests__/view-layout-agents.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar"] },
  { destination: "Agent detail", producer: "components/AgentDetailView.tsx", scenario: "components/__tests__/view-layout-agents.test.tsx", requires: ["ViewLayout", "ViewHeader"] },
  { destination: "Mailbox", producer: "components/MailboxView.tsx", scenario: "components/__tests__/view-layout-mailbox.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar"] },
  { destination: "Mailbox window", producer: "components/MailboxModal.tsx", scenario: "components/__tests__/MailboxModal.test.tsx", requires: ["ViewLayout", "ViewHeader"] },
  { destination: "Chat", producer: "components/ChatView.tsx", scenario: "components/__tests__/view-layout-chat.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar"] },
  { destination: "Goals", producer: "components/GoalsView.tsx", scenario: "components/__tests__/view-layout-goals-automations.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar"] },
  { destination: "Automations", producer: "components/ScheduledTasksModal.tsx", scenario: "components/__tests__/view-layout-goals-automations.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar"] },
  { destination: "Notes", producer: "components/NotesView.tsx", scenario: "components/__tests__/view-layout-collections.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar"] },
  { destination: "Whiteboard", producer: "components/WhiteboardView.tsx", scenario: "components/__tests__/WhiteboardView.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar"] },
  { destination: "Skills", producer: "components/SkillsView.tsx", scenario: "components/__tests__/SkillsView.tabs.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar"] },
  { destination: "Research", producer: "components/ResearchView.tsx", scenario: "components/__tests__/ResearchView.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar"] },
  { destination: "Evals", producer: "components/EvalsView.tsx", scenario: "components/__tests__/EvalsView.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar"] },
  { destination: "Insights", producer: "components/InsightsView.tsx", scenario: "components/__tests__/InsightsView.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar"] },
  { destination: "Memory", producer: "components/MemoryView.tsx", scenario: "components/__tests__/MemoryView.test.tsx", requires: ["ViewLayout", "ViewHeader"] },
  { destination: "Patchnode", producer: "components/PatchnodeView.tsx", scenario: "components/__tests__/PatchnodeView.test.tsx", requires: ["ViewLayout", "ViewHeader"] },
  { destination: "Projects", producer: "components/ProjectOverview.tsx", scenario: "components/__tests__/view-layout-specialized.test.tsx", requires: ["ViewHeader", "ViewActionButton"] },
  { destination: "List", producer: "components/ListView.tsx", scenario: "components/__tests__/view-layout-specialized.test.tsx", requires: ["ViewHeader", "ViewSidebar", "ViewActionButton"] },
  { destination: "Dashboard (Command Center)", producer: "components/command-center/CommandCenter.tsx", scenario: "components/command-center/__tests__/CommandCenter.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar"] },
  { destination: "Ideation", producer: "components/command-center/IdeationPanel.tsx", scenario: "components/command-center/__tests__/IdeationPanel.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar", "ViewActionButton"] },
  { destination: "Nodes", producer: "components/NodesView.tsx", scenario: "components/__tests__/NodesView.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar", "ViewActionButton"] },
  { destination: "Plugins", producer: "components/PluginManager.tsx", scenario: "components/__tests__/PluginManager.test.tsx", requires: ["ViewHeader", "ViewActionButton"] },
  { destination: "Pi extensions", producer: "components/PiExtensionsManager.tsx", scenario: "components/__tests__/PiExtensionsManager.test.tsx", requires: ["ViewHeader", "ViewActionButton"] },
  { destination: "Workflows", producer: "components/WorkflowNodeEditor.tsx", scenario: "components/__tests__/view-layout-specialized.test.tsx", requires: ["ViewLayout", "ViewHeader", "ViewSidebar", "ViewActionButton"] },
  { destination: "Import Tasks", producer: "components/GitHubImportModal.tsx", scenario: "components/__tests__/GitHubImportModal.test.tsx", requires: ["ViewHeader"] },
  { destination: "Settings", producer: "components/SettingsModal.tsx", scenario: "components/__tests__/SettingsModal.general.test.tsx", requires: ["ViewHeader", "ViewSidebar"] },
  { destination: "Files", producer: "components/FileBrowserModal.tsx", scenario: "components/__tests__/FileBrowserModal.test.tsx", requires: ["ViewHeader", "ViewSidebar"] },
  { destination: "Pull requests", producer: "components/PullRequestView.tsx", scenario: "components/__tests__/view-layout-tools.test.tsx", requires: ["ViewHeader"] },
  { destination: "Secrets", producer: "components/SecretsView.tsx", scenario: "components/__tests__/view-layout-tools.test.tsx", requires: ["ViewHeader", "ViewActionButton"] },
  { destination: "Dev server", producer: "components/DevServerView.tsx", scenario: "components/__tests__/DevServerView.test.tsx", requires: ["ViewHeader", "ViewActionButton"] },
  { destination: "History (activity log)", producer: "components/ActivityLogModal.tsx", scenario: "components/__tests__/view-layout-window-tools.test.tsx", requires: ["ViewHeader", "ViewLayoutContent"] },
  { destination: "Scripts", producer: "components/ScriptsModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader", "ViewLayout", "ViewSidebar", "ViewActionButton", "ViewLayoutContent"] },
  /*
  FNXC:StandardizedViewLayout 2026-09-13-21:49:
  Dialogs, confirmations, onboarding flows, and secondary windows are producers too. Before FN-379's remediation a
  surface could escape this table simply by keeping a local header row, so they are classified here and exercised
  against their real components on both viewports in view-layout-dialogs.test.tsx.
  */
  { destination: "Add node", producer: "components/AddNodeModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Agent error details", producer: "components/AgentErrorDetailsModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Agents window", producer: "components/AgentListModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader", "ViewActionButton"] },
  { destination: "Agent onboarding", producer: "components/AgentOnboardingModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Changes diff", producer: "components/ChangesDiffModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Confirmation", producer: "components/ConfirmDialog.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Connect node", producer: "components/ConnectNodeModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Create room", producer: "components/CreateRoomModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Docker node onboarding", producer: "components/DockerNodeOnboardingModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Duplicate warning", producer: "components/DuplicateWarningModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Experimental agent onboarding", producer: "components/ExperimentalAgentOnboardingModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Branch group", producer: "components/GroupTaskModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Model selection", producer: "components/ModelSelectionModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Connection manager", producer: "components/NativeShellConnectionManager.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Native shell onboarding", producer: "components/NativeShellOnboardingModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "New task", producer: "components/NewTaskModal.tsx", scenario: "components/__tests__/NewTaskModal.test.tsx", requires: ["ViewHeader"] },
  { destination: "Node detail", producer: "components/NodeDetailModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Create pull request", producer: "components/PrCreateModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Provider login", producer: "components/ProviderLoginDialog.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Reliability", producer: "components/ReliabilityView.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Research task action", producer: "components/ResearchTaskActionModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Settings sync conflicts", producer: "components/SettingsSyncConflictModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Stash conflicts", producer: "components/StashConflictModal.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Stash recovery", producer: "components/StashRecoveryView.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Task reset", producer: "components/TaskResetDialog.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Usage", producer: "components/UsageIndicator.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Workflow results output", producer: "components/WorkflowResultsTab.tsx", scenario: "components/__tests__/view-layout-dialogs.test.tsx", requires: ["ViewHeader"] },
  /*
  FNXC:StandardizedViewLayout 2026-09-13-22:40:
  FN-379 remediation: the window-shaped producers that previously escaped by naming their header row something
  other than `modal-header`. Each is exercised against its real component on both viewports.
  */
  { destination: "Agent generation", producer: "components/AgentGenerationModal.tsx", scenario: "components/__tests__/view-layout-window-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Agent import", producer: "components/AgentImportModal.tsx", scenario: "components/__tests__/view-layout-window-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "New agent", producer: "components/NewAgentDialog.tsx", scenario: "components/__tests__/view-layout-window-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Artifact media viewer", producer: "components/ArtifactImageViewer.tsx", scenario: "components/__tests__/view-layout-window-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Artifact gallery viewer", producer: "components/ArtifactsGallery.tsx", scenario: "components/__tests__/view-layout-window-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "AI onboarding", producer: "components/ModelOnboardingModal.tsx", scenario: "components/__tests__/view-layout-window-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Report", producer: "components/ReportModal.tsx", scenario: "components/__tests__/view-layout-window-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "First-run wizard", producer: "components/SetupWizardModal.tsx", scenario: "components/__tests__/view-layout-window-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Add workflow step", producer: "components/WorkflowAddStepModal.tsx", scenario: "components/__tests__/view-layout-window-dialogs.test.tsx", requires: ["ViewHeader"] },
  { destination: "Git manager", producer: "components/GitManagerModal.tsx", scenario: "components/__tests__/GitManagerModal.test.tsx", requires: ["ViewHeader", "ViewLayoutContent"] },
  { destination: "Task detail", producer: "components/TaskDetailModal.tsx", scenario: "components/__tests__/view-layout-drawers-task-detail.test.tsx", requires: ["ViewLayoutHeader", "ViewBackButton"] },
  { destination: "Terminal", producer: "components/TerminalModal.tsx", scenario: "components/__tests__/TerminalModal.closed-mount-cost.test.tsx", requires: ["ViewLayoutHeader", "ViewLayoutContent"] },
  { destination: "Mobile drawer shell", producer: "components/AlphaMobileDrawer.tsx", scenario: "components/__tests__/view-layout-runtime-hosts.test.tsx", requires: ["ViewLayoutHeader", "ViewLayoutContent"] },
  { destination: "Right dock expand window", producer: "components/RightDockExpandModal.tsx", scenario: "components/__tests__/view-layout-runtime-hosts.test.tsx", requires: ["ViewLayoutHeader", "ViewLayoutContent"] },
  { destination: "Floating window shell", producer: "components/FloatingWindow.tsx", scenario: "components/__tests__/view-layout-drawers-task-detail.test.tsx", requires: ["ViewLayoutHeader", "ViewLayoutContent"] },
  { destination: "Plugin view host", producer: "plugins/PluginDashboardViewHost.tsx", scenario: "components/__tests__/view-layout-plugins.test.tsx", requires: ["ViewLayout", "ViewHeader"] },
];

/*
FNXC:StandardizedPluginViews 2026-09-13-22:40:
Bundled plugin destinations are the second producer family. A plugin view that paints its own destination title
must build it with the cooperative header so a framing host stays the sole title owner; a plugin whose title is
owned by the host (canvas, wizard) is classified as such and must NOT construct one. Behaviour for every row is
exercised against the real component in view-layout-plugins.test.tsx.
*/
type PluginInventoryRow = {
  destination: string;
  /** Repository-relative plugin source that renders the destination body. */
  producer: string;
  titleOwner: "plugin" | "host";
  /*
  FNXC:StandardizedPluginViews 2026-09-13-22:40:
  Repository-relative suite inside the PLUGIN's own runner that mounts this real component. Todos ships no React
  testing toolchain of its own, so its behavioural home stays the dashboard-hosted plugin suite; every other
  family owns a runner-local scenario and the guard below refuses a row whose suite does not mount it.
  */
  scenario: string;
};

const PLUGIN_INVENTORY: PluginInventoryRow[] = [
  { destination: "Roadmaps", producer: "plugins/fusion-plugin-roadmap/src/dashboard/RoadmapsView.tsx", titleOwner: "plugin", scenario: "plugins/fusion-plugin-roadmap/src/dashboard/__tests__/view-layout.test.tsx" },
  { destination: "Quality", producer: "plugins/fusion-plugin-quality/src/dashboard-view.tsx", titleOwner: "plugin", scenario: "plugins/fusion-plugin-quality/src/__tests__/view-layout.test.tsx" },
  { destination: "Compound engineering", producer: "plugins/fusion-plugin-compound-engineering/src/dashboard/CompoundEngineeringView.tsx", titleOwner: "plugin", scenario: "plugins/fusion-plugin-compound-engineering/src/dashboard/__tests__/view-layout.test.tsx" },
  { destination: "Todos", producer: "plugins/fusion-plugin-todos/src/dashboard/TodoView.tsx", titleOwner: "plugin", scenario: "packages/dashboard/app/components/__tests__/view-layout-plugins.test.tsx" },
  { destination: "Reports", producer: "plugins/fusion-plugin-reports/src/dashboard/ReportsView.tsx", titleOwner: "plugin", scenario: "plugins/fusion-plugin-reports/src/dashboard/__tests__/view-layout.test.tsx" },
  { destination: "Linear import", producer: "plugins/fusion-plugin-linear-import/src/LinearImportView.tsx", titleOwner: "plugin", scenario: "plugins/fusion-plugin-linear-import/src/__tests__/view-layout.test.tsx" },
  { destination: "Printing Press manage", producer: "plugins/fusion-plugin-cli-printing-press/src/manage-view.tsx", titleOwner: "plugin", scenario: "plugins/fusion-plugin-cli-printing-press/src/__tests__/view-layout.test.tsx" },
  { destination: "Dependency graph", producer: "plugins/fusion-plugin-dependency-graph/src/dashboard-view.tsx", titleOwner: "host", scenario: "plugins/fusion-plugin-dependency-graph/src/__tests__/view-layout.test.tsx" },
  { destination: "Printing Press wizard", producer: "plugins/fusion-plugin-cli-printing-press/src/dashboard-view.tsx", titleOwner: "host", scenario: "plugins/fusion-plugin-cli-printing-press/src/__tests__/view-layout.test.tsx" },
];

/** Retired chrome contracts that must not come back anywhere in the dashboard app sources. */
const RETIRED_CONSTRUCTS = [
  "kb-dashboard-list-sidebar-width",
  "kb-dashboard-mailbox-sidebar-width",
  "kb-dashboard-agents-sidebar-width",
  "kb-dashboard-github-import-list-width",
  "fusion:file-browser-sidebar-width",
  "fusion:settings-nav-width",
  "fusion:wf-left-sidebar-collapsed",
  "wf-sidebar-collapse",
  "wf-sidebar-restore",
  "planning-sidebar-footer",
  "mission-manager__sidebar-cta-bar",
  "chat-thread-header-back",
  "sidebar-nav-new-task",
];

function readPluginSource(repoRelativePath: string): string {
  const source = readFileSync(resolve(__dirname, "../../../../..", repoRelativePath), "utf8");
  return stripComments(source);
}

/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
Source extents of every shared header element, so the guard below can ask whether a close control is inside one
without depending on what a surface names its own rows. Prop values that carry JSX (an `actions` cluster) are
followed through their brace depth, so a close rendered as a header action counts as owned by that header.
*/
function sharedHeaderRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const openings = /<(ViewHeader|ViewLayoutHeader)[\s/>]/g;
  let opening: RegExpExecArray | null;
  while ((opening = openings.exec(code))) {
    const tagName = opening[1];
    let cursor = opening.index + opening[0].length - 1;
    let braceDepth = 0;
    let tagEnd = -1;
    let selfClosing = false;
    for (; cursor < code.length; cursor += 1) {
      const char = code[cursor];
      if (char === "{") braceDepth += 1;
      else if (char === "}") braceDepth -= 1;
      else if (braceDepth === 0 && char === ">") {
        selfClosing = code[cursor - 1] === "/";
        tagEnd = cursor;
        break;
      }
    }
    if (tagEnd === -1) continue;
    if (selfClosing) {
      ranges.push([opening.index, tagEnd]);
      continue;
    }
    const closingTag = code.indexOf(`</${tagName}>`, tagEnd);
    ranges.push([opening.index, closingTag === -1 ? code.length : closingTag]);
  }
  return ranges;
}

function appSourceFiles(): string[] {
  return listComponentFiles().map((name) => `components/${name}`);
}

describe("FN-379 view-layout host inventory", () => {
  it("keeps every classified destination building the canonical chrome", () => {
    const missing: string[] = [];
    for (const row of INVENTORY) {
      const code = readCode(row.producer);
      for (const construct of row.requires) {
        if (!new RegExp(`<${construct}[\\s/>]`).test(code)) missing.push(`${row.destination} → ${construct}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("binds every classified destination to a suite that mounts its real producer", () => {
    const offenders: string[] = [];
    for (const row of INVENTORY) {
      const componentName = row.producer.split("/").at(-1)!.replace(/\.tsx$/, "");
      let suite: string;
      try {
        suite = readSource(row.scenario);
      } catch {
        offenders.push(`${row.destination} → missing scenario suite ${row.scenario}`);
        continue;
      }
      if (!suite.includes(componentName)) offenders.push(`${row.destination} → ${row.scenario} never mounts ${componentName}`);
      if (!/render\w*\(/.test(suite)) offenders.push(`${row.destination} → ${row.scenario} renders nothing`);
    }
    expect(offenders).toEqual([]);
  });

  it("classifies every dashboard destination that owns a canonical header", () => {
    const classified = new Set<string>([
      ...INVENTORY.map((row) => row.producer),
      /*
      Settings' pricing table is a dialog inside the already-classified Settings destination; its chrome is proven
      by the Settings suites and it is not a destination of its own.
      */
      "components/settings/sections/ModelPricingSection.tsx",
    ]);
    const unclassified = appSourceFiles().filter((file) => {
      if (file.includes("__tests__/")) return false;
      if (classified.has(file)) return false;
      const code = readCode(file);
      // Only full destinations construct the shared header themselves.
      return /<ViewHeader[\s/>]/.test(code);
    });
    expect(unclassified).toEqual([]);
  });

  /*
  FNXC:StandardizedViewLayout 2026-09-13-21:49:
  Keying classification on ViewHeader adoption alone let an UNMIGRATED producer escape the matrix: a surface that
  kept a local `.modal-header` row was simply invisible to the guard. Chrome ownership is therefore detected from
  the construct a surface BUILDS, so a local header row is an offender whether or not the file is classified.
  */
  it("lets no producer keep a local header row instead of the shared header", () => {
    const offenders = appSourceFiles().filter((file) => {
      if (file.includes("__tests__/")) return false;
      const code = readCode(file);
      // A header row built by anything other than the shared header components.
      // `modal-header-actions` is an action group INSIDE a shared header, not a competing header row.
      return /<(?!ViewHeader\b|ViewLayoutHeader\b)[A-Za-z][\w.]*\s[^<>]*className=(?:"[^"]*\bmodal-header\b(?!-)[^"]*"|\{[^}<]*modal-header(?!-)[^}<]*\})/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  /*
  FNXC:StandardizedViewLayout 2026-09-13-22:40:
  FN-379 remediation: keying the previous guard on the literal `modal-header` class still let a producer escape by
  NAMING its local row something else (`agent-dialog-header`, `setup-wizard-header`, `model-onboarding-header`).
  Detection is therefore structural and name-independent: the canonical close control must sit inside a shared
  header construct, so any surface that keeps its own header row — or floats its exit with no header at all — is an
  offender whatever it calls that row.
  */
  it("lets no producer own the canonical close outside a shared header, whatever it names its row", () => {
    const offenders: string[] = [];
    for (const file of appSourceFiles()) {
      if (file.includes("__tests__/") || file === "components/ViewHeader.tsx") continue;
      const code = readCode(file);
      const outsideShared = sharedHeaderRanges(code);
      const closePattern = /<ModalCloseButton[\s/>]/g;
      let close: RegExpExecArray | null;
      while ((close = closePattern.exec(code))) {
        const index = close.index;
        if (!outsideShared.some(([start, end]) => index > start && index < end)) {
          offenders.push(`${file} → canonical close outside a shared header`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never reintroduces a retired rail width, collapse shell, or duplicate creation entry", () => {
    const offenders: string[] = [];
    for (const file of [...appSourceFiles(), "components/LeftSidebarNav.tsx", "components/Header.tsx"]) {
      if (file.includes("__tests__/")) continue;
      const code = readCode(file);
      for (const construct of RETIRED_CONSTRUCTS) {
        if (code.includes(construct)) offenders.push(`${file} → ${construct}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /*
  A destination that renders its own ViewHeader must hand it to the layout's header zone. Passing
  `header={null}` and dropping the header into the children places it inside the bounded content, so it
  scrolls away with the body instead of staying a fixed sibling.
  */
  it("never renders a destination header inside the bounded content zone", () => {
    const offenders = appSourceFiles().filter((file) => {
      if (file.includes("__tests__/")) return false;
      const code = readCode(file);
      return /header=\{null\}/.test(code) && /<ViewHeader[\s/>]/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("binds every classified plugin destination to a suite that mounts its real component", () => {
    const offenders: string[] = [];
    for (const row of PLUGIN_INVENTORY) {
      const componentName = row.producer.split("/").at(-1)!.replace(/\.tsx$/, "");
      let suite: string;
      try {
        suite = readFileSync(resolve(__dirname, "../../../../..", row.scenario), "utf8");
      } catch {
        offenders.push(`${row.destination} → missing scenario suite ${row.scenario}`);
        continue;
      }
      if (!/render\w*\(/.test(suite)) offenders.push(`${row.destination} → ${row.scenario} renders nothing`);
      // A plugin source may export helpers beside its destination; the suite must mount one of its exported views.
      const exported = [...readPluginSource(row.producer).matchAll(/export function (\w*View\w*)/g)].map((match) => match[1]);
      const candidates = exported.length > 0 ? exported : [componentName];
      if (!candidates.some((name) => suite.includes(name))) {
        offenders.push(`${row.destination} → ${row.scenario} never mounts ${candidates.join(" | ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every classified plugin destination on its declared title owner", () => {
    const offenders: string[] = [];
    for (const row of PLUGIN_INVENTORY) {
      const code = readPluginSource(row.producer);
      const buildsHeader = /<PluginDashboardViewHeader[\s/>]/.test(code);
      if (row.titleOwner === "plugin" && !buildsHeader) offenders.push(`${row.destination} → missing cooperative header`);
      if (row.titleOwner === "host" && buildsHeader) offenders.push(`${row.destination} → competing plugin header`);
      if (/<h2>\s*(Reports|Roadmaps|Todos)\s*<\/h2>/.test(code)) offenders.push(`${row.destination} → retired local title row`);
    }
    expect(offenders).toEqual([]);
  });

  /*
  FNXC:StandardizedViewActions 2026-09-13-20:32:
  A plugin writes its header actions as plain buttons rather than through the shared component, so the icon-only
  phone collapse has to be ratcheted here: hiding the label of an icon-less button leaves an empty touch target.
  */
  it("never lets a plugin collapse an icon-less header action to icon-only", () => {
    const offenders: string[] = [];
    for (const row of PLUGIN_INVENTORY) {
      const code = readPluginSource(row.producer);
      let index = code.indexOf("view-action-button--mobile-icon-only");
      while (index !== -1) {
        const buttonEnd = code.indexOf("</button>", index);
        const body = buttonEnd === -1 ? code.slice(index) : code.slice(index, buttonEnd);
        if (!body.includes('aria-hidden="true"')) offenders.push(`${row.destination} → icon-only action without an icon`);
        index = code.indexOf("view-action-button--mobile-icon-only", index + 1);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("routes every rail width through the single shared preference authority", () => {
    const hookSource = readCode("hooks/useViewSidebarWidth.ts");
    expect(hookSource).toContain("ViewLayoutContext");
    expect(hookSource).not.toMatch(/localStorage/);

    const contextSource = readSource("context/ViewLayoutContext.tsx");
    expect(contextSource).toContain("kb-dashboard-view-sidebar-width");

    /*
    Global navigation is not a collection rail: LeftSidebarNav sizes the app's primary navigation surface,
    which the shared destination preference must never move. It is the one documented exception.
    */
    const navigationRail = "components/LeftSidebarNav.tsx";
    const localAuthorities = appSourceFiles().filter((file) => {
      if (file.includes("__tests__/") || file === navigationRail) return false;
      const code = readCode(file);
      return /sidebar[-_]?width/i.test(code) && !/ViewSidebar|useViewSidebarWidth|view-sidebar/.test(code);
    });
    expect(localAuthorities).toEqual([]);
  });
});
