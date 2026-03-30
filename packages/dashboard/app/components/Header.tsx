import { Settings, Pause, Play, Square, Download, LayoutGrid, List, GitBranch } from "lucide-react";

interface HeaderProps {
  onOpenSettings?: () => void;
  onOpenGitHubImport?: () => void;
  onOpenGitManager?: () => void;
  globalPaused?: boolean;
  enginePaused?: boolean;
  onToggleGlobalPause?: () => void;
  onToggleEnginePause?: () => void;
  view?: "board" | "list";
  onChangeView?: (view: "board" | "list") => void;
}

export function Header({
  onOpenSettings,
  onOpenGitHubImport,
  onOpenGitManager,
  globalPaused,
  enginePaused,
  onToggleGlobalPause,
  onToggleEnginePause,
  view = "board",
  onChangeView,
}: HeaderProps) {
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
        {/* Import from GitHub */}
        <button className="btn-icon" onClick={onOpenGitHubImport} title="Import from GitHub">
          <Download size={16} />
        </button>
        {/* Git Manager */}
        <button className="btn-icon" onClick={onOpenGitManager} title="Git Manager">
          <GitBranch size={16} />
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
