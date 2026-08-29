---
title: "Branch-group name collision silently strands mission triage"
date: 2026-06-03
category: docs/solutions/logic-errors
module: "core/store (branch_groups) + engine mission triage"
problem_type: logic_error
component: database
symptoms:
  - "Mission's defined features (incl. auto-generated fix features) are never triaged into tasks and the mission stops progressing"
  - "No Fix: tasks exist and no triage audit event is emitted, despite repeated startups"
  - "Engine log shows 'UNIQUE constraint failed: branch_groups.branchName' (only in stdout — never persisted)"
  - "Triage works for one mission but fails for another that shares the same base branch"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - "packages/core/src/store.ts (ensureBranchGroupForSource, createBranchGroup, getBranchGroupByBranchName)"
  - "packages/core/src/mission-store.ts (triageFeature)"
  - "packages/engine/src/mission-execution-loop.ts (handleValidationFail auto-triage)"
  - "packages/engine/src/scheduler.ts (reconcileAllMissionFeatures)"
tags:
  - mission-system
  - branch-groups
  - triage
  - unique-constraint
  - swallowed-error
  - idempotency
---

# Branch-group name collision silently strands mission triage

## Problem

`MissionStore.triageFeature` throws `UNIQUE constraint failed: branch_groups.branchName` for a mission whose shared-branch base collides with a branch group another mission already owns. The throw is swallowed by both triage callers, so the mission's `defined` features — including auto-generated **Fix** features from failed validations — are never turned into tasks and the mission silently stops progressing.

## Symptoms

- A mission stops advancing; `defined`/Fix features accumulate in active slices and never become tasks.
- No `Fix:` tasks exist and no triage audit event (`mission:stranded-feature-triaged`) is emitted, even across many engine restarts.
- The only trace is in engine **stdout** (never persisted): `Error triaging fix feature …: UNIQUE constraint failed: branch_groups.branchName` and `Failed to triage stranded feature … during reconciliation: …`.
- Triage succeeds for one mission but consistently fails for another — the one whose shared base resolves to a branch name (e.g. `main`) already claimed by the first mission's branch group.

## What Didn't Work

- **Reasoning from code alone** suggested `triageFeature` looked robust (the branch-assignment helpers don't obviously throw), which nearly led to dismissing the triage-throw hypothesis. The error sites are also silent (logged, not persisted), so the audit/activity tables showed nothing.
- The breakthrough was **reproducing against a `VACUUM INTO` snapshot of the live mission DB**: instantiating a real `TaskStore`, pulling its `MissionStore`, and calling `triageFeature` on a stuck fix feature surfaced the exact exception and stack immediately.

## Solution

`ensureBranchGroupForSource` was only idempotent by `(sourceType, sourceId)`, but `branch_groups.branchName` is globally **UNIQUE**. When the source had no group yet and another source already owned a group with that branch name, `createBranchGroup` violated the unique constraint and threw.

Reuse an existing open group for the same branch name before creating one (the idiom already used in `register-task-workflow-routes.ts`):

```ts
// packages/core/src/store.ts — ensureBranchGroupForSource
const existing = this.getBranchGroupBySource(sourceType, sourceId);
if (existing) return existing;

// branch_groups.branchName is globally UNIQUE — one open group per branch.
// Reuse it instead of colliding on the constraint.
const existingByBranch = this.getBranchGroupByBranchName(init.branchName);
if (existingByBranch) return existingByBranch;

return this.createBranchGroup({ sourceType, sourceId, ...init });
```

The low-level `createBranchGroup` still enforces uniqueness (unchanged).

## Why This Works

The mission had an empty `branchStrategy`, so `missionBranchStrategyDefaults(undefined)` returned `assignmentMode: "shared"`, and the shared base fell through to `settings.defaultBranch = "main"`. Triaging any `defined` feature then called `ensureBranchGroupForSource("mission", missionId, { branchName: "main" })`; a different mission already owned the `"main"` group, so the insert threw. The error escaped `triageFeature` into its two callers — the validation-failure auto-triage (`mission-execution-loop.ts`) and the reconcile sweep (`scheduler.ts`) — both of which catch-and-log without persisting, so features stayed `defined` forever. Reusing the existing open group removes the only failing operation; verified against the live snapshot (`triageFeature` threw before, returned `status: triaged` with a new task after).

## Prevention

- **An "ensure"-named helper keyed on one identity can still violate a UNIQUE constraint on a *different* column.** Make idempotency cover every uniqueness dimension the table enforces — here, both `(sourceType, sourceId)` and the unique `branchName`.
- **Swallowed errors in triage/reconcile paths cause silent stalls.** When a catch-and-continue site guards a step that work depends on (triage, validation, advancement), emit a persisted signal (audit event / mission event), not just a stdout log — otherwise the failure is invisible in the DB and impossible to diagnose post-hoc.
- **When a state machine stalls with no error, snapshot the live DB read-only (`VACUUM INTO` / `?mode=ro`) and drive the real code path against it.** Code-reading alone misled this investigation; the exact exception came from reproduction.
- Known limitation / follow-up: this reuses an *open* same-name group; a *closed/finalized* group on the same branch would still hit the UNIQUE constraint (branch-name retirement is a separate, arguably by-design concern).

## Related Issues

- `docs/solutions/logic-errors/mission-autopilot-stalled-by-stranded-done-feature.md` — sibling mission-stall learning (PR #1345). Same family: a mission silently wedges and an error/edge in a triage/recovery path is the cause. Both reinforce "swallowed triage-path errors → silent mission stalls."
- PR #1348 — the fix for this bug.
