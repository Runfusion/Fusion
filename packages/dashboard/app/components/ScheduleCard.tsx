import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Play, Pause, Pencil, Trash2, Clock, CheckCircle, XCircle, ChevronDown, ChevronUp, Layers, Globe, Folder } from "lucide-react";
import type { ScheduledTask, AutomationRunResult, AutomationStepResult } from "@fusion/core";
import { useConfirm } from "../hooks/useConfirm";

/**
 * Format a duration in milliseconds to a human-readable string.
 */
function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Format an ISO timestamp to a relative time string.
 */
function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;

  // Future
  if (diffMs < 0) {
    const absDiff = Math.abs(diffMs);
    if (absDiff < 60_000) return "in a moment";
    if (absDiff < 3_600_000) return `in ${Math.floor(absDiff / 60_000)}m`;
    if (absDiff < 86_400_000) return `in ${Math.floor(absDiff / 3_600_000)}h`;
    return `in ${Math.floor(absDiff / 86_400_000)}d`;
  }

  // Past
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

const SCHEDULE_TYPE_COLORS: Record<string, string> = {
  hourly: "var(--color-blue, #3b82f6)",
  daily: "var(--color-green, #22c55e)",
  weekly: "var(--color-purple, #a855f7)",
  monthly: "var(--color-orange, #f97316)",
  custom: "var(--color-gray, #6b7280)",
  every15Minutes: "var(--color-cyan, #06b6d4)",
  every30Minutes: "var(--color-teal, #14b8a6)",
  every2Hours: "var(--color-indigo, #6366f1)",
  every6Hours: "var(--color-rose, #f43f5e)",
  every12Hours: "var(--color-amber, #f59e0b)",
  weekdays: "var(--color-emerald, #10b981)",
};

interface ScheduleCardProps {
  schedule: ScheduledTask;
  onEdit: (schedule: ScheduledTask) => void;
  onDelete: (schedule: ScheduledTask) => void;
  onRun: (schedule: ScheduledTask) => void;
  onToggle: (schedule: ScheduledTask) => void;
  /** Whether a manual run is currently in progress. */
  running?: boolean;
}

function RunResultBadge({ result }: { result: AutomationRunResult }) {
  const { t } = useTranslation("app");
  const duration = new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime();
  return (
    <span className={`schedule-run-badge ${result.success ? "success" : "failure"}`}>
      {result.success ? (
        <CheckCircle size={12} />
      ) : (
        <XCircle size={12} />
      )}
      <span>{result.success ? t("schedule.resultSuccess", "Success") : t("schedule.resultFailed", "Failed")}</span>
      <span className="schedule-run-duration">{formatDurationMs(duration)}</span>
    </span>
  );
}

function StepResultIndicator({ stepResults }: { stepResults: AutomationStepResult[] }) {
  return (
    <span className="step-results-indicator">
      {stepResults.map((sr) => (
        <span
          key={sr.stepId}
          className={`step-result-dot ${sr.success ? "success" : "failure"}`}
          title={`${sr.stepName}: ${sr.success ? "success" : "failed"}`}
        />
      ))}
    </span>
  );
}

function RunHistoryItem({ result, index }: { result: AutomationRunResult; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const duration = new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime();
  const hasStepResults = result.stepResults && result.stepResults.length > 0;

  return (
    <div className="schedule-history-item">
      <button
        className="schedule-history-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`Run #${index + 1}: ${result.success ? "succeeded" : "failed"} ${relativeTime(result.startedAt)}`}
      >
        <span className={`schedule-history-status ${result.success ? "success" : "failure"}`}>
          {result.success ? <CheckCircle size={12} /> : <XCircle size={12} />}
        </span>
        <span className="schedule-history-time">{relativeTime(result.startedAt)}</span>
        {hasStepResults && <StepResultIndicator stepResults={result.stepResults!} />}
        <span className="schedule-history-duration">{formatDurationMs(duration)}</span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {expanded && (
        <div className="schedule-history-detail">
          {hasStepResults && (
            <div className="schedule-step-results">
              {result.stepResults!.map((sr) => (
                <div key={sr.stepId} className={`schedule-step-result ${sr.success ? "success" : "failure"}`}>
                  <span className="schedule-step-result-status">
                    {sr.success ? <CheckCircle size={10} /> : <XCircle size={10} />}
                  </span>
                  <span className="schedule-step-result-name">{sr.stepName}</span>
                  {sr.error && <span className="schedule-step-result-error">{sr.error}</span>}
                </div>
              ))}
            </div>
          )}
          {result.output && (
            <pre className="schedule-history-output">{result.output}</pre>
          )}
          {result.error && (
            <div className="schedule-history-error">{result.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function ScheduleCard({ schedule, onEdit, onDelete, onRun, onToggle, running }: ScheduleCardProps) {
  const { t } = useTranslation("app");
  const [showHistory, setShowHistory] = useState(false);
  const { confirm } = useConfirm();

  const handleDelete = useCallback(async () => {
    const shouldDelete = await confirm({
      title: t("schedule.deleteTitle", "Delete Schedule"),
      message: t("schedule.deleteMessage", "Delete schedule \"{{name}}\"? This cannot be undone.", { name: schedule.name }),
      danger: true,
    });
    if (shouldDelete) {
      onDelete(schedule);
    }
  }, [schedule, onDelete, confirm, t]);

  const typeColor = SCHEDULE_TYPE_COLORS[schedule.scheduleType] ?? SCHEDULE_TYPE_COLORS.custom;

  return (
    <div className={`schedule-card${schedule.enabled ? "" : " disabled"}`}>
      <div className="schedule-card-header">
        <div className="schedule-card-info">
          <div className="schedule-card-name-row">
            <span className="schedule-card-name">{schedule.name}</span>
            <span
              className="schedule-type-badge"
              style={{ borderColor: typeColor, color: typeColor }}
            >
              {schedule.scheduleType}
            </span>
            {schedule.scope && (
              <span
                className={`schedule-scope-badge${schedule.scope === "global" ? " global" : " project"}`}
                title={`${schedule.scope === "global" ? "Global" : "Project"}-scoped schedule`}
              >
                {schedule.scope === "global" ? <Globe size={10} /> : <Folder size={10} />}
                {schedule.scope}
              </span>
            )}
          </div>
          {schedule.description && (
            <p className="schedule-card-description">{schedule.description}</p>
          )}
        </div>
        <div className="schedule-card-actions">
          <button
            className="btn-icon"
            onClick={() => onRun(schedule)}
            disabled={running}
            title={running ? t("schedule.running", "Running…") : t("schedule.runNow", "Run now")}
            aria-label={running ? t("schedule.running", "Running…") : t("schedule.runNameNow", "Run {{name}} now", { name: schedule.name })}
          >
            <Play />
          </button>
          <button
            className="btn-icon"
            onClick={() => onToggle(schedule)}
            title={schedule.enabled ? t("schedule.disable", "Disable") : t("schedule.enable", "Enable")}
            aria-label={schedule.enabled ? t("schedule.disableName", "Disable {{name}}", { name: schedule.name }) : t("schedule.enableName", "Enable {{name}}", { name: schedule.name })}
            aria-pressed={schedule.enabled}
          >
            {schedule.enabled ? <Pause /> : <Play />}
          </button>
          <button
            className="btn-icon"
            onClick={() => onEdit(schedule)}
            title={t("schedule.edit", "Edit")}
            aria-label={t("schedule.editName", "Edit {{name}}", { name: schedule.name })}
          >
            <Pencil />
          </button>
          <button
            className="btn-icon"
            onClick={handleDelete}
            title={t("schedule.delete", "Delete")}
            aria-label={t("schedule.deleteName", "Delete {{name}}", { name: schedule.name })}
          >
            <Trash2 />
          </button>
        </div>
      </div>

      <div className="schedule-card-meta">
        {schedule.steps && schedule.steps.length > 0 ? (
          <div className="schedule-meta-item">
            <Layers size={12} />
            <span className="schedule-steps-badge">{t("schedule.stepCount", "{{count}} step", { count: schedule.steps.length, defaultValue_one: "{{count}} step", defaultValue_other: "{{count}} steps" })}</span>
          </div>
        ) : (
          <div className="schedule-meta-item schedule-meta-command-preview" title={schedule.command}>
            <code className="schedule-command-preview">{schedule.command}</code>
          </div>
        )}
        <div className="schedule-meta-item">
          <Clock size={12} />
          <code className="schedule-cron">{schedule.cronExpression}</code>
        </div>
        {schedule.nextRunAt && schedule.enabled && (
          <div className="schedule-meta-item">
            <span className="schedule-meta-label">{t("schedule.nextLabel", "Next:")}</span>
            <span title={schedule.nextRunAt}>{relativeTime(schedule.nextRunAt)}</span>
          </div>
        )}
        {schedule.lastRunAt && (
          <div className="schedule-meta-item">
            <span className="schedule-meta-label">{t("schedule.lastLabel", "Last:")}</span>
            <span title={schedule.lastRunAt}>{relativeTime(schedule.lastRunAt)}</span>
          </div>
        )}
        {schedule.lastRunResult && (
          <RunResultBadge result={schedule.lastRunResult} />
        )}
        <div className="schedule-meta-item">
          <span className="schedule-meta-label">{t("schedule.runsLabel", "Runs:")}</span>
          <span>{schedule.runCount}</span>
        </div>
      </div>

      {schedule.runHistory.length > 0 && (
        <div className="schedule-card-history">
          <button
            className="schedule-history-toggle"
            onClick={() => setShowHistory((h) => !h)}
            aria-expanded={showHistory}
          >
            {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <span>{t("schedule.runHistory", "Run History ({{count}})", { count: schedule.runHistory.length })}</span>
          </button>
          {showHistory && (
            <div className="schedule-history-list">
              {schedule.runHistory.slice(0, 10).map((result, i) => (
                <RunHistoryItem key={`${result.startedAt}-${i}`} result={result} index={i} />
              ))}
              {schedule.runHistory.length > 10 && (
                <div className="schedule-history-more">
                  {t("schedule.andMore", "…and {{count}} more", { count: schedule.runHistory.length - 10 })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
