import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpCircle,
  Blocks,
  Bot,
  Bug,
  Copy,
  Database,
  Download,
  Hammer,
  Link2,
  Package,
  Power,
  RefreshCw,
  ScrollText,
  Cpu,
} from "lucide-react";
import {
  createBackup,
  fetchDashboardHealth,
  fetchCurrentSystemRebuild,
  fetchSystemInfo,
  fetchSystemLogs,
  refreshUpdateCheck,
  reloadAllSystemPlugins,
  requestSystemRestart,
  restartAllSystemAgents,
  restartSystemEngines,
  startFnBinaryLinkLocal,
  startFnBinaryUseGlobal,
  startSystemRebuild,
  type SystemInfoResponse,
  type SystemLogEntryDto,
  type SystemRebuildJobLine,
  type SystemRebuildJobSnapshot,
  type UpdateCheckResponse,
} from "../../../api/legacy";
import { subscribeSse } from "../../../sse-bus";
import type { ReportActionType } from "@fusion/core";
import type { ToastType } from "../../../hooks/useToast";
import { ReportActionMenu } from "../../ReportActionMenu";
import { ReportModal } from "../../ReportModal";
import { resolveReportContextRefs } from "../../../utils/reportContextRefs";
import { copyTextToClipboard } from "../../../utils/copyToClipboard";
import "./SystemControlsArea.css";

/*
FNXC:SystemPanel 2026-07-12-11:45:
Operator controls for the Command Center → System tab, rendered above the
runtime-metrics area. Requirements this encodes:
  - "Rebuild & restart" must run the build in the server process, stream its
    output live into this panel, restart the server seamlessly, and show when
    the dashboard is back and ready (we poll /system/info until the PID
    changes, then offer/auto reload).
  - Controls degrade honestly: capabilities come from GET /system/info, and a
    control that the host process can't honor (not supervised, not a source
    checkout, no engine) renders disabled with the reason.
  - Additional debug controls: restart server only, restart project engines,
    restart all active agents, backup the database, rebuild+reload plugins,
    live server log tail, report a bug (prefilled GitHub issue), and copy a
    diagnostics bundle.

FNXC:SystemPanelFnBinary 2026-07-15-09:54:
  - "Build & link local fn" (source/dev only): run full workspace build + Bun
    compile + install to ~/.local as the default PATH `fn`.
  - "Use global npm fn": remove local shims and reinstall runfusion.ai globally.
  - "Check for updates": force-refresh the published version probe.
  - Any build/job step (rebuild, link-local, use-global) scrolls the panel to
    the shared job log viewer so operators see live output without hunting.
*/

const LOG_VIEW_CAP = 500;
const RESTART_POLL_MS = 1500;
const BACK_ONLINE_RELOAD_DELAY_MS = 3000;
// Bound the post-restart wait so a server that never comes back (crashed
// respawn, unsupervised restart that stopped) doesn't leave the panel polling
// forever with every control disabled.
const RESTART_WAIT_TIMEOUT_MS = 90_000;
const BOTTOM_FOLLOW_THRESHOLD_PX = 50;

function isNearBottom(container: HTMLElement): boolean {
  return container.scrollHeight - (container.scrollTop + container.clientHeight) <= BOTTOM_FOLLOW_THRESHOLD_PX;
}

type RestartPhase = null | "waiting" | "back" | "timeout";

interface SystemControlsAreaProps {
  projectId?: string;
  addToast?: (message: string, type?: ToastType) => void;
}

function formatLogTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}

export function SystemControlsArea({ projectId, addToast }: SystemControlsAreaProps) {
  const { t } = useTranslation("app");
  const toast = useCallback(
    (message: string, type?: ToastType) => addToast?.(message, type),
    [addToast],
  );

  const [info, setInfo] = useState<SystemInfoResponse | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reportAction, setReportAction] = useState<ReportActionType | null>(null);
  const reportContextRefs = typeof window === "undefined" ? undefined : resolveReportContextRefs(window.location);

  const [job, setJob] = useState<SystemRebuildJobSnapshot | null>(null);
  const [jobLines, setJobLines] = useState<SystemRebuildJobLine[]>([]);
  const jobOutputRef = useRef<HTMLPreElement | null>(null);
  const jobFollowingRef = useRef(true);
  const jobSectionRef = useRef<HTMLDivElement | null>(null);

  const [restartPhase, setRestartPhase] = useState<RestartPhase>(null);
  const prevPidRef = useRef<number | null>(null);

  const [logsOpen, setLogsOpen] = useState(false);
  const [logEntries, setLogEntries] = useState<SystemLogEntryDto[]>([]);
  const logOutputRef = useRef<HTMLDivElement | null>(null);
  const logFollowingRef = useRef(true);

  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResponse | null>(null);

  /*
  FNXC:SystemPanel 2026-07-18-16:12:
  FN-8346 mirrors FN-8339's pinned-bottom contract for independently streamed
  System Controls tails. A tail may follow growth only while its reader remains
  within the bottom threshold; an onScroll geometry check synchronously unsnaps
  it so SSE updates never override a manual scroll-up. Starting a new stream
  resets its pin, preserving the initial/latest-output anchor.
  */
  const updateJobFollowState = useCallback(() => {
    const output = jobOutputRef.current;
    if (output) jobFollowingRef.current = isNearBottom(output);
  }, []);

  const updateLogFollowState = useCallback(() => {
    const output = logOutputRef.current;
    if (output) logFollowingRef.current = isNearBottom(output);
  }, []);

  const loadInfo = useCallback(async () => {
    try {
      const next = await fetchSystemInfo();
      setInfo(next);
      setInfoError(null);
      if (next.activeRebuild) {
        setJob((current) => {
          if (current && current.id === next.activeRebuild!.id) return current;
          // Adopting a different (resumed) job — clear stale lines so the new
          // job's stream doesn't render mixed with the previous job's output.
          setJobLines([]);
          jobFollowingRef.current = true;
          return next.activeRebuild;
        });
      }
      return next;
    } catch (err) {
      setInfoError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  // On mount, hydrate the buffered rebuild output. A running job's lines also
  // arrive via the SSE replay-on-connect below, but a job that already
  // succeeded/failed before the panel opened is never streamed (the stream
  // effect skips non-running jobs), so without this the operator would see a
  // finished job with an empty log — losing the output needed to diagnose it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadInfo();
      try {
        const { job: current } = await fetchCurrentSystemRebuild();
        if (!cancelled && current) {
          setJob(current);
          setJobLines(current.lines ?? []);
        }
      } catch {
        // Best-effort hydration; the live stream still fills a running job.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadInfo]);

  // ── Rebuild job output streaming ──────────────────────────────────────────
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const unsubscribe = subscribeSse(`/api/system/jobs/${job.id}/stream`, {
      events: {
        line: (event) => {
          try {
            const line = JSON.parse((event as MessageEvent).data) as SystemRebuildJobLine;
            setJobLines((current) => {
              if (current.some((existing) => existing.i === line.i)) return current;
              return [...current, line];
            });
          } catch {
            // Ignore malformed stream payloads.
          }
        },
        end: (event) => {
          try {
            const snapshot = JSON.parse((event as MessageEvent).data) as SystemRebuildJobSnapshot;
            setJob(snapshot);
            if (snapshot.status === "succeeded" && snapshot.restartScheduled) {
              prevPidRef.current = info?.pid ?? null;
              setRestartPhase("waiting");
            } else if (snapshot.status === "succeeded") {
              const successMsg =
                snapshot.kind === "fn-binary" && snapshot.scope === "link-local"
                  ? t("systemControls.fnLinkLocalSucceeded", "Local fn binary built and linked")
                  : snapshot.kind === "fn-binary" && snapshot.scope === "use-global"
                    ? t("systemControls.fnUseGlobalSucceeded", "Switched default fn to global npm install")
                    : t("systemControls.rebuildSucceeded", "Rebuild finished successfully");
              toast(successMsg, "success");
            } else {
              toast(t("systemControls.rebuildFailed", "Job failed — see output for details"), "error");
            }
          } catch {
            // Ignore malformed stream payloads.
          }
        },
      },
    });
    return unsubscribe;
  }, [job?.id, job?.status, info?.pid, t, toast]);

  useEffect(() => {
    const output = jobOutputRef.current;
    if (output && jobFollowingRef.current) {
      output.scrollTop = output.scrollHeight;
    }
  }, [jobLines]);

  // ── Restart wait loop: server is back when /system/info answers with a new PID ──
  useEffect(() => {
    if (restartPhase !== "waiting") return;
    let cancelled = false;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      void (async () => {
        if (Date.now() - startedAt > RESTART_WAIT_TIMEOUT_MS) {
          if (!cancelled) setRestartPhase("timeout");
          return;
        }
        try {
          const next = await fetchSystemInfo();
          if (cancelled) return;
          if (prevPidRef.current === null || next.pid !== prevPidRef.current) {
            setInfo(next);
            setRestartPhase("back");
          }
        } catch {
          // Server still restarting — keep polling until the timeout above.
        }
      })();
    }, RESTART_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [restartPhase]);

  useEffect(() => {
    if (restartPhase !== "back") return;
    const timer = setTimeout(() => window.location.reload(), BACK_ONLINE_RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [restartPhase]);

  // ── Live server log tail ──────────────────────────────────────────────────
  // FNXC:SystemPanel 2026-07-12-14:05: The SSE stream replays the recent log
  // ring on connect (and reconnect), so it is the single source of truth — a
  // separate REST backfill here duplicated every recent line. Reset on open so
  // a reconnect's replay overwrites rather than appends past the cap boundary.
  useEffect(() => {
    if (!logsOpen || !info?.logsSupported) return;
    logFollowingRef.current = true;
    setLogEntries([]);
    const unsubscribe = subscribeSse("/api/system/logs/stream", {
      events: {
        log: (event) => {
          try {
            const entry = JSON.parse((event as MessageEvent).data) as SystemLogEntryDto;
            setLogEntries((current) => {
              const next = [...current, entry];
              return next.length > LOG_VIEW_CAP ? next.slice(-LOG_VIEW_CAP) : next;
            });
          } catch {
            // Ignore malformed stream payloads.
          }
        },
      },
      onReconnect: () => setLogEntries([]),
    });
    return unsubscribe;
  }, [logsOpen, info?.logsSupported]);

  useEffect(() => {
    const output = logOutputRef.current;
    if (output && logFollowingRef.current) {
      output.scrollTop = output.scrollHeight;
    }
  }, [logEntries]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const runAction = useCallback(
    async (key: string, action: () => Promise<void>) => {
      if (busyAction) return;
      setBusyAction(key);
      try {
        await action();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, toast],
  );

  /*
  FNXC:SystemPanelFnBinary 2026-07-15-09:54:
  Whenever a build/job starts, scroll the job log section into view so the
  operator immediately sees streamed output (rebuild, link-local, use-global).
  The effect waits until the job section is mounted (after setJob) so
  scrollIntoView has a real target; the inner <pre> still auto-follows new
  lines via scrollTop.
  */
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const frame = requestAnimationFrame(() => {
      jobSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [job?.id, job?.status]);

  const adoptJob = useCallback((snapshot: SystemRebuildJobSnapshot) => {
    jobFollowingRef.current = true;
    setJobLines([]);
    setJob(snapshot);
  }, []);

  const beginRebuild = useCallback(
    (scope: "app" | "full" | "plugins") =>
      runAction(`rebuild-${scope}`, async () => {
        const snapshot = await startSystemRebuild(scope, info?.restartSupported ?? false);
        adoptJob(snapshot);
      }),
    [adoptJob, info?.restartSupported, runAction],
  );

  const beginFnLinkLocal = useCallback(
    () =>
      runAction("fn-link-local", async () => {
        const snapshot = await startFnBinaryLinkLocal();
        adoptJob(snapshot);
      }),
    [adoptJob, runAction],
  );

  const beginFnUseGlobal = useCallback(
    () =>
      runAction("fn-use-global", async () => {
        const snapshot = await startFnBinaryUseGlobal();
        adoptJob(snapshot);
      }),
    [adoptJob, runAction],
  );

  const doCheckUpdates = useCallback(
    () =>
      runAction("check-updates", async () => {
        const result = await refreshUpdateCheck();
        setUpdateCheckResult(result);
        if (result.error) {
          toast(result.error, "error");
          return;
        }
        if (result.disabled) {
          toast(t("systemControls.updatesDisabled", "Update checks are disabled in global settings"), "warning");
          return;
        }
        if (result.updateAvailable && result.latestVersion) {
          toast(
            t("systemControls.updateAvailable", "Update available: v{{version}} (current: v{{current}})", {
              version: result.latestVersion,
              current: result.currentVersion,
            }),
            "success",
          );
          return;
        }
        toast(
          t("systemControls.upToDate", "You're up to date (v{{version}})", {
            version: result.currentVersion,
          }),
          "success",
        );
      }),
    [runAction, t, toast],
  );

  const doRestart = useCallback(
    () =>
      runAction("restart", async () => {
        prevPidRef.current = info?.pid ?? null;
        await requestSystemRestart("system-panel");
        setRestartPhase("waiting");
      }),
    [info?.pid, runAction],
  );

  const doEngineRestart = useCallback(
    () =>
      runAction("engine", async () => {
        const result = await restartSystemEngines();
        toast(
          t("systemControls.engineRestarted", "Restarted {{count}} engine(s){{failed}}", {
            count: result.restarted.length,
            failed: result.failed.length ? ` — ${result.failed.length} failed` : "",
          }),
          result.failed.length ? "warning" : "success",
        );
      }),
    [runAction, t, toast],
  );

  const doAgentsRestart = useCallback(
    () =>
      runAction("agents", async () => {
        const result = await restartAllSystemAgents(projectId);
        toast(
          t("systemControls.agentsRestarted", "Restarted {{count}} active agent(s){{failed}}", {
            count: result.restarted.length,
            failed: result.failed.length ? ` — ${result.failed.length} failed` : "",
          }),
          result.failed.length ? "warning" : "success",
        );
      }),
    [projectId, runAction, t, toast],
  );

  const doReloadPlugins = useCallback(
    () =>
      runAction("plugins-reload", async () => {
        const result = await reloadAllSystemPlugins();
        toast(
          t("systemControls.pluginsReloaded", "Reloaded {{count}} plugin(s){{failed}}", {
            count: result.reloaded.length,
            failed: result.failed.length ? ` — ${result.failed.length} failed` : "",
          }),
          result.failed.length ? "warning" : "success",
        );
      }),
    [runAction, t, toast],
  );

  const doBackup = useCallback(
    () =>
      runAction("backup", async () => {
        await createBackup(projectId);
        toast(t("systemControls.backupCreated", "Database backup created"), "success");
      }),
    [projectId, runAction, t, toast],
  );

  const buildDiagnostics = useCallback(async () => {
    const health = await fetchDashboardHealth().catch(() => null);
    const logs = info?.logsSupported
      ? await fetchSystemLogs(100).then((r) => r.entries).catch(() => [])
      : [];
    return {
      capturedAt: new Date().toISOString(),
      version: health?.version,
      health: health ?? undefined,
      system: info ?? undefined,
      recentLogs: logs,
    };
  }, [info]);

  const doCopyDiagnostics = useCallback(
    () =>
      runAction("diagnostics", async () => {
        const diagnostics = await buildDiagnostics();
        /*
        FNXC:SystemPanel 2026-07-12-00:00:
        Diagnostics copy must use copyTextToClipboard because navigator.clipboard is undefined on non-secure origins such as mobile http://fusionstudio:4040. Calling writeText directly previously crashed with reading 'writeText' instead of surfacing a clear copy failure.
        */
        const copied = await copyTextToClipboard(JSON.stringify(diagnostics, null, 2));
        if (copied) {
          toast(t("systemControls.diagnosticsCopied", "Diagnostics copied to clipboard"), "success");
          return;
        }
        toast(t("systemControls.diagnosticsCopyFailed", "Could not copy diagnostics to clipboard"), "error");
      }),
    [buildDiagnostics, runAction, t, toast],
  );

  /*
  FNXC:SystemPanel 2026-07-19-14:00:
  FN-8406 consolidates Command Center reporting here. This card opens the
  guided ReportActionMenu and ReportModal; Copy diagnostics remains a separate
  control instead of embedding local system data in a window.open GitHub URL.
  */

  // ── Control definitions ───────────────────────────────────────────────────
  const restartDisabledNote = info && !info.restartSupported
    ? t("systemControls.restartUnavailable", "Needs a supervising parent — restart the dashboard without --no-supervise.")
    : undefined;
  /*
  FNXC:SystemPanel 2026-07-12-14:15:
  Rebuild controls are HIDDEN (not disabled) unless the server runs from a
  Fusion source checkout (`pnpm dev`) — packaged installs (npm/npx, compiled
  binary, desktop app) have nothing to rebuild, so showing the cards would
  only confuse operators.
  */
  const showRebuildControls = info?.rebuildSupported ?? false;
  /*
  FNXC:SystemPanelFnBinary 2026-07-15-09:54:
  Link-local is HIDDEN unless the server advertises a Fusion source checkout
  (dev mode). Use-global and check-for-updates stay visible on packaged installs.
  */
  const showFnLinkLocal = info?.fnBinaryLinkLocalSupported ?? info?.rebuildSupported ?? false;
  const showFnUseGlobal = info?.fnBinaryUseGlobalSupported !== false;

  const rebuildRunning = job?.status === "running";
  const controls = useMemo(
    () => [
      {
        key: "rebuild-app",
        icon: Hammer,
        title: t("systemControls.rebuildRestart", "Rebuild & restart"),
        description: t(
          "systemControls.rebuildRestartDesc",
          "Rebuild core, engine, dashboard and changed plugins, then restart the server.",
        ),
        cta: t("systemControls.rebuildRestartCta", "Rebuild"),
        hidden: !showRebuildControls,
        disabled: rebuildRunning,
        run: () => void beginRebuild("app"),
        testId: "cc-syscontrol-rebuild-app",
      },
      {
        key: "rebuild-full",
        icon: Package,
        title: t("systemControls.fullRebuild", "Full rebuild & restart"),
        description: t("systemControls.fullRebuildDesc", "Rebuild the entire workspace (slower), then restart."),
        cta: t("systemControls.fullRebuildCta", "Full rebuild"),
        hidden: !showRebuildControls,
        disabled: rebuildRunning,
        run: () => void beginRebuild("full"),
        testId: "cc-syscontrol-rebuild-full",
      },
      {
        key: "fn-link-local",
        icon: Link2,
        title: t("systemControls.fnLinkLocal", "Build & link local fn"),
        description: t(
          "systemControls.fnLinkLocalDesc",
          "Build the standalone fn binary from this source checkout and install it as your default PATH binary (~/.local).",
        ),
        cta: t("systemControls.fnLinkLocalCta", "Build & link"),
        hidden: !showFnLinkLocal,
        disabled: rebuildRunning,
        run: () => void beginFnLinkLocal(),
        testId: "cc-syscontrol-fn-link-local",
      },
      {
        key: "fn-use-global",
        icon: Download,
        title: t("systemControls.fnUseGlobal", "Use global npm fn"),
        description: t(
          "systemControls.fnUseGlobalDesc",
          "Remove the local-build shims and reinstall the published runfusion.ai package globally.",
        ),
        cta: t("systemControls.fnUseGlobalCta", "Install global"),
        hidden: !showFnUseGlobal,
        disabled: rebuildRunning,
        run: () => void beginFnUseGlobal(),
        testId: "cc-syscontrol-fn-use-global",
      },
      {
        key: "check-updates",
        icon: ArrowUpCircle,
        title: t("systemControls.checkUpdates", "Check for updates"),
        description: t(
          "systemControls.checkUpdatesDesc",
          "Query the registry for a newer published Fusion version.",
        ),
        cta: t("systemControls.checkUpdatesCta", "Check now"),
        disabled: false,
        run: () => void doCheckUpdates(),
        testId: "cc-syscontrol-check-updates",
      },
      {
        key: "restart",
        icon: Power,
        title: t("systemControls.restartServer", "Restart server"),
        description: t("systemControls.restartServerDesc", "Gracefully restart the dashboard and engine process."),
        cta: t("systemControls.restartServerCta", "Restart"),
        disabled: !info?.restartSupported,
        note: restartDisabledNote,
        run: () => void doRestart(),
        testId: "cc-syscontrol-restart",
      },
      {
        key: "engine",
        icon: Cpu,
        title: t("systemControls.restartEngine", "Restart engine"),
        description: t("systemControls.restartEngineDesc", "Stop and restart all running project engines in place."),
        cta: t("systemControls.restartEngineCta", "Restart engine"),
        disabled: !info?.engineAvailable,
        note: info && !info.engineAvailable
          ? t("systemControls.engineUnavailable", "Engine is not running in this process.")
          : undefined,
        run: () => void doEngineRestart(),
        testId: "cc-syscontrol-engine",
      },
      {
        key: "agents",
        icon: Bot,
        title: t("systemControls.restartAgents", "Restart all agents"),
        description: t(
          "systemControls.restartAgentsDesc",
          "Stop active runs and bounce every active agent. Paused agents stay paused.",
        ),
        cta: t("systemControls.restartAgentsCta", "Restart agents"),
        disabled: false,
        run: () => void doAgentsRestart(),
        testId: "cc-syscontrol-agents",
      },
      {
        key: "rebuild-plugins",
        icon: Blocks,
        title: t("systemControls.rebuildPlugins", "Rebuild & reload plugins"),
        description: t(
          "systemControls.rebuildPluginsDesc",
          "Rebuild changed plugin bundles and hot-reload them without a server restart.",
        ),
        cta: t("systemControls.rebuildPluginsCta", "Rebuild plugins"),
        hidden: !showRebuildControls,
        disabled: rebuildRunning,
        run: () => void beginRebuild("plugins"),
        testId: "cc-syscontrol-rebuild-plugins",
      },
      {
        key: "plugins-reload",
        icon: RefreshCw,
        title: t("systemControls.reloadPlugins", "Reload plugins"),
        description: t("systemControls.reloadPluginsDesc", "Hot-reload every started plugin from its current build."),
        cta: t("systemControls.reloadPluginsCta", "Reload"),
        disabled: !info?.pluginReloadSupported,
        note: info && !info.pluginReloadSupported
          ? t("systemControls.pluginReloadUnavailable", "Plugin runner is unavailable in this mode.")
          : undefined,
        run: () => void doReloadPlugins(),
        testId: "cc-syscontrol-plugins-reload",
      },
      {
        key: "backup",
        icon: Database,
        title: t("systemControls.backupDb", "Backup database"),
        description: t("systemControls.backupDbDesc", "Create an integrity-checked backup of the database now."),
        cta: t("systemControls.backupDbCta", "Backup now"),
        disabled: false,
        run: () => void doBackup(),
        testId: "cc-syscontrol-backup",
      },
      {
        key: "diagnostics",
        icon: Copy,
        title: t("systemControls.copyDiagnostics", "Copy diagnostics"),
        description: t(
          "systemControls.copyDiagnosticsDesc",
          "Copy a JSON bundle with health, runtime info and recent logs.",
        ),
        cta: t("systemControls.copyDiagnosticsCta", "Copy"),
        disabled: false,
        run: () => void doCopyDiagnostics(),
        testId: "cc-syscontrol-diagnostics",
      },
    ],
    [
      beginFnLinkLocal,
      beginFnUseGlobal,
      beginRebuild,
      doAgentsRestart,
      doBackup,
      doCheckUpdates,
      doCopyDiagnostics,
      doEngineRestart,
      doReloadPlugins,
      doRestart,
      info,
      showFnLinkLocal,
      showFnUseGlobal,
      showRebuildControls,
      rebuildRunning,
      restartDisabledNote,
      t,
    ],
  );

  const jobStatusLabel = job
    ? job.status === "running"
      ? t("systemControls.jobRunning", "Running…")
      : job.status === "succeeded"
        ? t("systemControls.jobSucceeded", "Succeeded")
        : t("systemControls.jobFailed", "Failed")
    : null;

  const jobTitle =
    job?.kind === "fn-binary" && job.scope === "link-local"
      ? t("systemControls.fnLinkLocalOutput", "Local fn build output")
      : job?.kind === "fn-binary" && job.scope === "use-global"
        ? t("systemControls.fnUseGlobalOutput", "Global npm install output")
        : t("systemControls.rebuildOutput", "Rebuild output");

  return (
    <>
      <div className="cc-area-section" data-testid="cc-system-controls">
        <div className="cc-area-section-header cc-system-controls-header">
          <h3 className="cc-area-section-title">{t("systemControls.title", "System controls")}</h3>
          <button
            type="button"
            className="btn-icon"
            data-testid="cc-system-refresh"
            onClick={() => void loadInfo()}
            title={t("systemControls.refresh", "Refresh capabilities")}
            aria-label={t("systemControls.refresh", "Refresh capabilities")}
          >
            <RefreshCw size={16} />
          </button>
        </div>

        {infoError ? (
          <p className="cc-system-note cc-system-note--error" role="status">
            {t("systemControls.infoError", "Failed to load system info: {{error}}", { error: infoError })}
          </p>
        ) : null}

        {restartPhase === "waiting" ? (
          <div className="cc-syscontrols-banner cc-syscontrols-banner--waiting" role="status" data-testid="cc-system-restart-waiting">
            <RefreshCw size={16} className="spin" />
            <span>{t("systemControls.restartWaiting", "Restarting server — waiting for it to come back…")}</span>
          </div>
        ) : null}
        {restartPhase === "back" ? (
          <div className="cc-syscontrols-banner cc-syscontrols-banner--back" role="status" data-testid="cc-system-restart-back">
            <span>{t("systemControls.restartBack", "Server is back online — reloading…")}</span>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              {t("systemControls.reloadNow", "Reload now")}
            </button>
          </div>
        ) : null}
        {restartPhase === "timeout" ? (
          <div className="cc-syscontrols-banner cc-syscontrols-banner--error" role="status" data-testid="cc-system-restart-timeout">
            <span>
              {t(
                "systemControls.restartTimeout",
                "The server did not come back within the expected time. It may still be restarting, or the restart may have stopped it.",
              )}
            </span>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              {t("systemControls.reloadNow", "Reload now")}
            </button>
          </div>
        ) : null}

        {updateCheckResult && !updateCheckResult.error ? (
          <div
            className={`cc-syscontrols-banner ${updateCheckResult.updateAvailable ? "cc-syscontrols-banner--back" : ""}`}
            role="status"
            data-testid="cc-system-update-check-result"
          >
            <span>
              {updateCheckResult.disabled
                ? t("systemControls.updatesDisabled", "Update checks are disabled in global settings")
                : updateCheckResult.updateAvailable && updateCheckResult.latestVersion
                  ? t("systemControls.updateAvailable", "Update available: v{{version}} (current: v{{current}})", {
                      version: updateCheckResult.latestVersion,
                      current: updateCheckResult.currentVersion,
                    })
                  : t("systemControls.upToDate", "You're up to date (v{{version}})", {
                      version: updateCheckResult.currentVersion,
                    })}
            </span>
          </div>
        ) : null}

        <div className="cc-syscontrols-grid">
          {controls.filter((control) => !("hidden" in control && control.hidden)).map((control) => (
            <div key={control.key} className="card cc-syscontrol-card" data-testid={control.testId}>
              <div className="cc-syscontrol-head">
                <control.icon size={18} className="cc-syscontrol-icon" aria-hidden />
                <span className="cc-syscontrol-title">{control.title}</span>
              </div>
              <p className="cc-syscontrol-desc">{control.description}</p>
              {control.note ? <p className="cc-syscontrol-note">{control.note}</p> : null}
              <button
                type="button"
                className="btn cc-syscontrol-cta"
                disabled={control.disabled || busyAction !== null || restartPhase === "waiting"}
                onClick={control.run}
              >
                {busyAction === control.key
                  ? t("systemControls.working", "Working…")
                  : control.cta}
              </button>
            </div>
          ))}
          <div className="card cc-syscontrol-card" data-testid="cc-syscontrol-report-bug">
            <div className="cc-syscontrol-head">
              <Bug size={18} className="cc-syscontrol-icon" aria-hidden />
              <span className="cc-syscontrol-title">{t("systemControls.reportBug", "Report")}</span>
            </div>
            <p className="cc-syscontrol-desc">{t("systemControls.reportBugDesc", "Report a bug, send feedback, share an idea, or get help through a guided prompt.")}</p>
            <div className="cc-syscontrol-cta"><ReportActionMenu onSelect={setReportAction} /></div>
          </div>
        </div>
        {reportAction ? <ReportModal actionType={reportAction} contextRefs={reportContextRefs} onClose={() => setReportAction(null)} /> : null}
      </div>

      {job ? (
        <div ref={jobSectionRef} className="cc-area-section" data-testid="cc-system-rebuild-output">
          <div className="cc-area-section-header">
            <h3 className="cc-area-section-title">{jobTitle}</h3>
            <span className={`cc-syscontrols-job-status cc-syscontrols-job-status--${job.status}`}>
              {jobStatusLabel}
            </span>
          </div>
          <pre ref={jobOutputRef} className="cc-syscontrols-output" aria-live="polite" onScroll={updateJobFollowState}>
            {jobLines.map((line) => `${line.stream === "stderr" ? "! " : ""}${line.text}`).join("\n")}
          </pre>
          {job.status === "failed" && job.error ? (
            <p className="cc-system-note cc-system-note--error">{job.error}</p>
          ) : null}
        </div>
      ) : null}

      <div className="cc-area-section" data-testid="cc-system-logs">
        <div className="cc-area-section-header">
          <h3 className="cc-area-section-title cc-system-section-title-with-icon">
            <ScrollText size={16} />
            <span>{t("systemControls.serverLogs", "Server logs")}</span>
          </h3>
          <button
            type="button"
            className="btn"
            disabled={info ? !info.logsSupported : false}
            onClick={() => setLogsOpen((open) => !open)}
            data-testid="cc-system-logs-toggle"
          >
            {logsOpen
              ? t("systemControls.hideLogs", "Hide logs")
              : t("systemControls.viewLogs", "View logs")}
          </button>
        </div>
        {info && !info.logsSupported ? (
          <p className="cc-system-note">
            {t("systemControls.logsUnavailable", "Host-process logs are not available in this mode.")}
          </p>
        ) : null}
        {logsOpen && info?.logsSupported ? (
          <div ref={logOutputRef} className="cc-syscontrols-output cc-syscontrols-logs" aria-live="polite" onScroll={updateLogFollowState}>
            {logEntries.map((entry, index) => (
              <div key={`${entry.timestamp}-${index}`} className={`cc-syscontrols-log-line cc-syscontrols-log-line--${entry.level}`}>
                <span className="cc-syscontrols-log-time">{formatLogTimestamp(entry.timestamp)}</span>
                {entry.prefix ? <span className="cc-syscontrols-log-prefix">[{entry.prefix}]</span> : null}
                <span className="cc-syscontrols-log-message">{entry.message}</span>
              </div>
            ))}
            {logEntries.length === 0 ? (
              <div className="cc-syscontrols-log-line">{t("systemControls.noLogs", "No log entries yet.")}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
