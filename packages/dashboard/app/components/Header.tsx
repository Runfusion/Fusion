import { Settings, Pause, Play, Square } from "lucide-react";

interface HeaderProps {
  onOpenSettings?: () => void;
  globalPaused?: boolean;
  enginePaused?: boolean;
  onToggleGlobalPause?: () => void;
  onToggleEnginePause?: () => void;
}

export function Header({
  onOpenSettings,
  globalPaused,
  enginePaused,
  onToggleGlobalPause,
  onToggleEnginePause,
}: HeaderProps) {
  return (
    <header className="header">
      <div className="header-left">
        <img src="/logo.svg" alt="kb logo" className="header-logo" width={24} height={24} />
        <h1 className="logo">kb</h1>
        <span className="logo-sub">board</span>
      </div>
      <div className="header-actions">
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
