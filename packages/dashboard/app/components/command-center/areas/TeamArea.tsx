/*
FNXC:CommandCenter 2026-06-18-16:57:
Team tab shows each agent's tokens/cost/files-changed/tasks-completed with live status and bar charts, reusing existing analytics primitives; GitHub-issue per-agent stats are FN-6653, not here.
*/
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play } from "lucide-react";
import type { CostResult, OrgTreeNode, TeamAgentSummary, TeamAnalytics } from "@fusion/core";
import { fetchExecutorStats, fetchOrgTree } from "../../../api/legacy";
import { useAppSettings } from "../../../hooks/useAppSettings";
import { AgentAvatar } from "../../AgentAvatar";
import { LoadingSpinner } from "../../LoadingSpinner";
import type { DateRange } from "../DateRangePicker";
import { Bar, type BarDatum } from "../charts/Bar";
import { Sparkline } from "../charts/Sparkline";
import { PieChart } from "../charts/recharts";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCost, formatCount } from "./areaShared";

const TEAM_LIVE_REFRESH_MS = 15_000;
const EXECUTOR_STATUS_POLL_MS = 10_000;
type SortKey = "agent" | "tokens" | "cost" | "filesChanged" | "tasksCompleted" | "tasksInProgress";

type AsyncState<T> =
  | { status: "loading"; data: T | null; error: null }
  | { status: "loaded"; data: T; error: null }
  | { status: "error"; data: T | null; error: string };

type ExecutorStats = {
  globalPause: boolean;
  enginePaused: boolean;
  maxConcurrent: number;
  lastActivityAt?: string;
};

function costSortValue(cost: CostResult): number {
  return cost.unavailable || cost.usd === null ? -1 : cost.usd;
}

function agentLabel(agent: TeamAgentSummary, unknownLabel: string): string {
  return agent.agentName ?? agent.agentId ?? unknownLabel;
}

function stateDotClass(state: string | null): string {
  switch (state) {
    case "running":
      return "status-dot status-dot--connecting";
    case "active":
    case "idle":
      return "status-dot status-dot--online";
    case "error":
    case "failed":
      return "status-dot status-dot--error";
    case "starting":
    case "pending":
      return "status-dot status-dot--pending";
    default:
      return "status-dot status-dot--pending";
  }
}

function sortAgents(agents: TeamAgentSummary[], key: SortKey, dir: 1 | -1, unknownLabel: string): TeamAgentSummary[] {
  const sorted = [...agents];
  sorted.sort((a, b) => {
    let cmp = 0;
    if (key === "agent") {
      cmp = agentLabel(a, unknownLabel).localeCompare(agentLabel(b, unknownLabel));
    } else if (key === "tokens") {
      cmp = a.tokens.totalTokens - b.tokens.totalTokens;
    } else if (key === "cost") {
      cmp = costSortValue(a.cost) - costSortValue(b.cost);
    } else if (key === "filesChanged") {
      cmp = a.filesChanged - b.filesChanged;
    } else if (key === "tasksCompleted") {
      cmp = a.tasksCompleted - b.tasksCompleted;
    } else {
      cmp = a.tasksInProgress - b.tasksInProgress;
    }
    if (cmp === 0) {
      cmp = a.agentId.localeCompare(b.agentId);
    }
    return cmp * dir;
  });
  return sorted;
}

function buildBarData(
  agents: TeamAgentSummary[],
  valueFor: (agent: TeamAgentSummary) => number,
  unknownLabel: string,
): BarDatum[] {
  return [...agents]
    .sort((a, b) => valueFor(b) - valueFor(a) || a.agentId.localeCompare(b.agentId))
    .slice(0, 12)
    .map((agent) => {
      const value = valueFor(agent);
      return {
        label: agentLabel(agent, unknownLabel),
        value,
        valueLabel: formatCount(value),
      };
    });
}

function formatLastActivity(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString();
}

function TeamStatusPill({ paused, label }: { paused: boolean; label: string }) {
  return (
    <span className="cc-team-status-pill">
      <span className={`status-dot ${paused ? "status-dot--pending" : "status-dot--online"}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function TeamOrgChartNode({ node }: { node: OrgTreeNode }) {
  const hasChildren = node.children.length > 0;
  return (
    <li className="cc-team-org-item">
      <div className="cc-team-org-card">
        <div className="cc-team-org-card-header">
          <span className="cc-team-org-avatar"><AgentAvatar agent={node.agent} size={20} /></span>
          <span className="cc-team-org-name">{node.agent.name}</span>
          <span className="cc-team-org-badge">{node.agent.state}</span>
        </div>
      </div>
      {hasChildren ? (
        <ul className="cc-team-org-children">
          {node.children.map((child) => (
            <TeamOrgChartNode key={child.agent.id} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * FNXC:CommandCenter 2026-06-19-13:45:
 * Org chart and heartbeat control are Team-tab responsibilities, not Overview controls. Keep them outside AreaShell so project-level team operations remain visible while analytics load, error, or return empty, remove org-node role/title descriptions, and style org cards locally so Command Center never depends on lazy AgentsView.css.
 */
export function TeamArea({ range, projectId }: { range: DateRange; projectId?: string }) {
  const { t } = useTranslation("app");
  const {
    globalPaused,
    enginePaused,
    toggleEnginePause,
  } = useAppSettings(projectId);
  const [orgTreeState, setOrgTreeState] = useState<AsyncState<OrgTreeNode[]>>({ status: "loading", data: null, error: null });
  const [executorStatsState, setExecutorStatsState] = useState<AsyncState<ExecutorStats>>({ status: "loading", data: null, error: null });
  const { data, isLoading, error } = useAnalyticsArea<TeamAnalytics>("/command-center/team", range, {
    pollMs: TEAM_LIVE_REFRESH_MS,
  });

  useEffect(() => {
    let cancelled = false;
    setOrgTreeState({ status: "loading", data: null, error: null });
    void (async () => {
      try {
        const result = await fetchOrgTree(projectId);
        if (!cancelled) {
          setOrgTreeState({ status: "loaded", data: result, error: null });
        }
      } catch (orgError) {
        if (!cancelled) {
          setOrgTreeState({
            status: "error",
            data: null,
            error: orgError instanceof Error ? orgError.message : t("commandCenter.controls.orgChart.error", "Unable to load org chart"),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, t]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const loadExecutorStats = async () => {
      try {
        const result = await fetchExecutorStats(projectId);
        if (!cancelled) {
          setExecutorStatsState({ status: "loaded", data: result, error: null });
        }
      } catch (statsError) {
        if (!cancelled) {
          setExecutorStatsState({
            status: "error",
            data: null,
            error: statsError instanceof Error ? statsError.message : t("commandCenter.controls.status.error", "Unable to load live scheduler status"),
          });
        }
      } finally {
        if (!cancelled) {
          timeoutId = setTimeout(loadExecutorStats, EXECUTOR_STATUS_POLL_MS);
        }
      }
    };
    setExecutorStatsState({ status: "loading", data: null, error: null });
    void loadExecutorStats();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [projectId, t]);
  const agents = useMemo(() => data?.agents ?? [], [data?.agents]);
  const unknownAgent = t("commandCenter.team.unknownAgent", "(unknown agent)");
  const unknownRole = t("commandCenter.team.unknownRole", "Unknown role");
  const noChartData = t("commandCenter.team.noChartData", "No non-zero values for this chart yet.");

  const [sortKey, setSortKey] = useState<SortKey>("tokens");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const agentIdsSig = useMemo(() => agents.map((agent) => agent.agentId).join(" "), [agents]);
  const firstSig = useRef<string | null>(null);
  useEffect(() => {
    if (firstSig.current === null) {
      firstSig.current = agentIdsSig;
      return;
    }
    if (firstSig.current !== agentIdsSig) {
      firstSig.current = agentIdsSig;
      setSortKey("tokens");
      setSortDir(-1);
    }
  }, [agentIdsSig]);

  const sortedAgents = useMemo(
    () => sortAgents(agents, sortKey, sortDir, unknownAgent),
    [agents, sortDir, sortKey, unknownAgent],
  );

  const tokenBarData = useMemo(
    () => buildBarData(agents, (agent) => agent.tokens.totalTokens, unknownAgent),
    [agents, unknownAgent],
  );
  /*
  FNXC:CommandCenterCharts 2026-06-19-00:00:
  The Team surface needs a real per-agent pie chart without a new endpoint; map the existing per-agent token totals additively so loading, empty, bar, sparkline, and table affordances remain unchanged.
  */
  const tokenPieData = useMemo(
    () => tokenBarData.map((datum) => ({ label: datum.label, value: datum.value })),
    [tokenBarData],
  );
  const completedBarData = useMemo(
    () => buildBarData(agents, (agent) => agent.tasksCompleted, unknownAgent),
    [agents, unknownAgent],
  );
  const hasTokenChart = tokenBarData.some((datum) => datum.value > 0);
  const hasCompletedChart = completedBarData.some((datum) => datum.value > 0);
  const sparklineValues = useMemo(
    () => agents.flatMap((agent) => [agent.tokens.totalTokens, agent.filesChanged, agent.tasksCompleted]),
    [agents],
  );

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((dir) => (dir === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(key === "agent" ? 1 : -1);
    }
  }

  function caret(key: SortKey) {
    if (key !== sortKey) return null;
    return <span className="cc-sort-caret">{sortDir === 1 ? "▲" : "▼"}</span>;
  }

  const effectiveGlobalPaused = executorStatsState.data?.globalPause ?? globalPaused;
  const effectiveEnginePaused = executorStatsState.data?.enginePaused ?? enginePaused;
  const lastActivityLabel = formatLastActivity(
    executorStatsState.data?.lastActivityAt,
    t("commandCenter.controls.status.noActivity", "No recent activity"),
  );

  return (
    <div className="cc-team-area">
      <div className="cc-team-ops-grid" data-testid="cc-team-ops">
        <section className="card cc-team-ops-card cc-team-ops-card--org" data-testid="cc-team-org-chart">
          <div className="cc-team-ops-card-header">
            <div>
              <h3>{t("commandCenter.controls.orgChart.title", "Agent org chart")}</h3>
            </div>
          </div>
          <div className="cc-team-org-scroll" aria-live="polite">
            {orgTreeState.status === "loading" ? (
              <p className="cc-team-muted"><LoadingSpinner label={t("commandCenter.controls.orgChart.loading", "Loading org chart…")} /></p>
            ) : orgTreeState.status === "error" ? (
              <p className="cc-team-error" role="alert">{orgTreeState.error}</p>
            ) : orgTreeState.data.length === 0 ? (
              <p className="cc-team-muted">{t("commandCenter.controls.orgChart.empty", "No agents are reporting in yet.")}</p>
            ) : (
              <ul className="cc-team-org-roots">
                {orgTreeState.data.map((node) => (
                  <TeamOrgChartNode key={node.agent.id} node={node} />
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="card cc-team-ops-card" data-testid="cc-team-heartbeat">
          <div className="cc-team-ops-card-header">
            <div>
              <h3>{t("commandCenter.controls.heartbeat.title", "Heartbeat control")}</h3>
              <p>{t("commandCenter.controls.heartbeat.description", "Pause or resume the scheduling heartbeat.")}</p>
            </div>
            <TeamStatusPill
              paused={effectiveEnginePaused}
              label={effectiveEnginePaused ? t("commandCenter.controls.status.paused", "Paused") : t("commandCenter.controls.status.running", "Running")}
            />
          </div>
          <dl className="cc-team-facts">
            <div>
              <dt>{t("commandCenter.controls.status.lastActivity", "Last activity")}</dt>
              <dd>{executorStatsState.status === "loading" ? t("commandCenter.controls.status.loading", "Loading…") : lastActivityLabel}</dd>
            </div>
            <div>
              <dt>{t("commandCenter.controls.status.maxConcurrent", "Max concurrent")}</dt>
              <dd>{executorStatsState.data?.maxConcurrent ?? "—"}</dd>
            </div>
          </dl>
          {executorStatsState.status === "error" ? <p className="cc-team-error" role="alert">{executorStatsState.error}</p> : null}
          <button
            type="button"
            className="btn btn-secondary cc-team-action"
            onClick={() => void toggleEnginePause()}
            disabled={effectiveGlobalPaused}
          >
            {effectiveEnginePaused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
            <span>
              {effectiveEnginePaused
                ? t("commandCenter.controls.heartbeat.resume", "Resume heartbeat")
                : t("commandCenter.controls.heartbeat.pause", "Pause heartbeat")}
            </span>
          </button>
          {effectiveGlobalPaused ? (
            <p className="cc-team-muted">{t("commandCenter.controls.heartbeat.disabledByStop", "Start the AI engine before resuming the heartbeat.")}</p>
          ) : null}
        </section>
      </div>

      <AreaShell
      testId="team"
      isLoading={isLoading}
      error={error}
      isEmpty={!data || data.agents.length === 0}
      emptyMessage={t("commandCenter.team.empty", "No agents have reported team analytics yet.")}
    >
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.team.totalsTitle", "Team totals")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-team-total-tokens">
            <div className="cc-stat-label">{t("commandCenter.team.totalTokens", "Total tokens")}</div>
            <div className="cc-stat-value">{formatCount(data?.totals.tokens.totalTokens ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-team-total-cost">
            <div className="cc-stat-label">{t("commandCenter.team.totalCost", "Estimated cost")}</div>
            <div className="cc-stat-value">
              {data ? formatCost(data.totals.cost.usd, data.totals.cost.unavailable) : "—"}
            </div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-team-total-files">
            <div className="cc-stat-label">{t("commandCenter.team.filesChanged", "Files changed")}</div>
            <div className="cc-stat-value">{formatCount(data?.totals.filesChanged ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-team-total-completed">
            <div className="cc-stat-label">{t("commandCenter.team.tasksCompleted", "Tasks done")}</div>
            <div className="cc-stat-value">{formatCount(data?.totals.tasksCompleted ?? 0)}</div>
          </div>
        </div>
      </div>

      <div className="cc-area-section cc-team-chart-grid">
        {hasTokenChart ? (
          <div className="cc-team-chart-panel" data-testid="cc-team-pie">
            <h3 className="cc-area-section-title">{t("commandCenter.team.tokenShareByAgent", "Token share by agent")}</h3>
            <PieChart data={tokenPieData} ariaLabel={t("commandCenter.team.tokenShareByAgent", "Token share by agent")} />
          </div>
        ) : null}
        <div className="cc-team-chart-panel" data-testid="cc-team-tokens-chart">
          <h3 className="cc-area-section-title">{t("commandCenter.team.tokensByAgent", "Tokens by agent")}</h3>
          {hasTokenChart ? (
            <Bar data={tokenBarData} ariaLabel={t("commandCenter.team.tokensByAgent", "Tokens by agent")} />
          ) : (
            <p className="cc-muted-hint">{noChartData}</p>
          )}
        </div>
        <div className="cc-team-chart-panel" data-testid="cc-team-completed-chart">
          <h3 className="cc-area-section-title">{t("commandCenter.team.completedByAgent", "Tasks done by agent")}</h3>
          {hasCompletedChart ? (
            <Bar data={completedBarData} ariaLabel={t("commandCenter.team.completedByAgent", "Tasks done by agent")} />
          ) : (
            <p className="cc-muted-hint">{noChartData}</p>
          )}
        </div>
        <div className="cc-team-chart-panel cc-team-spark-panel" data-testid="cc-team-spread-chart">
          <h3 className="cc-area-section-title">{t("commandCenter.team.spread", "Team spread")}</h3>
          <Sparkline values={sparklineValues} ariaLabel={t("commandCenter.team.spread", "Team spread")} />
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.team.tableTitle", "Per-agent breakdown")}</h3>
        <div className="cc-table-wrap">
          <table className="cc-table" data-testid="cc-team-table">
            <thead>
              <tr>
                <th className="cc-sortable" onClick={() => toggleSort("agent")} data-testid="cc-team-sort-agent">
                  {t("commandCenter.team.agent", "Agent")}
                  {caret("agent")}
                </th>
                <th className="cc-sortable" onClick={() => toggleSort("tokens")} data-testid="cc-team-sort-tokens">
                  {t("commandCenter.team.tokens", "Tokens")}
                  {caret("tokens")}
                </th>
                <th className="cc-sortable" onClick={() => toggleSort("cost")} data-testid="cc-team-sort-cost">
                  {t("commandCenter.team.cost", "Cost")}
                  {caret("cost")}
                </th>
                <th className="cc-sortable" onClick={() => toggleSort("filesChanged")} data-testid="cc-team-sort-files">
                  {t("commandCenter.team.files", "Files changed")}
                  {caret("filesChanged")}
                </th>
                <th className="cc-sortable" onClick={() => toggleSort("tasksCompleted")} data-testid="cc-team-sort-completed">
                  {t("commandCenter.team.done", "Tasks done")}
                  {caret("tasksCompleted")}
                </th>
                <th className="cc-sortable" onClick={() => toggleSort("tasksInProgress")} data-testid="cc-team-sort-progress">
                  {t("commandCenter.team.inProgress", "In progress")}
                  {caret("tasksInProgress")}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedAgents.map((agent) => (
                <tr key={agent.agentId} data-testid={`cc-team-row-${agent.agentId}`}>
                  <td>
                    <span className="cc-team-agent-cell">
                      <span
                        className={stateDotClass(agent.state)}
                        aria-label={t("commandCenter.team.state", "Agent state: {{state}}", {
                          state: agent.state ?? t("commandCenter.team.unknownState", "unknown"),
                        })}
                      />
                      <span>
                        <span className="cc-team-agent-name">{agentLabel(agent, unknownAgent)}</span>
                        <span className="cc-team-agent-role">{agent.role ?? unknownRole}</span>
                      </span>
                    </span>
                  </td>
                  <td>{formatCount(agent.tokens.totalTokens)}</td>
                  <td>{formatCost(agent.cost.usd, agent.cost.unavailable)}</td>
                  <td>{formatCount(agent.filesChanged)}</td>
                  <td>{formatCount(agent.tasksCompleted)}</td>
                  <td>{formatCount(agent.tasksInProgress)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </AreaShell>
    </div>
  );
}
