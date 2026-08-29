/*
FNXC:CommandCenterGitLab 2026-07-02-00:00:
The GitLab Command Center area mirrors GitHub issue-flow semantics but reads only the local `/command-center/gitlab` analytics endpoint. Rendering must not call GitLab.com, self-managed GitLab instances, `glab`, or any provider API; exact close-time repair remains an explicit backfill route outside render-time analytics.
*/
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { GitlabIssueAnalytics } from "@fusion/core";
import type { DateRange } from "../DateRangePicker";
import { Bar } from "../charts/Bar";
import { Sparkline } from "../charts/Sparkline";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCount } from "./areaShared";

function formatResolvedAt(value: string, fallback: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString();
}

export function GitlabArea({ range, projectId }: { range: DateRange; projectId?: string }) {
  const { t } = useTranslation("app");
  const { data, isLoading, error } = useAnalyticsArea<GitlabIssueAnalytics>(
    "/command-center/gitlab",
    range,
    { projectId },
  );

  const daily = useMemo(() => data?.daily ?? [], [data?.daily]);
  const byProject = useMemo(() => data?.byProject ?? [], [data?.byProject]);
  const resolved = useMemo(() => data?.resolved ?? [], [data?.resolved]);
  const filedValues = useMemo(() => daily.map((d) => d.filed), [daily]);
  const fixedValues = useMemo(() => daily.map((d) => d.fixed), [daily]);
  const maxDaily = useMemo(() => Math.max(0, ...filedValues, ...fixedValues), [filedValues, fixedValues]);
  const projectBars = useMemo(
    () => byProject.slice(0, 12).map((project) => ({
      label: project.project,
      value: project.filed + project.fixed,
      valueLabel: t("commandCenter.gitlab.projectValue", "{{filed}} filed / {{fixed}} fixed", {
        filed: formatCount(project.filed),
        fixed: formatCount(project.fixed),
      }),
    })),
    [byProject, t],
  );

  const filed = data?.filed ?? 0;
  const fixed = data?.fixed ?? 0;
  const net = data?.net ?? filed - fixed;
  const isEmpty = !data || (filed === 0 && fixed === 0);

  return (
    <AreaShell
      testId="gitlab"
      isLoading={isLoading}
      error={error}
      isEmpty={false}
      emptyMessage={t("commandCenter.gitlab.empty", "No GitLab issue or merge request activity in the selected range.")}
    >
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.gitlab.totalsTitle", "GitLab issue and MR flow")}</h3>
        {isEmpty ? (
          <span className="cc-stat-sub">{t("commandCenter.gitlab.empty", "No GitLab issue or merge request activity in the selected range.")}</span>
        ) : null}
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-gitlab-filed">
            <div className="cc-stat-label">{t("commandCenter.gitlab.filed", "Filed by Fusion")}</div>
            <div className="cc-stat-value">{formatCount(filed)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-gitlab-fixed">
            <div className="cc-stat-label">{t("commandCenter.gitlab.fixed", "Fixed by Fusion")}</div>
            <div className="cc-stat-value">{formatCount(fixed)}</div>
            <span className="cc-stat-sub">{t("commandCenter.gitlab.fixedApproximation", "Uses persisted GitLab close times when available")}</span>
          </div>
          <div className="card cc-stat-card" data-testid="cc-gitlab-net">
            <div className="cc-stat-label">{t("commandCenter.gitlab.net", "Net")}</div>
            <div className="cc-stat-value">{formatCount(net)}</div>
          </div>
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.gitlab.dailyTitle", "Daily GitLab flow")}</h3>
        {daily.length > 0 ? (
          <div className="cc-chart-grid">
            <div className="card cc-chart-card">
              <h4>{t("commandCenter.gitlab.filedTrend", "Filed")}</h4>
              <Sparkline values={filedValues} max={maxDaily} />
            </div>
            <div className="card cc-chart-card">
              <h4>{t("commandCenter.gitlab.fixedTrend", "Fixed")}</h4>
              <Sparkline values={fixedValues} max={maxDaily} />
            </div>
          </div>
        ) : <span className="cc-stat-sub">{t("commandCenter.gitlab.noDaily", "No daily GitLab trend data yet.")}</span>}
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.gitlab.projectsTitle", "Projects and groups")}</h3>
        {projectBars.length > 0 ? <Bar data={projectBars} /> : <span className="cc-stat-sub">{t("commandCenter.gitlab.noProjects", "No GitLab project activity yet.")}</span>}
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.gitlab.resolvedTitle", "Resolved GitLab source items")}</h3>
        {resolved.length > 0 ? (
          <div className="cc-resolved-list" data-testid="cc-gitlab-resolved-list">
            {resolved.slice(0, 12).map((item) => {
              const key = item.issueNumber === null ? item.project : `${item.project}#${item.issueNumber}`;
              const label = `${key} · ${item.taskId}`;
              return (
                <div className="card cc-resolved-item" key={`${item.taskId}:${item.resolvedAt}`}>
                  <div>
                    {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">{label}</a> : <strong>{label}</strong>}
                    <div className="cc-stat-sub">{item.taskTitle}</div>
                  </div>
                  <span className="cc-stat-sub">
                    {formatResolvedAt(item.resolvedAt, item.resolvedAt)}{item.resolvedAtExact ? "" : ` ${t("commandCenter.gitlab.approximate", "(approx.)")}`}
                  </span>
                </div>
              );
            })}
          </div>
        ) : <span className="cc-stat-sub">{t("commandCenter.gitlab.noResolved", "No resolved GitLab source items in range.")}</span>}
      </div>
    </AreaShell>
  );
}
