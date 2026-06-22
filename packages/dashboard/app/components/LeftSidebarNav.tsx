import "./LeftSidebarNav.css";

/*
FNXC:Navigation 2026-06-19-00:00:
When the leftSidebarNav experiment is active, this component owns the non-mobile primary navigation destinations that Header previously exposed through inline and overflow view controls. Mobile remains owned by MobileNavBar, so this sidebar keeps the desktop/tablet contract only.
*/
import { useCallback, useMemo, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Brain,
  ChevronLeft,
  ChevronRight,
  FileText,
  Gauge,
  Lightbulb,
  LayoutGrid,
  List,
  Mail,
  MessageSquare,
  Monitor,
  Plus,
  Search,
  Settings,
  Sparkles,
  Target,
  Zap,
  type LucideProps,
} from "lucide-react";
import type { ProjectInfo, PluginDashboardViewEntry } from "../api";
import type { TaskView } from "../hooks/useViewState";
import { buildPluginTaskViewId } from "../plugins/pluginViewRegistry";
import { getPluginNavIcon } from "./pluginNavIcon";

export interface LeftSidebarExperimentalFeatures {
  insights?: boolean;
  memoryView?: boolean;
  devServerView?: boolean;
  researchView?: boolean;
  evalsView?: boolean;
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
  dot?: "pending" | "online";
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
  onNewTask?: () => void;
  onOpenSettings?: () => void;
  todosEnabled?: boolean;
  mailboxUnreadCount?: number;
  mailboxPendingApprovalCount?: number;
  chatHasUnreadResponse?: boolean;
  experimentalFeatures?: LeftSidebarExperimentalFeatures;
  pluginDashboardViews?: PluginDashboardViewEntry[];
  showAgentsTab?: boolean;
  showSkillsTab?: boolean;
  projects?: ProjectInfo[];
  currentProject?: ProjectInfo | null;
  onSelectProject?: (project: ProjectInfo) => void;
  onViewAllProjects?: () => void;
  footerVisible?: boolean;
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
  return entry.pluginId === "fusion-plugin-compound-engineering" ? "Compound" : entry.view.label;
}

export function LeftSidebarNav({
  view,
  onChangeView,
  onNewTask,
  onOpenSettings,
  mailboxUnreadCount = 0,
  mailboxPendingApprovalCount = 0,
  chatHasUnreadResponse = false,
  experimentalFeatures,
  pluginDashboardViews = [],
  showAgentsTab = false,
  showSkillsTab = false,
  footerVisible = false,
}: LeftSidebarNavProps) {
  const { t } = useTranslation("app");
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const [isCollapsed, setIsCollapsed] = useState(readStoredCollapsed);

  const toggleCollapsed = useCallback(() => {
    setIsCollapsed((current) => {
      const next = !current;
      persistCollapsed(next);
      return next;
    });
  }, []);

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

  const newTaskLabel = t("nav.newTask", "New Task");

  const primaryPluginViews = useMemo(
    () => sortPluginViews(pluginDashboardViews.filter((entry) => entry.view.placement === "primary")),
    [pluginDashboardViews],
  );
  const overflowPluginViews = useMemo(
    () => sortPluginViews(pluginDashboardViews.filter((entry) => entry.view.placement !== "primary")),
    [pluginDashboardViews],
  );

  const primaryEntries: SidebarNavEntry[] = [
    {
      id: "board",
      label: t("nav.board", "Board"),
      view: "board",
      isActive: view === "board",
      icon: LayoutGrid,
      testId: "sidebar-nav-board",
      onSelect: () => onChangeView("board"),
    },
    {
      id: "list",
      label: t("nav.list", "List"),
      view: "list",
      isActive: view === "list",
      icon: List,
      testId: "sidebar-nav-list",
      onSelect: () => onChangeView("list"),
    },
    ...(showAgentsTab
      ? [
          {
            id: "agents",
            label: t("nav.agents", "Agents"),
            view: "agents" as TaskView,
            isActive: view === "agents",
            icon: Bot,
            testId: "sidebar-nav-agents",
            onSelect: () => onChangeView("agents"),
          },
        ]
      : []),
    {
      id: "command-center",
      label: t("nav.commandCenter", "Command Center"),
      view: "command-center",
      isActive: view === "command-center",
      icon: Gauge,
      testId: "sidebar-nav-command-center",
      onSelect: () => onChangeView("command-center"),
    },
    {
      id: "planning",
      /*
      FNXC:Navigation 2026-06-21-00:00:
      FN-6886 makes Planning Mode a first-class sidebar destination immediately after Command Center so the experimental sidebar owns the desktop planning affordance.
      */
      label: t("nav.planning", "Planning"),
      view: "planning",
      isActive: view === "planning",
      icon: Lightbulb,
      testId: "sidebar-nav-planning",
      onSelect: () => onChangeView("planning"),
    },
    {
      id: "missions",
      label: t("nav.missions", "Missions"),
      view: "missions",
      isActive: view === "missions",
      icon: Target,
      testId: "sidebar-nav-missions",
      onSelect: () => onChangeView("missions"),
    },
    {
      id: "chat",
      label: t("nav.chat", "Chat"),
      view: "chat",
      isActive: view === "chat",
      icon: MessageSquare,
      testId: "sidebar-nav-chat",
      dot: chatHasUnreadResponse && view !== "chat" ? "pending" : undefined,
      onSelect: () => onChangeView("chat"),
    },
    {
      id: "documents",
      /*
      FNXC:Navigation 2026-06-21-18:25:
      FN-6890 renames the top-level Documents label to Artifacts while preserving the documents view id and sidebar-nav-documents test id.
      */
      label: t("nav.documents", "Artifacts"),
      view: "documents",
      isActive: view === "documents",
      icon: FileText,
      testId: "sidebar-nav-documents",
      onSelect: () => onChangeView("documents"),
    },
    {
      id: "mailbox",
      label: t("nav.mailbox", "Mailbox"),
      view: "mailbox",
      isActive: view === "mailbox",
      icon: Mail,
      testId: "sidebar-nav-mailbox",
      badge: mailboxUnreadCount > 0 ? mailboxUnreadCount : undefined,
      dot: view !== "mailbox" && mailboxPendingApprovalCount > 0 ? "pending" : view !== "mailbox" && mailboxUnreadCount > 0 ? "online" : undefined,
      onSelect: () => onChangeView("mailbox"),
    },
    ...primaryPluginViews.map((entry): SidebarNavEntry => {
      const PluginIcon = getPluginNavIcon(entry.view.icon);
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
    }),
  ];

  /*
  FNXC:Navigation 2026-06-21-00:00:
  Secrets and Todos are intentionally omitted from the left sidebar. They live in the right dock through RightDock/overflowViewRegistry, while mobile keeps its More-sheet entries and the Header opt-out layout keeps its overflow entries.
  */
  const secondaryEntries: SidebarNavEntry[] = [
    ...(experimentalFeatures?.evalsView
      ? [{ id: "evals", label: t("header.evalsView", "Evals"), view: "evals" as TaskView, isActive: view === "evals", icon: Target, testId: "sidebar-nav-evals", onSelect: () => onChangeView("evals") }]
      : []),
    ...(experimentalFeatures?.goalsView
      ? [{ id: "goals", label: t("header.goalsView", "Goals"), view: "goalsView" as TaskView, isActive: view === "goalsView", icon: Target, testId: "sidebar-nav-goals", onSelect: () => onChangeView("goalsView") }]
      : []),
    ...(experimentalFeatures?.researchView
      ? [{ id: "research", label: t("header.researchView", "Research"), view: "research" as TaskView, isActive: view === "research", icon: Search, testId: "sidebar-nav-research", onSelect: () => onChangeView("research") }]
      : []),
    ...(experimentalFeatures?.insights
      ? [{ id: "insights", label: t("header.insightsView", "Insights"), view: "insights" as TaskView, isActive: view === "insights", icon: Sparkles, testId: "sidebar-nav-insights", onSelect: () => onChangeView("insights") }]
      : []),
    ...(showSkillsTab
      ? [{ id: "skills", label: t("header.skillsView", "Skills"), view: "skills" as TaskView, isActive: view === "skills", icon: Zap, testId: "sidebar-nav-skills", onSelect: () => onChangeView("skills") }]
      : []),
    ...(experimentalFeatures?.memoryView
      ? [{ id: "memory", label: t("header.memoryView", "Memory"), view: "memory" as TaskView, isActive: view === "memory", icon: Brain, testId: "sidebar-nav-memory", onSelect: () => onChangeView("memory") }]
      : []),
    ...(experimentalFeatures?.devServerView
      ? [{ id: "devserver", label: t("header.devServerView", "Dev Server"), view: "devserver" as TaskView, isActive: view === "dev-server" || view === "devserver", icon: Monitor, testId: "sidebar-nav-devserver", onSelect: () => onChangeView("devserver") }]
      : []),
    ...overflowPluginViews.map((entry): SidebarNavEntry => {
      const PluginIcon = getPluginNavIcon(entry.view.icon);
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
    }),
  ];

  const renderEntry = (entry: SidebarNavEntry) => {
    const Icon = entry.icon;
    return (
      <button
        key={entry.id}
        type="button"
        className={`left-sidebar-nav__item${entry.isActive ? " left-sidebar-nav__item--active" : ""}`}
        aria-label={entry.label}
        aria-current={entry.isActive && entry.view ? "page" : undefined}
        title={entry.label}
        data-testid={entry.testId}
        onClick={entry.onSelect}
      >
        <span className="left-sidebar-nav__icon-wrap">
          <Icon size={16} />
          {entry.dot ? <span className={`status-dot status-dot--${entry.dot} left-sidebar-nav__dot`} aria-hidden="true" /> : null}
        </span>
        <span className="left-sidebar-nav__label">{entry.label}</span>
        {entry.badge ? <span className="btn-badge left-sidebar-nav__badge">{formatCount(entry.badge)}</span> : null}
      </button>
    );
  };

  return (
    <aside
      className={`left-sidebar-nav${isCollapsed ? " left-sidebar-nav--collapsed" : ""}${footerVisible ? " left-sidebar-nav--with-footer" : ""}`}
      data-testid="left-sidebar-nav"
      aria-label={t("nav.sidebarAriaLabel", "Sidebar navigation")}
      style={isCollapsed ? undefined : { width: sidebarWidth, minWidth: sidebarWidth }}
    >
      {onNewTask ? (
        <button
          type="button"
          className="btn left-sidebar-nav__item left-sidebar-nav__new-task"
          aria-label={newTaskLabel}
          title={newTaskLabel}
          data-testid="sidebar-nav-new-task"
          onClick={onNewTask}
        >
          <Plus size={16} />
          <span className="left-sidebar-nav__label">{newTaskLabel}</span>
        </button>
      ) : null}
      <nav className="left-sidebar-nav__list" aria-label={t("nav.primaryNavAriaLabel", "Primary navigation")}>
        <div className="left-sidebar-nav__section">{primaryEntries.map(renderEntry)}</div>
        <div className="left-sidebar-nav__section left-sidebar-nav__section--secondary">{secondaryEntries.map(renderEntry)}</div>
      </nav>

      <div className="left-sidebar-nav__footer">
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
          aria-label={t("header.settings", "Settings")}
          title={t("header.settings", "Settings")}
          data-testid="sidebar-nav-settings"
          onClick={onOpenSettings}
        >
          <Settings size={16} />
          <span className="left-sidebar-nav__label">{t("header.settings", "Settings")}</span>
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
