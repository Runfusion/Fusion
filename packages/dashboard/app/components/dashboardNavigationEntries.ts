import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import { Bot, Brain, Clock, Folder, FolderGit2, Gauge, Lightbulb, LayoutGrid, List, Mail, MessageSquare, Monitor, PanelsTopLeft, Search, Settings, Sparkles, Target, Type, Workflow, Zap } from "lucide-react";
import type { PluginDashboardViewEntry } from "../api";
import type { TaskView } from "../hooks/useViewState";
import { buildPluginTaskViewId } from "../plugins/pluginViewRegistry";
import { getPluginDashboardViewNavIcon } from "./pluginNavIcon";
import { GithubIcon } from "./GithubIcon";
import { resolveNavigationQuickAccessEntryIds } from "../../../core/src/board/mobile-nav-primary-items";

export type DashboardNavigationKind = "main-page" | "existing-action" | "external-owner";
export type DashboardNavigationPlacement = "direct" | "overflow" | "external";

export interface DashboardNavigationEntry {
  id: string;
  label: string;
  icon: ComponentType<LucideProps>;
  kind: DashboardNavigationKind;
  placement: DashboardNavigationPlacement;
  view?: TaskView;
  testId: string;
  badge?: number;
  dot?: "pending" | "online";
  onSelect?: () => void | boolean | Promise<void | boolean>;
  /*
  FNXC:DesktopNavigation 2026-09-17-16:53:
  FN-511 : champs d'accessibilité GÉNÉRIQUES pour une entrée qui n'ouvre pas une page mais une surface (panneau,
  menu). Ils existent pour qu'une telle entrée conserve exactement son contrat d'accessibilité quel que soit
  l'emplacement où l'hôte la rend (rangée directe, groupe de droite, menu « More »). Ils ne sont spécifiques à aucune
  destination : `active` sert à toute entrée dont l'état actif ne découle pas de la vue courante.
  */
  ariaHasPopup?: "dialog" | "menu";
  ariaExpanded?: boolean;
  ariaControls?: string;
  active?: boolean;
}

export interface DashboardNavigationRegistryOptions {
  view: TaskView;
  onChangeView: (view: TaskView) => void | boolean | Promise<void | boolean>;
  onNewTask?: () => void;
  onOpenSettings?: () => void | boolean | Promise<void | boolean>;
  pluginDashboardViews?: PluginDashboardViewEntry[];
  showAgents?: boolean;
  showSkills?: boolean;
  flags?: { memory?: boolean; whiteboard?: boolean; goals?: boolean; insights?: boolean; research?: boolean; ideation?: boolean; evals?: boolean };
  mailboxUnreadCount?: number;
  mailboxPendingApprovalCount?: number;
  chatHasUnreadResponse?: boolean;
  /*
  FNXC:DesktopNavigation 2026-09-17-16:53:
  FN-511 : le Chat est une destination ORDINAIRE de ce registre, donc l'hôte fournit son ouverture et son état comme
  pour toute autre entrée. L'entrée n'est construite que si `onOpenChatPanel` est fourni, donc aucun bouton orphelin
  n'apparaît quand aucun projet n'est sélectionné.
  */
  onOpenChatPanel?: () => void;
  chatPanelOpen?: boolean;
  chatPanelId?: string;
  planningNeedsInput?: boolean;
  /* FN-426: Dev Server is a primary-navigation destination now that the right dock no longer hosts it. */
  showDevServer?: boolean;
  /*
  FNXC:DesktopNavigation 2026-09-16-04:15:
  FN-446: the footer's direct row is derived from the project quick-access setting (`mobileNavPrimaryItems`) instead of
  a hardcoded list. Callers pass already-resolved REGISTRY entry ids, in display order; when omitted the registry falls
  back to the core-resolved default so every host (sidebar, tests) sees the same classification.
  */
  quickAccessEntryIds?: readonly string[];
}

/*
FNXC:DesktopNavigation 2026-09-11-21:48:
The desktop footer owns primary navigation only. History remains on complete-column headers, while Chat and Notes belong to the explicit desktop right-dock host; removing those three footer entries prevents duplicate navigation owners without changing standard hosts.
*/
export function buildDashboardNavigationEntries(options: DashboardNavigationRegistryOptions): DashboardNavigationEntry[] {
  const page = (id: string, label: string, view: TaskView, icon: ComponentType<LucideProps>, placement: DashboardNavigationPlacement = "overflow"): DashboardNavigationEntry => ({ id, label, view, icon, kind: "main-page", placement, testId: `desktop-nav-${id}`, onSelect: () => options.onChangeView(view) });
  /*
  FNXC:DesktopNavigation 2026-09-16-04:15:
  FN-446: these destinations no longer declare their own placement. They are the head of the natural page order, and
  the quick-access selection below decides which of ALL page entries become `direct`; Agents is an ordinary entry that
  simply is not selected by default any more, so it falls into the **More** menu without leaving an empty shell behind.
  */
  const leading = [
    page("command-center", "Dashboard", "command-center", Gauge),
    page("board", "Board", "board", LayoutGrid),
    page("planning", "Planning", "planning", Lightbulb),
    page("missions", "Missions", "missions", Target),
    ...(options.showAgents ? [page("agents", "Agents", "agents", Bot)] : []),
    { ...page("mailbox", "Mailbox", "mailbox", Mail), badge: options.mailboxUnreadCount, dot: options.view !== "mailbox" && (options.mailboxPendingApprovalCount ?? 0) > 0 ? "pending" as const : undefined },
    /*
    FNXC:DesktopNavigation 2026-09-17-16:53:
    FN-511 renverse FN-495 : le Chat EST une entrée de ce registre. L'invariant qui remplace l'ancienne interdiction est
    que ce registre en est l'UNIQUE propriétaire sur cet hôte : l'entrée est rendue exactement une fois (rangée directe
    quand la sélection résolue la contient, sinon menu « More »), et aucun second producteur de
    `desktop-nav-chat-panel` codé en dur ne peut exister dans la barre. Le Chat ouvre un panneau ancré, pas une page,
    donc il porte ses attributs de dialogue via les champs génériques ci-dessus ; `aria-controls` n'est déclaré que
    lorsque la popover est réellement montée.
    */
    ...(options.onOpenChatPanel ? [{
      id: "chat",
      label: "Chat",
      icon: MessageSquare,
      kind: "existing-action" as const,
      placement: "overflow" as const,
      testId: "desktop-nav-chat-panel",
      dot: options.chatHasUnreadResponse && !options.chatPanelOpen ? "pending" as const : undefined,
      active: options.chatPanelOpen,
      ariaHasPopup: "dialog" as const,
      ariaExpanded: Boolean(options.chatPanelOpen),
      ariaControls: options.chatPanelOpen ? options.chatPanelId : undefined,
      onSelect: options.onOpenChatPanel,
    }] : []),
  ];
  const plugins = [...(options.pluginDashboardViews ?? [])].sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER)).map((entry) => {
    const view = entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
    return page(`plugin-${entry.pluginId}-${entry.view.viewId}`, entry.view.label, view, getPluginDashboardViewNavIcon(entry));
  });
  const trailing = [
    /*
    FNXC:ToolSurfaces 2026-09-15-23:37:
    FN-439: List is an ordinary destination of the wide navigation again. FN-382 had evicted it on the assumption the
    right dock would always host it, and FN-426 then had to keep a standalone Header button alive as the only
    reachable producer. Putting it in the footer **More** menu (and back in the sidebar) is what allows the Header to
    stop producing it on tablet/desktop, leaving exactly one owner per host. It sits in `overflow`, not `direct`, so
    the primary rail keeps its existing six destinations unchanged.
    */
    page("list", "List", "list", List),
    ...plugins,
    /*
    FNXC:ToolSurfaces 2026-09-15-16:04:
    FN-426: Files, Git, and Dev Server become ordinary primary-navigation destinations. They were the last tools that
    existed only inside the right dock, so promoting them here is what allows the dock to be turned off without any
    feature becoming unreachable. Pull Requests is deliberately absent: it is a section of Git, not a destination.
    Secrets is deliberately absent: it lives in Settings → project Secrets.
    */
    page("files", "Files", "files", Folder),
    page("git-manager", "Git Manager", "git-manager", FolderGit2),
    ...(options.showDevServer ? [page("dev-server", "Dev Server", "dev-server", Monitor)] : []),
    ...(options.showSkills ? [page("skills", "Skills", "skills", Zap)] : []),
    ...(options.showSkills ? [page("snippets", "Snippets", "snippets", Type)] : []),
    ...(options.flags?.memory ? [page("memory", "Memory", "memory", Brain)] : []),
    ...(options.flags?.whiteboard ? [page("whiteboard", "Whiteboard", "whiteboard", PanelsTopLeft)] : []),
    ...(options.flags?.goals ? [page("goals", "Goals", "goalsView", Target)] : []),
    page("automations", "Automations", "automations", Clock),
    page("import-tasks", "Import Tasks", "import-tasks", GithubIcon),
    page("workflows", "Workflows", "workflows", Workflow),
    ...(options.flags?.insights ? [page("insights", "Insights", "insights", Sparkles)] : []),
    ...(options.flags?.research ? [page("research", "Research", "research", Search)] : []),
    ...(options.flags?.ideation ? [page("ideation", "Ideation", "ideation", Lightbulb)] : []),
    ...(options.flags?.evals ? [page("evals", "Evals", "evals", Target)] : []),
  ];
  const settingsEntry = { id: "settings", label: "Settings", icon: Settings, kind: "existing-action" as const, placement: "external" as const, view: "settings" as TaskView, testId: "desktop-nav-settings", onSelect: options.onOpenSettings };
  /*
  FNXC:DesktopNavigation 2026-09-16-04:15:
  FN-446: the direct row is the resolved quick-access selection, in the operator's persisted order, restricted to
  destinations that actually exist under their gates so a gated-off selection leaves no hole. Every other page entry
  keeps its natural relative order in `overflow`; Settings stays `external`.

  FNXC:DesktopNavigation 2026-09-17-16:53:
  FN-511 : le plafond est **5** créneaux configurables, et le cinquième est rendu par l'hôte dans la piste de droite du
  pied de page large — l'emplacement qu'occupait le bouton Chat codé en dur. Le Chat est une entrée ordinaire (voir le
  bloc ci-dessus), donc il traverse exactement la même classification `direct`/`overflow` que toute autre destination et
  ne peut apparaître qu'une seule fois par hôte.
  */
  const pages = [...leading, ...trailing];
  const quickAccessIds = options.quickAccessEntryIds ?? resolveNavigationQuickAccessEntryIds();
  const directIds = new Set<string>();
  const direct = quickAccessIds.reduce<DashboardNavigationEntry[]>((selected, entryId) => {
    const entry = directIds.has(entryId) ? undefined : pages.find((candidate) => candidate.id === entryId);
    if (entry) {
      directIds.add(entry.id);
      selected.push({ ...entry, placement: "direct" });
    }
    return selected;
  }, []);
  const overflow = pages.filter((entry) => !directIds.has(entry.id)).map((entry) => ({ ...entry, placement: "overflow" as const }));
  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  FN-426 removes the `external-owner` tier entirely. It existed to declare destinations whose real owner was the right
  dock; with the dock optional, a destination owned by it would be unreachable whenever an operator leaves it off.
  Dev Server moved into the overflow above, Secrets into Settings, Pull Requests into the Git page.
  */
  return [...direct, ...overflow, settingsEntry];
}
