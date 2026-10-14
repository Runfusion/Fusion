import { AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskIdIntegrityReport } from "@fusion/core";
import { refreshDashboardHealth, type DashboardHealthResponse } from "../api";
import { Banner } from "./Banner";
import "./TaskIdIntegrityBanner.css";

/*
FNXC:PostgresHealth 2026-07-14-23:58:
An on-demand integrity refresh may return a PostgreSQL detector error as well as an ok or anomaly report. Propagate the complete health contract so the dashboard cannot discard a failed readiness check after the banner requests a recheck.
*/
/*
FNXC:TaskIdIntegrityCanary 2026-09-26-01:10 (RUFU-301):
The props widened from `TaskIdIntegrityReport` to the full response union on
purpose. The banner used to be rendered only for `status === "anomaly"`, so an
integrity probe that timed out produced no visible signal anywhere in the UI while
`/api/health` simultaneously published `corruptionDetected: false` — the operator
saw a clean canary that had in fact never measured. An unmeasured verdict now
renders its own warning, because "we could not look" must be as visible as
"we looked and found nothing".
*/
type IntegrityHealth = DashboardHealthResponse["taskIdIntegrity"];

interface TaskIdIntegrityBannerProps {
  report: IntegrityHealth;
  recommendedAction: string | null;
  onRefresh?: (report: IntegrityHealth, recommendedAction: string | null) => void;
}

function getAnomalyLabel(kind: TaskIdIntegrityReport["anomalies"][number]["kind"], t: ReturnType<typeof useTranslation>["t"]): string {
  switch (kind) {
    case "duplicate_active_id":
      return t("health.anomaly.duplicateActiveId", "Duplicate active task ID");
    case "id_in_active_and_archived":
      return t("health.anomaly.idInBothStorages", "Task ID present in active and archived storage");
    case "next_sequence_at_or_below_used":
      return t("health.anomaly.sequenceOverlap", "Allocator next sequence overlaps an existing task ID");
    case "task_row_outside_known_prefix":
      return t("health.anomaly.unknownPrefix", "Task row uses a prefix outside allocator state");
    default:
      return kind;
  }
}

/*
FNXC:TaskIdIntegrityCanary 2026-09-26-04:25 (RUFU-301):
The NOT-VERIFIED body is chosen per evidence class. One hardcoded sentence
asserted "Fusion reached PostgreSQL" for every `status: "error"`, and
`unconfigured` is production-reachable (no PostgreSQL health layer at all), so the
canary banner stated the opposite of the truth about connectivity in exactly the
states where the payload says connectivity failed — the same class of false claim
this task removes elsewhere, and it contradicted the per-class recommended action
already shown in the banner footer. "Reached PostgreSQL" is only true for
`incomplete`, where the connectivity stage measurably answered and only the
integrity read is missing.

Key shape note: the copy stays flat-suffixed (`…BodyUnreachable`) rather than
nested (`.unreachable`) because `health.integrityNotMeasured` is already a leaf
string (the headline), and i18next cannot also make it an object.
*/
function getNotMeasuredBody(
  failure: Extract<IntegrityHealth, { status: "error" }>["failure"],
  t: ReturnType<typeof useTranslation>["t"],
): string {
  switch (failure) {
    case "unconfigured":
      return t(
        "health.integrityNotMeasuredBodyUnconfigured",
        "No PostgreSQL health layer is available, so the task-ID integrity check could not run at all. This is not a clean result — the canary has never measured.",
      );
    case "unreachable":
      return t(
        "health.integrityNotMeasuredBodyUnreachable",
        "Fusion could not reach PostgreSQL, so the task-ID integrity check could not run. This is not a clean result — no corruption verdict was measured.",
      );
    case "incomplete":
    default:
      return t(
        "health.integrityNotMeasuredBody",
        "Fusion reached PostgreSQL, but the task-ID integrity check did not finish, so there is no corruption verdict. This is not a clean result — the next health check retries automatically.",
      );
  }
}

function formatAffectedIds(affectedIds: string[]): string {
  if (affectedIds.length <= 5) {
    return affectedIds.join(", ");
  }

  const visible = affectedIds.slice(0, 5).join(", ");
  return `${visible} +${affectedIds.length - 5} more`;
}

export function TaskIdIntegrityBanner({ report, recommendedAction, onRefresh }: TaskIdIntegrityBannerProps) {
  const { t } = useTranslation("app");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const health = await refreshDashboardHealth();
      onRefresh?.(health.taskIdIntegrity, health.taskIdIntegrity.recommendedAction);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : t("health.refreshFailed", "Failed to refresh integrity status."));
    } finally {
      setRefreshing(false);
    }
  };

  const refreshButton = (testId: string) => (
    <button
      type="button"
      className="btn btn-sm task-id-integrity-banner__refresh"
      data-testid={testId}
      onClick={() => {
        void handleRefresh();
      }}
      disabled={refreshing}
    >
      <RefreshCw className={refreshing ? "task-id-integrity-banner__refresh-icon task-id-integrity-banner__refresh-icon--spinning" : "task-id-integrity-banner__refresh-icon"} aria-hidden="true" />
      {refreshing ? t("health.rechecking", "Re-checking…") : t("health.recheck", "Re-check")}
    </button>
  );

  /*
  FNXC:TaskIdIntegrityCanary 2026-09-26-01:12 (RUFU-301):
  Unmeasured is its own tone and copy: warning, not error, because PostgreSQL may
  be perfectly healthy (measured: `pg_isready` accepted connections while the reads
  timed out), and no anomaly was found either way. The probe error is shown
  verbatim so the operator can tell a statement cancellation from a connection loss.
  */
  if (report.status === "error") {
    return (
      <Banner as="section" className="task-id-integrity-banner" tone="warning" role="status" aria-live="polite">
        <div className="task-id-integrity-banner__header">
          <div className="task-id-integrity-banner__headline-wrap">
            <span className="status-dot status-dot--pending" aria-hidden="true" />
            <AlertTriangle aria-hidden="true" />
            <h2 className="task-id-integrity-banner__headline">{t("health.integrityNotMeasured", "Task ID integrity could not be measured")}</h2>
          </div>
          {refreshButton("integrity-recheck")}
        </div>
        <p className="task-id-integrity-banner__body">
          {getNotMeasuredBody(report.failure, t)}
        </p>
        <ul className="task-id-integrity-banner__list">
          <li className="task-id-integrity-banner__item">
            <code className="task-id-integrity-banner__ids">{report.error}</code>
          </li>
        </ul>
        {recommendedAction ? <p className="task-id-integrity-banner__footer">{recommendedAction}</p> : null}
        {refreshError ? <p className="task-id-integrity-banner__error">{refreshError}</p> : null}
      </Banner>
    );
  }

  if (report.status !== "anomaly") {
    return null;
  }

  return (
    <Banner as="section" className="task-id-integrity-banner" tone="error" role="alert" aria-live="assertive">
      <div className="task-id-integrity-banner__header">
        <div className="task-id-integrity-banner__headline-wrap">
          <span className="status-dot status-dot--error" aria-hidden="true" />
          <AlertTriangle aria-hidden="true" />
          <h2 className="task-id-integrity-banner__headline">{t("health.anomalyDetected", "Task ID integrity anomaly detected")}</h2>
        </div>
        {refreshButton("integrity-anomaly-recheck")}
      </div>

      <p className="task-id-integrity-banner__body">
        {t("health.anomalyBody", "Fusion found allocator state that can cause task IDs to be reused or overwrite live task records.")}
      </p>

      <ul className="task-id-integrity-banner__list">
        {report.anomalies.map((anomaly) => (
          <li
            key={`${anomaly.kind}:${anomaly.prefix}:${anomaly.affectedIds.join(",")}`}
            className="task-id-integrity-banner__item"
          >
            <strong className="task-id-integrity-banner__item-title">{getAnomalyLabel(anomaly.kind, t)}</strong>
            <span className="task-id-integrity-banner__item-detail">{anomaly.details}</span>
            <code className="task-id-integrity-banner__ids">{formatAffectedIds(anomaly.affectedIds)}</code>
          </li>
        ))}
      </ul>

      {recommendedAction ? <p className="task-id-integrity-banner__footer">{recommendedAction}</p> : null}
      {refreshError ? <p className="task-id-integrity-banner__error">{refreshError}</p> : null}
    </Banner>
  );
}
