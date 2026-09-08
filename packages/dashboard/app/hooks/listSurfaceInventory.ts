export type ListPagination = "server-cursor" | "server-offset-bounded" | "local-bounded" | "exempt";
export type ListDirection = "start" | "end" | "none";

export interface ListSurfaceInventoryEntry {
  id: string;
  hosts: readonly string[];
  pagination: ListPagination;
  virtualized: boolean;
  direction: ListDirection;
  tests: readonly string[];
  bound?: number;
  exemption?: string;
}

/*
FNXC:ListSurfaceInventory 2026-09-07-16:03:
Every dynamic dashboard collection that can grow without a product bound is registered here with its pagination owner, render-window contract, loading direction, and production-reachability test. Finite selectors and per-row disclosure controls stay explicit exemptions so the performance policy cannot accidentally turn menus into remote lists.
*/
export const LIST_SURFACE_INVENTORY: readonly ListSurfaceInventoryEntry[] = [
  { id: "board-columns", hosts: ["Board", "Column", "ListView"], pagination: "server-cursor", virtualized: true, direction: "end", tests: ["DoneColumn.history-pagination.integration", "Board.done-pagination", "Column", "list-view-windowing"] },
  { id: "chat-sessions", hosts: ["ChatView", "FloatingWindow", "RightDock", "mobile"], pagination: "server-cursor", virtualized: true, direction: "end", tests: ["ChatView.sessions-rooms", "ChatView.virtualization"] },
  { id: "direct-transcript", hosts: ["ChatView", "FloatingWindow", "RightDock", "mobile"], pagination: "server-cursor", virtualized: true, direction: "start", tests: ["ChatView.virtualization"] },
  { id: "planner-transcript", hosts: ["TaskPlannerChatTab", "expanded"], pagination: "server-cursor", virtualized: true, direction: "start", tests: ["TaskPlannerChatTab.virtualization"] },
  { id: "agent-logs", hosts: ["AgentLogViewer", "TaskDetailModal", "AgentDetailView"], pagination: "server-offset-bounded", virtualized: true, direction: "start", tests: ["AgentLogViewer.layout", "AgentDetailView.logs-tasks-runs"] },
  { id: "activity-logs", hosts: ["ActivityLogModal", "RightDock"], pagination: "server-cursor", virtualized: true, direction: "start", tests: ["ActivityLogModal"] },
  { id: "dev-server-logs", hosts: ["DevServerLogViewer"], pagination: "server-cursor", virtualized: true, direction: "start", tests: ["DevServerLogViewer"] },
  { id: "settings-sync-logs", hosts: ["SettingsSyncLog"], pagination: "local-bounded", virtualized: true, direction: "start", tests: ["SettingsSyncLog"], bound: 1_000 },
  { id: "recommendations", hosts: ["RecommendationsView", "InsightsView"], pagination: "server-offset-bounded", virtualized: true, direction: "end", tests: ["RecommendationsView", "InsightsView"], bound: 20 },
  { id: "patchnode", hosts: ["PatchnodeView"], pagination: "server-cursor", virtualized: true, direction: "end", tests: ["PatchnodeView"] },
  { id: "git-history", hosts: ["GitManagerModal"], pagination: "server-offset-bounded", virtualized: true, direction: "end", tests: ["GitManagerModal"] },
  { id: "missions", hosts: ["MissionManager"], pagination: "server-offset-bounded", virtualized: true, direction: "end", tests: ["MissionManager"] },
  { id: "agent-activity", hosts: ["AgentActivityPanel"], pagination: "server-cursor", virtualized: true, direction: "end", tests: ["AgentActivityPanel"] },
  { id: "static-selectors", hosts: ["select", "menus", "command-palette"], pagination: "exempt", virtualized: false, direction: "none", tests: ["listSurfaceInventory"], bound: 500, exemption: "Catalogues statiques ou plafonnés par leur fournisseur." },
  { id: "row-disclosures", hosts: ["ThinkingTrace", "ToolCallDetails"], pagination: "exempt", virtualized: false, direction: "none", tests: ["listSurfaceInventory"], bound: 1, exemption: "Développe le contenu d’une ligne existante et ne demande aucune page." },
] as const;

export function validateListSurfaceInventory(entries = LIST_SURFACE_INVENTORY): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) errors.push(`duplicate:${entry.id}`);
    ids.add(entry.id);
    if (entry.hosts.length === 0 || entry.tests.length === 0) errors.push(`unowned:${entry.id}`);
    if (entry.pagination === "exempt") {
      if (!entry.exemption || entry.bound === undefined || entry.direction !== "none") errors.push(`invalid-exemption:${entry.id}`);
    } else if (!entry.virtualized || entry.direction === "none") {
      errors.push(`unadapted:${entry.id}`);
    }
  }
  return errors;
}
