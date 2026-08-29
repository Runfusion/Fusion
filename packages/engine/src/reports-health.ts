export type ReportHealthBucket =
  | "healthy"
  | "stale-assignment"
  | "stale"
  | "stuck"
  | "paused"
  | "operator-actionable";

export interface ReportHealthInput {
  state: string | undefined;
  pauseReason: string | undefined;
  heartbeatAgeMs: number;
  heartbeatTimeoutMs: number;
  staleThresholdMs: number;
  staleParkedAssignment: boolean;
}

export interface ReportHealthClassification {
  bucket: ReportHealthBucket;
  cellText: string;
}

const OPERATOR_ACTIONABLE_PAUSE_REASONS = new Set([
  "error-unrecoverable",
  "error-retry-exhausted",
  "heartbeat-model-unavailable",
]);

/**
 * FNXC:ReportsHealth 2026-07-24-12:00:
 * FN-8569 requires pause markers to outrank the state column because independent
 * state and marker writes can persist a live-looking state alongside an
 * error-unrecoverable park marker. This classifier must be truthful for every
 * persisted shape, including desyncs that best-effort store cleanup cannot prevent.
 * `lastError` is deliberately excluded: it is diagnostic history, not a health
 * input. Keep this classifier engine-side so @fusion/core never depends on engine.
 */
export function classifyReportHealth(input: ReportHealthInput): ReportHealthClassification {
  const pauseReason = input.pauseReason?.trim();
  if (pauseReason) {
    if (OPERATOR_ACTIONABLE_PAUSE_REASONS.has(pauseReason)) {
      return {
        bucket: "operator-actionable",
        cellText: `**needs operator repair** (${pauseReason})`,
      };
    }
    return {
      bucket: "paused",
      cellText: `paused (${pauseReason})`,
    };
  }

  if (input.state === "error") {
    return { bucket: "operator-actionable", cellText: "**needs operator repair**" };
  }
  if (input.staleParkedAssignment) {
    return { bucket: "stale-assignment", cellText: "**stale** assignment" };
  }
  if (input.state === "running" && input.heartbeatAgeMs > input.heartbeatTimeoutMs * 2) {
    return { bucket: "stuck", cellText: "**stuck**" };
  }
  if ((input.state === "active" || input.state === "idle") && input.heartbeatAgeMs > input.staleThresholdMs) {
    return { bucket: "stale", cellText: "**stale**" };
  }
  if (input.state === "paused") {
    return { bucket: "paused", cellText: "paused" };
  }

  return { bucket: "healthy", cellText: "healthy" };
}
