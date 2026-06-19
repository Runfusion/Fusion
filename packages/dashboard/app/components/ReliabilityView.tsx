import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2 } from "lucide-react";
import { LineChart, PieChart } from "./command-center/charts/recharts";
import type { LineChartSeries, PieChartDatum } from "./command-center/charts/recharts";
import "./ReliabilityView.css";

type ReliabilityResponse = {
  windowDays: number;
  generatedAt: string;
  resetAt: string | null;
  headline: { inReviewFailureRate7d: number | null; reason?: string };
  perDay: Array<{
    date: string;
    tasksEnteredInReview: number;
    tasksBouncedToInProgress: number;
    postMergeAuditFailures: { block: number; warn: number; off: number } | null;
    fileScopeInvariantFailures: number | null;
    recoverAlreadyMergedReviewTasksRecoveries: number | null;
    hasSamples?: boolean;
  }>;
  duration: { p50Ms: number | null; p95Ms: number | null; sampleCount: number; reason?: string };
  mergeAttempts: { mean: number | null; max: number | null; histogram: Record<string, number>; reason?: string };
};

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return `${(value / 60_000).toFixed(1)}m`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function ReliabilityView() {
  const { t } = useTranslation("app");
  const [data, setData] = useState<ReliabilityResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEmptyDays, setShowEmptyDays] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/health/reliability");
      if (!response.ok) {
        throw new Error(`Failed to load reliability metrics (${response.status})`);
      }
      const payload = (await response.json()) as ReliabilityResponse;
      setData(payload);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : t("reliability.failedToLoad", "Failed to load reliability metrics"));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  const resetStats = useCallback(async () => {
    setResetError(null);
    const response = await fetch("/api/health/reliability/reset", { method: "POST" });
    if (!response.ok) {
      throw new Error(`Failed to reset reliability metrics (${response.status})`);
    }
    await load();
    setShowResetConfirm(false);
  }, [load]);

  useEffect(() => {
    void load();
    const pollInterval = setInterval(() => {
      void load();
    }, 60_000);
    return () => clearInterval(pollInterval);
  }, [load]);

  const failureRate = data?.headline.inReviewFailureRate7d;
  const reliabilityRate = useMemo(() => {
    if (failureRate === null || failureRate === undefined) return null;
    return Math.max(0, Math.min(1, 1 - failureRate));
  }, [failureRate]);

  const headlineColorVar = useMemo(() => {
    if (reliabilityRate === null) return "var(--text-muted)";
    if (reliabilityRate >= 0.95) return "var(--color-success)";
    if (reliabilityRate >= 0.9) return "var(--color-warning)";
    return "var(--color-error)";
  }, [reliabilityRate]);

  const totalEntered = useMemo(() => (data?.perDay ?? []).reduce((sum, row) => sum + row.tasksEnteredInReview, 0), [data?.perDay]);
  const totalBounced = useMemo(() => (data?.perDay ?? []).reduce((sum, row) => sum + row.tasksBouncedToInProgress, 0), [data?.perDay]);

  const perDayRows = useMemo(() => {
    if (!data?.perDay) return [];
    const filteredRows = showEmptyDays ? data.perDay : data.perDay.filter((row) => row.hasSamples !== false);
    return [...filteredRows].sort((left, right) => left.date.localeCompare(right.date));
  }, [data?.perDay, showEmptyDays]);

  /*
  FNXC:Reliability 2026-06-19-00:00:
  The in-review trend chart must reuse the same perDayRows source as the table, including the Show empty days filter, so visual and tabular reliability surfaces never disagree about which dates are represented.
  */
  const flowChartSeries = useMemo<LineChartSeries[]>(() => {
    const hasFlowSamples = perDayRows.some((row) => row.tasksEnteredInReview > 0 || row.tasksBouncedToInProgress > 0);
    if (!hasFlowSamples) return [];
    return [
      { label: t("reliability.flowChart.entered", "Entered"), values: perDayRows.map((row) => row.tasksEnteredInReview) },
      { label: t("reliability.flowChart.bounced", "Bounced"), values: perDayRows.map((row) => row.tasksBouncedToInProgress) },
    ];
  }, [perDayRows, t]);

  const mergeAttemptsHistogramEntries = useMemo(
    () => Object.entries(data?.mergeAttempts.histogram ?? {}).sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true })),
    [data?.mergeAttempts.histogram],
  );

  const mergeAttemptsChartData = useMemo<PieChartDatum[]>(
    () => mergeAttemptsHistogramEntries.map(([bucket, count]) => ({ label: bucket, value: count })),
    [mergeAttemptsHistogramEntries],
  );

  const mergeAttemptTaskCount = useMemo(
    () => mergeAttemptsHistogramEntries.reduce((sum, [, count]) => sum + count, 0),
    [mergeAttemptsHistogramEntries],
  );

  const windowStartLabel = data
    ? formatDateTime(data.resetAt ?? new Date(Date.parse(data.generatedAt) - data.windowDays * 86_400_000).toISOString())
    : "—";

  if (isLoading && data === null) {
    return (
      <div className="reliability-loading" data-testid="reliability-loading">
        <Loader2 size={24} className="spin" />
        <p>{t("reliability.loading", "Loading reliability data...")}</p>
      </div>
    );
  }

  if (error !== null && data === null) {
    return (
      <div className="reliability-error" data-testid="reliability-error" role="alert">
        <AlertCircle size={24} />
        <p>{error}</p>
      </div>
    );
  }

  return (
    <section className="reliability-view">
      <div className="card reliability-card reliability-headline-card">
        <div className="reliability-section-header">
          <h2>{t("reliability.heading", "Reliability")}</h2>
          <button className="btn btn-danger btn-sm" onClick={() => setShowResetConfirm(true)}>{t("reliability.resetStats", "Reset stats")}</button>
        </div>
        <div className="reliability-headline" style={{ color: headlineColorVar }}>
          {failureRate === null || failureRate === undefined
            ? t("reliability.insufficientData", "Insufficient data — {{reason}}", { reason: data?.headline.reason ?? "unknown" })
            : formatPercent(reliabilityRate ?? 0)}
        </div>
        {reliabilityRate !== null ? <div className="reliability-muted">{t("reliability.successRateLabel", "In-review success rate (last 7d)")}</div> : null}
        {data?.resetAt ? <div className="reliability-muted">{t("reliability.countingSince", "Counting since {{date}}", { date: formatDateTime(data.resetAt) })}</div> : null}
        <details className="reliability-details">
          <summary>{t("reliability.details", "Details")}</summary>
          <div className="reliability-details-content">
            <div>{t("reliability.bouncedEntered", "{{bounced}} bounced / {{entered}} entered (last {{days}}d)", { bounced: totalBounced, entered: totalEntered, days: data?.windowDays ?? 7 })}</div>
            {failureRate !== null && failureRate !== undefined ? <div>{t("reliability.failureRate", "Failure rate: {{rate}}", { rate: formatPercent(failureRate) })}</div> : null}
            <div>{t("reliability.window", "Window: {{start}} → {{end}}", { start: windowStartLabel, end: formatDateTime(data?.generatedAt) })}</div>
            {data?.resetAt ? <div>{t("reliability.resetBaseline", "Reset baseline: {{date}}", { date: formatDateTime(data.resetAt) })}</div> : null}
            {data?.headline.reason ? <div>{t("reliability.reason", "Reason: {{reason}}", { reason: data.headline.reason })}</div> : null}
          </div>
        </details>
      </div>

      <div className="reliability-grid">
        <div className="card reliability-card">
          <div className="reliability-section-header">
            <h3>{t("reliability.inReviewFlow", "In-review flow")}</h3>
            <button className="btn btn-sm" onClick={() => setShowEmptyDays((value) => !value)}>
              {showEmptyDays ? t("reliability.hideEmptyDays", "Hide empty days") : t("reliability.showEmptyDays", "Show empty days")}
            </button>
          </div>
          <div className="reliability-chart-section" data-testid="reliability-flow-chart">
            <h4>{t("reliability.flowChart.heading", "Entered vs bounced trend")}</h4>
            <LineChart
              series={flowChartSeries}
              ariaLabel={t("reliability.flowChart.aria", "In-review entered vs bounced per day")}
              emptyLabel={t("reliability.flowChart.empty", "No in-review flow data")}
            />
          </div>
          <table className="reliability-table">
            <thead><tr><th>{t("reliability.table.date", "Date")}</th><th>{t("reliability.table.entered", "Entered")}</th><th>{t("reliability.table.bounced", "Bounced")}</th></tr></thead>
            <tbody>
              {perDayRows.map((row) => (
                <tr key={row.date}><td>{row.date}</td><td>{row.tasksEnteredInReview}</td><td>{row.tasksBouncedToInProgress}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card reliability-card">
          <h3>{t("reliability.duration.heading", "Duration")}</h3>
          <div className="reliability-stat-row"><span>{t("reliability.duration.p50", "P50")}</span><strong>{formatDuration(data?.duration.p50Ms ?? null)}</strong></div>
          <div className="reliability-stat-row"><span>{t("reliability.duration.p95", "P95")}</span><strong>{formatDuration(data?.duration.p95Ms ?? null)}</strong></div>
          <div className="reliability-muted">{t("reliability.duration.samples", "Samples: {{count}}", { count: data?.duration.sampleCount ?? 0 })}</div>
          <details className="reliability-details">
            <summary>{t("reliability.duration.moreStats", "More stats")}</summary>
            <div className="reliability-details-content">
              <div>{t("reliability.duration.p50Raw", "P50 raw: {{value}} ms", { value: data?.duration.p50Ms ?? "—" })}</div>
              <div>{t("reliability.duration.p95Raw", "P95 raw: {{value}} ms", { value: data?.duration.p95Ms ?? "—" })}</div>
              <div>{t("reliability.duration.sampleCount", "Sample count: {{count}}", { count: data?.duration.sampleCount ?? 0 })}</div>
              {data?.duration.reason ? <div>{t("reliability.duration.reason", "Reason: {{reason}}", { reason: data.duration.reason })}</div> : null}
            </div>
          </details>
        </div>

        <div className="card reliability-card">
          <h3>{t("reliability.mergeAttempts.heading", "Merge attempts")}</h3>
          <div className="reliability-stat-row"><span>{t("reliability.mergeAttempts.mean", "Mean")}</span><strong>{data?.mergeAttempts.mean?.toFixed(2) ?? "—"}</strong></div>
          <div className="reliability-stat-row"><span>{t("reliability.mergeAttempts.max", "Max")}</span><strong>{data?.mergeAttempts.max ?? "—"}</strong></div>
          <div className="reliability-chart-section" data-testid="reliability-merge-attempts-chart">
            <h4>{t("reliability.mergeAttemptsChart.heading", "Attempts distribution")}</h4>
            <PieChart
              data={mergeAttemptsChartData}
              ariaLabel={t("reliability.mergeAttemptsChart.aria", "Merge attempts histogram")}
              emptyLabel={t("reliability.mergeAttemptsChart.empty", "No merge attempt data")}
            />
          </div>
          <ul className="reliability-histogram">
            {mergeAttemptsHistogramEntries.map(([bucket, count]) => (
              <li key={bucket}>
                <span>{bucket}</span>
                <div className="reliability-histogram-bar-wrap"><div className="reliability-histogram-bar" style={{ width: `${Math.min(count * 20, 100)}%` }} /></div>
                <strong>{count}</strong>
              </li>
            ))}
          </ul>
          <details className="reliability-details">
            <summary>{t("reliability.mergeAttempts.moreStats", "More stats")}</summary>
            <div className="reliability-details-content">
              <div>{t("reliability.mergeAttempts.tasksCounted", "Tasks counted: {{count}}", { count: mergeAttemptTaskCount })}</div>
              <div>{t("reliability.mergeAttempts.histogramTotal", "Histogram total: {{count}}", { count: mergeAttemptTaskCount })}</div>
              {data?.mergeAttempts.reason ? <div>{t("reliability.mergeAttempts.reason", "Reason: {{reason}}", { reason: data.mergeAttempts.reason })}</div> : null}
            </div>
          </details>
        </div>
      </div>

      {showResetConfirm ? (
        <div className="modal-overlay open" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="reliability-reset-title">
            <div className="modal-header"><h2 id="reliability-reset-title">{t("reliability.resetModal.title", "Reset reliability stats?")}</h2></div>
            <p>{t("reliability.resetModal.description", "This sets a new baseline for reliability statistics. Historical events older than the reset time are excluded from counts but are not deleted.")}</p>
            {resetError ? <div className="form-error">{resetError}</div> : null}
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowResetConfirm(false)}>{t("common.cancel", "Cancel")}</button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  void resetStats().catch((error: unknown) => {
                    setResetError(error instanceof Error ? error.message : t("reliability.resetModal.failedError", "Failed to reset reliability stats"));
                  });
                }}
              >
                {t("reliability.resetModal.confirm", "Confirm reset")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
