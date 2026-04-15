import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  ChevronRight,
  Clock,
  FileCode,
  Folder,
  GitBranch,
  Grid3X3,
  LayoutGrid,
  List,
  Lightbulb,
  Loader2,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Play,
  Settings,
  Target,
  Terminal,
  Workflow,
  Map,
  Zap,
} from "lucide-react";
import { fetchScripts } from "../api";
import { useViewportMode } from "./Header";

export interface MobileNavBarProps {
  /** Current task view mode */
  view: "board" | "list" | "agents" | "missions" | "chat" | "roadmaps" | "skills" | "mailbox";
  /** Change task view handler */
  onChangeView: (view: "board" | "list" | "agents" | "missions" | "chat" | "roadmaps" | "skills" | "mailbox") => void;
  /** Whether the ExecutorStatusBar footer is visible */
  footerVisible: boolean;
  /** Whether any full-screen modal is currently open (hides the tab bar) */
  modalOpen?: boolean;
  // Navigation handlers
  onOpenSettings?: () => void;
  onOpenActivityLog?: () => void;
  onOpenMailbox?: () => void;
  mailboxUnreadCount?: number;
  onOpenGitManager?: () => void;
  onOpenWorkflowSteps?: () => void;
  onOpenSchedules?: () => void;
  onOpenScripts?: () => void;
  onToggleTerminal?: () => void;
  onOpenFiles?: () => void;
  onOpenGitHubImport?: () => void;
  onOpenPlanning?: () => void;
  onResumePlanning?: () => void;
  activePlanningSessionCount?: number;
  onOpenUsage?: () => void;
  onRunScript?: (name: string, command: string) => void;
  onOpenQuickChat?: () => void;
  projectId?: string;
  onViewAllProjects?: () => void;
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
  onOpenSettings,
  onOpenActivityLog,
  onOpenMailbox,
  mailboxUnreadCount = 0,
  onOpenGitManager,
  onOpenWorkflowSteps,
  onOpenSchedules,
  onOpenScripts,
  onToggleTerminal,
  onOpenFiles,
  onOpenGitHubImport,
  onOpenPlanning,
  onResumePlanning,
  activePlanningSessionCount = 0,
  onOpenUsage,
  onRunScript,
  onOpenQuickChat,
  projectId,
  onViewAllProjects,
}: MobileNavBarProps) {
  const mode = useViewportMode();
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

  if (mode !== "mobile" || modalOpen) {
    return null;
  }

  const planningHandler = activePlanningSessionCount > 0 && onResumePlanning ? onResumePlanning : onOpenPlanning;

  return (
    <>
      <nav
        className={`mobile-nav-bar${footerVisible ? " mobile-nav-bar--with-footer" : ""}`}
        role="tablist"
        aria-label="Primary navigation"
      >
        <button
          type="button"
          className={`mobile-nav-tab${view === "board" ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-board"
          role="tab"
          aria-selected={view === "board"}
          onClick={() => onChangeView("board")}
        >
          <LayoutGrid />
          <span className="mobile-nav-tab-label">Board</span>
        </button>
        <button
          type="button"
          className={`mobile-nav-tab${view === "list" ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-list"
          role="tab"
          aria-selected={view === "list"}
          onClick={() => onChangeView("list")}
        >
          <List />
          <span className="mobile-nav-tab-label">List</span>
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

        <button
          type="button"
          className="mobile-nav-tab"
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
                <span className="mobile-more-item-badge">{formatCount(mailboxUnreadCount)}</span>
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
                    <Loader2 size={14} className="animate-spin" />
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
                        <Play size={14} />
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
                        <FileCode size={14} />
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
                      <FileCode size={14} />
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
              <span>Schedules</span>
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
              data-testid="mobile-more-item-chat"
              onClick={() => handleMoreAction(onOpenQuickChat)}
            >
              <MessageSquare />
              <span>Chat</span>
            </button>

            <button
              type="button"
              className="mobile-more-item"
              data-testid="mobile-more-item-roadmaps"
              onClick={() => handleMoreAction(() => onChangeView("roadmaps"))}
            >
              <Map />
              <span>Roadmaps</span>
            </button>

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
