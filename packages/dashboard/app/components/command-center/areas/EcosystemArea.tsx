import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PluginActivationAnalytics, TokenAnalytics } from "@fusion/core";
import type { DateRange } from "../DateRangePicker";
import { inferProviderIconKey } from "../../../utils/providerIconKey";
import { Bar } from "../charts/Bar";
import { LineChart, PieChart } from "../charts/recharts";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCount } from "./areaShared";

/**
 * Ecosystem area: ecosystem breadth derived from the tokens endpoint grouped by
 * model (per KTD/plan: "reuses the tokens endpoint grouped by model where
 * possible"). Shows the unique-active-model count and a per-model activity bar
 * (tasks per model as the activity proxy — token rows carry `nTasks`, not a
 * session count). Plugin activation count uses the project-scoped activation
 * event source and renders the unavailable sentinel when no activation rows
 * exist in range rather than a misleading 0.
 *
 * FNXC:CommandCenterEcosystem 2026-06-19-08:10:
 * Plugin activations now come from recorded load/reload events. Show a real count only when the activation endpoint reports in-range rows; no rows, loading, or plugin-analytics errors must keep the honest `—` sentinel.
 */
export function EcosystemArea({ range, projectId }: { range: DateRange; projectId?: string }) {
  const { t } = useTranslation("app");
  const { data, isLoading, error } = useAnalyticsArea<TokenAnalytics>(
    "/command-center/tokens?groupBy=model&granularity=day",
    range,
    { projectId },
  );
  const { data: pluginActivations, isLoading: pluginActivationsLoading } = useAnalyticsArea<PluginActivationAnalytics>(
    "/command-center/plugin-activations",
    range,
    { projectId },
  );

  const models = useMemo(
    () => (data?.groups ?? []).filter((g) => (g.key ?? "").trim().length > 0),
    [data?.groups],
  );

  const uniqueModels = models.length;

  const perModelBars = useMemo(
    () =>
      [...models]
        .sort((a, b) => b.nTasks - a.nTasks || (a.key ?? "").localeCompare(b.key ?? ""))
        .slice(0, 12)
        .map((g) => {
          const label = g.key ?? t("commandCenter.tokens.unknownModel", "(unknown)");
          return {
            label,
            value: g.nTasks,
            valueLabel: formatCount(g.nTasks),
            iconProvider: inferProviderIconKey(g.key ?? ""),
          };
        }),
    [models, t],
  );
  /*
  FNXC:CommandCenterCharts 2026-06-19-00:00:
  Ecosystem charts must reuse the existing token analytics endpoint: per-model task counts become the pie, and optional token buckets become a trend line without fabricating series when the endpoint returns none.
  */
  const perModelPieData = useMemo(
    () => perModelBars.map((datum) => ({ label: datum.label, value: datum.value })),
    [perModelBars],
  );
  const tokenTrendSeries = useMemo(
    () => [
      {
        label: t("commandCenter.ecosystem.tokenTrendSeries", "Tokens"),
        values: (data?.series ?? []).map((point) => point.totalTokens),
      },
      {
        label: t("commandCenter.ecosystem.taskTrendSeries", "Tasks"),
        values: (data?.series ?? []).map((point) => point.nTasks),
      },
    ],
    [data?.series, t],
  );
  const hasModelPie = perModelPieData.some((datum) => datum.value > 0);
  const hasTokenTrend = (data?.series ?? []).length > 0;

  const hasPluginActivations = pluginActivations?.unavailable === false;
  const isEmpty = (!data || uniqueModels === 0) && !hasPluginActivations;
  const shellLoading = isLoading || (pluginActivationsLoading && !data);

  return (
    <AreaShell
      testId="ecosystem"
      isLoading={shellLoading}
      error={error}
      isEmpty={isEmpty}
      emptyMessage={t("commandCenter.ecosystem.empty", "No models or plugins active in the selected range.")}
    >
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.ecosystem.breadthTitle", "Ecosystem breadth")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-ecosystem-unique-models">
            <div className="cc-stat-label">{t("commandCenter.ecosystem.uniqueModels", "Active models")}</div>
            <div className="cc-stat-value">{formatCount(uniqueModels)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-ecosystem-plugins">
            <div className="cc-stat-label">{t("commandCenter.ecosystem.plugins", "Plugin activations")}</div>
            <div className="cc-stat-value">
              {hasPluginActivations ? (
                <span data-testid="cc-ecosystem-plugins-value">{formatCount(pluginActivations?.activations ?? 0)}</span>
              ) : (
                <span
                  className="cc-unavailable"
                  title={t("commandCenter.ecosystem.pluginsUnavailable", "Plugin-activation metrics are not yet recorded")}
                  data-testid="cc-ecosystem-plugins-unavailable"
                >
                  —
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {hasModelPie ? (
        <div className="cc-area-section" data-testid="cc-ecosystem-pie">
          <h3 className="cc-area-section-title">{t("commandCenter.ecosystem.modelShareTitle", "Task share by model")}</h3>
          <PieChart data={perModelPieData} ariaLabel={t("commandCenter.ecosystem.modelShareTitle", "Task share by model")} />
        </div>
      ) : null}

      {hasTokenTrend ? (
        <div className="cc-area-section" data-testid="cc-ecosystem-line">
          <h3 className="cc-area-section-title">{t("commandCenter.ecosystem.trendTitle", "Ecosystem trend")}</h3>
          <LineChart series={tokenTrendSeries} ariaLabel={t("commandCenter.ecosystem.trendTitle", "Ecosystem trend")} />
        </div>
      ) : null}

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.ecosystem.perModelTitle", "Tasks per model")}</h3>
        <Bar data={perModelBars} ariaLabel={t("commandCenter.ecosystem.perModelTitle", "Tasks per model")} />
      </div>
    </AreaShell>
  );
}
