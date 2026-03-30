import { Settings, Pause, Play, Square, Download, LayoutGrid, List, Terminal, Moon, Sun, Monitor } from "lucide-react";
import type { ThemeMode } from "@kb/core";

interface HeaderProps {
  onOpenSettings?: () => void;
  onOpenGitHubImport?: () => void;
  onToggleTerminal?: () => void;
  inProgressCount?: number;
  globalPaused?: boolean;
  enginePaused?: boolean;
  onToggleGlobalPause?: () => void;
  onToggleEnginePause?: () => void;
  view?: "board" | "list";
  onChangeView?: (view: "board" | "list") => void;
  themeMode?: ThemeMode;
  onToggleTheme?: () => void;
}

export function Header({
  onOpenSettings,
  onOpenGitHubImport,
  onToggleTerminal,
  inProgressCount = 0,
  globalPaused,
  enginePaused,
  onToggleGlobalPause,
  onToggleEnginePause,
  view = "board",
  onChangeView,
  themeMode = "dark",
  onToggleTheme,
}: HeaderProps) {
  const hasInProgressTasks = inProgressCount > 0;

  return (
    <header className="header">
      <div className="header-left">
        <img src="/logo.svg" alt="kb logo" className="header-logo" width={24} height={24} />
        <h1 className="logo">kb</h1>
        <span className="logo-sub">board</span>
      </div>
      <div className="header-actions">
        {/* View Toggle */}
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
        {/* Theme Toggle */}
        {onToggleTheme && (
          <button
            className="btn-icon"
            onClick={onToggleTheme}
            title={`Toggle theme (${themeMode === "dark" ? "Dark" : themeMode === "light" ? "Light" : "System"})`}
            aria-label={`Toggle theme (${themeMode === "dark" ? "Dark" : themeMode === "light" ? "Light" : "System"})`}
            data-testid="theme-toggle-btn"
          >
            {themeMode === "dark" ? (
              <Moon size={16} />
            ) : themeMode === "light" ? (
              <Sun size={16} />
            ) : (
              <Monitor size={16} />
            )}
          </button>
        )}
        {/* Import from GitHub */}
        <button className="btn-icon" onClick={onOpenGitHubImport} title="Import from GitHub">
          <Download size={16} />
        </button>
        {/* Terminal button - shows badge with count when in-progress tasks exist */}
        <button
          className={`btn-icon btn-icon--terminal${hasInProgressTasks ? " has-badge" : ""}`}
          onClick={onToggleTerminal}
          title="Open Terminal View"
          disabled={!hasInProgressTasks}
          data-testid="terminal-toggle-btn"
        >
          <Terminal size={16} />
          {hasInProgressTasks && (
            <span className="btn-badge" data-testid="terminal-badge">
              {inProgressCount > 9 ? "9+" : inProgressCount}
            </span>
          )}
        </button>
        {/* Pause button (soft pause): stops new work, lets agents finish */}
        <button
          className={`btn-icon${enginePaused ? " btn-icon--paused" : ""}`}
          onClick={onToggleEnginePause}
          title={enginePaused ? "Resume scheduling" : "Pause scheduling"}
          disabled={!!globalPaused}
        >
          {enginePaused ? <Play size={16} /> : <Pause size={16} />}
        </button>
        {/* Stop button (hard stop): kills all agents immediately */}
        <button
          className={`btn-icon${globalPaused ? " btn-icon--stopped" : ""}`}
          onClick={onToggleGlobalPause}
          title={globalPaused ? "Start AI engine" : "Stop AI engine"}
        >
          {globalPaused ? <Play size={16} /> : <Square size={16} />}
        </button>
        <button className="btn-icon" onClick={onOpenSettings} title="Settings">
          <Settings size={16} />
        </button>
      </div>
    </header>
  );
}
