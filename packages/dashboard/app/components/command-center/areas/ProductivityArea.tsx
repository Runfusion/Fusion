import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ProductivityAnalytics } from "@fusion/core";
import type { DateRange } from "../DateRangePicker";
import { Bar } from "../charts/Bar";
import { PieChart } from "../charts/recharts";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCount, formatDurationMs } from "./areaShared";

/*
FNXC:CommandCenterCharts 2026-06-18-23:40:
ProductivityAnalytics exposes a categorical language distribution but no per-day throughput series. Add the real language pie from already-fetched data, preserve the bar/stat affordances, and document that a line chart is intentionally omitted until a genuine trend source exists.
*/

/**
 * Productivity area. Per the plan's A5 framing, LOC and tool/file counts are
 * presented as *volume* proxies, kept visually distinct from outcome counters
 * (PRs, commits). Unavailable LOC renders the "—" sentinel with a tooltip,
 * NEVER 0.
 *
 * FNXC:CommandCenter 2026-06-16-09:42:
 * Productivity area of the Command Center (PR #1683). Volume proxies (files/LOC) must read as distinct
 * from outcome counters (PRs/commits), and missing LOC must render "—", never 0, to avoid implying zero work.
 *
 * FNXC:CommandCenter 2026-06-19-00:00:
 * FN-6704 owns real commit diff-stat capture for LOC. Keep this sentinel honest until a persisted additions/deletions source exists; do not backfill with modified-file counts or any other proxy.
 *
 * FNXC:CommandCenterProductivity 2026-06-19-12:00:
 * Human hours saved is a derived estimate from LOC. It must render the unavailable "—" sentinel, never 0, when LOC is unavailable and stay visibly labeled as an estimate rather than exact accounting.
 *
 * FNXC:CommandCenter 2026-06-19-12:10:
 * The task-duration block shows active execution time from completed tasks and must use the same unavailable "—" contract as LOC so absent duration history is never displayed as 0.
 *
 * FNXC:CommandCenterProductivity 2026-06-20-03:41:
 * Every productivity metric sub-object is defaulted to the unavailable sentinel so a partial or contract-incomplete payload, including future field additions, renders "—" instead of throwing an uncaught error that crashes Command Center and pollutes the shared jsdom worker.
 */
export function ProductivityArea({ range }: { range: DateRange }) {
  const { t } = useTranslation("app");
  const { data, isLoading, error } = useAnalyticsArea<ProductivityAnalytics>(
    "/command-center/productivity",
    range,
  );

  const languageBars = useMemo(
    () =>
      (data?.byLanguage ?? []).slice(0, 12).map((l) => ({
        label: l.language,
        value: l.count,
        valueLabel: formatCount(l.count),
      })),
    [data?.byLanguage],
  );

  const languagePieData = useMemo(
    () =>
      (data?.byLanguage ?? []).slice(0, 12).map((l) => ({
        label: l.language,
        value: l.count,
      })),
    [data?.byLanguage],
  );

  const taskDuration = data?.taskDuration ?? {
    completedTasks: 0,
    averageMs: null,
    medianMs: null,
    p90Ms: null,
    totalMs: null,
    unavailable: true,
  };
  /*
  FNXC:CommandCenterProductivity 2026-06-22-00:32:
  Backfill-era dashboard tests and cached clients can render ProductivityArea with legacy productivity payloads that predate LOC and hours-saved summaries. Treat missing nested summaries as unavailable sentinels so the whole Command Center remains mounted instead of crashing during responsive-layout verification.
  */
  const loc = data?.loc ?? { value: null, unavailable: true };
  const hoursSaved = data?.hoursSaved ?? { value: null, unavailable: true };
  const isEmpty =
    !data ||
    (data.modifiedFiles === 0 &&
      data.commits === 0 &&
      data.pullRequests === 0 &&
      taskDuration.completedTasks === 0);

  const locUnavailable = !data || loc.unavailable || loc.value === null;
  const hoursSavedUnavailable = !data || hoursSaved.unavailable || hoursSaved.value === null;
  const durationUnavailable = !data || taskDuration.unavailable;
  const durationTitle = t(
    "commandCenter.productivity.durationUnavailable",
    "Task duration is unavailable until completed tasks have active execution time recorded",
  );
  const renderDurationValue = (value: number | null, testId: string) =>
    durationUnavailable || value === null ? (
      <span className="cc-unavailable" title={durationTitle} data-testid={testId}>
        —
      </span>
    ) : (
      formatDurationMs(value)
    );

  return (
    <AreaShell testId="productivity" isLoading={isLoading} error={error} isEmpty={isEmpty}>
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.productivity.outcomesTitle", "Outcomes")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-productivity-commits">
            <div className="cc-stat-label">{t("commandCenter.productivity.commits", "Commits")}</div>
            <div className="cc-stat-value">{formatCount(data?.commits ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-productivity-prs">
            <div className="cc-stat-label">{t("commandCenter.productivity.pullRequests", "Pull requests")}</div>
            <div className="cc-stat-value">{formatCount(data?.pullRequests ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-productivity-hours-saved">
            <div className="cc-stat-label">{t("commandCenter.productivity.hoursSaved", "Human hours saved")}</div>
            <div className="cc-stat-value">
              {hoursSavedUnavailable ? (
                <span
                  className="cc-unavailable"
                  title={t(
                    "commandCenter.productivity.hoursSavedUnavailable",
                    "Estimated human hours saved is unavailable until commit diff stats exist",
                  )}
                  data-testid="cc-productivity-hours-saved-unavailable"
                >
                  —
                </span>
              ) : (
                formatCount(hoursSaved.value ?? 0)
              )}
            </div>
            <span className="cc-stat-sub">{t("commandCenter.productivity.hoursSavedEstimate", "estimate from lines changed")}</span>
          </div>
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.productivity.volumeTitle", "Volume (proxy)")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-productivity-files">
            <div className="cc-stat-label">{t("commandCenter.productivity.modifiedFiles", "Files modified")}</div>
            <div className="cc-stat-value">{formatCount(data?.modifiedFiles ?? 0)}</div>
            <span className="cc-stat-sub">{t("commandCenter.productivity.volumeHint", "volume, not outcome")}</span>
          </div>
          <div className="card cc-stat-card" data-testid="cc-productivity-loc">
            <div className="cc-stat-label">{t("commandCenter.productivity.loc", "Lines changed")}</div>
            <div className="cc-stat-value">
              {locUnavailable ? (
                <span
                  className="cc-unavailable"
                  title={t(
                    "commandCenter.productivity.locUnavailable",
                    "LOC is unavailable until commit diff stats are recorded",
                  )}
                  data-testid="cc-productivity-loc-unavailable"
                >
                  —
                </span>
              ) : (
                formatCount(loc.value ?? 0)
              )}
            </div>
            <span className="cc-stat-sub">{t("commandCenter.productivity.volumeHint", "volume, not outcome")}</span>
          </div>
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.productivity.durationTitle", "Task duration")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-productivity-duration-completed">
            <div className="cc-stat-label">{t("commandCenter.productivity.completedTasks", "Completed tasks")}</div>
            <div className="cc-stat-value">{formatCount(taskDuration.completedTasks)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-productivity-duration-avg">
            <div className="cc-stat-label">{t("commandCenter.productivity.averageDuration", "Average")}</div>
            <div className="cc-stat-value">
              {renderDurationValue(taskDuration.averageMs, "cc-productivity-duration-avg-unavailable")}
            </div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-productivity-duration-median">
            <div className="cc-stat-label">{t("commandCenter.productivity.medianDuration", "Median")}</div>
            <div className="cc-stat-value">
              {renderDurationValue(taskDuration.medianMs, "cc-productivity-duration-median-unavailable")}
            </div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-productivity-duration-p90">
            <div className="cc-stat-label">{t("commandCenter.productivity.p90Duration", "P90")}</div>
            <div className="cc-stat-value">
              {renderDurationValue(taskDuration.p90Ms, "cc-productivity-duration-p90-unavailable")}
            </div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-productivity-duration-total">
            <div className="cc-stat-label">{t("commandCenter.productivity.totalDuration", "Total active")}</div>
            <div className="cc-stat-value">
              {renderDurationValue(taskDuration.totalMs, "cc-productivity-duration-total-unavailable")}
            </div>
          </div>
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">
          {t("commandCenter.productivity.byLanguage", "Files by language")}
        </h3>
        <Bar data={languageBars} ariaLabel={t("commandCenter.productivity.byLanguage", "Files by language")} />
      </div>

      {languagePieData.length > 0 ? (
        <div className="cc-area-section" data-testid="cc-productivity-pie">
          <h3 className="cc-area-section-title">
            {t("commandCenter.productivity.languagePie", "Language share")}
          </h3>
          <PieChart
            data={languagePieData}
            ariaLabel={t("commandCenter.productivity.languagePie", "Language share")}
          />
        </div>
      ) : null}
    </AreaShell>
  );
}
