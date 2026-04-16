import { useState, useCallback } from "react";
import { Play, Pause, Pencil, Trash2, Clock, CheckCircle, XCircle, ChevronDown, ChevronUp, Calendar, Webhook, Code, Zap, Globe, Folder } from "lucide-react";
import type { Routine, RoutineExecutionResult, RoutineTriggerType, RoutineCatchUpPolicy, RoutineExecutionPolicy } from "@fusion/core";

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

const TRIGGER_TYPE_COLORS: Record<RoutineTriggerType, string> = {
  cron: "var(--color-blue, #3b82f6)",
  webhook: "var(--color-purple, #a855f7)",
  api: "var(--color-green, #22c55e)",
  manual: "var(--color-gray, #6b7280)",
};

const TRIGGER_TYPE_LABELS: Record<RoutineTriggerType, string> = {
  cron: "Cron",
  webhook: "Webhook",
  api: "API",
  manual: "Manual",
};

const TRIGGER_TYPE_ICONS: Record<RoutineTriggerType, React.ComponentType<{ size: number }>> = {
  cron: Calendar,
  webhook: Webhook,
  api: Code,
  manual: Zap,
};

const EXECUTION_POLICY_LABELS: Record<RoutineExecutionPolicy, string> = {
  parallel: "Concurrent",
  queue: "Queued",
  reject: "Exclusive",
};

const CATCH_UP_POLICY_LABELS: Record<RoutineCatchUpPolicy, string> = {
  run: "Catch up",
  skip: "Skip missed",
  run_one: "Catch up (latest)",
};

interface RoutineCardProps {
  routine: Routine;
  onEdit: (routine: Routine) => void;
  onDelete: (routine: Routine) => void;
  onRun: (routine: Routine) => void;
  onToggle: (routine: Routine) => void;
  /** Whether a manual run is currently in progress. */
  running?: boolean;
}

function RunResultBadge({ result }: { result: RoutineExecutionResult }) {
  const duration = result.completedAt && result.startedAt
    ? new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime()
    : 0;
  return (
    <span className={`schedule-run-badge ${result.success ? "success" : "failure"}`}>
      {result.success ? (
        <CheckCircle size={12} />
      ) : (
        <XCircle size={12} />
      )}
      <span>{result.success ? "Success" : "Failed"}</span>
      {duration > 0 && (
        <span className="schedule-run-duration">{formatDurationMs(duration)}</span>
      )}
    </span>
  );
}

function RunHistoryItem({ result, index }: { result: RoutineExecutionResult; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const duration = result.completedAt && result.startedAt
    ? new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime()
    : 0;

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
        {result.triggerType && (
          <span className="routine-history-trigger-type">{TRIGGER_TYPE_LABELS[result.triggerType]}</span>
        )}
        <span className="schedule-history-duration">{formatDurationMs(duration)}</span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {expanded && (
        <div className="schedule-history-detail">
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

export function RoutineCard({ routine, onEdit, onDelete, onRun, onToggle, running }: RoutineCardProps) {
  const [showHistory, setShowHistory] = useState(false);

  const handleDelete = useCallback(() => {
    if (window.confirm(`Delete routine "${routine.name}"? This cannot be undone.`)) {
      onDelete(routine);
    }
  }, [routine, onDelete]);

  const triggerColor = TRIGGER_TYPE_COLORS[routine.trigger.type];
  const TriggerIcon = TRIGGER_TYPE_ICONS[routine.trigger.type];

  // Get cron expression if available (from trigger or direct field)
  const cronExpression = routine.trigger.type === "cron"
    ? (routine.trigger as any).cronExpression || routine.cronExpression || ""
    : routine.cronExpression || "";

  return (
    <div className={`routine-card${routine.enabled ? "" : " disabled"}`}>
      <div className="routine-card-header">
        <div className="routine-card-info">
          <div className="routine-card-name-row">
            <span className="routine-card-name">{routine.name}</span>
            <span
              className="routine-trigger-badge"
              style={{ borderColor: triggerColor, color: triggerColor }}
            >
              <TriggerIcon size={10} />
              {TRIGGER_TYPE_LABELS[routine.trigger.type]}
            </span>
            {routine.scope && (
              <span
                className={`routine-scope-badge${routine.scope === "global" ? " global" : " project"}`}
                title={`${routine.scope === "global" ? "Global" : "Project"}-scoped routine`}
              >
                {routine.scope === "global" ? <Globe size={10} /> : <Folder size={10} />}
                {routine.scope}
              </span>
            )}
          </div>
          {routine.description && (
            <p className="routine-card-description">{routine.description}</p>
          )}
        </div>
        <div className="routine-card-actions">
          <button
            className="btn-icon"
            onClick={() => onRun(routine)}
            disabled={running}
            title={running ? "Running…" : "Run now"}
            aria-label={running ? "Running…" : `Run ${routine.name} now`}
          >
            <Play size={14} />
          </button>
          <button
            className="btn-icon"
            onClick={() => onToggle(routine)}
            title={routine.enabled ? "Disable" : "Enable"}
            aria-label={routine.enabled ? `Disable ${routine.name}` : `Enable ${routine.name}`}
            aria-pressed={routine.enabled}
          >
            {routine.enabled ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            className="btn-icon"
            onClick={() => onEdit(routine)}
            title="Edit"
            aria-label={`Edit ${routine.name}`}
          >
            <Pencil size={14} />
          </button>
          <button
            className="btn-icon"
            onClick={handleDelete}
            title="Delete"
            aria-label={`Delete ${routine.name}`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="routine-card-meta">
        {/* Cron expression for cron triggers */}
        {routine.trigger.type === "cron" && cronExpression && (
          <div className="routine-meta-item">
            <Clock size={12} />
            <code className="routine-cron">{cronExpression}</code>
          </div>
        )}

        {/* Policy badges */}
        <div className="routine-meta-item">
          <span className="routine-policy-badge" title={`Execution policy: ${routine.executionPolicy}`}>
            {EXECUTION_POLICY_LABELS[routine.executionPolicy]}
          </span>
        </div>
        <div className="routine-meta-item">
          <span className="routine-policy-badge" title={`Catch-up policy: ${routine.catchUpPolicy}`}>
            {CATCH_UP_POLICY_LABELS[routine.catchUpPolicy]}
          </span>
        </div>

        {/* Timing info */}
        {routine.nextRunAt && routine.enabled && (
          <div className="routine-meta-item">
            <span className="routine-meta-label">Next:</span>
            <span title={routine.nextRunAt}>{relativeTime(routine.nextRunAt)}</span>
          </div>
        )}
        {routine.lastRunAt && (
          <div className="routine-meta-item">
            <span className="routine-meta-label">Last:</span>
            <span title={routine.lastRunAt}>{relativeTime(routine.lastRunAt)}</span>
          </div>
        )}
        {routine.lastRunResult && (
          <RunResultBadge result={routine.lastRunResult} />
        )}
        <div className="routine-meta-item">
          <span className="routine-meta-label">Runs:</span>
          <span>{routine.runCount}</span>
        </div>
      </div>

      {routine.runHistory.length > 0 && (
        <div className="routine-card-history">
          <button
            className="schedule-history-toggle"
            onClick={() => setShowHistory((h) => !h)}
            aria-expanded={showHistory}
          >
            {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <span>Run History ({routine.runHistory.length})</span>
          </button>
          {showHistory && (
            <div className="schedule-history-list">
              {routine.runHistory.slice(0, 10).map((result, i) => (
                <RunHistoryItem key={`${result.startedAt}-${i}`} result={result} index={i} />
              ))}
              {routine.runHistory.length > 10 && (
                <div className="schedule-history-more">
                  …and {routine.runHistory.length - 10} more
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
