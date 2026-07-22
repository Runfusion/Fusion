/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Planner overseer intervention timeline types peeled from types.ts.
 */

// ── Planner Intervention Timeline Types ─────────────────────────────────────

/**
 * FNXC:PlannerOversight 2026-07-04-18:00:
 * FN-7519 introduces a structured intervention-timeline entry so operators can
 * see, per task, exactly why and how the planner overseer stepped in. Each
 * entry records six field groups: the watched STAGE (executor / reviewer /
 * merger / pull-request / workflow-gate), the REASON for intervention, the
 * ACTION taken, the OUTCOME, the bounded-recovery ATTEMPT count/limit, and
 * SOURCE LINKS to supporting evidence (agent logs, review comments, failed
 * checks, merge errors, or PR state). Entries persist as run-audit events
 * under the canonical `overseer:intervention` mutation type (see
 * `OVERSEER_INTERVENTION_MUTATION` and `packages/core/src/planner-intervention.ts`)
 * so no parallel audit store is introduced. This task owns the entry SHAPE
 * and its record/read helpers only — FN-7511/FN-7512 produce interventions
 * and FN-7520 wires the emission call-sites at overseer decision points.
 */
export type PlannerOversightStage = "executor" | "reviewer" | "merger" | "pull-request" | "workflow-gate";

export type PlannerInterventionAction =
  | "observe"
  | "inject-guidance"
  | "retry"
  | "request-fix"
  | "escalate"
  | "request-confirmation";

export type PlannerInterventionOutcome = "succeeded" | "failed" | "pending" | "awaiting-confirmation" | "skipped";

/** A single piece of evidence backing an intervention entry (agent log, review comment, failed check, merge error, or PR state; `url` is a generic fallback). */
export interface PlannerInterventionSourceLink {
  kind: "agent-log" | "review-comment" | "failed-check" | "merge-error" | "pr-state" | "url";
  /** Human-readable label for the link (e.g. "Agent log", "Review comment #3"). */
  label: string;
  /** Opaque identifier for the target evidence (run ID, comment ID, check name, etc). Optional — the UI degrades gracefully when absent. */
  target?: string;
  /** Direct URL to the evidence, when available. Optional. */
  url?: string;
}

/** A single planner-overseer intervention timeline entry (see FNXC note above for the six field groups). */
export interface PlannerInterventionEntry {
  id: string;
  taskId: string;
  /** ISO-8601 timestamp when the intervention occurred. */
  timestamp: string;
  stage: PlannerOversightStage;
  /** Why the overseer intervened (free-text, operator-facing). */
  reason: string;
  action: PlannerInterventionAction;
  outcome: PlannerInterventionOutcome;
  /** Current attempt count for bounded recovery. Present only for recovery-style actions (e.g. retry/request-fix). */
  attemptCount?: number;
  /** Attempt limit for bounded recovery. Present only alongside `attemptCount`. */
  attemptLimit?: number;
  /** Evidence links supporting this intervention (agent logs, review comments, failed checks, merge errors, PR state). */
  sourceLinks?: PlannerInterventionSourceLink[];
  /** Heartbeat run ID that produced this intervention, if applicable. */
  runId?: string;
  /** Agent ID that produced this intervention, if applicable. */
  agentId?: string;
  /*
  FNXC:PlannerOversight 2026-07-13-22:45:
  Session-advisor parity: optional severity (nit/concern/blocker) and provenance
  source so the intervention timeline distinguishes lifecycle canned guidance
  from live session-advisor notes and manual operator nudges. Absent on
  pre-existing rows — parsers must tolerate missing fields.
  */
  severity?: "nit" | "concern" | "blocker";
  source?: "lifecycle" | "session-advisor" | "manual";
  advisorSlug?: string;
}

/** Canonical run-audit mutation type used to persist planner-intervention entries. Single writer: `recordPlannerIntervention` (see `packages/core/src/planner-intervention.ts`); FN-7520 reuses this helper rather than emitting `overseer:intervention` events directly. */
export const OVERSEER_INTERVENTION_MUTATION = "overseer:intervention" as const;

