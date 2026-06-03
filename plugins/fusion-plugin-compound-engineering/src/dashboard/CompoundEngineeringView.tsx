import "./CompoundEngineeringView.css";
import { useCallback, useMemo, useState } from "react";
import * as LucideIcons from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { useArtifacts } from "./hooks/useArtifacts.js";
import { useViewportMode } from "./hooks/useViewportMode.js";
import { useCeSession, type CeSessionSubscribe } from "./hooks/useCeSession.js";
import { useCeSessions, type CeSessionsSubscribe } from "./hooks/useCeSessions.js";
import { getArtifactPreviewUrl } from "./hooks/api.js";
import { CeFlow } from "./CeFlow.js";
import { getStage, listStages, type CeStageDefinition } from "../session/stage-registry.js";
import type { CeArtifactEntry, CeArtifactGroup } from "../artifacts/discovery.js";
import type { CeSession, CeSessionStatus } from "../session/session-store.js";

const CE_PLUGIN_ID = "fusion-plugin-compound-engineering";

/** Resolve a lucide icon name (from the registry) to a component, with fallback. */
function resolveIcon(name: string): LucideIcon {
  const icons = LucideIcons as unknown as Record<string, LucideIcon>;
  return icons[name] ?? LucideIcons.Circle;
}

/** Launcher: lists exactly the registered stages (R4) and launches one. */
function StageLauncher({
  stages,
  disabled,
  onLaunch,
}: {
  stages: CeStageDefinition[];
  disabled: boolean;
  onLaunch: (stage: CeStageDefinition) => void;
}) {
  return (
    <div className="ce-launcher card" data-testid="ce-launcher">
      <h3>Start a stage</h3>
      <ul className="ce-launcher-list">
        {stages.map((stage) => {
          const Icon = resolveIcon(stage.icon);
          return (
            <li key={stage.stageId}>
              <button
                type="button"
                className="ce-launcher-tile btn"
                data-testid="ce-launcher-stage"
                data-stage={stage.stageId}
                disabled={disabled}
                onClick={() => onLaunch(stage)}
              >
                <Icon className="ce-launcher-icon" size={18} aria-hidden="true" />
                <span className="ce-launcher-label">{stage.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Statuses that are settled (no agent turn in flight). */
const TERMINAL: ReadonlySet<CeSessionStatus> = new Set(["completed", "error", "interrupted"]);

function statusLabel(status: CeSessionStatus): string {
  return status.replace("_", " ");
}

/**
 * Sessions panel: every CE session (each an independent pipeline run) with its
 * stage, status, and last activity — open any to keep working on it, discard
 * settled ones. Sessions keep running server-side while not open here.
 */
function SessionsPanel({
  sessions,
  activeSessionId,
  disabled,
  onOpen,
  onDiscard,
}: {
  sessions: CeSession[];
  activeSessionId?: string;
  disabled: boolean;
  onOpen: (session: CeSession) => void;
  onDiscard: (session: CeSession) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <section className="ce-sessions card" data-testid="ce-sessions">
      <header className="ce-group-header">
        <h3>Sessions</h3>
        <span className="ce-group-count">{sessions.length}</span>
      </header>
      <ul className="ce-sessions-list">
        {sessions.map((s) => {
          const stageLabel = getStage(s.stage)?.label ?? s.stage;
          const awaiting = s.status === "awaiting_input";
          return (
            <li
              key={s.id}
              className={`ce-session-row${s.id === activeSessionId ? " is-active" : ""}`}
              data-testid="ce-session-row"
              data-session={s.id}
              data-status={s.status}
            >
              <button
                type="button"
                className="ce-session-open"
                data-testid="ce-session-open"
                disabled={disabled}
                onClick={() => onOpen(s)}
              >
                <span className="ce-session-stage">{stageLabel}</span>
                <span className={`ce-session-status ce-session-status-${s.status}`} data-testid="ce-session-status">
                  {awaiting ? "needs your input" : statusLabel(s.status)}
                </span>
                <span className="ce-session-updated">{new Date(s.updatedAt).toLocaleString()}</span>
              </button>
              {TERMINAL.has(s.status) ? (
                <button
                  type="button"
                  className="btn ce-session-discard"
                  data-testid="ce-session-discard"
                  disabled={disabled}
                  onClick={() => onDiscard(s)}
                >
                  Discard
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface CompoundEngineeringViewProps {
  context?: PluginDashboardViewContext;
  /** Test seam: override the active project id without a host context. */
  projectId?: string;
  /** Test seam: force the viewport-gated fetch on/off. */
  enabledOverride?: boolean;
}

function readProjectId(props: CompoundEngineeringViewProps): string | undefined {
  if (props.projectId) return props.projectId;
  const ctx = props.context as { projectId?: string } | undefined;
  return ctx?.projectId;
}

/** First-run / empty state: no artifacts AND no errors anywhere. */
function EmptyState({ onStart }: { onStart: () => void }) {
  return (
    <div className="ce-empty card" data-testid="ce-empty-state">
      <h3>Start your compounding pipeline</h3>
      <p>
        No compound-engineering artifacts found yet. Compound Engineering tracks the documents your
        pipeline produces — strategy, ideation, brainstorms, plans, solutions, and concepts — as you
        move through each stage.
      </p>
      <p className="ce-empty-hint">
        Begin with a stage and its artifact will appear here, grouped and traceable.
      </p>
      <button type="button" className="btn btn-primary" data-testid="ce-start-action" onClick={onStart}>
        Start a stage
      </button>
    </div>
  );
}

function ArtifactRow({
  entry,
  projectId,
  onSelect,
  selected,
}: {
  entry: CeArtifactEntry;
  projectId?: string;
  onSelect: (id: string) => void;
  selected: boolean;
}) {
  if (entry.kind === "error") {
    return (
      <li className="ce-artifact ce-artifact-error" data-testid="ce-artifact-error">
        <span className="ce-artifact-name">{entry.name}</span>
        <span className="ce-artifact-error-msg" role="alert">
          Could not read: {entry.error}
        </span>
        <span className="ce-artifact-path">{entry.path}</span>
      </li>
    );
  }
  return (
    <li className={`ce-artifact${selected ? " is-selected" : ""}`} data-testid="ce-artifact">
      <button type="button" className="ce-artifact-btn" onClick={() => onSelect(entry.id)}>
        <span className="ce-artifact-name">{entry.name}</span>
        <span className="ce-artifact-path">{entry.path}</span>
      </button>
      <a
        className="ce-artifact-open"
        href={getArtifactPreviewUrl(entry.id, projectId)}
        target="_blank"
        rel="noreferrer"
      >
        Open
      </a>
    </li>
  );
}

function StageGroup({
  group,
  projectId,
  onSelect,
  selectedId,
}: {
  group: CeArtifactGroup;
  projectId?: string;
  onSelect: (id: string) => void;
  selectedId?: string;
}) {
  const empty = group.entries.length === 0;
  return (
    <section className="ce-group" data-testid="ce-group" data-stage={group.stage} data-empty={empty ? "true" : "false"}>
      <header className="ce-group-header">
        <h3>{group.label}</h3>
        <span className="ce-group-count">{group.entries.length}</span>
      </header>
      {empty ? (
        <p className="ce-group-empty" data-testid="ce-group-empty">
          No {group.label.toLowerCase()} artifacts yet.
        </p>
      ) : (
        <ul className="ce-artifact-list">
          {group.entries.map((entry) => (
            <ArtifactRow
              key={entry.id}
              entry={entry}
              projectId={projectId}
              onSelect={onSelect}
              selected={selectedId === entry.id}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function CompoundEngineeringView(props: CompoundEngineeringViewProps) {
  const projectId = readProjectId(props);
  const { mobile, active } = useViewportMode();
  const enabled = props.enabledOverride ?? active;
  const { result, loading, error } = useArtifacts({ projectId, enabled });
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const stages = listStages();
  // Live push: when the host forwards a plugin:custom SSE event for THIS session,
  // refetch — lower latency than the poll fallback. Uses the host-provided
  // subscribe capability (no raw EventSource, no deep dashboard import); when the
  // host doesn't supply it, the hook falls back to polling.
  const subscribePluginEvents = (props.context as PluginDashboardViewContext | undefined)
    ?.subscribePluginEvents;
  const subscribe = useMemo<CeSessionSubscribe | undefined>(() => {
    if (!subscribePluginEvents) return undefined;
    return (sessionId, _projectId, onSessionEvent) =>
      subscribePluginEvents(CE_PLUGIN_ID, ({ payload }) => {
        if ((payload as { sessionId?: string } | undefined)?.sessionId === sessionId) {
          onSessionEvent();
        }
      });
  }, [subscribePluginEvents]);
  const ceSession = useCeSession(subscribe ? { subscribe } : {});
  // Session list refresh: ANY CE push event means some session changed.
  const subscribeList = useMemo<CeSessionsSubscribe | undefined>(() => {
    if (!subscribePluginEvents) return undefined;
    return (onAnyEvent) => subscribePluginEvents(CE_PLUGIN_ID, () => onAnyEvent());
  }, [subscribePluginEvents]);
  const ceSessions = useCeSessions({
    projectId,
    enabled,
    ...(subscribeList ? { subscribe: subscribeList } : {}),
  });
  const [launcherOpen, setLauncherOpen] = useState(false);

  const totalArtifacts = result?.totalArtifacts ?? 0;
  const totalErrors = result?.totalErrors ?? 0;
  const hasAnything = totalArtifacts > 0 || totalErrors > 0;
  // Partial discovery: at least one category populated AND at least one empty.
  const populatedGroups = result?.groups.filter((g) => g.entries.length > 0).length ?? 0;
  const emptyGroups = result?.groups.filter((g) => g.entries.length === 0).length ?? 0;
  const isPartial = populatedGroups > 0 && emptyGroups > 0;

  const onStart = () => setLauncherOpen(true);

  const onLaunch = useCallback(
    (stage: CeStageDefinition) => {
      setLauncherOpen(false);
      void ceSession
        .start(stage.stageId, { message: `Start the ${stage.label} stage.`, projectId })
        .then(() => ceSessions.refresh());
    },
    [ceSession, ceSessions, projectId],
  );

  const onOpenSession = useCallback(
    (s: CeSession) => {
      void ceSession.open(s.id, { projectId });
    },
    [ceSession, projectId],
  );

  const onDiscardSession = useCallback(
    (s: CeSession) => {
      void ceSessions.remove(s.id);
    },
    [ceSessions],
  );

  // Closing the flow returns to the overview WITHOUT stopping the session —
  // it keeps running server-side and stays reachable from the sessions panel.
  const onCloseFlow = useCallback(() => {
    ceSession.reset();
    void ceSessions.refresh();
  }, [ceSession, ceSessions]);

  // Once a session is active here, the flow renderer owns the surface until
  // closed — but the sessions panel stays visible so other sessions remain
  // one click away (switching does not stop the open one).
  if (ceSession.session) {
    return (
      <div className="ce-view" data-testid="compound-engineering-view" data-mobile={mobile ? "true" : "false"}>
        <div className="ce-view-header">
          <h2>Compound Engineering</h2>
        </div>
        <SessionsPanel
          sessions={ceSessions.sessions}
          activeSessionId={ceSession.session.id}
          disabled={ceSession.busy}
          onOpen={onOpenSession}
          onDiscard={onDiscardSession}
        />
        <CeFlow
          session={ceSession.session}
          busy={ceSession.busy}
          error={ceSession.error}
          onAnswer={ceSession.answer}
          onResume={ceSession.resume}
          onClose={onCloseFlow}
        />
      </div>
    );
  }

  return (
    <div className="ce-view" data-testid="compound-engineering-view" data-mobile={mobile ? "true" : "false"}>
      <div className="ce-view-header">
        <h2>Compound Engineering</h2>
        {hasAnything ? (
          <span className="ce-view-summary" data-testid="ce-summary">
            {totalArtifacts} artifact{totalArtifacts === 1 ? "" : "s"}
            {totalErrors > 0 ? ` · ${totalErrors} unreadable` : ""}
            {isPartial ? " · partial" : ""}
          </span>
        ) : null}
        {hasAnything ? (
          <button type="button" className="btn btn-primary ce-view-start" data-testid="ce-start-action-header" onClick={onStart}>
            Start a stage
          </button>
        ) : null}
      </div>

      {launcherOpen ? (
        <StageLauncher stages={stages} disabled={ceSession.busy} onLaunch={onLaunch} />
      ) : null}

      <SessionsPanel
        sessions={ceSessions.sessions}
        disabled={ceSession.busy}
        onOpen={onOpenSession}
        onDiscard={onDiscardSession}
      />

      {ceSessions.error ? (
        <div className="ce-view-error card" role="alert" data-testid="ce-sessions-error">
          Failed to load sessions: {ceSessions.error}
        </div>
      ) : null}

      {ceSession.error && !ceSession.session ? (
        <div className="ce-view-error card" role="alert" data-testid="ce-session-error">
          Failed to start session: {ceSession.error}
        </div>
      ) : null}

      {error ? (
        <div className="ce-view-error card" role="alert" data-testid="ce-fetch-error">
          Failed to load artifacts: {error}
        </div>
      ) : null}

      {loading && !result ? (
        <div className="ce-loading" data-testid="ce-loading">
          Discovering artifacts…
        </div>
      ) : null}

      {result && !hasAnything ? (
        <EmptyState onStart={onStart} />
      ) : null}

      {result && hasAnything ? (
        <div className="ce-groups" data-partial={isPartial ? "true" : "false"}>
          {result.groups.map((group) => (
            <StageGroup
              key={group.stage}
              group={group}
              projectId={projectId}
              onSelect={setSelectedId}
              selectedId={selectedId}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default CompoundEngineeringView;
