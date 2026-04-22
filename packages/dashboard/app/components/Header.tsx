import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Settings, Pause, Play, Square, LayoutGrid, List, Terminal, Lightbulb, Search, X, Activity, MoreHorizontal, Clock, Folder, History, GitBranch, Monitor, Server, Workflow, Bot, ChevronLeft, Target, ChevronRight, FileCode, Loader2, Grid3X3, Mail, MessageSquare, ChevronDown, Check, Map, Zap, Sparkles, FileText, Brain } from "lucide-react";
import type { ProjectInfo } from "../api";
import type { NodeConfig, ProjectStatus } from "@fusion/core";
import { fetchScripts } from "../api";
import { QuickScriptsDropdown } from "./QuickScriptsDropdown";
import { NodeStatusIndicator } from "./NodeStatusIndicator";
import { PluginSlot } from "./PluginSlot";
import { useViewportMode, type ViewportMode } from "../hooks/useViewportMode";

export { useViewportMode };

// Status icon config for project selector dropdown
const PROJECT_STATUS_CONFIG: Record<ProjectStatus, { color: string }> = {
  active: { color: "var(--success)" },
  paused: { color: "var(--warning)" },
  errored: { color: "var(--color-error)" },
  initializing: { color: "var(--info)" },
};

/**
 * ProjectSelector - A component for project navigation.
 * Shows "Back to All Projects" button with ChevronLeft icon when currentProject is set.
 * Shows project dropdown for switching when 2+ projects exist.
 */
function ProjectSelector({
  projects,
  currentProject,
  onViewAll,
  onSelectProject,
}: {
  projects: ProjectInfo[];
  currentProject: ProjectInfo | null;
  onViewAll: () => void;
  onSelectProject?: (project: ProjectInfo) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleSelectProject = useCallback(
    (project: ProjectInfo) => {
      onSelectProject?.(project);
      setIsOpen(false);
    },
    [onSelectProject]
  );

  return (
    <div className="project-selector" ref={dropdownRef}>
      {/* Back to All Projects button - shown when a project is selected */}
      {currentProject && (
        <button
          className="header-back-button"
          onClick={onViewAll}
          title="Back to All Projects"
          data-testid="back-to-projects-btn"
        >
          <ChevronLeft size={14} />
          <span>Back to All Projects</span>
        </button>
      )}

      {/* Project dropdown - shown when 2+ projects exist */}
      {projects.length > 1 && (
        <>
          <button
            className={`project-selector-trigger${isOpen ? " project-selector-trigger--open" : ""}`}
            onClick={() => setIsOpen((prev) => !prev)}
            title="Switch project"
            aria-label="Switch project"
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            data-testid="project-selector-trigger"
          >
            <ChevronDown size={12} className={`project-selector-chevron${isOpen ? " project-selector-chevron--open" : ""}`} />
          </button>
          {isOpen && (
            <div
              className="project-selector-dropdown"
              role="listbox"
              aria-label="Select project"
              data-testid="project-selector-dropdown"
            >
              {projects.map((project) => {
                const isCurrent = currentProject?.id === project.id;
                const statusColor = PROJECT_STATUS_CONFIG[project.status]?.color;
                return (
                  <button
                    key={project.id}
                    className={`project-selector-item${isCurrent ? " project-selector-item--current" : ""}`}
                    onClick={() => handleSelectProject(project)}
                    role="option"
                    aria-selected={isCurrent}
                  >
                    <span
                      className="project-selector-dot"
                      style={{ backgroundColor: statusColor || "var(--text-muted)" }}
                    />
                    <div className="project-selector-info">
                      <span className="project-selector-name">{project.name}</span>
                      <span className="project-selector-path">
                        {project.path.split("/").slice(-2).join("/")}
                      </span>
                    </div>
                    {isCurrent && <Check size={14} className="project-selector-check" />}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

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
  onOpenPlanning?: () => void;
  /** Resume an in-flight planning session. Takes priority over onOpenPlanning when activePlanningSessionCount > 0 */
  onResumePlanning?: () => void;
  /** Number of active planning sessions. When > 0, shows a badge on the Planning button. */
  activePlanningSessionCount?: number;
  onOpenUsage?: () => void;
  onOpenActivityLog?: () => void;
  /** Opens the mailbox view */
  onOpenMailbox?: () => void;
  /** Unread message count for badge display */
  mailboxUnreadCount?: number;
  onOpenSchedules?: () => void;
  onOpenGitManager?: () => void;
  onOpenNodes?: () => void;
  /** When false, hides the Nodes management button. Defaults to true for backward compat. */
  showNodesButton?: boolean;
  onOpenWorkflowSteps?: () => void;
  onOpenScripts?: () => void;
  onRunScript?: (name: string, command: string) => void;
  onToggleTerminal?: () => void;
  /** Opens the top-level workspace-aware file browser modal. */
  onOpenFiles?: () => void;
  filesOpen?: boolean;
  globalPaused?: boolean;
  enginePaused?: boolean;
  onToggleGlobalPause?: () => void;
  onToggleEnginePause?: () => void;
  view?: "board" | "list" | "agents" | "missions" | "chat" | "documents" | "roadmaps" | "skills" | "mailbox" | "insights" | "memory" | "devserver" | "dev-server";
  onChangeView?: (view: "board" | "list" | "agents" | "missions" | "chat" | "documents" | "roadmaps" | "skills" | "mailbox" | "insights" | "memory" | "devserver" | "dev-server") => void;
  /** Whether to show the skills tab in the view toggle */
  showSkillsTab?: boolean;
  /** When true, shows the Agents view tab button. Hidden by default (experimental feature). */
  showAgentsTab?: boolean;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  /** Multi-project props */
  projects?: ProjectInfo[];
  currentProject?: ProjectInfo | null;
  onSelectProject?: (project: ProjectInfo) => void;
  onViewAllProjects?: () => void;
  projectId?: string;
  isElectron?: boolean;
  /** When true, the mobile bottom nav bar handles primary navigation and header nav controls are hidden. */
  mobileNavEnabled?: boolean;
  /** Available nodes for the node selector */
  availableNodes?: NodeConfig[];
  /** Currently selected node (null for local) */
  currentNode?: NodeConfig | null;
  /** Callback when a node is selected */
  onSelectNode?: (node: NodeConfig | null) => void;
  /** Whether the current view is a remote node */
  isRemote?: boolean;
  /** Experimental feature flags controlling visibility of nav items. */
  experimentalFeatures?: { insights?: boolean; roadmap?: boolean; memoryView?: boolean; devServer?: boolean; devServerView?: boolean };
}

export function Header({
  onOpenSettings,
  onOpenGitHubImport,
  onOpenPlanning,
  onResumePlanning,
  activePlanningSessionCount = 0,
  onOpenUsage,
  onOpenActivityLog,
  onOpenMailbox,
  mailboxUnreadCount = 0,
  onOpenSchedules,
  onOpenGitManager,
  onOpenNodes,
  showNodesButton,
  onOpenWorkflowSteps,
  onOpenScripts,
  onRunScript,
  onToggleTerminal,
  onOpenFiles,
  filesOpen,
  globalPaused,
  enginePaused,
  onToggleGlobalPause,
  onToggleEnginePause,
  view = "board",
  onChangeView,
  showSkillsTab,
  showAgentsTab,
  searchQuery = "",
  onSearchChange,
  projects = [],
  currentProject,
  onSelectProject,
  onViewAllProjects,
  projectId,
  isElectron = false,
  mobileNavEnabled,
  availableNodes = [],
  currentNode,
  onSelectNode,
  isRemote = false,
  experimentalFeatures,
}: HeaderProps) {
  const mode: ViewportMode = useViewportMode();
  const isMobile = mode === "mobile";
  const isTablet = mode === "tablet";
  const isCompact = isMobile || isTablet;
  const hideFullNav = isMobile && mobileNavEnabled;
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [isNonMobileSearchOpen, setIsNonMobileSearchOpen] = useState(false);
  // Track when user has explicitly closed the search (used for toggle visibility)
  const [isNonMobileSearchExplicitlyClosed, setIsNonMobileSearchExplicitlyClosed] = useState(false);
  const [isOverflowMenuOpen, setIsOverflowMenuOpen] = useState(false);
  const [isTerminalSubmenuOpen, setIsTerminalSubmenuOpen] = useState(false);
  const [isNodeSelectorOpen, setIsNodeSelectorOpen] = useState(false);
  const [isMobileProjectSwitchOpen, setIsMobileProjectSwitchOpen] = useState(false);
  const [isViewOverflowOpen, setIsViewOverflowOpen] = useState(false);
  const [isDesktopOverflowOpen, setIsDesktopOverflowOpen] = useState(false);
  const [overflowScripts, setOverflowScripts] = useState<Record<string, string>>({});
  const [overflowScriptsLoading, setOverflowScriptsLoading] = useState(false);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const desktopOverflowTriggerRef = useRef<HTMLButtonElement>(null);
  const desktopOverflowRef = useRef<HTMLDivElement>(null);
  const mobileSearchRef = useRef<HTMLDivElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const terminalSubmenuOpenRef = useRef(false);
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

  // Script entries sorted alphabetically for overflow submenu
  const overflowScriptEntries = useMemo(() => {
    return Object.entries(overflowScripts).sort(([a], [b]) => a.localeCompare(b));
  }, [overflowScripts]);

  const hasViewOverflowItems = useMemo(() => {
    return !!(
      experimentalFeatures?.insights ||
      experimentalFeatures?.roadmap ||
      showSkillsTab ||
      experimentalFeatures?.memoryView ||
      experimentalFeatures?.devServerView
    );
  }, [experimentalFeatures, showSkillsTab]);

  // Keep ref in sync with state
  useEffect(() => {
    terminalSubmenuOpenRef.current = isTerminalSubmenuOpen;
  }, [isTerminalSubmenuOpen]);

  // Fetch scripts when terminal submenu opens in compact mode
  useEffect(() => {
    if (!isTerminalSubmenuOpen || !isCompact) return;

    let cancelled = false;
    setOverflowScriptsLoading(true);

    fetchScripts(projectId)
      .then((data) => {
        if (!cancelled) {
          setOverflowScripts(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOverflowScripts({});
        }
      })
      .finally(() => {
        if (!cancelled) {
          setOverflowScriptsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isTerminalSubmenuOpen, isCompact, projectId]);

  // Keep mobile search open if there's an active search query
  const shouldShowMobileSearch = isMobileSearchOpen || searchQuery.length > 0;

  // Non-mobile search: toggled open OR has active query, but not if explicitly closed
  const shouldShowNonMobileSearch = (isNonMobileSearchOpen || searchQuery.length > 0) && !isNonMobileSearchExplicitlyClosed;
  // Show toggle when search is available, NOT currently shown, NOT explicitly closed, AND query is empty
  const canShowNonMobileSearchToggle = (view === "board" || view === "list") && !isMobile && onSearchChange && !isNonMobileSearchExplicitlyClosed && searchQuery.length === 0;
  const canShowNonMobileSearch = (view === "board" || view === "list") && !isMobile && onSearchChange;

  // Reset explicit close flag when query becomes empty (so toggle reappears)
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

  // Close desktop overflow menu on outside click
  useEffect(() => {
    if (!isDesktopOverflowOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        desktopOverflowRef.current &&
        !desktopOverflowRef.current.contains(e.target as Node) &&
        desktopOverflowTriggerRef.current &&
        !desktopOverflowTriggerRef.current.contains(e.target as Node)
      ) {
        setIsDesktopOverflowOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isDesktopOverflowOpen]);

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
        setIsDesktopOverflowOpen(false);
        if (terminalSubmenuOpenRef.current) {
          setIsTerminalSubmenuOpen(false);
          return;
        }
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
    setIsTerminalSubmenuOpen(false);
  }, []);

  const handleMobileSearchClose = useCallback(() => {
    setIsMobileSearchOpen(false);
    if (onSearchChange) onSearchChange("");
  }, [onSearchChange]);

  return (
    <div className="header-wrapper">
      <header className="header">
        <div className="header-left">
          <div className="header-brand">
          <svg
            className="header-logo"
            width={24}
            height={24}
            viewBox="0 0 128 128"
            fill="none"
            aria-label="Fusion logo"
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
          <h1 className="logo">Fusion</h1>
        </div>

        {/* Mobile Project Switch - dropdown trigger next to logo when 2+ projects (mobile only) */}
        {isMobile && projects.length > 1 && onSelectProject && (
          <div className="mobile-project-switch" ref={mobileProjectSwitchRef}>
            <button
              className={`mobile-project-switch-trigger${isMobileProjectSwitchOpen ? " mobile-project-switch-trigger--open" : ""}`}
              onClick={() => setIsMobileProjectSwitchOpen((prev) => !prev)}
              title="Switch project"
              aria-label="Switch project"
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
                aria-label="Select project"
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
                          {project.path.split("/").slice(-2).join("/")}
                        </span>
                      </div>
                      {isCurrent && <Check size={14} className="mobile-project-switch-check" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Project Selector - Back button when project selected, dropdown when 2+ projects (desktop only) */}
        {!isCompact && projects.length >= 1 && onViewAllProjects && (
          <ProjectSelector
            projects={projects}
            currentProject={currentProject ?? null}
            onViewAll={onViewAllProjects}
            onSelectProject={onSelectProject}
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
                  title="Switch node"
                  aria-label="Switch node"
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
                  <div className="node-selector-dropdown" role="listbox" aria-label="Select node">
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
                      <span className="node-selector-option-dot node-selector-option-dot--local" />
                      <span className="node-selector-option-label">Local</span>
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
                        <span className={`node-selector-option-dot node-selector-option-dot--${node.status}`} />
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
        {/* Mobile View Toggle - compact board/list switcher in header when mobile nav is active */}
        {hideFullNav && onChangeView && (view === "board" || view === "list") && (
          <div className="view-toggle" data-testid="mobile-view-toggle">
            <button
              className={`view-toggle-btn${view === "board" ? " active" : ""}`}
              onClick={() => onChangeView("board")}
              title="Board view"
              aria-label="Board view"
              aria-pressed={view === "board"}
              data-testid="mobile-view-toggle-board"
            >
              <LayoutGrid size={16} />
            </button>
            <button
              className={`view-toggle-btn${view === "list" ? " active" : ""}`}
              onClick={() => onChangeView("list")}
              title="List view"
              aria-label="List view"
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
            title="Open search"
            aria-label="Open search"
            aria-expanded={false}
            data-testid="mobile-header-search-btn"
          >
            <Search size={16} />
          </button>
        )}

        {/* Desktop/Tablet Search Toggle - show icon when search is available but hidden */}
        {canShowNonMobileSearchToggle && (
          <button
            className="btn-icon"
            onClick={handleNonMobileSearchToggle}
            title="Open search"
            aria-label="Open search"
            data-testid="desktop-header-search-btn"
          >
            <Search size={16} />
          </button>
        )}

        {/* Usage button on mobile when mobile bottom nav is active */}
        {isMobile && hideFullNav && onOpenUsage && (
          <button
            className="btn-icon"
            onClick={onOpenUsage}
            title="View usage"
            data-testid="mobile-header-usage-btn"
          >
            <Activity size={16} />
          </button>
        )}

        {/* View Toggle - always inline, even on mobile */}
        {!hideFullNav && onChangeView && (
          <div className="view-toggle">
            <button
              className={`view-toggle-btn${view === "board" ? " active" : ""}`}
              onClick={() => onChangeView("board")}
              title="Board view"
              aria-label="Board view"
              aria-pressed={view === "board"}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              className={`view-toggle-btn${view === "list" ? " active" : ""}`}
              onClick={() => onChangeView("list")}
              title="List view"
              aria-label="List view"
              aria-pressed={view === "list"}
            >
              <List size={16} />
            </button>
            {showAgentsTab && (
              <button
                className={`view-toggle-btn${view === "agents" ? " active" : ""}`}
                onClick={() => onChangeView("agents")}
                title="Agents view"
                aria-label="Agents view"
                aria-pressed={view === "agents"}
              >
                <Bot size={16} />
              </button>
            )}
            <button
              className={`view-toggle-btn${view === "missions" ? " active" : ""}`}
              onClick={() => onChangeView("missions")}
              title="Missions view"
              aria-label="Missions view"
              aria-pressed={view === "missions"}
            >
              <Target size={16} />
            </button>
            <button
              className={`view-toggle-btn${view === "chat" ? " active" : ""}`}
              onClick={() => onChangeView("chat")}
              title="Chat view"
              aria-label="Chat view"
              aria-pressed={view === "chat"}
            >
              <MessageSquare size={16} />
            </button>
            <button
              className={`view-toggle-btn${view === "documents" ? " active" : ""}`}
              onClick={() => onChangeView("documents")}
              title="Documents view"
              aria-label="Documents view"
              aria-pressed={view === "documents"}
            >
              <FileText size={16} />
            </button>
            <button
              className={`view-toggle-btn${view === "mailbox" ? " active" : ""}`}
              onClick={() => onChangeView("mailbox")}
              title="Mailbox view"
              aria-label="Mailbox view"
              aria-pressed={view === "mailbox"}
            >
              <Mail size={16} />
            </button>
            {hasViewOverflowItems && (
              <>
                <button
                  ref={viewOverflowTriggerRef}
                  className={`view-toggle-btn${["skills", "roadmaps", "insights", "memory", "dev-server", "devserver"].includes(view) ? " active" : ""}`}
                  onClick={() => setIsViewOverflowOpen((prev) => !prev)}
                  title="More views"
                  aria-label="More views"
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
                    aria-label="More views"
                  >
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
                        <span>Insights</span>
                      </button>
                    )}
                    {experimentalFeatures?.roadmap && (
                      <button
                        className={`view-toggle-overflow-item${view === "roadmaps" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("roadmaps");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-roadmaps"
                      >
                        <Map size={14} />
                        <span>Roadmaps</span>
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
                        <span>Skills</span>
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
                        <span>Memory</span>
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
                        <span>Dev Server</span>
                        <span className="visually-hidden" data-testid="view-toggle-dev-server" />
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Usage button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenUsage && (
          <button
            className="btn-icon"
            onClick={onOpenUsage}
            title="View usage"
            data-testid="desktop-header-usage-btn"
          >
            <Activity size={16} />
          </button>
        )}

        {/* Activity Log button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenActivityLog && (
          <button className="btn-icon" onClick={onOpenActivityLog} title="View Activity Log">
            <History size={16} />
          </button>
        )}

        {/* Mailbox button - desktop only */}
        {!isCompact && onOpenMailbox && (
          <button
            className={`btn-icon${mailboxUnreadCount > 0 ? " btn-icon--has-indicator" : ""}`}
            onClick={onOpenMailbox}
            title={`Mailbox${mailboxUnreadCount > 0 ? ` (${mailboxUnreadCount} unread)` : ""}`}
            data-testid="header-mailbox-btn"
          >
            <Mail size={16} />
            {mailboxUnreadCount > 0 && (
              <span className="header-badge" data-testid="header-mailbox-badge">
                {mailboxUnreadCount > 9 ? "9+" : mailboxUnreadCount}
              </span>
            )}
          </button>
        )}

        {/* Desktop actions */}
        {!isCompact && !isElectron && (
          <button className="btn-icon" onClick={onOpenGitHubImport} title="Import from GitHub">
            <GitHubLogo size={16} />
          </button>
        )}

        {!isCompact && (
          <button
            className={`btn-icon${activePlanningSessionCount > 0 ? " btn-icon--has-indicator" : ""}`}
            onClick={activePlanningSessionCount > 0 && onResumePlanning ? onResumePlanning : onOpenPlanning}
            title={activePlanningSessionCount > 0 ? "Resume planning session" : "Create a task with AI planning"}
            data-testid="planning-btn"
            style={{ position: "relative" }}
          >
            <Lightbulb size={16} />
            {activePlanningSessionCount > 0 && (
              <span
                className="header-badge header-badge--pulse"
                data-testid="planning-badge"
                aria-label={`${activePlanningSessionCount} active planning session${activePlanningSessionCount !== 1 ? "s" : ""}`}
              >
                {activePlanningSessionCount}
              </span>
            )}
          </button>
        )}

        {/* Terminal button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && (
          <button
            className="btn-icon btn-icon--terminal"
            onClick={onToggleTerminal}
            title="Open Terminal"
            data-testid="terminal-toggle-btn"
          >
            <Terminal size={16} />
          </button>
        )}

        {/* Files button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenFiles && (
          <button
            className={`btn-icon${filesOpen ? " btn-icon--active" : ""}`}
            onClick={onOpenFiles}
            title="Browse files"
            data-testid="files-toggle-btn"
          >
            <Folder size={16} />
          </button>
        )}

        {/* Git Manager button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenGitManager && (
          <button
            className="btn-icon"
            onClick={onOpenGitManager}
            title="Git Manager"
            data-testid="git-manager-btn"
          >
            <GitBranch size={16} />
          </button>
        )}

        {/* Workflow Steps - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenWorkflowSteps && (
          <button
            className="btn-icon"
            onClick={onOpenWorkflowSteps}
            title="Workflow Steps"
            data-testid="workflow-steps-btn"
          >
            <Workflow size={16} />
          </button>
        )}

        {/* Scripts - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenScripts && onRunScript && (
          <QuickScriptsDropdown
            onOpenScripts={onOpenScripts}
            onRunScript={onRunScript}
            projectId={projectId}
          />
        )}

        {/* Desktop overflow menu for Nodes and Schedules */}
        {!isCompact && (
          <div style={{ position: "relative" }}>
            <button
              ref={desktopOverflowTriggerRef}
              className="btn-icon"
              onClick={() => setIsDesktopOverflowOpen((prev) => !prev)}
              title="More actions"
              aria-label="More actions"
              aria-expanded={isDesktopOverflowOpen}
              aria-haspopup="menu"
              data-testid="desktop-overflow-trigger"
            >
              <MoreHorizontal size={16} />
            </button>
            {isDesktopOverflowOpen && (
              <div
                ref={desktopOverflowRef}
                className="desktop-overflow-menu"
                role="menu"
                aria-label="More actions"
              >
                {onOpenNodes && showNodesButton !== false && (
                  <button
                    className="view-toggle-overflow-item"
                    onClick={() => {
                      onOpenNodes();
                      setIsDesktopOverflowOpen(false);
                    }}
                    role="menuitem"
                    data-testid="desktop-overflow-nodes-btn"
                  >
                    <Server size={14} />
                    <span>Nodes</span>
                  </button>
                )}
                <button
                  className="view-toggle-overflow-item"
                  onClick={() => {
                    handleOverflowAction(onOpenSchedules);
                    setIsDesktopOverflowOpen(false);
                  }}
                  role="menuitem"
                  data-testid="desktop-overflow-schedules-btn"
                >
                  <Clock size={14} />
                  <span>Automation</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Pause button (soft pause) - always inline */}
        <button
          className={`btn-icon${enginePaused ? " btn-icon--paused" : ""}`}
          onClick={onToggleEnginePause}
          title={enginePaused ? "Resume scheduling" : "Pause scheduling"}
          disabled={!!globalPaused}
        >
          {enginePaused ? <Play size={16} /> : <Pause size={16} />}
        </button>

        {/* Stop button (hard stop) - always inline */}
        <button
          className={`btn-icon${globalPaused ? " btn-icon--stopped" : ""}`}
          onClick={onToggleGlobalPause}
          title={globalPaused ? "Start AI engine" : "Stop AI engine"}
        >
          {globalPaused ? <Play size={16} /> : <Square size={16} />}
        </button>

        {/* Settings - always inline on desktop, placed after engine controls */}
        {!isCompact && (
          <button className="btn-icon" onClick={onOpenSettings} title="Settings">
            <Settings size={16} />
          </button>
        )}

        {/* Plugin UI slot for header actions */}
        <PluginSlot slotId="header-action" projectId={projectId} />

        {/* Compact overflow menu trigger (mobile + tablet) */}
        {isCompact && !hideFullNav && (
          <button
            ref={overflowButtonRef}
            className="btn-icon compact-overflow-trigger"
            onClick={handleOverflowToggle}
            title="More header actions"
            aria-label="More header actions"
            aria-expanded={isOverflowMenuOpen}
            aria-haspopup="menu"
          >
            <MoreHorizontal size={16} />
          </button>
        )}

        {/* Compact overflow menu (mobile + tablet) */}
        {isCompact && !hideFullNav && isOverflowMenuOpen && (
          <div
            ref={overflowMenuRef}
            className="mobile-overflow-menu"
            role="menu"
            aria-label="Additional header actions"
          >
            {/* Projects - in overflow on mobile */}
            {projects.length >= 1 && onViewAllProjects && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onViewAllProjects)}
                role="menuitem"
                data-testid="overflow-project-selector-btn"
              >
                <Grid3X3 size={16} />
                <span>Projects</span>
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
                <span>Browse Files</span>
              </button>
            )}
            <button
              className={`mobile-overflow-item${activePlanningSessionCount > 0 ? " mobile-overflow-item--has-indicator" : ""}`}
              onClick={() => handleOverflowAction(activePlanningSessionCount > 0 && onResumePlanning ? onResumePlanning : onOpenPlanning)}
              role="menuitem"
              data-testid="overflow-planning-btn"
            >
              <span className="mobile-overflow-icon-wrapper">
                <Lightbulb size={16} />
                {activePlanningSessionCount > 0 && (
                  <span className="header-badge header-badge--pulse" data-testid="overflow-planning-badge">
                    {activePlanningSessionCount}
                  </span>
                )}
              </span>
              <span>{activePlanningSessionCount > 0 ? `Resume planning session (${activePlanningSessionCount})` : "Create a task with AI planning"}</span>
            </button>
            {/* Git Manager - in overflow on mobile */}
            {onOpenGitManager && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenGitManager)}
                role="menuitem"
                data-testid="overflow-git-btn"
              >
                <GitBranch size={16} />
                <span>Git Manager</span>
              </button>
            )}
            {/* Nodes - in overflow on mobile */}
            {onOpenNodes && showNodesButton !== false && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenNodes)}
                role="menuitem"
                data-testid="overflow-nodes-btn"
              >
                <Server size={16} />
                <span>Nodes</span>
              </button>
            )}
            {!isElectron && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenGitHubImport)}
                role="menuitem"
              >
                <GitHubLogo size={16} />
                <span>Import from GitHub</span>
              </button>
            )}
            <div
              className="mobile-overflow-group"
              data-testid="overflow-terminal-group"
            >
              <div className="mobile-overflow-split-row">
                <button
                  className="mobile-overflow-item mobile-overflow-split-primary"
                  onClick={() => handleOverflowAction(onToggleTerminal)}
                  role="menuitem"
                  data-testid="overflow-terminal-primary-btn"
                >
                  <Terminal size={16} />
                  <span>Terminal</span>
                </button>
                <button
                  className="mobile-overflow-split-toggle"
                  onClick={() => setIsTerminalSubmenuOpen((prev) => !prev)}
                  role="menuitem"
                  aria-expanded={isTerminalSubmenuOpen}
                  aria-haspopup="menu"
                  aria-label="Show scripts"
                  data-testid="overflow-terminal-submenu-toggle"
                >
                  <ChevronRight
                    size={14}
                    className={`mobile-overflow-chevron${isTerminalSubmenuOpen ? " mobile-overflow-chevron--open" : ""}`}
                  />
                </button>
              </div>
              {isTerminalSubmenuOpen && (
                <div className="mobile-overflow-submenu" role="menu" aria-label="Scripts submenu">
                  {overflowScriptsLoading ? (
                    <div className="mobile-overflow-submenu-loading" data-testid="overflow-scripts-loading">
                      <Loader2 size={14} className="animate-spin" />
                      <span>Loading scripts…</span>
                    </div>
                  ) : overflowScriptEntries.length > 0 ? (
                    <>
                      {overflowScriptEntries.map(([name, command]) => (
                        <button
                          key={name}
                          className="mobile-overflow-item mobile-overflow-subitem"
                          onClick={() => {
                            if (onRunScript) onRunScript(name, command);
                            setIsOverflowMenuOpen(false);
                            setIsTerminalSubmenuOpen(false);
                          }}
                          role="menuitem"
                          data-testid={`overflow-script-item-${name}`}
                        >
                          <Play size={14} />
                          <span>{name}</span>
                        </button>
                      ))}
                      {onOpenScripts && (
                        <button
                          className="mobile-overflow-item mobile-overflow-subitem mobile-overflow-subitem--manage"
                          onClick={() => handleOverflowAction(onOpenScripts)}
                          role="menuitem"
                          data-testid="overflow-scripts-manage"
                        >
                          <FileCode size={14} />
                          <span>Manage Scripts…</span>
                        </button>
                      )}
                    </>
                  ) : (
                    onOpenScripts && (
                      <button
                        className="mobile-overflow-item mobile-overflow-subitem"
                        onClick={() => handleOverflowAction(onOpenScripts)}
                        role="menuitem"
                        data-testid="overflow-scripts-manage"
                      >
                        <FileCode size={14} />
                        <span>No scripts — add one…</span>
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
            <button
              className="mobile-overflow-item"
              onClick={() => handleOverflowAction(onOpenSchedules)}
              role="menuitem"
              data-testid="overflow-schedules-btn"
            >
              <Clock size={16} />
              <span>Automation</span>
            </button>
            {/* Activity Log - in overflow on mobile */}
            {onOpenActivityLog && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenActivityLog)}
                role="menuitem"
                data-testid="overflow-activity-log-btn"
              >
                <History size={16} />
                <span>View Activity Log</span>
              </button>
            )}
            {/* Mailbox - in overflow on mobile */}
            {onOpenMailbox && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenMailbox)}
                role="menuitem"
                data-testid="overflow-mailbox-btn"
              >
                <Mail size={16} />
                <span>Mailbox{mailboxUnreadCount > 0 ? ` (${mailboxUnreadCount})` : ""}</span>
              </button>
            )}
            {/* Usage - in overflow on mobile */}
            {onOpenUsage && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenUsage)}
                role="menuitem"
                data-testid="overflow-usage-btn"
              >
                <Activity size={16} />
                <span>View Usage</span>
              </button>
            )}
            {/* Workflow Steps - in overflow on mobile */}
            {onOpenWorkflowSteps && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenWorkflowSteps)}
                role="menuitem"
                data-testid="overflow-workflow-steps-btn"
              >
                <Workflow size={16} />
                <span>Workflow Steps</span>
              </button>
            )}
            {/* Settings - always last in overflow menu */}
            <button
              className="mobile-overflow-item"
              onClick={() => handleOverflowAction(onOpenSettings)}
              role="menuitem"
            >
              <Settings size={16} />
              <span>Settings</span>
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
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="header-search-input"
          />
          <button
            className="header-search-clear"
            onClick={handleNonMobileSearchClose}
            aria-label="Close search"
          >
            <X size={14} />
          </button>
        </div>
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
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="header-search-input"
          />
          <button
            className="header-search-clear"
            onClick={handleMobileSearchClose}
            aria-label="Close search"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    )}
  </div>
);
}
