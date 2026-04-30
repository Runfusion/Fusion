import { useCallback, useEffect, useMemo, useState } from "react";
import { Monitor, RefreshCw, ShieldAlert, Skull, X } from "lucide-react";
import {
  fetchGlobalSettings,
  fetchSystemStats,
  killVitestProcesses,
  updateGlobalSettings,
  type KillVitestResponse,
  type SystemStatsResponse,
} from "../api";
import "./SystemStatsModal.css";

interface SystemStatsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
}

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

type Severity = "normal" | "warning" | "critical";

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

function severityClassName(severity: Severity): string {
  if (severity === "critical") return "system-stats-modal__value--critical";
  if (severity === "warning") return "system-stats-modal__value--warning";
  return "";
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Not yet";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not yet";
  return parsed.toLocaleString();
}

/**
 * SystemStatsModal groups dashboard runtime telemetry into five sections:
 * process memory metrics, CPU/load information, host memory usage, task counts
 * by column, and agent state counts.
 */
export function SystemStatsModal({ isOpen, onClose, projectId }: SystemStatsModalProps) {
  const [stats, setStats] = useState<SystemStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoKillEnabled, setAutoKillEnabled] = useState(true);
  const [killThreshold, setKillThreshold] = useState(90);
  const [isKilling, setIsKilling] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [killResult, setKillResult] = useState<KillVitestResponse | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);

  const loadStats = useCallback(async (options?: { preserveKillResult?: boolean }) => {
    setLoading(true);
    try {
      const response = await fetchSystemStats(projectId);
      setStats(response);
      setError(null);
      setLastRefreshedAt(Date.now());
      if (!options?.preserveKillResult) {
        setKillResult(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load system stats");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!isOpen) return;
    void loadStats();

    const timer = window.setInterval(() => {
      void loadStats();
    }, 5_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isOpen, loadStats]);

  useEffect(() => {
    if (!isOpen) return;

    const loadSettings = async () => {
      try {
        const settings = await fetchGlobalSettings();
        setAutoKillEnabled(settings.vitestAutoKillEnabled ?? true);
        setKillThreshold(settings.vitestKillThresholdPct ?? 90);
        setSettingsError(null);
      } catch (err) {
        setSettingsError(err instanceof Error ? err.message : "Failed to load vitest settings");
      }
    };

    void loadSettings();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [isOpen, onClose]);

  const processRows = useMemo(() => {
    if (!stats) return [];
    const system = stats.systemStats;
    const heapClassName = severityClassName(heapSeverity(system.heapUsed, system.heapLimit));
    const rssClassName = severityClassName(rssSeverity(system.rss, system.systemTotalMem));
    return [
      { label: "RSS", value: formatBytes(system.rss), detail: toPercent(system.rss, system.systemTotalMem), className: rssClassName },
      { label: "Heap Used", value: formatBytes(system.heapUsed), detail: `of ${formatBytes(system.heapTotal)}`, className: heapClassName },
      { label: "Heap Limit", value: formatBytes(system.heapLimit), detail: "V8 limit" },
      { label: "External", value: formatBytes(system.external) },
      { label: "Array Buffers", value: formatBytes(system.arrayBuffers) },
    ];
  }, [stats]);

  const persistAutoKill = useCallback(async (enabled: boolean) => {
    setAutoKillEnabled(enabled);
    try {
      await updateGlobalSettings({ vitestAutoKillEnabled: enabled });
      setSettingsError(null);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Failed to save vitest settings");
    }
  }, []);

  const persistKillThreshold = useCallback(async (nextThreshold: number) => {
    const clamped = Math.min(99, Math.max(50, Number.isFinite(nextThreshold) ? Math.round(nextThreshold) : 90));
    setKillThreshold(clamped);

    try {
      await updateGlobalSettings({ vitestKillThresholdPct: clamped });
      setSettingsError(null);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Failed to save vitest settings");
    }
  }, []);

  const handleKillVitest = useCallback(async () => {
    if (isKilling) return;
    if (!confirmKill) {
      setConfirmKill(true);
      return;
    }

    setIsKilling(true);
    try {
      const result = await killVitestProcesses(projectId);
      setKillResult(result);
      setConfirmKill(false);
      await loadStats({ preserveKillResult: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to kill vitest processes");
    } finally {
      setIsKilling(false);
    }
  }, [confirmKill, isKilling, loadStats, projectId]);

  if (!isOpen) return null;

  const system = stats?.systemStats;
  const isBackgroundRefreshing = loading && Boolean(stats);
  const refreshLabel = lastRefreshedAt
    ? `Updated ${new Date(lastRefreshedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}`
    : "Waiting for first update";
  const taskStats = stats?.taskStats;
  const usedSystemMem = system ? system.systemTotalMem - system.systemFreeMem : 0;
  const usedSystemMemSeverity = system ? systemMemSeverity(usedSystemMem, system.systemTotalMem) : "normal";
  const usedSystemClassName = system ? severityClassName(usedSystemMemSeverity) : "";
  const usedSystemMemPercent =
    system && Number.isFinite(system.systemTotalMem) && system.systemTotalMem > 0
      ? Math.max(0, Math.min(100, (usedSystemMem / system.systemTotalMem) * 100))
      : 0;
  const usedSystemMemProgressLabel = system
    ? `System memory used: ${usedSystemMemPercent.toFixed(1)}% (${formatBytes(usedSystemMem)} of ${formatBytes(system.systemTotalMem)})`
    : "System memory usage unavailable";
  const vitestProcessCount = stats?.vitestProcessCount;
  const killResultClassName = killResult
    ? killResult.killed > 0
      ? "system-stats-modal__kill-result system-stats-modal__kill-result--success"
      : "system-stats-modal__kill-result system-stats-modal__kill-result--error"
    : "";
  const lastAutoKillLabel = formatTimestamp(stats?.vitestLastAutoKillAt);

  return (
    <div
      className="modal-overlay open"
      role="dialog"
      aria-modal="true"
      aria-labelledby="system-stats-modal-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      data-testid="system-stats-modal-overlay"
    >
      <div className="modal modal-lg system-stats-modal" data-testid="system-stats-modal">
        <div className="modal-header system-stats-modal__header">
          <h2 id="system-stats-modal-title" className="system-stats-modal__title">
            <Monitor />
            <span>System Stats</span>
          </h2>
          <div className="system-stats-modal__header-actions">
            <span className="system-stats-modal__auto-refresh" aria-live="polite">
              <span>Auto-refresh · 5s</span>
              <span className="system-stats-modal__auto-refresh-time">{refreshLabel}</span>
            </span>
            <button
              type="button"
              className="btn-icon"
              onClick={() => void loadStats()}
              title="Refresh"
              aria-label="Refresh system stats"
            >
              <RefreshCw
                size={16}
                className={isBackgroundRefreshing ? "system-stats-modal__refresh--spinning" : undefined}
              />
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
              <X />
            </button>
          </div>
        </div>

        {loading && !stats && <div className="system-stats-modal__state">Loading system stats…</div>}

        {error && !stats && (
          <div className="system-stats-modal__state system-stats-modal__state--error" role="alert">
            {error}
          </div>
        )}

        {stats && (
          <div className="system-stats-modal__content">
            <section className="system-stats-modal__section" aria-label="Process stats">
              <h3 className="system-stats-modal__section-title">Process</h3>
              <dl className="system-stats-modal__grid">
                {processRows.map((row) => (
                  <div key={row.label} className="system-stats-modal__row">
                    <dt>{row.label}</dt>
                    <dd>
                      <span className={`system-stats-modal__value ${row.className}`.trim()}>{row.value}</span>
                      {row.detail ? <span className="system-stats-modal__detail">{row.detail}</span> : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="system-stats-modal__section" aria-label="CPU and load stats">
              <h3 className="system-stats-modal__section-title">CPU &amp; Load</h3>
              <dl className="system-stats-modal__grid">
                <div className="system-stats-modal__row">
                  <dt>Load Avg</dt>
                  <dd>{system?.loadAvg.map((value) => value.toFixed(2)).join(" ") ?? "—"}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>Cores</dt>
                  <dd>{system?.cpuCount ?? "—"}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>Platform</dt>
                  <dd>{system?.platform ?? "—"}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>Node</dt>
                  <dd>{system?.nodeVersion ?? "—"}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>PID</dt>
                  <dd>{system?.pid ?? "—"}</dd>
                </div>
              </dl>
            </section>

            <section className="system-stats-modal__section" aria-label="System memory stats">
              <h3 className="system-stats-modal__section-title">System</h3>
              <dl className="system-stats-modal__grid">
                <div className="system-stats-modal__row system-stats-modal__row--memory-used">
                  <dt>Memory Used</dt>
                  <dd>
                    <span className={`system-stats-modal__value ${usedSystemClassName}`.trim()}>
                      {system ? formatBytes(usedSystemMem) : "—"}
                    </span>
                    <span className="system-stats-modal__detail">
                      {system ? `${toPercent(usedSystemMem, system.systemTotalMem)} of ${formatBytes(system.systemTotalMem)}` : ""}
                    </span>
                  </dd>
                  <div className="system-stats-modal__memory-progress-wrapper">
                    <div
                      className={`system-stats-modal__memory-progress-track system-stats-modal__memory-progress-track--${usedSystemMemSeverity}`}
                      role="progressbar"
                      aria-valuenow={Math.round(usedSystemMemPercent)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={usedSystemMemProgressLabel}
                    >
                      <div
                        className={`system-stats-modal__memory-progress-fill system-stats-modal__memory-progress-fill--${usedSystemMemSeverity}`}
                        style={{ width: `${usedSystemMemPercent}%` }}
                      />
                    </div>
                  </div>
                </div>
                <div className="system-stats-modal__row">
                  <dt>Memory Free</dt>
                  <dd>{system ? formatBytes(system.systemFreeMem) : "—"}</dd>
                </div>
              </dl>
            </section>

            <section className="system-stats-modal__section" aria-label="Task stats">
              <h3 className="system-stats-modal__section-title">Tasks</h3>
              <dl className="system-stats-modal__grid">
                <div className="system-stats-modal__row">
                  <dt>Total</dt>
                  <dd>{taskStats?.total ?? 0}</dd>
                </div>
                {Object.entries(taskStats?.byColumn ?? {}).map(([column, count]) => (
                  <div key={column} className="system-stats-modal__row">
                    <dt>{column}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="system-stats-modal__section" aria-label="Agent stats">
              <h3 className="system-stats-modal__section-title">Agents</h3>
              <dl className="system-stats-modal__grid">
                <div className="system-stats-modal__row">
                  <dt>idle</dt>
                  <dd>{taskStats?.agents.idle ?? 0}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>active</dt>
                  <dd>{taskStats?.agents.active ?? 0}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>running</dt>
                  <dd>{taskStats?.agents.running ?? 0}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>error</dt>
                  <dd>{taskStats?.agents.error ?? 0}</dd>
                </div>
              </dl>
            </section>

            <section className="system-stats-modal__section" aria-label="Vitest controls">
              <h3 className="system-stats-modal__section-title system-stats-modal__section-title--with-icon">
                <ShieldAlert />
                <span>Vitest Controls</span>
              </h3>
              <dl className="system-stats-modal__grid system-stats-modal__vitest-controls">
                <div className="system-stats-modal__row">
                  <dt>Vitest Processes</dt>
                  <dd>{vitestProcessCount ?? "—"}</dd>
                </div>
              </dl>

              <div className="system-stats-modal__vitest-controls">
                <div className="system-stats-modal__kill-row">
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => void handleKillVitest()}
                    disabled={isKilling || vitestProcessCount === 0}
                  >
                    <Skull />
                    <span>{confirmKill ? "Confirm Kill?" : "Kill Vitest Processes"}</span>
                  </button>
                </div>

                <label className="system-stats-modal__toggle-row">
                  <input
                    type="checkbox"
                    checked={autoKillEnabled}
                    onChange={(event) => {
                      void persistAutoKill(event.target.checked);
                    }}
                  />
                  <span>Auto-kill vitest on memory pressure</span>
                </label>

                <div className="system-stats-modal__threshold-row">
                  <label htmlFor="vitest-threshold-number">Kill threshold (%)</label>
                  <div className="system-stats-modal__threshold-controls">
                    <input
                      id="vitest-threshold-range"
                      type="range"
                      min={50}
                      max={99}
                      value={killThreshold}
                      aria-label="Kill threshold slider (%)"
                      onChange={(event) => {
                        const nextValue = Number.parseInt(event.target.value, 10);
                        void persistKillThreshold(Number.isNaN(nextValue) ? 90 : nextValue);
                      }}
                    />
                    <input
                      id="vitest-threshold-number"
                      type="number"
                      className="input"
                      min={50}
                      max={99}
                      value={killThreshold}
                      aria-label="Kill threshold (%)"
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

                {killResult && <p className={killResultClassName}>Killed {killResult.killed} processes</p>}
                <p className="system-stats-modal__last-kill">Last auto-kill: {lastAutoKillLabel}</p>
                {settingsError && <p className="system-stats-modal__kill-result system-stats-modal__kill-result--error">{settingsError}</p>}
              </div>
            </section>
          </div>
        )}

        {error && stats && <div className="system-stats-modal__footer-error">Latest refresh failed: {error}</div>}
      </div>
    </div>
  );
}
