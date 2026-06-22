import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, RefreshCw, Settings, Target } from "lucide-react";
import { fetchSettings } from "../api";
import { useEvals } from "../hooks/useEvals";
import type { SectionId } from "./SettingsModal";
import { LoadingSpinner } from "./LoadingSpinner";
import { ViewHeader } from "./ViewHeader";
import "./EvalsView.css";

interface EvalsViewProps {
  projectId?: string;
  onOpenSettings?: (section?: SectionId) => void;
  onOpenTaskDetail?: (taskId: string) => void;
}

export function EvalsView({ projectId, onOpenSettings, onOpenTaskDetail }: EvalsViewProps) {
  const { t } = useTranslation("app");
  const { loading, error, results, runs, filters, setFilters, selectedEvalId, setSelectedEvalId, selectedEval, refresh } = useEvals({ projectId });
  const [scheduledEnabled, setScheduledEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchSettings(projectId)
      .then((settings) => {
        if (cancelled) return;
        const enabled = (settings as { evalSettings?: { enabled?: boolean } }).evalSettings?.enabled;
        setScheduledEnabled(enabled ?? false);
      })
      .catch(() => {
        if (!cancelled) setScheduledEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const hasResults = results.length > 0;
  const selectedSummary = useMemo(() => results.find((result) => result.id === selectedEvalId) ?? null, [results, selectedEvalId]);

  if (!scheduledEnabled) {
    return (
      /*
      FNXC:Evals 2026-06-23-04:15:
      The disabled state shares the standard ViewHeader (matching InsightsView/ResearchView) and centers its empty-state copy/CTA in the full-width pane. Previously it rendered as a headerless `evals-view card`, which collapsed to a ~70px min-content column and lacked a view header.
      */
      <section className="evals-view" data-testid="evals-disabled">
        <ViewHeader icon={Target} title={t("evals.title", "Evals")} />
        <div className="evals-view__empty">
          <h2 className="evals-title">{t("evals.disabledTitle", "Scheduled evals are disabled")}</h2>
          <p className="evals-empty-copy">{t("evals.enablePrompt", "Enable Scheduled Evals to review scored tasks, evidence, and follow-up recommendations.")}</p>
          <button className="btn btn-primary" type="button" onClick={() => onOpenSettings?.("scheduled-evals")}>
            <Settings size={16} />
            {t("evals.openSettings", "Open Scheduled Evals Settings")}
          </button>
        </div>
      </section>
    );
  }

  return (
    /*
    FNXC:Navigation 2026-06-22-01:10:
    Evals adopts the shared ViewHeader (CC-modeled) so this main-content destination reads consistently with the others; the scored-results grid moves into a body wrapper beneath the header. The per-list Refresh control stays in the results toolbar.
    */
    <section className="evals-view" data-testid="evals-view">
      <ViewHeader icon={Target} title={t("evals.title", "Evals")} />
      <div className="evals-view__body">
      <div className="evals-list card">
        <div className="evals-toolbar">
          <input
            className="input"
            placeholder={t("evals.searchPlaceholder", "Search task or rationale")}
            value={filters.q}
            onChange={(event) => setFilters((prev) => ({ ...prev, q: event.target.value }))}
          />
          <select
            className="select"
            value={filters.runId}
            onChange={(event) => setFilters((prev) => ({ ...prev, runId: event.target.value }))}
          >
            <option value="">{t("evals.allRuns", "All runs")}</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>{run.id}</option>
            ))}
          </select>
          <input className="input" placeholder={t("evals.minScorePlaceholder", "Min score")} value={filters.scoreMin} onChange={(event) => setFilters((prev) => ({ ...prev, scoreMin: event.target.value }))} />
          <input className="input" placeholder={t("evals.maxScorePlaceholder", "Max score")} value={filters.scoreMax} onChange={(event) => setFilters((prev) => ({ ...prev, scoreMax: event.target.value }))} />
          <button className="btn btn-icon" type="button" onClick={() => void refresh()} aria-label={t("evals.refreshAria", "Refresh evals")}><RefreshCw size={16} /></button>
        </div>

        {loading && <p className="evals-state" data-testid="evals-loading"><LoadingSpinner label={t("evals.loading", "Loading evals…")} /></p>}
        {error && <p className="evals-state evals-state--error">{error}</p>}
        {!loading && !error && !hasResults && (
          <p className="evals-state">{t("evals.empty", "No evals yet. Scheduled evals review tasks completed since the last run.")}</p>
        )}

        <ul className="evals-results" data-testid="evals-results">
          {results.map((result) => (
            <li key={result.id}>
              <button className={`evals-result ${result.id === selectedEvalId ? "evals-result--active" : ""}`} type="button" onClick={() => setSelectedEvalId(result.id)}>
                <span className="evals-result-title">{result.taskTitle}</span>
                <span className="evals-result-meta">{result.taskId} · {result.runId} · {result.overallScore ?? t("evals.naPlaceholder", "n/a")}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="evals-detail card" data-testid="evals-detail">
        {!selectedEval && <p className="evals-state">{t("evals.selectPrompt", "Select an evaluation to inspect scores, rationale, and evidence.")}</p>}
        {selectedEval && (
          <>
            <h3 className="evals-detail-title">{selectedSummary?.taskTitle ?? selectedEval.taskTitle}</h3>
            <p className="evals-result-meta">{selectedEval.taskId} · {selectedEval.runId}</p>
            <p className="evals-score">{t("evals.overallScore", "Overall score: {{score}}", { score: selectedEval.overallScore ?? t("evals.naPlaceholder", "n/a") })}</p>
            <ul className="evals-categories">
              {selectedEval.categoryScores.map((score) => (
                <li key={score.category}>{score.category}: {score.finalScore}</li>
              ))}
            </ul>
            <p className="evals-rationale">{selectedEval.rationale || t("evals.noRationale", "No rationale recorded.")}</p>

            <div>
              <h4>{t("evals.evidenceHeading", "Evidence")}</h4>
              <ul className="evals-links">
                {selectedEval.evidence.map((item, index) => {
                  const taskId = typeof item.metadata?.taskId === "string" ? item.metadata.taskId : undefined;
                  const url = typeof item.metadata?.url === "string" ? item.metadata.url : undefined;
                  return (
                    <li key={`${item.ref}-${index}`}>
                      {taskId ? (
                        <button type="button" className="btn" onClick={() => onOpenTaskDetail?.(taskId)}>{item.ref}</button>
                      ) : url ? (
                        <a href={url} target="_blank" rel="noreferrer" className="evals-external-link">{item.ref}<ExternalLink size={14} /></a>
                      ) : (
                        <span>{item.ref}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>

            <div>
              <h4>{t("evals.suggestedFollowupsHeading", "Suggested follow-up tasks")}</h4>
              <ul className="evals-follow-ups">
                {selectedEval.followUps.length === 0 && <li>{t("evals.noFollowups", "None")}</li>}
                {selectedEval.followUps.map((followUp) => (
                  <li key={followUp.suggestionId}><strong>{followUp.title}</strong><p>{followUp.rationale}</p></li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
      </div>
    </section>
  );
}
