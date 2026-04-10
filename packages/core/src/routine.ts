/**
 * Routine domain types for first-class recurring task automation.
 *
 * Routines are similar to ScheduledTasks but support multiple trigger modes
 * (cron, webhook, API, manual) with configurable execution and catch-up policies.
 */

import type { AutomationRunResult } from "./automation.js";

// ── Trigger Types ─────────────────────────────────────────────────────

/** Supported trigger modes for routines. */
export type RoutineTriggerType = "cron" | "webhook" | "api" | "manual";

/** Cron-based trigger with timezone support. */
export interface RoutineCronTrigger {
  type: "cron";
  /** Valid 5-field cron expression. */
  cronExpression: string;
  /** Optional IANA timezone (e.g., "America/New_York"). Defaults to UTC. */
  timezone?: string;
}

/** Webhook trigger for external invocation. */
export interface RoutineWebhookTrigger {
  type: "webhook";
  /** URL path for the webhook (e.g., "/trigger/my-routine"). */
  webhookPath: string;
  /** Optional HMAC secret for signature verification. */
  secret?: string;
}

/** API-triggered routine. */
export interface RoutineApiTrigger {
  type: "api";
  /** API endpoint that triggers this routine. */
  endpoint: string;
}

/** Manually triggered routine. */
export interface RoutineManualTrigger {
  type: "manual";
}

/** Union of all trigger types. */
export type RoutineTrigger =
  | RoutineCronTrigger
  | RoutineWebhookTrigger
  | RoutineApiTrigger
  | RoutineManualTrigger;

/** Discriminant helper for trigger type narrowing. */
export function isCronTrigger(trigger: RoutineTrigger): trigger is RoutineCronTrigger {
  return trigger.type === "cron";
}

export function isWebhookTrigger(trigger: RoutineTrigger): trigger is RoutineWebhookTrigger {
  return trigger.type === "webhook";
}

export function isApiTrigger(trigger: RoutineTrigger): trigger is RoutineApiTrigger {
  return trigger.type === "api";
}

export function isManualTrigger(trigger: RoutineTrigger): trigger is RoutineManualTrigger {
  return trigger.type === "manual";
}

// ── Execution Policies ─────────────────────────────────────────────────

/**
 * Catch-up policy: what to do when a routine misses its scheduled run.
 * - `run`: Execute the routine for each missed occurrence (catch-up runs).
 * - `skip`: Skip missed occurrences entirely.
 * - `run_one`: Execute once for the most recent missed occurrence only.
 */
export type RoutineCatchUpPolicy = "run" | "skip" | "run_one";

/**
 * Execution policy: how to handle concurrent runs of the same routine.
 * - `parallel`: Allow multiple concurrent executions.
 * - `queue`: Queue subsequent runs, execute one at a time.
 * - `reject`: Reject new runs if one is already in progress.
 */
export type RoutineExecutionPolicy = "parallel" | "queue" | "reject";

// ── Execution Result ───────────────────────────────────────────────────

/**
 * Result of a single routine execution.
 * Extends AutomationRunResult with routine-specific fields.
 */
export interface RoutineExecutionResult extends AutomationRunResult {
  /** ID of the routine that was executed. */
  routineId: string;
  /** Whether a catch-up run was triggered. */
  isCatchUp?: boolean;
  /** Trigger type that fired this execution. */
  triggerType?: RoutineTriggerType;
}

// ── Routine ───────────────────────────────────────────────────────────

/**
 * A routine is a recurring automation with configurable triggers and policies.
 */
export interface Routine {
  /** Unique identifier (UUID). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Optional description of what this routine does. */
  description?: string;
  /** The trigger configuration. */
  trigger: RoutineTrigger;
  /** Catch-up policy for missed runs. Default: "run_one". */
  catchUpPolicy: RoutineCatchUpPolicy;
  /** Execution policy for concurrent runs. Default: "queue". */
  executionPolicy: RoutineExecutionPolicy;
  /** Whether this routine is currently enabled. */
  enabled: boolean;
  /** ISO-8601 timestamp of the last run start, if any. */
  lastRunAt?: string;
  /** Result of the most recent run, if any. */
  lastRunResult?: RoutineExecutionResult;
  /** ISO-8601 timestamp of the next scheduled run (for cron triggers). */
  nextRunAt?: string;
  /** Total number of runs executed. */
  runCount: number;
  /** History of recent run results (most recent first, capped at MAX_ROUTINE_RUN_HISTORY). */
  runHistory: RoutineExecutionResult[];
  /** Optional cron expression stored directly for due-routine queries (derived from trigger). */
  cronExpression?: string;
  /** ISO-8601 timestamp of when this routine was created. */
  createdAt: string;
  /** ISO-8601 timestamp of when this routine was last updated. */
  updatedAt: string;
}

// ── Input Types ───────────────────────────────────────────────────────

/** Input for creating a new routine. */
export interface RoutineCreateInput {
  /** Human-readable name. Required. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Trigger configuration. Required. */
  trigger: RoutineTrigger;
  /** Catch-up policy. Default: "run_one". */
  catchUpPolicy?: RoutineCatchUpPolicy;
  /** Execution policy. Default: "queue". */
  executionPolicy?: RoutineExecutionPolicy;
  /** Whether enabled. Default: true. */
  enabled?: boolean;
}

/** Input for updating an existing routine. */
export interface RoutineUpdateInput {
  /** Human-readable name. */
  name?: string;
  /** Optional description. */
  description?: string;
  /** Trigger configuration. */
  trigger?: RoutineTrigger;
  /** Catch-up policy. */
  catchUpPolicy?: RoutineCatchUpPolicy;
  /** Execution policy. */
  executionPolicy?: RoutineExecutionPolicy;
  /** Whether enabled. */
  enabled?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────

/** Maximum number of run history entries to retain per routine. */
export const MAX_ROUTINE_RUN_HISTORY = 50;
