import "./UpdateAvailableBanner.css";
import { X } from "lucide-react";

interface UpdateAvailableBannerProps {
  latestVersion: string;
  currentVersion: string;
  onDismiss: () => void;
}

export function UpdateAvailableBanner({ latestVersion, currentVersion, onDismiss }: UpdateAvailableBannerProps) {
  return (
    <div className="update-available-banner" role="status" aria-live="polite">
      <p className="update-available-banner__text">
        Update available: v{latestVersion} (current: v{currentVersion}). Run <code>npm i -g @runfusion/fusion</code> to
        update. {" "}
        <a
          className="update-available-banner__link"
          href="https://github.com/Runfusion/Fusion/releases"
          target="_blank"
          rel="noreferrer"
        >
          Release notes
        </a>{" "}
        ·{" "}
        <a className="update-available-banner__link" href="https://runfusion.ai" target="_blank" rel="noreferrer">
          Learn more
        </a>
      </p>
      <button
        type="button"
        className="update-available-banner__dismiss touch-target"
        aria-label="Dismiss update notice"
        onClick={onDismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
