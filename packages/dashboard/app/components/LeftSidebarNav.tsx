import "./LeftSidebarNav.css";

/*
FNXC:Navigation 2026-06-19-00:00:
When the leftSidebarNav experiment is active, this component owns the non-mobile primary navigation destinations that Header previously exposed through inline and overflow view controls. Mobile remains owned by MobileNavBar, so this sidebar keeps the desktop/tablet contract only.
*/
import { useCallback, useEffect, useMemo, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Brain,
  ChevronLeft,
  ChevronRight,
  Clock,
  Folder,
  FolderGit2,
  Gauge,
  Lightbulb,
  LayoutGrid,
  Mail,
  MessageSquare,
  Monitor,
  PanelsTopLeft,
  Search,
  Settings,
  Sparkles,
  StickyNote,
  Target,
  Terminal,
  Workflow,
  Zap,
  type LucideProps,
} from "lucide-react";
import type { Task } from "@fusion/core";
import type { ProjectInfo, PluginDashboardViewEntry } from "../api";
import type { ExecutorColumnFlags } from "../hooks/useExecutorStats";
import { useExecutorStats } from "../hooks/useExecutorStats";
import { EngineControlMenu } from "./EngineControlMenu";
import type { TaskView } from "../hooks/useViewState";
import { buildPluginTaskViewId } from "../plugins/pluginViewRegistry";
import { getPluginDashboardViewNavIcon } from "./pluginNavIcon";
import { GithubIcon } from "./GithubIcon";
import { getDashboardViewLabel } from "../../src/shared/dashboard-views";
import { buildDashboardNavigationEntries } from "./dashboardNavigationEntries";
import { useDashboardWindowLandmark } from "../context/DashboardWindowManagerContext";

export interface LeftSidebarExperimentalFeatures {
  insights?: boolean;
  memoryView?: boolean;
  devServerView?: boolean;
  researchView?: boolean;
  evalsView?: boolean;
  ideationView?: boolean;
  whiteboardView?: boolean;
  goalsView?: boolean;
}

interface SidebarNavEntry {
  id: string;
  label: string;
  view?: TaskView;
  isActive: boolean;
  icon: ComponentType<LucideProps>;
  testId: string;
  badge?: number;
  badgeLabel?: string;
  alpha?: boolean;
  dot?: "pending" | "online";
  dotLabel?: string;
  onSelect: () => void;
}

/*
FNXC:Navigation 2026-06-20-00:00:
The experimental sidebar default is intentionally narrower than the original 256px layout so desktop/tablet navigation preserves more board content while keeping the existing resize clamps.

FNXC:Navigation 2026-06-21-00:00:
The minimum resizable width is lowered so users can recover board/content space without forcing full rail collapse. Keep the floor at the narrowest label-legible width; below this point users should switch to collapse/rail mode to preserve icons, badges, and labels.
*/
const LEFT_SIDEBAR_DEFAULT_WIDTH = 224;
const LEFT_SIDEBAR_MIN_WIDTH = 160;
const LEFT_SIDEBAR_MAX_WIDTH = 384;
const LEFT_SIDEBAR_WIDTH_STORAGE_KEY = "fusion:left-sidebar-width";
const LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY = "fusion:left-sidebar-collapsed";

function clampSidebarWidth(width: number): number {
  return Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.min(LEFT_SIDEBAR_MAX_WIDTH, width));
}

function readStoredSidebarWidth(): number {
  if (typeof window === "undefined") return LEFT_SIDEBAR_DEFAULT_WIDTH;
  const stored = window.localStorage.getItem(LEFT_SIDEBAR_WIDTH_STORAGE_KEY);
  const parsed = stored ? Number(stored) : NaN;
  return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : LEFT_SIDEBAR_DEFAULT_WIDTH;
}

function readStoredCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
}

function persistSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(LEFT_SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Ignore storage errors.
  }
}

function persistCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Ignore storage errors.
  }
}

export interface LeftSidebarNavProps {
  view: TaskView;
  onChangeView: (view: TaskView) => void;
  onNewTask?: (workflowId?: string | null) => void;
  onOpenSettings?: () => void;
  mailboxUnreadCount?: number;
  mailboxPendingApprovalCount?: number;
  chatHasUnreadResponse?: boolean;
  /*
  FNXC:Navigation 2026-07-05-00:00:
  Planning Mode "awaiting input" no longer shows a top-of-board banner (its Resume button did not reliably
  redirect). Instead this flag drives a yellow `status-dot--pending` dot on the Planning nav destination,
  mirroring `chatHasUnreadResponse` exactly, so the click target is always the working `planning` nav item.
  */
  planningNeedsInput?: boolean;
  experimentalFeatures?: LeftSidebarExperimentalFeatures;
  pluginDashboardViews?: PluginDashboardViewEntry[];
  showAgentsTab?: boolean;
  showSkillsTab?: boolean;
  projects?: ProjectInfo[];
  currentProject?: ProjectInfo | null;
  onSelectProject?: (project: ProjectInfo) => void;
  onViewAllProjects?: () => void;
  footerVisible?: boolean;
  /*
  FNXC:Navigation 2026-09-15-14:41:
  FN-419: in `sidebar` placement the shell has NO bottom bar, so the engine control menu and the Terminal action
  would otherwise lose their only wide entry point. The sidebar hosts them here instead. Because the two primary
  surfaces are mutually exclusive, `EngineControlMenu` can never be mounted twice at once.
  `DashboardWindowVisibilityToggle` is deliberately NOT relocated: the operator asked for that control to disappear
  in sidebar placement, and it remains footer-only (still rendered by `DesktopActionBar` and `ExecutorStatusBar`).
  */
  tasks?: Task[];
  projectId?: string;
  columnFlagsByTaskId?: ReadonlyMap<string, ExecutorColumnFlags>;
  onToggleTerminal?: () => void;
}

function formatCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function getPluginEntryView(entry: PluginDashboardViewEntry): TaskView {
  if (entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph") {
    return "graph";
  }
  return buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
}

function isPluginEntryActive(view: TaskView, entry: PluginDashboardViewEntry): boolean {
  const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
  return view === pluginTaskView || (view === "graph" && entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph");
}

function sortPluginViews(entries: PluginDashboardViewEntry[]): PluginDashboardViewEntry[] {
  return [...entries].sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER));
}

/*
FNXC:Navigation 2026-06-20-00:00:
Experimental sidebar plugin labels must read as plain navigation nouns without an appended "view" suffix. The Compound Engineering plugin is intentionally shortened to "Compound" so its label fits the narrower sidebar.
*/
function getSidebarPluginLabel(entry: PluginDashboardViewEntry): string {
  return entry.pluginId === "fusion-plugin-compound-engineering" ? "Compound Eng" : entry.view.label;
}

export function LeftSidebarNav({
  view,
  onChangeView,
  onNewTask,
  onOpenSettings,
  mailboxUnreadCount = 0,
  mailboxPendingApprovalCount = 0,
  chatHasUnreadResponse = false,
  planningNeedsInput = false,
  experimentalFeatures,
  pluginDashboardViews = [],
  showAgentsTab = false,
  showSkillsTab = false,
  footerVisible = false,
  tasks,
  projectId,
  columnFlagsByTaskId,
  onToggleTerminal,
}: LeftSidebarNavProps) {
  const { t } = useTranslation("app");
  /*
  FNXC:DashboardWindowBounds 2026-09-14-21:10:
  FN-394: the sidebar declares its own right edge so dashboard windows treat it as shell, not content.
  Collapsing, resizing, or unmounting it re-measures immediately and snapped columns re-split; the
  sidebar itself is never closed to make room for a window.
  */
  const dashboardWindowLeftNavRef = useDashboardWindowLandmark("left-nav");
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const [isCollapsed, setIsCollapsed] = useState(readStoredCollapsed);
  /*
  FNXC:Navigation 2026-06-23-02:15:
  Optimistic active highlight: when a nav item is clicked, paint the active color IMMEDIATELY instead of waiting for the (possibly lazy-loaded via Suspense) target view to mount and flip `isActive`. Without this the clicked row lingers on the hover/highlight color until the view swaps. `optimisticView` is set on click and cleared once the real `view` prop catches up.
  */
  const [optimisticView, setOptimisticView] = useState<string | null>(null);
  useEffect(() => {
    setOptimisticView(null);
  }, [view]);

  const toggleCollapsed = useCallback(() => {
    setIsCollapsed((current) => {
      const next = !current;
      persistCollapsed(next);
      return next;
    });
  }, []);

  /*
  FNXC:Navigation 2026-09-15-14:41:
  FN-419: the engine control trigger mirrors the footer's contract exactly — same `executor.engineControls` label and
  the same `running / maxConcurrent` trigger content — so moving the menu between placements does not change what an
  operator reads. The hook runs unconditionally (Rules of Hooks); the host renders only when a project is present.
  */
  const emptyTasks = useMemo<Task[]>(() => [], []);
  const { stats: executorStats, loading: executorStatsLoading, error: executorStatsError } = useExecutorStats(tasks ?? emptyTasks, projectId, columnFlagsByTaskId);
  const capacityText = executorStatsLoading
    ? t("commandCenter.controls.status.loading", "Loading…")
    : executorStatsError
      ? t("commandCenter.controls.concurrency.error", "Unable to load concurrency settings")
      : `${executorStats.runningTaskCount} / ${executorStats.maxConcurrent}`;
  const capacityLabel = `${t("executor.engineControls", "Engine controls")}: ${capacityText}`;

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isCollapsed) return;
    event.preventDefault();
    event.stopPropagation();

    const resizeHandle = event.currentTarget;
    if (typeof resizeHandle.setPointerCapture === "function") {
      resizeHandle.setPointerCapture(event.pointerId);
    }

    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;
    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      latestWidth = nextWidth;
      setSidebarWidth(nextWidth);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (typeof resizeHandle.releasePointerCapture === "function") {
        resizeHandle.releasePointerCapture(upEvent.pointerId);
      }
      document.body.style.userSelect = "";
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      persistSidebarWidth(latestWidth);
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }, [isCollapsed, sidebarWidth]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isCollapsed) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 48 : 16;
    const delta = event.key === "ArrowLeft" ? -step : step;
    const nextWidth = clampSidebarWidth(sidebarWidth + delta);
    setSidebarWidth(nextWidth);
    persistSidebarWidth(nextWidth);
  }, [isCollapsed, sidebarWidth]);

  /*
  FNXC:Navigation 2026-06-22-12:00:
  All plugin dashboard views are flattened into a single sorted pool. Placement no longer splits the sidebar into primary/secondary sections; the sidebar is now ONE explicitly-ordered list (FN navigation reorder). The dependency-graph and compound-engineering plugin views are hoisted into fixed positions (graph after List, compound after Goals), so they must be excluded from the trailing "remaining plugin views" append to avoid duplication.
  */
  const sortedPluginViews = useMemo(
    () => sortPluginViews(pluginDashboardViews),
    [pluginDashboardViews],
  );

  const mapPluginEntry = useCallback(
    (entry: PluginDashboardViewEntry): SidebarNavEntry => {
      const PluginIcon = getPluginDashboardViewNavIcon(entry);
      const targetView = getPluginEntryView(entry);
      return {
        id: `plugin-${entry.pluginId}-${entry.view.viewId}`,
        label: getSidebarPluginLabel(entry),
        view: targetView,
        isActive: isPluginEntryActive(view, entry),
        icon: PluginIcon,
        testId: `sidebar-nav-plugin-${entry.pluginId}-${entry.view.viewId}`,
        onSelect: () => onChangeView(targetView),
      };
    },
    [view, onChangeView],
  );

  const graphPluginEntry = sortedPluginViews.find(
    (entry) => entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph",
  );
  const compoundPluginEntry = sortedPluginViews.find(
    (entry) => entry.pluginId === "fusion-plugin-compound-engineering",
  );
  /*
  FNXC:RoadmapsNavigation 2026-07-19-12:00:
  The bundled registry now hosts the manifest-advertised roadmaps view. Keep it in the
  normal plugin pool so roadmap-item previews have a live callback navigation destination.
  */
  const remainingPluginViews = sortedPluginViews.filter(
    (entry) => entry !== graphPluginEntry && entry !== compoundPluginEntry,
  );

  /*
  FNXC:Navigation 2026-06-22-12:00:
  Single explicit sidebar order (top to bottom): dashboard, board, list, History, graph, planning, missions, agents, chat, mailbox, recommendations, skills, memory, Artifacts, goals, automation, import, workflows, insight, research, ideation, evals, then any remaining plugin views in their sorted order.

  Dev Server is intentionally absent: it moved to the right dock. Secrets and Todos remain omitted (they live in the right dock / mobile More-sheet / Header overflow).

  Flag gates preserved verbatim from the prior layout: agents (showAgentsTab), goals (goalsView), insight (insights), research (researchView), ideation (ideationView), skills (showSkillsTab), memory (memoryView), evals (evalsView). graph and compound are skipped when their plugin view is absent.

  */
  const navEntries: SidebarNavEntry[] = [
    /*
    FNXC:Navigation 2026-06-22-01:15:
    Command Center is labeled "Dashboard" and sits at the very top of the sidebar. The board remains the default view on load (useViewState initial taskView is still "board").
    */
    {
      id: "command-center",
      label: t("nav.commandCenter", getDashboardViewLabel("command-center")),
      view: "command-center",
      isActive: view === "command-center",
      icon: Gauge,
      testId: "sidebar-nav-command-center",
      onSelect: () => onChangeView("command-center"),
    },
    {
      id: "board",
      label: t("nav.board", getDashboardViewLabel("board")),
      view: "board",
      isActive: view === "board",
      icon: LayoutGrid,
      testId: "sidebar-nav-board",
      onSelect: () => onChangeView("board"),
    },
    /*
    FNXC:ListInRightDock 2026-09-14-04:42:
    FN-382: List is a right-dock tool on every non-mobile host, so this rail no longer offers it as a page. The phone
    navigation keeps both of its List producers.
    */
    ...(graphPluginEntry ? [mapPluginEntry(graphPluginEntry)] : []),
    /*
    FNXC:Navigation 2026-06-23-01:30:
    Planning and Missions sit directly below Graph and above Agents (moved up from after Memory) per user request, so the planning/mission destinations sit next to the structural Board/List/Graph group.
    */
    {
      id: "planning",
      label: t("nav.planning", getDashboardViewLabel("planning")),
      view: "planning",
      isActive: view === "planning",
      icon: Lightbulb,
      testId: "sidebar-nav-planning",
      // FNXC:Navigation 2026-07-05-00:00: mirrors the chat item's `dot` below — replaces the broken-Resume banner.
      dot: planningNeedsInput && view !== "planning" ? "pending" : undefined,
      onSelect: () => onChangeView("planning"),
    },
    {
      id: "missions",
      label: t("nav.missions", getDashboardViewLabel("missions")),
      view: "missions",
      isActive: view === "missions",
      icon: Target,
      testId: "sidebar-nav-missions",
      onSelect: () => onChangeView("missions"),
    },
    ...(showAgentsTab
      ? [
          {
            id: "agents",
            label: t("nav.agents", getDashboardViewLabel("agents")),
            view: "agents" as TaskView,
            isActive: view === "agents",
            icon: Bot,
            testId: "sidebar-nav-agents",
            onSelect: () => onChangeView("agents"),
          },
        ]
      : []),
    {
      id: "chat",
      label: t("nav.chat", getDashboardViewLabel("chat")),
      view: "chat",
      isActive: view === "chat",
      icon: MessageSquare,
      testId: "sidebar-nav-chat",
      dot: chatHasUnreadResponse && view !== "chat" ? "pending" : undefined,
      onSelect: () => onChangeView("chat"),
    },
    {
      id: "mailbox",
      label: t("nav.mailbox", getDashboardViewLabel("mailbox")),
      view: "mailbox",
      isActive: view === "mailbox",
      icon: Mail,
      testId: "sidebar-nav-mailbox",
      badge: mailboxUnreadCount > 0 ? mailboxUnreadCount : undefined,
      dot: view !== "mailbox" && mailboxPendingApprovalCount > 0 ? "pending" : view !== "mailbox" && mailboxUnreadCount > 0 ? "online" : undefined,
      onSelect: () => onChangeView("mailbox"),
    },
    ...(showSkillsTab
      ? [{ id: "skills", label: t("header.skillsView", getDashboardViewLabel("skills")), view: "skills" as TaskView, isActive: view === "skills", icon: Zap, testId: "sidebar-nav-skills", onSelect: () => onChangeView("skills") }]
      : []),
    ...(experimentalFeatures?.memoryView
      ? [{ id: "memory", label: t("header.memoryView", getDashboardViewLabel("memory")), view: "memory" as TaskView, isActive: view === "memory", icon: Brain, testId: "sidebar-nav-memory", onSelect: () => onChangeView("memory") }]
      : []),
    {
      id: "notes",
      label: t("nav.notes", getDashboardViewLabel("notes")),
      view: "notes",
      isActive: view === "notes",
      icon: StickyNote,
      testId: "sidebar-nav-notes",
      onSelect: () => onChangeView("notes"),
    },
    ...(experimentalFeatures?.whiteboardView
      ? [{ id: "whiteboard", label: t("nav.whiteboard", getDashboardViewLabel("whiteboard")), view: "whiteboard" as TaskView, isActive: view === "whiteboard", icon: PanelsTopLeft, testId: "sidebar-nav-whiteboard", alpha: true, onSelect: () => onChangeView("whiteboard") }]
      : []),
    ...(experimentalFeatures?.goalsView
      ? [{ id: "goals", label: t("header.goalsView", getDashboardViewLabel("goalsView")), view: "goalsView" as TaskView, isActive: view === "goalsView", icon: Target, testId: "sidebar-nav-goals", onSelect: () => onChangeView("goalsView") }]
      : []),
    /*
    FNXC:Navigation 2026-06-22-00:00 (reordered 2026-06-23-01:45):
    Workflows, Import Tasks, and Automations are left-sidebar destinations that load in the main content area (not modals). Import Tasks is the GitHub import view (labeled "Import Tasks", not "Import from GitHub"). Automations + Import Tasks sit directly ABOVE Compound Eng per user request.
    */
    /*
    FNXC:ToolSurfaces 2026-09-15-16:04:
    FN-426: Files and Git Manager are sidebar destinations too. They were the last two tools reachable only through the
    right dock, so this rail — which is a full replacement for the footer under `navigationPlacement: "sidebar"` — must
    offer them, otherwise turning the dock off would strand them on that placement. Pull Requests stays a Git section
    and Secrets stays a Settings section, so neither gains a rail entry.
    */
    {
      id: "files",
      label: t("nav.files", getDashboardViewLabel("files")),
      view: "files" as TaskView,
      isActive: view === "files",
      icon: Folder,
      testId: "sidebar-nav-files",
      onSelect: () => onChangeView("files"),
    },
    {
      id: "git-manager",
      label: t("nav.gitManager", getDashboardViewLabel("git-manager")),
      view: "git-manager" as TaskView,
      isActive: view === "git-manager",
      icon: FolderGit2,
      testId: "sidebar-nav-git-manager",
      onSelect: () => onChangeView("git-manager"),
    },
    ...(experimentalFeatures?.devServerView
      ? [{ id: "dev-server", label: t("nav.devServer", getDashboardViewLabel("dev-server")), view: "dev-server" as TaskView, isActive: view === "dev-server" || view === "devserver", icon: Monitor, testId: "sidebar-nav-dev-server", onSelect: () => onChangeView("dev-server") }]
      : []),
    {
      id: "automations",
      label: t("nav.automations", getDashboardViewLabel("automations")),
      view: "automations" as TaskView,
      isActive: view === "automations",
      icon: Clock,
      testId: "sidebar-nav-automations",
      onSelect: () => onChangeView("automations"),
    },
    {
      id: "import-tasks",
      label: t("nav.importTasks", getDashboardViewLabel("import-tasks")),
      view: "import-tasks" as TaskView,
      isActive: view === "import-tasks",
      icon: GithubIcon,
      testId: "sidebar-nav-import-tasks",
      onSelect: () => onChangeView("import-tasks"),
    },
    ...(compoundPluginEntry ? [mapPluginEntry(compoundPluginEntry)] : []),
    {
      id: "workflows",
      label: t("nav.workflows", getDashboardViewLabel("workflows")),
      view: "workflows" as TaskView,
      isActive: view === "workflows",
      icon: Workflow,
      testId: "sidebar-nav-workflows",
      onSelect: () => onChangeView("workflows"),
    },
    ...(experimentalFeatures?.insights
      ? [{ id: "insights", label: t("header.insightsView", getDashboardViewLabel("insights")), view: "insights" as TaskView, isActive: view === "insights", icon: Sparkles, testId: "sidebar-nav-insights", onSelect: () => onChangeView("insights") }]
      : []),
    ...(experimentalFeatures?.researchView
      ? [{ id: "research", label: t("header.researchView", getDashboardViewLabel("research")), view: "research" as TaskView, isActive: view === "research", icon: Search, testId: "sidebar-nav-research", onSelect: () => onChangeView("research") }]
      : []),
    ...(experimentalFeatures?.ideationView
      ? [{ id: "ideation", label: t("nav.ideation", getDashboardViewLabel("ideation")), view: "ideation" as TaskView, isActive: view === "ideation", icon: Lightbulb, testId: "sidebar-nav-ideation", onSelect: () => onChangeView("ideation") }]
      : []),
    ...(experimentalFeatures?.evalsView
      ? [{ id: "evals", label: t("header.evalsView", getDashboardViewLabel("evals")), view: "evals" as TaskView, isActive: view === "evals", icon: Target, testId: "sidebar-nav-evals", onSelect: () => onChangeView("evals") }]
      : []),
    ...remainingPluginViews.map(mapPluginEntry),
  ];

  const sharedRegistry = buildDashboardNavigationEntries({
    view,
    onChangeView,
    onNewTask: onNewTask ? () => onNewTask() : undefined,
    onOpenSettings,
    pluginDashboardViews,
    showAgents: showAgentsTab,
    showSkills: showSkillsTab,
    flags: { memory: experimentalFeatures?.memoryView, whiteboard: experimentalFeatures?.whiteboardView, goals: experimentalFeatures?.goalsView, insights: experimentalFeatures?.insights, research: experimentalFeatures?.researchView, ideation: experimentalFeatures?.ideationView, evals: experimentalFeatures?.evalsView },
    showDevServer: experimentalFeatures?.devServerView === true,
  });
  const sharedKinds = new Map(sharedRegistry.map((entry) => [entry.view ?? entry.id, entry.kind]));

  const renderEntry = (entry: SidebarNavEntry) => {
    const Icon = entry.icon;
    // Active the moment it's clicked (optimistic), then the real `view` confirms it.
    const isActive = entry.isActive || (optimisticView !== null && entry.view === optimisticView);
    return (
      <button
        key={entry.id}
        type="button"
        className={`left-sidebar-nav__item${isActive ? " left-sidebar-nav__item--active" : ""}`}
        aria-label={entry.label}
        aria-current={isActive && entry.view ? "page" : undefined}
        title={entry.label}
        data-testid={entry.testId}
        data-navigation-kind={sharedKinds.get(entry.view ?? entry.id)}
        onClick={() => {
          if (entry.view) setOptimisticView(entry.view);
          entry.onSelect();
        }}
      >
        <span className="left-sidebar-nav__icon-wrap">
          <Icon size={16} />
          {entry.dot ? (
            <span
              className={`status-dot status-dot--${entry.dot} left-sidebar-nav__dot`}
              aria-hidden={entry.dotLabel ? undefined : "true"}
              aria-label={entry.dotLabel}
            />
          ) : null}
        </span>
        <span className="left-sidebar-nav__label">{entry.label}</span>
        {entry.badge ? <span className="btn-badge left-sidebar-nav__badge" aria-label={entry.badgeLabel}>{formatCount(entry.badge)}</span> : null}
        {entry.alpha ? <span className="btn-badge left-sidebar-nav__badge">{t("common.alpha", "Alpha")}</span> : null}
      </button>
    );
  };

  return (
    <aside
      ref={dashboardWindowLeftNavRef}
      className={`left-sidebar-nav${isCollapsed ? " left-sidebar-nav--collapsed" : ""}${footerVisible ? " left-sidebar-nav--with-footer" : ""}`}
      data-testid="left-sidebar-nav"
      aria-label={t("nav.sidebarAriaLabel", "Sidebar navigation")}
      style={isCollapsed ? undefined : { width: sidebarWidth, minWidth: sidebarWidth }}
    >
      <nav className="left-sidebar-nav__list" aria-label={t("nav.primaryNavAriaLabel", "Primary navigation")}>
        <div className="left-sidebar-nav__section">{navEntries.map(renderEntry)}</div>
      </nav>

      <div className="left-sidebar-nav__footer">
        {/* FNXC:StandardizedViewActions 2026-09-13-21:43: New Task is header-owned; the navigation footer contains navigation chrome only and must never expose a duplicate creation mutation. */}
        {/*
        FNXC:Navigation 2026-09-15-14:41:
        FN-419 relocates the shell controls that have no other wide host in `sidebar` placement: the engine control
        menu and the Terminal action, both ABOVE Collapse. Omitting `onToggleTerminal` must leave no empty button
        shell. `DashboardWindowVisibilityToggle` is intentionally absent here — the operator asked for it to disappear
        with the bottom bar, and it stays owned by `DesktopActionBar`/`ExecutorStatusBar`.
        */}
        {projectId ? (
          <div className="left-sidebar-nav__capacity">
            <EngineControlMenu
              projectId={projectId}
              triggerContent={<span data-testid="sidebar-capacity-count">{capacityText}</span>}
              triggerLabel={capacityLabel}
            />
          </div>
        ) : null}
        {onToggleTerminal ? (
          <button
            type="button"
            className="btn left-sidebar-nav__item left-sidebar-nav__terminal"
            aria-label={t("nav.terminal", "Terminal")}
            title={t("nav.terminal", "Terminal")}
            data-testid="sidebar-nav-terminal"
            onClick={onToggleTerminal}
          >
            <Terminal size={16} />
            <span className="left-sidebar-nav__label">{t("nav.terminal", "Terminal")}</span>
          </button>
        ) : null}
        {/*
        FNXC:Navigation 2026-06-21-00:00:
        The sidebar collapse affordance belongs in the footer immediately above Settings, using the same row-item visual language. Expanded mode shows the Collapse label, while rail mode relies on the shared label-hiding rule so the button remains icon-only like Settings.
        */}
        <button
          type="button"
          className="btn left-sidebar-nav__item left-sidebar-nav__collapse-toggle"
          aria-label={isCollapsed ? t("nav.expandSidebar", "Expand sidebar") : t("nav.collapseSidebar", "Collapse sidebar")}
          title={isCollapsed ? t("nav.expandSidebar", "Expand sidebar") : t("nav.collapseSidebar", "Collapse sidebar")}
          aria-pressed={isCollapsed}
          data-testid="sidebar-nav-collapse-toggle"
          onClick={toggleCollapsed}
        >
          {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          <span className="left-sidebar-nav__label">{t("nav.collapse", "Collapse")}</span>
        </button>
        <button
          type="button"
          className="btn left-sidebar-nav__item left-sidebar-nav__settings"
          aria-label={t("header.settings", getDashboardViewLabel("settings"))}
          title={t("header.settings", getDashboardViewLabel("settings"))}
          data-testid="sidebar-nav-settings"
          /* FNXC:Navigation 2026-06-22-12:00: Wrap so React's MouseEvent is not forwarded as onOpenSettings' settingsInitialSection arg. */
          onClick={() => onOpenSettings?.()}
        >
          <Settings size={16} />
          <span className="left-sidebar-nav__label">{t("header.settings", getDashboardViewLabel("settings"))}</span>
        </button>
      </div>

      {!isCollapsed && (
        <div
          className="left-sidebar-nav__resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={LEFT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={LEFT_SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          aria-label={t("nav.resizeSidebar", "Resize sidebar")}
          tabIndex={0}
          data-testid="sidebar-nav-resize-handle"
          onPointerDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
        />
      )}
    </aside>
  );
}
