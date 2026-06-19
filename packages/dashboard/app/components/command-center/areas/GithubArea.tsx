/*
FNXC:CommandCenterGithub 2026-06-18-00:00:
The GitHub Command Center area visualizes only locally persisted task-store data: filed issues come from `githubTracking.issue`, and fixed issues are source-GitHub tasks currently in `done` using `updatedAt` as the documented completion approximation. No GitHub API or `gh` CLI calls belong in this rendering path.
*/
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import type { GithubIssueAnalytics } from "@fusion/core";
import { apiBackfillGithubSourceIssueClosedAt } from "../../../api/legacy";
import type { GithubSourceIssueClosedAtBackfillResult } from "../../../api/legacy";
import type { DateRange } from "../DateRangePicker";
import { Bar } from "../charts/Bar";
import { Sparkline } from "../charts/Sparkline";
import { LineChart, PieChart } from "../charts/recharts";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCount } from "./areaShared";

const GITHUB_SOURCE_ISSUE_BACKFILL_LIMIT = 100;
const GITHUB_SOURCE_ISSUE_BACKFILL_MAX_BATCHES = 1000;

type BackfillAggregate = Omit<GithubSourceIssueClosedAtBackfillResult, "hasMore">;

export function GithubArea({ range }: { range: DateRange }) {
  const { t } = useTranslation("app");
  const { data, isLoading, error } = useAnalyticsArea<GithubIssueAnalytics>(
    "/command-center/github",
    range,
  );
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<BackfillAggregate | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  const handleBackfill = useCallback(async () => {
    if (isBackfilling) return;

    setIsBackfilling(true);
    setBackfillResult(null);
    setBackfillError(null);

    try {
      let offset = 0;
      const aggregate: BackfillAggregate = { scanned: 0, filled: 0, skipped: 0, errors: 0 };

      for (let batch = 0; batch < GITHUB_SOURCE_ISSUE_BACKFILL_MAX_BATCHES; batch += 1) {
        const result = await apiBackfillGithubSourceIssueClosedAt({
          offset,
          limit: GITHUB_SOURCE_ISSUE_BACKFILL_LIMIT,
        });
        aggregate.scanned += result.scanned;
        aggregate.filled += result.filled;
        aggregate.skipped += result.skipped;
        aggregate.errors += result.errors;

        if (!result.hasMore) {
          setBackfillResult(aggregate);
          return;
        }

        offset += GITHUB_SOURCE_ISSUE_BACKFILL_LIMIT;
      }

      setBackfillResult(aggregate);
      setBackfillError(
        t(
          "commandCenter.github.backfillMaxBatches",
          "Backfill stopped after the safety limit; rerun after checking server logs.",
        ),
      );
    } catch (err) {
      setBackfillError(
        err instanceof Error
          ? err.message
          : t("commandCenter.github.backfillFailed", "Failed to backfill GitHub source issue close times"),
      );
    } finally {
      setIsBackfilling(false);
    }
  }, [isBackfilling, t]);

  const daily = useMemo(() => data?.daily ?? [], [data?.daily]);
  const byRepo = useMemo(() => data?.byRepo ?? [], [data?.byRepo]);
  const filedValues = useMemo(() => daily.map((d) => d.filed), [daily]);
  const fixedValues = useMemo(() => daily.map((d) => d.fixed), [daily]);
  const maxDaily = useMemo(
    () => Math.max(0, ...filedValues, ...fixedValues),
    [filedValues, fixedValues],
  );
  const repoBars = useMemo(
    () =>
      byRepo.slice(0, 12).map((repo) => ({
        label: repo.repo,
        value: repo.filed + repo.fixed,
        valueLabel: t("commandCenter.github.repoValue", "{{filed}} filed / {{fixed}} fixed", {
          filed: formatCount(repo.filed),
          fixed: formatCount(repo.fixed),
        }),
      })),
    [byRepo, t],
  );
  /*
  FNXC:CommandCenterCharts 2026-06-19-00:00:
  GitHub charts must remain local-task-store only: filed/fixed totals become the pie, and the already-fetched daily filed/fixed buckets become a real trend line while existing sparklines and repository bars stay additive.
  */
  const issueFlowPieData = useMemo(
    () => [
      { label: t("commandCenter.github.filed", "Filed by Fusion"), value: data?.filed ?? 0 },
      { label: t("commandCenter.github.fixed", "Fixed by Fusion"), value: data?.fixed ?? 0 },
    ],
    [data?.filed, data?.fixed, t],
  );
  const issueFlowLineSeries = useMemo(
    () => [
      { label: t("commandCenter.github.filedTrend", "Filed"), values: filedValues },
      { label: t("commandCenter.github.fixedTrend", "Fixed"), values: fixedValues },
    ],
    [filedValues, fixedValues, t],
  );

  const filed = data?.filed ?? 0;
  const fixed = data?.fixed ?? 0;
  const net = data?.net ?? filed - fixed;
  const isEmpty = !data || (filed === 0 && fixed === 0);
  const hasDailyTrend = daily.length > 0;
  const hasIssueFlowPie = filed + fixed > 0;
  const hasRepoBreakdown = repoBars.length > 0;
  const backfillStatusClass = backfillError || (backfillResult?.errors ?? 0) > 0
    ? "cc-github-backfill-status--error"
    : isBackfilling
      ? "cc-github-backfill-status--warning"
      : "";

  return (
    <AreaShell
      testId="github"
      isLoading={isLoading}
      error={error}
      isEmpty={false}
      emptyMessage={t("commandCenter.github.empty", "No GitHub issue activity in the selected range.")}
    >
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.github.totalsTitle", "GitHub issue flow")}</h3>
        {isEmpty ? (
          <span className="cc-stat-sub">{t("commandCenter.github.empty", "No GitHub issue activity in the selected range.")}</span>
        ) : null}
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-github-filed">
            <div className="cc-stat-label">{t("commandCenter.github.filed", "Filed by Fusion")}</div>
            <div className="cc-stat-value">{formatCount(filed)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-github-fixed">
            <div className="cc-stat-label">{t("commandCenter.github.fixed", "Fixed by Fusion")}</div>
            <div className="cc-stat-value">{formatCount(fixed)}</div>
            <span className="cc-stat-sub">
              {t("commandCenter.github.fixedApproximation", "Uses done tasks updated in range")}
            </span>
            {/*
              FNXC:CommandCenterGithub 2026-06-18-19:24:
              This backfill is an explicit operator action that paginates the FN-6674 endpoint until `hasMore === false`, then surfaces scanned/filled/skipped/errors. Keep GitHub network fetches here in the click handler only; Command Center analytics and render-time data loading must stay backed by local task-store data.
            */}
            <div className="cc-github-backfill-actions">
              <button
                type="button"
                className="btn"
                data-testid="cc-github-backfill-button"
                onClick={() => void handleBackfill()}
                disabled={isBackfilling}
              >
                <RefreshCw className={isBackfilling ? "spin" : undefined} />
                <span>
                  {isBackfilling
                    ? t("commandCenter.github.backfillBusy", "Backfilling close times…")
                    : t("commandCenter.github.backfillButton", "Backfill exact close times")}
                </span>
              </button>
            </div>
            {isBackfilling || backfillResult || backfillError ? (
              <div
                className={`cc-github-backfill-status ${backfillStatusClass}`.trim()}
                data-testid="cc-github-backfill-result"
                role="status"
              >
                {isBackfilling ? (
                  <span>{t("commandCenter.github.backfillPending", "Backfill is running in paginated batches.")}</span>
                ) : null}
                {backfillError ? <span>{backfillError}</span> : null}
                {backfillResult ? (
                  <span>
                    {backfillResult.scanned === 0 && backfillResult.filled === 0
                      ? t(
                          "commandCenter.github.backfillNothing",
                          "Nothing to backfill. Scanned {{scanned}}, filled {{filled}}, skipped {{skipped}}, errors {{errors}}.",
                          backfillResult,
                        )
                      : t(
                          "commandCenter.github.backfillResult",
                          "Backfill complete. Scanned {{scanned}}, filled {{filled}}, skipped {{skipped}}, errors {{errors}}.",
                          backfillResult,
                        )}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="card cc-stat-card" data-testid="cc-github-net">
            <div className="cc-stat-label">{t("commandCenter.github.net", "Net")}</div>
            <div className="cc-stat-value">{formatCount(net)}</div>
          </div>
        </div>
      </div>

      {hasIssueFlowPie ? (
        <div className="cc-area-section" data-testid="cc-github-pie">
          <h3 className="cc-area-section-title">{t("commandCenter.github.issueFlowShare", "Filed vs fixed share")}</h3>
          <PieChart data={issueFlowPieData} ariaLabel={t("commandCenter.github.issueFlowShare", "Filed vs fixed share")} />
        </div>
      ) : null}

      {hasDailyTrend ? (
        <div className="cc-area-section" data-testid="cc-github-line">
          <h3 className="cc-area-section-title">{t("commandCenter.github.dailyLine", "Filed vs fixed line")}</h3>
          <LineChart series={issueFlowLineSeries} ariaLabel={t("commandCenter.github.dailyLine", "Filed vs fixed line")} />
        </div>
      ) : null}

      {hasDailyTrend ? (
        <div className="cc-area-section" data-testid="cc-github-daily-trend">
          <h3 className="cc-area-section-title">{t("commandCenter.github.dailyTrend", "Filed vs fixed trend")}</h3>
          <div className="cc-stat-grid">
            <div className="card cc-stat-card">
              <div className="cc-stat-label">{t("commandCenter.github.filedTrend", "Filed")}</div>
              <Sparkline
                values={filedValues}
                max={maxDaily}
                ariaLabel={t("commandCenter.github.filedTrend", "Filed")}
              />
            </div>
            <div className="card cc-stat-card">
              <div className="cc-stat-label">{t("commandCenter.github.fixedTrend", "Fixed")}</div>
              <Sparkline
                values={fixedValues}
                max={maxDaily}
                ariaLabel={t("commandCenter.github.fixedTrend", "Fixed")}
              />
            </div>
          </div>
        </div>
      ) : null}

      {hasRepoBreakdown ? (
        <div className="cc-area-section" data-testid="cc-github-by-repo">
          <h3 className="cc-area-section-title">{t("commandCenter.github.byRepo", "By repository")}</h3>
          <Bar data={repoBars} ariaLabel={t("commandCenter.github.byRepo", "By repository")} />
        </div>
      ) : null}
    </AreaShell>
  );
}
