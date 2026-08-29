import React, { useState } from "react";
import "./DesktopModeChooser.css";

export type DesktopModeChoice = "local" | "remote";

interface DesktopModeChooserProps {
  onSelectMode: (mode: DesktopModeChoice) => Promise<void>;
}

export function DesktopModeChooser({ onSelectMode }: DesktopModeChooserProps) {
  const [pendingMode, setPendingMode] = useState<DesktopModeChoice | null>(null);

  const handleSelect = async (mode: DesktopModeChoice) => {
    setPendingMode(mode);
    try {
      await onSelectMode(mode);
    } finally {
      setPendingMode(null);
    }
  };

  return (
    <section className="desktop-mode-chooser" data-testid="desktop-mode-chooser">
      <h1 className="desktop-mode-chooser__title">How do you want to run Fusion?</h1>
      <p className="desktop-mode-chooser__subtitle">
        Run Fusion locally in this app, or continue with remote server setup.
      </p>
      <div className="desktop-mode-chooser__actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void handleSelect("local")}
          disabled={pendingMode !== null}
        >
          Continue with Local Fusion
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void handleSelect("remote")}
          disabled={pendingMode !== null}
        >
          Continue to Remote Connection
        </button>
      </div>
    </section>
  );
}
