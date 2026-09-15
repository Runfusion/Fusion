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
  "notes",
  "whiteboard",
  "research",
  "evals",
  "ideation",
  "goalsView",
  "planning",
  "skills",
  "snippets",
  "mailbox",
  "insights",
  "memory",
  "command-center",
  "files",
  "git-manager",
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
export type BuiltInTaskView = CanonicalDashboardViewId | "devserver" | "documents" | "recommendations";

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

  FNXC:HistoryModalSurface 2026-09-15-04:29:
  FN-403: History is no longer a main-content destination. The id stays in this registry because persisted view
  values, deep links, the API route, and the mobile navigation registry still address it, but a request for it now
  opens the single History modal instead of replacing the current view.
  */
  { id: "patchnode", label: "History", labelKey: "nav.patchnode" },
  { id: "graph", label: "Graph" },
  { id: "agents", label: "Agents", labelKey: "nav.agents" },
  { id: "missions", label: "Missions", labelKey: "nav.missions" },
  { id: "chat", label: "Chat", labelKey: "nav.chat" },
  /* FNXC:ProjectNotes 2026-09-09-17:08: Notes is one canonical project-scoped destination shared by metadata, deep links, desktop navigation, and mobile customization. */
  { id: "notes", label: "Notes", labelKey: "nav.notes" },
  /* FNXC:WhiteboardAlpha 2026-09-10-05:42: Whiteboard is one canonical default-off project destination shared by metadata, deep links, and every responsive navigation host. */
  { id: "whiteboard", label: "Whiteboard", labelKey: "nav.whiteboard" },
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
  FNXC:SnippetsDestination 2026-09-14-04:12:
  Skills and Snippets are two destinations, each with its own collection rail. The `skills` route keeps its stable id
  and persistence identity; Snippets gets its own rather than remaining a tab inside it.
  */
  { id: "skills", label: "Skills", labelKey: "header.skillsView" },
  { id: "snippets", label: "Snippets", labelKey: "header.snippetsView" },
  /*
  FNXC:MailboxNavigation 2026-09-09-20:02:
  Artifacts and recommendations are mailbox categories rather than standalone dashboard destinations. Legacy persisted and linked ids remain aliases so old navigation state resolves to Mailbox instead of an orphaned route.
  */
  { id: "mailbox", label: "Mailbox", labelKey: "nav.mailbox", aliases: ["documents", "recommendations"] },
  { id: "insights", label: "Insights", labelKey: "header.insightsView" },
  { id: "memory", label: "Memory", labelKey: "header.memoryView" },
  { id: "command-center", label: "Dashboard", labelKey: "nav.commandCenter" },
  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  FN-426 promotes Files and Git Manager from right-dock-only tools to first-class main-content destinations, which is
  what lets the right dock become optional. Git Manager owns Pull Requests as one of its sections, so `pull-requests`
  keeps its id below for persisted values and old links but is no longer offered as a standalone navigation entry.
  */
  { id: "files", label: "Files", labelKey: "nav.files" },
  { id: "git-manager", label: "Git Manager", labelKey: "nav.gitManager" },
  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  FN-426 moves Secrets into Settings → project Secrets. The id stays registered so persisted view values, favorites,
  and `?view=secrets` links resolve; App routes them to the Settings section instead of a standalone page.
  */
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
