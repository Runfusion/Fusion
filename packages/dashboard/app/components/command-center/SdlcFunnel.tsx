import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityAnalytics } from "@fusion/core";
import type { DateRange } from "./DateRangePicker";
import { Funnel, type FunnelStage } from "./charts/Funnel";
import { RadialGauge } from "./charts/RadialGauge";
import { AreaShell } from "./areas/AreaShell";
import { useAnalyticsArea } from "./areas/useAnalyticsArea";
import { formatCount } from "./areas/areaShared";
import "./SdlcFunnel.css";

/** The funnel sub-shape carried on the activity analytics payload (U7). */
type SdlcFunnelData = ActivityAnalytics["funnel"];

/**
 * FNXC:CommandCenter 2026-07-08-00:00:
 * The SDLC funnel's intake stage displays as "Planning" (not "Triage") for
 * consistency with the renamed board column (FN-7660/FN-7665). The aggregator
 * stage KEY produced by aggregateSdlcFunnel and matched below stays "triage" —
 * only the English display text changes.
 *
 * Human-readable label per stage key, falling back to the raw key.
 */
function useStageLabels(): (stage: string) => string {
  const { t } = useTranslation("app");
  return (stage: string) => {
    switch (stage) {
      case "triage":
        return t("commandCenter.funnel.stage.triage", "Planning");
      case "todo":
        return t("commandCenter.funnel.stage.todo", "Todo");
      case "in-progress":
        return t("commandCenter.funnel.stage.inProgress", "In progress");
      case "in-review":
        return t("commandCenter.funnel.stage.inReview", "In review");
      case "done":
        return t("commandCenter.funnel.stage.done", "Done");
      case "other":
        return t("commandCenter.funnel.stage.other", "Other");
      default:
        return stage;
    }
  };
}

function formatThroughput(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

/**
 * SDLC funnel + throughput (U7). Renders the HISTORICAL funnel over the selected
 * date range from `activityLog` transitions (distinct from the live funnel in
 * Mission Control). Reads the `funnel` field that rides on the `/command-center/
 * activity` payload — no extra endpoint — and renders it via the U4 `Funnel`
 * primitive plus throughput / completion-rate stat cards.
 *
 * Stage labels are mapped from the stage **keys** the core aggregator produces
 * (which it derives by workflow trait, not column name), so custom workflow
 * columns surface correctly and unknown columns appear under "Other".
 */
export function SdlcFunnel({ range }: { range: DateRange }) {
  const { t } = useTranslation("app");
  const labelFor = useStageLabels();
  const { data, isLoading, error } = useAnalyticsArea<ActivityAnalytics>(
    "/command-center/activity",
    range,
  );

  const funnel: SdlcFunnelData | null = data?.funnel ?? null;

  const stages: FunnelStage[] = useMemo(
    () => (funnel?.stages ?? []).map((s) => ({ label: labelFor(s.stage), value: s.entered })),
    [funnel?.stages, labelFor],
  );

  const isEmpty =
    !funnel || funnel.stages.every((s) => s.entered === 0);

  return (
    <AreaShell
      testId="funnel"
      isLoading={isLoading}
      error={error}
      isEmpty={isEmpty}
      emptyMessage={t(
        "commandCenter.funnel.empty",
        "No task transitions in the selected range.",
      )}
    >
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">
          {t("commandCenter.funnel.title", "SDLC funnel")}
        </h3>
        <Funnel
          stages={stages}
          ariaLabel={t("commandCenter.funnel.ariaLabel", "Tasks per workflow stage")}
        />
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">
          {t("commandCenter.funnel.throughputTitle", "Throughput")}
        </h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card cc-stat-card--gauge" data-testid="cc-funnel-completion-rate">
            <RadialGauge
              value={funnel?.completionRate ?? null}
              label={t("commandCenter.funnel.completionRate", "Completion rate")}
              ariaLabel={t("commandCenter.funnel.completionRateAria", "Completion rate for in-range planning entrants")}
            />
            <span className="cc-stat-sub">
              {t("commandCenter.funnel.completionRateHint", "Done ÷ entered (in range)")}
            </span>
          </div>
          <div className="card cc-stat-card" data-testid="cc-funnel-throughput">
            <div className="cc-stat-label">
              {t("commandCenter.funnel.throughputPerDay", "Tasks done / day")}
            </div>
            <div className="cc-stat-value">{formatThroughput(funnel?.throughputPerDay ?? 0)}</div>
            <span className="cc-stat-sub">
              {t("commandCenter.funnel.rangeDays", "{{count}} day range", {
                count: funnel?.rangeDays ?? 0,
              })}
            </span>
          </div>
          <div className="card cc-stat-card" data-testid="cc-funnel-done">
            <div className="cc-stat-label">
              {t("commandCenter.funnel.doneInRange", "Reached done")}
            </div>
            <div className="cc-stat-value">{formatCount(funnel?.doneInRange ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-funnel-entered">
            <div className="cc-stat-label">
              {t("commandCenter.funnel.enteredInRange", "Entered planning")}
            </div>
            <div className="cc-stat-value">{formatCount(funnel?.enteredInRange ?? 0)}</div>
          </div>
        </div>
      </div>
    </AreaShell>
  );
}
