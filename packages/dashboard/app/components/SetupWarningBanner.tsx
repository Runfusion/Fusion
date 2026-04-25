import "./SetupWarningBanner.css";
import { X } from "lucide-react";

interface SetupWarningBannerProps {
  /** Whether an AI provider is connected */
  hasAiProvider: boolean;
  /** Whether GitHub is connected */
  hasGithub: boolean;
  /** Optional: compact mode for inline use (QuickEntryBox) */
  compact?: boolean;
  /** Optional callback to dismiss the banner */
  onDismiss?: () => void;
}

interface WarningItem {
  key: "ai" | "github";
  title: string;
  description: string;
}

export function SetupWarningBanner({
  hasAiProvider,
  hasGithub,
  compact = false,
  onDismiss,
}: SetupWarningBannerProps) {
  if (hasAiProvider && hasGithub) {
    return null;
  }

  const dismissButton = onDismiss ? (
    <button
      type="button"
      className="setup-warning-banner__dismiss touch-target"
      aria-label="Dismiss setup warning"
      onClick={onDismiss}
    >
      <X size={16} aria-hidden="true" />
    </button>
  ) : null;

  if (compact) {
    return (
      <div
        className={`setup-warning-banner setup-warning-banner--compact${onDismiss ? " setup-warning-banner--dismissible" : ""}`}
        role="status"
        aria-live="polite"
      >
        <p className="setup-warning-banner__compact-text">
          ⚠ Setup incomplete — AI and/or GitHub features will be limited.
        </p>
        {dismissButton}
      </div>
    );
  }

  const warningItems: WarningItem[] = [];

  if (!hasAiProvider) {
    warningItems.push({
      key: "ai",
      title: "No AI provider connected",
      description:
        "AI agents won't be able to work on tasks until you connect a provider. Set one up in Settings → AI Setup.",
    });
  }

  if (!hasGithub) {
    warningItems.push({
      key: "github",
      title: "GitHub not connected",
      description:
        "You won't be able to import issues from GitHub, but you can still create tasks manually.",
    });
  }

  return (
    <div
      className={`setup-warning-banner${onDismiss ? " setup-warning-banner--dismissible" : ""}`}
      role="status"
      aria-live="polite"
    >
      {dismissButton}
      {warningItems.map((warning) => (
        <div key={warning.key} className="setup-warning-banner__item">
          <strong className="setup-warning-banner__title">{warning.title}</strong>
          <p className="setup-warning-banner__description">{warning.description}</p>
        </div>
      ))}
    </div>
  );
}
