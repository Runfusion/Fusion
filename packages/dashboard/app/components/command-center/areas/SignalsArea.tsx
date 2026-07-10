import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SignalsAnalytics } from "@fusion/core";
import type { DateRange } from "../DateRangePicker";
import { Bar } from "../charts/Bar";
import { PieChart } from "../charts/recharts";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCount } from "./areaShared";

type SignalConnectorStatus = {
  provider: string;
  configured: boolean;
};

type SignalConnectorsResponse = {
  connectors: SignalConnectorStatus[];
};

type SignalsAnalyticsWithConnectors = SignalsAnalytics & {
  connectors?: {
    configured: string[];
    anyConfigured: boolean;
  };
};

/*
FNXC:CommandCenter 2026-06-16-09:42:
Signals area of the Command Center (PR #1683). Surfaces external-signal volume/severity from the project-scoped incidents table so operators see incoming pressure alongside internal analytics.

FNXC:CommandCenter 2026-06-19-00:00:
Signals now reads a real `/api/command-center/signals` route backed by incidents instead of swallowing a missing endpoint. Empty still means no incident source has recorded data, and MTTR remains `—` until at least one incident is resolved. FN-6706 owns building external Sentry/Datadog/PagerDuty/webhook connectors into that incidents table.

FNXC:CommandCenterSignals 2026-07-02-00:00:
GitLab is a first-class Signals connector beside Sentry, Datadog, PagerDuty, and generic webhooks. Empty/setup copy must include GitLab while preserving the existing no-new-affordance Signals layout across desktop and mobile.

FNXC:CommandCenterSignals 2026-06-25-22:40:
Empty Signals copy is driven by the connectors-status endpoint, not fabricated metrics. Operators must see "no connector configured" when no HMAC secret exists and "configured, awaiting signals" when ingestion is ready but quiet; loading the status should keep the normal loading-before-empty behavior.
*/

export function SignalsArea({ range, projectId }: { range: DateRange; projectId?: string }) {
  const { t } = useTranslation("app");
  const { data, isLoading } = useAnalyticsArea<SignalsAnalyticsWithConnectors>("/command-center/signals", range, {
    projectId,
  });
  const { data: connectorsData, isLoading: isConnectorsLoading } = useAnalyticsArea<SignalConnectorsResponse>(
    "/command-center/signals/connectors",
    range,
    { projectId },
  );

  const sourceBars = useMemo(
    () => (data?.bySource ?? []).map((s) => ({ label: s.source, value: s.count, valueLabel: formatCount(s.count) })),
    [data?.bySource],
  );
  const severityBars = useMemo(
    () =>
      (data?.bySeverity ?? []).map((s) => ({ label: s.severity, value: s.count, valueLabel: formatCount(s.count) })),
    [data?.bySeverity],
  );
  /*
  FNXC:CommandCenterCharts 2026-06-19-00:00:
  Signals has no per-day series yet, so the chart affordance is an additive status pie from the already-fetched open/resolved counts; do not fabricate a line trend until the endpoint returns time buckets.
  */
  const statusPieData = useMemo(
    () => [
      { label: t("commandCenter.signals.open", "Open"), value: data?.open ?? 0 },
      { label: t("commandCenter.signals.resolved", "Resolved"), value: data?.resolved ?? 0 },
    ],
    [data?.open, data?.resolved, t],
  );

  const isEmpty = !data || data.totalSignals === 0;
  const configuredProvidersFromStatus = Array.isArray(connectorsData?.connectors)
    ? connectorsData.connectors.filter((connector) => connector.configured).map((connector) => connector.provider)
    : undefined;
  const configuredProviders = configuredProvidersFromStatus ?? data?.connectors?.configured ?? [];
  const hasConfiguredConnector = configuredProviders.length > 0 || data?.connectors?.anyConfigured === true;
  const emptyMessage = hasConfiguredConnector
    ? t(
      "commandCenter.signals.emptyAwaitingSignals",
      "Connector configured, awaiting signals in this range. Configured providers: {{providers}}.",
      { providers: configuredProviders.length > 0 ? configuredProviders.join(", ") : t("commandCenter.signals.providersUnknown", "unknown") },
    )
    : t(
      "commandCenter.signals.emptyNoConnectorConfigured",
      "No signal connector configured. Connect GitLab, Sentry, Datadog, PagerDuty, or a generic webhook to see incident metrics here.",
    );
  const hasStatusPie = !isEmpty && statusPieData.some((datum) => datum.value > 0);

  return (
    <AreaShell
      testId="signals"
      isLoading={isLoading || isConnectorsLoading}
      error={null}
      isEmpty={isEmpty}
      emptyMessage={emptyMessage}
    >
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.signals.summaryTitle", "Summary")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-signals-total">
            <div className="cc-stat-label">{t("commandCenter.signals.total", "Total signals")}</div>
            <div className="cc-stat-value">{formatCount(data?.totalSignals ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-signals-open">
            <div className="cc-stat-label">{t("commandCenter.signals.open", "Open")}</div>
            <div className="cc-stat-value">{formatCount(data?.open ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-signals-resolved">
            <div className="cc-stat-label">{t("commandCenter.signals.resolved", "Resolved")}</div>
            <div className="cc-stat-value">{formatCount(data?.resolved ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-signals-mttr">
            <div className="cc-stat-label">{t("commandCenter.signals.mttr", "MTTR")}</div>
            <div className="cc-stat-value">
              {data && data.mttr.value !== null && !data.mttr.unavailable ? (
                t("commandCenter.signals.mttrValue", "{{min}} min", { min: Math.round(data.mttr.value) })
              ) : (
                <span
                  className="cc-unavailable"
                  title={t("commandCenter.signals.mttrUnavailable", "MTTR is unavailable until incident data is recorded")}
                >
                  —
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {hasStatusPie ? (
        <div className="cc-area-section" data-testid="cc-signals-pie">
          <h3 className="cc-area-section-title">{t("commandCenter.signals.statusShare", "Signal status share")}</h3>
          <PieChart data={statusPieData} ariaLabel={t("commandCenter.signals.statusShare", "Signal status share")} />
        </div>
      ) : null}

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.signals.bySource", "By source")}</h3>
        <Bar data={sourceBars} ariaLabel={t("commandCenter.signals.bySource", "By source")} />
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.signals.bySeverity", "By severity")}</h3>
        <Bar data={severityBars} ariaLabel={t("commandCenter.signals.bySeverity", "By severity")} />
      </div>
    </AreaShell>
  );
}
