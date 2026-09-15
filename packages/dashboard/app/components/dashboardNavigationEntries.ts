import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import { Bot, Brain, Clock, Folder, FolderGit2, Gauge, Lightbulb, LayoutGrid, Mail, Monitor, PanelsTopLeft, Search, Settings, Sparkles, Target, Type, Workflow, Zap } from "lucide-react";
import type { PluginDashboardViewEntry } from "../api";
import type { TaskView } from "../hooks/useViewState";
import { buildPluginTaskViewId } from "../plugins/pluginViewRegistry";
import { getPluginDashboardViewNavIcon } from "./pluginNavIcon";
import { GithubIcon } from "./GithubIcon";

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
  planningNeedsInput?: boolean;
  /* FN-426: Dev Server is a primary-navigation destination now that the right dock no longer hosts it. */
  showDevServer?: boolean;
}

/*
FNXC:DesktopNavigation 2026-09-11-21:48:
The desktop footer owns primary navigation only. History remains on complete-column headers, while Chat and Notes belong to the explicit desktop right-dock host; removing those three footer entries prevents duplicate navigation owners without changing standard hosts.
*/
export function buildDashboardNavigationEntries(options: DashboardNavigationRegistryOptions): DashboardNavigationEntry[] {
  const page = (id: string, label: string, view: TaskView, icon: ComponentType<LucideProps>, placement: DashboardNavigationPlacement = "overflow"): DashboardNavigationEntry => ({ id, label, view, icon, kind: "main-page", placement, testId: `desktop-nav-${id}`, onSelect: () => options.onChangeView(view) });
  const direct = [
    page("command-center", "Dashboard", "command-center", Gauge, "direct"),
    page("board", "Board", "board", LayoutGrid, "direct"),
    page("planning", "Planning", "planning", Lightbulb, "direct"),
    page("missions", "Missions", "missions", Target, "direct"),
    ...(options.showAgents ? [page("agents", "Agents", "agents", Bot, "direct")] : []),
    { ...page("mailbox", "Mailbox", "mailbox", Mail, "direct"), badge: options.mailboxUnreadCount, dot: options.view !== "mailbox" && (options.mailboxPendingApprovalCount ?? 0) > 0 ? "pending" as const : undefined },
  ];
  const plugins = [...(options.pluginDashboardViews ?? [])].sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER)).map((entry) => {
    const view = entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
    return page(`plugin-${entry.pluginId}-${entry.view.viewId}`, entry.view.label, view, getPluginDashboardViewNavIcon(entry));
  });
  const overflow = [
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
    { id: "settings", label: "Settings", icon: Settings, kind: "existing-action" as const, placement: "external" as const, view: "settings" as TaskView, testId: "desktop-nav-settings", onSelect: options.onOpenSettings },
  ];
  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  FN-426 removes the `external-owner` tier entirely. It existed to declare destinations whose real owner was the right
  dock; with the dock optional, a destination owned by it would be unreachable whenever an operator leaves it off.
  Dev Server moved into the overflow above, Secrets into Settings, Pull Requests into the Git page.
  */
  return [...direct, ...overflow];
}
