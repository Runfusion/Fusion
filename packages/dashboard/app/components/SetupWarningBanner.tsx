interface SetupWarningBannerProps {
  /** Whether an AI provider is connected */
  hasAiProvider: boolean;
  /** Whether GitHub is connected */
  hasGithub: boolean;
  /** Optional: compact mode for inline use (QuickEntryBox) */
  compact?: boolean;
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
}: SetupWarningBannerProps) {
  if (hasAiProvider && hasGithub) {
    return null;
  }

  if (compact) {
    return (
      <div
        className="setup-warning-banner setup-warning-banner--compact"
        role="status"
        aria-live="polite"
      >
        <p className="setup-warning-banner__compact-text">
          ⚠ Setup incomplete — AI and/or GitHub features will be limited.
        </p>
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
    <div className="setup-warning-banner" role="status" aria-live="polite">
      {warningItems.map((warning) => (
        <div key={warning.key} className="setup-warning-banner__item">
          <strong className="setup-warning-banner__title">{warning.title}</strong>
          <p className="setup-warning-banner__description">{warning.description}</p>
        </div>
      ))}
    </div>
  );
}
