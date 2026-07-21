import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Settings, LayoutGrid, List, Search, X, Activity, MoreHorizontal, Clock, Folder, History, GitBranch, Monitor, Workflow, Bot, Target, Grid3X3, Mail, MessageSquare, Check, Zap, Sparkles, FileText, Brain, CheckSquare, Lock, Gauge, Lightbulb, ChevronDown, ChevronRight, PanelRight } from "lucide-react";
import "./Header.css";
// ProjectSelector styles used by the imported standalone component.
import "./ProjectSelector.css";
import { ProjectSelector as StandaloneProjectSelector } from "./ProjectSelector";
import type { ProjectInfo } from "../api";
import type { NodeConfig, ProjectStatus } from "@fusion/core";
import { NodeStatusIndicator } from "./NodeStatusIndicator";
import { NodeHealthDot } from "./NodeHealthDot";
import { PluginSlot } from "./PluginSlot";
import { useViewportMode, type ViewportMode } from "../hooks/useViewportMode";
import { getTrailingPath } from "../utils/pathDisplay";
import type { TaskView } from "../hooks/useViewState";
import type { PluginDashboardViewEntry } from "../api";
import { buildPluginTaskViewId, isPluginViewId } from "../plugins/pluginViewRegistry";
import { getPluginNavIcon } from "./pluginNavIcon";
import type { ShellHostContext } from "../shell-host";
export { resolveReportContextRefs } from "../utils/reportContextRefs";

export { useViewportMode };

const NO_BRANCH_FILTER_VALUE = "__fusion:no-branch__";

// Status icon config for project selector dropdown
const PROJECT_STATUS_CONFIG: Record<ProjectStatus, { color: string }> = {
  active: { color: "var(--success)" },
  paused: { color: "var(--warning)" },
  errored: { color: "var(--color-error)" },
  initializing: { color: "var(--info)" },
};

// Inline ProjectSelector removed — now imports StandaloneProjectSelector from ./ProjectSelector
// which has scroll fix, autocomplete, and bookmarking features.

// GitHub logo icon (Octocat mark) - uses currentColor for theme compatibility
function GitHubLogo({ size = 16 }: { size?: number }) {
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


export interface HeaderProps {
  onOpenSettings?: () => void;
  onOpenGitHubImport?: () => void;
  onOpenUsage?: (anchorRect?: DOMRect | null) => void;
  onOpenActivityLog?: () => void;
  /** Opens the mailbox view */
  onOpenMailbox?: () => void;
  /** Unread message count for badge display */
  mailboxUnreadCount?: number;
  /** Pending approval count for mailbox indicator */
  mailboxPendingApprovalCount?: number;
  /** Whether chat has an unread assistant response */
  chatHasUnreadResponse?: boolean;
  /** Count of orphaned merger autostashes for stash recovery indicator. */
  stashOrphanCount?: number;
  onOpenSchedules?: () => void;
  onOpenGitManager?: () => void;
  onOpenWorkflowEditor?: () => void;
  /** Opens the top-level workspace-aware file browser modal. */
  onOpenFiles?: () => void;
  filesOpen?: boolean;
  todosEnabled?: boolean;
  view?: TaskView;
  onChangeView?: (view: TaskView) => void;
  /** Whether to show the skills tab in the view toggle */
  showSkillsTab?: boolean;
  /** When true, shows the Agents view tab button. Hidden by default (experimental feature). */
  showAgentsTab?: boolean;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  branchFilter?: string;
  baseBranchFilter?: string;
  branchOptions?: string[];
  baseBranchOptions?: string[];
  onBranchFilterChange?: (value: string) => void;
  onBaseBranchFilterChange?: (value: string) => void;
  /** Multi-project props */
  projects?: ProjectInfo[];
  currentProject?: ProjectInfo | null;
  onSelectProject?: (project: ProjectInfo) => void;
  onViewAllProjects?: () => void;
  projectId?: string;
  shellHost?: ShellHostContext;
  /** When true, the mobile bottom nav bar handles primary navigation and header nav controls are hidden. */
  mobileNavEnabled?: boolean;
  /** When true on non-mobile screens, persistent left sidebar owns primary view navigation. */
  leftSidebarNavActive?: boolean;
  /*
  FNXC:Navigation 2026-06-22-00:00:
  The right dock is no longer a persistent rail. On non-mobile surfaces the Header owns a single show/hide toggle (replacing the tablet three-dots overflow) that opens/closes the right sidebar; mobile keeps its existing overflow menu untouched.
  */
  /** Whether the right dock is available on this surface (non-mobile + enabled). */
  rightDockAvailable?: boolean;
  /** Current open state of the right dock. */
  rightDockOpen?: boolean;
  /** Toggle the right dock open/closed. */
  onToggleRightDock?: () => void;
  /** Available nodes for the node selector */
  availableNodes?: NodeConfig[];
  /** Currently selected node (null for local) */
  currentNode?: NodeConfig | null;
  /** Callback when a node is selected */
  onSelectNode?: (node: NodeConfig | null) => void;
  /** Whether the current view is a remote node */
  isRemote?: boolean;
  /** Experimental feature flags controlling visibility of nav items. */
  experimentalFeatures?: { insights?: boolean; memoryView?: boolean; devServer?: boolean; devServerView?: boolean; researchView?: boolean; evalsView?: boolean; ideationView?: boolean; goalsView?: boolean; leftSidebarNav?: boolean; rightDock?: boolean };
  pluginDashboardViews?: PluginDashboardViewEntry[];
  shellConnectionControl?: ReactNode;
}

export function Header({
  onOpenSettings,
  onOpenGitHubImport,
  onOpenUsage,
  onOpenActivityLog,
  onOpenMailbox,
  mailboxUnreadCount = 0,
  mailboxPendingApprovalCount = 0,
  chatHasUnreadResponse = false,
  stashOrphanCount = 0,
  onOpenSchedules,
  onOpenGitManager,
  onOpenWorkflowEditor,
  onOpenFiles,
  todosEnabled,
  view = "board",
  onChangeView,
  showSkillsTab,
  showAgentsTab,
  searchQuery = "",
  onSearchChange,
  branchFilter = "",
  baseBranchFilter = "",
  branchOptions = [],
  baseBranchOptions = [],
  onBranchFilterChange,
  onBaseBranchFilterChange,
  projects = [],
  currentProject,
  onSelectProject,
  onViewAllProjects,
  projectId,
  shellHost = { kind: "browser" },
  mobileNavEnabled,
  leftSidebarNavActive = false,
  rightDockAvailable = false,
  rightDockOpen = false,
  onToggleRightDock,
  availableNodes = [],
  currentNode,
  onSelectNode,
  isRemote = false,
  experimentalFeatures,
  pluginDashboardViews = [],
  shellConnectionControl,
}: HeaderProps) {
  const { t } = useTranslation("app");
  const mode: ViewportMode = useViewportMode();
  const isMobile = mode === "mobile";
  const isTablet = mode === "tablet";
  const isCompact = isMobile || isTablet;
  const hideFullNav = isMobile && mobileNavEnabled;
  /*
  FNXC:Navigation 2026-06-19-00:00:
  When experimental left sidebar navigation is active on tablet/desktop, Header must suppress its view-toggle and More-views trigger so there is one canonical non-mobile navigation surface and no orphaned chevron remains.

  FNXC:WorkflowControls 2026-06-20-00:00:
  The hidden Header view-toggle location becomes the workflow-control portal slot only when left sidebar navigation is active on tablet/desktop. Mobile and flag-off paths keep workflow controls inline so the board/list chrome remains byte-identical.

  FNXC:WorkflowControls 2026-06-22-18:00:
  Mobile also renders the workflow portal in the top header next to the logo/project switch. The board/list workflow selector stays single-sourced through this slot, while CSS hides the "Workflow" label and compacts the trigger so it fits the mobile header.
  */
  const hideHeaderViewNav = leftSidebarNavActive && !isMobile;
  /*
  FNXC:Navigation 2026-06-21-23:40:
  The right dock is persistent and owns its own collapse control, so Header must not render a duplicate right-dock toggle or repurpose the More views overflow trigger on tablet/desktop.
  */
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [isNonMobileSearchOpen, setIsNonMobileSearchOpen] = useState(false);
  // Track when user has explicitly closed the search (used for toggle visibility)
  const [isNonMobileSearchExplicitlyClosed, setIsNonMobileSearchExplicitlyClosed] = useState(false);
  const [isOverflowMenuOpen, setIsOverflowMenuOpen] = useState(false);
  const [isNodeSelectorOpen, setIsNodeSelectorOpen] = useState(false);
  const [isMobileProjectSwitchOpen, setIsMobileProjectSwitchOpen] = useState(false);
  const [isViewOverflowOpen, setIsViewOverflowOpen] = useState(false);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const mobileSearchRef = useRef<HTMLDivElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const nodeSelectorRef = useRef<HTMLDivElement>(null);
  const mobileProjectSwitchRef = useRef<HTMLDivElement>(null);
  const viewOverflowRef = useRef<HTMLDivElement>(null);
  const viewOverflowTriggerRef = useRef<HTMLButtonElement>(null);
  
  // Get remote nodes only (exclude local node type)
  const remoteNodes = useMemo(() => 
    availableNodes.filter((node) => node.type === "remote"),
    [availableNodes]
  );
  const showNodeSelector = remoteNodes.length > 0;

  const hasViewOverflowItems = useMemo(() => {
    return !!(
      onChangeView ||
      experimentalFeatures?.researchView ||
      experimentalFeatures?.ideationView ||
      todosEnabled ||
      experimentalFeatures?.insights ||

      showSkillsTab ||
      experimentalFeatures?.memoryView ||
      experimentalFeatures?.devServerView ||
      !hideFullNav ||
      isTablet ||
      pluginDashboardViews.some((entry) => entry.view.placement !== "primary")
    );
  }, [onChangeView, experimentalFeatures, todosEnabled, showSkillsTab, hideFullNav, isTablet, pluginDashboardViews]);

  // Keep mobile search open if there's an active search query
  const shouldShowMobileSearch = isMobileSearchOpen || searchQuery.length > 0;

  const canShowNonMobileSearch = (view === "board" || view === "list") && !isMobile && onSearchChange;
  // Non-mobile search: toggled open OR has active query, but not if explicitly closed.
  const shouldShowNonMobileSearch = (isNonMobileSearchOpen || searchQuery.length > 0) && !isNonMobileSearchExplicitlyClosed;
  /*
  FNXC:BoardSearch 2026-07-01-23:38:
  Closing board/list search must suppress the populated floating panel until App clears searchQuery, then immediately restore the Open search affordance. Keep the explicit-close state out of the empty-query toggle gate so an open-but-empty dismissal cannot strand the header without a search trigger.
  */
  const canShowNonMobileSearchToggle = Boolean(canShowNonMobileSearch && !shouldShowNonMobileSearch && searchQuery.length === 0);
  const showBoardBranchFilters = view === "board";

  // Reset explicit close flag when query becomes empty (so active-query reopen behavior is ready for the next search).
  useEffect(() => {
    if (searchQuery === "") {
      setIsNonMobileSearchExplicitlyClosed(false);
    }
  }, [searchQuery]);

  // Close overflow menu on outside click
  useEffect(() => {
    if (!isOverflowMenuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        overflowMenuRef.current &&
        !overflowMenuRef.current.contains(e.target as Node) &&
        overflowButtonRef.current &&
        !overflowButtonRef.current.contains(e.target as Node)
      ) {
        setIsOverflowMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOverflowMenuOpen]);

  // Close node selector on outside click
  useEffect(() => {
    if (!isNodeSelectorOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        nodeSelectorRef.current &&
        !nodeSelectorRef.current.contains(e.target as Node)
      ) {
        setIsNodeSelectorOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isNodeSelectorOpen]);

  // Close menus on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsViewOverflowOpen(false);
        setIsOverflowMenuOpen(false);
        setIsMobileSearchOpen(false);
        setIsNodeSelectorOpen(false);
        setIsMobileProjectSwitchOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Close mobile project switch on outside click
  useEffect(() => {
    if (!isMobileProjectSwitchOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        mobileProjectSwitchRef.current &&
        !mobileProjectSwitchRef.current.contains(e.target as Node)
      ) {
        setIsMobileProjectSwitchOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isMobileProjectSwitchOpen]);

  // Close view toggle overflow on outside click
  useEffect(() => {
    if (!isViewOverflowOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        viewOverflowRef.current &&
        !viewOverflowRef.current.contains(e.target as Node) &&
        viewOverflowTriggerRef.current &&
        !viewOverflowTriggerRef.current.contains(e.target as Node)
      ) {
        setIsViewOverflowOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isViewOverflowOpen]);

  const handleMobileSearchToggle = useCallback(() => {
    setIsMobileSearchOpen((prev) => !prev);
  }, []);

  const handleNonMobileSearchToggle = useCallback(() => {
    setIsNonMobileSearchOpen(true);
    setIsNonMobileSearchExplicitlyClosed(false);
  }, []);

  const handleNonMobileSearchClose = useCallback(() => {
    setIsNonMobileSearchOpen(false);
    setIsNonMobileSearchExplicitlyClosed(true);
    if (onSearchChange) onSearchChange("");
  }, [onSearchChange]);

  const handleOverflowToggle = useCallback(() => {
    setIsOverflowMenuOpen((prev) => !prev);
  }, []);

  const handleOverflowAction = useCallback((callback?: () => void) => {
    if (callback) callback();
    setIsOverflowMenuOpen(false);
  }, []);

  const handleMobileSearchClose = useCallback(() => {
    setIsMobileSearchOpen(false);
    if (onSearchChange) onSearchChange("");
  }, [onSearchChange]);

  const isDesktopShell = shellHost.kind === "desktop-shell";

  return (
    <div className="header-wrapper">
      <header className="header" data-shell-kind={shellHost.kind}>
        <div className="header-left">
          <div className="header-brand">
          <svg
            className="header-logo"
            width={24}
            height={24}
            viewBox="0 0 128 128"
            fill="none"
            aria-label={t("header.fusionLogo")}
            role="img"
          >
            <circle
              cx="64"
              cy="64"
              r="52"
              stroke="currentColor"
              strokeWidth="8"
            />
            <path
              d="M26 101C44 82 62 64 82 45C90 37 98 30 104 24C96 35 89 47 81 60C70 79 57 95 43 108C38 112 32 108 26 101Z"
              fill="currentColor"
            />
          </svg>
          <h1 className="logo">{t("appName", "Fusion")}</h1>
        </div>

        {/* Mobile Project Switch - dropdown trigger next to logo when at least one project exists (mobile only) */}
        {isMobile && projects.length >= 1 && onSelectProject && (
          <div className="mobile-project-switch" ref={mobileProjectSwitchRef}>
            <button
              className={`mobile-project-switch-trigger${isMobileProjectSwitchOpen ? " mobile-project-switch-trigger--open" : ""}`}
              onClick={() => setIsMobileProjectSwitchOpen((prev) => !prev)}
              title={t("header.switchProject", "Switch project")}
              aria-label={t("header.switchProject", "Switch project")}
              aria-expanded={isMobileProjectSwitchOpen}
              aria-haspopup="listbox"
              data-testid="mobile-project-switch-trigger"
            >
              <ChevronDown size={14} className={`mobile-project-switch-chevron${isMobileProjectSwitchOpen ? " mobile-project-switch-chevron--open" : ""}`} />
            </button>
            {isMobileProjectSwitchOpen && (
              <div
                className="mobile-project-switch-dropdown"
                role="listbox"
                aria-label={t("header.selectProject", "Select project")}
                data-testid="mobile-project-switch-dropdown"
              >
                {projects.map((project) => {
                  const isCurrent = currentProject?.id === project.id;
                  const statusColor = PROJECT_STATUS_CONFIG[project.status]?.color;
                  return (
                    <button
                      key={project.id}
                      className={`mobile-project-switch-item${isCurrent ? " mobile-project-switch-item--current" : ""}`}
                      onClick={() => {
                        onSelectProject(project);
                        setIsMobileProjectSwitchOpen(false);
                      }}
                      role="option"
                      aria-selected={isCurrent}
                      data-testid={`mobile-project-switch-item-${project.id}`}
                    >
                      <span
                        className="mobile-project-switch-dot"
                        style={{ backgroundColor: statusColor || "var(--text-muted)" }}
                      />
                      <div className="mobile-project-switch-info">
                        <span className="mobile-project-switch-name">{project.name}</span>
                        <span className="mobile-project-switch-path">
                          {getTrailingPath(project.path, 2)}
                        </span>
                      </div>
                      {isCurrent && <Check size={14} className="mobile-project-switch-check" />}
                    </button>
                  );
                })}
                {onViewAllProjects && (
                  <>
                    <div className="mobile-project-switch-divider" />
                    <button
                      className="mobile-project-switch-manage"
                      onClick={() => {
                        onViewAllProjects();
                        setIsMobileProjectSwitchOpen(false);
                      }}
                      data-testid="mobile-project-switch-view-all"
                    >
                      <Grid3X3 size={14} />
                      <span>{t("header.viewProjects", "View Projects")}</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {hideFullNav && (
          <div
            id="header-workflow-slot"
            className="header-workflow-slot header-workflow-slot--mobile"
            data-testid="header-workflow-slot"
          />
        )}

        {/* Project Selector - Back button when project selected, dropdown when 2+ projects (tablet + desktop) */}
        {!isMobile && projects.length >= 1 && onViewAllProjects && (
          <StandaloneProjectSelector
            projects={projects}
            currentProject={currentProject ?? null}
            onViewAll={onViewAllProjects}
            onSelect={onSelectProject}
            allowSingleProject
            viewAllLabel={t("header.manageProjects", "Manage Projects")}
          />
        )}

        {/* Node selector and status indicator */}
        {showNodeSelector && (
          <div
            className={`header-node-selector${isMobile ? " header-node-selector--mobile" : ""}`}
            ref={isMobile ? undefined : nodeSelectorRef}
          >
            {/* Node status indicator - always visible */}
            <NodeStatusIndicator
              node={currentNode ?? null}
              showDetails={!isMobile}
            />

            {/* Node selector dropdown - desktop/tablet only */}
            {!isMobile && (
              <>
                <button
                  className={`btn-icon node-selector-trigger${isNodeSelectorOpen ? " node-selector-trigger--open" : ""}`}
                  onClick={() => setIsNodeSelectorOpen((prev) => !prev)}
                  title={t("header.switchNode", "Switch node")}
                  aria-label={t("header.switchNode", "Switch node")}
                  aria-expanded={isNodeSelectorOpen}
                  aria-haspopup="listbox"
                  data-testid="node-selector-trigger"
                >
                  <ChevronRight
                    size={12}
                    className={`node-selector-chevron${isNodeSelectorOpen ? " node-selector-chevron--open" : ""}`}
                  />
                </button>

                {/* Node selector dropdown menu */}
                {isNodeSelectorOpen && (
                  <div className="node-selector-dropdown" role="listbox" aria-label={t("header.selectNode", "Select node")}>
                    {/* Local option */}
                    <button
                      className={`node-selector-option${!isRemote ? " node-selector-option--active" : ""}`}
                      onClick={() => {
                        onSelectNode?.(null);
                        setIsNodeSelectorOpen(false);
                      }}
                      role="option"
                      aria-selected={!isRemote}
                      data-testid="node-option-local"
                    >
                      <NodeHealthDot status="online" compact />
                      <span className="node-selector-option-label">{t("header.localNode", "Local")}</span>
                    </button>

                    {/* Remote nodes */}
                    {remoteNodes.map((node) => (
                      <button
                        key={node.id}
                        className={`node-selector-option${currentNode?.id === node.id ? " node-selector-option--active" : ""}`}
                        onClick={() => {
                          onSelectNode?.(node);
                          setIsNodeSelectorOpen(false);
                        }}
                        role="option"
                        aria-selected={currentNode?.id === node.id}
                        data-testid={`node-option-${node.id}`}
                      >
                        <NodeHealthDot status={node.status} compact />
                        <span className="node-selector-option-label">{node.name}</span>
                        <span className="node-selector-option-status">{node.status}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="header-actions">
        {shellConnectionControl}
        {/* Mobile View Toggle - compact board/list switcher in header when mobile nav is active */}
        {hideFullNav && onChangeView && (view === "board" || view === "list") && (
          <div className="view-toggle" data-testid="mobile-view-toggle">
            <button
              className={`view-toggle-btn${view === "board" ? " active" : ""}`}
              onClick={() => onChangeView("board")}
              title={t("header.boardView", "Board view")}
              aria-label={t("header.boardView", "Board view")}
              aria-pressed={view === "board"}
              data-testid="mobile-view-toggle-board"
            >
              <LayoutGrid size={16} />
            </button>
            <button
              className={`view-toggle-btn${view === "list" ? " active" : ""}`}
              onClick={() => onChangeView("list")}
              title={t("header.listView", "List view")}
              aria-label={t("header.listView", "List view")}
              aria-pressed={view === "list"}
              data-testid="mobile-view-toggle-list"
            >
              <List size={16} />
            </button>
          </div>
        )}

        {/* Mobile Search Trigger - only on mobile, show trigger button in header */}
        {onSearchChange && isMobile && (hideFullNav || view === "board" || view === "list") && !shouldShowMobileSearch && (
          <button
            className="btn-icon mobile-search-trigger"
            onClick={handleMobileSearchToggle}
            title={t("header.openSearch", "Open search")}
            aria-label={t("header.openSearch", "Open search")}
            aria-expanded={false}
            data-testid="mobile-header-search-btn"
          >
            <Search size={16} />
          </button>
        )}

        {/* Usage button on mobile when mobile bottom nav is active */}
        {isMobile && hideFullNav && onOpenUsage && (
          <button
            className="btn-icon"
            onClick={(event) => onOpenUsage(event.currentTarget.getBoundingClientRect())}
            title={t("header.viewUsage", "View usage")}
            data-testid="mobile-header-usage-btn"
          >
            <Activity size={16} />
          </button>
        )}

        {hideHeaderViewNav && (
          <div
            id="header-workflow-slot"
            className="header-workflow-slot"
            data-testid="header-workflow-slot"
          />
        )}

        {/**
         * FNXC:Header 2026-06-21-00:00:
         * Desktop and tablet header search must render after the workflow portal slot so a populated WorkflowSwitcher appears left of the search icon while preserving the mobile search trigger's existing position and behavior.
         */}
        {canShowNonMobileSearchToggle && (
          <button
            className="btn-icon"
            onClick={handleNonMobileSearchToggle}
            title={t("header.openSearch", "Open search")}
            aria-label={t("header.openSearch", "Open search")}
            data-testid="desktop-header-search-btn"
          >
            <Search size={16} />
          </button>
        )}

        {/* View Toggle - always inline, even on mobile */}
        {!hideFullNav && !hideHeaderViewNav && onChangeView && (
          <div className="view-toggle">
            <button
              className={`view-toggle-btn${view === "board" ? " active" : ""}`}
              onClick={() => onChangeView("board")}
              title={t("header.boardView", "Board view")}
              aria-label={t("header.boardView", "Board view")}
              aria-pressed={view === "board"}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              className={`view-toggle-btn${view === "list" ? " active" : ""}`}
              onClick={() => onChangeView("list")}
              title={t("header.listView", "List view")}
              aria-label={t("header.listView", "List view")}
              aria-pressed={view === "list"}
            >
              <List size={16} />
            </button>
            {showAgentsTab && (
              <button
                className={`view-toggle-btn${view === "agents" ? " active" : ""}`}
                onClick={() => onChangeView("agents")}
                title={t("header.agentsView", "Agents view")}
                aria-label={t("header.agentsView", "Agents view")}
                aria-pressed={view === "agents"}
              >
                <Bot size={16} />
              </button>
            )}
            {/*
            FNXC:Navigation 2026-06-19-12:00:
            FN-6781 supersedes the prior tablet-only inline / desktop-overflow split: Command Center must remain a stable inline destination immediately after Agents on tablet and desktop so the affordance does not relocate while resizing.
            Documents still moves to the tablet More-views overflow to conserve horizontal space without changing desktop ordering.
            */}
            <button
              className={`view-toggle-btn${view === "command-center" ? " active" : ""}`}
              onClick={() => onChangeView("command-center")}
              title={t("header.commandCenterView", "Dashboard")}
              aria-label={t("header.commandCenterView", "Dashboard")}
              aria-pressed={view === "command-center"}
              data-testid="view-toggle-command-center"
            >
              <Gauge size={16} />
            </button>
            <button
              className={`view-toggle-btn${view === "missions" ? " active" : ""}`}
              onClick={() => onChangeView("missions")}
              title={t("header.missionsView", "Missions view")}
              aria-label={t("header.missionsView", "Missions view")}
              aria-pressed={view === "missions"}
            >
              <Target size={16} />
            </button>
            <button
              className={`view-toggle-btn${view === "chat" ? " active" : ""}`}
              onClick={() => onChangeView("chat")}
              title={t("header.chatView", "Chat view")}
              aria-label={t("header.chatView", "Chat view")}
              aria-pressed={view === "chat"}
              data-testid="header-chat-view-btn"
            >
              <MessageSquare size={16} />
              {chatHasUnreadResponse && view !== "chat" && (
                <span className="status-dot status-dot--pending header-chat-unread-dot" aria-label={t("header.unreadChatResponse", "Unread chat response")} />
              )}
            </button>
            {!isTablet && (
              /*
              FNXC:Navigation 2026-06-21-18:25:
              The top-level documents destination now displays as Artifacts (FN-6890), but the documents route id remains stable for navigation and tests.
              */
              <button
                className={`view-toggle-btn${view === "documents" ? " active" : ""}`}
                onClick={() => onChangeView("documents")}
                title={t("header.documentsView", "Artifacts view")}
                aria-label={t("header.documentsView", "Artifacts view")}
                aria-pressed={view === "documents"}
              >
                <FileText size={16} />
              </button>
            )}
            <button
              className={`view-toggle-btn${view === "mailbox" ? " active" : ""}`}
              onClick={() => (onOpenMailbox ? onOpenMailbox() : onChangeView("mailbox"))}
              title={t("header.mailboxView", "Mailbox view")}
              aria-label={t("header.mailboxView", "Mailbox view")}
              aria-pressed={view === "mailbox"}
            >
              <Mail size={16} />
              {view !== "mailbox" && mailboxPendingApprovalCount > 0 ? (
                <span className="status-dot status-dot--pending header-chat-unread-dot" aria-label={t("header.pendingApprovals", "Pending approvals")} />
              ) : view !== "mailbox" && mailboxUnreadCount > 0 ? (
                <span
                  className="status-dot status-dot--online header-chat-unread-dot"
                  aria-label={t("header.unreadMessages", "{{count}} unread messages", { count: mailboxUnreadCount })}
                />
              ) : null}
            </button>
            {pluginDashboardViews
              .filter((entry) => entry.view.placement === "primary")
              .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER))
              .map((entry) => {
                const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
                const PluginIcon = getPluginNavIcon(entry.view.icon);
                return (
                  <button
                    key={`${entry.pluginId}:${entry.view.viewId}`}
                    className={`view-toggle-btn${view === pluginTaskView || (view === "graph" && entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph") ? " active" : ""}`}
                    onClick={() => onChangeView(entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : pluginTaskView)}
                    title={`${entry.view.label} view`}
                    aria-label={`${entry.view.label} view`}
                    aria-pressed={view === pluginTaskView}
                    data-testid={`view-toggle-plugin-${entry.pluginId}-${entry.view.viewId}`}
                  >
                    <PluginIcon size={16} />
                  </button>
                );
              })}
            {hasViewOverflowItems && (
              <>
                <button
                  ref={viewOverflowTriggerRef}
                  className={`view-toggle-btn${(["research", "ideation", "skills", "insights", "memory", "secrets", "dev-server", "devserver", "graph", "todos"].includes(view) || (isTablet && view === "documents") || (experimentalFeatures?.evalsView && view === "evals") || (experimentalFeatures?.goalsView && view === "goalsView") || isPluginViewId(view)) ? " active" : ""}`}
                  onClick={() => {
                    setIsViewOverflowOpen((prev) => !prev);
                  }}
                  title={t("header.moreViews", "More views")}
                  aria-label={t("header.moreViews", "More views")}
                  aria-haspopup="menu"
                  aria-expanded={isViewOverflowOpen}
                  data-testid="view-toggle-overflow-trigger"
                >
                  <ChevronDown size={12} />
                </button>
                {isViewOverflowOpen && (
                  <div
                    ref={viewOverflowRef}
                    className="view-toggle-overflow-menu"
                    role="menu"
                    aria-label={t("header.moreViews", "More views")}
                  >
                    {experimentalFeatures?.evalsView && (
                      <button
                        className={`view-toggle-overflow-item${view === "evals" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("evals");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-evals"
                      >
                        <Target size={14} />
                        <span>{t("header.evalsView", "Evals")}</span>
                      </button>
                    )}
                    {experimentalFeatures?.goalsView && (
                      <button
                        className={`view-toggle-overflow-item${view === "goalsView" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("goalsView");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-goals"
                      >
                        <Target size={14} />
                        <span>{t("header.goalsView", "Goals")}</span>
                      </button>
                    )}
                    {experimentalFeatures?.researchView && (
                      <button
                        className={`view-toggle-overflow-item${view === "research" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("research");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-research"
                      >
                        <Search size={14} />
                        <span>{t("header.researchView", "Research")}</span>
                      </button>
                    )}
                    {experimentalFeatures?.ideationView && (
                      <button
                        className={`view-toggle-overflow-item${view === "ideation" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("ideation");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-ideation"
                      >
                        <Lightbulb size={14} />
                        <span>{t("nav.ideation", "Ideation")}</span>
                      </button>
                    )}
                    {experimentalFeatures?.insights && (
                      <button
                        className={`view-toggle-overflow-item${view === "insights" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("insights");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-insights"
                      >
                        <Sparkles size={14} />
                        <span>{t("header.insightsView", "Insights")}</span>
                      </button>
                    )}

                    {showSkillsTab && (
                      <button
                        className={`view-toggle-overflow-item${view === "skills" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("skills");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-skills"
                      >
                        <Zap size={14} />
                        <span>{t("header.skillsView", "Skills")}</span>
                      </button>
                    )}
                    {experimentalFeatures?.memoryView && (
                      <button
                        className={`view-toggle-overflow-item${view === "memory" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("memory");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-toggle-memory"
                      >
                        <Brain size={14} />
                        <span>{t("header.memoryView", "Memory")}</span>
                      </button>
                    )}
                    <button
                      className={`view-toggle-overflow-item${view === "secrets" ? " active" : ""}`}
                      onClick={() => {
                        onChangeView("secrets");
                        setIsViewOverflowOpen(false);
                      }}
                      role="menuitem"
                      data-testid="view-overflow-secrets"
                    >
                      <Lock size={14} />
                      <span>{t("header.secretsView", "Secrets")}</span>
                    </button>
                    {isTablet && (
                      <button
                        className={`view-toggle-overflow-item${view === "documents" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("documents");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-documents"
                      >
                        <FileText size={14} />
                        <span>{t("header.documentsView", "Artifacts view")}</span>
                      </button>
                    )}
                    {experimentalFeatures?.devServerView && (
                      <button
                        className={`view-toggle-overflow-item${view === "dev-server" || view === "devserver" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("devserver");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-toggle-devserver"
                      >
                        <Monitor size={14} />
                        <span>{t("header.devServerView", "Dev Server")}</span>
                        <span className="visually-hidden" data-testid="view-toggle-dev-server" />
                      </button>
                    )}
                    {todosEnabled && onChangeView && (
                      <button
                        className={`view-toggle-overflow-item${view === "todos" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("todos");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-todos"
                      >
                        <CheckSquare size={14} />
                        <span>{t("header.todosView", "Todos")}</span>
                      </button>
                    )}
                    {pluginDashboardViews
                      .filter((entry) => entry.view.placement !== "primary")
                      .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER))
                      .map((entry) => {
                        const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
                        const PluginIcon = getPluginNavIcon(entry.view.icon);
                        return (
                          <button
                            key={`${entry.pluginId}:${entry.view.viewId}`}
                            className={`view-toggle-overflow-item${view === pluginTaskView || (view === "graph" && entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph") ? " active" : ""}`}
                            onClick={() => {
                              onChangeView(entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : pluginTaskView);
                              setIsViewOverflowOpen(false);
                            }}
                            role="menuitem"
                            data-testid={`view-overflow-plugin-${entry.pluginId}-${entry.view.viewId}`}
                          >
                            <PluginIcon size={14} />
                            <span>{entry.view.label}</span>
                          </button>
                        );
                      })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/*
        FNXC:Navigation 2026-06-21-20:20:
        FN-6882 moves desktop tool actions (Activity, Activity Log, GitHub Import, Git Manager, Files, Automation) out of the Header toolbar into the right-dock tools rail while compact overflow keeps those tools for mobile/tablet.

        FNXC:Navigation 2026-06-21-00:00:
        FN-6886 removes the header Lightbulb affordances because Planning Mode is now a primary left-sidebar destination after Command Center and a single canonical MobileNavBar More item on compact breakpoints.
        */}

        {/*
        FNXC:Navigation 2026-06-22-00:00:
        When the left sidebar is active it owns Workflows as a main-content destination, so the Header drops its duplicate desktop Workflow button. The flag-off desktop layout keeps the Header button; mobile/tablet keep the overflow entry.
        */}
        {/*
        FNXC:ReportPipeline 2026-07-18-19:25:
        FN-8348 relocates guided Bug, Feedback, Idea, and Help reporting from
        Header to Settings General and Command Center. Those always-reachable
        destinations replace this responsive action-row slot without leaving a
        compact-navigation dependency or an empty header control.
        */}

        {!isCompact && !leftSidebarNavActive && onOpenWorkflowEditor && (
          <button
            className="btn-icon"
            onClick={onOpenWorkflowEditor}
            title={t("header.workflows", "Workflows")}
            data-testid="workflow-steps-btn"
          >
            <Workflow size={16} />
          </button>
        )}


        {/*
        FNXC:Navigation 2026-06-21-13:48:
        Left sidebar navigation owns desktop Settings when active, so Header hides its duplicate icon to preserve a single titled Settings control for users and navigation-history tests.
        */}
        {!isCompact && !leftSidebarNavActive && (
          // FNXC:Navigation 2026-06-22-12:00: Wrap so React's MouseEvent is not forwarded as onOpenSettings' settingsInitialSection arg.
          <button className="btn-icon" onClick={() => onOpenSettings?.()} title={t("header.settings", "Settings")}>
            <Settings size={16} />
          </button>
        )}

        {/* Plugin UI slot for header actions */}
        <PluginSlot slotId="header-action" projectId={projectId} />

        {/*
        FNXC:Navigation 2026-06-22-00:50:
        Usage (Activity) lives in the top header to the left of the right-sidebar toggle and opens the UsageIndicator as a header-anchored modal (not inline in the dock). Non-mobile only; mobile keeps its own usage button in the bottom-nav layout.
        */}
        {!isMobile && onOpenUsage && (
          <button
            className="btn-icon"
            onClick={(event) => onOpenUsage(event.currentTarget.getBoundingClientRect())}
            title={t("header.viewUsage", "View usage")}
            aria-label={t("header.viewUsage", "View usage")}
            data-testid="header-usage-btn"
          >
            <Activity size={16} />
          </button>
        )}

        {/*
        FNXC:Navigation 2026-06-22-00:00:
        Non-mobile surfaces (desktop + tablet) get a single right-sidebar show/hide toggle that owns the right dock visibility. It replaces the tablet three-dots overflow; the dock is fully hidden when closed and reopened from here. Mobile is intentionally excluded — it keeps its existing overflow menu untouched and has no right dock.
        */}
        {!isMobile && rightDockAvailable && onToggleRightDock && (
          <button
            className={`btn-icon${rightDockOpen ? " btn-icon--active" : ""}`}
            onClick={onToggleRightDock}
            title={rightDockOpen ? t("header.hideRightSidebar", "Hide right sidebar") : t("header.showRightSidebar", "Show right sidebar")}
            aria-label={rightDockOpen ? t("header.hideRightSidebar", "Hide right sidebar") : t("header.showRightSidebar", "Show right sidebar")}
            aria-expanded={rightDockOpen}
            aria-pressed={rightDockOpen}
            data-testid="header-right-dock-toggle"
          >
            <PanelRight size={16} />
          </button>
        )}

        {/* Compact overflow menu trigger (mobile only — tablet uses the right-sidebar toggle above) */}
        {isMobile && !hideFullNav && (
          <button
            ref={overflowButtonRef}
            className="btn-icon compact-overflow-trigger"
            onClick={handleOverflowToggle}
            title={t("header.moreHeaderActions", "More header actions")}
            aria-label={t("header.moreHeaderActions", "More header actions")}
            aria-expanded={isOverflowMenuOpen}
            aria-haspopup="menu"
          >
            <MoreHorizontal size={16} />
          </button>
        )}

        {/* Compact overflow menu (mobile only) */}
        {isMobile && !hideFullNav && isOverflowMenuOpen && (
          <div
            ref={overflowMenuRef}
            className="mobile-overflow-menu"
            role="menu"
            aria-label={t("header.additionalHeaderActions", "Additional header actions")}
          >
            {/* Projects - in overflow on mobile */}
            {isMobile && projects.length >= 1 && onViewAllProjects && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onViewAllProjects)}
                role="menuitem"
                data-testid="overflow-project-selector-btn"
              >
                <Grid3X3 size={16} />
                <span>{t("header.projects", "Projects")}</span>
              </button>
            )}
            {/* Files - in overflow on mobile */}
            {onOpenFiles && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenFiles)}
                role="menuitem"
                data-testid="overflow-files-btn"
              >
                <Folder size={16} />
                <span>{t("header.browseFiles", "Browse Files")}</span>
              </button>
            )}
            {/* Git Manager - in overflow on mobile */}
            {onOpenGitManager && (
              <button
                className="mobile-overflow-item mobile-overflow-item--with-badge"
                onClick={() => handleOverflowAction(onOpenGitManager)}
                role="menuitem"
                data-testid="overflow-git-btn"
              >
                <GitBranch size={16} />
                <span>{t("header.gitManager", "Git Manager")}</span>
                {stashOrphanCount > 0 ? <span className="btn-badge">{stashOrphanCount}</span> : null}
              </button>
            )}
            {!isDesktopShell && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenGitHubImport)}
                role="menuitem"
              >
                <GitHubLogo size={16} />
                <span>{t("header.importFromGitHub", "Import from GitHub")}</span>
              </button>
            )}
            {onOpenSchedules && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenSchedules)}
                role="menuitem"
                data-testid="overflow-schedules-btn"
              >
                <Clock size={16} />
                <span>{t("header.automation", "Automation")}</span>
              </button>
            )}
            {onOpenActivityLog && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenActivityLog)}
                role="menuitem"
                data-testid="overflow-activity-log-btn"
              >
                <History size={16} />
                <span>{t("header.viewActivityLog", "View Activity Log")}</span>
              </button>
            )}
            {onOpenMailbox && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenMailbox)}
                role="menuitem"
                data-testid="overflow-mailbox-btn"
              >
                <Mail size={16} />
                <span>{mailboxUnreadCount > 0 ? t("header.mailboxWithCount", "Mailbox ({{count}})", { count: mailboxUnreadCount }) : t("header.mailbox", "Mailbox")}</span>
                {mailboxPendingApprovalCount > 0 && (
                  <span className="header-badge" data-testid="overflow-mailbox-approval-badge">{mailboxPendingApprovalCount}</span>
                )}
              </button>
            )}
            {onOpenUsage && (
              <button
                className="mobile-overflow-item"
                onClick={(event) =>
                  handleOverflowAction(() => onOpenUsage(event.currentTarget.getBoundingClientRect()))
                }
                role="menuitem"
                data-testid="overflow-usage-btn"
              >
                <Activity size={16} />
                <span>{t("header.viewUsage", "View Usage")}</span>
              </button>
            )}
            {onOpenWorkflowEditor && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenWorkflowEditor)}
                role="menuitem"
                data-testid="overflow-workflow-steps-btn"
              >
                <Workflow size={16} />
                <span>{t("header.workflows", "Workflows")}</span>
              </button>
            )}
            {/* Settings - always last in overflow menu */}
            <button
              className="mobile-overflow-item"
              onClick={() => handleOverflowAction(onOpenSettings)}
              role="menuitem"
            >
              <Settings size={16} />
              <span>{t("header.settings", "Settings")}</span>
            </button>
          </div>
        )}
      </div>
    </header>

    {/* Desktop/Tablet Search - floating below header, in board or list view */}
    {canShowNonMobileSearch && shouldShowNonMobileSearch && (
      <div className="header-floating-search">
        <div className="header-search">
          <Search size={14} className="header-search-icon" />
          <input
            autoFocus
            type="text"
            placeholder={t("header.searchTasks", "Search tasks...")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="header-search-input"
          />
          <button
            className="header-search-clear"
            onClick={handleNonMobileSearchClose}
            aria-label={t("header.closeSearch", "Close search")}
          >
            <X size={14} />
          </button>
        </div>
        {showBoardBranchFilters && (
          <div className="header-branch-filters" data-testid="header-branch-filters-desktop">
            <label className="header-branch-filter-label">
              <span>{t("header.workingBranch", "Working branch")}</span>
              <select
                className="header-branch-filter-select"
                value={branchFilter}
                onChange={(event) => onBranchFilterChange?.(event.target.value)}
                data-testid="working-branch-filter"
              >
                <option value="">{t("header.allWorkingBranches", "All working branches")}</option>
                <option value={NO_BRANCH_FILTER_VALUE}>{t("header.noWorkingBranch", "No working branch")}</option>
                {branchOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="header-branch-filter-label">
              <span>{t("header.baseBranch", "Base branch")}</span>
              <select
                className="header-branch-filter-select"
                value={baseBranchFilter}
                onChange={(event) => onBaseBranchFilterChange?.(event.target.value)}
                data-testid="target-branch-filter"
              >
                <option value="">{t("header.allBaseBranches", "All base branches")}</option>
                <option value={NO_BRANCH_FILTER_VALUE}>{t("header.noBaseBranch", "No base branch")}</option>
                {baseBranchOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
    )}

    {/* Mobile Search Expanded - floating below header */}
    {onSearchChange && isMobile && shouldShowMobileSearch && (
      <div className="header-floating-search">
        <div
          ref={mobileSearchRef}
          className="header-search mobile-search-expanded"
        >
          <Search size={14} className="header-search-icon" />
          <input
            ref={mobileSearchInputRef}
            autoFocus
            type="text"
            placeholder={t("header.searchTasks", "Search tasks...")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="header-search-input"
          />
          <button
            className="header-search-clear"
            onClick={handleMobileSearchClose}
            aria-label={t("header.closeSearch", "Close search")}
          >
            <X size={14} />
          </button>
        </div>
        {showBoardBranchFilters && (
          <div className="header-branch-filters" data-testid="header-branch-filters-mobile">
            <label className="header-branch-filter-label">
              <span>{t("header.workingBranch", "Working branch")}</span>
              <select
                className="header-branch-filter-select"
                value={branchFilter}
                onChange={(event) => onBranchFilterChange?.(event.target.value)}
                data-testid="working-branch-filter-mobile"
              >
                <option value="">{t("header.allWorkingBranches", "All working branches")}</option>
                <option value={NO_BRANCH_FILTER_VALUE}>{t("header.noWorkingBranch", "No working branch")}</option>
                {branchOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="header-branch-filter-label">
              <span>{t("header.baseBranch", "Base branch")}</span>
              <select
                className="header-branch-filter-select"
                value={baseBranchFilter}
                onChange={(event) => onBaseBranchFilterChange?.(event.target.value)}
                data-testid="target-branch-filter-mobile"
              >
                <option value="">{t("header.allBaseBranches", "All base branches")}</option>
                <option value={NO_BRANCH_FILTER_VALUE}>{t("header.noBaseBranch", "No base branch")}</option>
                {baseBranchOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
    )}
  </div>
);
}
