import "./CompoundEngineeringView.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as LucideIcons from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { ViewHeader } from "@fusion/dashboard/app/components/ViewHeader";
import { useArtifacts } from "./hooks/useArtifacts.js";
import { useViewportMode } from "./hooks/useViewportMode.js";
import { useCeSession, type CeSessionSubscribe } from "./hooks/useCeSession.js";
import { useCeSessions, type CeSessionsSubscribe } from "./hooks/useCeSessions.js";
import { CeFlow } from "./CeFlow.js";
import { getStage, listPipelineStages, listStages, type CeStageDefinition } from "../session/stage-registry.js";
import type { CeArtifactEntry, CeArtifactGroup } from "../artifacts/discovery.js";
import type { CeSession, CeSessionStatus } from "../session/session-store.js";

const CE_PLUGIN_ID = "fusion-plugin-compound-engineering";
export const COMPOUND_ENGINEERING_VIEW_HEADER_ICON = "Boxes";

/**
 * FNXC:CompoundEngineeringUI 2026-06-17-00:52:
 * The dashboard surface keeps CE-specific data-testid values and semantics intact while adding shared Fusion classes to panels and controls so plugin layout inherits the system button/card rhythm.
 *
 * FNXC:CompoundEngineeringUI 2026-06-22-09:40:
 * The view renders the dashboard's shared ViewHeader (Boxes icon + "Compound Engineering" title) at the top of its root container so the CE plugin surface reads with the same main-content header as native Fusion views. ViewHeader supplies the standard --space-lg top/side padding and is flex-shrink:0, so the root drops its own header padding and becomes a flex column whose content area (.ce-view-body) scrolls below the fixed header. The summary + "Start a stage" affordances move into ViewHeader's right-aligned actions slot, preserving their data-testid values (ce-summary, ce-start-action-header).
 */

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
  onCancel,
  onDiscard,
}: {
  sessions: CeSession[];
  activeSessionId?: string;
  disabled: boolean;
  onOpen: (session: CeSession) => void;
  onCancel: (session: CeSession) => void;
  onDiscard: (session: CeSession) => void;
}) {
  const [discardCandidate, setDiscardCandidate] = useState<string>();
  if (sessions.length === 0) return null;
  return (
    <details className="ce-sessions" data-testid="ce-sessions">
      <summary className="ce-sessions-summary">
        <span>Session history</span>
        <span className="ce-group-count">{sessions.length}</span>
      </summary>
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
                className="btn ce-session-open"
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
                discardCandidate === s.id ? (
                  <span className="ce-discard-confirm" data-testid="ce-discard-confirm">
                    <button type="button" className="btn ce-session-discard" disabled={disabled} onClick={() => onDiscard(s)}>
                      Delete permanently
                    </button>
                    <button type="button" className="btn" disabled={disabled} onClick={() => setDiscardCandidate(undefined)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn ce-session-discard"
                    data-testid="ce-session-discard"
                    disabled={disabled}
                    onClick={() => setDiscardCandidate(s.id)}
                  >
                    Discard
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="btn btn-icon ce-session-cancel"
                  data-testid="ce-session-cancel"
                  disabled={disabled}
                  onClick={() => onCancel(s)}
                  aria-label="Cancel session"
                  title="Cancel session"
                >
                  <LucideIcons.CircleStop size={16} aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function nextPipelineStageId(stageId: string): string | undefined {
  if (stageId === "strategy" || stageId === "ideate") return "brainstorm";
  const stages = listPipelineStages();
  const index = stages.findIndex((stage) => stage.stageId === stageId);
  return index >= 0 ? stages[index + 1]?.stageId : undefined;
}

type RailStatus = "Not started" | "Active" | "Needs input" | "Last run complete" | "History" | "Current";

function artifactsForStage(stageId: string, groups: CeArtifactGroup[]): CeArtifactEntry[] {
  const entries = groups.find((group) => group.stage === stageId)?.entries
    ?? (stageId === "compound" ? groups.find((group) => group.stage === "solution")?.entries : undefined)
    ?? [];
  if (stageId === "brainstorm") {
    const unifiedEntries = groups.find((group) => group.stage === "plan")?.entries ?? [];
    return [...entries, ...unifiedEntries.filter((entry) => (
      entry.kind === "artifact"
      && entry.artifactContract === "ce-unified-plan/v1"
      && (entry.artifactReadiness === "requirements-only" || !entry.productContractSource || entry.productContractSource === "ce-brainstorm")
    ))];
  }
  if (stageId === "plan") {
    return entries.filter((entry) => (
      entry.kind === "artifact"
      && (entry.artifactReadiness === "implementation-ready" || !entry.artifactReadiness)
    ));
  }
  return entries.filter((entry) => entry.kind === "artifact");
}

function railStatus(stageId: string, sessions: CeSession[], artifact?: CeArtifactEntry): RailStatus {
  const latest = sessions.find((session) => session.stage === stageId);
  if (latest?.status === "awaiting_input") return "Needs input";
  if (latest?.status === "active" || latest?.status === "launching") return "Active";
  if (latest?.status === "completed") return "Last run complete";
  if (artifact?.kind === "artifact") return stageId === "strategy" ? "Current" : "History";
  return "Not started";
}

const STAGE_PURPOSE: Record<string, string> = {
  strategy: "Set the product direction",
  ideate: "Explore high-leverage ideas",
  brainstorm: "Define what to build",
  plan: "Decide how to build it",
  work: "Build, simplify, and review",
  compound: "Save reusable learnings",
};

function StageRail({
  stages,
  groups,
  sessions,
  disabled,
  openFile,
  onLaunch,
  onOpenSession,
}: {
  stages: CeStageDefinition[];
  groups: CeArtifactGroup[];
  sessions: CeSession[];
  disabled: boolean;
  openFile?: PluginDashboardViewContext["openFile"];
  onLaunch: (stage: CeStageDefinition) => void;
  onOpenSession: (session: CeSession) => void;
}) {
  return (
    <ol className="ce-stage-rail" data-count={stages.length}>
      {stages.map((stage) => {
        const artifacts = artifactsForStage(stage.stageId, groups);
        const artifact = artifacts[0];
        const stageSessions = sessions.filter((session) => session.stage === stage.stageId);
        const latestSession = stageSessions[0];
        const status = railStatus(stage.stageId, sessions, artifact);
        const Icon = resolveIcon(stage.icon);
        return (
          <li key={stage.stageId} className="ce-stage-step" data-status={status.toLowerCase().replaceAll(" ", "-")}>
            <button
              type="button"
              className="ce-stage-main"
              data-testid="ce-pipeline-stage"
              data-stage={stage.stageId}
              disabled={disabled}
              onClick={() => latestSession && !TERMINAL.has(latestSession.status) ? onOpenSession(latestSession) : onLaunch(stage)}
            >
              <span className="ce-stage-icon"><Icon size={17} aria-hidden="true" /></span>
              <span className="ce-stage-copy">
                <strong>{stage.label}</strong>
                {STAGE_PURPOSE[stage.stageId] ? <span className="ce-stage-purpose">{STAGE_PURPOSE[stage.stageId]}</span> : null}
                <span className="ce-stage-status">
                  {status} · {stageSessions.length} {stageSessions.length === 1 ? "run" : "runs"} · {artifacts.length} {artifacts.length === 1 ? "artifact" : "artifacts"}
                </span>
              </span>
            </button>
            {artifact?.kind === "artifact" ? (
              <button type="button" className="ce-stage-artifact" onClick={() => openFile?.(artifact.path, { workspace: "project" })}>
                <LucideIcons.FileText size={13} aria-hidden="true" />
                <span>{artifact.name}</span>
              </button>
            ) : <span className="ce-stage-artifact is-empty">No artifact yet</span>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * FNXC:CompoundEngineeringUI 2026-07-10-12:00:
 * Operators need the optional foundation plus four-stage delivery loop as the overview's primary navigation. Stages report repeatable run and artifact collections instead of implying one permanent completion; Strategy remains the upstream singleton anchor, while Debug remains a separate investigation action because it is not pipeline progression.
 *
 * FNXC:CompoundEngineeringUI 2026-07-10-23:40:
 * Compound Engineering follows the upstream repeatable loop: brainstorm requirements, plan implementation, work through built-in simplification and review, compound the learning, then repeat with better context. Brainstorm and Plan therefore expose collection counts and latest activity over multiple unified-plan files rather than a single artifact slot.
 *
 * FNXC:CompoundEngineeringUI 2026-07-11-00:02:
 * Strategy and Ideate are optional foundation work, not mandatory delivery gates. Visually separate them from the Brainstorm -> Plan -> Work -> Compound loop, and state that Work owns simplification and review so users do not repeat quality stages manually.
 */
function PipelineOverview({
  groups,
  sessions,
  disabled,
  openFile,
  onLaunch,
  onOpenSession,
}: {
  groups: CeArtifactGroup[];
  sessions: CeSession[];
  disabled: boolean;
  openFile?: PluginDashboardViewContext["openFile"];
  onLaunch: (stage: CeStageDefinition) => void;
  onOpenSession: (session: CeSession) => void;
}) {
  const stages = listStages().filter((stage) => stage.stageId !== "debug");
  const foundationStages = stages.filter((stage) => stage.stageId === "strategy" || stage.stageId === "ideate");
  const deliveryStages = stages.filter((stage) => stage.stageId !== "strategy" && stage.stageId !== "ideate");
  const debug = getStage("debug");
  return (
    <section className="ce-pipeline" data-testid="ce-pipeline">
      <header className="ce-pipeline-header">
        <div>
          <h2>Compound Engineering</h2>
          <p>Plan deeply, ship carefully, and save what you learn.</p>
        </div>
        {debug ? (
          <button type="button" className="btn ce-investigate" data-testid="ce-investigate" disabled={disabled} onClick={() => onLaunch(debug)}>
            <LucideIcons.Bug size={16} aria-hidden="true" /> Investigate
          </button>
        ) : null}
      </header>
      <div className="ce-pipeline-block">
        <div className="ce-pipeline-block-heading"><h3>Foundation</h3><span>Optional grounding</span></div>
        <StageRail stages={foundationStages} groups={groups} sessions={sessions} disabled={disabled} openFile={openFile} onLaunch={onLaunch} onOpenSession={onOpenSession} />
      </div>
      <div className="ce-pipeline-block">
        <div className="ce-pipeline-block-heading"><h3>Delivery loop</h3><span>Repeat for each meaningful change</span></div>
        <StageRail stages={deliveryStages} groups={groups} sessions={sessions} disabled={disabled} openFile={openFile} onLaunch={onLaunch} onOpenSession={onOpenSession} />
      </div>
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
        workflow produces — strategy, ideation, brainstorms, plans, work logs, learnings, and concepts — as you
        move through each stage.
      </p>
      <p className="ce-empty-hint">
        Start with Brainstorm when the problem is still fuzzy, Plan when requirements are settled, or Debug for broken behavior.
      </p>
      <button type="button" className="btn btn-primary" data-testid="ce-start-action" onClick={onStart}>
        Start a stage
      </button>
    </div>
  );
}

function ArtifactRow({
  entry,
  onSelect,
  selected,
  openFile,
}: {
  entry: CeArtifactEntry;
  onSelect: (id: string) => void;
  selected: boolean;
  openFile?: PluginDashboardViewContext["openFile"];
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
  const readinessLabel = entry.artifactReadiness === "requirements-only"
    ? "Requirements"
    : entry.artifactReadiness === "implementation-ready"
      ? "Implementation ready"
      : entry.artifactReadiness;
  return (
    <li className={`ce-artifact${selected ? " is-selected" : ""}`} data-testid="ce-artifact">
      <button type="button" className="ce-artifact-btn" onClick={() => onSelect(entry.id)}>
        <span className="ce-artifact-name">{entry.name}</span>
        {entry.artifactReadiness ? (
          <span className={`ce-readiness ce-readiness-${entry.artifactReadiness}`}>
            {readinessLabel}
          </span>
        ) : null}
        <span className="ce-artifact-path">{entry.path}</span>
      </button>
      <button
        type="button"
        className="ce-artifact-open"
        data-testid="ce-artifact-open"
        onClick={() => openFile?.(entry.path, { workspace: "project" })}
      >
        Open
      </button>
    </li>
  );
}

function StageGroup({
  group,
  onSelect,
  selectedId,
  openFile,
}: {
  group: CeArtifactGroup;
  onSelect: (id: string) => void;
  selectedId?: string;
  openFile?: PluginDashboardViewContext["openFile"];
}) {
  /*
   * FNXC:CompoundEngineeringUI 2026-07-11-00:06:
   * Brainstorm and Plan are repeatable collections that can contain dozens of artifacts. Keep the four newest visible for scanning and disclose the full history on demand so power does not overwhelm the default view.
   */
  const empty = group.entries.length === 0;
  const singleton = group.stage === "strategy";
  const visibleEntries = group.entries.slice(0, 4);
  const remainingEntries = group.entries.slice(4);
  return (
    <section className="ce-group card" data-testid="ce-group" data-stage={group.stage} data-layout={singleton ? "singleton" : "collection"} data-empty={empty ? "true" : "false"}>
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
          {visibleEntries.map((entry) => (
            <ArtifactRow
              key={entry.id}
              entry={entry}
              onSelect={onSelect}
              selected={selectedId === entry.id}
              openFile={openFile}
            />
          ))}
        </ul>
      )}
      {remainingEntries.length > 0 ? (
        <details className="ce-group-more">
          <summary>Show all {group.entries.length}</summary>
          <ul className="ce-artifact-list">
            {remainingEntries.map((entry) => (
              <ArtifactRow
                key={entry.id}
                entry={entry}
                onSelect={onSelect}
                selected={selectedId === entry.id}
                openFile={openFile}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function artifactDisplayGroups(groups: CeArtifactGroup[]): CeArtifactGroup[] {
  const conventionalBrainstorms = groups.find((group) => group.stage === "brainstorm");
  const hasCompoundGroup = groups.some((group) => group.stage === "compound");
  return groups.flatMap((group) => {
    if (group.stage === "brainstorm") return [];
    if (group.stage === "solution") {
      return hasCompoundGroup ? [] : [{ ...group, stage: "compound", label: "Learnings" }];
    }
    if (group.stage !== "plan") return [group];
    const brainstorms = group.entries.filter((entry) => (
      entry.kind === "artifact"
      && entry.artifactContract === "ce-unified-plan/v1"
      && entry.artifactReadiness === "requirements-only"
    ));
    const plans = group.entries.filter((entry) => (
      entry.kind === "error"
      || (entry.artifactReadiness !== "requirements-only")
    ));
    return [
      {
        ...(conventionalBrainstorms ?? group),
        stage: "brainstorm",
        label: "Brainstorms",
        present: Boolean(conventionalBrainstorms?.present || brainstorms.length > 0),
        entries: [...(conventionalBrainstorms?.entries ?? []), ...brainstorms],
      },
      { ...group, label: "Plans", entries: plans },
    ];
  });
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
  const openFile = props.context?.openFile;
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
  const activeSession = ceSession.session;
  const openSession = ceSession.open;
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
  const [sessionActionBusy, setSessionActionBusy] = useState(false);

  const setSessionUrl = useCallback((value?: string) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("ceSession", value);
    else url.searchParams.delete("ceSession");
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const totalArtifacts = result?.totalArtifacts ?? 0;
  const totalErrors = result?.totalErrors ?? 0;
  const hasAnything = totalArtifacts > 0 || totalErrors > 0;
  // Partial discovery: at least one category populated AND at least one empty.
  const populatedGroups = result?.groups.filter((g) => g.entries.length > 0).length ?? 0;
  const emptyGroups = result?.groups.filter((g) => g.entries.length === 0).length ?? 0;
  const isPartial = populatedGroups > 0 && emptyGroups > 0;

  const onStart = () => setLauncherOpen(true);

  const onLaunch = useCallback(
    (stage: CeStageDefinition, sourceSessionId?: string) => {
      setLauncherOpen(false);
      void ceSession
        .start(stage.stageId, { message: `Start the ${stage.label} stage.`, projectId, sourceSessionId })
        .then((session) => {
          if (session) setSessionUrl(session.id);
          return ceSessions.refresh();
        });
    },
    [ceSession, ceSessions, projectId, setSessionUrl],
  );

  const onOpenSession = useCallback(
    (s: CeSession) => {
      setSessionUrl(s.id);
      void openSession(s.id, { projectId });
    },
    [openSession, projectId, setSessionUrl],
  );

  const onCancelSession = useCallback(
    (s: CeSession) => {
      setSessionActionBusy(true);
      void ceSessions
        .cancel(s.id)
        .then(() => {
          if (ceSession.session?.id === s.id) {
            ceSession.reset();
            setSessionUrl();
          }
        })
        .finally(() => setSessionActionBusy(false));
    },
    [ceSession, ceSessions, setSessionUrl],
  );

  const onDiscardSession = useCallback(
    (s: CeSession) => {
      setSessionActionBusy(true);
      void ceSessions.remove(s.id).finally(() => setSessionActionBusy(false));
    },
    [ceSessions],
  );

  // Closing the flow returns to the overview WITHOUT stopping the session —
  // it keeps running server-side and stays reachable from the sessions panel.
  const onCloseFlow = useCallback(() => {
    ceSession.reset();
    setSessionUrl();
    void ceSessions.refresh();
  }, [ceSession, ceSessions, setSessionUrl]);

  const resumableSession = useMemo(() => {
    return ceSessions.sessions.find(
      (session) => session.status === "active" || session.status === "awaiting_input" || session.status === "launching",
    );
  }, [ceSessions.sessions]);

  useEffect(() => {
    if (activeSession || ceSessions.loading || ceSessions.sessions.length === 0 || typeof window === "undefined") return;
    const sessionId = new URL(window.location.href).searchParams.get("ceSession");
    const session = ceSessions.sessions.find((candidate) => candidate.id === sessionId);
    if (session) void openSession(session.id, { projectId });
  }, [activeSession, ceSessions.loading, ceSessions.sessions, openSession, projectId]);

  // Once a session is active here, the flow renderer owns the surface until
  // closed — but the sessions panel stays visible so other sessions remain
  // one click away (switching does not stop the open one).
  /*
  FNXC:CompoundEngineering 2026-06-28-00:00:
  Compound Engineering uses Boxes for its nav and view header icon because Sparkles collides with Insights in the left sidebar. Keep this header aligned with the plugin dashboardViews icon so desktop, mobile, and in-view surfaces share the same no-overlap glyph.
  */
  const HeaderIcon = LucideIcons[COMPOUND_ENGINEERING_VIEW_HEADER_ICON];

  if (ceSession.session) {
    return (
      <div className="ce-view" data-testid="compound-engineering-view" data-mobile={mobile ? "true" : "false"}>
        <ViewHeader icon={HeaderIcon} title="Compound Engineering" />
        <div className="ce-view-body">
          <SessionsPanel
            sessions={ceSessions.sessions}
            activeSessionId={ceSession.session.id}
            disabled={ceSession.busy || sessionActionBusy}
            onOpen={onOpenSession}
            onCancel={onCancelSession}
            onDiscard={onDiscardSession}
          />
          <CeFlow
            session={ceSession.session}
            busy={ceSession.busy || sessionActionBusy}
            error={ceSession.error}
            onAnswer={ceSession.answer}
            onResume={ceSession.resume}
            onCancel={() => onCancelSession(ceSession.session!)}
            onClose={onCloseFlow}
            onOpenArtifact={openFile ? (path) => openFile(path, { workspace: "project" }) : undefined}
            nextStageId={nextPipelineStageId(ceSession.session.stage)}
            onStartNextStage={(stageId) => {
              const stage = getStage(stageId);
              if (stage) onLaunch(stage, ceSession.session!.id);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="ce-view" data-testid="compound-engineering-view" data-mobile={mobile ? "true" : "false"}>
      <ViewHeader
        icon={HeaderIcon}
        title="Compound Engineering"
        actions={
          hasAnything ? (
            <>
              <span className="ce-view-summary" data-testid="ce-summary">
                {totalArtifacts} artifact{totalArtifacts === 1 ? "" : "s"}
                {totalErrors > 0 ? ` · ${totalErrors} unreadable` : ""}
                {isPartial ? " · partial" : ""}
              </span>
              <button type="button" className="btn btn-primary ce-view-start" data-testid="ce-start-action-header" onClick={onStart}>
                Start a stage
              </button>
            </>
          ) : null
        }
      />

      <div className="ce-view-body">
        <PipelineOverview
          groups={result?.groups ?? []}
          sessions={ceSessions.sessions}
          disabled={ceSession.busy || sessionActionBusy}
          openFile={openFile}
          onLaunch={onLaunch}
          onOpenSession={onOpenSession}
        />

        {resumableSession ? (
          <button type="button" className="ce-resume-banner" data-testid="ce-resume-latest" onClick={() => onOpenSession(resumableSession)}>
            <span className="ce-resume-icon"><LucideIcons.Play size={16} aria-hidden="true" /></span>
            <span>
              <strong>{resumableSession.status === "awaiting_input" ? "Input needed" : "Resume active session"}</strong>
              <small>{getStage(resumableSession.stage)?.label ?? resumableSession.stage} · Updated {new Date(resumableSession.updatedAt).toLocaleString()}</small>
            </span>
            <LucideIcons.ChevronRight size={17} aria-hidden="true" />
          </button>
        ) : null}

        {launcherOpen ? (
          <StageLauncher stages={listStages().filter((stage) => stage.stageId !== "debug")} disabled={ceSession.busy} onLaunch={onLaunch} />
        ) : null}

        <SessionsPanel
          sessions={ceSessions.sessions}
          disabled={ceSession.busy || sessionActionBusy}
          onOpen={onOpenSession}
          onCancel={onCancelSession}
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
            {artifactDisplayGroups(result.groups).map((group) => (
              <StageGroup
                key={group.stage}
                group={group}
                onSelect={setSelectedId}
                selectedId={selectedId}
                openFile={openFile}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default CompoundEngineeringView;
