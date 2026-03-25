interface HeaderProps {
  onNewTask: () => void;
}

export function Header({ onNewTask }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-left">
        <h1 className="logo">hai</h1>
        <span className="logo-sub">board</span>
      </div>
      <button className="btn btn-primary" onClick={onNewTask}>
        + New Task
      </button>
    </header>
  );
}
