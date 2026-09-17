/*
FNXC:TaskFollowUp 2026-09-17-15:50:
FN-513 adds a FOLLOW-UP action: an operator prepares task B from the plan and the in-flight
implementation of a still-running task A, without interrupting A. This module is the SINGLE
definition of two questions, so the menu, the store, the HTTP route, and the planner cannot
disagree:

  1. is this row a follow-up? (`isFollowUpTask`)
  2. may a follow-up be created from this row right now? (`evaluateFollowUpEligibility`)

WHY NO NEW `SourceType`. A follow-up IS a refinement for every existing lineage reader, delete
guard, stranded-refinement recovery lane, and provenance surface; adding a source type would fork
all of them and require a migration. The sub-type is therefore a VERSIONED marker inside the
already-persisted `sourceMetadata`, and an absent or malformed marker degrades to an ordinary
refinement rather than to a follow-up.

WHY THIS FILE IS PURE. It is re-exported through the browser-safe `types.ts` leaf the dashboard app
aliases `@fusion/core` to, so it may import types and the browser-safe column-role predicates only —
no store, no Node built-in, no workflow resolver.
*/

import {
  isCompleteColumnRole,
  isHoldColumnRole,
  isIntakeColumnRole,
  isReviewColumnRole,
  isWipColumnRole,
  type ColumnRoleTraitFlags,
} from "../column-roles.js";
import { PLAN_REVIEW_GROUP_ID } from "../workflows/builtin-plan-review-group.js";

/** Reserved `sourceMetadata` key carrying the follow-up sub-type marker. */
export const FOLLOW_UP_METADATA_KEY = "followUp" as const;

/** Current marker version. A row with an unknown version is NOT treated as a follow-up. */
export const FOLLOW_UP_METADATA_VERSION = 1 as const;

/** Shape persisted under {@link FOLLOW_UP_METADATA_KEY}. */
export interface FollowUpSourceMarker {
  version: number;
}

/** The provenance fields the sub-type test reads. */
export interface FollowUpProvenanceInput {
  readonly sourceType?: string;
  readonly sourceParentTaskId?: string;
  readonly sourceMetadata?: Record<string, unknown> | null;
}

/**
 * Is this row a follow-up (a refinement carrying the versioned follow-up marker and a parent)?
 *
 * Requires all three facts: `sourceType === "task_refine"`, a non-empty `sourceParentTaskId`, and a
 * well-formed marker of the known version. Any missing or malformed part answers `false`, which is
 * exactly the ordinary-refinement behavior that shipped before FN-513.
 */
export function isFollowUpTask(input: FollowUpProvenanceInput | null | undefined): boolean {
  if (!input) return false;
  if (input.sourceType !== "task_refine") return false;
  if (!input.sourceParentTaskId?.trim()) return false;
  const marker = input.sourceMetadata?.[FOLLOW_UP_METADATA_KEY];
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  return (marker as { version?: unknown }).version === FOLLOW_UP_METADATA_VERSION;
}

/** Build the metadata patch that stamps the follow-up sub-type, preserving other keys. */
export function buildFollowUpSourceMetadata(
  existing?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    [FOLLOW_UP_METADATA_KEY]: { version: FOLLOW_UP_METADATA_VERSION } satisfies FollowUpSourceMarker,
  };
}

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                 */
/* -------------------------------------------------------------------------- */

/** Fixed refusal vocabulary. Never operator prose, so HTTP and UI can both branch on it. */
export type FollowUpIneligibleReason =
  | "source-deleted"
  | "source-terminal"
  | "source-manual-intake"
  | "source-column-unsupported"
  | "plan-review-not-approved";

export type FollowUpEligibility =
  | { eligible: true; lane: "implementation" | "review" | "planning" }
  | { eligible: false; reason: FollowUpIneligibleReason };

/** The `workflowStepResult` subset the Planning exception reads. */
export interface FollowUpReviewResultInput {
  readonly workflowStepId?: string;
  readonly workflowStepName?: string;
  readonly status?: string;
  readonly verdict?: string;
  readonly supersededAt?: string | null;
  readonly remediationArchivedAt?: string | null;
  readonly bypassedBy?: string | null;
}

/** Column trait flags plus the server-resolved manual-intake fact. */
export type FollowUpColumnFlags = ColumnRoleTraitFlags & { readonly manualIntake?: boolean };

export interface FollowUpEligibilityInput {
  readonly column: string;
  readonly columnFlags?: FollowUpColumnFlags;
  /** Durable planning/replan signal; `needs-replan` or `planning` invalidates the Planning exception. */
  readonly status?: string | null;
  readonly deletedAt?: string | null;
  readonly workflowStepResults?: readonly FollowUpReviewResultInput[];
}

/*
FNXC:TaskFollowUp 2026-09-17-15:55:
The gate id is imported rather than re-typed so a rename of the built-in Plan Review group cannot
silently make every planning card ineligible (the failure would be a missing menu entry, which is
invisible). The display name is kept only as a secondary match for legacy results written before the
group id was stable.
*/
const PLAN_REVIEW_STEP_ID = PLAN_REVIEW_GROUP_ID;
const PLAN_REVIEW_STEP_NAME = "Plan Review";

/**
 * Historical ids used ONLY when no trait flags resolved at all (first paint, or a card resting in a
 * column its workflow no longer declares). An UNKNOWN id is never treated as an execution lane:
 * over-permissiveness here would offer Follow-up on a terminal or manual row.
 */
const LEGACY_MANUAL_INTAKE_COLUMN_ID = "ideas";
const LEGACY_PLANNING_COLUMN_IDS: ReadonlySet<string> = new Set(["todo", "triage"]);

/*
FNXC:TaskFollowUp 2026-09-17-15:50:
THE PLANNING EXCEPTION IS DELIBERATELY STRICT. The operator asked for Follow-up during planning only
when Plan Review has really approved, so this reads the CURRENT plan-review result — the newest
result that still counts — and demands `status === "passed"` with `verdict === "APPROVE"`.

An older APPROVE followed by a pending/failed/REVISE round does NOT qualify: the plan the follow-up
would be derived from no longer exists. Superseded and remediation-archived carriers are skipped as
history rather than treated as current, while `skipped` (a gate that did not run), an operator
bypass, arbitration, and a human plan approval alone are refusals — none of them is a reviewer
verdict about the plan text. A `planning`/`needs-replan` status is a live replan and also refuses.
*/
function isCurrentPlanReviewApproved(
  results: readonly FollowUpReviewResultInput[] | undefined,
  status?: string | null,
): boolean {
  if (status === "planning" || status === "needs-replan") return false;
  const relevant = (results ?? []).filter((result) =>
    (result.workflowStepId === PLAN_REVIEW_STEP_ID || result.workflowStepName === PLAN_REVIEW_STEP_NAME)
    && !result.supersededAt
    && !result.remediationArchivedAt,
  );
  const current = relevant[relevant.length - 1];
  if (!current) return false;
  if (current.bypassedBy) return false;
  return current.status === "passed" && current.verdict === "APPROVE";
}

/**
 * May a follow-up be created from this source row right now?
 *
 * Allowed: a live implementation (WIP) lane, a review lane (merge-blocking or human review), and —
 * under {@link isCurrentPlanReviewApproved} — an automatic planning lane. A momentary pause or
 * failure does NOT remove eligibility, because creating B neither resumes nor disturbs A.
 *
 * Refused: terminal/complete rows (ordinary Refine owns those), soft-deleted rows, manual-capture
 * intake (nothing has been planned yet), and any column whose role cannot be established.
 */
export function evaluateFollowUpEligibility(input: FollowUpEligibilityInput): FollowUpEligibility {
  if (input.deletedAt) return { eligible: false, reason: "source-deleted" };

  const flags = input.columnFlags;
  const column = input.column;

  // `complete` wins over contradictory flags: a terminal card is Refine's, not Follow-up's.
  if (isCompleteColumnRole(flags, column)) return { eligible: false, reason: "source-terminal" };
  if (isReviewColumnRole(flags, column)) return { eligible: true, lane: "review" };
  if (isWipColumnRole(flags, column)) return { eligible: true, lane: "implementation" };

  if (flags?.manualIntake === true || (!flags && column === LEGACY_MANUAL_INTAKE_COLUMN_ID)) {
    return { eligible: false, reason: "source-manual-intake" };
  }

  const isPlanningLane = flags
    ? isHoldColumnRole(flags, column) || isIntakeColumnRole(flags, column)
    : LEGACY_PLANNING_COLUMN_IDS.has(column);
  if (isPlanningLane) {
    return isCurrentPlanReviewApproved(input.workflowStepResults, input.status)
      ? { eligible: true, lane: "planning" }
      : { eligible: false, reason: "plan-review-not-approved" };
  }

  return { eligible: false, reason: "source-column-unsupported" };
}

/** Boolean convenience wrapper for menu predicates. */
export function isFollowUpEligible(input: FollowUpEligibilityInput): boolean {
  return evaluateFollowUpEligibility(input).eligible;
}
