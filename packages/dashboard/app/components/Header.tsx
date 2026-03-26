import { Settings } from "lucide-react";

interface HeaderProps {
  onOpenSettings?: () => void;
}

export function Header({ onOpenSettings }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-left">
        <h1 className="logo">hai</h1>
        <span className="logo-sub">board</span>
      </div>
      <div className="header-actions">
        <button className="btn-icon" onClick={onOpenSettings} title="Settings">
          <Settings size={16} />
        </button>
      </div>
    </header>
  );
}
