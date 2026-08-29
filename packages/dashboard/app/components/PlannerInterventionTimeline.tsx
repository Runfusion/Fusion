import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { PlannerInterventionEntry, PlannerInterventionSourceLink } from "@fusion/core";
import { fetchPlannerInterventionTimeline } from "../api";

/*
FNXC:PlannerOversight 2026-07-04-18:00:
FN-7519 Intervention Timeline UI. Renders the FN-7519 planner-intervention
entries (stage / reason / action / outcome / attempt count+limit / source
links) inside/adjacent to the FN-7517 oversight cluster in TaskDetailModal.
Renders a calm empty state ("No planner interventions yet") rather than an
empty shell when there are no interventions, and safely falls back on
unknown/legacy/future stage/action/outcome enum values instead of throwing.
This component is a pure READ surface \u2014 FN-7520 owns wiring the actual
`recordPlannerIntervention` call-sites at overseer decision points.
*/

export interface PlannerInterventionTimelineProps {
  taskId: string;
  projectId?: string;
  /** When true, the timeline renders nothing (no leftover shell) \u2014 used for the "oversight Off / undefined" branch so callers don't fetch or render an always-on empty container. */
  hidden?: boolean;
}

const STAGE_LABEL_KEYS: Record<string, string> = {
  executor: "taskDetail.oversight.interventions.stage.executor",
  reviewer: "taskDetail.oversight.interventions.stage.reviewer",
  merger: "taskDetail.oversight.interventions.stage.merger",
  "pull-request": "taskDetail.oversight.interventions.stage.pullRequest",
  "workflow-gate": "taskDetail.oversight.interventions.stage.workflowGate",
};

const ACTION_LABEL_KEYS: Record<string, string> = {
  observe: "taskDetail.oversight.interventions.action.observe",
  "inject-guidance": "taskDetail.oversight.interventions.action.injectGuidance",
  retry: "taskDetail.oversight.interventions.action.retry",
  "request-fix": "taskDetail.oversight.interventions.action.requestFix",
  escalate: "taskDetail.oversight.interventions.action.escalate",
  "request-confirmation": "taskDetail.oversight.interventions.action.requestConfirmation",
};

const OUTCOME_LABEL_KEYS: Record<string, string> = {
  succeeded: "taskDetail.oversight.interventions.outcome.succeeded",
  failed: "taskDetail.oversight.interventions.outcome.failed",
  pending: "taskDetail.oversight.interventions.outcome.pending",
  "awaiting-confirmation": "taskDetail.oversight.interventions.outcome.awaitingConfirmation",
  skipped: "taskDetail.oversight.interventions.outcome.skipped",
};

const OUTCOME_DOT_MODIFIER: Record<string, string> = {
  succeeded: "status-dot--online",
  failed: "status-dot--error",
  pending: "status-dot--pending",
  "awaiting-confirmation": "status-dot--connecting",
  skipped: "status-dot--skipped",
};

const SOURCE_LINK_LABEL_KEYS: Record<string, string> = {
  "agent-log": "taskDetail.oversight.interventions.sourceLink.agentLog",
  "review-comment": "taskDetail.oversight.interventions.sourceLink.reviewComment",
  "failed-check": "taskDetail.oversight.interventions.sourceLink.failedCheck",
  "merge-error": "taskDetail.oversight.interventions.sourceLink.mergeError",
  "pr-state": "taskDetail.oversight.interventions.sourceLink.prState",
  url: "taskDetail.oversight.interventions.sourceLink.url",
};

function SourceLinkChip({ link, index }: { link: PlannerInterventionSourceLink; index: number }) {
  const { t } = useTranslation();
  const kindLabel = t(SOURCE_LINK_LABEL_KEYS[link.kind] ?? SOURCE_LINK_LABEL_KEYS.url, link.kind);
  const display = link.label && link.label.length > 0 ? link.label : kindLabel;
  const href = link.url;

  const content = (
    <>
      <span className="planner-intervention-source-link__kind">{kindLabel}</span>
      <span className="planner-intervention-source-link__label">{display}</span>
    </>
  );

  return href ? (
    <a
      key={`${link.kind}-${index}`}
      className="planner-intervention-source-link"
      data-testid="planner-intervention-source-link"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={link.target ?? href}
    >
      {content}
    </a>
  ) : (
    <span
      key={`${link.kind}-${index}`}
      className="planner-intervention-source-link planner-intervention-source-link--inert"
      data-testid="planner-intervention-source-link"
      title={link.target}
    >
      {content}
    </span>
  );
}

function InterventionEntryRow({ entry }: { entry: PlannerInterventionEntry }) {
  const { t } = useTranslation();
  const stageLabel = t(STAGE_LABEL_KEYS[entry.stage] ?? STAGE_LABEL_KEYS["workflow-gate"], entry.stage);
  const actionLabel = t(ACTION_LABEL_KEYS[entry.action] ?? ACTION_LABEL_KEYS.observe, entry.action);
  const outcomeLabel = t(OUTCOME_LABEL_KEYS[entry.outcome] ?? OUTCOME_LABEL_KEYS.pending, entry.outcome);
  const dotModifier = OUTCOME_DOT_MODIFIER[entry.outcome] ?? "status-dot--pending";
  const hasAttempts = typeof entry.attemptCount === "number" && typeof entry.attemptLimit === "number";
  const timestampLabel = (() => {
    try {
      return new Date(entry.timestamp).toLocaleString();
    } catch {
      return entry.timestamp;
    }
  })();

  return (
    <li className="planner-intervention-entry" data-testid="planner-intervention-entry">
      <div className="planner-intervention-entry__header">
        <span className="planner-intervention-entry__stage" data-testid="planner-intervention-entry-stage">
          {stageLabel}
        </span>
        <span className={`status-dot ${dotModifier}`} aria-hidden="true" />
        <span className="planner-intervention-entry__outcome">{outcomeLabel}</span>
        <span className="planner-intervention-entry__timestamp">{timestampLabel}</span>
      </div>
      <p className="planner-intervention-entry__reason">{entry.reason}</p>
      <div className="planner-intervention-entry__meta">
        <span className="planner-intervention-entry__action">{actionLabel}</span>
        {hasAttempts && (
          <span className="planner-intervention-entry__attempts" data-testid="planner-intervention-entry-attempts">
            {t("taskDetail.oversight.interventions.attempts", "Attempt {{count}}/{{limit}}", {
              count: entry.attemptCount,
              limit: entry.attemptLimit,
            })}
          </span>
        )}
      </div>
      {entry.sourceLinks && entry.sourceLinks.length > 0 && (
        <div className="planner-intervention-entry__links" data-testid="planner-intervention-entry-links">
          {entry.sourceLinks.map((link, index) => (
            <SourceLinkChip key={`${link.kind}-${link.target ?? link.url ?? index}`} link={link} index={index} />
          ))}
        </div>
      )}
    </li>
  );
}

export function PlannerInterventionTimeline({ taskId, projectId, hidden }: PlannerInterventionTimelineProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<PlannerInterventionEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    setIsLoading(true);
    setLoadError(false);
    fetchPlannerInterventionTimeline(taskId, projectId)
      .then((result) => {
        if (cancelled) return;
        setEntries(Array.isArray(result?.entries) ? result.entries : []);
      })
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
        setLoadError(true);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, projectId, hidden]);

  // FNXC:PlannerOversight 2026-07-04-18:00: when hidden (oversight Off / oversight
  // fields undefined), render nothing at all — no leftover empty container,
  // scroll region, or dangling aria-label, per the Surface Enumeration gate.
  if (hidden) return null;

  return (
    <section
      className="task-oversight-timeline"
      data-testid="planner-intervention-timeline"
      aria-label={t("taskDetail.oversight.interventions.ariaLabel", "Planner intervention timeline")}
    >
      <h4 className="task-oversight-timeline__heading">
        {t("taskDetail.oversight.interventions.heading", "Intervention timeline")}
      </h4>
      {isLoading ? (
        <span className="task-oversight-timeline__loading">
          <Loader2 className="spin" aria-hidden="true" />
          {t("taskDetail.oversight.interventions.loading", "Loading intervention timeline\u2026")}
        </span>
      ) : entries.length === 0 ? (
        <p className="task-oversight-timeline__empty" data-testid="planner-intervention-timeline-empty">
          {loadError
            ? t("taskDetail.oversight.interventions.loadError", "Unable to load intervention timeline")
            : t("taskDetail.oversight.interventions.empty", "No planner interventions yet")}
        </p>
      ) : (
        <ul className="planner-intervention-list">
          {entries.map((entry) => (
            <InterventionEntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}
