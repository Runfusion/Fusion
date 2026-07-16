import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Gauge } from "lucide-react";
import type { ActivityAnalytics, ColorTheme, LiveSnapshot, SignalsAnalytics, ThemeMode, TokenAnalytics, ToolAnalytics } from "@fusion/core";
import { api, fetchCodebaseMetrics, withProjectId, type CodebaseMetrics } from "../../api/legacy";
import { formatBytes } from "../../utils/formatBytes";
import { DateRangePicker, defaultPresets, rangeFromPreset, type DateRange } from "./DateRangePicker";
import { LoadingSpinner } from "../LoadingSpinner";
import { TokensArea } from "./areas/TokensArea";
import { ToolsArea } from "./areas/ToolsArea";
import { ActivityArea } from "./areas/ActivityArea";
import { ProductivityArea } from "./areas/ProductivityArea";
import { TeamArea } from "./areas/TeamArea";
import { WorkflowArea } from "./areas/WorkflowArea";
import { EcosystemArea } from "./areas/EcosystemArea";
import { GithubArea } from "./areas/GithubArea";
import { GitlabArea } from "./areas/GitlabArea";
import { SignalsArea } from "./areas/SignalsArea";
import { SystemStatsArea } from "./areas/SystemStatsArea";
import { SystemControlsArea } from "./areas/SystemControlsArea";
import { PluginManager } from "../PluginManager";
import { MissionControlPanel } from "./MissionControlPanel";
import { CommandCenterControls } from "./CommandCenterControls";
import { ReliabilityView } from "../ReliabilityView";
import { NodesView } from "../NodesView";
import type { ToastType } from "../../hooks/useToast";
import type { TaskView } from "../../hooks/useViewState";
import { SdlcFunnel } from "./SdlcFunnel";
import { inferProviderIconKey } from "../../utils/providerIconKey";
import { Bar, type BarDatum } from "./charts/Bar";
import { Sparkline } from "./charts/Sparkline";
import { LineChart as RechartsLineChart, PieChart } from "./charts/recharts";
import { useAnalyticsArea } from "./areas/useAnalyticsArea";
import { formatCost, formatCount } from "./areas/areaShared";
import "./CommandCenter.css";

type SubViewId =
  | "overview"
  | "tokens"
  | "tools"
  | "activity"
  | "productivity"
  | "team"
  | "workflows"
  | "ecosystem"
  | "github"
  | "gitlab"
  | "signals"
  | "system"
  | "plugins"
  | "nodes"
  | "reliability"
  | "mission-control";

interface SubView {
  id: SubViewId;
  label: string;
}

/*
FNXC:CommandCenter 2026-06-27-09:45:
Overview remains an intentionally compact top-consumers summary because its chart copy promises a top-N snapshot, while the Tokens detail area shows every used model. Keep the bar and pie on this same capped source so the two Overview cards never disagree about which models are summarized.
*/
const OVERVIEW_TOKEN_MODEL_LIMIT = 8;

/*
FNXC:CommandCenter 2026-06-18-16:57:
Team tab shows each agent's tokens/cost/files-changed/tasks-completed with live status and bar charts, reusing existing analytics primitives; GitHub-issue per-agent stats are FN-6653, not here.

FNXC:CommandCenter 2026-06-27-12:00:
Workflows is the canonical Command Center tab for read-only per-workflow observability. Keep it adjacent to Team because both surfaces break down the same tokens/cost/files/task-count metrics by an operational dimension.

FNXC:CommandCenter 2026-06-19-00:00:
FN-6702 moves Reliability from a top-level dashboard view into a Command Center tab next to System telemetry. Reuse ReliabilityView unchanged so its /api/health/reliability loading, error, insufficient-data, and populated states keep the same data flow.

FNXC:CommandCenter 2026-06-19-00:00:
FN-6717 moves Nodes from a standalone overlay into a Command Center tab gated by the nodesView flag. Reuse NodesView unchanged so useNodes, managed Docker nodes, mesh state, settings sync, toast wiring, and data-testid anchors keep the same data flow.
*/
function useSubViews(nodesEnabled: boolean): SubView[] {
  const { t } = useTranslation("app");
  return [
    { id: "overview", label: t("commandCenter.tabs.overview", "Overview") },
    { id: "tokens", label: t("commandCenter.tabs.tokens", "Tokens") },
    { id: "tools", label: t("commandCenter.tabs.tools", "Tools") },
    { id: "activity", label: t("commandCenter.tabs.activity", "Activity") },
    { id: "productivity", label: t("commandCenter.tabs.productivity", "Productivity") },
    { id: "team", label: t("commandCenter.tabs.team", "Team") },
    { id: "workflows", label: t("commandCenter.tabs.workflows", "Workflows") },
    { id: "ecosystem", label: t("commandCenter.tabs.ecosystem", "Ecosystem") },
    { id: "github", label: t("commandCenter.tabs.github", "GitHub") },
    { id: "gitlab", label: t("commandCenter.tabs.gitlab", "GitLab") },
    { id: "signals", label: t("commandCenter.tabs.signals", "Signals") },
    { id: "system", label: t("commandCenter.tabs.system", "System") },
    { id: "plugins", label: t("commandCenter.tabs.plugins", "Plugins") },
    ...(nodesEnabled ? [{ id: "nodes" as const, label: t("commandCenter.tabs.nodes", "Nodes") }] : []),
    { id: "reliability", label: t("commandCenter.tabs.reliability", "Reliability") },
    { id: "mission-control", label: t("commandCenter.tabs.missionControl", "Mission Control") },
  ];
}

interface OverviewStatCard {
  id: string;
  label: string;
  value: string;
  subLabel?: string;
  testId?: string;
}

/*
FNXC:CommandCenter 2026-06-17-00:00:
Overview is the Command Center landing surface, so it must reflect real analytics instead of shell placeholders. Show loading while core analytics have not settled, show the empty state only after settled zero data, include the agent-runs card as a first-class activity signal, and read Signals from the project-scoped incidents-backed endpoint without fabricating a value during loading/errors.

FNXC:CommandCenter 2026-06-19-00:00:
The Open signals card must be real project data, not a swallowed missing-route blank. It calls the scoped `/command-center/signals` endpoint backed by incidents and renders `—` only while unavailable/loading.

FNXC:CommandCenter 2026-06-18-23:45:
FN-6683 adds real Overview pie and line charts by reusing the already-fetched tokens and activity analytics. Keep the existing overview bars, sparkline, live strip, funnel, and loading/error/empty branches intact; no new endpoint is allowed for these additive affordances.
*/
/*
FNXC:CommandCenterTokenLive 2026-06-25-09:06:
Overview token usage is a live surface: the stat card, live strip, and token-by-model charts must consume the latest successful `/command-center/tokens` poll without remounting the page or requiring a date-range nudge.
*/
const OVERVIEW_TOKEN_REFRESH_MS = 15_000;

interface CommandCenterProps {
  projectId?: string;
  colorTheme?: ColorTheme;
  themeMode?: ThemeMode;
  shadcnCustomColors?: Record<string, string>;
  resolvedThemeMode?: "dark" | "light";
  onColorThemeChange?: (theme: ColorTheme) => void;
  onThemeModeChange?: (mode: ThemeMode) => void;
  onShadcnCustomColorsChange?: (colors: Record<string, string>) => void;
  addToast?: (message: string, type?: ToastType) => void;
  nodesEnabled?: boolean;
  /*
  FNXC:CommandCenter 2026-06-22-15:30:
  The Overview (Command Center landing) surfaces "View Board"/"View Agents" shortcuts directly under the Live activity snapshot (the engine-activity strip, the closest "AI engine" element on Overview). Navigation is owned by App's view router, so thread an optional onChangeView down to OverviewTab rather than letting the Command Center mutate routing state itself. Moved here from the Team-tab Heartbeat card (FN earlier).
  */
  onChangeView?: (view: TaskView) => void;
}

function OverviewTab({
  range,
  projectId,
  colorTheme = "default",
  themeMode = "system",
  shadcnCustomColors = {},
  resolvedThemeMode = themeMode === "light" ? "light" : "dark",
  onColorThemeChange = () => {},
  onThemeModeChange = () => {},
  onShadcnCustomColorsChange = () => {},
  onChangeView,
}: { range: DateRange } & CommandCenterProps) {
  const { t } = useTranslation("app");
  const tokens = useAnalyticsArea<TokenAnalytics>("/command-center/tokens?groupBy=model", range, {
    pollMs: OVERVIEW_TOKEN_REFRESH_MS,
    projectId,
  });
  const tools = useAnalyticsArea<ToolAnalytics>("/command-center/tools", range, { projectId });
  const activity = useAnalyticsArea<ActivityAnalytics>("/command-center/activity", range, { projectId });
  const signals = useAnalyticsArea<SignalsAnalytics>("/command-center/signals", range, { projectId });
  const [liveSnapshot, setLiveSnapshot] = useState<LiveSnapshot | null>(null);
  const [liveSnapshotLoading, setLiveSnapshotLoading] = useState(true);
  const [codebaseMetrics, setCodebaseMetrics] = useState<CodebaseMetrics | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLiveSnapshotLoading(true);
    void (async () => {
      try {
        const result = await api<LiveSnapshot>(withProjectId("/command-center/live", projectId));
        if (!cancelled) {
          setLiveSnapshot(result);
        }
      } catch {
        if (!cancelled) {
          setLiveSnapshot(null);
        }
      } finally {
        if (!cancelled) {
          setLiveSnapshotLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setCodebaseMetrics(null);
    if (!projectId) return () => { cancelled = true; };
    void fetchCodebaseMetrics(projectId).then(
      (result) => { if (!cancelled) setCodebaseMetrics(result); },
      () => { if (!cancelled) setCodebaseMetrics(null); },
    );
    return () => { cancelled = true; };
  }, [projectId]);

  const tokenTotal = tokens.data?.totals?.totalTokens ?? 0;
  const toolCalls = tools.data?.toolCalls ?? 0;
  const activeNodes = activity.data?.activeNodes ?? 0;
  const activeAgents = activity.data?.activeAgents ?? 0;
  const sessionsCount = activity.data?.sessions ?? 0;
  const agentRunsTotal = activity.data?.agentRuns?.total ?? 0;
  const tasksDone = activity.data?.funnel?.doneInRange ?? 0;
  /*
  FNXC:CommandCenter 2026-06-18-00:00:
  The Live activity snapshot "tasks in progress" metric must reflect current board state from /command-center/live columns, not the date-range SDLC funnel entered count, because cumulative transitions inflate with history and do not decrease when tasks leave in-progress.
  */
  const inProgressTasks = liveSnapshot?.columns.find((column) => column.column === "in-progress")?.count ?? 0;
  const uniqueModels = tokens.data?.groups?.length ?? 0;
  const tokensByModelData = useMemo<BarDatum[]>(
    () =>
      [...(tokens.data?.groups ?? [])]
        .sort((a, b) => b.totalTokens - a.totalTokens || (a.key ?? "").localeCompare(b.key ?? ""))
        .slice(0, OVERVIEW_TOKEN_MODEL_LIMIT)
        .map((g) => {
          const label = g.key ?? t("commandCenter.tokens.unknownModel", "(unknown)");
          return {
            label,
            value: g.totalTokens,
            valueLabel: formatCount(g.totalTokens),
            iconProvider: inferProviderIconKey(g.key ?? ""),
          };
        }),
    [tokens.data?.groups, t],
  );
  const toolCategoryData = useMemo<BarDatum[]>(
    () =>
      [...(tools.data?.byCategory ?? [])]
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
        .map((c) => ({
          label: c.category,
          value: c.count,
          valueLabel: formatCount(c.count),
        })),
    [tools.data?.byCategory],
  );
  const overviewPieData = useMemo(
    () => tokensByModelData.map((entry) => ({ label: entry.label, value: entry.value })),
    [tokensByModelData],
  );
  const dailyActivityValues = useMemo(
    () => (activity.data?.daily ?? []).map((day) => day.messages + day.activeAgents + (day.agentRuns ?? 0)),
    [activity.data?.daily],
  );
  const overviewLineSeries = useMemo(
    () => [
      { label: t("commandCenter.activity.messages", "Messages"), values: (activity.data?.daily ?? []).map((day) => day.messages) },
      { label: t("commandCenter.activity.activeAgents", "Active agents"), values: (activity.data?.daily ?? []).map((day) => day.activeAgents) },
      { label: t("commandCenter.activity.agentRuns", "Agent runs"), values: (activity.data?.daily ?? []).map((day) => day.agentRuns) },
    ],
    [activity.data?.daily, t],
  );
  const activityTrendValues =
    dailyActivityValues.length > 0
      ? dailyActivityValues
      : [sessionsCount, activity.data?.messages ?? 0, activeAgents, activeNodes, tasksDone];
  const hasOverviewChartData = tokensByModelData.length > 0 || toolCategoryData.length > 0 || dailyActivityValues.length > 0;
  const hasActivityData =
    sessionsCount > 0 ||
    (activity.data?.messages ?? 0) > 0 ||
    activeNodes > 0 ||
    activeAgents > 0 ||
    agentRunsTotal > 0 ||
    tasksDone > 0;
  const hasData = tokenTotal > 0 || toolCalls > 0 || hasActivityData;
  const hasAllCoreData = tokens.data !== null && tools.data !== null && activity.data !== null;
  const isInitialLoading = !hasAllCoreData && (tokens.isLoading || tools.isLoading || activity.isLoading);
  const coreError = tokens.error ?? tools.error ?? activity.error;

  const costLabel = tokens.data ? formatCost(tokens.data.cost?.usd ?? null, tokens.data.cost?.unavailable ?? true) : "—";
  const autonomyLabel = tools.data
    ? tools.data.fullyAutonomous
      ? t("commandCenter.tools.ratioAutonomous", "{{ratio}} calls/session (fully autonomous)", {
          ratio: tools.data.autonomyRatio.toFixed(1),
        })
      : `${tools.data.autonomyRatio.toFixed(1)}:1`
    : "—";

  /*
  FNXC:CommandCenter 2026-07-16-10:45:
  Codebase tokens and Disk size are project-intrinsic local metrics, not agent-usage analytics. Keep their cards in loading, core-error, empty, and populated Overview branches so a new project can inspect its context and apparent footprint without sending code to a service.
  */
  const projectMetricCards: OverviewStatCard[] = [
    {
      id: "codebaseTokens",
      testId: "cc-overview-codebase-tokens",
      label: t("commandCenter.overview.codebaseTokens", "Codebase tokens"),
      value: codebaseMetrics ? formatCount(codebaseMetrics.tokenEstimate) : "—",
      subLabel: codebaseMetrics?.truncated
        ? t("commandCenter.overview.metricsPartial", "Approx. (partial)")
        : codebaseMetrics ? t("commandCenter.overview.codebaseTokensHint", "Local estimate calibrated to cl100k_base") : undefined,
    },
    {
      id: "diskSize",
      testId: "cc-overview-disk-size",
      label: t("commandCenter.overview.diskSize", "Disk size"),
      value: codebaseMetrics ? formatBytes(codebaseMetrics.diskBytes) : "—",
      subLabel: codebaseMetrics?.truncated
        ? t("commandCenter.overview.metricsPartial", "Approx. (partial)")
        : codebaseMetrics ? t("commandCenter.overview.diskSizeHint", "Apparent local size") : undefined,
    },
  ];
  const renderStatGrid = (items: OverviewStatCard[]) => (
    <div className="cc-stat-grid">
      {items.map((card) => (
        <div key={card.id} className="card cc-stat-card" data-testid={card.testId ?? `command-center-stat-${card.id}`}>
          <div className="cc-stat-label">{card.label}</div>
          <div key={card.value} className={`cc-stat-value ${card.id === "tokens" ? "cc-token-count-live" : ""}`}>{card.value}</div>
          {card.subLabel ? <span className="cc-stat-sub">{card.subLabel}</span> : null}
        </div>
      ))}
    </div>
  );

  const cards: OverviewStatCard[] = [
    {
      id: "tokens",
      label: t("commandCenter.overview.tokensCost", "Tokens & cost"),
      value: formatCount(tokenTotal),
      subLabel: costLabel,
    },
    { id: "autonomy", label: t("commandCenter.overview.autonomy", "Autonomy ratio"), value: autonomyLabel },
    /*
    FNXC:CommandCenter 2026-06-23-01:30:
    The "Active nodes" and "Sessions" Overview stat cards were removed to declutter the stat grid; the underlying activeNodes/sessionsCount values are still fetched and reused by the activity-trend sparkline and hasActivityData guard, so the data wiring stays. The grid uses auto-fill, so the remaining cards reflow without an orphan column.
    */
    { id: "agentRuns", label: t("commandCenter.overview.agentRuns", "Agent runs"), value: formatCount(agentRunsTotal) },
    { id: "tasksDone", label: t("commandCenter.overview.tasksDone", "Tasks done"), value: formatCount(tasksDone) },
    { id: "models", label: t("commandCenter.overview.uniqueModels", "Unique models"), value: formatCount(uniqueModels) },
    {
      id: "signals",
      label: t("commandCenter.overview.openSignals", "Open signals"),
      value: signals.isLoading ? "—" : signals.data ? formatCount(signals.data.open ?? 0) : "—",
    },
  ];

  // FNXC:CommandCenter 2026-06-19-07:56:
  // The SDLC throughput funnel must sit at the bottom of the Overview first page in every branch (loading/error/empty/populated) while keeping mobile scroll owner and data-testid anchors unchanged.
  // The throughput funnel reads its own data (activityLog transitions) and shows
  // its own empty state, so it renders even when the stat-card aggregates have no
  // data yet.
  /*
  FNXC:CommandCenter 2026-06-22-20:55:
  The Overview's AI-engine controls are a SINGLE instance: the CommandCenterControls "AI engine" card (Stop AI Engine) now also hosts the "View Board"/"View Agents" shortcuts (threaded onChangeView). The earlier duplicate `.cc-overview-engine-panel` (a second AI Engine row) was removed — the buttons moved into the first instance.
  */
  const controlsSection = (
    <>
      <CommandCenterControls
        projectId={projectId}
        colorTheme={colorTheme}
        themeMode={themeMode}
        shadcnCustomColors={shadcnCustomColors}
        resolvedThemeMode={resolvedThemeMode}
        onColorThemeChange={onColorThemeChange}
        onThemeModeChange={onThemeModeChange}
        onShadcnCustomColorsChange={onShadcnCustomColorsChange}
        onChangeView={onChangeView}
      />
    </>
  );
  const throughputSection = (
    <div className="cc-overview-throughput" data-testid="command-center-throughput">
      <SdlcFunnel range={range} projectId={projectId} />
    </div>
  );

  if (isInitialLoading) {
    return (
      <div className="cc-overview">
        {controlsSection}
        {renderStatGrid(projectMetricCards)}
        <div className="cc-loading" data-testid="command-center-overview-loading">
          <div className="cc-chart-skeleton" />
          <p><LoadingSpinner label={t("commandCenter.loading", "Loading dashboard...")} /></p>
        </div>
        {throughputSection}
      </div>
    );
  }

  if (coreError !== null && !hasData) {
    return (
      <div className="cc-overview">
        {controlsSection}
        {renderStatGrid(projectMetricCards)}
        <div className="cc-error" data-testid="command-center-overview-error" role="alert">
          <AlertCircle size={24} />
          <p>{coreError}</p>
        </div>
        {throughputSection}
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="cc-overview">
        {controlsSection}
        {renderStatGrid(projectMetricCards)}
        <div className="cc-empty" data-testid="command-center-empty">
          <Gauge size={28} />
          <p>{t("commandCenter.empty", "No usage data yet. Run some agents to populate the Dashboard.")}</p>
        </div>
        {throughputSection}
      </div>
    );
  }

  return (
    <div className="cc-overview">
      {controlsSection}
      {renderStatGrid([...projectMetricCards, ...cards])}
      {/*
      FNXC:CommandCenter 2026-06-18-00:00:
      The Overview should feel like a living software factory, so the live strip now surfaces animated pulses for tasks in progress, agents working, open signals, and a compact throughput trend from existing activity analytics without adding a new endpoint.

      FNXC:CommandCenter 2026-06-18-00:00:
      Motion must be decorative and disabled for reduced-motion users; keep data-testid anchors and the mobile scroll owner unchanged so the cooler dashboard does not destabilize Command Center navigation.
      */}
      <div className="cc-live-strip" data-testid="command-center-live-strip">
        <div className="cc-live-strip-heading">
          <span className="status-dot status-dot--connecting" aria-hidden="true" />
          <span className="cc-live-strip-label">{t("commandCenter.overview.liveStrip", "Live activity snapshot")}</span>
        </div>
        <div className="cc-live-strip-metrics" data-testid="command-center-live-snapshot">
          <span className="cc-live-metric" data-testid="command-center-live-tasks-in-progress">
            <span className="cc-live-metric-value">{liveSnapshotLoading ? "—" : formatCount(inProgressTasks)}</span>
            <span className="cc-live-metric-label">{t("commandCenter.overview.tasksInProgress", "tasks in progress")}</span>
          </span>
          <span className="cc-live-metric" data-testid="command-center-live-agents-working">
            <span className="cc-live-metric-value">{formatCount(activeAgents)}</span>
            <span className="cc-live-metric-label">{t("commandCenter.overview.agentsWorking", "agents working")}</span>
          </span>
          <span className="cc-live-metric" data-testid="command-center-live-tokens">
            <span key={tokenTotal} className="cc-live-metric-value cc-token-count-live">{formatCount(tokenTotal)}</span>
            <span className="cc-live-metric-label">{t("commandCenter.overview.liveTokens", "tokens")}</span>
          </span>
          <span className="cc-live-metric" data-testid="command-center-live-open-signals">
            <span className="cc-live-metric-value">{signals.isLoading ? "—" : signals.data ? formatCount(signals.data.open ?? 0) : "—"}</span>
            <span className="cc-live-metric-label">{t("commandCenter.overview.openSignals", "open signals")}</span>
          </span>
        </div>
        <div className="cc-live-trend" data-testid="command-center-throughput-trend">
          <span className="cc-live-trend-label">{t("commandCenter.overview.throughputTrend", "throughput trend")}</span>
          <Sparkline
            values={activityTrendValues}
            ariaLabel={t("commandCenter.overview.throughputTrendAria", "Recent activity throughput trend")}
          />
        </div>
      </div>
      {hasOverviewChartData ? (
        /*
        FNXC:CommandCenter 2026-06-18-00:00:
        Overview must present an attractive, graph-rich software-factory snapshot reusing existing tokens/tools/activity analytics with no new endpoint, additive to the live strip and funnel.
        */
        <section className="cc-overview-charts" data-testid="command-center-overview-charts">
          {tokensByModelData.length > 0 ? (
            <div className="card cc-overview-chart-card" data-testid="command-center-overview-chart-tokens">
              <div className="cc-overview-chart-header">
                <h3 className="cc-area-section-title">{t("commandCenter.overview.tokensByModel", "Tokens by model")}</h3>
                <p>{t("commandCenter.overview.tokensByModelHint", "Top model token consumers in this range")}</p>
              </div>
              <Bar data={tokensByModelData} ariaLabel={t("commandCenter.overview.tokensByModel", "Tokens by model")} />
            </div>
          ) : null}
          {overviewPieData.length > 0 ? (
            <div className="card cc-overview-chart-card" data-testid="cc-overview-pie">
              <div className="cc-overview-chart-header">
                <h3 className="cc-area-section-title">{t("commandCenter.overview.tokensByModelPie", "Token share by model")}</h3>
                <p>{t("commandCenter.overview.tokensByModelPieHint", "Top model token share in this range")}</p>
              </div>
              <PieChart data={overviewPieData} ariaLabel={t("commandCenter.overview.tokensByModelPie", "Token share by model")} />
            </div>
          ) : null}
          {toolCategoryData.length > 0 ? (
            <div className="card cc-overview-chart-card" data-testid="command-center-overview-chart-tools">
              <div className="cc-overview-chart-header">
                <h3 className="cc-area-section-title">{t("commandCenter.overview.toolCategories", "Tool categories")}</h3>
                <p>{t("commandCenter.overview.toolCategoriesHint", "Autonomous work grouped by tool family")}</p>
              </div>
              <Bar data={toolCategoryData} ariaLabel={t("commandCenter.overview.toolCategories", "Tool categories")} />
            </div>
          ) : null}
          {/*
          FNXC:CommandCenter 2026-06-19-00:00:
          The Overview chart grid should surface the multi-series daily activity line higher by rendering it directly before the daily activity sparkline, without changing either card's data gate or wiring.
          */}
          {dailyActivityValues.length > 0 ? (
            <div className="card cc-overview-chart-card cc-overview-chart-card--trend" data-testid="cc-overview-line">
              <div className="cc-overview-chart-header">
                <h3 className="cc-area-section-title">{t("commandCenter.overview.dailyActivityLine", "Daily activity line")}</h3>
                <p>{t("commandCenter.overview.dailyActivityLineHint", "Messages, agents, and runs by day")}</p>
              </div>
              <RechartsLineChart
                series={overviewLineSeries}
                ariaLabel={t("commandCenter.overview.dailyActivityLine", "Daily activity line")}
              />
            </div>
          ) : null}
          {dailyActivityValues.length > 0 ? (
            <div className="card cc-overview-chart-card cc-overview-chart-card--trend" data-testid="command-center-overview-chart-activity">
              <div className="cc-overview-chart-header">
                <h3 className="cc-area-section-title">{t("commandCenter.overview.dailyActivity", "Daily activity trend")}</h3>
                <p>{t("commandCenter.overview.dailyActivityHint", "Messages plus active agents per day")}</p>
              </div>
              <Sparkline
                values={dailyActivityValues}
                ariaLabel={t("commandCenter.overview.dailyActivityAria", "Daily activity trend")}
              />
            </div>
          ) : null}
        </section>
      ) : null}
      {throughputSection}
    </div>
  );
}

function PlaceholderTab({ tabId }: { tabId: SubViewId }) {
  const { t } = useTranslation("app");
  return (
    <div className="cc-empty" data-testid={`command-center-placeholder-${tabId}`}>
      <Gauge size={28} />
      <p>{t("commandCenter.areaPending", "This area renders once metrics data is available.")}</p>
    </div>
  );
}

export function CommandCenter({
  projectId,
  colorTheme = "default",
  themeMode = "system",
  shadcnCustomColors = {},
  resolvedThemeMode = themeMode === "light" ? "light" : "dark",
  onColorThemeChange = () => {},
  onThemeModeChange = () => {},
  onShadcnCustomColorsChange = () => {},
  addToast = () => {},
  nodesEnabled = false,
  onChangeView,
}: CommandCenterProps = {}) {
  const { t } = useTranslation("app");
  const subViews = useSubViews(nodesEnabled);
  const [activeTab, setActiveTab] = useState<SubViewId>("overview");

  const [range, setRange] = useState<DateRange>(() => rangeFromPreset(defaultPresets((_k, f) => f)[1]));

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTab = useCallback(
    (index: number) => {
      const clamped = (index + subViews.length) % subViews.length;
      setActiveTab(subViews[clamped].id);
      tabRefs.current[clamped]?.focus();
    },
    [subViews],
  );

  const onTabKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault();
          focusTab(index + 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          focusTab(index - 1);
          break;
        case "Home":
          e.preventDefault();
          focusTab(0);
          break;
        case "End":
          e.preventDefault();
          focusTab(subViews.length - 1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          setActiveTab(subViews[index].id);
          break;
        default:
          break;
      }
    },
    [focusTab, subViews],
  );

  function renderActiveTab() {
    switch (activeTab) {
      case "overview":
        return (
          <OverviewTab
            range={range}
            projectId={projectId}
            colorTheme={colorTheme}
            themeMode={themeMode}
            shadcnCustomColors={shadcnCustomColors}
            resolvedThemeMode={resolvedThemeMode}
            onColorThemeChange={onColorThemeChange}
            onThemeModeChange={onThemeModeChange}
            onShadcnCustomColorsChange={onShadcnCustomColorsChange}
            onChangeView={onChangeView}
          />
        );
      case "tokens":
        return <TokensArea range={range} projectId={projectId} />;
      case "tools":
        return <ToolsArea range={range} projectId={projectId} />;
      case "activity":
        return <ActivityArea range={range} projectId={projectId} />;
      case "productivity":
        return <ProductivityArea range={range} projectId={projectId} />;
      case "team":
        return <TeamArea range={range} projectId={projectId} addToast={addToast} />;
      case "workflows":
        return <WorkflowArea range={range} projectId={projectId} />;
      case "ecosystem":
        return <EcosystemArea range={range} projectId={projectId} />;
      case "github":
        return <GithubArea range={range} projectId={projectId} />;
      case "gitlab":
        return <GitlabArea range={range} projectId={projectId} />;
      case "signals":
        return <SignalsArea range={range} projectId={projectId} />;
      case "system":
        /*
        FNXC:SystemPanel 2026-07-12-11:55:
        The System tab is the operator's debug home: system controls
        (rebuild/restart/backup/logs/report-bug) render above the existing
        runtime-metrics telemetry, per the requirement that these controls
        live "on the dashboard under System where we have runtime metrics".
        */
        return (
          <div className="cc-system-tab" data-testid="cc-system-tab">
            {/*
            FNXC:SystemPanel 2026-07-12-16:10:
            The System tab renders a bare SystemControlsArea section fragment followed by SystemStatsArea's own .cc-area wrapper. The tab-level flex container owns the inter-area rhythm so controls, rebuild output, Server logs, and Live system health all share the same --space-lg gap without adding another scroll owner.
            */}
            <SystemControlsArea projectId={projectId} addToast={addToast} />
            <SystemStatsArea />
          </div>
        );
      case "plugins":
        /*
        FNXC:SystemPanel 2026-07-12-11:55:
        Plugins is a first-class Command Center tab: installed plugins first,
        then available (registry/builtin) plugins — reusing PluginManager
        unchanged (same precedent as the Reliability and Nodes tabs) so a
        future server-hosted plugin browser can extend the same surface.
        */
        return <PluginManager addToast={addToast ?? (() => {})} projectId={projectId} />;
      case "nodes":
        return <NodesView addToast={addToast} />;
      case "reliability":
        return <ReliabilityView projectId={projectId} />;
      case "mission-control":
        return <MissionControlPanel projectId={projectId} />;
      default:
        return <PlaceholderTab tabId={activeTab} />;
    }
  }

  return (
    <section className="command-center" data-testid="command-center">
      <header className="cc-header">
        {/* FNXC:CommandCenter 2026-06-22-01:00: Icon size aligned to 20 to match the shared ViewHeader (cc-header is the model for ViewHeader; title is already 1.125rem with --space-lg padding). */}
        <h2 className="cc-title">
          <Gauge size={20} />
          {t("commandCenter.heading", "Dashboard")}
        </h2>
        <DateRangePicker value={range} onChange={setRange} />
      </header>

      <div
        className="cc-tablist"
        role="tablist"
        aria-label={t("commandCenter.tablistLabel", "Dashboard sections")}
      >
        {subViews.map((sub, index) => {
          const selected = sub.id === activeTab;
          return (
            <button
              key={sub.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              role="tab"
              id={`cc-tab-${sub.id}`}
              aria-selected={selected}
              aria-controls={`cc-tabpanel-${sub.id}`}
              tabIndex={selected ? 0 : -1}
              className={`cc-tab${selected ? " active" : ""}`}
              onClick={() => setActiveTab(sub.id)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
              data-testid={`command-center-tab-${sub.id}`}
            >
              {sub.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`cc-tabpanel-${activeTab}`}
        aria-labelledby={`cc-tab-${activeTab}`}
        tabIndex={0}
        className="cc-tabpanel"
        data-testid={`command-center-panel-${activeTab}`}
      >
        {renderActiveTab()}
      </div>
    </section>
  );
}
