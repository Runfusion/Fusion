---
title: "Sticky evidence fields must not outrank explicit backward-lifecycle signals"
date: 2026-07-26
category: docs/solutions/logic-errors
module: "engine planner re-entry + unusable-worktree recovery"
problem_type: logic_error
component: engine
symptoms:
  - "A card sits in triage with status needs-replan indefinitely after Plan Review sends it back — the board reads 'Planning' forever and no planner ever claims it"
  - "An in-review task retries into a worktree that no longer exists until the retry budget is exhausted, then parks failed for a human"
  - "Recovery log says the recorded task worktree is live while the session-start refusal names a different path"
root_cause: invariant_gap
resolution_type: code_fix
severity: high
related_components:
  - "packages/engine/src/replan-target.ts (hasAdvancedPastPlanning)"
  - "packages/engine/src/self-healing.ts (autoRecoverWorktreeSessionStartFailure)"
  - "packages/engine/src/triage.ts (discoverReadyPlanningTasks, handleStuckAbortRequeue)"
  - "packages/engine/src/worktree-pool.ts (classifyTaskWorktree, hasUsableWorktreeShape)"
tags:
  - self-healing
  - liveness
  - worktrees
  - replan
  - requeue-loop
  - lifecycle
applies_when:
  - "Adding a field that is written once and read later as proof a task 'has progressed' or a resource 'is live'"
  - "Changing precedence inside hasAdvancedPastPlanning or any recovery guard that decides a backward lifecycle move"
---

# Sticky evidence fields must not outrank explicit backward-lifecycle signals

## Problem

Both halves of this bug class share one shape: **a field written once and never cleared is used as a
durable proxy for "has advanced" or "is live", and the lifecycle is then allowed to legitimately move
backward.** Nothing clears the field on the backward move, so the proxy keeps answering with history
instead of current truth, and the card wedges.

Two instances, one day apart:

1. **Planner re-entry (FN-8594).** `hasAdvancedPastPlanning` read `firstExecutionAt` /
   `executionStartedAt` as proof a card had left planning. Plan Review returning REVISE is a
   legitimate backward move: the graph rebounds the card to a planner lane with
   `status: "needs-replan"`. The stamps are never cleared, so the guard answered "advanced" forever,
   triage's discovery filter (`column === "triage" && isTaskStillInPlanningStage`) never re-admitted
   the card, and it sat in triage/needs-replan until an operator force-promoted it. Every
   triage-column workflow was affected; plan-in-place (Ideas) cards escaped only because todo
   discovery admits `needs-replan` without consulting the guard.

2. **Unusable-worktree recovery.** `autoRecoverWorktreeSessionStartFailure` treated "the failing path
   DIFFERS from `task.worktree`" as proof the recorded worktree was live, and preserved it. When both
   were dead — an AI-merge clean room refused as an "incomplete worktree" while the task worktree had
   already been removed — the dead path was carried into every requeue until the retry budget burned
   out and the card parked `failed` in review.

## Solution

Give the explicit, current signal unconditional precedence over the sticky field:

- **Durable park statuses outrank stamps.** `REPLAN_PARK_STATUSES` (`needs-replan`,
  `plan-review-unavailable`) is checked before the execution stamps. It is *derived* from
  `PLANNING_STAGE_STATUSES` by subtracting the transient `planning`, so a new durable status cannot
  be added to one set and forgotten in the other.
- **`planning` deliberately still loses to the stamps.** It is the transient in-flight planner claim;
  a stamp landing on a `planning` row means execution won the FN-8361 claim race, and recovery must
  not clear the status out from under the claiming executor. That tension is the whole design: the
  durable/transient split is what lets both invariants hold at once.
- **Prove liveness, don't infer it.** Recovery preserves `task.worktree` only when
  `hasUsableWorktreeShape` says the path is really there. Otherwise it clears the metadata so the
  next dispatch builds a fresh checkout.

## Prevention

- When introducing a field as evidence of "has progressed" or "is live", **enumerate every legitimate
  backward transition up front** and decide the precedence rule then. `hasAdvancedPastPlanning` has
  now been patched five times for precedence bugs among its signals (`1d6a0449c` steps,
  `214af9859` FN-7977 provider failures, `d10d91bae` worktree, `2dbfe3d31` + `05b704dc6` stamps). A
  sixth is likely unless new signals arrive with their precedence already specified.
- **The order of the early-returns in that guard is load-bearing.** Adding a check means deciding
  where it sits relative to the terminal-column check, the durable parks, the stamps, and steps.
- **`classifyTaskWorktree` remains the canonical liveness classifier.** `hasUsableWorktreeShape` is a
  deliberately narrower sync probe for failure paths that must not spawn git; it cannot see
  `unregistered` or a dangling gitdir. Do not treat the two as interchangeable, and do not grow a
  third check in an unrelated module — see
  [repo-root-task-worktree-requeue-loop.md](repo-root-task-worktree-requeue-loop.md) → Prevention.
- **A preserve-vs-clear decision must be readable without the prose.** The recovery emits
  `task:auto-recover-worktree-session-metadata` (ids/outcomes-only) so an agent — not just an
  operator reading the dashboard activity log — can see which way the decision went and why.

## Related

- [repo-root-task-worktree-requeue-loop.md](repo-root-task-worktree-requeue-loop.md) — the repo root
  misclassified as a usable task worktree; same acquire → gate → requeue shape.
- [heartbeat-worktree-acquisition-unbounded-requeue.md](heartbeat-worktree-acquisition-unbounded-requeue.md)
  — a second retry path that reimplemented "requeue on failure" with no cap.
