import type { Task, TaskTokenUsage, WorkflowStepResult } from "@fusion/core";
import { extractTimingEvents, getActiveRuntimeMs, getEndToEndDurationMs, getTimedDurationMs, getWallClockSinceFirstExecutionMs, getWorkflowRuntimeMs, type TimingEvent } from "../utils/taskTiming";
import "./TaskTokenStatsPanel.css";

interface TaskTokenStatsPanelProps {
  tokenUsage?: TaskTokenUsage;
  loading: boolean;
  task?: Pick<
    Task,
    | "log"
    | "timedExecutionMs"
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
    | "executionStartedAt"
    | "executionCompletedAt"
    | "firstExecutionAt"
    | "cumulativeActiveMs"
    | "column"
    | "columnMovedAt"
  >;
}

interface WorkflowTimingSummary {
  timedStepCount: number;
  totalDurationMs: number;
  longestStep?: { name: string; durationMs: number };
}

function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

function formatHitRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
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

function summarizeWorkflowTiming(results: WorkflowStepResult[]): WorkflowTimingSummary {
  const nowMs = Date.now();
  const timedResults = results
    .map((step) => {
      if (!step.startedAt) {
        return null;
      }
      const startedMs = new Date(step.startedAt).getTime();
      if (Number.isNaN(startedMs)) {
        return null;
      }
      let endMs: number;
      if (step.completedAt) {
        const completedMs = new Date(step.completedAt).getTime();
        if (Number.isNaN(completedMs) || completedMs < startedMs) {
          return null;
        }
        endMs = completedMs;
      } else {
        endMs = Math.max(startedMs, nowMs);
      }
      return {
        name: step.workflowStepName || step.workflowStepId,
        durationMs: endMs - startedMs,
      };
    })
    .filter((value): value is { name: string; durationMs: number } => value !== null);

  const totalDurationMs = getWorkflowRuntimeMs(results, nowMs) ?? 0;
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
  const nowMs = Date.now();
  const timingEvents = extractTimingEvents(task?.log ?? []);
  const timedTimingEvents = timingEvents.filter((event) => typeof event.durationMs === "number");
  const logTimingDurationMs = timedTimingEvents.reduce((sum, event) => sum + (event.durationMs ?? 0), 0);
  const parsedTimingDurationMs = getTimedDurationMs(task?.log) ?? 0;
  const totalTimingDurationMs = typeof task?.timedExecutionMs === "number"
    ? task.timedExecutionMs
    : Math.max(logTimingDurationMs, parsedTimingDurationMs);
  const longestTimingEvent = timedTimingEvents.reduce<TimingEvent | undefined>((longest, event) => {
    if (!longest || (event.durationMs ?? 0) > (longest.durationMs ?? 0)) {
      return event;
    }
    return longest;
  }, undefined);

  const workflowTiming = summarizeWorkflowTiming(task?.workflowStepResults ?? []);
  const activeRuntimeMs = task ? getActiveRuntimeMs(task, nowMs) : null;
  const endToEndDurationMs = getEndToEndDurationMs(task?.executionStartedAt, task?.executionCompletedAt, nowMs);
  const wallClockSinceFirstExecutionMs = getWallClockSinceFirstExecutionMs(
    task?.firstExecutionAt,
    task?.executionCompletedAt,
    nowMs,
  );
  // Canonical fallback order for Task Detail Stats total runtime:
  // 1) durable wall-clock execution window (`executionStartedAt` → `executionCompletedAt`),
  // 2) server aggregate `timedExecutionMs` when present,
  // 3) legacy local aggregate (`[timing]` sum + workflow runtime).
  // This avoids double counting when workflow timings appear in both `[timing]`
  // logs and `workflowStepResults`.
  const totalExecutionMs = activeRuntimeMs
    ?? (endToEndDurationMs
      ?? (typeof task?.timedExecutionMs === "number"
        ? task.timedExecutionMs
        : totalTimingDurationMs + workflowTiming.totalDurationMs));
  const showWallClockSinceFirstExecution =
    wallClockSinceFirstExecutionMs != null
    && wallClockSinceFirstExecutionMs !== totalExecutionMs;
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
          <div className="task-token-stats-panel__metric" role="listitem">
            <span className="task-token-stats-panel__label">Total execution time</span>
            <span className="task-token-stats-panel__value">{formatDuration(totalExecutionMs)}</span>
          </div>
          {showWallClockSinceFirstExecution ? (
            <div className="task-token-stats-panel__metric" role="listitem">
              <span className="task-token-stats-panel__label">Wall-clock since first execution</span>
              <span className="task-token-stats-panel__value">{formatDuration(wallClockSinceFirstExecutionMs)}</span>
            </div>
          ) : null}
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
                <span className="task-token-stats-panel__label">Cache read</span>
                <span className="task-token-stats-panel__value">{formatTokenCount(tokenUsage.cachedTokens)}</span>
              </div>
              <div className="task-token-stats-panel__metric" role="listitem">
                <span className="task-token-stats-panel__label">Cache write</span>
                <span className="task-token-stats-panel__value">{formatTokenCount(tokenUsage.cacheWriteTokens ?? 0)}</span>
              </div>
              <div className="task-token-stats-panel__metric" role="listitem">
                <span className="task-token-stats-panel__label">Total</span>
                <span className="task-token-stats-panel__value">{formatTokenCount(tokenUsage.totalTokens)}</span>
              </div>
            </div>
            <div className="task-token-stats-panel__cache-ratio">
              <span className="task-token-stats-panel__cache-ratio-label">Cache hit ratio:</span>{" "}
              <span className="task-token-stats-panel__cache-ratio-value">
                {(tokenUsage.inputTokens + tokenUsage.cachedTokens) > 0
                  ? formatHitRatio(tokenUsage.cachedTokens / (tokenUsage.inputTokens + tokenUsage.cachedTokens))
                  : "—"}
              </span>
            </div>
            <div className="task-token-stats-panel__cache-breakdown">
              (read {formatTokenCount(tokenUsage.cachedTokens)} / write {formatTokenCount(tokenUsage.cacheWriteTokens ?? 0)} / input {formatTokenCount(tokenUsage.inputTokens)})
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
