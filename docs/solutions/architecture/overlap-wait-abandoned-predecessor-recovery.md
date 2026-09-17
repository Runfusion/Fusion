---
category: architecture
module: overlap-wait-synchronization
tags: [overlap, reset, self-healing, dependencies, lifecycle]
problem_type: logic_error
applies_when: A task fails with missing delivered file evidence after its predecessor stops owning the overlap.
---

# Recover overlap waits without inventing a delivery

## Symptom and cause

A task observes an active file-scope predecessor. Reset discards the predecessor's execution before it delivers. Scheduling clears the visible blocker and admits the waiting task, but the independent durable overlap episode still requires delivered file evidence. The synchronization gate fails before implementation starts. Clearing the display marker or merely retrying cannot repair that obligation.

An overlap lease is not an explicit dependency and is not a guarantee of a future delivery. A finished, deleted or abandoned execution must stop blocking scheduling; an actual landed delivery must still be synchronized.

## Shared repair

- `recordOverlapBlockerResetInTransaction` stamps incoming episodes inside Reset's publication transaction and captures existing delivery metadata before it is discarded. Failed publication releases nobody. A later lease is re-armed explicitly; unrelated task updates cannot turn an abandoned execution into a new obligation.
- `reconcileTaskOverlapWaits` re-reads the owner and its predecessors under the task advisory transaction lock. It cancels unlanded released waits with revision fencing, retains concrete delivery snapshots and removes obsolete `blockedBy`/`overlapBlockedBy` indicators. A declared dependency on a reset task remains real work.
- `synchronizeOverlapWaitBeforeExecution` reconciles before testing pending delivery evidence. Ordinary execution with no pending episode keeps its cheap read-only path.
- `reconcileReleasedOverlapWaits` runs at startup and during maintenance. It includes failures whose visible blocker was already cleared, and permits only the recognized overlap failure to resume in its current implementation lane. Its `task:updated` publication enters the existing executor resume path; it does not move the task or reset its plan, steps, reviews or checkout.

Recovery respects global/engine pause, user pauses, live process/session/checkout ownership, active durable continuations, unrelated failures and effective auto-merge-Off policy. Legacy receipt-only delivery evidence remains fail-closed: aggregated proofs without predecessor identity are neither discarded nor turned into fabricated attributed snapshots. Each task's workflow supplies its lifecycle columns. A database read failure is not evidence of an absent predecessor. Pre-upgrade recovery accepts a retained successful Reset description-replacement event newer than the observation; a planning column or incomplete cleanup log alone is not proof of Reset.

## Symptom verification and surfaces

`packages/core/src/__tests__/postgres/overlap-wait-release.pg.test.ts` reproduces the failure using generated tasks in an isolated PostgreSQL fixture, runs the production recovery function, then exercises the real executor resume admission and synchronization entry. It checks unchanged completed/pending steps and checkout identity and verifies that a second recovery is a no-op.

Coverage includes Reset, soft deletion, missing rows, completion, preserved delivered commits, workspace repositories, pre-upgrade state, Reset rollback, superseded owners, new wait episodes, multiple predecessors, explicit dependencies, same-ID foreign-project rows, renamed workflows, pauses, auto-merge-Off and live continuations. Existing freshness/entry-point tests retain the Git ancestry, dirty-checkout and delivered-context protections.

`packages/engine/src/__tests__/self-healing.test.ts` exercises both startup and maintenance registration. `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` verifies that a reconciled snapshot removes scope and queued-reason indicators without empty metadata rows at desktop and mobile widths. Board/list/detail clients receive the same authoritative task update; no client-only hiding rule substitutes for repairing persisted state.

### Verification limitation observed during implementation

The non-gate `merge-orphan-durable-write-inventory-drift.test.ts` already had 13 unclassified store methods and two unrecorded `publishPremiseReplan` writes at baseline `a3b76118e` (verified using the untouched Git archive). This change classifies and records its new reconciliation writer/callsite without hiding or weakening that pre-existing inventory failure. The targeted recovery tests and blocking gate are separate checks.
