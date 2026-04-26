import type { Task, TaskLogEntry, TaskTokenUsage, WorkflowStepResult } from "@fusion/core";
import "./TaskTokenStatsPanel.css";

interface TaskTokenStatsPanelProps {
  tokenUsage?: TaskTokenUsage;
  loading: boolean;
  task?: Pick<
    Task,
    | "log"
    | "workflowStepResults"
    | "executionMode"
    | "status"
    | "paused"
    | "currentStep"
    | "steps"
    | "mergeRetries"
    | "workflowStepRetries"
    | "stuckKillCount"
    | "postReviewFixCount"
    | "recoveryRetryCount"
    | "taskDoneRetryCount"
    | "nextRecoveryAt"
    | "checkedOutBy"
    | "assignedAgentId"
    | "blockedBy"
    | "sessionFile"
  >;
}

interface TimingEvent {
  timestamp: string;
  durationMs?: number;
  summary: string;
}

interface WorkflowTimingSummary {
  timedStepCount: number;
  totalDurationMs: number;
  longestStep?: { name: string; durationMs: number };
}

function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function formatDuration(valueMs: number): string {
  if (valueMs < 1000) {
    return `${Math.round(valueMs)} ms`;
  }
  const valueSeconds = valueMs / 1000;
  if (valueSeconds < 60) {
    return `${valueSeconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(valueSeconds / 60);
  const seconds = Math.round(valueSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

function summarizeTimingLabel(entry: TaskLogEntry): string {
  const timingText = entry.action || entry.outcome || "";
  const stripped = timingText
    .replace(/^\[timing\]\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/i, "")
    .replace(/\s+in\s+\d+(?:\.\d+)?ms\b/i, "")
    .replace(/\s+after\s+\d+(?:\.\d+)?ms\b/i, "")
    .trim();
  return stripped || "Timing event";
}

function extractTimingEvents(logEntries: TaskLogEntry[]): TimingEvent[] {
  return logEntries
    .filter((entry) => {
      const actionText = typeof entry.action === "string" ? entry.action : "";
      const outcomeText = typeof entry.outcome === "string" ? entry.outcome : "";
      return actionText.includes("[timing]") || outcomeText.includes("[timing]");
    })
    .map((entry) => {
      const haystack = `${entry.action ?? ""}\n${entry.outcome ?? ""}`;
      const durationMatch = haystack.match(/(\d+(?:\.\d+)?)ms\b/i);
      const durationMs = durationMatch ? Number(durationMatch[1]) : undefined;
      return {
        timestamp: entry.timestamp,
        durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
        summary: summarizeTimingLabel(entry),
      };
    });
}

function summarizeWorkflowTiming(results: WorkflowStepResult[]): WorkflowTimingSummary {
  const timedResults = results
    .map((step) => {
      if (!step.startedAt || !step.completedAt) {
        return null;
      }
      const startedMs = new Date(step.startedAt).getTime();
      const completedMs = new Date(step.completedAt).getTime();
      if (Number.isNaN(startedMs) || Number.isNaN(completedMs) || completedMs < startedMs) {
        return null;
      }
      return {
        name: step.workflowStepName || step.workflowStepId,
        durationMs: completedMs - startedMs,
      };
    })
    .filter((value): value is { name: string; durationMs: number } => value !== null);

  const totalDurationMs = timedResults.reduce((sum, step) => sum + step.durationMs, 0);
  const longestStep = timedResults.reduce<{ name: string; durationMs: number } | undefined>((longest, step) => {
    if (!longest || step.durationMs > longest.durationMs) {
      return step;
    }
    return longest;
  }, undefined);

  return {
    timedStepCount: timedResults.length,
    totalDurationMs,
    longestStep,
  };
}

export function TaskTokenStatsPanel({ tokenUsage, loading, task }: TaskTokenStatsPanelProps) {
  const timingEvents = extractTimingEvents(task?.log ?? []);
  const timedTimingEvents = timingEvents.filter((event) => typeof event.durationMs === "number");
  const totalTimingDurationMs = timedTimingEvents.reduce((sum, event) => sum + (event.durationMs ?? 0), 0);
  const longestTimingEvent = timedTimingEvents.reduce<TimingEvent | undefined>((longest, event) => {
    if (!longest || (event.durationMs ?? 0) > (longest.durationMs ?? 0)) {
      return event;
    }
    return longest;
  }, undefined);

  const workflowTiming = summarizeWorkflowTiming(task?.workflowStepResults ?? []);
  const taskStepCount = task?.steps?.length ?? 0;

  return (
    <section className="task-token-stats-panel" aria-label="Task execution statistics">
      <h4>Execution &amp; Token Stats</h4>

      <div className="task-token-stats-panel__section">
        <h5>Execution Timing</h5>
        <div className="task-token-stats-panel__grid" role="list" aria-label="Execution timing metrics">
          <div className="task-token-stats-panel__metric" role="listitem">
            <span className="task-token-stats-panel__label">Timing events</span>
            <span className="task-token-stats-panel__value">{timingEvents.length.toLocaleString()}</span>
          </div>
          <div className="task-token-stats-panel__metric" role="listitem">
            <span className="task-token-stats-panel__label">Timed duration</span>
            <span className="task-token-stats-panel__value">{formatDuration(totalTimingDurationMs)}</span>
          </div>
          <div className="task-token-stats-panel__metric" role="listitem">
            <span className="task-token-stats-panel__label">Workflow timed steps</span>
            <span className="task-token-stats-panel__value">{workflowTiming.timedStepCount.toLocaleString()}</span>
          </div>
          <div className="task-token-stats-panel__metric" role="listitem">
            <span className="task-token-stats-panel__label">Workflow runtime</span>
            <span className="task-token-stats-panel__value">{formatDuration(workflowTiming.totalDurationMs)}</span>
          </div>
        </div>

        <dl className="task-token-stats-panel__timestamps">
          <div className="task-token-stats-panel__timestamp-row">
            <dt>Longest timing event</dt>
            <dd>
              {longestTimingEvent?.durationMs
                ? `${longestTimingEvent.summary} (${formatDuration(longestTimingEvent.durationMs)})`
                : "No timed events recorded yet."}
            </dd>
          </div>
          <div className="task-token-stats-panel__timestamp-row">
            <dt>Longest workflow step</dt>
            <dd>
              {workflowTiming.longestStep
                ? `${workflowTiming.longestStep.name} (${formatDuration(workflowTiming.longestStep.durationMs)})`
                : "No completed workflow step timings yet."}
            </dd>
          </div>
        </dl>
      </div>

      <div className="task-token-stats-panel__section">
        <h5>Execution Details</h5>
        <dl className="task-token-stats-panel__details">
          <div className="task-token-stats-panel__detail-row">
            <dt>Execution mode</dt>
            <dd>{task?.executionMode === "fast" ? "Fast" : "Standard"}</dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>Runtime status</dt>
            <dd>{task?.status ?? "Not set"}</dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>Paused</dt>
            <dd>{task?.paused ? "Yes" : "No"}</dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>Step progress</dt>
            <dd>{taskStepCount > 0 ? `${Math.min((task?.currentStep ?? 0) + 1, taskStepCount)} / ${taskStepCount}` : "No steps"}</dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>Retries (recovery / workflow / merge / task_done)</dt>
            <dd>{`${task?.recoveryRetryCount ?? 0} / ${task?.workflowStepRetries ?? 0} / ${task?.mergeRetries ?? 0} / ${task?.taskDoneRetryCount ?? 0}`}</dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>Recovery state</dt>
            <dd>
              {task?.nextRecoveryAt
                ? `Next recovery at ${formatTimestamp(task.nextRecoveryAt)}`
                : "No scheduled recovery"}
            </dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>Self-heal counters</dt>
            <dd>{`stuck kills: ${task?.stuckKillCount ?? 0}, post-review fixes: ${task?.postReviewFixCount ?? 0}`}</dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>Runtime links</dt>
            <dd>
              {[
                task?.assignedAgentId ? `agent ${task.assignedAgentId}` : null,
                task?.checkedOutBy ? `checkout ${task.checkedOutBy}` : null,
                task?.blockedBy ? `blocked by ${task.blockedBy}` : null,
                task?.sessionFile ? "has session" : null,
              ].filter(Boolean).join(", ") || "No runtime links"}
            </dd>
          </div>
        </dl>
      </div>

      <div className="task-token-stats-panel__section">
        <h5>Token Usage</h5>
        {!tokenUsage && loading ? (
          <div className="task-token-stats-panel__loading" role="status" aria-live="polite">
            Loading token statistics…
          </div>
        ) : !tokenUsage ? (
          <div className="task-token-stats-panel__empty" role="status">
            No token usage recorded for this task yet.
          </div>
        ) : (
          <>
            <div className="task-token-stats-panel__grid" role="list" aria-label="Task token totals">
              <div className="task-token-stats-panel__metric" role="listitem">
                <span className="task-token-stats-panel__label">Input</span>
                <span className="task-token-stats-panel__value">{formatTokenCount(tokenUsage.inputTokens)}</span>
              </div>
              <div className="task-token-stats-panel__metric" role="listitem">
                <span className="task-token-stats-panel__label">Output</span>
                <span className="task-token-stats-panel__value">{formatTokenCount(tokenUsage.outputTokens)}</span>
              </div>
              <div className="task-token-stats-panel__metric" role="listitem">
                <span className="task-token-stats-panel__label">Cached</span>
                <span className="task-token-stats-panel__value">{formatTokenCount(tokenUsage.cachedTokens)}</span>
              </div>
              <div className="task-token-stats-panel__metric" role="listitem">
                <span className="task-token-stats-panel__label">Total</span>
                <span className="task-token-stats-panel__value">{formatTokenCount(tokenUsage.totalTokens)}</span>
              </div>
            </div>
            <dl className="task-token-stats-panel__timestamps">
              <div className="task-token-stats-panel__timestamp-row">
                <dt>First used</dt>
                <dd>
                  <time dateTime={tokenUsage.firstUsedAt}>{formatTimestamp(tokenUsage.firstUsedAt)}</time>
                </dd>
              </div>
              <div className="task-token-stats-panel__timestamp-row">
                <dt>Last used</dt>
                <dd>
                  <time dateTime={tokenUsage.lastUsedAt}>{formatTimestamp(tokenUsage.lastUsedAt)}</time>
                </dd>
              </div>
            </dl>
          </>
        )}
      </div>
    </section>
  );
}
