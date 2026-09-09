/*
FNXC:UiMetadataApi 2026-07-14-00:00:
Dashboard view ids, English fallback labels, and translation keys have one source of truth consumed by both the dashboard UI and GET /api/views. Edit this registry rather than either consumer so external discovery cannot drift from navigation.
*/

export const DASHBOARD_VIEW_IDS = [
  "board",
  "list",
  "patchnode",
  "graph",
  "agents",
  "missions",
  "chat",
  "documents",
  "research",
  "evals",
  "ideation",
  "goalsView",
  "planning",
  "skills",
  "mailbox",
  "recommendations",
  "insights",
  "memory",
  "command-center",
  "secrets",
  "dev-server",
  "pull-requests",
  "workflows",
  "import-tasks",
  "automations",
  "settings",
  "task-detail",
] as const;

export type CanonicalDashboardViewId = (typeof DASHBOARD_VIEW_IDS)[number];
export type BuiltInTaskView = CanonicalDashboardViewId | "devserver";

export interface DashboardViewMetadata {
  id: CanonicalDashboardViewId;
  label: string;
  /*
  FNXC:UiMetadataApi 2026-07-14-00:00:
  Optional because a labelKey is only published when the dashboard itself renders
  that view's title through it. Ids with no host-owned translation key (`graph`,
  whose label comes from a plugin manifest, and the internal `task-detail`
  destination) omit it rather than advertise a key that resolves to nothing —
  `label` is the guaranteed display string.
  */
  labelKey?: string;
  aliases?: readonly string[];
  internal?: boolean;
}

export const DASHBOARD_VIEWS: readonly DashboardViewMetadata[] = [
  { id: "board", label: "Board", labelKey: "nav.board" },
  { id: "list", label: "List", labelKey: "nav.list" },
  /*
  FNXC:HistoryNaming 2026-09-04-09:35:
  Operators call this destination History, and chat exposes it as `fn_history_read`. The `patchnode` view id, `nav.patchnode` key, `GET /api/patchnode` route, `project.patchnode_entries` table, and persisted mobile-navigation preferences intentionally remain unchanged.
  */
  { id: "patchnode", label: "History", labelKey: "nav.patchnode" },
  { id: "graph", label: "Graph" },
  { id: "agents", label: "Agents", labelKey: "nav.agents" },
  { id: "missions", label: "Missions", labelKey: "nav.missions" },
  { id: "chat", label: "Chat", labelKey: "nav.chat" },
  { id: "documents", label: "Artifacts", labelKey: "nav.documents" },
  { id: "research", label: "Research", labelKey: "header.researchView" },
  { id: "evals", label: "Evals", labelKey: "header.evalsView" },
  /*
  FNXC:Navigation 2026-07-27-00:00:
  FN-8352 promotes Ideation from a Command Center tab to a persisted,
  default-off experimental top-level view.
  */
  { id: "ideation", label: "Ideation", labelKey: "nav.ideation" },
  { id: "goalsView", label: "Goals", labelKey: "header.goalsView" },
  /*
  FNXC:Navigation 2026-06-21-00:00:
  FN-6886 promotes Planning Mode into a persisted top-level docked task view instead of treating it as a modal-only overlay.
  */
  { id: "planning", label: "Planning", labelKey: "nav.planning" },
  /*
  FNXC:ChatSnippets 2026-09-03-16:32:
  The existing `skills` route and persistence identity stay stable while every navigation label presents the combined Skills & Snippets destination.
  */
  { id: "skills", label: "Skills & Snippets", labelKey: "header.skillsView" },
  { id: "mailbox", label: "Mailbox", labelKey: "nav.mailbox" },
  { id: "recommendations", label: "Recommendations", labelKey: "nav.recommendations" },
  { id: "insights", label: "Insights", labelKey: "header.insightsView" },
  { id: "memory", label: "Memory", labelKey: "header.memoryView" },
  { id: "command-center", label: "Dashboard", labelKey: "nav.commandCenter" },
  { id: "secrets", label: "Secrets", labelKey: "header.secretsView" },
  { id: "dev-server", label: "Dev Server", labelKey: "nav.devServer", aliases: ["devserver"] },
  { id: "pull-requests", label: "Pull Requests", labelKey: "pr.view.title" },
  /*
  FNXC:ViewState 2026-06-22-00:00:
  Workflows, Import Tasks, and Automations are promoted to top-level main-content task views (left-sidebar destinations) instead of modal-only overlays, so they render in the main panel like Command Center.
  */
  { id: "workflows", label: "Workflows", labelKey: "nav.workflows" },
  { id: "import-tasks", label: "Import Tasks", labelKey: "nav.importTasks" },
  { id: "automations", label: "Automations", labelKey: "nav.automations" },
  /*
  FNXC:ViewState 2026-06-22-00:00:
  Settings is promoted from a modal-only overlay into a top-level main-content task view so the header/sidebar Settings entry points dock it in the main panel like Command Center, while preserving deep-link section navigation.
  */
  { id: "settings", label: "Settings", labelKey: "header.settings" },
  /*
  FNXC:Navigation 2026-06-22-00:00:
  Clicking a task card on the Board opens its detail as a full main-content view ("Full main panel (replaces board)") with a Back-to-board button, instead of the TaskDetailModal overlay. The detail is hosted under this registered `task-detail` task view so navigation/persistence treat it like any other docked main-panel destination.
  */
  { id: "task-detail", label: "Task Detail", internal: true },
];

// Indexed by canonical id and every legacy alias (e.g. "devserver" -> dev-server)
// so lookups tolerate a persisted BuiltInTaskView value, not just canonical ids.
const DASHBOARD_VIEW_BY_ID = new Map<string, DashboardViewMetadata>();
for (const view of DASHBOARD_VIEWS) {
  DASHBOARD_VIEW_BY_ID.set(view.id, view);
  for (const alias of view.aliases ?? []) {
    DASHBOARD_VIEW_BY_ID.set(alias, view);
  }
}

export function getDashboardViewLabel(id: BuiltInTaskView): string {
  const view = DASHBOARD_VIEW_BY_ID.get(id);
  if (!view) {
    throw new Error(`Unknown dashboard view id: ${id}`);
  }
  return view.label;
}
