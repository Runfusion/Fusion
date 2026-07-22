import type {
  PlannerInterventionAction,
  PlannerInterventionOutcome,
  PlannerInterventionSourceLink,
  PlannerOversightStage,
  RunAuditEvent,
} from "../types.js";
import { type PlannerInterventionStore, recordPlannerIntervention } from "./planner-intervention.js";

/**
 * FNXC:PlannerOversight 2026-07-04-19:30:
 * FN-7520 canonical emission façade for planner-overseer decision points.
 * Requirement: every overseer decision point — a passive observation, injected
 * steering guidance, a bounded recovery attempt, a retry of a stuck/failed
 * step, a merge/PR confirmation request, or an escalation to a human — is
 * recorded as a run-audit/activity event through exactly ONE façade. Each
 * exported emitter below fixes the `action` (and a sensible default
 * `outcome`, overridable via input) for its category and delegates to
 * FN-7519's `recordPlannerIntervention(...)`, which is the single canonical
 * writer for the `overseer:intervention` run-audit mutation type.
 *
 * Single-writer contract: do NOT call `recordRunAuditEvent` directly from
 * here and do NOT introduce a second `overseer:*` mutation type. FN-7511 /
 * FN-7512 / FN-7513 (the monitoring loop, bounded-recovery engine, and
 * confirmation/escalation producers) are expected to import and call these
 * emitters rather than emit run-audit events inline.
 */

/** Shared input for every `emitOverseer*` façade function. */
export interface OverseerEventInput {
  /** Store implementing the minimal `recordRunAuditEvent`/`getRunAuditEvents` seam (satisfied by `TaskStore`). */
  store: PlannerInterventionStore;
  taskId: string;
  /** Heartbeat run ID that produced this decision point. Defaults to a synthetic per-call ID when omitted (see `recordPlannerIntervention`). */
  runId?: string;
  /** Agent ID that produced this decision point. Defaults to `"overseer"` when omitted. */
  agentId?: string;
  stage: PlannerOversightStage;
  reason: string;
  /** Overrides the emitter's default outcome for this category. */
  outcome?: PlannerInterventionOutcome;
  attemptCount?: number;
  attemptLimit?: number;
  sourceLinks?: PlannerInterventionSourceLink[];
  /** ISO-8601 timestamp override. Defaults to now. */
  timestamp?: string;
  /*
  FNXC:PlannerOversight 2026-07-13-22:45:
  Optional session-advisor metadata threaded into recordPlannerIntervention.
  */
  severity?: "nit" | "concern" | "blocker";
  source?: "lifecycle" | "session-advisor" | "manual";
  advisorSlug?: string;
}

/**
 * Normalizes an `OverseerEventInput` into FN-7519's `RecordPlannerInterventionInput`
 * shape for the given fixed `action`, applying `defaultOutcome` when the caller
 * did not supply an explicit `outcome`, and delegates to `recordPlannerIntervention`.
 * Non-throwing on optional-field absence — all optional fields are passed through
 * as-is (`undefined` when absent) so FN-7519's own tolerant handling applies.
 */
function normalizeAndRecord(
  input: OverseerEventInput,
  action: PlannerInterventionAction,
  defaultOutcome: PlannerInterventionOutcome,
): RunAuditEvent | Promise<RunAuditEvent> {
  return recordPlannerIntervention(input.store, {
    taskId: input.taskId,
    runId: input.runId,
    agentId: input.agentId,
    stage: input.stage,
    reason: input.reason,
    action,
    outcome: input.outcome ?? defaultOutcome,
    attemptCount: input.attemptCount,
    attemptLimit: input.attemptLimit,
    sourceLinks: input.sourceLinks,
    timestamp: input.timestamp,
    severity: input.severity,
    source: input.source,
    advisorSlug: input.advisorSlug,
  });
}

/**
 * Records a passive overseer observation (a watch signal with no corrective
 * action taken). Default outcome: `"succeeded"` (the observation itself always
 * "succeeds"; attempt fields are typically omitted for this category).
 */
export function emitOverseerObservation(input: OverseerEventInput): RunAuditEvent | Promise<RunAuditEvent> {
  return normalizeAndRecord(input, "observe", "succeeded");
}

/**
 * Records the overseer injecting steering guidance into a running task.
 * Default outcome: `"pending"` (guidance has been injected; whether it lands
 * successfully is determined by a later observation/retry).
 */
export function emitOverseerSteering(input: OverseerEventInput): RunAuditEvent | Promise<RunAuditEvent> {
  return normalizeAndRecord(input, "inject-guidance", "pending");
}

/**
 * Records a bounded recovery attempt (an overseer-issued fix request).
 * Default outcome: `"pending"`. Callers should supply `attemptCount`/`attemptLimit`
 * so the timeline can render bounded-recovery progress.
 */
export function emitOverseerRecoveryAttempt(input: OverseerEventInput): RunAuditEvent | Promise<RunAuditEvent> {
  return normalizeAndRecord(input, "request-fix", "pending");
}

/**
 * Records a retry of a stuck/failed step. Default outcome: `"pending"`.
 * Callers should supply `attemptCount`/`attemptLimit` so the timeline can
 * render bounded-retry progress.
 */
export function emitOverseerRetry(input: OverseerEventInput): RunAuditEvent | Promise<RunAuditEvent> {
  return normalizeAndRecord(input, "retry", "pending");
}

/**
 * Records a merge/PR confirmation request raised to a human. Default outcome:
 * `"awaiting-confirmation"`.
 */
export function emitOverseerConfirmation(input: OverseerEventInput): RunAuditEvent | Promise<RunAuditEvent> {
  return normalizeAndRecord(input, "request-confirmation", "awaiting-confirmation");
}

/**
 * Records an escalation to a human (bounded recovery exhausted, or an
 * unrecoverable condition). Default outcome: `"failed"`, overridable — for
 * example a caller may escalate with outcome `"skipped"` when escalation is
 * itself bypassed by a human-control guard.
 */
export function emitOverseerEscalation(input: OverseerEventInput): RunAuditEvent | Promise<RunAuditEvent> {
  return normalizeAndRecord(input, "escalate", "failed");
}
