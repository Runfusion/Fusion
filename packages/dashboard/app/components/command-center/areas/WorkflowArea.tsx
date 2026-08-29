/*
FNXC:CommandCenter 2026-06-27-12:00:
The Workflows tab is an additive read-only per-workflow analytics surface paralleling Team. It consumes /command-center/workflows so operators can compare workflow token spend, task throughput, and files changed without adding editing controls or persisted schema.
*/
import { useTranslation } from "react-i18next";
import type { CostResult, WorkflowAnalytics, WorkflowSummary } from "@fusion/core";
import type { DateRange } from "../DateRangePicker";
import { Bar, type BarDatum } from "../charts/Bar";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCost, formatCount } from "./areaShared";
import { WorkflowIcon } from "../../WorkflowIcon";

type SortKey = "workflow" | "tokens" | "cost" | "filesChanged" | "tasksCompleted" | "tasksInProgress" | "tasksInReview";

function costSortValue(cost: CostResult): number {
  return cost.usd ?? -1;
}

function workflowLabel(workflow: WorkflowSummary, unknownLabel: string): string {
  return workflow.workflowName || workflow.workflowId || unknownLabel;
}

function sortWorkflows(workflows: WorkflowSummary[], key: SortKey, dir: 1 | -1, unknownLabel: string): WorkflowSummary[] {
  const sorted = [...workflows];
  sorted.sort((a, b) => {
    let cmp = 0;
    if (key === "workflow") {
      cmp = workflowLabel(a, unknownLabel).localeCompare(workflowLabel(b, unknownLabel));
    } else if (key === "tokens") {
      cmp = a.tokens.totalTokens - b.tokens.totalTokens;
    } else if (key === "cost") {
      cmp = costSortValue(a.cost) - costSortValue(b.cost);
    } else if (key === "filesChanged") {
      cmp = a.filesChanged - b.filesChanged;
    } else if (key === "tasksCompleted") {
      cmp = a.tasksCompleted - b.tasksCompleted;
    } else if (key === "tasksInProgress") {
      cmp = a.tasksInProgress - b.tasksInProgress;
    } else {
      cmp = a.tasksInReview - b.tasksInReview;
    }
    if (cmp === 0) cmp = a.workflowId.localeCompare(b.workflowId);
    return cmp * dir;
  });
  return sorted;
}

function buildBarData(
  workflows: WorkflowSummary[],
  valueFor: (workflow: WorkflowSummary) => number,
  unknownLabel: string,
): BarDatum[] {
  return [...workflows]
    .sort((a, b) => valueFor(b) - valueFor(a) || a.workflowId.localeCompare(b.workflowId))
    .slice(0, 12)
    .map((workflow) => {
      const value = valueFor(workflow);
      return {
        label: workflowLabel(workflow, unknownLabel),
        value,
        valueLabel: formatCount(value),
      };
    });
}

export function WorkflowArea({ range, projectId }: { range: DateRange; projectId?: string }) {
  const { t } = useTranslation("app");
  const { data, isLoading, error } = useAnalyticsArea<WorkflowAnalytics>("/command-center/workflows", range, {
    projectId,
  });
  const unknownWorkflow = t("commandCenter.workflows.unknownWorkflow", "(unknown workflow)");
  const noChartData = t("commandCenter.workflows.noChartData", "No non-zero values for this chart yet.");

  const workflows = data?.workflows ?? [];
  const sortedWorkflows = sortWorkflows(workflows, "tokens", -1, unknownWorkflow);
  const tokenBarData = buildBarData(workflows, (workflow) => workflow.tokens.totalTokens, unknownWorkflow);
  const completedBarData = buildBarData(workflows, (workflow) => workflow.tasksCompleted, unknownWorkflow);
  const hasTokenChart = tokenBarData.some((datum) => datum.value > 0);
  const hasCompletedChart = completedBarData.some((datum) => datum.value > 0);

  return (
    <AreaShell
      testId="workflows"
      isLoading={isLoading}
      error={error}
      isEmpty={!data || data.workflows.length === 0}
      emptyMessage={t("commandCenter.workflows.empty", "No workflow analytics have been recorded for this range yet.")}
    >
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.workflows.totalsTitle", "Workflow totals")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-workflows-total-tokens">
            <div className="cc-stat-label">{t("commandCenter.workflows.totalTokens", "Total tokens")}</div>
            <div className="cc-stat-value">{formatCount(data?.totals.tokens.totalTokens ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-workflows-total-cost">
            <div className="cc-stat-label">{t("commandCenter.workflows.totalCost", "Estimated cost")}</div>
            <div className="cc-stat-value">
              {data ? formatCost(data.totals.cost.usd, data.totals.cost.unavailable) : "—"}
            </div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-workflows-total-files">
            <div className="cc-stat-label">{t("commandCenter.workflows.filesChanged", "Files changed")}</div>
            <div className="cc-stat-value">{formatCount(data?.totals.filesChanged ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-workflows-total-completed">
            <div className="cc-stat-label">{t("commandCenter.workflows.tasksCompleted", "Tasks done")}</div>
            <div className="cc-stat-value">{formatCount(data?.totals.tasksCompleted ?? 0)}</div>
          </div>
        </div>
      </div>

      <div className="cc-area-section cc-team-chart-grid">
        <div className="cc-team-chart-panel" data-testid="cc-workflows-tokens-chart">
          <h3 className="cc-area-section-title">{t("commandCenter.workflows.tokensByWorkflow", "Tokens by workflow")}</h3>
          {hasTokenChart ? (
            <Bar data={tokenBarData} ariaLabel={t("commandCenter.workflows.tokensByWorkflow", "Tokens by workflow")} />
          ) : (
            <p className="cc-muted-hint">{noChartData}</p>
          )}
        </div>
        <div className="cc-team-chart-panel" data-testid="cc-workflows-completed-chart">
          <h3 className="cc-area-section-title">{t("commandCenter.workflows.completedByWorkflow", "Tasks done by workflow")}</h3>
          {hasCompletedChart ? (
            <Bar data={completedBarData} ariaLabel={t("commandCenter.workflows.completedByWorkflow", "Tasks done by workflow")} />
          ) : (
            <p className="cc-muted-hint">{noChartData}</p>
          )}
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.workflows.tableTitle", "Per-workflow breakdown")}</h3>
        <div className="cc-table-wrap">
          <table className="cc-table" data-testid="cc-workflows-table">
            <thead>
              <tr>
                <th>{t("commandCenter.workflows.workflow", "Workflow")}</th>
                <th>{t("commandCenter.workflows.tokens", "Tokens")}</th>
                <th>{t("commandCenter.workflows.cost", "Cost")}</th>
                <th>{t("commandCenter.workflows.files", "Files changed")}</th>
                <th>{t("commandCenter.workflows.done", "Tasks done")}</th>
                <th>{t("commandCenter.workflows.inProgress", "In progress")}</th>
                <th>{t("commandCenter.workflows.inReview", "In review")}</th>
              </tr>
            </thead>
            <tbody>
              {sortedWorkflows.map((workflow) => (
                <tr key={workflow.workflowId} data-testid={`cc-workflows-row-${workflow.workflowId}`}>
                  <td>
                    <span className="cc-team-agent-cell">
                      <WorkflowIcon workflowId={workflow.workflowId} icon={workflow.workflowIcon} decorative />
                      <span>
                        <span className="cc-team-agent-name">{workflowLabel(workflow, unknownWorkflow)}</span>
                        <span className="cc-team-agent-role">{workflow.workflowId}</span>
                      </span>
                    </span>
                  </td>
                  <td>{formatCount(workflow.tokens.totalTokens)}</td>
                  <td>{formatCost(workflow.cost.usd, workflow.cost.unavailable)}</td>
                  <td>{formatCount(workflow.filesChanged)}</td>
                  <td>{formatCount(workflow.tasksCompleted)}</td>
                  <td>{formatCount(workflow.tasksInProgress)}</td>
                  <td>{formatCount(workflow.tasksInReview)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AreaShell>
  );
}
