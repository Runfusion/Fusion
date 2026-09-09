/*
FNXC:RunAuditCatalogue 2026-08-10-08:56:
S4 delivery-pipeline run-audit catalogue (RUFU-065 — "Reliability, Durability & Observability",
feature F-MSL72J0A-000M-GIJN, slice S4, milestone M2 — Roadmap Definition, mission
M-MSL4E01A-0001-Y9QC). Grounded verbatim in the M1 vision theme ("Reliability, durability, and
observability of the delivery pipeline — tasks, agents, and their delivery are recoverable and
inspectable"). Requirement: delivery-pipeline run-audit observability must be inspectable after the
fact. This typed, curated catalogue is the single-source-of-truth reference for the delivery-pipeline
run-audit event surface (finalization, self-healing reconciliation, durable-agent error-state). Every
entry is a literal member of the real `DatabaseMutationType` union in `../util/run-audit.ts` —
enforced at compile time by typing the array as `Readonly<DatabaseMutationType[]>` — and is kept in
lock-step with `docs/run-audit.md` by the run-audit-catalogue parity test. The catalogue is
deliberately a curated subset scoped to the delivery-pipeline reliability/observability theme, not all
union members. See `docs/run-audit.md` for the enriched reference and maintenance contract.
 */
import type { DatabaseMutationType } from "../util/run-audit.js";

/**
 * Curated delivery-pipeline run-audit events, grouped by theme into the three delivery-pipeline
 * reliability/observability categories the S4 roadmap item names:
 *
 *   1. Delivery-pipeline finalization — the finalize/hand-off surface that closes a task's delivery
 *      (blocked parks, already-on-main/merged no-ops, finalize column-mismatch reconciliation,
 *      post-finalize verification, finalize-blocking guards, stale-merger recovery).
 *   2. Self-healing reconciliation events — reconciliation-scoped auto-recover/reclaim events the
 *      self-healing sweep surfaces when it repairs board state after the fact.
 *   3. Durable-agent error-state — the durable-agent error/posture events that make agent error
 *      states and their recovery inspectable.
 *
 * Every name is a verified literal member of the `DatabaseMutationType` union; the array type
 * enforces member-validity at compile time, so an invented name is a type error.
 */
export const DELIVERY_PIPELINE_RUN_AUDIT_EVENTS_LITERALS = [
  /* ── 1. Delivery-pipeline finalization ─────────────────────────────────── */
  "task:completed-blocked-parked",
  "task:completed-blocked-advanced",
  "task:auto-recover-already-merged",
  "task:auto-recover-finalize-already-on-main",
  "task:auto-merge-skipped-already-done",
  "task:auto-merge-finalize-column-mismatch-reconciled",
  "task:auto-merge-finalize-column-mismatch-no-action",
  "task:post-finalize-verification-no-op",
  "task:no-commits-finalize-blocked-incomplete-steps",
  "task:empty-merge-finalize-blocked-no-landed-proof",
  "task:finalize-unproven-blocked",
  "task:merge-boundary-unproven-parked",
  "task:merge-admission-deferred-live-execution",
  "task:reconcile-confirmed-merge-checklist",
  "task:finalize-lost-work-blocked",
  "task:auto-recover-stale-merger-status",

  /* ── 2. Self-healing reconciliation events ─────────────────────────────── */
  "task:auto-recover-paused-abort-park",
  "task:auto-rebound-paused-scope-decay",
  "task:auto-archive-failure-budget-exhausted",
  /*
  FNXC:RunAudit 2026-08-23-18:58:
  FN-9186's bounded zero-progress requeue pair. docs/run-audit.md carried both rows while the catalogue
  did not, and the lock-step guard is the only thing that reports that direction of drift.
  */

  "task:reclaim-phantom-executor-binding",
  "task:reconcile-orphaned-pending-step-results",
  "task:reconcile-unproven-review-approval",
  "task:reconcile-stale-duplicate-decision",
  "task:reconcile-stale-agent-assignment",
  "task:reconcile-engine-downtime-active-timing",
  "task:reconcile-engine-downtime-active-timing-no-action",
  "task:reconcile-undeclared-column",
  "task:reconcile-wedged-active-merge",
  "task:reconcile-stranded-completed-no-action",
  "task:reconcile-legacy-adoption",
  "task:reconcile-archived-into-done",

  /* ── 3. Durable-agent error-state ──────────────────────────────────────── */
  "agent:auto-recover-error-state",
  "agent:reset-error-state-on-startup",
  "agent:error-retry-exhausted",
  "agent:error-parked-unrecoverable",
  "agent:heartbeat-move-skipped-soft-delete",
] as const;

/**
 * The 31-event literal union of the curated catalogue. `as const` preserves the literal element
 * tuples so the notes map can be keyed by exactly the catalogued events (rather than widening to the
 * full `DatabaseMutationType` union). The exported array below is still typed as
 * `Readonly<DatabaseMutationType[]>`, so member-validity remains compile-time-enforced: assigning
 * this literal array is only valid because every literal is a member of the real union.
 */
type DeliveryPipelineRunAuditEvent = (typeof DELIVERY_PIPELINE_RUN_AUDIT_EVENTS_LITERALS)[number];

export const DELIVERY_PIPELINE_RUN_AUDIT_EVENTS: Readonly<DatabaseMutationType[]> =
  DELIVERY_PIPELINE_RUN_AUDIT_EVENTS_LITERALS;

/**
 * One-line "what it records / when it fires" commentary for each catalogued event, framed with the
 * run-audit metadata convention (ids/outcomes-only; never prose). `docs/run-audit.md` carries the
 * full per-event reference; this compact map keeps the catalogue self-describing in source.
 */
export const DELIVERY_PIPELINE_RUN_AUDIT_EVENT_NOTES: Readonly<Record<DeliveryPipelineRunAuditEvent, string>> = {
  /* ── 1. Delivery-pipeline finalization ─────────────────────────────────── */
  "task:completed-blocked-parked":
    "A fully implemented task is parked instead of advancing to review because a live completion blocker applies.",
  "task:completed-blocked-advanced":
    "The parked completed task's blocker cleared and its work advances to review.",
  "task:auto-recover-already-merged":
    "Self-healing finds a task already merged into main and records the no-recovery needed outcome.",
  "task:auto-recover-finalize-already-on-main":
    "A finalize attempt is skipped because the task's changes are already present on main.",
  "task:auto-merge-skipped-already-done":
    "Auto-merge is skipped because the task is already done/landed.",
  "task:auto-merge-finalize-column-mismatch-reconciled":
    "Finalize found the task in a different live column than its target and reconciled the column.",
  "task:auto-merge-finalize-column-mismatch-no-action":
    "Finalize found a column mismatch but took no action (e.g. blocked/no-action per triple-proof).",
  "task:post-finalize-verification-no-op":
    "Post-finalize verification ran and found nothing to verify (no-op), recording the check outcome.",
  "task:no-commits-finalize-blocked-incomplete-steps":
    "Finalize is blocked for a zero-commit task with incomplete workflow steps (FN-6461 lane).",
  "task:empty-merge-finalize-blocked-no-landed-proof":
    "The AI empty-merge lane vetoes a zero-diff no-op finalize with no landed proof (FN-8141).",
  "task:finalize-unproven-blocked":
    "Finalize is blocked because finalization has not been proven against the landing truth.",
  "task:merge-boundary-unproven-parked":
    "A terminal merge-boundary proof failure is parked with bounded best-effort audit telemetry.",
  "task:merge-admission-deferred-live-execution":
    "Merge admission deferred because a live execution signal still owns the task.",
  "task:reconcile-confirmed-merge-checklist":
    "Confirmed-merge finalization reconciled stale checklist state using counts-only telemetry.",
  "task:finalize-lost-work-blocked":
    "Finalize is blocked because it would discard work (lost-work guard).",
  "task:auto-recover-stale-merger-status":
    "Self-healing clears a stale merger status left on a finalize path.",

  /* ── 2. Self-healing reconciliation events ─────────────────────────────── */
  "task:auto-recover-paused-abort-park":
    "Self-healing clears a benign pause-abort operator park and requeues the task.",
  "task:auto-rebound-paused-scope-decay":
    "Self-healing rebounds a task whose paused scope decayed past its floor, unblocking followers.",
  "task:auto-archive-failure-budget-exhausted":
    "Historical compatibility event for a retired stale-task archive sweep.",

  "task:reclaim-phantom-executor-binding":
    "Self-healing proves an in-memory executor-active binding is stale and requeues the task.",
  "task:reconcile-orphaned-pending-step-results":
    "Self-healing rewrites orphaned 'pending' workflow-step results (no live session) to 'failed'.",
  "task:reconcile-unproven-review-approval":
    "Self-healing rewrites singular content-review approvals without input proof to recoverable failed results.",
  "task:reconcile-stale-duplicate-decision":
    "Self-healing clears a recurring duplicate-decision pause with no canonical target.",
  "task:reconcile-stale-agent-assignment":
    "Self-healing clears stale durable Agent.taskId/state drift while preserving file-scope leases.",
  "task:reconcile-engine-downtime-active-timing":
    "Self-healing shifts active-task anchors to exclude proven stopped-engine wall-clock.",
  "task:reconcile-engine-downtime-active-timing-no-action":
    "Self-healing finds no active task qualifies for downtime-timing reconciliation (no-action).",
  "task:reconcile-undeclared-column":
    "Self-healing re-homes a row out of a column its workflow no longer declares.",
  "task:reconcile-wedged-active-merge":
    "Self-healing reclaims a wedged single-flight merge entry.",
  "task:reconcile-stranded-completed-no-action":
    "A stranded-completed promoter withholds promotion of an all-steps-done/skipped task with a failure park provenance (no-action).",
  "task:reconcile-legacy-adoption":
    "Self-healing startup adopts a pre-cutover legacy task row through the KTD-8 adoption table.",
  "task:reconcile-archived-into-done":
    "Self-healing moves or restores one historical archived task into its workflow completion lane.",

  /* ── 3. Durable-agent error-state ──────────────────────────────────────── */
  "agent:auto-recover-error-state":
    "A recoverable, non-operator-actionable durable-agent error is cleared by the heartbeat/self-healing sweep and retried.",
  "agent:reset-error-state-on-startup":
    "An engine restart clears an eligible durable-agent error/exhaustion park and re-arms the heartbeat (startup-only).",
  "agent:error-retry-exhausted":
    "A durable-agent error retry budget is exhausted and the agent is parked 'paused' with pauseReason error-retry-exhausted.",
  "agent:error-parked-unrecoverable":
    "An operator-actionable durable-agent error parks the agent 'paused' with pauseReason error-unrecoverable for human repair.",
  "agent:heartbeat-move-skipped-soft-delete":
    "A heartbeat move races a soft-deleted task and is skipped without parking the durable agent.",
};