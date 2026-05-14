import { useCallback, useEffect, useMemo, useState } from "react";
import "./ReliabilityView.css";

type ReliabilityResponse = {
  windowDays: number;
  generatedAt: string;
  headline: { inReviewFailureRate7d: number | null; reason?: string };
  perDay: Array<{
    date: string;
    tasksEnteredInReview: number;
    tasksBouncedToInProgress: number;
    postMergeAuditFailures: { block: number; warn: number; off: number } | null;
    fileScopeInvariantFailures: number | null;
    recoverAlreadyMergedReviewTasksRecoveries: number | null;
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
  const minutes = value / 60_000;
  return `${minutes.toFixed(1)}m`;
}

export function ReliabilityView() {
  const [data, setData] = useState<ReliabilityResponse | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/health/reliability");
    if (!response.ok) {
      throw new Error(`Failed to load reliability metrics (${response.status})`);
    }
    const payload = (await response.json()) as ReliabilityResponse;
    setData(payload);
  }, []);

  useEffect(() => {
    void load();
    const pollInterval = setInterval(() => {
      void load();
    }, 60_000);
    return () => clearInterval(pollInterval);
  }, [load]);

  const headlineColorVar = useMemo(() => {
    const rate = data?.headline.inReviewFailureRate7d;
    if (rate === null || rate === undefined) {
      return "var(--text-muted)";
    }
    if (rate < 0.05) {
      return "var(--color-success)";
    }
    if (rate < 0.1) {
      return "var(--color-warning)";
    }
    return "var(--color-error)";
  }, [data]);

  return (
    <section className="reliability-view">
      <div className="card reliability-card reliability-headline-card">
        <h2>Reliability</h2>
        <div className="reliability-headline" style={{ color: headlineColorVar }}>
          {data?.headline.inReviewFailureRate7d === null || data?.headline.inReviewFailureRate7d === undefined
            ? `Insufficient data — ${data?.headline.reason ?? "unknown"}`
            : formatPercent(data.headline.inReviewFailureRate7d)}
        </div>
      </div>

      <div className="reliability-grid">
        <div className="card reliability-card">
          <h3>In-review flow</h3>
          <table className="reliability-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Entered</th>
                <th>Bounced</th>
              </tr>
            </thead>
            <tbody>
              {data?.perDay.map((row) => (
                <tr key={row.date}>
                  <td>{row.date}</td>
                  <td>{row.tasksEnteredInReview}</td>
                  <td>{row.tasksBouncedToInProgress}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card reliability-card">
          <h3>Duration</h3>
          <div className="reliability-stat-row"><span>P50</span><strong>{formatDuration(data?.duration.p50Ms ?? null)}</strong></div>
          <div className="reliability-stat-row"><span>P95</span><strong>{formatDuration(data?.duration.p95Ms ?? null)}</strong></div>
          <div className="reliability-muted">Samples: {data?.duration.sampleCount ?? 0}</div>
        </div>

        <div className="card reliability-card">
          <h3>Merge attempts</h3>
          <div className="reliability-stat-row"><span>Mean</span><strong>{data?.mergeAttempts.mean?.toFixed(2) ?? "—"}</strong></div>
          <div className="reliability-stat-row"><span>Max</span><strong>{data?.mergeAttempts.max ?? "—"}</strong></div>
          <ul className="reliability-histogram">
            {Object.entries(data?.mergeAttempts.histogram ?? {}).map(([bucket, count]) => (
              <li key={bucket}>
                <span>{bucket}</span>
                <div className="reliability-histogram-bar-wrap"><div className="reliability-histogram-bar" style={{ width: `${Math.min(count * 20, 100)}%` }} /></div>
                <strong>{count}</strong>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
