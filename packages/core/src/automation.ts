/** Schedule type presets plus a custom cron option. */
export type ScheduleType = "hourly" | "daily" | "weekly" | "monthly" | "custom" | "every15Minutes" | "every30Minutes" | "every2Hours" | "every6Hours" | "every12Hours" | "weekdays";

/** Mapping from preset schedule types to their cron expressions. */
export const AUTOMATION_PRESETS: Record<Exclude<ScheduleType, "custom">, string> = {
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 1",
  monthly: "0 0 1 * *",
  every15Minutes: "*/15 * * * *",
  every30Minutes: "*/30 * * * *",
  every2Hours: "0 */2 * * *",
  every6Hours: "0 */6 * * *",
  every12Hours: "0 */12 * * *",
  weekdays: "0 9 * * 1-5",
};

// ── Automation Step Types ────────────────────────────────────────────

/** The type of an automation step. */
export type AutomationStepType = "command" | "ai-prompt";

/** A single step within a multi-step scheduled task. */
export interface AutomationStep {
  /** Unique step identifier (UUID). */
  id: string;
  /** The type of this step. */
  type: AutomationStepType;
  /** Human-readable step name. */
  name: string;
  /** Shell command to execute (for command steps). */
  command?: string;
  /** AI prompt to run (for ai-prompt steps). */
  prompt?: string;
  /** AI model provider (for ai-prompt steps). */
  modelProvider?: string;
  /** AI model ID (for ai-prompt steps). */
  modelId?: string;
  /** Per-step timeout override in milliseconds. */
  timeoutMs?: number;
  /** Whether to continue to the next step if this one fails. Default: false. */
  continueOnFailure?: boolean;
}

/** Result of executing a single automation step. */
export interface AutomationStepResult {
  /** Step ID that produced this result. */
  stepId: string;
  /** Step name (for display). */
  stepName: string;
  /** Zero-based index of the step. */
  stepIndex: number;
  /** Whether the step completed successfully. */
  success: boolean;
  /** Output from the step. */
  output: string;
  /** Error message if the step failed. */
  error?: string;
  /** ISO-8601 timestamp of when this step started. */
  startedAt: string;
  /** ISO-8601 timestamp of when this step completed. */
  completedAt: string;
}

/** Result of a single automation run. */
export interface AutomationRunResult {
  success: boolean;
  output: string;
  error?: string;
  startedAt: string;
  completedAt: string;
  /** Per-step results (present only for multi-step schedules). */
  stepResults?: AutomationStepResult[];
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
  /** The shell command to execute (legacy single-command mode). */
  command: string;
  /** Multi-step workflow. When present, steps execute sequentially instead of `command`. */
  steps?: AutomationStep[];
  /** Index of the step currently being executed (runtime only, not persisted as running state). */
  currentStepIndex?: number;
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
  /** Shell command (legacy single-command mode). Required if `steps` is not provided. */
  command: string;
  enabled?: boolean;
  timeoutMs?: number;
  /** Multi-step workflow. When provided, `command` is ignored in favor of sequential step execution. */
  steps?: AutomationStep[];
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
  /** Multi-step workflow. When provided, `command` is ignored in favor of sequential step execution. */
  steps?: AutomationStep[];
}

/** Maximum number of run history entries to retain per schedule. */
export const MAX_RUN_HISTORY = 50;
