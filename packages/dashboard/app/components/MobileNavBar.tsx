import "./MobileNavBar.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  Brain,
  CheckSquare,
  ChevronRight,
  Clock,
  FileCode,
  FileText,
  Folder,
  Gauge,
  GitBranch,
  Grid3X3,
  History,
  LayoutGrid,
  Lightbulb,
  Loader2,
  Lock,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Play,
  Settings,
  Monitor,
  Network,
  Search,
  Sparkles,
  Target,
  Terminal,
  Workflow,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchScripts } from "../api";
import type { PluginDashboardViewEntry } from "../api";
import { useViewportMode } from "./Header";
import type { TaskView } from "../hooks/useViewState";
import { buildPluginTaskViewId, isPluginViewId } from "../plugins/pluginViewRegistry";
import { getPluginNavIcon } from "./pluginNavIcon";

export interface PublishedMobileNavHeightInput {
  navOffsetHeight: number;
  paddingBottom: number;
  tabHeights: number[];
}

export function computePublishedMobileNavHeight({
  navOffsetHeight,
  paddingBottom,
  tabHeights,
}: PublishedMobileNavHeightInput): number {
  const measuredTabHeight = Math.max(0, ...tabHeights.filter((height) => Number.isFinite(height)));
  if (measuredTabHeight > 0) {
    return Math.max(44, Math.ceil(measuredTabHeight));
  }

  const resolvedPaddingBottom = Number.isFinite(paddingBottom) ? paddingBottom : 0;
  const contentHeight = navOffsetHeight - resolvedPaddingBottom;
  return Math.max(44, Math.ceil(contentHeight));
}

export interface MobileNavBarProps {
  /** Current task view mode */
  view: TaskView;
  /** Change task view handler */
  onChangeView: (view: TaskView) => void;
  /** Whether the ExecutorStatusBar footer is visible */
  footerVisible: boolean;
  /** Whether any full-screen modal is currently open (hides the tab bar) */
  modalOpen?: boolean;
  /** Whether the on-screen mobile keyboard is open */
  keyboardOpen?: boolean;
  // Navigation handlers
  onOpenSettings?: () => void;
  onOpenActivityLog?: () => void;
  onOpenMailbox?: () => void;
  mailboxUnreadCount?: number;
  mailboxPendingApprovalCount?: number;
  chatHasUnreadResponse?: boolean;
  stashOrphanCount?: number;
  onOpenGitManager?: () => void;
  onOpenWorkflowEditor?: () => void;
  onOpenSchedules?: () => void;
  onOpenScripts?: () => void;
  onToggleTerminal?: () => void;
  onOpenFiles?: () => void;
  onOpenTodos?: () => void;
  todosOpen?: boolean;
  onOpenGitHubImport?: () => void;
  onOpenPlanning?: () => void;
  onResumePlanning?: () => void;
  activePlanningSessionCount?: number;
  onOpenUsage?: () => void;
  onRunScript?: (name: string, command: string) => void;
  projectId?: string;
  onViewAllProjects?: () => void;
  /** Whether to show the skills tab */
  showSkillsTab?: boolean;
  /** Experimental feature flags controlling visibility of nav items. */
  experimentalFeatures?: {
    insights?: boolean;
    memoryView?: boolean;
    devServer?: boolean;
    devServerView?: boolean;
    todoView?: boolean;
    researchView?: boolean;
    evalsView?: boolean;
    goalsView?: boolean;
    nodesView?: boolean;
  };
  onOpenNodes?: () => void;
  pluginDashboardViews?: PluginDashboardViewEntry[];
  shellConnectionControl?: ReactNode;
}

function GitHubLogo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

function formatCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function MobileNavBar({
  view,
  onChangeView,
  footerVisible,
  modalOpen = false,
  keyboardOpen = false,
  onOpenSettings,
  onOpenActivityLog,
  onOpenMailbox,
  mailboxUnreadCount = 0,
  mailboxPendingApprovalCount = 0,
  chatHasUnreadResponse = false,
  stashOrphanCount = 0,
  onOpenGitManager,
  onOpenWorkflowEditor,
  onOpenSchedules,
  onOpenScripts,
  onToggleTerminal,
  onOpenFiles,
  onOpenTodos,
  todosOpen = false,
  onOpenGitHubImport,
  onOpenPlanning,
  onResumePlanning,
  activePlanningSessionCount = 0,
  onOpenUsage,
  onRunScript,
  projectId,
  onViewAllProjects,
  showSkillsTab,
  experimentalFeatures,
  onOpenNodes,
  pluginDashboardViews = [],
  shellConnectionControl,
}: MobileNavBarProps) {
  const { t } = useTranslation("app");
  const mode = useViewportMode();
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isScriptsSubmenuOpen, setIsScriptsSubmenuOpen] = useState(false);
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);

  const scriptEntries = useMemo(
    () => Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b)),
    [scripts],
  );

  // Fetch scripts when the submenu opens
  useEffect(() => {
    if (!isScriptsSubmenuOpen) return;

    let cancelled = false;
    setScriptsLoading(true);

    fetchScripts(projectId)
      .then((data) => {
        if (!cancelled) setScripts(data);
      })
      .catch(() => {
        if (!cancelled) setScripts({});
      })
      .finally(() => {
        if (!cancelled) setScriptsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isScriptsSubmenuOpen, projectId]);

  const closeMore = useCallback(() => setIsMoreOpen(false), []);

  const handleMoreAction = useCallback(
    (callback?: () => void) => {
      closeMore();
      callback?.();
    },
    [closeMore],
  );

  useEffect(() => {
    if (!isMoreOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMoreOpen(false);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isMoreOpen]);

  useLayoutEffect(() => {
    const navEl = navRef.current;
    if (!navEl || typeof document === "undefined") {
      return;
    }

    const publishMeasuredHeight = () => {
      const computed = window.getComputedStyle(navEl);
      const paddingBottom = Number.parseFloat(computed.paddingBottom);
      const tabHeights = Array.from(navEl.querySelectorAll<HTMLElement>(".mobile-nav-tab"), (tab) => tab.getBoundingClientRect().height);
      const publishedHeight = computePublishedMobileNavHeight({
        navOffsetHeight: navEl.offsetHeight,
        paddingBottom,
        tabHeights,
      });
      document.documentElement.style.setProperty("--mobile-nav-height", `${publishedHeight}px`);
    };

    publishMeasuredHeight();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        publishMeasuredHeight();
      });
      observer.observe(navEl);
    }

    return () => {
      observer?.disconnect();
      document.documentElement.style.removeProperty("--mobile-nav-height");
    };
  }, []);

  if (mode !== "mobile" || modalOpen) {
    return null;
  }

  const planningHandler = activePlanningSessionCount > 0 && onResumePlanning ? onResumePlanning : onOpenPlanning;

  const skillsEnabled = Boolean(showSkillsTab);
  const todoViewEnabled = Boolean(experimentalFeatures?.todoView);

  // Keep optional primary tabs limited to preserve touch-target width.
  // Overflowed destinations remain available in the More sheet.
  const showSkillsTopLevel = skillsEnabled;
  const showSkillsInMore = skillsEnabled && !showSkillsTopLevel;
  const sortedPrimaryPluginViews = pluginDashboardViews
    .filter((entry) => entry.view.placement === "primary")
    .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER));
  /*
  FNXC:Navigation 2026-06-19-12:05:
  Mobile navigation adds Command Center as a fixed top-level tab immediately after Mailbox.
  Primary plugin tabs, including Compound Engineering, are demoted to the More sheet so touch targets stay wide and Command Center is not duplicated.
  */
  const MAX_PRIMARY_PLUGIN_TOP_LEVEL_TABS = 0;
  const topLevelPrimaryPluginViews = sortedPrimaryPluginViews.slice(0, MAX_PRIMARY_PLUGIN_TOP_LEVEL_TABS);
  const topLevelPluginViewKeys = new Set(
    topLevelPrimaryPluginViews.map((entry) => `${entry.pluginId}:${entry.view.viewId}`),
  );
  const overflowPluginViews = pluginDashboardViews
    .filter((entry) => !topLevelPluginViewKeys.has(`${entry.pluginId}:${entry.view.viewId}`))
    .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER));

  const isMoreActive =
    view === "documents"
    || (Boolean(experimentalFeatures?.evalsView) && view === "evals")
    || (Boolean(experimentalFeatures?.goalsView) && view === "goalsView")
    || view === "research"
    || view === "insights"
    || view === "memory"
    || view === "secrets"
    || view === "devserver"
    || view === "dev-server"
    || (todosOpen && todoViewEnabled)
    || (view === "skills" && !showSkillsTopLevel)
    || view === "graph"
    || view === "stash-recovery"
    || (isPluginViewId(view) && !topLevelPrimaryPluginViews.some((entry) => buildPluginTaskViewId(entry.pluginId, entry.view.viewId) === view));

  return (
    <>
      <nav
        ref={navRef}
        className={`mobile-nav-bar${footerVisible ? " mobile-nav-bar--with-footer" : ""}${keyboardOpen ? " mobile-nav-bar--keyboard-open" : ""}`}
        role="tablist"
        aria-label={t("nav.primaryNavAriaLabel", "Primary navigation")}
      >
        <button
          type="button"
          className={`mobile-nav-tab${view === "board" || view === "list" ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-tasks"
          role="tab"
          aria-selected={view === "board" || view === "list"}
          onClick={() => {
            // If already on a tasks view, stay there; otherwise go to board
            if (view === "board" || view === "list") {
              onChangeView(view);
            } else {
              onChangeView("board");
            }
          }}
        >
          <LayoutGrid />
          <span className="mobile-nav-tab-label">{t("nav.tasks", "Tasks")}</span>
        </button>

        <button
          type="button"
          className={`mobile-nav-tab${view === "agents" ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-agents"
          role="tab"
          aria-selected={view === "agents"}
          onClick={() => onChangeView("agents")}
        >
          <Bot />
          <span className="mobile-nav-tab-label">{t("nav.agents", "Agents")}</span>
        </button>

        <button
          type="button"
          className={`mobile-nav-tab${view === "missions" ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-missions"
          role="tab"
          aria-selected={view === "missions"}
          onClick={() => onChangeView("missions")}
        >
          <Target />
          <span className="mobile-nav-tab-label">{t("nav.missions", "Missions")}</span>
        </button>

        <button
          type="button"
          className={`mobile-nav-tab${view === "chat" ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-chat"
          role="tab"
          aria-selected={view === "chat"}
          onClick={() => onChangeView("chat")}
        >
          <span className="mobile-nav-tab-icon-wrapper">
            <MessageSquare />
            {chatHasUnreadResponse && view !== "chat" && (
              <span className="status-dot status-dot--pending mobile-nav-chat-unread-dot" aria-label={t("nav.chatUnreadAriaLabel", "Unread chat response")} />
            )}
          </span>
          <span className="mobile-nav-tab-label">{t("nav.chat", "Chat")}</span>
        </button>


        <button
          type="button"
          className={`mobile-nav-tab${view === "mailbox" ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-mailbox"
          role="tab"
          aria-selected={view === "mailbox"}
          onClick={() => onChangeView("mailbox")}
        >
          <span className="mobile-nav-tab-icon-wrapper">
            <Mail />
            {mailboxPendingApprovalCount > 0 && view !== "mailbox" && (
              <span className="status-dot status-dot--pending mobile-nav-chat-unread-dot" aria-label={t("nav.mailboxPendingAriaLabel", "Pending approvals")} />
            )}
          </span>
          <span className="mobile-nav-tab-label">{t("nav.mailbox", "Mailbox")}</span>
          {mailboxUnreadCount > 0 && (
            <span className="mobile-nav-tab-badge">{formatCount(mailboxUnreadCount)}</span>
          )}
        </button>

        <button
          type="button"
          className={`mobile-nav-tab${view === "command-center" ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-command-center"
          role="tab"
          aria-selected={view === "command-center"}
          onClick={() => onChangeView("command-center")}
        >
          <Gauge />
          <span className="mobile-nav-tab-label">{t("nav.commandCenter", "Command Center")}</span>
        </button>

        {showSkillsTopLevel && (
          <button
            type="button"
            className={`mobile-nav-tab${view === "skills" ? " mobile-nav-tab--active" : ""}`}
            data-testid="mobile-nav-tab-skills"
            role="tab"
            aria-selected={view === "skills"}
            onClick={() => onChangeView("skills")}
          >
            <Zap />
            <span className="mobile-nav-tab-label">{t("nav.skills", "Skills")}</span>
          </button>
        )}


        {topLevelPrimaryPluginViews.map((entry) => {
          const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
          const PluginIcon = getPluginNavIcon(entry.view.icon);
          return (
            <button
              key={`${entry.pluginId}:${entry.view.viewId}`}
              type="button"
              className={`mobile-nav-tab${view === pluginTaskView || (view === "graph" && entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph") ? " mobile-nav-tab--active" : ""}`}
              data-testid={`mobile-nav-tab-plugin-${entry.pluginId}-${entry.view.viewId}`}
              role="tab"
              aria-selected={view === pluginTaskView || (view === "graph" && entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph")}
              onClick={() => onChangeView(entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : pluginTaskView)}
            >
              <PluginIcon />
              <span className="mobile-nav-tab-label">{entry.view.label}</span>
            </button>
          );
        })}

        <button
          type="button"
          className={`mobile-nav-tab${isMoreActive ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-more"
          role="tab"
          aria-selected={false}
          onClick={() => setIsMoreOpen((prev) => !prev)}
        >
          <MoreHorizontal />
          <span className="mobile-nav-tab-label">{t("nav.more", "More")}</span>
        </button>
      </nav>

      {isMoreOpen && (
        <>
          <div
            className="mobile-more-sheet-backdrop"
            onClick={closeMore}
          />
          <div className="mobile-more-sheet">
            <div className="mobile-more-sheet-handle" />
            <div className="mobile-more-sheet-title">{t("nav.moreSheetTitle", "Navigate")}</div>

            {shellConnectionControl ? (
              <div className="mobile-more-shell-connection" data-testid="mobile-more-shell-connection">
                {shellConnectionControl}
              </div>
            ) : null}

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-mailbox"
              onClick={() => handleMoreAction(onOpenMailbox)}
            >
              <Mail />
              <span>{t("nav.mailbox", "Mailbox")}</span>
              {mailboxUnreadCount > 0 && (
                <span className="mobile-more-item-badge mobile-more-item-badge--unread">{formatCount(mailboxUnreadCount)}</span>
              )}
              {mailboxPendingApprovalCount > 0 && (
                <span className="mobile-more-item-badge">{formatCount(mailboxPendingApprovalCount)}</span>
              )}
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-activity"
              onClick={() => handleMoreAction(onOpenActivityLog)}
            >
              <Activity />
              <span>{t("nav.activityLog", "Activity Log")}</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-git"
              onClick={() => handleMoreAction(onOpenGitManager)}
            >
              <GitBranch />
              <span>{t("nav.gitManager", "Git Manager")}</span>
            </button>

            <div className="mobile-more-split-row">
              <button
                type="button"
                className="mobile-more-item mobile-more-split-primary"
                data-testid="mobile-more-item-terminal"
                onClick={() => handleMoreAction(onToggleTerminal)}
              >
                <Terminal />
                <span>{t("nav.terminal", "Terminal")}</span>
              </button>
              <button
                type="button"
                className="mobile-more-split-toggle"
                data-testid="mobile-more-terminal-split-toggle"
                onClick={() => setIsScriptsSubmenuOpen((prev) => !prev)}
                aria-expanded={isScriptsSubmenuOpen}
                aria-haspopup="menu"
                aria-label={t("nav.showScriptsAriaLabel", "Show scripts")}
              >
                <ChevronRight
                  size={14}
                  className={`mobile-more-chevron${isScriptsSubmenuOpen ? " mobile-more-chevron--open" : ""}`}
                />
              </button>
            </div>
            {isScriptsSubmenuOpen && (
              <div className="mobile-more-submenu" role="menu" aria-label={t("nav.scriptsSubmenuAriaLabel", "Scripts submenu")}>
                {scriptsLoading ? (
                  <div className="mobile-more-submenu-loading" data-testid="mobile-more-scripts-loading">
                    <Loader2 className="animate-spin" />
                    <span>{t("nav.loadingScripts", "Loading scripts…")}</span>
                  </div>
                ) : scriptEntries.length > 0 ? (
                  <>
                    {scriptEntries.map(([name, command]) => (
                      <button
                        key={name}
                        type="button"
                        className="mobile-more-item mobile-more-subitem"
                        data-testid={`mobile-more-script-item-${name}`}
                        onClick={() => {
                          if (onRunScript) onRunScript(name, command);
                          closeMore();
                          setIsScriptsSubmenuOpen(false);
                        }}
                      >
                        <Play />
                        <span>{name}</span>
                      </button>
                    ))}
                    {onOpenScripts && (
                      <button
                        type="button"
                        className="mobile-more-item mobile-more-subitem mobile-more-subitem--manage"
                        data-testid="mobile-more-scripts-manage"
                        onClick={() => {
                          closeMore();
                          setIsScriptsSubmenuOpen(false);
                          onOpenScripts();
                        }}
                      >
                        <FileCode />
                        <span>{t("nav.manageScripts", "Manage Scripts…")}</span>
                      </button>
                    )}
                  </>
                ) : (
                  onOpenScripts && (
                    <button
                      type="button"
                      className="mobile-more-item mobile-more-subitem"
                      data-testid="mobile-more-scripts-manage"
                      onClick={() => {
                        closeMore();
                        setIsScriptsSubmenuOpen(false);
                        onOpenScripts();
                      }}
                    >
                      <FileCode />
                      <span>{t("nav.noScriptsAddOne", "No scripts — add one…")}</span>
                    </button>
                  )
                )}
              </div>
            )}

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-files"
              onClick={() => handleMoreAction(onOpenFiles)}
            >
              <Folder />
              <span>{t("nav.files", "Files")}</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-planning"
              onClick={() => handleMoreAction(planningHandler)}
            >
              <Lightbulb />
              <span>{t("nav.planning", "Planning")}</span>
              {activePlanningSessionCount > 0 && (
                <span className="mobile-more-item-badge">{formatCount(activePlanningSessionCount)}</span>
              )}
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-workflow"
              onClick={() => handleMoreAction(onOpenWorkflowEditor)}
            >
              <Workflow />
              <span>{t("nav.workflows", "Workflows")}</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-schedules"
              onClick={() => handleMoreAction(onOpenSchedules)}
            >
              <Clock />
              <span>{t("nav.automation", "Automation")}</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-github"
              onClick={() => handleMoreAction(onOpenGitHubImport)}
            >
              <GitHubLogo />
              <span>{t("nav.importFromGitHub", "Import from GitHub")}</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-usage"
              onClick={() => handleMoreAction(onOpenUsage)}
            >
              <Activity />
              <span>{t("nav.usage", "Usage")}</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-projects"
              onClick={() => handleMoreAction(onViewAllProjects)}
            >
              <Grid3X3 />
              <span>{t("nav.projects", "Projects")}</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-documents"
              onClick={() => handleMoreAction(() => onChangeView("documents"))}
            >
              <FileText />
              <span>{t("nav.documents", "Documents")}</span>
            </button>

            {experimentalFeatures?.evalsView && (
              <button
                type="button"
                className="mobile-more-item"
                data-testid="mobile-more-item-evals"
                onClick={() => handleMoreAction(() => onChangeView("evals"))}
              >
                <Target />
                <span>{t("nav.evals", "Evals")}</span>
              </button>
            )}
            {experimentalFeatures?.goalsView && (
              <button
                type="button"
                className="mobile-more-item"
                data-testid="mobile-more-item-goals"
                onClick={() => handleMoreAction(() => onChangeView("goalsView"))}
              >
                <Target />
                <span>{t("nav.goals", "Goals")}</span>
              </button>
            )}

            {showSkillsInMore && (
              <button
                type="button"
                className="mobile-more-item"
                data-testid="mobile-more-item-skills"
                onClick={() => handleMoreAction(() => onChangeView("skills"))}
              >
                <Zap />
                <span>{t("nav.skills", "Skills")}</span>
              </button>
            )}



            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-stash-recovery"
              onClick={() => handleMoreAction(() => onChangeView("stash-recovery"))}
            >
              <History />
              <span>{t("nav.stashRecovery", "Stash Recovery")}</span>
              {stashOrphanCount > 0 ? <span className="mobile-more-item-badge">{formatCount(stashOrphanCount)}</span> : null}
            </button>

            {experimentalFeatures?.researchView && (
              <button
                type="button"
                className="mobile-more-item"
                data-testid="mobile-more-item-research"
                onClick={() => handleMoreAction(() => onChangeView("research"))}
              >
                <Search />
                <span>{t("nav.research", "Research")}</span>
              </button>
            )}

            {experimentalFeatures?.insights && (
              <button
                type="button"
                className="mobile-more-item"
                data-testid="mobile-more-item-insights"
                onClick={() => handleMoreAction(() => onChangeView("insights"))}
              >
                <Sparkles />
                <span>{t("nav.insights", "Insights")}</span>
              </button>
            )}

            {experimentalFeatures?.memoryView && (
              <button
                type="button"
                className="mobile-more-item"
                data-testid="mobile-more-item-memory"
                onClick={() => handleMoreAction(() => onChangeView("memory"))}
              >
                <Brain />
                <span>{t("nav.memory", "Memory")}</span>
              </button>
            )}

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-secrets"
              onClick={() => handleMoreAction(() => onChangeView("secrets"))}
            >
              <Lock />
              <span>{t("nav.secrets", "Secrets")}</span>
            </button>

            {experimentalFeatures?.devServerView && (
              <button
                type="button"
                className="mobile-more-item"
                data-testid="mobile-more-item-dev-server"
                onClick={() => {
                  handleMoreAction(() => onChangeView("dev-server"));
                }}
              >
                <Monitor />
                <span>{t("nav.devServer", "Dev Server")}</span>
              </button>
            )}

            {experimentalFeatures?.nodesView && onOpenNodes && (
              <button
                type="button"
                className="mobile-more-item"
                data-testid="mobile-more-item-nodes"
                onClick={() => handleMoreAction(onOpenNodes)}
              >
                <Network />
                <span>{t("nav.nodes", "Nodes")}</span>
              </button>
            )}

            {todoViewEnabled && (
              <button
                type="button"
                className="mobile-more-item"
                data-testid="mobile-more-item-todos"
                onClick={() => handleMoreAction(() => onOpenTodos?.())}
              >
                <CheckSquare />
                <span>{t("nav.todos", "Todos")}</span>
              </button>
            )}

            {overflowPluginViews.map((entry) => {
                const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
                const PluginIcon = getPluginNavIcon(entry.view.icon);
                return (
                  <button
                    key={`${entry.pluginId}:${entry.view.viewId}`}
                    type="button"
                    className="mobile-more-item"
                    data-testid={`mobile-more-item-plugin-${entry.pluginId}-${entry.view.viewId}`}
                    onClick={() => handleMoreAction(() => onChangeView(entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : pluginTaskView))}
                  >
                    <PluginIcon />
                    <span>{entry.view.label}</span>
                  </button>
                );
              })}

            <div className="mobile-more-separator" />

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-settings"
              onClick={() => handleMoreAction(onOpenSettings)}
            >
              <Settings />
              <span>{t("nav.settings", "Settings")}</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}
