import "./CompoundEngineeringView.css";
import { useCallback, useState } from "react";
import * as LucideIcons from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { useArtifacts } from "./hooks/useArtifacts.js";
import { useViewportMode } from "./hooks/useViewportMode.js";
import { useCeSession } from "./hooks/useCeSession.js";
import { getArtifactPreviewUrl } from "./hooks/api.js";
import { CeFlow } from "./CeFlow.js";
import { listStages, type CeStageDefinition } from "../session/stage-registry.js";
import type { CeArtifactEntry, CeArtifactGroup } from "../artifacts/discovery.js";

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
  const ceSession = useCeSession();
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
      void ceSession.start(stage.stageId, { message: `Start the ${stage.label} stage.`, projectId });
    },
    [ceSession, projectId],
  );

  const onCloseFlow = useCallback(() => ceSession.reset(), [ceSession]);

  // Once a session exists, the flow renderer owns the surface until closed.
  if (ceSession.session) {
    return (
      <div className="ce-view" data-testid="compound-engineering-view" data-mobile={mobile ? "true" : "false"}>
        <div className="ce-view-header">
          <h2>Compound Engineering</h2>
        </div>
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
