/*
FNXC:WorkflowTransitionPolicy 2026-07-18-19:40:
U1 / KTD-5 — the single shared transition validator. This module hosts the PURE
trait-invariant logic for a column transition; it has no store, no DB handle, and
no engine import, so it is unit-testable in isolation (transition-validator.test.ts).

The lifecycle cutover has one in-lock enforcement point — `task-store/moves.ts`
`moveTaskInternalImpl` — that EVERY mover funnels through (graph traversal,
scheduler hold→wip release, self-healing rebound, heartbeat progression, operator
drag, dashboard routes). That single call site is the sole caller of this policy.
No other module may call it directly (branch-local trait checks are
defense-in-depth only). Enforcing an invariant at one branch of one gate loop is
how invariants stop drifting apart between movers — see
docs/solutions/logic-errors/repo-root-task-worktree-requeue-loop.md.

The invariants live here as RETURN-GUARD POSTCONDITIONS: a move is only permitted
when every applicable invariant returns `allow`, so a would-be caller cannot skip
one by taking a different branch. The two structural invariants are:

  1. merge-blocker on complete-bound entry — a card may not enter a `complete`
     column while it carries an unresolved merge blocker (generalized FN-5147 in
     trait terms; the builtin realization is in-review→done with a live blocker).
  2. terminal → wip re-entry — a card in a `complete`/`archived` column may not be
     moved into a WIP column. Completed/archived work is not resurrected straight
     into active capacity; reopens route through a `hold`/`intake` column instead.

Capacity for direct WIP entry (KTD-5) is a pure DECISION here — the caller counts
live occupants via the one `workflow-capacity` counter and hands (limit,
occupants) to `evaluateCapacityRejection`, so there is exactly one capacity-
counting authority and one capacity-verdict authority. A move into a saturated
WIP column is rejected and the task parks ready at the boundary.
*/

import { type TraitFlags } from "./trait-types.js";
import { type TransitionRejection, makeTransitionRejection } from "./transition-types.js";

/** The trait-derived facts about a column, resolved by the caller from the IR.
 *  Kept as plain flags so the policy never touches the trait registry or IR. */
export interface TransitionColumnFacts {
  columnId: string;
  /** Effective (OR-merged) trait flags for the column. */
  flags: TraitFlags;
}

/** Capacity facts for a real column change into a WIP column. `limit` is the
 *  effective finite limit; `occupants` is the live count in the target capacity
 *  slot with the moving task EXCLUDED. A non-finite limit means "no gate". */
export interface CapacityFacts {
  limit: number;
  occupants: number;
}

/** Input to the shared invariant policy. `mergeBlockerReason` is the caller's
 *  already-resolved blocker string (or null when clear / not enforced for this
 *  move); the policy never re-derives it (that needs the task, which is the
 *  caller's concern). */
export interface TransitionInvariantInput {
  taskId: string;
  from: TransitionColumnFacts;
  to: TransitionColumnFacts;
  mergeBlockerReason: string | null;
}

/** Discriminated decision. `allow:false` carries a JSON-safe {@link TransitionRejection}. */
export type TransitionPolicyDecision =
  | { allow: true }
  | { allow: false; rejection: TransitionRejection };

const ALLOW: TransitionPolicyDecision = { allow: true };

// ── Trait classification (pure, flag-derived) ────────────────────────────────

/** A WIP column: cards here count against a capacity/WIP budget. */
export function isWipColumn(flags: TraitFlags): boolean {
  return flags.countsTowardWip === true;
}

/** A terminal column: success-complete or archived. */
export function isTerminalColumn(flags: TraitFlags): boolean {
  return flags.complete === true || flags.archived === true;
}

/** A completion (terminal-success) column. */
export function isCompleteColumn(flags: TraitFlags): boolean {
  return flags.complete === true;
}

/** A passive dwell/hold column (release-condition gated). */
export function isHoldColumn(flags: TraitFlags): boolean {
  return flags.hold === true;
}

/**
 * KTD-2 classification: is this boundary a hold→wip crossing? The graph must NOT
 * move on this boundary — it parks the card at the ready-for-release seam and the
 * scheduler's capacity sweep is the sole actor that performs the hold→wip move.
 * Two movers at the busiest seam means double-dispatch or deadlock.
 */
export function isHoldToWipBoundary(from: TraitFlags, to: TraitFlags): boolean {
  return isHoldColumn(from) && isWipColumn(to);
}

// ── Invariant postconditions ─────────────────────────────────────────────────

/**
 * Invariant 1: a card may not enter a `complete` column while carrying an
 * unresolved merge blocker. Returns a rejection when `to` is a complete column
 * and `mergeBlockerReason` is non-null; otherwise null.
 */
export function evaluateMergeBlockerPostcondition(
  input: TransitionInvariantInput,
): TransitionRejection | null {
  if (!isCompleteColumn(input.to.flags)) return null;
  if (!input.mergeBlockerReason) return null;
  return makeTransitionRejection(
    "merge-blocked",
    "transition.rejected.mergeBlocked",
    true,
    input.mergeBlockerReason,
  );
}

/**
 * Invariant 2: a card in a `complete`/`archived` column may not be moved into a
 * WIP column (terminal work is not resurrected into active capacity). Returns a
 * rejection when `from` is terminal and `to` is WIP; otherwise null.
 */
export function evaluateTerminalReentryPostcondition(
  input: TransitionInvariantInput,
): TransitionRejection | null {
  if (!isTerminalColumn(input.from.flags)) return null;
  if (!isWipColumn(input.to.flags)) return null;
  return makeTransitionRejection(
    "guard-rejected",
    "transition.rejected.terminalReentry",
    false,
    `Column '${input.from.columnId}' is terminal; a completed/archived card cannot re-enter the WIP column '${input.to.columnId}'`,
  );
}

/**
 * Capacity decision for a real column change into a capacity-bearing column
 * (KTD-5/KTD-9). Pure: the caller supplies the effective `limit` and the live
 * `occupants` count (moving task excluded, taken with the ONE workflow-capacity
 * counter). A finite limit at or below the occupant count rejects; a non-finite
 * limit never gates.
 */
export function evaluateCapacityRejection(
  toColumnId: string,
  capacity: CapacityFacts | null | undefined,
): TransitionRejection | null {
  if (!capacity) return null;
  const { limit, occupants } = capacity;
  if (!Number.isFinite(limit)) return null;
  if (occupants < limit) return null;
  return makeTransitionRejection(
    "capacity-exhausted",
    "transition.rejected.capacityExhausted",
    true,
    `Column '${toColumnId}' is at capacity (${occupants}/${limit})`,
  );
}

/**
 * Evaluate the structural transition invariants (merge-blocker on complete entry,
 * terminal→wip re-entry) as a single ordered return-guard. First rejection wins;
 * otherwise `allow`. Capacity is NOT evaluated here because it needs an in-txn
 * occupant count — the caller invokes {@link evaluateCapacityRejection} inside the
 * move transaction after this passes.
 */
export function evaluateTransitionInvariants(
  input: TransitionInvariantInput,
): TransitionPolicyDecision {
  const mergeBlocked = evaluateMergeBlockerPostcondition(input);
  if (mergeBlocked) return { allow: false, rejection: mergeBlocked };

  const terminalReentry = evaluateTerminalReentryPostcondition(input);
  if (terminalReentry) return { allow: false, rejection: terminalReentry };

  return ALLOW;
}
