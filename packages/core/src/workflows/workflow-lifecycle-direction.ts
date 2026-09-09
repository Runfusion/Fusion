import type { TraitFlags } from "./trait-types.js";

/** A task's trait-derived position in the forward lifecycle. */
export type LifecycleRole = "intake" | "hold" | "wip" | "review" | "complete";

/** The only lifecycle ordering used for automatic-move containment. */
export const LIFECYCLE_ROLE_RANK: Readonly<Record<LifecycleRole, number>> = Object.freeze({
  intake: 0,
  hold: 1,
  wip: 2,
  review: 3,
  complete: 4,
});

export type LifecycleDirection = "forward" | "backward" | "lateral" | "unknown";

/*
FNXC:LifecycleContainment 2026-08-28-11:02:
Only a revision may move a card backward. Plan Review REVISE is the sole WIP-to-hold path; Code
Review, verification, or merge-fix REVISE may return review to WIP only with pending remediation.
Forward advancement from review through completion is explicitly permitted. FN-295 removes the archive
lifecycle role and its former F3 path; F4 protects only completed work from automatic
backward movement. Cleanup, timeout, dependency, contamination, branch, capacity, merge failure, and graph retry paths repair in
their current lifecycle role. Graph node-column routing therefore has no blanket backward authority.
Roles come from each column's own trait flags so renamed and duplicate WIP/review lanes obey the same
rule.
*/
/**
 * Classify one column from its own effective flags. Higher lifecycle roles win
 * when a custom column intentionally carries several lifecycle traits.
 */
export function classifyLifecycleRole(flags: TraitFlags): LifecycleRole | undefined {
  if (flags.complete === true) return "complete";
  if (flags.mergeOrchestration === true || flags.mergeBlocker === true || flags.humanReview === true) {
    return "review";
  }
  if (flags.countsTowardWip === true) return "wip";
  if (flags.hold === true) return "hold";
  if (flags.intake === true) return "intake";
  return undefined;
}

/** Classify an automatic move without inventing a role for trait-less columns. */
export function classifyLifecycleDirection(
  from: LifecycleRole | undefined,
  to: LifecycleRole | undefined,
): LifecycleDirection {
  if (from === undefined || to === undefined) return "unknown";
  const difference = LIFECYCLE_ROLE_RANK[to] - LIFECYCLE_ROLE_RANK[from];
  if (difference > 0) return "forward";
  if (difference < 0) return "backward";
  return "lateral";
}

export interface ForbiddenLifecyclePath {
  rule: "F1" | "F2" | "F4" | "F5";
  detail: string;
}

/**
 * The structural lifecycle deny-list. It intentionally runs independently of
 * reason registration: an engine reason may explain a legal step backward but
 * can never authorize a structurally forbidden route.
 */
export function evaluateForbiddenLifecyclePath(
  from: LifecycleRole | undefined,
  to: LifecycleRole | undefined,
  reason?: string,
): ForbiddenLifecyclePath | null {
  if (from === undefined || to === undefined) return null;
  const direction = classifyLifecycleDirection(from, to);
  if (to === "intake") {
    return { rule: "F1", detail: "Automatic moves may not target the intake lifecycle role" };
  }
  if (LIFECYCLE_ROLE_RANK[from] - LIFECYCLE_ROLE_RANK[to] > 1) {
    return { rule: "F2", detail: "Automatic moves may not step backward more than one lifecycle rank" };
  }
  if (from === "wip" && to === "hold" && reason !== "plan-review-revise-replan") {
    return { rule: "F5", detail: "A WIP card may return to planning only for Plan Review REVISE" };
  }
  /* DELIBERATE-LITERAL: LifecycleRole values are policy roles, not column ids. */
  if (from === "complete" && direction === "backward") {
    return { rule: "F4", detail: "A terminal-lane card may not move backward automatically" };
  }
  return null;
}

export type LifecycleRoleSet = readonly LifecycleRole[] | "any";

export interface EngineBackwardMoveReason {
  from: LifecycleRoleSet;
  to: LifecycleRoleSet;
  /** Recovery-only reasons may operate in several roles but never cross between them. */
  sameRoleOnly?: boolean;
  summary: string;
}

/** Every legal engine/scheduler backward move must use one of these revision reason ids. */
export const ENGINE_BACKWARD_MOVE_REASONS: Readonly<Record<string, EngineBackwardMoveReason>> = Object.freeze({
  "code-review-revise-remediation": {
    from: ["review"], to: ["wip"], summary: "Code Review REVISE requested implementation fixes",
  },
  "verification-failure-remediation": {
    from: ["review", "wip"], to: ["wip"], summary: "Verification REVISE requested implementation fixes",
  },
  "merge-fix-remediation": {
    from: ["review"], to: ["wip"], summary: "Merge review REVISE requested implementation fixes",
  },
  "plan-review-revise-replan": {
    from: ["wip"], to: ["hold"], summary: "Plan Review REVISE requested a planning revision",
  },
  "merge-failure-rebound": {
    from: ["review"], to: ["review"], summary: "Merge failure bookkeeping remains in review",
  },
  "self-healing-worktree-reclaim": {
    from: ["review", "wip"], to: ["review", "wip"], sameRoleOnly: true, summary: "Worktree recovery remains in its lifecycle role",
  },
  "self-healing-stranded-recovery": {
    from: ["review", "wip"], to: ["review", "wip"], sameRoleOnly: true, summary: "Stranded-state recovery remains in its lifecycle role",
  },
  "self-healing-dependency-rebound": {
    from: ["review", "wip"], to: ["review", "wip"], sameRoleOnly: true, summary: "Dependency recovery remains in its lifecycle role",
  },
  "self-healing-session-recovery": {
    from: ["review", "wip"], to: ["review", "wip"], sameRoleOnly: true, summary: "Session recovery remains in its lifecycle role",
  },
  "contamination-recovery": {
    from: ["review", "wip"], to: ["review", "wip"], sameRoleOnly: true, summary: "Contamination recovery remains in its lifecycle role",
  },
  "branch-worktree-recovery": {
    from: ["review", "wip"], to: ["review", "wip"], sameRoleOnly: true, summary: "Branch and worktree recovery remains in its lifecycle role",
  },
  "capacity-hold-return": {
    from: ["review", "wip"], to: ["review", "wip"], sameRoleOnly: true, summary: "Capacity recovery remains in its lifecycle role",
  },
});

function includesRole(roles: LifecycleRoleSet, role: LifecycleRole): boolean {
  return roles === "any" || roles.includes(role);
}

/** True only when a known reason explicitly permits this concrete role pair. */
export function isSanctionedEngineBackwardMove(
  reason: string | undefined,
  from: LifecycleRole | undefined,
  to: LifecycleRole | undefined,
): boolean {
  if (!reason || from === undefined || to === undefined) return false;
  const definition = ENGINE_BACKWARD_MOVE_REASONS[reason];
  return definition !== undefined
    && (!definition.sameRoleOnly || from === to)
    && includesRole(definition.from, from)
    && includesRole(definition.to, to);
}
