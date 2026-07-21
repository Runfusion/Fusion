import { useTranslation } from "react-i18next";
import type { Task, TaskTokenUsage, WorkflowStepResult } from "@fusion/core";
import { extractTimingEvents, getTotalAgentActiveMs, getEndToEndDurationMs, getTimedDurationMs, getWallClockSinceFirstExecutionMs, getWorkflowRuntimeMs, type TimingEvent } from "../utils/taskTiming";
import { getCanonicalStepNumber } from "../lib/step-display";
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
    | "cumulativePlanningMs"
    | "planningStartedAt"
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
  const { t } = useTranslation("app");
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
  const activeRuntimeMs = task ? getTotalAgentActiveMs(task, nowMs) : null;
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
  // FNXC:TaskStepNumbering 2026-07-05-00:00: use the canonical (0-based, PROMPT-numbered) step
  // number so this indicator agrees with the Activity tab for the same underlying step (FN-7612).
  const { stepNumber: canonicalStepNumber, totalSteps: taskStepCount } = getCanonicalStepNumber(task);

  return (
    <section className="task-token-stats-panel" aria-label={t("taskDetail.executionStatsAria", "Task execution statistics")}>
      <h4>{t("taskDetail.executionAndTokenStats", "Execution & Token Stats")}</h4>

      <div className="task-token-stats-panel__section">
        <h5>{t("taskDetail.executionTiming", "Execution Timing")}</h5>
        <div className="task-token-stats-panel__grid" role="list" aria-label={t("taskDetail.executionTimingMetricsAria", "Execution timing metrics")}>
          <div className="task-token-stats-panel__metric" role="listitem">
            <span className="task-token-stats-panel__label">{t("taskDetail.timingEvents", "Timing events")}</span>
            <span className="task-token-stats-panel__value">{timingEvents.length.toLocaleString()}</span>
          </div>
          <div className="task-token-stats-panel__metric" role="listitem">
            <span className="task-token-stats-panel__label">{t("taskDetail.timedDuration", "Timed duration")}</span>
            <span className="task-token-stats-panel__value">{formatDuration(totalTimingDurationMs)}</span>
          </div>
          <div className="task-token-stats-panel__metric" role="listitem">
            <span className="task-token-stats-panel__label">{t("taskDetail.workflowTimedSteps", "Workflow timed steps")}</span>
            <span className="task-token-stats-panel__value">{workflowTiming.timedStepCount.toLocaleString()}</span>
          </div>
          <div className="task-token-stats-panel__metric" role="listitem">
            <span className="task-token-stats-panel__label">{t("taskDetail.workflowRuntime", "Workflow runtime")}</span>
            <span className="task-token-stats-panel__value">{formatDuration(workflowTiming.totalDurationMs)}</span>
          </div>
          <div className="task-token-stats-panel__metric" role="listitem">
            <span className="task-token-stats-panel__label">{t("taskDetail.totalExecutionTime", "Total execution time")}</span>
            <span className="task-token-stats-panel__value">{formatDuration(totalExecutionMs)}</span>
          </div>
          {showWallClockSinceFirstExecution ? (
            <div className="task-token-stats-panel__metric" role="listitem">
              <span className="task-token-stats-panel__label">{t("taskDetail.wallClockSinceFirst", "Wall-clock since first execution")}</span>
              <span className="task-token-stats-panel__value">{formatDuration(wallClockSinceFirstExecutionMs)}</span>
            </div>
          ) : null}
        </div>

        <dl className="task-token-stats-panel__timestamps">
          <div className="task-token-stats-panel__timestamp-row">
            <dt>{t("taskDetail.longestTimingEvent", "Longest timing event")}</dt>
            <dd>
              {longestTimingEvent?.durationMs
                ? `${longestTimingEvent.summary} (${formatDuration(longestTimingEvent.durationMs)})`
                : t("taskDetail.noTimedEvents", "No timed events recorded yet.")}
            </dd>
          </div>
          <div className="task-token-stats-panel__timestamp-row">
            <dt>{t("taskDetail.longestWorkflowStep", "Longest workflow step")}</dt>
            <dd>
              {workflowTiming.longestStep
                ? `${workflowTiming.longestStep.name} (${formatDuration(workflowTiming.longestStep.durationMs)})`
                : t("taskDetail.noWorkflowStepTimings", "No completed workflow step timings yet.")}
            </dd>
          </div>
        </dl>
      </div>

      <div className="task-token-stats-panel__section">
        <h5>{t("taskDetail.executionDetails", "Execution Details")}</h5>
        <dl className="task-token-stats-panel__details">
          <div className="task-token-stats-panel__detail-row">
            {/*
            FNXC:TaskStats 2026-07-01-00:00:
            Use the leaf `taskDetail.executionModeLabel`, not `taskDetail.executionMode`, which is a nested object (ariaLabel/fast/standard/replan* copy for the inline mode toggle). Calling `t()` on the object key makes i18next return "key 'taskDetail.executionMode (en)' returned an object instead of string" and crashes the Stats tab render (issue #1863).
            */}
            <dt>{t("taskDetail.executionModeLabel", "Execution mode")}</dt>
            <dd>{task?.executionMode === "fast" ? t("taskDetail.executionModeFast", "Fast") : t("taskDetail.executionModeStandard", "Standard")}</dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>{t("taskDetail.runtimeStatus", "Runtime status")}</dt>
            <dd>{task?.status ?? t("taskDetail.notSet", "Not set")}</dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>{t("taskDetail.paused", "Paused")}</dt>
            <dd>{task?.paused ? t("taskDetail.yes", "Yes") : t("taskDetail.no", "No")}</dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>{t("taskDetail.stepProgress", "Step progress")}</dt>
            <dd>{taskStepCount > 0 ? `${canonicalStepNumber} / ${taskStepCount}` : t("taskDetail.noSteps", "No steps")}</dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>{t("taskDetail.retriesLabel", "Retries (recovery / workflow / merge / task_done)")}</dt>
            <dd>{`${task?.recoveryRetryCount ?? 0} / ${task?.workflowStepRetries ?? 0} / ${task?.mergeRetries ?? 0} / ${task?.taskDoneRetryCount ?? 0}`}</dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>{t("taskDetail.recoveryState", "Recovery state")}</dt>
            <dd>
              {task?.nextRecoveryAt
                ? t("taskDetail.nextRecoveryAt", "Next recovery at {{time}}", { time: formatTimestamp(task.nextRecoveryAt) })
                : t("taskDetail.noScheduledRecovery", "No scheduled recovery")}
            </dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>{t("taskDetail.selfHealCounters", "Self-heal counters")}</dt>
            <dd>{t("taskDetail.selfHealValues", "stuck kills: {{stuckKills}}, post-review fixes: {{postReviewFixes}}", { stuckKills: task?.stuckKillCount ?? 0, postReviewFixes: task?.postReviewFixCount ?? 0 })}</dd>
          </div>
          <div className="task-token-stats-panel__detail-row">
            <dt>{t("taskDetail.runtimeLinks", "Runtime links")}</dt>
            <dd>
              {[
                task?.assignedAgentId ? t("taskDetail.agentLink", "agent {{id}}", { id: task.assignedAgentId }) : null,
                task?.checkedOutBy ? t("taskDetail.checkoutLink", "checkout {{id}}", { id: task.checkedOutBy }) : null,
                task?.blockedBy ? t("taskDetail.blockedByLink", "blocked by {{id}}", { id: task.blockedBy }) : null,
                task?.sessionFile ? t("taskDetail.hasSession", "has session") : null,
              ].filter(Boolean).join(", ") || t("taskDetail.noRuntimeLinks", "No runtime links")}
            </dd>
          </div>
        </dl>
      </div>

      <div className="task-token-stats-panel__section">
        <h5>{t("taskDetail.tokenUsage", "Token Usage")}</h5>
        {!tokenUsage && loading ? (
          <div className="task-token-stats-panel__loading" role="status" aria-live="polite">
            {t("taskDetail.loadingTokenStats", "Loading token statistics…")}
          </div>
        ) : !tokenUsage ? (
          <div className="task-token-stats-panel__empty" role="status">
            {t("taskDetail.noTokenUsage", "No token usage recorded for this task yet.")}
          </div>
        ) : (
          <>
            <div className="task-token-stats-panel__grid" role="list" aria-label={t("taskDetail.tokenTotalsAria", "Task token totals")}>
              <div className="task-token-stats-panel__metric" role="listitem">
                <span className="task-token-stats-panel__label">{t("taskDetail.inputTokens", "Input")}</span>
                <span className="task-token-stats-panel__value">{formatTokenCount(tokenUsage.inputTokens)}</span>
              </div>
              <div className="task-token-stats-panel__metric" role="listitem">
                <span className="task-token-stats-panel__label">{t("taskDetail.outputTokens", "Output")}</span>
                <span className="task-token-stats-panel__value">{formatTokenCount(tokenUsage.outputTokens)}</span>
              </div>
              <div className="task-token-stats-panel__metric" role="listitem">
                <span className="task-token-stats-panel__label">{t("taskDetail.cacheRead", "Cache read")}</span>
                <span className="task-token-stats-panel__value">{formatTokenCount(tokenUsage.cachedTokens)}</span>
              </div>
              <div className="task-token-stats-panel__metric" role="listitem">
                <span className="task-token-stats-panel__label">{t("taskDetail.cacheWrite", "Cache write")}</span>
                <span className="task-token-stats-panel__value">{formatTokenCount(tokenUsage.cacheWriteTokens ?? 0)}</span>
              </div>
              <div className="task-token-stats-panel__metric" role="listitem">
                <span className="task-token-stats-panel__label">{t("taskDetail.totalTokens", "Total")}</span>
                <span className="task-token-stats-panel__value">{formatTokenCount(tokenUsage.totalTokens)}</span>
              </div>
            </div>
            <div className="task-token-stats-panel__cache-ratio">
              <span className="task-token-stats-panel__cache-ratio-label">{t("taskDetail.cacheHitRatio", "Cache hit ratio:")}</span>{" "}
              <span className="task-token-stats-panel__cache-ratio-value">
                {(tokenUsage.inputTokens + tokenUsage.cachedTokens) > 0
                  ? formatHitRatio(tokenUsage.cachedTokens / (tokenUsage.inputTokens + tokenUsage.cachedTokens))
                  : "—"}
              </span>
            </div>
            <div className="task-token-stats-panel__cache-breakdown">
              {t("taskDetail.cacheBreakdown", "(read {{read}} / write {{write}} / input {{input}})", { read: formatTokenCount(tokenUsage.cachedTokens), write: formatTokenCount(tokenUsage.cacheWriteTokens ?? 0), input: formatTokenCount(tokenUsage.inputTokens) })}
            </div>
            <dl className="task-token-stats-panel__timestamps">
              <div className="task-token-stats-panel__timestamp-row">
                <dt>{t("taskDetail.firstUsed", "First used")}</dt>
                <dd>
                  <time dateTime={tokenUsage.firstUsedAt}>{formatTimestamp(tokenUsage.firstUsedAt)}</time>
                </dd>
              </div>
              <div className="task-token-stats-panel__timestamp-row">
                <dt>{t("taskDetail.lastUsed", "Last used")}</dt>
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
