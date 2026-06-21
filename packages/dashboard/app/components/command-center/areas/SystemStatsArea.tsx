import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, ShieldAlert, Skull } from "lucide-react";
import {
  fetchGlobalSettings,
  fetchNodeSystemStats,
  fetchSystemStats,
  killVitestProcesses,
  updateGlobalSettings,
  type KillVitestResponse,
  type SystemStatsResponse,
} from "../../../api";
import { useNodes } from "../../../hooks/useNodes";
import { Bar, type BarDatum } from "../charts/Bar";
import { RadialGauge } from "../charts/RadialGauge";
import { Sparkline } from "../charts/Sparkline";
import { LineChart, PieChart } from "../charts/recharts";
import { AreaShell } from "./AreaShell";
import { formatCount } from "./areaShared";
import "./SystemStatsArea.css";

type Severity = "normal" | "warning" | "critical";

interface SystemSample {
  cpuPercent: number;
  usedSystemMemPercent: number;
  heapUsedPercent: number;
}

const SYSTEM_STATS_POLL_MS = 5_000;
const MAX_SYSTEM_SAMPLES = 30;
const DEFAULT_TASK_COLUMNS = ["triage", "todo", "in-progress", "in-review", "done"];
const AGENT_STATES = ["idle", "active", "running", "error"] as const;

/*
FNXC:CommandCenter 2026-06-18-00:00:
System telemetry now lives in the Command Center System area; it polls /api/system-stats (no new endpoint) and keeps a bounded rolling sample buffer to render live CPU/memory trend sparklines.
*/

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function toPercent(used: number, total: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return "—";
  return `${((used / total) * 100).toFixed(1)}%`;
}

function heapSeverity(used: number, limit: number): Severity {
  if (limit <= 0) return "normal";
  const pct = used / limit;
  if (pct >= 0.85) return "critical";
  if (pct >= 0.65) return "warning";
  return "normal";
}

function rssSeverity(rss: number, totalSystemMem: number): Severity {
  if (totalSystemMem <= 0) return "normal";
  const pct = rss / totalSystemMem;
  if (pct >= 0.5) return "critical";
  if (pct >= 0.25) return "warning";
  return "normal";
}

function systemMemSeverity(used: number, total: number): Severity {
  if (total <= 0) return "normal";
  const pct = used / total;
  if (pct >= 0.9) return "critical";
  if (pct >= 0.75) return "warning";
  return "normal";
}

function cpuSeverity(percent: number | null, cores: number): Severity {
  if (percent === null || !Number.isFinite(percent) || percent < 0) return "normal";
  const normalized = cores > 0 ? percent / cores : percent;
  if (normalized >= 80) return "critical";
  if (normalized >= 50) return "warning";
  return "normal";
}

function severityClassName(severity: Severity): string {
  if (severity === "critical") return "cc-system-value--critical";
  if (severity === "warning") return "cc-system-value--warning";
  return "";
}

function formatTimestamp(value: string | null | undefined, notYetLabel: string): string {
  if (!value) return notYetLabel;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return notYetLabel;
  return parsed.toLocaleString();
}

function safeRatio(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(1, used / total));
}

function clampPercent(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function sampleFromStats(stats: SystemStatsResponse): SystemSample {
  const system = stats.systemStats;
  const usedSystemMem = system.systemTotalMem - system.systemFreeMem;
  return {
    cpuPercent: clampPercent(system.cpuPercent),
    usedSystemMemPercent: safeRatio(usedSystemMem, system.systemTotalMem) * 100,
    heapUsedPercent: safeRatio(system.heapUsed, system.heapLimit) * 100,
  };
}

export function SystemStatsArea({ projectId }: { projectId?: string }) {
  const { t } = useTranslation("app");
  const [stats, setStats] = useState<SystemStatsResponse | null>(null);
  const [samples, setSamples] = useState<SystemSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoKillEnabled, setAutoKillEnabled] = useState(true);
  const [killThreshold, setKillThreshold] = useState(90);
  const [isKilling, setIsKilling] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [killResult, setKillResult] = useState<KillVitestResponse | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const { nodes } = useNodes();

  const localNodeId = useMemo(() => nodes.find((node) => node.type === "local")?.id, [nodes]);
  const effectiveSelectedNodeId = selectedNodeId ?? localNodeId ?? null;
  const selectedNode = nodes.find((node) => node.id === effectiveSelectedNodeId) ?? null;
  const shouldRenderNodeSelector = nodes.length > 1;
  const activeNodeName = selectedNode?.name ?? t("systemStats.localNodeFallback", "Local node");
  const formatNodeOptionLabel = useCallback((node: (typeof nodes)[number]) => {
    const suffixes = [];
    if (node.type === "local") {
      suffixes.push(t("systemStats.thisNodeSuffix", "this node"));
    }
    if (node.status && node.status !== "online") {
      suffixes.push(t("systemStats.nodeStatusSuffix", "{{status}}", { status: node.status }));
    }
    return suffixes.length > 0 ? `${node.name} (${suffixes.join(" · ")})` : node.name;
  }, [nodes, t]);

  /*
  FNXC:CommandCenter 2026-06-21-00:00:
  The System area node selector must reuse useNodes, default to local telemetry, hide when no remote choice exists, fetch remote telemetry through fetchNodeSystemStats, and clear rolling samples whenever the selected host changes so CPU, memory, heap, workload, and Vitest controls never mix data across nodes.
  */
  const loadStats = useCallback(async (options?: { preserveKillResult?: boolean }) => {
    setLoading(true);
    try {
      const response = effectiveSelectedNodeId && effectiveSelectedNodeId !== localNodeId
        ? await fetchNodeSystemStats(effectiveSelectedNodeId, projectId)
        : await fetchSystemStats(projectId);
      setStats(response);
      setSamples((prev) => [...prev, sampleFromStats(response)].slice(-MAX_SYSTEM_SAMPLES));
      setError(null);
      setLastRefreshedAt(Date.now());
      if (!options?.preserveKillResult) {
        setKillResult(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("systemStats.errorLoadStats", "Failed to load system stats"));
    } finally {
      setLoading(false);
    }
  }, [effectiveSelectedNodeId, localNodeId, projectId, t]);

  useEffect(() => {
    void loadStats();
    const timer = window.setInterval(() => {
      void loadStats();
    }, SYSTEM_STATS_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [loadStats]);

  useEffect(() => {
    setSelectedNodeId((current) => (current && nodes.some((node) => node.id === current) ? current : null));
  }, [nodes]);

  useEffect(() => {
    setSamples([]);
    setError(null);
    setKillResult(null);
    setConfirmKill(false);
  }, [effectiveSelectedNodeId]);

  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      try {
        const settings = await fetchGlobalSettings();
        if (cancelled) return;
        setAutoKillEnabled(settings.vitestAutoKillEnabled ?? true);
        setKillThreshold(settings.vitestKillThresholdPct ?? 90);
        setSettingsError(null);
      } catch (err) {
        if (!cancelled) {
          setSettingsError(err instanceof Error ? err.message : t("systemStats.errorLoadVitestSettings", "Failed to load vitest settings"));
        }
      }
    };
    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const persistAutoKill = useCallback(async (enabled: boolean) => {
    setAutoKillEnabled(enabled);
    try {
      await updateGlobalSettings({ vitestAutoKillEnabled: enabled });
      setSettingsError(null);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : t("systemStats.errorSaveVitestSettings", "Failed to save vitest settings"));
    }
  }, [t]);

  const persistKillThreshold = useCallback(async (nextThreshold: number) => {
    const clamped = Math.min(99, Math.max(50, Number.isFinite(nextThreshold) ? Math.round(nextThreshold) : 90));
    setKillThreshold(clamped);

    try {
      await updateGlobalSettings({ vitestKillThresholdPct: clamped });
      setSettingsError(null);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : t("systemStats.errorSaveVitestSettings", "Failed to save vitest settings"));
    }
  }, [t]);

  const handleKillVitest = useCallback(async () => {
    if (isKilling) return;
    if (!confirmKill) {
      setConfirmKill(true);
      return;
    }

    setIsKilling(true);
    try {
      const result = effectiveSelectedNodeId && effectiveSelectedNodeId !== localNodeId
        ? await killVitestProcesses(projectId, effectiveSelectedNodeId, localNodeId)
        : await killVitestProcesses(projectId);
      setKillResult(result);
      setConfirmKill(false);
      await loadStats({ preserveKillResult: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("systemStats.errorKillVitest", "Failed to kill vitest processes"));
    } finally {
      setIsKilling(false);
    }
  }, [confirmKill, effectiveSelectedNodeId, isKilling, loadStats, localNodeId, projectId, t]);

  const system = stats?.systemStats;
  const taskStats = stats?.taskStats;
  const usedSystemMem = system ? system.systemTotalMem - system.systemFreeMem : 0;
  const usedSystemMemRatio = system ? safeRatio(usedSystemMem, system.systemTotalMem) : 0;
  const heapRatio = system ? safeRatio(system.heapUsed, system.heapLimit) : 0;
  const cpuRatio = system?.cpuPercent === null || system?.cpuPercent === undefined ? null : clampPercent(system.cpuPercent) / 100;
  const cpuPercentLabel = system?.cpuPercent === null || system?.cpuPercent === undefined ? t("systemStats.cpuSampling", "Sampling…") : `${system.cpuPercent.toFixed(1)}%`;
  const refreshLabel = lastRefreshedAt
    ? t("systemStats.updatedAt", "Updated {{time}}", {
        time: new Date(lastRefreshedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      })
    : t("systemStats.waitingFirstUpdate", "Waiting for first update");

  const taskBarData = useMemo<BarDatum[]>(() => {
    const byColumn = taskStats?.byColumn ?? {};
    const labels = Object.keys(byColumn).length > 0 ? Object.keys(byColumn) : DEFAULT_TASK_COLUMNS;
    return labels.map((label) => ({ label, value: byColumn[label] ?? 0, valueLabel: formatCount(byColumn[label] ?? 0) }));
  }, [taskStats?.byColumn]);
  /*
  FNXC:CommandCenterCharts 2026-06-19-00:00:
  System charts reuse the existing `/api/system-stats` payload: task columns become an additive workload pie, and the bounded resource sample buffer becomes a CPU/memory/heap line without introducing another polling endpoint or scroll owner.
  */
  const taskPieData = useMemo(
    () => taskBarData.map((datum) => ({ label: datum.label, value: datum.value })),
    [taskBarData],
  );
  const resourceLineSeries = useMemo(
    () => [
      { label: t("commandCenter.system.cpuSeries", "CPU"), values: samples.map((sample) => clampPercent(sample.cpuPercent)) },
      {
        label: t("commandCenter.system.memorySeries", "Memory"),
        values: samples.map((sample) => clampPercent(sample.usedSystemMemPercent)),
      },
      { label: t("commandCenter.system.heapSeries", "Heap"), values: samples.map((sample) => clampPercent(sample.heapUsedPercent)) },
    ],
    [samples, t],
  );
  const hasTaskPie = taskPieData.some((datum) => datum.value > 0);
  const hasResourceTrend = samples.length > 0;

  const agentBarData = useMemo<BarDatum[]>(() => {
    const agents = taskStats?.agents;
    return AGENT_STATES.map((state) => ({
      label: t(`systemStats.agent${state[0].toUpperCase()}${state.slice(1)}`, state),
      value: agents?.[state] ?? 0,
      valueLabel: formatCount(agents?.[state] ?? 0),
    }));
  }, [taskStats?.agents, t]);

  const detailRows = useMemo(() => {
    const heapClassName = system ? severityClassName(heapSeverity(system.heapUsed, system.heapLimit)) : "";
    const rssClassName = system ? severityClassName(rssSeverity(system.rss, system.systemTotalMem)) : "";
    const systemMemClassName = system ? severityClassName(systemMemSeverity(usedSystemMem, system.systemTotalMem)) : "";
    const cpuClassName = system ? severityClassName(cpuSeverity(system.cpuPercent, system.cpuCount)) : "";
    return [
      { label: t("systemStats.rowAppCpu", "App CPU"), value: cpuPercentLabel, detail: system?.cpuPercent === null ? t("systemStats.cpuFirstSamplePending", "First sample pending") : t("systemStats.cpuProcessUsage", "process usage"), className: cpuClassName },
      { label: t("systemStats.rowRss", "RSS"), value: system ? formatBytes(system.rss) : "—", detail: system ? toPercent(system.rss, system.systemTotalMem) : "—", className: rssClassName },
      { label: t("systemStats.rowHeapUsed", "Heap Used"), value: system ? formatBytes(system.heapUsed) : "—", detail: system ? t("systemStats.rowHeapUsedDetail", "of {{total}}", { total: formatBytes(system.heapTotal) }) : "—", className: heapClassName },
      { label: t("systemStats.rowHeapLimit", "Heap Limit"), value: system ? formatBytes(system.heapLimit) : "—", detail: t("systemStats.rowHeapLimitDetail", "V8 limit") },
      { label: t("systemStats.rowExternal", "External"), value: system ? formatBytes(system.external) : "—" },
      { label: t("systemStats.rowArrayBuffers", "Array Buffers"), value: system ? formatBytes(system.arrayBuffers) : "—" },
      { label: t("systemStats.rowLoadAvg", "Load Avg"), value: system?.loadAvg.map((value) => value.toFixed(2)).join(" ") ?? "—" },
      { label: t("systemStats.rowCores", "Cores"), value: system?.cpuCount ?? "—" },
      { label: t("systemStats.rowPlatform", "Platform"), value: system?.platform ?? "—" },
      { label: t("systemStats.rowNode", "Node"), value: system?.nodeVersion ?? "—" },
      { label: t("systemStats.rowPid", "PID"), value: system?.pid ?? "—" },
      { label: t("systemStats.rowMemoryUsed", "Memory Used"), value: system ? formatBytes(usedSystemMem) : "—", detail: system ? `${toPercent(usedSystemMem, system.systemTotalMem)} of ${formatBytes(system.systemTotalMem)}` : "—", className: systemMemClassName },
      { label: t("systemStats.rowMemoryFree", "Memory Free"), value: system ? formatBytes(system.systemFreeMem) : "—" },
    ];
  }, [cpuPercentLabel, system, t, usedSystemMem]);

  const vitestProcessCount = stats?.vitestProcessCount;
  const lastAutoKillLabel = formatTimestamp(stats?.vitestLastAutoKillAt, t("systemStats.notYet", "Not yet"));
  const isBackgroundRefreshing = loading && Boolean(stats);

  return (
    <AreaShell testId="system" isLoading={loading && !stats} error={!stats ? error : null} isEmpty={false}>
      <div className="cc-area-section">
        <div className="cc-area-section-header">
          <h3 className="cc-area-section-title">{t("commandCenter.system.healthTitle", "Live system health")}</h3>
          <div className="cc-system-refresh" aria-live="polite">
            {shouldRenderNodeSelector ? (
              <label className="cc-system-node-selector" htmlFor="cc-system-node-select">
                <span>{t("systemStats.nodeSelectorLabel", "Node")}</span>
                <select
                  id="cc-system-node-select"
                  className="input"
                  data-testid="cc-system-node-select"
                  aria-label={t("systemStats.nodeSelectorAriaLabel", "Select system stats node")}
                  value={effectiveSelectedNodeId ?? ""}
                  onChange={(event) => {
                    setSamples([]);
                    setKillResult(null);
                    setConfirmKill(false);
                    setSelectedNodeId(event.target.value || null);
                  }}
                >
                  {nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {formatNodeOptionLabel(node)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <span>{t("systemStats.viewingNode", "Viewing {{node}}", { node: activeNodeName })}</span>
            <span>{t("systemStats.autoRefresh", "Auto-refresh · 5s")}</span>
            <span>{refreshLabel}</span>
            <button
              type="button"
              className="btn-icon"
              onClick={() => void loadStats()}
              title={t("systemStats.refreshTitle", "Refresh")}
              aria-label={t("systemStats.refreshAriaLabel", "Refresh system stats")}
            >
              <RefreshCw size={16} className={isBackgroundRefreshing ? "spin" : undefined} />
            </button>
          </div>
        </div>
        {error && stats ? (
          <p className="cc-system-note cc-system-note--error" role="status">
            {t("systemStats.footerRefreshFailed", "Latest refresh failed: {{error}}", { error })}
          </p>
        ) : null}
        <div className="cc-stat-grid cc-system-gauges">
          <div className="card cc-stat-card cc-stat-card--gauge" data-testid="cc-system-cpu-gauge">
            <RadialGauge value={cpuRatio} label={t("systemStats.rowAppCpu", "App CPU")} ariaLabel={t("commandCenter.system.cpuGauge", "App CPU usage")} />
            <span className="cc-stat-sub">{cpuPercentLabel}</span>
          </div>
          <div className="card cc-stat-card cc-stat-card--gauge" data-testid="cc-system-mem-gauge">
            <RadialGauge value={usedSystemMemRatio} label={t("systemStats.rowMemoryUsed", "Memory Used")} ariaLabel={t("commandCenter.system.memoryGauge", "System memory used")} />
            <span className="cc-stat-sub">{system ? `${formatBytes(usedSystemMem)} / ${formatBytes(system.systemTotalMem)}` : "—"}</span>
          </div>
          <div className="card cc-stat-card cc-stat-card--gauge" data-testid="cc-system-heap-gauge">
            <RadialGauge value={heapRatio} label={t("systemStats.rowHeapUsed", "Heap Used")} ariaLabel={t("commandCenter.system.heapGauge", "Heap used")} />
            <span className="cc-stat-sub">{system ? `${formatBytes(system.heapUsed)} / ${formatBytes(system.heapLimit)}` : "—"}</span>
          </div>
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.system.trendsTitle", "Live trends")}</h3>
        {hasResourceTrend ? (
          <div className="card cc-stat-card" data-testid="cc-system-line">
            <div className="cc-stat-label">{t("commandCenter.system.resourceTrend", "Resource trend")}</div>
            <LineChart series={resourceLineSeries} ariaLabel={t("commandCenter.system.resourceTrend", "Resource trend")} />
          </div>
        ) : null}
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-system-cpu-trend">
            <div className="cc-stat-label">{t("commandCenter.system.cpuTrend", "CPU over time")}</div>
            <Sparkline values={samples.map((sample) => sample.cpuPercent)} max={100} ariaLabel={t("commandCenter.system.cpuTrend", "CPU over time")} />
          </div>
          <div className="card cc-stat-card" data-testid="cc-system-memory-trend">
            <div className="cc-stat-label">{t("commandCenter.system.memoryTrend", "Memory over time")}</div>
            <Sparkline values={samples.map((sample) => sample.usedSystemMemPercent)} max={100} ariaLabel={t("commandCenter.system.memoryTrend", "Memory over time")} />
          </div>
          <div className="card cc-stat-card" data-testid="cc-system-heap-trend">
            <div className="cc-stat-label">{t("commandCenter.system.heapTrend", "Heap over time")}</div>
            <Sparkline values={samples.map((sample) => sample.heapUsedPercent)} max={100} ariaLabel={t("commandCenter.system.heapTrend", "Heap over time")} />
          </div>
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.system.workloadTitle", "Workload")}</h3>
        <div className="cc-system-chart-grid">
          {hasTaskPie ? (
            <div className="card cc-stat-card" data-testid="cc-system-pie">
              <div className="cc-stat-label">{t("commandCenter.system.taskShare", "Task distribution")}</div>
              <PieChart data={taskPieData} ariaLabel={t("commandCenter.system.taskShare", "Task distribution")} />
            </div>
          ) : null}
          <div className="card cc-stat-card" data-testid="cc-system-tasks-bar">
            <div className="cc-stat-label">{t("systemStats.sectionTasks", "Tasks")}</div>
            <Bar data={taskBarData} ariaLabel={t("systemStats.sectionTasksAriaLabel", "Task stats")} />
          </div>
          <div className="card cc-stat-card" data-testid="cc-system-agents-bar">
            <div className="cc-stat-label">{t("systemStats.sectionAgents", "Agents")}</div>
            <Bar data={agentBarData} ariaLabel={t("systemStats.sectionAgentsAriaLabel", "Agent stats")} />
          </div>
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.system.detailsTitle", "Runtime details")}</h3>
        <div className="cc-stat-grid" data-testid="cc-system-details-grid">
          {detailRows.map((row) => (
            <div key={row.label} className="card cc-stat-card">
              <div className="cc-stat-label">{row.label}</div>
              <div className={`cc-stat-value ${row.className ?? ""}`.trim()}>{row.value}</div>
              {row.detail ? <span className="cc-stat-sub">{row.detail}</span> : null}
            </div>
          ))}
        </div>
      </div>

      <div className="cc-area-section" data-testid="cc-system-vitest-controls">
        <h3 className="cc-area-section-title cc-system-section-title-with-icon">
          <ShieldAlert />
          <span>{t("systemStats.sectionVitest", "Vitest Controls")}</span>
        </h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card">
            <div className="cc-stat-label">{t("systemStats.vitestProcesses", "Vitest Processes")}</div>
            <div className="cc-stat-value">{vitestProcessCount ?? "—"}</div>
          </div>
          <div className="card cc-stat-card">
            <div className="cc-stat-label">{t("systemStats.lastAutoKill", "Last auto-kill: {{time}}", { time: "" }).trim()}</div>
            <div className="cc-stat-value">{lastAutoKillLabel}</div>
          </div>
        </div>
        <div className="card cc-system-vitest-card">
          <button
            type="button"
            className="btn btn-danger"
            data-testid="cc-system-kill-vitest"
            onClick={() => void handleKillVitest()}
            disabled={isKilling || vitestProcessCount === 0}
          >
            <Skull />
            <span>{confirmKill ? t("systemStats.confirmKill", "Confirm Kill?") : t("systemStats.killVitest", "Kill Vitest Processes")}</span>
          </button>

          <label className="cc-system-toggle-row">
            <input
              type="checkbox"
              checked={autoKillEnabled}
              onChange={(event) => {
                void persistAutoKill(event.target.checked);
              }}
            />
            <span>{t("systemStats.autoKillLabel", "Auto-kill vitest on memory pressure")}</span>
          </label>

          <div className="cc-system-threshold-row">
            <label htmlFor="cc-system-vitest-threshold-number">{t("systemStats.killThresholdLabel", "Kill threshold (%)")}</label>
            <div className="cc-system-threshold-controls">
              <input
                id="cc-system-vitest-threshold-range"
                type="range"
                min={50}
                max={99}
                value={killThreshold}
                aria-label={t("systemStats.killThresholdSliderAriaLabel", "Kill threshold slider (%)")}
                onChange={(event) => {
                  const nextValue = Number.parseInt(event.target.value, 10);
                  void persistKillThreshold(Number.isNaN(nextValue) ? 90 : nextValue);
                }}
              />
              <input
                id="cc-system-vitest-threshold-number"
                type="number"
                className="input"
                min={50}
                max={99}
                value={killThreshold}
                aria-label={t("systemStats.killThresholdInputAriaLabel", "Kill threshold (%)")}
                onChange={(event) => {
                  const nextValue = Number.parseInt(event.target.value, 10);
                  void persistKillThreshold(Number.isNaN(nextValue) ? 90 : nextValue);
                }}
                onBlur={() => {
                  void persistKillThreshold(killThreshold);
                }}
              />
            </div>
          </div>

          {killResult ? (
            <p className={`cc-system-note ${killResult.killed > 0 ? "cc-system-note--success" : "cc-system-note--error"}`}>
              {t("systemStats.killedProcesses", "Killed {{count}} processes", { count: killResult.killed })}
            </p>
          ) : null}
          {settingsError ? <p className="cc-system-note cc-system-note--error">{settingsError}</p> : null}
        </div>
      </div>
    </AreaShell>
  );
}
