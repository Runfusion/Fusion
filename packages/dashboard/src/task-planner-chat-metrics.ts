import type { ModelPricingOverrides, Task, TaskLogEntry, TaskTokenUsagePerModel, WorkflowStepResult } from "@fusion/core";
import { costFor } from "@fusion/core";

type MetricsTask = Pick<
  Task,
  | "id"
  | "title"
  | "column"
  | "status"
  | "tokenUsage"
  | "log"
  | "timedExecutionMs"
  | "workflowStepResults"
  | "executionStartedAt"
  | "executionCompletedAt"
  | "firstExecutionAt"
  | "cumulativeActiveMs"
  | "cumulativePlanningMs"
  | "planningStartedAt"
>;

type TokenBucketInput = Pick<
  TaskTokenUsagePerModel,
  "modelProvider" | "modelId" | "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens" | "totalTokens"
> & Partial<Pick<TaskTokenUsagePerModel, "firstUsedAt" | "lastUsedAt">>;

export interface TaskPlannerTokenCostMetrics {
  usd: number | null;
  costUnavailable: boolean;
  pricingStale: boolean;
}

export interface TaskPlannerTokenBucketMetrics extends TokenBucketInput {
  key: string;
  cost: TaskPlannerTokenCostMetrics;
}

export interface TaskPlannerTimingEventMetrics {
  timestamp?: string;
  summary: string;
  durationMs: number | null;
}

export interface TaskPlannerWorkflowStepTimingMetrics {
  workflowStepId: string;
  workflowStepName: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  durationMs: number | null;
  running: boolean;
}

export interface TaskPlannerChatMetricsPayload {
  taskId: string;
  title?: string;
  column?: string;
  status?: string;
  tokens: {
    available: boolean;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    firstUsedAt: string | null;
    lastUsedAt: string | null;
    malformedTimestamps: string[];
    perModel: TaskPlannerTokenBucketMetrics[];
    cost: TaskPlannerTokenCostMetrics;
  };
  timing: {
    executionStartedAt: string | null;
    executionCompletedAt: string | null;
    firstExecutionAt: string | null;
    endToEndExecutionMs: number | null;
    wallClockSinceFirstExecutionMs: number | null;
    activeRuntimeMs: number | null;
    cumulativeActiveMs: number | null;
    cumulativePlanningMs: number | null;
    timedExecutionMs: number | null;
    logTimingDurationMs: number | null;
    timingEventCount: number;
    timedTimingEventCount: number;
    workflowRuntimeMs: number | null;
    timedWorkflowStepCount: number;
    totalExecutionMs: number | null;
    longestTimingEvent: TaskPlannerTimingEventMetrics | null;
    longestWorkflowStep: TaskPlannerWorkflowStepTimingMetrics | null;
    timingEvents: TaskPlannerTimingEventMetrics[];
    workflowSteps: TaskPlannerWorkflowStepTimingMetrics[];
    malformedTimestamps: string[];
  };
}

export interface TaskPlannerChatMetricsResult {
  metrics: TaskPlannerChatMetricsPayload;
  summaryText: string;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function validTimestamp(value: unknown, malformed: string[]): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (!Number.isFinite(Date.parse(trimmed))) {
    malformed.push(trimmed);
    return null;
  }
  return trimmed;
}

function parseTimestampToMs(value: unknown, malformed: string[]): number | null {
  const timestamp = validTimestamp(value, malformed);
  if (!timestamp) return null;
  return Date.parse(timestamp);
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "not available";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
}

function formatUsd(usd: number | null): string {
  if (usd == null || !Number.isFinite(usd)) return "unavailable";
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

function summarizeTimingLabel(entry: TaskLogEntry): string {
  const actionText = typeof entry.action === "string" ? entry.action : "";
  const outcomeText = typeof entry.outcome === "string" ? entry.outcome : "";
  const timingText = actionText.includes("[timing]") ? actionText : outcomeText.includes("[timing]") ? outcomeText : `${actionText}\n${outcomeText}`;
  const stripped = timingText
    .replace(/^\[timing\]\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/i, "")
    .replace(/\s+in\s+\d+(?:\.\d+)?ms\b/i, "")
    .replace(/\s+after\s+\d+(?:\.\d+)?ms\b/i, "")
    .trim();
  return stripped || "Timing event";
}

function extractTimingEvents(logEntries: TaskLogEntry[] | undefined): TaskPlannerTimingEventMetrics[] {
  return (logEntries ?? [])
    .filter((entry) => {
      const actionText = typeof entry.action === "string" ? entry.action : "";
      const outcomeText = typeof entry.outcome === "string" ? entry.outcome : "";
      return actionText.includes("[timing]") || outcomeText.includes("[timing]");
    })
    .map((entry) => {
      const haystack = `${entry.action ?? ""}\n${entry.outcome ?? ""}`;
      const durationMatch = haystack.match(/(\d+(?:\.\d+)?)ms\b/i);
      const durationMs = durationMatch ? Number(durationMatch[1]) : NaN;
      return {
        timestamp: entry.timestamp,
        summary: summarizeTimingLabel(entry),
        durationMs: Number.isFinite(durationMs) ? durationMs : null,
      };
    });
}

function bucketKey(bucket: Pick<TokenBucketInput, "modelProvider" | "modelId">): string {
  return `${bucket.modelProvider ?? ""}:${bucket.modelId ?? ""}`;
}

function normalizeBucket(bucket: TokenBucketInput): TokenBucketInput {
  return {
    modelProvider: bucket.modelProvider?.trim() || undefined,
    modelId: bucket.modelId?.trim() || undefined,
    inputTokens: finiteNumber(bucket.inputTokens),
    outputTokens: finiteNumber(bucket.outputTokens),
    cachedTokens: finiteNumber(bucket.cachedTokens),
    cacheWriteTokens: finiteNumber(bucket.cacheWriteTokens),
    totalTokens: finiteNumber(bucket.totalTokens),
    firstUsedAt: bucket.firstUsedAt,
    lastUsedAt: bucket.lastUsedAt,
  };
}

function mergeBuckets(buckets: TokenBucketInput[]): TokenBucketInput[] {
  const merged = new Map<string, TokenBucketInput>();
  for (const rawBucket of buckets) {
    const bucket = normalizeBucket(rawBucket);
    const key = bucketKey(bucket);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...bucket });
      continue;
    }
    current.inputTokens += bucket.inputTokens;
    current.outputTokens += bucket.outputTokens;
    current.cachedTokens += bucket.cachedTokens;
    current.cacheWriteTokens += bucket.cacheWriteTokens;
    current.totalTokens += bucket.totalTokens;
    current.firstUsedAt = minTimestampString(current.firstUsedAt, bucket.firstUsedAt);
    current.lastUsedAt = maxTimestampString(current.lastUsedAt, bucket.lastUsedAt);
  }
  return Array.from(merged.values());
}

function minTimestampString(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  return rightMs < leftMs ? right : left;
}

function maxTimestampString(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  return rightMs > leftMs ? right : left;
}

function buildTokenMetrics(task: MetricsTask, pricingOverrides: ModelPricingOverrides | undefined, nowMs: number): TaskPlannerChatMetricsPayload["tokens"] {
  const tokenUsage = task.tokenUsage;
  const malformedTimestamps: string[] = [];
  if (!tokenUsage) {
    return {
      available: false,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      firstUsedAt: null,
      lastUsedAt: null,
      malformedTimestamps,
      perModel: [],
      cost: { usd: null, costUnavailable: false, pricingStale: false },
    };
  }

  const buckets = tokenUsage.perModel?.length
    ? mergeBuckets(tokenUsage.perModel)
    : mergeBuckets([{
        modelProvider: tokenUsage.modelProvider,
        modelId: tokenUsage.modelId,
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        cachedTokens: tokenUsage.cachedTokens,
        cacheWriteTokens: tokenUsage.cacheWriteTokens,
        totalTokens: tokenUsage.totalTokens,
        firstUsedAt: tokenUsage.firstUsedAt,
        lastUsedAt: tokenUsage.lastUsedAt,
      }]);

  let totalUsd = 0;
  let costUnavailable = false;
  let pricingStale = false;
  const perModel = buckets.map((bucket) => {
    const cost = costFor(
      {
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cachedTokens: bucket.cachedTokens,
        cacheWriteTokens: bucket.cacheWriteTokens,
      },
      { provider: bucket.modelProvider, model: bucket.modelId },
      nowMs,
      pricingOverrides,
    );
    if (bucket.totalTokens > 0 && (cost.unavailable || cost.usd === null || !Number.isFinite(cost.usd))) {
      costUnavailable = true;
    } else if (cost.usd != null && Number.isFinite(cost.usd)) {
      totalUsd += cost.usd;
    }
    pricingStale ||= cost.stale;
    return {
      ...bucket,
      key: bucketKey(bucket),
      cost: {
        usd: cost.usd,
        costUnavailable: cost.unavailable,
        pricingStale: cost.stale,
      },
    };
  });

  return {
    available: true,
    inputTokens: finiteNumber(tokenUsage.inputTokens),
    outputTokens: finiteNumber(tokenUsage.outputTokens),
    cachedTokens: finiteNumber(tokenUsage.cachedTokens),
    cacheWriteTokens: finiteNumber(tokenUsage.cacheWriteTokens),
    totalTokens: finiteNumber(tokenUsage.totalTokens),
    firstUsedAt: validTimestamp(tokenUsage.firstUsedAt, malformedTimestamps),
    lastUsedAt: validTimestamp(tokenUsage.lastUsedAt, malformedTimestamps),
    malformedTimestamps,
    perModel,
    cost: {
      usd: costUnavailable ? null : totalUsd,
      costUnavailable,
      pricingStale,
    },
  };
}

function buildWorkflowStepTimings(results: WorkflowStepResult[] | undefined, nowMs: number, malformed: string[]): TaskPlannerWorkflowStepTimingMetrics[] {
  return (results ?? []).map((step) => {
    const startedMs = parseTimestampToMs(step.startedAt, malformed);
    if (startedMs == null) {
      return {
        workflowStepId: step.workflowStepId,
        workflowStepName: step.workflowStepName || step.workflowStepId,
        status: step.status,
        startedAt: typeof step.startedAt === "string" ? step.startedAt : undefined,
        completedAt: typeof step.completedAt === "string" ? step.completedAt : undefined,
        durationMs: null,
        running: false,
      };
    }
    const completedMs = parseTimestampToMs(step.completedAt, malformed);
    const running = completedMs == null;
    const endMs = completedMs != null && completedMs >= startedMs ? completedMs : Math.max(startedMs, nowMs);
    return {
      workflowStepId: step.workflowStepId,
      workflowStepName: step.workflowStepName || step.workflowStepId,
      status: step.status,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      durationMs: endMs - startedMs,
      running,
    };
  });
}

function buildTimingMetrics(task: MetricsTask, nowMs: number): TaskPlannerChatMetricsPayload["timing"] {
  const malformedTimestamps: string[] = [];
  const executionStartedMs = parseTimestampToMs(task.executionStartedAt, malformedTimestamps);
  const executionCompletedMs = parseTimestampToMs(task.executionCompletedAt, malformedTimestamps);
  const firstExecutionMs = parseTimestampToMs(task.firstExecutionAt, malformedTimestamps);
  const executionStartedAt = executionStartedMs == null ? null : task.executionStartedAt ?? null;
  const executionCompletedAt = executionCompletedMs == null ? null : task.executionCompletedAt ?? null;
  const firstExecutionAt = firstExecutionMs == null ? null : task.firstExecutionAt ?? null;

  const endToEndExecutionMs = executionStartedMs == null
    ? null
    : Math.max(0, (executionCompletedMs != null && executionCompletedMs >= executionStartedMs ? executionCompletedMs : nowMs) - executionStartedMs);
  const wallClockSinceFirstExecutionMs = firstExecutionMs == null
    ? null
    : Math.max(0, (executionCompletedMs ?? nowMs) - firstExecutionMs);
  const cumulativeActiveMs = optionalFiniteNumber(task.cumulativeActiveMs);
  const activeRuntimeMs = task.column === "in-progress" && executionStartedMs != null
    ? (cumulativeActiveMs ?? 0) + Math.max(0, nowMs - executionStartedMs)
    : cumulativeActiveMs;

  const cumulativePlanningMs = optionalFiniteNumber(task.cumulativePlanningMs);
  const planningStartedMs = parseTimestampToMs(task.planningStartedAt, malformedTimestamps);
  const totalActiveMs = (activeRuntimeMs != null || cumulativePlanningMs != null || planningStartedMs != null)
    ? (activeRuntimeMs ?? 0) + (cumulativePlanningMs ?? 0) + (planningStartedMs != null ? Math.max(0, nowMs - planningStartedMs) : 0)
    : null;

  const timingEvents = extractTimingEvents(task.log);
  const timedEvents = timingEvents.filter((event) => event.durationMs != null);
  const logTimingDurationMs = timedEvents.length > 0
    ? timedEvents.reduce((sum, event) => sum + (event.durationMs ?? 0), 0)
    : null;
  const timedExecutionMs = optionalFiniteNumber(task.timedExecutionMs);
  const workflowSteps = buildWorkflowStepTimings(task.workflowStepResults, nowMs, malformedTimestamps);
  const timedWorkflowSteps = workflowSteps.filter((step) => step.durationMs != null);
  const workflowRuntimeMs = timedWorkflowSteps.length > 0
    ? timedWorkflowSteps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0)
    : null;
  const longestTimingEvent = timedEvents.reduce<TaskPlannerTimingEventMetrics | null>((longest, event) => {
    if (!longest || (event.durationMs ?? 0) > (longest.durationMs ?? 0)) return event;
    return longest;
  }, null);
  const longestWorkflowStep = timedWorkflowSteps.reduce<TaskPlannerWorkflowStepTimingMetrics | null>((longest, step) => {
    if (!longest || (step.durationMs ?? 0) > (longest.durationMs ?? 0)) return step;
    return longest;
  }, null);
  const totalExecutionMs = totalActiveMs
    ?? endToEndExecutionMs
    ?? timedExecutionMs
    ?? (logTimingDurationMs != null || workflowRuntimeMs != null ? (logTimingDurationMs ?? 0) + (workflowRuntimeMs ?? 0) : null);

  return {
    executionStartedAt,
    executionCompletedAt,
    firstExecutionAt,
    endToEndExecutionMs,
    wallClockSinceFirstExecutionMs,
    activeRuntimeMs,
    cumulativeActiveMs,
    cumulativePlanningMs,
    timedExecutionMs,
    logTimingDurationMs,
    timingEventCount: timingEvents.length,
    timedTimingEventCount: timedEvents.length,
    workflowRuntimeMs,
    timedWorkflowStepCount: timedWorkflowSteps.length,
    totalExecutionMs,
    longestTimingEvent,
    longestWorkflowStep,
    timingEvents,
    workflowSteps,
    malformedTimestamps,
  };
}

/**
 * FNXC:TaskPlannerChatMetrics 2026-07-01-20:48:
 * Task-detail planner Chat must answer token, cost, and timing questions from durable task fields instead of asking the model to infer numbers from prose. Keep this helper pure and read-only so the scoped chat tool can expose exact persisted metrics without mutating Activity, steering, documents, or task state.
 *
 * FNXC:TaskPlannerChatMetrics 2026-07-01-20:48:
 * Pricing estimates are derived at read time with costFor and optional settings overrides; never persist them here. Unknown or stale pricing stays explicit as unavailable/stale so planner Chat cannot understate cost by reporting missing model prices as $0.
 */
export function formatTaskPlannerChatMetrics(
  task: MetricsTask,
  options: { pricingOverrides?: ModelPricingOverrides; nowMs?: number } = {},
): TaskPlannerChatMetricsResult {
  const nowMs = options.nowMs ?? Date.now();
  const metrics: TaskPlannerChatMetricsPayload = {
    taskId: task.id,
    title: task.title,
    column: task.column,
    status: task.status,
    tokens: buildTokenMetrics(task, options.pricingOverrides, nowMs),
    timing: buildTimingMetrics(task, nowMs),
  };

  const tokenSummary = metrics.tokens.available
    ? `${metrics.tokens.totalTokens.toLocaleString()} total tokens (${metrics.tokens.inputTokens.toLocaleString()} input, ${metrics.tokens.outputTokens.toLocaleString()} output, ${metrics.tokens.cachedTokens.toLocaleString()} cache read, ${metrics.tokens.cacheWriteTokens.toLocaleString()} cache write)`
    : "no token usage recorded";
  const costSummary = metrics.tokens.cost.costUnavailable
    ? "cost unavailable because at least one model has no pricing"
    : `estimated cost ${formatUsd(metrics.tokens.cost.usd)}`;
  const staleSuffix = metrics.tokens.cost.pricingStale ? "; pricing is stale" : "";
  const timingSummary = `total active ${formatDuration(metrics.timing.totalExecutionMs)}, execution runtime ${formatDuration(metrics.timing.activeRuntimeMs)}, ${metrics.timing.timingEventCount.toLocaleString()} timing events, ${metrics.timing.timedWorkflowStepCount.toLocaleString()} workflow steps with timing`;

  return {
    metrics,
    summaryText: `Task ${metrics.taskId} metrics: ${tokenSummary}; ${costSummary}${staleSuffix}; ${timingSummary}.`,
  };
}
