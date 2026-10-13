import {
  getPostMergeEvidenceGateStatuses,
} from "../merge/confirmed-merge-reconciliation.js";
import {
  isAuditedOperatorBypass,
  requiresAuthoredReviewVerdict,
} from "../merge/pre-merge-approval.js";
import { resolveRequiredPreMergeStepIds } from "../merge/required-pre-merge-steps.js";
import { TransitionRejectionError } from "../task-store/errors.js";
import type { TransitionRejection } from "../tasks/transition-types.js";
import type { Task, WorkflowStepResult } from "../types.js";
import { resolveFastLaneRoute } from "./workflow-fast-lane.js";
import type { WorkflowIr } from "./workflow-ir-types.js";
import {
  isWorkflowOptionalGroupEnabled,
  resolveWorkflowOptionalSteps,
} from "./workflow-optional-steps.js";
import { isWorkflowStepNotRun } from "./workflow-step-results.js";

/*
FNXC:CompleteColumnGateEvidence 2026-10-11-17:20 (RUFU-406):
Measured 2026-09-29 on two cards: RUFU-389 reached `done` through a `todo → in-progress → done`
CLI chain run from an agent's bash, with ZERO `code-review` rows and no merge, and RUFU-337 sits
in the same shape with `noCommitsExpected: true`. Neither was refused, because the only complete-bound
refusal at the move seam is the MERGE blocker (`getTaskMergeBlocker`), and that resolver is consulted
only when the SOURCE column carries the `merge-blocker` trait — a `todo → done` move never asks it.
So a card could be terminal while every gate that verifies its work had said nothing about it.

This module is the missing gate-EVIDENCE half of that boundary: given the already-resolved workflow IR
and the card, it reports which required gates have no approving evidence. It is pure (no store, no
clock, no I/O) so the move seam, the tests, and any future graph-entry owner (RUFU-349 owns
`workflow-column-boundary.ts` node entry) read ONE classifier instead of writing parallel copies.

Deliberate boundaries:
- Identity of "required" is delegated to `resolveRequiredPreMergeStepIds` — this file never re-derives
  which gates are owed, so the merge door and this guard can never disagree about the SET.
- The waiver predicate is delegated to `isAuditedOperatorBypass` (FN-7720): the sanctioned override
  stays the audited bypass, which refuses every automated actor, so a machine `skipped` never reads
  as a human decision.
- Missing MERGE evidence is not this guard's subject. "Not merged yet" remains the exclusive authority
  of `getTaskMergeBlocker`; this file never reads `mergeDetails`.
*/

/** Which lane a required gate belongs to. Post-merge gates are owed AFTER landing. */
export type CompleteColumnGateLane = "pre-merge" | "post-merge";

/**
 * Evidence state of one required gate, as read from its LATEST result row.
 *
 * `satisfied`/`advisory`/`waived`/`not-run` are passing states; `missing`/`in-flight`/
 * `not-approved`/`unwaived-skip` refuse. The split is exhaustive over
 * `WorkflowStepResult["status"]` plus the absent-row case, so an unknown status fails closed.
 */
export type CompleteColumnGateEvidenceState =
  /** Approving evidence exists (`passed` with an approving verdict, or a status-only `passed` that owed none). */
  | "satisfied"
  /** `advisory_failure` — a terminal advisory outcome, deliberately non-blocking at this boundary. */
  | "advisory"
  /** `skipped` carrying an audited operator waiver (`bypassedBy`/`bypassedAt`/`bypassReason`). */
  | "waived"
  /** Honest non-run carrier (`skipped` + valid `notRunReason`) for a gate that owed no authored verdict. */
  | "not-run"
  /** Zero result rows: the required gate never ran. */
  | "missing"
  /** Latest row `pending` — an in-flight session owns it; a move must not pre-empt the verdict. */
  | "in-flight"
  /** A durable negative opinion: `failed`, a non-approving verdict, or a `passed` row that owed one. */
  | "not-approved"
  /** `skipped` with no audited waiver — including a review-domain skip that owed an authored verdict. */
  | "unwaived-skip";

/** States that refuse entry into a complete-trait column. */
const REFUSING_STATES: readonly CompleteColumnGateEvidenceState[] = [
  "missing",
  "in-flight",
  "not-approved",
  "unwaived-skip",
];

/** Human-readable clause per refusing state, for the deterministic refusal sentence. */
const STATE_CLAUSES: Readonly<Record<CompleteColumnGateEvidenceState, string>> = {
  satisfied: "approved",
  advisory: "recorded an advisory failure",
  waived: "waived by an audited operator bypass",
  "not-run": "reported it could not run",
  missing: "has no result recorded",
  "in-flight": "is still running",
  "not-approved": "did not approve",
  "unwaived-skip": "was skipped without an audited operator waiver",
};

export interface CompleteColumnGateFinding {
  gateId: string;
  lane: CompleteColumnGateLane;
  state: CompleteColumnGateEvidenceState;
}

/**
 * The narrow card facts this classifier reads. `workspaceWorktrees` is required by the post-merge
 * helpers' delivery-shape exemption (RUFU-429); the rest are the fast-lane and gate-selection facts.
 */
export type CompleteColumnGateTask = Pick<
  Task,
  "enabledWorkflowSteps" | "workflowStepResults" | "executionMode" | "humanPlanApproval" | "workspaceWorktrees"
>;

/**
 * Why a workflow-aware card resolved ZERO required pre-merge gates. Registered as an explicit
 * vocabulary because "nothing is owed" has genuinely different causes, and an empty set that came
 * from an unreadable IR must not be reported as the same fact as a fast-lane route.
 */
export type CompleteColumnEmptyReason =
  /** Fast mode bypasses every pre-merge group by design (the resolver returns an empty set). */
  | "fast-lane-route"
  /** The IR declares no pre-merge optional group at all. */
  | "no-pre-merge-gates-declared"
  /** Pre-merge groups exist but this card's selection has every non-reporting one disabled. */
  | "all-pre-merge-gates-disabled"
  /** Every pre-merge group is reporting-only, so no approval is owed by construction. */
  | "reporting-only-pre-merge-gates";

export interface CompleteColumnGateEvidence {
  /** True when at least one required gate is in a refusing state. */
  refuse: boolean;
  /** Refusing findings only, ordered pre-merge-then-post-merge and by gate id for byte stability. */
  findings: CompleteColumnGateFinding[];
  /** Present only when the required pre-merge set resolved empty, naming WHICH empty case this is. */
  emptyReason?: CompleteColumnEmptyReason;
  requiredPreMergeGateCount: number;
  requiredPostMergeGateCount: number;
}

/** The latest row for one gate, or `undefined` when it never ran. */
export function findLatestWorkflowStepResult(
  results: readonly WorkflowStepResult[] | undefined,
  stepId: string,
): WorkflowStepResult | undefined {
  return results?.filter((entry) => entry.workflowStepId === stepId).at(-1);
}

/*
FNXC:CompleteColumnGateEvidence 2026-10-11-17:20 (RUFU-406) — divergence register vs merge authority:
This classifier is NOT `evaluatePreMergeApprovals` renamed. Two states deliberately differ, both in the
permissive direction, both required by this task's contract:
1. `advisory_failure` PASSES here. The merge door keeps it non-approved, so a card whose advisory gate
   failed can reach a terminal lane but still cannot publish — the stricter authority stays the merge
   door, which also owns content staleness this guard cannot see.
2. A non-review `skipped + notRunReason` carrier PASSES here, matching the merge door's honest-not-run
   reading; a skip on a gate that OWED an authored verdict (`requiresAuthoredReviewVerdict`) still
   refuses, so a `skipped` code-review can never masquerade as the honest tooling-unavailable shape.
Everything else agrees with the door because it reuses the door's own predicates
(`isAuditedOperatorBypass`, `requiresAuthoredReviewVerdict`). The parity test in
`__tests__/complete-column-gate-evidence.test.ts` pins both the agreement and these two exceptions,
so a future change to merge authority cannot silently move this gate.
*/
/** Classify one required pre-merge gate from its latest row (delegating waiver/verdict-owed truth). */
export function classifyPreMergeGateEvidence(
  gateId: string,
  result: WorkflowStepResult | undefined,
): CompleteColumnGateEvidenceState {
  if (!result) return "missing";
  // The audited override is the ONLY sanctioned way to pass a gate that never approved.
  if (isAuditedOperatorBypass(result)) return "waived";
  switch (result.status) {
    case "pending":
      return "in-flight";
    case "advisory_failure":
      return "advisory";
    case "passed": {
      if (result.verdict === "APPROVE" || result.verdict === "APPROVE_WITH_NOTES") return "satisfied";
      if (result.verdict !== undefined) return "not-approved";
      // Status-only `passed`: a gate that owed no authored verdict is satisfied by its own pass.
      return requiresAuthoredReviewVerdict(gateId, result) ? "not-approved" : "satisfied";
    }
    case "failed":
      return "not-approved";
    case "skipped": {
      if (requiresAuthoredReviewVerdict(gateId, result)) return "unwaived-skip";
      return isWorkflowStepNotRun(result) ? "not-run" : "unwaived-skip";
    }
    default:
      // An unknown status is not evidence; fail closed rather than invent a pass.
      return "not-approved";
  }
}

/** Why the required pre-merge set is empty for a workflow-aware card. */
export function classifyEmptyRequiredPreMergeSet(
  ir: WorkflowIr,
  task: CompleteColumnGateTask,
): CompleteColumnEmptyReason {
  if (resolveFastLaneRoute(ir, task).active) return "fast-lane-route";
  const preMerge = resolveWorkflowOptionalSteps(ir).filter((step) => step.phase === "pre-merge");
  if (preMerge.length === 0) return "no-pre-merge-gates-declared";
  const owwable = preMerge.filter((step) => !step.reportingOnly);
  if (owwable.length === 0) return "reporting-only-pre-merge-gates";
  if (
    owwable.every(
      (step) => !isWorkflowOptionalGroupEnabled(task.enabledWorkflowSteps, step.templateId, step.defaultOn),
    )
  ) {
    return "all-pre-merge-gates-disabled";
  }
  // Unreachable for a resolver-consistent IR; report the narrowest honest cause.
  return "no-pre-merge-gates-declared";
}

/**
 * Evaluate the required-gate evidence a card presents before it may enter a complete-trait column.
 *
 * `ir` must already be resolved by the caller (the move seam resolves it inside KTD-5), which is why
 * this helper takes it as an argument instead of re-reading the store: a card whose workflow IR could
 * not be resolved never reaches here, so this file has no "read failed" branch to launder into either
 * a pass or a refusal.
 */
export function resolveCompleteColumnGateEvidence(args: {
  ir: WorkflowIr;
  task: CompleteColumnGateTask;
}): CompleteColumnGateEvidence {
  const { ir, task } = args;
  const requiredPreMerge = resolveRequiredPreMergeStepIds(ir, task.enabledWorkflowSteps, task);
  const findings: CompleteColumnGateFinding[] = [];

  for (const gateId of requiredPreMerge) {
    const state = classifyPreMergeGateEvidence(gateId, findLatestWorkflowStepResult(task.workflowStepResults, gateId));
    if (REFUSING_STATES.includes(state)) findings.push({ gateId, lane: "pre-merge", state });
  }

  /*
  FNXC:CompleteColumnGateEvidence 2026-10-11-17:20 (RUFU-406):
  Post-merge gates are checked for one thing only: a DURABLE NEGATIVE report. The post-merge helpers
  already fold the delivery-shape (RUFU-429) and no-reporter (RUFU-430) exemptions into their status, and
  they never report `not-approved` for an absent or honest not-run row — a card that has not merged yet
  simply has no post-merge evidence, which is the finalizer's and self-healing's domain, not a reason to
  refuse a move into the lane where that evidence would be produced. The engine-side evidence CONTRACT is
  deliberately not resolved here (it is async and provider-aware); the cost is that a CI-shaped gate on a
  reporter-less board reads `missing` instead of `not-applicable`, and `missing` never refuses.
  */
  const postMergeStatuses = getPostMergeEvidenceGateStatuses(task, ir);
  for (const status of postMergeStatuses) {
    if (status.state === "not-approved") findings.push({ gateId: status.gateId, lane: "post-merge", state: "not-approved" });
  }

  findings.sort((a, b) => (a.lane === b.lane ? a.gateId.localeCompare(b.gateId) : a.lane === "pre-merge" ? -1 : 1));

  return {
    refuse: findings.length > 0,
    findings,
    ...(requiredPreMerge.size === 0
      ? { emptyReason: classifyEmptyRequiredPreMergeSet(ir, task) }
      : {}),
    requiredPreMergeGateCount: requiredPreMerge.size,
    requiredPostMergeGateCount: postMergeStatuses.length,
  };
}

/** Deterministic, surface-agnostic refusal sentence naming each silent gate and the remediation. */
export function describeCompleteColumnGateFindings(
  findings: readonly CompleteColumnGateFinding[],
  opts: { taskId: string; toColumn: string },
): string {
  const clauses = findings.map(
    (finding) =>
      `${finding.gateId} (${finding.lane}) ${STATE_CLAUSES[finding.state]}`,
  );
  return (
    `Required workflow gate evidence is missing for: ${clauses.join(", ")}. ` +
    `A card may not enter '${opts.toColumn}' until every required gate reports — run the gate, ` +
    // The remedy must be ACTIONABLE at the surface that reads it. There is no `fn task bypass-review`
    // subcommand — the audited waiver lives on the operator-only `fn_task_bypass_review` tool and the
    // card's Review menu (`POST /tasks/:id/bypass-review`) — so naming a CLI command here would hand an
    // agent a dead end and invite it to retry the move. `docs/cli-reference.md` documents the same pair.
    `or have an operator record the audited bypass with its reason (fn_task_bypass_review, `
    + `or POST /tasks/${opts.taskId}/bypass-review).`
  );
}

/**
 * The typed refusal for a complete-column move that lacks gate evidence.
 *
 * It is a `TransitionRejectionError` so every existing catcher (dashboard route, CLI, engine retry
 * router) keeps working by `instanceof`, while `.gateFindings` carries the structured facts for the
 * surfaces that want to name each gate without parsing prose.
 */
export class CompleteColumnGateEvidenceRejectionError extends TransitionRejectionError {
  readonly gateFindings: readonly CompleteColumnGateFinding[];
  constructor(rejection: TransitionRejection, message: string, gateFindings: readonly CompleteColumnGateFinding[]) {
    super(rejection, message);
    this.name = "CompleteColumnGateEvidenceRejectionError";
    this.gateFindings = gateFindings;
  }
}
