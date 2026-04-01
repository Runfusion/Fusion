import { useState, useEffect, useRef, useCallback } from "react";
import { Settings, Pause, Play, Square, LayoutGrid, List, Terminal, Lightbulb, Search, X, Activity, MoreHorizontal, Clock, Folder, History, GitBranch, Workflow, Bot } from "lucide-react";

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

interface HeaderProps {
  onOpenSettings?: () => void;
  onOpenGitHubImport?: () => void;
  onOpenPlanning?: () => void;
  onOpenUsage?: () => void;
  onOpenActivityLog?: () => void;
  onOpenSchedules?: () => void;
  onOpenGitManager?: () => void;
  onOpenWorkflowSteps?: () => void;
  onOpenAgents?: () => void;
  onToggleTerminal?: () => void;
  /** Opens the top-level workspace-aware file browser modal. */
  onOpenFiles?: () => void;
  filesOpen?: boolean;
  globalPaused?: boolean;
  enginePaused?: boolean;
  onToggleGlobalPause?: () => void;
  onToggleEnginePause?: () => void;
  view?: "board" | "list";
  onChangeView?: (view: "board" | "list") => void;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 768px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(max-width: 768px)");
    const handleChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return isMobile;
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
  onOpenAgents,
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
}: HeaderProps) {
  const isMobile = useIsMobile();
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [isOverflowMenuOpen, setIsOverflowMenuOpen] = useState(false);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const mobileSearchRef = useRef<HTMLDivElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);

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
        <span className="logo-sub">tasks</span>
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
          </div>
        )}

        {/* Usage button - inline on all screens when onOpenUsage provided */}
        {onOpenUsage && (
          <button className="btn-icon" onClick={onOpenUsage} title="View usage">
            <Activity size={16} />
          </button>
        )}

        {/* Activity Log button */}
        {onOpenActivityLog && (
          <button className="btn-icon" onClick={onOpenActivityLog} title="View Activity Log">
            <History size={16} />
          </button>
        )}

        {/* Desktop actions */}
        {!isMobile && (
          <button className="btn-icon" onClick={onOpenGitHubImport} title="Import from GitHub">
            <GitHubLogo size={16} />
          </button>
        )}

        {!isMobile && (
          <button
            className="btn-icon"
            onClick={onOpenPlanning}
            title="Create a task with AI planning"
            data-testid="planning-btn"
          >
            <Lightbulb size={16} />
          </button>
        )}

        {/* Schedules button - desktop only (moved to overflow on mobile) */}
        {!isMobile && (
          <button
            className="btn-icon"
            onClick={onOpenSchedules}
            title="Scheduled tasks"
            data-testid="schedules-btn"
          >
            <Clock size={16} />
          </button>
        )}

        {/* Terminal button - desktop only (moved to overflow on mobile) */}
        {!isMobile && (
          <button
            className="btn-icon btn-icon--terminal"
            onClick={onToggleTerminal}
            title="Open Terminal"
            data-testid="terminal-toggle-btn"
          >
            <Terminal size={16} />
          </button>
        )}

        {/* Files button - desktop only */}
        {!isMobile && onOpenFiles && (
          <button
            className={`btn-icon${filesOpen ? " btn-icon--active" : ""}`}
            onClick={onOpenFiles}
            title="Browse files"
            data-testid="files-toggle-btn"
          >
            <Folder size={16} />
          </button>
        )}

        {/* Git Manager button - desktop only */}
        {!isMobile && onOpenGitManager && (
          <button
            className="btn-icon"
            onClick={onOpenGitManager}
            title="Git Manager"
            data-testid="git-manager-btn"
          >
            <GitBranch size={16} />
          </button>
        )}

        {/* Workflow Steps - desktop only */}
        {!isMobile && onOpenWorkflowSteps && (
          <button
            className="btn-icon"
            onClick={onOpenWorkflowSteps}
            title="Workflow Steps"
            data-testid="workflow-steps-btn"
          >
            <Workflow size={16} />
          </button>
        )}

        {/* Agents - desktop only */}
        {!isMobile && onOpenAgents && (
          <button
            className="btn-icon"
            onClick={onOpenAgents}
            title="Manage Agents"
            data-testid="agents-btn"
          >
            <Bot size={16} />
          </button>
        )}

        {/* Settings - always inline on desktop */}
        {!isMobile && (
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

        {/* Mobile overflow menu trigger */}
        {isMobile && (
          <button
            ref={overflowButtonRef}
            className="btn-icon mobile-overflow-trigger"
            onClick={handleOverflowToggle}
            title="More header actions"
            aria-label="More header actions"
            aria-expanded={isOverflowMenuOpen}
            aria-haspopup="menu"
          >
            <MoreHorizontal size={16} />
          </button>
        )}

        {/* Mobile overflow menu */}
        {isMobile && isOverflowMenuOpen && (
          <div
            ref={overflowMenuRef}
            className="mobile-overflow-menu"
            role="menu"
            aria-label="Additional header actions"
          >
            {/* Terminal - in overflow on mobile */}
            <button
              className="mobile-overflow-item"
              onClick={() => handleOverflowAction(onToggleTerminal)}
              role="menuitem"
              data-testid="overflow-terminal-btn"
            >
              <Terminal size={16} />
              <span>Open Terminal</span>
            </button>
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
            <button
              className="mobile-overflow-item"
              onClick={() => handleOverflowAction(onOpenPlanning)}
              role="menuitem"
              data-testid="overflow-planning-btn"
            >
              <Lightbulb size={16} />
              <span>Create a task with AI planning</span>
            </button>
            <button
              className="mobile-overflow-item"
              onClick={() => handleOverflowAction(onOpenSchedules)}
              role="menuitem"
              data-testid="overflow-schedules-btn"
            >
              <Clock size={16} />
              <span>Scheduled Tasks</span>
            </button>
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
            {onOpenAgents && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenAgents)}
                role="menuitem"
                data-testid="overflow-agents-btn"
              >
                <Bot size={16} />
                <span>Manage Agents</span>
              </button>
            )}
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
