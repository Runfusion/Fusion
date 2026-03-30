/** Schedule type presets plus a custom cron option. */
export type ScheduleType = "hourly" | "daily" | "weekly" | "monthly" | "custom";

/** Mapping from preset schedule types to their cron expressions. */
export const AUTOMATION_PRESETS: Record<Exclude<ScheduleType, "custom">, string> = {
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 1",
  monthly: "0 0 1 * *",
};

/** Result of a single automation run. */
export interface AutomationRunResult {
  success: boolean;
  output: string;
  error?: string;
  startedAt: string;
  completedAt: string;
}

/** A scheduled automation task. */
export interface ScheduledTask {
  /** Unique identifier for this schedule (UUID). */
  id: string;
  /** Human-readable name for this schedule. */
  name: string;
  /** Optional description of what this schedule does. */
  description?: string;
  /** The type of schedule — preset or custom. */
  scheduleType: ScheduleType;
  /** The cron expression (auto-derived from preset or user-supplied for custom). */
  cronExpression: string;
  /** The shell command to execute. */
  command: string;
  /** Whether this schedule is currently active. */
  enabled: boolean;
  /** ISO-8601 timestamp of the last run start, if any. */
  lastRunAt?: string;
  /** Result of the most recent run, if any. */
  lastRunResult?: AutomationRunResult;
  /** ISO-8601 timestamp of the next scheduled run. */
  nextRunAt?: string;
  /** Total number of runs executed. */
  runCount: number;
  /** Per-schedule execution timeout in milliseconds. Default: 300000 (5 min). */
  timeoutMs?: number;
  /** History of recent run results (most recent first, capped at 50). */
  runHistory: AutomationRunResult[];
  /** ISO-8601 timestamp of when this schedule was created. */
  createdAt: string;
  /** ISO-8601 timestamp of when this schedule was last updated. */
  updatedAt: string;
}

/** Input for creating a new scheduled task. */
export interface ScheduledTaskCreateInput {
  name: string;
  description?: string;
  scheduleType: ScheduleType;
  /** Required for 'custom' type; ignored for presets (auto-derived). */
  cronExpression?: string;
  command: string;
  enabled?: boolean;
  timeoutMs?: number;
}

/** Input for updating an existing scheduled task. */
export interface ScheduledTaskUpdateInput {
  name?: string;
  description?: string;
  scheduleType?: ScheduleType;
  cronExpression?: string;
  command?: string;
  enabled?: boolean;
  timeoutMs?: number;
}

/** Maximum number of run history entries to retain per schedule. */
export const MAX_RUN_HISTORY = 50;
