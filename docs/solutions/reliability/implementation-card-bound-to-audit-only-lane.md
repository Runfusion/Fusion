---
title: "Implementation cards must never start on a lane that cannot run them"
date: 2026-09-26
problem_type: reliability
module: "@fusion/engine"
component: agent-heartbeat
tags:
  - agents
  - heartbeat
  - auto-claim
  - assignment-policy
  - lane-capability
  - self-healing
  - rufu-272
symptoms:
  - "an implementation-class card sits in an audit-only lane's todo forever with no decline anywhere"
  - "heartbeat wakes for the bound lane complete instantly with no session and no error"
  - "task.assignedAgentId names a lane whose assignmentPolicy excludes implementation work"
root_cause: "bind predicates and the wake path evaluated lane capability against the hardcoded legacy column vocabulary and the deprecated singular role, so eligibility silently passed (or failed unnameably) on renamed boards and policy changes after binding"
resolution_type: "capability revalidation at wake + single-owner reconciliation sweep"
---

## Problem

A durable lane narrowed to audit-only (`assignmentPolicy: "none"`, reviewer-only roles) kept
holding an implementation-class card in its `todo`: every heartbeat wake completed without a
session, and nothing — task row, audit feed, or mailbox — named why. The bind had been legitimate
when made (before the policy change), but nothing re-checked capability after binding, and the
wake path could not refuse a durable assignment even if it wanted to. Two latent vocabulary bugs
made the eligibility answer itself wrong wherever lanes are renamed: bind predicates compared
against the hardcoded legacy ids (`triage/todo/in-progress/in-review`) while the board's
implementation lanes live under custom ids with trait roles, and the heartbeat's task projection
carried only the deprecated singular `role`, hiding multi-role lanes from the selector.

## Why naive fixes fail

- **Unbinding at wake** destroys the operator's routing decision and races the scheduler; the card
  silently re-enters the auto-claim pool. Decline must mean "don't start it now", not "re-parent it".
- **Refusing in the engine scheduler only** leaves heartbeat auto-claim, inbox selection, and the
  existing durable bind untouched — the wedge had already escaped every admission gate.
- **Checking `agent.taskId` for liveness** misreads a parked link (idle lane, stale link) as a live
  carry; liveness is `isTaskPlanningOrExecutionLive(taskId)` (sessions) plus an active heartbeat run
  whose snapshot names the card — and that run must exclude the current tick's own run id, or the
  first decline erases itself on the next wake.
- **Sweeping with any mutation seam**: `assignTask`/direct `agents.taskId` writes desync the durable
  halves. The only sanctioned rebind is `TaskStore.updateTask(..., { assignedAgentId })`, which runs
  `syncAgentTaskLinkOnReassignment` in the same transaction and clears an agent-only `paused` park
  exactly per its documented condition.

## Resolution

1. **Sync lane vocabulary (Step 1).** `implementationColumns(ir)` +
   `resolveTaskImplementationColumns(store, taskId)` derive a card's implementation columns from its
   selected workflow IR (union of `intake ∪ hold ∪ countsTowardWip ∪ mergeOrchestration ∪
   mergeBlocker ∪ humanReview` traits), and every bind-predicate call site threads the resolved set
   alongside the legacy four. Null/hostile selection falls back to the default workflow's lanes;
   hard failure falls back to the legacy set — the resolver never answers "nothing", so a malformed
   IR cannot freeze dispatch fleet-wide. A structural guard
   (`scripts/check-inert-sync-lane-conversions.mjs`) refuses any future sync lane-set conversion that
   resolves without awaiting the selection read.
2. **Wake revalidation + named decline (Step 2).** The heartbeat wake re-runs the same bind verdict
   (`explicitRouting: true`, full `roles` projection, resolved columns). Ineligible ⇒ log the named
   reason, one bounded `task:lane-capability-declined` row (10-min cooldown), and fall through to
   inbox/auto-claim. Paused/user-paused cards, live-session cards, and cards carried by another live
   run are absolutely skipped; an unreadable row fails open. The wake mutates nothing.
3. **Reconciliation sweep (Step 3/4).** `reconcile-lane-capability-misbind` (self-healing, after the
   link-mirror sweeps) is the sole mutation owner: rebind via the updateTask assignment seam to the
   best auto-eligible lane (idle first, then id — deterministic), or freeze the card once with the
   named `lane-capability-mismatch` external block when no eligible lane exists. No lifecycle moves,
   progress preserved, idempotent across passes, and stable under the neighbor drift sweeps.

## Verification

- `pnpm --filter @fusion/engine exec vitest run src/__tests__/self-healing-lane-capability.test.ts src/__tests__/heartbeat-executor.test.ts --silent=passed-only --reporter=dot`
- With CI-shape Postgres: `FUSION_PG_TEST_URL_BASE=... pnpm --filter @fusion/engine exec vitest run src/__tests__/lane-capability-reconciliation.pg.test.ts --silent=passed-only --reporter=dot`
- Wake-path contract: `heartbeat-executor.test.ts` describe `lane-capability-revalidation`; renamed-board
  eligibility: core `agent-dispatch-renamed-lanes.test.ts`; vocabulary guard: `pnpm check:inert-lane-conversions`.

## Pitfalls recorded

- `updateTask` does **not** write `column` or `userPaused`; PG fixtures needing those states must use
  the `moveTask` seam or raw admin SQL.
- `run_audit_events` requires `run_id` NOT NULL: sweep emitters must pass an explicit `runId`
  (precedent: `symbol-lock-reconcile`), or the bounded seam swallows a guaranteed insert failure.
- The shared PG harness layer carries no `projectId`, so `store.asyncLayer` is unusable for agent-row
  fixtures there — seed via raw `adminSql` against `project.agents`.

## See also

- [`review-dispatch-refused-by-its-own-lane.md`](review-dispatch-refused-by-its-own-lane.md) (RUFU-682): what happens when the
  decline is correct but a *second* dispatcher re-opens the attempt every tick, and why the refusal had to be recorded in the
  reviewer-run ledger rather than only in run-audit.
