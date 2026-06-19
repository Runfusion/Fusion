import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TokenAnalytics } from "@fusion/core";
import type { DateRange } from "../DateRangePicker";
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
 * session count). Plugin activation count has no current event source, so it
 * renders its unavailable sentinel rather than a misleading 0. Empty state when
 * no models have been used.
 *
 * FNXC:CommandCenter 2026-06-19-00:00:
 * FN-6705 owns real plugin activation recording. Keep the Plugin activations card at `—` until activation events are persisted and aggregated; model/task token trends are real but are not a plugin proxy.
 */
export function EcosystemArea({ range }: { range: DateRange }) {
  const { t } = useTranslation("app");
  const { data, isLoading, error } = useAnalyticsArea<TokenAnalytics>(
    "/command-center/tokens?groupBy=model&granularity=day",
    range,
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
        .map((g) => ({
          label: g.key ?? t("commandCenter.tokens.unknownModel", "(unknown)"),
          value: g.nTasks,
          valueLabel: formatCount(g.nTasks),
        })),
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

  const isEmpty = !data || uniqueModels === 0;

  return (
    <AreaShell
      testId="ecosystem"
      isLoading={isLoading}
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
              <span
                className="cc-unavailable"
                title={t("commandCenter.ecosystem.pluginsUnavailable", "Plugin-activation metrics are not yet recorded")}
                data-testid="cc-ecosystem-plugins-unavailable"
              >
                —
              </span>
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
