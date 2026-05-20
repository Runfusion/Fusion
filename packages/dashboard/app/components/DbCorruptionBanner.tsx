import { AlertTriangle, RefreshCw } from "lucide-react";

import "./DbCorruptionBanner.css";

interface DbCorruptionBannerProps {
  errors: string[];
  lastCheckedAt: string | null;
  onRefresh: () => void | Promise<void>;
  refreshing: boolean;
  refreshError: string | null;
}

export function DbCorruptionBanner({
  errors,
  lastCheckedAt,
  onRefresh,
  refreshing,
  refreshError,
}: DbCorruptionBannerProps) {
  if (errors.length === 0) {
    return null;
  }

  const visibleErrors = errors.slice(0, 5);
  const checkedAtLabel = lastCheckedAt ? new Date(lastCheckedAt).toLocaleString() : null;

  return (
    <section className="db-corruption-banner" role="alert" aria-live="assertive">
      <div className="db-corruption-banner__header">
        <div className="db-corruption-banner__headline-wrap">
          <span className="status-dot status-dot--error" aria-hidden="true" />
          <AlertTriangle aria-hidden="true" />
          <div className="db-corruption-banner__headline-copy">
            <h2 className="db-corruption-banner__headline">Database corruption detected</h2>
            {checkedAtLabel ? (
              <p className="db-corruption-banner__meta">Last checked: {checkedAtLabel}</p>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm db-corruption-banner__refresh"
          onClick={() => {
            void onRefresh();
          }}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? "db-corruption-banner__refresh-icon db-corruption-banner__refresh-icon--spinning" : "db-corruption-banner__refresh-icon"} aria-hidden="true" />
          {refreshing ? "Refreshing…" : "Refresh health"}
        </button>
      </div>

      <p className="db-corruption-banner__body">
        Fusion&apos;s background SQLite integrity check reported corruption. Review the failing objects below before continuing critical operations.
      </p>

      <ul className="db-corruption-banner__list">
        {visibleErrors.map((error, index) => (
          <li key={`${index}:${error}`} className="db-corruption-banner__item">
            <code className="db-corruption-banner__error-code">{error}</code>
          </li>
        ))}
      </ul>

      <p className="db-corruption-banner__footer">
        <strong className="db-corruption-banner__footer-label">What to do:</strong>{" "}
        Back up the project, try <code className="db-corruption-banner__inline-code">fn db --vacuum</code> if the database still opens cleanly, and restore from a known-good backup if corruption persists. See{" "}
        <a href="docs/storage.md" target="_blank" rel="noreferrer" className="db-corruption-banner__link">docs/storage.md</a>
        {" "}for the storage layout and recovery guidance.
      </p>
      {refreshError ? <p className="db-corruption-banner__error">{refreshError}</p> : null}
    </section>
  );
}
