import { useState, useEffect, useRef, useCallback } from "react";
import { Settings, Pause, Play, Square, LayoutGrid, List, Terminal, Lightbulb, Search, X, Activity, MoreHorizontal, Clock, Folder, History, GitBranch, Workflow, Bot, ChevronLeft, Target, Building2, ChevronRight, FileCode } from "lucide-react";
import type { ProjectInfo } from "../api";
import { ProjectSelector } from "./ProjectSelector";
import { QuickScriptsDropdown } from "./QuickScriptsDropdown";

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
  onOpenUsage?: () => void;
  onOpenActivityLog?: () => void;
  onOpenSchedules?: () => void;
  onOpenGitManager?: () => void;
  onOpenWorkflowSteps?: () => void;
  onOpenMissions?: () => void;
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
  view?: "board" | "list" | "agents";
  onChangeView?: (view: "board" | "list" | "agents") => void;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  /** Multi-project props */
  projects?: ProjectInfo[];
  currentProject?: ProjectInfo | null;
  onSelectProject?: (project: ProjectInfo) => void;
  onViewAllProjects?: () => void;
  projectId?: string;
}

type ViewportMode = "mobile" | "tablet" | "desktop";

function getViewportMode(): ViewportMode {
  if (typeof window === "undefined") return "desktop";
  if (window.matchMedia("(max-width: 768px)").matches) return "mobile";
  if (window.matchMedia("(min-width: 769px) and (max-width: 1024px)").matches) return "tablet";
  return "desktop";
}

function useViewportMode(): ViewportMode {
  const [mode, setMode] = useState<ViewportMode>(getViewportMode);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mobileQuery = window.matchMedia("(max-width: 768px)");
    const tabletQuery = window.matchMedia("(min-width: 769px) and (max-width: 1024px)");

    const updateMode = () => {
      if (mobileQuery.matches) {
        setMode("mobile");
      } else if (tabletQuery.matches) {
        setMode("tablet");
      } else {
        setMode("desktop");
      }
    };

    mobileQuery.addEventListener("change", updateMode);
    tabletQuery.addEventListener("change", updateMode);
    return () => {
      mobileQuery.removeEventListener("change", updateMode);
      tabletQuery.removeEventListener("change", updateMode);
    };
  }, []);

  return mode;
}

export function Header({
  onOpenSettings,
  onOpenGitHubImport,
  onOpenPlanning,
  onOpenUsage,
  onOpenActivityLog,
  onOpenSchedules,
  onOpenGitManager,
  onOpenWorkflowSteps,
  onOpenMissions,
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
  searchQuery = "",
  onSearchChange,
  projects = [],
  currentProject,
  onSelectProject,
  onViewAllProjects,
  projectId,
}: HeaderProps) {
  const mode = useViewportMode();
  const isMobile = mode === "mobile";
  const isTablet = mode === "tablet";
  const isCompact = isMobile || isTablet;
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [isOverflowMenuOpen, setIsOverflowMenuOpen] = useState(false);
  const [isTerminalSubmenuOpen, setIsTerminalSubmenuOpen] = useState(false);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const mobileSearchRef = useRef<HTMLDivElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const terminalSubmenuOpenRef = useRef(false);

  // Keep ref in sync with state
  useEffect(() => {
    terminalSubmenuOpenRef.current = isTerminalSubmenuOpen;
  }, [isTerminalSubmenuOpen]);

  // Keep mobile search open if there's an active search query
  const shouldShowMobileSearch = isMobileSearchOpen || searchQuery.length > 0;

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

  // Close menus on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (terminalSubmenuOpenRef.current) {
          setIsTerminalSubmenuOpen(false);
          return;
        }
        setIsOverflowMenuOpen(false);
        setIsMobileSearchOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Focus input when mobile search opens
  useEffect(() => {
    if (isMobileSearchOpen && mobileSearchInputRef.current) {
      setTimeout(() => mobileSearchInputRef.current?.focus(), 0);
    }
  }, [isMobileSearchOpen]);

  const handleMobileSearchToggle = useCallback(() => {
    setIsMobileSearchOpen((prev) => !prev);
  }, []);

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
    <header className="header">
      <div className="header-left">
        <img src="/logo.svg" alt="Fusion logo" className="header-logo" width={24} height={24} />
        <h1 className="logo">Fusion</h1>

        {/* Project Selector - shown when 2+ projects on desktop only */}
        {!isCompact && projects.length > 1 && (
          <div className="header-project-selector">
            <ProjectSelector
              projects={projects}
              currentProject={currentProject || null}
              onSelect={(project) => {
                onSelectProject?.(project);
              }}
              onViewAll={onViewAllProjects || (() => {})}
            />
          </div>
        )}
        
        {/* Back to All Projects button when viewing a specific project (desktop only) */}
        {!isCompact && currentProject && onViewAllProjects && (
          <button
            className="header-back-button"
            onClick={onViewAllProjects}
            title="Back to All Projects"
            data-testid="back-to-projects-btn"
          >
            <ChevronLeft size={14} />
            <span>All Projects</span>
          </button>
        )}
      </div>

      <div className="header-actions">
        {/* Desktop Search - only show in board view */}
        {onSearchChange && view === "board" && !isMobile && (
          <div className="header-search">
            <Search size={14} className="header-search-icon" />
            <input
              type="text"
              placeholder="Search tasks..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="header-search-input"
            />
            {searchQuery && (
              <button
                className="header-search-clear"
                onClick={() => onSearchChange("")}
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}

        {/* Mobile Search Trigger - only show in board view on mobile */}
        {onSearchChange && view === "board" && isMobile && (
          <>
            {!shouldShowMobileSearch ? (
              <button
                className="btn-icon mobile-search-trigger"
                onClick={handleMobileSearchToggle}
                title="Open search"
                aria-label="Open search"
                aria-expanded={false}
              >
                <Search size={16} />
              </button>
            ) : (
              <div
                ref={mobileSearchRef}
                className="header-search mobile-search-expanded"
              >
                <Search size={14} className="header-search-icon" />
                <input
                  ref={mobileSearchInputRef}
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
            )}
          </>
        )}

        {/* View Toggle - always inline, even on mobile */}
        {onChangeView && (
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
            <button
              className={`view-toggle-btn${view === "agents" ? " active" : ""}`}
              onClick={() => onChangeView("agents")}
              title="Agents view"
              aria-label="Agents view"
              aria-pressed={view === "agents"}
            >
              <Bot size={16} />
            </button>
          </div>
        )}

        {/* Usage button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenUsage && (
          <button className="btn-icon" onClick={onOpenUsage} title="View usage">
            <Activity size={16} />
          </button>
        )}

        {/* Activity Log button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenActivityLog && (
          <button className="btn-icon" onClick={onOpenActivityLog} title="View Activity Log">
            <History size={16} />
          </button>
        )}

        {/* Desktop actions */}
        {!isCompact && (
          <button className="btn-icon" onClick={onOpenGitHubImport} title="Import from GitHub">
            <GitHubLogo size={16} />
          </button>
        )}

        {!isCompact && (
          <button
            className="btn-icon"
            onClick={onOpenPlanning}
            title="Create a task with AI planning"
            data-testid="planning-btn"
          >
            <Lightbulb size={16} />
          </button>
        )}

        {/* Schedules button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && (
          <button
            className="btn-icon"
            onClick={onOpenSchedules}
            title="Scheduled tasks"
            data-testid="schedules-btn"
          >
            <Clock size={16} />
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

        {/* Missions - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenMissions && (
          <button
            className="btn-icon"
            onClick={onOpenMissions}
            title="Mission Manager"
            data-testid="missions-btn"
          >
            <Target size={16} />
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

        {/* Settings - always inline on desktop only (overflow on mobile/tablet) */}
        {!isCompact && (
          <button className="btn-icon" onClick={onOpenSettings} title="Settings">
            <Settings size={16} />
          </button>
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

        {/* Compact overflow menu trigger (mobile + tablet) */}
        {isCompact && (
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
        {isCompact && isOverflowMenuOpen && (
          <div
            ref={overflowMenuRef}
            className="mobile-overflow-menu"
            role="menu"
            aria-label="Additional header actions"
          >
            {/* Switch Project - in overflow on mobile */}
            {projects.length > 1 && onViewAllProjects && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onViewAllProjects)}
                role="menuitem"
                data-testid="overflow-project-selector-btn"
              >
                <Building2 size={16} />
                <span>{currentProject ? currentProject.name : "Switch Project"}</span>
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
              className="mobile-overflow-item"
              onClick={() => handleOverflowAction(onOpenPlanning)}
              role="menuitem"
              data-testid="overflow-planning-btn"
            >
              <Lightbulb size={16} />
              <span>Create a task with AI planning</span>
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
            <button
              className="mobile-overflow-item"
              onClick={() => handleOverflowAction(onOpenGitHubImport)}
              role="menuitem"
            >
              <GitHubLogo size={16} />
              <span>Import from GitHub</span>
            </button>
            <div
              className="mobile-overflow-group"
              data-testid="overflow-terminal-group"
            >
              <button
                className="mobile-overflow-item mobile-overflow-group-trigger"
                onClick={() => setIsTerminalSubmenuOpen((prev) => !prev)}
                role="menuitem"
                aria-expanded={isTerminalSubmenuOpen}
                aria-haspopup="menu"
                data-testid="overflow-terminal-group-trigger"
              >
                <Terminal size={16} />
                <span>Terminal</span>
                <ChevronRight
                  size={14}
                  className={`mobile-overflow-chevron${isTerminalSubmenuOpen ? " mobile-overflow-chevron--open" : ""}`}
                />
              </button>
              {isTerminalSubmenuOpen && (
                <div className="mobile-overflow-submenu" role="menu" aria-label="Terminal submenu">
                  <button
                    className="mobile-overflow-item mobile-overflow-subitem"
                    onClick={() => handleOverflowAction(onToggleTerminal)}
                    role="menuitem"
                    data-testid="overflow-terminal-btn"
                  >
                    <Terminal size={16} />
                    <span>Open Terminal</span>
                  </button>
                  {onOpenScripts && (
                    <button
                      className="mobile-overflow-item mobile-overflow-subitem"
                      onClick={() => handleOverflowAction(onOpenScripts)}
                      role="menuitem"
                      data-testid="overflow-scripts-btn"
                    >
                      <FileCode size={16} />
                      <span>Scripts</span>
                    </button>
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
              <span>Scheduled Tasks</span>
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
            {/* Missions - in overflow on mobile */}
            {onOpenMissions && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenMissions)}
                role="menuitem"
                data-testid="overflow-missions-btn"
              >
                <Target size={16} />
                <span>Missions</span>
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
  );
}
