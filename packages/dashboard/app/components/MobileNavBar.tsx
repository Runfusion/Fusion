import "./MobileNavBar.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
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
  GitBranch,
  Grid3X3,
  LayoutGrid,
  Lightbulb,
  Loader2,
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
  Map,
  Zap,
} from "lucide-react";
import { fetchScripts } from "../api";
import type { PluginDashboardViewEntry } from "../api";
import { useViewportMode } from "./Header";
import type { TaskView } from "../hooks/useViewState";
import { buildPluginTaskViewId, isPluginViewId } from "../plugins/pluginViewRegistry";
import { getPluginNavIcon } from "./pluginNavIcon";

export interface MobileNavBarProps {
  /** Current task view mode */
  view: TaskView;
  /** Change task view handler */
  onChangeView: (view: TaskView) => void;
  /** Whether the ExecutorStatusBar footer is visible */
  footerVisible: boolean;
  /** Whether any full-screen modal is currently open (hides the tab bar) */
  modalOpen?: boolean;
  /** Whether the on-screen mobile keyboard is open (hides the tab bar) */
  keyboardOpen?: boolean;
  // Navigation handlers
  onOpenSettings?: () => void;
  onOpenActivityLog?: () => void;
  onOpenSystemStats?: () => void;
  onOpenMailbox?: () => void;
  mailboxUnreadCount?: number;
  onOpenGitManager?: () => void;
  onOpenWorkflowSteps?: () => void;
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
    roadmap?: boolean;
    memoryView?: boolean;
    devServer?: boolean;
    devServerView?: boolean;
    todoView?: boolean;
    researchView?: boolean;
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
  onOpenSystemStats,
  onOpenMailbox,
  mailboxUnreadCount = 0,
  onOpenGitManager,
  onOpenWorkflowSteps,
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
  const mode = useViewportMode();
  void shellConnectionControl;
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isScriptsSubmenuOpen, setIsScriptsSubmenuOpen] = useState(false);
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [scriptsLoading, setScriptsLoading] = useState(false);

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

  if (mode !== "mobile" || modalOpen || keyboardOpen) {
    return null;
  }

  const planningHandler = activePlanningSessionCount > 0 && onResumePlanning ? onResumePlanning : onOpenPlanning;

  const hasRoadmapsPluginView = pluginDashboardViews.some((entry) => entry.pluginId === "fusion-plugin-roadmap");
  const roadmapEnabled = Boolean(experimentalFeatures?.roadmap) && !hasRoadmapsPluginView;
  const skillsEnabled = Boolean(showSkillsTab);
  const todoViewEnabled = Boolean(experimentalFeatures?.todoView);

  // Keep a maximum of one optional primary tab visible at once to preserve touch-target width.
  // Overflowed destinations remain available in the More sheet.
  const showRoadmapsTopLevel = roadmapEnabled && (!skillsEnabled || view === "roadmaps");
  const showSkillsTopLevel = skillsEnabled && (!roadmapEnabled || view !== "roadmaps");
  const showSkillsInMore = skillsEnabled && !showSkillsTopLevel;
  const isDependencyGraphView = (entry: PluginDashboardViewEntry): boolean => (
    entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph"
  );
  const sortedPrimaryPluginViews = pluginDashboardViews
    .filter((entry) => entry.view.placement === "primary")
    .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER));
  const dependencyGraphPluginView = pluginDashboardViews.find(isDependencyGraphView) ?? null;
  // Keep plugin-provided top-level tabs constrained on mobile so fixed tabs retain
  // reasonable touch-target width. Additional primary plugin destinations overflow into More.
  // FN-3235: Always surface the dependency graph destination as the first plugin top-level tab
  // on mobile so task graph navigation has a clear entry point.
  const prioritizedPrimaryPluginViews = dependencyGraphPluginView
    ? [dependencyGraphPluginView, ...sortedPrimaryPluginViews.filter((entry) => !isDependencyGraphView(entry))]
    : sortedPrimaryPluginViews;
  const MAX_PRIMARY_PLUGIN_TOP_LEVEL_TABS = 1;
  const topLevelPrimaryPluginViews = prioritizedPrimaryPluginViews.slice(0, MAX_PRIMARY_PLUGIN_TOP_LEVEL_TABS);
  const topLevelPluginViewKeys = new Set(
    topLevelPrimaryPluginViews.map((entry) => `${entry.pluginId}:${entry.view.viewId}`),
  );
  const overflowPluginViews = pluginDashboardViews
    .filter((entry) => !topLevelPluginViewKeys.has(`${entry.pluginId}:${entry.view.viewId}`))
    .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER));

  const isMoreActive =
    view === "documents"
    || view === "research"
    || view === "insights"
    || view === "memory"
    || view === "devserver"
    || view === "dev-server"
    || (todosOpen && todoViewEnabled)
    || (view === "roadmaps" && !showRoadmapsTopLevel)
    || (view === "skills" && !showSkillsTopLevel)
    || (isPluginViewId(view) && !topLevelPrimaryPluginViews.some((entry) => buildPluginTaskViewId(entry.pluginId, entry.view.viewId) === view));

  return (
    <>
      <nav
        className={`mobile-nav-bar${footerVisible ? " mobile-nav-bar--with-footer" : ""}`}
        role="tablist"
        aria-label="Primary navigation"
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
          <span className="mobile-nav-tab-label">Tasks</span>
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
          <span className="mobile-nav-tab-label">Agents</span>
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
          <span className="mobile-nav-tab-label">Missions</span>
        </button>

        <button
          type="button"
          className={`mobile-nav-tab${view === "chat" ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-chat"
          role="tab"
          aria-selected={view === "chat"}
          onClick={() => onChangeView("chat")}
        >
          <MessageSquare />
          <span className="mobile-nav-tab-label">Chat</span>
        </button>


        <button
          type="button"
          className={`mobile-nav-tab${view === "mailbox" ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-mailbox"
          role="tab"
          aria-selected={view === "mailbox"}
          onClick={() => onChangeView("mailbox")}
        >
          <Mail />
          <span className="mobile-nav-tab-label">Mailbox</span>
          {mailboxUnreadCount > 0 && (
            <span className="mobile-nav-tab-badge">{formatCount(mailboxUnreadCount)}</span>
          )}
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
            <span className="mobile-nav-tab-label">Skills</span>
          </button>
        )}

        {showRoadmapsTopLevel && (
          <button
            type="button"
            className={`mobile-nav-tab${view === "roadmaps" ? " mobile-nav-tab--active" : ""}`}
            data-testid="mobile-nav-tab-roadmaps"
            role="tab"
            aria-selected={view === "roadmaps"}
            onClick={() => onChangeView("roadmaps")}
          >
            <Map />
            <span className="mobile-nav-tab-label">Roadmaps</span>
          </button>
        )}

        {topLevelPrimaryPluginViews.map((entry) => {
          const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
          const PluginIcon = getPluginNavIcon(entry.view.icon);
          return (
            <button
              key={`${entry.pluginId}:${entry.view.viewId}`}
              type="button"
              className={`mobile-nav-tab${view === pluginTaskView ? " mobile-nav-tab--active" : ""}`}
              data-testid={`mobile-nav-tab-plugin-${entry.pluginId}-${entry.view.viewId}`}
              role="tab"
              aria-selected={view === pluginTaskView}
              onClick={() => onChangeView(pluginTaskView)}
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
          <span className="mobile-nav-tab-label">More</span>
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
            <div className="mobile-more-sheet-title">Navigate</div>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-mailbox"
              onClick={() => handleMoreAction(onOpenMailbox)}
            >
              <Mail />
              <span>Mailbox</span>
              {mailboxUnreadCount > 0 && (
                <span className="mobile-more-item-badge mobile-more-item-badge--unread">{formatCount(mailboxUnreadCount)}</span>
              )}
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-activity"
              onClick={() => handleMoreAction(onOpenActivityLog)}
            >
              <Activity />
              <span>Activity Log</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-system-stats"
              onClick={() => handleMoreAction(onOpenSystemStats)}
            >
              <Monitor />
              <span>System Stats</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-git"
              onClick={() => handleMoreAction(onOpenGitManager)}
            >
              <GitBranch />
              <span>Git Manager</span>
            </button>

            <div className="mobile-more-split-row">
              <button
                type="button"
                className="mobile-more-item mobile-more-split-primary"
                data-testid="mobile-more-item-terminal"
                onClick={() => handleMoreAction(onToggleTerminal)}
              >
                <Terminal />
                <span>Terminal</span>
              </button>
              <button
                type="button"
                className="mobile-more-split-toggle"
                data-testid="mobile-more-terminal-split-toggle"
                onClick={() => setIsScriptsSubmenuOpen((prev) => !prev)}
                aria-expanded={isScriptsSubmenuOpen}
                aria-haspopup="menu"
                aria-label="Show scripts"
              >
                <ChevronRight
                  size={14}
                  className={`mobile-more-chevron${isScriptsSubmenuOpen ? " mobile-more-chevron--open" : ""}`}
                />
              </button>
            </div>
            {isScriptsSubmenuOpen && (
              <div className="mobile-more-submenu" role="menu" aria-label="Scripts submenu">
                {scriptsLoading ? (
                  <div className="mobile-more-submenu-loading" data-testid="mobile-more-scripts-loading">
                    <Loader2 className="animate-spin" />
                    <span>Loading scripts…</span>
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
                        <span>Manage Scripts…</span>
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
                      <span>No scripts — add one…</span>
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
              <span>Files</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-planning"
              onClick={() => handleMoreAction(planningHandler)}
            >
              <Lightbulb />
              <span>Planning</span>
              {activePlanningSessionCount > 0 && (
                <span className="mobile-more-item-badge">{formatCount(activePlanningSessionCount)}</span>
              )}
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-workflow"
              onClick={() => handleMoreAction(onOpenWorkflowSteps)}
            >
              <Workflow />
              <span>Workflow Steps</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-schedules"
              onClick={() => handleMoreAction(onOpenSchedules)}
            >
              <Clock />
              <span>Automation</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-github"
              onClick={() => handleMoreAction(onOpenGitHubImport)}
            >
              <GitHubLogo />
              <span>Import from GitHub</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-usage"
              onClick={() => handleMoreAction(onOpenUsage)}
            >
              <Activity />
              <span>Usage</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-projects"
              onClick={() => handleMoreAction(onViewAllProjects)}
            >
              <Grid3X3 />
              <span>Projects</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-documents"
              onClick={() => handleMoreAction(() => onChangeView("documents"))}
            >
              <FileText />
              <span>Documents</span>
            </button>

            {showSkillsInMore && (
              <button
                type="button"
                className="mobile-more-item"
                data-testid="mobile-more-item-skills"
                onClick={() => handleMoreAction(() => onChangeView("skills"))}
              >
                <Zap />
                <span>Skills</span>
              </button>
            )}

            {roadmapEnabled && (
              <button
                type="button"
                className="mobile-more-item"
                data-testid="mobile-more-item-roadmaps"
                onClick={() => handleMoreAction(() => onChangeView("roadmaps"))}
              >
                <Map />
                <span>Roadmaps</span>
              </button>
            )}

            {experimentalFeatures?.researchView && (
              <button
                type="button"
                className="mobile-more-item"
                data-testid="mobile-more-item-research"
                onClick={() => handleMoreAction(() => onChangeView("research"))}
              >
                <Search />
                <span>Research</span>
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
                <span>Insights</span>
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
                <span>Memory</span>
              </button>
            )}

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
                <span>Dev Server</span>
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
                <span>Nodes</span>
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
                <span>Todos</span>
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
                    onClick={() => handleMoreAction(() => onChangeView(pluginTaskView))}
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
              <span>Settings</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}
