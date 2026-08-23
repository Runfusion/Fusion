import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { useEngineStatus } from "../hooks/useEngineStatus";
import { Banner } from "./Banner";
import "./EngineStatusBanner.css";

interface EngineStatusBannerProps {
  projectId: string;
}

/*
 * FNXC:EngineStatusBanner 2026-06-22-00:00:
 * The project banner stack needs a single visible remediation when the dashboard is loaded but the current project's engine is absent. Hide the entire component once `connected` is true so no empty wrapper, button shell, or stale aria surface remains in the DOM.
 */
export function EngineStatusBanner({ projectId }: EngineStatusBannerProps) {
  const { t } = useTranslation("app");
  const { status, canStart, starting, error, start } = useEngineStatus(projectId);

  if (!status || status.connected) return null;

  const isDashboardOnly = status.reason === "dashboard-only" || status.reason === "unreachable";
  const statusDotClass = starting ? "status-dot status-dot--connecting" : "status-dot status-dot--error";
  const body = canStart
    ? t("engineBanner.body", "The engine for this project is not running, so task automation and live updates may be paused. Start it now to reconnect the dashboard.")
    : t("engineBanner.dashboardOnly", "This dashboard cannot start engines from the current process. Run `fn serve` for this project to enable task execution and live automation.");

  return (
    <Banner
      as="section"
      className="engine-status-banner"
      tone="warning"
      icon={<div className="engine-status-banner__indicator" aria-hidden="true"><span className={statusDotClass} /></div>}
      title={<div className="engine-status-banner__title">{t("engineBanner.title", "Project engine is not connected")}</div>}
      role="status"
      aria-live="polite"
      data-testid="engine-status-banner"
      actions={canStart ? <button type="button" className="btn btn-primary btn-sm engine-status-banner__start" onClick={() => void start()} disabled={starting} data-testid="engine-status-start-button">
        {starting ? <Loader2 className="spinner" aria-hidden="true" /> : null}
        {starting ? t("engineBanner.starting", "Starting…") : t("engineBanner.startCta", "Start engine")}
      </button> : null}
    >
      <p className="engine-status-banner__body">
          {isDashboardOnly ? (
            <>
              {t("engineBanner.dashboardOnlyPrefix", "This dashboard cannot start engines from the current process. Run")} <code>fn serve</code> {t("engineBanner.dashboardOnlySuffix", "for this project to enable task execution and live automation.")}
            </>
          ) : body}
      </p>
      {error && <p className="engine-status-banner__error" role="alert">{t("engineBanner.error", "Start failed: {{message}}", { message: error })}</p>}
    </Banner>
  );
}
