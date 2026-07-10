import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityAnalytics } from "@fusion/core";
import type { DateRange } from "../DateRangePicker";
import { LineChart } from "../charts/LineChart";
import { Sparkline } from "../charts/Sparkline";
import { LineChart as RechartsLineChart, PieChart } from "../charts/recharts";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCount, isInvalidRange } from "./areaShared";

const ACTIVITY_LIVE_REFRESH_MS = 15_000;

/*
FNXC:CommandCenterCharts 2026-06-18-23:34:
The Activity surface must add FN-6682 recharts affordances without replacing the existing hand-rolled line/sparkline testids or live-refresh behavior. Reuse the current daily and agent-run outcome analytics; never introduce a new endpoint or fabricate missing dimensions.
*/

/**
 * FNXC:CommandCenter 2026-06-18-14:29:
 * Activity metrics surface as live, animated line charts auto-refreshed via reload() on a bounded interval; motion is decorative and reduced-motion-safe, uses the existing activity endpoint, and keeps prior data visible during polling revalidation.
 */
export function ActivityArea({ range, projectId }: { range: DateRange; projectId?: string }) {
  const { t } = useTranslation("app");
  const { data, isLoading, error, reload } = useAnalyticsArea<ActivityAnalytics>("/command-center/activity", range, {
    projectId,
  });

  const daily = useMemo(() => data?.daily ?? [], [data?.daily]);
  const messagesSeries = useMemo(() => daily.map((d) => d.messages), [daily]);
  const agentsSeries = useMemo(() => daily.map((d) => d.activeAgents), [daily]);
  const nodesSeries = useMemo(() => daily.map((d) => d.activeNodes), [daily]);
  const agentRunsSeries = useMemo(() => daily.map((d) => d.agentRuns), [daily]);
  const throughputSeries = useMemo(
    () => daily.map((d) => d.messages + d.activeAgents + d.activeNodes),
    [daily],
  );
  const rechartsLineSeries = useMemo(
    () => [
      { label: t("commandCenter.activity.messages", "Messages"), values: messagesSeries },
      { label: t("commandCenter.activity.activeAgents", "Active agents"), values: agentsSeries },
      { label: t("commandCenter.activity.agentRuns", "Agent runs"), values: agentRunsSeries },
    ],
    [agentRunsSeries, agentsSeries, messagesSeries, t],
  );
  const invalidRange = isInvalidRange(range);
  const isInitialLoading = isLoading && data === null;

  useEffect(() => {
    if (invalidRange) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      reload();
    }, ACTIVITY_LIVE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [invalidRange, reload]);

  const agentRuns = data?.agentRuns ?? { total: 0, active: 0, completed: 0, failed: 0 };
  const agentRunPieData = useMemo(
    () => [
      { label: t("commandCenter.activity.agentRunsActive", "Active"), value: agentRuns.active },
      { label: t("commandCenter.activity.agentRunsCompleted", "Completed"), value: agentRuns.completed },
      { label: t("commandCenter.activity.agentRunsFailed", "Failed"), value: agentRuns.failed },
    ].filter((entry) => entry.value > 0),
    [agentRuns.active, agentRuns.completed, agentRuns.failed, t],
  );
  const isEmpty =
    !data ||
    (data.sessions === 0 &&
      data.messages === 0 &&
      data.activeNodes === 0 &&
      data.activeAgents === 0 &&
      agentRuns.total === 0);

  return (
    <AreaShell testId="activity" isLoading={isInitialLoading} error={error} isEmpty={isEmpty}>
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.summaryTitle", "Summary")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-activity-sessions">
            <div className="cc-stat-label">{t("commandCenter.activity.sessions", "Sessions")}</div>
            <div className="cc-stat-value">{formatCount(data?.sessions ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-activity-messages">
            <div className="cc-stat-label">{t("commandCenter.activity.messages", "Messages")}</div>
            <div className="cc-stat-value">{formatCount(data?.messages ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-activity-nodes">
            <div className="cc-stat-label">{t("commandCenter.activity.activeNodes", "Active nodes")}</div>
            <div className="cc-stat-value">{formatCount(data?.activeNodes ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-activity-agents">
            <div className="cc-stat-label">{t("commandCenter.activity.activeAgents", "Active agents")}</div>
            <div className="cc-stat-value">{formatCount(data?.activeAgents ?? 0)}</div>
          </div>
          {/*
          FNXC:CommandCenter 2026-06-18-00:00:
          Activity Summary needs agent-run sheets for total, active, completed, and failed heartbeat runs so operators can read run volume without leaving the existing Command Center Activity surface.
          */}
          <div className="card cc-stat-card" data-testid="cc-activity-agent-runs">
            <div className="cc-stat-label">{t("commandCenter.activity.agentRuns", "Agent runs")}</div>
            <div className="cc-stat-value">{formatCount(agentRuns.total)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-activity-agent-runs-active">
            <div className="cc-stat-label">{t("commandCenter.activity.agentRunsActive", "Active")}</div>
            <div className="cc-stat-value">{formatCount(agentRuns.active)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-activity-agent-runs-completed">
            <div className="cc-stat-label">{t("commandCenter.activity.agentRunsCompleted", "Completed")}</div>
            <div className="cc-stat-value">{formatCount(agentRuns.completed)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-activity-agent-runs-failed">
            <div className="cc-stat-label">{t("commandCenter.activity.agentRunsFailed", "Failed")}</div>
            <div className="cc-stat-value">{formatCount(agentRuns.failed)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-activity-stickiness">
            <div className="cc-stat-label">{t("commandCenter.activity.stickiness", "Stickiness")}</div>
            <div className="cc-stat-value">{data ? `${Math.round(data.stickiness * 100)}%` : "—"}</div>
            <span className="cc-stat-sub">{t("commandCenter.activity.stickinessHint", "DAU / MAU")}</span>
          </div>
        </div>
      </div>

      {daily.length > 0 ? (
        <div className="cc-area-section" data-testid="cc-activity-line">
          <h3 className="cc-area-section-title">{t("commandCenter.activity.rechartsLine", "Activity trend")}</h3>
          {/*
          FNXC:CommandCenterCharts 2026-06-19-07:58:
          The Activity trend combines message volume with low-count agent/run series. Opt into per-series normalization so agent activity remains visible instead of being flattened by message-scale values.
          */}
          <RechartsLineChart
            series={rechartsLineSeries}
            ariaLabel={t("commandCenter.activity.rechartsLine", "Activity trend")}
            scaleMode="series"
          />
        </div>
      ) : null}

      {agentRunPieData.length > 0 ? (
        <div className="cc-area-section" data-testid="cc-activity-pie">
          <h3 className="cc-area-section-title">{t("commandCenter.activity.agentRunOutcomeShare", "Agent run outcome share")}</h3>
          <PieChart
            data={agentRunPieData}
            ariaLabel={t("commandCenter.activity.agentRunOutcomeShare", "Agent run outcome share")}
          />
        </div>
      ) : null}

      <div className="cc-area-section" data-testid="cc-activity-line-messages">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.messagesPerDay", "Messages / day")}</h3>
        <LineChart
          series={[{ label: t("commandCenter.activity.messages", "Messages"), values: messagesSeries }]}
          ariaLabel={t("commandCenter.activity.messagesPerDay", "Messages / day")}
        />
      </div>

      <div className="cc-area-section" data-testid="cc-activity-line-agents">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.agentsPerDay", "Active agents / day")}</h3>
        <LineChart
          series={[{ label: t("commandCenter.activity.activeAgents", "Active agents"), values: agentsSeries }]}
          ariaLabel={t("commandCenter.activity.agentsPerDay", "Active agents / day")}
        />
      </div>

      <div className="cc-area-section" data-testid="cc-activity-line-nodes">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.nodesPerDay", "Active nodes / day")}</h3>
        <LineChart
          series={[{ label: t("commandCenter.activity.activeNodes", "Active nodes"), values: nodesSeries }]}
          ariaLabel={t("commandCenter.activity.nodesPerDay", "Active nodes / day")}
        />
      </div>

      <div className="cc-area-section" data-testid="cc-activity-agent-runs-sparkline">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.agentRunsPerDay", "Agent runs / day")}</h3>
        <Sparkline
          values={agentRunsSeries}
          ariaLabel={t("commandCenter.activity.agentRunsPerDay", "Agent runs / day")}
        />
      </div>

      <div className="cc-area-section" data-testid="cc-activity-line-throughput">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.throughputPerDay", "Throughput / day")}</h3>
        <LineChart
          series={[{ label: t("commandCenter.activity.throughput", "Throughput"), values: throughputSeries }]}
          ariaLabel={t("commandCenter.activity.throughputPerDay", "Throughput / day")}
        />
      </div>
    </AreaShell>
  );
}
