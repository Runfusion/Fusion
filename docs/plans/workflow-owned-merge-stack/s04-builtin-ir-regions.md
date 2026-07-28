---
title: "S04: built-in merge retry recovery IR regions"
type: refactor
status: landed
measured_against: "main @ 46f35323c (2026-07-28)"
date: 2026-06-09
slice: S04
milestone: "Gate A"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s03-generic-scheduler-claim
---

# S04: built-in merge retry recovery IR regions

## Measured State (2026-07-28, U9 pre-flight)

The merge/retry/manual-hold/branch-group/recovery regions are **present** in `packages/core/src/builtin-coding-workflow-ir.ts` (`merge-gate`, `merge-retry`, `manual-merge-hold`, `merge-attempt`, `recovery-router`). Do not re-implement. Caveat: the declared node *config* (`maxAttempts`, `release`, `maxReworkCycles`) is read by nothing — pinned by `u9-merge-region-node-config-authority.test.ts` in the merge gate.

Status corrected from `draft-stack-handoff`, which was accurate when drafted on
2026-06-09 and is not now. See `docs/workflow-policy-ownership-map.md` →
"Measured Wiring State" for the whole-stack table.

## Stack Role

This slot was drafted 2026-06-09 as a handoff artifact. It is **no longer**
only that — see the Measured State block above for what has actually landed.

## Milestone

Gate A

## Depends On

S1 workflow work items and S2 merge request projection.

## Goal

Add explicit merge, retry, manual hold, branch-group, and recovery regions to built-in workflow IR.

## Expected File Scope

packages/core/src/builtin-*-workflow-ir.ts; packages/core/src/workflow-ir-types.ts; built-in workflow IR tests.

## Expected Tests

Built-in workflow validation for merge gates, retry nodes, manual holds, PR workflow routing, autoMerge false, and branch-group nodes.

## Exit Gate

Built-in IR is the source of truth for default merge/retry/recovery policy.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
