import { AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskIdIntegrityReport } from "@fusion/core";
import { refreshDashboardHealth, type DashboardHealthResponse } from "../api";
import "./TaskIdIntegrityBanner.css";

/*
FNXC:PostgresHealth 2026-07-14-23:58:
An on-demand integrity refresh may return a PostgreSQL detector error as well as an ok or anomaly report. Propagate the complete health contract so the dashboard cannot discard a failed readiness check after the banner requests a recheck.
*/
interface TaskIdIntegrityBannerProps {
  report: TaskIdIntegrityReport;
  recommendedAction: string;
  onRefresh?: (
    report: DashboardHealthResponse["taskIdIntegrity"],
    recommendedAction: string | null,
  ) => void;
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

  if (report.status !== "anomaly") {
    return null;
  }

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

  return (
    <section className="task-id-integrity-banner" role="alert" aria-live="assertive">
      <div className="task-id-integrity-banner__header">
        <div className="task-id-integrity-banner__headline-wrap">
          <span className="status-dot status-dot--error" aria-hidden="true" />
          <AlertTriangle aria-hidden="true" />
          <h2 className="task-id-integrity-banner__headline">{t("health.anomalyDetected", "Task ID integrity anomaly detected")}</h2>
        </div>
        <button
          type="button"
          className="btn btn-sm task-id-integrity-banner__refresh"
          onClick={() => {
            void handleRefresh();
          }}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? "task-id-integrity-banner__refresh-icon task-id-integrity-banner__refresh-icon--spinning" : "task-id-integrity-banner__refresh-icon"} aria-hidden="true" />
          {refreshing ? t("health.rechecking", "Re-checking…") : t("health.recheck", "Re-check")}
        </button>
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

      <p className="task-id-integrity-banner__footer">{recommendedAction}</p>
      {refreshError ? <p className="task-id-integrity-banner__error">{refreshError}</p> : null}
    </section>
  );
}
