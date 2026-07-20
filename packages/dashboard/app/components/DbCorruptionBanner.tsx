import { AlertTriangle, RefreshCw } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import "./DbCorruptionBanner.css";

interface DbCorruptionBannerProps {
  errors: string[];
  lastCheckedAt: string | null;
  onRefresh: () => void | Promise<void>;
  refreshing: boolean;
  refreshError: string | null;
}

/*
FNXC:PostgresHealth 2026-07-19-17:55:
The shared degraded-health shape includes connectivity, permissions, and query
failures, so the banner must not claim corruption or prescribe SQLite recovery.
Keep operator guidance focused on PostgreSQL diagnostics and the reported error.
*/
export function DbCorruptionBanner({
  errors,
  lastCheckedAt,
  onRefresh,
  refreshing,
  refreshError,
}: DbCorruptionBannerProps) {
  const { t } = useTranslation("app");
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
            <h2 className="db-corruption-banner__headline">{t("dbBanner.title", "Database health check failed")}</h2>
            {checkedAtLabel ? (
              <p className="db-corruption-banner__meta">{t("dbBanner.lastChecked", "Last checked: {{checkedAtLabel}}", { checkedAtLabel })}</p>
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
          {refreshing ? t("dbBanner.refreshing", "Refreshing…") : t("dbBanner.refreshHealth", "Refresh health")}
        </button>
      </div>

      <p className="db-corruption-banner__body">
        {t("dbBanner.body", "Fusion's PostgreSQL health check reported a failure. Review the details below before continuing critical operations.")}
      </p>

      <ul className="db-corruption-banner__list">
        {visibleErrors.map((error, index) => (
          <li key={`${index}:${error}`} className="db-corruption-banner__item">
            <code className="db-corruption-banner__error-code">{error}</code>
          </li>
        ))}
      </ul>

      <p className="db-corruption-banner__footer">
        <strong className="db-corruption-banner__footer-label">{t("dbBanner.whatToDo", "What to do:")}</strong>{" "}
        <Trans
          i18nKey="app:dbBanner.instructions"
          defaults="Back up the project, check <cmd>database logs</cmd> and PostgreSQL connectivity and permissions, then refresh health. See <docsLink>docs/storage.md</docsLink> for storage and recovery guidance."
          components={{
            cmd: <code />,
            docsLink: <a href="docs/storage.md" />,
          }}
        />
      </p>
      {refreshError ? <p className="db-corruption-banner__error">{refreshError}</p> : null}
    </section>
  );
}
