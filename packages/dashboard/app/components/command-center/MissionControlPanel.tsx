import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2, Radio } from "lucide-react";
import type { LiveSnapshot, LiveSession, ColumnCount } from "@fusion/core";
import { api, withProjectId } from "../../api/legacy";
import { subscribeSse } from "../../sse-bus";
import { useProjectContextGuard } from "../../hooks/useProjectContextGuard";
import { Funnel, type FunnelStage } from "./charts/Funnel";
import { isInProgressColumn } from "./liveSnapshotMetrics";
import "./MissionControlPanel.css";

/** Poll cadence while work is in-flight (KTD5). */
export const LIVE_POLL_INTERVAL_MS = 5_000;

/**
 * A node whose most recent active session was last updated longer ago than this
 * is rendered as "inactive" rather than dropped from the list, so a node that
 * goes quiet stays visible (greyed) until the next authoritative snapshot
 * removes it.
 */
export const NODE_STALE_THRESHOLD_MS = 30_000;

/** SSE events that should trigger an immediate refetch (push half of KTD5). */
const LIVE_REFETCH_EVENTS = [
  "session:updated",
  "session:completed",
  "run:created",
  "run:updated",
  "run:completed",
  "run:cancelled",
  "run:failed",
  "agent:stateChanged",
  "task:moved",
  "task:updated",
  "task:created",
  "task:deleted",
] as const;

/**
 * The ordered SDLC funnel stages. Columns are matched case-insensitively against
 * these canonical stage ids; any column that does not map to a known stage is
 * folded into an "other" bucket so custom workflow columns still contribute a
 * count rather than being silently dropped.
 */
const FUNNEL_STAGES: Array<{ id: string; match: (column: string) => boolean }> = [
  { id: "triage", match: (c) => c === "triage" || c === "signal" || c === "backlog" },
  { id: "todo", match: (c) => c === "todo" || c === "to-do" || c === "to do" || c === "ready" },
  { id: "in-progress", match: isInProgressColumn },
  { id: "in-review", match: (c) => c === "in-review" || c === "in review" || c === "review" },
  { id: "done", match: (c) => c === "done" || c === "complete" || c === "completed" || c === "shipped" },
];

interface NodeView {
  path: string;
  label: string;
  sessionCount: number;
  inactive: boolean;
}

export interface LiveSnapshotState {
  snapshot: LiveSnapshot | null;
  isLoading: boolean;
  /** Non-null only for a hard error with no prior snapshot to fall back on. */
  error: string | null;
  /** True while a poll interval is scheduled (work in-flight). Exposed for tests. */
  polling: boolean;
  reload: () => void;
}

/**
 * Live snapshot hook implementing the push + poll convergence pattern (KTD5):
 *
 * - **Push:** subscribes to the shared SSE bus and refetches immediately on any
 *   session/run/task event — so a change lands within one event, not one poll.
 * - **Poll:** schedules a 5s interval as a fallback, but **only while work is
 *   in-flight** (any active session or run). When the latest snapshot shows no
 *   active work, the interval is cleared and no new one is scheduled — so an idle
 *   panel does no background polling. The SSE subscription stays live so the next
 *   started session pushes in and re-arms polling.
 *
 * The decision to poll is derived from the freshest snapshot (kept in a ref so the
 * interval callback always sees current state), re-evaluated after every fetch.
 */
export function useLiveSnapshot(projectId?: string): LiveSnapshotState {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const snapshotRef = useRef<LiveSnapshot | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const noRequest = useRef(Symbol("no-live-snapshot-request"));
  const inFlightProjectRef = useRef<string | undefined | symbol>(noRequest.current);
  const { capture } = useProjectContextGuard(projectId, "useLiveSnapshot");

  // Stable callbacks below close over only refs + setState, so `load` (and the
  // SSE subscription / poll interval that call it) never need to be recreated.

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
      setPolling(false);
    }
  }, []);

  const load = useCallback(async () => {
    const context = capture();
    const requestProjectId = context.projectIdAtStart;
    // Coalesce only same-project fetches. A project switch must start its own
    // request rather than waiting for a prior project's response.
    if (inFlightProjectRef.current === requestProjectId) return;
    inFlightProjectRef.current = requestProjectId;
    try {
      const result = await api<LiveSnapshot>(withProjectId("/command-center/live", requestProjectId));
      if (context.isStale()) return;
      snapshotRef.current = result;
      setSnapshot(result);
      setError(null);
    } catch (loadError: unknown) {
      if (context.isStale()) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load live snapshot");
    } finally {
      if (inFlightProjectRef.current === requestProjectId) {
        inFlightProjectRef.current = noRequest.current;
      }
      if (!context.isStale()) {
        setIsLoading(false);
        // Re-evaluate polling against the freshest snapshot after every fetch.
        // "In-flight" = any active session or run. Idle → no interval exists.
        const snap = snapshotRef.current;
        const inFlight = !!snap && (snap.activeSessions > 0 || snap.activeRuns > 0);
        if (inFlight) {
          // Start the poll interval iff one is not already running.
          if (pollTimerRef.current === null) {
            pollTimerRef.current = setInterval(() => {
              void load();
            }, LIVE_POLL_INTERVAL_MS);
            setPolling(true);
          }
        } else {
          stopPolling();
        }
      }
    }
  }, [capture, stopPolling]);

  useEffect(() => {
    /*
    FNXC:LiveActivity 2026-07-20-09:30:
    FN-8429 requires a project-scoped live strip. Clear the prior snapshot on a
    project switch and reject stale responses so another project's board counts
    cannot briefly inflate Overview or Mission Control.
    */
    snapshotRef.current = null;
    setSnapshot(null);
    setIsLoading(true);
    setError(null);
    void load();

    const unsubscribe = subscribeSse("/api/events", {
      events: Object.fromEntries(
        LIVE_REFETCH_EVENTS.map((name) => [name, () => void load()]),
      ),
      // On reconnect we may have missed events while the stream was down —
      // refetch authoritative state.
      onReconnect: () => void load(),
    });

    return () => {
      unsubscribe();
      stopPolling();
    };
  }, [load, projectId, stopPolling]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  return {
    snapshot,
    isLoading,
    error: error !== null && snapshot === null ? error : null,
    polling,
    reload,
  };
}

function nodeLabelFromPath(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** Derive per-node views, marking nodes whose sessions are all stale as inactive. */
function deriveNodes(sessions: LiveSession[], capturedAt: string): NodeView[] {
  const capturedMs = Date.parse(capturedAt);
  const byPath = new Map<string, { count: number; freshestMs: number }>();
  for (const s of sessions) {
    if (!s.worktreePath) continue;
    const prev = byPath.get(s.worktreePath) ?? { count: 0, freshestMs: 0 };
    const ms = Date.parse(s.updatedAt);
    byPath.set(s.worktreePath, {
      count: prev.count + 1,
      freshestMs: Number.isFinite(ms) ? Math.max(prev.freshestMs, ms) : prev.freshestMs,
    });
  }
  return Array.from(byPath.entries())
    .map(([path, info]) => {
      const age = Number.isFinite(capturedMs) && info.freshestMs > 0 ? capturedMs - info.freshestMs : 0;
      return {
        path,
        label: nodeLabelFromPath(path),
        sessionCount: info.count,
        inactive: age > NODE_STALE_THRESHOLD_MS,
      };
    })
    .sort((a, b) => b.sessionCount - a.sessionCount);
}

/** Map raw column counts onto the ordered SDLC funnel stages. */
function deriveFunnelStages(columns: ColumnCount[], label: (id: string, fallback: string) => string): FunnelStage[] {
  const totals = new Map<string, number>();
  for (const stage of FUNNEL_STAGES) totals.set(stage.id, 0);
  let other = 0;
  for (const c of columns) {
    const normalized = c.column.trim().toLowerCase();
    const stage = FUNNEL_STAGES.find((s) => s.match(normalized));
    if (stage) {
      totals.set(stage.id, (totals.get(stage.id) ?? 0) + c.count);
    } else {
      other += c.count;
    }
  }
  const stages: FunnelStage[] = FUNNEL_STAGES.map((s) => ({
    label: label(`commandCenter.missionControl.stage.${s.id}`, s.id),
    value: totals.get(s.id) ?? 0,
  }));
  if (other > 0) {
    stages.push({ label: label("commandCenter.missionControl.stage.other", "Other"), value: other });
  }
  return stages;
}

/**
 * Live Mission-Control panel (U6b). Renders the live snapshot from
 * `GET /api/command-center/live` with push + poll convergence (KTD5): SSE events
 * trigger an immediate refetch, and a 5s poll runs only while work is in-flight.
 */
export function MissionControlPanel({ projectId }: { projectId?: string } = {}) {
  const { t } = useTranslation("app");
  const { snapshot, isLoading, error } = useLiveSnapshot(projectId);

  const sessions = useMemo(() => snapshot?.sessions ?? [], [snapshot?.sessions]);
  const nodes = useMemo(
    () => (snapshot ? deriveNodes(snapshot.sessions, snapshot.capturedAt) : []),
    [snapshot],
  );
  const stages = useMemo(
    () => (snapshot ? deriveFunnelStages(snapshot.columns, t) : []),
    [snapshot, t],
  );

  if (isLoading && !snapshot) {
    return (
      <div className="cc-loading-inline" data-testid="mission-control-loading">
        <Loader2 size={18} className="spin" />
        <span>{t("commandCenter.missionControl.loading", "Loading live activity…")}</span>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="cc-area-error" data-testid="mission-control-error" role="alert">
        <AlertCircle size={22} />
        <p>{error}</p>
      </div>
    );
  }

  const hasActivity = (snapshot?.activeSessions ?? 0) > 0 || (snapshot?.activeRuns ?? 0) > 0;

  return (
    <div className="cc-mission-control" data-testid="mission-control">
      <div className="cc-stat-grid" data-testid="mission-control-summary">
        <div className="card cc-stat-card" data-testid="mission-control-active-sessions">
          <div className="cc-stat-label">{t("commandCenter.missionControl.activeSessions", "Active sessions")}</div>
          <div className="cc-stat-value">{snapshot?.activeSessions ?? 0}</div>
        </div>
        <div className="card cc-stat-card" data-testid="mission-control-active-runs">
          <div className="cc-stat-label">{t("commandCenter.missionControl.activeRuns", "Active runs")}</div>
          <div className="cc-stat-value">{snapshot?.activeRuns ?? 0}</div>
        </div>
        <div className="card cc-stat-card" data-testid="mission-control-active-nodes">
          <div className="cc-stat-label">{t("commandCenter.missionControl.activeNodes", "Active nodes")}</div>
          <div className="cc-stat-value">{snapshot?.activeNodes ?? 0}</div>
        </div>
      </div>

      {!hasActivity ? (
        <div className="cc-area-empty" data-testid="mission-control-idle">
          <Radio size={24} />
          <p>{t("commandCenter.missionControl.idle", "No active sessions. Live updates resume when work starts.")}</p>
        </div>
      ) : null}

      <div className="cc-mc-columns">
        <section className="cc-mc-section" data-testid="mission-control-sessions">
          <h3 className="cc-area-section-title">{t("commandCenter.missionControl.sessionsTitle", "Sessions")}</h3>
          {sessions.length === 0 ? (
            <p className="cc-mc-muted" data-testid="mission-control-sessions-empty">
              {t("commandCenter.missionControl.noSessions", "No active sessions.")}
            </p>
          ) : (
            <ul className="cc-mc-list">
              {sessions.map((s) => (
                <li key={s.id} className="cc-mc-session" data-testid={`mission-control-session-${s.id}`}>
                  <span className="cc-mc-session-purpose">{s.purpose || s.adapterId}</span>
                  <span className="cc-mc-session-meta">
                    <span className="cc-mc-badge">{s.agentState}</span>
                    {s.taskId ? <span className="cc-mc-task">{s.taskId}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="cc-mc-section" data-testid="mission-control-nodes">
          <h3 className="cc-area-section-title">{t("commandCenter.missionControl.nodesTitle", "Nodes")}</h3>
          {nodes.length === 0 ? (
            <p className="cc-mc-muted" data-testid="mission-control-nodes-empty">
              {t("commandCenter.missionControl.noNodes", "No active nodes.")}
            </p>
          ) : (
            <ul className="cc-mc-list">
              {nodes.map((n) => (
                <li
                  key={n.path}
                  className={`cc-mc-node${n.inactive ? " inactive" : ""}`}
                  data-testid={`mission-control-node-${n.label}`}
                  data-inactive={n.inactive ? "true" : "false"}
                >
                  <span className="cc-mc-node-label">{n.label}</span>
                  <span className="cc-mc-node-meta">
                    {n.inactive ? (
                      <span className="cc-mc-badge inactive">
                        {t("commandCenter.missionControl.inactive", "inactive")}
                      </span>
                    ) : null}
                    <span className="cc-mc-node-count">
                      {t("commandCenter.missionControl.sessionCount", "{{count}} session", { count: n.sessionCount })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="cc-mc-section" data-testid="mission-control-funnel">
        <h3 className="cc-area-section-title">{t("commandCenter.missionControl.funnelTitle", "SDLC funnel (live)")}</h3>
        <Funnel stages={stages} ariaLabel={t("commandCenter.missionControl.funnelTitle", "SDLC funnel (live)")} />
      </section>
    </div>
  );
}
