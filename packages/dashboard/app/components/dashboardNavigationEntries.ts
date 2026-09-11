import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import { Bot, Brain, Clock, Gauge, History, Lightbulb, LayoutGrid, List, Mail, MessageSquare, PanelsTopLeft, Plus, Search, Settings, Sparkles, StickyNote, Target, Workflow, Zap } from "lucide-react";
import type { PluginDashboardViewEntry } from "../api";
import type { TaskView } from "../hooks/useViewState";
import { buildPluginTaskViewId } from "../plugins/pluginViewRegistry";
import { getPluginDashboardViewNavIcon } from "./pluginNavIcon";
import { GithubIcon } from "./GithubIcon";

export type DashboardNavigationKind = "pilot-window" | "main-page" | "existing-action" | "external-owner";
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
  onOpenPilot?: (view: "patchnode" | "notes") => void;
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
}

/*
FNXC:AlphaDesktopNavigation 2026-09-11-19:35:
Every desktop Alpha destination is explicitly classified before rendering. Only History and Notes are pilot windows; ordinary pages keep their current TaskView owner, New Task keeps its modal owner, and right-dock destinations remain external so no fallback can silently turn a destination into a window.
*/
export function buildDashboardNavigationEntries(options: DashboardNavigationRegistryOptions): DashboardNavigationEntry[] {
  const page = (id: string, label: string, view: TaskView, icon: ComponentType<LucideProps>, placement: DashboardNavigationPlacement = "overflow"): DashboardNavigationEntry => ({ id, label, view, icon, kind: "main-page", placement, testId: `alpha-desktop-nav-${id}`, onSelect: () => options.onChangeView(view) });
  const pilot = (id: "patchnode" | "notes", label: string, icon: ComponentType<LucideProps>): DashboardNavigationEntry => ({ id, label, view: id, icon, kind: "pilot-window", placement: "direct", testId: `alpha-desktop-nav-${id}`, onSelect: () => options.onOpenPilot?.(id) });
  const direct = [
    page("command-center", "Dashboard", "command-center", Gauge, "direct"),
    page("board", "Board", "board", LayoutGrid, "direct"),
    page("list", "List", "list", List, "direct"),
    pilot("patchnode", "History", History),
    page("planning", "Planning", "planning", Lightbulb, "direct"),
    page("missions", "Missions", "missions", Target, "direct"),
    ...(options.showAgents ? [page("agents", "Agents", "agents", Bot, "direct")] : []),
    { ...page("chat", "Chat", "chat", MessageSquare, "direct"), dot: options.chatHasUnreadResponse && options.view !== "chat" ? "pending" as const : undefined },
    { ...page("mailbox", "Mailbox", "mailbox", Mail, "direct"), badge: options.mailboxUnreadCount, dot: options.view !== "mailbox" && (options.mailboxPendingApprovalCount ?? 0) > 0 ? "pending" as const : undefined },
    pilot("notes", "Notes", StickyNote),
    { id: "new-task", label: "New Task", icon: Plus, kind: "existing-action" as const, placement: "direct" as const, testId: "alpha-desktop-nav-new-task", onSelect: options.onNewTask },
  ];
  const plugins = [...(options.pluginDashboardViews ?? [])].sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER)).map((entry) => {
    const view = entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
    return page(`plugin-${entry.pluginId}-${entry.view.viewId}`, entry.view.label, view, getPluginDashboardViewNavIcon(entry));
  });
  const overflow = [
    ...plugins,
    ...(options.showSkills ? [page("skills", "Skills & Snippets", "skills", Zap)] : []),
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
    { id: "settings", label: "Settings", icon: Settings, kind: "existing-action" as const, placement: "overflow" as const, view: "settings" as TaskView, testId: "alpha-desktop-nav-settings", onSelect: options.onOpenSettings },
  ];
  const external: DashboardNavigationEntry[] = [
    { id: "dev-server", label: "Dev Server", icon: PanelsTopLeft, kind: "external-owner", placement: "external", view: "devserver", testId: "right-dock-dev-server" },
    { id: "secrets", label: "Secrets", icon: Settings, kind: "external-owner", placement: "external", view: "secrets", testId: "right-dock-secrets" },
    { id: "pull-requests", label: "Pull Requests", icon: Workflow, kind: "external-owner", placement: "external", view: "pull-requests", testId: "right-dock-pull-requests" },
  ];
  return [...direct, ...overflow, ...external];
}
